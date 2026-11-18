// Symbols (src/lsp.ts): consult-imenu listing the server's document symbols, and consult-eglot-symbols asking for the
// workspace's, against a stand-in server that is a real child through Ed.proc (fake-proc.mts). It answers each
// request with what the suite wrote in its answers file (a result, an error, "hang", a delay; initialize answered
// initDelay ms late when the capabilities name one) and logs every message. Then nil from nixpkgs (when
// EDWIN_LSP_REAL names it) listing a Nix file's attributes.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-symbols-')));
host.files = {
  cwd: tmp, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(tmp, p),
  read: (p: string) => { if (!fs.existsSync(p)) return null; if (fs.statSync(p).isDirectory()) throw new Error('is a directory'); return fs.readFileSync(p, 'utf8'); },
  write: (p: string, v: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); },
  remove: (p: string) => { fs.rmSync(p, { force: true }); },
  list: () => [] as string[], truename: (p: string) => { try { return fs.realpathSync(p); } catch { return p; } }, label: (p: string) => p, temp: [] as string[],
};
L.evalText(`(define-language fake-mode "Fake" :files '("\\\\.fake$"))`);
L.evalText(`(define-language plain-mode "Plain" :files '("\\\\.plain$"))`);
after(async () => {
  await Ed.lsp.shutdownAll();
  for (const id of proc.running()) proc.kill(id, 'KILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DEFAULTS = { ...Ed.lsp.timing };
beforeEach(async () => {
  for (let i = 0; i < 3 && (E.mini || E.prompt); i++) { Ed.feedKey('C-g'); await sleep(20); }
  await until(() => E.running === 0, 'the command before over');
  await Ed.lsp.shutdownAll();
  Ed.deleteOtherWindows();
  for (const b of E.buffers.slice()) if (b.file) { b.modified = false; L.call('kill-buffer', [b]); }
  Object.assign(Ed.lsp.timing, DEFAULTS);
  Ed.lsp.timing.symbols = 50;
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
const type = (s: string) => { for (const ch of s) Ed.feedKey(ch === ' ' ? 'SPC' : ch); };
const done = async () => { await Ed.whenIdle(); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
/* COMMAND run as a key (as -f delivers it), not waiting for it. */
const mx = (command: string) => { Ed.feedKey(`<cmd:${command}>`); };
/* The picker with PROMPT once it is open: its candidates and their annotations. */
async function picker(prompt: string) {
  await until(() => E.mini && E.mini.prompt === prompt, `the picker ${JSON.stringify(prompt)} (echo: ${E.echo})`);
  const cands = Ed.miniCandidates(true) as string[];
  return { cands, anns: cands.map(c => E.mini.opts.annotate(c)) };
}

/* The stand-in: node SCRIPT LOG ANSWERS CAPS, whole-text sync. */
const FAKE = `
const fs = require('fs');
const [log, answers, capsArg] = process.argv.slice(2);
const note = s => fs.appendFileSync(log, s + '\\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
const read = () => JSON.parse(fs.readFileSync(answers, 'utf8'));
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
    note((m.method || 'answer') + ' ' + JSON.stringify(m.method ? (m.params === undefined ? null : m.params) : { id: m.id, result: m.result, error: m.error }));
    if (!m.method) continue;
    if (m.method === 'initialize') {
      const caps = Object.assign({ textDocumentSync: 1 }, JSON.parse(capsArg)), late = caps.initDelay;
      delete caps.initDelay;
      const out = { jsonrpc: '2.0', id: m.id, result: { capabilities: caps } };
      if (late) setTimeout(() => send(out), late); else send(out);
    }
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
    else if (m.id !== undefined) {
      const a = read()[m.method];
      if (a === 'hang') continue;
      const out = a && a.error ? { jsonrpc: '2.0', id: m.id, error: a.error } : { jsonrpc: '2.0', id: m.id, result: a ? a.result : null };
      if (a && a.delay) setTimeout(() => send(out), a.delay); else send(out);
    }
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
let logs = 0;
function fake(caps: Record<string, unknown> = { documentSymbolProvider: true, workspaceSymbolProvider: true }) {
  const log = path.join(tmp, `log-${++logs}`), answers = path.join(tmp, `answers-${logs}.json`);
  fs.writeFileSync(log, ''); fs.writeFileSync(answers, '{}');
  const argv = [process.execPath, script, log, answers, JSON.stringify(caps)];
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${argv.map(a => JSON.stringify(a)).join(' ')}))`);
  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { const k = l.indexOf(' '); return { method: l.slice(0, k), rest: l.slice(k + 1) }; });
  const of = (method: string) => lines().filter(l => l.method === method).map(l => JSON.parse(l.rest));
  /* written whole, then renamed: the stand-in may read it while the suite writes */
  const answer = (a: Record<string, unknown>) => { fs.writeFileSync(answers + '.new', JSON.stringify(a)); fs.renameSync(answers + '.new', answers); };
  return { lines, of, answer };
}
function project(name: string, files: Record<string, string>): Record<string, string> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); out[f] = p; }
  return { dir, ...out };
}
type Buf = { text: string; file: string | null; mode: string; pt: number; name: string; modified: boolean };
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
/* A DocumentSymbol: its whole range from L0:C0 to the line after, its name at L0:C0. */
const docSym = (name: unknown, kind: number, l0: number, c0: number, children?: unknown[]) =>
  ({ name, kind, range: range(l0, 0, l0 + 1, 0), selectionRange: range(l0, c0, l0, c0 + 1), ...(children ? { children } : {}) });
