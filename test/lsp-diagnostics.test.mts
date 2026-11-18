// Diagnostics (src/lsp.ts): what a server publishes, placed in the buffer and following its edits, counted in the
// mode line, shown at point in the echo area, listed by flymake-show-buffer-diagnostics and
// flymake-show-project-diagnostics (RET visits one) and stepped through by M-g n, against a stand-in server that is
// a real child through Ed.proc (fake-proc.mts). It publishes what the suite wrote in its file after each didOpen,
// didChange and didSave, and when it gets the suite's test/publish notification. Then nil from nixpkgs (when
// EDWIN_LSP_REAL names it): an undefined name.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-diagnostics-')));
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
  for (const b of E.buffers.slice()) if (b.file || b.name.startsWith('*Flymake')) { b.modified = false; L.call('kill-buffer', [b]); }
  L.call('delete-other-windows', []);
  Object.assign(Ed.lsp.timing, DEFAULTS);
  Ed.lsp.timing.change = 60_000;   // a change is sent when the suite flushes it
  Ed.lsp.timing.diagnostics = 20;
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
const mx = async (command: string) => { await keys('M-x'); for (const ch of command) Ed.feedKey(ch); await keys('RET'); };
const messages = () => (E.buffers.find((b: { name: string }) => b.name === '*Messages*') || { text: '' }).text as string;
const extra = () => Ed.modelineFields(E.sel, Ed.windowState(E.sel), 1).extra as string;

/* The stand-in: node SCRIPT LOG PUBLISH. PUBLISH is a JSON file read after each didOpen, didChange and didSave and
   on test/publish: a list of publishes, each {uri?, version?, diagnostics}, the uri the document's when absent, a
   version of "doc" the document's version as last told. Each message is logged as "METHOD PARAMS". */
const FAKE = `
const fs = require('fs');
const [log, publish] = process.argv.slice(2);
const note = s => fs.appendFileSync(log, s + '\\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
const vers = new Map();
let last = null;
function pub(uri) {
  for (const p of JSON.parse(fs.readFileSync(publish, 'utf8'))) {
    const u = p.uri || uri, params = { uri: u, diagnostics: p.diagnostics };
    if (p.version === 'doc') params.version = vers.get(u); else if (p.version !== undefined) params.version = p.version;
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params });
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
    note((m.method || 'answer') + ' ' + JSON.stringify(m.params === undefined ? null : m.params));
    const p = m.params || {};
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { textDocumentSync: { openClose: true, change: 1, save: true } } } });
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
    else if (m.method === 'textDocument/didOpen') { vers.set(p.textDocument.uri, p.textDocument.version); last = p.textDocument.uri; pub(last); }
    else if (m.method === 'textDocument/didChange') { vers.set(p.textDocument.uri, p.textDocument.version); last = p.textDocument.uri; pub(last); }
    else if (m.method === 'textDocument/didSave') pub(p.textDocument.uri);
    else if (m.method === 'test/publish') pub(last);
    else if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, result: null });
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
let logs = 0;
/* A fresh log and publish file, and the stand-in declared for fake-mode. */
function fake() {
  const log = path.join(tmp, `log-${++logs}`), pubs = path.join(tmp, `publish-${logs}.json`);
  fs.writeFileSync(log, ''); fs.writeFileSync(pubs, '[]');
  const argv = [process.execPath, script, log, pubs];
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${argv.map(a => JSON.stringify(a)).join(' ')}))`);
  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { const k = l.indexOf(' '); return { method: l.slice(0, k), rest: l.slice(k + 1) }; });
  const of = (method: string) => lines().filter(l => l.method === method).map(l => JSON.parse(l.rest));
  /* what the stand-in publishes from now on */
  const publish = (p: unknown[]) => fs.writeFileSync(pubs, JSON.stringify(p));
  return { of, publish };
}
/* A project (with a .git) under NAME holding FILES (path: text) on the disk; their absolute paths. */
function project(name: string, files: Record<string, string>): Record<string, string> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); out[f] = p; }
  return { dir, ...out };
}
type Buf = { text: string; file: string | null; mode: string; pt: number; name: string; ver: number; temps: Set<unknown> };
/* P visited in the selected window, its server ready, in Normal state. */
async function open(p: string): Promise<Buf> {
  await keys('ESC');
  const b = L.call('find-file', [p]) as Buf;
  const s = Ed.lsp.sessionOf(b);
  assert.ok(s, E.echo);
  await Ed.lsp.ready(s);
  return b;
}
const range = (l: number, c: number, l2: number, c2: number) => ({ start: { line: l, character: c }, end: { line: l2, character: c2 } });
const diag = (l: number, c: number, l2: number, c2: number, message: string, severity?: number, more: Record<string, unknown> = {}) =>
  ({ range: range(l, c, l2, c2), message, ...(severity === undefined ? {} : { severity }), ...more });
