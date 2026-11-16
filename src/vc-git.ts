/* git's status buffer (docs/steps.md, "The git status buffer"), as magit's status shows it: the head and its
   upstream, then the untracked files, the conflicts, the unstaged and the staged changes with their hunks, the
   stashes, the commits not yet pulled or pushed (or the recent ones when the branch has no upstream). Each part
   is a section that TAB folds; a file's hunks, and each hunk, are sections too. g r reads the repository again,
   as SPC g g does in a repository whose buffer is open, keeping the folds and point.

   Everything is read through the runner (src/vc.ts) with read subcommands only (status, diff, log), so nothing
   the repository's configuration names runs; `stash list` and `branch -vv` would be writes there. There are no
   text properties: the buffer's text is drawn from the model again on each change, and each line's row says
   what it shows (dired's way).

   s, u and x stage, unstage and discard (docs/steps.md, "Staging and discarding"): a whole file or part by its
   name (add, reset, checkout, clean), a hunk or the lines selected by a patch VcDiff.patch builds from the diff
   shown (apply), each a write through the runner, then the repository read again. */

(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD } = L;
const cur = () => E.current;
const { lineNoB, lineStartB } = Ed;

/* Each read: at most this much output, and this long. A diff past the bound shows its files without hunks. */
const MAX_BYTES = 16 * 1024 * 1024;
const READ = { timeout: 120000, maxBytes: MAX_BYTES };
/* Commits listed: the recent ones of a branch with no upstream; at most so many unpulled or unpushed. */
const RECENT = 10, AHEAD_MAX = 100;

interface GitCommit { hash: string; subject: string }
/* A file of a section: its path (a directory of untracked files ends in /), its old path for a rename or copy,
   what happened to it, and its part of the section's diff (null: none read, or none). */
interface GitFile { path: string; orig: string | null; label: string; diff: VcDiffFile | null }
interface GitModel {
  branch: string | null; oid: string | null; head: GitCommit | null;
  upstream: string | null; gone: boolean; merge: GitCommit | null; ahead: number; behind: number;
  untracked: GitFile[]; unmerged: GitFile[]; unstaged: GitFile[]; staged: GitFile[];
  /* the diffs as parsed (what a pick of a hunk is taken from), and why one is not shown (null: it is) */
  diffs: { unstaged: VcDiffFile[]; staged: VcDiffFile[] };
  notes: { unstaged: string | null; staged: string | null };
  stashes: GitCommit[]; unpulled: GitCommit[]; unpushed: GitCommit[]; recent: GitCommit[];
}
/* A section: its id (the ids of its parents and its own key, joined by NUL), the line of its heading and the
   line past its end, whether it has a body to fold, its parent and children. */
interface GitSection { id: string; start: number; end: number; body: boolean; parent: GitSection | null; children: GitSection[] }
/* A line as drawn: its id (what point is kept on across a redraw), the innermost section it is in, its faces as
   [from, to, face] from the line's start, and the file and line (from 1) RET visits. */
interface GitRow { id: string; sec: GitSection; spans: [number, number, number][]; visit?: { path: string; line: number }; at?: GitAt }
/* What s, u and x act on at a line: a part of the status (its heading: FILE null), a file of it, one of the file's
   hunks (by its index in FILE.diff.hunks), or a line of that hunk (by its index in hunk.lines). */
type GitPart = 'untracked' | 'unmerged' | 'unstaged' | 'staged';
interface GitAt { part: GitPart; file: GitFile | null; hunk?: number; line?: number }
interface GitStatus { repo: VcRepo; model: GitModel; folds: Map<string, boolean>; rows: GitRow[]; top: GitSection; seq: number }

const statusOf = (b: EdBuffer) => (b.gitStatus as GitStatus | undefined) || signal('user-error', 'Not a git status buffer') as never;
/* A name as a line shows it: a control character would break the line. */
const shown = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '?');
const join = (root: string, p: string) => (root === '/' ? '/' : root + '/') + p;

/* ---------- reading the repository ---------- */
const X_LABEL: Record<string, string> = { M: 'modified', T: 'new type', A: 'new file', D: 'deleted', R: 'renamed', C: 'copied' };
const U_LABEL: Record<string, string> = { DD: 'both deleted', AU: 'added by us', UD: 'deleted by them', UA: 'added by them', DU: 'deleted by us', AA: 'both added', UU: 'both modified' };

