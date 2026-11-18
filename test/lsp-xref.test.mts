// Cross references (src/lsp.ts): g d, g r and the other finds against a stand-in server that is a real child
// through Ed.proc (fake-proc.mts). It answers each textDocument/* request with what the suite wrote for that method
// in its answers file (a result, an error, or nothing at all), logs every message, and keeps each document's text,
// so a request's position can be checked against the text the server holds. Then nil from nixpkgs (when
// EDWIN_LSP_REAL names it): g d from a use to its binding, g r listing both.
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
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: unknown };
host.proc = proc;
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
L.evalText('(set! corfu-auto #f)');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-xref-')));
/* The files as the desktop program reads them: with a bound, only a regular file no larger than it (else a throw).
   Every bound asked is kept. */
const bounds: (number | undefined)[] = [];
host.files = {
  cwd: tmp, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(tmp, p),
  read: (p: string, max?: number) => {
    bounds.push(max);
    if (!fs.existsSync(p)) return null;
    if (max !== undefined) { const st = fs.statSync(p); if (!st.isFile()) throw new Error('not a regular file'); if (st.size > max) throw new Error(`larger than ${max} bytes`); }
    return fs.readFileSync(p, 'utf8');
  },
  write: (p: string, v: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); },
  remove: (p: string) => { fs.rmSync(p, { force: true }); },
  list: () => [] as string[], truename: (p: string) => p, label: (p: string) => p, temp: [] as string[],
};
L.evalText(`(define-language fake-mode "Fake" :files '("\\\\.fake$"))`);
after(async () => {
  await Ed.lsp.shutdownAll();
  for (const id of proc.running()) proc.kill(id, 'KILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DEFAULTS = { ...Ed.lsp.timing };
beforeEach(async () => {
  await Ed.lsp.shutdownAll();
  Ed.deleteOtherWindows();
  for (const b of E.buffers.slice()) if (b.file || b.name === '*xref*') { b.modified = false; L.call('kill-buffer', [b]); }
  while (true) { try { L.call('xref-go-back', []); } catch { break; } }   // an empty history
  Object.assign(Ed.lsp.timing, DEFAULTS);
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
/* KEYS typed, then the command loop idle again (a find that waits on its server holds it until it ends). */
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
/* COMMAND by M-x. */
const mx = async (command: string) => { await keys('M-x'); for (const ch of command) Ed.feedKey(ch); await keys('RET'); };
/* P as the client shows a path out of the project: under the home directory as ~/... */
const shown = (p: string) => { const home = Ed.host.dirs ? Ed.host.dirs.home.replace(/\/$/, '') : ''; return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p; };

/* The stand-in: node SCRIPT LOG ANSWERS CAPS. ANSWERS is a JSON file read at each request: by method, the result
   ({"result": R}), an error ({"error": {...}}) or "hang" (no answer). CAPS is the capabilities it answers
   initialize with (whole-text sync always). Each message is logged as "METHOD PARAMS"; a request's position is
   also logged as "at METHOD TEXT", TEXT what the document holds from that position to its line's end. */
const FAKE = `
const fs = require('fs');
const [log, answers, capsArg] = process.argv.slice(2);
const note = s => fs.appendFileSync(log, s + '\\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
const docs = new Map();
function rest(t, pos) {
  const lines = t.split(/\\r\\n|\\r|\\n/);
  const l = lines[pos.line];
  return l === undefined ? null : l.slice(pos.character);
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
    note((m.method || 'answer') + ' ' + JSON.stringify(m.params === undefined ? null : m.params));
    const p = m.params || {};
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: Object.assign({ textDocumentSync: 1 }, JSON.parse(capsArg)) } });
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
    else if (m.method === 'textDocument/didOpen') docs.set(p.textDocument.uri, p.textDocument.text);
    else if (m.method === 'textDocument/didChange') docs.set(p.textDocument.uri, p.contentChanges[p.contentChanges.length - 1].text);
    else if (m.id !== undefined && m.method) {
      const t = docs.get(p.textDocument && p.textDocument.uri);
      if (p.position) note('at ' + m.method + ' ' + JSON.stringify(t === undefined ? null : rest(t, p.position)));
      const a = JSON.parse(fs.readFileSync(answers, 'utf8'))[m.method];
      if (a === 'hang') continue;
      send(a && a.error ? { jsonrpc: '2.0', id: m.id, error: a.error } : { jsonrpc: '2.0', id: m.id, result: a ? a.result : null });
    }
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
const ALL = { definitionProvider: true, referencesProvider: true, implementationProvider: {}, typeDefinitionProvider: true, declarationProvider: true };
let logs = 0;
/* A fresh log and answers file, and the stand-in declared for fake-mode with CAPS. */
function fake(caps: Record<string, unknown> = ALL) {
  const log = path.join(tmp, `log-${++logs}`), answers = path.join(tmp, `answers-${logs}.json`);
  fs.writeFileSync(log, ''); fs.writeFileSync(answers, '{}');
  const argv = [process.execPath, script, log, answers, JSON.stringify(caps)];
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${argv.map(a => JSON.stringify(a)).join(' ')}))`);
  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { const k = l.indexOf(' '); return { method: l.slice(0, k), rest: l.slice(k + 1) }; });
  const of = (method: string) => lines().filter(l => l.method === method).map(l => JSON.parse(l.rest));
  /* where the server was asked METHOD: the rest of the line it holds from there */
  const at = (method: string) => lines().filter(l => l.method === 'at').map(l => l.rest).filter(r => r.startsWith(method + ' ')).map(r => JSON.parse(r.slice(method.length + 1)));
  const answer = (a: Record<string, unknown>) => fs.writeFileSync(answers, JSON.stringify(a));
  return { lines, of, at, answer };
}
/* A project (with a .git) under NAME holding FILES (path: text) on the disk; their absolute paths. */
function project(name: string, files: Record<string, string>): Record<string, string> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); out[f] = p; }
  return { dir, ...out };   // dir, and each file by its name
}
type Buf = { text: string; file: string | null; mode: string; pt: number; name: string; ver: number };
/* P visited in the selected window, its server ready, in Normal state. */
async function open(p: string): Promise<Buf> {
  await keys('ESC');
  const b = L.call('find-file', [p]) as Buf;
  const s = Ed.lsp.sessionOf(b);
  assert.ok(s, E.echo);
  await Ed.lsp.ready(s);
  return b;
}
const uri = (p: string) => Ed.lsp.uri(p);
const loc = (p: string, line: number, character: number) => ({ uri: uri(p), range: { start: { line, character }, end: { line, character: character + 1 } } });
const lineCol = (b: Buf) => { const t = b.text.slice(0, b.pt), nl = t.lastIndexOf('\n'); return [t.split('\n').length - 1, b.pt - nl - 1]; };