/* The diagnostics of B as [start, end, severity, message]. */
const placedOf = (b: Buf) => Ed.lsp.diagnostics(b).map((d: { start: number; end: number; severity: number; message: string }) => [d.start, d.end, d.severity, d.message]);
/* Ask the stand-in to publish again, and wait until B's diagnostics satisfy COND. */
async function republish(b: Buf, cond: () => unknown, what: string) {
  Ed.lsp.sessionOf(b).conn.notify('test/publish', {});
  await until(cond, what);
}
const listText = () => E.current.text as string;

test('initialize says publishDiagnostics with its version; a publish is placed at UTF-16 positions, every shape read', async () => {
  const f = fake();
  const text = '😀 bad thing\nsecond line\nthird\n';
  f.publish([{ diagnostics: [
    diag(0, 3, 0, 6, 'bad is bad', 1, { source: 'fake', code: 'E1' }),
    diag(1, 0, 1, 6, 'second warns', 2, { code: 42 }),
    diag(2, 0, 2, 5, 'info', 3), diag(2, 1, 2, 2, 'hint', 4),
    diag(1, 7, 1, 7, 'no severity'),
    diag(2, 4, 2, 1, 'backwards', 2),
    diag(9, 0, 9, 3, 'past the end', 2),
    { range: range(0, 0, 0, 1) }, { message: 'no range' }, { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }, message: 'bad line' }, null, 5,
    diag(0, 0, 0, 1, 'esc \x1b[31mred\x1b[0m\r\nline two', 2, { source: 'a\x07b' }), diag(0, 1, 0, 2, 'in the pair', 3),
  ] }, { uri: 'untitled:x', diagnostics: [diag(0, 0, 0, 1, 'elsewhere', 1)] }]);
  const b = await open(project('caps', { 'a.fake': text })['a.fake']);
  assert.deepEqual(f.of('initialize')[0].capabilities.textDocument.publishDiagnostics, { versionSupport: true });
  await until(() => Ed.lsp.diagnostics(b).length, 'the diagnostics');
  const bad = text.indexOf('bad'), second = text.indexOf('second'), third = text.indexOf('third');
  assert.deepEqual(placedOf(b), [
    [0, 0, 2, 'esc  [31mred [0m\nline two'],
    [0, 2, 3, 'in the pair'],
    [bad, bad + 3, 1, 'bad is bad'],
    [second, second + 6, 2, 'second warns'],
    [second + 7, second + 7, 1, 'no severity'],
    [third, third + 5, 3, 'info'],
    [third + 1, third + 2, 4, 'hint'],
    [third + 4, third + 4, 2, 'backwards'],
    [text.length, text.length, 2, 'past the end'],
  ], 'by place; after 😀 in UTF-16 units, a position inside it at its start; control characters blanked; malformed ones and another scheme left out');
  assert.deepEqual(Ed.lsp.diagnostics(b).map((d: { source: string }) => d.source), ['a b', '', 'fake E1', '42', '', '', '', '', '']);
  assert.equal(extra(), 'E2 W4 N3', 'the mode line counts errors, warnings and notes');
});

test('the message at point in the echo area, not logged: errors first, cleared when point leaves, never over a message or the minibuffer', async () => {
  const f = fake();
  f.publish([{ diagnostics: [diag(0, 4, 0, 7, 'two here', 2, { source: 'w' }), diag(0, 5, 0, 6, 'an error', 1), diag(1, 3, 1, 3, 'empty range', 3)] }]);
  const b = await open(project('echo', { 'a.fake': 'abc def ghi\nxyz\n' })['a.fake']);
  await until(() => Ed.lsp.diagnostics(b).length === 3, 'the diagnostics');
  const logged = messages().length;
  b.pt = 0;
  await keys('l l l l l');
  assert.equal(E.echo, 'error: an error\nwarning: two here (w)');
  await keys('l');
  assert.equal(E.echo, 'warning: two here (w)');
  assert.equal(messages().length, logged, 'nothing in *Messages*');
  await keys('l');
  assert.equal(E.echo, '', 'point left them');
  await keys('j');
  assert.equal(b.pt, b.text.indexOf('xyz') + 2);
  assert.equal(E.echo, 'note: empty range', 'an empty range at the line end shows on the character before it');
  await keys('k');
  b.pt = 5;
  await keys('C-g');
  assert.equal(E.echo, 'Quit', 'a message stays');
  await keys(':');
  assert.ok(E.mini);
  assert.doesNotMatch(E.echo, /error/);
  await keys('C-g');
});

