// Workspace edits and rename (src/lsp.ts): eglot-rename against a stand-in server that is a real child through
// Ed.proc (fake-proc.mts). It answers textDocument/rename with what the suite wrote in its answers file (a
// result, an error), a version of "@" put back as the version it was last told of that document (didOpen or
// didChange), "@-1" one less, and a delay (ms) sends the answer that much later, filled when asked; it logs every
// message and keeps each document's text. Then nil from nixpkgs (when EDWIN_LSP_REAL names it) renaming a binding.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

const proc = fakeProc();
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: { truename: (p: string) => string; [k: string]: unknown } };
host.proc = proc;
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
L.evalText('(set! corfu-auto #f)');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-rename-')));
host.files = {
  cwd: tmp, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(tmp, p),
  read: (p: string) => { if (!fs.existsSync(p)) return null; if (fs.statSync(p).isDirectory()) throw new Error('is a directory'); return fs.readFileSync(p, 'utf8'); },
  write: (p: string, v: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); },
  remove: (p: string) => { fs.rmSync(p, { force: true }); },
  list: () => [] as string[], truename: (p: string) => { try { return fs.realpathSync(p); } catch { return p; } }, label: (p: string) => p, temp: [] as string[],
};
L.evalText(`(define-language fake-mode "Fake" :files '("\\\\.fake$"))`);
after(async () => {
  await Ed.lsp.shutdownAll();
  for (const id of proc.running()) proc.kill(id, 'KILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DEFAULTS = { ...Ed.lsp.timing };
beforeEach(async () => {
  if (E.mini) Ed.feedKey('C-g');
  await until(() => E.running === 0, 'the command before over');
  await Ed.lsp.shutdownAll();
  Ed.deleteOtherWindows();
  for (const b of E.buffers.slice()) if (b.file) { b.modified = false; L.call('kill-buffer', [b]); }
  Object.assign(Ed.lsp.timing, DEFAULTS);
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
const type = (s: string) => { for (const ch of s) Ed.feedKey(ch === ' ' ? 'SPC' : ch); };
/* M-x eglot-rename: the prompt it opens (and what it holds at first), then with CLEAR that emptied, NAME typed and
   RET; the command over. */
async function rename(name: string, clear = false) {
  await keys('ESC');
  Ed.feedKey('M-x'); type('eglot-rename'); Ed.feedKey('RET');
  await until(() => E.mini && /^Rename/.test(E.mini.prompt), 'the prompt');
  const asked = { prompt: E.mini.prompt as string, initial: E.minibuf.text as string };
  if (clear) for (let i = E.minibuf.text.length; i > 0; i--) Ed.feedKey('DEL');
  type(name); Ed.feedKey('RET');
  await until(() => E.running === 0, 'the rename to end');
  await Ed.whenIdle();
  return asked;
}

/* The stand-in: node SCRIPT LOG ANSWERS CAPS, as test/lsp-xref.test.mts's, whole-text sync, with the versions. */
const FAKE = `
const fs = require('fs');
const [log, answers, capsArg] = process.argv.slice(2);
const note = s => fs.appendFileSync(log, s + '\\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
const docs = new Map(), versions = new Map();
const fill = (x) => {
  if (Array.isArray(x)) return x.map(fill);
  if (!x || typeof x !== 'object') return x;
  const o = {};
  for (const [k, v] of Object.entries(x)) o[k] = v;
  if (o.textDocument && (o.textDocument.version === '@' || o.textDocument.version === '@-1'))
    o.textDocument = { uri: o.textDocument.uri, version: versions.get(o.textDocument.uri) - (o.textDocument.version === '@' ? 0 : 1) };
  for (const k of Object.keys(o)) if (k !== 'textDocument') o[k] = fill(o[k]);
  return o;
};
let buf = Buffer.alloc(0);
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1]);
    if (buf.length < end + 4 + n) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + n).toString('utf8'));
    buf = buf.subarray(end + 4 + n);
    note((m.method || 'answer') + ' ' + JSON.stringify(m.params === undefined ? null : m.params));
    const p = m.params || {};
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: Object.assign({ textDocumentSync: 1 }, JSON.parse(capsArg)) } });
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
    else if (m.method === 'textDocument/didOpen') { docs.set(p.textDocument.uri, p.textDocument.text); versions.set(p.textDocument.uri, p.textDocument.version); }
    else if (m.method === 'textDocument/didChange') { docs.set(p.textDocument.uri, p.contentChanges[p.contentChanges.length - 1].text); versions.set(p.textDocument.uri, p.textDocument.version); }
    else if (m.id !== undefined && m.method) {
      const a = JSON.parse(fs.readFileSync(answers, 'utf8'))[m.method];
      if (a === 'hang') continue;
      const out = a && a.error ? { jsonrpc: '2.0', id: m.id, error: a.error } : { jsonrpc: '2.0', id: m.id, result: a ? fill(a.result) : null };
      if (a && a.delay) setTimeout(() => send(out), a.delay); else send(out);
    }
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
let logs = 0;
function fake(caps: Record<string, unknown> = { renameProvider: true }) {
  const log = path.join(tmp, `log-${++logs}`), answers = path.join(tmp, `answers-${logs}.json`);
  fs.writeFileSync(log, ''); fs.writeFileSync(answers, '{}');
  const argv = [process.execPath, script, log, answers, JSON.stringify(caps)];
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${argv.map(a => JSON.stringify(a)).join(' ')}))`);
  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { const k = l.indexOf(' '); return { method: l.slice(0, k), rest: l.slice(k + 1) }; });
  const of = (method: string) => lines().filter(l => l.method === method).map(l => JSON.parse(l.rest));
  const answer = (a: Record<string, unknown>) => fs.writeFileSync(answers, JSON.stringify(a));
  return { lines, of, answer };
}
function project(name: string, files: Record<string, string>): Record<string, string> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); out[f] = p; }
  return { dir, ...out };
}
type Buf = { text: string; file: string | null; mode: string; pt: number; name: string; ver: number; modified: boolean; readOnly: boolean };
async function open(p: string): Promise<Buf> {
  await keys('ESC');
  const b = L.call('find-file', [p]) as Buf;
  const s = Ed.lsp.sessionOf(b);
  assert.ok(s, E.echo);
  await Ed.lsp.ready(s);
  return b;
}
const uri = (p: string) => Ed.lsp.uri(p);
const range = (l0: number, c0: number, l1: number, c1: number) => ({ start: { line: l0, character: c0 }, end: { line: l1, character: c1 } });
const edit = (l0: number, c0: number, l1: number, c1: number, newText: string) => ({ range: range(l0, c0, l1, c1), newText });
const fileBuffers = () => E.buffers.filter((b: Buf) => b.file).map((b: Buf) => b.file).sort();
const shownBuffers = () => Ed.windowList().map((w: { buffer: Buf }) => w.buffer.file);

