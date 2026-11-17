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
  if (Ed) { await until(() => Ed.sync.state === 'online', 'frame reconnect'); return; }
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
test('exact blocks, private per-edit persistence, attachments, named reuse, kill/reopen and daemon restart', async () => {
  const retained = await value('agent-prompt-create', [{ targets: ['alpha', 'beta'] }]);
  const opened = await client.open(retained); assert.equal(opened.error, null); assert.equal(opened.meta!.readOnly, false); assert.equal(opened.meta!.mode, 'markdown-mode');
  const body = '# A real prompt\n\n```md\n## not a transcript boundary\n```\n';
  assert.equal((await client.edit(retained, opened.ver!, [[0, '', body]])).t, 'ack');
  const key = /: ([A-Za-z0-9_-]+)\*$/.exec(retained)![1], root = path.join(dir.dirs.state, 'agent-prompts');
  await value('agent-prompt-preview', [retained]);
  assert.equal(fs.readFileSync(path.join(root, key + '.md'), 'utf8'), body, 'edits are durable without notes autosave');
  assert.equal(fs.statSync(path.join(root, key + '.md')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, key + '.json')).mode & 0o777, 0o600);
  await value('agent-prompt-attach-file', [retained, '/only-on-the-agent-host/source.ts', { mimeType: 'text/typescript' }]);
  const file = path.join(dir.dirs.notes, 'attach.md'); fs.writeFileSync(file, 'embedded file bytes\n');
  await value('agent-prompt-attach-file', [retained, file, { embed: true, mimeType: 'text/markdown' }]);
  await value('agent-prompt-attach-buffer', [retained, { uri: 'edwin-buffer:source', text: 'whole buffer', mimeType: 'text/plain' }]);
  await value('agent-prompt-attach-region', [retained, { uri: 'edwin-buffer:source?start=2&end=5', text: 'ole', mimeType: 'text/plain' }]);
  const exact = await value('agent-prompt-preview', [retained]);
  assert.deepEqual(exact.targets, ['alpha', 'beta']);
  assert.deepEqual(exact.blocks, [
    { type: 'text', text: body },
    { type: 'resource_link', uri: 'file:///only-on-the-agent-host/source.ts', name: 'source.ts', mimeType: 'text/typescript' },
    { type: 'resource', resource: { uri: new URL('file://' + file).href, text: 'embedded file bytes\n', mimeType: 'text/markdown' } },
    { type: 'resource', resource: { uri: 'edwin-buffer:source', text: 'whole buffer', mimeType: 'text/plain' } },
    { type: 'resource', resource: { uri: 'edwin-buffer:source?start=2&end=5', text: 'ole', mimeType: 'text/plain' } },
  ]);
  assert.equal(await value('agent-prompt-save', [retained, 'review carefully']), 'review carefully');
  assert.ok((await value('agent-prompt-list')).includes('review carefully'));
  const reused = await value('agent-prompt-load', ['review carefully', ['alpha']]);
  assert.deepEqual((await value('agent-prompt-preview', [reused])).blocks, exact.blocks);
  assert.equal((await client.request({ t: 'save', buf: retained })).error, undefined, 'scoped draft save bypasses no general writable root');
  await value('agent-prompt-abandon', [retained]); await value('kill-buffer', [retained]);
  await value('agent-prompt-open', [retained]); assert.deepEqual(await value('agent-prompt-preview', [retained]), exact);
  client.close(); await stopEdwind(child); child = await startEdwind(dir); client = await connect();
  assert.deepEqual(await value('agent-prompt-preview', [retained]), exact, 'restart retains resources and text');
  assert.deepEqual((await value('agent-prompt-preview', [await value('agent-prompt-load', ['review carefully'])])).blocks, exact.blocks);
  const link = path.join(dir.dirs.notes, 'secret-link'); fs.symlinkSync(tokenFile, link);
  const refused = await client.call('agent-prompt-attach-file', [retained, link, { embed: true }]); assert.ok(refused.error); assert.ok(!JSON.stringify(refused).includes(hub.token));
});

test('multi-send snapshots exact blocks, removes successful targets before partial failure, and never retries an ambiguous mutation', async () => {
  const retained = await value('agent-prompt-create', [{ targets: ['alpha', 'beta'], blocks: [{ type: 'text', text: 'review a resource' }, { type: 'resource_link', uri: 'file:///remote/source', name: 'source' }] }]);
  const exact = await value('agent-prompt-preview', [retained]);
  const original = hub.handle.bind(hub); let refuseBeta = true, lostReply = false;
  hub.handle = async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/sessions/beta/prompt' && (refuseBeta || lostReply)) {
      let text = ''; for await (const chunk of req) text += chunk;
      hub.calls.push({ method: req.method, path: req.url, body: JSON.parse(text) });
      if (lostReply) { res.destroy(); return; }
      res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'busy', code: 'busy' })); return;
    }
    await original(req, res);
  };
  try {
    const before = hub.calls.length, failed = await client.call('agent-prompt-send', [retained]);
    assert.match(failed.error.report, /busy/);
    assert.deepEqual((await value('agent-prompt-preview', [retained])).targets, ['beta']);
    const sends = hub.calls.slice(before).filter(c => c.path.endsWith('/prompt'));
    assert.equal(sends.length, 2); for (const send of sends) assert.deepEqual(send.body!.blocks, exact.blocks);
    assert.equal(sends.filter(c => c.path.includes('/alpha/')).length, 1);
    client.close(); await stopEdwind(child); child = await startEdwind(dir); client = await connect();
    assert.deepEqual((await value('agent-prompt-preview', [retained])).targets, ['beta'], 'partial success is durable across restart');
    refuseBeta = false;
    const sent = await value('agent-prompt-send', [retained]); assert.deepEqual(sent.sent, ['beta']);
    assert.deepEqual((await value('agent-prompt-preview', [retained])).targets, []);
    assert.equal(hub.calls.slice(before).filter(c => c.path === '/v1/sessions/alpha/prompt').length, 1, 'successful alpha was not resent');
    const ambiguous = await value('agent-prompt-create', [{ sid: 'beta', text: 'may already have acted' }]); lostReply = true;
    const mark = hub.calls.length, result = await client.call('agent-prompt-send', [ambiguous]); assert.ok(result.error);
    assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 1);
    assert.deepEqual((await value('agent-prompt-preview', [ambiguous])).targets, ['beta']);
  } finally { hub.handle = original; }
});

