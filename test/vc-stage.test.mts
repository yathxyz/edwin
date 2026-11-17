// Staging, unstaging and discarding in git's status buffer (src/vc-git.ts: s, u and x) in the headless runtime,
// with real git from PATH through Ed.proc over fake-proc.mts's host.proc, in throwaway repositories under a
// throwaway HOME; host.files.tree is node:fs, as host-native.ts has it. After each action the index (`git show
// :PATH`) or the work tree is compared with the text it must hold.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-stage.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-stage-')));
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
  write() { throw new Error('not here'); }, remove() { throw new Error('not here'); }, list: () => [] as string[], cwd: root,
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
/* What the index holds for P ('' when it holds nothing), and its blob's id, which must be git's own for TEXT. */
const indexed = (cwd: string, p: string) => git(cwd, 'show', ':' + p);
const assertIndex = (cwd: string, p: string, text: string, why?: string) => {
  assert.equal(indexed(cwd, p), text, why);
  const blob = execFileSync('git', ['hash-object', '--stdin'], { cwd, input: text, encoding: 'utf8' }).trim();
  assert.equal(git(cwd, 'rev-parse', ':' + p).trim(), blob, why);
};
const inIndex = (cwd: string) => git(cwd, 'ls-files', '--cached').split('\n').filter(l => l).sort();

const from = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-stage test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
/* The file heading's line unfolded (its hunks shown): TAB on a folded one. */
const unfold = async (heading: string) => { if (lines().includes(heading + '…')) { goTo(heading + '…'); await keys('TAB'); } lineOf(heading); };

/* ---------- the fixture ---------- */
const N = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
const text = (ls: string[]) => ls.join('\n') + '\n';
const with_ = (changes: Record<number, string>) => text(N.map((l, i) => changes[i + 1] ?? l));
const work = mkdir('work');
git(work, 'init', '-q', '-b', 'main');
write(path.join(work, 'a.txt'), text(N));
write(path.join(work, 'b.txt'), 'b\n');
write(path.join(work, 'old.txt'), 'renamed whole\n');
write(path.join(work, 'ws.txt'), 'w\n');
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'first');
/* a.txt: two hunks, far apart; the second changes two lines */
const A = with_({ 2: 'L2', 17: 'L17', 18: 'L18' });
write(path.join(work, 'a.txt'), A);
write(path.join(work, 'b.txt'), 'B\n');
git(work, 'mv', 'old.txt', 'new.txt');
write(path.join(work, 'u.txt'), 'u\n');
write(path.join(work, 'star*.txt'), 'literal\n');
write(path.join(work, 'starX.txt'), 'not matched\n');
write(path.join(work, 'dir/x.txt'), 'x\n');

test('s stages a hunk and u unstages it: the index holds that hunk\'s change alone', async () => {
  from(path.join(work, 'a.txt'));
  await keys('SPC g g');
  assert.equal(E.current.mode, 'git-status-mode');
  await unfold('modified   a.txt');
  goTo('+L2');
  await keys('s');
  assertIndex(work, 'a.txt', with_({ 2: 'L2' }));
  assert.equal(read(path.join(work, 'a.txt')), A, 'the work tree is left');
  assert.match(E.current.text, /^Staged changes \(2\)$/m, 'read again');
  /* the staged hunk, under the staged a.txt */
  const at = lines().lastIndexOf('modified   a.txt…') + 1;
  assert.ok(at > lineOf('Staged changes (2)'));
  E.current.pt = Ed.lineStartB(E.current, at);
  await keys('TAB');
  goTo('@@ -1,5 +1,5 @@');
  await keys('u');
  assertIndex(work, 'a.txt', text(N), 'unstaged: the index as HEAD');
  /* all a.txt's hunks were picked by apply: only git apply, with the whitespace settings neutral, wrote */
  const applies = proc.calls.filter(c => c.argv.includes('apply'));
  assert.equal(applies.length, 2);
  for (const c of applies) {
    assert.ok(c.argv.includes('--cached') && c.argv.includes('--whitespace=nowarn') && c.argv.includes('--no-ignore-whitespace'), c.argv.join(' '));
    assert.ok(c.argv.includes('core.hooksPath=/dev/null'), 'no hook');
  }
});