test('initialize says workspace edits with documentChanges, and rename', async () => {
  const f = fake();
  await open(project('caps', { 'a.fake': 'x\n' })['a.fake']);
  const c = f.of('initialize')[0].capabilities;
  assert.deepEqual(c.workspace.workspaceEdit, { documentChanges: true });
  assert.deepEqual(c.textDocument.rename, {});
});

test('a rename across open and unopened files: each file changed, UTF-16 positions over \\r\\n and a lone \\r, the file not open visited unshown and told, nothing saved, one undo step a buffer', async () => {
  const f = fake();
  const pr = project('across', {
    'a.fake': 'let thing = 1\nthing + thing\n',
    'b.fake': 'use thing\n',
    'lib/c.fake': '😀 thing\r\nx\rthing 𝄞 thing\n',
  });
  const b = await open(pr['b.fake']);
  const a = await open(pr['a.fake']);
  assert.equal(E.current, a);
  /* an edit of a not yet sent: the rename sends it first, and it stays an undo step of its own */
  Ed.lsp.timing.change = 60_000;
  a.pt = a.text.length;
  await keys('G o z ESC');
  assert.equal(a.text, 'let thing = 1\nthing + thing\nz\n');
  a.pt = a.text.indexOf('thing') + 3;   // inside the identifier: thi|ng
  const pt = a.pt, prevA = Ed.windowList()[0].prev.slice();
  f.answer({ 'textDocument/rename': { result: { documentChanges: [
    { textDocument: { uri: uri(pr['a.fake']), version: '@' }, edits: [edit(1, 8, 1, 13, 'thingTwo'), edit(0, 4, 0, 9, 'thingTwo'), edit(1, 0, 1, 5, 'thingTwo')] },
    { textDocument: { uri: uri(pr['lib/c.fake']), version: null }, edits: [edit(0, 3, 0, 8, 'thingTwo'), edit(2, 0, 2, 5, 'thingTwo'), edit(2, 9, 2, 14, 'thingTwo')] },
    { textDocument: { uri: uri(pr['b.fake']), version: '@' }, edits: [edit(0, 4, 0, 9, 'thingTwo')] },
  ] } } });
  const asked = await rename('Two');
  assert.deepEqual(asked, { prompt: 'Rename thing to: ', initial: 'thing' });
  const req = f.of('textDocument/rename')[0];
  assert.equal(req.newName, 'thingTwo');
  assert.deepEqual(req.position, { line: 0, character: 7 });
  const opens = f.of('textDocument/didChange').filter((c: { textDocument: { uri: string } }) => c.textDocument.uri === uri(pr['a.fake']));
  assert.equal(opens[0].contentChanges[0].text, 'let thing = 1\nthing + thing\nz\n', 'the pending edit sent before the rename');
  assert.equal(a.text, 'let thingTwo = 1\nthingTwo + thingTwo\nz\n');
  assert.equal(b.text, 'use thingTwo\n');
  const c = E.buffers.find((x: Buf) => x.file === pr['lib/c.fake']) as Buf;
  assert.ok(c, 'c.fake is visited');
  assert.equal(c.text, '😀 thingTwo\r\nx\rthingTwo 𝄞 thingTwo\n');
  assert.equal(E.echo, 'Renamed to thingTwo: 7 edits in 3 files (1 visited for it), not saved');
  assert.equal(E.current, a);
  assert.equal(a.pt, pt, 'point inside the renamed identifier stays');
  assert.deepEqual(shownBuffers(), [pr['a.fake']], 'c.fake is not shown');
  assert.deepEqual(Ed.windowList()[0].prev, prevA, "the window's history is as it was");
  assert.ok(a.modified && b.modified && c.modified);
  for (const [k, t] of [['a.fake', 'let thing = 1\nthing + thing\n'], ['b.fake', 'use thing\n'], ['lib/c.fake', '😀 thing\r\nx\rthing 𝄞 thing\n']]) assert.equal(fs.readFileSync(pr[k], 'utf8'), t, `${k} not saved`);
  /* c is a document of the server now, and it is told of the edit */
  assert.equal(Ed.lsp.sessionOf(c), Ed.lsp.sessionOf(a));
  Ed.lsp.flush(c);
  await until(() => f.of('textDocument/didChange').some((x: { textDocument: { uri: string } }) => x.textDocument.uri === uri(pr['lib/c.fake'])), 'c told of the edit');
  assert.equal(f.of('textDocument/didOpen').filter((x: { textDocument: { uri: string } }) => x.textDocument.uri === uri(pr['lib/c.fake']))[0].textDocument.text, '😀 thing\r\nx\rthing 𝄞 thing\n');
  /* undo: one step a buffer, the earlier edit of a its own */
  await keys('u');
  assert.equal(a.text, 'let thing = 1\nthing + thing\nz\n');
  await keys('u');
  assert.equal(a.text, 'let thing = 1\nthing + thing\n');
  Ed.setWindowBuffer(b);
  await keys('u');
  assert.equal(b.text, 'use thing\n');
  assert.equal(b.modified, false);
  Ed.setWindowBuffer(c);
  await keys('u');
  assert.equal(c.text, '😀 thing\r\nx\rthing 𝄞 thing\n');
  assert.equal(c.modified, false);
  await keys('u');
  assert.match(E.echo, /Already at oldest change/, 'c had no step before the rename');
});

