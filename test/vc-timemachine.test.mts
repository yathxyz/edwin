// git's time machine (src/vc-git.ts: SPC g t, git-timemachine) in the headless runtime, with real git from PATH
// through Ed.proc over fake-proc.mts's host.proc, in throwaway repositories under a throwaway HOME; host.files is
// node:fs, as host-native.ts has it. A fixture file of four revisions, renamed in the third, is stepped through,
// each revision compared with what `git show REV:PATH` says of it and point kept on its line.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-timemachine.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-timemachine-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's is read. */
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
/* a commit of everything by AUTHOR at DATE (git's own date format, with its zone) */
const commitAs = (cwd: string, author: string, date: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return git(cwd, 'rev-parse', 'HEAD').trim();
};
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const lineNo = () => Ed.lineNoB(E.current, E.current.pt);
const colNo = () => E.current.pt - Ed.lineStartB(E.current, lineNo());
const goTo = (n: number, col = 0) => { const b = E.current; b.pt = Ed.lineStartB(b, n) + col; };
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
/* Visit FILE alone in one window, point on line LINE at column COL. */
const visit = (file: string, line = 1, col = 0) => {
  L('delete-other-windows');
  L('find-file', file);
  assert.equal(E.current.file, file);
  goTo(line, col);
  return E.current;
};
/* Wait, up to 20 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 5))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}\n${E.current.text.slice(-2000)}`);
  await Ed.whenIdle();
};
/* The time machine buffer showing TEXT, no child left; with OID, the echo area naming that revision too (two revisions
   of the same text cannot be told apart by it). */
const shows = (text: string, oid?: string, b: Edwin = E.current) =>
  until(() => b.text === text && !proc.running().length && (!oid || lastMessage().includes(` at ${oid.slice(0, 8)} (`)), `the revision ${JSON.stringify(text)}`);
