// Code actions (src/lsp.ts): eglot-code-actions and eglot-code-action-quickfix against a stand-in server that is a
// real child through Ed.proc (fake-proc.mts). It answers each request with what the suite wrote in its answers file
// (a result, an error, "hang", a delay; initialize answered initDelay ms late when the capabilities name one), first sending the requests named beside it (workspace/applyEdit), each
// only once the client has answered the one before; it publishes the diagnostics written under "publish" for each
// document it is told of, sends the requests under "onChange" when told of a change, logs every message (the client's answers to its requests as "answer") and keeps each
// document's text. Then nil from nixpkgs (when EDWIN_LSP_REAL names it) rewriting a string.
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
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-actions-')));
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
  for (let i = 0; i < 3 && (E.mini || E.prompt); i++) { Ed.feedKey('C-g'); await sleep(20); }
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
const done = async () => { await Ed.whenIdle(); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
/* COMMAND run as a key (as -f delivers it), not waiting for it. */
const mx = (command: string) => { Ed.feedKey(`<cmd:${command}>`); };
/* The action picker once it is open: its candidates and their annotations. */
async function picker() {
  await until(() => E.mini && E.mini.prompt === 'Code action: ', `the picker (echo: ${E.echo})`);
  const cands = Ed.miniCandidates(true) as string[];
  return { cands, anns: cands.map(c => E.mini.opts.annotate(c)) };
}
/* Choose TITLE in the open picker. */
const choose = (title: string) => { type(title); Ed.feedKey('RET'); };
const question = async (p: string) => { await until(() => E.prompt === p + ' (y or n) ', `the question ${JSON.stringify(p)} (now ${JSON.stringify(E.prompt)}, echo ${JSON.stringify(E.echo)})`); };

/* The stand-in: node SCRIPT LOG ANSWERS CAPS, whole-text sync. */
const FAKE = `
const fs = require('fs');
const [log, answers, capsArg] = process.argv.slice(2);
const note = s => fs.appendFileSync(log, s + '\\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
const read = () => JSON.parse(fs.readFileSync(answers, 'utf8'));
const docs = new Map(), versions = new Map();
let ours = 0, queue = null;
/* the next of the requests sent before an answer, else the answer */
const pump = () => {
  if (!queue) return;
  const q = queue;
  if (q.requests.length) { const r = q.requests.shift(); send({ jsonrpc: '2.0', id: 'srv-' + (++ours), method: r.method, params: r.params }); return; }
  queue = null;
  if (q.delay) setTimeout(() => send(q.out), q.delay); else send(q.out);
};
const publish = uri => { const p = read().publish; if (p) send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: p } }); };
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
    const p = m.params || {};
    if (!m.method) { pump(); continue; }
    if (m.method === 'initialize') {
      const caps = Object.assign({ textDocumentSync: 1 }, JSON.parse(capsArg)), late = caps.initDelay;
      delete caps.initDelay;
      const out = { jsonrpc: '2.0', id: m.id, result: { capabilities: caps } };
      if (late) setTimeout(() => send(out), late); else send(out);
    }
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
    else if (m.method === 'textDocument/didOpen') { docs.set(p.textDocument.uri, p.textDocument.text); versions.set(p.textDocument.uri, p.textDocument.version); publish(p.textDocument.uri); }
    else if (m.method === 'textDocument/didChange') {
      docs.set(p.textDocument.uri, p.contentChanges[p.contentChanges.length - 1].text); versions.set(p.textDocument.uri, p.textDocument.version);
      for (const r of read().onChange || []) send({ jsonrpc: '2.0', id: 'srv-' + (++ours), method: r.method, params: r.params });
    }
    else if (m.id !== undefined && m.method) {
      const a = read()[m.method];
      if (a === 'hang') continue;
      const out = a && a.error ? { jsonrpc: '2.0', id: m.id, error: a.error } : { jsonrpc: '2.0', id: m.id, result: a ? a.result : null };
      queue = { requests: (a && a.requests) || [], out, delay: a && a.delay };
      pump();
    }
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
let logs = 0;
const COMMANDS = ['fake.organize', 'fake.fail'];
function fake(caps: Record<string, unknown> = { codeActionProvider: true, executeCommandProvider: { commands: COMMANDS } }) {
  const log = path.join(tmp, `log-${++logs}`), answers = path.join(tmp, `answers-${logs}.json`);
  fs.writeFileSync(log, ''); fs.writeFileSync(answers, '{}');
  const argv = [process.execPath, script, log, answers, JSON.stringify(caps)];
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${argv.map(a => JSON.stringify(a)).join(' ')}))`);
  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { const k = l.indexOf(' '); return { method: l.slice(0, k), rest: l.slice(k + 1) }; });
  const of = (method: string) => lines().filter(l => l.method === method).map(l => JSON.parse(l.rest));
  /* written whole, then renamed: the stand-in reads it when told of a document, which may be while the suite writes */
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
type Buf = { text: string; file: string | null; mode: string; pt: number; mark: number | null; name: string; ver: number; modified: boolean; readOnly: boolean };
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
const changes = (p: string, ...es: unknown[]) => ({ changes: { [uri(p)]: es } });
const fileBuffers = () => E.buffers.filter((b: Buf) => b.file).map((b: Buf) => b.file).sort();
const applyEdit = (e: unknown) => ({ method: 'workspace/applyEdit', params: { edit: e } });
/* The client's answers to the stand-in's own requests. */
const answers = (f: ReturnType<typeof fake>) => f.of('answer').filter((a: { id: unknown }) => typeof a.id === 'string');

