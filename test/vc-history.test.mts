// Branches, checkout, reset, stash and tags from git's status and log buffers (src/vc-git.ts: b, O, z and t) in
// the headless runtime, with real git from PATH through Ed.proc over fake-proc.mts's host.proc, in throwaway
// repositories under a throwaway HOME; host.files is node:fs, as host-native.ts has it. After each operation the
// refs, the index and the work tree are compared with what it must leave, and the message with what git did.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-history.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-history-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's is read; fixed dates. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS']) delete process.env[k];
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

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

/* git run directly (not through Vc), for the fixtures and to look at the result: a failure gives ''. */
const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' }); }
  catch (e) { return String((e as { stdout?: string }).stdout || ''); }
};
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file: string) => fs.readFileSync(file, 'utf8');
const rev = (cwd: string, r: string) => git(cwd, 'rev-parse', '--verify', '--quiet', r).trim();
const short = (cwd: string, r: string) => git(cwd, 'rev-parse', '--short', r).trim();
const branches = (cwd: string) => git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(l => l);
const tags = (cwd: string) => git(cwd, 'tag', '--list').split('\n').filter(l => l);
const stashes = (cwd: string) => git(cwd, 'stash', 'list', '--format=%gd %gs').split('\n').filter(l => l);
const porcelain = (cwd: string) => git(cwd, 'status', '--porcelain').split('\n').filter(l => l);
const headName = (cwd: string) => git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').trim();

const visit = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-history test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
/* Wait, up to 20 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}\n${lastMessage()}\n${E.current.text.slice(-2000)}`);
  await Ed.whenIdle();
};
/* The minibuffer's prompt once it asks, and a y-or-n question's. */
const asked = async (p: string) => { await until(() => (E.mini && E.mini.prompt) === p, `the prompt ${JSON.stringify(p)} (now ${JSON.stringify(E.mini && E.mini.prompt)})`); };
const question = async (p: string) => { await until(() => E.prompt === p + ' (y or n) ', `the question ${JSON.stringify(p)} (now ${JSON.stringify(E.prompt)})`); };
/* The command done: a message said since MARK, every child ended. */
const marked = () => Ed.getBuffer('*Messages*').text.length;
const done = async (mark: number) => { await until(() => Ed.getBuffer('*Messages*').text.length > mark && !proc.running().length, 'the command\'s message'); };
/* Answer the minibuffer with TEXT, then wait for the command to end. */
const answer = async (text: string) => { await ed.type(text + '\n'); await Ed.whenIdle(); };
/* git's writes run since call N (every subcommand but the reads these commands make). */
const READS = new Set(['status', 'diff', 'log', 'config', 'rev-parse', 'for-each-ref', 'symbolic-ref', 'check-ref-format', 'ls-tree', 'ls-files', 'grep']);
const writes = (n: number) => proc.calls.slice(n).map(c => c.argv).filter(a => a[0] === 'git').map(a => a.find((x, i) => i > 0 && !x.startsWith('-') && a[i - 1] !== '-c')!).filter(s => !READS.has(s));
const argvOf = (sub: string) => { const c = proc.calls.filter(x => x.argv.includes(sub)).at(-1)!.argv; return c.slice(c.indexOf(sub)); };

/* ---------- the fixture ---------- */
/* main: first (a.txt, c.txt), second (a.txt changed); other, from first: its own a.txt. */
const work = mkdir('work');
git(work, 'init', '-q', '-b', 'main');
write(path.join(work, 'a.txt'), 'a\n');
write(path.join(work, 'c.txt'), 'c\n');
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'first');
git(work, 'branch', 'other');
write(path.join(work, 'a.txt'), 'a2\n');
git(work, 'commit', '-q', '-am', 'second');
git(work, 'switch', '-q', 'other');
write(path.join(work, 'a.txt'), 'other\n');
git(work, 'commit', '-q', '-am', 'on other');
git(work, 'switch', '-q', 'main');
const FIRST = short(work, 'main~1');
const status = async () => { visit(path.join(work, 'a.txt')); await keys('SPC g g'); assert.equal(E.current.mode, 'git-status-mode'); goTo(lines()[0]); };

test('b b with local changes git would overwrite: refused with the files named, HEAD and the work tree as they were', async () => {
  write(path.join(work, 'a.txt'), 'dirty\n');
  await status();
  const n = proc.calls.length, m = marked();
  await keys('b b');
  await asked('Checkout (main): ');
  await answer('other');
  await done(m);
  assert.equal(lastMessage(), 'Not checked out: your local changes to a.txt would be overwritten; commit or stash them (z z) first');
  assert.equal(headName(work), 'main');
  assert.equal(read(path.join(work, 'a.txt')), 'dirty\n');
  assert.deepEqual(writes(n), ['switch']);
  assert.deepEqual(argvOf('switch'), ['switch', '--end-of-options', 'other']);
  const sw = proc.calls.findLastIndex(c => c.argv.includes('switch'));
  assert.ok(proc.calls.slice(sw).some(c => c.argv.includes('status')), 'the status read again after it');
  write(path.join(work, 'a.txt'), 'a2\n');
});