const symInfo = (name: unknown, kind: number, u: string, l0: number, c0: number, containerName?: string) =>
  ({ name, kind, location: { uri: u, range: range(l0, c0, l0, c0 + 1) }, ...(containerName ? { containerName } : {}) });
const current = () => E.current as Buf;
/* The text the definition picker's fallback (the buffer's own definitions) finds: a paragraph's first line. */
const OWN = 'x\n\nAlpha\n\nBeta\n';

test('initialize says hierarchical document symbols and workspace symbols, every SymbolKind', async () => {
  const f = fake();
  await open(project('caps', { 'a.fake': 'x\n' })['a.fake']);
  const c = f.of('initialize')[0].capabilities, kinds = { valueSet: Array.from({ length: 26 }, (_, k) => k + 1) };
  assert.deepEqual(c.textDocument.documentSymbol, { hierarchicalDocumentSymbolSupport: true, symbolKind: kinds });
  assert.deepEqual(c.workspace.symbol, { symbolKind: kinds });
});

test("consult-imenu lists the server's document symbols in the order of the text, children under their parent, malformed ones left out; one chosen visited, previewed, C-g puts point back", async () => {
  const f = fake();
  const pr = project('doc', { 'a.fake': 'outer {\n  inner\n  other\n}\nlast\n' });
  const a = await open(pr['a.fake']);
  /* an edit not yet sent: sent before the request, positions are UTF-16 */
  Ed.lsp.timing.change = 60_000;
  a.pt = 0; Ed.insertText(a, '😀\n');
  f.answer({ 'textDocument/documentSymbol': { result: [
    docSym('last', 12, 5, 0),
    docSym('outer', 5, 1, 0, [docSym('other', 8, 3, 2), docSym('inner', 6, 2, 2, [docSym('', 13, 2, 2), docSym('   ', 13, 2, 2)])]),
    'not a symbol', { kind: 13, range: range(1, 0, 1, 1) }, { name: 'nowhere', kind: 13 },
    { name: 'whole', kind: 99, range: range(0, 1, 1, 0) },
    docSym('Esc\x1b[31mape\nd', 14, 4, 0),
    docSym('last', 12, 5, 1),
  ] } });
  const start = a.pt;
  mx('consult-imenu');
  const { cands, anns } = await picker('Go to symbol: ');
  assert.equal(f.of('textDocument/didChange').length, 1, 'the change sent before the request');
  assert.deepEqual(f.of('textDocument/documentSymbol')[0], { textDocument: { uri: uri(pr['a.fake']) } });
  assert.deepEqual(cands, ['whole', 'outer', 'outer.inner', 'outer.other', 'Esc [31mape d', 'last', 'last <7>']);
  /* SymbolKind 12 is a function (CompletionItemKind 12 is a value); a kind past 26 is none */
  assert.deepEqual(anns, ['', 'class', 'method', 'field', 'constant', 'function', 'function']);
  /* previewed as the highlight moves, then C-g: point back */
  Ed.feedKey('C-n'); Ed.feedKey('C-n'); await Ed.whenIdle();
  assert.equal(a.pt, a.text.indexOf('inner'));
  Ed.feedKey('C-g');
  await done();
  assert.equal(a.pt, start);
  /* chosen: point at its name (after the 😀, two UTF-16 units) */
  mx('consult-imenu');
  await picker('Go to symbol: ');
  type('other'); Ed.feedKey('RET');
  await done();
  assert.equal(a.pt, a.text.indexOf('other'));
  mx('consult-imenu');
  await picker('Go to symbol: ');
  type('last <7>'); Ed.feedKey('RET');
  await done();
  assert.equal(a.pt, a.text.indexOf('last') + 1);
  assert.equal(a.text.slice(0, 3), '😀\n');
});

