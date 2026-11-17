// AS1 steering and prompt engineering against edwind + a loopback API. No agent or external provider runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeAgentHub } from './fake-agent-hub.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
import type { TestDir, EdwindChild, Msg } from './edit-client.mts';

type Core = any; // any: classic-script frame runtime and extensible ACP JSON
const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.cts');
let hub: FakeAgentHub, dir: TestDir, child: EdwindChild, client: EditClient, Ed: Core, E: Core, L: Core;
let tokenFile: string;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => unknown, message: string) {
  const start = Date.now();
  while (!f()) { if (Date.now() - start > 8000) throw new Error(message); await sleep(10); }
}
async function connect() {
  const c = new EditClient(dir.cfg.socket, { kind: 'frame' }); await c.connect(); assert.equal((await c.hello()).t, 'welcome'); return c;
}
async function value(command: string, args: unknown[] = []): Promise<any> { // any: wire result
  const r = await client.call(command, args); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value;
}
async function pending(sid: string, req: number) {
  const start = Date.now();
  for (;;) {
    const rows = await value('agent-session-pending') as Msg[];
    if (rows.length === 1 && rows[0].sid === sid && rows[0].req === req) return;
    if (Date.now() - start > 8000) throw new Error('pending request did not reach the registry');
    await sleep(10);
  }
}
async function frame() {
  if (Ed) return;
  Ed = loadEdwin(createHost({ storage: memoryStorage(), workers: false })); E = Ed.E; L = (globalThis as Core).L;
  await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'agent-prompt-test' }); await Ed.whenIdle();
}
async function keys(text: string) { for (const k of Ed.kbd(text).split(' ')) Ed.feedKey(k); await Ed.whenIdle(); }
async function mini(text: string) {
  await until(() => E.mini, 'expected a minibuffer');
  E.minibuf.text = text; E.minibuf.pt = text.length; Ed.feedKey('RET'); await Ed.whenIdle();
}
function show(b: Core) { Ed.setWindowBuffer(b); E.current = b; }