test('b b carries local changes git need not overwrite, and says so', async () => {
  write(path.join(work, 'c.txt'), 'c changed\n');
  await status();
  const m = marked();
  await keys('b b');
  await asked('Checkout (main): ');
  await answer('other');
  await done(m);
  assert.equal(lastMessage(), "Switched to branch 'other'; local changes kept in 1 file");
  assert.equal(headName(work), 'other');
  assert.equal(read(path.join(work, 'c.txt')), 'c changed\n');
  assert.match(lines()[0], /^Head: {5}other on other$/, 'the status read again');
  /* switch keeps no hook: core.hooksPath=/dev/null, as every command but commit, push and the sequencer */
  assert.ok(proc.calls.filter(c => c.argv.includes('switch')).at(-1)!.argv.includes('core.hooksPath=/dev/null'));
  write(path.join(work, 'c.txt'), 'c\n');
  const m2 = marked();
  await keys('b b');
  await asked('Checkout (other): ');
  await answer('main');
  await done(m2);
  assert.equal(lastMessage(), "Switched to branch 'main'");
});

test('b b on a log line with no branch detaches HEAD; leaving it with a commit made there names the commit left behind', async () => {
  await status();
  await keys('l l');
  await until(() => E.current.mode === 'git-log-mode' && lines().some(l => l.startsWith(FIRST + ' ')) && !proc.running().length, 'the log');
  goTo(lines().find(l => l.startsWith(FIRST + ' '))!);
  const m = marked();
  await keys('b b');
  await asked(`Checkout (${FIRST}): `);
  await keys('RET');
  await done(m);
  assert.equal(lastMessage(), `HEAD detached at ${FIRST} first`);
  assert.equal(headName(work), '', 'detached');
  assert.equal(rev(work, 'HEAD'), rev(work, 'main~1'));
  assert.deepEqual(argvOf('switch'), ['switch', '--detach', rev(work, 'main~1')]);
  await until(() => !proc.running().length && lines().some(l => l.startsWith(FIRST + ' (HEAD')), 'the log read again from the new HEAD');
  write(path.join(work, 'd.txt'), 'd\n');
  git(work, 'add', 'd.txt'); git(work, 'commit', '-q', '-m', 'detached work');
  const lost = short(work, 'HEAD');
  await status();
  assert.equal(lines()[0], `Head:     ${lost} detached work`, 'the status says HEAD is detached');
  const m2 = marked();
  await keys('b b');
  await asked(`Checkout (${lost}): `);
  await answer('main');
  await done(m2);
  assert.equal(lastMessage(), `Switched to branch 'main'; 1 commit left on no branch, the last ${lost} detached work (b n there names it)`);
  assert.equal(headName(work), 'main');
});

test('b c and b n create a branch at point\'s commit, checked out or not; a name or revision that would be a switch is refused, nothing written', async () => {
  await status();
  await keys('l l');
  await until(() => E.current.mode === 'git-log-mode' && lines().some(l => l.startsWith(FIRST + ' ')) && !proc.running().length, 'the log');
  goTo(lines().find(l => l.startsWith(FIRST + ' '))!);
  let m = marked();
  await keys('b c');
  await asked(`Create and checkout branch starting at (${FIRST}): `);
  await keys('RET');
  await asked('Name for new branch: ');
  await answer('feature');
  await done(m);
  assert.equal(lastMessage(), `Switched to a new branch feature at ${FIRST} first`);
  assert.equal(headName(work), 'feature');
  assert.equal(rev(work, 'feature'), rev(work, 'main~1'));
  await until(() => !proc.running().length && lines().some(l => l.startsWith(FIRST + ' (HEAD -> feature')), 'the log read again');
  /* b n: from a branch name, not checked out */
  m = marked();
  await keys('b n');
  await asked(`Create branch starting at (feature): `);
  await answer('main');
  await asked('Name for new branch: ');
  await answer('topic');
  await done(m);
  assert.equal(lastMessage(), `Branch topic created at ${short(work, 'main')} second`);
  assert.equal(headName(work), 'feature');
  assert.equal(rev(work, 'topic'), rev(work, 'main'));
  assert.deepEqual(argvOf('branch'), ['branch', '--end-of-options', 'topic', 'main']);
  /* refused before any write: a switch as a name, a name git would expand, one that exists, a switch as a revision */
  const n = proc.calls.length;
  for (const [bad, said] of [['--force', 'Not a valid branch name: --force'], ['@{-1}', 'Not a valid branch name: @{-1}'], ['a..b', 'Not a valid branch name: a..b']]) {
    m = marked();
    await keys('b n');
    await asked(`Create branch starting at (feature): `);
    await keys('RET');
    await asked('Name for new branch: ');
    await answer(bad);
    await done(m);
    assert.equal(lastMessage(), said);
  }
  m = marked();
  await keys('b n');
  await asked(`Create branch starting at (feature): `);
  await answer('--output=/tmp/x');
  await done(m);
  assert.equal(lastMessage(), 'Not a commit: --output=/tmp/x');
  assert.deepEqual(writes(n), [], 'no write ran');
  m = marked();
  await keys('b n');
  await asked(`Create branch starting at (feature): `);
  await keys('RET');
  await asked('Name for new branch: ');
  await answer('topic');
  await done(m);
  assert.equal(lastMessage(), "process-error: No branch created: a branch named 'topic' already exists (see *vc-process*)");
  await keys('q');
});