/* No child left, and the buffer past its `(reading …)` note. */
const settled = (b: Edwin = E.current) => until(() => !proc.running().length && !/^\(reading /.test(b.text), 'the time machine');
const runs = (sub: string) => proc.calls.filter(c => c.argv.includes(sub));
const tail = (argv: string[], sub: string) => argv.slice(argv.indexOf(sub));

/* ---------- the fixture: f.scm in two revisions, renamed g.scm in the third, changed in the fourth ---------- */
const hist = mkdir('hist');
git(hist, 'init', '-q', '-b', 'main');
write(path.join(hist, 'f.scm'), '(one)\n(two)\n(three)\n(four)\n(five)\n');
const C1 = commitAs(hist, 'Alice', '2026-01-01T00:00:00+0000', 'first');
write(path.join(hist, 'f.scm'), '(one)\n(TWO)\n(3)\n');
write(path.join(hist, 'other.txt'), 'not f\n');
const C2 = commitAs(hist, 'Bob', '2026-02-03T23:30:00-0500', 'second');
git(hist, 'mv', 'f.scm', 'g.scm');
const C3 = commitAs(hist, 'Carol', '2026-03-01T00:00:00+0000', 'rename');
write(path.join(hist, 'other.txt'), 'still not g\n');
commitAs(hist, 'Zed', '2026-03-15T00:00:00+0000', 'unrelated');
write(path.join(hist, 'g.scm'), '(one)\n(TWO)\n(3)\n(four!)\n(five!)\n(six!)\n');
const C4 = commitAs(hist, 'Dave', '2026-04-01T00:00:00+0000', 'fourth');
const G = path.join(hist, 'g.scm');
const at = (oid: string, p: string) => git(hist, 'show', `${oid}:${p}`);
const s8 = (oid: string) => oid.slice(0, 8);

test('SPC g t shows the file\'s newest revision in its window, in the background, in the file\'s mode with git-timemachine-mode on', async () => {
  const src = visit(G, 2, 3);
  assert.equal(ed.L.call('lookup-key', [ed.L.get('evil-normal-state-map'), 'SPC g t']).name, 'git-timemachine');
  const n = proc.calls.length;
  await keys('SPC g t');
  const b = E.current;
  assert.equal(b.name, '*git-timemachine: g.scm*');
  /* the command has ended while git still reads */
  assert.equal(b.text, '(reading the revisions of g.scm…)\n');
  assert.ok(!/on the desktop/.test(lastMessage()), 'the desktop-only stub is gone');
  assert.equal(Ed.windowList().length, 1);
  assert.equal(Ed.windowList()[0].buffer, b);
  await shows(at(C4, 'g.scm'), C4);
  assert.equal(b.mode, src.mode, 'the file\'s major mode');
  assert.equal(b.mode, Ed.modeFor(G));
  assert.notEqual(b.mode, 'fundamental-mode');
  assert.ok(Ed.isLisp(src) && Ed.isLisp(b), 'Scheme\'s faces, as the file has them (the display lexes a Lisp mode\'s buffer)');
  assert.equal(b.file, null, 'the revision visits no file: nothing saves it over the file');
  assert.ok(b.readOnly);
  assert.ok(!b.modified);
  assert.equal(b.evilState, 'normal');
  assert.equal(ed.eval("(minor-mode-active-p 'git-timemachine-mode)"), true);
  /* point on the line and column point was on in the file */
  assert.equal(lineNo(), 2); assert.equal(colNo(), 3);
  assert.equal(lastMessage(), `g.scm at ${s8(C4)} (4 of 4), 2026-04-01, Dave: fourth`);
  /* the revisions read once with the path after -- as a literal pathspec, the newest read by its hash; reads,
     the hooks off */
  const calls = proc.calls.slice(n).filter(c => !c.argv.includes('config'));
  assert.equal(calls.length, 2);
  assert.deepEqual(tail(calls[0].argv, 'log'), ['log', '--no-ext-diff', '--no-textconv', '--submodule=short', '--no-color', '--encoding=UTF-8',
    '--format=%x01%H%x00%an%x00%as%x00%s', '-z', '--name-only', '--follow', '--diff-filter=d', '--diff-merges=first-parent', '--', ':(literal)g.scm']);
  assert.deepEqual(tail(calls[1].argv, 'cat-file'), ['cat-file', 'blob', `${C4}:g.scm`]);
  for (const c of calls) assert.ok(c.argv.includes('core.hooksPath=/dev/null'));
});

test('p steps back through the revisions, across the rename, point kept on its line and column as near as each has them; n steps forward', async () => {
  const b = E.current;
  goTo(5, 4);
  await keys('p');
  await shows(at(C3, 'g.scm'), C3);
  /* three lines: point on the last, `(3)`, at its end (Normal state's last character) */
  assert.equal(lineNo(), 3); assert.equal(colNo(), 2);
  assert.equal(lastMessage(), `g.scm at ${s8(C3)} (3 of 4), 2026-03-01, Carol: rename`);
  goTo(2, 3);
  await keys('p');
  await shows(at(C2, 'f.scm'), C2);
  assert.equal(lineNo(), 2); assert.equal(colNo(), 3);
  assert.equal(lastMessage(), `f.scm at ${s8(C2)} (2 of 4), 2026-02-03, Bob: second`);
  assert.deepEqual(tail(runs('cat-file').at(-1)!.argv, 'cat-file'), ['cat-file', 'blob', `${C2}:f.scm`], 'the file by its name in that commit');
  goTo(1, 3);
  await keys('C-k');
  await shows(at(C1, 'f.scm'), C1);
  assert.equal(lineNo(), 1); assert.equal(colNo(), 3);
  assert.equal(lastMessage(), `f.scm at ${s8(C1)} (1 of 4), 2026-01-01, Alice: first`);
  /* the oldest: p starts nothing */
  let n = proc.calls.length;
  await keys('p');
  assert.equal(lastMessage(), 'This is the oldest revision');
  assert.equal(proc.calls.length, n, 'no child started');
  assert.equal(b.text, at(C1, 'f.scm'));
  /* and forward again: line 5 to the last line of three, `(three)`'s column 5 to the end of `(3)` */
  goTo(3, 5);
  await keys('n');
  await shows(at(C2, 'f.scm'), C2);
  assert.equal(lineNo(), 3); assert.equal(colNo(), 2);
  goTo(2, 4);
  await keys('C-j');
  await shows(at(C3, 'g.scm'), C3);
  await keys('n');
  await shows(at(C4, 'g.scm'), C4);
  assert.equal(lineNo(), 2); assert.equal(colNo(), 4);
  assert.equal(lastMessage(), `g.scm at ${s8(C4)} (4 of 4), 2026-04-01, Dave: fourth`);
  n = proc.calls.length;
  await keys('n');
  assert.equal(lastMessage(), 'This is the newest revision');
  assert.equal(proc.calls.length, n, 'no child started');
  /* n and p are no search and no paste here: the buffer is not changed */
  assert.ok(!b.modified);
  assert.equal(b.text, at(C4, 'g.scm'));
});

test('p p reads the revision two back; with the revision in two windows, the selected window\'s point is kept', async () => {
  const b = E.current;
  goTo(2);
  await keys('p p');
  await shows(at(C2, 'f.scm'), C2);
  assert.equal(lastMessage(), `f.scm at ${s8(C2)} (2 of 4), 2026-02-03, Bob: second`);
  assert.equal(lineNo(), 2);
  L('split-window-right');
  const [w1, w2] = Ed.windowList();
  assert.equal(w1.buffer, b); assert.equal(w2.buffer, b);
  Ed.selectWindow(w2);
  goTo(1);
  Ed.selectWindow(w1);
  goTo(3, 1);
  await keys('n');
  await shows(at(C3, 'g.scm'), C3);
  assert.equal(E.sel, w1);
  assert.equal(lineNo(), 3); assert.equal(colNo(), 1);
  assert.equal(w2.pt, b.pt, 'the other window on the same place');
  L('delete-other-windows');
});

test('q leaves: the time machine\'s buffer killed, the file\'s buffer back in the window; SPC g t again starts over', async () => {
  const b = E.current;
  await keys('q');
  const src = E.current;
  assert.equal(src.file, G);
  assert.ok(!E.buffers.includes(b));
  assert.equal(Ed.windowList().length, 1);
  /* again, twice: one buffer, the newest revision, point on the file's line */
  goTo(6);
  await keys('SPC g t');
  const b2 = E.current;
  await shows(at(C4, 'g.scm'), C4);
  assert.equal(lineNo(), 6);
  await keys('p');
  await shows(at(C3, 'g.scm'), C3);
  Ed.setWindowBuffer(src);
  goTo(4);
  await keys('SPC g t');
  assert.equal(E.current, b2, 'the same buffer');
  await shows(at(C4, 'g.scm'), C4);
  assert.equal(lineNo(), 4);
  assert.equal(lastMessage(), `g.scm at ${s8(C4)} (4 of 4), 2026-04-01, Dave: fourth`);
  assert.equal(E.buffers.filter((x: Edwin) => x.name.startsWith('*git-timemachine')).length, 1);
  await keys('q');
  assert.equal(E.current, src);
});

test('a name with a space, a leading - and glob characters: only its own revisions, named literally after --', async () => {
  const lit = path.join(hist, 'sub', '-x [y]*.txt'), decoy = path.join(hist, 'sub', '-x y-and-more.txt');
  write(decoy, 'decoy\n');
  commitAs(hist, 'Eve', '2026-05-01T00:00:00+0000', 'decoy');
  write(lit, 'lit 1\n');
  const L1 = commitAs(hist, 'Eve', '2026-05-02T00:00:00+0000', 'lit one');
  write(decoy, 'decoy 2\n');
  commitAs(hist, 'Eve', '2026-05-03T00:00:00+0000', 'decoy two');
  write(lit, 'lit 2\n');
  const L2 = commitAs(hist, 'Eve', '2026-05-04T00:00:00+0000', 'lit two');
  visit(lit);
  await keys('SPC g t');
  assert.equal(E.current.name, '*git-timemachine: sub/-x [y]*.txt*');
  await shows('lit 2\n');
  assert.deepEqual(tail(runs('log').at(-1)!.argv, 'log').slice(-2), ['--', ':(literal)sub/-x [y]*.txt']);
  assert.equal(lastMessage(), `sub/-x [y]*.txt at ${s8(L2)} (2 of 2), 2026-05-04, Eve: lit two`);
  await keys('p');
  await shows('lit 1\n');
  assert.equal(lastMessage(), `sub/-x [y]*.txt at ${s8(L1)} (1 of 2), 2026-05-02, Eve: lit one`);
  await keys('q');
});

test('a file deleted and added again: the deletion is no revision', async () => {
  const d = path.join(hist, 'd.txt');
  write(d, 'd one\n');
  const D1 = commitAs(hist, 'Fay', '2026-06-01T00:00:00+0000', 'd one');
  fs.rmSync(d);
  commitAs(hist, 'Fay', '2026-06-02T00:00:00+0000', 'd gone');
  write(d, 'd two\n');
  const D3 = commitAs(hist, 'Fay', '2026-06-03T00:00:00+0000', 'd back');
  visit(d);
  await keys('SPC g t');
  await shows('d two\n');
  assert.equal(lastMessage(), `d.txt at ${s8(D3)} (2 of 2), 2026-06-03, Fay: d back`);
  await keys('p');
  await shows('d one\n');
  assert.equal(lastMessage(), `d.txt at ${s8(D1)} (1 of 2), 2026-06-01, Fay: d one`);
  await keys('q');
});

test('a merge that changed the file is a revision of its own, the file as the merge left it; a merge that took one side\'s file is none', async () => {
  const mg = mkdir('merge'), m = path.join(mg, 'm.txt');
  git(mg, 'init', '-q', '-b', 'main');
  write(m, '1\n2\n3\n');
  commitAs(mg, 'Hal', '2026-08-01T00:00:00+0000', 'base');
  git(mg, 'checkout', '-q', '-b', 'side');
  write(m, 'S\n2\n3\n');
  const S = commitAs(mg, 'Hal', '2026-08-02T00:00:00+0000', 'side');
  git(mg, 'checkout', '-q', 'main');
  write(m, '1\n2\nM\n');
  const M = commitAs(mg, 'Hal', '2026-08-03T00:00:00+0000', 'main');
  execFileSync('git', ['merge', '-q', '--no-edit', 'side'], { cwd: mg, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Ida', GIT_AUTHOR_DATE: '2026-08-04T00:00:00+0000', GIT_COMMITTER_DATE: '2026-08-04T00:00:00+0000' } });
  const X = git(mg, 'rev-parse', 'HEAD').trim();
  /* a merge whose file is main's: no revision */
  git(mg, 'checkout', '-q', '-b', 'other', 'HEAD~1');
  write(path.join(mg, 'o.txt'), 'o\n');
  commitAs(mg, 'Hal', '2026-08-05T00:00:00+0000', 'other');
  git(mg, 'checkout', '-q', 'main');
  execFileSync('git', ['merge', '-q', '--no-edit', 'other'], { cwd: mg, stdio: 'ignore' });
  visit(m, 3);
  await keys('SPC g t');
  await shows('S\n2\nM\n');
  assert.equal(lastMessage(), `m.txt at ${s8(X)} (4 of 4), 2026-08-04, Ida: Merge branch 'side'`);
  await keys('p');
  await shows('1\n2\nM\n');
  assert.equal(lastMessage(), `m.txt at ${s8(M)} (3 of 4), 2026-08-03, Hal: main`);
  await keys('p');
  await shows('S\n2\n3\n');
  assert.equal(lastMessage(), `m.txt at ${s8(S)} (2 of 4), 2026-08-02, Hal: side`);
  await keys('q');
});

test('a revision that is not UTF-8 is shown lossily; a file visited through a symbolic link is taken by its true name', async () => {
  const file = path.join(hist, 'latin1.txt');
  fs.writeFileSync(file, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  commitAs(hist, 'Gus', '2026-07-01T00:00:00+0000', 'latin1');
  visit(file);
  await keys('SPC g t');
  await shows('caf�\n');
  await keys('q');
  const files = host.files as unknown as { truename: (n: string) => string }, was = files.truename;
  files.truename = (n: string) => { try { return fs.realpathSync(n); } catch (e) { return n; } };
  try {
    for (const x of E.buffers.filter((x: Edwin) => x.file === G)) L('kill-buffer', x);
    const link = path.join(root, 'hist-link');
    fs.symlinkSync(hist, link);
    visit(path.join(link, 'g.scm'), 3);
    await keys('SPC g t');
    assert.equal(E.current.name, '*git-timemachine: g.scm*');
    await shows(at(C4, 'g.scm'), C4);
    assert.equal(lineNo(), 3);
    assert.deepEqual(tail(runs('log').at(-1)!.argv, 'log').slice(-2), ['--', ':(literal)g.scm']);
    await keys('q');
    assert.equal(E.current.file, path.join(link, 'g.scm'), 'back to the buffer it was started from');
  } finally { files.truename = was; }
});

test('refused: a file never committed and a repository with no commit (said in the buffer), a buffer that visits no file, outside a repository, the image\'s replay', async () => {
  const u = path.join(hist, 'u.txt');
  write(u, 'u\n');
  visit(u);
  await keys('SPC g t'); await settled();
  assert.equal(E.current.name, '*git-timemachine: u.txt*');
  assert.equal(E.current.text, '(u.txt has no committed revision)\n');
  assert.equal(lastMessage(), 'u.txt has no committed revision');
  let n = proc.calls.length;
  await keys('p');
  assert.equal(lastMessage(), 'No revision is shown');
  assert.equal(proc.calls.length, n, 'no child started');
  await keys('q');
  assert.equal(E.current.file, u);
  /* a repository with no commit yet */
  const empty = mkdir('empty');
  git(empty, 'init', '-q', '-b', 'main');
  write(path.join(empty, 'e.txt'), 'e\n');
  visit(path.join(empty, 'e.txt'));
  await keys('SPC g t'); await settled();
  assert.equal(E.current.text, '(the revisions could not be read: see *vc-process*)\n');
  assert.match(lastMessage(), /^process-error: No revisions of e\.txt: /);
  await keys('q');
  /* no file: nothing starts */
  Ed.setWindowBuffer(Ed.getBufferCreate('no file (vc-timemachine test)'));
  n = proc.calls.length;
  await keys('SPC g t');
  assert.match(lastMessage(), /visits no file: git-timemachine shows a file's revisions/);
  assert.equal(proc.calls.length, n, 'no child started');
  assert.equal(E.current.name, 'no file (vc-timemachine test)');
  /* the time machine buffer itself */
  visit(G);
  await keys('SPC g t'); await shows(at(C4, 'g.scm'), C4);
  n = proc.calls.length;
  await keys('M-x'); await ed.type('git-timemachine\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /visits no file/);
  assert.equal(proc.calls.length, n, 'no child started');
  await keys('q');
  /* p outside a time machine */
  await keys('M-x'); await ed.type('git-timemachine-show-previous-revision\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /Not a git time machine buffer/);
  /* outside a repository */
  const plain = mkdir('plain');
  write(path.join(plain, 'p.txt'), 'p\n');
  visit(path.join(plain, 'p.txt'));
  n = proc.calls.length;
  await keys('SPC g t');
  assert.match(lastMessage(), new RegExp(`Not in a git repository: ${plain}`));
  assert.equal(proc.calls.length, n, 'no child started');
  assert.equal(E.current.file, path.join(plain, 'p.txt'));
  /* the image's replay */
  visit(G);
  n = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { try { ps.push(Promise.resolve(L('git-timemachine'))); } catch (e) { ps.push(Promise.reject(e)); } });
  assert.match(String(await errorOf(ps[0])), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, n, 'no child started');
  assert.equal(E.current.file, G);
});

test('a repository whose own configuration names programs runs none of them for the time machine', async () => {
  const evil = mkdir('evil'), marker = path.join(root, 'evil-ran');
  git(evil, 'init', '-q', '-b', 'main');
  write(path.join(evil, 'a.txt'), 'one\n'); git(evil, 'add', '.'); git(evil, 'commit', '-q', '-m', 'one');
  write(path.join(evil, 'a.txt'), 'one\ntwo\n'); git(evil, 'commit', '-q', '-am', 'two');
  const script = path.join(root, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat "$@"\n`, { mode: 0o755 });
  for (const [k, v] of [['core.fsmonitor', script], ['core.pager', script], ['diff.external', script], ['diff.evil.textconv', script],
    ['filter.evil.clean', script], ['filter.evil.smudge', script], ['filter.evil.process', script]]) git(evil, 'config', k, v);
  write(path.join(evil, '.git/info/attributes'), '* diff=evil filter=evil\n');
  /* the control: plain git show of the blob with --textconv runs the textconv */
  execFileSync('git', ['show', '--textconv', 'HEAD:a.txt'], { cwd: evil, stdio: ['ignore', 'ignore', 'ignore'] });
  assert.ok(fs.existsSync(marker), 'plain git runs the repository\'s programs');
  fs.rmSync(marker);
  visit(path.join(evil, 'a.txt'), 2);
  await keys('SPC g t');
  await shows('one\ntwo\n');
  await keys('p');
  await shows('one\n');
  assert.equal(fs.existsSync(marker), false, 'nothing of the repository\'s ran');
  await keys('q');
});