test('refused, nothing changed and no buffer left open: a stale version, an edit the server was not told of, changes it does not know of, a file past the end after another was visited', async () => {
  const f = fake();
  const pr = project('stale', { 'a.fake': 'one\n', 'b.fake': 'two\n', 'c.fake': 'three\n', 'd.fake': 'four\n' });
  const b = await open(pr['b.fake']);
  const a = await open(pr['a.fake']);
  const before = fileBuffers();
  const ed = (bv: unknown, dEdits = [edit(0, 0, 0, 4, 'FOUR')]) => ({ 'textDocument/rename': { result: { documentChanges: [
    { textDocument: { uri: uri(pr['a.fake']), version: '@' }, edits: [edit(0, 0, 0, 3, 'ONE')] },
    { textDocument: { uri: uri(pr['c.fake']), version: null }, edits: [edit(0, 0, 0, 5, 'THREE')] },
    { textDocument: { uri: uri(pr['b.fake']), version: bv }, edits: [edit(0, 0, 0, 3, 'TWO')] },
    { textDocument: { uri: uri(pr['d.fake']), version: null }, edits: dEdits },
  ] } } });
  const unchanged = (why: RegExp) => {
    assert.match(E.echo, why);
    assert.equal(a.text, 'one\n'); assert.equal(b.text, 'two\n');
    assert.equal(a.modified, false); assert.equal(b.modified, false);
    assert.deepEqual(fileBuffers(), before, 'no buffer left open');
    assert.equal(E.current, a);
  };
  f.answer(ed('@-1'));
  await rename('X', true);
  unchanged(/^The server's edit is not applied: b\.fake is not the version the edit is of \(\d+; the server was told of \d+\)$/);
  f.answer(ed(12345));
  await rename('X', true);
  unchanged(/b\.fake is not the version the edit is of/);
  /* b edited and the change not sent yet */
  Ed.lsp.timing.change = 60_000;
  b.pt = 0; Ed.insertText(b, 'q'); Ed.deleteText(b, 0, 1); Ed.insertText(b, 'w');
  f.answer(ed('@'));
  await rename('X', true);
  assert.match(E.echo, /b\.fake has changed since the server made the edit/);
  assert.equal(b.text, 'wtwo\n'); assert.equal(a.text, 'one\n');
  Ed.deleteText(b, 0, 1); b.modified = false;
  Ed.lsp.flush(b);
  /* a buffer that is not the server's document with unsaved changes: the server's positions are of the file */
  L.call('eglot-mode', [0]);   // in a, the current buffer: off
  Ed.setWindowBuffer(b);
  assert.equal(Ed.lsp.sessionOf(a), null);
  a.pt = 0; Ed.insertText(a, 'z');
  f.answer({ 'textDocument/rename': { result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 3, 'ONE')], [uri(pr['b.fake'])]: [edit(0, 0, 0, 3, 'TWO')] } } } });
  await rename('X', true);
  assert.match(E.echo, /a\.fake has changes its server was not told of/);
  assert.equal(a.text, 'zone\n'); assert.equal(b.text, 'two\n');
  Ed.deleteText(a, 0, 1); a.modified = false;
  Ed.setWindowBuffer(a); L.call('eglot-mode', [1]); await Ed.lsp.ready(Ed.lsp.sessionOf(a));
  /* d past its end, after c was visited: c is killed again */
  f.answer(ed('@', [edit(3, 0, 3, 0, 'x')]));
  await rename('X', true);
  unchanged(/an edit of .*d\.fake is past its last line, 2/);
  assert.equal(f.of('textDocument/didOpen').filter((x: { textDocument: { uri: string } }) => x.textDocument.uri === uri(pr['c.fake'])).length, 1, 'c was visited, told, then closed');
  await until(() => f.of('textDocument/didClose').some((x: { textDocument: { uri: string } }) => x.textDocument.uri === uri(pr['c.fake'])), 'c closed');
  /* then all of it, with the version right */
  f.answer(ed('@'));
  await rename('X', true);
  assert.equal(E.echo, 'Renamed to X: 4 edits in 4 files (2 visited for it), not saved');
  assert.equal(a.text, 'ONE\n'); assert.equal(b.text, 'TWO\n');
});