test('in Visual state s and u take the changed lines selected within one hunk', async () => {
  await unfold('modified   a.txt');
  /* the second hunk: -l17 -l18 +L17 +L18; select -l18 and +L17 ... no: -l18 and +L18 */
  const hunk = lines().slice(lineOf('modified   a.txt'));
  assert.ok(hunk.includes('-l18') && hunk.includes('+L18'), E.current.text);
  goTo('-l17');
  await keys('V j');
  assert.equal(E.current.evilState, 'visual');
  await keys('s');
  assert.equal(E.current.evilState, 'motion', 'Visual state left');
  /* -l17 and -l18 picked, +L17 and +L18 not: both lines removed in the index */
  assertIndex(work, 'a.txt', text(N.filter(l => l !== 'l17' && l !== 'l18')));
  /* back, by the staged hunk's lines */
  const at = lines().lastIndexOf('modified   a.txt…') + 1;
  E.current.pt = Ed.lineStartB(E.current, at);
  await keys('TAB');
  const staged = lines().lastIndexOf('-l17') + 1;
  E.current.pt = Ed.lineStartB(E.current, staged);
  await keys('V');
  await keys('u');
  assertIndex(work, 'a.txt', text(N.filter(l => l !== 'l18')), 'only -l17 unstaged');
  E.current.pt = Ed.lineStartB(E.current, lines().lastIndexOf('-l18') + 1);
  await keys('u');
  assertIndex(work, 'a.txt', text(N), 'u on a line without a selection: its whole hunk');
  /* now +L18 alone: l18 stays as context, L18 added after it */
  goTo('+L18');
  await keys('V s');
  assertIndex(work, 'a.txt', text([...N.slice(0, 18), 'L18', ...N.slice(18)]));
  git(work, 'reset', '-q', '--', 'a.txt');
  await keys('g r');
  /* a selection across two hunks, or of context only, is refused or does nothing */
  await unfold('modified   a.txt');
  goTo('+L2');
  const before = git(work, 'ls-files', '-s');
  E.current.pt = Ed.lineStartB(E.current, lineOf('+L2'));
  await keys('V');
  E.current.pt = Ed.lineStartB(E.current, lineOf('+L17'));
  await keys('s');
  assert.equal(lastMessage(), 'The selection must lie within one hunk');
  assert.equal(E.current.evilState, 'motion');
  goTo(' l3');
  await keys('V s');
  assert.equal(lastMessage(), 'No change selected');
  assert.equal(git(work, 'ls-files', '-s'), before, 'the index is as it was');
});

test('s and u on a file, a rename, a part\'s heading; untracked names are literal pathspecs', async () => {
  goTo('modified   b.txt…');
  await keys('s');
  assertIndex(work, 'b.txt', 'B\n');
  goTo('Staged changes (2)');
  const b = lines().slice(lineOf('Staged changes (2)'));
  assert.ok(b.includes('modified   b.txt…') && b.includes('renamed    old.txt -> new.txt'), E.current.text);
  /* the rename unstaged: old.txt back in the index, new.txt out of it */
  goTo('renamed    old.txt -> new.txt');
  await keys('u');
  assert.deepEqual(inIndex(work), ['a.txt', 'b.txt', 'old.txt', 'ws.txt']);
  assertIndex(work, 'old.txt', 'renamed whole\n');
  assert.ok(lines().includes('new.txt') && lines().includes('deleted    old.txt…'), E.current.text);
  /* untracked star*.txt staged: not starX.txt */
  goTo('star*.txt');
  await keys('s');
  assert.deepEqual(inIndex(work), ['a.txt', 'b.txt', 'old.txt', 'star*.txt', 'ws.txt']);
  /* the Untracked heading: all of them, a directory's files too */
  goTo('Untracked files (4)');
  await keys('s');
  assert.deepEqual(inIndex(work), ['a.txt', 'b.txt', 'dir/x.txt', 'new.txt', 'old.txt', 'star*.txt', 'starX.txt', 'u.txt', 'ws.txt']);
  /* the Staged heading: everything unstaged */
  goTo(lines().find(l => l.startsWith('Staged changes'))!);
  await keys('u');
  assert.deepEqual(inIndex(work), ['a.txt', 'b.txt', 'old.txt', 'ws.txt']);
  assertIndex(work, 'b.txt', 'b\n');
  assert.ok(!E.current.text.includes('Staged changes'));
  /* the Unstaged heading: every tracked change, the deletion of old.txt too */
  goTo(lines().find(l => l.startsWith('Unstaged changes'))!);
  await keys('s');
  assert.deepEqual(inIndex(work), ['a.txt', 'b.txt', 'ws.txt']);
  assertIndex(work, 'a.txt', A);
  /* s on a staged line, u on an unstaged one: said, nothing done */
  goTo(lines().find(l => l.startsWith('Staged changes'))!);
  await keys('s');
  assert.equal(lastMessage(), 'Already staged');
  git(work, 'reset', '-q');
  await keys('g r');
  const index = git(work, 'ls-files', '-s');
  goTo('modified   b.txt…');
  await keys('u');
  assert.equal(lastMessage(), 'Not staged');
  goTo('Head:     main first');
  await keys('s');
  assert.equal(lastMessage(), 'Nothing to stage here');
  assert.equal(git(work, 'ls-files', '-s'), index);
});


