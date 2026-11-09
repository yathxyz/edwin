// pi agents (server/agent.mts, scm/pi.scm, scm/pi-tools.scm) against a real edwind and a loopback provider: a chat
// note runs the agent loop, a tool edits another note after a yes in the chat, a no reaches the model, the
// session is saved, and a switch of backend mid-session carries the conversation to another provider's API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild } from './edit-client.mts';

const KEY = 'sk-test-' + randomBytes(12).toString('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const body = (req: http.IncomingMessage) => new Promise<string>(r => { let s = ''; req.setEncoding('utf8'); req.on('data', d => { s += d; }); req.on('end', () => r(s)); });
const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: Msg) => p.text ?? (typeof p.content === 'string' ? p.content : textOf(p.content)) ?? '').join('') : '';

/* The provider: the Messages API (tool_use when asked to rename, then text naming the tool result) and chat
   completions (always "Local", recording what it was sent). */
const seen: { path: string; body: Msg }[] = [];
let target = '';
const server = http.createServer(async (req, res) => {
  const b = JSON.parse(await body(req) || '{}'); seen.push({ path: req.url!, body: b });
  if (req.url!.startsWith('/v1/chat/completions')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o: unknown) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    ev({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Local' } }] });
    ev({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    res.write('data: [DONE]\n\n'); return res.end();
  }
  if (req.headers['x-api-key'] !== KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"message":"bad key"}}'); }
  const last = b.messages[b.messages.length - 1];
  const result = Array.isArray(last.content) ? last.content.find((p: Msg) => p.type === 'tool_result') : null;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } } });
  /* A prompt that names a scripted tool call gets it (once: the next request carries its result). */
  const ask = textOf(last.content);
  const call = result ? null
    : /rename/.test(ask) ? { name: 'edit_buffer', input: { name: target, old: 'Now', new: 'Later' } }
    : /patch the image/.test(ask) ? { name: 'image_define', input: { code: '(define (agent-fixed) 42)' } }
    : /describe it/.test(ask) ? { name: 'describe', input: { name: 'image-log' } }
    : null;
  if (call && b.tools && b.tools.some((t: Msg) => t.name === call.name)) {
    ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_' + seen.length, name: call.name, input: {} } });
    ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
  } else {
    const say = result ? `Done: ${textOf(result.content)}` : 'Hello';
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const part of [say.slice(0, 3), say.slice(3)]) { ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } }); await sleep(5); }
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
  }
  ev('message_stop', {}); res.end();
});