test('a buffer whose change was sent while the server worked is refused with no version named; unchanged, the same edit applies', async () => {
  const f = fake();
  const pr = project('race', { 'a.fake': 'thing\n', 'b.fake': 'using\n' });
  const b = await open(pr['b.fake']);
  const a = await open(pr['a.fake']);
  const before = fileBuffers();
  const late = { 'textDocument/rename': { delay: 400, result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 5, 'thingTwo')], [uri(pr['b.fake'])]: [edit(0, 0, 0, 5, 'thingTwo')] } } } };
  f.answer(late);
  const done = rename('Two');
  await until(() => f.of('textDocument/rename').length === 1, 'the request');
  b.pt = 0; Ed.insertText(b, 'XX');
  Ed.lsp.flush(b);
  await done;
  assert.equal(E.echo, "The server's edit is not applied: b.fake has changed since the server made the edit");
  assert.equal(b.text, 'XXusing\n'); assert.equal(a.text, 'thing\n'); assert.equal(a.modified, false);
  assert.deepEqual(fileBuffers(), before);
  const told = f.lines().map(l => l.method), asked = told.indexOf('textDocument/rename');
  assert.ok(told.indexOf('textDocument/didChange', asked) > asked, "b's change was sent after the request");
  Ed.deleteText(b, 0, 2); b.modified = false;
  Ed.lsp.flush(b);
  f.answer(late);
  await rename('Two');
  assert.equal(E.echo, 'Renamed to thingTwo: 2 edits in 2 files, not saved');
  assert.equal(a.text, 'thingTwo\n'); assert.equal(b.text, 'thingTwo\n');
});