test('b x deletes a merged branch at once and an unmerged one after asking; b m renames', async () => {
  await status();
  /* topic is at main: merged into HEAD (feature)? No: feature is behind main, so topic is not merged into it. */
  git(work, 'switch', '-q', 'main');
  await keys('g r');
  let m = marked();
  await keys('b x');
  await asked('Delete branch (topic): ');
  await keys('RET');
  await done(m);
  assert.equal(lastMessage(), `Deleted branch topic (was ${short(work, 'main')}).`);
  assert.ok(!branches(work).includes('topic'));
  /* other has a commit main lacks */
  m = marked();
  await keys('b x');
  await asked('Delete branch: ');
  await answer('other');
  await question('Branch other is not fully merged: delete it anyway?');
  await keys('n');
  await done(m);
  assert.equal(lastMessage(), 'Nothing deleted');
  assert.ok(branches(work).includes('other'));
  const was = short(work, 'other');
  m = marked();
  await keys('b x');
  await asked('Delete branch: ');
  await answer('other');
  await question('Branch other is not fully merged: delete it anyway?');
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Deleted branch other (was ${was}).`);
  assert.deepEqual(argvOf('branch'), ['branch', '-D', '--end-of-options', 'other']);
  /* b m: the current branch by default */
  m = marked();
  await keys('b m');
  await asked('Rename branch (main): ');
  await keys('RET');
  await asked('Rename main to: ');
  await answer('trunk');
  await done(m);
  assert.equal(lastMessage(), 'Branch main renamed to trunk');
  assert.equal(headName(work), 'trunk');
  assert.match(lines()[0], /^Head: {5}trunk second$/);
  m = marked();
  await keys('b m');
  await asked('Rename branch (trunk): ');
  await keys('RET');
  await asked('Rename trunk to: ');
  await answer('main');
  await done(m);
  assert.deepEqual(branches(work).sort(), ['feature', 'main']);
});

test('O s, O m and O h reset to the commit at point or one typed; the hard reset asks first, and n writes nothing', async () => {
  write(path.join(work, 'a.txt'), 'a3\n');
  git(work, 'commit', '-q', '-am', 'third');
  const third = rev(work, 'HEAD'), second = rev(work, 'HEAD~1');
  await status();
  goTo('');
  /* soft, to a typed revision: the index keeps third's change */
  let m = marked();
  await keys('O s');
  await asked('Soft reset main to (HEAD): ');
  await answer('HEAD~1');
  await done(m);
  assert.equal(lastMessage(), `main reset to ${short(work, second)} second (soft)`);
  assert.equal(rev(work, 'HEAD'), second);
  assert.deepEqual(porcelain(work), ['M  a.txt']);
  assert.deepEqual(argvOf('reset'), ['reset', '-q', '--soft', second, '--']);
  /* mixed, to HEAD: the index as HEAD, the work tree kept */
  m = marked();
  await keys('O m');
  await asked('Mixed reset main to (HEAD): ');
  await keys('RET');
  await done(m);
  assert.deepEqual(porcelain(work), [' M a.txt']);
  assert.equal(read(path.join(work, 'a.txt')), 'a3\n');
  /* hard, from the commit at point (Recent commits): n keeps everything */
  goTo(lines().find(l => l.startsWith(FIRST + ' '))!);
  const n = proc.calls.length;
  m = marked();
  await keys('O h');
  await asked(`Hard reset main to (${FIRST}): `);
  await keys('RET');
  await question(`Hard reset main to ${FIRST} first, discarding every uncommitted change to tracked files?`);
  await keys('n');
  await done(m);
  assert.equal(lastMessage(), 'Nothing reset');
  assert.deepEqual(writes(n), [], 'n: no write ran');
  assert.equal(rev(work, 'HEAD'), second);
  assert.equal(read(path.join(work, 'a.txt')), 'a3\n');
  /* y: HEAD, the index and the work tree at the commit typed */
  goTo('');
  m = marked();
  await keys('O h');
  await asked('Hard reset main to (HEAD): ');
  await answer(third);
  await question(`Hard reset main to ${short(work, third)} third, discarding every uncommitted change to tracked files?`);
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `main reset to ${short(work, third)} third (hard)`);
  assert.equal(rev(work, 'HEAD'), third);
  assert.deepEqual(porcelain(work), []);
  /* a typed switch is never given to git */
  const k = proc.calls.length;
  m = marked();
  await keys('O h');
  await asked('Hard reset main to (HEAD): ');
  await answer('--merge');
  await done(m);
  assert.equal(lastMessage(), 'Not a commit: --merge');
  assert.deepEqual(writes(k), []);
});

test('O h names the untracked files the hard reset would overwrite, which git overwrites without a word', async () => {
  const start = rev(work, 'HEAD');
  write(path.join(work, 'x.txt'), 'old x\n');
  fs.mkdirSync(path.join(work, 'd'));
  write(path.join(work, 'd', 'y.txt'), 'old y\n');
  git(work, 'add', 'x.txt', 'd/y.txt');
  git(work, 'commit', '-q', '-m', 'tracked');
  const tracked = rev(work, 'HEAD');
  git(work, 'rm', '-q', '--cached', 'x.txt', 'd/y.txt');
  git(work, 'commit', '-q', '-m', 'untracked');
  write(path.join(work, 'x.txt'), 'precious\n');
  write(path.join(work, 'd', 'y.txt'), 'precious\n');
  await status();
  goTo('');
  const n = proc.calls.length;
  let m = marked();
  await keys('O h');
  await asked('Hard reset main to (HEAD): ');
  await answer('HEAD~1');
  await question(`Hard reset main to ${short(work, tracked)} tracked, discarding every uncommitted change to tracked files, and overwriting 2 untracked files d/y.txt, x.txt?`);
  await keys('n');
  await done(m);
  assert.equal(lastMessage(), 'Nothing reset');
  assert.deepEqual(writes(n), []);
  assert.equal(read(path.join(work, 'x.txt')), 'precious\n');
  /* y: git overwrites them, as asked */
  m = marked();
  await keys('O h');
  await asked('Hard reset main to (HEAD): ');
  await answer('HEAD~1');
  await question(`Hard reset main to ${short(work, tracked)} tracked, discarding every uncommitted change to tracked files, and overwriting 2 untracked files d/y.txt, x.txt?`);
  await keys('y');
  await done(m);
  assert.equal(rev(work, 'HEAD'), tracked);
  assert.equal(read(path.join(work, 'x.txt')), 'old x\n');
  /* the fixture as the next test expects it */
  git(work, 'reset', '-q', '--hard', start);
});

test('O h names the untracked files a hard reset overwrites where a file and a directory change places', async () => {
  const start = rev(work, 'HEAD');
  /* each case: the commit it resets to, then the work tree's precious data; the question's tail; what is lost */
  const ask = async (to: string, subject: string, tail: string) => {
    await status();
    goTo('');
    const n = proc.calls.length, m = marked();
    await keys('O h');
    await asked('Hard reset main to (HEAD): ');
    await answer(to);
    await question(`Hard reset main to ${short(work, to)} ${subject}, discarding every uncommitted change to tracked files${tail}?`);
    await keys('n');
    await done(m);
    assert.equal(lastMessage(), 'Nothing reset');
    assert.deepEqual(writes(n), []);
  };
  const yes = async (to: string, subject: string, tail: string) => {
    const m = marked();
    await keys('O h');
    await asked('Hard reset main to (HEAD): ');
    await answer(to);
    await question(`Hard reset main to ${short(work, to)} ${subject}, discarding every uncommitted change to tracked files${tail}?`);
    await keys('y');
    await done(m);
  };
  const clean = () => { git(work, 'reset', '-q', '--hard', start); for (const p of ['d', 'x']) fs.rmSync(path.join(work, p), { recursive: true, force: true }); };
  /* A: the target tracks d/f, the work tree has an untracked file d */
  write(path.join(work, 'd', 'f'), 'f\n');
  git(work, 'add', 'd/f'); git(work, 'commit', '-q', '-m', 'dir');
  const dir = rev(work, 'HEAD');
  git(work, 'rm', '-q', '-r', '--cached', 'd'); git(work, 'commit', '-q', '-m', 'none');
  fs.rmSync(path.join(work, 'd'), { recursive: true }); write(path.join(work, 'd'), 'precious\n');
  await ask(dir, 'dir', ', and overwriting the untracked file d');
  assert.equal(read(path.join(work, 'd')), 'precious\n');
  clean();
  /* B: the target tracks the file x, the work tree has an untracked directory x/ with files */
  write(path.join(work, 'x'), 'x\n');
  git(work, 'add', 'x'); git(work, 'commit', '-q', '-m', 'file');
  const file = rev(work, 'HEAD');
  git(work, 'rm', '-q', '--cached', 'x'); git(work, 'commit', '-q', '-m', 'none');
  fs.rmSync(path.join(work, 'x')); write(path.join(work, 'x', 'p'), 'precious\n');
  await ask(file, 'file', ', and overwriting the untracked directory x/');
  assert.equal(read(path.join(work, 'x', 'p')), 'precious\n');
  /* an empty directory there holds nothing to lose: not named */
  fs.rmSync(path.join(work, 'x', 'p'));
  await ask(file, 'file', '');
  clean();
  /* C: the index and the target track d/f, the work tree has an untracked file d in its place; y loses it */
  write(path.join(work, 'd', 'f'), 'f\n');
  git(work, 'add', 'd/f'); git(work, 'commit', '-q', '-m', 'dir');
  const dirC = rev(work, 'HEAD');
  fs.rmSync(path.join(work, 'd'), { recursive: true }); write(path.join(work, 'd'), 'precious\n');
  await ask('HEAD', 'dir', ', and overwriting the untracked file d');
  assert.equal(read(path.join(work, 'd')), 'precious\n');
  await yes('HEAD', 'dir', ', and overwriting the untracked file d');
  assert.equal(rev(work, 'HEAD'), dirC);
  assert.equal(read(path.join(work, 'd', 'f')), 'f\n', 'd is the directory again, the untracked file gone');
  clean();
  /* D: the index and the target track the file x, the work tree has a directory x/ in its place (git's
     --directory lists nothing there); y loses x/p and x/q */
  write(path.join(work, 'x'), 'x\n');
  git(work, 'add', 'x'); git(work, 'commit', '-q', '-m', 'file');
  fs.rmSync(path.join(work, 'x')); write(path.join(work, 'x', 'p'), 'precious\n'); write(path.join(work, 'x', 'q'), 'precious\n');
  await ask('HEAD', 'file', ', and overwriting 2 untracked files x/p, x/q');
  assert.equal(read(path.join(work, 'x', 'p')), 'precious\n');
  await yes('HEAD', 'file', ', and overwriting 2 untracked files x/p, x/q');
  assert.equal(read(path.join(work, 'x')), 'x\n', 'x is the file again, x/p and x/q gone');
  clean();
  assert.deepEqual(porcelain(work), []);
});

test('O h names whole a nested repository, and a directory whose name is not UTF-8, that a hard reset overwrites', async () => {
  const start = rev(work, 'HEAD');
  const ask = async (to: string, tail: string) => {
    await status();
    goTo('');
    const n = proc.calls.length, m = marked();
    await keys('O h');
    await asked('Hard reset main to (HEAD): ');
    await answer(to);
    await question(`Hard reset main to ${short(work, to)} dir, discarding every uncommitted change to tracked files${tail}?`);
    await keys('n');
    await done(m);
    assert.equal(lastMessage(), 'Nothing reset');
    assert.deepEqual(writes(n), []);
  };
  /* the target tracks sub/file; sub/ is now a repository of its own, which ls-files lists as a directory and
     never looks into, holding an untracked sub/file the reset overwrites */
  write(path.join(work, 'sub', 'file'), 'f\n');
  git(work, 'add', 'sub/file'); git(work, 'commit', '-q', '-m', 'dir');
  const dir = rev(work, 'HEAD');
  git(work, 'rm', '-q', '-r', '--cached', 'sub'); git(work, 'commit', '-q', '-m', 'none');
  git(path.join(work, 'sub'), 'init', '-q');
  write(path.join(work, 'sub', 'file'), 'precious\n');
  await ask(dir, ', and overwriting the untracked directory sub/');
  assert.equal(read(path.join(work, 'sub', 'file')), 'precious\n');
  git(work, 'reset', '-q', '--hard', start); fs.rmSync(path.join(work, 'sub'), { recursive: true, force: true });
  /* the target tracks a file in a directory named by a byte that is not UTF-8 (read as U+FFFD, a name git would
     not know again); the directory, wholly untracked, is named whole */
  const bad = Buffer.concat([Buffer.from(work + path.sep), Buffer.from([0xff])]), badFile = Buffer.concat([bad, Buffer.from('/p')]);
  fs.mkdirSync(bad); fs.writeFileSync(badFile, 'f\n');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'dir');
  const bytes = rev(work, 'HEAD');
  git(work, 'read-tree', 'HEAD~1'); git(work, 'commit', '-q', '-m', 'none');   // the index without it, the file left in the work tree
  fs.writeFileSync(badFile, 'precious\n');
  await ask(bytes, ', and overwriting the untracked directory �/');
  assert.equal(fs.readFileSync(badFile, 'utf8'), 'precious\n');
  git(work, 'reset', '-q', '--hard', start); fs.rmSync(bad, { recursive: true, force: true });
  assert.deepEqual(porcelain(work), []);
});

test('z z and z i stash; z a applies the stash at point with its index; z p with a conflict keeps the stash and says where', async () => {
  write(path.join(work, 'a.txt'), 'staged\n');
  git(work, 'add', 'a.txt');
  write(path.join(work, 'c.txt'), 'unstaged\n');
  await status();
  let m = marked();
  await keys('z z');
  await asked('Stash message: ');
  await answer('both');
  await done(m);
  assert.equal(lastMessage(), 'Saved working directory and index state On main: both');
  assert.deepEqual(stashes(work), ['stash@{0} On main: both']);
  assert.deepEqual(porcelain(work), []);
  assert.deepEqual(argvOf('stash'), ['stash', 'push', '--message=both', '--']);
  /* nothing left to stash */
  m = marked();
  await keys('z z');
  await asked('Stash message: ');
  await answer('');
  await done(m);
  assert.equal(lastMessage(), 'No local changes to save');
  /* z a on the stash's line: both changes back, a.txt staged again; the stash kept */
  await keys('g r');
  const sline = lines().find(l => l.startsWith('Stashes'))!;
  goTo(sline);
  await keys('TAB');
  goTo('stash@{0} On main: both');
  m = marked();
  await keys('z a');
  await done(m);
  assert.equal(lastMessage(), 'stash@{0} applied');
  assert.deepEqual(porcelain(work), ['M  a.txt', ' M c.txt']);
  assert.deepEqual(stashes(work), ['stash@{0} On main: both']);
  /* z i: the staged change alone */
  m = marked();
  await keys('z i');
  await asked('Stash the staged changes, message: ');
  await answer('index');
  await done(m);
  assert.deepEqual(stashes(work), ['stash@{0} On main: index', 'stash@{1} On main: both']);
  assert.deepEqual(porcelain(work), [' M c.txt']);
  git(work, 'checkout', '-q', '--', 'c.txt');
  /* a stash line whose name now stands for another stash (as after a push or drop elsewhere, made so here by its
     recorded commit): refused, nothing popped */
  await until(() => !proc.running().length, 'the refresh');
  const b = E.current, row = b.gitView.rows.find((r: { stash?: unknown }) => r.stash);
  assert.ok(row, 'a stash line');
  row.stash = { ...row.stash, oid: '0'.repeat(40) };
  b.pt = Ed.lineStartB(b, b.gitView.rows.indexOf(row) + 1); m = marked(); await keys('z p'); await done(m); assert.match(lastMessage(), /^The stashes changed since stash@\{\d\} was shown: g r reads them again$/);
  /* z p of stash@{1} ("both") with a.txt changed and committed since: a conflict, the stash kept */
  write(path.join(work, 'a.txt'), 'conflicting\n');
  git(work, 'commit', '-q', '-am', 'fourth');
  await keys('g r');
  goTo(lines()[0]);
  const n = proc.calls.length;
  m = marked();
  await keys('z p');
  await asked('Pop stash (stash@{0}): ');
  await answer('stash@{1}');
  await done(m);
  assert.equal(lastMessage(), 'stash@{1} applied with conflicts in a.txt: resolve them and stage them (s); the stash is kept (z k drops it)');
  assert.deepEqual(stashes(work), ['stash@{0} On main: index', 'stash@{1} On main: both'], 'the stash kept');
  assert.ok(porcelain(work).includes('UU a.txt'), porcelain(work).join('\n'));
  assert.ok(lines().includes('Unmerged paths (1)'), 'the conflict shown');
  assert.deepEqual(writes(n).filter(s => s === 'stash'), ['stash', 'stash'], 'with --index, then without');
  /* the conflict left: z p and z z refused with its file named, before any write (git would say only `could not
     write index`) */
  const k = proc.calls.length;
  m = marked();
  await keys('z p');
  await asked('Pop stash (stash@{0}): ');
  await keys('RET');
  await done(m);
  assert.equal(lastMessage(), 'stash@{0} not popped: a.txt is in conflict; resolve and stage it (s) first');
  m = marked();
  await keys('z z');
  await done(m);
  assert.equal(lastMessage(), 'Nothing stashed: a.txt is in conflict; resolve and stage it (s) first');
  assert.deepEqual(writes(k), [], 'no write ran');
  assert.deepEqual(stashes(work), ['stash@{0} On main: index', 'stash@{1} On main: both']);
  git(work, 'reset', '-q', '--hard');
});

test('z p with local changes in the way: refused, nothing changed; z k drops after asking', async () => {
  write(path.join(work, 'a.txt'), 'in the way\n');
  await status();
  let m = marked();
  await keys('z p');
  await asked('Pop stash (stash@{0}): ');
  await keys('RET');
  await done(m);
  assert.equal(lastMessage(), 'stash@{0} not popped: your local changes to a.txt would be overwritten; commit or stash them (z z) first');
  assert.equal(stashes(work).length, 2);
  assert.equal(read(path.join(work, 'a.txt')), 'in the way\n');
  /* a.txt staged: refused before any write (git's --index would fail and unstage it, `Index was not unstashed`) */
  git(work, 'add', 'a.txt');
  const k = proc.calls.length;
  m = marked();
  await keys('z p');
  await asked('Pop stash (stash@{0}): ');
  await keys('RET');
  await done(m);
  assert.equal(lastMessage(), 'stash@{0} not popped: a.txt is staged, and git would unstage it; commit, unstage (u) or stash (z z) it first');
  assert.deepEqual(writes(k), [], 'no write ran');
  assert.deepEqual(porcelain(work), ['M  a.txt'], 'still staged');
  assert.equal(stashes(work).length, 2);
  git(work, 'reset', '-q', '--hard');
  /* a stash without staged changes (c.txt changed, nothing staged) popped over a staged a.txt: git's --index
     applies it, and a.txt stays staged, so Edwin does not refuse */
  write(path.join(work, 'c.txt'), 'plain\n');
  git(work, 'stash', 'push', '-q', '--message=plain');
  write(path.join(work, 'a.txt'), 'staged meanwhile\n');
  git(work, 'add', 'a.txt');
  await keys('g r');
  const k2 = proc.calls.length;
  m = marked();
  await keys('z p');
  await asked('Pop stash (stash@{0}): ');
  await keys('RET');
  await done(m);
  assert.equal(lastMessage(), 'stash@{0} popped');
  assert.deepEqual(writes(k2), ['stash'], 'one write, with --index');
  assert.deepEqual(argvOf('pop'), ['pop', '--index', 'stash@{0}']);
  assert.deepEqual(porcelain(work), ['M  a.txt', ' M c.txt'], 'a.txt still staged, c.txt back unstaged');
  assert.equal(read(path.join(work, 'c.txt')), 'plain\n');
  assert.deepEqual(stashes(work), ['stash@{0} On main: index', 'stash@{1} On main: both'], 'the plain stash dropped');
  git(work, 'reset', '-q', '--hard');
  /* a stash of a staged c.txt, then a.txt staged after that check, just before git runs: git's own refusal (its
     files indented by two spaces, `Index was not unstashed.`) is said with the file named, and that git unstaged
     it; the stash kept */
  write(path.join(work, 'c.txt'), 'stashed\n');
  git(work, 'add', 'c.txt');
  git(work, 'stash', 'push', '-q', '--message=race');
  write(path.join(work, 'a.txt'), 'raced\n');
  await keys('g r');
  const spawn = proc.spawn;
  proc.spawn = (argv, opts, on) => {
    if (argv.includes('stash') && argv.includes('--index')) git(work, 'add', 'a.txt');
    return spawn(argv, opts, on);
  };
  try {
    m = marked();
    await keys('z p');
    await asked('Pop stash (stash@{0}): ');
    await keys('RET');
    await done(m);
  } finally { proc.spawn = spawn; }
  assert.equal(lastMessage(), 'process-error: stash@{0} not popped: your local changes to a.txt would be overwritten; commit or stash them (z z) first; git unstaged the staged changes (see *vc-process*)');
  assert.deepEqual(porcelain(work), [' M a.txt'], 'unstaged by git, as said');
  assert.equal(stashes(work)[0], 'stash@{0} On main: race');
  git(work, 'stash', 'drop', '-q');
  git(work, 'reset', '-q', '--hard');
  m = marked();
  await keys('z k');
  await asked('Drop stash (stash@{0}): ');
  await keys('RET');
  await question('Drop stash@{0} On main: index?');
  await keys('n');
  await done(m);
  assert.equal(lastMessage(), 'Nothing dropped');
  assert.equal(stashes(work).length, 2);
  m = marked();
  await keys('z k');
  await asked('Drop stash (stash@{0}): ');
  await answer('stash@{1}');
  /* a stash pushed elsewhere while the question is open: stash@{1} is now another stash, and nothing is dropped */
  await question('Drop stash@{1} On main: both?');
  write(path.join(work, 'c.txt'), 'intruder\n');
  git(work, 'stash', 'push', '-q', '--message=intruder');
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), 'The stashes changed since stash@{1} was shown: g r reads them again');
  assert.deepEqual(stashes(work), ['stash@{0} On main: intruder', 'stash@{1} On main: index', 'stash@{2} On main: both']);
  git(work, 'stash', 'drop', '-q');
  m = marked();
  await keys('z k');
  await asked('Drop stash (stash@{0}): ');
  await answer('stash@{1}');
  await question('Drop stash@{1} On main: both?');
  await keys('y');
  await done(m);
  assert.match(lastMessage(), /^Dropped stash@\{1\} \([0-9a-f]+\)$/);
  assert.deepEqual(stashes(work), ['stash@{0} On main: index']);
  /* a stash pushed and popped cleanly */
  write(path.join(work, 'c.txt'), 'popped\n');
  m = marked();
  await keys('z z'); await asked('Stash message: '); await answer('pop me'); await done(m);
  m = marked();
  await keys('z p'); await asked('Pop stash (stash@{0}): '); await keys('RET'); await done(m);
  assert.equal(lastMessage(), 'stash@{0} popped');
  assert.deepEqual(porcelain(work), [' M c.txt']);
  assert.deepEqual(stashes(work), ['stash@{0} On main: index']);
  git(work, 'checkout', '-q', '--', 'c.txt');
});

test('t t tags the commit at point, lightweight and never signed; t x deletes after asking', async () => {
  /* a repository that asks for signed tags, with a gpg program that leaves a marker */
  const marker = path.join(root, 'gpg-ran'), gpg = path.join(root, 'gpg.sh');
  write(gpg, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); fs.chmodSync(gpg, 0o755);
  git(work, 'config', 'tag.gpgSign', 'true'); git(work, 'config', 'gpg.program', gpg);
  await status();
  goTo(lines().find(l => l.startsWith(FIRST + ' '))!);
  let m = marked();
  await keys('t t');
  await asked('Tag name: ');
  await answer('v1');
  await asked(`Tag v1 at (${FIRST}): `);
  await keys('RET');
  await done(m);
  assert.equal(lastMessage(), `Tag v1 at ${FIRST} first`);
  assert.equal(rev(work, 'v1'), rev(work, FIRST));
  assert.equal(git(work, 'cat-file', '-t', 'v1').trim(), 'commit', 'lightweight');
  assert.equal(fs.existsSync(marker), false, 'no signature program ran');
  m = marked();
  await keys('t t');
  await asked('Tag name: ');
  await answer('-d');
  await done(m);
  assert.equal(lastMessage(), 'Not a valid tag name: -d');
  m = marked();
  await keys('t x');
  await asked('Delete tag: ');
  await answer('v1');
  await question('Delete tag v1?');
  await keys('n');
  await done(m);
  assert.deepEqual(tags(work), ['v1']);
  m = marked();
  await keys('t x');
  await asked('Delete tag: ');
  await answer('v1');
  await question('Delete tag v1?');
  await keys('y');
  await done(m);
  assert.match(lastMessage(), /^Deleted tag 'v1' \(was [0-9a-f]+\)$/);
  assert.deepEqual(tags(work), []);
  git(work, 'config', '--unset', 'tag.gpgSign'); git(work, 'config', '--unset', 'gpg.program');
});

test('refused: a jj workspace, and every operation under the image\'s replay, no child started', async () => {
  const jj = mkdir('jj');
  execFileSync('jj', ['git', 'init'], { cwd: jj, stdio: 'ignore' });
  visit(path.join(jj, 'f.txt'));
  const n = proc.calls.length;
  await keys('M-x'); await ed.type('git-checkout\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /is a jj workspace: jj has its own commands/);
  assert.equal(proc.calls.length, n, 'nothing ran');
  await status();
  const k = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  const all = ['git-checkout', 'git-branch-create', 'git-branch-new', 'git-branch-delete', 'git-branch-rename', 'git-reset-soft', 'git-reset-mixed', 'git-reset-hard',
    'git-stash', 'git-stash-index', 'git-stash-apply', 'git-stash-pop', 'git-stash-drop', 'git-tag-create', 'git-tag-delete'];
  Ed.proc.replay(() => { for (const c of all) { try { ps.push(Promise.resolve(L(c))); } catch (e) { ps.push(Promise.reject(e)); } } });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, k, 'no child started');
});