test('initialize says what the client asks for: definitions, declarations, type definitions and implementations with links, references', async () => {
  const f = fake();
  const pr = project('caps', { 'a.fake': 'x\n' });
  await open(pr['a.fake']);
  const td = f.of('initialize')[0].capabilities.textDocument;
  assert.deepEqual(td.definition, { linkSupport: true });
  assert.deepEqual(td.declaration, { linkSupport: true });
  assert.deepEqual(td.typeDefinition, { linkSupport: true });
  assert.deepEqual(td.implementation, { linkSupport: true });
  assert.deepEqual(td.references, {});
});

test('g d: a pending edit is sent first, the position is in UTF-16 units, one place in another file is visited there; C-t and M-, come back', async () => {
  const f = fake();
  const pr = project('gd', { 'a.fake': 'use 😀 thing here\n', 'lib/b.fake': 'one\n\rtwo\n𝄞𝄞 thing = 1\n' });
  const a = await open(pr['a.fake']);
  /* eglot-mode's g d and g r leave Normal state's other g keys */
  a.pt = 5;
  await keys('g g');
  assert.equal(a.pt, 0, 'g g');
  await keys('g U U');
  assert.deepEqual([a.text], ['USE 😀 THING HERE\n'], 'g U U');
  await keys('u');
  assert.deepEqual([a.text], ['use 😀 thing here\n']);
  a.pt = a.text.indexOf('thing');
  Ed.insertText(a, 'X');   // not yet sent: the find flushes it
  a.pt = a.text.indexOf('thing');
  /* line 3 of b by LSP's count (\n, then a lone \r), after two astral characters (4 units) and a blank */
  f.answer({ 'textDocument/definition': { result: loc(pr['lib/b.fake'], 3, 5) } });
  await keys('g d');
  assert.deepEqual(f.at('textDocument/definition'), ['thing here'], 'asked at point, in the text with the edit');
  const ask = f.of('textDocument/definition')[0];
  assert.deepEqual(ask.position, { line: 0, character: 'use 😀 X'.length });
  assert.equal(ask.textDocument.uri, uri(pr['a.fake']));
  const b = E.current as Buf;
  assert.equal(b.file, pr['lib/b.fake']);
  assert.equal(b.text.slice(b.pt), 'thing = 1\n', E.echo);
  assert.equal(Ed.windowList().length, 1, 'visited in the selected window');
  await keys('C-t');
  assert.equal(E.current, a);
  assert.equal(a.text.slice(a.pt), 'thing here\n');
  /* again, and back with M-, from Emacs state */
  await keys('g d');
  assert.equal(E.current, b);
  await keys('C-z M-,');   // Emacs state in b; a is still in Normal state
  assert.equal(E.current, a);
  assert.equal(a.text.slice(a.pt), 'thing here\n');
  await keys('C-t');
  assert.match(E.echo, /At the start of the xref history/);
});