test('a document closed while the server worked is refused rather than visited afresh from the disk; killed and visited again with the text the server held, the edit applies', async () => {
  const f = fake();
  const pr = project('closed', { 'a.fake': 'thing\n', 'b.fake': 'thing\n' });
  const b = await open(pr['b.fake']);
  b.pt = 0; Ed.insertText(b, 'XX');
  Ed.lsp.flush(b);
  const a = await open(pr['a.fake']);
  const before = fileBuffers();
  const late = { 'textDocument/rename': { delay: 400, result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 5, 'thingTwo')], [uri(pr['b.fake'])]: [edit(0, 2, 0, 7, 'thingTwo')] } } } };
  f.answer(late);
  let done = rename('Two');
  await until(() => f.of('textDocument/rename').length === 1, 'the request');
  b.modified = false; L.call('kill-buffer', [b]);
  await done;
  assert.equal(E.echo, "The server's edit is not applied: b.fake was closed while the server worked");
  assert.equal(a.text, 'thing\n'); assert.equal(a.modified, false);
  assert.deepEqual(fileBuffers(), before.filter((p: string) => p !== pr['b.fake']), 'b.fake was not visited for the edit');
  assert.equal(fs.readFileSync(pr['b.fake'], 'utf8'), 'thing\n');
  /* killed and visited again while the server worked, holding the text it held: the edit is of that text */
  const b2 = await open(pr['b.fake']);
  b2.pt = 0; Ed.insertText(b2, 'XX'); Ed.lsp.flush(b2);
  Ed.setWindowBuffer(a);
  f.answer({ 'textDocument/rename': { ...late['textDocument/rename'], delay: 1500 } });
  done = rename('Two');
  await until(() => f.of('textDocument/rename').length === 2, 'the second request');
  b2.modified = false; L.call('kill-buffer', [b2]);
  const b3 = L.call('find-file', [pr['b.fake']]) as Buf;  /* while the command waits: not open(), which waits for it */
  b3.pt = 0; Ed.insertText(b3, 'XX'); Ed.lsp.flush(b3);
  Ed.setWindowBuffer(a);
  assert.ok(E.running > 0, 'the rename still waits for its answer');
  await done;
  assert.equal(E.echo, 'Renamed to thingTwo: 2 edits in 2 files, not saved');
  assert.equal(a.text, 'thingTwo\n'); assert.equal(b3.text, 'XXthingTwo\n');
});