/* The first N fields of a porcelain entry, split at spaces, and the rest of it (a path may hold spaces). */
function fields(entry: string, n: number): [string[], string] {
  const f: string[] = [];
  let at = 0;
  for (let k = 0; k < n; k++) { const sp = entry.indexOf(' ', at); if (sp < 0) signal('error', `git status printed an entry Edwin cannot read: ${shown(entry)}`); f.push(entry.slice(at, sp)); at = sp + 1; }
  return [f, entry.slice(at)];
}

function failed(x: EdProcResult, what: string): never {
  const why = x.error || (x.timedOut ? 'it took too long' : x.truncated ? 'its output was too long' : `exit ${x.code}`);
  return signal('process-error', `${what} failed (${why}): see *vc-process*`) as never;
}

/* `git status --porcelain=v2 --branch --show-stash -z` into the model's head, upstream, stash count and files.
   Names are decoded lossily: they are shown, and a name that is not UTF-8 is not worth the whole buffer. */
function readStatus(m: GitModel, out: string): number {
  let stashes = 0;
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [k, ...rest] = t.slice(2).split(' '), v = rest.join(' ');
      if (k === 'branch.oid') m.oid = v === '(initial)' ? null : v;
      else if (k === 'branch.head') m.branch = v === '(detached)' ? null : v;
      else if (k === 'branch.upstream') { m.upstream = v; m.gone = true; }
      else if (k === 'branch.ab') { const ab = /^\+(\d+) -(\d+)$/.exec(v); if (ab) { m.ahead = +ab[1]; m.behind = +ab[2]; m.gone = false; } }
      else if (k === 'stash') stashes = +v || 0;
      continue;
    }
    const kind = t[0];
    if (kind === '?') { m.untracked.push({ path: t.slice(2), orig: null, label: '', diff: null }); continue; }
    if (kind === 'u') {
      const [f, path] = fields(t, 10);
      m.unmerged.push({ path, orig: null, label: U_LABEL[f[1]] || f[1], diff: null });
      continue;
    }
    if (kind !== '1' && kind !== '2') continue;   // '!' (ignored) is not asked for
    const [f, path] = fields(t, kind === '2' ? 9 : 8);
    const orig = kind === '2' ? tokens[++i] : null, [x, y] = f[1];
    const of = (c: string) => ({ path, orig: (c === 'R' || c === 'C') ? orig : null, label: X_LABEL[c] || c, diff: null });
    if (x !== '.') m.staged.push(of(x));
    if (y !== '.') m.unstaged.push(of(y));
  }
  return stashes;
}

/* `git diff` (ARGS: --cached for the staged one) parsed, or why it is not shown. Strict UTF-8: a patch is never
   built from a lossy text, so a diff that is not UTF-8 shows its files without hunks. */
async function readDiff(r: VcRepo, args: string[]): Promise<{ files: VcDiffFile[]; note: string | null }> {
  const x = await Vc.run(r, ['diff', ...args, ...VcDiff.gitArgs, '--find-renames'], READ);
  if (x.error) return { files: [], note: 'the diff is not shown: its text is not UTF-8' };
  if (x.truncated) return { files: [], note: `the diff is not shown: it is larger than ${MAX_BYTES / 1024 / 1024} MiB` };
  if (x.code !== 0) failed(x, 'git diff');
  try { return { files: VcDiff.parse(x.out), note: null }; }
  catch (e) { return { files: [], note: 'the diff is not shown: Edwin cannot read what git printed (see *vc-process*)' }; }
}

/* Commits as `git log --format=%h %s ARGS --` lists them. */
async function readLog(r: VcRepo, args: string[]): Promise<GitCommit[]> {
  const x = await Vc.run(r, ['log', '--format=%h %s', ...args, '--'], { ...READ, lossy: true });
  if (x.code !== 0 || x.truncated) failed(x, 'git log');
  return x.out.split('\n').filter(l => l).map(l => { const sp = l.indexOf(' '); return { hash: l.slice(0, sp), subject: l.slice(sp + 1) }; });
}
/* The stashes, from the stash's reflog (log -g is a read; `git stash list` would keep the repository's
   signature programs). */
async function readStashes(r: VcRepo): Promise<GitCommit[]> {
  const x = await Vc.run(r, ['log', '--walk-reflogs', '--format=%gd %gs', 'refs/stash', '--'], { ...READ, lossy: true });
  if (x.code !== 0 || x.truncated) failed(x, 'git log of the stashes');
  return x.out.split('\n').filter(l => l).map(l => { const sp = l.indexOf(' '); return { hash: l.slice(0, sp), subject: l.slice(sp + 1) }; });
}

