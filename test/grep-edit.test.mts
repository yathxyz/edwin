// Editing *grep* (src/compile.ts, grep-edit-mode): rg from PATH over a throwaway tree, the rows changed in the
// buffer and written back to their files with C-c C-c, and the refusals: a file changed since the search, a row
// line that is no longer what rg found, a visiting buffer with unsaved changes, a changed prefix, lines added; a
// changed line that is no row put back.
// Headless Edwin on the Node host, host.proc stood in by fake-proc.mts and host.files by a stand-in for
// host-native.ts's over the real directory (its read takes the byte order mark and an all-CRLF file's \r off, its
// write puts them back), each read, write, stamp and true name counted.
// Run: node --test test/grep-edit.test.mts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-grep-edit-')));
const T = path.join(root, 'tree');
after(() => { L.evalText('(global-auto-revert-mode 0)'); for (const id of proc.running()) proc.kill(id, 'KILL'); fs.rmSync(root, { recursive: true, force: true }); });

const resolve = (n: string) => (n.startsWith('/') ? path.normalize(n) : path.resolve(T, n));
/* ignoreBOM: the mark is kept, as the native readFile keeps it, for read to take off and note */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const writes: string[] = [];
let stampFor: ((p: string) => string | null) | null = null;
let truenames = 0, writeDelay = 0;
/* As host-native.ts keeps them: each file's line ends and byte order mark, from its last read. */
const shapes = new Map<string, { crlf: boolean; bom: boolean }>();
const realStamp = (p: string) => { try { const s = fs.statSync(p, { bigint: true }); return s.isDirectory() ? null : `${s.ino}:${s.mtimeNs}:${s.size}`; } catch (e) { return null; } };
const files = {
  resolve, get cwd() { return T; }, temp: [] as string[],
  truename: (n: string) => { truenames++; const p = resolve(n); try { return fs.realpathSync(p); } catch (e) { return p; } },
  label: (p: string) => (p.startsWith(T + '/') ? p.slice(T.length + 1) : p),
  /* as the native readFile, a file that is not UTF-8 throws; as host-native.ts's read, the shape is taken off */
  read(n: string) {
    const p = resolve(n);
    let bytes; try { bytes = fs.readFileSync(p); } catch (e) { return null; }
    let t = utf8.decode(bytes);
    const bom = t.charCodeAt(0) === 0xfeff;
    if (bom) t = t.slice(1);
    const crlf = t.includes('\r\n') && !/(^|[^\r])\n/.test(t);
    if (crlf) t = t.replace(/\r\n/g, '\n');
    shapes.set(p, { crlf, bom });
    return t;
  },
  /* as the native writeFile, a new file renamed over the old one; as host-native.ts's write, the shape put back */
  write(n: string, text: string) {
    const p = resolve(n), sh = shapes.get(p) || { crlf: false, bom: false };
    let t = text;
    if (sh.crlf) t = t.replace(/\n/g, '\r\n');
    if (sh.bom) t = '\ufeff' + t;
    writes.push(p); fs.writeFileSync(p + '.new', t); fs.renameSync(p + '.new', p);
    /* as a native write's fsync on a slow disk: the thread held for writeDelay ms */
    const end = performance.now() + writeDelay; while (performance.now() < end);
  },
  remove(n: string) { fs.rmSync(resolve(n), { force: true }); },
  list: () => [] as string[],
  exists: (n: string) => fs.existsSync(resolve(n)),
  stamp: (n: string) => (stampFor ? stampFor(resolve(n)) : realStamp(resolve(n))),
};

const proc = fakeProc();
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: unknown; dirs?: unknown };
host.proc = proc;
host.files = files;
host.dirs = { home: root, cwd: T, config: path.join(root, '.config/edwin'), state: path.join(root, '.local/state/edwin') };
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
/* A C-c C-c writes its files in slices across turns of the event loop: KEYS waits for the last one too. */
const writing = () => !!Ed.getBuffer('*grep*')?.grepEdit?.writing;
const written = async () => { const end = Date.now() + 20000; while (writing() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); await Ed.whenIdle(); };
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await Ed.whenIdle(); if (writing()) await written(); };
L.evalText('(set! corfu-auto #f)');
L.evalText('(set! auto-revert-interval 3600)');

