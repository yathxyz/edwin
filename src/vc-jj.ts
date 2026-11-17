/* jj's log (docs/steps.md, "The jj log and change view"): the status view of a jj workspace, as SPC g g shows it
   there and SPC g J anywhere in one, and the change view RET opens from it, the change's header, description and
   diff by file and hunk. Both are views of git's buffers (VcView, src/vc-git.ts): the same drawing, rows, folds,
   motions and visits, each with its own model.

   Everything is read through the runner (src/vc.ts), from an explicit template whose every field is a JSON value
   (json()), one change a line: no line of jj's graph text is ever parsed, and the user's log templates, graph
   style and date format do not change what is read. What is given back to jj is a revset Edwin builds,
   `change_id(ID)`, or `commit_id(HEX)` for a divergent change, from ids read that way and checked (revOf); a
   bookmark or tag of the same name as an id cannot shadow it.

   The everyday operations (docs/steps.md, "jj new, describe, edit, abandon and squash") act on the change at point
   in the log, or the one the change view shows, by that revset alone: o new, c describe, e edit, x abandon (after
   asking), s squash into the parent. A description is written in vc-message-mode and given on standard input, or
   as one --message= argument; jj itself never opens an editor (JJ_EDITOR is false).

   The rewrites (docs/steps.md, "jj rebase, split by file, undo and redo"): r marks the change at point as the
   source and r on another rebases it and its descendants onto that one; S in the change view splits the files at
   point or selected off into a change of their own; u undoes jj's last operation after saying which, C-r redoes.

   Remotes and bookmarks (docs/steps.md, "jj git fetch and push, and bookmarks"): f f and f a fetch, p p pushes the
   bookmarks on the change at point, p c the change under a new bookmark, p d the deletions, in the background as
   git's remote commands run; b c, s, r, d, f, t and u create, set, rename, delete, forget, track and untrack a
   bookmark. A name goes to jj as a string literal (quoted), as `exact:` where jj would take a pattern; the git jj
   starts for the transport runs with the runner's jjTransportEnv. */

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
    if (sources.get(r.root)?.rev === revOf(c.change, c.commit, c.divergent)) add('[rebase source]', F.REMOVED);
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

/* ---------- operations on a change ---------- */
/* What the operations read of a change: its ids, its shortest id, its whole description, whether it is immutable,
   and its parents' descriptions and whether each is immutable. */
const INFO_TEMPLATE = record(['change_id', 'commit_id', 'stringify(change_id.shortest(8))', 'description', 'immutable', 'parents.map(|c| c.description())', 'parents.map(|c| stringify(c.immutable()))']);
interface JjInfo { change: string; commit: string; short: string; description: string; immutable: boolean; parents: string[]; parentsImmutable: boolean[] }
/* An operation's run: its output is only said, never read. */
const OP = { timeout: 120000, maxBytes: 1024 * 1024, lossy: true };

async function readInfo(r: VcRepo, rev: string): Promise<JjInfo> {
  const x = await Vc.run(r, ['log', '--no-graph', '--limit', '2', '-r', rev, '-T', INFO_TEMPLATE], READ);
  if (x.code !== 0 || x.truncated || x.error || x.timedOut) failed(x, 'jj log');
  const ls = x.out.split('\n').filter(l => l);
  if (ls.length !== 1) signal('user-error', ls.length ? 'That change is divergent: it names more than one commit' : 'No such change');
  const f = fieldsOf(ls[0], 'ssssbll');
  if (!f || !CHANGE.test(f[0] as string) || !COMMIT.test(f[1] as string) || !/^[k-z]{1,64}$/.test(f[2] as string)) return unreadable('jj log');
  const [change, commit, short, description, immutable, parents, flags] = f as [string, string, string, string, boolean, string[], string[]];
  if (flags.length !== parents.length || !flags.every(x => x === 'true' || x === 'false')) return unreadable('jj log');
  return { change, commit, short, description, immutable, parents, parentsImmutable: flags.map(x => x === 'true') };
}
const subjectOf = (description: string) => shown(description.split('\n')[0]) || '(no description set)';
const named = (i: JjInfo) => `${i.short} ${subjectOf(i.description)}`;
function mutable(i: JjInfo, doing: string) {
  if (i.immutable) signal('user-error', `${named(i)} is immutable: jj does not ${doing} it`);
}

/* The change an operation acts on, and its workspace: in the log, the change on the line at point; in the change
   view, the change it shows. Always a revset Edwin built (revOf), checked again here. */
function target(): { r: VcRepo; rev: string } {
  refused();
  const b = cur();
  let rev: string | undefined;
  if (b.mode === LOG_VIEW.mode) { const x = VcView.at(b, LOG_VIEW); rev = x ? x.show : undefined; }
  else if (b.mode === CHANGE_VIEW.mode) rev = (VcView.model(b, CHANGE_VIEW) as JjChangeModel).rev;
  else signal('user-error', 'Not a jj log or change buffer');
  if (!rev || !REV.test(rev)) signal('user-error', 'No change at point');
  return { r: (b.gitView as { repo: VcRepo }).repo, rev: rev! };
}