test('x asks first: n keeps everything; y discards an unstaged hunk, lines, a file, a deletion, untracked files', async () => {
  await unfold('modified   a.txt');
  goTo('+L2');
  const n = proc.calls.length;
  await keys('x');
  assert.equal(E.prompt, 'Discard this hunk of a.txt? (y or n) ');
  await keys('n');
  assert.equal(lastMessage(), 'Nothing discarded');
  assert.equal(read(path.join(work, 'a.txt')), A, 'n: the work tree as it was');
  const reads = ['status', 'diff', 'log', 'config', 'rev-parse', 'grep'];
  assert.equal(proc.calls.filter((c, i) => i >= n && !reads.some(s => c.argv.includes(s))).length, 0, 'n: no write ran');
  goTo('+L2');
  await keys('x');
  await keys('y');
  assert.equal(read(path.join(work, 'a.txt')), with_({ 17: 'L17', 18: 'L18' }), 'y: that hunk gone from the work tree');
  assertIndex(work, 'a.txt', text(N), 'the index untouched');
  /* lines: +L18 alone; -l18 not picked goes as well (the line stays as the work tree has it: removed) */
  await unfold('modified   a.txt');
  goTo('+L18');
  await keys('V x');
  assert.equal(E.prompt, 'Discard the selected lines of a.txt? (y or n) ');
  await keys('y');
  assert.equal(read(path.join(work, 'a.txt')), text(N.map(l => (l === 'l17' ? 'L17' : l)).filter(l => l !== 'l18')));
  /* a whole file: as the index has it */
  goTo('modified   b.txt…');
  await keys('x y');
  assert.equal(read(path.join(work, 'b.txt')), 'b\n');
  goTo('deleted    old.txt…');
  await keys('x y');
  assert.equal(read(path.join(work, 'old.txt')), 'renamed whole\n', 'a deletion undone');
  /* untracked: a file, by its literal name, and a directory */
  goTo('star*.txt');
  await keys('x');
  assert.equal(E.prompt, 'Delete untracked star*.txt? (y or n) ');
  await keys('y');
  assert.equal(fs.existsSync(path.join(work, 'star*.txt')), false);
  assert.equal(fs.existsSync(path.join(work, 'starX.txt')), true, 'only the file named');
  goTo('dir/');
  await keys('x y');
  assert.equal(fs.existsSync(path.join(work, 'dir')), false);
  assert.deepEqual(lines().slice(lineOf('Untracked files (3)'), lineOf('Untracked files (3)') + 3), ['new.txt', 'starX.txt', 'u.txt']);
  goTo('Untracked files (3)');
  await keys('x y');
  for (const f of ['new.txt', 'starX.txt', 'u.txt']) assert.equal(fs.existsSync(path.join(work, f)), false, f);
  assert.equal(git(work, 'status', '--porcelain'), ' M a.txt\n');
});

test('x on staged changes takes them out of the index and the work tree; refused where the work tree differs', async () => {
  goTo('modified   a.txt');
  await keys('s');
  assertIndex(work, 'a.txt', read(path.join(work, 'a.txt')));
  const at = lines().indexOf('modified   a.txt…') + 1;
  E.current.pt = Ed.lineStartB(E.current, at);
  await keys('TAB');
  goTo('+L17');
  await keys('x y');
  assertIndex(work, 'a.txt', text(N), 'the hunk out of the index: as HEAD');
  assert.equal(read(path.join(work, 'a.txt')), text(N), 'and out of the work tree');
  /* the work tree has more of b.txt than the index: refused, nothing changed */
  write(path.join(work, 'b.txt'), 'B\n'); git(work, 'add', 'b.txt'); write(path.join(work, 'b.txt'), 'BB\n');
  await keys('g r');
  const lastStaged = (s: string) => { E.current.pt = Ed.lineStartB(E.current, lines().lastIndexOf(s) + 1); };
  lastStaged('modified   b.txt…');
  assert.ok(Ed.lineNoB(E.current, E.current.pt) > lineOf(lines().find(l => l.startsWith('Staged changes'))!));
  await keys('x y');
  assert.match(lastMessage(), /git apply failed \(exit 1\): see \*vc-process\*/);
  assertIndex(work, 'b.txt', 'B\n');
  assert.equal(read(path.join(work, 'b.txt')), 'BB\n');
  /* a new file staged, discarded: gone from both */
  write(path.join(work, 'b.txt'), 'b\n'); git(work, 'add', 'b.txt');
  write(path.join(work, 'fresh.txt'), 'fresh\n'); git(work, 'add', 'fresh.txt');
  await keys('g r');
  goTo('new file   fresh.txt…');
  await keys('x y');
  assert.equal(fs.existsSync(path.join(work, 'fresh.txt')), false);
  assert.ok(!inIndex(work).includes('fresh.txt'));
  /* x on a staged rename's heading: both names back */
  git(work, 'mv', 'old.txt', 'new.txt');
  await keys('g r');
  goTo('renamed    old.txt -> new.txt');
  await keys('x y');
  assert.equal(read(path.join(work, 'old.txt')), 'renamed whole\n');
  assert.equal(fs.existsSync(path.join(work, 'new.txt')), false);
  git(work, 'checkout', '-q', '--', '.');
  assert.equal(git(work, 'status', '--porcelain'), '');
});