const at = (p: string) => path.join(T, p);
/* A fresh tree: three files with rows, one CRLF, one with two rows; one with none. */
function tree() {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(path.join(T, 'src'), { recursive: true });
  fs.writeFileSync(at('alpha.txt'), 'first line\nold needle one\nmiddle\nold needle two\nlast\n');
  fs.writeFileSync(at('src/beta.rs'), 'fn main() {\n    let needle = 1;\n}\n');
  fs.writeFileSync(at('crlf.txt'), 'top\r\nneedle in crlf\r\nbottom\r\n');
  fs.writeFileSync(at('none.txt'), 'nothing here\n');
}
const bytes = (p: string) => fs.readFileSync(at(p), 'utf8');
const gbuf = () => Ed.getBuffer('*grep*');
const glines = (): string[] => gbuf().text.split('\n');
/* rg sorted by path: its order is not fixed otherwise. */
const CMD = 'rg -nSH --no-heading --column --sort=path needle';
async function grep(cmd = CMD) {
  Ed.deleteOtherWindows(); Ed.setWindowBuffer(Ed.getBufferCreate('*scratch-grep*'));
  const c = await Ed.compile.grep(cmd, T); await c.exit;
  Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer === gbuf()));
  assert.equal(E.current, gbuf());
}
/* The buffer line holding ROW (its prefix), from 0. */
const lineOf = (prefix: string) => { const i = glines().findIndex(l => l.startsWith(prefix)); assert.ok(i >= 0, `no row ${prefix}`); return i; };
/* Put TEXT in place of the row's text after PREFIX, as an edit of the buffer. */
function setRow(prefix: string, text: string) {
  const b = gbuf(), i = lineOf(prefix), start = glines().slice(0, i).reduce((n, l) => n + l.length + 1, 0) + prefix.length;
  const end = start + glines()[i].length - prefix.length;
  Ed.editText(b, start, end - start, text);
}

test('C-c C-p makes *grep* editable; C-c C-c writes the changed rows of three files, each in one write', async () => {
  tree(); await grep();
  const b = gbuf();
  assert.equal(b.readOnly, true);
  assert.deepEqual(glines().slice(4, 9), ['alpha.txt:2:5:old needle one', 'alpha.txt:4:5:old needle two', 'crlf.txt:2:1:needle in crlf', 'src/beta.rs:2:9:    let needle = 1;', '']);
  await keys('C-c C-p');
  assert.equal(b.readOnly, false); assert.equal(b.evilState, 'normal');
  assert.equal(Ed.localValue(b, 'grep-edit-enabled'), true); assert.equal(Ed.localValue(Ed.getBuffer('*scratch-grep*'), 'grep-edit-enabled'), false, 'the mode is the buffer\'s own');
  assert.match(E.echo, /^Editing \*grep\*/);
  /* One edit by Evil keys (the text of the first row, from its point on), the others in place. */
  b.pt = b.text.indexOf('old needle one'); await keys('c w'); for (const ch of 'new') Ed.feedKey(ch); await keys('<escape>');
  assert.equal(glines()[4], 'alpha.txt:2:5:new needle one');
  setRow('crlf.txt:2:1:', 'pin in crlf');
  setRow('src/beta.rs:2:9:', '    let pin = 2;');
  writes.length = 0;
  await keys('C-c C-c');
  assert.equal(E.echo, 'Wrote 3 lines in 3 files');
  assert.equal(bytes('alpha.txt'), 'first line\nnew needle one\nmiddle\nold needle two\nlast\n', 'only the changed line of alpha.txt');
  assert.equal(bytes('crlf.txt'), 'top\r\npin in crlf\r\nbottom\r\n', 'a CRLF line keeps its \\r');
  assert.equal(bytes('src/beta.rs'), 'fn main() {\n    let pin = 2;\n}\n');
  assert.equal(bytes('none.txt'), 'nothing here\n');
  assert.deepEqual(writes.sort(), [at('alpha.txt'), at('crlf.txt'), at('src/beta.rs')], 'one write per file, none for a file with no change');
  assert.equal(b.readOnly, true, 'read-only again'); assert.equal(b.evilState, 'motion'); assert.equal(b.modified, false);
  assert.equal(Ed.localValue(b, 'grep-edit-enabled'), false);
  assert.equal(glines()[6], 'crlf.txt:2:1:pin in crlf', 'the buffer shows what was written');
  /* The rows are lines, not offsets: after the shorter texts were written, editing again finds the same four,
     and the status line (`… at 2026-11-16 09:46:54, …`, shaped like FILE:LINE:) is none of them. */
  await keys('C-c C-p');
  assert.deepEqual(b.grepEdit.rows.map((r: { line: number; file: string; n: number }) => [r.line, r.file, r.n]),
    [[4, at('alpha.txt'), 2], [5, at('alpha.txt'), 4], [6, at('crlf.txt'), 2], [7, at('src/beta.rs'), 2]]);
  await keys('C-c C-k');
});

