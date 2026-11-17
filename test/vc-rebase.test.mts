// The interactive rebase from git's status and log buffers (src/vc-git.ts: r i, and git-rebase-todo-mode) in the
// headless runtime, with real git from PATH through Ed.proc over fake-proc.mts's host.proc, in throwaway
// repositories under a throwaway HOME; host.files is node:fs, as host-native.ts has it. The frame is git's
// sequence editor and editor (Vc's edit): the todo and the messages git asks for are written in buffers and
// handed back to the git that waits for them. One Edwin per process, so the cases run in order.
// Run: node --test test/vc-rebase.test.mts
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startEdwin, type Edwin, type NodeHost } from './headless.mts';
import { fakeProc, type FakeProc } from './fake-proc.mts';

const ed = await startEdwin();
const { Ed, E } = ed;
ed.eval('(set! corfu-auto #f)');
const lastMessage = (): string => { const t: string = Ed.getBuffer('*Messages*').text.replace(/\n+$/, ''); return t.slice(t.lastIndexOf('\n') + 1); };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-rebase-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's is read; fixed dates. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'EDITOR', 'VISUAL']) delete process.env[k];
after(() => { for (const id of proc.running()) proc.kill(id, 'KILL'); fs.rmSync(root, { recursive: true, force: true }); });

const proc = fakeProc();
const host = ed.host as NodeHost & { proc?: FakeProc; files?: Edwin };
host.proc = proc;
host.files = {
  read(n: string) { try { return fs.readFileSync(n, 'utf8'); } catch (e) { return null; } },
  exists: (n: string) => fs.existsSync(n), resolve: (n: string) => path.resolve(root, n), truename: (n: string) => n, label: (n: string) => n,
  write(n: string, text: string) { fs.writeFileSync(n, text); return true; }, remove() { throw new Error('not here'); }, list: () => [] as string[], cwd: root,
  tree: {
    names: (d: string) => fs.readdirSync(d),
    entry(p: string) {
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) { return null; }
      return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
    },
  },
};

const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' }); }
  catch (e) { return String((e as { stdout?: string }).stdout || ''); }
};
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rev = (cwd: string, r: string) => git(cwd, 'rev-parse', '--verify', '--quiet', r).trim();
const short = (cwd: string, r: string) => git(cwd, 'rev-parse', '--short', r).trim();
const subjects = (cwd: string, n: number) => git(cwd, 'log', '--format=%s', '-' + n).split('\n').filter(l => l);
const messageOf = (cwd: string, r: string) => git(cwd, 'log', '-1', '--format=%B', r);
const filesOf = (cwd: string, r: string) => git(cwd, 'ls-tree', '--name-only', r).split('\n').filter(l => l);
/* The short hash of HEAD's commit whose subject is SUBJECT. */
const hashOf = (subject: string) => { const l = git(work, 'log', '--format=%h %s', 'HEAD').split('\n').find(x => x.slice(x.indexOf(' ') + 1) === subject); assert.ok(l, `a commit ${subject}`); return l!.split(' ')[0]; };
const gitPath = (cwd: string, p: string) => path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', p).trim());

