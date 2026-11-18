// Completion (src/lsp.ts, src/complete.ts): the server's items in the completion popup, against a stand-in server
// that is a real child through Ed.proc (fake-proc.mts). It answers textDocument/completion with what the suite
// wrote in its answers file (a result, an error, nothing at all, or a result after a delay), logs every message (a
// request with its id) and keeps each document's text, so a request's position can be checked against the text
// the server holds. Then nil from nixpkgs (when EDWIN_LSP_REAL names it): a builtin completed.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-completion-')));
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
  for (const b of E.buffers.slice()) if (b.file) { b.modified = false; b.readOnly = false; L.call('kill-buffer', [b]); }
  Object.assign(Ed.lsp.timing, DEFAULTS);
  Ed.lsp.timing.completion = 50;
  Ed.lsp.timing.eldoc = 60_000;
  L.evalText('(set! corfu-auto #t)');
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
/* KEYS typed, then the command loop idle again (a command waiting on its server holds it until it ends). */
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
/* TEXT typed key by key, all at once (no wait between keys), then the loop idle. */
const type = async (text: string) => { for (const ch of text) Ed.feedKey(ch === ' ' ? 'SPC' : ch); await until(() => E.running === 0, 'the keys to end'); await Ed.whenIdle(); };
const popup = () => (E.corfu ? E.corfu.cands.map((c: { text: string }) => c.text) : null);
const anns = () => (E.corfu ? E.corfu.cands.map((c: { ann: string }) => c.ann) : null);

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
const ALL = { completionProvider: { triggerCharacters: ['.'] } };
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
  const asked = () => ids('textDocument/completion').length;
  return { lines, of, at, ids, cancels, answer, asked };
}
/* A project (with a .git) under NAME holding FILES (path: text) on the disk; their absolute paths. */
function project(name: string, files: Record<string, string>): Record<string, string> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); out[f] = p; }
  return { dir, ...out };
}
type Buf = { text: string; file: string | null; mode: string; pt: number; name: string; ver: number; evilState: string; readOnly: boolean; modified: boolean };
/* P visited in the selected window, its server ready, in Normal state. */
async function open(p: string): Promise<Buf> {
  await keys('ESC');
  const b = L.call('find-file', [p]) as Buf;
  const s = Ed.lsp.sessionOf(b);
  assert.ok(s, E.echo);
  await Ed.lsp.ready(s);
  return b;
}
const pos = (line: number, character: number) => ({ line, character });
const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: pos(l1, c1), end: pos(l2, c2) });
const items = (list: unknown, extra: Record<string, unknown> = {}) => ({ 'textDocument/completion': { result: list, ...extra } });

test('initialize says what the client asks for: completion, no snippets, the context', async () => {
  const f = fake();
  await open(project('caps', { 'a.fake': 'x\n' })['a.fake']);
  const td = f.of('initialize')[0].capabilities.textDocument;
  assert.deepEqual(td.completion, { completionItem: { snippetSupport: false }, contextSupport: true });
  assert.ok(td.hover && td.rename, 'the other requests are still asked for');
});