/* Read R's log and change view again, one after the other: a change view whose change is gone (abandoned,
   squashed away) is killed. */
async function reread(r: VcRepo) {
  const of = (kind: VcViewKind) => E.buffers.filter(b => { const v = b.gitView as { repo: VcRepo; ext?: VcViewKind } | undefined; return !!v && v.ext === kind && v.repo.root === r.root; });
  for (const b of of(LOG_VIEW)) await VcView.refresh(b).catch(Ed.reportError);
  for (const b of of(CHANGE_VIEW)) {
    try { await VcView.refresh(b); }
    catch (e) {
      if (/No such change/.test(String(Ed.errorText(e)))) L.call('kill-buffer', [b]);
      else Ed.reportError(e);
    }
  }
}

/* jj's error, as it printed it: its `Error:` line, else its last line. */
function jjError(x: EdProcResult): string {
  const ls = x.err.split('\n').map(l => l.trim()).filter(l => l), e = ls.find(l => l.startsWith('Error:')) || ls[ls.length - 1];
  return e ? ': ' + shown(e.replace(/^Error: /, '')).slice(0, 200) : '';
}
/* jj ARGS in R (an operation WHAT names), then R's buffers read again and what jj said first said. */
async function operate(r: VcRepo, args: string[], what: string, input?: string) {
  await settle(r, await Vc.run(r, args, input === undefined ? OP : { ...OP, input }), what);
}
/* The end of operation WHAT, X: its failure raised, else R's buffers read again and what jj said first said. */
async function settle(r: VcRepo, x: EdProcResult, what: string) {
  if (x.code !== 0 || x.error || x.timedOut) signal('process-error', `jj ${what} failed (${x.error || (x.timedOut ? 'it took too long' : `exit ${x.code}`)})${jjError(x)} (see *vc-process*)`);
  await reread(r);
  const said = x.err.split('\n').find(l => l.trim());
  Ed.message(said ? shown(said.trim()) : `jj ${what}: done`);
}

/* A message written in its buffer for an operation on a change jj refused: the next one of that kind on that
   change starts from it, by workspace root, kind and change id. */
const kept = new Map<string, string>();
/* Write a message in `*jj-KIND: NAME*` from TEXT, the comment lines HEAD under it; then DONE with it. The command
   ends once the buffer is open; DONE runs when the message comes, its failure reported as a command's would be,
   and a refused message kept for the next. */
function withMessage(r: VcRepo, kind: string, change: string, text: string, head: string[], done: (msg: string) => Promise<void>): false {
  const key = r.root + '\0' + kind + '\0' + change, last = kept.get(key);
  const comments = head.map(l => 'JJ: ' + l).join('\n') + '\n';
  const name = `*jj-${kind}: ${r.root.slice(r.root.lastIndexOf('/') + 1) || '/'}*`;
  const pending = Vc.message({ name, text: (last ?? text) + '\n' + comments, comment: 'JJ:' });
  kept.delete(key);
  void pending.then(async msg => {
    if (msg === null) return;
    try { await done(msg); } catch (e) { kept.set(key, msg); throw e; }
  }).catch(Ed.reportError).finally(() => Ed.scheduleRender());
  return false;
}
const asText = (d: string) => (d ? d.replace(/\n*$/, '\n') : '\n');

async function jjNew(): Promise<false> {
  const { r, rev } = target();
  await Vc.offerSave(r, 'jj new');
  await operate(r, ['new', '-r', rev], 'new');
  return false;
}
async function jjEdit(): Promise<false> {
  const { r, rev } = target();
  await Vc.offerSave(r, 'jj edit');
  await operate(r, ['edit', '-r', rev], 'edit');
  return false;
}
async function jjAbandon(): Promise<false> {
  const { r, rev } = target();
  const i = await readInfo(r, rev);
  mutable(i, 'abandon');
  if (!await Ed.yesOrNo(`Abandon ${named(i)}?`)) { Ed.message('Nothing abandoned'); return false; }
  await Vc.offerSave(r, 'jj abandon');
  await operate(r, ['abandon', '-r', rev], 'abandon');
  return false;
}
async function jjDescribe(): Promise<false> {
  const { r, rev } = target();
  const i = await readInfo(r, rev);
  mutable(i, 'describe');
  return withMessage(r, 'describe', i.change, asText(i.description), [
    `Describing ${i.short} in ${shown(r.root)}.`,
    'C-c C-c describes, C-c C-k aborts. Lines starting with JJ: are left out.',
  ], msg => operate(r, ['describe', '-r', rev, '--stdin'], 'describe', msg));
}
/* Squash the change into its parent, refused before anything is written when the parent is immutable. When
   both have a description (jj's rule: not the empty string, so one of only whitespace counts) jj would ask for
   the one the result gets in an editor: it is written in a buffer instead, from the parent's and then the
   change's, and given as one --message= argument (never a separate one, which jj could take as a switch). */