test("SymbolInformation: those of this file, named under their container; another file's and another scheme's left out", async () => {
  const f = fake();
  const pr = project('info', { 'a.fake': 'one\ntwo\n', 'b.fake': 'x\n' });
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/documentSymbol': { result: [
    symInfo('two', 12, uri(pr['a.fake']), 1, 0, 'Mod'),
    symInfo('elsewhere', 12, uri(pr['b.fake']), 0, 0),
    symInfo('remote', 12, 'jdt://x/y', 0, 0),
    symInfo('one', 13, uri(pr['a.fake']), 0, 0),
    { name: 'no range', kind: 13, location: { uri: uri(pr['a.fake']) } },
  ] } });
  mx('consult-imenu');
  const { cands, anns } = await picker('Go to symbol: ');
  assert.deepEqual(cands, ['one', 'Mod.two']);
  assert.deepEqual(anns, ['variable', 'function']);
  Ed.feedKey('RET');
  await done();
  assert.equal(a.pt, 0);
});

test("consult-imenu falls back to the buffer's own definitions: no server, no capability (not asked), a server not yet running (not asked), an error, no answer in time, no symbol of this file, the text changed while asked", async () => {
  const own = async (what: string) => {
    const { cands } = await picker('Go to definition: ');
    assert.deepEqual(cands, ['Alpha', 'Beta'], what);
    Ed.feedKey('C-g'); await done();
  };
  /* no server for the mode */
  await keys('ESC');
  L.call('find-file', [project('none', { 'a.plain': OWN })['a.plain']]);
  mx('consult-imenu'); await own('no server');
  /* the server gives no documentSymbolProvider: not asked */
  let f = fake({ workspaceSymbolProvider: true });
  const p1 = project('nocap', { 'a.fake': OWN });
  await open(p1['a.fake']);
  mx('consult-imenu'); await own('no capability');
  assert.equal(f.of('textDocument/documentSymbol').length, 0);
  /* the server still starting: not waited for, not asked */
  await Ed.lsp.shutdownAll();
  f = fake({ documentSymbolProvider: true, initDelay: 800 });
  await keys('ESC');
  const s0 = L.call('find-file', [project('starting', { 'a.fake': OWN })['a.fake']]) as Buf;
  assert.equal(Ed.lsp.sessionOf(s0).state, 'starting');
  mx('consult-imenu'); await own('starting');
  assert.equal(f.of('textDocument/documentSymbol').length, 0);
  await Ed.lsp.ready(Ed.lsp.sessionOf(s0));
  await Ed.lsp.shutdownAll();
  f = fake();
  const pr = project('fallback', { 'a.fake': OWN, 'b.fake': 'x\n' });
  const a = await open(pr['a.fake']);
  /* an error answer */
  f.answer({ 'textDocument/documentSymbol': { error: { code: -32603, message: 'broken' } } });
  mx('consult-imenu'); await own('an error');
  /* no answer in time */
  Ed.lsp.timing.request = 300;
  f.answer({ 'textDocument/documentSymbol': 'hang' });
  mx('consult-imenu'); await own('no answer');
  Ed.lsp.timing.request = DEFAULTS.request;
  /* empty, null, or only another file's */
  for (const result of [[], null, [symInfo('elsewhere', 12, uri(pr['b.fake']), 0, 0)]]) {
    f.answer({ 'textDocument/documentSymbol': { result } });
    mx('consult-imenu'); await own(JSON.stringify(result));
  }
  /* the text changed while the server answered: its places would be of another text */
  f.answer({ 'textDocument/documentSymbol': { delay: 400, result: [docSym('Alpha', 12, 2, 0)] } });
  const n = f.of('textDocument/documentSymbol').length;
  mx('consult-imenu');
  await until(() => f.of('textDocument/documentSymbol').length === n + 1, 'the request');
  a.pt = 0; Ed.insertText(a, 'y');
  await own('changed');
  /* unchanged, the server's */
  mx('consult-imenu');
  assert.deepEqual((await picker('Go to symbol: ')).cands, ['Alpha']);
});

