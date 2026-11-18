// Document sync and eglot-mode (src/lsp.ts) in the headless runtime, against a stand-in server that is a real child
// through Ed.proc (fake-proc.mts) and keeps its own copy of each document: it applies didOpen, didChange,
// didSave and didClose with its own code (lines split at \n, \r\n and a lone \r, characters counted in UTF-16
// units, a position past its line's end refused), shares nothing with lsp.ts, and answers fake/text with what it
// holds. fast-check edits buffers at random (inserts, deletes, replacements, the whole text set, the edit log
// forgotten, undo and redo, saves, flushes) under whole and incremental sync, and the server's text must be the buffer's after
// each run. Known answers pin the ranges for an astral character, a combining mark, \r\n and a lone \r. Then the
// lifecycle (eglot-mode from visiting a file, off and on, a major mode changed, write-file to another name, a
// kill, a crash and start again), the sync kinds a server may ask for, the refusals, and nil from nixpkgs (when
// EDWIN_LSP_REAL names it) finding a definition after edits around astral characters.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

const require = createRequire(import.meta.url);
const fc = require('fast-check'); // any: fast-check's types are not resolvable from edwin/ (it lives in tools/node_modules)

const proc = fakeProc();
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: unknown };
host.proc = proc;
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-docs-')));
host.files = {
  cwd: tmp, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(tmp, p),
  read: (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  write: (p: string, v: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); },
  remove: (p: string) => { fs.rmSync(p, { force: true }); },
  list: () => [] as string[], truename: (p: string) => p, label: (p: string) => p, temp: [] as string[],
};
L.evalText(`(define-language fake-mode "Fake" :files '("\\\\.fake$"))`);
L.evalText(`(define-language fake2-mode "Fake2" :files '("\\\\.fake2$"))`);
after(async () => {
  await Ed.lsp.shutdownAll();
  for (const id of proc.running()) proc.kill(id, 'KILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DEFAULTS = { ...Ed.lsp.timing };
beforeEach(async () => {
  await Ed.lsp.shutdownAll();
  for (const b of E.buffers.slice()) if (b.file) { b.modified = false; L.call('kill-buffer', [b]); }
  Object.assign(Ed.lsp.timing, DEFAULTS);
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };

/* The stand-in: node SCRIPT LOG SYNC. SYNC is the textDocumentSync it answers, as JSON ("absent" for none). Each
   message is logged as "PID METHOD PARAMS"; what it finds wrong (a document opened twice, a change to one not
   open, a version not above the last, a position past its line's end) as "PID error WHAT". crash-once in the
   argv's fourth place exits 3 once the first document is opened, the first time. */
const FAKE = `
const fs = require('fs');
const [log, syncArg, crash] = process.argv.slice(2);
const note = s => fs.appendFileSync(log, process.pid + ' ' + s + '\\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
const caps = syncArg === 'absent' ? {} : { textDocumentSync: JSON.parse(syncArg) };
let crashNow = false;
if (crash === 'crash-once') { const mark = log + '.crashed'; if (!fs.existsSync(mark)) { fs.writeFileSync(mark, ''); crashNow = true; } }
const docs = new Map();
/* Where line L, character C is in T: its lines end at \\n, \\r\\n or a lone \\r; null past the line's end. */
function offset(t, pos) {
  let i = 0;
  for (let l = 0; l < pos.line; l++) {
    const re = /\\r\\n|\\r|\\n/g; re.lastIndex = i;
    const m = re.exec(t);
    if (!m) return null;
    i = m.index + m[0].length;
  }
  const re = /\\r\\n|\\r|\\n/g; re.lastIndex = i;
  const m = re.exec(t), end = m ? m.index : t.length;
  return i + pos.character <= end ? i + pos.character : null;
}
function apply(m) {
  const p = m.params || {}, td = p.textDocument || {};
  if (m.method === 'textDocument/didOpen') {
    if (docs.has(td.uri)) note('error opened twice ' + td.uri);
    docs.set(td.uri, { text: td.text, version: td.version, languageId: td.languageId });
    if (crashNow) setTimeout(() => process.exit(3), 20);
  } else if (m.method === 'textDocument/didChange') {
    const d = docs.get(td.uri);
    if (!d) return note('error change to a document not open ' + td.uri);
    if (!(td.version > d.version)) note('error version ' + td.version + ' after ' + d.version);
    d.version = td.version;
    for (const c of p.contentChanges) {
      if (!c.range) { d.text = c.text; continue; }
      const s = offset(d.text, c.range.start), e = offset(d.text, c.range.end);
      if (s === null || e === null || e < s) return note('error range ' + JSON.stringify(c.range) + ' in ' + JSON.stringify(d.text));
      d.text = d.text.slice(0, s) + c.text + d.text.slice(e);
    }
  } else if (m.method === 'textDocument/didSave') {
    const d = docs.get(td.uri);
    if (!d) note('error save of a document not open ' + td.uri);
    else if (p.text !== undefined && p.text !== d.text) note('error saved text differs');
  } else if (m.method === 'textDocument/didClose') {
    if (!docs.delete(td.uri)) note('error close of a document not open ' + td.uri);
  }
}
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
    if (m.method !== 'fake/text') note((m.method || 'answer') + ' ' + JSON.stringify(m.params === undefined ? null : m.params));
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: caps } });
    else if (m.method === 'fake/text') send({ jsonrpc: '2.0', id: m.id, result: docs.get(m.params.uri) || null });
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
    else apply(m);
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
let logs = 0;
type Line = { pid: number; method: string; params: Record<string, unknown> | string };
/* A fresh log, and the stand-in declared for MODE with textDocumentSync SYNC. */
function fake(sync: unknown, { mode = 'fake-mode', name = 'fake', crash = '' } = {}) {
  const log = path.join(tmp, `log-${++logs}`);
  fs.writeFileSync(log, '');
  const argv = [process.execPath, script, log, sync === undefined ? 'absent' : JSON.stringify(sync), ...(crash ? [crash] : [])];
  L.evalText(`(define-language-server '${name} :modes '(${mode}) :command (list ${argv.map(a => JSON.stringify(a)).join(' ')}))`);
  const lines = (): Line[] => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => {
    const [pid, method] = l.split(' ', 2), rest = l.slice(pid.length + method.length + 2);
    return { pid: Number(pid), method, params: method === 'error' ? rest : JSON.parse(rest) };
  });
  const errors = () => lines().filter(l => l.method === 'error').map(l => l.params);
  const of = (method: string) => lines().filter(l => l.method === method).map(l => l.params as Record<string, unknown> & { textDocument: { uri: string; version?: number; languageId?: string; text?: string }; contentChanges?: { range?: unknown; text: string }[]; text?: string });
  return { log, lines, errors, of };
}
const methods = (lines: Line[]) => lines.map(l => l.method);
/* A project (with a .git) holding FILE with TEXT on the disk. */
function project(name: string, file: string, text: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
const visit = (p: string) => L.call('find-file', [p]) as EdBufferLike;
type EdBufferLike = { text: string; ver: number; file: string | null; mode: string; pt: number; mark: number | null; modified: boolean; name: string; undo: unknown[]; redo: unknown[] };
const uriOf = (p: string) => Ed.lsp.uri(p);
const on = (b: EdBufferLike) => L.truthy(Ed.localValue(b, 'eglot-enabled'));
/* What the server holds of B, once B's changes are sent. */
async function held(b: EdBufferLike) {
  Ed.lsp.flush(b);
  const s = Ed.lsp.sessionOf(b);
  return await s.conn.request('fake/text', { uri: uriOf(b.file!) }) as { text: string; version: number; languageId: string } | null;
}
const run = (command: string, b: unknown, args: unknown[] = []) => { Ed.setWindowBuffer(b); return L.call(command, args); };

test('visiting a file whose mode has a server turns eglot-mode on; didOpen once it is initialized, with the uri, languageId, version and text', async () => {
  const f = fake(2);
  const p = project('open é #1', 'a.fake', 'héllo\n');
  const before = proc.calls.length;
  const b = visit(p);
  assert.equal(b.mode, 'fake-mode');
  assert.equal(on(b), true, 'eglot-mode is on at once');
  assert.equal(proc.calls.length, before + 1, 'the server was started by the visit');
  const s = Ed.lsp.sessionOf(b);
  assert.equal(s.state, 'starting');
  b.pt = 0; Ed.insertText(b, 'X');   // an edit before the server is ready: the didOpen carries it
  await Ed.lsp.ready(s);
  const got = await held(b);
  const [open] = f.of('textDocument/didOpen');
  assert.deepEqual(open.textDocument, { uri: uriOf(p), languageId: 'fake', version: b.ver, text: 'Xhéllo\n' });
  assert.ok(uriOf(p).includes('/open%20%C3%A9%20%231/a.fake'));
  assert.deepEqual(got, { text: 'Xhéllo\n', version: b.ver, languageId: 'fake' });
  assert.equal(f.of('textDocument/didChange').length, 0, 'nothing changed after the didOpen');
  assert.deepEqual(f.errors(), []);
  const init = f.of('initialize')[0] as unknown as { capabilities: { textDocument: unknown } };
  assert.deepEqual((init.capabilities.textDocument as { synchronization: unknown }).synchronization, { didSave: true });
  assert.equal(Ed.lsp.languageId('c++-mode'), 'cpp');
  assert.equal(Ed.lsp.languageId('tsx-mode'), 'typescriptreact');
  assert.equal(Ed.lsp.languageId('nix-mode'), 'nix');
});

test('known answers: incremental ranges in UTF-16 units, across an astral character, a combining mark, \\r\\n and a lone \\r', async () => {
  const f = fake({ openClose: true, change: 2 });
  const p = project('known', 'k.fake', 'a😀b\r\nxy\rz\né!');
  const b = visit(p);
  await Ed.lsp.ready(Ed.lsp.sessionOf(b));
  const last = () => { const cs = f.of('textDocument/didChange'); return cs[cs.length - 1].contentChanges; };
  const edit = async (fn: () => void) => { fn(); Ed.lsp.flush(b); await until(() => f.of('textDocument/didChange').length > n, 'the change'); n++; return last(); };
  let n = 0;
  const at = (line: number, character: number) => ({ line, character });
  assert.deepEqual(await edit(() => { b.pt = 3; Ed.insertText(b, 'Q'); }), [{ range: { start: at(0, 3), end: at(0, 3) }, text: 'Q' }], 'after a😀: 3 units');
  assert.deepEqual(await edit(() => Ed.deleteText(b, 1, 3)), [{ range: { start: at(0, 1), end: at(0, 3) }, text: '' }], 'the emoji is 2 units');
  assert.deepEqual(await edit(() => { b.pt = 1; Ed.insertText(b, '😀'); }), [{ range: { start: at(0, 1), end: at(0, 1) }, text: '😀' }]);
  /* 😀 to 😁: the same high surrogate; the range takes the whole pair */
  assert.deepEqual(await edit(() => Ed.replaceText(b, 1, 3, '😁')), [{ range: { start: at(0, 1), end: at(0, 3) }, text: '😁' }]);
  /* the line after \r\n, the one after a lone \r */
  assert.deepEqual(await edit(() => { b.pt = b.text.indexOf('y'); Ed.insertText(b, '-'); }), [{ range: { start: at(1, 1), end: at(1, 1) }, text: '-' }]);
  assert.deepEqual(await edit(() => { b.pt = b.text.indexOf('z') + 1; Ed.insertText(b, '+'); }), [{ range: { start: at(2, 1), end: at(2, 1) }, text: '+' }]);
  /* a combining mark is a unit of its own */
  assert.deepEqual(await edit(() => { b.pt = b.text.indexOf('!'); Ed.insertText(b, '?'); }), [{ range: { start: at(3, 2), end: at(3, 2) }, text: '?' }]);
  /* a \n inserted between \r and \n: the range keeps the \r\n whole */
  assert.deepEqual(await edit(() => { b.pt = b.text.indexOf('\r\n') + 1; Ed.insertText(b, 'W'); }), [{ range: { start: at(0, 5), end: at(1, 0) }, text: '\rW\n' }]);
  /* the three deleted: the lone \r and the \n were two line ends */
  assert.deepEqual(await edit(() => Ed.deleteText(b, b.text.indexOf('\rW\n'), b.text.indexOf('\rW\n') + 3)), [{ range: { start: at(0, 5), end: at(2, 0) }, text: '' }]);
  assert.deepEqual((await held(b))!.text, b.text);
  assert.deepEqual(f.errors(), []);

  /* two edits within timing.change: one didChange, sent once the time has passed */
  Ed.lsp.timing.change = 80;
  const k = f.of('textDocument/didChange').length;
  b.pt = 0; Ed.insertText(b, '1'); Ed.insertText(b, '2');
  await sleep(30);
  assert.equal(f.of('textDocument/didChange').length, k, 'nothing sent before the idle time');
  await until(() => f.of('textDocument/didChange').length === k + 1, 'the change after the idle time');
  await sleep(120);
  assert.equal(f.of('textDocument/didChange').length, k + 1, 'one change for both edits');
  assert.deepEqual(last(), [{ range: { start: at(0, 0), end: at(0, 0) }, text: '12' }]);
  assert.equal((await held(b))!.text, b.text);
});

/* Random edits of B: inserts and deletes at random places (never inside a surrogate pair), replacements, the whole
   text set, undo and redo, the edit log forgotten, saves and flushes in between. */
const PIECES = ['a', 'Z', ' ', 'é', 'é', '😀', '𝄞x', '\n', '\r\n', '\r', '\t', '中文'];
const piece = fc.array(fc.constantFrom(...PIECES), { maxLength: 4 }).map((a: string[]) => a.join(''));
const op = fc.oneof(
  fc.record({ k: fc.constant('ins'), at: fc.nat(), s: piece }),
  fc.record({ k: fc.constant('del'), at: fc.nat(), n: fc.nat({ max: 6 }) }),
  fc.record({ k: fc.constant('rep'), at: fc.nat(), n: fc.nat({ max: 6 }), s: piece }),
  fc.record({ k: fc.constant('set'), s: fc.array(piece, { maxLength: 6 }).map((a: string[]) => a.join('')) }),
  fc.record({ k: fc.constant('forget') }),
  fc.record({ k: fc.constant('flush') }),
  fc.record({ k: fc.constant('save') }),
  fc.record({ k: fc.constant('undo') }),
  fc.record({ k: fc.constant('redo') }),
);
type Op = { k: 'ins'; at: number; s: string } | { k: 'del'; at: number; n: number } | { k: 'rep'; at: number; n: number; s: string } | { k: 'set'; s: string } | { k: 'forget' } | { k: 'flush' } | { k: 'save' } | { k: 'undo' } | { k: 'redo' };
const whole = (t: string, p: number) => (p > 0 && p < t.length && (t.charCodeAt(p) & 0xfc00) === 0xdc00 ? p - 1 : p);
async function randomRuns(sync: unknown, dir: string) {
  const f = fake(sync);
  const p = project(dir, 'r.fake', 'start\n');
  const b = visit(p);
  await Ed.lsp.ready(Ed.lsp.sessionOf(b));
  Ed.lsp.timing.change = 5;
  let runs = 0, undos = 0;
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 20 }).map((s: string) => s.replace(/[\ud800-\udfff]/g, 'u')), fc.array(op, { maxLength: 25 }), fc.boolean(), async (init: string, ops: Op[], idle: boolean) => {
    runs++;
    b.text = init; b.undo = []; b.redo = [];
    for (const o of ops) {
      const t = b.text, at = whole(t, (o as { at?: number }).at! % (t.length + 1));
      /* an edit is an undo step, as a command's is */
      if (o.k === 'ins' || o.k === 'del' || o.k === 'rep' || o.k === 'set') { b.undo.push({ ver: b.ver, pt: b.pt, mark: b.mark, modified: b.modified }); b.redo = []; }
      if (o.k === 'ins') { b.pt = at; Ed.insertText(b, o.s); }
      else if (o.k === 'del') Ed.deleteText(b, at, whole(t, Math.min(t.length, at + o.n)));
      else if (o.k === 'rep') Ed.replaceText(b, at, whole(t, Math.min(t.length, at + o.n)), o.s);
      else if (o.k === 'set') b.text = o.s;
      else if (o.k === 'forget') { Ed.forgetLog(b); b.undo = []; b.redo = []; }
      else if (o.k === 'flush') Ed.lsp.flush(b);
      else if (o.k === 'save') { run('save-buffer', b); }
      else if (o.k === 'undo') { if (b.undo.length) { Ed.undoStep(b); undos++; } }
      else if (o.k === 'redo') { if (b.redo.length) { Ed.redoStep(b); undos++; } }
      if (o.k === 'flush' || o.k === 'save') await sleep(0);
    }
    if (idle) await sleep(10);   // sent by the idle timer, else by the flush below
    const got = await held(b);
    assert.equal(got!.text, b.text);
    assert.ok(got!.version <= b.ver, 'a version the buffer had (an edit undone by another sends nothing)');
  }), { numRuns: Number(process.env.LSP_DOC_RUNS || 60) });
  assert.deepEqual(f.errors(), [], 'the server found nothing wrong');
  assert.ok(f.of('textDocument/didChange').length > runs, 'the runs were sent as changes');
  assert.ok(undos > 0, 'undo and redo were run');
  return f;
}

test('fast-check, incremental sync: the server\'s text is the buffer\'s after random edits', async () => {
  const f = await randomRuns({ openClose: true, change: 2, save: { includeText: true } }, 'random-inc');
  assert.ok(f.of('textDocument/didChange').every(c => c.contentChanges!.length === 1 && c.contentChanges![0].range), 'every change is one range');
  assert.ok(f.of('textDocument/didSave').length > 0 && f.of('textDocument/didSave').every(s => typeof s.text === 'string'), 'saves told, with the text the server asked for');
});

test('fast-check, whole-text sync: the server\'s text is the buffer\'s after random edits', async () => {
  const f = await randomRuns(1, 'random-full');
  assert.ok(f.of('textDocument/didChange').every(c => c.contentChanges!.length === 1 && !c.contentChanges![0].range), 'every change is the whole text');
  assert.ok(f.of('textDocument/didSave').length > 0 && f.of('textDocument/didSave').every(s => s.text === undefined), 'a number asks for saves without the text');
});

test('save-buffer: didSave after the change before it; write-file to another name closes the old uri and opens the new', async () => {
  const f = fake({ openClose: true, change: 2, save: true });
  const p = project('save', 'a.fake', 'one\n');
  const b = visit(p);
  await Ed.lsp.ready(Ed.lsp.sessionOf(b));
  b.pt = 0; Ed.insertText(b, 'zero ');
  run('save-buffer', b);
  await held(b);
  assert.deepEqual(methods(f.lines()).slice(-2), ['textDocument/didChange', 'textDocument/didSave'], 'the pending change goes first');
  assert.deepEqual(f.of('textDocument/didSave')[0], { textDocument: { uri: uriOf(p) } }, 'save: true asks for no text');
  const q = path.join(path.dirname(p), 'sub', 'b.fake');
  run('write-file', b, [q]);
  await held(b);
  assert.deepEqual(methods(f.lines()).slice(-2), ['textDocument/didClose', 'textDocument/didOpen']);
  assert.deepEqual(f.of('textDocument/didClose')[0], { textDocument: { uri: uriOf(p) } });
  assert.equal(f.of('textDocument/didOpen')[1].textDocument.uri, uriOf(q));
  assert.equal((await held(b))!.text, 'zero one\n');
  assert.equal(Ed.lsp.sessions().length, 1, 'the same project: the same session');
  /* to another project: that project's session */
  const other = project('save-other', 'x', '');
  run('write-file', b, [path.join(path.dirname(other), 'c.fake')]);
  assert.equal(Ed.lsp.sessions().length, 2);
  assert.equal(Ed.lsp.sessionOf(b).root, path.dirname(other));
  await Ed.lsp.ready(Ed.lsp.sessionOf(b));
  assert.equal((await held(b))!.text, 'zero one\n');
  assert.deepEqual(f.errors(), []);
});

test('eglot-mode off and on, a major mode changed, a kill: didClose, and didOpen again', async () => {
  const f = fake(2);
  const g = fake(2, { mode: 'fake2-mode', name: 'fake2' });
  const p = project('modes', 'a.fake', 'text\n');
  const b = visit(p);
  const s = Ed.lsp.sessionOf(b);
  await Ed.lsp.ready(s);
  run('eglot-mode', b, [0]);
  await s.conn.request('fake/text', { uri: '' });
  assert.equal(on(b), false);
  assert.equal(Ed.lsp.sessionOf(b), null);
  assert.deepEqual(f.of('textDocument/didClose'), [{ textDocument: { uri: uriOf(p) } }]);
  Ed.insertText(b, 'edited while off ');
  run('eglot-mode', b, [1]);
  assert.equal(on(b), true);
  assert.equal(Ed.lsp.sessionOf(b), s, 'the session it had, still running');
  assert.equal((await held(b))!.text, b.text);
  assert.equal(f.of('textDocument/didOpen').length, 2);

  /* a mode with another server: closed on the first, opened on the second; a mode with none: off */
  run('fake2-mode', b);
  assert.equal(on(b), true);
  const s2 = Ed.lsp.sessionOf(b);
  assert.equal(s2.name, 'fake2');
  await Ed.lsp.ready(s2);
  await held(b); await s.conn.request('fake/text', { uri: '' });
  assert.equal(f.of('textDocument/didClose').length, 2);
  assert.equal(g.of('textDocument/didOpen')[0].textDocument.languageId, 'fake2');
  run('fundamental-mode', b);
  await s2.conn.request('fake/text', { uri: '' });
  assert.equal(on(b), false);
  assert.equal(Ed.lsp.sessionOf(b), null);
  assert.equal(g.of('textDocument/didClose').length, 1);
  assert.throws(() => run('eglot-mode', b, [1]), (e: unknown) => L.S.conditionIs(e, 'lsp-error'), 'no server for the mode');
  assert.equal(on(b), false, 'left off when it cannot start');

  /* a mode set with no hook run (as a form of the image's might): the next flush closes the document and starts
     no server for the new mode */
  run('fake-mode', b);
  assert.equal(Ed.lsp.sessionOf(b), s);
  await Ed.lsp.shutdown(s2);
  const spawns = proc.calls.length;
  b.mode = 'fake2-mode';
  Ed.lsp.flush(b);
  await s.conn.request('fake/text', { uri: '' });
  assert.equal(Ed.lsp.sessionOf(b), null);
  assert.equal(on(b), false);
  assert.equal(proc.calls.length, spawns, 'nothing started');
  assert.equal(f.of('textDocument/didClose').length, 3, 'closed on the server it had');

  /* a kill closes it */
  run('fake-mode', b);
  assert.equal(Ed.lsp.sessionOf(b), s);
  const closes = f.of('textDocument/didClose').length;
  b.modified = false;
  L.call('kill-buffer', [b]);
  await s.conn.request('fake/text', { uri: '' });
  assert.equal(f.of('textDocument/didClose').length, closes + 1);
  assert.equal(s.buffers.size, 0);
  assert.deepEqual(f.errors(), []);
  assert.deepEqual(g.errors(), []);
});

test('a crash: the new process gets didOpen with the text as it is then, edits made while it was down included', async () => {
  Ed.lsp.timing.restartDelay = 100;
  const f = fake(2, { crash: 'crash-once' });
  const p = project('crash', 'a.fake', 'before\n');
  const b = visit(p);
  const s = Ed.lsp.sessionOf(b);
  await Ed.lsp.ready(s);
  const first = s.proc;
  await until(() => s.state === 'restarting', 'the crash');
  b.pt = 0; Ed.insertText(b, 'while down ');
  Ed.lsp.flush(b);   // nothing to send to: dropped, no error
  await until(() => s.state === 'running' && s.proc !== first, 'the start again');
  await until(() => f.of('textDocument/didOpen').length === 2, 'the new process logged its didOpen');   // its log is written as it reads
  const opens = f.of('textDocument/didOpen');
  assert.equal(opens.length, 2);
  assert.equal(opens[1].textDocument.text, 'while down before\n');
  assert.equal(f.of('textDocument/didChange').length, 0, 'no change sent to a server that was down');
  Ed.insertText(b, '!');
  assert.equal((await held(b))!.text, b.text);
  assert.deepEqual(f.errors(), []);
});

test('the sync a server asks for: none tells nothing; openClose alone tells no changes; a buffer of a server shut down is off', async () => {
  const f = fake(undefined);
  const p = project('none', 'a.fake', 'x');
  const b = visit(p);
  const s = Ed.lsp.sessionOf(b);
  await Ed.lsp.ready(s);
  Ed.insertText(b, 'y'); Ed.lsp.flush(b); run('save-buffer', b);
  L.call('kill-buffer', [b]);
  await s.conn.request('fake/text', { uri: '' });
  await Ed.lsp.shutdown(s);
  assert.deepEqual(methods(f.lines()), ['initialize', 'initialized', 'shutdown', 'exit'], 'no textDocumentSync: nothing about documents');

  const g = fake({ openClose: true }, { name: 'fake' });
  const q = project('openclose', 'a.fake', 'x');
  const c = visit(q);
  const t = Ed.lsp.sessionOf(c);
  await Ed.lsp.ready(t);
  Ed.insertText(c, 'y'); Ed.lsp.flush(c); run('save-buffer', c);
  await held(c);
  assert.deepEqual(methods(g.lines()), ['initialize', 'initialized', 'textDocument/didOpen'], 'opened, no change and no save told');
  run('eglot-shutdown', c);
  assert.equal(on(c), false, 'off once its server is shut down');
  await Ed.lsp.shutdown(t);
  assert.deepEqual(methods(g.lines()), ['initialize', 'initialized', 'textDocument/didOpen', 'shutdown', 'exit'], 'no didClose to a server shutting down');
});

test('eglot-mode turns on by itself only where a server can start: no server for the mode, no project, the image\'s replay, a web frame', async () => {
  fake(2);
  const before = proc.calls.length;
  const t = visit(project('refuse', 'a.txt', 'x'));
  assert.equal(on(t), false, 'no server for its mode: off, no message');
  const g = Ed.getBufferCreate('*scratch-fake*');
  Ed.setWindowBuffer(g); L.call('fake-mode', []);
  assert.equal(on(g), false, 'a buffer with no file');
  /* while the image replays: nothing started, no error, off */
  const p = project('refuse', 'b.fake', 'x');
  const b = Ed.proc.replay(() => visit(p));
  await sleep(5);   // the replay's window closes on the loop's next turn
  assert.equal(b.file, p);
  assert.equal(on(b), false);
  assert.equal(proc.calls.length, before);
  /* a web frame, and a host with no processes */
  const kind = Ed.host.kind;
  Ed.host.kind = 'browser';
  try { assert.equal(on(visit(project('refuse', 'c.fake', 'x'))), false); }
  finally { Ed.host.kind = kind; }
  delete host.proc;
  try { assert.equal(on(visit(project('refuse', 'e.fake', 'x'))), false); }
  finally { host.proc = proc; }
  assert.equal(proc.calls.length, before);
  /* a program missing: said, the visit goes on */
  L.evalText(`(define-language-server 'gone :modes '(fake-mode) :command '("edwin-no-such-server"))`);
  const d = visit(project('refuse', 'd.fake', 'x'));
  assert.equal(on(d), false);
  assert.match(E.echo, /^eglot: /);
  assert.equal(d.text, 'x');
});

test('nil: a definition found after edits around astral characters, so the server holds the buffer\'s text', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL names no nil' }, async () => {
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command (list ${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const p = project('nil', 'default.nix', 'let\n  x = 1;\nin\n  x\n');
  const b = visit(p);
  assert.equal(b.mode, 'nix-mode');
  const s = Ed.lsp.sessionOf(b);
  assert.ok(s, E.echo);
  await Ed.lsp.ready(s);
  /* a comment of astral characters first; x renamed yy in both places; the use behind a comment of more */
  b.pt = 0; Ed.insertText(b, '# 😀𝄞 é\n');
  let k = b.text.indexOf('x = 1');
  Ed.replaceText(b, k, k + 1, 'yy');
  k = b.text.lastIndexOf('  x\n');
  Ed.replaceText(b, k, k + 3, '  /* 😀😀 */ yy');
  Ed.lsp.flush(b);
  assert.equal(b.text, '# 😀𝄞 é\nlet\n  yy = 1;\nin\n  /* 😀😀 */ yy\n');
  const character = '  /* 😀😀 */ '.length;   // UTF-16 units
  const got = await s.conn.request('textDocument/definition', { textDocument: { uri: uriOf(p) }, position: { line: 4, character: character + 1 } }) as unknown;
  const loc = (Array.isArray(got) ? got[0] : got) as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetSelectionRange?: { start: { line: number; character: number } } };
  assert.ok(loc, 'nil found a definition');
  const start = (loc.range || loc.targetSelectionRange)!.start;
  assert.deepEqual(start, { line: 2, character: 2 }, 'yy\'s binding');
  run('eglot-shutdown', b);
  await until(() => proc.running().length === 0, 'nil ended');
});