async function jjSquash(): Promise<false> {
  const { r, rev } = target();
  const i = await readInfo(r, rev);
  mutable(i, 'squash');
  if (i.parents.length !== 1) signal('user-error', `${named(i)} is a merge: squash it from a terminal, naming the parent with --into`);
  if (i.parentsImmutable[0]) signal('user-error', `The parent of ${named(i)} is immutable: jj does not squash into it`);
  await Vc.offerSave(r, 'jj squash');
  const into = i.parents[0];
  if (into === '' || i.description === '') { await operate(r, ['squash', '-r', rev], 'squash'); return false; }
  return withMessage(r, 'squash', i.change, asText(into) + '\n' + asText(i.description), [
    `Squashing ${i.short} into its parent in ${shown(r.root)}: the description of what it makes, the parent's above and ${i.short}'s below.`,
    'C-c C-c squashes, C-c C-k aborts. Lines starting with JJ: are left out.',
  ], msg => operate(r, ['squash', '-r', rev, '--message=' + msg], 'squash'));
}

/* ---------- rewriting: rebase, split, undo and redo ---------- */
/* The change r marked as a rebase's source, by workspace root: its revset and how it is named. */
const sources = new Map<string, { rev: string; name: string }>();
/* Draw R's open log again, its source mark as it is now. */
function markLog(r: VcRepo) {
  for (const b of E.buffers) { const v = b.gitView as { repo: VcRepo; ext?: VcViewKind } | undefined; if (v && v.ext === LOG_VIEW && v.repo.root === r.root) VcView.redraw(b); }
}

/* r: with no source marked in the workspace, mark the change at point; on the marked change again, unmark it; on
   another, after asking, rebase the source and its descendants onto it (jj rebase -s SRC -o DEST). The mark goes
   once a destination is picked, whatever comes of it. */
async function jjRebase(): Promise<false> {
  const { r, rev } = target();
  const src = sources.get(r.root);
  if (!src) {
    const i = await readInfo(r, rev);
    mutable(i, 'rebase');
    sources.set(r.root, { rev, name: named(i) });
    markLog(r);
    Ed.message(`Rebasing ${named(i)} and its descendants: r on the change to put them on, r on it again to stop`);
    return false;
  }
  sources.delete(r.root);
  markLog(r);
  if (src.rev === rev) { Ed.message('No rebase'); return false; }
  let from: JjInfo;
  try { from = await readInfo(r, src.rev); }
  catch (e) { if (/No such change/.test(String(Ed.errorText(e)))) signal('user-error', `${src.name} is gone: nothing rebased`); throw e; }
  mutable(from, 'rebase');
  const onto = await readInfo(r, rev);
  if (!await Ed.yesOrNo(`Rebase ${named(from)} and its descendants onto ${named(onto)}?`)) { Ed.message('Nothing rebased'); return false; }
  await Vc.offerSave(r, 'jj rebase');
  await operate(r, ['rebase', '--source', src.rev, '--onto', rev], 'rebase');
  return false;
}

/* A file name as a jj fileset that names that file alone, from the workspace's root: root-file:"NAME", the name's
   \ and " escaped. A name with U+FFFD (read lossily: not UTF-8) or a control character is never given back. */
function fileset(p: string): string {
  if (/[\u0000-\u001f\u007f\ufffd]/.test(p)) signal('user-error', `${shown(p)}: Edwin does not give this name back to jj; split it from a terminal`);
  return `root-file:"${p.replace(/[\\"]/g, '\\$&')}"`;
}
/* The files the change REV changes now, each its name and, renamed or copied, the name it came from. */
async function filesOf(r: VcRepo, rev: string): Promise<{ path: string; source: string }[]> {
  const x = await Vc.run(r, ['log', '--no-graph', '--limit', '2', '-r', rev, '-T', '"[" ++ diff.files().map(|f| "[" ++ json(f.path()) ++ "," ++ json(f.source().path()) ++ "]").join(",") ++ "]\\n"'], READ);
  if (x.code !== 0 || x.truncated || x.error || x.timedOut) failed(x, 'jj log');
  const ls = x.out.split('\n').filter(l => l);
  if (ls.length !== 1) signal('user-error', ls.length ? 'That change is divergent: it names more than one commit' : 'No such change');
  let a: unknown;
  try { a = JSON.parse(ls[0]); } catch (e) { return unreadable('jj log'); }
  if (!Array.isArray(a) || !a.every(f => Array.isArray(f) && f.length === 2 && f.every(x => typeof x === 'string'))) return unreadable('jj log');
  return (a as [string, string][]).map(([path, source]) => ({ path, source }));
}