test('consult-imenu: the answer to a buffer no longer current or killed dropped; C-g quits the wait, cancelling the request', async () => {
  const f = fake();
  const pr = project('drop', { 'a.fake': OWN, 'b.fake': OWN });
  const a = await open(pr['a.fake']);
  const b = await open(pr['b.fake']);
  f.answer({ 'textDocument/documentSymbol': { delay: 400, result: [docSym('Alpha', 12, 2, 0)] } });
  mx('consult-imenu');
  await until(() => f.of('textDocument/documentSymbol').length === 1, 'the request');
  Ed.setWindowBuffer(a);
  await done();
  assert.equal(E.mini, null);
  assert.match(E.echo, /^Symbols dropped: .*b\.fake is no longer the current buffer$/);
  mx('consult-imenu');
  await until(() => f.of('textDocument/documentSymbol').length === 2, 'the request');
  a.modified = false; L.call('kill-buffer', [a]);
  await done();
  assert.equal(E.mini, null);
  assert.match(E.echo, /^Symbols dropped: .*a\.fake is no longer the current buffer$/);
  /* C-g: a quit, the request cancelled, no fallback */
  Ed.setWindowBuffer(b);
  f.answer({ 'textDocument/documentSymbol': 'hang' });
  mx('consult-imenu');
  await until(() => f.of('textDocument/documentSymbol').length === 3, 'the request');
  Ed.feedKey('C-g');
  await done();
  assert.equal(E.mini, null);
  assert.equal(E.echo, 'Quit');
  await until(() => f.of('$/cancelRequest').length === 1, 'the request cancelled');
});

test('consult-imenu: at most 5000 symbols, children followed 32 levels down', async () => {
  const f = fake();
  const a = await open(project('bounds', { 'a.fake': 'x\n' })['a.fake']);
  let deep: Record<string, unknown> = docSym('d40', 13, 0, 0);
  for (let k = 39; k >= 0; k--) deep = docSym(`d${k}`, 13, 0, 0, [deep]);
  f.answer({ 'textDocument/documentSymbol': { result: [deep] } });
  mx('consult-imenu');
  let { cands } = await picker('Go to symbol: ');
  assert.equal(cands.length, 33);
  assert.ok(cands[32].endsWith('d31.d32'), cands[32]);
  Ed.feedKey('C-g'); await done();
  f.answer({ 'textDocument/documentSymbol': { result: Array.from({ length: 5001 }, (_, k) => docSym(`s${k}`, 13, 0, 0)) } });
  mx('consult-imenu');
  ({ cands } = await picker('Go to symbol: '));
  assert.equal(cands.length, 5000);
  assert.equal(cands[4999], 's4999');
  Ed.feedKey('C-g'); await done();
  assert.equal(a.pt, 0);
});