test('recall preserves every immutable content block and named resources without editing the journal', async () => {
  const blocks = [{ type: 'text', text: 'first' }, { type: 'resource_link', uri: 'file:///remote/source', name: 'source' }, { type: 'text', text: 'second' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }];
  const prompt = hub.append('alpha', { e: 'prompt', prompt: blocks });
  const before = JSON.stringify(hub.journals.get('alpha'));
  const id = await value('agent-session-recall', ['alpha', prompt.seq]);
  assert.deepEqual((await value('agent-prompt-preview', [id])).blocks, blocks);
  await value('agent-prompt-save', [id, 'immutable recall']);
  const loaded = await value('agent-prompt-load', ['immutable recall', ['beta']]);
  assert.deepEqual((await value('agent-prompt-preview', [loaded])).blocks, blocks);
  assert.equal(JSON.stringify(hub.journals.get('alpha')), before, 'recall and reuse do not rewrite earlier prompts');
});
test('source buffer and Visual region attach to a draft elsewhere, without pasting text', async () => {
  await frame();
  const id = await value('agent-prompt-create', [{ sid: 'alpha', text: 'please review' }]);
  const b = Ed.getBufferCreate('*Attachment source*'); b.text = 'source region text'; b.pt = 12; b.mark = 7; b.visual = 'char'; b.evilState = 'visual'; show(b);
  await L.call('agent-prompt-attach-buffer', [b.name, id]);
  await L.call('agent-prompt-attach-region', [id]);
  const preview = await value('agent-prompt-preview', [id]);
  assert.equal(preview.blocks[0].text, 'please review');
  assert.equal(preview.blocks[1].resource.text, 'source region text'); assert.equal(preview.blocks[2].resource.text, 'region');
  assert.equal(E.current, b, 'attachment command does not steal its source');
});

test('advertised prompt capabilities refuse unsupported resources without making a prompt mutation', async () => {
  const summary = hub.sessions.get('alpha')!;
  summary.acp.promptCapabilities = { embeddedContext: false, image: false, audio: false };
  const id = await value('agent-prompt-create', [{ sid: 'alpha', blocks: [{ type: 'text', text: 'read' }, { type: 'resource', resource: { uri: 'edwin-buffer:fixture', text: 'content', mimeType: 'text/plain' } }] }]);
  const mark = hub.calls.length, reply = await client.call('agent-prompt-send', [id]);
  assert.match(reply.error.report, /embeddedContext/);
  assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 0);
  assert.deepEqual((await value('agent-prompt-preview', [id])).targets, ['alpha']);
  delete summary.acp.promptCapabilities;
});

test('a failed draft-file write cannot let kill discard acknowledged journal edits', async () => {
  const id = await value('agent-prompt-create', [{ sid: 'alpha', text: 'before' }]), opened = await client.open(id);
  const key = /: ([A-Za-z0-9_-]+)\*$/.exec(id)![1], file = path.join(dir.dirs.state, 'agent-prompts', key + '.md');
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.equal((await client.edit(id, opened.ver!, [[6, '', ' acknowledged']])).t, 'ack');
  const killed = await client.call('kill-buffer', [id]); assert.equal(killed.t, 'error');
  assert.ok((await client.open(id)).text!.includes('acknowledged'));
  fs.rmdirSync(file); fs.writeFileSync(file, '');
  client.close(); await stopEdwind(child, 'SIGKILL'); child = await startEdwind(dir); client = await connect();
  assert.equal((await value('agent-prompt-preview', [id])).blocks[0].text, 'before acknowledged');
});

test('optional enumerated elicitation fields may be skipped rather than silently supplied', async () => {
  await frame();
  const request = hub.append('beta', { e: 'elicitation', request: { message: 'Optional choices', requestedSchema: { type: 'object', properties: { color: { type: 'string', enum: ['red', 'blue'] } } } } });
  await pending('beta', request.seq); await keys('C-c a !'); await mini('accept'); await mini('Skip field');
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/elicitation')).at(-1)!.body!.response, { action: 'accept', content: {} });
});