test('initialize says code action literals with their kinds, isPreferred, workspace/applyEdit and executeCommand', async () => {
  const f = fake();
  await open(project('caps', { 'a.fake': 'x\n' })['a.fake']);
  const c = f.of('initialize')[0].capabilities;
  assert.deepEqual(c.textDocument.codeAction, { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } }, isPreferredSupport: true });
  assert.equal(c.workspace.applyEdit, true);
  assert.deepEqual(c.workspace.executeCommand, {});
});

test('the actions at point listed, the preferred first, malformed, disabled and empty ones left out, titles cleaned and numbered; the one chosen applied across files, one undo step a buffer', async () => {
  const f = fake();
  const pr = project('list', { 'a.fake': 'let thing = 1\nthing\n', 'lib/b.fake': 'use thing\n' });
  const a = await open(pr['a.fake']);
  /* an edit not yet sent: sent before the request */
  Ed.lsp.timing.change = 60_000;
  a.pt = 0; Ed.insertText(a, '# 😀\n');
  a.pt = a.text.indexOf('thing') + 2;
  const rename = { ...changes(pr['a.fake'], edit(1, 4, 1, 9, 'other'), edit(2, 0, 2, 5, 'other')), };
  (rename.changes as Record<string, unknown>)[uri(pr['lib/b.fake'])] = [edit(0, 4, 0, 9, 'other')];
  const actions = [
    { title: 'Inline thing', kind: 'refactor.inline', edit: changes(pr['a.fake'], edit(1, 0, 1, 14, '')) },
    'not an action',
    { kind: 'quickfix', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'x')) },
    { title: '   ', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'x')) },
    { title: 'Nothing to do', kind: 'refactor' },
    { title: 'Disabled', kind: 'refactor', disabled: { reason: 'no' }, edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'x')) },
    { title: 'Bad edit', edit: 'everything' },
    { title: 'Bad command', command: { title: 'x', command: 'fake.organize', arguments: 'not a list' } },
    { title: 'Rename to other', kind: 'refactor.rewrite', edit: rename },
    { title: 'Inline thing', kind: 'refactor.inline', edit: changes(pr['a.fake'], edit(1, 0, 1, 0, 'X')) },
    { title: 'Esc\x1b[31mape\nd', kind: 'refactor\x07', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'x')) },
    { title: 'Organize', command: 'fake.organize', arguments: [1] },
    { title: 'Best', kind: 'quickfix', isPreferred: true, edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'x')) },
  ];
  f.answer({ 'textDocument/codeAction': { result: actions } });
  mx('eglot-code-actions');
  const { cands, anns } = await picker();
  assert.deepEqual(cands, ['Best', 'Inline thing', 'Rename to other', 'Inline thing (2)', 'Esc [31mape d', 'Organize']);
  assert.deepEqual(anns, ['quickfix', 'refactor.inline', 'refactor.rewrite', 'refactor.inline', 'refactor', '']);
  const req = f.of('textDocument/codeAction')[0];
  assert.deepEqual(req.range, range(1, 6, 1, 6), 'point, as an empty range, after the edit before it');
  assert.deepEqual(req.context, { diagnostics: [], triggerKind: 1 });
  assert.equal('position' in req, false);
  const sent = f.of('textDocument/didChange');
  assert.equal(sent[sent.length - 1].contentChanges[0].text, a.text, 'the pending edit sent first');
  choose('Rename to other');
  await done();
  assert.equal(E.echo, 'Rename to other: 3 edits in 2 files (1 visited for it), not saved');
  assert.equal(a.text, '# 😀\nlet other = 1\nother\n');
  const b = E.buffers.find((x: Buf) => x.file === pr['lib/b.fake']) as Buf;
  assert.equal(b.text, 'use other\n');
  assert.equal(fs.readFileSync(pr['lib/b.fake'], 'utf8'), 'use thing\n', 'nothing saved');
  await keys('u');
  assert.equal(a.text, '# 😀\nlet thing = 1\nthing\n', 'one undo step');
  Ed.setWindowBuffer(b);
  await keys('u');
  assert.equal(b.text, 'use thing\n');
  /* the second of two titles alike is the one it names */
  Ed.setWindowBuffer(a);
  mx('eglot-code-actions');
  await picker();
  choose('Inline thing (2)');
  await done();
  assert.equal(a.text, '# 😀\nXlet thing = 1\nthing\n', E.echo);
  assert.equal(E.echo, 'Inline thing: 1 edit in 1 file, not saved', 'the message names the title as the server gave it');
  /* no control character reaches the echo area */
  mx('eglot-code-actions');
  await picker();
  Ed.feedKey('C-g');
  await done();
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(E.echo));
});