/* S in the change view: split the files at point (in Visual state, those of the selected lines) off the change it
   shows, into a change of their own before what is left: jj split -r REV --message=TEXT -- FILESETS, the files
   checked against what the change changes now, its description written first in a buffer. A rename takes the name
   it came from with it. */
async function jjSplit(): Promise<false> {
  refused();
  const b = cur();
  if (b.mode !== CHANGE_VIEW.mode) signal('user-error', 'S splits from the change view: RET on a change, then S on its files');
  const { rev } = VcView.model(b, CHANGE_VIEW) as JjChangeModel, r = (b.gitView as { repo: VcRepo }).repo;
  const picked = [...new Set(VcView.selected(b, CHANGE_VIEW).map(x => x.visit && x.visit.path).filter((p): p is string => !!p))];
  if (!picked.length) signal('user-error', 'No file at point');
  const i = await readInfo(r, rev);
  mutable(i, 'split');
  /* the save first: when the change shown is @, a saved file is snapshotted into it and its files change */
  await Vc.offerSave(r, 'jj split');
  const files = await filesOf(r, rev), sets: string[] = [];
  for (const p of picked) {
    const f = files.find(x => x.path === p);
    if (!f) signal('user-error', `${shown(p)} is not changed in ${named(i)} now: g r, then pick again`);
    sets.push(fileset(f!.path));
    if (f!.source !== f!.path) sets.push(fileset(f!.source));
  }
  if (picked.length === files.length) signal('user-error', `Every file of ${named(i)} is picked: nothing would be left`);
  const list = picked.map(shown).join(', ');
  return withMessage(r, 'split', i.change, asText(i.description), [
    `Splitting ${list} off ${i.short} in ${shown(r.root)}: the description of the change that takes them; the rest keeps ${i.short}'s.`,
    'C-c C-c splits, C-c C-k aborts. Lines starting with JJ: are left out.',
  ], msg => operate(r, ['split', '-r', rev, '--message=' + msg, '--', ...sets], 'split'));
}

/* The workspace of the jj log or change view the current buffer is. */
function viewRepo(): VcRepo {
  refused();
  const b = cur();
  if (b.mode !== LOG_VIEW.mode && b.mode !== CHANGE_VIEW.mode) signal('user-error', 'Not a jj log or change buffer');
  return (b.gitView as { repo: VcRepo }).repo;
}
/* One operation's id and description, read by the jj op command ARGS (op log, op show) with the template. */
async function readOp(r: VcRepo, args: string[]): Promise<{ id: string; description: string }> {
  const what = 'jj ' + args.slice(0, 2).join(' ');
  const x = await Vc.run(r, [...args, '--no-graph', '-T', record(['id', 'description'])], READ);
  if (x.code !== 0 || x.truncated || x.error || x.timedOut) failed(x, what);
  const ls = x.out.split('\n').filter(l => l), f = ls.length === 1 ? fieldsOf(ls[0], 'ss') : null;
  if (!f || !/^[0-9a-f]{12,}$/.test(f[0] as string)) return unreadable(what);
  return { id: f[0] as string, description: f[1] as string };
}
/* jj's last operation, read as every jj command reads, after a snapshot of the working copy. */
const headOp = (r: VcRepo) => readOp(r, ['op', 'log', '--limit', '1']);
/* The operation an undo or redo restored to, from its description `undo: restore to operation ID`, read back
   and checked to be ID. */
async function restoredTo(r: VcRepo, description: string, prefix: string): Promise<{ id: string; description: string }> {
  const to = description.slice(prefix.length);
  if (!/^[0-9a-f]{12,}$/.test(to)) return unreadable('jj op log');
  const op = await readOp(r, ['op', 'show', to, '--no-op-diff']);
  if (op.id !== to) return unreadable('jj op show');
  return op;
}
/* The operation jj undo would undo, with jj's last operation's id, and how to name it. That is the last operation
   (`last`), unless it is an undo itself: then jj undo goes further back and undoes the operation that undo
   restored to, the one whose state the workspace is in (jj's cli/src/commands/undo.rs), so that one is read
   (`again`). A redo is undone as any operation, but named by the operation it did again (`redo`): its own
   description is only that operation's full id. */
async function undoTarget(r: VcRepo): Promise<{ head: string; op: { id: string; description: string }; how: 'last' | 'again' | 'redo' }> {
  const head = await headOp(r);
  if (head.description.startsWith('undo: restore to operation ')) return { head: head.id, op: await restoredTo(r, head.description, 'undo: restore to operation '), how: 'again' };
  if (head.description.startsWith('redo: restore to operation ')) return { head: head.id, op: await restoredTo(r, head.description, 'redo: restore to operation '), how: 'redo' };
  return { head: head.id, op: head, how: 'last' };
}
/* u: say which operation jj undo undoes and ask; on y, undo it, unless another operation came meanwhile. When it
   is a snapshot of the working copy (files written since jj last looked), the question says that undoing it puts
   those files back as they were. After an undo, it names the operation before, the one jj undo goes back over;
   after a redo, the operation redone. */
