/* Version control for Edwin (docs/steps.md, "The commit message buffer" and "Running git and jj"): the parts
   git and jj share. The buffer a commit message is written in, and the runner every git and jj child goes
   through (Vc.repo, Vc.start, Vc.run), below it.

   Vc.message opens a buffer in vc-message-mode (scm/emacs.scm) holding a message to edit, and gives a promise
   of what the user leaves in it: C-c C-c (vc-message-finish) gives the message without its comment lines,
   cleaned as `git stripspace --strip-comments` cleans it; C-c C-k (vc-message-abort), or killing the buffer,
   gives null. The opener runs the program that takes the message (git commit, jj describe), from TypeScript:
   a Scheme form can finish or abort a message, never open one or say what is done with it.

   The mode shows the summary line (the first line that is neither blank nor a comment) in its own face, the
   characters past vc-message-summary-max-length and a second line that is not blank as warnings, and the
   comment lines (those that start with the opener's comment prefix, `#` for git, `JJ:` for jj) as comments. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD } = L;
const cur = () => E.current;

L.defvar('vc-message-summary-max-length', 68, 'The longest summary line a commit message should have: the characters past it show as a warning (vc-message-mode).');
function maxLength(): number {
  const n = L.get('vc-message-summary-max-length');
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 68;
}

/* White space as git stripspace counts it: space, tab and carriage return only (not \v, \f or Unicode spaces
   such as U+00A0). A blank line holds nothing else. */
const TRAILING_SPACE = /[ \t\r]+$/;
const isBlank = (line: string) => !/[^ \t\r]/.test(line);

/* TEXT without the lines that start with COMMENT, trailing white space and runs of blank lines, as
   `git stripspace --strip-comments` gives it: '' when nothing is left, else it ends in one newline. */