test('stamping the files of a grep as its rows come does not stall the frame', async () => {
  fs.rmSync(T, { recursive: true, force: true });
  for (let d = 0; d < 30; d++) {
    fs.mkdirSync(at(`d${d}`), { recursive: true });
    for (let i = 0; i < 100; i++) fs.writeFileSync(at(`d${d}/f${i}.txt`), 'a needle\n');
  }
  let stalled = 0, stamps = 0, last = Date.now();
  const tick = setInterval(() => { const now = Date.now(); stalled = Math.max(stalled, now - last); last = now; }, 5);
  /* envFor's look for an .envrc above the search stamps too: only the rows' files count */
  stampFor = (p: string) => { if (!p.endsWith('/.envrc')) stamps++; return realStamp(p); };
  try { await grep(); } finally { clearInterval(tick); stampFor = null; }
  assert.equal(stamps, 3000, 'each file once');
  assert.equal(gbuf().grepRows.stamps.size, 3000);
  assert.ok(stalled < 250, `the frame stalled ${stalled} ms`);
  console.log(`# 3000 files stamped as their rows came: the longest stall ${stalled} ms`);
});

test('a file changed since the search is refused and nothing of it is written; the others are; C-c C-k gives its rows back', async () => {
  tree(); await grep();
  await keys('C-c C-p');
  setRow('alpha.txt:2:5:', 'A1'); setRow('alpha.txt:4:5:', 'A2');
  setRow('crlf.txt:2:1:', 'C');
  setRow('src/beta.rs:2:9:', 'B');
  /* Another program changes alpha.txt after the search, on a line no row names: only the stamp can tell. */
  const stale = 'first line changed\nold needle one\nmiddle\nold needle two\nlast\n';
  fs.writeFileSync(at('alpha.txt'), stale);
  writes.length = 0;
  await keys('C-c C-c');
  assert.equal(bytes('alpha.txt'), stale, 'the stale file is as the other program left it');
  assert.ok(!writes.includes(at('alpha.txt')), 'no write reached it');
  assert.equal(bytes('crlf.txt'), 'top\r\nC\r\nbottom\r\n');
  assert.equal(bytes('src/beta.rs'), 'fn main() {\nB\n}\n');
  assert.equal(E.echo, 'Wrote 2 lines in 2 files; not written: alpha.txt: it changed since the search');
  const b = gbuf();
  assert.equal(b.readOnly, false, 'still editing: the refused rows keep their edits');
  assert.equal(glines()[4], 'alpha.txt:2:5:A1');
  /* A second C-c C-c refuses it again: the stamp is still not the search's. */
  writes.length = 0;
  await keys('C-c C-c');
  assert.equal(E.echo, 'Wrote 0 lines in 0 files; not written: alpha.txt: it changed since the search');
  assert.deepEqual(writes, []);
  await keys('C-c C-k');
  assert.equal(E.echo, 'Edits in *grep* given up');
  assert.deepEqual(glines().slice(4, 8), ['alpha.txt:2:5:old needle one', 'alpha.txt:4:5:old needle two', 'crlf.txt:2:1:C', 'src/beta.rs:2:9:B'], 'the refused rows show the search\'s text, the written ones what was written');
  assert.equal(b.readOnly, true); assert.equal(b.modified, false);
  assert.equal(bytes('alpha.txt'), stale);
});

