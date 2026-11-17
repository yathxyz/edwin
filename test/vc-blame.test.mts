// git's blame (src/vc-git.ts: SPC g b, git-blame) in the headless runtime, with real git from PATH through Ed.proc
// over fake-proc.mts's host.proc, in throwaway repositories under a throwaway HOME; host.files is node:fs, as
// host-native.ts has it. A fixture history of three commits by three authors in three time zones is blamed, each
// line compared with what `git blame` says of it.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-blame.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-blame-')));
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
const lines = (): string[] => E.current.text.replace(/\n$/, '').split('\n');
const lineNo = () => Ed.lineNoB(E.current, E.current.pt);
const goLine = (n: number) => { const b = E.current; b.pt = Ed.lineStartB(b, n); };
const classes = (b: Edwin, n: number) => { const s = Ed.lineStartB(b, n), e = Ed.eol(b.rope, s), lx = Ed.hooks.lexSeg(b, s, e, b.rope.slice(s, e)); return [...lx.cls].map((c: number) => lx.names[c]); };
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
/* Visit FILE alone in one window, point on line LINE. */
const visit = (file: string, line = 1) => {
  L('delete-other-windows');
  L('find-file', file);
  assert.equal(E.current.file, file);
  goLine(line);
  return E.current;
};
/* Wait, up to 20 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 5))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}\n${E.current.text.slice(-2000)}`);
  await Ed.whenIdle();
};
/* The blame buffer done reading: no `(blaming …)` line, no child left. */
const reading = (b: Edwin = E.current) => /^\(blaming /.test(b.text.replace(/\n$/, '').split('\n').at(-1) || '');
const settled = (b: Edwin = E.current) => until(() => !reading(b) && !proc.running().length, 'the blame');
const blames = () => proc.calls.filter(c => c.argv.includes('blame'));
const tail = (argv: string[]) => argv.slice(argv.indexOf('blame'));
/* git's own blame of FILE: the full hash of each line's commit, in order */
const gitBlame = (cwd: string, file: string, contents?: string) => {
  const out = execFileSync('git', ['blame', '-l', '-s', '--root', ...(contents !== undefined ? ['--contents', '-'] : []), '--', file], { cwd, input: contents ?? '', encoding: 'utf8' });
  return out.split('\n').filter(l => l).map(l => l.slice(0, 40));
};

/* ---------- the fixture: three commits by three authors, each in a time zone of its own ---------- */
const hist = mkdir('hist'), F = path.join(hist, 'f.txt');
git(hist, 'init', '-q', '-b', 'main');
write(F, 'one\ntwo\nthree\nfour\n');
const C1 = commitAs(hist, 'Alice', '2026-01-01T00:00:00+0000', 'first');
/* 23:30 on the 3rd at -0500 is the 4th in UTC: the day shown is the author's */
write(F, 'one\nTWO\nthree\nfour\n');
const C2 = commitAs(hist, 'Bartholomew Longname-Smythe', '2026-02-03T23:30:00-0500', 'second');
/* 00:30 on the 1st at +0200 is February in UTC; a TAB and a control character in the line */
write(F, 'one\nTWO\nthree\nfour\n\tfive\u0007\n');
const C3 = commitAs(hist, 'Carol', '2026-03-01T00:30:00+0200', 'third');
const s8 = (oid: string) => oid.slice(0, 8);
/* the author column: 20 wide, the longest name cut with … */
const BART = 'Bartholomew Longnam…';

test('SPC g b blames the file beside it, in the background: a line for each of its lines, its commit, author and day, then its text', async () => {
  const src = visit(F, 3);
  await keys('SPC g b');
  const b = E.current;
  assert.equal(b.name, '*git-blame: f.txt*');
  assert.equal(b.mode, 'git-blame-mode');
  assert.equal(Ed.MODE_NAMES['git-blame-mode'], 'Git Blame');
  assert.ok(b.readOnly);
  assert.equal(b.evilState, 'motion');
  /* the command has ended while git still reads */
  assert.equal(b.text, '(blaming f.txt…)\n');
  /* beside the file: the blame in the window the file was in, the file in a new one on its right */
  const ws = Ed.windowList();
  assert.equal(ws.length, 2);
  assert.equal(ws[0].buffer, b);
  assert.equal(ws[0], E.sel);
  assert.equal(ws[1].buffer, src);
  await settled();
  assert.deepEqual(lines(), [
    `${s8(C1)} Alice                2026-01-01 one`,
    `${s8(C2)} ${BART} 2026-02-03 TWO`,
    `${s8(C1)} Alice                2026-01-01 three`,
    `${s8(C1)} Alice                2026-01-01 four`,
    `${s8(C3)} Carol                2026-03-01 \tfive?`,
  ]);
  /* each line's commit is git blame's */
  assert.deepEqual(b.gitView.rows.map((r: { show: string }) => r.show), gitBlame(hist, 'f.txt'));
  /* point on the line point was on in the file */
  assert.equal(lineNo(), 3);
  /* the buffer has no change: the file on disk, the path after --, a read: the hooks off, no textconv, no
     ignore-revs file */
  const c = blames().at(-1)!;
  assert.deepEqual(tail(c.argv), ['blame', '--no-textconv', '--no-ignore-revs-file', '--porcelain', '--', 'f.txt']);
  assert.ok(c.argv.includes('core.hooksPath=/dev/null'));
  /* faces: the hash, then the author and day dim, the text plain */
  const cls = classes(b, 2), head = `${s8(C2)} ${BART} 2026-02-03`;
  assert.deepEqual(new Set(cls.slice(0, 8)), new Set(['git-hash']));
  assert.deepEqual(new Set(cls.slice(9, head.length)), new Set(['git-dim']));
  assert.deepEqual(new Set(cls.slice(head.length)), new Set(['']));
});

test('RET on a line shows its commit in the revision buffer', async () => {
  goLine(2);
  await keys('RET');
  assert.equal(E.current.name, '*git-revision: hist*');
  assert.equal(lines()[0], `Commit:    ${C2}`);
  assert.match(E.current.text, /^    second$/m);
  await keys('q');
  assert.equal(E.current.name, '*git-blame: f.txt*');
});

test('a change not saved is blamed as the buffer has it: its line not committed yet, RET there visiting the file; g r blames again', async () => {
  const b = E.current, src = Ed.windowList()[1].buffer;
  Ed.editText(src, 0, 0, 'new\n');
  src.modified = true;
  await keys('g r');
  assert.equal(b.text.split('\n').at(-2), '(blaming f.txt…)', 'g r reads it again in the background');
  await settled();
  const zero = '0'.repeat(8) + ' Not committed yet    ' + ' '.repeat(10) + ' new';
  assert.deepEqual(lines(), [
    zero,
    `${s8(C1)} Alice                2026-01-01 one`,
    `${s8(C2)} ${BART} 2026-02-03 TWO`,
    `${s8(C1)} Alice                2026-01-01 three`,
    `${s8(C1)} Alice                2026-01-01 four`,
    `${s8(C3)} Carol                2026-03-01 \tfive?`,
  ]);
  assert.deepEqual(b.gitView.rows.slice(1).map((r: { show: string }) => r.show), gitBlame(hist, 'f.txt', src.text).slice(1));
  assert.deepEqual(tail(blames().at(-1)!.argv).slice(-4), ['--contents', '-', '--', 'f.txt'], 'the buffer\'s text on git\'s input');
  assert.equal(fs.readFileSync(F, 'utf8'), 'one\nTWO\nthree\nfour\n\tfive\u0007\n', 'the file is not written');
  assert.deepEqual(new Set(classes(b, 1).slice(0, 8)), new Set(['git-dim']));
  /* point kept on its line across g r (the second, where RET left it) */
  assert.equal(lineNo(), 2);
  /* RET on the line not committed visits the file there */
  goLine(1);
  await keys('RET');
  assert.equal(E.current, src);
  assert.equal(lineNo(), 1);
  Ed.editText(src, 0, 4, ''); src.modified = false;
});

test('SPC g b again with the blame shown: no other window or buffer, the blame selected and read again, point on the file\'s line', async () => {
  const src = visit(F, 1);
  assert.equal(src.text, fs.readFileSync(F, 'utf8'));
  await keys('SPC g b'); await settled();
  goLine(1);
  /* to the file's window, to line 5, and SPC g b */
  Ed.selectWindow(Ed.windowList()[1]);
  assert.equal(E.current, src);
  goLine(5);
  const n = blames().length;
  await keys('SPC g b');
  assert.equal(Ed.windowList().length, 2);
  assert.equal(E.current.name, '*git-blame: f.txt*');
  await settled();
  assert.equal(blames().length, n + 1);
  assert.equal(lineNo(), 5);
  assert.equal(E.buffers.filter((x: Edwin) => x.mode === 'git-blame-mode').length, 1);
});

test('a file in a directory, its name with a space and a leading -: given to git after --', async () => {
  const file = path.join(hist, 'sub', '-x y.txt');
  write(file, 'alpha\nbeta\n');
  const C4 = commitAs(hist, 'Dee', '2026-04-01T12:00:00+0000', 'fourth');
  visit(file, 2);
  await keys('SPC g b'); await settled();
  assert.equal(E.current.name, '*git-blame: sub/-x y.txt*');
  assert.deepEqual(lines(), [`${s8(C4)} Dee 2026-04-01 alpha`, `${s8(C4)} Dee 2026-04-01 beta`]);
  assert.deepEqual(tail(blames().at(-1)!.argv).slice(-2), ['--', 'sub/-x y.txt']);
  assert.equal(lineNo(), 2);
});

test('the file on disk when no buffer visits it: g r after the file\'s buffer is killed', async () => {
  const src = Ed.windowList()[1].buffer, b = E.current;
  L('kill-buffer', src);
  Ed.selectWindow(Ed.windowList().find((w: Edwin) => w.buffer === b));
  await keys('g r'); await settled();
  assert.equal(lines().length, 2);
  const t = tail(blames().at(-1)!.argv);
  assert.ok(!t.includes('--contents'), 'no buffer: the file as it is on disk');
  assert.deepEqual(t.slice(-2), ['--', 'sub/-x y.txt']);
});

test('refused: an untracked file (said in the blame buffer too), a buffer that visits no file, outside a repository, the image\'s replay', async () => {
  const u = path.join(hist, 'u.txt');
  write(u, 'u\n');
  visit(u);
  await keys('SPC g b'); await settled();
  assert.equal(E.current.name, '*git-blame: u.txt*');
  assert.equal(E.current.text, '(the blame could not be read: see *vc-process*)\n');
  assert.match(lastMessage(), /Not blamed: no such path '?u\.txt'? in HEAD \(see \*vc-process\*\)/);
  /* a repository with no commit yet */
  const empty = mkdir('empty');
  git(empty, 'init', '-q', '-b', 'main');
  write(path.join(empty, 'e.txt'), 'e\n');
  visit(path.join(empty, 'e.txt'));
  await keys('SPC g b'); await settled();
  assert.match(lastMessage(), /^process-error: Not blamed: /);
  /* no file: nothing starts */
  L('delete-other-windows');
  Ed.setWindowBuffer(Ed.getBufferCreate('no file (vc-blame test)'));
  let n = proc.calls.length;
  await keys('SPC g b');
  assert.match(lastMessage(), /visits no file: git-blame blames a file's lines/);
  assert.equal(proc.calls.length, n, 'no child started');
  assert.equal(Ed.windowList().length, 1);
  /* the blame buffer itself */
  visit(F);
  await keys('SPC g b'); await settled();
  n = proc.calls.length;
  await keys('M-x'); await ed.type('git-blame\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /visits no file/);
  assert.equal(proc.calls.length, n, 'no child started');
  /* outside a repository */
  const plain = mkdir('plain');
  write(path.join(plain, 'p.txt'), 'p\n');
  visit(path.join(plain, 'p.txt'));
  n = proc.calls.length;
  await keys('SPC g b');
  assert.match(lastMessage(), new RegExp(`Not in a git repository: ${plain}`));
  assert.equal(proc.calls.length, n, 'no child started');
  assert.equal(Ed.windowList().length, 1);
  /* the image's replay */
  visit(F);
  n = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { try { ps.push(Promise.resolve(L('git-blame'))); } catch (e) { ps.push(Promise.reject(e)); } });
  assert.match(String(await errorOf(ps[0])), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, n, 'no child started');
  assert.equal(Ed.windowList().length, 1);
});

test('a repository whose own configuration names programs runs none of them for a blame', async () => {
  const evil = mkdir('evil'), marker = path.join(root, 'evil-ran');
  git(evil, 'init', '-q', '-b', 'main');
  write(path.join(evil, 'a.txt'), 'one\n'); git(evil, 'add', '.'); git(evil, 'commit', '-q', '-m', 'one');
  write(path.join(evil, 'a.txt'), 'one\ntwo\n'); git(evil, 'commit', '-q', '-am', 'two');
  const script = path.join(root, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat "$@"\n`, { mode: 0o755 });
  for (const [k, v] of [['core.fsmonitor', script], ['core.pager', script], ['diff.external', script], ['diff.evil.textconv', script],
    ['filter.evil.clean', script], ['filter.evil.smudge', script], ['filter.evil.process', script], ['alias.blame', '!' + script]]) git(evil, 'config', k, v);
  write(path.join(evil, '.git/info/attributes'), '* diff=evil filter=evil\n');
  /* the control: plain git blame of a buffer's text runs the clean filter, of the file the textconv */
  execFileSync('git', ['-c', 'filter.evil.process=', 'blame', '--contents', '-', '--', 'a.txt'], { cwd: evil, input: 'one\ntwo\n', stdio: ['pipe', 'ignore', 'ignore'] });
  assert.ok(fs.existsSync(marker), 'plain git blame runs the repository\'s programs');
  fs.rmSync(marker);
  visit(path.join(evil, 'a.txt'), 2);
  await keys('SPC g b'); await settled();
  assert.equal(lines().length, 2, E.current.text + Ed.getBuffer('*vc-process*').text.slice(-3000));
  assert.match(lines()[1], / two$/);
  await keys('g r'); await settled();
  assert.equal(fs.existsSync(marker), false, 'nothing of the repository\'s ran');
  /* blame.ignoreRevsFile naming a file outside the repository, mailmap.file a FIFO: plain git blame dies with
     the file's first line (the control) and hangs on the FIFO; Edwin's reads neither */
  const secret = path.join(root, 'secret'), fifo = path.join(root, 'fifo');
  fs.writeFileSync(secret, 'SECRET-TOKEN-123\n');
  git(evil, 'config', 'blame.ignoreRevsFile', secret);
  const plain = (...pre: string[]) => {
    try { execFileSync('git', [...pre, 'blame', '--porcelain', '--', 'a.txt'], { cwd: evil, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000, encoding: 'utf8' }); return 'ok'; }
    catch (e) { const x = e as { stderr?: string; code?: string }; return x.code === 'ETIMEDOUT' ? 'hung' : String(x.stderr); }
  };
  assert.match(plain(), /invalid object name: SECRET-TOKEN-123/);
  assert.match(plain('-c', 'blame.ignoreRevsFile='), /SECRET-TOKEN-123/, 'an empty -c value does not drop it');
  execFileSync('mkfifo', [fifo]);
  git(evil, 'config', '--unset-all', 'blame.ignoreRevsFile');
  git(evil, 'config', 'mailmap.file', fifo);
  assert.equal(plain(), 'hung');
  git(evil, 'config', 'blame.ignoreRevsFile', secret);
  if (fs.existsSync(marker)) fs.rmSync(marker);   // plain git, the controls, ran its programs
  await keys('g r'); await settled();
  assert.equal(lines().length, 2, E.current.text + Ed.getBuffer('*vc-process*').text.slice(-3000));
  assert.match(lines()[1], / two$/);
  assert.ok(!Ed.getBuffer('*vc-process*').text.includes('SECRET') && !Ed.getBuffer('*Messages*').text.includes('SECRET'));
  assert.ok(blames().at(-1)!.argv.includes('mailmap.file='), 'the repository\'s mailmap.file set back to the user\'s none');
  assert.equal(fs.existsSync(marker), false, 'nothing of the repository\'s ran');
});

test('an unchanged buffer of a file that is not UTF-8 is blamed from the file\'s bytes: its lines committed', async () => {
  const file = path.join(hist, 'latin1.txt');
  fs.writeFileSync(file, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a]));
  const C = commitAs(hist, 'Fay', '2026-06-01T00:00:00+0000', 'latin1');
  const src = visit(file);
  assert.ok(!src.modified);
  await keys('SPC g b'); await settled();
  assert.deepEqual(lines(), [`${s8(C)} Fay 2026-06-01 caf�`, `${s8(C)} Fay 2026-06-01 x`]);
  assert.deepEqual(E.current.gitView.rows.map((r: { show: string }) => r.show), gitBlame(hist, 'latin1.txt'));
  await keys('RET');
  assert.equal(E.current.name, '*git-revision: hist*');
  await keys('q');
});

test('a file visited through a symbolic link is blamed by its true name: its blame buffer selected, its changes read', async () => {
  const files = host.files as unknown as { truename: (n: string) => string }, was = files.truename;
  files.truename = (n: string) => { try { return fs.realpathSync(n); } catch (e) { return n; } };
  try {
    for (const x of E.buffers.filter((x: Edwin) => x.file === F)) L('kill-buffer', x);
    const link = path.join(root, 'hist-link');
    fs.symlinkSync(hist, link);
    const src = visit(path.join(link, 'f.txt'), 2);
    await keys('SPC g b'); await settled();
    assert.equal(E.current.name, '*git-blame: f.txt*');
    assert.equal(E.buffers.filter((x: Edwin) => x.name.startsWith('*git-blame: f.txt*')).length, 1, 'no second blame of the file');
    assert.deepEqual(tail(blames().at(-1)!.argv).slice(-2), ['--', 'f.txt']);
    assert.equal(lineNo(), 2);
    Ed.editText(src, 0, 0, 'new\n'); src.modified = true;
    await keys('g r'); await settled();
    assert.ok(blames().at(-1)!.argv.includes('--contents'), 'the changed buffer, by its true name, is what is blamed');
    assert.match(lines()[0], /^00000000 Not committed yet/);
    Ed.editText(src, 0, 4, ''); src.modified = false;
  } finally { files.truename = was; }
});

test('an empty file says so', async () => {
  const file = path.join(hist, 'empty.txt');
  write(file, '');
  commitAs(hist, 'Eve', '2026-05-01T00:00:00+0000', 'empty');
  visit(file);
  await keys('SPC g b'); await settled();
  assert.equal(E.current.name, '*git-blame: empty.txt*');
  assert.equal(E.current.text, '(the file is empty)\n');
});