/* Everything the buffer shows, read from REPO. */
async function collect(r: VcRepo): Promise<GitModel> {
  const m: GitModel = {
    branch: null, oid: null, head: null, upstream: null, gone: false, merge: null, ahead: 0, behind: 0,
    untracked: [], unmerged: [], unstaged: [], staged: [], diffs: { unstaged: [], staged: [] }, notes: { unstaged: null, staged: null },
    stashes: [], unpulled: [], unpushed: [], recent: [],
  };
  const [st, un, ix] = await Promise.all([
    Vc.run(r, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z', '--untracked-files=normal', '--find-renames'], { ...READ, lossy: true }),
    readDiff(r, []), readDiff(r, ['--cached']),
  ]);
  if (st.code !== 0 || st.truncated) failed(st, 'git status');
  const stashes = readStatus(m, st.out);
  m.diffs = { unstaged: un.files, staged: ix.files };
  m.notes = { unstaged: un.note, staged: ix.note };
  /* each file's part of its section's diff: by the path it has now (the old one for a deletion) */
  const attach = (files: GitFile[], diff: VcDiffFile[]) => {
    const by = new Map<string, VcDiffFile>();
    for (const f of diff) if (f.status !== 'unmerged') by.set((f.newPath ?? f.oldPath)!, f);
    for (const f of files) f.diff = by.get(f.path) || null;
  };
  attach(m.unstaged, un.files); attach(m.staged, ix.files);
  const upstream = m.upstream !== null && !m.gone;
  const [head, merge, unpulled, unpushed, stash] = await Promise.all([
    m.oid === null ? [] : readLog(r, ['--max-count=' + (upstream ? 1 : RECENT), 'HEAD']),
    upstream ? readLog(r, ['--max-count=1', '@{upstream}']) : [],
    upstream && m.behind ? readLog(r, ['--max-count=' + AHEAD_MAX, 'HEAD..@{upstream}']) : [],
    upstream && m.oid !== null && m.ahead ? readLog(r, ['--max-count=' + AHEAD_MAX, '@{upstream}..HEAD']) : [],
    stashes ? readStashes(r) : [],
  ]);
  m.head = head[0] || null; m.merge = merge[0] || null;
  m.unpulled = unpulled; m.unpushed = unpushed; m.stashes = stash;
  if (!upstream) m.recent = head;
  return m;
}

/* ---------- drawing ---------- */
const FACES = ['', 'git-section', 'git-dim', 'git-branch', 'git-remote', 'git-hash', 'git-hunk', 'git-added', 'git-removed'];
const F = { SECTION: 1, DIM: 2, BRANCH: 3, REMOTE: 4, HASH: 5, HUNK: 6, ADDED: 7, REMOVED: 8 };
/* Folded unless the user unfolded them: a file's hunks, and the stashes. */
const FOLDED_FIRST = (key: string) => key.startsWith('f:') || key === 'stashes';
const MARK = '…';

/* The buffer's lines and rows for status V. */
function build(v: GitStatus): { lines: string[]; rows: GitRow[]; top: GitSection } {
  const m = v.model, lines: string[] = [], rows: GitRow[] = [];
  const top: GitSection = { id: '', start: 0, end: 0, body: true, parent: null, children: [] };
  /* the sections drawn, and those whose children were all drawn (unfolded) */
  const seen = new Set<string>(), opened = new Set<string>(['']);
  let sec = top;
  const line = (key: string, text: string, spans: [number, number, number][] = [], visit?: GitRow['visit'], at?: GitAt) => {
    lines.push(text); rows.push({ id: sec.id + '\0' + key, sec, spans, visit, at });
  };
  const folded = (id: string, key: string) => { const f = v.folds.get(id); return f === undefined ? FOLDED_FIRST(key) : f; };
  /* A section under the current one: its heading, then BODY unless it is folded (the heading then ends in …). */
  const section = (key: string, heading: string, spans: [number, number, number][], hasBody: boolean, body: () => void, visit?: GitRow['visit'], at?: GitAt) => {
    const s: GitSection = { id: sec.id + '\0' + key, start: lines.length, end: 0, body: hasBody, parent: sec, children: [] };
    sec.children.push(s);
    const fold = hasBody && folded(s.id, key);
    seen.add(s.id);
    if (hasBody && !fold) opened.add(s.id);
    const outer = sec;
    sec = s;
    lines.push(heading + (fold ? MARK : '')); rows.push({ id: s.id, sec: s, spans, visit, at });
    if (hasBody && !fold) body();
    sec = outer;
    s.end = lines.length;
  };
  const commitLine = (c: GitCommit) => line(c.hash, `${c.hash} ${shown(c.subject)}`, [[0, c.hash.length, F.HASH]]);
  const top_ = (key: string, title: string, n: number, body: () => void, at?: GitAt) => {
    if (!n) return;
    const heading = `${title} (${n})`;
    section(key, heading, [[0, heading.length, F.SECTION]], true, body, undefined, at);
    line('end:' + key, '');
  };

  /* the head and its upstream */
  const label = (l: string) => l.padEnd(10);
  {
    const h = 'Head:', head = m.head;
    if (m.oid === null) line('head', `${label(h)}${shown(m.branch || '')} (no commit yet)`, [[10, 10 + (m.branch || '').length, F.BRANCH]]);
    else if (m.branch !== null) line('head', `${label(h)}${shown(m.branch)} ${head ? shown(head.subject) : ''}`, [[10, 10 + m.branch.length, F.BRANCH]]);
    else line('head', `${label(h)}${head ? head.hash + ' ' + shown(head.subject) : m.oid.slice(0, 7)}`, [[10, 10 + (head ? head.hash : m.oid.slice(0, 7)).length, F.HASH]]);
    if (m.upstream !== null) {
      const u = shown(m.upstream);
      line('merge', `${label('Merge:')}${u} ${m.gone ? '(gone)' : m.merge ? shown(m.merge.subject) : ''}`, [[10, 10 + u.length, F.REMOTE], ...(m.gone ? [[11 + u.length, 17 + u.length, F.DIM] as [number, number, number]] : [])]);
    }
    for (const r of rows) r.spans.unshift([0, r.id.endsWith('merge') ? 6 : 5, F.DIM]);
    line('end:head', '');
  }

  const fileHeading = (f: GitFile) => {
    const name = f.orig !== null ? `${shown(f.orig)} -> ${shown(f.path)}` : shown(f.path), lab = f.label ? f.label.padEnd(f.label.length < 11 ? 11 : f.label.length + 1) : '';
    return { text: lab + name, spans: lab ? [[0, f.label.length, F.DIM]] as [number, number, number][] : [] };
  };
  /* FILES of a section, each with its hunks under it */
  const files = (part: GitPart, fs: GitFile[], note: string | null) => () => {
    if (note) line('note', `(${note})`, [[0, note.length + 2, F.DIM]]);
    for (const f of fs) {
      const { text, spans } = fileHeading(f), hunks = f.diff ? f.diff.hunks : [];
      section('f:' + f.path, text, spans, hunks.length > 0, () => {
        hunks.forEach((h, k) => {
          section('h' + k, h.header, [[0, h.header.length, F.HUNK]], true, () => {
            let n = h.newStart;
            h.lines.forEach((l, j) => {
              const c = l[0];
              line('l' + j, l, [[0, l.length, c === '+' ? F.ADDED : c === '-' ? F.REMOVED : c === '\\' ? F.DIM : 0]], { path: f.path, line: Math.max(1, n) }, { part, file: f, hunk: k, line: j });
              if (c === ' ' || c === '+') n++;
            });
          }, { path: f.path, line: Math.max(1, h.newStart) }, { part, file: f, hunk: k });
        });
      }, { path: f.path, line: 1 }, { part, file: f });
    }
  };
  top_('untracked', 'Untracked files', m.untracked.length, files('untracked', m.untracked, null), { part: 'untracked', file: null });
  top_('unmerged', 'Unmerged paths', m.unmerged.length, files('unmerged', m.unmerged, null), { part: 'unmerged', file: null });
  top_('unstaged', 'Unstaged changes', m.unstaged.length, files('unstaged', m.unstaged, m.notes.unstaged), { part: 'unstaged', file: null });
  top_('staged', 'Staged changes', m.staged.length, files('staged', m.staged, m.notes.staged), { part: 'staged', file: null });
  top_('stashes', 'Stashes', m.stashes.length, () => m.stashes.forEach(commitLine));
  const up = m.upstream === null ? '' : shown(m.upstream);
  const ahead = (list: GitCommit[], n: number) => () => {
    list.forEach(commitLine);
    if (n > list.length) line('more', `(${n - list.length} more)`, [[0, String(n - list.length).length + 7, F.DIM]]);
  };
  top_('unpulled', `Unpulled from ${up}`, m.unpulled.length && m.behind, ahead(m.unpulled, m.behind));
  top_('unpushed', `Unpushed to ${up}`, m.unpushed.length && m.ahead, ahead(m.unpushed, m.ahead));
  {
    const heading = 'Recent commits';
    if (m.recent.length) { section('recent', heading, [[0, heading.length, F.SECTION]], true, () => m.recent.forEach(commitLine)); line('end:recent', ''); }
  }
  /* the last line is blank: drop it, so the text ends in one newline */
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); rows.pop(); }
  top.end = lines.length;
  /* the folds of sections no longer there are forgotten: those whose parent was drawn unfolded, without them
     (one under a folded section is kept, so a section unfolded again shows its parts as they were) */
  for (const id of [...v.folds.keys()]) if (!seen.has(id) && opened.has(id.slice(0, id.lastIndexOf('\0')))) v.folds.delete(id);
  return { lines, rows, top };
}