test('the region and the diagnostics in it: Evil\'s selection as the range, each diagnostic there given back as published (its code and data) at its range now', async () => {
  const f = fake();
  const diag = (l: number, c0: number, c1: number, message: string, extra = {}) => ({ range: range(l, c0, l, c1), severity: 2, message, ...extra });
  f.answer({ publish: [
    diag(0, 2, 5, 'first', { code: 'E1', source: 'fake', data: { fix: 1 } }),
    diag(1, 4, 9, 'second', { code: 7, data: [1, 2], tags: [1] }),
    diag(3, 0, 1, 'elsewhere'),
  ] });
  const pr = project('region', { 'a.fake': 'one two\nlet thing = 1\n\nz\n' });
  const a = await open(pr['a.fake']);
  await until(() => Ed.lsp.diagnostics(a).length === 3, 'the diagnostics placed');
  f.answer({ 'textDocument/codeAction': { result: [] } });
  /* a line above inserted and sent: the diagnostics' ranges are where they are now */
  a.pt = 0; Ed.insertText(a, 'new\n'); Ed.lsp.flush(a);
  a.pt = a.text.indexOf('two');
  await keys('v j');
  mx('eglot-code-actions');
  await done();
  assert.equal(E.echo, 'No code actions here');
  const req = f.of('textDocument/codeAction')[0];
  assert.deepEqual(req.range, range(1, 4, 2, 5), "the selection, its end after the character under point");
  assert.deepEqual(req.context.diagnostics, [
    { range: range(1, 2, 1, 5), severity: 2, message: 'first', code: 'E1', source: 'fake', data: { fix: 1 } },
    { range: range(2, 4, 2, 9), severity: 2, message: 'second', code: 7, data: [1, 2], tags: [1] },
  ]);
  /* the active region without Evil's selection, in Emacs state */
  await keys('ESC');
  a.mark = a.text.indexOf('z'); a.pt = a.text.indexOf('z') + 1; (a as unknown as { markActive: boolean }).markActive = true;
  mx('eglot-code-actions');
  await done();
  assert.deepEqual(f.of('textDocument/codeAction')[1].range, range(4, 0, 4, 1));
  assert.deepEqual(f.of('textDocument/codeAction')[1].context.diagnostics.map((d: { message: string }) => d.message), ['elsewhere']);
});