test('placed diagnostics follow the edits until the next publish; an edit not yet sent moves them; a stale version is dropped', async () => {
  const f = fake();
  f.publish([{ version: 'doc', diagnostics: [diag(1, 0, 1, 3, 'on two', 1), diag(2, 2, 2, 4, 'on three', 2)] }]);
  const b = await open(project('follow', { 'a.fake': 'one\ntwo\nthree\n' })['a.fake']);
  await until(() => Ed.lsp.diagnostics(b).length === 2, 'the diagnostics');
  f.publish([]);   // nothing published after the next change
  b.pt = 0;
  Ed.insertText(b, 'zero\n');
  const two = b.text.indexOf('two'), three = b.text.indexOf('three');
  assert.deepEqual(placedOf(b), [[two, two + 3, 1, 'on two'], [three + 2, three + 4, 2, 'on three']], 'moved by the edit');
  /* A publish of the text the server holds, with an edit of the buffer it was not told of yet: placed past it. */
  f.publish([{ diagnostics: [diag(0, 0, 0, 3, 'on one', 1), diag(1, 0, 1, 3, 'on two again', 1)] }]);
  await republish(b, () => placedOf(b).length === 2 && placedOf(b)[0][3] === 'on one', 'the publish');
  assert.deepEqual(placedOf(b), [[5, 8, 1, 'on one'], [two, two + 3, 1, 'on two again']], 'the server holds one\\ntwo: past the line inserted');
  Ed.lsp.flush(b);
  await until(() => f.of('textDocument/didChange').length === 1, 'the change sent');
  /* A version older than the one the server was last told of is about text gone. */
  f.publish([{ version: 0, diagnostics: [diag(0, 0, 0, 1, 'stale', 1)] }, { version: 'doc', diagnostics: [diag(3, 0, 3, 5, 'fresh', 2)] }]);
  await republish(b, () => placedOf(b).length === 1, 'the fresh publish');
  const th = b.text.indexOf('three');
  assert.deepEqual(placedOf(b), [[th, th + 5, 2, 'fresh']]);
  f.publish([{ version: 0, diagnostics: [diag(0, 0, 0, 1, 'stale', 1)] }]);
  Ed.lsp.sessionOf(b).conn.notify('test/publish', {});
  await sleep(300);
  assert.deepEqual(placedOf(b), [[th, th + 5, 2, 'fresh']], 'the stale publish dropped');
  /* an edit not yet sent inside a range: the range holds it */
  f.publish([{ diagnostics: [diag(1, 0, 1, 3, 'across', 2)] }]);
  await republish(b, () => placedOf(b)[0][3] === 'across', 'the publish');
  b.pt = 6;
  Ed.insertText(b, 'NN');
  assert.deepEqual(placedOf(b), [[5, 10, 2, 'across']], 'o[NN]ne, by the positions');
  await republish(b, () => placedOf(b).length === 1, 'the publish');
  assert.deepEqual(placedOf(b), [[5, 10, 2, 'across']], 'o[NN]ne, by the edit the server was not told of');
  Ed.lsp.flush(b);
  await until(() => f.of('textDocument/didChange').length === 2, 'the change sent');
  /* an edit undone before it was sent tells the server nothing: a publish of the version it holds is current */
  b.pt = 0;
  Ed.insertText(b, 'q');
  Ed.deleteText(b, 0, 1);
  Ed.lsp.flush(b);
  const changes = f.of('textDocument/didChange').length;
  f.publish([{ version: 'doc', diagnostics: [diag(0, 0, 0, 4, 'still current', 1)] }]);
  await republish(b, () => placedOf(b).length === 1 && placedOf(b)[0][3] === 'still current', 'the publish of the version the server holds');
  assert.equal(f.of('textDocument/didChange').length, changes, 'no didChange for an edit undone');
  /* An empty publish clears them, and the mode line. */
  f.publish([{ diagnostics: [] }]);
  await republish(b, () => placedOf(b).length === 0, 'the empty publish');
  assert.equal(extra(), '');
});

