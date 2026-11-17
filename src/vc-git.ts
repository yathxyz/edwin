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
   shown (apply), each a write through the runner, then the repository read again.

   c c, c a, c w and c f commit, amend, reword and fix up (docs/steps.md, "Committing"): the message written in
   Vc.message's buffer, given to `git commit -F -` on its standard input.

   l l shows the log, and RET on a commit the commit with its diff (docs/steps.md, "The git log and commit
   view"): the log buffer reads HEAD's history a page at a time, in the background, from the commit HEAD was when
   it opened, so the frame never waits for a long history; the revision buffer is drawn as the status buffer is,
   its files and hunks sections that TAB folds. The three buffers are views: the same drawing, rows, folds and
   motions, each with its own model.

   VcView gives that drawing to other version control: jj's log and change buffers (src/vc-jj.ts) are views of
   kind 'ext', drawn, read again and shown by their VcViewKind, folded, stepped and visited by the same commands.

   b, O, z and t in the status and log buffers branch, check out, reset, stash and tag (docs/steps.md, "Branches,
   checkout, reset, stash and tags"): each a write through the runner on what point is on (a commit, a stash) or
   what is typed (refused as a switch: a revision is resolved to its hash first, a name checked as git checks
   one), the state git leaves said exactly (local changes in the way, a conflict, a commit left behind), then the
   repository's status and log buffers read again.

   f, F and p fetch, pull and push (docs/steps.md, "Fetch, pull and push"): the current branch with its upstream,
   in the background once the command has ended, the progress in *vc-process*; the runner takes the transport's
   programs from the user's configuration alone, and asks for no credentials (they come from the user's helper
   or agent). A force push asks first and leases the remote branch at the commit the question named.

   m, A, _ and r merge, cherry-pick, revert and rebase (docs/steps.md, "Merge, cherry-pick, revert and rebase"):
   started, gone on with, skipped and aborted, in the background as the remote commands are; the state git keeps
   in the repository (readSeq) is the status header's line and its todo section, and what git stopped on is said.

   r i rebases interactively (docs/steps.md, "The interactive rebase"): the frame is git's sequence editor and
   editor (Vc's edit), the todo a buffer in git-rebase-todo-mode handed back to git.

   SPC g b blames the file the buffer visits (docs/steps.md, "Blame"): `git blame --porcelain` of the file, or of
   the buffer's text when it has changes not saved, read in the background and drawn as a view of its own in a
   window beside the file's, a line for each of the file's lines; RET on one shows its commit in the revision
   buffer. */

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
/* A stash: its name (stash@{N}), the commit it is, and its subject. */
interface GitStash { name: string; oid: string; subject: string }
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
  stashes: GitStash[]; unpulled: GitCommit[]; unpushed: GitCommit[]; recent: GitCommit[];
  /* the merge, cherry-pick, revert or rebase in progress (null: none) */
  seq: GitSeq | null;
}
/* A merge, cherry-pick, revert or rebase in progress, or a `git am` (shown, never gone on with here), as git's files
   say it: the commit it stopped at (a merge's: the commit merged; null between two steps); for a rebase, the branch
   rebased (null: a detached HEAD), the commit it goes onto, the commit the branch was at, and the step it is at of
   how many (git am's too); the steps still to do, as the todo lists them. */
type GitSeqOp = 'merge' | 'cherry-pick' | 'revert' | 'rebase' | 'am';
interface GitTodo { text: string; oid: string | null }
interface GitSeq { op: GitSeqOp; current: GitCommit | null; branch: string | null; onto: GitCommit | null; orig: string | null; step: number; of: number; todo: GitTodo[] }
/* A section: its id (the ids of its parents and its own key, joined by NUL), the line of its heading and the
   line past its end, whether it has a body to fold, its parent and children. */
interface GitSection { id: string; start: number; end: number; body: boolean; parent: GitSection | null; children: GitSection[] }
/* A line as drawn: its id (what point is kept on across a redraw), the innermost section it is in, its faces as
   [from, to, face] from the line's start, the file and line (from 1) RET visits, the commit it names (what c f fixes
   up: one in HEAD's history), the revision RET shows (any commit line, a stash's too), and, MORE, that RET there
   reads the log's next page; on a stash's line, the stash (what z a, z p and z k act on). */
interface GitRow { id: string; sec: GitSection; spans: [number, number, number][]; visit?: { path: string; line: number }; at?: GitAt; commit?: string; show?: string; more?: boolean; stash?: GitStash }
type GitExtra = Pick<GitRow, 'visit' | 'at' | 'commit' | 'show' | 'more' | 'stash'>;
/* What s, u and x act on at a line: a part of the status (its heading: FILE null), a file of it, one of the file's
   hunks (by its index in FILE.diff.hunks), or a line of that hunk (by its index in hunk.lines). */
type GitPart = 'untracked' | 'unmerged' | 'unstaged' | 'staged';
interface GitAt { part: GitPart; file: GitFile | null; hunk?: number; line?: number }
/* A log entry: the full and the short hash, the refs at it (%D), the author, the date and the subject. */
interface GitLogEntry { oid: string; hash: string; refs: string; author: string; date: string; subject: string }
/* The log: the commit it starts from (null: no commit yet), the commits read so far, whether there are more,
   what is being read (the log again from HEAD, or the next page; null: nothing), and why the last read failed
   (null: it did not). */
interface GitLog { tip: string | null; commits: GitLogEntry[]; more: boolean; reading: 'all' | 'next' | null; note: string | null }
/* A commit as the revision buffer shows it: its hash, parents, author and committer with their dates, the
   refs at it, its message, and its diff against its first parent (or why it is not shown). */
interface GitShow { oid: string; parents: string[]; author: string; authorDate: string; committer: string; committerDate: string; refs: string; message: string; files: VcDiffFile[]; note: string | null }
/* A view: a buffer of the repository REPO drawn from its model, with its folds, the rows drawn last, the
   sections, and the number of the latest read (a read started earlier draws nothing). */
interface GitViewBase { repo: VcRepo; folds: Map<string, boolean>; rows: GitRow[]; top: GitSection; seq: number }
interface GitStatus extends GitViewBase { kind: 'status'; model: GitModel }
interface GitLogView extends GitViewBase { kind: 'log'; log: GitLog }
interface GitShowView extends GitViewBase { kind: 'show'; show: GitShow }
/* a view another module draws (VcView.open): its kind and its model, which only that kind reads */
interface GitExtView extends GitViewBase { kind: 'ext'; ext: VcViewKind; model: unknown }
/* A file's blame: FILE (absolute) is PATH in the repository; a line for each of its lines (null until read),
   whether it is being read, why the last read failed (null: it did not), and the line point goes to once it is
   read (null: none). */
interface GitBlameLine { oid: string; author: string; date: string; text: string }
interface GitBlame { file: string; path: string; lines: GitBlameLine[] | null; reading: boolean; note: string | null; line: number | null }
interface GitBlameView extends GitViewBase { kind: 'blame'; blame: GitBlame }
type GitView = GitStatus | GitLogView | GitShowView | GitExtView | GitBlameView;
const VIEW_MODES = new Set(['git-status-mode', 'git-log-mode', 'git-revision-mode', 'git-blame-mode']);

const viewOf = (b: EdBuffer) => (b.gitView as GitView | undefined) || signal('user-error', 'Not a git buffer') as never;
const statusOf = (b: EdBuffer) => { const v = b.gitView as GitView | undefined; return v && v.kind === 'status' ? v : signal('user-error', 'Not a git status buffer') as never; };
const logOf = (b: EdBuffer) => { const v = b.gitView as GitView | undefined; return v && v.kind === 'log' ? v : signal('user-error', 'Not a git log buffer') as never; };
const buffersOf = (r: VcRepo, kind: GitView['kind']) => E.buffers.filter(x => { const v = x.gitView as GitView | undefined; return !!v && v.kind === kind && v.repo.root === r.root; });
const repoName = (r: VcRepo) => r.root.slice(r.root.lastIndexOf('/') + 1) || '/';
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

/* The diff git HEAD prints (`diff`, `diff --cached` for the staged one, a `show` of a commit), with REVS after its
   switches, parsed, or why it is not shown. Strict UTF-8 unless LOSSY: a patch is never built from a lossy text,
   so a diff staging reads that is not UTF-8 shows its files without hunks; one only shown (a commit's) is read
   lossily, a byte that is not UTF-8 shown as U+FFFD. */
async function readDiff(r: VcRepo, head: string[], revs: string[] = [], lossy = false): Promise<{ files: VcDiffFile[]; note: string | null }> {
  const x = await Vc.run(r, [...head, ...VcDiff.gitArgs, '--find-renames', ...revs, '--'], { ...READ, lossy });
  if (x.error) return { files: [], note: 'the diff is not shown: its text is not UTF-8' };
  if (x.truncated) return { files: [], note: `the diff is not shown: it is larger than ${MAX_BYTES / 1024 / 1024} MiB` };
  if (x.code !== 0) failed(x, `git ${head[0]}`);
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
async function readStashes(r: VcRepo): Promise<GitStash[]> {
  const x = await Vc.run(r, ['log', '--walk-reflogs', '--format=%gd%x00%H%x00%gs', 'refs/stash', '--'], { ...READ, lossy: true });
  if (x.code !== 0 || x.truncated) failed(x, 'git log of the stashes');
  return x.out.split('\n').filter(l => l).map(l => { const [name, oid, ...subject] = l.split('\0'); return { name, oid, subject: subject.join(' ') }; });
}

/* The lines of a todo (a rebase's git-rebase-todo, the sequencer's todo) still to do, comments and blank lines left
   out: each as `VERB HASH SUBJECT` (the hash shortened, the `# ` git puts before a subject dropped), with the commit
   it names (null: a line that names none, an exec's or a label's). */
function todoOf(text: string | null): GitTodo[] {
  return (text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const [verb, id = ''] = l.split(/\s+/, 2);
    if (verb === 'exec' || verb === 'x' || !/^[0-9a-f]{4,64}$/.test(id)) return { text: shown(l), oid: null };
    const rest = l.slice(l.indexOf(id) + id.length).trim().replace(/^# /, '');
    return { text: shown(`${verb} ${id.slice(0, 7)}${rest ? ' ' + rest : ''}`), oid: id };
  });
}
const OID = /^[0-9a-f]{40,64}$/;
const PSEUDO = ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'];
/* What R is in the middle of, read from git's own files: the directories a rebase (rebase-merge, rebase-apply; git
   am's rebase-apply holds `applying`) and a sequence of picks or reverts (sequencer) keep, MERGE_HEAD (a file
   always), and the pseudorefs CHERRY_PICK_HEAD, REVERT_HEAD and REBASE_HEAD by their exact names, as git status
   reads them: never by git's rules for a name typed (refs/NAME, refs/tags/NAME, refs/heads/NAME, ...), under which
   a branch or a tag of that name would be taken for an operation in progress. In a files repository each is the
   file there; in a reftable one (`rev-parse --show-ref-format`; a git older than 2.45, which has no reftable,
   prints a switch it does not know back) each is a root ref, listed by `for-each-ref --include-root-refs` (git 2.46; only a
   reftable repository needs it). The paths come from `rev-parse --git-path`, so a linked worktree's own are read.
   Precedence as git status has it: a rebase (or am), a merge, a pick, a revert, then a sequence stopped between
   two of its steps (its todo's first word says which). Reads only. */
async function readSeq(r: VcRepo): Promise<GitSeq | null> {
  const px = await Vc.run(r, ['rev-parse', '--show-ref-format', ...['rebase-merge', 'rebase-apply', 'sequencer', 'MERGE_HEAD', ...PSEUDO].flatMap(p => ['--git-path', p])], { ...READ, lossy: true });
  if (px.code !== 0 || px.error || px.timedOut || px.truncated) failed(px, 'git rev-parse');
  const [format, ...paths] = px.out.split('\n');
  const [rm, ra, sq, mh, ...pseudo] = paths.map(p => (p.startsWith('/') ? p : join(r.root, p)));
  const files = Ed.host.files;
  if (!files || !files.tree || !mh) return null;
  const read = (p: string) => { try { return files.read(p); } catch (e) { return null; } };
  const isDir = (p: string) => { try { const e = files.tree!.entry(p); return !!e && e.kind === 'dir'; } catch (e) { return false; } };
  const first = (p: string) => (read(p) || '').split('\n')[0].trim();
  const num = (p: string) => { const n = parseInt(first(p), 10); return Number.isFinite(n) ? n : 0; };
  const heads = new Map<string, string>();
  if (format === 'reftable') {
    const hx = await Vc.run(r, ['for-each-ref', '--include-root-refs', '--format=%(refname)%00%(objectname)', ...PSEUDO], { ...READ, lossy: true });
    if (hx.code !== 0 || hx.error || hx.timedOut || hx.truncated) failed(hx, 'git for-each-ref');
    for (const l of hx.out.split('\n')) { const [name, oid] = l.split('\0'); if (PSEUDO.includes(name) && OID.test(oid)) heads.set(name, oid); }
  } else PSEUDO.forEach((name, i) => { const oid = first(pseudo[i]); if (OID.test(oid)) heads.set(name, oid); });
  const commit = async (oid: string | undefined): Promise<GitCommit | null> => (oid && OID.test(oid) ? (await readLog(r, ['--max-count=1', oid]))[0] || { hash: oid.slice(0, 7), subject: '' } : null);
  const none: GitSeq = { op: 'merge', current: null, branch: null, onto: null, orig: null, step: 0, of: 0, todo: [] };
  const dir = isDir(rm) ? rm : isDir(ra) ? ra : null;
  if (dir) {
    const apply = dir === ra, at = (f: string) => dir + '/' + f;
    const [step, of] = [num(at(apply ? 'next' : 'msgnum')), num(at(apply ? 'last' : 'end'))];
    if (apply && read(at('applying')) !== null) return { ...none, op: 'am', step, of };
    const head = first(at('head-name')), [current, onto] = await Promise.all([commit(heads.get('REBASE_HEAD')), commit(first(at('onto')))]);
    return {
      op: 'rebase', current, branch: head.startsWith('refs/heads/') ? head.slice(11) : null, onto, orig: OID.test(first(at('orig-head'))) ? first(at('orig-head')) : null,
      step, of, todo: apply ? [] : todoOf(read(at('git-rebase-todo'))),
    };
  }
  const merging = first(mh);
  if (OID.test(merging)) return { ...none, current: await commit(merging) };
  /* the todo's first line is the step it stopped at, done or not: git goes on from the line after it */
  const todo = todoOf(read(sq + '/todo'));
  for (const [ref, op] of [['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const)
    if (heads.has(ref)) return { ...none, op, current: await commit(heads.get(ref)), todo: todo.slice(1) };
  if (todo.length) return { ...none, op: todo[0].text.startsWith('revert ') ? 'revert' : 'cherry-pick', todo: todo.slice(1) };
  return null;
}

/* Everything the buffer shows, read from REPO. */
async function collect(r: VcRepo): Promise<GitModel> {
  const m: GitModel = {
    branch: null, oid: null, head: null, upstream: null, gone: false, merge: null, ahead: 0, behind: 0,
    untracked: [], unmerged: [], unstaged: [], staged: [], diffs: { unstaged: [], staged: [] }, notes: { unstaged: null, staged: null },
    stashes: [], unpulled: [], unpushed: [], recent: [], seq: null,
  };
  const [st, un, ix] = await Promise.all([
    Vc.run(r, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z', '--untracked-files=normal', '--find-renames'], { ...READ, lossy: true }),
    readDiff(r, ['diff']), readDiff(r, ['diff', '--cached']),
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
  const [head, merge, unpulled, unpushed, stash, seq] = await Promise.all([
    m.oid === null ? [] : readLog(r, ['--max-count=' + (upstream ? 1 : RECENT), 'HEAD']),
    upstream ? readLog(r, ['--max-count=1', '@{upstream}']) : [],
    upstream && m.behind ? readLog(r, ['--max-count=' + AHEAD_MAX, 'HEAD..@{upstream}']) : [],
    upstream && m.oid !== null && m.ahead ? readLog(r, ['--max-count=' + AHEAD_MAX, '@{upstream}..HEAD']) : [],
    stashes ? readStashes(r) : [],
    readSeq(r),
  ]);
  m.head = head[0] || null; m.merge = merge[0] || null;
  m.unpulled = unpulled; m.unpushed = unpushed; m.stashes = stash; m.seq = seq;
  if (!upstream) m.recent = head;
  return m;
}

/* REV as the full hash of the commit it names, or null when it names none (`--verify --quiet` exits 1 then: an
   unknown name, an unborn HEAD). Any other failure is git refusing the repository or not running at all (exit 128:
   an unknown extension, dubious ownership, a corrupt HEAD), and is raised as one, not taken for an empty history.
   REV is given to git only after `--end-of-options`, as one argument, so what a user types never reaches git as a
   switch. */
async function resolve(r: VcRepo, rev: string): Promise<string | null> {
  const x = await Vc.run(r, ['rev-parse', '--verify', '--quiet', '--end-of-options', rev + '^{commit}'], { ...READ, lossy: true });
  if (x.code === 1 && !x.error && !x.timedOut) return null;
  const hash = x.out.trim();
  if (x.code !== 0 || x.error || x.timedOut || x.truncated || !/^[0-9a-f]{40,64}$/.test(hash)) failed(x, 'git rev-parse');
  return hash;
}

/* The log's pages: so many commits each. git is asked for one more, to know whether there are more. No --graph
   and no --topo-order: both walk the whole history before the first line comes. */
const PAGE = 256;
/* N commits of TIP's history (a full hash) past the first SKIP, newest first, in the shape the format fixes: the
   user's log.date, log.decorate and format.pretty do not count (--date and --format), nor log.showSignature (the
   runner's), and no signature is verified (no %G). Read lossily: they are only shown. */
async function readCommits(r: VcRepo, tip: string, skip: number, n: number): Promise<GitLogEntry[]> {
  const x = await Vc.run(r, ['log', '--no-color', '--encoding=UTF-8', '--date=short', '--format=%H%x00%h%x00%D%x00%an%x00%ad%x00%s',
    '--skip=' + skip, '--max-count=' + n, tip, '--'], { ...READ, lossy: true });
  if (x.code !== 0 || x.truncated || x.error) failed(x, 'git log');
  return x.out.split('\n').filter(l => l).map(l => {
    const [oid, hash, refs, author, date, ...subject] = l.split('\0');
    return { oid, hash, refs, author, date, subject: subject.join(' ') };
  });
}

/* The commit OID (a full hash) as the revision buffer shows it: its header and message (lossily: shown only),
   then its diff against its first parent (a merge's too: git's combined diff is not one Edwin reads into hunks,
   and the user's log.diffMerges must not change what is shown), a root commit's against the empty tree. The diff
   is read lossily as well: no patch is built from it. */
async function readShow(r: VcRepo, oid: string): Promise<GitShow> {
  const [hx, diff] = await Promise.all([
    Vc.run(r, ['show', '--no-patch', '--no-color', '--encoding=UTF-8', '--date=iso-strict', '--format=%H%x00%P%x00%an <%ae>%x00%ad%x00%cn <%ce>%x00%cd%x00%D%x00%B', oid, '--'], { ...READ, lossy: true }),
    readDiff(r, ['show', '--format=', '--patch', '--root', '--diff-merges=first-parent'], [oid], true),
  ]);
  if (hx.code !== 0 || hx.truncated || hx.error) failed(hx, 'git show');
  const [h, parents, author, authorDate, committer, committerDate, refs, ...message] = hx.out.split('\0');
  return { oid: h, parents: parents ? parents.split(' ') : [], author, authorDate, committer, committerDate, refs, message: message.join('\0').replace(/\s+$/, ''), files: diff.files, note: diff.note };
}

/* ---------- drawing ---------- */
const FACES = ['', 'git-section', 'git-dim', 'git-branch', 'git-remote', 'git-hash', 'git-hunk', 'git-added', 'git-removed'];
const F = { SECTION: 1, DIM: 2, BRANCH: 3, REMOTE: 4, HASH: 5, HUNK: 6, ADDED: 7, REMOVED: 8 };
type Spans = [number, number, number][];
/* Folded unless the user unfolded them: in the status buffer a file's hunks, and the stashes; in the revision
   buffer nothing. */
const foldedFirst = (v: GitView, key: string) => v.kind === 'status' && (key.startsWith('f:') || key === 'stashes');
const MARK = '…';

/* What a view's drawing adds lines and sections with. */
interface Drawer {
  line(key: string, text: string, spans?: Spans, extra?: GitExtra): void;
  /* A section under the current one: its heading, then BODY unless it is folded (the heading then ends in …). */
  section(key: string, heading: string, spans: Spans, hasBody: boolean, body: () => void, extra?: GitExtra): void;
}
/* The lines, rows and sections DRAW gives for view V. */
function drawing(v: GitView, draw: (d: Drawer) => void): { lines: string[]; rows: GitRow[]; top: GitSection } {
  const lines: string[] = [], rows: GitRow[] = [];
  const top: GitSection = { id: '', start: 0, end: 0, body: true, parent: null, children: [] };
  /* the sections drawn, and those whose children were all drawn (unfolded) */
  const seen = new Set<string>(), opened = new Set<string>(['']);
  let sec = top;
  const folded = (id: string, key: string) => { const f = v.folds.get(id); return f === undefined ? foldedFirst(v, key) : f; };
  draw({
    line(key, text, spans = [], extra = {}) { lines.push(text); rows.push({ id: sec.id + '\0' + key, sec, spans, ...extra }); },
    section(key, heading, spans, hasBody, body, extra = {}) {
      const s: GitSection = { id: sec.id + '\0' + key, start: lines.length, end: 0, body: hasBody, parent: sec, children: [] };
      sec.children.push(s);
      const fold = hasBody && folded(s.id, key);
      seen.add(s.id);
      if (hasBody && !fold) opened.add(s.id);
      const outer = sec;
      sec = s;
      lines.push(heading + (fold ? MARK : '')); rows.push({ id: s.id, sec: s, spans, ...extra });
      if (hasBody && !fold) body();
      sec = outer;
      s.end = lines.length;
    },
  });
  /* the last line is blank: drop it, so the text ends in one newline */
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); rows.pop(); }
  top.end = lines.length;
  /* the folds of sections no longer there are forgotten: those whose parent was drawn unfolded, without them
     (one under a folded section is kept, so a section unfolded again shows its parts as they were) */
  for (const id of [...v.folds.keys()]) if (!seen.has(id) && opened.has(id.slice(0, id.lastIndexOf('\0')))) v.folds.delete(id);
  return { lines, rows, top };
}

/* A file's HUNKS under D's current section, each a section of its lines; RET on a line visits PATH at that line of
   the new side (a removed line where it was). AT, when given, says what s, u and x act on at a hunk or a line. */
function hunks(d: Drawer, path: string, hs: VcDiffHunk[], at?: (hunk: number, line?: number) => GitAt) {
  hs.forEach((h, k) => {
    d.section('h' + k, h.header, [[0, h.header.length, F.HUNK]], true, () => {
      let n = h.newStart;
      h.lines.forEach((l, j) => {
        const c = l[0];
        d.line('l' + j, l, [[0, l.length, c === '+' ? F.ADDED : c === '-' ? F.REMOVED : c === '\\' ? F.DIM : 0]], { visit: { path, line: Math.max(1, n) }, at: at && at(k, j) });
        if (c === ' ' || c === '+') n++;
      });
    }, { visit: { path, line: Math.max(1, h.newStart) }, at: at && at(k) });
  });
}
/* A file's heading: its label padded, then its name (`old -> new` for a rename or copy). */
function fileHeading(label: string, path: string, orig: string | null): { text: string; spans: Spans } {
  const name = orig !== null ? `${shown(orig)} -> ${shown(path)}` : shown(path), lab = label ? label.padEnd(label.length < 11 ? 11 : label.length + 1) : '';
  return { text: lab + name, spans: lab ? [[0, label.length, F.DIM]] : [] };
}
const label = (l: string) => l.padEnd(10);

/* A commit as a line or a message names it: its short hash and subject. */
const commitText = (c: GitCommit) => (c.subject ? `${c.hash} ${shown(c.subject)}` : c.hash);
/* The status buffer's line for what S is in the middle of. */
function seqText(s: GitSeq): string {
  const at = s.current ? ' ' + commitText(s.current) : '';
  switch (s.op) {
    case 'merge': return `Merging${at}`;
    case 'cherry-pick': return at ? `Cherry-picking${at}` : 'Cherry-picking, stopped between two commits';
    case 'revert': return at ? `Reverting${at}` : 'Reverting, stopped between two commits';
    case 'am': return `Applying patches with git am (${s.step} of ${s.of})`;
    case 'rebase': return `Rebasing ${s.branch !== null ? shown(s.branch) : 'a detached HEAD'} onto ${s.onto ? commitText(s.onto) : '?'}, `
      + (at ? `stopped at${at} (${s.step} of ${s.of})` : `stopped after ${s.step} of ${s.of}`);
  }
}

/* The status buffer's lines. */
function drawStatus(v: GitStatus, d: Drawer) {
  const m = v.model, { line, section } = d;
  /* a commit's line; with NOFIX (a stash's, an unpulled one: not in HEAD's history) no fixup is for it */
  const commitLine = (c: GitCommit, noFix = false) => line(c.hash, `${c.hash} ${shown(c.subject)}`, [[0, c.hash.length, F.HASH]], { commit: noFix ? undefined : c.hash, show: c.hash });
  const top_ = (key: string, title: string, n: number, body: () => void, at?: GitAt) => {
    if (!n) return;
    const heading = `${title} (${n})`;
    section(key, heading, [[0, heading.length, F.SECTION]], true, body, { at });
    line('end:' + key, '');
  };

  /* the head and its upstream */
  {
    const h = 'Head:', head = m.head, dim = (n: number): [number, number, number] => [0, n, F.DIM];
    if (m.oid === null) line('head', `${label(h)}${shown(m.branch || '')} (no commit yet)`, [dim(5), [10, 10 + (m.branch || '').length, F.BRANCH]]);
    else if (m.branch !== null) line('head', `${label(h)}${shown(m.branch)} ${head ? shown(head.subject) : ''}`, [dim(5), [10, 10 + m.branch.length, F.BRANCH]], { show: head ? head.hash : undefined });
    else line('head', `${label(h)}${head ? head.hash + ' ' + shown(head.subject) : m.oid.slice(0, 7)}`, [dim(5), [10, 10 + (head ? head.hash : m.oid.slice(0, 7)).length, F.HASH]], { show: head ? head.hash : undefined });
    if (m.upstream !== null) {
      const u = shown(m.upstream);
      line('merge', `${label('Merge:')}${u} ${m.gone ? '(gone)' : m.merge ? shown(m.merge.subject) : ''}`, [dim(6), [10, 10 + u.length, F.REMOTE], ...(m.gone ? [[11 + u.length, 17 + u.length, F.DIM] as [number, number, number]] : [])], { show: m.merge ? m.merge.hash : undefined });
    }
    if (m.seq) {
      const t = seqText(m.seq);
      line('seq', t, [[0, t.search(/[ ,]|$/), F.SECTION]], { show: m.seq.current ? m.seq.current.hash : undefined });
    }
    line('end:head', '');
  }
  /* the steps a rebase or a sequence of picks or reverts has still to do */
  if (m.seq && m.seq.todo.length) {
    const s = m.seq;
    top_('todo', `To ${s.op}`, s.todo.length, () => s.todo.forEach((t, k) => {
      const v = t.text.indexOf(' ');
      line('t' + k, t.text, t.oid ? [[v + 1, v + 1 + Math.min(7, t.oid.length), F.HASH]] : [], { show: t.oid ?? undefined });
    }));
  }

  /* FILES of a section, each with its hunks under it */
  const files = (part: GitPart, fs: GitFile[], note: string | null) => () => {
    if (note) line('note', `(${note})`, [[0, note.length + 2, F.DIM]]);
    for (const f of fs) {
      const { text, spans } = fileHeading(f.label, f.path, f.orig), hs = f.diff ? f.diff.hunks : [];
      section('f:' + f.path, text, spans, hs.length > 0, () => hunks(d, f.path, hs, (hunk, l) => (l === undefined ? { part, file: f, hunk } : { part, file: f, hunk, line: l })),
        { visit: { path: f.path, line: 1 }, at: { part, file: f } });
    }
  };
  top_('untracked', 'Untracked files', m.untracked.length, files('untracked', m.untracked, null), { part: 'untracked', file: null });
  top_('unmerged', 'Unmerged paths', m.unmerged.length, files('unmerged', m.unmerged, null), { part: 'unmerged', file: null });
  top_('unstaged', 'Unstaged changes', m.unstaged.length, files('unstaged', m.unstaged, m.notes.unstaged), { part: 'unstaged', file: null });
  top_('staged', 'Staged changes', m.staged.length, files('staged', m.staged, m.notes.staged), { part: 'staged', file: null });
  top_('stashes', 'Stashes', m.stashes.length, () => m.stashes.forEach(c => line(c.name, `${c.name} ${shown(c.subject)}`, [[0, c.name.length, F.HASH]], { show: c.name, stash: c })));
  const up = m.upstream === null ? '' : shown(m.upstream);
  const ahead = (list: GitCommit[], n: number, mine: boolean) => () => {
    list.forEach(c => commitLine(c, !mine));
    if (n > list.length) line('more', `(${n - list.length} more)`, [[0, String(n - list.length).length + 7, F.DIM]]);
  };
  top_('unpulled', `Unpulled from ${up}`, m.unpulled.length && m.behind, ahead(m.unpulled, m.behind, false));
  top_('unpushed', `Unpushed to ${up}`, m.unpushed.length && m.ahead, ahead(m.unpushed, m.ahead, true));
  {
    const heading = 'Recent commits';
    if (m.recent.length) { section('recent', heading, [[0, heading.length, F.SECTION]], true, () => m.recent.forEach(c => commitLine(c))); line('end:recent', ''); }
  }
}

/* The log buffer's lines: a heading, a line per commit (its short hash, the refs at it, its subject, then its
   author and date), and a last line that says whether more can be read. */
function drawLog(v: GitLogView, d: Drawer) {
  const g = v.log, heading = g.tip === null && !g.reading && !g.note ? 'No commit yet' : `Commits in ${shown(v.repo.root)}`;
  d.line('heading', heading, [[0, heading.length, F.SECTION]]);
  for (const c of g.commits) {
    const refs = c.refs ? `(${shown(c.refs)}) ` : '', at = c.hash.length + 1, tail = `  ${shown(c.author)} ${c.date}`;
    const text = `${c.hash} ${refs}${shown(c.subject)}${tail}`;
    const spans: Spans = [[0, c.hash.length, F.HASH], [text.length - tail.length + 2, text.length, F.DIM]];
    if (refs) spans.splice(1, 0, [at, at + refs.length - 1, F.BRANCH]);
    d.line(c.oid, text, spans, { commit: c.oid, show: c.oid });
  }
  const tail = (key: string, text: string, extra?: GitExtra) => d.line(key, text, [[0, text.length, F.DIM]], extra);
  if (g.note) tail('note', `(${g.note})`);
  if (g.reading) tail('reading', g.reading === 'next' ? `(reading the next ${PAGE}…)` : '(reading…)');
  else if (g.more) tail('more', `(more: + or RET here reads the next ${PAGE})`, { more: true });
}

/* The revision buffer's lines: the commit's header, its message indented, then its diff, a section per file. The
   header's values start at column COL, one past its longest label, `Committer:`. */
const COL = 11;
function drawShow(v: GitShowView, d: Drawer) {
  const s = v.show, lab = (l: string) => l.padEnd(COL), dim = (n: number): [number, number, number] => [0, n, F.DIM];
  d.line('commit', `${lab('Commit:')}${s.oid}`, [dim(7), [COL, COL + s.oid.length, F.HASH]]);
  s.parents.forEach((p, k) => { const l = k ? '' : s.parents.length > 1 ? 'Parents:' : 'Parent:'; d.line('parent' + k, `${lab(l)}${p}`, [dim(l.length), [COL, COL + p.length, F.HASH]], { show: p }); });
  if (s.refs) d.line('refs', `${lab('Refs:')}${shown(s.refs)}`, [dim(5), [COL, COL + shown(s.refs).length, F.BRANCH]]);
  d.line('author', `${lab('Author:')}${shown(s.author)} ${s.authorDate}`, [dim(7)]);
  if (s.committer !== s.author || s.committerDate !== s.authorDate) d.line('committer', `${lab('Committer:')}${shown(s.committer)} ${s.committerDate}`, [dim(10)]);
  d.line('end:head', '');
  if (s.message) {   // an empty message (--allow-empty-message) draws no lines of its own: one blank line parts the header from the diff
    s.message.split('\n').forEach((l, k) => { const t = l ? '    ' + shown(l) : ''; d.line('m' + k, t, k ? [] : [[0, t.length, F.SECTION]]); });
    d.line('end:message', '');
  }
  if (s.note) d.line('note', `(${s.note})`, [[0, s.note.length + 2, F.DIM]]);
  const LABEL: Record<VcDiffStatus, string> = { modified: 'modified', added: 'new file', deleted: 'deleted', renamed: 'renamed', copied: 'copied', unmerged: 'unmerged' };
  for (const f of s.files) {
    const path = (f.newPath ?? f.oldPath)!, orig = f.status === 'renamed' || f.status === 'copied' ? f.oldPath : null;
    const lab = LABEL[f.status] + (f.binary ? ' (binary)' : f.oldMode && f.newMode && f.oldMode !== f.newMode ? ` (${f.oldMode} -> ${f.newMode})` : '');
    const { text, spans } = fileHeading(lab, path, orig);
    d.section('f:' + path, text, spans, f.hunks.length > 0, () => hunks(d, path, f.hunks), { visit: { path, line: 1 } });
  }
}

/* The buffer's lines and rows for view V. */
const build = (v: GitView) => drawing(v, d => (v.kind === 'status' ? drawStatus(v, d) : v.kind === 'log' ? drawLog(v, d) : v.kind === 'ext' ? v.ext.draw(v.model, v.repo, d)
  : v.kind === 'blame' ? drawBlame(v, d) : drawShow(v, d)));

/* The row of point's line in B, and how far into the line point is. */
function here(b: EdBuffer): { row: GitRow | undefined; col: number; line: number } {
  const v = viewOf(b), line = lineNoB(b, b.pt);
  return { row: v.rows[line - 1], col: b.pt - lineStartB(b, line), line };
}
/* Draw B from its model again, point on the row it was on (or the nearest section around it that is still
   shown, or the same line). */
function draw(b: EdBuffer, at: string | null = null) {
  const v = viewOf(b), was = here(b), id = at ?? (was.row ? was.row.id : null);
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
  const v = viewOf(b);
  if (v.kind === 'log') { void loadLog(b, true).catch(Ed.reportError); return; }   // in the background, as l l reads
  if (v.kind === 'blame') { void loadBlame(b).catch(Ed.reportError); return; }
  const seq = ++v.seq;
  if (v.kind === 'status') {
    const m = await collect(v.repo);
    if (seq !== v.seq || !E.buffers.includes(b)) return;
    v.model = m;
  } else if (v.kind === 'ext') {
    const m = await v.ext.read(v.repo, v.model);
    if (seq !== v.seq || !E.buffers.includes(b)) return;
    v.model = m;
  } else {
    const s = await readShow(v.repo, v.show.oid);
    if (seq !== v.seq || !E.buffers.includes(b)) return;
    v.show = s;
  }
  draw(b); Ed.scheduleRender();
}

/* The directory a status is asked from: a git buffer's repository, else the buffer's directory (a grep's). */
function directoryOf(b: EdBuffer): string | null {
  if (b.gitView) return viewOf(b).repo.root;
  return Ed.compile.directory(b);
}

/* The buffer of KIND for repository R: the one open, else a new one named `*git-NAME: REPO*` (with <2> when that
   name is taken), in MODE, read-only and in Motion state, its view what MAKE gives. */
function viewBuffer(r: VcRepo, kind: GitView['kind'], mode: string, make: () => GitView): EdBuffer {
  let b = buffersOf(r, kind)[0];
  if (b) return b;
  const name = `*git-${kind === 'show' ? 'revision' : kind}: ${repoName(r)}*`;
  b = Ed.getBufferCreate(Ed.getBuffer(name) ? L.call('generate-new-buffer-name', [name]) as string : name);
  b.mode = mode; b.readOnly = true; b.evilState = 'motion';
  b.gitView = make();
  b.pt = 0;
  return b;
}
const newView = (r: VcRepo) => ({ repo: r, folds: new Map<string, boolean>(), rows: [] as GitRow[], top: null as unknown as GitSection, seq: 0 });

/* Show the status of the repository around the current buffer's directory (jj's first, or with ONLY git's
   alone), reading it again when its buffer is open. */
async function status(only?: 'git'): Promise<false> {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const dir = directoryOf(cur()), r = dir ? Vc.repo(dir, only) : null;
  if (!r) signal('user-error', `Not in a ${only ? 'git ' : ''}repository: ${dir || 'no directory'}`);
  if (r!.vcs === 'jj') return VcJj.log(r!);
  let b = buffersOf(r!, 'status')[0];
  if (b) { await refresh(b); Ed.setWindowBuffer(b); Ed.scheduleRender(); return false; }
  const m = await collect(r!);
  b = buffersOf(r!, 'status')[0];   // opened while this one read
  if (b) await refresh(b);
  else { b = viewBuffer(r!, 'status', 'git-status-mode', () => ({ ...newView(r!), kind: 'status', model: m })); draw(b); }
  Ed.setWindowBuffer(b); Ed.scheduleRender();
  return false;
}

CMD('vc-status', '', '', 'Show the status of the repository the current buffer is in (SPC g g): git\'s status buffer, or a jj workspace\'s log (jj-log).', () => status());
CMD('git-status', '', '', 'Show the status of the git repository the current buffer is in, a colocated jj workspace\'s too (SPC g G): the head, the untracked files, the unstaged and staged changes with their hunks, the stashes and the commits not yet pushed or pulled.', () => status('git'));
CMD('git-status-refresh', '', '', 'Read the repository again (g r), keeping the folds and point; in a log buffer, its log from HEAD again, as many commits as it shows, in the background.', async () => { await refresh(cur()); return false; });

/* The innermost section point's line is in. */
function sectionAt(b: EdBuffer): GitSection | null {
  viewOf(b);
  const r = here(b).row;
  return r ? r.sec : null;
}
CMD('git-status-toggle', '', '', 'Fold or unfold the section at point (TAB): a part of the status, a file\'s hunks, or a hunk.', () => {
  const b = cur(), v = viewOf(b), s = sectionAt(b);
  if (!s || !s.body || !s.parent) { Ed.message('Nothing to fold here'); return false; }
  const key = s.id.slice(s.id.lastIndexOf('\0') + 1), was = v.folds.get(s.id);
  v.folds.set(s.id, !(was === undefined ? foldedFirst(v, key) : was));
  draw(b, s.id);
  return false;
});
/* Point to the heading of the next (DIR 1) or previous (-1) section, at any depth, or, SIBLING, of the same
   parent. */
function move(b: EdBuffer, dir: number, sibling: boolean) {
  const v = viewOf(b), { line } = here(b), at = line - 1;
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
CMD('git-status-visit', '', '', 'Show or visit what is at point (RET): a commit, in the revision buffer; the log\'s next page on its last line; else the file, on a hunk at its line, an untracked directory\'s listing. A file not in the work tree (deleted) is not visited.', () => {
  const b = cur(), v = viewOf(b), r = here(b).row;
  if (r && r.show) return v.kind === 'ext' ? v.ext.show(v.repo, r.show) : revision(v.repo, r.show);
  if (r && r.more) return v.kind === 'ext' ? v.ext.more!(b) : logMore();
  if (!r || !r.visit) signal('user-error', 'Nothing to visit here');
  /* a commit's tree may name what a work tree cannot hold: a path out of the repository is never visited */
  const rel = r!.visit!.path, p = join(v.repo.root, rel);
  if (rel.startsWith('/') || rel.split('/').includes('..')) signal('user-error', `${shown(rel)} is not in the work tree`);
  if (!Ed.host.files || !Ed.host.files.exists(p.replace(/\/$/, ''))) signal('user-error', `${shown(r!.visit!.path)} is not in the work tree`);
  if (p.endsWith('/')) return L.call('dired', [p.slice(0, -1)]);
  return L.call('visit-location', [p, r!.visit!.line]);
});

/* ---------- the log and the revision buffer ---------- */
/* Read B's log: with RESET from HEAD again, as many commits as it shows (a page at least), else the next page
   from the commit it started from. The buffer says it reads, and is drawn again when the page comes; a read
   started later (g r) wins, and one whose buffer was killed is left. */
async function loadLog(b: EdBuffer, reset: boolean) {
  const v = logOf(b), g = v.log;
  if (!reset && g.reading) { Ed.message('Still reading the log'); return; }
  if (!reset && !g.more) { Ed.message('No more commits'); return; }
  const seq = reset ? ++v.seq : v.seq;
  g.reading = reset ? 'all' : 'next'; g.note = null;
  draw(b); Ed.scheduleRender();
  try {
    const n = reset ? Math.max(PAGE, g.commits.length) : PAGE, skip = reset ? 0 : g.commits.length;
    const tip = reset ? await resolve(v.repo, 'HEAD') : g.tip;
    const got = tip === null ? [] : await readCommits(v.repo, tip, skip, n + 1);
    if (seq !== v.seq) return;
    if (reset) { g.tip = tip; g.commits = []; }
    g.commits.push(...got.slice(0, n));
    g.more = got.length > n;
  } catch (e) {
    if (seq === v.seq) g.note = 'the log could not be read: see *vc-process*';
    throw e;
  } finally {
    if (seq === v.seq) { g.reading = null; if (E.buffers.includes(b)) { draw(b); Ed.scheduleRender(); } }
  }
}

/* The repository a log or a commit is shown for: a git buffer's, else git's around the current buffer's
   directory, a jj workspace refused (DOING says what it would do). */
function gitRepo(doing: string): VcRepo {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const b = cur();
  if (b.gitView && viewOf(b).repo.vcs === 'git') return viewOf(b).repo;
  const dir = directoryOf(b), r = dir ? Vc.repo(dir) : null;
  if (!r) signal('user-error', `Not in a repository: ${dir || 'no directory'}`);
  if (r!.vcs === 'jj') signal('user-error', `${r!.root} is a jj workspace: ${doing}`);
  return r!;
}

/* Show HEAD's log in the repository's log buffer, read again from HEAD when it is open. The command ends at once;
   the first page comes in the background. */
function openLog(): false {
  const r = gitRepo('use jj log, or SPC g G and l l for its git repository\'s log');
  const b = viewBuffer(r, 'log', 'git-log-mode', () => ({ ...newView(r), kind: 'log', log: { tip: null, commits: [], more: false, reading: null, note: null } }));
  b.pt = 0;
  void loadLog(b, true).catch(Ed.reportError);
  Ed.setWindowBuffer(b); Ed.scheduleRender();
  return false;
}
/* The log's next page, in the background. */
function logMore(): false {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  void loadLog(cur(), false).catch(Ed.reportError);
  return false;
}

/* Show the commit REV names (a hash or a stash's name from a git buffer's line) in R's revision buffer. */
async function revision(r: VcRepo, rev: string): Promise<false> {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const oid = await resolve(r, rev);
  if (!oid) signal('user-error', `Not a commit: ${shown(rev)}`);
  const s = await readShow(r, oid!);
  const b = viewBuffer(r, 'show', 'git-revision-mode', () => ({ ...newView(r), kind: 'show', show: s })), v = b.gitView as GitShowView;
  ++v.seq;   // a refresh still reading draws nothing
  if (v.show.oid !== s.oid) { v.folds.clear(); b.pt = 0; }
  v.show = s; draw(b);
  Ed.setWindowBuffer(b); Ed.scheduleRender();
  return false;
}

/* ---------- views for other version control ---------- */
/* Show MODEL of KIND for R in KIND's buffer for R, `*NAME: REPO*` (with <2> when that name is taken), made when
   none is open. FRESH: it shows another thing than before (another change), so its folds are forgotten and point
   goes to its start. A read of it still running draws nothing. */
function openView(r: VcRepo, kind: VcViewKind, model: unknown, fresh: boolean): EdBuffer {
  let b = E.buffers.find(x => { const v = x.gitView as GitView | undefined; return !!v && v.kind === 'ext' && v.ext === kind && v.repo.root === r.root; });
  if (!b) {
    const name = `*${kind.name}: ${repoName(r)}*`;
    b = Ed.getBufferCreate(Ed.getBuffer(name) ? L.call('generate-new-buffer-name', [name]) as string : name);
    b.mode = kind.mode; b.readOnly = true; b.evilState = 'motion';
    b.gitView = { ...newView(r), kind: 'ext', ext: kind, model } as GitExtView;
    b.pt = 0;
  }
  const v = b.gitView as GitExtView;
  ++v.seq;
  if (fresh) { v.folds.clear(); b.pt = 0; }
  v.model = model; draw(b);
  Ed.setWindowBuffer(b); Ed.scheduleRender();
  return b;
}
/* The model of B, a buffer of KIND. */
function modelOf(b: EdBuffer, kind: VcViewKind): unknown {
  const v = b.gitView as GitView | undefined;
  return v && v.kind === 'ext' && v.ext === kind ? v.model : signal('user-error', `Not a ${kind.name} buffer`);
}
/* What the line at point in B, a buffer of KIND, says RET does there. */
function atPoint(b: EdBuffer, kind: VcViewKind): VcRowExtra | null {
  modelOf(b, kind);
  const r = here(b).row;
  return r && (r.visit || r.show || r.more) ? { visit: r.visit, show: r.show, more: r.more } : null;
}
/* What the lines of B, a buffer of KIND, say RET does there: in Visual state the selected lines' (Visual state then
   left), else the line at point's; lines that say nothing are left out. */
function selectedRows(b: EdBuffer, kind: VcViewKind): VcRowExtra[] {
  modelOf(b, kind);
  const v = viewOf(b);
  let rows: (GitRow | undefined)[];
  if (EvilCore.stateOf(b) === 'visual') {
    const [s, e] = EvilCore.visualRange(b, true);
    EvilCore.setState(b, 'motion');
    rows = v.rows.slice(lineNoB(b, s) - 1, lineNoB(b, Math.max(s, e - 1)));
  } else rows = [here(b).row];
  return rows.filter((r): r is GitRow => !!r && !!(r.visit || r.show || r.more)).map(r => ({ visit: r.visit, show: r.show, more: r.more }));
}
/* Draw B, a view buffer, from its model again, without reading. */
const redraw = (b: EdBuffer) => { draw(b); Ed.scheduleRender(); };
globalThis.VcView = { faces: F, open: openView, model: modelOf, at: atPoint, selected: selectedRows, redraw, refresh, hunks, fileHeading, shown };

/* ---------- blame ---------- */
/* P's true name, every symbolic link followed; P where the host cannot say. */
const truename = (p: string) => { try { return Ed.host.files!.truename(p); } catch (e) { return p; } };
/* The blame buffer's author column: as wide as its longest author, at most this, a longer one cut with … */
const AUTHOR_MAX = 20;
/* The day of an author date (seconds since the epoch and git's zone, `+0100`) in the author's own zone, as
   `YYYY-MM-DD`; ? for a time that is no date. */
function dayOf(time: string, tz: string): string {
  const z = /^([+-])(\d\d)(\d\d)$/.exec(tz), off = z ? (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) * 60 : 0;
  const d = new Date((Number(time) + off) * 1000);
  return /^\d+$/.test(time) && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '?'.padEnd(10);
}
const isZero = (oid: string) => /^0+$/.test(oid);
/* `git blame --porcelain`'s output as a line for each of the file's, in order: each line's group starts with `OID
   ORIG FINAL [COUNT]`, a commit's headers (author, author-time, author-tz and others) follow only the first time
   it is named, and the line's text follows a TAB. A line not committed has the zero hash. Anything else is
   refused. */
function readBlame(out: string): GitBlameLine[] {
  const commits = new Map<string, { author: string; time: string; tz: string }>(), lines: GitBlameLine[] = [];
  const bad = (l: string) => signal('process-error', `git blame printed a line Edwin cannot read: ${shown(l).slice(0, 200)}`);
  let at: { oid: string; final: number } | null = null;
  for (const l of out.split('\n')) {
    if (l.startsWith('\t')) {
      if (!at || at.final !== lines.length + 1) bad(l);
      const c = commits.get(at!.oid)!, zero = isZero(at!.oid);
      lines.push({ oid: at!.oid, author: zero ? 'Not committed yet' : c.author, date: zero ? ''.padEnd(10) : dayOf(c.time, c.tz), text: l.slice(1) });
      at = null;
      continue;
    }
    const h = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(l);
    if (h && !at) {
      at = { oid: h[1], final: Number(h[2]) };
      if (!commits.has(h[1])) commits.set(h[1], { author: '', time: '', tz: '' });
      continue;
    }
    const sp = l.indexOf(' '), key = sp < 0 ? l : l.slice(0, sp), c = at && commits.get(at.oid);
    if (!c) { if (l) bad(l); continue; }
    if (key === 'author') c.author = l.slice(sp + 1);
    else if (key === 'author-time') c.time = l.slice(sp + 1);
    else if (key === 'author-tz') c.tz = l.slice(sp + 1);
  }
  if (at) bad(`${at.oid} with no line after it`);
  return lines;
}

/* The blame buffer's lines: line K is the file's line K, its commit's short hash, author and day, then its text
   (a control character but TAB shown as ?). A last line past the file's says when it is being read or could not
   be, or that the file is empty. */
function drawBlame(v: GitBlameView, d: Drawer) {
  const g = v.blame, ls = g.lines || [];
  const width = Math.min(AUTHOR_MAX, ls.reduce((n, l) => Math.max(n, shown(l.author).length), 0));
  ls.forEach((l, k) => {
    const zero = isZero(l.oid), a = shown(l.author), author = a.length > width ? a.slice(0, width - 1) + MARK : a.padEnd(width);
    const head = `${l.oid.slice(0, 8)} ${author} ${l.date} `, text = l.text.replace(/\r$/, '').replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, '?');
    d.line('l' + k, head + text, [[0, 8, zero ? F.DIM : F.HASH], [9, head.length - 1, F.DIM]], { show: zero ? undefined : l.oid, visit: { path: g.path, line: k + 1 } });
  });
  const tail = (text: string) => d.line('tail', text, [[0, text.length, F.DIM]]);
  if (g.reading) tail(`(blaming ${shown(g.path)}…)`);
  else if (g.note) tail(`(${g.note})`);
  else if (g.lines && !ls.length) tail('(the file is empty)');
}

/* Read B's blame, in the background: of the text of the buffer that visits its file when that buffer has
   changes not saved (`--contents -`, so its lines are the buffer's), else of the file as it is on disk (its
   bytes, which a buffer's text decoded from a file that is not UTF-8 no longer matches). A read started later
   wins; a buffer killed meanwhile is left. Point then goes to the line asked for, once. */
async function loadBlame(b: EdBuffer) {
  const v = b.gitView as GitBlameView, g = v.blame, seq = ++v.seq;
  g.reading = true; g.note = null;
  draw(b); Ed.scheduleRender();
  try {
    const src = E.buffers.find(x => x.modified && x.file && !x.gitView && truename(x.file) === g.file);
    const x = await Vc.run(v.repo, ['blame', '--porcelain', ...(src ? ['--contents', '-'] : []), '--', g.path], { ...READ, lossy: true, input: src ? src.text : undefined });
    if (x.error || x.timedOut || x.truncated) failed(x, 'git blame');
    if (x.code !== 0) signal('process-error', `Not blamed: ${reason(x)} (see *vc-process*)`);
    const lines = readBlame(x.out);
    if (seq === v.seq) g.lines = lines;
  } catch (e) {
    if (seq === v.seq) g.note = 'the blame could not be read: see *vc-process*';
    throw e;
  } finally {
    if (seq === v.seq) {
      g.reading = false;
      if (E.buffers.includes(b)) {
        draw(b);
        if (g.line !== null && g.lines) {
          b.pt = lineStartB(b, Math.max(1, Math.min(g.line, g.lines.length)));
          for (const w of Ed.windowList()) if (w.buffer === b && w !== E.sel) w.pt = b.pt;
          g.line = null;
        }
        Ed.scheduleRender();
      }
    }
  }
}

/* Blame the file the current buffer visits in `*git-blame: PATH*`, beside it: the blame in the window the file
   was in and the file in a new window on its right (or the blame selected where it is already shown), point on
   the line point was on in the file once the blame is read. The command ends at once; the blame is read in the
   background. The file is taken by its true name, so a name through a symbolic link blames, and selects, the
   file it names. */
function openBlame(): false {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const src = cur(), visited = src.gitView ? null : src.file;
  if (!visited || !visited.startsWith('/')) signal('user-error', `${shown(src.name)} visits no file: git-blame blames a file's lines`);
  const file = truename(visited!);
  const dir = file!.slice(0, file!.lastIndexOf('/')) || '/', r = Vc.repo(dir, 'git');
  if (!r) signal('user-error', `Not in a git repository: ${shown(dir)}`);
  const path = file!.slice(r!.root === '/' ? 1 : r!.root.length + 1), line = lineNoB(src, src.pt);
  let b = E.buffers.find(x => { const v = x.gitView as GitView | undefined; return !!v && v.kind === 'blame' && v.blame.file === file; });
  if (!b) {
    const name = `*git-blame: ${shown(path)}*`;
    b = Ed.getBufferCreate(Ed.getBuffer(name) ? L.call('generate-new-buffer-name', [name]) as string : name);
    b.mode = 'git-blame-mode'; b.readOnly = true; b.evilState = 'motion';
    b.gitView = { ...newView(r!), kind: 'blame', blame: { file: file!, path, lines: null, reading: false, note: null, line } } as GitBlameView;
    b.pt = 0;
  } else (b.gitView as GitBlameView).blame.line = line;
  const shownIn = Ed.windowFor(b);
  if (shownIn) Ed.selectWindow(shownIn);
  else { Ed.splitWindow(E.sel, 'right'); Ed.setWindowBuffer(b); }
  void loadBlame(b).catch(Ed.reportError);
  Ed.scheduleRender();
  return false;
}
CMD('git-blame', '', '', 'Blame the file the current buffer visits (SPC g b), beside it: a line for each of its lines with the commit that last changed it, its author and day, read in the background from the file, or from the buffer\'s text when it has changes not saved (a line changed and not committed says so); RET on a line shows its commit, g r reads it again.', () => openBlame());

CMD('git-log', '', '', 'Show the log of HEAD in the current buffer\'s git repository (l l in the status buffer): a commit per line, read a page at a time in the background; RET on a commit shows it, + reads the next page.', () => openLog());
CMD('git-log-more', '', '', 'Read the log\'s next page (+), in the background.', () => { logOf(cur()); return logMore(); });
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

/* ---------- committing ---------- */
/* A commit's hooks may run a whole test suite and print as much as they like (git sends what they print to its
   error output): a commit has no bound on its output, which would kill it partway, only a time. Kept of it are
   the head of its output (git's `[main 1234567] Subject` line comes first, the files after) and the tail of its
   error output (why it failed comes last). */
const COMMIT_TIMEOUT = 600000, OUT_KEPT = 64 * 1024, ERR_KEPT = 64 * 1024;
type CommitKind = 'commit' | 'amend' | 'reword';
/* The message of a commit git refused (a hook said no), by repository root and kind: the next commit of that
   kind there starts from it. Taken when that message buffer opens. */
const kept = new Map<string, string>();

/* The repository a commit command acts on: a status buffer's, else git's (jj's workspace refused) around the
   current buffer's directory. */
function commitRepo(): VcRepo {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const b = cur();
  if (b.gitView && viewOf(b).repo.vcs === 'git') return viewOf(b).repo;
  const dir = directoryOf(b), r = dir ? Vc.repo(dir) : null;
  if (!r) signal('user-error', `Not in a repository: ${dir || 'no directory'}`);
  if (r!.vcs === 'jj') signal('user-error', `${r!.root} is a jj workspace: describe its change with jj, or commit from SPC g G's status buffer`);
  return r!;
}

/* Read REPO, refusing what git would refuse before anything is written: a conflict left, nothing staged (a
   commit), no commit yet (amend, reword, fixup). */
async function ready(r: VcRepo, kind: CommitKind | 'fixup'): Promise<GitModel> {
  const m = await collect(r);
  if (m.unmerged.length) signal('user-error', `${m.unmerged.length} conflicted file${m.unmerged.length === 1 ? '' : 's'}: resolve and stage ${m.unmerged.length === 1 ? 'it' : 'them'} first`);
  if (kind !== 'commit' && m.oid === null) signal('user-error', 'No commit yet: nothing to ' + (kind === 'fixup' ? 'fix up' : kind));
  if ((kind === 'commit' || kind === 'fixup') && !m.staged.length) signal('user-error', 'Nothing staged: stage changes with s first');
  return m;
}

/* The comment lines under a message: what it is for and, but for a reword, the staged files it takes. */
function template(r: VcRepo, m: GitModel, kind: CommitKind): string {
  const on = m.branch !== null ? `on branch ${shown(m.branch)}` : 'on a detached HEAD';
  const head = m.head ? `${m.head.hash} ${shown(m.head.subject)}` : '';
  const lines = [
    kind === 'commit' ? `Committing ${on} in ${shown(r.root)}.` : `${kind === 'amend' ? 'Amending' : 'Rewording'} ${head} ${on} in ${shown(r.root)}.`,
    'C-c C-c commits, C-c C-k aborts. Lines starting with # are left out.',
  ];
  if (kind === 'reword') lines.push('Only the message changes: the staged changes stay staged, and no pre-commit or commit-msg hook runs.');
  else if (m.staged.length) {
    lines.push('', kind === 'amend' ? 'Staged changes it takes as well:' : 'Changes to be committed:');
    for (const f of m.staged) lines.push(`\t${(f.label + ':').padEnd(12)}${f.orig !== null ? `${shown(f.orig)} -> ` : ''}${shown(f.path)}`);
  }
  return lines.map(l => (l ? '# ' + l : '#')).join('\n').replace(/^# \t/gm, '#\t') + '\n';
}

/* What a failed commit printed last on its error output, for the message. */
function lastError(x: EdProcResult): string {
  const ls = x.err.split('\n').map(l => l.trim()).filter(l => l);
  return ls.length ? ': ' + shown(ls[ls.length - 1]).slice(0, 200) : '';
}

/* git ARGS in R, a write whose hooks may print much (a commit, a rebase): no bound on its output, only a time, and
   kept of it the head of its output and the tail of its error output. INPUT goes to its standard input;
   KEEPMESSAGE and EDIT as Vc.run has them. */
async function runLong(r: VcRepo, args: string[], input?: string, keepMessage = false, edit?: VcRunOptions['edit']): Promise<EdProcResult> {
  let out = '', err = '';
  const p = await Vc.start(r, args, {
    timeout: COMMIT_TIMEOUT, lossy: true, keepMessage, edit,
    onOut: s => { if (out.length < OUT_KEPT) out += s; },
    onErr: s => { err += s; if (err.length > 2 * ERR_KEPT) err = err.slice(-ERR_KEPT); },
  });
  try {
    if (input) p.write(input);
    p.closeStdin();
  } catch (e) { p.kill('KILL'); throw e; }
  return { ...await p.exit, out, err };
}
/* git commit ARGS in R: its result said ("[main 1234567] subject"), the status buffers of R read again. */
async function commitWith(r: VcRepo, args: string[], input?: string): Promise<EdProcResult> {
  const x = await runLong(r, ['commit', ...args], input);
  /* (a status that cannot be read again is said, the commit done all the same) */
  for (const b of buffersOf(r, 'status')) await refresh(b).catch(Ed.reportError);
  return x;
}
function said(x: EdProcResult) {
  const l = x.out.split('\n').find(s => /^\[.+\] /.test(s));
  Ed.message(l ? shown(l) : 'Committed');
}

/* Commit, amend or reword with a message written in the message buffer. */
async function commit(kind: CommitKind): Promise<false> {
  const r = commitRepo();
  if (kind !== 'reword') await Vc.offerSave(r, 'committing');
  const m = await ready(r, kind);
  let text = '\n';
  const key = r.root + '\0' + kind, last = kept.get(key);
  if (last !== undefined) text = last;
  else if (kind !== 'commit') {
    const x = await Vc.run(r, ['log', '-1', '--format=%B', 'HEAD', '--'], READ);
    if (x.code !== 0 || x.error || x.truncated) failed(x, 'git log');
    text = x.out.replace(/\n+$/, '') + '\n';
  }
  const name = `*git-commit: ${r.root.slice(r.root.lastIndexOf('/') + 1) || '/'}*`;
  /* The command ends once the buffer is open (commands run one at a time, and C-c C-c is one): the commit runs
     when the message comes, its failure reported as a command's would be. */
  const pending = Vc.message({ name, text: text + '\n' + template(r, m, kind), comment: '#' });
  kept.delete(key);   // taken: an abort lets it go
  void pending.then(msg => (msg === null ? undefined : commitMessage(r, kind, key, msg))).catch(Ed.reportError).finally(() => Ed.scheduleRender());
  return false;
}
/* git commit of MSG in R as KIND says. A commit git refuses (a hook said no) keeps MSG under KEY for the next. */
async function commitMessage(r: VcRepo, kind: CommitKind, key: string, msg: string) {
  /* The message on standard input, as written: it is cleaned already, and the repository's commit.cleanup or
     core.commentChar must not clean it again. */
  const args = ['--cleanup=verbatim', '-F', '-'];
  if (kind === 'amend') args.unshift('--amend');
  /* the message alone: --only with no paths leaves the staged changes out; no pre-commit or commit-msg hook (owner decision 12) */
  if (kind === 'reword') args.unshift('--amend', '--only', '--no-verify');
  let x: EdProcResult;
  try { x = await commitWith(r, args, msg); }
  catch (e) { kept.set(key, msg); throw e; }
  if (x.code !== 0 || x.error || x.timedOut) {
    kept.set(key, msg);
    signal('process-error', `git commit failed (${x.error || (x.timedOut ? 'it took too long' : `exit ${x.code}`)})${lastError(x)}; the message is kept for the next ${kind === 'commit' ? 'commit' : kind} (see *vc-process*)`);
  }
  said(x);
}

/* The commit a fixup is for: the commit on the line at point in a status buffer, else one asked for (HEAD by
   default), as its full hash. What is typed is given to git only after `--end-of-options`, as one argument. */
async function fixupTarget(r: VcRepo): Promise<string> {
  const b = cur(), row = b.gitView ? here(b).row : undefined;
  let rev = row && row.commit;
  if (!rev) rev = (await Ed.readMini('Fix up commit (HEAD): ', '')).trim() || 'HEAD';
  const x = await Vc.run(r, ['rev-parse', '--verify', '--quiet', '--end-of-options', rev + '^{commit}'], { ...READ, lossy: true });
  const hash = x.out.trim();
  if (x.code !== 0 || !/^[0-9a-f]{40,64}$/.test(hash)) signal('user-error', `Not a commit: ${shown(rev)}`);
  return hash;
}
async function fixup(): Promise<false> {
  const r = commitRepo();
  await Vc.offerSave(r, 'committing');
  await ready(r, 'fixup');
  const hash = await fixupTarget(r);
  /* The commit, its hooks perhaps long, runs after the command ends, as a message buffer's does. */
  void commitWith(r, ['--fixup=' + hash]).then(x => {
    if (x.code !== 0 || x.error || x.timedOut) signal('process-error', `git commit --fixup failed (${x.error || (x.timedOut ? 'it took too long' : `exit ${x.code}`)})${lastError(x)} (see *vc-process*)`);
    said(x);
  }).catch(Ed.reportError).finally(() => Ed.scheduleRender());
  return false;
}

CMD('git-commit', '', '', 'Commit the staged changes (c c) with a message written in a buffer (C-c C-c commits, C-c C-k aborts), after offering to save the changed buffers of the repository. A message git refused (a hook) comes back the next time.', () => commit('commit'));
CMD('git-commit-amend', '', '', 'Amend the last commit (c a): its message, in a buffer, and the staged changes.', () => commit('amend'));
CMD('git-commit-reword', '', '', 'Change the last commit\'s message only (c w): the staged changes stay staged, and no pre-commit or commit-msg hook runs.', () => commit('reword'));
CMD('git-commit-fixup', '', '', 'Commit the staged changes as a fixup of the commit at point, or of one asked for (c f): `fixup! SUBJECT`, for git rebase --autosquash.', () => fixup());

/* ---------- branches, checkout, reset, stash and tags ---------- */
/* Each of these writes: so long at most (a checkout of a large tree), and so much output (its list of files). */
const WRITE = { timeout: 120000, maxBytes: MAX_BYTES, lossy: true };
const JJ_HISTORY = 'jj has its own commands for its changes and bookmarks; SPC g G\'s status buffer works on its git repository';

/* git ARGS in R, a write: its result, whatever its exit; one that could not run, ran too long or printed too much
   raised. */
async function gitWrite(r: VcRepo, args: string[]): Promise<EdProcResult> {
  const x = await Vc.run(r, args, WRITE);
  if (x.error || x.timedOut || x.truncated) failed(x, `git ${args[0]}`);
  return x;
}
const firstLine = (s: string) => shown(s.split('\n').find(l => l.trim()) || '').trim();
/* NAMES for a message: the first five, then how many more. */
const listed = (names: string[]) => names.slice(0, 5).map(shown).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
/* git's reason for a failure: its first `error:` or `fatal:` line, without the prefix. */
function reason(x: EdProcResult): string {
  const l = (x.err + '\n' + x.out).split('\n').find(s => /^(error|fatal): /.test(s));
  return l ? shown(l.replace(/^(error|fatal): /, '')).slice(0, 300) : `exit ${x.code}`;
}
/* What git refused to overwrite, as it says it: the files of the local changes or the untracked files in the way.
   Null when that is not why it failed. */
function inTheWay(x: EdProcResult): string | null {
  const m = /(Your local changes to the following files|The following untracked working tree files) would be (overwritten|removed) by \w+:\n((?:(?:\t| {2}).*(?:\n|$))+)/.exec(x.err);
  if (!m) return null;
  const files = m[3].split('\n').map(l => l.trim()).filter(l => l);
  return m[1].startsWith('Your')
    ? `your local changes to ${listed(files)} would be overwritten; commit or stash them (z z) first`
    : `the untracked ${listed(files)} would be ${m[2]}; move ${files.length === 1 ? 'it' : 'them'} away first`;
}
/* Raise git's failure X, WHAT saying what was not done. */
function refused(x: EdProcResult, what: string): never {
  const way = inTheWay(x);
  if (way) return signal('user-error', `${what}: ${way}`) as never;
  return signal('process-error', `${what}: ${reason(x)} (see *vc-process*)`) as never;
}
/* What a switch said besides where HEAD is now: the local changes it carried, the commits it left on no branch. */
function carried(x: EdProcResult): string {
  let s = '';
  const kept = x.out.split('\n').filter(l => /^[A-Z]\t/.test(l)).length;
  if (kept) s += `; local changes kept in ${kept} file${kept === 1 ? '' : 's'}`;
  const left = /you are leaving (\d+) commits? behind/.exec(x.err.replace(/\s+/g, ' '));
  if (left) {
    const n = +left[1], tip = /^ {2}([0-9a-f]{7,}) (.*)$/m.exec(x.err);
    s += `; ${n} commit${n === 1 ? '' : 's'} left on no branch${tip ? `, the last ${tip[1]} ${shown(tip[2])}` : ''} (b n there names ${n === 1 ? 'it' : 'them'})`;
  }
  return s;
}

/* R's refs, from for-each-ref (a read): the local branches with the commit each is at, the remote branches (but
   their HEAD) and the tags, by their short names. A name that is not UTF-8, holds a control character or starts
   with `-` is left out: it is never given back to git. */
interface GitRefs { heads: Map<string, string>; remotes: string[]; tags: string[] }
async function readRefs(r: VcRepo): Promise<GitRefs> {
  const x = await Vc.run(r, ['for-each-ref', '--format=%(objectname)%00%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { ...READ, lossy: true });
  if (x.code !== 0 || x.truncated || x.error) failed(x, 'git for-each-ref');
  const refs: GitRefs = { heads: new Map(), remotes: [], tags: [] };
  for (const l of x.out.split('\n')) {
    const [oid, ref] = l.split('\0');
    if (!ref || /[\u0000-\u001f\u007f�]/.test(ref)) continue;
    const [, kind, name] = /^refs\/(heads|remotes|tags)\/(.*)$/.exec(ref) || [];
    if (!name || name.startsWith('-')) continue;
    if (kind === 'heads') refs.heads.set(name, oid);
    else if (kind === 'tags') refs.tags.push(name);
    else if (!name.endsWith('/HEAD')) refs.remotes.push(name);
  }
  return refs;
}
const refNames = (refs: GitRefs) => [...refs.heads.keys(), ...refs.remotes, ...refs.tags];
/* The branch HEAD is on (an unborn one too), or null when it is detached. */
async function currentBranch(r: VcRepo): Promise<string | null> {
  const x = await Vc.run(r, ['symbolic-ref', '--quiet', 'HEAD'], { ...READ, lossy: true });
  if (x.code === 1 && !x.error && !x.timedOut) return null;
  if (x.code !== 0 || x.error || x.timedOut) failed(x, 'git symbolic-ref');
  const ref = x.out.trim();
  return ref.startsWith('refs/heads/') ? ref.slice(11) : null;
}
/* The commit point's line in B shows (a commit's line, the Head and Merge lines, a parent's), never a stash's. */
function commitAt(b: EdBuffer): string | undefined {
  if (!b.gitView) return undefined;
  const row = here(b).row;
  return row && !row.stash ? row.show : undefined;
}
/* What point in B names as a revision: a local branch at the commit on its line (one but CURRENT when there are
   several), else the commit. */
async function revAt(r: VcRepo, b: EdBuffer, refs: GitRefs, current: string | null): Promise<string | undefined> {
  const rev = commitAt(b);
  if (!rev) return undefined;
  const oid = await resolve(r, rev);
  if (!oid) return undefined;
  const names = [...refs.heads].filter(([, o]) => o === oid).map(([n]) => n);
  return names.find(n => n !== current) ?? names[0] ?? rev;
}
/* A revision or a name read at PROMPT, completed from CANDS, DEF first (what RET gives on an empty input; a full
   hash shown by its first 7 digits); with REQUIRE, one of CANDS. '' when nothing is typed and there is no
   default. */
async function ask(prompt: string, cands: string[], def?: string, require = false): Promise<string> {
  const list = def === undefined ? cands : [def, ...cands.filter(c => c !== def)];
  const p = def === undefined ? `${prompt}: ` : `${prompt} (${shown(/^[0-9a-f]{40,64}$/.test(def) ? def.slice(0, 7) : def)}): `;
  return (await Ed.readMini(p, '', list.length ? () => list : null, { def, require, kind: 'git-rev', keepOrder: true, noIndex: true })).trim();
}
/* REV, typed or offered, as the full hash of its commit; refused when it names none. */
async function commitOf(r: VcRepo, rev: string): Promise<string> {
  if (!rev) signal('user-error', 'No revision given');
  return (await resolve(r, rev)) || signal('user-error', `Not a commit: ${shown(rev)}`) as never;
}
/* OID as a message names it: its short hash and subject. */
async function described(r: VcRepo, oid: string): Promise<string> {
  const [c] = await readLog(r, ['--max-count=1', oid]);
  return c ? `${c.hash} ${shown(c.subject)}` : oid.slice(0, 7);
}
/* NAME as a new branch's or tag's, refused unless git takes it as it is typed: check-ref-format (a read) finds
   it valid and expands nothing in it (`@{-1}`, the branch before). */
async function newName(r: VcRepo, kind: 'branch' | 'tag', name: string): Promise<string> {
  if (!name) signal('user-error', `No ${kind} name given`);
  const x = name.startsWith('-') ? null : await Vc.run(r, kind === 'branch' ? ['check-ref-format', '--branch', name] : ['check-ref-format', 'refs/tags/' + name], { ...READ, lossy: true });
  if (!x || x.code !== 0 || kind === 'branch' && x.out.trim() !== name) signal('user-error', `Not a valid ${kind} name: ${shown(name)}`);
  return name;
}

/* Run OP on the current buffer's git repository (a jj workspace refused), then read its status and log buffers
   again, whether it worked or not: a conflict it left, or a moved HEAD, is shown. */
async function historyOp(op: (r: VcRepo, b: EdBuffer) => Promise<void>): Promise<false> {
  const b = cur(), r = gitRepo(JJ_HISTORY);
  let err: unknown = null;
  try { await op(r, b); } catch (e) { err = e; }
  for (const s of buffersOf(r, 'status')) await refresh(s).catch(Ed.reportError);
  for (const l of buffersOf(r, 'log')) void loadLog(l, true).catch(Ed.reportError);
  if (err) throw err;
  return false;
}

/* b b: a local branch becomes HEAD; anything else (a remote branch, a tag, a commit) is checked out detached, as
   magit-checkout does. */
async function checkout(r: VcRepo, b: EdBuffer) {
  const [refs, current] = await Promise.all([readRefs(r), currentBranch(r)]);
  const rev = await ask('Checkout', refNames(refs), await revAt(r, b, refs, current));
  if (!rev) signal('user-error', 'No branch or commit given');
  if (refs.heads.has(rev)) {
    const x = await gitWrite(r, ['switch', '--end-of-options', rev]);
    if (x.code !== 0) refused(x, 'Not checked out');
    const said = /^(Switched to branch '.*'|Already on '.*')$/m.exec(x.err);
    Ed.message((said ? shown(said[1]) : `On branch ${shown(rev)}`) + carried(x));
    return;
  }
  const oid = (await resolve(r, rev)) || signal('user-error', `Not a branch or commit: ${shown(rev)}`) as never;
  const x = await gitWrite(r, ['switch', '--detach', oid]);
  if (x.code !== 0) refused(x, 'Not checked out');
  Ed.message(`HEAD detached at ${await described(r, oid)}` + carried(x));
}
/* b c and b n: a new branch starting at a revision (point's, else the current branch), checked out with CHECKOUT.
   A ref's name is given to git as it is, so a remote branch becomes the new branch's upstream (git's
   branch.autoSetupMerge); anything else as its commit's hash. */
async function branchCreate(r: VcRepo, b: EdBuffer, checkout: boolean) {
  const [refs, current] = await Promise.all([readRefs(r), currentBranch(r)]);
  const start = await ask(checkout ? 'Create and checkout branch starting at' : 'Create branch starting at', refNames(refs), (await revAt(r, b, refs, current)) ?? current ?? 'HEAD');
  const oid = await commitOf(r, start), at = refNames(refs).includes(start) ? start : oid;
  const name = await newName(r, 'branch', (await Ed.readMini('Name for new branch: ', '', null, { kind: 'git-branch-name' })).trim());
  const x = await gitWrite(r, checkout ? ['switch', '-c', name, '--end-of-options', at] : ['branch', '--end-of-options', name, at]);
  if (x.code !== 0) refused(x, 'No branch created');
  const where = await described(r, oid);
  Ed.message(checkout ? `Switched to a new branch ${shown(name)} at ${where}` + carried(x) : `Branch ${shown(name)} created at ${where}`);
}
/* b x: a local branch deleted; one not merged into HEAD or its upstream only after asking, as magit does. */
async function branchDelete(r: VcRepo, b: EdBuffer) {
  const [refs, current] = await Promise.all([readRefs(r), currentBranch(r)]);
  const at = await revAt(r, b, refs, current), others = [...refs.heads.keys()].filter(n => n !== current);
  const name = await ask('Delete branch', others, at !== undefined && at !== current && refs.heads.has(at) ? at : undefined, true);
  if (!name || !refs.heads.has(name)) signal('user-error', `Not a branch: ${shown(name)}`);
  let x = await gitWrite(r, ['branch', '-d', '--end-of-options', name]);
  if (x.code !== 0 && /is not fully merged/.test(x.err)) {
    if (!await Ed.yesOrNo(`Branch ${shown(name)} is not fully merged: delete it anyway?`)) { Ed.message('Nothing deleted'); return; }
    x = await gitWrite(r, ['branch', '-D', '--end-of-options', name]);
  }
  if (x.code !== 0) refused(x, 'Not deleted');
  Ed.message(firstLine(x.out) || `Deleted branch ${shown(name)}`);
}
/* b m: a local branch renamed (the current one by default). */
async function branchRename(r: VcRepo) {
  const [refs, current] = await Promise.all([readRefs(r), currentBranch(r)]);
  const old = await ask('Rename branch', [...refs.heads.keys()], current !== null && refs.heads.has(current) ? current : undefined, true);
  if (!old || !refs.heads.has(old)) signal('user-error', `Not a branch: ${shown(old)}`);
  const name = await newName(r, 'branch', (await Ed.readMini(`Rename ${shown(old)} to: `, '', null, { kind: 'git-branch-name' })).trim());
  const x = await gitWrite(r, ['branch', '-m', '--end-of-options', old, name]);
  if (x.code !== 0) refused(x, 'Not renamed');
  Ed.message(`Branch ${shown(old)} renamed to ${shown(name)}`);
}
/* O s, O m and O h: HEAD (its branch) reset to a revision, point's or HEAD. A hard reset asks first, naming the
   branch and the commit. */
async function reset(r: VcRepo, b: EdBuffer, mode: 'soft' | 'mixed' | 'hard') {
  const [refs, current] = await Promise.all([readRefs(r), currentBranch(r)]);
  const head = current === null ? 'HEAD' : shown(current), Mode = mode[0].toUpperCase() + mode.slice(1);
  const oid = await commitOf(r, await ask(`${Mode} reset ${head} to`, refNames(refs), commitAt(b) ?? 'HEAD'));
  const what = await described(r, oid);
  if (mode === 'hard') {
    const lost = await overwritten(r, oid);
    const also = lost.length === 0 ? ''
      : `, and overwriting ${lost.length === 1 ? 'the untracked ' + (lost[0].endsWith('/') ? 'directory' : 'file') : lost.length + ' untracked files'} ${lost.slice(0, 3).map(shown).join(', ')}${lost.length > 3 ? ', …' : ''}`;
    if (!await Ed.yesOrNo(`Hard reset ${head} to ${what}, discarding every uncommitted change to tracked files${also}?`)) { Ed.message('Nothing reset'); return; }
  }
  const x = await gitWrite(r, ['reset', '-q', '--' + mode, oid, '--']);
  if (x.code !== 0) refused(x, 'Not reset');
  Ed.message(`${head} reset to ${what} (${mode})`);
}

/* The untracked or ignored files a hard reset to OID would overwrite, which git does without a word: those at a
   path OID tracks, under one (a directory where OID has a file), or at a directory of one (a file where OID has a
   directory). ls-files names a wholly untracked directory with a trailing / (and not at all one standing where the
   index has a file, which diff calls deleted): the files of those a path of OID is in are read one by one. A
   directory named is lost whole. Reads only. */
async function overwritten(r: VcRepo, oid: string): Promise<string[]> {
  const list = async (args: string[], what: string) => {
    const x = await Vc.run(r, args, { ...READ, lossy: true });
    if (x.code !== 0 || x.error || x.timedOut || x.truncated) failed(x, what);
    return x.out.split('\0').filter(p => p);
  };
  const [target, others, deleted] = await Promise.all([
    list(['ls-tree', '-r', '-z', '--name-only', '--full-tree', oid], 'git ls-tree'),
    list(['ls-files', '-z', '--others', '--directory', '--no-empty-directory', '--full-name'], 'git ls-files'),
    list(['diff', '--name-only', '-z', '--diff-filter=D'], 'git diff'),
  ]);
  const files = new Set(target), dirs = new Set<string>();   // OID's files, and its directories (each with a /)
  for (const p of target) for (let k = p.indexOf('/'); k >= 0; k = p.indexOf('/', k + 1)) dirs.add(p.slice(0, k + 1));
  /* whether OID has a file at path P (a directory's ends in /) or at a directory P is in */
  const under = (p: string) => { for (let k = p.indexOf('/'); k >= 0 && k < p.length - 1; k = p.indexOf('/', k + 1)) if (files.has(p.slice(0, k))) return true; return files.has(p.replace(/\/$/, '')); };
  const lost = new Set<string>(), read: string[] = [];
  /* A directory a path of OID is in is read, unless its name is not UTF-8 (read lossily, it holds U+FFFD and
     cannot be given back to git): that one is named whole. */
  const toRead = (d: string) => { if (d.includes('�')) lost.add(d); else read.push(d); };
  for (const p of others) {
    if (under(p) || (!p.endsWith('/') && dirs.has(p + '/'))) lost.add(p);
    else if (p.endsWith('/') && dirs.has(p)) toRead(p);
  }
  for (const p of deleted) if (under(p) || dirs.has(p + '/')) toRead(p + '/');
  /* ls-files does not look into a nested repository and lists it as a directory (its / kept): one a path of OID
     is in is named whole. */
  if (read.length) for (const p of await list(['ls-files', '-z', '--others', '--full-name', '--', ...read.map(d => ':(top,literal)' + d)], 'git ls-files')) if (under(p) || dirs.has(p.endsWith('/') ? p : p + '/')) lost.add(p);
  return [...lost].sort();
}
/* The files git left in conflict. */
async function conflicted(r: VcRepo): Promise<string[]> {
  const x = await Vc.run(r, ['diff', '--name-only', '--diff-filter=U', '-z'], { ...READ, lossy: true });
  if (x.code !== 0 || x.error || x.timedOut || x.truncated) failed(x, 'git diff');
  return x.out.split('\0').filter(p => p);
}
/* The files staged in R: the index differing from HEAD. */
async function stagedFiles(r: VcRepo): Promise<string[]> {
  const x = await Vc.run(r, ['diff', '--cached', '--name-only', '-z'], { ...READ, lossy: true });
  if (x.code !== 0 || x.error || x.timedOut || x.truncated) failed(x, 'git diff');
  return x.out.split('\0').filter(p => p);
}
/* Whether stash S carries staged changes: the tree of its index commit (its second parent) differs from its
   base's (its first). */
async function stashHasIndex(r: VcRepo, s: GitStash): Promise<boolean> {
  const tree = async (parent: number) => {   // --verify takes one revision, and it alone keeps --end-of-options out of the output
    const x = await Vc.run(r, ['rev-parse', '--verify', '--end-of-options', `${s.oid}^${parent}^{tree}`], { ...READ, lossy: true });
    const hash = x.out.trim();
    if (x.code !== 0 || x.error || x.timedOut || x.truncated || !/^[0-9a-f]{40,64}$/.test(hash)) failed(x, 'git rev-parse');
    return hash;
  };
  return await tree(1) !== await tree(2);
}
/* Refused while a conflict is left (git would say only `could not write index`): WHAT names what is not done. */
async function unmerged(r: VcRepo, what: string) {
  const files = await conflicted(r);
  if (files.length) signal('user-error', `${what}: ${listed(files)} ${files.length === 1 ? 'is' : 'are'} in conflict; resolve and stage ${files.length === 1 ? 'it' : 'them'} (s) first`);
}
/* z z and z i: the local changes (with STAGED, the staged ones alone) stashed, under a message typed (git's when
   none is). Untracked files are not stashed. Nothing is stashed while a conflict is left. */
async function stashPush(r: VcRepo, staged: boolean) {
  await unmerged(r, 'Nothing stashed');
  const msg = (await Ed.readMini(staged ? 'Stash the staged changes, message: ' : 'Stash message: ', '', null, { kind: 'git-stash-message' })).trim();
  const x = await gitWrite(r, ['stash', 'push', ...(staged ? ['--staged'] : []), ...(msg ? ['--message=' + msg] : []), '--']);
  if (x.code !== 0) refused(x, 'Nothing stashed');
  Ed.message(firstLine(x.out) || 'Stashed');
}
const STASH_NAME = /^stash@\{\d+\}$/;
/* The stash z a, z p or z k acts on: the one on point's line in B, refused when the stashes changed since it was
   shown (a name stands for a different stash once one is pushed or dropped); else one read at a prompt
   (stash@{0} first). */
async function stashPick(r: VcRepo, b: EdBuffer, verb: string): Promise<GitStash> {
  if (!await resolve(r, 'refs/stash')) signal('user-error', 'No stashes');
  const stashes = (await readStashes(r)).filter(s => STASH_NAME.test(s.name)), row = b.gitView ? here(b).row : undefined;
  if (row && row.stash) {
    const s = stashes.find(x => x.name === row.stash!.name);
    if (!s || s.oid !== row.stash.oid) signal('user-error', `The stashes changed since ${row.stash.name} was shown: g r reads them again`);
    return s!;
  }
  const name = await ask(`${verb} stash`, stashes.map(s => s.name), stashes.length ? stashes[0].name : undefined, true);
  return stashes.find(s => s.name === name) || signal('user-error', `Not a stash: ${shown(name)}`) as never;
}
/* z a and z p: a stash applied (POP: then dropped) with its staged changes staged again; when those do not apply
   to the index (git says so and changes nothing), applied again without, its changes then unstaged. A conflict is
   said with its files, the stash kept. Nothing is applied while a conflict is left, nor, when the stash carries
   staged changes, while anything is staged: git's --index then fails for any staged file, one the stash does not
   touch too, and unstages them all (`Index was not unstashed`). A stash without staged changes applies over a
   staged file, which stays staged. */
async function stashApply(r: VcRepo, b: EdBuffer, pop: boolean) {
  const s = await stashPick(r, b, pop ? 'Pop' : 'Apply'), sub = pop ? 'pop' : 'apply', done = pop ? 'popped' : 'applied';
  await unmerged(r, `${s.name} not ${done}`);
  const staged = await stagedFiles(r), them = staged.length === 1 ? 'it' : 'them';
  if (staged.length && await stashHasIndex(r, s)) signal('user-error', `${s.name} not ${done}: ${listed(staged)} ${staged.length === 1 ? 'is' : 'are'} staged, and git would unstage ${them}; commit, unstage (u) or stash (z z) ${them} first`);
  /* git applies by name alone, and a stash pushed or dropped while the prompt was open moves the names */
  if (await resolve(r, s.name) !== s.oid) signal('user-error', `The stashes changed since ${s.name} was shown: g r reads them again`);
  let x = await gitWrite(r, ['stash', sub, '--index', s.name]), unindexed = false;
  if (x.code !== 0 && /conflicts in index\. Try without --index/i.test(x.err)) { unindexed = true; x = await gitWrite(r, ['stash', sub, s.name]); }
  if (x.code !== 0 && /^CONFLICT /m.test(x.out + '\n' + x.err)) {
    const files = await conflicted(r);
    Ed.message(`${s.name} applied with conflicts${files.length ? ' in ' + listed(files) : ''}: resolve them and stage them (s); the stash is kept${pop ? ' (z k drops it)' : ''}`);
    return;
  }
  if (x.code !== 0 && /^Index was not unstashed\./m.test(x.err)) signal('process-error', `${s.name} not ${done}: ${inTheWay(x) || reason(x)}; git unstaged the staged changes (see *vc-process*)`);
  if (x.code !== 0) refused(x, `${s.name} not ${done}`);
  Ed.message(`${s.name} ${done}${unindexed ? '; its staged changes are unstaged: they did not apply to the index' : ''}`);
}
/* z k: a stash dropped, after asking. */
async function stashDrop(r: VcRepo, b: EdBuffer) {
  const s = await stashPick(r, b, 'Drop');
  if (!await Ed.yesOrNo(`Drop ${s.name} ${shown(s.subject)}?`)) { Ed.message('Nothing dropped'); return; }
  /* git drops by name alone, and a stash pushed or dropped while the question was open moves the names */
  if (await resolve(r, s.name) !== s.oid) signal('user-error', `The stashes changed since ${s.name} was shown: g r reads them again`);
  const x = await gitWrite(r, ['stash', 'drop', s.name]);
  if (x.code !== 0) refused(x, `${s.name} not dropped`);
  Ed.message(firstLine(x.out) || `Dropped ${s.name}`);
}

/* t t: a lightweight tag at a revision, point's or HEAD; never signed, whatever tag.gpgSign says (a signed tag
   is annotated, and its message would need an editor). */
async function tagCreate(r: VcRepo, b: EdBuffer) {
  const refs = await readRefs(r);
  const name = await newName(r, 'tag', (await Ed.readMini('Tag name: ', '', null, { kind: 'git-tag-name' })).trim());
  const oid = await commitOf(r, await ask(`Tag ${shown(name)} at`, refNames(refs), commitAt(b) ?? 'HEAD'));
  const x = await gitWrite(r, ['tag', '--no-sign', '--end-of-options', name, oid]);
  if (x.code !== 0) refused(x, 'No tag created');
  Ed.message(`Tag ${shown(name)} at ${await described(r, oid)}`);
}
/* t x: a tag deleted, after asking (a tag has no reflog to bring it back from). */
async function tagDelete(r: VcRepo) {
  const refs = await readRefs(r);
  const name = await ask('Delete tag', refs.tags, undefined, true);
  if (!name || !refs.tags.includes(name)) signal('user-error', `Not a tag: ${shown(name)}`);
  if (!await Ed.yesOrNo(`Delete tag ${shown(name)}?`)) { Ed.message('Nothing deleted'); return; }
  const x = await gitWrite(r, ['tag', '-d', '--end-of-options', name]);
  if (x.code !== 0) refused(x, 'Not deleted');
  Ed.message(firstLine(x.out) || `Deleted tag ${shown(name)}`);
}

CMD('git-checkout', '', '', 'Check out a branch or a revision (b b), the branch or commit at point by default: a local branch becomes HEAD, anything else is checked out detached. Local changes git would overwrite stop it.', () => historyOp(checkout));
CMD('git-branch-create', '', '', 'Create a branch and check it out (b c), starting at the branch or commit at point, or the current branch.', () => historyOp((r, b) => branchCreate(r, b, true)));
CMD('git-branch-new', '', '', 'Create a branch without checking it out (b n), starting at the branch or commit at point, or the current branch.', () => historyOp((r, b) => branchCreate(r, b, false)));
CMD('git-branch-delete', '', '', 'Delete a local branch (b x), the one at point by default; one not fully merged only after asking.', () => historyOp(branchDelete));
CMD('git-branch-rename', '', '', 'Rename a local branch (b m), the current one by default.', () => historyOp(r => branchRename(r)));
CMD('git-reset-soft', '', '', 'Reset HEAD to the commit at point, or one asked for (O s): the index and the work tree stay.', () => historyOp((r, b) => reset(r, b, 'soft')));
CMD('git-reset-mixed', '', '', 'Reset HEAD and the index to the commit at point, or one asked for (O m): the work tree stays.', () => historyOp((r, b) => reset(r, b, 'mixed')));
CMD('git-reset-hard', '', '', 'Reset HEAD, the index and the work tree to the commit at point, or one asked for (O h), after asking: uncommitted changes to tracked files are lost.', () => historyOp((r, b) => reset(r, b, 'hard')));
CMD('git-stash', '', '', 'Stash the local changes, staged and unstaged (z z), under a message asked for. Untracked files stay.', () => historyOp(r => stashPush(r, false)));
CMD('git-stash-index', '', '', 'Stash the staged changes alone (z i), under a message asked for.', () => historyOp(r => stashPush(r, true)));
CMD('git-stash-apply', '', '', 'Apply the stash at point, or one asked for (z a), its staged changes staged again; a conflict is said, the stash kept.', () => historyOp((r, b) => stashApply(r, b, false)));
CMD('git-stash-pop', '', '', 'Apply the stash at point, or one asked for, and drop it (z p); on a conflict it is kept.', () => historyOp((r, b) => stashApply(r, b, true)));
CMD('git-stash-drop', '', '', 'Drop the stash at point, or one asked for (z k), after asking.', () => historyOp(stashDrop));
CMD('git-tag-create', '', '', 'Tag the commit at point, or one asked for (t t), with a lightweight tag.', () => historyOp(tagCreate));
CMD('git-tag-delete', '', '', 'Delete a tag (t x), after asking.', () => historyOp(r => tagDelete(r)));

/* ---------- fetch, pull and push ---------- */
/* Each reaches a remote: so long at most (a large fetch over a slow link, a push's hooks), its progress in
   *vc-process* as it comes. It runs once the command has ended, so the frame takes keys meanwhile; one at a time
   in a repository. */
const REMOTE = { timeout: 1800000, maxBytes: MAX_BYTES, lossy: true, progress: true };
const JJ_REMOTE = 'jj fetches and pushes with its own commands: f f, f a, p p, p c and p d in jj\'s log (SPC g J); SPC g G\'s status buffer works on its git repository';
/* the remote, merge, cherry-pick, revert or rebase command that runs, by repository root */
const busy = new Map<string, string>();

/* R's remotes, by name: those its configuration (a read) gives a URL. A name that holds a control character, is
   not UTF-8 or starts with `-` is left out. */
async function readRemotes(r: VcRepo): Promise<string[]> {
  const x = await Vc.run(r, ['config', '--null', '--name-only', '--get-regexp', '^remote\\..+\\.url$'], { ...READ, lossy: true });
  if (x.code === 1 && !x.error && !x.timedOut) return [];
  if (x.code !== 0 || x.truncated || x.error) failed(x, 'git config');
  const names = new Set<string>();
  for (const k of x.out.split('\0')) {
    const m = /^remote\.(.+)\.url$/s.exec(k);
    if (m && !/[\u0000-\u001f\u007f�]/.test(m[1]) && !m[1].startsWith('-')) names.add(m[1]);
  }
  return [...names];
}
/* BRANCH's upstream: its remote ('.' for a local branch), the branch there (refs/heads/NAME) and the
   remote-tracking ref that follows it; null when it has none, or one that names no branch. */
interface GitUpstream { remote: string; ref: string; tracking: string }
async function upstreamOf(r: VcRepo, branch: string): Promise<GitUpstream | null> {
  const x = await Vc.run(r, ['for-each-ref', '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/' + branch], { ...READ, lossy: true });
  if (x.code !== 0 || x.truncated || x.error) failed(x, 'git for-each-ref');
  for (const l of x.out.split('\n')) {
    const [ref, tracking, remote, merge] = l.split('\0');
    if (ref !== 'refs/heads/' + branch || !tracking || !remote) continue;
    /* the branch there goes into a refspec: no `:` and nothing else a ref name may not hold */
    if (!/^refs\/heads\/[^\u0000- :~^?*[\\\u007f]+$/.test(merge) || /[\u0000-\u001f\u007f�]/.test(remote)) return null;
    return { remote, ref: merge, tracking };
  }
  return null;
}
const upstreamName = (u: GitUpstream) => (u.remote === '.' ? '' : shown(u.remote) + '/') + shown(u.ref.slice(11));
/* The branch a pull or a push is for: HEAD's; a detached HEAD refused. */
async function branchFor(r: VcRepo, doing: string): Promise<string> {
  const b = await currentBranch(r);
  return b ?? signal('user-error', `HEAD is detached: check out a branch (b b) to ${doing}`) as never;
}
/* A remote read at PROMPT, origin (else the first) by default; refused when R has none. */
async function askRemote(r: VcRepo, prompt: string): Promise<string> {
  const remotes = await readRemotes(r);
  if (!remotes.length) signal('user-error', `${shown(r.root)} has no remote (git remote add NAME URL adds one)`);
  const name = await ask(prompt, remotes, remotes.includes('origin') ? 'origin' : remotes[0], true);
  return remotes.includes(name) ? name : signal('user-error', `Not a remote: ${shown(name)}`) as never;
}
/* Raise git's failure X to reach a remote, WHAT saying what was not done; when it wanted credentials, where they
   come from: nothing is asked here. */
function unreached(x: EdProcResult, what: string): never {
  const way = inTheWay(x);
  if (way) return signal('user-error', `${what}: ${way}`) as never;
  const creds = /terminal prompts disabled|Permission denied \(|Host key verification failed|Authentication failed|could not read (Username|Password)/i.test(x.err)
    ? '; git asks no credentials here: they come from your credential helper or ssh agent' : '';
  return signal('process-error', `${what}: ${reason(x)}${creds} (see *vc-process*)`) as never;
}

/* Run the operation PREP readies (asking what it needs) on the current buffer B's git repository, a jj workspace
   refused (JJ says why): PREP gives what is starting (`Fetching origin`) and the operation, or null for nothing.
   The command ends once it has started; when it ends, the repository's status and log buffers are read again and
   what it did is said. One at a time in a repository, whether it reaches a remote or is a merge, cherry-pick,
   revert or rebase: STARTING names the command in the refusal while PREP readies it. */
async function backgroundOp(jj: string, starting: string, prep: (r: VcRepo, b: EdBuffer) => Promise<[string, () => Promise<string>] | null>): Promise<false> {
  const b = cur(), r = gitRepo(jj);
  const running = busy.get(r.root);
  if (running) signal('user-error', `${running} still runs in ${shown(r.root)}: see *vc-process*`);
  /* the slot taken before PREP's git reads and questions, so that a second command started meanwhile is refused */
  busy.set(r.root, starting);
  let op: [string, () => Promise<string>] | null = null;
  try { op = await prep(r, b); } finally { if (!op) busy.delete(r.root); }
  if (!op) return false;
  const [what, run] = op;
  busy.set(r.root, what);
  Ed.message(`${what}… (see *vc-process*)`);
  void (async () => {
    let said = '', err: unknown = null;
    try { said = await run(); } catch (e) { err = e; }
    busy.delete(r.root);
    for (const s of buffersOf(r, 'status')) await refresh(s).catch(Ed.reportError);
    for (const l of buffersOf(r, 'log')) void loadLog(l, true).catch(Ed.reportError);
    if (err) Ed.reportError(err); else Ed.message(said);
    Ed.scheduleRender();
  })();
  return false;
}
const remoteOp = (prep: (r: VcRepo) => Promise<[string, () => Promise<string>] | null>) => backgroundOp(JJ_REMOTE, 'A remote command', prep);

/* f u and f a: fetch from the current branch's upstream's remote (one asked for when it has none), or from every
   remote. */
async function fetchPrep(r: VcRepo, all: boolean): Promise<[string, () => Promise<string>]> {
  if (all) {
    if (!(await readRemotes(r)).length) signal('user-error', `${shown(r.root)} has no remote (git remote add NAME URL adds one)`);
    return ['Fetching all remotes', () => fetchRun(r, ['--all'], 'all remotes')];
  }
  const branch = await currentBranch(r), up = branch === null ? null : await upstreamOf(r, branch);
  const remote = up && up.remote !== '.' ? up.remote : await askRemote(r, 'Fetch from remote');
  return [`Fetching ${shown(remote)}`, () => fetchRun(r, ['--end-of-options', remote], shown(remote))];
}
async function fetchRun(r: VcRepo, args: string[], from: string): Promise<string> {
  const x = await Vc.run(r, ['fetch', '--progress', '--porcelain', ...args], REMOTE);
  if (x.error || x.timedOut || x.truncated) failed(x, 'git fetch');
  if (x.code !== 0) unreached(x, `Not fetched from ${from}`);
  /* --porcelain: a line per ref it changed, `FLAG OLD NEW REF` */
  const n = x.out.split('\n').filter(l => /^. [0-9a-f]+ [0-9a-f]+ /.test(l)).length;
  return `Fetched ${from}: ${n ? `${n} ref${n === 1 ? '' : 's'} updated` : 'nothing new'}`;
}

/* F u: pull the current branch's upstream into it, merging or rebasing as the user's git configuration says
   (pull.rebase, pull.ff). A branch with no upstream is given one first, asked for among the remote branches. */
async function pullPrep(r: VcRepo): Promise<[string, () => Promise<string>]> {
  const branch = await branchFor(r, 'pull into it');
  await unmerged(r, 'Not pulled');
  let up = await upstreamOf(r, branch);
  if (!up) {
    const refs = await readRefs(r), mine = refs.remotes.find(n => n.endsWith('/' + branch));
    if (!refs.remotes.length) signal('user-error', `${shown(branch)} has no upstream, and there is no remote branch to pull from: f u fetches them`);
    const name = await ask(`Set upstream of ${shown(branch)} and pull from`, refs.remotes, mine, true);
    if (!refs.remotes.includes(name)) signal('user-error', `Not a remote branch: ${shown(name)}`);
    const x = await gitWrite(r, ['branch', '--set-upstream-to=refs/remotes/' + name, '--end-of-options', branch]);
    if (x.code !== 0) refused(x, 'No upstream set');
    up = (await upstreamOf(r, branch)) || signal('user-error', `${shown(name)} is no branch git can pull ${shown(branch)} from`) as never;
  }
  const from = upstreamName(up);
  return [`Pulling ${from} into ${shown(branch)}`, () => pullRun(r, branch, from)];
}
async function pullRun(r: VcRepo, branch: string, from: string): Promise<string> {
  const before = await resolve(r, 'HEAD');
  const x = await Vc.run(r, ['pull', '--progress'], REMOTE);
  if (x.error || x.timedOut || x.truncated) failed(x, 'git pull');
  if (x.code !== 0) {
    if (/^CONFLICT /m.test(x.out + '\n' + x.err)) {
      const files = await conflicted(r), rebase = /^Could not apply /m.test(x.out + '\n' + x.err);
      return `Pulled ${from} with conflicts${files.length ? ' in ' + listed(files) : ''}: resolve them and stage them (s), then ${rebase ? SEQ.rebase.keys : SEQ.merge.keys}`;
    }
    if (/divergent branches/.test(x.err)) signal('user-error', `Not pulled: ${shown(branch)} and ${from} have diverged, and your git configuration does not say how to reconcile them (pull.rebase, pull.ff)`);
    unreached(x, 'Not pulled');
  }
  const after = await resolve(r, 'HEAD');
  if (!after || after === before) return `${shown(branch)} is up to date with ${from}`;
  return `Pulled ${from} into ${shown(branch)}: now at ${await described(r, after)}${/^Fast-forward$/m.test(x.out) ? ' (fast-forward)' : ''}`;
}

/* p u and p f: push the current branch to its upstream (p u to a remote asked for, setting it as the upstream,
   when it has none); p f force-pushes after asking, its lease the commit the remote-tracking branch is at when
   asked, so what is overwritten is what the question named. */
async function pushPrep(r: VcRepo, force: boolean): Promise<[string, () => Promise<string>] | null> {
  const branch = await branchFor(r, 'push it'), up = await upstreamOf(r, branch);
  if (up && up.remote === '.') signal('user-error', `${shown(branch)}'s upstream is the local branch ${upstreamName(up)}: nothing to push to a remote`);
  if (!up) {
    if (force) signal('user-error', `${shown(branch)} has no upstream: p u pushes it and sets one`);
    const remote = await askRemote(r, `Set upstream of ${shown(branch)} and push to remote`), to = `${shown(remote)}/${shown(branch)}`;
    return [`Pushing ${shown(branch)} to ${to}`, () => pushRun(r, branch, remote, 'refs/heads/' + branch, ['--set-upstream'], to)];
  }
  const to = upstreamName(up);
  if (!force) return [`Pushing ${shown(branch)} to ${to}`, () => pushRun(r, branch, up.remote, up.ref, [], to)];
  const lease = await resolve(r, up.tracking);
  if (!lease) signal('user-error', `${to} has not been fetched: f u fetches it, to see what a force push would discard`);
  const x = await Vc.run(r, ['rev-list', '--count', `refs/heads/${branch}..${lease}`, '--'], { ...READ, lossy: true });
  if (x.code !== 0 || x.error || x.timedOut || x.truncated) failed(x, 'git rev-list');
  const n = +x.out.trim();
  const lost = n ? `, discarding ${n} commit${n === 1 ? '' : 's'} of ${to} not in ${shown(branch)} (the last ${await described(r, lease!)})` : '';
  if (!await Ed.yesOrNo(`Force push ${shown(branch)} to ${to}${lost}?`)) { Ed.message('Nothing pushed'); return null; }
  return [`Force-pushing ${shown(branch)} to ${to}`, () => pushRun(r, branch, up.remote, up.ref, [`--force-with-lease=${up.ref}:${lease}`], to)];
}
async function pushRun(r: VcRepo, branch: string, remote: string, ref: string, extra: string[], to: string): Promise<string> {
  const x = await Vc.run(r, ['push', '--progress', '--porcelain', ...extra, '--end-of-options', remote, `refs/heads/${branch}:${ref}`], REMOTE);
  if (x.error || x.timedOut || x.truncated) failed(x, 'git push');
  /* --porcelain: `FLAG\tFROM:TO\tSUMMARY` for the ref */
  const line = x.out.split('\n').find(l => /^[ +*!=-]\t/.test(l)), [flag, , summary = ''] = line ? line.split('\t') : [];
  if (flag === '!') {
    if (/\(stale info\)/.test(summary)) signal('user-error', `Not force-pushed: ${to} is no longer where it was when asked (someone pushed): f u fetches it, to see what a force push would discard`);
    if (/\((non-fast-forward|fetch first)\)/.test(summary)) signal('user-error', `Not pushed: ${to} has commits ${shown(branch)} does not: pull them (F u) first, or force push (p f)`);
    signal('process-error', `Not pushed: ${shown(summary)} (see *vc-process*)`);
  }
  if (x.code !== 0 || !line) {
    if (/^error: failed to push some refs/m.test(x.err) && !/^(error|fatal): (?!failed to push some refs)/m.test(x.err)) signal('process-error', `Not pushed: the pre-push hook refused it (see *vc-process*)`);
    unreached(x, 'Not pushed');
  }
  if (flag === '=') return `${to} is already at ${shown(branch)}: nothing to push`;
  const upstream = extra.includes('--set-upstream') ? `; ${to} is now its upstream` : '';
  if (flag === '*') return `Pushed ${shown(branch)} to ${to}, a new branch there${upstream}`;
  return `${flag === '+' ? 'Force-pushed' : 'Pushed'} ${shown(branch)} to ${to} (${shown(summary)})${upstream}`;
}

CMD('git-fetch', '', '', 'Fetch from the current branch\'s upstream\'s remote, or one asked for (f u), in the background: its progress in *vc-process*.', () => remoteOp(r => fetchPrep(r, false)));
CMD('git-fetch-all', '', '', 'Fetch from every remote (f a), in the background.', () => remoteOp(r => fetchPrep(r, true)));
CMD('git-pull', '', '', 'Pull the current branch\'s upstream into it (F u), merging or rebasing as your git configuration says; a branch with no upstream is given one first. In the background: its progress in *vc-process*.', () => remoteOp(r => pullPrep(r)));
CMD('git-push', '', '', 'Push the current branch to its upstream (p u), or to a remote asked for, which becomes its upstream. In the background: its progress in *vc-process*.', () => remoteOp(r => pushPrep(r, false)));
CMD('git-push-force', '', '', 'Force push the current branch to its upstream (p f), after asking, with the commits it would discard named: --force-with-lease, so a push someone made since is not overwritten.', () => remoteOp(r => pushPrep(r, true)));

/* ---------- merge, cherry-pick, revert and rebase ---------- */
/* Each runs as a commit does (runLong: no bound on its output, which would kill git partway through a rebase),
   after the command has ended, one at a time in a repository with the remote commands. A commit git makes going
   on takes the message git prepared (keepMessage: GIT_EDITOR=:). Their hooks run (owner decision 12). */
type GitSeqKind = Exclude<GitSeqOp, 'am'>;
const SEQ: Record<GitSeqKind, { name: string; Name: string; doing: string; done: string; skip: string | null; keys: string }> = {
  merge: { name: 'merge', Name: 'Merge', doing: 'Merging', done: 'Merged', skip: null, keys: 'm m commits the merge, m a aborts it' },
  'cherry-pick': { name: 'cherry-pick', Name: 'Cherry-pick', doing: 'Cherry-picking', done: 'Cherry-picked', skip: 'A s', keys: 'A A goes on, A s skips the commit, A a aborts' },
  revert: { name: 'revert', Name: 'Revert', doing: 'Reverting', done: 'Reverted', skip: '_ s', keys: '_ _ goes on, _ s skips the commit, _ a aborts' },
  rebase: { name: 'rebase', Name: 'Rebase', doing: 'Rebasing', done: 'Rebased', skip: 'r s', keys: 'r r goes on, r s skips the commit, r a aborts' },
};
const AM = 'finish it in a terminal: git am --continue, --skip or --abort';
const seqOp = (prep: (r: VcRepo, b: EdBuffer) => Promise<[string, () => Promise<string>] | null>) => backgroundOp(JJ_HISTORY, 'A merge, cherry-pick, revert or rebase', prep);

/* HEAD for a message: its branch (HEAD when detached) and the commit it is at. */
async function headNow(r: VcRepo): Promise<string> {
  const [branch, oid] = await Promise.all([currentBranch(r), resolve(r, 'HEAD')]);
  return `${branch !== null ? shown(branch) : 'HEAD'} ${oid ? 'at ' + await described(r, oid) : 'has no commit'}`;
}
/* The staged files that still hold a conflict marker, as `diff --cached --check` (a read) finds them. */
async function markers(r: VcRepo): Promise<string[]> {
  const x = await Vc.run(r, ['diff', '--cached', '--check'], { ...READ, lossy: true });
  if (x.error || x.timedOut || x.truncated || x.code !== 0 && x.code !== 2) failed(x, 'git diff --check');   // 2: it found something
  const files = new Set<string>();
  for (const l of x.out.split('\n')) { const m = /^(.+):\d+: leftover conflict marker$/.exec(l); if (m) files.add(m[1]); }
  return [...files];
}

/* What git did, run for KIND: stopped (a conflict, a commit that would be empty, a rebase's edit), said with what
   to do then; else, when it failed, WHAT (`Not merged`) with git's reason, or DONE's message. */
async function seqSaid(r: VcRepo, kind: GitSeqKind, x: EdProcResult, what: string, done: () => Promise<string>, ed: RebaseEditor | null = null): Promise<string> {
  if (x.error || x.timedOut) failed(x, `git ${kind}`);
  const S = SEQ[kind], s = await readSeq(r);
  if (ed && ed.aborted === 'todo' && !s) return 'Rebase aborted (C-c C-k): nothing changed';
  if (s && s.op === kind) {
    const cur = s.current ? commitText(s.current) : null, where = kind === 'merge' ? `The merge${cur ? ' of ' + cur : ''} stopped` : `${S.doing} stopped${cur ? ` at ${cur}${kind === 'rebase' ? ` (${s.step} of ${s.of})` : ''}` : ''}`;
    const files = await conflicted(r);
    if (files.length) return `${where} with conflicts in ${listed(files)}: resolve them and stage them (s), then ${S.keys}`;
    if (S.skip && /\bis now empty\b/.test(x.err + '\n' + x.out)) return `${where}: its changes are in HEAD already, so it would commit nothing: ${S.keys}`;
    if (ed && ed.aborted === 'message') return `${where}: its message was aborted (C-c C-k), so it keeps the one it had: ${S.keys}`;
    if (x.code !== 0) signal('process-error', `${where}: ${reason(x)} (see *vc-process*); ${S.keys}`);
    return `${where}: ${S.keys}`;
  }
  if (x.code !== 0) refused(x, what);
  return done();
}

/* What a start command of KIND finds in progress: nothing (it starts; refused while a conflict is left), its own
   (m m, A A and _ _ go on with it), or anything else, a rebase's for r e and r u too (refused). */
async function seqStart(r: VcRepo, kind: GitSeqKind): Promise<boolean> {
  const s = await readSeq(r);
  if (s && (s.op !== kind || kind === 'rebase')) signal('user-error', s.op === 'am' ? `git am is in progress: ${AM}` : `A ${SEQ[s.op].name} is in progress: ${SEQ[s.op].keys}`);
  if (!s) await unmerged(r, `No ${SEQ[kind].name} started`);
  return !!s;
}

/* m m: a branch or a revision (point's, else asked) merged into HEAD, with git's own message (--no-edit); while a
   merge is in progress, that merge committed. A ref's name is given to git as it is (the message names it),
   anything else as its commit's hash. */
async function mergePrep(r: VcRepo, b: EdBuffer): Promise<[string, () => Promise<string>] | null> {
  if (await seqStart(r, 'merge')) return stepPrep(r, 'merge', 'continue');
  const [refs, current] = await Promise.all([readRefs(r), currentBranch(r)]);
  const head = current !== null ? shown(current) : 'HEAD', at = await revAt(r, b, refs, current);
  const rev = await ask(`Merge into ${head}`, refNames(refs).filter(n => n !== current), at === current ? undefined : at);
  const oid = await commitOf(r, rev), named = refNames(refs).includes(rev), it = named ? shown(rev) : await described(r, oid);
  return [`Merging ${it} into ${head}`, async () => {
    const before = await resolve(r, 'HEAD');
    const x = await runLong(r, ['merge', '--no-edit', '--end-of-options', named ? rev : oid], undefined, true);
    return seqSaid(r, 'merge', x, 'Not merged', async () => {
      const after = await resolve(r, 'HEAD');
      if (after === before) return `${head} already has ${it}: nothing merged`;
      return `Merged ${it} into ${head}: now at ${await described(r, after!)}${/^Fast-forward$/m.test(x.out) ? ' (fast-forward)' : ''}`;
    });
  }];
}

/* A A and _ _: the commits SELECTED (in Visual state), else one or a range `A..B` asked for (the
   commit at point by default), cherry-picked (oldest first) or reverted (newest first); while one is in progress,
   it goes on. */
async function pickPrep(r: VcRepo, b: EdBuffer, kind: 'cherry-pick' | 'revert', selected: string[]): Promise<[string, () => Promise<string>] | null> {
  if (await seqStart(r, kind)) return stepPrep(r, kind, 'continue');
  const S = SEQ[kind];
  let revs: string[], it: string;
  if (selected.length) {
    const oids = [...new Set(await Promise.all(selected.map(x => commitOf(r, x))))];
    revs = kind === 'cherry-pick' ? oids.reverse() : oids;   // shown newest first
    it = revs.length === 1 ? await described(r, revs[0]) : `${revs.length} commits`;
  } else {
    const rev = await ask(`${S.Name} commit or range A..B`, refNames(await readRefs(r)), commitAt(b));
    const dots = rev.indexOf('..');
    if (dots > 0 && dots + 2 < rev.length && rev[dots + 2] !== '.' && !rev.includes('..', dots + 2)) {
      const [from, to] = [rev.slice(0, dots), rev.slice(dots + 2)], range = `${await commitOf(r, from)}..${await commitOf(r, to)}`;
      const x = await Vc.run(r, ['rev-list', '--count', range, '--'], { ...READ, lossy: true });
      if (x.code !== 0 || x.error || x.timedOut || x.truncated) failed(x, 'git rev-list');
      const n = +x.out.trim();
      if (!n) signal('user-error', `${shown(rev)} holds no commit`);
      revs = [range]; it = `${n} commit${n === 1 ? '' : 's'} (${shown(rev)})`;
    } else { revs = [await commitOf(r, rev)]; it = await described(r, revs[0]); }
  }
  return [`${S.doing} ${it}`, async () => {
    const x = await runLong(r, [kind, '--no-edit', '--end-of-options', ...revs], undefined, true);
    return seqSaid(r, kind, x, `Not ${S.done.toLowerCase()}`, async () => `${S.done} ${it}: ${await headNow(r)}`);
  }];
}

/* r e and r u: HEAD rebased onto a revision (point's, else asked) or onto its branch's upstream, without a todo
   (the interactive rebase is git-rebase-todo's). */
async function rebasePrep(r: VcRepo, b: EdBuffer, upstream: boolean): Promise<[string, () => Promise<string>]> {
  await seqStart(r, 'rebase');
  const branch = await currentBranch(r), head = branch !== null ? shown(branch) : 'HEAD';
  let onto: string, it: string;
  if (upstream) {
    if (branch === null) signal('user-error', 'HEAD is detached: r e rebases it onto a revision asked for');
    const up = await upstreamOf(r, branch!);
    if (!up) signal('user-error', `${head} has no upstream: r e rebases it onto a revision asked for`);
    it = upstreamName(up!);
    if (!await resolve(r, up!.tracking)) signal('user-error', `${it} has not been fetched: f u fetches it`);
    onto = up!.tracking;
  } else {
    const refs = await readRefs(r), at = await revAt(r, b, refs, branch);
    const rev = await ask(`Rebase ${head} onto`, refNames(refs).filter(n => n !== branch), at === branch ? undefined : at);
    const oid = await commitOf(r, rev), named = refNames(refs).includes(rev);
    onto = named ? rev : oid; it = named ? shown(rev) : await described(r, oid);
  }
  return [`Rebasing ${head} onto ${it}`, async () => {
    const before = await resolve(r, 'HEAD'), ed = rebaseEditor(r);
    const x = await rebaseRun(r, ['rebase', '--end-of-options', onto], ed);
    return seqSaid(r, 'rebase', x, 'Not rebased', async () => {
      const after = await resolve(r, 'HEAD');
      return after === before ? `${head} is up to date with ${it}: nothing rebased` : `Rebased ${head} onto ${it}: now at ${await described(r, after!)}`;
    }, ed);
  }];
}

/* Go on with (STEP continue), skip the commit stopped at in, or abort the KIND in progress; refused when none is,
   or another operation is. Going on is refused while a conflict is left, offers to save the repository's changed
   buffers and asks when a staged file still holds a conflict marker; a skip and an abort ask first, naming what
   they discard. */
async function stepPrep(r: VcRepo, kind: GitSeqKind, step: 'continue' | 'skip' | 'abort'): Promise<[string, () => Promise<string>] | null> {
  const S = SEQ[kind], s = await readSeq(r);
  if (!s || s.op !== kind) signal('user-error', `No ${S.name} in progress${!s ? '' : s.op === 'am' ? `: git am is (${AM})` : `: a ${SEQ[s.op].name} is (${SEQ[s.op].keys})`}`);
  const at = s!.current ? commitText(s!.current) : null;
  if (step === 'continue') {
    const files = await conflicted(r), them = files.length === 1 ? 'it' : 'them';
    if (files.length) signal('user-error', `${listed(files)} ${files.length === 1 ? 'is' : 'are'} still in conflict: resolve ${them} and stage ${them} (s) first`);
    await Vc.offerSave(r, `going on with the ${S.name}`);
    const marked = await markers(r);
    if (marked.length && !await Ed.yesOrNo(`${listed(marked)} still hold${marked.length === 1 ? 's' : ''} a conflict marker: go on with the ${S.name}, committing ${marked.length === 1 ? 'it' : 'them'} as staged?`)) {
      Ed.message(`Nothing done: the ${S.name} is where it was`);
      return null;
    }
  } else {
    let q: string;
    if (step === 'skip') q = `Skip ${at ?? 'the commit it stopped at'}, leaving it out of the ${S.name} (its changes here and your resolution of them discarded)?`;
    else if (kind === 'merge') q = `Abort the merge${at ? ' of ' + at : ''}, putting the index and the work tree back as HEAD has them (your resolutions discarded)?`;
    else if (kind === 'rebase') q = `Abort the rebase, putting ${s!.branch !== null ? shown(s!.branch) : 'HEAD'} back at ${s!.orig ? await described(r, s!.orig) : 'where it was'} (the commits rebased so far and your resolutions discarded)?`;
    else q = `Abort the ${S.name}, putting HEAD back where it was before it (the commits it made and your resolutions discarded)?`;
    if (!await Ed.yesOrNo(q)) { Ed.message(`Nothing done: the ${S.name} is where it was`); return null; }
  }
  const doing = step === 'continue' ? `Going on with the ${S.name}` : step === 'skip' ? `Skipping ${at ?? 'a commit'} in the ${S.name}` : `Aborting the ${S.name}`;
  return [doing, async () => {
    /* a rebase going on or skipping may come to a reword or a squash, whose message is written in the frame */
    const ed = kind === 'rebase' && step !== 'abort' ? rebaseEditor(r) : null;
    const x = ed ? await rebaseRun(r, [kind, '--' + step], ed) : await runLong(r, [kind, '--' + step], undefined, true);
    if (step !== 'abort') return seqSaid(r, kind, x, `The ${S.name} did not go on`, async () => `${S.Name} done: ${await headNow(r)}`, ed);
    if (x.error || x.timedOut) failed(x, `git ${kind} --abort`);
    if (x.code !== 0) refused(x, `The ${S.name} is not aborted`);
    return `${S.Name} aborted: ${await headNow(r)}`;
  }];
}

/* ---------- the interactive rebase and its todo ----------

   r i rebases the commit at point (or one asked for) and those after it up to HEAD, interactively: git writes its
   todo and gives it to the frame, its sequence editor (Vc's edit). The todo is a plain text buffer in
   git-rebase-todo-mode, whose keys change the action of the commit line at point or move it; C-c C-c (Z Z) hands
   the text back to git as it is, C-c C-k (Z Q), or killing the buffer, aborts the rebase. A reword's, a squash's
   or a `fixup -c`'s message git gives the frame too, written in vc-message-mode; a message git asks for after a
   conflict on a pick or an edit is handed back unedited, as `:` would (the git-sequencer's way). Every rebase
   Edwin runs but its abort has the frame as its editors, so a reword left in the todo is reached by r r too. */
interface RebaseEditor { edit: (file: string) => Promise<boolean | null>; aborted: 'todo' | 'message' | null; open: Set<EdBuffer>; todoDue: boolean }
interface GitTodoPending { done(ok: boolean): void }
/* the steps whose message git asks the frame for, by their todo verb */
const EDITED_STEPS = new Set(['reword', 'r', 'squash', 's', 'fixup', 'f']);

/* The frame as git's editors for a rebase in R: only the todo and COMMIT_EDITMSG of R's own git directory (a
   linked worktree's own), by their true names, are taken; any other file is left unanswered. Only `rebase -i`
   (INTERACTIVE) asks for the todo, once, when it starts: any other frame naming it (an exec line's, one in a
   rebase gone on with) is nobody's and is left unanswered too, so no second todo buffer opens and the todo git
   is working from is not written over. */
function rebaseEditor(r: VcRepo, interactive = false): RebaseEditor {
  const ed: RebaseEditor = { aborted: null, open: new Set(), todoDue: interactive, edit: async file => {
    const px = await Vc.run(r, ['rev-parse', '--git-path', 'rebase-merge/git-rebase-todo', '--git-path', 'COMMIT_EDITMSG', '--git-path', 'rebase-merge/done'], { ...READ, lossy: true });
    if (px.code !== 0 || px.error || px.timedOut || px.truncated) failed(px, 'git rev-parse');
    const [todo, msg, done] = px.out.split('\n').slice(0, 3).map(p => truename(p.startsWith('/') ? p : join(r.root, p)));
    const f = truename(file), files = Ed.host.files!;
    if (f === todo) {
      if (!ed.todoDue) return null;
      ed.todoDue = false;
      return editTodo(r, ed, f);
    }
    if (f !== msg) return null;
    const last = (files.read(done) || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).pop() || '';
    if (!EDITED_STEPS.has(last.split(/\s+/)[0])) return true;
    /* git cleans the message itself, with its own comment character (core.commentChar, `auto` included): it is
       handed back as written. Another rebase's message under the same name gets a name of its own. */
    const base = `*git-rebase-message: ${repoName(r)}*`, b = Ed.getBuffer(base) ? L.call('generate-new-buffer-name', [base]) as string : base;
    const pending = Vc.message({ name: b, text: files.read(f) || '', comment: '#', raw: true });
    const mb = Ed.getBuffer(b);
    if (mb) ed.open.add(mb);
    const m = await pending;
    if (mb) ed.open.delete(mb);
    if (m === null) { ed.aborted = 'message'; return false; }
    files.write(f, m);
    return true;
  } };
  return ed;
}
/* A rebase run with ED as its editors; a todo or message buffer still open when git ends goes with it. */
async function rebaseRun(r: VcRepo, args: string[], ed: RebaseEditor): Promise<EdProcResult> {
  try { return await runLong(r, args, undefined, false, ed.edit); }
  finally { for (const b of ed.open) if (E.buffers.includes(b)) L.call('kill-buffer', [b]); }
}

/* The todo FILE of R's rebase in its buffer: true when it is handed back (C-c C-c), false when the rebase is
   aborted. */
function editTodo(r: VcRepo, ed: RebaseEditor, file: string): Promise<boolean> {
  const text = Ed.host.files!.read(file);
  if (text === null) signal('file-error', `Could not read ${shown(file)}`);
  /* another rebase's todo under the same name (a repository of the same name) gets a name of its own */
  const name = `*git-rebase-todo: ${repoName(r)}*`;
  const b = Ed.getBufferCreate(Ed.getBuffer(name) ? L.call('generate-new-buffer-name', [name]) as string : name);
  b.text = text!; b.pt = 0; b.modified = false; b.undo = []; b.redo = [];
  try { Ed.switchMajorMode(b, 'git-rebase-todo-mode'); }
  catch (e) { L.call('kill-buffer', [b]); throw e; }
  b.pt = Math.max(0, lineStartB(b, todoLines(b)[0] ?? 1));
  ed.open.add(b);
  return new Promise<boolean>(done => {
    b.gitTodo = { done: (ok: boolean) => {
      delete b.gitTodo; ed.open.delete(b);
      if (ok) try { Ed.host.files!.write(file, b.text); } catch (e) { Ed.reportError(e); ok = false; }
      if (!ok) ed.aborted = 'todo';
      done(ok);
    } } as GitTodoPending;
    Ed.setWindowBuffer(b); Ed.scheduleRender();
    Ed.message('C-c C-c (Z Z) rebases as the todo says, C-c C-k (Z Q) aborts');
  });
}
const todoOfBuffer = (b: EdBuffer) => (b.gitTodo as GitTodoPending | undefined) || signal('user-error', 'No rebase waits for this todo') as never;
/* A todo line that names a commit: its indent, its verb (with fixup's -C or -c), and the rest from the commit. */
const TODO_LINE = /^(\s*)(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)(?:\s+-[cC])?\s+([0-9a-f]{4,64}\b.*)$/;
const TODO_STEP = /^\s*[a-z]/;
/* The line numbers of B's todo steps: neither blank nor a comment (git's comment character, whatever it is, is
   no letter). */
function todoLines(b: EdBuffer): number[] {
  return b.text.split('\n').flatMap((l, i) => (TODO_STEP.test(l) ? [i + 1] : []));
}
function lineText(b: EdBuffer, n: number): [number, number, string] {
  const s = lineStartB(b, n), nl = b.rope.indexOf('\n', s), e = nl < 0 ? b.rope.length : nl;
  return [s, e, b.text.slice(s, e)];
}
/* The commit line at point given VERB (its fixup flag dropped), as one change; point to the next line. */
function todoSet(verb: string): false {
  const b = cur();
  todoOfBuffer(b);
  const n = lineNoB(b, b.pt), [s, e, text] = lineText(b, n), m = TODO_LINE.exec(text);
  if (!m) signal('user-error', 'Not a commit\'s line: only pick, reword, edit, squash, fixup and drop lines change');
  Ed.replaceText(b, s, e, `${m![1]}${verb} ${m![3]}`);
  b.pt = lineStartB(b, Math.min(n + 1, lineNoB(b, b.rope.length)));
  return false;
}
/* The step at point moved past the step before it (UP) or after it, as one change; point stays on it. */
function todoMove(up: boolean): false {
  const b = cur();
  todoOfBuffer(b);
  const n = lineNoB(b, b.pt), steps = todoLines(b), k = steps.indexOf(n);
  if (k < 0) signal('user-error', 'Not a step of the todo');
  const o = steps[up ? k - 1 : k + 1];
  if (o === undefined) signal('user-error', up ? 'The first step already' : 'The last step already');
  const col = b.pt - lineStartB(b, n), [a, z] = up ? [o, n] : [n, o];
  const [as, , at] = lineText(b, a), [zs, ze, zt] = lineText(b, z), between = b.text.slice(as + at.length, zs);
  Ed.replaceText(b, as, ze, zt + between + at);
  b.pt = Math.min(lineStartB(b, o!) + col, lineText(b, o!)[1]);
  return false;
}
/* r i: the commit asked for (point's by default) and its descendants up to HEAD rebased interactively, onto its
   parent (--root for a root commit). */
async function interactivePrep(r: VcRepo, b: EdBuffer): Promise<[string, () => Promise<string>]> {
  await seqStart(r, 'rebase');
  const [branch, headOid] = await Promise.all([currentBranch(r), resolve(r, 'HEAD')]), head = branch !== null ? shown(branch) : 'HEAD';
  if (!headOid) signal('user-error', 'No commit yet: nothing to rebase');
  const rev = await ask('Rebase interactively from commit', refNames(await readRefs(r)), commitAt(b));
  const oid = await commitOf(r, rev), it = await described(r, oid);
  const x = await Vc.run(r, ['merge-base', '--is-ancestor', oid, headOid!], { ...READ, lossy: true });
  if (x.code === 1 && !x.error && !x.timedOut) signal('user-error', `${it} is not in ${head}'s history: r i rebases a commit of it and those after it`);
  if (x.code !== 0 || x.error || x.timedOut) failed(x, 'git merge-base');
  await Vc.offerSave(r, 'rebasing');
  const parent = await resolve(r, oid + '^');
  const args = parent ? ['rebase', '-i', '--end-of-options', parent] : ['rebase', '-i', '--root'];
  return [`Rebasing ${head} interactively from ${it}`, async () => {
    const ed = rebaseEditor(r, true);
    const x = await rebaseRun(r, args, ed);
    return seqSaid(r, 'rebase', x, 'Not rebased', async () => {
      const after = await resolve(r, 'HEAD');
      return after === headOid ? `Nothing rebased: ${head} at ${await described(r, after!)}` : `Rebased ${head} interactively: now at ${await described(r, after!)}`;
    }, ed);
  }];
}

CMD('git-rebase-interactive', '', '', 'Rebase the commit at point, or one asked for, and those after it up to HEAD interactively (r i): their todo is written in a buffer, C-c C-c rebases as it says, C-c C-k aborts. In the background.', () => seqOp(interactivePrep));
CMD('git-rebase-todo-pick', '', '', 'Pick the commit on this todo line (p): use it as it is.', () => todoSet('pick'));
CMD('git-rebase-todo-reword', '', '', 'Reword the commit on this todo line (r): use it, its message written in a buffer.', () => todoSet('reword'));
CMD('git-rebase-todo-edit', '', '', 'Edit the commit on this todo line (e): use it, and stop there for amending.', () => todoSet('edit'));
CMD('git-rebase-todo-squash', '', '', 'Squash the commit on this todo line into the one before it (s), the two messages written as one in a buffer.', () => todoSet('squash'));
CMD('git-rebase-todo-fixup', '', '', 'Fix up the one before with the commit on this todo line (f): melded into it, its message left out.', () => todoSet('fixup'));
CMD('git-rebase-todo-drop', '', '', 'Drop the commit on this todo line (d): leave it out.', () => todoSet('drop'));
CMD('git-rebase-todo-move-up', '', '', 'Move the step at point above the one before it (M-k, M-p).', () => todoMove(true));
CMD('git-rebase-todo-move-down', '', '', 'Move the step at point below the one after it (M-j, M-n).', () => todoMove(false));
CMD('git-rebase-todo-finish', '', '', 'Hand the todo back to git as it is (C-c C-c, Z Z): the rebase goes on with it.', () => {
  const b = cur();
  todoOfBuffer(b).done(true);
  L.call('kill-buffer', [b]);
  return false;
});
CMD('git-rebase-todo-abort', '', '', 'Abort the rebase this todo is for (C-c C-k, Z Q): nothing is changed.', () => {
  const b = cur();
  todoOfBuffer(b).done(false);
  L.call('kill-buffer', [b]);
  return false;
});
/* A todo buffer killed another way aborts its rebase. */
L.D('git--rebase-todo-killed', '', 'kill-buffer-hook: a rebase todo killed before C-c C-c aborts its rebase.', () => {
  const t = cur().gitTodo as GitTodoPending | undefined;
  if (t) t.done(false);
  return false;
});
L.addHook('kill-buffer-hook', intern('git--rebase-todo-killed'));

/* The commits selected in Visual state in a git buffer, newest first as they are shown (Visual state then left);
   none outside it. In the status buffer only its lists of commits count: the Head, Merge, operation and todo
   lines name a commit too (RET shows it), but one is no commit to pick (HEAD's own, the one being picked). */
const COMMIT_LISTS = new Set(['\0unpulled', '\0unpushed', '\0recent']);
function selectedCommits(b: EdBuffer): string[] {
  const v = b.gitView as GitView | undefined;
  if (!v || v.kind === 'ext' || EvilCore.stateOf(b) !== 'visual') return [];
  const [s, e] = EvilCore.visualRange(b, true);
  EvilCore.setState(b, 'motion');
  return v.rows.slice(lineNoB(b, s) - 1, lineNoB(b, Math.max(s, e - 1)))
    .filter(x => x.show && !x.stash && (v.kind !== 'status' || COMMIT_LISTS.has(x.sec.id))).map(x => x.show!);
}

CMD('git-merge', '', '', 'Merge a branch or a revision into HEAD (m m), the one at point by default, with git\'s message; while a merge is in progress, commit it. In the background; a conflict is said with its files.', () => seqOp(mergePrep));
CMD('git-merge-abort', '', '', 'Abort the merge in progress (m a), after asking: the index and the work tree back as HEAD has them.', () => seqOp(r => stepPrep(r, 'merge', 'abort')));
CMD('git-cherry-pick', '', '', 'Cherry-pick the commits selected, or a commit or a range A..B asked for (A A), the commit at point by default; while a cherry-pick is in progress, go on with it. In the background; a conflict is said with its files.', () => { const sel = selectedCommits(cur()); return seqOp((r, b) => pickPrep(r, b, 'cherry-pick', sel)); });
CMD('git-cherry-pick-skip', '', '', 'Skip the commit the cherry-pick in progress stopped at (A s), after asking, and go on with the rest.', () => seqOp(r => stepPrep(r, 'cherry-pick', 'skip')));
CMD('git-cherry-pick-abort', '', '', 'Abort the cherry-pick in progress (A a), after asking: HEAD back where it was before it.', () => seqOp(r => stepPrep(r, 'cherry-pick', 'abort')));
CMD('git-revert', '', '', 'Revert the commits selected, or a commit or a range A..B asked for (_ _), the commit at point by default, each by a commit of its own with git\'s message; while a revert is in progress, go on with it.', () => { const sel = selectedCommits(cur()); return seqOp((r, b) => pickPrep(r, b, 'revert', sel)); });
CMD('git-revert-skip', '', '', 'Skip the commit the revert in progress stopped at (_ s), after asking, and go on with the rest.', () => seqOp(r => stepPrep(r, 'revert', 'skip')));
CMD('git-revert-abort', '', '', 'Abort the revert in progress (_ a), after asking: HEAD back where it was before it.', () => seqOp(r => stepPrep(r, 'revert', 'abort')));
CMD('git-rebase', '', '', 'Rebase HEAD onto a branch or a revision (r e), the one at point by default. In the background; a conflict is said with its files.', () => seqOp((r, b) => rebasePrep(r, b, false)));
CMD('git-rebase-upstream', '', '', 'Rebase the current branch onto its upstream (r u), as last fetched.', () => seqOp((r, b) => rebasePrep(r, b, true)));
CMD('git-rebase-continue', '', '', 'Go on with the rebase in progress (r r): refused while a conflict is left; asks when a staged file still holds a conflict marker.', () => seqOp(r => stepPrep(r, 'rebase', 'continue')));
CMD('git-rebase-skip', '', '', 'Skip the commit the rebase in progress stopped at (r s), after asking, and go on with the rest.', () => seqOp(r => stepPrep(r, 'rebase', 'skip')));
CMD('git-rebase-abort', '', '', 'Abort the rebase in progress (r a), after asking: the branch back where it was before it.', () => seqOp(r => stepPrep(r, 'rebase', 'abort')));

for (const n of ['vc-status', 'git-status', 'git-status-refresh', 'git-status-toggle', 'git-status-next-section', 'git-status-previous-section',
  'git-status-next-sibling', 'git-status-previous-sibling', 'git-status-visit', 'git-status-stage', 'git-status-unstage', 'git-status-discard',
  'git-commit', 'git-commit-amend', 'git-commit-reword', 'git-commit-fixup', 'git-log', 'git-log-more',
  'git-checkout', 'git-branch-create', 'git-branch-new', 'git-branch-delete', 'git-branch-rename', 'git-reset-soft', 'git-reset-mixed',
  'git-reset-hard', 'git-stash', 'git-stash-index', 'git-stash-apply', 'git-stash-pop', 'git-stash-drop', 'git-tag-create', 'git-tag-delete',
  'git-fetch', 'git-fetch-all', 'git-pull', 'git-push', 'git-push-force', 'git-merge', 'git-merge-abort', 'git-cherry-pick', 'git-cherry-pick-skip',
  'git-cherry-pick-abort', 'git-revert', 'git-revert-skip', 'git-revert-abort', 'git-rebase', 'git-rebase-upstream', 'git-rebase-continue', 'git-rebase-skip',
  'git-rebase-abort', 'git-rebase-interactive', 'git-rebase-todo-finish', 'git-rebase-todo-abort', 'git-blame']) L.put(intern(n), 'evil-repeat', intern('abort'));
Ed.MODE_NAMES['git-rebase-todo-mode'] = 'Git Rebase Todo';
Ed.MODE_NAMES['git-status-mode'] = 'Git Status';
Ed.MODE_NAMES['git-log-mode'] = 'Git Log';
Ed.MODE_NAMES['git-revision-mode'] = 'Git Revision';
Ed.MODE_NAMES['git-blame-mode'] = 'Git Blame';

/* ---------- faces ---------- */
interface GitLex { ver: number; from: number; to: number; cls: Uint8Array; names: string[] }
const prevLexSeg = H.lexSeg;
H.lexSeg = (b, from, to, seg) => {
  const gv = b.gitView as GitView | undefined;
  if (!gv || !(VIEW_MODES.has(b.mode) || gv.kind === 'ext' && gv.ext.mode === b.mode)) return prevLexSeg ? prevLexSeg(b, from, to, seg) : null;
  const c = b._glx as GitLex | undefined;
  if (c && c.ver === b.ver && c.from === from && c.to === to) return c;
  const v = gv, text = seg as string, cls = new Uint8Array(text.length);
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