test('quick fixes: only quickfix asked, other kinds left out, a single one applied at once, several chosen from, none said', async () => {
  const f = fake();
  const pr = project('quick', { 'a.fake': 'x = 1\n' });
  const a = await open(pr['a.fake']);
  const fix = (title: string, text: string, more = {}) => ({ title, kind: 'quickfix', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, text)), ...more });
  f.answer({ 'textDocument/codeAction': { result: [
    { title: 'Extract', kind: 'refactor.extract', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'E')) },
    { title: 'Bare', command: 'fake.organize' },
    fix('Add let', 'let '),
  ] } });
  mx('eglot-code-action-quickfix');
  await done();
  assert.equal(f.of('textDocument/codeAction').length, 1);
  assert.deepEqual(f.of('textDocument/codeAction')[0].context.only, ['quickfix']);
  assert.equal(a.text, 'let x = 1\n', E.echo);
  assert.equal(E.echo, 'Add let: 1 edit in 1 file, not saved');
  f.answer({ 'textDocument/codeAction': { result: [fix('Add var', 'var '), fix('Add const', 'const ', { isPreferred: true }), { ...fix('Sub kind', 'sub '), kind: 'quickfix.sub' }] } });
  mx('eglot-code-action-quickfix');
  const { cands } = await picker();
  assert.deepEqual(cands, ['Add const', 'Add var', 'Sub kind']);
  Ed.feedKey('RET');
  await done();
  assert.equal(a.text, 'const let x = 1\n', 'RET takes the preferred, selected first');
  f.answer({ 'textDocument/codeAction': { result: [{ title: 'Extract', kind: 'refactor.extract', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'E')) }] } });
  mx('eglot-code-action-quickfix');
  await done();
  assert.equal(E.echo, 'No quickfix code actions here');
  assert.equal(a.text, 'const let x = 1\n');
});

test("a command: refused unasked when the server does not name it; asked, n sends nothing and applies nothing; y applies the edit, runs it, and the server's edits during it are applied, one undo step", async () => {
  const f = fake();
  const pr = project('command', { 'a.fake': 'b\na\n', 'c.fake': 'c\n' });
  const a = await open(pr['a.fake']);
  const act = { title: 'Organize', kind: 'source.organizeImports', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, '# sorted\n')), command: { title: 'Organize', command: 'fake.organize', arguments: ['x', { y: 1 }] } };
  /* not the server's */
  f.answer({ 'textDocument/codeAction': { result: [{ ...act, command: { title: 'Run', command: 'editor.action.run' } }] } });
  mx('eglot-code-actions'); await picker(); choose('Organize');
  await done();
  assert.equal(E.echo, 'Organize: editor.action.run is not a command fake runs, and Edwin runs none of a server\'s commands itself');
  assert.equal(E.prompt, null, 'not asked');
  assert.equal(a.text, 'b\na\n');
  /* n */
  f.answer({ 'textDocument/codeAction': { result: [act] } });
  mx('eglot-code-actions'); await picker(); choose('Organize');
  await question('Organize: let fake run its command fake.organize?');
  Ed.feedKey('n');
  await done();
  assert.equal(E.echo, 'Organize: nothing done');
  assert.equal(a.text, 'b\na\n');
  assert.equal(f.of('workspace/executeCommand').length, 0);
  /* y: the edit, then the command, which edits through workspace/applyEdit */
  f.answer({ 'textDocument/codeAction': { result: [act] }, 'workspace/executeCommand': { requests: [applyEdit(changes(pr['a.fake'], edit(1, 0, 3, 0, 'a\nb\n'))), applyEdit(changes(pr['c.fake'], edit(0, 0, 0, 1, 'C')))], result: null } });
  mx('eglot-code-actions'); await picker(); choose('Organize');
  await question('Organize: let fake run its command fake.organize?');
  Ed.feedKey('y');
  await done();
  assert.deepEqual(f.of('workspace/executeCommand'), [{ command: 'fake.organize', arguments: ['x', { y: 1 }] }]);
  assert.equal(a.text, '# sorted\na\nb\n');
  const c = E.buffers.find((x: Buf) => x.file === pr['c.fake']) as Buf;
  assert.equal(c.text, 'C\n');
  assert.deepEqual(answers(f).map((x: { result: unknown }) => x.result), [{ applied: true }, { applied: true }]);
  assert.equal(E.echo, 'Organize: 1 edit in 1 file; fake.organize run, its edits 2 edits in 2 files (1 visited for it), not saved');
  const told = f.lines(), run = told.findIndex(l => l.method === 'workspace/executeCommand');
  assert.deepEqual(told.slice(0, run).filter(l => l.method === 'textDocument/didChange').map(l => JSON.parse(l.rest).contentChanges[0].text).pop(), '# sorted\nb\na\n', 'the edit sent before the command');
  await keys('u');
  assert.equal(a.text, 'b\na\n', 'the edit and the command\'s one undo step in the current buffer');
  await keys('u');
  assert.match(E.echo, /Already at oldest change/, 'and no step between them');
  assert.equal(a.text, 'b\na\n');
  Ed.setWindowBuffer(c);
  await keys('u');
  assert.equal(c.text, 'c\n');
});