/* The row of point's line in B, and how far into the line point is. */
function here(b: EdBuffer): { row: GitRow | undefined; col: number; line: number } {
  const v = b.gitStatus as GitStatus, line = lineNoB(b, b.pt);
  return { row: v.rows[line - 1], col: b.pt - lineStartB(b, line), line };
}
/* Draw B from its model again, point on the row it was on (or the nearest section around it that is still
   shown, or the same line). */
function draw(b: EdBuffer, at: string | null = null) {
  const v = b.gitStatus as GitStatus, was = here(b), id = at ?? (was.row ? was.row.id : null);
  const { lines, rows, top } = build(v);
  v.rows = rows; v.top = top;
  b.text = lines.join('\n') + '\n';
  b.modified = false; b.undo = []; b.redo = [];
  let k = -1;
  for (let p = id; p !== null && k < 0; p = p.includes('\0') ? p.slice(0, p.lastIndexOf('\0')) : null) k = rows.findIndex(r => r.id === p);
  const line = k >= 0 ? k + 1 : Math.min(was.line, rows.length);
  b.pt = Math.min(lineStartB(b, line) + (k >= 0 && was.row && rows[k].id === was.row.id ? was.col : 0), Ed.eol(b.rope, lineStartB(b, line)));
}

/* ---------- the buffer ---------- */
/* Read B's repository again and draw it. A refresh started later wins; a buffer killed meanwhile is left. */
async function refresh(b: EdBuffer) {
  const v = statusOf(b), seq = ++v.seq;
  const m = await collect(v.repo);
  if (seq !== v.seq || !E.buffers.includes(b)) return;
  v.model = m; draw(b); Ed.scheduleRender();
}