test('names cut at 200 characters, containers at 80, a name under others past 200 keeping its end', async () => {
  const f = fake();
  const pr = project('cuts', { 'a.fake': 'x\ny\n' });
  await open(pr['a.fake']);
  const long = 'n'.repeat(250), c = 'c'.repeat(100);
  f.answer({ 'textDocument/documentSymbol': { result: [docSym(long, 12, 0, 0, [docSym('child', 12, 0, 0)]), symInfo('t'.repeat(150), 12, uri(pr['a.fake']), 1, 0, c), symInfo('e'.repeat(198), 12, uri(pr['a.fake']), 1, 1, 'q😀')] },
    'workspace/symbol': { result: [symInfo(long, 12, uri(pr['a.fake']), 0, 0, c)] } });
  mx('consult-imenu');
  const { cands } = await picker('Go to symbol: ');
  /* the child: the parent's 200 and '…', '.child', its end kept; the container's 81 and '.', then 150; a surrogate
     pair at the cut not split */
  assert.deepEqual(cands, ['n'.repeat(200) + '…', '…' + 'n'.repeat(193) + '….child', '…' + 'c'.repeat(48) + '….' + 't'.repeat(150), '….' + 'e'.repeat(198)]);
  Ed.feedKey('C-g'); await done();
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  type('n');
  await until(() => Ed.miniCandidates(true).length, 'the answer');
  const ws = await picker('Workspace symbol: ');
  assert.deepEqual(ws.cands, ['n'.repeat(200) + '…']);
  assert.equal(ws.anns[0], `function  in ${'c'.repeat(80)}…  a.fake:1`);
});

test("consult-eglot-symbols asks for what is typed once the keys stop, lists the server's answer in its order, numbered and annotated; the one chosen visited, M-, comes back", async () => {
  const f = fake();
  const pr = project('ws', { 'a.fake': 'here\n', 'lib/b.fake': '😀 thing\nthings\n' });
  const a = await open(pr['a.fake']);
  a.pt = 2;
  const b = uri(pr['lib/b.fake']);
  f.answer({ 'workspace/symbol': { result: [
    symInfo('things', 13, b, 1, 0),
    symInfo('thing', 12, b, 0, 3, 'Mod\x1b'),
    'not a symbol', { name: '', kind: 12, location: { uri: b, range: range(0, 0, 0, 1) } },
    symInfo('remote', 12, 'jdt://x/y', 0, 0),
    { name: 'unresolved', kind: 12, location: { uri: b } },
    docSym('a document symbol', 12, 0, 0),
    { name: 'workspace symbol', kind: 23, location: { uri: b, range: range(1, 0, 1, 1) } },
    symInfo('thing', 6, uri('/elsewhere/c.fake'), 9, 0),
  ] } });
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  assert.equal(Ed.miniCandidates(true).length, 0, 'nothing before anything is typed');
  type('thi');
  await until(() => Ed.miniCandidates(true).length, 'the answer');
  /* asked once, for the input as the keys stopped */
  assert.deepEqual(f.of('workspace/symbol'), [{ query: 'thi' }]);
  const { cands, anns } = await picker('Workspace symbol: ');
  assert.deepEqual(cands, ['things', 'thing', 'workspace symbol', 'thing (2)'], 'the server\'s order, as it matched them');
  assert.deepEqual(anns, ['variable  lib/b.fake:2', 'function  in Mod  lib/b.fake:1', 'struct  lib/b.fake:2', 'method  /elsewhere/c.fake:10']);
  /* the highlight moved while the next input is asked for: the new answer's first highlighted */
  Ed.lsp.timing.symbols = 300;
  type('n'); Ed.feedKey('C-n');
  await until(() => E.mini.index === 1, 'the highlight moved');
  await until(() => f.of('workspace/symbol').length === 2, 'thin asked');
  await until(() => E.mini.index === 0, 'the first highlighted');
  Ed.feedKey('DEL');
  Ed.lsp.timing.symbols = 50;
  await until(() => f.of('workspace/symbol').length === 3, 'thi asked again');
  await until(() => Ed.miniCandidates(true).includes('workspace symbol'), 'the answer for thi');
  /* back to the input answered: not asked again */
  type('n'); Ed.feedKey('DEL');
  await sleep(200);
  assert.equal(f.of('workspace/symbol').length, 3, 'thi not asked again');
  /* the second chosen: at its place, after the 😀 (two UTF-16 units) */
  Ed.feedKey('C-n'); Ed.feedKey('RET');
  await done();
  const v = current();
  assert.equal(v.file, pr['lib/b.fake']);
  assert.equal(v.pt, v.text.indexOf('thing'));
  await keys('M-,');
  assert.equal(current(), a);
  assert.equal(a.pt, 2);
  /* RET before the answer for the input: the first of the last answer as the minibuffer filters it */
  Ed.lsp.timing.symbols = 5000;
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  Ed.lsp.timing.symbols = 50;
  type('thi');
  await until(() => Ed.miniCandidates(true).length, 'the answer');
  Ed.lsp.timing.symbols = 5000;
  type('ngs'); Ed.feedKey('RET');
  await done();
  assert.equal(current().pt, v.text.indexOf('things'));
  assert.equal(f.of('workspace/symbol').length, 4, 'thin, thing and things not asked');
});