test('typing: one request once the keys stop, the server\'s items in the popup (not the words), filtered as the word grows without asking again; the item goes in with its edit and its import, one undo step', async () => {
  const f = fake();
  const a = await open(project('auto', { 'a.fake': '😀 header\nprivate printer\n\n' })['a.fake']);
  f.answer(items([
    { label: 'print', kind: 3, detail: 'fn(s: str)', textEdit: { range: range(2, 0, 2, 3), newText: 'print' }, additionalTextEdits: [{ range: range(0, 0, 0, 0), newText: 'import io\n' }] },
    { label: 'printf', kind: 3, sortText: '0' },
    { label: 'pristine', kind: 6 },
    { label: 'sprint', kind: 3 },
    { label: 'zzz', kind: 14, filterText: 'aprix' },
    { label: 'other' },
  ]));
  a.pt = a.text.indexOf('\n\n') + 1;
  await keys('i');
  await type('pri');
  await until(() => popup(), 'the popup');
  assert.equal(f.asked(), 1, 'three keys, one request');
  assert.deepEqual(f.at('textDocument/completion'), [''], 'asked at point, the typed word sent first');
  assert.deepEqual(f.of('textDocument/completion')[0].context, { triggerKind: 1 });
  assert.deepEqual(popup(), ['printf', 'print', 'pristine', 'sprint', 'zzz'], 'sortText first, then labels; those holding the word after those starting with it; private and printer (the buffer\'s words) not offered');
  assert.deepEqual(anns(), ['function', 'fn(s: str)', 'variable', 'function', 'keyword'], 'the detail, else the kind');
  await type('n');
  assert.deepEqual(popup(), ['printf', 'print', 'sprint'], 'filtered again at once');
  await sleep(200);
  assert.equal(f.asked(), 1, 'a complete answer is not asked again');
  await keys('C-n');
  await keys('RET');
  assert.equal(a.text, 'import io\n😀 header\nprivate printer\nprint\n', 'the edit over the word typed since (prin), and the import');
  assert.equal(a.pt, a.text.lastIndexOf('print') + 5, 'point after the item');
  assert.equal(E.corfu, null);
  await keys('ESC u');
  assert.equal(a.text, '😀 header\nprivate printer\n\n', 'one undo: the insertion, the item and its import');
});

test('the answer kept is asked again for another word, a word changed before where it was asked, point back before it, another buffer', async () => {
  const f = fake();
  const pr = project('again', { 'a.fake': '\n', 'b.fake': 'pri\n' });
  const a = await open(pr['a.fake']);
  f.answer(items([{ label: 'print' }, { label: 'pprint' }, { label: 'ppprint' }]));
  await keys('i');
  await type('pri');
  await until(() => popup(), 'the popup');
  assert.equal(f.asked(), 1);
  await type(' pri');
  await until(() => f.asked() === 2, 'another word asked again');
  await until(() => popup(), 'the popup');
  await keys('DEL');
  await type('x');
  await until(() => f.asked() === 3, 'the word changed before where it was asked: asked again');
  await keys('ESC');
  a.text = '\n'; a.pt = 0;
  await keys('i');
  await type('pppp');
  await until(() => f.asked() === 4, 'asked at pppp');
  await keys('<left> <left>');
  await type('p');
  assert.equal(a.text, 'ppppp\n');
  await until(() => f.asked() === 5, 'point back before where it was asked: asked again');
  await keys('ESC');
  /* another buffer made current by no command, its text and point those the answer was of with a key more */
  a.text = '\n'; a.pt = 0;
  await keys('i');
  await type('pri');
  await until(() => f.asked() === 6 && popup(), 'asked in a.fake');
  const b = Ed.visit(pr['b.fake']) as Buf;
  await Ed.lsp.ready(Ed.lsp.sessionOf(b));
  Ed.setWindowBuffer(b);
  b.pt = 3; b.evilState = 'insert';
  await type('n');
  assert.equal(b.text, 'prin\n');
  await until(() => f.asked() === 7, 'asked in b.fake');
});

test('an incomplete answer is asked again as the word grows (triggerKind 3), its candidates shown meanwhile', async () => {
  const f = fake();
  await open(project('incomplete', { 'a.fake': '\n' })['a.fake']);
  f.answer(items({ isIncomplete: true, items: [{ label: 'alpha' }, { label: 'alps' }] }));
  await keys('i');
  await type('alp');
  await until(() => popup(), 'the popup');
  f.answer(items({ isIncomplete: false, items: [{ label: 'alphabet' }] }));
  await type('h');
  assert.deepEqual(popup(), ['alpha'], 'the kept answer filtered meanwhile');
  await until(() => f.asked() === 2, 'asked again');
  assert.deepEqual(f.of('textDocument/completion')[1].context, { triggerKind: 3 });
  await until(() => popup()?.[0] === 'alphabet', 'the new answer shown');
  await type('a');
  await sleep(200);
  assert.equal(f.asked(), 2, 'that answer was complete');
  assert.deepEqual(popup(), ['alphabet']);
});