test('without a changed stamp, a row whose line no longer holds what rg found refuses its file', async () => {
  /* Lines drift: one inserted above the rows of alpha.txt. The stamp is blind from the search on, so only the
     text can tell. */
  stampFor = () => 'same';
  try {
    tree(); await grep();
    await keys('C-c C-p');
    setRow('alpha.txt:4:5:', 'changed');
    setRow('src/beta.rs:2:9:', 'B');
    const drifted = 'inserted\nfirst line\nold needle one\nmiddle\nold needle two\nlast\n';
    fs.writeFileSync(at('alpha.txt'), drifted);
    writes.length = 0;
    await keys('C-c C-c');
    assert.equal(bytes('alpha.txt'), drifted);
    assert.ok(!writes.includes(at('alpha.txt')));
    assert.equal(E.echo, 'Wrote 1 line in 1 file; not written: alpha.txt: its line 2 is not what the search found');
  } finally { stampFor = null; await keys('C-c C-k'); }
});

test('a buffer visiting the file with unsaved changes refuses it; an unmodified one takes the new text', async () => {
  tree();
  const beta = L.call('find-file', [at('src/beta.rs')]), alpha = L.call('find-file', [at('alpha.txt')]);
  try {
  beta.pt = 0; Ed.insertText(beta, '// mine\n');
  assert.equal(beta.modified, true);
  await grep();
  await keys('C-c C-p');
  setRow('alpha.txt:2:5:', 'A');
  setRow('src/beta.rs:2:9:', 'B');
  await keys('C-c C-c');
  assert.equal(E.echo, `Wrote 1 line in 1 file; not written: src/beta.rs: ${at('src/beta.rs')} has unsaved changes to it`);
  assert.equal(bytes('src/beta.rs'), 'fn main() {\n    let needle = 1;\n}\n');
  assert.equal(alpha.text, 'first line\nA\nmiddle\nold needle two\nlast\n', 'the visiting buffer follows');
  assert.equal(alpha.modified, false);
  await keys('C-c C-k');
  /* Its stamp is the write's: saving it does not ask about a change on disk. */
  E.current = alpha; alpha.pt = 0; Ed.insertText(alpha, 'x'); L.call('save-buffer', []);
  assert.match(E.echo, /^Wrote /);
  assert.equal(bytes('alpha.txt'), 'xfirst line\nA\nmiddle\nold needle two\nlast\n');
  } finally { for (const b of [alpha, beta]) { b.modified = false; L.call('kill-buffer', [b]); } }
});

test('lines added refuse the whole write; a changed prefix refuses its file; a changed line that is no row is put back', async () => {
  tree(); await grep();
  await keys('C-c C-p');
  const b = gbuf();
  setRow('src/beta.rs:2:9:', 'B');
  const before = b.text;
  const i = b.text.indexOf('crlf.txt'); Ed.editText(b, i, 0, 'extra\n');
  writes.length = 0;
  await keys('C-c C-c');
  assert.match(E.echo, /^Lines were added to \*grep\* or taken from it/);
  assert.deepEqual(writes, [], 'nothing written');
  assert.equal(b.readOnly, false, 'still editing');
  Ed.applyLineDiff(b, before);
  /* The prefix of alpha.txt's first row and the header's first line changed: alpha.txt is refused, the header
     put back, and src/beta.rs written. */
  setRow('alpha.txt:4:5:', 'A2');
  const a = b.text.indexOf('alpha.txt:2:5:'); Ed.editText(b, a + 10, 1, '9');
  Ed.editText(b, 0, 3, '!!!');
  await keys('C-c C-c');
  assert.equal(E.echo, 'Wrote 1 line in 1 file; 1 changed line that is no row put back; not written: alpha.txt: its row on line 5 of *grep* had its alpha.txt:2:5: changed');
  assert.deepEqual(writes, [at('src/beta.rs')]);
  assert.equal(bytes('src/beta.rs'), 'fn main() {\nB\n}\n');
  assert.equal(bytes('alpha.txt'), 'first line\nold needle one\nmiddle\nold needle two\nlast\n');
  assert.ok(glines()[0].startsWith('-*- mode: grep'), 'the header is back');
  assert.equal(glines()[4], 'alpha.txt:9:5:old needle one', 'the refused row keeps its edit');
  assert.equal(b.readOnly, false, 'still editing');
  await keys('C-c C-k');
});