function cleanMessage(text: string, comment: string): string {
  const out: string[] = [];
  let blank = false;
  for (const line of text.split('\n')) {
    if (comment && line.startsWith(comment)) continue;
    const l = line.replace(TRAILING_SPACE, '');
    if (!l) { blank = out.length > 0; continue; }
    if (blank) out.push('');
    blank = false;
    out.push(l);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/* b.vcMessage: the comment prefix of a buffer whose message an opener waits for, and how to give it the
   message (null: none). Gone once it has its answer. */
function pendingOf(b: EdBuffer): VcPending {
  const p = b.vcMessage;
  if (!p) signal('user-error', 'No commit waits for a message in this buffer');
  return p!;
}
function settle(b: EdBuffer, msg: string | null) {
  const p = b.vcMessage;
  if (!p) return;
  delete b.vcMessage;
  p.done(msg);
}

/* Open a buffer named NAME holding TEXT (point at its start) in the selected window, in vc-message-mode, its
   comment lines those that start with COMMENT. The promise gives the cleaned message, or null when the user
   aborts or kills the buffer. NAME must not name a live buffer: a message is never written over another
   buffer, nor over a message still being written. */
function message(opts: VcMessageOptions): Promise<string | null> {
  const { name, text = '', comment = '#' } = opts;
  if (typeof name !== 'string' || !name) signal('error', 'Vc.message needs a buffer name');
  if (typeof text !== 'string' || typeof comment !== 'string' || !comment) signal('error', 'Vc.message: TEXT is a string and COMMENT a non-empty one');
  if (Ed.getBuffer(name)) signal('user-error', `${name} is already open: finish (C-c C-c) or abort (C-c C-k) the message there first`);
  const b = Ed.getBufferCreate(name);
  b.text = text; b.pt = 0; b.modified = false; b.undo = []; b.redo = [];
  /* A signal from the mode's hooks (a broken vc-message-mode-hook in init.scm) leaves no buffer behind: a
     leftover one, with no message waiting, would refuse every later message under its name. */
  try { Ed.switchMajorMode(b, 'vc-message-mode'); }
  catch (e) { L.call('kill-buffer', [b]); throw e; }
  return new Promise<string | null>(done => {
    b.vcMessage = { comment, done };
    Ed.setWindowBuffer(b); Ed.scheduleRender();
  });
}

CMD('vc-message-finish', '', '', 'Give the commit message in this buffer to what waits for it, without its comment lines, and kill the buffer (C-c C-c). An empty message is refused.', () => {
  const b = cur(), p = pendingOf(b), msg = cleanMessage(b.text, p.comment);
  if (!msg) signal('user-error', 'The message is empty: write one, or abort with C-c C-k');
  settle(b, msg);
  L.call('kill-buffer', [b]);
  return false;
});
CMD('vc-message-abort', '', '', 'Abort the commit this buffer\'s message is for, and kill the buffer (C-c C-k).', () => {
  const b = cur();
  pendingOf(b);
  settle(b, null);
  L.call('kill-buffer', [b]);
  Ed.message('Message aborted');
  return false;
});
/* A message buffer killed another way aborts its message. */
L.D('vc--message-killed', '', 'kill-buffer-hook: a commit message buffer killed before C-c C-c aborts its commit.', () => { settle(cur(), null); return false; });
L.addHook('kill-buffer-hook', intern('vc--message-killed'));
for (const n of ['vc-message-finish', 'vc-message-abort']) L.put(intern(n), 'evil-repeat', intern('abort'));

/* ---------- faces ---------- */
const FACES = ['', 'vc-message-summary', 'vc-message-warning', 'cm'];
const F = { SUMMARY: 1, WARNING: 2, COMMENT: 3 };
interface VcLex { ver: number; from: number; to: number; max: number; comment: string; cls: Uint8Array; names: string[] }
const prevLexSeg = H.lexSeg;
H.lexSeg = (b, from, to, seg) => {
  if (b.mode !== 'vc-message-mode') return prevLexSeg ? prevLexSeg(b, from, to, seg) : null;
  const comment = b.vcMessage ? b.vcMessage.comment : '#', max = maxLength();
  const c = b._vlx as VcLex | undefined;
  if (c && c.ver === b.ver && c.from === from && c.to === to && c.max === max && c.comment === comment) return c;
  const all = b.text, text = seg as string, cls = new Uint8Array(text.length);
  /* The summary line: the first that is neither blank nor a comment; the line after it is the second. */
  let summary = -1, second = -1;
  for (let ls = 0; ls < all.length;) {
    let le = all.indexOf('\n', ls); if (le < 0) le = all.length;
    const line = all.slice(ls, le);
    if (!isBlank(line) && !line.startsWith(comment)) { summary = ls; second = le < all.length ? le + 1 : -1; break; }
    ls = le + 1;
  }
  for (let ls = 0; ls < text.length;) {
    let le = text.indexOf('\n', ls); if (le < 0) le = text.length;
    const start = from + ls, line = text.slice(ls, le), lineStart = all.lastIndexOf('\n', start - 1) + 1;
    if (all.startsWith(comment, lineStart)) cls.fill(F.COMMENT, ls, le);
    else if (lineStart === summary) {
      const past = Math.max(ls, Math.min(le, ls + max - (start - lineStart)));
      cls.fill(F.SUMMARY, ls, past); cls.fill(F.WARNING, past, le);
    }
    else if (lineStart === second && !isBlank(line)) cls.fill(F.WARNING, ls, le);
    ls = le + 1;
  }
  return b._vlx = { ver: b.ver, from, to, max, comment, cls, names: FACES };
};
const CSS = `
.text .vc-message-summary { color: var(--fn); font-weight: 600; }
.text .vc-message-warning { color: var(--rb1); text-decoration: underline; }
`;
Ed.host.page.addStyle('vc-css', CSS);

/* ---------- running git and jj ---------- */

/* git subcommands that keep the repository's hooks: commit, push and the sequencer (owner decision 12). Every
   other one, a subcommand not named anywhere here included, runs with core.hooksPath=/dev/null. */
const GIT_HOOKED = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'revert', 'am']);
/* git subcommands that write: they change the work tree, the index, the history or a remote, so they keep the
   repository's filter and merge drivers, its signature programs and its transport, as the owner expects. Every
   other subcommand, one named nowhere here included, is a read: for it nothing the repository's own configuration
   names runs. Its filter drivers are emptied (`git diff` runs a clean filter), its merge drivers too (`--remerge-diff`, and `-m` under
   log.diffMerges=remerge, merge a merge commit's parents again with the drivers of the merge attribute) and its
   signature programs set back to the user's (a `%G?` format verifies), a submodule's work tree is not looked
   into (the git that would look runs under the submodule's own configuration, its filters included), and a
   partial clone fetches nothing it lacks (`--no-lazy-fetch`: a fetch runs the remote's transport, with its
   core.sshCommand or credential helper, and a repository's protocol.NAME.allow beats `protocol.allow=never`). */