test('a file not open when the rename was asked, opened and edited while the server worked, is refused', async () => {
  const f = fake();
  const pr = project('opened', { 'a.fake': 'thing\n', 'c.fake': 'thing\n' });
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/rename': { delay: 1500, result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 5, 'thingTwo')], [uri(pr['c.fake'])]: [edit(0, 0, 0, 5, 'thingTwo')] } } } });
  const done = rename('Two');
  await until(() => f.of('textDocument/rename').length === 1, 'the request');
  const c = L.call('find-file', [pr['c.fake']]) as Buf;  /* while the command waits: not open(), which waits for it */
  c.pt = 0; Ed.insertText(c, 'XX'); Ed.lsp.flush(c);
  Ed.setWindowBuffer(a);
  assert.ok(E.running > 0, 'the rename still waits for its answer');
  await done;
  assert.equal(E.echo, "The server's edit is not applied: c.fake has changed since the server made the edit");
  assert.equal(a.text, 'thing\n'); assert.equal(a.modified, false);
  assert.equal(c.text, 'XXthing\n');
  assert.equal(fs.readFileSync(pr['c.fake'], 'utf8'), 'thing\n');
});

test('the answer to a rename asked from a buffer no longer current is dropped with a message, and nothing changes', async () => {
  const f = fake();
  const pr = project('switched', { 'a.fake': 'thing\n', 'b.fake': 'thing\n' });
  const b = await open(pr['b.fake']);
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/rename': { delay: 400, result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 5, 'thingTwo')], [uri(pr['b.fake'])]: [edit(0, 0, 0, 5, 'thingTwo')] } } } });
  const done = rename('Two');
  await until(() => f.of('textDocument/rename').length === 1, 'the request');
  Ed.setWindowBuffer(b);
  await done;
  assert.equal(E.echo, `Rename to thingTwo dropped: ${a.name} is no longer the current buffer`);
  assert.equal(a.text, 'thing\n'); assert.equal(b.text, 'thing\n');
  assert.equal(a.modified, false); assert.equal(b.modified, false);
});