test('one place in the same buffer: C-o comes back too; a LocationLink goes to its targetSelectionRange, else its targetRange', async () => {
  const f = fake();
  const pr = project('link', { 'a.fake': 'def foo\n\nfoo()\n' });
  const a = await open(pr['a.fake']);
  a.pt = a.text.lastIndexOf('foo');
  const p = pr['a.fake'];
  f.answer({ 'textDocument/definition': { result: [{ targetUri: uri(p), targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, targetSelectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } } }] } });
  await keys('g d');
  assert.equal(E.current, a);
  assert.deepEqual(lineCol(a), [0, 4]);
  await keys('C-o');
  assert.deepEqual(lineCol(a), [2, 0]);
  f.answer({ 'textDocument/definition': { result: [{ targetUri: uri(p), targetRange: { start: { line: 0, character: 1 }, end: { line: 0, character: 7 } } }] } });
  await keys('g d');
  assert.deepEqual(lineCol(a), [0, 1]);
});

test('g r lists the references by file in *xref*, the declaration asked for; RET visits a row in the other window, o shows one, M-g n steps, M-, comes back', async () => {
  const f = fake();
  const pr = project('refs', { 'src/a.fake': 'let n = 1\nn + n\n', 'z.fake': '\n\n\n\n\n\n\n\n\nn\n', 'src/b.fake': '\r\n  call(n)   \r\n' });
  const outside = path.join(tmp, 'elsewhere.fake');
  fs.writeFileSync(outside, 'n\n');
  const a = await open(pr['src/a.fake']);
  a.pt = a.text.indexOf('n');
  bounds.length = 0;
  /* in the server's order of files, each file's rows by line; one twice (left out), one in no file */
  f.answer({ 'textDocument/references': { result: [
    loc(pr['src/a.fake'], 1, 4), loc(pr['z.fake'], 9, 0), loc(pr['src/a.fake'], 0, 4), loc(pr['src/b.fake'], 1, 7),
    loc(pr['src/a.fake'], 1, 0), loc(pr['src/a.fake'], 1, 4), loc(outside, 0, 0), { uri: 'jdt://x/y', range: { start: { line: 0, character: 0 } } },
    { uri: 42 }, null, { uri: uri(pr['z.fake']), range: { start: { line: -1, character: 0 } } },
  ] } });
  await keys('g r');
  assert.deepEqual(f.of('textDocument/references')[0].context, { includeDeclaration: true });
  const x = E.current;
  assert.equal(x.name, '*xref*');
  assert.equal(x.mode, 'xref-mode');
  assert.equal(x.readOnly, true);
  assert.equal(x.text, [
    'src/a.fake', '  1: let n = 1', '  2: n + n', '  2: n + n',
    'z.fake', '  10: n',
    'src/b.fake', '  2: call(n)',
    shown(outside), '  1: n', ''].join('\n'));
  assert.equal(E.echo, '6 references');
  assert.equal(Ed.windowList().length, 2);
  assert.deepEqual(bounds, [4 * 1024 * 1024, 4 * 1024 * 1024, 4 * 1024 * 1024], 'the files not open read once each, with the bound');
  /* point on the first row; j to the third (a.fake line 2, character 4) */
  assert.equal(x.text.slice(x.pt).split('\n')[0], '  1: let n = 1');
  await keys('j j RET');
  assert.equal(E.current, a);
  assert.deepEqual(lineCol(a), [1, 4]);
  assert.equal(Ed.windowList().length, 2, '*xref* stays shown');
  /* o in *xref*: z.fake shown in the other window, *xref* still selected */
  Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer === x));
  await keys('j j o');
  assert.equal(E.current, x);
  const z = Ed.windowList().map((w: { buffer: Buf }) => w.buffer).find((b: Buf) => b.file === pr['z.fake']);
  assert.ok(z, 'z.fake is shown');
  assert.deepEqual(lineCol(z), [9, 0]);
  /* a heading is no row */
  await keys('k RET');
  assert.equal(E.current, x);
  assert.match(E.echo, /No reference here/);
  /* the error list: M-g n goes to the first */
  Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer !== x));
  await keys('M-g n');
  assert.equal((E.current as Buf).file, pr['src/a.fake']);
  assert.deepEqual(lineCol(E.current), [0, 4]);
  await keys('M-g n M-g p');
  assert.deepEqual(lineCol(E.current), [0, 4], 'M-g p back to the first');
  /* RET in Emacs state too (xref-mode-map) */
  Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer === x));
  await keys('C-z');
  x.pt = 0;
  await keys('C-n C-n RET');
  assert.equal((E.current as Buf).file, pr['src/a.fake']);
  assert.deepEqual(lineCol(E.current), [1, 0]);
  /* back to where g r was typed */
  a.pt = 0;
  await keys('C-t');
  assert.equal(E.current, a);
  assert.deepEqual(lineCol(a), [0, 4]);
});

