/* jj's log (docs/steps.md, "The jj log and change view"): the status view of a jj workspace, as SPC g g shows it
   there and SPC g J anywhere in one, and the change view RET opens from it, the change's header, description and
   diff by file and hunk. Both are views of git's buffers (VcView, src/vc-git.ts): the same drawing, rows, folds,
   motions and visits, each with its own model.

   Everything is read through the runner (src/vc.ts), from an explicit template whose every field is a JSON value
   (json()), one change a line: no line of jj's graph text is ever parsed, and the user's log templates, graph
   style and date format do not change what is read. What is given back to jj is a revset Edwin builds,
   `change_id(ID)`, or `commit_id(HEX)` for a divergent change, from ids read that way and checked (revOf); a
   bookmark or tag of the same name as an id cannot shadow it. */

(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E;
const { intern, signal, CMD } = L;
const cur = () => E.current;
const F = VcView.faces, shown = VcView.shown;

/* Each read: at most this much output, and this long. A diff past the bound shows no files. */
const MAX_BYTES = 16 * 1024 * 1024;
const READ = { timeout: 120000, maxBytes: MAX_BYTES, lossy: true };
/* Changes the log reads at first, and how many more each + reads. */
const PAGE = 256;

const COMMIT = /^[0-9a-f]{40,64}$/, CHANGE = /^[k-z]{32,64}$/;
/* The revset a change is shown and read again by: its change id, which follows it as it is rewritten (the
   working copy's, by the snapshot the next read takes), or its commit id when the change is divergent. */
const revOf = (change: string, commit: string, divergent: boolean) => (divergent ? `commit_id(${commit})` : `change_id(${change})`);
const REV = /^(commit_id\([0-9a-f]{40,64}\)|change_id\([k-z]{32,64}\))$/;

/* A change as a log line shows it. */
interface JjChange {
  change: string; commit: string;
  /* the shortest unique prefix of the change id and the rest of its first 8 letters; the commit id's first 8 */
  prefix: string; rest: string; short: string;
  bookmarks: string; tags: string;
  current: boolean; root: boolean; empty: boolean; conflict: boolean; immutable: boolean; divergent: boolean;
  author: string; date: string; subject: string;
}
/* A change as the change view shows it. */
interface JjShow {
  change: string; commit: string;
  /* the parents' commit ids, change ids and whether each is divergent */
  parents: string[]; parentChanges: string[]; parentDivergent: boolean[];
  bookmarks: string; tags: string;
  author: string; authorDate: string; committer: string; committerDate: string;
  description: string;
  current: boolean; root: boolean; empty: boolean; conflict: boolean; immutable: boolean; divergent: boolean;
  files: VcDiffFile[]; note: string | null;
}
/* The log: its changes, how many it asks for, whether there are more. */
interface JjLog { changes: JjChange[]; limit: number; more: boolean }
/* The change view: the revset it is read again by, and what it shows. */
interface JjChangeModel { rev: string; show: JjShow }

/* ---------- the templates ---------- */
/* A template that prints FIELDS (template expressions) as one JSON array a line. */
const record = (fields: string[]) => `"[" ++ ${fields.map(f => `json(${f})`).join(' ++ "," ++ ')} ++ "]\\n"`;
const FLAGS = ['current_working_copy', 'root', 'empty', 'conflict', 'immutable', 'divergent'];
const LOG_TEMPLATE = record([
  'change_id', 'commit_id', 'change_id.shortest(8).prefix()', 'change_id.shortest(8).rest()', 'stringify(commit_id.short(8))',
  'stringify(bookmarks.join(" "))', 'stringify(tags.join(" "))', ...FLAGS,
  'author.name()', 'stringify(author.timestamp().format("%Y-%m-%d"))', 'description.first_line()',
]);
const ISO = '"%Y-%m-%dT%H:%M:%S%:z"';
const SHOW_TEMPLATE = record([
  'change_id', 'commit_id', 'parents.map(|c| c.commit_id())', 'parents.map(|c| c.change_id())', 'parents.map(|c| stringify(c.divergent()))',
  'stringify(bookmarks.join(" "))', 'stringify(tags.join(" "))',
  'author.name()', 'author.email()', `stringify(author.timestamp().format(${ISO}))`,
  'committer.name()', 'committer.email()', `stringify(committer.timestamp().format(${ISO}))`,
  'description', ...FLAGS,
]);

function failed(x: EdProcResult, what: string): never {
  const why = x.error || (x.timedOut ? 'it took too long' : x.truncated ? 'its output was too long' : `exit ${x.code}`);
  return signal('process-error', `${what} failed (${why}): see *vc-process*`) as never;
}
/* One line of a template's output as an array of N values, each of the type TYPES says ('s' string, 'b'
   boolean, 'l' list of strings); null when it is not that. */
function fieldsOf(line: string, types: string): unknown[] | null {
  let a: unknown;
  try { a = JSON.parse(line); } catch (e) { return null; }
  if (!Array.isArray(a) || a.length !== types.length) return null;
  for (let i = 0; i < a.length; i++) {
    const t = types[i], v = a[i];
    if (t === 's' ? typeof v !== 'string' : t === 'b' ? typeof v !== 'boolean' : !(Array.isArray(v) && v.every(x => typeof x === 'string'))) return null;
  }
  return a;
}
const unreadable = (what: string) => signal('process-error', `${what} printed what Edwin cannot read (see *vc-process*)`) as never;

/* ---------- reading ---------- */
/* The first LIMIT changes of the log (the user's revsets.log, as jj log shows them), and whether there are
   more: jj is asked for one more. No --graph: the order is jj's, the graph's lines are not drawn. */
async function readLog(r: VcRepo, limit: number): Promise<JjLog> {
  const x = await Vc.run(r, ['log', '--no-graph', '--limit', String(limit + 1), '-T', LOG_TEMPLATE], READ);
  if (x.code !== 0 || x.truncated || x.error || x.timedOut) failed(x, 'jj log');
  const changes = x.out.split('\n').filter(l => l).map(l => {
    const f = fieldsOf(l, 'sssssssbbbbbbsss');
    if (!f || !COMMIT.test(f[1] as string) || !CHANGE.test(f[0] as string)) return unreadable('jj log');
    const [change, commit, prefix, rest, short, bookmarks, tags, current, root, empty, conflict, immutable, divergent, author, date, subject] = f as [string, string, string, string, string, string, string, boolean, boolean, boolean, boolean, boolean, boolean, string, string, string];
    return { change, commit, prefix, rest, short, bookmarks, tags, current, root, empty, conflict, immutable, divergent, author, date, subject };
  });
  return { changes: changes.slice(0, limit), limit, more: changes.length > limit };
}

/* The change REV (a revset Edwin built) names: its header, read first, then its diff against its parents (jj's
   diff -r, a merge's against its parents merged), read with --ignore-working-copy: the first read has taken the
   working copy's snapshot, and a second snapshot at once would be a second operation. Both lossily: only shown. */
async function readShow(r: VcRepo, rev: string): Promise<JjShow> {
  const hx = await Vc.run(r, ['log', '--no-graph', '--limit', '2', '-r', rev, '-T', SHOW_TEMPLATE], READ);
  if (hx.code !== 0 || hx.truncated || hx.error || hx.timedOut) failed(hx, 'jj log');
  const ls = hx.out.split('\n').filter(l => l);
  if (ls.length !== 1) signal('user-error', ls.length ? 'That change is divergent: it names more than one commit' : 'No such change');
  const f = fieldsOf(ls[0], 'sslllsssssssssbbbbbb'), n = f ? (f[2] as string[]).length : 0;
  if (!f || !CHANGE.test(f[0] as string) || !COMMIT.test(f[1] as string) || !(f[2] as string[]).every(p => COMMIT.test(p))
    || (f[3] as string[]).length !== n || !(f[3] as string[]).every(p => CHANGE.test(p))
    || (f[4] as string[]).length !== n || !(f[4] as string[]).every(p => p === 'true' || p === 'false')) return unreadable('jj log');
  const [change, commit, parents, parentChanges, divergentParents, bookmarks, tags, an, ae, authorDate, cn, ce, committerDate, description, current, root, empty, conflict, immutable, divergent] = f as [string, string, string[], string[], string[], string, string, string, string, string, string, string, string, string, boolean, boolean, boolean, boolean, boolean, boolean];
  const s: JjShow = {
    change, commit, parents, parentChanges, parentDivergent: divergentParents.map(p => p === 'true'), bookmarks, tags, author: `${an} <${ae}>`, authorDate, committer: `${cn} <${ce}>`, committerDate,
    description: description.replace(/\s+$/, ''), current, root, empty, conflict, immutable, divergent, files: [], note: null,
  };
  const dx = await Vc.run(r, ['diff', '--ignore-working-copy', '--git', '-r', `commit_id(${commit})`], READ);
  if (dx.truncated) s.note = `the diff is not shown: it is larger than ${MAX_BYTES / 1024 / 1024} MiB`;
  else if (dx.code !== 0 || dx.error || dx.timedOut) failed(dx, 'jj diff');
  else {
    try { s.files = VcDiff.parse(dx.out); }
    catch (e) { s.note = 'the diff is not shown: Edwin cannot read what jj printed (see *vc-process*)'; }
  }
  return s;
}

/* ---------- drawing ---------- */
/* The node jj's graph would draw for C: @ the working copy's, × a conflict, ◆ immutable, ○ any other. */
const node = (c: { current: boolean; conflict: boolean; immutable: boolean }) => (c.current ? '@' : c.conflict ? '×' : c.immutable ? '◆' : '○');

/* The log's lines: a heading, a line per change, `NODE CHANGE COMMIT BOOKMARKS TAGS (STATES) DESCRIPTION  AUTHOR
   DATE`, and a last line that says whether more can be read. */
function drawLog(g: JjLog, r: VcRepo, d: VcDrawer) {
  const heading = `Changes in ${shown(r.root)}`;
  d.line('heading', heading, [[0, heading.length, F.SECTION]]);
  for (const c of g.changes) {
    let text = '';
    const spans: VcSpans = [];
    const add = (s: string, face = 0) => { if (text) text += ' '; if (face) spans.push([text.length, text.length + s.length, face]); text += s; };
    add(node(c), c.current ? F.BRANCH : c.conflict ? F.REMOVED : F.DIM);
    add(c.prefix, F.REMOTE);
    if (c.rest) { spans.push([text.length, text.length + c.rest.length, F.DIM]); text += c.rest; }
    if (c.divergent) { spans.push([text.length, text.length + 2, F.REMOVED]); text += '??'; }
    add(c.short, F.HASH);
    if (c.root) add('root()', F.SECTION);
    else {
      if (c.bookmarks) add(shown(c.bookmarks), F.BRANCH);
      if (c.tags) add(shown(c.tags), F.BRANCH);
      if (c.conflict) add('(conflict)', F.REMOVED);
      if (c.empty) add('(empty)', F.DIM);
      add(c.subject ? shown(c.subject) : '(no description set)', c.subject ? 0 : F.DIM);
      const tail = `${shown(c.author)} ${c.date}`;
      text += ' '; add(tail, F.DIM);
    }
    d.line(c.commit, text, spans, { show: revOf(c.change, c.commit, c.divergent) });
  }
  if (g.more) { const t = `(more: + or RET here reads the next ${PAGE})`; d.line('more', t, [[0, t.length, F.DIM]], { more: true }); }
}

/* The change view's lines: the header, its values at column COL, the description indented, then the diff a section
   per file. */
const COL = 11;
const LABEL: Record<VcDiffStatus, string> = { modified: 'modified', added: 'new file', deleted: 'deleted', renamed: 'renamed', copied: 'copied', unmerged: 'unmerged' };
function drawShow(m: JjChangeModel, _r: VcRepo, d: VcDrawer) {
  const s = m.show, lab = (l: string) => l.padEnd(COL), dim = (n: number): [number, number, number] => [0, n, F.DIM];
  d.line('change', `${lab('Change:')}${s.change}${s.divergent ? ' (divergent)' : ''}`, [dim(7), [COL, COL + s.change.length, F.REMOTE]]);
  d.line('commit', `${lab('Commit:')}${s.commit}`, [dim(7), [COL, COL + s.commit.length, F.HASH]]);
  s.parents.forEach((p, k) => {
    const l = k ? '' : s.parents.length > 1 ? 'Parents:' : 'Parent:', ch = s.parentChanges[k].slice(0, 8);
    d.line('parent' + k, `${lab(l)}${ch} ${p}`, [dim(l.length), [COL, COL + ch.length, F.REMOTE], [COL + ch.length + 1, COL + ch.length + 1 + p.length, F.HASH]], { show: revOf(s.parentChanges[k], p, s.parentDivergent[k]) });
  });
  if (s.bookmarks) d.line('bookmarks', `${lab('Bookmarks:')}${shown(s.bookmarks)}`, [dim(10), [COL, COL + shown(s.bookmarks).length, F.BRANCH]]);
  if (s.tags) d.line('tags', `${lab('Tags:')}${shown(s.tags)}`, [dim(5), [COL, COL + shown(s.tags).length, F.BRANCH]]);
  const states = [s.current && 'working copy', s.root && 'root', s.immutable && 'immutable', s.empty && 'empty', s.conflict && 'conflict'].filter(x => x) as string[];
  if (states.length) d.line('states', `${lab('State:')}${states.join(', ')}`, [dim(6)]);
  if (!s.root) {
    d.line('author', `${lab('Author:')}${shown(s.author)} ${s.authorDate}`, [dim(7)]);
    if (s.committer !== s.author || s.committerDate !== s.authorDate) d.line('committer', `${lab('Committer:')}${shown(s.committer)} ${s.committerDate}`, [dim(10)]);
  }
  d.line('end:head', '');
  const desc = s.description || (s.root ? '' : '(no description set)');
  if (desc) {
    desc.split('\n').forEach((l, k) => { const t = l ? '    ' + shown(l) : ''; d.line('m' + k, t, k ? [] : [[0, t.length, s.description ? F.SECTION : F.DIM]]); });
    d.line('end:message', '');
  }
  if (s.note) d.line('note', `(${s.note})`, [[0, s.note.length + 2, F.DIM]]);
  for (const f of s.files) {
    const path = (f.newPath ?? f.oldPath)!, orig = f.status === 'renamed' || f.status === 'copied' ? f.oldPath : null;
    const lb = LABEL[f.status] + (f.binary ? ' (binary)' : f.oldMode && f.newMode && f.oldMode !== f.newMode ? ` (${f.oldMode} -> ${f.newMode})` : '');
    const { text, spans } = VcView.fileHeading(lb, path, orig);
    d.section('f:' + path, text, spans, f.hunks.length > 0, () => VcView.hunks(d, path, f.hunks), { visit: { path, line: 1 } });
  }
}

/* ---------- the buffers ---------- */
function refused() {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
}

const CHANGE_VIEW: VcViewKind = {
  name: 'jj-change', mode: 'jj-change-mode',
  draw: (m, r, d) => drawShow(m as JjChangeModel, r, d),
  read: async (r, m) => { const c = m as JjChangeModel, s = await readShow(r, c.rev); return { rev: c.rev, show: s }; },
  show: (r, rev) => showChange(r, rev),
};
const LOG_VIEW: VcViewKind = {
  name: 'jj-log', mode: 'jj-log-mode',
  draw: (m, r, d) => drawLog(m as JjLog, r, d),
  /* g r: as many changes as it shows, a page at least */
  read: (r, m) => readLog(r, Math.max(PAGE, (m as JjLog).limit)),
  show: (r, rev) => showChange(r, rev),
  more: b => logMore(b),
};

/* Show the change REV (a line's revOf) names in R's change view, replacing the change it shows; g r reads it again
   by the same revset. By its change id, the read that takes the snapshot shows the working copy's change as the
   snapshot leaves it, not the commit the line was drawn from, which the snapshot hides. */
async function showChange(r: VcRepo, rev: string): Promise<false> {
  refused();
  if (!REV.test(rev)) signal('user-error', `Not a change: ${shown(rev)}`);
  const s = await readShow(r, rev);
  const open = E.buffers.find(b => b.mode === CHANGE_VIEW.mode && b.gitView && (b.gitView as { repo: VcRepo }).repo.root === r.root);
  const was = open ? VcView.model(open, CHANGE_VIEW) as JjChangeModel : null;
  VcView.open(r, CHANGE_VIEW, { rev, show: s }, !was || was.show.change !== s.change);
  return false;
}

/* Show R's log, read again when its buffer is open. */
async function log(r: VcRepo): Promise<false> {
  refused();
  const open = E.buffers.find(b => b.mode === LOG_VIEW.mode && b.gitView && (b.gitView as { repo: VcRepo }).repo.root === r.root);
  if (open) { await VcView.refresh(open); Ed.setWindowBuffer(open); Ed.scheduleRender(); return false; }
  const g = await readLog(r, PAGE);
  VcView.open(r, LOG_VIEW, g, true);
  return false;
}
/* PAGE more changes: the log read again with a limit that much larger (jj log has no --skip). */
async function logMore(b: EdBuffer): Promise<false> {
  refused();
  const g = VcView.model(b, LOG_VIEW) as JjLog;
  if (!g.more) { Ed.message('No more changes'); return false; }
  g.limit += PAGE;
  try { await VcView.refresh(b); } catch (e) { g.limit -= PAGE; throw e; }
  return false;
}

/* The jj workspace around the current buffer: a view's repository, else the buffer's directory's. */
function workspace(): VcRepo {
  refused();
  const b = cur(), v = b.gitView as { repo: VcRepo } | undefined;
  const dir = v ? v.repo.root : Ed.compile.directory(b), r = dir ? Vc.repo(dir) : null;
  if (!r || r.vcs !== 'jj') signal('user-error', `Not in a jj workspace: ${dir || 'no directory'}`);
  return r!;
}

CMD('jj-log', '', '', 'Show the log of the jj workspace the current buffer is in (SPC g J; SPC g g there): a change per line, from an explicit template; RET on one shows it with its diff, + reads more, g r reads it again.', () => log(workspace()));
CMD('jj-log-more', '', '', 'Read the next changes of the jj log (+).', () => logMore(cur()));

for (const n of ['jj-log', 'jj-log-more']) L.put(intern(n), 'evil-repeat', intern('abort'));
Ed.MODE_NAMES['jj-log-mode'] = 'jj Log';
Ed.MODE_NAMES['jj-change-mode'] = 'jj Change';

globalThis.VcJj = { log };
})();