test('a conflict: s marks it resolved, x refuses; an unborn branch stages and unstages', async () => {
  const cf = mkdir('conflict');
  git(cf, 'init', '-q', '-b', 'main');
  write(path.join(cf, 'c.txt'), 'base\n'); git(cf, 'add', '.'); git(cf, 'commit', '-q', '-m', 'base');
  git(cf, 'checkout', '-q', '-b', 'side'); write(path.join(cf, 'c.txt'), 'side\n'); git(cf, 'commit', '-q', '-am', 'side');
  git(cf, 'checkout', '-q', 'main'); write(path.join(cf, 'c.txt'), 'main\n'); git(cf, 'commit', '-q', '-am', 'main');
  git(cf, 'merge', '-q', 'side');
  from(path.join(cf, 'c.txt'));
  await keys('SPC g g');
  goTo('both modified c.txt');
  await keys('x');
  assert.match(lastMessage(), /A conflict is not discarded here/);
  assert.equal(E.current.mode, 'git-status-mode', 'no question asked');
  write(path.join(cf, 'c.txt'), 'resolved\n');
  await keys('u');
  assert.equal(lastMessage(), 'Not staged');
  await keys('s');
  assert.equal(git(cf, 'ls-files', '-u'), '', 'no conflict left');
  assertIndex(cf, 'c.txt', 'resolved\n');

  const fresh = mkdir('fresh');
  git(fresh, 'init', '-q', '-b', 'trunk');
  write(path.join(fresh, 'f.txt'), 'one\ntwo\n');
  from(path.join(fresh, 'f.txt'));
  await keys('SPC g g');
  goTo('f.txt');
  await keys('s');
  assertIndex(fresh, 'f.txt', 'one\ntwo\n');
  goTo('new file   f.txt…');
  await keys('u');
  assert.deepEqual(inIndex(fresh), [], 'unstaged with no commit yet');
  assert.equal(E.current.text, 'Head:     trunk (no commit yet)\n\nUntracked files (1)\nf.txt\n');
});

test('the repository\'s apply.whitespace and apply.ignoreWhitespace do not change what is staged', async () => {
  const ws = mkdir('ws');
  git(ws, 'init', '-q', '-b', 'main');
  write(path.join(ws, 'w.txt'), 'a  b\nkeep\n'); git(ws, 'add', '.'); git(ws, 'commit', '-q', '-m', 'w');
  git(ws, 'config', 'apply.whitespace', 'fix'); git(ws, 'config', 'apply.ignoreWhitespace', 'change');
  write(path.join(ws, 'w.txt'), 'a  b\nkeep\ntrailing  \n');
  from(path.join(ws, 'w.txt'));
  await keys('SPC g g');
  await unfold('modified   w.txt');
  goTo('+trailing  ');
  await keys('s');
  assertIndex(ws, 'w.txt', 'a  b\nkeep\ntrailing  \n', 'the trailing white space kept');
  git(ws, 'config', 'apply.whitespace', 'error');
  write(path.join(ws, 'w.txt'), 'a  b\nkeep\ntrailing  \nmore \n');
  await keys('g r');
  await unfold('modified   w.txt');
  goTo('+more ');
  await keys('s');
  assertIndex(ws, 'w.txt', 'a  b\nkeep\ntrailing  \nmore \n');
});

test('refused: a name that is not UTF-8, under the image\'s replay', async () => {
  const odd = mkdir('odd');
  git(odd, 'init', '-q', '-b', 'main');
  fs.writeFileSync(Buffer.concat([Buffer.from(odd + '/caf'), Buffer.from([0xe9]), Buffer.from('.txt')]), 'x\n');
  from(path.join(odd, 'x'));
  await keys('SPC g g');
  goTo('caf�.txt');
  const n = proc.calls.length;
  await keys('s');
  assert.match(lastMessage(), /caf�\.txt: its name is not UTF-8/);
  assert.equal(proc.calls.slice(n).filter(c => c.argv.includes('add')).length, 0, 'nothing added');
  assert.deepEqual(inIndex(odd), []);
  /* the replay of the image starts nothing */
  const m = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { for (const c of ['git-status-stage', 'git-status-unstage', 'git-status-discard']) ps.push(ed.L.call(c, [])); });
  for (const p of ps) { let e: unknown = null; try { await p; } catch (x) { e = x; } assert.match(String(Ed.errorText(e)), /while the image replays/); }
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, m, 'no child started');
});