test('one reference is listed; several definitions are listed and RET visits one; a file too large or not regular shows no text', async () => {
  const f = fake();
  const pr = project('one', { 'a.fake': 'n\n', 'big.fake': 'x'.repeat(4 * 1024 * 1024 + 1) + '\n' });
  const fifo = path.join(pr.dir, 'dir.fake');
  fs.mkdirSync(fifo);
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/references': { result: [loc(pr['a.fake'], 0, 0)] }, 'textDocument/definition': { result: [loc(pr['big.fake'], 0, 3), loc(fifo, 2, 0)] } });
  await keys('g r');
  assert.equal(E.current.name, '*xref*');
  assert.equal(E.current.text, 'a.fake\n  1: n\n');
  assert.equal(E.echo, '1 references');
  Ed.deleteOtherWindows(); Ed.setWindowBuffer(a);
  await keys('g d');
  assert.equal(E.current.text, 'big.fake\n  1: \ndir.fake\n  3: \n');
  assert.equal(E.echo, '2 definitions');
  await keys('RET');
  assert.equal((E.current as Buf).file, pr['big.fake']);
  assert.equal(E.current.pt, 3);
});

test('nothing found, places in no file, an error answer, no capability and no server each say so and move nothing', async () => {
  const f = fake({ definitionProvider: true, referencesProvider: true });
  const pr = project('none', { 'a.fake': 'abc\n' });
  const a = await open(pr['a.fake']);
  a.pt = 1;
  f.answer({ 'textDocument/definition': { result: null } });
  await keys('g d');
  assert.equal(E.echo, 'No definitions found');
  f.answer({ 'textDocument/definition': { result: [] } });
  await keys('g d');
  assert.equal(E.echo, 'No definitions found');
  f.answer({ 'textDocument/definition': { result: { uri: 'untitled:x', range: { start: { line: 0, character: 0 } } } } });
  await keys('g d');
  assert.equal(E.echo, 'No definitions in a file: the server names 1 elsewhere');
  f.answer({ 'textDocument/definition': { result: { uri: 'file:///%E0%A4%A', range: { start: { line: 0, character: 0 } } } } });
  await keys('g d');
  assert.equal(E.echo, 'No definitions in a file: the server names 1 elsewhere', 'a malformed escape');
  f.answer({ 'textDocument/definition': { error: { code: -32603, message: 'boom' } } });
  await keys('g d');
  assert.match(E.echo, /textDocument\/definition: boom/);
  f.answer({ 'textDocument/definition': { result: loc(path.join(pr.dir, 'gone.fake'), 0, 0) } });
  await keys('g d');
  assert.match(E.echo, /gone\.fake: no such file/);
  await mx('eglot-find-implementation');
  assert.equal(E.echo, 'fake gives no implementations');
  assert.equal(f.of('textDocument/implementation').length, 0, 'not asked');
  assert.equal(E.current, a); assert.equal(a.pt, 1);
  assert.equal(Ed.windowList().length, 1);
  await keys('C-t');
  assert.match(E.echo, /At the start of the xref history/, 'nothing was recorded');
  /* no server: g d is not bound, M-. says so */
  const t = L.call('find-file', [path.join(pr.dir, 'plain.txt')]);
  assert.equal(L.truthy(Ed.localValue(t, 'eglot-enabled')), false);
  await keys('C-z M-.');
  assert.match(E.echo, /No language server for this buffer/);
  await keys('C-z');
});