const GIT_WRITE = new Set([...GIT_HOOKED, 'add', 'apply', 'bisect', 'branch', 'checkout', 'checkout-index', 'clean', 'clone',
  'fetch', 'hash-object', 'init', 'ls-remote', 'merge-file', 'mv', 'notes', 'pull', 'read-tree', 'remote', 'reset', 'restore',
  'rm', 'stash', 'submodule', 'switch', 'tag', 'update-index', 'worktree']);
/* git subcommands that run a program the repository's configuration names and no setting turns off: difftool's
   and mergetool's tool commands, help's man viewer, the web browser of instaweb and web--browse. Refused. */
const GIT_REFUSED = new Set(['difftool', 'mergetool', 'help', 'instaweb', 'web--browse']);
/* The switches each of them gets after the subcommand: no external diff driver, no textconv driver, a submodule
   shown by its commit only (diff.submodule=diff would diff inside it), and a submodule's work tree not compared
   (`--ignore-submodules=dirty`, which beats a repository's submodule.NAME.ignore). */
const NO_EXT = ['--no-ext-diff', '--no-textconv', '--submodule=short'];
const GIT_AFTER: Record<string, string[]> = {
  diff: [...NO_EXT, '--ignore-submodules=dirty'], 'diff-files': [...NO_EXT, '--ignore-submodules=dirty'], 'diff-index': [...NO_EXT, '--ignore-submodules=dirty'],
  show: NO_EXT, log: NO_EXT, 'diff-tree': NO_EXT,
  status: ['--ignore-submodules=dirty'], blame: ['--no-textconv'], annotate: ['--no-textconv'],
};
/* The keys that name a signature program (gpg.program is gpg.openpgp.program's other name), by the format
   each is for, and the program git runs for a format no configuration names one for. */
const GPG_KEYS: Record<string, string> = { 'gpg.program': 'openpgp', 'gpg.openpgp.program': 'openpgp', 'gpg.ssh.program': 'ssh', 'gpg.x509.program': 'x509' };
const GPG_DEFAULT: Record<string, string> = { openpgp: 'gpg', ssh: 'ssh-keygen', x509: 'gpgsm' };
/* Before every git subcommand: no pager, no fsmonitor hook, no external diff. git's safe.directory check is
   left as it is: a repository it refuses as unsafe stays refused. */
const GIT_BASE = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external='];
/* Before every jj subcommand: no pager, no colour, git's diff format (no external diff tool). */
const JJ_BASE = ['--no-pager', '--color=never', '--config', 'ui.diff-formatter=:git'];
/* Switches that would undo the above, refused before a `--`: a caller puts what the user typed after one. For
   git, `describe --dirty` and `--broken` too: they compare a submodule's work tree (describe reads no
   diff.ignoreSubmodules, and no switch of its own keeps it out), which runs the submodule's clean filter. */
const UNDOES: Record<VcTool, string[]> = {
  git: ['--ext-diff', '--textconv', '--paginate', '--show-signature', '--submodule', '--ignore-submodules', '--recurse-submodules', '--dirty', '--broken'],
  jj: ['--config', '--config-file', '--config-toml', '--color', '--tool', '--repository', '-R'],
};
/* The child's environment changes. No prompt for credentials (the child has no terminal either), no optional
   index write from a read, no editor (GIT_EDITOR is false until a package wires it back to the frame; a
   repository's sequence.editor beats GIT_EDITOR, GIT_SEQUENCE_EDITOR beats it), no stray repository from
   Edwin's own environment, and git's messages in English, so an unsafe repository is told apart in any locale. */