test(':%s over all of *grep* writes every row; the command line holding the pattern is put back; a file named by the pattern is refused alone', async () => {
  tree();
  fs.writeFileSync(at('needle.txt'), 'a needle here\n');
  await grep();
  const b = gbuf(), command = glines()[3], status = glines().slice(9);
  assert.equal(command, CMD);
  await keys('C-c C-p');
  writes.length = 0;
  await keys(':'); for (const ch of '%s/needle/pin/g') Ed.feedKey(ch); await keys('<return>');
  assert.equal(glines()[3], CMD.replace('needle', 'pin'), 'the substitution reached the command line');
  await keys('C-c C-c');
  assert.equal(E.echo, 'Wrote 4 lines in 3 files; 1 changed line that is no row put back; not written: needle.txt: its row on line 8 of *grep* had its needle.txt:1:3: changed');
  assert.equal(bytes('alpha.txt'), 'first line\nold pin one\nmiddle\nold pin two\nlast\n');
  assert.equal(bytes('crlf.txt'), 'top\r\npin in crlf\r\nbottom\r\n');
  assert.equal(bytes('src/beta.rs'), 'fn main() {\n    let pin = 1;\n}\n');
  assert.equal(bytes('needle.txt'), 'a needle here\n');
  assert.deepEqual(writes.sort(), [at('alpha.txt'), at('crlf.txt'), at('src/beta.rs')]);
  assert.equal(glines()[3], command, 'the command line is as the grep ran it');
  assert.deepEqual(glines().slice(9), status, 'and so is the status line');
  assert.equal(b.readOnly, false, 'still editing: needle.txt\'s row');
  await keys('C-c C-k');
  assert.equal(glines()[7], 'needle.txt:1:3:a needle here');
});

test('outside Evil, C-c C-p, typing and C-c C-c write the row; Emacs state stays Emacs state', async () => {
  tree(); await grep();
  const b = gbuf();
  L.call('evil-mode', []);
  try {
    assert.equal(E.evil, false);
    await keys('C-c C-p');
    assert.equal(b.readOnly, false);
    b.pt = b.text.indexOf('    let needle') + 4;
    for (const ch of 'mut') Ed.feedKey(ch);
    await keys('SPC');
    await Ed.whenIdle();
    await keys('C-c C-c');
    assert.equal(E.echo, 'Wrote 1 line in 1 file');
    assert.equal(bytes('src/beta.rs'), 'fn main() {\n    mut let needle = 1;\n}\n');
  } finally { L.call('evil-mode', []); }
  assert.equal(E.evil, true);
  L.call('evil-emacs-state', []);
  await keys('C-c C-p');
  assert.equal(b.evilState, 'emacs');
  await keys('C-c C-k');
  assert.equal(b.evilState, 'emacs');
});

test('one map of true names per C-c C-c: writing 200 files with 50 visiting buffers open', async () => {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(T, { recursive: true });
  for (let i = 0; i < 200; i++) fs.writeFileSync(at(`f${String(i).padStart(3, '0')}.txt`), 'a needle\n');
  for (let i = 0; i < 50; i++) fs.writeFileSync(at(`v${i}.txt`), 'visited\n');
  const visiting = Array.from({ length: 50 }, (_, i) => L.call('find-file', [at(`v${i}.txt`)]));
  try {
    await grep();
    await keys('C-c C-p');
    const b = gbuf(); Ed.applyLineDiff(b, b.text.split('\n').map((l: string) => (/^f\d+\.txt:/.test(l) ? l.replace('needle', 'pin') : l)).join('\n'));
    truenames = 0;
    await keys('C-c C-c');
    assert.equal(E.echo, 'Wrote 200 lines in 200 files');
    assert.equal(bytes('f199.txt'), 'a pin\n');
    assert.ok(truenames <= 200 + 50, `${truenames} true names for 200 files and 50 buffers`);
  } finally { for (const v of visiting) L.call('kill-buffer', [v]); }
});