test('no server items: the words of the buffers instead (an empty answer, a server with no completion, a word too short)', async () => {
  const f = fake();
  const pr = project('fallback', { 'a.fake': 'qwzzy qwzzing\n\n' });
  const a = await open(pr['a.fake']);
  f.answer(items([]));
  a.pt = a.text.length - 1;
  await keys('i');
  await type('qwz');
  await until(() => f.asked() === 1 && popup(), 'asked, then the words');
  assert.deepEqual(popup(), ['qwzzing', 'qwzzy']);
  f.answer(items([{ label: 'nothing' }]));
  await type('z');
  assert.deepEqual(popup(), ['qwzzing', 'qwzzy'], 'the kept answer matches nothing: the words');
  await keys('ESC o');
  await type('qw');
  await sleep(200);
  assert.equal(f.asked(), 1, 'a word of two characters asks nothing');
  assert.equal(popup(), null);
  await keys('ESC');
  const g = fake({ hoverProvider: true });
  const b = await open(path.join(project('nocompletion', { 'a.fake': 'xkcdy xkcding\n\n' }).dir, 'a.fake'));
  b.pt = b.text.length - 1;
  await keys('i');
  await type('xkc');
  assert.deepEqual(popup(), ['xkcding', 'xkcdy'], 'at once: the server is not asked');
  await sleep(200);
  assert.equal(g.asked(), 0);
  await keys('ESC o');
  await type('qw');
  await sleep(200);
  assert.equal(g.asked(), 0);
  assert.equal(popup(), null, 'two characters open nothing');
});

const BOOM = { 'textDocument/completion': { error: { code: -32603, message: 'boom' } } };
test('an error answer to C-SPC: the words instead, the error said; with no words, the error', async () => {
  const f = fake();
  const a = await open(project('error-explicit', { 'a.fake': 'zebra zebu\n\n' })['a.fake']);
  L.evalText('(set! corfu-auto #f)');
  f.answer(BOOM);
  a.pt = a.text.length - 1;
  await keys('i');
  await type('zeb');
  await keys('C-SPC');
  assert.equal(f.asked(), 1);
  assert.deepEqual(popup(), ['zebra', 'zebu'], 'the words');
  assert.match(E.echo, /boom/);
  await keys('ESC');
  await keys('o');
  await type('qq');
  await keys('C-SPC');
  assert.equal(f.asked(), 2);
  assert.equal(popup(), null);
  assert.match(E.echo, /boom/, 'no words: the error itself');
});

test('an error answer while typing: the words instead', async () => {
  const f = fake();
  const a = await open(project('error-auto', { 'a.fake': 'zebra zebu\n\n' })['a.fake']);
  f.answer(BOOM);
  a.pt = a.text.length - 1;
  await keys('i');
  await type('zeb');
  await until(() => f.asked() === 1 && popup(), 'asked, then the words');
  assert.deepEqual(popup(), ['zebra', 'zebu']);
});

test('snippets go in as their plain text; labels are made fit for the popup', async () => {
  const f = fake();
  const a = await open(project('snip', { 'a.fake': '\n' })['a.fake']);
  const cases: [string, string][] = [
    ['foo(${1:x}, $2)$0', 'foo(x, )'],
    ['${1:outer ${2:inner}} end', 'outer inner end'],
    ['${1|one,two|} \\$HOME \\} \\\\', 'one $HOME } \\'],
    ['${TM_FILENAME} $TM_SELECTED_TEXT ${VAR:def}', '  def'],
    ['cost $ 5 ${', 'cost $ 5 ${'],
    ['${1|a,${2|b|} c', 'a c'],
    ['${1|a ${2:b} ${3|c|}', 'a ${2:b} ${3|c'],
    ['${1|a ${2:b} ${3|c', '${1|a b ${3|c'],
  ];
  for (const [snippet, want] of cases) {
    f.answer(items([{ label: 'snip\x1b[2J\nlabel', insertText: snippet, insertTextFormat: 2, filterText: 'snipx' }]));
    a.text = '\n'; a.pt = 0;
    await keys('i');
    await type('sni');
    await until(() => popup(), 'the popup');
    assert.deepEqual(popup(), ['snip [2J label']);
    await keys('RET');
    assert.equal(a.text, want + '\n', snippet);
    await keys('ESC');
  }
  f.answer(items([{ label: 'plain', insertText: 'a $1 b', insertTextFormat: 1 }]));
  a.text = '\n'; a.pt = 0;
  await keys('i');
  await type('pla');
  await until(() => popup(), 'the popup');
  await keys('RET');
  assert.equal(a.text, 'a $1 b\n', 'plain text stays as it is');
});