test('implementation, type definition and declaration ask their methods; a position inside a surrogate pair is its start', async () => {
  const f = fake();
  const pr = project('friends', { 'a.fake': 'a\nb\nc\n𝄞d\n' });
  const a = await open(pr['a.fake']);
  const p = pr['a.fake'];
  f.answer({ 'textDocument/implementation': { result: [loc(p, 1, 0)] }, 'textDocument/typeDefinition': { result: loc(p, 2, 0) }, 'textDocument/declaration': { result: [loc(p, 3, 1)] } });
  await mx('eglot-find-implementation');
  assert.deepEqual(lineCol(a), [1, 0]);
  await mx('eglot-find-typeDefinition');
  assert.deepEqual(lineCol(a), [2, 0]);
  await mx('eglot-find-declaration');
  assert.deepEqual(lineCol(a), [3, 0], 'a character between the halves of a pair: the start of the pair');
  await keys('C-t C-t');
  assert.deepEqual(lineCol(a), [1, 0]);
});

test('a server that does not answer: C-g quits and cancels the request; past timing.request it says so; the frame takes keys again', async () => {
  const f = fake();
  const pr = project('hang', { 'a.fake': 'abc\n' });
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/definition': 'hang' });
  Ed.feedKey('g'); Ed.feedKey('d');
  await until(() => f.of('textDocument/definition').length === 1, 'the request');
  assert.ok(E.running > 0, 'the command waits');
  Ed.feedKey('C-g');
  await until(() => E.running === 0, 'the command over');
  assert.equal(E.echo, 'Quit');
  await until(() => f.lines().some(l => l.method === '$/cancelRequest'), 'the cancel sent');
  Ed.lsp.timing.request = 200;
  await keys('g d');
  assert.match(E.echo, /textDocument\/definition/);
  await until(() => f.lines().filter(l => l.method === '$/cancelRequest').length === 2, 'the timed-out request cancelled');
  await keys('l');
  assert.equal(a.pt, 1, 'keys work again');
  /* a server that never answers initialize: waited for at most timing.request */
  L.evalText(`(define-language-server 'slow :modes '(fake-mode) :command (list ${JSON.stringify(process.execPath)} "-e" "setInterval(() => {}, 1000)"))`);
  const b = L.call('find-file', [path.join(project('hang2', { 'b.fake': 'x\n' }).dir, 'b.fake')]);
  assert.equal(Ed.lsp.sessionOf(b).state, 'starting');
  await keys('g d');
  assert.match(E.echo, /^slow in .*hang2: not ready after 0\.2 s$/);
  assert.equal(E.current, b);
});

test('xref-go-back skips the place of a killed buffer', async () => {
  const f = fake();
  const pr = project('killed', { 'a.fake': 'a\n', 'b.fake': 'b\n', 'c.fake': 'c\n' });
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/definition': { result: loc(pr['b.fake'], 0, 0) } });
  await keys('g d');
  const b = E.current;
  f.answer({ 'textDocument/definition': { result: loc(pr['c.fake'], 0, 0) } });
  await keys('g d');
  assert.equal((E.current as Buf).file, pr['c.fake']);
  b.modified = false; L.call('kill-buffer', [b]);
  await keys('C-t');
  assert.equal(E.current, a);
});

test('nil: g d from a use to its binding, g r lists both', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL names no nil' }, async () => {
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command (list ${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const pr = project('nil', { 'default.nix': '# 😀\nlet\n  x = 1;\nin\n  /* 𝄞 */ x + x\n' });
  const b = await open(pr['default.nix']);
  assert.equal(b.mode, 'nix-mode');
  b.pt = b.text.indexOf('x + x');
  await keys('g d');
  assert.equal(E.current, b, E.echo);
  assert.deepEqual(lineCol(b), [2, 2], E.echo);
  await keys('C-t');
  assert.equal(b.text.slice(b.pt), 'x + x\n');
  await keys('g r');
  assert.equal(E.current.name, '*xref*', E.echo);
  assert.equal(E.current.text, 'default.nix\n  5: /* 𝄞 */ x + x\n  5: /* 𝄞 */ x + x\n');
  Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  await until(() => proc.running().length === 0, 'nil ended');
});