test("each change sent before the command and before the server's next edit: the action's edit of another open file, and a file edited twice by the command, one visited for it", async () => {
  const f = fake();
  const pr = project('twice', { 'a.fake': 'b\na\n', 'b.fake': 'one\n', 'c.fake': 'c\n' });
  const b = await open(pr['b.fake']);
  const a = await open(pr['a.fake']);
  /* the action's edit is of b.fake, not the current a.fake; the command edits b.fake, then a.fake twice and c.fake (not open) twice */
  const act = { title: 'Two', edit: changes(pr['b.fake'], edit(0, 0, 0, 0, 'E')), command: { title: 'Two', command: 'fake.organize' } };
  f.answer({ 'textDocument/codeAction': { result: [act] }, 'workspace/executeCommand': { requests: [
    applyEdit(changes(pr['b.fake'], edit(0, 0, 0, 1, 'F'))),
    applyEdit(changes(pr['a.fake'], edit(0, 0, 0, 0, 'X'))), applyEdit(changes(pr['a.fake'], edit(1, 0, 1, 0, 'Y'))),
    applyEdit(changes(pr['c.fake'], edit(0, 0, 0, 0, 'P'))), applyEdit(changes(pr['c.fake'], edit(1, 0, 1, 0, 'Q'))),
  ], result: null } });
  mx('eglot-code-actions'); await picker(); choose('Two');
  await question('Two: let fake run its command fake.organize?');
  Ed.feedKey('y');
  await done();
  assert.deepEqual(answers(f).map((x: { result: unknown }) => x.result), [{ applied: true }, { applied: true }, { applied: true }, { applied: true }, { applied: true }]);
  assert.equal(b.text, 'Fone\n');
  assert.equal(a.text, 'Xb\nYa\n');
  const c = E.buffers.find((x: Buf) => x.file === pr['c.fake']) as Buf;
  assert.equal(c.text, 'Pc\nQ');
  const told = f.lines();
  const toB = told.findIndex(l => l.method === 'textDocument/didChange' && JSON.parse(l.rest).textDocument.uri === uri(pr['b.fake']));
  assert.ok(toB >= 0 && toB < told.findIndex(l => l.method === 'workspace/executeCommand'), "the action's edit of b.fake sent before the command");
  assert.equal(E.echo, 'Two: 1 edit in 1 file; fake.organize run, its edits 5 edits in 3 files (1 visited for it), not saved');
});