const ENV: Record<VcTool, Record<string, string | null>> = {
  git: {
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', GIT_PAGER: 'cat',
    GIT_DIR: null, GIT_WORK_TREE: null, GIT_INDEX_FILE: null, LC_ALL: null, LANGUAGE: null, LC_MESSAGES: 'C',
  },
  jj: { JJ_EDITOR: 'false', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'false' },
};

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const inDir = (d: string, name: string) => (d === '/' ? '/' : d + '/') + name;
function entryOf(p: string): EdFileEntry | null {
  const tree = Ed.host.files && Ed.host.files.tree;
  if (!tree) return null;
  try { return tree.entry(p); } catch (e) { return null; }
}
const isDirEntry = (e: EdFileEntry | null) => !!e && (e.kind === 'dir' || e.kind === 'link' && !!e.dir);

/* The repository DIR (an absolute path) is in: the nearest directory up from it that holds `.jj` (a jj
   workspace, colocated or not) or `.git` (a directory, or the file of a worktree or submodule), `.jj` first.
   Null outside one, and where the host has no file tree (a web frame, edwind). Read from the file system: no
   process runs, so nothing in the repository can run either. */
function repo(dir: string): VcRepo | null {
  if (typeof dir !== 'string' || !dir.startsWith('/') || !(Ed.host.files && Ed.host.files.tree)) return null;
  for (let d = dir.replace(/\/+$/, '') || '/'; ; d = parentOf(d)) {
    if (isDirEntry(entryOf(inDir(d, '.jj')))) return { vcs: 'jj', root: d };
    const g = entryOf(inDir(d, '.git'));
    if (g && g.kind !== 'other') return { vcs: 'git', root: d };
    if (d === '/') return null;
  }
}

/* ---------- *vc-process* ---------- */
const LOG = '*vc-process*', LOG_MAX = 256 * 1024, ERR_KEPT = 8 * 1024;
const shownArg = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
/* TEXT at the end of *vc-process*, which keeps its last LOG_MAX characters, from a line's start. The buffer is
   read-only, never modified and keeps no undo. */
function log(text: string) {
  let b = Ed.getBuffer(LOG);
  if (!b) { b = Ed.getBufferCreate(LOG); b.readOnly = true; }
  Ed.editText(b, b.rope.length, 0, text);
  if (b.rope.length > LOG_MAX) {
    const nl = b.rope.indexOf('\n', b.rope.length - LOG_MAX);
    Ed.editText(b, 0, nl < 0 ? b.rope.length - LOG_MAX : nl + 1, '');
  }
  b.modified = false; b.undo = []; b.redo = [];
}
function ending(x: EdProcExit) {
  if (x.error) return `stopped: ${x.error}`;
  if (x.timedOut) return 'timed out';
  if (x.signal) return `killed by ${x.signal}`;
  return `exit ${x.code}${x.truncated ? ', output cut' : ''}`;
}
const UNSAFE = /detected dubious ownership in repository/;

/* ARGV started in REPO's root with ENV, logged to *vc-process*: the whole argv when it starts, then its error
   output (the first ERR_KEPT characters) and how it ended. The exit rejects with user-error when git refuses
   the repository as unsafe (safe.directory): that is shown as it is, never retried. */
function spawnLogged(r: VcRepo, argv: string[], env: Record<string, string | null>, opts: VcRunOptions): EdProc {
  const { onErr, ...rest } = opts;
  let err = '';
  const p = Ed.proc.spawn(argv, {
    ...rest, cwd: r.root, env,
    onErr: s => { if (err.length < ERR_KEPT) err += s; if (onErr) onErr(s); },
  });
  log(`$ ${argv.map(shownArg).join(' ')}\n  [${p.id}] in ${r.root}\n`);
  const exit = p.exit.then(x => {
    const e = err.length > ERR_KEPT ? err.slice(0, ERR_KEPT) + '\n…' : err;
    log(`${e ? e.replace(/\n?$/, '\n') : ''}  [${p.id}] ${ending(x)}\n`);
    if (argv[0] === 'git' && x.code === 128 && UNSAFE.test(err)) {
      const why = `git refuses ${r.root} as unsafe: it belongs to another user (safe.directory); see ${LOG}`;
      Ed.message(why);
      return signal('user-error', why) as never;
    }
    return x;
  });
  return { ...p, exit };
}

