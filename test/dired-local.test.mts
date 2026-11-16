// Dired on the desktop program's own files (src/dired.ts's local backend over host.files.tree): the Node host
// with a stand-in for host-native.ts's files over a real directory. The natives themselves are tested by
// native/tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

type EdwinCore = any; // any: Edwin's core (src) is outside this program's types

const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.cts');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-dired-local-')));
const HOME = path.join(root, 'home'), CWD = path.join(HOME, 'proj');
/* The temporary directory, as host.files.temp gives it: its listings never follow it. */
const TEMP = path.join(HOME, 'tmpdir');
const at = (p: string) => path.join(HOME, p);
const put = (p: string, text = 'x\n') => { fs.mkdirSync(path.dirname(at(p)), { recursive: true }); fs.writeFileSync(at(p), text); };
for (const d of ['proj/sub/deep', 'proj/empty', 'other']) fs.mkdirSync(at(d), { recursive: true });
put('proj/a.txt', 'ay\n'); put('proj/b.txt', 'bee\n'); put('proj/sub/in.txt', 'inside\n'); put('proj/sub/deep/d.txt');
fs.symlinkSync('a.txt', at('proj/link')); fs.symlinkSync('sub', at('proj/sublink'));

/* host.files as host-native.ts shapes it, over node:fs. */
let readdirs = 0;
const resolve = (n: string) => (n === '~' ? HOME : n.startsWith('~/') ? path.join(HOME, n.slice(2)) : path.resolve(CWD, n));
const truename = (n: string) => { const p = resolve(n); try { return fs.realpathSync(p); } catch (e) { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch (e2) { return p; } } };
const files = {
  resolve, truename, cwd: CWD,
  label: (p: string) => (p.startsWith(CWD + '/') ? p.slice(CWD.length + 1) : p.startsWith(HOME + '/') ? '~/' + p.slice(HOME.length + 1) : p),
  read(n: string) { try { return fs.readFileSync(resolve(n), 'utf8'); } catch (e) { return null; } },
  write(n: string, t: string) { fs.writeFileSync(resolve(n), t); },
  remove(n: string) { fs.rmSync(resolve(n), { force: true }); },
  list: () => [] as string[],
  exists: (n: string) => fs.existsSync(resolve(n)),
  /* a file's stamp, null for a directory, as host-native.ts: global-auto-revert-mode looks where there is one */
  stamp(n: string) { try { const s = fs.statSync(resolve(n), { bigint: true }); return s.isDirectory() ? null : `${s.ino}:${s.mtimeNs}:${s.size}`; } catch (e) { return null; } },
  temp: [TEMP],
  tree: {
    entry(p: string) {
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) { return null; }
      const e: { kind: string; size: number; mtime: number; mode: number; target?: string; dir?: boolean } =
        { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
      if (e.kind === 'link') { e.target = fs.readlinkSync(p); try { if (fs.statSync(p).isDirectory()) e.dir = true; } catch (err) { /* dangling */ } }
      return e;
    },
    names: (d: string) => { readdirs++; return fs.readdirSync(d); },
    rename: (src: string, dst: string) => fs.renameSync(src, dst),
    copy: (src: string, dst: string) => fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true }),
    rmdir: (p: string, recursive: boolean) => (recursive ? fs.rmSync(p, { recursive: true }) : fs.rmdirSync(p)),
    mkdir: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
  },
};

const host = createHost({ storage: memoryStorage(), workers: false });
host.files = files;
host.dirs = { home: HOME, cwd: CWD, config: path.join(HOME, '.config/edwin'), state: path.join(HOME, '.local/state/edwin') };
const Ed: EdwinCore = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const E = Ed.E, L = (globalThis as unknown as { L: EdwinCore }).L;
const ev = (src: string) => { L.resetOps(); return L.evalText(src); };
/* The look runs by hand: the timer never fires. */
ev('(set! auto-revert-interval 3600)');
const frame = Ed.makeFrame(null, { backend: { tty: true, size: () => ({ cols: 100, rows: 30 }), draw: () => {} } });
frame.focused = true;