test("the server's edit at any other time is refused, and a refused one during a command is said and answered applied false", async () => {
  const f = fake();
  const pr = project('unasked', { 'a.fake': 'one\n' });
  const outside = project('outside', { 'o.fake': 'out\n' });
  const a = await open(pr['a.fake']);
  /* with the answer to codeAction: no command runs */
  f.answer({ 'textDocument/codeAction': { requests: [applyEdit(changes(pr['a.fake'], edit(0, 0, 0, 3, 'HACKED')))], result: [] } });
  mx('eglot-code-actions');
  await done();
  assert.deepEqual(answers(f).map((x: { result: unknown }) => x.result), [{ applied: false, failureReason: "Edwin applies a server's edit only while it runs a command the user chose" }]);
  assert.equal(a.text, 'one\n');
  assert.equal(a.modified, false);
  /* during a command: a file outside the project refused, said, the command still answered */
  f.answer({ 'textDocument/codeAction': { result: [{ title: 'Fix', command: 'fake.organize' }] }, 'workspace/executeCommand': { requests: [applyEdit(changes(outside['o.fake'], edit(0, 0, 0, 3, 'X')))], result: null } });
  mx('eglot-code-actions'); await picker(); choose('Fix');
  await question('Fix: let fake run its command fake.organize?');
  Ed.feedKey('y');
  await done();
  const last = answers(f).pop();
  assert.equal(last.result.applied, false);
  assert.match(last.result.failureReason, /^The server's edit is not applied: .*o\.fake is not in /);
  assert.match(E.echo, /^Fix: fake\.organize run; an edit of it refused: The server's edit is not applied: .*o\.fake is not in /);
  assert.equal(fs.readFileSync(outside['o.fake'], 'utf8'), 'out\n');
  assert.ok(!fileBuffers().includes(outside['o.fake']));
  /* an error answer to the command, then C-g while one hangs: no command runs after either, so an edit then is refused */
  f.answer({ 'textDocument/codeAction': { result: [{ title: 'Fix', command: 'fake.fail' }] }, 'workspace/executeCommand': { error: { code: -32603, message: 'boom' } } });
  mx('eglot-code-actions'); await picker(); choose('Fix');
  await question('Fix: let fake run its command fake.fail?');
  Ed.feedKey('y');
  await done();
  assert.match(E.echo, /workspace\/executeCommand: boom/);
  f.answer({ 'textDocument/codeAction': { result: [{ title: 'Fix', command: 'fake.fail' }] }, 'workspace/executeCommand': 'hang' });
  mx('eglot-code-actions'); await picker(); choose('Fix');
  await question('Fix: let fake run its command fake.fail?');
  Ed.feedKey('y');
  await until(() => f.of('workspace/executeCommand').length === 3, 'the command sent');
  Ed.feedKey('C-g');
  await done();
  const n = answers(f).length;
  f.answer({ 'textDocument/codeAction': { requests: [applyEdit(changes(pr['a.fake'], edit(0, 0, 0, 3, 'HACKED')))], result: [] } });
  mx('eglot-code-actions');
  await done();
  assert.equal(answers(f).length, n + 1);
  assert.equal(answers(f)[n].result.applied, false);
  assert.equal(a.text, 'one\n');
});

test('an edit refused as the text changed while the server worked or the action was chosen: nothing applied and its command not run', async () => {
  const f = fake();
  const pr = project('stale', { 'a.fake': 'thing\n', 'b.fake': 'thing\n' });
  const b = await open(pr['b.fake']);
  const a = await open(pr['a.fake']);
  const act = { title: 'Both', edit: { changes: { [uri(pr['a.fake'])]: [edit(0, 0, 0, 5, 'other')], [uri(pr['b.fake'])]: [edit(0, 0, 0, 5, 'other')] } }, command: { title: 'Both', command: 'fake.organize' } };
  f.answer({ 'textDocument/codeAction': { result: [act] } });
  mx('eglot-code-actions');
  await picker();
  /* b changed and sent while the picker is open */
  b.pt = 0; Ed.insertText(b, 'XX'); Ed.lsp.flush(b);
  choose('Both');
  await question('Both: let fake run its command fake.organize?');
  Ed.feedKey('y');
  await done();
  assert.equal(E.echo, "The server's edit is not applied: b.fake has changed since the server made the edit");
  assert.equal(a.text, 'thing\n'); assert.equal(b.text, 'XXthing\n');
  assert.equal(f.of('workspace/executeCommand').length, 0, 'the command not run');
  /* the same with b as it was: applied */
  Ed.deleteText(b, 0, 2); b.modified = false; Ed.lsp.flush(b);
  f.answer({ 'textDocument/codeAction': { result: [{ ...act, command: undefined }] } });
  mx('eglot-code-actions'); await picker(); choose('Both');
  await done();
  assert.equal(E.echo, 'Both: 2 edits in 2 files, not saved');
  assert.equal(a.text, 'other\n'); assert.equal(b.text, 'other\n');
});

test('the answer to a buffer no longer current dropped with a message; no capability, not asked; an error answer; at most 500 actions', async () => {
  const f = fake();
  const pr = project('drop', { 'a.fake': 'one\n', 'b.fake': 'two\n' });
  const b = await open(pr['b.fake']);
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/codeAction': { delay: 400, result: [{ title: 'Fix', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'x')) }] } });
  mx('eglot-code-actions');
  await until(() => f.of('textDocument/codeAction').length === 1, 'the request');
  Ed.setWindowBuffer(b);
  await done();
  assert.match(E.echo, /^Code actions dropped: .*a\.fake is no longer the current buffer$/);
  assert.equal(E.mini, null);
  assert.equal(a.text, 'one\n');
  Ed.setWindowBuffer(a);
  f.answer({ 'textDocument/codeAction': { error: { code: -32603, message: 'boom' } } });
  mx('eglot-code-actions');
  await done();
  assert.match(E.echo, /textDocument\/codeAction: boom/);
  f.answer({ 'textDocument/codeAction': { result: null } });
  mx('eglot-code-actions');
  await done();
  assert.equal(E.echo, 'No code actions here');
  const many = Array.from({ length: 501 }, (_, i) => ({ title: `Fix ${i}`, edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'x')) }));
  f.answer({ 'textDocument/codeAction': { result: many } });
  mx('eglot-code-actions');
  const { cands } = await picker();
  assert.equal(cands.length, 500);
  assert.equal(cands[499], 'Fix 499');
  Ed.feedKey('C-g');
  await done();
  await Ed.lsp.shutdownAll();
  const g = fake({});
  const c = await open(project('nocap', { 'a.fake': 'one\n' })['a.fake']);
  mx('eglot-code-actions');
  await done();
  assert.equal(E.echo, 'fake gives no code actions');
  assert.equal(g.of('textDocument/codeAction').length, 0, 'not asked');
  assert.equal(c.text, 'one\n');
});