/* The `-c` settings a read command runs with, so that nothing the repository's own configuration (local and
   worktree scopes, the files they include) names runs: each filter and merge driver it declares emptied (git
   then fails to run the empty command, `cannot run : No such file`, and goes on), and each signature program it
   names set back to the user's (global, system or command scope; git's default when they name none). The user's
   own drivers (git-lfs) stay. */
async function repoOverrides(r: VcRepo): Promise<string[]> {
  const out: string[] = [];
  const p = spawnLogged(r, ['git', ...GIT_BASE, '-c', 'core.hooksPath=/dev/null', 'config', '--show-scope', '--null', '--get-regexp', '^(filter|merge|diff|gpg)\\.'],
    ENV.git, { maxBytes: 1024 * 1024, onOut: s => { out.push(s); } });
  p.closeStdin();
  const x = await p.exit;
  if (x.code === 1) return [];   // none
  if (x.code !== 0 || x.truncated) signal('process-error', `git config could not list ${r.root}'s drivers and signature programs: see ${LOG}`);
  const parts = out.join('').split('\0'), filters = new Set<string>(), merges = new Set<string>(), diffs = new Set<string>(), repoGpg = new Set<string>(), userGpg: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const ofRepo = parts[i] === 'local' || parts[i] === 'worktree', nl = parts[i + 1].indexOf('\n');
    const key = nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl), format = GPG_KEYS[key];
    if (format) {
      if (ofRepo) repoGpg.add(format);
      else if (nl >= 0) userGpg[format] = parts[i + 1].slice(nl + 1);   // the last one is git's
      continue;
    }
    /* A driver's keys have three parts (filter.NAME.clean, merge.NAME.driver, diff.NAME.textconv); merge's and
       diff's own settings (merge.conflictStyle, diff.external) two. */
    const m = /^(filter|merge|diff)\.(.+)\.[^.]+$/s.exec(key);
    if (!ofRepo || !m) continue;
    /* `-c` takes the key up to the first '=': a name holding one could not be emptied. */
    if (/[=\n]/.test(m[2])) signal('user-error', `${r.root} declares a ${m[1]} driver whose name git -c cannot name: see ${LOG}`);
    (m[1] === 'filter' ? filters : m[1] === 'merge' ? merges : diffs).add(m[2]);
  }
  const c: string[] = [];
  for (const n of filters) c.push('-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`);
  for (const n of merges) c.push('-c', `merge.${n}.driver=`);
  /* A diff driver's programs too: `status -v` prints a diff and takes no --no-textconv. Emptied, git refuses
     to run the empty program, so such a read fails (exit 128) and runs nothing. */
  for (const n of diffs) c.push('-c', `diff.${n}.textconv=`, '-c', `diff.${n}.command=`);
  for (const [key, format] of Object.entries(GPG_KEYS))
    if (repoGpg.has(format)) c.push('-c', `${key}=${userGpg[format] ?? GPG_DEFAULT[format]}`);
  return c;
}

/* The jj settings a repository brings in its own .jj that jj would adopt as the user's for good (jj moves
   .jj/repo/config.toml and .jj/workspace-config.toml beside the user's config the first time it runs there,
   when no config id is beside them yet), or null. */
function jjAdopts(r: VcRepo): string | null {
  const jj = inDir(r.root, '.jj');
  let store = inDir(jj, 'repo');
  const e = entryOf(store);
  if (e && e.kind === 'file') {
    /* a secondary workspace: .jj/repo names the repository's store */
    const t = (Ed.host.files!.read(store) || '').trim();
    if (t) store = t.startsWith('/') ? t : inDir(jj, t);
  }
  for (const [conf, id] of [[inDir(store, 'config.toml'), inDir(store, 'config-id')], [inDir(jj, 'workspace-config.toml'), inDir(jj, 'workspace-config-id')]])
    if (entryOf(conf) && !entryOf(id)) return conf;
  return null;
}