test('refusals of the edit itself: a resource operation, another scheme, a file out of the project, a missing file, a directory, a range backwards, two overlapping, a read-only buffer, a file twice, a malformed edit', async () => {
  const f = fake();
  const pr = project('bad', { 'a.fake': 'abc\ndef\n', 'b.fake': 'b\n', 'sub/x.fake': 'x\n' });
  const outside = path.join(tmp, 'outside.fake');
  fs.writeFileSync(outside, 'o\n');
  fs.symlinkSync(tmp, path.join(pr.dir, 'link'));
  const a = await open(pr['a.fake']);
  const ok = { textDocument: { uri: uri(pr['a.fake']), version: '@' }, edits: [edit(0, 0, 0, 1, 'A')] };
  const cases: [unknown, RegExp][] = [
    [{ documentChanges: [ok, { kind: 'create', uri: uri(path.join(pr.dir, 'new.fake')) }] }, /it would create a file, which is not done here/],
    [{ documentChanges: [ok, { kind: 'rename', oldUri: uri(pr['b.fake']), newUri: uri(path.join(pr.dir, 'c.fake')) }] }, /it would rename a file/],
    [{ changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 1, 'A')], 'untitled:x': [edit(0, 0, 0, 0, 'y')] } }, /untitled:x is not a file/],
    [{ changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 1, 'A')], [uri(outside)]: [edit(0, 0, 0, 1, 'O')] } }, /outside\.fake is not in .*bad/],
    [{ changes: { [uri(path.join(pr.dir, 'link', 'outside.fake'))]: [edit(0, 0, 0, 1, 'O')] } }, /link\/outside\.fake is not in .*bad/],
    [{ changes: { [uri(path.join(pr.dir, 'gone.fake'))]: [edit(0, 0, 0, 1, 'O')] } }, /gone\.fake: no such file/],
    [{ changes: { [uri(path.join(pr.dir, 'sub'))]: [edit(0, 0, 0, 1, 'O')] } }, /sub could not be visited/],
    [{ changes: { [uri(pr['a.fake'])]: [edit(1, 2, 0, 1, 'A')] } }, /an edit of a\.fake ends before it starts/],
    [{ changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 2, 'A'), edit(0, 1, 0, 3, 'B')] } }, /two edits of a\.fake overlap/],
    [{ changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 1, 'A')] }, documentChanges: [ok, { textDocument: { uri: uri(pr['a.fake']), version: '@' }, edits: [] }] }, /it names .*a\.fake twice/],
    [{ changes: { [uri(pr['a.fake'])]: [{ range: range(0, 0, 0, 1) }] } }, /an edit of .*a\.fake is malformed/],
    [{ changes: { [uri(pr['a.fake'])]: [edit(0, -1, 0, 1, 'A')] } }, /is malformed/],
    [{ changes: { [uri(pr['a.fake'])]: 'x' } }, /its edits of .*a\.fake are not a list/],
    [{ documentChanges: [{ textDocument: { uri: uri(pr['b.fake']), version: 3 }, edits: [edit(0, 0, 0, 1, 'B')] }] }, /b\.fake is not open, but the edit is of its version 3/],
    ['nope', /it is not a workspace edit/],
    /* names from the server shown cleaned: a terminal frame draws the echo area */
    [{ changes: { [`file://${pr.dir}/%1B%5D0;x%07.fake`]: [edit(0, 0, 0, 1, 'O')] } }, /  \]0;x \.fake: no such file/],
    [{ documentChanges: [{ kind: '\x1b[2J\nx' }] }, /it would  \[2J x a file/],
  ];
  for (const [result, why] of cases) {
    f.answer({ 'textDocument/rename': { result } });
    await rename('X', true);
    assert.match(E.echo, why, JSON.stringify(result));
    assert.match(E.echo, /^The server's edit is not applied: /);
    assert.doesNotMatch(E.echo, /[\x00-\x1f\x7f-\x9f]/, `no control character in ${JSON.stringify(E.echo)}`);
    assert.equal(a.text, 'abc\ndef\n');
    assert.deepEqual(fileBuffers(), [pr['a.fake']], `no buffer left by ${JSON.stringify(result)}`);
  }
  /* a read-only buffer */
  const b = L.call('find-file', [pr['b.fake']]) as Buf;
  b.readOnly = true;
  Ed.setWindowBuffer(a);
  f.answer({ 'textDocument/rename': { result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 1, 'A')], [uri(pr['b.fake'])]: [edit(0, 0, 0, 1, 'B')] } } } });
  await rename('X', true);
  assert.match(E.echo, /b\.fake is read-only/);
  assert.equal(a.text, 'abc\ndef\n'); assert.equal(b.text, 'b\n');
});