test('dropped when the server stopped while the action was chosen, or the buffer was left while the command was asked about; another server\'s edit while a command runs refused', async () => {
  const f = fake();
  const pr = project('dropped', { 'a.fake': 'one\n', 'b.fake': 'two\n' });
  const b = await open(pr['b.fake']);
  const a = await open(pr['a.fake']);
  f.answer({ 'textDocument/codeAction': { result: [{ title: 'Fix', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'x')) }, { title: 'Run', command: 'fake.organize' }] } });
  mx('eglot-code-actions');
  await picker();
  await Ed.lsp.shutdown(Ed.lsp.sessionOf(a));
  choose('Fix');
  await done();
  assert.match(E.echo, /^Fix: dropped, as .*a\.fake is no longer current or its server no longer runs$/);
  assert.equal(a.text, 'one\n');
  L.call('eglot-mode', [1]);
  await Ed.lsp.ready(Ed.lsp.sessionOf(a));
  mx('eglot-code-actions'); await picker(); choose('Run');
  await question('Run: let fake run its command fake.organize?');
  Ed.setWindowBuffer(b);
  Ed.feedKey('y');
  await done();
  assert.match(E.echo, /^Run: dropped, as .*a\.fake is no longer current or its server no longer runs$/);
  assert.equal(f.of('workspace/executeCommand').length, 0, 'not run');
  /* another project's server, asking for an edit while this one's command runs */
  Ed.setWindowBuffer(a);
  const g = fake();
  const other = project('other', { 'c.fake': 'three\n' });
  const c = await open(other['c.fake']);
  g.answer({ onChange: [applyEdit(changes(other['c.fake'], edit(0, 0, 0, 5, 'HACKED')))] });
  Ed.setWindowBuffer(a);
  f.answer({ 'textDocument/codeAction': { result: [{ title: 'Run', command: 'fake.organize' }] }, 'workspace/executeCommand': 'hang' });
  mx('eglot-code-actions'); await picker(); choose('Run');
  await question('Run: let fake run its command fake.organize?');
  Ed.feedKey('y');
  await until(() => f.of('workspace/executeCommand').length === 1, 'the command sent');
  c.pt = 0; Ed.insertText(c, 'X'); Ed.lsp.flush(c);
  await until(() => answers(g).length === 1, "the other server's edit answered");
  assert.deepEqual(answers(g)[0].result, { applied: false, failureReason: "Edwin applies a server's edit only while it runs a command the user chose" });
  assert.equal(c.text, 'Xthree\n');
  Ed.feedKey('C-g');
  await done();
});

