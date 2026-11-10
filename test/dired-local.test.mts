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
const at = (p: string) => path.join(HOME, p);
const put = (p: string, text = 'x\n') => { fs.mkdirSync(path.dirname(at(p)), { recursive: true }); fs.writeFileSync(at(p), text); };
for (const d of ['proj/sub/deep', 'proj/empty', 'other']) fs.mkdirSync(at(d), { recursive: true });
put('proj/a.txt', 'ay\n'); put('proj/b.txt', 'bee\n'); put('proj/sub/in.txt', 'inside\n'); put('proj/sub/deep/d.txt');
fs.symlinkSync('a.txt', at('proj/link')); fs.symlinkSync('sub', at('proj/sublink'));

/* host.files as host-native.ts shapes it, over node:fs. */
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
  tree: {
    entry(p: string) {
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) { return null; }
      const e: { kind: string; size: number; mtime: number; mode: number; target?: string; dir?: boolean } =
        { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
      if (e.kind === 'link') { e.target = fs.readlinkSync(p); try { if (fs.statSync(p).isDirectory()) e.dir = true; } catch (err) { /* dangling */ } }
      return e;
    },
    names: (d: string) => fs.readdirSync(d),
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

after(() => fs.rmSync(root, { recursive: true, force: true }));

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
