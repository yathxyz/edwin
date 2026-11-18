// Hover and signature help (src/lsp.ts): K's hover and the signatures shown while typing, against a stand-in
// server that is a real child through Ed.proc (fake-proc.mts). It answers each textDocument/* request with what
// the suite wrote for that method in its answers file (a result, an error, nothing at all, or a result after a
// delay), logs every message (a request with its id) and keeps each document's text, so a request's position can
// be checked against the text the server holds. Then nil from nixpkgs (when EDWIN_LSP_REAL names it): K on a
// builtin.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-eldoc-')));
host.files = {
  cwd: tmp, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(tmp, p),
  read: (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
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
  if (E.mini) await keys('C-g');
  await keys('ESC');
  await Ed.lsp.shutdownAll();
  for (const b of E.buffers.slice()) if (b.file) { b.modified = false; L.call('kill-buffer', [b]); }
  Object.assign(Ed.lsp.timing, DEFAULTS);
  Ed.lsp.timing.eldoc = 100;
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
/* KEYS typed, then the command loop idle again (K waiting on its server holds it until it ends). */
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
/* TEXT typed key by key, all at once (no wait between keys), then the loop idle. */
const type = async (text: string) => { for (const ch of text) Ed.feedKey(ch === ' ' ? 'SPC' : ch); await until(() => E.running === 0, 'the keys to end'); await Ed.whenIdle(); };
const messages = () => (E.buffers.find((b: { name: string }) => b.name === '*Messages*') || { text: '' }).text as string;

/* The stand-in: node SCRIPT LOG ANSWERS CAPS. ANSWERS is a JSON file read at each request: by method, the result
   ({"result": R}), the result after a delay ({"result": R, "delay": MS}), an error ({"error": {...}}) or "hang" (no
   answer). CAPS is the capabilities it answers initialize with (whole-text sync always). Each message is logged as
   "METHOD PARAMS", a request also as "id METHOD ID"; a request's position also as "at METHOD TEXT", TEXT what the
   document holds from that position to its line's end. */
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
      note('id ' + m.method + ' ' + m.id);
      const t = docs.get(p.textDocument && p.textDocument.uri);
      if (p.position) note('at ' + m.method + ' ' + JSON.stringify(t === undefined ? null : rest(t, p.position)));
      const a = JSON.parse(fs.readFileSync(answers, 'utf8'))[m.method];
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
const ALL = { hoverProvider: true, signatureHelpProvider: { triggerCharacters: ['(', ','] } };
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
  /* the ids of the METHOD requests, in order */
  const ids = (method: string) => lines().filter(l => l.method === 'id' && l.rest.startsWith(method + ' ')).map(l => Number(l.rest.slice(method.length + 1)));
  const cancels = () => of('$/cancelRequest').map((p: { id: number }) => p.id);
  const answer = (a: Record<string, unknown>) => fs.writeFileSync(answers, JSON.stringify(a));
  return { lines, of, at, ids, cancels, answer };
}
/* A project (with a .git) under NAME holding FILES (path: text) on the disk; their absolute paths. */
function project(name: string, files: Record<string, string>): Record<string, string> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); out[f] = p; }
  return { dir, ...out };
}
type Buf = { text: string; file: string | null; mode: string; pt: number; name: string; ver: number; evilState: string };
/* P visited in the selected window, its server ready, in Normal state. */
async function open(p: string): Promise<Buf> {
  await keys('ESC');
  const b = L.call('find-file', [p]) as Buf;
  const s = Ed.lsp.sessionOf(b);
  assert.ok(s, E.echo);
  await Ed.lsp.ready(s);
  return b;
}
const hover = (contents: unknown) => ({ 'textDocument/hover': { result: contents === null ? null : { contents } } });
const SIG = { signatures: [{ label: 'add(a: int, b: int) -> int', parameters: [{ label: 'a: int' }, { label: [12, 18] }] }], activeParameter: 1 };

test('initialize says what the client asks for: hover and signature help, plain text first', async () => {
  const f = fake();
  await open(project('caps', { 'a.fake': 'x\n' })['a.fake']);
  const td = f.of('initialize')[0].capabilities.textDocument;
  assert.deepEqual(td.hover, { contentFormat: ['plaintext', 'markdown'] });
  assert.deepEqual(td.signatureHelp, { signatureInformation: { documentationFormat: ['plaintext', 'markdown'], parameterInformation: { labelOffsets: true }, activeParameterSupport: true } });
  assert.ok(td.definition, 'the cross references are still asked for');
});