test('titles cut at 200 and kinds at 80; a command with no name left out, bare or in an action', async () => {
  const f = fake();
  const pr = project('cuts', { 'a.fake': 'one\n' });
  await open(pr['a.fake']);
  const e = changes(pr['a.fake'], edit(0, 0, 0, 0, 'x'));
  f.answer({ 'textDocument/codeAction': { result: [
    { title: 'T'.repeat(300), kind: 'k'.repeat(100), edit: e },
    { title: 'Bare', command: '' },
    { title: 'Nested', command: { title: 'Nested', command: '' } },
    { title: 'Kept', edit: e },
  ] } });
  mx('eglot-code-actions');
  const { cands, anns } = await picker();
  assert.deepEqual(cands, ['T'.repeat(200) + '…', 'Kept']);
  assert.deepEqual(anns, ['k'.repeat(80) + '…', '']);
  Ed.feedKey('C-g');
  await done();
});

test('asked while the server starts: the range follows an edit made meanwhile; the answer to a buffer killed meanwhile dropped silently, to one out of its server with a message', async () => {
  const f = fake({ codeActionProvider: true, initDelay: 600 });
  const pr = project('starting', { 'a.fake': 'one two\n', 'b.fake': 'x\n' });
  await keys('ESC');
  const a = L.call('find-file', [pr['a.fake']]) as Buf;
  assert.equal(Ed.lsp.sessionOf(a).state, 'starting');
  a.pt = 4;
  f.answer({ 'textDocument/codeAction': { result: [] } });
  mx('eglot-code-actions');
  await until(() => E.running > 0, 'the command waiting');
  a.pt = 0; Ed.insertText(a, 'zero ');
  await done();
  assert.equal(E.echo, 'No code actions here');
  assert.deepEqual(f.of('textDocument/codeAction')[0].range, range(0, 9, 0, 9), 'point as it was, moved on by the edit before it');
  /* killed while the server works: nothing said, nothing shown */
  const b = await open(pr['b.fake']);
  f.answer({ 'textDocument/codeAction': { delay: 400, result: [{ title: 'Fix', edit: changes(pr['b.fake'], edit(0, 0, 0, 0, 'y')) }] } });
  mx('eglot-code-actions');
  await until(() => f.of('textDocument/codeAction').length === 2, 'the request');
  b.modified = false; L.call('kill-buffer', [b]);
  await done();
  assert.equal(E.mini, null);
  assert.ok(!/Code actions dropped|Fix/.test(E.echo), E.echo);
  assert.ok(!fileBuffers().includes(pr['b.fake']));
  /* eglot-mode turned off while the server works */
  Ed.setWindowBuffer(a);
  f.answer({ 'textDocument/codeAction': { delay: 400, result: [{ title: 'Fix', edit: changes(pr['a.fake'], edit(0, 0, 0, 0, 'y')) }] } });
  mx('eglot-code-actions');
  await until(() => f.of('textDocument/codeAction').length === 3, 'the request');
  L.call('eglot-mode', [0]);
  await done();
  assert.match(E.echo, /^Code actions dropped: .*a\.fake left its language server$/);
  assert.equal(E.mini, null);
  assert.equal(a.text, 'zero one two\n');
});

test('nil: a string rewritten as an indented one', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL names no nil' }, async () => {
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command (list ${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const pr = project('nil', { 'default.nix': '{ a = "foo"; }\n' });
  const b = await open(pr['default.nix']);
  assert.ok((Ed.lsp.sessionOf(b).capabilities || {}).codeActionProvider, 'nil gives code actions');
  b.pt = b.text.indexOf('foo');
  mx('eglot-code-actions');
  const { cands } = await picker();
  assert.ok(cands.includes('Rewrite to indented string'), cands.join(', '));
  choose('Rewrite to indented string');
  await done();
  assert.equal(b.text, "{ a = ''\n  foo''; }\n", E.echo);
  assert.equal(E.echo, 'Rewrite to indented string: 1 edit in 1 file, not saved');
  await keys('u');
  assert.equal(b.text, '{ a = "foo"; }\n');
  Ed.lsp.shutdown(Ed.lsp.sessionOf(b));
  await until(() => proc.running().length === 0, 'nil ended');
});