async function jjUndo(): Promise<false> {
  const r = viewRepo();
  const { head, op, how } = await undoTarget(r), what = shown(op.description.split('\n')[0]).slice(0, 120);
  const q = how === 'redo' ? `Undo jj's redo of ${what}?`
    : op.description === 'snapshot working copy'
    ? `Undo jj's snapshot of the working copy (the files written since jj last looked go back as they were)?`
    : how === 'again' ? `Undo jj's operation before that too, ${what}?` : `Undo jj's last operation, ${what}?`;
  if (!await Ed.yesOrNo(q)) { Ed.message('Nothing undone'); return false; }
  if ((await headOp(r)).id !== head) signal('user-error', 'jj\'s operations changed while asking: nothing undone');
  await operate(r, ['undo'], 'undo');
  return false;
}
/* C-r: jj redo, the operation the last undo undid done again. */
async function jjRedo(): Promise<false> {
  await operate(viewRepo(), ['redo'], 'redo');
  return false;
}

/* ---------- bookmarks ---------- */
/* NAME (a bookmark's or a remote's) as a jj string literal, `\` and `"` escaped, so that jj takes it as that name
   alone: not a switch, not a glob, not a revset. A name with a control character or U+FFFD (read lossily: not
   UTF-8) is never given to jj. */
function quoted(name: string): string {
  if (!name) signal('user-error', 'No name given');
  if (/[\u0000-\u001f\u007f�]/.test(name)) signal('user-error', `${shown(name)}: Edwin does not give this name to jj; use a terminal`);
  return `"${name.replace(/[\\"]/g, '\\$&')}"`;
}
/* A bookmark as jj's bookmark list gives it: local (remote ''), or a remote's (`NAME@REMOTE`), whether it is
   there (a deleted local bookmark whose remote one is tracked is listed, not present), tracked, conflicted, and
   the commit it points to ('' when conflicted). The `git` remote (jj's view of the git repository's own
   branches) is left out. */
interface JjBookmark { name: string; remote: string; present: boolean; tracked: boolean; conflict: boolean; commit: string }
const BOOKMARK_TEMPLATE = record(['name', 'if(remote, remote, "")', 'present', 'tracked', 'conflict', 'if(normal_target, normal_target.commit_id(), "")']);
async function readBookmarks(r: VcRepo): Promise<JjBookmark[]> {
  const x = await Vc.run(r, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_TEMPLATE], READ);
  if (x.code !== 0 || x.truncated || x.error || x.timedOut) failed(x, 'jj bookmark list');
  return x.out.split('\n').filter(l => l).map(l => {
    const f = fieldsOf(l, 'ssbbbs');
    if (!f || f[5] !== '' && !COMMIT.test(f[5] as string)) return unreadable('jj bookmark list');
    const [name, remote, present, tracked, conflict, commit] = f as [string, string, boolean, boolean, boolean, string];
    return { name, remote, present, tracked, conflict, commit };
  }).filter(b => b.remote !== 'git');
}
const remoteName = (b: JjBookmark) => `${b.name}@${b.remote}`;
/* A name read at PROMPT, completed from CANDS, DEF first and what RET gives on an empty input; with REQUIRE, one
   of CANDS. */
async function askName(prompt: string, cands: string[], def?: string, require = false): Promise<string> {
  const list = def === undefined ? cands : [def, ...cands.filter(c => c !== def)];
  const p = def === undefined ? `${prompt}: ` : `${prompt} (${shown(def)}): `;
  const name = (await Ed.readMini(p, '', list.length ? () => list : null, { def, require, kind: 'jj-bookmark', keepOrder: true, noIndex: true })).trim();
  if (!name) signal('user-error', 'No bookmark given');
  if (require && !cands.includes(name)) signal('user-error', `Not one of these: ${shown(name)}`);
  return name;
}
/* The change at point, read, with the bookmarks: those of jj's list, and those on the change. */
async function atPoint(): Promise<{ r: VcRepo; rev: string; i: JjInfo; all: JjBookmark[]; here: JjBookmark[] }> {
  const { r, rev } = target();
  const [i, all] = await Promise.all([readInfo(r, rev), readBookmarks(r)]);
  return { r, rev, i, all, here: all.filter(b => b.commit === i.commit) };
}
const locals = (bs: JjBookmark[]) => bs.filter(b => !b.remote && b.present).map(b => b.name);

/* b c: a new bookmark on the change at point. */
async function bookmarkCreate(): Promise<false> {
  const { r, rev, i } = await atPoint();
  const name = (await Ed.readMini(`Create bookmark at ${named(i)}: `, '', null, { kind: 'jj-bookmark-name' })).trim();
  await operate(r, ['bookmark', 'create', '-r', rev, '--', quoted(name)], 'bookmark create');
  return false;
}
/* b s: a bookmark, existing or new, set to the change at point; moving one backwards or sideways (off the
   change's ancestors) only after asking. */