test('K: the hover at point in the echo area, at a UTF-16 position after the pending edit, not logged; each shape of contents', async () => {
  const f = fake();
  const a = await open(project('k', { 'a.fake': '😀 thing here\n' })['a.fake']);
  a.pt = a.text.indexOf('thing');
  Ed.insertText(a, 'X');   // not yet sent: K flushes it
  a.pt = a.text.indexOf('thing');
  f.answer(hover({ kind: 'markdown', value: '```fake\nthing: int\n```\n\n\n\nA thing.\n' }));
  const logged = messages().length;
  await keys('K');
  assert.equal(E.echo, 'thing: int\n\nA thing.', 'fences left out, the blank lines one');
  assert.equal(messages().length, logged, 'nothing in *Messages*');
  assert.deepEqual(f.at('textDocument/hover'), ['thing here'], 'the didChange first, the position after 😀 in UTF-16 units');
  assert.equal(f.of('textDocument/didChange').length, 1);
  assert.equal(E.current, a);
  await keys('l');
  assert.equal(E.echo, '', 'the next key clears it');
  const shapes: [unknown, string][] = [
    ['plain *marked*', 'plain *marked*'],
    [{ language: 'fake', value: 'x: int' }, 'x: int'],
    [['first', { language: 'fake', value: 'second' }, ''], 'first\n\nsecond'],
    [{ kind: 'plaintext', value: '  text\r\nwith\rends  ' }, 'text\nwith\nends'],
    [{ kind: 'plaintext', value: 'red \x1b[31mthing\x1b[0m\x07 \ttab' }, 'red  [31mthing [0m   tab'],
  ];
  for (const [c, want] of shapes) {
    f.answer(hover(c));
    await keys('K');
    assert.equal(E.echo, want, JSON.stringify(c));
  }
  f.answer(hover('y'.repeat(5000)));
  await keys('K');
  assert.equal(E.echo, 'y'.repeat(4096) + '…', 'cut at 4096 characters');
  for (const c of [null, '', [], { kind: 'markdown', value: '```\n```' }, 42]) {
    f.answer(hover(c));
    await keys('K');
    assert.equal(E.echo, 'No documentation here', JSON.stringify(c));
  }
  f.answer({ 'textDocument/hover': { error: { code: -32603, message: 'it broke' } } });
  await keys('K');
  assert.match(E.echo, /it broke/);
  assert.equal(f.of('textDocument/hover').length, 13);
});

test('K where the server gives no hover says so and asks nothing; K with no server is evil-lookup', async () => {
  const f = fake({ signatureHelpProvider: {} });
  const pr = project('nohover', { 'a.fake': 'x\n' });
  await open(pr['a.fake']);
  await keys('K');
  assert.equal(E.echo, 'fake gives no hover documentation');
  assert.equal(f.of('textDocument/hover').length, 0);
  const t = L.call('find-file', [path.join(pr.dir, 'plain.txt')]) as Buf;
  Ed.insertText(t, 'zzqq');
  t.pt = 1;
  await keys('K');
  assert.equal(E.echo, 'Nothing named zzqq', 'Evil\'s K where eglot-mode is off');
});

test('K on a server that does not answer: C-g quits and cancels the request; past timing.request it says so', async () => {
  const f = fake();
  const a = await open(project('hang', { 'a.fake': 'abc\n' })['a.fake']);
  f.answer({ 'textDocument/hover': 'hang' });
  Ed.feedKey('K');
  await until(() => f.ids('textDocument/hover').length === 1, 'the request');
  assert.ok(E.running > 0, 'the command waits');
  Ed.feedKey('C-g');
  await until(() => E.running === 0, 'the command over');
  assert.equal(E.echo, 'Quit');
  await until(() => f.cancels().includes(f.ids('textDocument/hover')[0]), 'its cancel sent');
  Ed.lsp.timing.request = 200;
  await keys('K');
  assert.match(E.echo, /textDocument\/hover/);
  await until(() => f.cancels().length === 2, 'the timed-out request cancelled');
  await keys('l');
  assert.equal(a.pt, 1, 'keys work again');
});