test('malformed items and items past the bounds are left out', async () => {
  const f = fake();
  await open(project('malformed', { 'a.fake': '\n' })['a.fake']);
  const edit = { range: range(0, 0, 0, 0), newText: 'x' };
  f.answer(items([
    { label: 'kept1' },
    { label: 7 }, null, 'kept-not', { label: '', filterText: 'kept-empty' }, { label: ' \x1b ', filterText: 'kept-blank' },
    { label: 'keptBadEdit', textEdit: { range: { start: pos(0, -1), end: pos(0, 0) }, newText: 'x' } },
    { label: 'keptNoText', textEdit: { range: range(0, 0, 0, 3) } },
    { label: 'keptLong', insertText: 'y'.repeat(10_001) },
    { label: 'keptLongEdit', additionalTextEdits: [{ range: range(0, 0, 0, 0), newText: 'y'.repeat(10_001) }] },
    { label: 'keptManyEdits', additionalTextEdits: Array.from({ length: 101 }, () => edit) },
    { label: 'keptBadExtra', additionalTextEdits: [{ range: range(0, 0, 0, 0) }] },
    { label: 'keptBadExtraRange', additionalTextEdits: [{ range: { start: pos(0, 0) }, newText: 'x' }] },
    { label: 'keptExtraNotList', additionalTextEdits: edit },
    { label: 'kept2', insertText: 'y'.repeat(10_000), additionalTextEdits: Array.from({ length: 100 }, () => edit), kind: 99 },
    { label: 'keptDeepSnippet', insertText: '${1:'.repeat(200_000), insertTextFormat: 2 },
    { label: 'keptDeepEdit', textEdit: { range: range(0, 0, 0, 0), newText: '${1:'.repeat(200_000) }, insertTextFormat: 2 },
    { label: 'kept3', insertText: '${1:'.repeat(2500), insertTextFormat: 2 },
  ]));
  await keys('i');
  await type('kep');
  await until(() => popup(), 'the popup');
  assert.deepEqual(popup(), ['kept1', 'kept2', 'kept3'], 'a snippet over 10,000 characters left out before it is read, the rest of the answer kept');
  assert.deepEqual(anns(), ['', '', ''], 'an unknown kind is no annotation');
  await keys('ESC o');
  /* the bounds: 5000 items kept, the 5001st left out; 200 shown; a label cut at 200, an annotation at 80 */
  f.answer(items([
    { label: 'bulk' + 'L'.repeat(300), detail: 'D'.repeat(100), sortText: '!' },
    ...Array.from({ length: 4999 }, (_, i) => ({ label: (i % 2 ? 'x' : '') + 'bulk' + String(i).padStart(4, '0'), sortText: String(i).padStart(4, '0') })),
    { label: 'bulkLast' },
  ]));
  await type('bul');
  await until(() => popup(), 'the popup');
  assert.equal(popup()!.length, 200);
  assert.equal(popup()![0], 'bulk' + 'L'.repeat(196) + '…');
  assert.equal(anns()[0], 'D'.repeat(80) + '…');
  await type('kLa');
  await sleep(200);
  assert.equal(f.asked(), 2, 'filtered again, not asked');
  assert.equal(popup(), null, 'the 5001st item was left out');
});