/* The directory a status is asked from: a status buffer's repository, else the buffer's directory (a grep's). */
function directoryOf(b: EdBuffer): string | null {
  if (b.gitStatus) return (b.gitStatus as GitStatus).repo.root;
  return Ed.compile.directory(b);
}

/* Show the status of the repository around the current buffer's directory (jj's first, or with ONLY git's
   alone), reading it again when its buffer is open. */
async function status(only?: 'git'): Promise<false> {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const dir = directoryOf(cur()), r = dir ? Vc.repo(dir, only) : null;
  if (!r) signal('user-error', `Not in a ${only ? 'git ' : ''}repository: ${dir || 'no directory'}`);
  if (r!.vcs === 'jj') signal('user-error', `${r!.root} is a jj workspace, and Edwin has no jj view yet: SPC g G shows its git repository's status when it is colocated`);
  const find = () => E.buffers.find(x => x.gitStatus && (x.gitStatus as GitStatus).repo.root === r!.root);
  let b = find();
  if (b) { await refresh(b); Ed.setWindowBuffer(b); Ed.scheduleRender(); return false; }
  const m = await collect(r!);
  b = find();   // opened while this one read
  if (b) { await refresh(b); }
  else {
    const name = `*git-status: ${r!.root.slice(r!.root.lastIndexOf('/') + 1) || '/'}*`;
    b = Ed.getBufferCreate(Ed.getBuffer(name) ? L.call('generate-new-buffer-name', [name]) as string : name);
    b.mode = 'git-status-mode'; b.readOnly = true; b.evilState = 'motion';
    b.gitStatus = { repo: r!, model: m, folds: new Map(), rows: [], top: null, seq: 0 } as unknown as GitStatus;
    b.pt = 0; draw(b);
  }
  Ed.setWindowBuffer(b); Ed.scheduleRender();
  return false;
}