test('the order of edits: inserts at one place in the server\'s order, before a replacement there; many on a line by place; an edit that changes nothing; a null answer, an error, no capability, no name', async () => {
  const f = fake();
  const pr = project('order', { 'a.fake': 'foo(foo, foo)\nend\n' });
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/rename': { result: { changes: { [uri(pr['a.fake'])]: [
    edit(0, 4, 0, 7, 'barbaz'), edit(0, 9, 0, 12, 'barbaz'), edit(0, 0, 0, 3, 'barbaz'), edit(1, 0, 1, 0, 'A'), edit(1, 0, 1, 3, 'E'), edit(1, 0, 1, 0, 'B'),
  ] } } } });
  await rename('barbaz', true);
  assert.equal(a.text, 'barbaz(barbaz, barbaz)\nABE\n');
  assert.equal(E.echo, 'Renamed to barbaz: 6 edits in 1 file, not saved');
  await keys('u');
  assert.equal(a.text, 'foo(foo, foo)\nend\n', 'one undo step');
  /* the start of the line after the last (a whole-document edit's end) is the end of the text; past it is refused */
  f.answer({ 'textDocument/rename': { result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 3, 0, 'whole\n')] } } } });
  await rename('x', true);
  assert.equal(a.text, 'whole\n');
  await keys('u');
  assert.equal(a.text, 'foo(foo, foo)\nend\n');
  f.answer({ 'textDocument/rename': { result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 3, 1, 'whole\n')] } } } });
  await rename('x', true);
  assert.match(E.echo, /an edit of a\.fake is past its last line, 3/);
  assert.equal(a.text, 'foo(foo, foo)\nend\n');
  f.answer({ 'textDocument/rename': { result: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 3, 'foo')] } } } });
  await rename('foo', true);
  assert.equal(E.echo, "Nothing to rename: the server's edit changes nothing");
  assert.equal(a.modified, false);
  f.answer({ 'textDocument/rename': { result: null } });
  await rename('x', true);
  assert.equal(E.echo, 'fake renames nothing here');
  f.answer({ 'textDocument/rename': { error: { code: -32803, message: 'cannot rename a keyword' } } });
  await rename('x', true);
  assert.match(E.echo, /textDocument\/rename: cannot rename a keyword/);
  await rename('', true);
  assert.equal(E.echo, 'No new name given');
  assert.equal(a.text, 'foo(foo, foo)\nend\n');
  await Ed.lsp.shutdownAll();
  const g = fake({});
  const b = await open(project('nocap', { 'b.fake': 'x\n' })['b.fake']);
  await rename('y', true);
  assert.equal(E.echo, 'fake gives no renames');
  assert.equal(g.of('textDocument/rename').length, 0, 'not asked');
  assert.equal(b.text, 'x\n');
});

test('nil: a binding renamed at both uses', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL names no nil' }, async () => {
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command (list ${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const pr = project('nil', { 'default.nix': '# 😀\nlet\n  x = 1;\nin\n  /* 𝄞 */ x + x\n' });
  const b = await open(pr['default.nix']);
  assert.ok((Ed.lsp.sessionOf(b).capabilities || {}).renameProvider, 'nil renames');
  b.pt = b.text.indexOf('x + x');
  const asked = await rename('yy', true);
  assert.equal(asked.initial, 'x');
  assert.equal(b.text, '# 😀\nlet\n  yy = 1;\nin\n  /* 𝄞 */ yy + yy\n', E.echo);
  assert.equal(E.echo, 'Renamed to yy: 3 edits in 1 file, not saved');
  await keys('u');
  assert.equal(b.text, '# 😀\nlet\n  x = 1;\nin\n  /* 𝄞 */ x + x\n');
  Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  await until(() => proc.running().length === 0, 'nil ended');
});

test('at the bound: an edit of 1000 files, 999 not open, applied without holding the loop past the frame budget', async () => {
  const f = fake();
  const n = 1000, files: Record<string, string> = {};
  for (let i = 0; i < n; i++) files[`m/f${i}.fake`] = `use thing ${i}\n`;
  const pr = project('big', files);
  const a = await open(pr['m/f0.fake']);
  const changes: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) changes[uri(pr[`m/f${i}.fake`])] = [edit(0, 4, 0, 9, 'other')];
  f.answer({ 'textDocument/rename': { result: { changes } } });
  const hf = host.files!, real = hf.truename; let asked = 0;
  hf.truename = (p: string) => { asked++; return real(p); };
  let last = performance.now(), gap = 0;
  const tick = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; }, 5);
  await rename('other', true);
  clearInterval(tick); hf.truename = real;
  assert.equal(E.echo, `Renamed to other: ${n} edits in ${n} files (${n - 1} visited for it), not saved`);
  assert.equal(a.text, 'use other 0\n');
  assert.equal(fileBuffers().length, n);
  console.log(`# the longest the loop was held: ${Math.round(gap)} ms; true names asked: ${asked}`);
  assert.ok(asked <= 3 * n, `${asked} true names asked`);
  assert.ok(gap < 2000, `the loop held ${Math.round(gap)} ms`);
});