async function bookmarkSet(): Promise<false> {
  const { r, rev, i, all, here } = await atPoint();
  const name = await askName(`Set bookmark to ${named(i)}`, locals(all).filter(n => !here.some(b => !b.remote && b.name === n)));
  const args = ['bookmark', 'set', '-r', rev, '--', quoted(name)];
  const x = await Vc.run(r, args, OP);
  if (x.code !== 0 && /Refusing to move bookmark backwards or sideways/.test(x.err)) {
    if (!await Ed.yesOrNo(`Move bookmark ${shown(name)} backwards or sideways to ${named(i)}?`)) { Ed.message('Nothing moved'); return false; }
    await operate(r, ['bookmark', 'set', '-r', rev, '--allow-backwards', '--', quoted(name)], 'bookmark set');
    return false;
  }
  await settle(r, x, 'bookmark set');
  return false;
}
/* b r: a local bookmark renamed, the change at point's by default. */
async function bookmarkRename(): Promise<false> {
  const { r, all, here } = await atPoint();
  const old = await askName('Rename bookmark', locals(all), locals(here)[0], true);
  const name = (await Ed.readMini(`Rename ${shown(old)} to: `, '', null, { kind: 'jj-bookmark-name' })).trim();
  await operate(r, ['bookmark', 'rename', '--', quoted(old), quoted(name)], 'bookmark rename');
  return false;
}
/* b d and b f: a local bookmark deleted (its deletion pushed to its tracked remotes by the next push of it), or
   forgotten (jj stops knowing it; its remotes keep it), after asking. */
async function bookmarkDelete(forget: boolean): Promise<false> {
  const { r, all, here } = await atPoint();
  const cands = forget ? [...new Set(all.filter(b => !b.remote).map(b => b.name))] : locals(all);
  const name = await askName(forget ? 'Forget bookmark' : 'Delete bookmark', cands, locals(here)[0], true);
  const q = forget ? `Forget bookmark ${shown(name)} (jj stops knowing it here; its remotes keep it)?`
    : `Delete bookmark ${shown(name)} (p d then deletes it on its remotes)?`;
  if (!await Ed.yesOrNo(q)) { Ed.message(forget ? 'Nothing forgotten' : 'Nothing deleted'); return false; }
  await operate(r, ['bookmark', forget ? 'forget' : 'delete', '--', 'exact:' + quoted(name)], forget ? 'bookmark forget' : 'bookmark delete');
  return false;
}
/* b t and b u: a remote bookmark tracked, so that it is the local bookmark of that name and fetches move it, or
   no longer tracked; the change at point's by default. */
async function bookmarkTrack(track: boolean): Promise<false> {
  const { r, all, here } = await atPoint();
  const of = (bs: JjBookmark[]) => bs.filter(b => b.remote && b.tracked !== track);
  const cands = of(all).map(remoteName);
  if (!cands.length) signal('user-error', track ? 'No remote bookmark is untracked: f f fetches them' : 'No remote bookmark is tracked');
  const pick = await askName(track ? 'Track remote bookmark' : 'Untrack remote bookmark', cands, of(here).map(remoteName)[0], true);
  const b = of(all).find(x => remoteName(x) === pick)!;
  await operate(r, ['bookmark', track ? 'track' : 'untrack', '--', `${quoted(b.name)}@${quoted(b.remote)}`], track ? 'bookmark track' : 'bookmark untrack');
  return false;
}

/* ---------- fetch and push ---------- */
/* Each reaches a remote: so long at most, its error output in *vc-process* as it comes. It runs once the command
   has ended, so the frame takes keys meanwhile; one at a time in a workspace. */
const REMOTE = { timeout: 1800000, maxBytes: 1024 * 1024, lossy: true, progress: true };
/* what runs, by workspace root */
const remoteBusy = new Map<string, string>();

/* The lines of jj's report X: its changes (`bookmark: main@origin [new] untracked`, `bookmark: main [move forward
   from A to B]`), its warnings and whether it said `Nothing changed.`. */