CMD('vc-status', '', '', 'Show the status of the repository the current buffer is in (SPC g g): git\'s status buffer. A jj workspace has no view yet.', () => status());
CMD('git-status', '', '', 'Show the status of the git repository the current buffer is in, a colocated jj workspace\'s too (SPC g G): the head, the untracked files, the unstaged and staged changes with their hunks, the stashes and the commits not yet pushed or pulled.', () => status('git'));
CMD('git-status-refresh', '', '', 'Read the repository again (g r), keeping the folds and point.', async () => { await refresh(cur()); return false; });

/* The innermost section point's line is in. */
function sectionAt(b: EdBuffer): GitSection | null {
  statusOf(b);
  const r = here(b).row;
  return r ? r.sec : null;
}
CMD('git-status-toggle', '', '', 'Fold or unfold the section at point (TAB): a part of the status, a file\'s hunks, or a hunk.', () => {
  const b = cur(), v = statusOf(b), s = sectionAt(b);
  if (!s || !s.body || !s.parent) { Ed.message('Nothing to fold here'); return false; }
  const key = s.id.slice(s.id.lastIndexOf('\0') + 1), was = v.folds.get(s.id);
  v.folds.set(s.id, !(was === undefined ? FOLDED_FIRST(key) : was));
  draw(b, s.id);
  return false;
});
/* Point to the heading of the next (DIR 1) or previous (-1) section, at any depth, or, SIBLING, of the same
   parent. */
function move(b: EdBuffer, dir: number, sibling: boolean) {
  const v = statusOf(b), { line } = here(b), at = line - 1;
  const all: GitSection[] = [];
  const walk = (s: GitSection) => { for (const c of s.children) { all.push(c); walk(c); } };
  walk(v.top);
  let target: GitSection | undefined;
  if (sibling) {
    const s = sectionAt(b), list = s && s.parent ? s.parent.children : [];
    const i = s ? list.indexOf(s) : -1;
    target = i < 0 ? undefined : dir > 0 ? list[i + 1] : (s!.start < at ? s! : list[i - 1]);
  } else target = dir > 0 ? all.find(s => s.start > at) : [...all].reverse().find(s => s.start < at);
  if (!target) { Ed.message(dir > 0 ? 'No next section' : 'No previous section'); return false; }
  b.pt = lineStartB(b, target.start + 1);
  return false;
}
CMD('git-status-next-section', '', '', 'Point to the next section\'s heading, at any depth (C-j).', () => move(cur(), 1, false));
CMD('git-status-previous-section', '', '', 'Point to the previous section\'s heading, at any depth (C-k).', () => move(cur(), -1, false));
CMD('git-status-next-sibling', '', '', 'Point to the next section at the same depth (g j).', () => move(cur(), 1, true));
CMD('git-status-previous-sibling', '', '', 'Point to the previous section at the same depth (g k).', () => move(cur(), -1, true));
CMD('git-status-visit', '', '', 'Visit the file at point (RET): on a hunk, at its line; on an untracked directory, its listing. A file not in the work tree (deleted) is not visited.', () => {
  const b = cur(), v = statusOf(b), r = here(b).row;
  if (!r || !r.visit) signal('user-error', 'No file to visit here');
  const p = join(v.repo.root, r!.visit!.path);
  if (!Ed.host.files || !Ed.host.files.exists(p.replace(/\/$/, ''))) signal('user-error', `${shown(r!.visit!.path)} is not in the work tree`);
  if (p.endsWith('/')) return L.call('dired', [p.slice(0, -1)]);
  return L.call('visit-location', [p, r!.visit!.line]);
});
/* ---------- staging ---------- */
/* What s, u or x acts on: a Visual selection (left first), whose changed lines are picked and which must lie
   within one hunk, else the row at point (on a hunk's line, the whole hunk). Null where there is nothing. */