test('typing: one signature request once the keys stop, shown with its active parameter, not logged; shown again after each key until the next answer', async () => {
  const f = fake();
  const a = await open(project('sig', { 'a.fake': '😀 x\n' })['a.fake']);
  f.answer({ 'textDocument/signatureHelp': { result: SIG } });
  a.pt = a.text.indexOf('x');
  await keys('i');
  await until(() => f.ids('textDocument/signatureHelp').length === 1, 'entering Insert state asks');
  await until(() => E.echo === 'add(a: int, ‹b: int›) -> int', 'the signature shown');
  const logged = messages().length;
  Ed.lsp.timing.eldoc = 1000;
  for (const ch of 'add(1, 2') { Ed.feedKey(ch === ' ' ? 'SPC' : ch); await sleep(20); }   // keys 20 ms apart, well under the debounce
  await until(() => E.running === 0, 'the keys to end');
  await until(() => f.ids('textDocument/signatureHelp').length === 2, 'the request once the keys stopped');
  await sleep(1100);
  assert.equal(f.ids('textDocument/signatureHelp').length, 2, 'eight keys, one request');
  assert.equal(f.of('textDocument/didChange').length, 1, 'the edits sent first, once');
  assert.deepEqual(f.at('textDocument/signatureHelp')[1], a.text.slice(a.pt, a.text.indexOf('\n')), 'the server was asked at point');
  assert.equal(messages().length, logged, 'nothing in *Messages*');
  Ed.lsp.timing.eldoc = 1500;   // long enough that the checks below run before the next request
  f.answer({ 'textDocument/signatureHelp': { result: null } });
  await type('3');
  assert.equal(E.echo, 'add(a: int, ‹b: int›) -> int', 'kept while the next request waits');
  assert.equal(f.ids('textDocument/signatureHelp').length, 2);
  await until(() => f.ids('textDocument/signatureHelp').length === 3, 'the next request');
  await until(() => E.echo === '', 'a null answer clears it');
  await type('4');
  assert.equal(E.echo, '', 'nothing shown again');
  await keys('ESC');
  const n = f.ids('textDocument/signatureHelp').length;
  await keys('h h l');
  await sleep(500);
  assert.equal(f.ids('textDocument/signatureHelp').length, n, 'nothing asked in Normal state');
  assert.equal(n, 3, 'the last key\'s request was never sent: ESC came before its debounce ran out');
  assert.deepEqual(f.cancels(), []);
});

test('signature labels: the active signature, its own active parameter, a parameter found by its text after the (, control characters and the cut', async () => {
  const f = fake();
  const a = await open(project('labels', { 'a.fake': 'x\n' })['a.fake']);
  const cases: [unknown, string][] = [
    [{ signatures: [{ label: 'a(a)', parameters: [{ label: 'a' }] }], activeParameter: 0 }, 'a(‹a›)'],
    [{ signatures: [{ label: 'one()' }, { label: 'f(x, y)', parameters: [{ label: 'x' }, { label: 'y' }], activeParameter: 1 }], activeSignature: 1, activeParameter: 0 }, 'f(x, ‹y›)'],
    [{ signatures: [{ label: 'g(p)', parameters: [{ label: 'p' }] }], activeSignature: 7, activeParameter: 3 }, 'g(p)'],
    [{ signatures: [{ label: 'h(\n  a,\n  b\n)\x1b[2J', parameters: [{ label: [10, 11] }] }], activeParameter: 0 }, 'h( a, ‹b› ) [2J'],
    [{ signatures: [{ label: 'k(p)', parameters: [{ label: [2, 9] }] }], activeParameter: 0 }, 'k(p)'],
    [{ signatures: [{ label: 'z'.repeat(600) }] }, 'z'.repeat(500) + '…'],
  ];
  await keys('A');
  for (const [res, want] of cases) {
    f.answer({ 'textDocument/signatureHelp': { result: res } });
    const n = f.ids('textDocument/signatureHelp').length;
    await type('y');
    await until(() => f.ids('textDocument/signatureHelp').length === n + 1, 'the request');
    await until(() => E.echo === want, `${want} shown (${E.echo})`);
  }
  for (const res of [{ signatures: [] }, { signatures: [{ label: 3 }] }, 'nonsense']) {
    f.answer({ 'textDocument/signatureHelp': { result: res } });
    const n = f.ids('textDocument/signatureHelp').length;
    await type('y');
    await until(() => f.ids('textDocument/signatureHelp').length === n + 1, 'the request');
    await until(() => E.echo === '', `${JSON.stringify(res)}: nothing shown`);
  }
  assert.equal(a.evilState, 'insert');
});