test('an answer of snippets each a run of choices that never close, or never close before the end (3 MB), holds the loop under a second', async () => {
  const f = fake();
  const a = await open(project('choices', { 'a.fake': '\n' })['a.fake']);
  f.answer(items(Array.from({ length: 300 }, (_, i) => ({ label: `pri${String(i).padStart(3, '0')}`, insertTextFormat: 2, insertText: i % 2 ? '${1|'.repeat(2500) : '${1|a,'.repeat(1666) }))));
  await keys('i');
  await type('pri');
  let last = Date.now(), stall = 0;
  await until(() => { const now = Date.now(); stall = Math.max(stall, now - last); last = now; return popup(); }, 'the popup', 30_000);
  console.log(`300 snippets of choices that never close: the loop held for at most ${stall} ms`);
  assert.ok(stall < 1000, `the answer held the loop for ${stall} ms`);
  assert.equal(popup()!.length, 200, 'every item kept, 200 shown');
  await keys('RET');
  assert.equal(a.text, '${1|a,'.repeat(1666) + '\n', 'a choice that never closes is kept as written');
  await keys('ESC');
});

test('C-SPC and TAB ask and wait: one item goes in at once; after a trigger character with no word; C-g quits; past timing.request it says so; TAB with nothing to complete inserts its tab', async () => {
  const f = fake();
  const a = await open(project('explicit', { 'a.fake': 'obj\n' })['a.fake']);
  L.evalText('(set! corfu-auto #f)');
  f.answer(items([{ label: 'object', textEdit: { range: range(0, 0, 0, 2), newText: 'object' } }]));
  a.pt = 2;
  await keys('i C-SPC');
  assert.equal(a.text, 'objectj\n', 'the one item at once, its range (ob) replaced');
  assert.deepEqual(f.of('textDocument/completion')[0].context, { triggerKind: 1 });
  assert.deepEqual(f.at('textDocument/completion'), ['j']);
  f.answer(items([{ label: 'len' }, { label: 'cap' }]));
  await keys('ESC A');
  await type('.');
  await keys('TAB');
  assert.deepEqual(popup(), ['cap', 'len'], 'TAB after . asks too');
  assert.deepEqual(f.of('textDocument/completion')[1].context, { triggerKind: 2, triggerCharacter: '.' });
  await keys('RET');
  assert.equal(a.text, 'objectj.cap\n');
  await type(' ');
  await keys('TAB');
  assert.equal(f.asked(), 2, 'no word and no trigger: the server is not asked');
  f.answer({ 'textDocument/completion': 'hang' });
  await type('ca');
  Ed.feedKey('C-SPC');
  await until(() => f.asked() === 3, 'the request');
  assert.ok(E.running > 0, 'the command waits');
  Ed.feedKey('C-g');
  await until(() => E.running === 0, 'the command over');
  assert.equal(E.echo, 'Quit');
  await until(() => f.cancels().includes(f.ids('textDocument/completion')[2]), 'its cancel sent');
  Ed.lsp.timing.request = 200;
  await keys('C-SPC');
  assert.match(E.echo, /textDocument\/completion/);
  /* the text changed while C-SPC waited (by no command): its answer is dropped, nothing said */
  Ed.lsp.timing.request = DEFAULTS.request;
  f.answer(items([{ label: 'cart' }, { label: 'carp' }], { delay: 300 }));
  Ed.feedKey('C-SPC');
  await until(() => f.asked() === 5, 'the request');
  Ed.applyOps(a, [[0, 0, 'W']]);
  const changed = a.text;
  await until(() => E.running === 0, 'the command over');
  assert.equal(popup(), null);
  assert.equal(a.text, changed, 'nothing inserted: neither the items nor the words');
  assert.doesNotMatch(E.echo, /No completions/);
  f.answer(items([]));
  await type(' qq');
  await keys('C-SPC');
  assert.equal(f.asked(), 6);
  assert.equal(E.echo, 'No completions', 'none from the server, no word in the buffers: said');
  await keys('TAB');
  assert.equal(f.asked(), 7);
  const text: string = a.text;
  assert.match(text, /qq[\t ]+\n$/, 'TAB with none from the server and no word: a tab, as with no server');
  assert.equal(a.pt, text.length - 1);
});