test('consult-eglot-symbols: a blank input not asked, an answer for an input no longer shown dropped, an error flashed, C-g cancels what is pending', async () => {
  const f = fake();
  const pr = project('ws2', { 'a.fake': 'x\n', 'b.fake': 'one\ntwo\n' });
  await open(pr['a.fake']);
  const b = uri(pr['b.fake']);
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  type('   ');
  await sleep(200);
  assert.equal(f.of('workspace/symbol').length, 0, 'a blank input not asked');
  Ed.feedKey('C-g'); await done();
  /* an answer that comes once the input changed: dropped, the new input's shown */
  f.answer({ 'workspace/symbol': { delay: 300, result: [symInfo('one', 12, b, 0, 0)] } });
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  type('o');
  await until(() => f.of('workspace/symbol').length === 1, 'the first request');
  f.answer({ 'workspace/symbol': { result: [symInfo('two', 12, b, 1, 0)] } });
  type('x');
  await until(() => f.of('workspace/symbol').length === 2, 'the second request');
  assert.deepEqual(f.of('$/cancelRequest').length, 1, 'the first cancelled');
  await until(() => Ed.miniCandidates(true).length, 'the second answer');
  await sleep(400);
  assert.deepEqual(Ed.miniCandidates(true), ['two'], 'the answer for ox, unfiltered; the late one for o dropped');
  assert.equal(E.miniFlash, '', 'the cancelled request not flashed');
  Ed.feedKey('C-g'); await done();
  /* an error answer: flashed after the input */
  f.answer({ 'workspace/symbol': { error: { code: -32603, message: 'index not ready' } } });
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  type('t');
  await until(() => /index not ready/.test(E.miniFlash || ''), 'the error flashed');
  Ed.feedKey('C-g'); await done();
  /* C-g while a request waits: cancelled */
  f.answer({ 'workspace/symbol': 'hang' });
  const cancels = f.of('$/cancelRequest').length;
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  type('t');
  await until(() => f.of('workspace/symbol').length === 4, 'the request');
  Ed.feedKey('C-g'); await done();
  await until(() => f.of('$/cancelRequest').length === cancels + 1, 'the request cancelled');
  /* C-g before the keys stopped: nothing asked */
  Ed.lsp.timing.symbols = 300;
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  type('t');
  Ed.feedKey('C-g'); await done();
  await sleep(500);
  assert.equal(f.of('workspace/symbol').length, 4, 'nothing asked after C-g');
  /* the server gone while the list is open: nothing asked, nothing thrown */
  Ed.lsp.timing.symbols = 50;
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  await Ed.lsp.shutdownAll();
  type('t');
  await sleep(200);
  assert.equal(f.of('workspace/symbol').length, 4);
  Ed.feedKey('C-g'); await done();
});