interface GitTarget extends GitAt { lines?: number[] }
function target(b: EdBuffer): GitTarget | null {
  const v = statusOf(b);
  if (EvilCore.stateOf(b) === 'visual') {
    const [s, e] = EvilCore.visualRange(b, true);
    EvilCore.setState(b, 'motion');
    const rows = v.rows.slice(lineNoB(b, s) - 1, lineNoB(b, Math.max(s, e - 1))), first = rows.length ? rows[0].at : undefined;
    if (!first || first.hunk === undefined || rows.some(r => !r.at || r.at.file !== first.file || r.at.hunk !== first.hunk))
      signal('user-error', 'The selection must lie within one hunk');
    return { part: first!.part, file: first!.file, hunk: first!.hunk, lines: rows.filter(r => r.at!.line !== undefined).map(r => r.at!.line!) };
  }
  return here(b).row?.at || null;
}

/* The names of FILES (with WITHORIG, a rename's or copy's old name too) as git's literal pathspecs, so a name
   with `*` or `:(...)` names that file alone. Names come from status, read lossily: one with U+FFFD (a name that
   is not UTF-8, or one that holds that character) is never given back to git. */
function pathspecs(files: GitFile[], withOrig: boolean): string[] {
  const out: string[] = [];
  for (const f of files) for (const p of withOrig && f.orig !== null ? [f.orig, f.path] : [f.path]) {
    if (p.includes('�')) signal('user-error', `${shown(p)}: its name is not UTF-8, so Edwin does not give it back to git; use a terminal`);
    out.push(':(literal)' + p);
  }
  return out;
}

/* The patch of what T picks of its part's diff (the whole part, a file, a hunk or the selected lines), for
   `git apply` forwards or, REVERSE, with --reverse. Null when the pick holds no change. */
function patchOf(v: GitStatus, t: GitTarget, reverse: boolean): string | null {
  const diffs = v.model.diffs[t.part as 'unstaged' | 'staged'], files = t.file ? [t.file] : v.model[t.part];
  const picks: VcDiffPick[] = files.map(f => {
    const k = f.diff ? diffs.indexOf(f.diff) : -1;
    if (k < 0) signal('user-error', `${shown(f.path)}: its diff is not read (${v.model.notes[t.part as 'unstaged' | 'staged'] || 'it has none'}); use a terminal`);
    return t.hunk === undefined ? { file: k } : t.lines ? { file: k, hunk: t.hunk, lines: t.lines } : { file: k, hunk: t.hunk };
  });
  return VcDiff.patch(diffs, picks, reverse);
}

/* git ARGS in V's repository, a write, with INPUT on its standard input; signals when it fails. */
async function git(v: GitStatus, args: string[], input?: string) {
  const x = await Vc.run(v.repo, args, { timeout: 120000, maxBytes: 1024 * 1024, lossy: true, input });
  if (x.code !== 0 || x.error || x.timedOut) failed(x, `git ${args[0]}`);
}
/* `git apply` of PATCH with FLAGS: the user's apply.whitespace (which `fix` would make change the lines) and
   apply.ignoreWhitespace (which would match context loosely) do not count. */
const apply = (v: GitStatus, flags: string[], patch: string) => git(v, ['apply', ...flags, '--whitespace=nowarn', '--no-ignore-whitespace'], patch);

/* What T names, for a message: the selected lines, a hunk, a file or a whole part. */
function named(v: GitStatus, t: GitTarget): string {
  const n = t.file ? 1 : v.model[t.part].length, what = t.file ? shown(t.file.orig !== null ? `${t.file.orig} -> ${t.file.path}` : t.file.path) : `${n} file${n === 1 ? '' : 's'}`;
  if (t.lines) return `the selected lines of ${what}`;
  if (t.hunk !== undefined) return `this hunk of ${what}`;
  return t.part === 'untracked' ? `untracked ${what}` : `the ${t.part} changes to ${what}`;
}

/* Run ACT on the status buffer B's target, then read the repository again, whether it worked or not. */
async function act(what: string, actOn: (v: GitStatus, t: GitTarget) => Promise<void>) {
  const b = cur(), v = statusOf(b);
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const t = target(b);
  if (!t) { Ed.message(`Nothing to ${what} here`); return false; }
  let err: unknown = null;
  try { await actOn(v, t); } catch (e) { err = e; }
  if (E.buffers.includes(b)) await refresh(b);
  if (err) throw err;
  return false;
}

CMD('git-status-stage', '', '', 'Stage what is at point (s): an untracked, unstaged or conflicted file (a conflict is then marked resolved), a hunk, a whole part of the status on its heading; in Visual state, the changed lines selected within one hunk.', () =>
  act('stage', async (v, t) => {
    if (t.part === 'staged') { Ed.message('Already staged'); return; }
    if (t.hunk === undefined) return git(v, ['add', '--', ...pathspecs(t.file ? [t.file] : v.model[t.part], false)]);
    const p = patchOf(v, t, false);
    if (!p) { Ed.message('No change selected'); return; }
    return apply(v, ['--cached'], p);
  }));