const visit = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-rebase test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}\n${lastMessage()}\n${E.current.name}\n${E.current.text.slice(-2000)}`);
  await Ed.whenIdle();
};
const asked = async (p: string) => { await until(() => (E.mini && E.mini.prompt) === p, `the prompt ${JSON.stringify(p)} (now ${JSON.stringify(E.mini && E.mini.prompt)})`); };
const question = async (p: string) => { await until(() => E.prompt === p + ' (y or n) ', `the question ${JSON.stringify(p)} (now ${JSON.stringify(E.prompt)})`); };
const marked = () => Ed.getBuffer('*Messages*').text.length;
/* The command done: a message said since MARK that is not the one it starts with, every child ended. */
const done = async (mark: number) => {
  await until(() => { const t: string = Ed.getBuffer('*Messages*').text.slice(mark); return t.trim() !== '' && !/… \(see \*vc-process\*\)\n?$/.test(t) && !/C-c C-k \(Z Q\) aborts\n?$/.test(t) && !proc.running().length; }, 'the command\'s message');
};
const answer = async (text: string) => { await ed.type(text + '\n'); await Ed.whenIdle(); };
const callOf = (sub: string) => proc.calls.filter(x => x.argv.includes(sub)).at(-1)!;
const argvOf = (sub: string) => { const c = callOf(sub).argv; return c.slice(c.indexOf(sub)); };
/* The todo's steps as the buffer shows them: its lines that are neither blank nor comments. */
const steps = () => lines().filter(l => l && !l.startsWith('#'));
const stepOf = (subject: string) => { const l = steps().find(s => s.endsWith(' ' + subject)); assert.ok(l, `a step of ${subject} in\n${E.current.text}`); return l!; };
const todoBuffer = async (name = '*git-rebase-todo: work*') => { await until(() => E.current.mode === 'git-rebase-todo-mode', 'the todo buffer'); assert.equal(E.current.name, name); };
const messageBuffer = async (name = '*git-rebase-message: work*') => { await until(() => E.current.mode === 'vc-message-mode', 'the message buffer'); assert.equal(E.current.name, name); };
const noRebase = (cwd: string) => assert.equal(fs.existsSync(gitPath(cwd, 'rebase-merge')), false, 'no rebase left in progress');

/* ---------- the fixture ---------- */
/* main: base (b.txt), c1 (f1.txt), c2 (f2.txt), c3 (f3.txt). */
const work = mkdir('work');
git(work, 'init', '-q', '-b', 'main');
write(path.join(work, 'b.txt'), 'b\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'base');
for (const n of [1, 2, 3]) { write(path.join(work, `f${n}.txt`), `${n}\n`); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', `c${n}`); }
const TIP = rev(work, 'main');
const reset = () => { git(work, 'rebase', '--abort'); git(work, 'switch', '-q', '-f', 'main'); git(work, 'reset', '-q', '--hard', TIP); git(work, 'clean', '-fdq'); };
const status = async (dir = work) => { visit(path.join(dir, 'b.txt')); await keys('SPC g g'); assert.equal(E.current.mode, 'git-status-mode'); };
/* r i from the commit SUBJECT, on its line in the status buffer's recent commits: the todo buffer. */
const rebaseFrom = async (subject: string) => {
  await status();
  goTo(`${hashOf(subject)} ${subject}`);
  await keys('r i');
  await asked(`Rebase interactively from commit (${hashOf(subject)}): `);
  await answer('');
  await todoBuffer();
};

test('r i reorders and squashes end to end: M-k moves a step, s squashes, Z Z hands the todo back; the squash\'s message is written in a buffer', async () => {
  const C1 = hashOf('c1'), C2 = hashOf('c2'), C3 = hashOf('c3');
  const m = marked();
  await rebaseFrom('c1');
  assert.deepEqual(argvOf('rebase'), ['rebase', '-i', '--end-of-options', rev(work, 'main~3')]);
  /* git's own todo, its comments with it; point on its first step */
  assert.deepEqual(steps(), [`pick ${C1} # c1`, `pick ${C2} # c2`, `pick ${C3} # c3`]);
  assert.match(E.current.text, /^# Rebase [0-9a-f]+\.\.[0-9a-f]+ onto [0-9a-f]+/m);
  assert.equal(Ed.lineNoB(E.current, E.current.pt), 1);
  assert.equal(E.current.text, fs.readFileSync(gitPath(work, 'rebase-merge/git-rebase-todo'), 'utf8'), 'the file git wrote');
  assert.equal(lastMessage(), 'C-c C-c (Z Z) rebases as the todo says, C-c C-k (Z Q) aborts');
  /* c3 above c2: M-k, point kept on it; then s on c2, below it */
  goTo(`pick ${C3} # c3`);
  E.current.pt += 5;
  await keys('M-k');
  assert.deepEqual(steps(), [`pick ${C1} # c1`, `pick ${C3} # c3`, `pick ${C2} # c2`]);
  assert.equal(Ed.lineNoB(E.current, E.current.pt), 2);
  assert.equal(E.current.pt - Ed.lineStartB(E.current, 2), 5, 'the column kept');
  /* one undo step: u puts it back, C-r again */
  await keys('u');
  assert.deepEqual(steps(), [`pick ${C1} # c1`, `pick ${C2} # c2`, `pick ${C3} # c3`]);
  await keys('C-r');
  assert.deepEqual(steps(), [`pick ${C1} # c1`, `pick ${C3} # c3`, `pick ${C2} # c2`]);
  goTo(`pick ${C2} # c2`);
  await keys('s');
  assert.deepEqual(steps(), [`pick ${C1} # c1`, `pick ${C3} # c3`, `squash ${C2} # c2`]);
  await keys('Z Z');
  /* the squash: git's combined message, in a message buffer */
  await messageBuffer();
  assert.match(E.current.text, /^# This is a combination of 2 commits\.\n# This is the 1st commit message:\n\nc3\n\n# This is the commit message #2:\n\nc2\n/);
  assert.equal(Ed.getBuffer('*git-rebase-todo: work*'), null, 'the todo buffer gone');
  E.current.text = 'c3 and c2\n\nboth files\n# left out\n';
  await keys('C-c C-c');
  await done(m);
  assert.equal(lastMessage(), `Rebased main interactively: now at ${short(work, 'HEAD')} c3 and c2`);
  assert.deepEqual(subjects(work, 4), ['c3 and c2', 'c1', 'base']);
  assert.equal(messageOf(work, 'HEAD'), 'c3 and c2\n\nboth files\n\n');
  assert.deepEqual(filesOf(work, 'HEAD'), ['b.txt', 'f1.txt', 'f2.txt', 'f3.txt']);
  assert.deepEqual(filesOf(work, 'HEAD~1'), ['b.txt', 'f1.txt'], 'c1 before c3 and c2');
  assert.equal(git(work, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
  noRebase(work);
  /* both editors were the frame's */
  const env = callOf('rebase').opts.env!;
  assert.match(env.GIT_SEQUENCE_EDITOR!, /edwin-edit/);
  assert.equal(env.GIT_EDITOR, env.GIT_SEQUENCE_EDITOR);
  assert.equal(callOf('rebase').opts.timeout, undefined, 'no timeout of the host: Vc\'s own, paused while editing');
  /* the status buffer read again */
  assert.equal(E.current.mode, 'git-status-mode');
  assert.ok(lines().includes(`${short(work, 'HEAD')} c3 and c2`), E.current.text);
});

test('r, e and d: a reword\'s message in a buffer, an edit stops for r r, a drop leaves its commit out', async () => {
  reset();
  const C2 = hashOf('c2'), C3 = hashOf('c3');
  let m = marked();
  await rebaseFrom('c1');
  await keys('r');
  assert.equal(steps()[0].split(' ')[0], 'reword');
  assert.equal(Ed.lineNoB(E.current, E.current.pt), 2, 'point to the next line');
  await keys('e');
  await keys('d');
  assert.deepEqual(steps().map(s => s.split(' ')[0]), ['reword', 'edit', 'drop']);
  /* f and back to p, and fixup -C's flag dropped by a key */
  goTo(steps()[1]);
  await keys('f');
  assert.equal(steps()[1].split(' ')[0], 'fixup');
  goTo(steps()[1]);
  E.current.text = E.current.text.replace(`fixup ${C2}`, `fixup -C ${C2}`);
  goTo(steps()[1]);
  await keys('p');
  assert.equal(steps()[1], `pick ${C2} # c2`);
  goTo(steps()[1]);
  await keys('e');
  await keys('C-c C-c');
  await messageBuffer();
  assert.match(E.current.text, /^c1\n/);
  E.current.text = 'c1 reworded\n';
  await keys('C-c C-c');
  await done(m);
  /* (the commit it stopped at is the one picked, as REBASE_HEAD names it) */
  assert.equal(lastMessage(), `Rebasing stopped at ${C2} c2 (2 of 3): r r goes on, r s skips the commit, r a aborts`);
  assert.match(lines()[1], /^Rebasing main onto [0-9a-f]+ base, stopped at [0-9a-f]+ c2 \(2 of 3\)$/, E.current.text);
  assert.deepEqual(lines().slice(lineOf('To rebase (1)'), lineOf('To rebase (1)') + 1), [`drop ${C3} c3`]);
  m = marked();
  await keys('r r');
  await done(m);
  assert.equal(lastMessage(), `Rebase done: main at ${short(work, 'HEAD')} c2`);
  assert.deepEqual(subjects(work, 4), ['c2', 'c1 reworded', 'base']);
  assert.deepEqual(filesOf(work, 'HEAD'), ['b.txt', 'f1.txt', 'f2.txt']);
  noRebase(work);
});

test('C-c C-k, Z Q and killing the todo abort the rebase: nothing changed; a reword\'s message aborted stops the rebase there', async () => {
  for (const how of ['C-c C-k', 'Z Q', 'kill']) {
    reset();
    const m = marked();
    await rebaseFrom('c2');
    if (how === 'kill') L('kill-buffer', E.current); else await keys(how);
    await done(m);
    assert.equal(lastMessage(), 'Rebase aborted (C-c C-k): nothing changed', how);
    assert.equal(rev(work, 'HEAD'), TIP);
    noRebase(work);
    assert.equal(Ed.getBuffer('*git-rebase-todo: work*'), null);
  }
  /* an empty todo: git's nothing to do */
  reset();
  let m = marked();
  await rebaseFrom('c3');
  E.current.text = '';
  await keys('C-c C-c');
  await done(m);
  assert.equal(lastMessage(), 'process-error: Not rebased: nothing to do (see *vc-process*)');
  assert.equal(rev(work, 'HEAD'), TIP);
  noRebase(work);
  /* a reword whose message is aborted: git stops at it, its message kept */
  m = marked();
  await rebaseFrom('c3');
  await keys('r');
  await keys('Z Z');
  await messageBuffer();
  await keys('C-c C-k');
  await done(m);
  assert.equal(lastMessage(), `Rebasing stopped at ${hashOf('c3')} c3 (1 of 1): its message was aborted (C-c C-k), so it keeps the one it had: r r goes on, r s skips the commit, r a aborts`);
  m = marked();
  await keys('r a');
  await question(`Abort the rebase, putting main back at ${short(work, TIP)} c3 (the commits rebased so far and your resolutions discarded)?`);
  await keys('y');
  await done(m);
  assert.equal(rev(work, 'HEAD'), TIP);
  noRebase(work);
});

test('a file the frame did not ask for is left unanswered: an exec line printing a frame for another file opens nothing, writes nothing', async () => {
  reset();
  const outside = path.join(root, 'outside.txt');
  write(outside, 'untouched\n');
  /* a pre-rebase hook that prints one too: hooks write to git's error output */
  const ran = path.join(root, 'hook-ran');
  write(path.join(work, '.git', 'hooks', 'pre-rebase'), `#!/bin/sh\nprintf '\\000edwin-edit\\000%s\\000%s\\000' "$$" '${outside}'\ntouch '${ran}'\nexit 0\n`);
  fs.chmodSync(path.join(work, '.git', 'hooks', 'pre-rebase'), 0o755);
  const m = marked(), n = proc.calls.length;
  await rebaseFrom('c3');
  E.current.text = `${stepOf('c3')}\nexec printf '\\000edwin-edit\\000%s\\000%s\\000' "$$" ${outside}\n`;
  await keys('Z Z');
  await done(m);
  assert.equal(lastMessage(), `Nothing rebased: main at ${short(work, 'HEAD')} c3`);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched\n');
  assert.ok(fs.existsSync(ran), 'the hook ran');
  /* the exec's frame was read and looked at (the todo's, then its): a rev-parse for each */
  assert.equal(proc.calls.slice(n).filter(c => c.argv.includes('COMMIT_EDITMSG')).length, 2);
  assert.ok(!E.buffers.some((b: { mode: string }) => b.mode === 'git-rebase-todo-mode' || b.mode === 'vc-message-mode'), 'no buffer opened for it');
  noRebase(work);
  fs.rmSync(path.join(work, '.git', 'hooks', 'pre-rebase'));
});

test('git cleans a rebase\'s message with its own comment character: with core.commentChar `;` a `#` line is kept, a `;` line left out', async () => {
  reset();
  git(work, 'config', 'core.commentChar', ';');
  const m = marked();
  await rebaseFrom('c3');
  await keys('r');
  await keys('Z Z');
  await messageBuffer();
  assert.match(E.current.text, /^c3\n\n; Please enter the commit message/m, 'git\'s comments with its character');
  E.current.text = 'c3 reworded\n\n#123 keep me\n; left out\n' + E.current.text.slice(E.current.text.indexOf('\n; Please'));
  await keys('C-c C-c');
  await done(m);
  git(work, 'config', '--unset', 'core.commentChar');
  assert.equal(messageOf(work, 'HEAD'), 'c3 reworded\n\n#123 keep me\n\n');
  noRebase(work);
});

test('a second repository of the same name: its todo has a buffer of its own, the first one\'s todo left open and its rebase waiting', async () => {
  reset();
  const other = mkdir('other', 'work');
  git(other, 'init', '-q', '-b', 'main');
  for (const n of [1, 2]) { write(path.join(other, `b.txt`), `${n}\n`); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', `o${n}`); }
  const OTHER = rev(other, 'main');
  await rebaseFrom('c3');
  const first = E.current;
  await status(other);
  goTo(`${short(other, 'main')} o2`);
  await keys('r i');
  await asked(`Rebase interactively from commit (${short(other, 'main')}): `);
  await answer('');
  await todoBuffer('*git-rebase-todo: work*<2>');
  const second = E.current;
  assert.ok(E.buffers.includes(first) && first.gitTodo, 'the first todo still open, its rebase waiting');
  await keys('C-c C-k');
  await until(() => !E.buffers.includes(second) && !fs.existsSync(gitPath(other, 'rebase-merge')), 'the second rebase aborted');
  assert.ok(fs.existsSync(gitPath(work, 'rebase-merge')), 'the first rebase still waits');
  Ed.setWindowBuffer(first);
  const m = marked();
  await keys('C-c C-k');
  await done(m);
  assert.equal(lastMessage(), 'Rebase aborted (C-c C-k): nothing changed');
  assert.equal(rev(work, 'HEAD'), TIP);
  assert.equal(rev(other, 'HEAD'), OTHER);
  noRebase(work);
});

test('a frame no editor waits for: an exec line\'s frame for the todo opens no second todo and writes nothing, its answer to one for COMMIT_EDITMSG is its own and the next editor skips it, so the reword after them is still edited', async () => {
  reset();
  const m = marked(), n = proc.calls.length;
  await rebaseFrom('c2');
  const todo = gitPath(work, 'rebase-merge/git-rebase-todo'), msg = gitPath(work, 'COMMIT_EDITMSG');
  /* each exec prints a frame as an editor shell would, with its own process id, then lingers so that the step git
     is at when Edwin looks at the frame is the exec itself; the last one's id is no number */
  const frame = (file: string, id = '"$$"') => `exec printf '\\000edwin-edit\\000%s\\000%s\\000' ${id} ${file}; sleep 2`;
  E.current.text = `${stepOf('c2')}\n${frame(todo)}\n${frame(msg)}\n${frame(msg, 'x')}\n${stepOf('c3').replace(/^pick/, 'reword')}\n`;
  await keys('Z Z');
  /* the exec's frame for COMMIT_EDITMSG got an answer nobody read (the exec's own id): the reword's editor must skip
     it and get its own, so its message buffer opens */
  await messageBuffer();
  assert.equal(E.current.text.split('\n')[0], 'c3');
  assert.ok(!E.buffers.some((b: { mode: string }) => b.mode === 'git-rebase-todo-mode'), 'no second todo buffer');
  E.current.text = 'c3 reworded\n';
  await keys('C-c C-c');
  await done(m);
  assert.equal(lastMessage(), `Rebased main interactively: now at ${short(work, 'HEAD')} c3 reworded`);
  assert.deepEqual(subjects(work, 4), ['c3 reworded', 'c2', 'c1', 'base']);
  /* the frames with a number for an id were each looked at (the todo's, the reword's, the execs' two): a rev-parse
     for each; the one with `x` for an id was not */
  assert.equal(proc.calls.slice(n).filter(c => c.argv.includes('COMMIT_EDITMSG')).length, 4);
  noRebase(work);
});

test('an exec line\'s command reads the end of its input at once; a frame\'s start never ended by a NUL is output, and a later frame is still answered', async () => {
  reset();
  const m = marked();
  await rebaseFrom('c3');
  /* cat ends at once (git's input is /dev/null); the printf starts a frame it never ends, 100 kB after it */
  E.current.text = `exec cat\nexec printf '\\000edwin-edit\\000%s\\000' "$$"; head -c 100000 /dev/zero | tr '\\000' x\n${stepOf('c3').replace(/^pick/, 'reword')}\n`;
  await keys('Z Z');
  await messageBuffer();
  E.current.text = 'c3 after the execs\n';
  await keys('C-c C-c');
  await done(m);
  assert.equal(lastMessage(), `Rebased main interactively: now at ${short(work, 'HEAD')} c3 after the execs`);
  noRebase(work);
});

test('r i on a root commit rebases with --root; from the log buffer too', async () => {
  reset();
  await status();
  await keys('l l');
  await until(() => E.current.mode === 'git-log-mode' && lines().some(l => / base /.test(l)), 'the log');
  E.current.pt = Ed.lineStartB(E.current, lines().findIndex(l => / base /.test(l)) + 1);
  const m = marked();
  await keys('r i');
  await asked(`Rebase interactively from commit (${hashOf('base')}): `);
  await answer('');
  await todoBuffer();
  assert.deepEqual(argvOf('rebase'), ['rebase', '-i', '--root']);
  assert.equal(steps().length, 4);
  await keys('C-c C-k');
  await done(m);
  assert.equal(rev(work, 'HEAD'), TIP);
  noRebase(work);
});

test('refused: a commit not in HEAD\'s history, a rebase in progress, the todo keys elsewhere and off a commit line, a jj workspace, the image\'s replay', async () => {
  reset();
  git(work, 'branch', '-f', 'side', 'main~2');
  git(work, 'switch', '-q', 'side');
  write(path.join(work, 's.txt'), 's\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'on side');
  const SIDE = rev(work, 'side');
  git(work, 'switch', '-q', 'main');
  await status();
  goTo(`${hashOf('c3')} c3`);
  const n = proc.calls.length;
  let m = marked();
  await keys('r i');
  await asked(`Rebase interactively from commit (${hashOf('c3')}): `);
  await answer('side');
  await done(m);
  assert.equal(lastMessage(), `${short(work, SIDE)} on side is not in main's history: r i rebases a commit of it and those after it`);
  m = marked();
  await keys('r i');
  await asked(`Rebase interactively from commit (${hashOf('c3')}): `);
  await answer('--exec=touch x');
  await done(m);
  assert.equal(lastMessage(), 'Not a commit: --exec=touch x');
  assert.ok(!proc.calls.slice(n).some(c => c.argv.includes('rebase')), 'no rebase ran');
  /* a rebase in progress (stopped at an edit) */
  git(work, '-c', 'sequence.editor=sed -i s/^pick/edit/', 'rebase', '-i', 'main~1');
  await keys('g r');
  m = marked();
  await keys('r i');
  await done(m);
  assert.equal(lastMessage(), 'A rebase is in progress: r r goes on, r s skips the commit, r a aborts');
  git(work, 'rebase', '--abort');
  /* the todo keys elsewhere; off a commit's line; moving past the ends */
  assert.equal(await errorOf(Promise.resolve().then(() => L('git-rebase-todo-pick'))), 'No rebase waits for this todo');
  m = marked();
  await rebaseFrom('c2');
  goTo(lines().find(l => l.startsWith('# Rebase'))!);
  await keys('p');
  assert.equal(lastMessage(), 'Not a commit\'s line: only pick, reword, edit, squash, fixup and drop lines change');
  await keys('M-k');
  assert.equal(lastMessage(), 'Not a step of the todo');
  goTo(stepOf('c2'));
  await keys('M-k');
  assert.equal(lastMessage(), 'The first step already');
  goTo(stepOf('c3'));
  await keys('M-j');
  assert.equal(lastMessage(), 'The last step already');
  /* while the todo is open the repository is busy */
  const todo = E.current;
  visit(path.join(work, 'b.txt'));
  assert.match(String(await errorOf(Promise.resolve().then(() => L('git-fetch')))), /^Rebasing main interactively from [0-9a-f]+ c2 still runs in .*: see \*vc-process\*$/);
  Ed.setWindowBuffer(todo);
  await keys('C-c C-k');
  await done(m);
  /* a jj workspace */
  const jj = mkdir('jj');
  execFileSync('jj', ['git', 'init'], { cwd: jj, stdio: 'ignore' });
  visit(path.join(jj, 'f.txt'));
  const k = proc.calls.length;
  await keys('M-x'); await ed.type('git-rebase-interactive\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /is a jj workspace: jj has its own commands/);
  assert.equal(proc.calls.length, k, 'nothing ran');
  /* under the image's replay nothing starts */
  await status();
  const j = proc.calls.length;
  let p: Promise<unknown> = Promise.resolve();
  Ed.proc.replay(() => { try { p = Promise.resolve(L('git-rebase-interactive')); } catch (e) { p = Promise.reject(e); } });
  assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, j, 'no child started');
});