function checkStart(r: VcRepo, args: string[]) {
  /* Before anything that waits: under the image's replay (and in a web frame, and in edwind) nothing starts. */
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  if (!r || (r.vcs !== 'git' && r.vcs !== 'jj')) signal('process-error', 'Vc runs git and jj only');
  if (typeof r.root !== 'string' || !r.root.startsWith('/')) signal('process-error', 'Vc needs the repository\'s root, an absolute path');
  if (!Array.isArray(args) || !args.length || args.some(a => typeof a !== 'string')) signal('process-error', 'Vc needs a subcommand and its arguments, as strings');
  /* (a name of git's shape that is no builtin would be looked up as the repository's alias.NAME: start empties
     that alias, so it runs nothing; jj's aliases are the user's own, a repository's settings being refused) */
  if (!/^[a-z][a-z0-9-]*$/.test(args[0])) signal('process-error', `Not a ${r.vcs} subcommand: ${args[0]}`);
  if (r.vcs === 'git' && GIT_REFUSED.has(args[0])) signal('process-error', `git ${args[0]} is not run here: it runs a program the repository's configuration names`);
  const end = args.indexOf('--'), undoes = UNDOES[r.vcs];
  for (const a of end < 0 ? args : args.slice(0, end)) {
    /* git's status, cat-file, ls-files and others take a long switch by any prefix of it (`--textc`): for git a
       prefix is refused too, `--text` included (diff's -a says it). jj takes none. */
    const name = a.split('=')[0], prefix = r.vcs === 'git' && name.length > 2 && name.startsWith('--');
    if (undoes.some(u => a === u || a.startsWith(u + '=') || prefix && u.startsWith(name) || u === '-R' && a.startsWith(u))) signal('process-error', `${a} is not given to ${r.vcs} here`);
  }
}

/* ARGS (a subcommand first) for REPO's program, in its root, with the hardening above; a running child, as
   Ed.proc.spawn gives it, its argv and environment fixed here. A jj repository that brings settings of its own
   is refused. */
async function start(r: VcRepo, args: string[], opts: VcRunOptions = {}): Promise<EdProc> {
  checkStart(r, args);
  args = args.slice();
  let argv: string[];
  if (r.vcs === 'jj') {
    const conf = jjAdopts(r);
    if (conf) signal('user-error', `jj not run in ${r.root}: ${conf} is jj settings the repository brings, which jj would take as yours for good (they may run programs). Look at them, then run jj there once in a terminal to take them`);
    argv = ['jj', ...JJ_BASE, ...args];
  } else {
    /* git runs a builtin by its name; any other name it looks up as alias.NAME, a shell command when it starts
       with `!`, so the repository's alias under the subcommand's name is emptied (git then refuses the name:
       `expansion of alias failed`) */
    const sub = args[0], pre = [...GIT_BASE, '-c', `alias.${sub}=`];
    if (!GIT_HOOKED.has(sub)) pre.push('-c', 'core.hooksPath=/dev/null');
    if (!GIT_WRITE.has(sub)) {
      /* (a git too old to know --no-lazy-fetch refuses it, and so runs nothing) */
      pre.splice(1, 0, '--no-lazy-fetch');
      pre.push('-c', 'protocol.allow=never', '-c', 'log.showSignature=false', ...await repoOverrides(r));
    }
    argv = ['git', ...pre, sub, ...(GIT_AFTER[sub] || []), ...args.slice(1)];
  }
  return spawnLogged(r, argv, ENV[r.vcs], opts);
}

/* As start, then the child's whole output, error and exit once it has ended. INPUT goes to its standard input,
   which is then closed (at once without one). */
async function run(r: VcRepo, args: string[], opts: VcRunOptions & { input?: string } = {}): Promise<EdProcResult> {
  const { input, onOut, onErr, ...rest } = opts;
  const out: string[] = [], err: string[] = [];
  const p = await start(r, args, { ...rest, onOut: s => { out.push(s); if (onOut) onOut(s); }, onErr: s => { err.push(s); if (onErr) onErr(s); } });
  try {
    if (input) p.write(input);
    p.closeStdin();
  } catch (e) { p.kill('KILL'); throw e; }
  const x = await p.exit;
  return { ...x, out: out.join(''), err: err.join('') };
}

globalThis.Vc = { message, cleanMessage, repo, start, run };
})();