test('flymake-show-buffer-diagnostics lists them; RET visits one, M-g n steps; a publish redraws the list and keeps the place', async () => {
  const f = fake();
  const d4 = diag(3, 2, 3, 3, 'four', 2);
  f.publish([{ diagnostics: [diag(0, 0, 0, 1, 'one\nmore', 1, { source: 'fk' }), diag(1, 1, 1, 2, 'two', 2), diag(2, 0, 2, 1, 'three', 3), d4] }]);
  const pr = project('list', { 'src/a.fake': 'a1\nb2\nc3\nd4 x\n' });
  const b = await open(pr['src/a.fake']);
  await until(() => Ed.lsp.diagnostics(b).length === 4, 'the diagnostics');
  await mx('flymake-show-buffer-diagnostics');
  const lb = E.current;
  assert.equal(lb.name, `*Flymake diagnostics for ${b.name}*`);
  assert.equal(lb.mode, 'flymake-diagnostics-buffer-mode');
  assert.equal(listText(), 'src/a.fake\n  1:1  error    one more  (fk)\n  2:2  warning  two\n  3:1  note     three\n  4:3  warning  four\n');
  assert.equal(E.echo, '4 diagnostics');
  await keys('j');
  await keys('RET');
  assert.equal(E.current, b, 'RET visits in the other window');
  assert.equal(b.pt, b.text.indexOf('b2') + 1);
  /* M-g n from the start of the list */
  await keys('M-g n');
  assert.equal(b.pt, 0);
  assert.match(E.echo, /\(1 of 4\) error: one more/);
  await keys('M-g n');
  assert.equal(b.pt, b.text.indexOf('b2') + 1);
  /* the error visited (two) and the one before it fixed: the list drawn again, M-g n goes on to three */
  f.publish([{ diagnostics: [diag(2, 0, 2, 1, 'three', 3), d4] }]);
  await republish(b, () => Ed.lsp.diagnostics(b).length === 2, 'the publish');
  await until(() => !lb.text.includes('two'), 'the list drawn again');
  assert.equal(lb.text, 'src/a.fake\n  3:1  note     three\n  4:3  warning  four\n');
  await keys('M-g n');
  assert.equal(b.pt, b.text.indexOf('c3'));
  assert.match(E.echo, /\(1 of 2\) note: three/);
  /* the rows follow an edit before the next publish */
  b.pt = 0;
  Ed.insertText(b, 'new\n');
  f.publish([{ diagnostics: [diag(2, 0, 2, 1, 'three', 3), d4, diag(0, 0, 0, 1, 'zero', 1)] }]);
  await republish(b, () => Ed.lsp.diagnostics(b).length === 3, 'the publish');
  await until(() => lb.text.includes('zero'), 'the list drawn again');
  assert.equal(lb.text, 'src/a.fake\n  2:1  error    zero\n  4:1  note     three\n  5:3  warning  four\n', 'the server holds the text before the edit: zero is past the line inserted');
  /* another list replaces the error list: a publish no longer touches it */
  L.evalText(`(next-error-set-list! (list (list ${JSON.stringify(pr['src/a.fake'])} 2 1 "the compiler's")))`);
  f.publish([{ diagnostics: [d4] }]);
  await republish(b, () => Ed.lsp.diagnostics(b).length === 1, 'the publish');
  await until(() => !lb.text.includes('zero'), 'the list drawn again');
  await keys('M-g n');
  assert.equal(E.echo, "(1 of 1) the compiler's");
});