test('a request is cancelled when point moves, the text changes or Insert state ends; a late answer is not shown', async () => {
  const f = fake();
  await open(project('move', { 'a.fake': 'abc def\n' })['a.fake']);
  f.answer(items([{ label: 'abcdef' }], { delay: 1500 }));
  await keys('A');
  await type('abc');
  await until(() => f.asked() === 1, 'the request');
  await keys('<left>');
  await until(() => f.cancels().length === 1, 'moving cancelled it');
  await sleep(1700);
  assert.equal(popup(), null, 'the late answer is not shown');
  await keys('<right>');
  await type('d');
  await until(() => f.asked() === 2, 'the second');
  await type('e');
  await until(() => f.cancels().length === 2, 'typing cancelled the second');
  await until(() => f.asked() === 3, 'the third');
  await keys('ESC');
  await until(() => f.cancels().length === 3, 'Normal state cancelled the third');
  assert.deepEqual(f.cancels(), f.ids('textDocument/completion'));
  await sleep(1700);
  assert.equal(popup(), null);
});

test('an edit by no command (a process, auto-revert) while the keys rest or the answer is on its way: nothing asked or shown; the minibuffer open when it comes: not shown', async () => {
  const f = fake();
  const a = await open(project('quiet', { 'a.fake': 'abc def\n' })['a.fake']);
  Ed.lsp.timing.completion = 300;
  f.answer(items([{ label: 'defghijklm' }], { delay: 500 }));
  await keys('A');
  await type('ghi');
  Ed.applyOps(a, [[0, 0, 'Z']]);
  await sleep(500);
  assert.equal(f.asked(), 0, 'the debounce found the text changed');
  await type('j');
  await until(() => f.asked() === 1, 'the request');
  Ed.applyOps(a, [[0, 0, 'Y']]);
  await sleep(700);
  assert.equal(popup(), null, 'the answer came for another text');
  assert.deepEqual(f.cancels(), [], 'no command cancelled it');
  await type('k');
  await until(() => f.asked() === 2, 'the second request');
  Ed.feedKey('M-x');
  await until(() => E.mini, 'the minibuffer');
  await sleep(700);
  assert.equal(E.corfu, null, 'not shown over the minibuffer');
  Ed.feedKey('C-g');
  await until(() => !E.mini && E.running === 0, 'the minibuffer closed');
  assert.equal(E.corfu, null);
});