let dir: TestDir, child: EdwindChild, origin: string;
before(async () => {
  origin = await new Promise<string>(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  dir = makeDir({ models: { anthropic: { baseUrl: origin, credential: 'anthropic-api-key' }, tiers: { default: 'tier-default', quick: 'tier-quick' } } });
  const creds = path.join(dir.root, 'creds');
  fs.mkdirSync(creds, { mode: 0o700 }); fs.writeFileSync(path.join(creds, 'anthropic-api-key'), KEY, { mode: 0o400 });
  /* init.scm runs before the agent module: its tools wait for it, and one of them replaces a built-in. */
  fs.writeFileSync(path.join(dir.dirs.config, 'init.scm'), `(define-pi-tool 'today "The date." '() (lambda (args) "2026-11-09"))
(define-pi-tool 'list_buffers "Mine." '() (lambda (args) "mine"))
`);
  child = await startEdwind(dir, { env: { CREDENTIALS_DIRECTORY: creds } });
});
after(async () => {
  await stopEdwind(child);
  await new Promise<void>(r => server.close(() => r()));
  fs.rmSync(dir.root, { recursive: true, force: true });
});
const client = async (kind = 'cli') => { const c = new EditClient(dir.cfg.socket, { kind }); await c.connect(); assert.equal((await c.hello()).t, 'welcome'); return c; };
const evalIn = async (c: EditClient, form: string, buf?: string) => { const m: Msg = { t: 'call', form, ctx: {} }; if (buf) m.buf = buf; const r = await c.request(m); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value; };
const textIn = async (c: EditClient, buf: string) => JSON.parse(await evalIn(c, '(buffer-string)', buf));
async function until(c: EditClient, buf: string, pred: (t: string) => boolean, what: string) {
  let t = '';
  for (let i = 0; i < 200; i++) { t = await textIn(c, buf); if (pred(t)) return t; await sleep(25); }
  assert.fail(`timed out waiting for ${what}; the buffer is:\n${t}`);
}

test('a chat note runs a pi agent: a tool edits after a yes, a no reaches the model, the session is saved and moves to another provider', async () => {
  fs.mkdirSync(path.join(dir.dirs.notes, 'pi'), { recursive: true });
  fs.writeFileSync(path.join(dir.dirs.notes, 'todo.md'), 'Now: write tests\n');
  fs.writeFileSync(path.join(dir.dirs.notes, 'pi', 't.md'), '## You\n\nrename it\n');
  const f = await client('frame'), w = await client();
  const chat = 'pi/t.md';
  await f.open(chat); await f.open('todo.md');
  target = JSON.parse(await evalIn(w, '(buffer-name)', 'todo.md'));
  assert.ok((await evalIn(w, '(%pi-tools)')).includes('edit_buffer'));

  /* Send: the agent asks for edit_buffer, the chat shows the question; C-c RET (pi-send again) allows it. */
  let r = await f.request({ t: 'call', cmd: 'pi-send', args: [], ctx: {}, buf: chat });
  assert.equal(r.error, undefined, JSON.stringify(r.error)); assert.match(r.msg || '', /asking anthropic/);
  await until(w, chat, t => t.includes('**Allow** `edit_buffer`'), 'the confirmation');
  assert.equal(await textIn(w, 'todo.md'), 'Now: write tests\n', 'nothing is edited before the yes');
  r = await f.request({ t: 'call', cmd: 'pi-send', args: [], ctx: {}, buf: chat });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  let text = await until(w, chat, t => /## You\n\n$/.test(t.slice(t.indexOf('Done'))), 'the answer');
  assert.equal(await textIn(w, 'todo.md'), 'Later: write tests\n');
  assert.match(text, /> tool `edit_buffer`/); assert.match(text, /> allowed/); assert.match(text, /Done: Replaced 3 characters with 5\./);
  const session = JSON.parse(await evalIn(w, '(pi--session-name (current-buffer))', chat));
  const writers = (await w.call('list-writers', [], {}, 'todo.md')).value;
  assert.ok(writers.some((b: Msg) => b.kind === 'agent' && b.agent === `pi:${session}`), JSON.stringify(writers));
  /* The tool came with its JSON Schema, and the key went to the provider only as its header. */
  const toolReq = seen.find(s => s.path.startsWith('/v1/messages') && s.body.tools)!;
  const edit = toolReq.body.tools.find((t: Msg) => t.name === 'edit_buffer');
  assert.deepEqual(edit.input_schema.required, ['name', 'old', 'new']);
  assert.ok(!JSON.stringify(seen).includes(KEY));

  /* A no: the model hears the refusal, the note stays as it was. */
  await evalIn(w, '(begin (goto-char (point-max)) (insert "rename it again\\n"))', chat);
  await f.request({ t: 'call', cmd: 'pi-send', args: [], ctx: {}, buf: chat });
  await until(w, chat, t => (t.match(/\*\*Allow\*\*/g) || []).length === 2, 'the second confirmation');
  r = await f.request({ t: 'call', cmd: 'pi-abort', args: [], ctx: {}, buf: chat });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  text = await until(w, chat, t => (t.match(/## You\n/g) || []).length === 3, 'the answer to the no');
  assert.match(text, /> denied/); assert.match(text, /Done: .*declined/);
  assert.equal(await textIn(w, 'todo.md'), 'Later: write tests\n');

  /* Saved: the conversation is in stateDir/pi, mode 0600. */
  const saved = path.join(dir.dirs.state, 'pi', session + '.json');
  const st = fs.statSync(saved); assert.equal(st.mode & 0o777, 0o600);
  const conv = JSON.parse(fs.readFileSync(saved, 'utf8'));
  assert.equal(conv.backend, 'anthropic'); assert.ok(conv.messages.length >= 8, String(conv.messages.length));
  assert.ok(!fs.readFileSync(saved, 'utf8').includes(KEY));

  /* Another backend mid-session: chat completions gets the whole conversation, tool calls included. */
  await evalIn(w, `(gptel-make-openai "local" :host "${origin}" :models (quote ("m1")) :tiers (quote ((default . "m1"))))`);
  r = await f.request({ t: 'call', cmd: 'pi-model', args: ['local', ''], ctx: {}, buf: chat });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  await evalIn(w, '(begin (goto-char (point-max)) (insert "and now?\\n"))', chat);
  await f.request({ t: 'call', cmd: 'pi-send', args: [], ctx: {}, buf: chat });
  text = await until(w, chat, t => t.includes('Local'), 'the other provider');
  const oai = seen.filter(s => s.path.startsWith('/v1/chat/completions')).pop()!;
  assert.equal(oai.body.model, 'm1');
  const roles = oai.body.messages.map((m: Msg) => m.role);
  assert.ok(roles.includes('tool') && roles.includes('assistant') && roles[0] === 'system', JSON.stringify(roles));
  f.close(); w.close();
});

test('pi-send needs text; steering and aborting need a run; a session name is checked', async () => {
  const w = await client();
  fs.writeFileSync(path.join(dir.dirs.notes, 'empty.md'), '## You\n\n');
  await w.open('empty.md');
  let r = await w.request({ t: 'call', cmd: 'pi-send', args: [], ctx: {}, buf: 'empty.md' });
  assert.equal(r.error.condition, 'user-error'); assert.match(r.error.report, /nothing to send/);
  r = await w.request({ t: 'call', cmd: 'pi-steer', args: ['x'], ctx: {}, buf: 'empty.md' });
  assert.equal(r.error.condition, 'user-error');
  r = await w.request({ t: 'call', cmd: 'pi-abort', args: [], ctx: {}, buf: 'empty.md' });
  assert.equal(r.msg, 'pi: nothing is running here');
  r = await w.request({ t: 'call', form: '(%pi-session "../x")', ctx: {} });
  assert.equal(r.error.condition, 'user-error');
  assert.match(await evalIn(w, '(%pi-tools)'), /"today"/);
  r = await w.request({ t: 'call', form: '(begin (define-pi-tool (quote bad) "x" (quote ((a list "y"))) (lambda (a) "")) #t)', ctx: {} });
  assert.equal(r.error.condition, 'user-error');
  w.close();
});

test('a pi agent works on the image: describe reads a definition and its shipped source; image_define asks, then logs the definition as the agent and every frame hears of it', async () => {
  fs.writeFileSync(path.join(dir.dirs.notes, 'pi', 'img.md'), '## You\n\ndescribe it\n');
  const f = await client('frame'), w = await client();
  const chat = 'pi/img.md';
  await f.open(chat);
  let r = await f.request({ t: 'call', cmd: 'pi-send', args: [], ctx: {}, buf: chat });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  let text = await until(w, chat, t => t.includes('Done:'), 'the description');
  assert.match(text, /image-log is a procedure/); assert.match(text, /Defined at edwin\/scm\/emacs\.scm:\d+/); assert.match(text, /Source:\n\d+: \(define-command \(image-log\)/);

  await evalIn(w, '(begin (goto-char (point-max)) (insert "patch the image\\n"))', chat);
  r = await f.request({ t: 'call', cmd: 'pi-send', args: [], ctx: {}, buf: chat });
  await until(w, chat, t => t.includes('**Allow** `image_define`'), 'the confirmation');
  assert.equal(await evalIn(w, "(bound? 'agent-fixed)"), '#f', 'nothing is defined before the yes');
  r = await f.request({ t: 'call', cmd: 'pi-send', args: [], ctx: {}, buf: chat });
  text = await until(w, chat, t => /Logged as image generation/.test(t), 'the definition');
  assert.equal(await evalIn(w, '(agent-fixed)'), '42');
  const session = JSON.parse(await evalIn(w, '(pi--session-name (current-buffer))', chat));
  const last = (await w.call('image-entries')).value.pop();
  assert.equal(last.form, '(define (agent-fixed) 42)');
  assert.deepEqual(last.by, { kind: 'agent', agent: `pi:${session}` }); assert.equal(last.origin, `pi:${session}`);
  for (let i = 0; i < 100 && !f.queue.some(m => m.t === 'image' && m.forms.includes('(define (agent-fixed) 42)')); i++) await sleep(20);
  assert.ok(f.queue.some(m => m.t === 'image' && m.forms.includes('(define (agent-fixed) 42)')), 'the frame gets the entry');
  assert.ok(f.queue.some(m => m.t === 'msg' && new RegExp(`Image changed by pi:${session}: agent-fixed`).test(m.text)), 'Q2: the frame is told who changed the image');
  f.close(); w.close();
});