test('a file of mixed line ends keeps its \\r on the CRLF line written; a byte order mark is kept', async () => {
  tree();
  fs.writeFileSync(at('mixed.txt'), 'lf\nneedle crlf\r\nneedle lf\n');
  fs.writeFileSync(at('bom.txt'), '﻿needle first\nsecond\n');
  await grep(`${CMD} mixed.txt bom.txt`);
  await keys('C-c C-p');
  setRow('mixed.txt:2:1:', 'pin crlf'); setRow('mixed.txt:3:1:', 'pin lf');
  const bomRow = glines().find(l => l.startsWith('bom.txt:1:'))!;
  setRow(bomRow.slice(0, bomRow.indexOf('needle')), 'pin first');
  await keys('C-c C-c');
  assert.equal(E.echo, 'Wrote 3 lines in 2 files');
  assert.equal(bytes('mixed.txt'), 'lf\npin crlf\r\npin lf\n');
  assert.equal(bytes('bom.txt'), '﻿pin first\nsecond\n');
});

test('no editing while the grep runs, nor in *compilation*; C-c C-c with no change writes nothing', async () => {
  tree();
  Ed.deleteOtherWindows(); Ed.setWindowBuffer(Ed.getBufferCreate('*scratch-grep*'));
  const c = await Ed.compile.grep(`sleep 0.5; ${CMD}`, T);
  E.current = gbuf();
  await assert.rejects(Promise.resolve().then(() => L.call('grep-change-to-grep-edit-mode', [])), (e: unknown) => /still running/.test(Ed.errorText(e)));
  assert.equal(gbuf().readOnly, true);
  await c.exit;
  const k = await Ed.compile.start('true', T); await k.exit;
  E.current = Ed.getBuffer('*compilation*');
  assert.throws(() => L.call('grep-change-to-grep-edit-mode', []), (e: unknown) => /Not a grep's output/.test(Ed.errorText(e)));
  await grep();
  await keys('C-c C-p'); writes.length = 0;
  await keys('C-c C-c');
  assert.equal(E.echo, '(No changes to write)'); assert.deepEqual(writes, []); assert.equal(gbuf().readOnly, true);
});

test('rg --vimgrep rows of one line: one changed is written, two changed differently refuse the file', async () => {
  tree();
  fs.writeFileSync(at('alpha.txt'), 'needle and needle\n');
  await grep('rg --vimgrep --sort=path needle alpha.txt');
  assert.deepEqual(glines().slice(4, 6), ['alpha.txt:1:1:needle and needle', 'alpha.txt:1:12:needle and needle']);
  await keys('C-c C-p');
  setRow('alpha.txt:1:1:', 'pin and needle'); setRow('alpha.txt:1:12:', 'needle and pin');
  await keys('C-c C-c');
  assert.equal(E.echo, 'Wrote 0 lines in 0 files; not written: alpha.txt: two rows of its line 1 were changed to different texts');
  assert.equal(bytes('alpha.txt'), 'needle and needle\n');
  setRow('alpha.txt:1:12:', 'needle and needle');
  await keys('C-c C-c');
  assert.equal(E.echo, 'Wrote 1 line in 1 file');
  assert.equal(bytes('alpha.txt'), 'pin and needle\n');
  assert.deepEqual(glines().slice(4, 6), ['alpha.txt:1:1:pin and needle', 'alpha.txt:1:12:pin and needle'], 'the other row of the line shows the written text');
});

test('a file that is not UTF-8 is refused; a new grep while editing asks before it drops the edits', async () => {
  tree();
  fs.writeFileSync(at('latin.txt'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x20, 0xe9, 0x0a]));
  await grep('rg -nSH --no-heading --column needle latin.txt');
  await keys('C-c C-p');
  setRow('latin.txt:1:1:', 'needle e');
  await keys('C-c C-c');
  assert.match(E.echo, /^Wrote 0 lines in 0 files; not written: latin\.txt: it cannot be read/);
  assert.deepEqual([...fs.readFileSync(at('latin.txt'))], [0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x20, 0xe9, 0x0a]);
  /* g r in *grep* while it holds edits: n keeps them, y runs the grep again and drops them. */
  const n = proc.calls.length;
  await keys('<escape>'); await keys('C-c C-p');
  Ed.feedKey('g'); Ed.feedKey('r'); await Ed.whenIdle(); await keys('n');
  assert.equal(proc.calls.length, n, 'no grep ran');
  assert.match(E.echo, /The edits in \*grep\* are kept/);
  assert.equal(glines()[4], 'latin.txt:1:1:needle e');
  Ed.feedKey('g'); Ed.feedKey('r'); await Ed.whenIdle(); await keys('y');
  await Ed.whenIdle();
  const end = Date.now() + 5000; while (Ed.compile.grepping() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  assert.equal(proc.calls.length, n + 1);
  assert.equal(gbuf().readOnly, true); assert.equal(gbuf().grepEdit, undefined);
});

test('C-c C-c over many slow files writes them in slices: the frame is never held long, and *grep* is read-only until the last', async () => {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(T, { recursive: true });
  const N = 600;
  for (let i = 0; i < N; i++) fs.writeFileSync(at(`f${String(i).padStart(3, '0')}.txt`), 'a needle\n');
  await grep();
  await keys('C-c C-p');
  const b = gbuf(); Ed.applyLineDiff(b, b.text.split('\n').map((l: string) => (/^f\d+\.txt:/.test(l) ? l.replace('needle', 'pin') : l)).join('\n'));
  /* Each write as slow as an fsync on a slow disk: all of them together take well over the frame deadline. */
  writeDelay = 3; writes.length = 0;
  let stalled = 0, last = Date.now();
  const tick = setInterval(() => { const now = Date.now(); stalled = Math.max(stalled, now - last); last = now; }, 5);
  const began = Date.now();
  try {
    for (const k of Ed.kbd('C-c C-c').split(' ')) Ed.feedKey(k); await Ed.whenIdle();
    assert.ok(b.grepEdit && b.grepEdit.writing, 'the command returned before the last slice');
    assert.match(E.echo, /^Writing the rows of \*grep\*: \d+ of 600 files$/);
    assert.ok(b.readOnly, '*grep* is read-only while its rows are written');
    assert.equal(b.evilState, 'motion');
    assert.throws(() => L.call('grep-edit-finish', []), (e: unknown) => /being written/.test(Ed.errorText(e)));
    assert.throws(() => L.call('grep-edit-abort', []), (e: unknown) => /being written/.test(Ed.errorText(e)));
    const n = proc.calls.length; Ed.feedKey('g'); Ed.feedKey('r'); await Ed.whenIdle();
    assert.equal(proc.calls.length, n, 'no grep ran'); assert.match(E.echo, /being written/);
    await written();
  } finally { clearInterval(tick); writeDelay = 0; }
  const took = Date.now() - began;
  assert.ok(took >= 1500, `the whole write took only ${took} ms: the stall meter saw no long write`);
  assert.ok(stalled < 250, `the frame stalled ${stalled} ms`);
  assert.equal(writes.length, N, 'each file once');
  assert.equal(E.echo, `Wrote ${N} lines in ${N} files`);
  assert.equal(bytes('f000.txt'), 'a pin\n'); assert.equal(bytes('f599.txt'), 'a pin\n');
  assert.ok(!b.grepEdit && b.readOnly, 'read-only, the editing over');
  console.log(`# ${N} files of ${took} ms written in slices: the longest stall ${stalled} ms`);
});