test("consult-eglot-symbols: a place in the same buffer, C-o comes back; a name numbered past a label the server gave", async () => {
  const f = fake();
  const pr = project('ws-jump', { 'a.fake': 'x\n\ndef x\n' });
  const a = await open(pr['a.fake']);
  a.pt = 0;
  const u = uri(pr['a.fake']);
  f.answer({ 'workspace/symbol': { result: [symInfo('x', 12, u, 2, 4), symInfo('x (2)', 12, u, 0, 0), symInfo('x', 12, u, 0, 0), symInfo('x', 12, u, 0, 0)] } });
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  type('x');
  await until(() => Ed.miniCandidates(true).length, 'the answer');
  assert.deepEqual((await picker('Workspace symbol: ')).cands, ['x', 'x (2)', 'x (3)', 'x (4)']);
  Ed.feedKey('RET');
  await done();
  assert.equal(current(), a);
  assert.equal(a.pt, a.text.lastIndexOf('x'), 'line 3, column 5');
  await keys('C-o');
  assert.equal(current(), a);
  assert.equal(a.pt, 0);
});

test('consult-eglot-symbols: no server, a server with no workspaceSymbolProvider (not asked), a place whose file is gone', async () => {
  await keys('ESC');
  L.call('find-file', [project('ws-none', { 'a.plain': 'x\n' })['a.plain']]);
  mx('consult-eglot-symbols');
  await done();
  assert.equal(E.echo, 'No language server for this buffer (M-x eglot starts one)');
  let f = fake({ documentSymbolProvider: true });
  await open(project('ws-nocap', { 'a.fake': 'x\n' })['a.fake']);
  mx('consult-eglot-symbols');
  await done();
  assert.equal(E.echo, 'fake gives no workspace symbols');
  assert.equal(E.mini, null);
  await Ed.lsp.shutdownAll();
  f = fake();
  const pr = project('ws-gone', { 'a.fake': 'x\n' });
  const a = await open(pr['a.fake']);
  f.answer({ 'workspace/symbol': { result: [symInfo('gone', 12, uri(path.join(pr.dir, 'gone.fake')), 0, 0)] } });
  mx('consult-eglot-symbols');
  await picker('Workspace symbol: ');
  type('g');
  await until(() => Ed.miniCandidates(true).length, 'the answer');
  Ed.feedKey('RET');
  await done();
  assert.match(E.echo, /gone\.fake: no such file$/);
  assert.equal(current(), a);
  await keys('M-,');
  assert.equal(E.echo, 'At the start of the xref history', 'no place recorded for a visit that failed');
});

test('SPC p s is consult-eglot-symbols, and the desktop-only stub is gone', async () => {
  assert.equal(L.evalText('(symbol->string (lookup-key evil-normal-state-map "SPC p s"))'), 'consult-eglot-symbols');
  await keys('ESC');
  L.call('find-file', [project('key', { 'a.plain': 'x\n' })['a.plain']]);
  await keys('SPC p s');
  assert.equal(E.echo, 'No language server for this buffer (M-x eglot starts one)');
});

test('nil: the attributes of a Nix file as document symbols, nested; no workspace symbols', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL names no nil' }, async () => {
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command (list ${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const pr = project('nil', { 'default.nix': '{\n  foo = 1;\n  bar = { baz = 2; };\n}\n' });
  const b = await open(pr['default.nix']);
  assert.ok((Ed.lsp.sessionOf(b).capabilities || {}).documentSymbolProvider, 'nil gives document symbols');
  mx('consult-imenu');
  const { cands, anns } = await picker('Go to symbol: ');
  assert.deepEqual(cands, ['foo', 'bar', 'bar.baz']);
  assert.deepEqual(anns, ['field', 'field', 'field']);
  type('bar.baz'); Ed.feedKey('RET');
  await done();
  assert.equal(b.pt, b.text.indexOf('baz'));
  mx('consult-eglot-symbols');
  await done();
  assert.equal(E.echo, 'nil gives no workspace symbols');
  Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  await until(() => proc.running().length === 0, 'nil ended');
});