CMD('git-status-unstage', '', '', 'Unstage what is at point (u): a staged file (a rename\'s both names), a hunk, all staged changes on their heading; in Visual state, the changed lines selected within one hunk.', () =>
  act('unstage', async (v, t) => {
    if (t.part !== 'staged') { Ed.message('Not staged'); return; }
    if (t.hunk === undefined) return git(v, ['reset', '-q', '--', ...pathspecs(t.file ? [t.file] : v.model.staged, true)]);
    const p = patchOf(v, t, true);
    if (!p) { Ed.message('No change selected'); return; }
    return apply(v, ['--cached', '--reverse'], p);
  }));
CMD('git-status-discard', '', '', 'Discard what is at point, after asking (x): delete an untracked file or directory; put an unstaged file, hunk or the selected lines back as the index has them; take a staged one out of both the index and the work tree (refused where the work tree has other changes there). A conflict is not discarded.', () =>
  act('discard', async (v, t) => {
    if (t.part === 'unmerged') signal('user-error', 'A conflict is not discarded here: resolve it, then stage it with s');
    const files = t.file ? [t.file] : v.model[t.part];
    let run: () => Promise<void>;
    if (t.part === 'untracked') { const ps = pathspecs(files, false); run = () => git(v, ['clean', '-f', '-d', '-q', '--', ...ps]); }
    else if (t.part === 'unstaged' && t.hunk === undefined) { const ps = pathspecs(files, false); run = () => git(v, ['checkout', '-q', '--', ...ps]); }
    else {
      const p = patchOf(v, t, true);
      if (!p) { Ed.message('No change selected'); return; }
      run = () => apply(v, t.part === 'staged' ? ['--reverse', '--index'] : ['--reverse'], p);
    }
    const it = named(v, t);
    if (!await Ed.yesOrNo(`${t.part === 'untracked' ? 'Delete' : 'Discard'} ${it}?`)) { Ed.message('Nothing discarded'); return; }
    await run();
  }));

for (const n of ['vc-status', 'git-status', 'git-status-refresh', 'git-status-toggle', 'git-status-next-section', 'git-status-previous-section',
  'git-status-next-sibling', 'git-status-previous-sibling', 'git-status-visit', 'git-status-stage', 'git-status-unstage', 'git-status-discard']) L.put(intern(n), 'evil-repeat', intern('abort'));
Ed.MODE_NAMES['git-status-mode'] = 'Git Status';

/* ---------- faces ---------- */
interface GitLex { ver: number; from: number; to: number; cls: Uint8Array; names: string[] }
const prevLexSeg = H.lexSeg;
H.lexSeg = (b, from, to, seg) => {
  if (b.mode !== 'git-status-mode' || !b.gitStatus) return prevLexSeg ? prevLexSeg(b, from, to, seg) : null;
  const c = b._glx as GitLex | undefined;
  if (c && c.ver === b.ver && c.from === from && c.to === to) return c;
  const v = b.gitStatus as GitStatus, text = seg as string, cls = new Uint8Array(text.length);
  let line = lineNoB(b, from);
  /* the first line may start before the segment */
  for (let ls = 0, start = lineStartB(b, line) - from; ls < text.length; line++) {
    let le = text.indexOf('\n', ls); if (le < 0) le = text.length;
    const r = v.rows[line - 1];
    if (r) for (const [a, z, f] of r.spans) if (f) cls.fill(f, Math.max(ls, start + a), Math.min(le, start + z));
    ls = le + 1; start = ls;
  }
  return b._glx = { ver: b.ver, from, to, cls, names: FACES };
};
const CSS = `
.text .git-section { color: var(--fn); font-weight: 700; }
.text .git-dim { color: var(--dim); }
.text .git-branch { color: var(--st); font-weight: 600; }
.text .git-remote { color: var(--rb2); font-weight: 600; }
.text .git-hash { color: var(--dim); }
.text .git-hunk { color: var(--dc); font-weight: 600; }
.text .git-added { color: var(--rb2); }
.text .git-removed { color: var(--rb1); }
`;
Ed.host.page.addStyle('vc-git-css', CSS);
})();