test('flymake-show-project-diagnostics lists every file the server published for; RET opens one not visited', async () => {
  const f = fake();
  const pr = project('proj', { 'a.fake': 'a\n', 'lib/b.fake': 'xx\nyy\n' });
  f.publish([{ diagnostics: [diag(0, 0, 0, 1, 'in a', 2)] }, { uri: Ed.lsp.uri(pr['lib/b.fake']), diagnostics: [diag(1, 1, 1, 2, 'in b', 1)] }]);
  const a = await open(pr['a.fake']);
  await until(() => Ed.lsp.diagnostics(a).length === 1, 'the diagnostics');
  await sleep(100);
  await mx('flymake-show-project-diagnostics');
  assert.equal(E.current.name, `*Flymake diagnostics for project ${pr.dir}*`);
  assert.equal(listText(), 'a.fake\n  1:1  warning  in a\nlib/b.fake\n  2:2  error    in b\n');
  await keys('j j RET');
  assert.equal(E.current.file, pr['lib/b.fake']);
  assert.equal(E.current.pt, E.current.text.indexOf('yy') + 1);
  await keys('M-g n M-g n');
  assert.equal(E.current.file, pr['lib/b.fake']);
  assert.match(E.echo, /\(2 of 2\) error: in b/);
});

test('cleared when the server is shut down, ends or the buffer stops using it; bounds on a publish', async () => {
  const f = fake();
  f.publish([{ diagnostics: [diag(0, 0, 0, 1, 'x', 1)] }]);
  const pr = project('clear', { 'a.fake': 'abc\n' });
  let b = await open(pr['a.fake']);
  await until(() => Ed.lsp.diagnostics(b).length === 1, 'the diagnostics');
  const temps = b.temps.size;
  await mx('flymake-show-buffer-diagnostics');
  const lb = E.current;
  L.call('other-window', [1]);
  assert.equal(E.current, b);
  assert.equal(extra(), 'E1');
  await Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  assert.deepEqual(placedOf(b), []);
  assert.equal(b.temps.size, temps - 2, 'its positions released');
  assert.equal(extra(), '');
  await until(() => lb.text.startsWith('No diagnostics: fake in'), 'the list drawn again');
  /* a crash forgets them; the server started again publishes afresh */
  Ed.lsp.timing.restartDelay = 50;
  await Ed.lsp.ready(Ed.lsp.start(b));
  await until(() => Ed.lsp.diagnostics(b).length === 1, 'the diagnostics');
  const s = Ed.lsp.sessionOf(b);
  f.publish([]);
  s.proc.kill('KILL');
  await until(() => s.state !== 'running', 'the crash');
  assert.deepEqual(placedOf(b), [], 'forgotten when it ended');
  await until(() => s.state === 'running', 'started again');
  /* eglot-mode off releases them */
  f.publish([{ diagnostics: [diag(0, 0, 0, 1, 'y', 2)] }]);
  await republish(b, () => Ed.lsp.diagnostics(b).length === 1, 'the publish');
  await mx('eglot-mode');
  assert.equal(Ed.lsp.sessionOf(b), null);
  assert.deepEqual(placedOf(b), []);
  /* at most 1000 a file, a message cut at 2000 characters */
  await mx('eglot-mode');
  await Ed.lsp.ready(Ed.lsp.sessionOf(b));
  f.publish([{ diagnostics: Array.from({ length: 1500 }, (_, i) => diag(0, 0, 0, 1, i ? `d${i}` : 'm'.repeat(3000), 2)) }]);
  await republish(b, () => Ed.lsp.diagnostics(b).length === 1000, 'the big publish');
  assert.ok(Ed.lsp.diagnostics(b).some((d: { message: string }) => d.message === 'm'.repeat(2000) + '…'));
  assert.equal(extra(), 'W1000');
});

test('nil: an undefined name is an error at its place', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL names no nil' }, async () => {
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command (list ${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const pr = project('nil', { 'default.nix': '# 😀\nlet\n  x = 1;\nin\n  x + nosuchname\n' });
  const b = await open(pr['default.nix']);
  assert.equal(b.mode, 'nix-mode');
  await until(() => Ed.lsp.diagnostics(b).some((d: { severity: number }) => d.severity === 1), 'nil\'s diagnostics', 20_000);
  const at = b.text.indexOf('nosuchname');
  const e = Ed.lsp.diagnostics(b).find((d: { severity: number }) => d.severity === 1);
  assert.deepEqual([e.start, e.end], [at, at + 'nosuchname'.length], JSON.stringify(Ed.lsp.diagnostics(b)));
  assert.match(e.message, /nosuchname|undefined/i);
  assert.match(extra(), /E1/);
  b.pt = at + 2;
  await keys('l');
  assert.match(E.echo, /^error: /);
  Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  await until(() => proc.running().length === 0, 'nil ended');
});
