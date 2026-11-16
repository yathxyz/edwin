// Auto-revert and save supersession (src/editor-prims.ts): the Node host with a stand-in for host-native.ts's
// files over a real directory, its stamp counted. The stamp's native (stat's ino and nsec) is tested by
// native/tests/terminal.rs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

type EdwinCore = any; // any: Edwin's core (src) is outside this program's types

const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.cts');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-autorevert-')));
const HOME = path.join(root, 'home'), TEMP = path.join(root, 'tmp');
fs.mkdirSync(HOME); fs.mkdirSync(TEMP);
const at = (p: string) => path.join(HOME, p);
/* Another program's writes: in place, or a new file renamed over the old one (a new inode), as editors and git do. */
const writeInPlace = (p: string, text: string) => fs.writeFileSync(p, text);
const replace = (p: string, text: string) => { fs.writeFileSync(p + '.new', text); fs.renameSync(p + '.new', p); };

let stamps = 0, reads = 0;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const statted: string[] = [];
const resolve = (n: string) => (n.startsWith('/') ? path.normalize(n) : path.resolve(HOME, n));
const files = {
  resolve, cwd: HOME, temp: [TEMP],
  truename: (n: string) => { const p = resolve(n); try { return fs.realpathSync(p); } catch (e) { return p; } },
  label: (p: string) => (p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p),
  /* as the native readFile, a file that is not UTF-8 throws */
  read(n: string) { reads++; let bytes; try { bytes = fs.readFileSync(resolve(n)); } catch (e) { return null; } return utf8.decode(bytes); },
  write(n: string, t: string) { replace(resolve(n), t); },
  remove(n: string) { fs.rmSync(resolve(n), { force: true }); },
  list: () => [] as string[],
  exists: (n: string) => fs.existsSync(resolve(n)),
  stamp(n: string) {
    stamps++; statted.push(resolve(n));
    try { const s = fs.statSync(resolve(n), { bigint: true }); return s.isDirectory() ? null : `${s.ino}:${s.mtimeNs}:${s.size}`; } catch (e) { return null; }
  },
};

const host = createHost({ storage: memoryStorage(), workers: false });
host.files = files;
host.dirs = { home: HOME, cwd: HOME, config: path.join(HOME, '.config/edwin'), state: path.join(HOME, '.local/state/edwin') };
const Ed: EdwinCore = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const E = Ed.E, L = (globalThis as unknown as { L: EdwinCore }).L;
const frame = Ed.makeFrame(null, { backend: { tty: true, size: () => ({ cols: 100, rows: 30 }), draw: () => {} } });
frame.focused = true;
const ev = (src: string) => { L.resetOps(); return L.evalText(src); };
/* The timer never fires in the tests that look by hand. */
ev('(set! auto-revert-interval 3600)');