before(async () => {
  hub = await new FakeAgentHub().start(); hub.add('alpha'); hub.add('beta');
  dir = makeDir({ writablePaths: [] }); tokenFile = path.join(dir.root, 'agent-token');
  fs.writeFileSync(tokenFile, hub.token + '\n', { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  child = await startEdwind(dir); client = await connect();
});
after(async () => {
  if (Ed) Ed.sync.shutdown(); if (client) client.close(); if (child) await stopEdwind(child); if (hub) await hub.stop();
  if (dir) fs.rmSync(dir.root, { recursive: true, force: true });
});

test('basic Markdown draft retains edited text after abandon, buffer kill and daemon restart', async () => {
  const id = await value('agent-prompt-create', [{ sid: 'alpha' }]), opened = await client.open(id);
  const body = 'A durable basic prompt\\n';
  assert.equal((await client.edit(id, opened.ver!, [[0, '', body]])).t, 'ack');
  const preview = await value('agent-prompt-preview', [id]);
  assert.deepEqual(preview.blocks, [{ type: 'text', text: body }]);
  await value('agent-prompt-abandon', [id]); await value('kill-buffer', [id]);
  assert.equal(await value('agent-prompt-open', [id]), id);
  assert.deepEqual(await value('agent-prompt-preview', [id]), preview);
  client.close(); await stopEdwind(child); child = await startEdwind(dir); client = await connect();
  assert.deepEqual(await value('agent-prompt-preview', [id]), preview);
});


test('prompt minor keys outrank Markdown/Evil, drain local edits and send exactly previewed JSON; abandon retains', async () => {
  await frame();
  await L.call('agent-session-prompt', ['alpha']); const draft = E.current;
  assert.equal(draft.mode, 'markdown-mode'); assert.equal(Ed.localValue(draft, 'agent-prompt-enabled'), true);
  Ed.insertText(draft, 'local edits before preview\n');
  await keys('C-c C-p');
  const preview = JSON.parse(Ed.getBuffer('*Agent Prompt Preview*').text); assert.equal(preview.blocks[0].text, 'local edits before preview\n');
  show(draft); await keys('C-c C-c');
  const call = hub.calls.filter(c => c.path === '/v1/sessions/alpha/prompt').at(-1)!; assert.deepEqual(call.body!.blocks, preview.blocks);
  await L.call('agent-session-prompt', ['alpha']); const abandoned = E.current; Ed.insertText(abandoned, 'retained unsent');
  const mark = hub.calls.length; await keys('C-c C-k');
  assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 0);
  assert.equal((await value('agent-prompt-preview', [abandoned.id])).blocks[0].text, 'retained unsent');
});


test('permission can be answered globally from another buffer and stale/competing outcomes remain errors', async () => {
  await frame();
  const summary = hub.sessions.get('alpha')!;
  const request = hub.append('alpha', { e: 'permission', toolCall: { title: 'Read source' }, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject once', kind: 'reject_once' }] });
  await pending('alpha', request.seq);
  show(Ed.getBufferCreate('*Other work*')); const other = E.current;
  await until(() => Ed.getBuffer('*Messages*').text.includes('Read source'), 'permission announcement');
  await keys('C-c a !'); await mini('once: Allow once');
  const answer = hub.calls.filter(c => c.path.endsWith('/permission')).at(-1)!;
  assert.deepEqual(answer.body, { req: request.seq, epoch: summary.createdAt, outcome: { outcome: 'selected', optionId: 'once' } });
  assert.equal(E.current, other);
  const again = await client.call('agent-session-permission', ['alpha', answer.body]); assert.match(again.error.report, /already|resolved|answered/i);
  const stale = await client.call('agent-session-permission', ['alpha', { ...answer.body, epoch: summary.createdAt - 1 }]); assert.match(stale.error.report, /stale/i);
  const cancel = hub.append('alpha', { e: 'permission', toolCall: { title: 'Another read' }, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }] });
  await pending('alpha', cancel.seq);
  await keys('C-c a !'); await mini('Cancel request');
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/permission')).at(-1)!.body!.outcome, { outcome: 'cancelled' });
});

test('form elicitation preserves primitive types and arrays; decline/cancel and URL origin are explicit, never auto-opened', async () => {
  await frame();
  const schema = { type: 'object', required: ['name', 'count', 'allowed', 'tags'], properties: { name: { type: 'string' }, count: { type: 'number' }, allowed: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } } };
  const request = hub.append('beta', { e: 'elicitation', request: { message: 'Supply form', requestedSchema: schema } });
  await pending('beta', request.seq);
  await keys('C-c a !');
  for (const input of ['accept', 'Alice', '2.5', 'true', '["one","two"]']) await mini(input);
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/elicitation')).at(-1)!.body!.response, { action: 'accept', content: { name: 'Alice', count: 2.5, allowed: true, tags: ['one', 'two'] } });
  for (const action of ['decline', 'cancel']) {
    const next = hub.append('beta', { e: 'elicitation', request: { message: 'Supply form', requestedSchema: schema } }); await pending('beta', next.seq);
    await keys('C-c a !'); await mini(action);
    assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/elicitation')).at(-1)!.body!.response, { action });
  }
  const url = 'https://approval.example.invalid:8443/full/path?request=visible';
  const linked = hub.append('beta', { e: 'elicitation', request: { message: 'External approval', mode: 'url', url } }); await pending('beta', linked.seq);
  await keys('C-c a !'); await until(() => Ed.getBuffer('*Agent Elicitation URL*'), 'URL buffer');
  assert.match(Ed.getBuffer('*Agent Elicitation URL*').text, /https:\/\/approval\.example\.invalid:8443/);
  assert.ok(Ed.getBuffer('*Agent Elicitation URL*').text.includes(url)); await mini('cancel');
  assert.ok(!child.logs.includes(hub.token));
});

test('offered mode/config values reach the API and an old hub reports config unsupported', async () => {
  await frame();
  hub.append('alpha', { e: 'session', via: 'new', sessionId: 'agent-alpha', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Automatic' }] }, configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] }] });
  await L.call('agent-session-mode', ['auto', 'alpha']);
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/mode')).at(-1)!.body, { modeId: 'auto' });
  await L.call('agent-session-config', ['model', 'large', 'alpha']);
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/config')).at(-1)!.body, { id: 'model', value: 'large' });
  hub.configSupported = false;
  try { await assert.rejects(L.call('agent-session-config', ['model', 'small', 'alpha']), /unsupported|does not support/i); }
  finally { hub.configSupported = true; }
});