const feed = async (ks: string[]) => { for (const k of ks) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = (s: string) => feed(Ed.kbd(s).split(' '));
const type = (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const messages = (): string => Ed.getBuffer('*Messages*').text;
const cur = () => E.current;
const NAME = 38;
const names = (): string[] => cur().text.split('\n').slice(1, -1).map((l: string) => l.slice(NAME));
const goTo = (name: string) => { const b = cur(), i = names().indexOf(name); assert.ok(i >= 0, `${name} is listed: ${names()}`); b.pt = Ed.lineStartB(b, i + 2) + NAME; };
async function dired(p: string) { E.current = Ed.getBuffer('*scratch*'); Ed.setWindowBuffer(E.current); await keys('SPC f d'); assert.ok(E.mini, 'the minibuffer asks for a directory'); await type(`~/${p}/`); await keys('RET'); }

after(() => { ev('(global-auto-revert-mode 0)'); fs.rmSync(root, { recursive: true, force: true }); });

test('SPC f d starts in the working directory; RET visits a file as a buffer of the program, - goes up', async () => {
  E.current = Ed.getBuffer('*scratch*'); Ed.setWindowBuffer(E.current);
  await keys('SPC f d');
  assert.equal(E.minibuf.text, '~/proj/');
  await keys('RET');
  const b = cur();
  assert.equal(b.mode, 'dired-mode'); assert.equal(b.name, '~/proj/');
  assert.deepEqual(names(), ['empty', 'sub', 'sublink -> sub', 'a.txt', 'b.txt', 'link -> a.txt']);
  goTo('b.txt'); await keys('RET');
  assert.equal(cur().file, at('proj/b.txt')); assert.equal(cur().text, 'bee\n');
  await keys('C-x C-j');
  assert.equal(cur().name, '~/proj/', 'dired-jump lists the file\'s directory');
  await keys('-');
  assert.equal(cur().name, '~/');
  assert.deepEqual(names(), ['other', 'proj']);
});

test('find-file answers a file with its buffer at once, and lists a directory', async () => {
  const b = L.call('find-file', ['a.txt']);
  assert.equal(b.file, at('proj/a.txt'), 'a buffer, not a promise: callers set its mode and point');
  const fresh = L.call('find-file', ['~/other/new.txt']);
  assert.equal(fresh.file, at('other/new.txt')); assert.equal(fresh.text, '');
  await L.call('find-file', ['sub']);
  await Ed.whenIdle();
  assert.equal(cur().mode, 'dired-mode'); assert.equal(cur().name, '~/proj/sub/');
  E.current = Ed.getBuffer('*scratch*'); Ed.setWindowBuffer(E.current);
  await keys('SPC f f');
  assert.equal(E.minibuf.text, '~/proj/');
  await type('su'); await keys('TAB TAB');
  assert.equal(E.minibuf.text, '~/proj/sub/');
  await type('in.txt'); await keys('RET');
  assert.equal(cur().file, at('proj/sub/in.txt'));
});

test('delete: a file after y, a directory with contents after a typed yes', async () => {
  put('proj/gone.txt'); put('proj/full/x.txt');
  await dired('proj');
  goTo('gone.txt'); await keys('D'); await keys('y');
  assert.equal(fs.existsSync(at('proj/gone.txt')), false);
  goTo('full'); await keys('D'); await keys('y');
  assert.ok(E.mini, 'a directory that is not empty asks again');
  await type('no'); await keys('RET');
  assert.equal(fs.existsSync(at('proj/full/x.txt')), true);
  goTo('full'); await keys('D'); await keys('y'); await type('yes'); await keys('RET');
  assert.equal(fs.existsSync(at('proj/full')), false);
  goTo('link -> a.txt'); await keys('D'); await keys('y');
  assert.equal(fs.existsSync(at('proj/a.txt')), true, 'a link goes, its target stays');
  assert.equal(names().includes('link -> a.txt'), false);
});

test('rename takes the open buffer along and never overwrites; copy, mkdir', async () => {
  put('proj/old.txt', 'old\n');
  const b = L.call('find-file', ['old.txt']);
  assert.equal(b.name, 'old.txt');
  await dired('proj');
  goTo('old.txt'); await keys('R'); await type('new.txt'); await keys('RET');
  assert.equal(fs.readFileSync(at('proj/new.txt'), 'utf8'), 'old\n'); assert.equal(fs.existsSync(at('proj/old.txt')), false);
  assert.equal(b.file, at('proj/new.txt')); assert.equal(b.name, 'new.txt');
  goTo('new.txt'); await keys('R'); await type('b.txt'); await keys('RET');
  assert.match(messages(), /destination exists/);
  assert.equal(fs.readFileSync(at('proj/b.txt'), 'utf8'), 'bee\n');
  /* A directory moves with the buffers under it. */
  const inside = L.call('find-file', ['sub/in.txt']);
  await dired('proj');
  goTo('sub'); await keys('R'); await type('~/other/'); await keys('RET');
  assert.equal(fs.existsSync(at('other/sub/in.txt')), true);
  assert.equal(inside.file, at('other/sub/in.txt'));
  /* Copy a directory: links stay links; into itself is refused. */
  await dired('other');
  goTo('sub'); await keys('C'); await type('copy'); await keys('RET');
  assert.equal(fs.readFileSync(at('other/copy/in.txt'), 'utf8'), 'inside\n');
  goTo('sub'); await keys('C'); await type('sub/inner'); await keys('RET');
  assert.match(messages(), /into itself/);
  assert.equal(fs.existsSync(at('other/sub/inner')), false);
  await keys('+'); await type('made/deeper'); await keys('RET');
  assert.equal(fs.statSync(at('other/made/deeper')).isDirectory(), true);
  await keys('+'); await type('made'); await keys('RET');
  assert.match(messages(), /exists/);
});

test('a host whose files are not a tree has no directories', async () => {
  const tree = files.tree;
  delete (files as { tree?: unknown }).tree;
  try {
    E.current = Ed.getBuffer('*scratch*'); Ed.setWindowBuffer(E.current);
    await keys('SPC f d');
    assert.equal(E.mini, null);
    assert.match(messages(), /No directories here/);
  } finally { files.tree = tree; }
});

/* The earlier tests' listings are followed too: gone, the looks count only these. */
const dropListings = () => { for (const x of [...E.buffers]) if (x.dired) L.call('kill-buffer', [x]); };

test('a listing follows its directory: a name made or gone elsewhere shows at the next look, marks and point kept', async () => {
  dropListings();
  for (const n of ['a', 'b', 'c', 'd']) put(`watched/${n}.txt`);
  await dired('watched');
  const b = cur();
  assert.equal(typeof b.autoRevert, 'function', 'the desktop program\'s own directory is followed');
  goTo('a.txt'); await keys('m');
  goTo('b.txt'); await keys('d');
  goTo('d.txt'); await keys('m');
  goTo('c.txt');
  const look = (): number => L.call('auto-revert-buffers', []);
  assert.equal(look(), 0, 'nothing changed');
  put('watched/aa.txt');
  fs.rmSync(at('watched/d.txt'));
  assert.equal(look(), 1);
  await Ed.whenIdle();
  assert.deepEqual(names(), ['a.txt', 'aa.txt', 'b.txt', 'c.txt']);
  const line = (n: string) => cur().text.split('\n')[names().indexOf(n) + 1];
  assert.equal(line('a.txt')[0], '*'); assert.equal(line('b.txt')[0], 'D'); assert.equal(line('aa.txt')[0], ' ');
  const at0 = cur().pt, ls = Ed.lineStartB(cur(), names().indexOf('c.txt') + 2);
  assert.equal(at0, ls + NAME, 'point stays on its entry, which moved down a line');
  assert.equal(look(), 0, 'nothing changed since');
  /* The same names again: a file's own change is not the directory's. */
  fs.writeFileSync(at('watched/a.txt'), 'longer now\n');
  assert.equal(look(), 0);
  /* A listing not shown in a window follows too, and one whose directory is gone stays as it was. */
  E.current = Ed.getBuffer('*scratch*'); Ed.setWindowBuffer(E.current);
  put('watched/e.txt');
  assert.equal(look(), 1); await Ed.whenIdle();
  assert.match(b.text, /e\.txt/);
  fs.rmSync(at('watched'), { recursive: true });
  assert.equal(look(), 0);
  assert.match(b.text, /e\.txt/);
  L.call('kill-buffer', [b]);
});

test('listings under the temporary directory or of a --private session are not followed; the mode off stops them', async () => {
  dropListings();
  fs.mkdirSync(TEMP, { recursive: true });
  await dired('tmpdir');
  assert.equal(cur().autoRevert, undefined, 'the temporary directory');
  L.call('kill-buffer', [cur()]);
  fs.mkdirSync(at('priv'), { recursive: true });
  host.private = true;
  try { await dired('priv'); assert.equal(cur().autoRevert, undefined, 'a --private session'); }
  finally { host.private = false; }
  L.call('kill-buffer', [cur()]);
  await dired('priv');
  const b = cur();
  ev('(global-auto-revert-mode 0)');
  put('priv/new.txt');
  assert.equal(L.call('auto-revert-buffers', []), 0, 'the mode off');
  ev('(global-auto-revert-mode 1)');
  assert.equal(L.call('auto-revert-buffers', []), 1); await Ed.whenIdle();
  assert.ok(names().includes('new.txt'));
  L.call('kill-buffer', [b]);
  fs.rmSync(TEMP, { recursive: true }); fs.rmSync(at('priv'), { recursive: true });
});

test('a quiet directory costs a look one lstat and no readdir; a name made in the tick of the read is still seen', async () => {
  dropListings();
  const dir = at('quiet');
  put('quiet/a.txt');
  const old = new Date(Date.now() - 60000); fs.utimesSync(dir, old, old);
  await dired('quiet');
  const look = (): number => L.call('auto-revert-buffers', []);
  assert.equal(look(), 0, 'the first look reads the names, the same');
  const n = readdirs;
  assert.equal(look(), 0); assert.equal(look(), 0);
  assert.equal(readdirs, n, 'the directory\'s time has not moved and is long past: no readdir');
  put('quiet/b.txt');
  assert.equal(look(), 1); await Ed.whenIdle();
  assert.ok(names().includes('b.txt'));
  /* Its time is now recent: a name made with the time put back as it was (the same tick) is still caught. */
  const st = fs.statSync(dir);
  put('quiet/c.txt'); fs.utimesSync(dir, st.atime, st.mtime);
  assert.equal(look(), 1); await Ed.whenIdle();
  assert.ok(names().includes('c.txt'));
  L.call('kill-buffer', [cur()]);
  fs.rmSync(dir, { recursive: true });
});

test('a listing of 10000 names follows its directory; one cut at 10000 is not followed', async (t) => {
  dropListings();
  const dir = at('big');
  fs.mkdirSync(dir);
  for (let i = 0; i < 9999; i++) fs.writeFileSync(path.join(dir, `f${i}`), '');
  await dired('big');
  const b = cur(), look = (): number => L.call('auto-revert-buffers', []);
  look();
  fs.writeFileSync(path.join(dir, 'f9999'), '');
  const t0 = performance.now(), n = look(), ms = performance.now() - t0;
  t.diagnostic(`a look that reads 10000 names: ${ms.toFixed(1)} ms`);
  assert.equal(n, 1); await Ed.whenIdle();
  assert.equal(names().length, 10000);
  fs.writeFileSync(path.join(dir, 'g'), '');
  assert.equal(look(), 1, 'the 10001st name is seen'); await Ed.whenIdle();
  assert.equal((b.dired as { truncated: boolean }).truncated, true);
  fs.writeFileSync(path.join(dir, 'h'), '');
  assert.equal(look(), 0, 'a cut listing is not followed');
  L.call('kill-buffer', [b]);
  fs.rmSync(dir, { recursive: true });
});
