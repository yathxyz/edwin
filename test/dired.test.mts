// Dired and find-file's path reading (src/dired.ts) in a served Edwin against a real edwind (server/fs.mts):
// the listing, walking a tree, the marks, delete, rename, copy and mkdir with their questions, and the path
// completed a name at a time in the minibuffer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeDir, startEdwind, stopEdwind } from './edit-client.mts';
import type { TestDir, EdwindChild } from './edit-client.mts';

type EdwinCore = any; // any: Edwin's core (src) is outside this program's types

const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.cts');

let dir: TestDir, child: EdwindChild, Ed: EdwinCore, E: EdwinCore, L: EdwinCore, sync: EdwinCore;
const at = (p: string) => path.join(dir.dirs.home, p);
const put = (p: string, text = 'x\n') => { fs.mkdirSync(path.dirname(at(p)), { recursive: true }); fs.writeFileSync(at(p), text); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => unknown, what = 'condition', ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(10); } }
/* A WebSocket-like object over the unix socket, as frame.test.mts has it. */
function transport(sockPath: string) {
  return () => {
    const s = net.connect(sockPath); s.setEncoding('utf8');
    const ws: { onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null; onclose: (() => void) | null; onerror: ((e: Error) => void) | null; send(str: string): void; close(): void } =
      { onopen: null, onmessage: null, onclose: null, onerror: null, send: str => { s.write(str + '\n'); }, close: () => s.destroy() };
    let buf = '';
    s.on('connect', () => ws.onopen && ws.onopen());
    s.on('data', d => { buf += d; let i: number; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line && ws.onmessage) ws.onmessage({ data: line }); } });
    s.on('close', () => ws.onclose && ws.onclose());
    s.on('error', e => ws.onerror && ws.onerror(e));
    return ws;
  };
}
const feed = async (ks: string[]) => { for (const k of ks) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = (s: string) => feed(Ed.kbd(s).split(' '));
const type = (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const messages = (): string => Ed.getBuffer('*Messages*').text;
const cur = () => E.current;
/* The listing as [mark, name] of each entry line, and the name point is on. */
const NAME = 38;
const rows = (): [string, string][] => cur().text.split('\n').slice(1, -1).map((l: string) => [l[0], l.slice(NAME)]);
const names = () => rows().map(r => r[1]);
const here = () => { const b = cur(), ln = Ed.lineNoB(b, b.pt); return b.text.split('\n')[ln - 1].slice(NAME); };
const goTo = (name: string) => { const b = cur(), i = names().indexOf(name); assert.ok(i >= 0, `${name} is listed: ${names()}`); b.pt = Ed.lineStartB(b, i + 2) + NAME; };
/* Open dired on ~/P from wherever: the path typed after the offered directory starts again at ~. */
async function dired(p: string) { E.current = Ed.getBuffer('*scratch*'); Ed.setWindowBuffer(E.current); await keys('SPC f d'); assert.ok(E.mini, 'the minibuffer asks for a directory'); await type(`~/${p}/`); await keys('RET'); }

before(async () => {
  dir = makeDir();
  for (const d of ['.ssh', 'tree/sub/deep', 'tree/empty', 'tree/Zed']) fs.mkdirSync(at(d), { recursive: true });
  put('.ssh/authorized_keys', 'key\n'); put('tree/b.md', 'bee\n'); put('tree/a.md', 'ay\n'); put('tree/.hidden'); put('tree/sub/in.md', 'inside\n'); put('tree/sub/deep/d.md');
  fs.symlinkSync('a.md', at('tree/link')); fs.symlinkSync('sub', at('tree/sublink'));
  fs.writeFileSync(path.join(dir.dirs.notes, 'note.md'), 'a note\n');
  child = await startEdwind(dir);
  const host = createHost({ storage: memoryStorage(), workers: false });
  Ed = loadEdwin(host); E = Ed.E; L = (globalThis as unknown as { L: EdwinCore }).L;
  sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'dired-test' });
  await Ed.whenIdle();
});
after(async () => { if (sync) sync.shutdown(); if (child) await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

test('SPC f d reads a directory, offering the notes directory; the listing has directories first and point on a name', async () => {
  E.current = Ed.getBuffer('*scratch*'); Ed.setWindowBuffer(E.current);
  await keys('SPC f d');
  assert.equal(E.minibuf.text, fs.realpathSync(dir.dirs.notes) + '/', 'a buffer with no file starts in the notes directory');
  assert.deepEqual(Ed.miniCandidates(), ['note.md']);
  await type('~/tree/'); await keys('RET');
  const b = cur();
  assert.equal(b.mode, 'dired-mode'); assert.equal(b.name, '~/tree/'); assert.equal(b.readOnly, true); assert.equal(b.evilState, 'motion');
  const lines = b.text.split('\n');
  assert.equal(lines[0], '  ~/tree:');
  assert.deepEqual(names(), ['empty', 'sub', 'sublink -> sub', 'Zed', '.hidden', 'a.md', 'b.md', 'link -> a.md']);
  assert.match(lines[1], /^  drwx[r-][w-][x-][r-][w-][x-] +[\d.]+k? \d{4}-\d\d-\d\d \d\d:\d\d empty$/);
  assert.match(lines[6], /^  -rw-[r-][w-]-[r-]-- +3 \d{4}-\d\d-\d\d \d\d:\d\d a\.md$/);
  assert.equal(lines[8][2], 'l');
  assert.equal(here(), 'empty', 'point starts on the first name');
  await keys('j'); assert.equal(here(), 'sub', 'j keeps the name column');
  // The faces: the header, the details dimmed, a directory, a link.
  const lex = Ed.hooks.lexSeg(b, 0, b.text.length, b.text), face = (line: number, col: number) => lex.names[lex.cls[Ed.lineStartB(b, line) + col]];
  assert.deepEqual([face(1, 2), face(2, 5), face(2, NAME), face(7, NAME), face(9, NAME), face(9, NAME + 5)], ['dired-header', 'dired-dim', 'dired-dir', '', 'dired-link', 'dired-dim']);
});

test('RET enters a directory and opens a file; - goes up to the directory left; one listing stays behind', async () => {
  await dired('tree');
  goTo('sub'); await keys('RET');
  assert.equal(cur().name, '~/tree/sub/'); assert.deepEqual(names(), ['deep', 'in.md']);
  assert.equal(Ed.getBuffer('~/tree/'), null, 'the listing left is gone');
  await keys('-');
  assert.equal(cur().name, '~/tree/'); assert.equal(here(), 'sub');
  goTo('sublink -> sub'); await keys('RET');
  assert.equal(cur().name, '~/tree/sub/', 'a link to a directory lists what it leads to');
  goTo('in.md'); await keys('RET');
  await until(() => cur().file === fs.realpathSync(at('tree/sub/in.md')), 'the file is visited');
  assert.equal(cur().text, 'inside\n'); assert.equal(cur().shared, true);
  // From a file, dired-jump lists its directory with point on it; q leaves the listing.
  await Ed.callInteractively(L.intern('dired-jump'));
  assert.equal(cur().name, '~/tree/sub/'); assert.equal(here(), 'in.md');
  await keys('q');
  assert.equal(cur().text, 'inside\n');
});

test('m, d, u, t and U mark; Y copies the paths of the marked files or of the one at point', async () => {
  await dired('tree');
  goTo('a.md'); await keys('m'); assert.equal(here(), 'b.md', 'a mark moves down');
  await keys('d');
  goTo('empty'); await keys('m k u');
  assert.deepEqual(rows().filter(r => r[0] !== ' '), [['*', 'a.md'], ['D', 'b.md']]);
  const b = cur(), lex = Ed.hooks.lexSeg(b, 0, b.text.length, b.text), face = (name: string, col: number) => lex.names[lex.cls[Ed.lineStartB(b, names().indexOf(name) + 2) + col]];
  assert.deepEqual([face('a.md', 0), face('a.md', NAME), face('b.md', 0), face('b.md', NAME)], ['dired-mark', 'dired-marked', 'dired-flag', 'dired-flagged']);
  await keys('Y'); assert.equal(E.killRing[0], fs.realpathSync(at('tree')) + '/a.md');
  await keys('t');
  assert.deepEqual(rows().filter(r => r[0] === '*').map(r => r[1]), ['empty', 'sub', 'sublink -> sub', 'Zed', '.hidden', 'link -> a.md'], 't flips the marks and leaves the flag');
  await keys('U'); assert.ok(rows().every(r => r[0] === ' '));
  goTo('Zed'); await keys('Y'); assert.equal(E.killRing[0], fs.realpathSync(at('tree')) + '/Zed');
});

test('D deletes after y; a directory that is not empty takes a typed yes; d and x delete the flagged files', async () => {
  put('rm/one.md'); put('rm/two.md'); put('rm/three.md'); put('rm/full/in.md'); put('rm/keep/in.md');
  await dired('rm');
  goTo('one.md'); await keys('D');
  await type('n'); assert.ok(fs.existsSync(at('rm/one.md')), 'n deletes nothing');
  await keys('D'); await type('y');
  assert.equal(fs.existsSync(at('rm/one.md')), false); assert.deepEqual(names(), ['full', 'keep', 'three.md', 'two.md']);
  goTo('three.md'); await keys('d d'); assert.deepEqual(rows().filter(r => r[0] === 'D').map(r => r[1]), ['three.md', 'two.md']);
  await keys('x'); await type('y');
  assert.deepEqual(names(), ['full', 'keep']); assert.deepEqual(fs.readdirSync(at('rm')).sort(), ['full', 'keep']);
  goTo('keep'); await keys('D'); await type('y');
  assert.match(E.mini.prompt, /keep is not empty/); await type('no\n');
  assert.ok(fs.existsSync(at('rm/keep/in.md')), 'anything but yes keeps the directory');
  goTo('full'); await keys('D'); await type('y'); await type('yes\n');
  assert.equal(fs.existsSync(at('rm/full')), false); assert.deepEqual(names(), ['keep']);
  assert.match(messages(), /Deleted 1 of 1/);
});

test('R renames the file at point and an open buffer follows; with marks R and C go into a directory; + makes one', async () => {
  put('mv/a.md', 'ay\n'); put('mv/b.md', 'bee\n'); put('mv/c.md');
  await dired('mv');
  // An open buffer of a.md follows the rename.
  goTo('a.md'); await keys('RET'); await until(() => cur().text === 'ay\n', 'a.md is open');
  const fileBuf = cur();
  await dired('mv');
  goTo('a.md'); await keys('R');
  assert.match(E.mini.prompt, /^Rename a\.md to: /); assert.equal(E.minibuf.text, '~/mv/');
  await type('renamed.md'); await keys('RET');
  assert.deepEqual(fs.readdirSync(at('mv')).sort(), ['b.md', 'c.md', 'renamed.md']);
  assert.equal(here(), 'renamed.md', 'point follows the new name');
  await until(() => fileBuf.file === fs.realpathSync(at('mv')) + '/renamed.md', 'the buffer is re-keyed');
  // Nothing is overwritten: the refusal is edwind's.
  await keys('R'); await type('b.md'); await keys('M-RET');
  assert.match(messages(), /destination exists/); assert.equal(fs.readFileSync(at('mv/b.md'), 'utf8'), 'bee\n');
  await keys('+'); assert.match(E.mini.prompt, /^Create directory: /); await type('into/deeper'); await keys('RET');
  assert.ok(fs.statSync(at('mv/into/deeper')).isDirectory()); assert.equal(here(), 'into');
  goTo('b.md'); await keys('m m'); // b.md and c.md
  await keys('C'); assert.match(E.mini.prompt, /^Copy 2 files to directory: /); await type('into/'); await keys('RET');
  assert.deepEqual(fs.readdirSync(at('mv/into')).sort(), ['b.md', 'c.md', 'deeper']); assert.ok(fs.existsSync(at('mv/b.md')));
  await keys('R'); await type('renamed.md'); await keys('M-RET');
  assert.match(messages(), /renamed\.md is not a directory/);
  await keys('R'); await type('into/dee'); await until(() => Ed.miniCandidates().includes('deeper/'), 'the candidates of into/'); await keys('RET');
  assert.deepEqual(fs.readdirSync(at('mv/into/deeper')).sort(), ['b.md', 'c.md']); assert.deepEqual(names(), ['into', 'renamed.md']);
});

test('find-file reads a path a name at a time: TAB takes a directory, RET a file; a directory opens as a listing', async () => {
  await dired('tree'); goTo('a.md'); await keys('RET'); await until(() => cur().text === 'ay\n', 'a.md is open');
  await keys('SPC f f');
  assert.equal(E.mini.prompt, 'Find file: '); assert.equal(E.minibuf.text, '~/tree/', 'the directory of the current file is offered');
  assert.deepEqual(Ed.miniCandidates(), ['empty/', 'sub/', 'sublink/', 'Zed/', 'a.md', 'b.md', 'link', '.hidden'], 'directories first, dot files last');
  assert.equal(E.mini.index, -1, 'nothing is highlighted while only the directory is typed');
  await type('su'); assert.deepEqual(Ed.miniCandidates(), ['sub/', 'sublink/']);
  await keys('TAB'); assert.equal(E.minibuf.text, '~/tree/sub', 'TAB completes what the candidates share');
  await keys('TAB'); assert.equal(E.minibuf.text, '~/tree/sub/', 'and then takes the highlighted one');
  await until(() => Ed.miniCandidates().length === 2, 'the names of sub/');
  assert.deepEqual(Ed.miniCandidates(), ['deep/', 'in.md']);
  await type('in'); await keys('RET');
  await until(() => cur().file === fs.realpathSync(at('tree/sub/in.md')), 'in.md is visited');
  // RET with only a directory typed lists it.
  await keys('SPC f f'); assert.equal(E.minibuf.text, '~/tree/sub/'); await keys('RET');
  assert.equal(cur().mode, 'dired-mode'); assert.equal(cur().name, '~/tree/sub/');
  // A new name makes a new file there; // starts again at the root, as in Emacs.
  await keys('SPC f f'); await type('new.md'); await keys('RET');
  await until(() => cur().id === '~/tree/sub/new.md' || cur().file === fs.realpathSync(at('tree/sub')) + '/new.md', 'a new file is visited');
  await keys('SPC f f'); await type('/' + fs.realpathSync(at('tree')) + '/b'); await until(() => Ed.miniCandidates().length, 'the names of tree/'); assert.deepEqual(Ed.miniCandidates(), ['b.md', 'sub/', 'sublink/'], 'a name that starts with the input sorts first'); await keys('RET');
  await until(() => cur().text === 'bee\n', 'b.md is visited');
  // From Scheme, a directory name without the slash is still a listing.
  await L.call('find-file', ['~/tree/Zed']);
  assert.equal(cur().name, '~/tree/Zed/'); assert.deepEqual(names(), []);
});

test('what edwind refuses stays refused: no listing of ~/.ssh, no delete of the notes directory', async () => {
  const before = E.buffers.length;
  await dired('.ssh');
  assert.match(messages(), /\.ssh: refused/); assert.equal(E.buffers.length, before); assert.notEqual(cur().mode, 'dired-mode');
  await dired('.');
  assert.ok(names().includes('.ssh'), 'the home directory lists, and names it');
  goTo('.ssh'); await keys('RET'); assert.equal(cur().name, '~/', 'entering it is refused');
  goTo('.ssh'); await keys('D'); await type('y');
  assert.ok(fs.existsSync(at('.ssh/authorized_keys'))); assert.match(messages(), /\.ssh: refused/);
});

test('a note starts find-file and dired-jump in its own directory under the notes', async () => {
  fs.mkdirSync(path.join(dir.dirs.notes, 'area'), { recursive: true });
  fs.writeFileSync(path.join(dir.dirs.notes, 'area', 'deep.md'), 'deep\n');
  fs.writeFileSync(path.join(dir.dirs.notes, 'area', 'next.md'), 'next\n');
  await Ed.visit('area/deep.md');
  await until(() => cur().id === 'area/deep.md' && cur().text === 'deep\n', 'the note');
  const area = path.join(fs.realpathSync(dir.dirs.notes), 'area');
  await keys('SPC f f');
  assert.equal(E.minibuf.text, area + '/');
  await until(() => Ed.miniCandidates().length === 2, 'the names of the note\'s directory');
  assert.deepEqual(Ed.miniCandidates(), ['deep.md', 'next.md']);
  await type('next.md'); await keys('RET');
  await until(() => cur().id === 'area/next.md', 'the note beside it');
  await keys('C-x C-j');
  await until(() => cur().mode === 'dired-mode', 'the listing');
  assert.equal(cur().dired.dir, area);
  assert.equal(here(), 'next.md');
});