test('refused, nothing changed: an edit off point\'s line or not around point, another edit over the item\'s, two that overlap, past the end, backwards, the buffer changed since the answer, read-only', async () => {
  const f = fake();
  const a = await open(project('refuse', { 'a.fake': 'zero\none\n\ntail\n' })['a.fake']);
  const base = 'zero\none\n\ntail\n', at = base.indexOf('\n\n') + 1, typed = base.slice(0, at) + 'twe' + base.slice(at);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ textEdit: { range: range(0, 0, 0, 4), newText: 'X' } }, /not on the line of point/],
    [{ textEdit: { range: range(1, 0, 2, 3), newText: 'X' } }, /not on the line of point/],
    [{ textEdit: { range: range(2, 0, 3, 0), newText: 'X' } }, /not on the line of point/],
    [{ textEdit: { range: range(2, 4, 2, 4), newText: 'X' } }, /not on the line of point, around where it was asked/],
    [{ textEdit: { insert: range(2, 0, 2, 2), replace: range(2, 0, 2, 3), newText: 'X' } }, /not on the line of point, around where it was asked/],
    [{ additionalTextEdits: [{ range: range(2, 1, 2, 2), newText: 'X' }] }, /overlaps its text/],
    [{ additionalTextEdits: [{ range: range(0, 0, 0, 3), newText: 'X' }, { range: range(0, 2, 0, 4), newText: 'Y' }] }, /two of its other edits overlap/],
    [{ additionalTextEdits: [{ range: range(9, 0, 1, 0), newText: 'X' }] }, /past the last line, 5/],
    [{ additionalTextEdits: [{ range: range(1, 0, 9, 0), newText: 'X' }] }, /past the last line, 5/],
    [{ additionalTextEdits: [{ range: range(1, 2, 1, 0), newText: 'X' }] }, /ends before it starts/],
  ];
  for (const [extra, why] of cases) {
    f.answer(items([{ label: 'twelve', ...extra }]));
    a.text = base; a.pt = at; a.modified = false;
    await keys('i');
    await type('twe');
    await until(() => popup(), 'the popup');
    await keys('RET');
    assert.match(E.echo, why, JSON.stringify(extra));
    assert.match(E.echo, /^The completion is not inserted: /);
    assert.equal(a.text, typed, `${JSON.stringify(extra)}: nothing changed`);
    await keys('ESC');
  }
  f.answer(items([{ label: 'twelve' }]));
  a.text = base; a.pt = at;
  await keys('i');
  await type('twe');
  await until(() => popup(), 'the popup');
  /* an edit elsewhere (a process, auto-revert) while the popup is open: one that adds text, one that changes a
     character before point and one after it */
  const edits: [number, string][] = [[0, 'Q'], [0, 'h'], [typed.indexOf('tail'), 'T']];
  for (const [k, [p, ch]] of edits.entries()) {
    if (k) {
      a.text = base; a.pt = at;
      await keys('i');
      await type('twe');
      await until(() => popup(), 'the popup');
    }
    const pt = a.pt, grow = k === 0;
    Ed.applyOps(a, [[p, grow ? 0 : 1, ch]]);
    a.pt = pt + (grow ? 1 : 0);
    const now = a.text;
    await keys('RET');
    assert.match(E.echo, /The completion is not inserted: the buffer has changed since its server answered/, `edit ${k}`);
    assert.equal(a.text, now, `edit ${k}: nothing changed`);
    await keys('ESC');
  }
  /* point moved back before where the server was asked, the text otherwise the same (an e after point taken
     away, point on the e before it) */
  f.answer(items([{ label: 'twelve' }]));
  a.text = base.slice(0, at) + 'e' + base.slice(at); a.pt = at;
  await keys('i');
  await type('twe');
  await until(() => popup(), 'the popup');
  Ed.applyOps(a, [[a.pt, 1, '']]);
  a.pt -= 1;
  const moved = a.text;
  await keys('RET');
  assert.match(E.echo, /The completion is not inserted: the buffer has changed since its server answered/, 'point moved back');
  assert.equal(a.text, moved);
  await keys('ESC');
  a.text = base; a.pt = at;
  f.answer(items([{ label: 'twelve', additionalTextEdits: [{ range: range(0, 0, 0, 0), newText: 'A' }] }]));
  await keys('i');
  await type('twe');
  await until(() => popup(), 'the popup');
  a.readOnly = true;
  await keys('RET');
  assert.match(E.echo, /read-only/i);
  assert.equal(a.text, typed);
  a.readOnly = false;
  await keys('ESC');
  /* the same shapes right go in: an import after the item's line, an insertion where the word starts, the
     InsertReplaceEdit's insert range */
  a.text = base; a.pt = at;
  f.answer(items([{ label: 'twelve', textEdit: { insert: range(2, 0, 2, 3), replace: range(2, 0, 2, 3), newText: 'twelve' }, additionalTextEdits: [{ range: range(3, 0, 3, 0), newText: 'end ' }, { range: range(2, 0, 2, 0), newText: '>' }, { range: range(0, 0, 0, 4), newText: 'ZERO' }] }]));
  await keys('i');
  await type('twe');
  await until(() => popup(), 'the popup');
  await type('l');
  await keys('RET');
  assert.equal(a.text, 'ZERO\none\n>twelve\nend tail\n');
  assert.equal(a.pt, a.text.indexOf('twelve') + 6);
});