test('requests cancelled on movement: point moved while the answer is on its way cancels it and the late answer is not shown; the new place is asked', async () => {
  const f = fake();
  await open(project('move', { 'a.fake': 'abc def\n' })['a.fake']);
  f.answer({ 'textDocument/signatureHelp': { result: SIG, delay: 2000 } });
  await keys('A');
  await until(() => f.ids('textDocument/signatureHelp').length === 1, 'the request');
  const first = f.ids('textDocument/signatureHelp')[0];
  await keys('<left>');
  await until(() => f.cancels().includes(first), 'its cancel sent');
  f.answer({ 'textDocument/signatureHelp': 'hang' });
  await until(() => f.ids('textDocument/signatureHelp').length === 2, 'the new place asked');
  assert.deepEqual(f.at('textDocument/signatureHelp'), ['', 'f'], 'at the end, then one to the left');
  await sleep(2200);   // past the answer's delay
  assert.equal(E.echo, '', 'the late answer is not shown');
  /* an edit, another buffer and leaving Insert state cancel it too */
  await type('Q');
  await until(() => f.cancels().length === 2, 'the edit cancelled the second');
  await until(() => f.ids('textDocument/signatureHelp').length === 3, 'the third');
  await keys('ESC');
  await until(() => f.cancels().length === 3, 'Normal state cancelled the third');
  assert.deepEqual(f.cancels(), f.ids('textDocument/signatureHelp'));
});

test('a request waiting while the minibuffer is open or a message shows: its answer leaves them', async () => {
  const f = fake();
  await open(project('mini', { 'a.fake': 'abc\n' })['a.fake']);
  f.answer({ 'textDocument/signatureHelp': { result: SIG, delay: 1000 } });
  await keys('A');
  await until(() => f.ids('textDocument/signatureHelp').length === 1, 'the request');
  Ed.feedKey('M-x');
  await until(() => E.mini, 'the minibuffer');
  await sleep(1200);   // past the answer's delay
  assert.ok(E.mini, 'still open');
  assert.notEqual(E.echo, 'add(a: int, ‹b: int›) -> int');
  Ed.feedKey('C-g');
  await until(() => !E.mini && E.running === 0, 'the minibuffer closed');
  await type('x');
  await until(() => f.ids('textDocument/signatureHelp').length === 2, 'the second request');
  Ed.message('a message');
  await sleep(1200);
  assert.equal(E.echo, 'a message');
});

test('no signature help: typing asks nothing; the session shut down while a request waits leaves nothing behind', async () => {
  const f = fake({ hoverProvider: true });
  const pr = project('nosig', { 'a.fake': 'abc\n', 'b.fake': 'abc\n' });
  await open(pr['a.fake']);
  await keys('A');
  await type('hello');
  await sleep(300);
  assert.equal(f.ids('textDocument/signatureHelp').length, 0);
  await keys('ESC');
  const g = fake();
  const b = await open(path.join(project('down', { 'a.fake': 'x\n' }).dir, 'a.fake'));
  g.answer({ 'textDocument/signatureHelp': 'hang' });
  await keys('A');
  await until(() => g.ids('textDocument/signatureHelp').length === 1, 'the request');
  await Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  await type('z');
  await sleep(300);
  assert.equal(E.echo, '');
  assert.equal(proc.running().length, 1, 'only the first project\'s server runs');
});

test('nil: K on a builtin shows its documentation', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL names no nil' }, async () => {
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command (list ${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const pr = project('nil', { 'default.nix': '# 😀\nlet\n  x = 1;\nin\n  /* 𝄞 */ builtins.toString x\n' });
  const b = await open(pr['default.nix']);
  assert.equal(b.mode, 'nix-mode');
  b.pt = b.text.indexOf('toString') + 2;
  await keys('K');
  assert.equal(E.current, b);
  assert.match(E.echo, /toString/, E.echo);
  assert.match(E.echo, /string/i);
  assert.doesNotMatch(E.echo, /```/);
  Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  await until(() => proc.running().length === 0, 'nil ended');
});