function report(x: EdProcResult): { changes: string[]; warnings: string[]; nothing: boolean } {
  const ls = x.err.split('\n').map(l => l.trim()).filter(l => l);
  return {
    changes: ls.filter(l => /^(bookmark|tag): /.test(l)).map(l => shown(l.replace(/\s+/g, ' '))),
    warnings: ls.filter(l => l.startsWith('Warning: ') && !/working-copy commit became immutable/.test(l)).map(l => shown(l.slice(9))),
    nothing: ls.includes('Nothing changed.'),
  };
}
/* jj's failure X to reach a remote, said; when it wanted credentials, where they come from. */
function unreached(x: EdProcResult, what: string): never {
  if (x.error || x.timedOut || x.truncated) failed(x, what);
  const creds = /terminal prompts disabled|Permission denied \(|Host key verification failed|Authentication failed|could not read (Username|Password)/i.test(x.err)
    ? '; jj asks no credentials here: they come from your credential helper or ssh agent' : '';
  return signal('process-error', `${what} failed (exit ${x.code})${jjError(x)}${creds} (see *vc-process*)`) as never;
}
/* jj's report X of an operation WHAT, when it did nothing: its warnings (`Refusing to create new remote bookmark
   …`), or that nothing changed. */
const nothingDone = (x: EdProcResult, what: string) => { const w = report(x).warnings; return `${what}: ${w.length ? w.join('; ') : 'nothing changed'}`; };

/* Run the remote operation PREP readies (asking what it needs) on the current buffer's jj workspace: PREP gives
   what is starting (`Fetching`) and the operation, or null for nothing. The command ends once it has started; when
   it ends, the workspace's views are read again and what it did is said. */
async function remoteOp(prep: (r: VcRepo) => Promise<[string, () => Promise<string>] | null>): Promise<false> {
  const r = workspace();
  const running = remoteBusy.get(r.root);
  if (running) signal('user-error', `${running} still runs in ${shown(r.root)}: see *vc-process*`);
  /* the slot taken before PREP's reads and questions, so that a second command started meanwhile is refused */
  remoteBusy.set(r.root, 'A remote command');
  let op: [string, () => Promise<string>] | null = null;
  try { op = await prep(r); } finally { if (!op) remoteBusy.delete(r.root); }
  if (!op) return false;
  const [what, run] = op;
  remoteBusy.set(r.root, what);
  Ed.message(`${what}… (see *vc-process*)`);
  void (async () => {
    let msg = '', err: unknown = null;
    try { msg = await run(); } catch (e) { err = e; }
    remoteBusy.delete(r.root);
    await reread(r);
    if (err) Ed.reportError(err); else Ed.message(msg);
    Ed.scheduleRender();
  })();
  return false;
}

/* f f and f a: jj git fetch from the remotes jj's configuration names (git.fetch; else origin, or the one
   remote), or from every remote. */
async function fetchRun(r: VcRepo, all: boolean): Promise<string> {
  const x = await Vc.run(r, ['git', 'fetch', ...(all ? ['--all-remotes'] : [])], REMOTE);
  if (x.code !== 0 || x.error || x.timedOut || x.truncated) unreached(x, 'jj git fetch');
  const { changes, warnings } = report(x), from = all ? 'Fetched from every remote' : 'Fetched';
  return `${from}: ${changes.length ? changes.join('; ') : 'nothing new'}${warnings.length ? ` (${warnings.join('; ')})` : ''}`;
}
/* p p, p c and p d: jj git push of ARGS (WHAT names it) to the remote jj's configuration names (git.push; else
   origin, or the one remote). What it would change is read first (--dry-run); when that moves a bookmark
   backwards or sideways there, or deletes one, it is said and asked. jj's own lease (the remote must be where
   the last fetch saw it) holds either way. */
async function pushPrep(r: VcRepo, args: string[], what: string): Promise<[string, () => Promise<string>] | null> {
  const dry = await Vc.run(r, ['git', 'push', ...args, '--dry-run'], OP);
  if (dry.code !== 0 || dry.error || dry.timedOut || dry.truncated) unreached(dry, 'jj git push');
  const plan = report(dry), to = /^Changes to push to (.+):$/m.exec(dry.err), remote = to ? shown(to[1]) : 'the remote';
  if (!plan.changes.length) { Ed.message(nothingDone(dry, 'Nothing pushed')); return null; }
  const risky = plan.changes.filter(c => /\[(move sideways|move backward|delete) /.test(c));
  if (risky.length && !await Ed.yesOrNo(`Push to ${remote}, ${risky.join('; ')}?`)) { Ed.message('Nothing pushed'); return null; }
  return [`Pushing ${what} to ${remote}`, async () => {
    const x = await Vc.run(r, ['git', 'push', ...args], REMOTE);
    if (x.code !== 0 || x.error || x.timedOut || x.truncated) unreached(x, 'jj git push');
    const done = report(x);
    return done.changes.length ? `Pushed to ${remote}: ${done.changes.join('; ')}` : nothingDone(x, 'Nothing pushed');
  }];
}
/* p p: the local bookmarks on the change at point, each by its name exactly (a new one is tracked on the
   remote as it is pushed). */
async function pushBookmarks(r: VcRepo) {
  const { i, here } = await atPoint();
  const names = here.filter(b => !b.remote && b.present && !b.conflict).map(b => b.name);
  if (!names.length) signal('user-error', `No bookmark on ${named(i)}: b c makes one, p c pushes it under a new one`);
  return pushPrep(r, names.map(n => '--bookmark=exact:' + quoted(n)), names.map(shown).join(', '));
}
/* p c: the change at point under a bookmark jj names for it (templates.git_push_bookmark; push-CHANGE). */
async function pushChange(r: VcRepo) {
  const { rev } = target(), i = await readInfo(r, rev);
  return pushPrep(r, ['--change', rev], named(i));
}

CMD('jj-git-fetch', '', '', 'Fetch from the remotes jj\'s configuration names (f f): jj git fetch, in the background, jj\'s error output in *vc-process*.', () => remoteOp(async r => ['Fetching', () => fetchRun(r, false)]));
CMD('jj-git-fetch-all', '', '', 'Fetch from every remote (f a): jj git fetch --all-remotes, in the background.', () => remoteOp(async r => ['Fetching from every remote', () => fetchRun(r, true)]));
CMD('jj-git-push', '', '', 'Push the bookmarks on the change at point (p p) to the remote jj\'s configuration names, in the background; a bookmark moved backwards or sideways there only after asking.', () => remoteOp(pushBookmarks));
CMD('jj-git-push-change', '', '', 'Push the change at point under a bookmark jj names for it (p c): jj git push --change.', () => remoteOp(pushChange));
CMD('jj-git-push-deleted', '', '', 'Push the deletion of the bookmarks deleted here (p d), after naming them: jj git push --deleted.', () => remoteOp(r => pushPrep(r, ['--deleted'], 'the deleted bookmarks')));
CMD('jj-bookmark-create', '', '', 'Create a bookmark on the change at point (b c), its name asked for.', () => bookmarkCreate());
CMD('jj-bookmark-set', '', '', 'Set a bookmark, existing or new, to the change at point (b s); one moved backwards or sideways only after asking.', () => bookmarkSet());
CMD('jj-bookmark-rename', '', '', 'Rename a local bookmark (b r), the one on the change at point by default.', () => bookmarkRename());
CMD('jj-bookmark-delete', '', '', 'Delete a local bookmark (b d), after asking; p d then deletes it on its remotes.', () => bookmarkDelete(false));
CMD('jj-bookmark-forget', '', '', 'Forget a local bookmark (b f), after asking: jj stops knowing it here, its remotes keep it.', () => bookmarkDelete(true));
CMD('jj-bookmark-track', '', '', 'Track a remote bookmark (b t), the one on the change at point by default: it becomes the local bookmark of that name.', () => bookmarkTrack(true));
CMD('jj-bookmark-untrack', '', '', 'Stop tracking a remote bookmark (b u).', () => bookmarkTrack(false));

CMD('jj-rebase', '', '', 'Rebase in jj\'s log (r): on a change, mark it as the source; on another, after asking, rebase the source and its descendants onto it (jj rebase -s -o); on the source again, unmark it.', () => jjRebase());
CMD('jj-split', '', '', 'Split the file at point, or the files selected, off the change the change view shows (S): jj split by file, the new change\'s description written in a buffer first.', () => jjSplit());
CMD('jj-undo', '', '', 'Undo jj\'s last operation, after saying which (u): jj undo.', () => jjUndo());
CMD('jj-redo', '', '', 'Redo the operation the last jj undo undid (C-r): jj redo.', () => jjRedo());

CMD('jj-new', '', '', 'Start a new change on the change at point in the jj log, or the one the change view shows (o): jj new, after offering to save the workspace\'s changed buffers.', () => jjNew());
CMD('jj-describe', '', '', 'Describe the change at point (c): its description, written in a buffer (C-c C-c describes, C-c C-k aborts), given to jj describe --stdin.', () => jjDescribe());
CMD('jj-edit', '', '', 'Make the change at point the working copy (e): jj edit, after offering to save the workspace\'s changed buffers.', () => jjEdit());
CMD('jj-abandon', '', '', 'Abandon the change at point, after asking (x): jj abandon.', () => jjAbandon());
CMD('jj-squash', '', '', 'Squash the change at point into its parent (s): jj squash; when both have a description, the one the result gets is written in a buffer.', () => jjSquash());

CMD('jj-log', '', '','Show the log of the jj workspace the current buffer is in (SPC g J; SPC g g there): a change per line, from an explicit template; RET on one shows it with its diff, + reads more, g r reads it again.', () => log(workspace()));
CMD('jj-log-more', '', '', 'Read the next changes of the jj log (+).', () => logMore(cur()));

for (const n of ['jj-log', 'jj-log-more', 'jj-new', 'jj-describe', 'jj-edit', 'jj-abandon', 'jj-squash', 'jj-rebase', 'jj-split', 'jj-undo', 'jj-redo',
  'jj-git-fetch', 'jj-git-fetch-all', 'jj-git-push', 'jj-git-push-change', 'jj-git-push-deleted', 'jj-bookmark-create', 'jj-bookmark-set',
  'jj-bookmark-rename', 'jj-bookmark-delete', 'jj-bookmark-forget', 'jj-bookmark-track', 'jj-bookmark-untrack']) L.put(intern(n), 'evil-repeat', intern('abort'));
Ed.MODE_NAMES['jj-log-mode'] = 'jj Log';
Ed.MODE_NAMES['jj-change-mode'] = 'jj Change';

globalThis.VcJj = { log };
})();