test('other edits at one place go in in the server\'s order, an insertion before a replacement there; an item inserted at point before a replacement from there', async () => {
  const f = fake();
  const a = await open(project('order', { 'a.fake': 'zero\n\n' })['a.fake']);
  const cases: [unknown[], string][] = [
    [[{ range: range(0, 0, 0, 0), newText: 'A\n' }, { range: range(0, 0, 0, 0), newText: 'B\n' }], 'A\nB\nzero\ntwelve\n'],
    [[{ range: range(0, 0, 0, 0), newText: 'X' }, { range: range(0, 0, 0, 4), newText: 'ZERO' }], 'XZERO\ntwelve\n'],
    [[{ range: range(0, 0, 0, 4), newText: 'ZERO' }, { range: range(0, 0, 0, 0), newText: 'X' }], 'XZERO\ntwelve\n'],
  ];
  for (const [extra, want] of cases) {
    f.answer(items([{ label: 'twelve', additionalTextEdits: extra }]));
    a.text = 'zero\n\n'; a.pt = 5;
    await keys('i');
    await type('twe');
    await until(() => popup(), 'the popup');
    await keys('RET');
    assert.equal(a.text, want, JSON.stringify(extra));
    assert.equal(a.pt, a.text.indexOf('twelve') + 6);
    await keys('ESC');
  }
  /* the item's edit empty at point, nothing typed since, and an other edit replacing what follows point */
  f.answer(items([{ label: 'twelve', textEdit: { range: range(1, 3, 1, 3), newText: 'lve' }, additionalTextEdits: [{ range: range(1, 3, 1, 5), newText: '()' }] }]));
  a.text = 'zero\n;;\n'; a.pt = 5;
  await keys('i');
  await type('twe');
  await until(() => popup(), 'the popup');
  await keys('RET');
  assert.equal(a.text, 'zero\ntwelve()\n');
  assert.equal(a.pt, a.text.indexOf('twelve') + 6);
});

test('the keystroke budget holds while a request is pending: 2 ms a key (median of 50) in a 10,000-line buffer', async () => {
  const f = fake();
  let text = '';
  for (let i = 0; i < 10000; i++) text += `line ${i} with some words alpha${i % 97} beta${i % 89}\n`;
  const a = await open(project('budget', { 'a.fake': text })['a.fake']);
  f.answer({ 'textDocument/completion': 'hang' });
  a.pt = text.indexOf('\n', text.length >> 1);
  await keys('i');
  await type('wor');
  await until(() => f.asked() === 1, 'the first request');
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    Ed.feedKey('x');
    await Ed.whenIdle();
    times.push(performance.now() - t0);
    await until(() => f.asked() === i + 2, 'the next request out');
  }
  times.sort((x, y) => x - y);
  console.log(`a key with a completion request pending: median ${times[25].toFixed(3)} ms, max ${times[49].toFixed(3)} ms`);
  assert.ok(times[25] <= 2, `median ${times[25]} ms`);
  await until(() => f.cancels().length === 50, 'each key cancelling the request pending');
  await keys('ESC');
});

test('the session shut down while a request waits leaves nothing behind; the buffer keeps its words', async () => {
  const f = fake();
  const a = await open(project('down', { 'a.fake': 'zebra\n\n' })['a.fake']);
  f.answer({ 'textDocument/completion': 'hang' });
  a.pt = a.text.length - 1;
  await keys('i');
  await type('zeb');
  await until(() => f.asked() === 1, 'the request');
  await Ed.lsp.shutdown(Ed.lsp.sessionOf(a));
  await type('r');
  await sleep(200);
  assert.deepEqual(popup(), ['zebra'], 'no server: the words');
  assert.equal(proc.running().length, 0);
});

test('nil: a builtin completed', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL names no nil' }, async () => {
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command (list ${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const pr = project('nil', { 'default.nix': '# 😀\nlet\n  x = 1;\nin\n  builtins.\n' });
  const b = await open(pr['default.nix']);
  assert.equal(b.mode, 'nix-mode');
  b.pt = b.text.indexOf('builtins.') + 'builtins.'.length;
  await keys('a');
  await type('toS');
  await until(() => popup()?.includes('toString'), `toString offered (${JSON.stringify(popup())})`);
  while (popup()![E.corfu.index] !== 'toString') await keys('C-n');
  await keys('RET');
  assert.match(b.text, /builtins\.toString\n/);
  Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  await until(() => proc.running().length === 0, 'nil ended');
});