const feed = async (ks: string[]) => { for (const k of ks) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = (s: string) => feed(Ed.kbd(s).split(' '));
const type = (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const look = (): number => L.call('auto-revert-buffers', []);
const lineCol = (b: EdwinCore) => { const t = b.text.slice(0, b.pt); return [t.split('\n').length, b.pt - (t.lastIndexOf('\n') + 1)]; };
function visit(file: string, text: string) {
  fs.writeFileSync(file, text);
  const b = L.call('find-file', [file]);
  Ed.setWindowBuffer(b); E.current = b;
  return b;
}

after(() => { ev('(global-auto-revert-mode 0)'); fs.rmSync(root, { recursive: true, force: true }); });

test('init.scm turns global-auto-revert-mode on', () => {
  assert.equal(ev('global-auto-revert-enabled'), true);
});

test('another program\'s write updates an unmodified buffer and keeps point on its line; undo brings the old text back', async () => {
  const b = visit(at('a.txt'), 'one\ntwo\nthree\n');
  b.pt = b.text.indexOf('three') + 2;
  assert.deepEqual(lineCol(b), [3, 2]);
  replace(at('a.txt'), 'zero\none\ntwo\nthree\n');
  assert.equal(look(), 1);
  assert.equal(b.text, 'zero\none\ntwo\nthree\n');
  assert.deepEqual(lineCol(b), [4, 2], 'point moved down with its line, same column');
  assert.equal(b.modified, false);
  assert.match(Ed.getBuffer('*Messages*').text, /Reverted a\.txt/);
  assert.equal(look(), 0, 'nothing changed since');
  /* A write in place of the same size: only the stamp's time tells it. */
  writeInPlace(at('a.txt'), 'zero\nONE\ntwo\nthree\n');
  fs.utimesSync(at('a.txt'), new Date(2001, 1, 1), new Date(2001, 1, 1));
  assert.equal(look(), 1);
  assert.equal(b.text, 'zero\nONE\ntwo\nthree\n');
  await keys('u');
  assert.equal(b.text, 'zero\none\ntwo\nthree\n', 'the revert is one undo step');
  assert.equal(b.modified, true, 'and undoing it leaves the buffer differing from its file');
  b.modified = false; L.call('kill-buffer', [b]);
});

test('a modified buffer is not touched; saving it over the changed file asks, n keeps the disk, y writes', async () => {
  const b = visit(at('m.txt'), 'mine\n');
  await keys('A'); await type(' edited'); await keys('ESC');
  assert.equal(b.modified, true);
  replace(at('m.txt'), 'theirs\n');
  assert.equal(look(), 0);
  assert.equal(b.text, 'mine edited\n', 'the edits stay');
  await keys(':'); await type('w'); await keys('RET');
  assert.ok(/changed on disk; save anyway\? \(y or n\)/.test(E.prompt || ''), `asks: ${E.prompt}`);
  await keys('n');
  assert.equal(fs.readFileSync(at('m.txt'), 'utf8'), 'theirs\n');
  assert.equal(b.modified, true);
  assert.match(Ed.getBuffer('*Messages*').text, /m\.txt not saved/);
  await keys('C-x C-s');
  assert.ok(/changed on disk/.test(E.prompt || ''), 'C-x C-s asks too');
  await keys('y');
  assert.equal(fs.readFileSync(at('m.txt'), 'utf8'), 'mine edited\n');
  assert.equal(b.modified, false);
  /* Saved: the buffer's own write is not another program's. */
  assert.equal(look(), 0);
  b.pt = 0; await keys('x'); await keys(':'); await type('w'); await keys('RET');
  assert.equal(E.prompt, null, 'no question');
  assert.equal(fs.readFileSync(at('m.txt'), 'utf8'), 'ine edited\n');
  L.call('kill-buffer', [b]);
});

test('a file gone from disk is no change: the buffer stays, saving makes the file again', async () => {
  const b = visit(at('g.txt'), 'gone\n');
  fs.rmSync(at('g.txt'));
  assert.equal(look(), 0);
  assert.equal(b.text, 'gone\n');
  await keys('x'); await keys(':'); await type('w'); await keys('RET');
  assert.equal(fs.readFileSync(at('g.txt'), 'utf8'), 'one\n');
  L.call('kill-buffer', [b]);
});

test('revert-buffer takes the stamp again: the next save does not ask', async () => {
  const b = visit(at('r.txt'), 'r\n');
  await keys('x');
  replace(at('r.txt'), 'outside\n');
  L.call('revert-buffer', []);
  assert.equal(b.text, 'outside\n');
  b.pt = 0; await keys('x'); await keys(':'); await type('w'); await keys('RET');
  assert.equal(E.prompt, null);
  assert.equal(fs.readFileSync(at('r.txt'), 'utf8'), 'utside\n');
  L.call('kill-buffer', [b]);
});

test('a --private session and the temporary directory are never looked at', async () => {
  host.private = true;
  try {
    stamps = 0;
    const b = visit(at('p.txt'), 'secret\n');
    replace(at('p.txt'), 'changed\n');
    assert.equal(look(), 0);
    assert.equal(b.text, 'secret\n');
    await keys('x'); await keys(':'); await type('w'); await keys('RET');
    assert.equal(E.prompt, null, 'saving does not ask: nothing was looked at');
    assert.equal(stamps, 0, 'no stat of a private buffer\'s file');
    b.modified = false; L.call('kill-buffer', [b]);
  } finally { host.private = false; }
  stamps = 0; statted.length = 0;
  const t = visit(path.join(TEMP, 'sops-edit.yaml'), 'key: plain\n');
  replace(path.join(TEMP, 'sops-edit.yaml'), 'key: other\n');
  assert.equal(look(), 0);
  assert.equal(t.text, 'key: plain\n');
  assert.equal(t.disk, undefined);
  assert.equal(statted.filter(p => p.startsWith(TEMP)).length, 0, 'no stat under the temporary directory');
  /* edwind's buffers are its own to follow (server/watch.mts): a shared buffer takes no stamp. */
  const s = visit(at('shared.md'), 'note\n');
  s.shared = true; Ed.noteDisk(s);
  assert.equal(s.disk, undefined);
  s.shared = false;
  for (const x of [t, s]) { x.modified = false; L.call('kill-buffer', [x]); }
});

test('with the mode off nothing follows the disk; on again, the timer looks every auto-revert-interval seconds', async () => {
  const b = visit(at('t.txt'), 'tick\n');
  ev('(global-auto-revert-mode 0)');
  replace(at('t.txt'), 'tock\n');
  assert.equal(look(), 0);
  assert.equal(b.text, 'tick\n');
  ev('(set! auto-revert-interval 1)');
  ev('(global-auto-revert-mode 1)');
  await new Promise(r => setTimeout(r, 1500));
  await Ed.whenIdle();
  assert.equal(b.text, 'tock\n');
  ev('(global-auto-revert-mode 0)');
  L.call('kill-buffer', [b]);
});

test('a version that cannot be read is tried once, and a save over it still asks', async () => {
  ev('(set! auto-revert-interval 3600)'); ev('(global-auto-revert-mode 1)');
  const b = visit(at('bin.txt'), 'text\n');
  fs.writeFileSync(at('bin.txt'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  reads = 0;
  assert.equal(look(), 0);
  assert.equal(look(), 0);
  assert.equal(reads, 1, 'one read for the one version');
  assert.equal(b.text, 'text\n');
  b.pt = 0; await keys('x'); await keys(':'); await type('w'); await keys('RET');
  assert.ok(/changed on disk/.test(E.prompt || ''), 'asks');
  await keys('n');
  assert.deepEqual([...fs.readFileSync(at('bin.txt'))], [0xff, 0xfe, 0x00, 0x80]);
  b.modified = false; L.call('kill-buffer', [b]);
});

test('a revert is never folded into an open insert session: the look waits, and a save over the change still asks', async () => {
  ev('(global-auto-revert-mode 1)');
  const b = visit(at('s.txt'), 'a\nb\n');
  await keys('j'); await keys('i');
  replace(at('s.txt'), 'z\na\nb\n');
  assert.equal(look(), 0, 'not while the insert session is open');
  assert.equal(b.text, 'a\nb\n');
  await type('X'); await keys('ESC');
  assert.equal(look(), 0, 'modified now: left as it is');
  await keys(':'); await type('w'); await keys('RET');
  assert.ok(/changed on disk/.test(E.prompt || ''), `asks: ${E.prompt}`);
  await keys('n');
  assert.equal(fs.readFileSync(at('s.txt'), 'utf8'), 'z\na\nb\n', 'the other program\'s line is kept');
  await keys('u');
  assert.deepEqual([b.text, b.modified], ['a\nb\n', false], 'one u takes back the typing only');
  assert.equal(look(), 1, 'unmodified again: the next look reverts');
  assert.equal(b.text, 'z\na\nb\n');
  /* Leaving insert state without typing: the next look reverts, and the revert is its own undo step. */
  await keys('i'); replace(at('s.txt'), 'y\nz\na\nb\n');
  assert.equal(look(), 0);
  await keys('ESC');
  assert.equal(look(), 1);
  await keys('i'); await type('X'); await keys('ESC'); await keys('u');
  assert.equal(b.text, 'y\nz\na\nb\n', 'one u takes back the typing only');
  b.modified = false; L.call('kill-buffer', [b]);
});

test('a revert is never folded into a command still reading its keys (an operator waiting for its motion)', async () => {
  const b = visit(at('o.txt'), 'a\nb\nc\n');
  await keys('d');
  replace(at('o.txt'), 'z\na\nb\nc\n');
  assert.equal(look(), 0, 'not while d waits for its motion');
  await keys('j');
  assert.equal(b.text, 'c\n');
  await keys(':'); await type('w'); await keys('RET');
  assert.ok(/changed on disk/.test(E.prompt || ''), `asks: ${E.prompt}`);
  await keys('n');
  assert.equal(fs.readFileSync(at('o.txt'), 'utf8'), 'z\na\nb\nc\n');
  await keys('u');
  assert.deepEqual([b.text, b.modified], ['a\nb\nc\n', false]);
  assert.equal(look(), 1);
  assert.equal(b.text, 'z\na\nb\nc\n');
  L.call('kill-buffer', [b]);
});

test('visiting takes the stamp before reading: a write between the read and the stat is seen by the next look', async () => {
  fs.writeFileSync(at('v.txt'), 'old\n');
  const read = files.read;
  /* Another program writes just after the visit has read the file. */
  files.read = (n: string) => { const t = read(n); if (resolve(n) === at('v.txt')) { files.read = read; replace(at('v.txt'), 'new\n'); } return t; };
  let b;
  try { b = L.call('find-file', [at('v.txt')]); } finally { files.read = read; }
  Ed.setWindowBuffer(b); E.current = b;
  assert.equal(b.text, 'old\n');
  assert.equal(look(), 1);
  assert.equal(b.text, 'new\n');
  L.call('kill-buffer', [b]);
});
