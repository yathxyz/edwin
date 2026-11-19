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
const target = (sid: string) => ({ sid, epoch: hub.sessions.get(sid)!.createdAt as number });
async function pending(sid: string, req: number, total = 1) {
  const start = Date.now();
  for (;;) {
    const rows = await value('agent-session-pending') as Msg[];
    if (rows.length === total && rows.some(row => row.sid === sid && row.req === req)) return;
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
function rejectingPicker(command: string, args: unknown[] = []) {
  const completion = Promise.withResolvers<unknown>(), rejected = assert.rejects(completion.promise, /session.*replaced/i);
  L.CMD('agent-review-picker', '', '', 'Run a parameterized picker through the actual editor command loop.', async () => {
    try { const result = await L.call(command, args); completion.resolve(result); return result; }
    catch (e) { completion.reject(e); throw e; }
  });
  Ed.feedKey('<cmd:agent-review-picker>');
  return rejected;
}

before(async () => {
  hub = await new FakeAgentHub().start(); hub.add('alpha'); hub.add('beta');
  dir = makeDir({ writablePaths: [] }); tokenFile = path.join(dir.root, 'agent-token');
  fs.writeFileSync(tokenFile, hub.token + '\n', { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile, steer: true }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  child = await startEdwind(dir); client = await connect();
});
after(async () => {
  if (Ed) Ed.sync.shutdown(); if (client) client.close(); if (child) await stopEdwind(child); if (hub) await hub.stop();
  if (dir) fs.rmSync(dir.root, { recursive: true, force: true });
});

test('basic Markdown draft retains edited text after abandon, buffer kill and daemon restart', async () => {
  const id = await value('agent-prompt-create', [target('alpha')]), opened = await client.open(id);
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
  await L.call('agent-prompt-compose', ['alpha']); const draft = E.current;
  assert.equal(draft.mode, 'markdown-mode'); assert.equal(Ed.localValue(draft, 'agent-prompt-enabled'), true);
  Ed.insertText(draft, 'local edits before preview\n');
  await keys('C-c C-p');
  const preview = JSON.parse(Ed.getBuffer('*Agent Prompt Preview*').text); assert.equal(preview.blocks[0].text, 'local edits before preview\n');
  show(draft); await keys('C-c C-c');
  const call = hub.calls.filter(c => c.path === '/v1/sessions/alpha/prompt').at(-1)!;
  assert.deepEqual(call.body, { epoch: preview.targets[0].epoch, blocks: preview.blocks });
  await L.call('agent-prompt-compose', ['alpha']); const abandoned = E.current; Ed.insertText(abandoned, 'retained unsent');
  const mark = hub.calls.length; await keys('C-c C-k');
  assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 0);
  assert.equal((await value('agent-prompt-preview', [abandoned.id])).blocks[0].text, 'retained unsent');
});


test('permission can be answered globally from another buffer and stale/competing outcomes remain errors', async () => {
  await frame();
  const summary = hub.sessions.get('alpha')!;
  const toolCall = { toolCallId: 'read-source', title: 'Read source', kind: 'read', rawInput: { path: '/project/source.ts', limit: 200 } };
  const request = hub.append('alpha', { e: 'permission', toolCall, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject once', kind: 'reject_once' }] });
  await pending('alpha', request.seq);
  show(Ed.getBufferCreate('*Other work*')); const other = E.current;
  await until(() => Ed.getBuffer('*Messages*').text.includes('Read source'), 'permission announcement');
  await keys('C-c a !');
  const details = Ed.getBuffer('*Agent Permission Request*'), shown = JSON.parse(details.text);
  assert.equal(details.readOnly, true); assert.equal(shown.sid, 'alpha'); assert.equal(shown.createdAt, summary.createdAt); assert.equal(shown.req, request.seq);
  assert.deepEqual(shown.request.toolCall, toolCall); assert.deepEqual(shown.request.options, request.options);
  assert.ok(E.mini, 'permission details are displayed before the option minibuffer is answered');
  await mini('once: Allow once');
  const answer = hub.calls.filter(c => c.path.endsWith('/permission')).at(-1)!;
  assert.deepEqual(answer.body, { req: request.seq, epoch: summary.createdAt, outcome: { outcome: 'selected', optionId: 'once' } });
  assert.equal(E.current, other);
  const captured = { ...answer.body, requestKey: shown.request.requestKey };
  const again = await client.call('agent-session-permission', ['alpha', captured]); assert.match(again.error.report, /already|resolved|answered/i);
  const stale = await client.call('agent-session-permission', ['alpha', { ...captured, epoch: summary.createdAt - 1 }]); assert.match(stale.error.report, /stale/i);
  const cancel = hub.append('alpha', { e: 'permission', toolCall: { title: 'Another read' }, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }] });
  await pending('alpha', cancel.seq);
  await keys('C-c a !'); await mini('Cancel request');
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/permission')).at(-1)!.body!.outcome, { outcome: 'cancelled' });
});

test('permission picker cannot rebind the same SID and request number to a replacement session', async () => {
  await frame();
  const sid = 'permission-picker-race', alternate = 'permission-picker-other', old = hub.add(sid), other = hub.add(alternate);
  const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }];
  const request = hub.append(sid, { e: 'permission', toolCall: { title: 'Original input', rawInput: { path: '/old' } }, options });
  hub.append(alternate, { e: 'permission', toolCall: { title: 'Unrelated request' }, options });
  await pending(sid, request.seq, 2);
  show(Ed.getBufferCreate('*Permission picker elsewhere*'));
  const rejected = rejectingPicker('agent-session-answer');
  await until(() => E.mini?.prompt === 'Pending request: ', 'pending request picker');
  const mark = hub.calls.length, replacement = hub.add(sid);
  replacement.createdAt = Math.max(replacement.createdAt, old.createdAt + 1); hub.emit('session', replacement);
  hub.append(sid, { e: 'permission', seq: request.seq, toolCall: { title: 'Different input', rawInput: { path: '/new' } }, options });
  await mini(`${sid} #${request.seq} permission: Original input`); await rejected;
  assert.equal(hub.calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith('/permission')).length, 0);
  assert.equal(hub.sessions.get(sid)!.acp.pending[0].req, request.seq, 'replacement request remains unanswered');
  for (const [id, epoch] of [[sid, replacement.createdAt], [alternate, other.createdAt]] as const) {
    hub.sessions.delete(id); hub.emit('gone', { sid: id, epoch });
  }
});

test('form elicitation preserves primitive types and arrays; decline/cancel and URL origin are explicit, never auto-opened', async () => {
  await frame();
  const schema = { type: 'object', required: ['name', 'count', 'allowed', 'tags'], properties: { name: { type: 'string' }, count: { type: 'number' }, allowed: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } } };
  const request = hub.append('beta', { e: 'elicitation', request: { message: 'Supply form', requestedSchema: schema } });
  await pending('beta', request.seq);
  await keys('C-c a !');
  for (const input of ['accept', 'Alice', '2.5', 'true', '["one","two"]']) await mini(input);
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/elicitation')).at(-1)!.body, { epoch: target('beta').epoch, req: request.seq, response: { action: 'accept', content: { name: 'Alice', count: 2.5, allowed: true, tags: ['one', 'two'] } } });
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
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/mode')).at(-1)!.body, { epoch: target('alpha').epoch, modeId: 'auto' });
  await L.call('agent-session-config', ['model', 'large', 'alpha']);
  assert.deepEqual(hub.calls.filter(c => c.path.endsWith('/config')).at(-1)!.body, { epoch: target('alpha').epoch, id: 'model', value: 'large' });
  hub.configSupported = false;
  try { await assert.rejects(L.call('agent-session-config', ['model', 'small', 'alpha']), /unsupported|does not support/i); }
  finally { hub.configSupported = true; }
});

test('mode and config choices carry the incarnation whose offered options were displayed', async () => {
  await frame();
  const modes = { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Automatic' }] }, configOptions = [{ id: 'model', name: 'Model', currentValue: 'small', options: [{ value: 'small' }, { value: 'large' }] }];
  for (const action of ['mode', 'config']) {
    const sid = `options-${action}-race`, old = hub.add(sid, [{ seq: 1, e: 'session', modes, configOptions }]);
    show(Ed.getBufferCreate('*Option selection elsewhere*'));
    const rejected = rejectingPicker(`agent-session-${action}`, action === 'mode' ? [undefined, sid] : ['model', undefined, sid]);
    await until(() => E.mini?.prompt === (action === 'mode' ? 'Mode: ' : 'Model: '), 'offered steering value picker');
    const mark = hub.calls.length, replacement = hub.add(sid, [{ seq: 1, e: 'session', modes, configOptions }]);
    replacement.createdAt = Math.max(replacement.createdAt, old.createdAt + 1); hub.emit('session', replacement);
    await mini(action === 'mode' ? 'auto: Automatic' : 'large'); await rejected;
    assert.equal(hub.calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith(`/${action}`)).length, 0);
  }
});

test('quick, compose, named reuse and explicit retarget keep the incarnation selected before a frame picker resumes', async () => {
  await frame();
  const named = await value('agent-prompt-create', [{ text: 'named picker content' }]);
  await value('agent-prompt-save', [named, 'picker identity fixture']);
  for (const action of ['quick', 'compose', 'named', 'targets']) {
    const sid = `frame-${action}-race`, old = hub.add(sid), draft = action === 'targets' ? await value('agent-prompt-create', [{ text: 'retarget content' }]) : null;
    show(Ed.getBufferCreate('*Prompt picker elsewhere*'));
    const rejected = action === 'quick' ? rejectingPicker('agent-session-quick-prompt', [undefined, sid]) : action === 'compose' ? rejectingPicker('agent-prompt-compose') : action === 'named' ? rejectingPicker('agent-prompt-load', ['picker identity fixture']) : rejectingPicker('agent-prompt-targets', [undefined, draft]);
    const prompt = action === 'quick' ? `Prompt ${sid}: ` : action === 'targets' ? 'Targets (comma separated): ' : 'Agent session: ';
    await until(() => E.mini?.prompt === prompt, 'incarnation-bearing prompt picker');
    const choice = action === 'quick' ? 'retained quick text' : action === 'targets' ? `${sid}@${old.createdAt}` : `${sid} (${old.createdAt})`;
    if (action !== 'quick') assert.ok(E.mini.completer('').includes(choice), 'completion shows the captured incarnation');
    const mark = hub.calls.length, replacement = hub.add(sid);
    replacement.createdAt = Math.max(replacement.createdAt, old.createdAt + 1); hub.emit('session', replacement);
    await mini(choice); await rejected;
    assert.equal(hub.calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith('/prompt')).length, 0);
    if (draft) assert.deepEqual((await value('agent-prompt-preview', [draft])).targets, []);
  }
});

test('a quick prompt from displayed transcript metadata cannot silently bind to a fresh session with the same SID', async () => {
  await frame();
  const sid = 'displayed-prompt-race', old = hub.add(sid), b = await Ed.agentSessions.open(sid), epoch = b.meta.locals.agentSession.epoch;
  assert.equal(epoch, old.createdAt); show(b);
  const replacement = { ...old, createdAt: old.createdAt + 1, acp: { ...old.acp, pending: [] } };
  hub.sessions.set(sid, replacement);
  try {
    const mark = hub.calls.length;
    await assert.rejects(L.call('agent-session-quick-prompt', ['keep displayed identity']), /session.*replaced/i);
    assert.equal(hub.calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith('/prompt')).length, 0);
  } finally { hub.emit('session', replacement); show(Ed.getBufferCreate('*Prompt picker elsewhere*')); }
});

test('exact blocks, private per-edit persistence, attachments, named reuse, kill/reopen and daemon restart', async () => {
  const destinations = [target('alpha'), target('beta')], retained = await value('agent-prompt-create', [{ targets: destinations }]);
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
  assert.deepEqual(exact.targets, destinations);
  assert.deepEqual(exact.blocks, [
    { type: 'text', text: body },
    { type: 'resource_link', uri: 'file:///only-on-the-agent-host/source.ts', name: 'source.ts', mimeType: 'text/typescript' },
    { type: 'resource', resource: { uri: new URL('file://' + file).href, text: 'embedded file bytes\n', mimeType: 'text/markdown' } },
    { type: 'resource', resource: { uri: 'edwin-buffer:source', text: 'whole buffer', mimeType: 'text/plain' } },
    { type: 'resource', resource: { uri: 'edwin-buffer:source?start=2&end=5', text: 'ole', mimeType: 'text/plain' } },
  ]);
  assert.equal(await value('agent-prompt-save', [retained, 'review carefully']), 'review carefully');
  assert.ok((await value('agent-prompt-list')).includes('review carefully'));
  const reused = await value('agent-prompt-load', ['review carefully', [target('alpha')]]);
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
  const alpha = target('alpha'), beta = target('beta'), retained = await value('agent-prompt-create', [{ targets: [alpha, beta], blocks: [{ type: 'text', text: 'review a resource' }, { type: 'resource_link', uri: 'file:///remote/source', name: 'source' }] }]);
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
    assert.deepEqual((await value('agent-prompt-preview', [retained])).targets, [beta]);
    const sends = hub.calls.slice(before).filter(c => c.path.endsWith('/prompt'));
    assert.equal(sends.length, 2); for (const send of sends) assert.deepEqual(send.body!.blocks, exact.blocks);
    assert.equal(sends.filter(c => c.path.includes('/alpha/')).length, 1);
    client.close(); await stopEdwind(child); child = await startEdwind(dir); client = await connect();
    assert.deepEqual((await value('agent-prompt-preview', [retained])).targets, [beta], 'partial success is durable across restart');
    const repeated = await client.call('agent-prompt-targets', [retained, [alpha, beta]]);
    assert.match(repeated.error?.report || '', /already acknowledged/i, 'positive receipt survives restart and explicit retarget');
    refuseBeta = false;
    const sent = await value('agent-prompt-send', [retained]); assert.deepEqual(sent.sent, ['beta']);
    assert.deepEqual((await value('agent-prompt-preview', [retained])).targets, []);
    assert.equal(hub.calls.slice(before).filter(c => c.path === '/v1/sessions/alpha/prompt').length, 1, 'successful alpha was not resent');
    const ambiguous = await value('agent-prompt-create', [{ ...beta, text: 'may already have acted' }]); lostReply = true;
    const mark = hub.calls.length, result = await client.call('agent-prompt-send', [ambiguous]); assert.ok(result.error);
    assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 1);
    assert.match(result.error.report, /possibly sent/i);
    const preview = await value('agent-prompt-preview', [ambiguous]);
    assert.deepEqual(preview.targets, []); assert.deepEqual(preview.possiblySent, [beta]);
    assert.match((await client.call('agent-prompt-send', [ambiguous])).error?.report || '', /possibly sent/i);
    assert.match((await client.call('agent-prompt-targets', [ambiguous, [beta]])).error?.report || '', /possibly sent/i);
    assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 1);
  } finally { hub.handle = original; }
});

test('an oversized serialized prompt retains its destination and can be shortened and sent', async () => {
  // The source fits in 1 MiB, but its JSON escapes do not.
  const body = ('"'.repeat(63) + '\n').repeat(8192), alpha = target('alpha');
  const id = await value('agent-prompt-create', [{ ...alpha, text: body }]), mark = hub.calls.length;
  const refused = await client.call('agent-prompt-send', [id]);
  assert.match(refused.error?.report || '', /1 MiB/);
  const preview = await value('agent-prompt-preview', [id]);
  assert.deepEqual(preview.targets, [alpha]); assert.deepEqual(preview.possiblySent, []);
  assert.equal(hub.calls.slice(mark).filter(c => c.method === 'POST').length, 0);
  const opened = await client.open(id);
  assert.equal((await client.edit(id, opened.ver!, [[0, body, 'shorter prompt']])).t, 'ack');
  assert.deepEqual((await value('agent-prompt-send', [id])).sent, ['alpha']);
  assert.deepEqual(hub.calls.slice(mark).filter(c => c.method === 'POST').map(c => c.body),
    [{ epoch: alpha.epoch, blocks: [{ type: 'text', text: 'shorter prompt' }] }]);
});

test('an oversized file cannot be embedded into a draft', async () => {
  const file = path.join(dir.dirs.notes, 'large-attachment.txt'), id = await value('agent-prompt-create', [{ text: 'small' }]);
  fs.writeFileSync(file, ''); fs.truncateSync(file, 1024 * 1024 + 1);
  const refused = await client.call('agent-prompt-attach-file', [id, file, { embed: true, mimeType: 'application/octet-stream' }]);
  assert.match(refused.error?.report || '', /limit|too large/i);
  assert.deepEqual((await value('agent-prompt-preview', [id])).blocks, [{ type: 'text', text: 'small' }]);
});

test('direct prompt retries cannot repeat an acknowledged or ambiguous submission after a crash', async () => {
  const sid = 'direct-receipts', epoch = hub.add(sid).createdAt, text = 'deliberately repeatable text';
  const send = (submissionId: string, body = text) => client.call('agent-session-prompt', [sid, { epoch, text: body, submissionId }]);
  const route = `/v1/sessions/${sid}/prompt`, posts = () => hub.calls.filter(c => c.method === 'POST' && c.path === route);
  const original = hub.handle.bind(hub); let outcome: 'normal' | 'lost' | 'busy' = 'normal';
  hub.handle = async (req, res) => {
    if (req.method !== 'POST' || req.url !== route || outcome === 'normal') return original(req, res);
    let raw = ''; for await (const chunk of req) raw += chunk;
    hub.calls.push({ method: req.method, path: req.url, body: JSON.parse(raw) });
    if (outcome === 'lost') { res.destroy(); return; }
    res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'busy' }));
  };
  try {
    assert.equal((await send('first-click')).error, undefined);
    outcome = 'lost'; assert.ok((await send('second-click')).error);
    assert.equal(posts().length, 2);
    client.close(); await stopEdwind(child, 'SIGKILL'); child = await startEdwind(dir); client = await connect();
    outcome = 'normal';
    const ack = await send('first-click'), uncertain = await send('second-click');
    assert.equal(posts().length, 2, 'neither a positive nor an ambiguous receipt can be replayed after restart');
    assert.match(ack.error?.report || '', /already acknowledged/i);
    assert.match(uncertain.error?.report || '', /possibly sent/i);
    outcome = 'busy'; assert.match((await send('third-click')).error?.report || '', /busy/);
    assert.ok((await send('third-click', 'changed text')).error);
    assert.equal(posts().length, 3, 'a retry id cannot be rebound to other content');
    outcome = 'normal'; assert.equal((await send('third-click')).error, undefined);
    assert.equal(posts().length, 4, 'a definite refusal is retryable with its original identity');
    for (const post of posts()) assert.deepEqual(post.body, { text, epoch }, 'only hub-defined fields leave edwind');
  } finally { hub.handle = original; }
});

test('direct prompt submission requires a caller-retained id and a writable intent store before POST', async () => {
  const sid = 'direct-intent', epoch = hub.add(sid).createdAt, text = 'retain this logical send', mark = hub.calls.length;
  const missing = await client.call('agent-session-prompt', [sid, { epoch, text }]);
  assert.match(missing.error?.report || '', /submissionId/);
  const root = path.join(dir.dirs.state, 'agent-prompts');
  fs.renameSync(root, root + '.saved'); fs.mkdirSync(root);
  try {
    const failed = await client.call('agent-session-prompt', [sid, { epoch, text, submissionId: 'cannot-record' }]);
    assert.ok(failed.error);
    assert.equal(hub.calls.slice(mark).filter(c => c.method === 'POST').length, 0);
  } finally { fs.rmdirSync(root); fs.renameSync(root + '.saved', root); }
});

test('a durable send intent is required before any prompt POST', async () => {
  const alpha = target('alpha'), id = await value('agent-prompt-create', [{ ...alpha, text: 'no intent, no send' }]);
  const key = /: ([A-Za-z0-9_-]+)\*$/.exec(id)![1], file = path.join(dir.dirs.state, 'agent-prompts', key + '.json');
  fs.renameSync(file, file + '.saved'); fs.mkdirSync(file);
  const mark = hub.calls.length;
  try {
    const failed = await client.call('agent-prompt-send', [id]);
    assert.ok(failed.error);
    assert.equal(hub.calls.slice(mark).filter(c => c.method === 'POST').length, 0, 'no mutation if its prior state cannot be recorded');
    assert.deepEqual((await value('agent-prompt-preview', [id])).targets, [alpha]);
  } finally { fs.rmdirSync(file); fs.renameSync(file + '.saved', file); }
});

test('an acknowledged prompt stays excluded after receipt persistence fails and the daemon crashes before saving', async () => {
  const alpha = target('alpha'), beta = target('beta'), blocks = [{ type: 'text', text: 'keep the text and resource' }, { type: 'resource_link', uri: 'file:///remote/kept', name: 'kept' }];
  const id = await value('agent-prompt-create', [{ targets: [alpha, beta], blocks }]);
  const key = /: ([A-Za-z0-9_-]+)\*$/.exec(id)![1], file = path.join(dir.dirs.state, 'agent-prompts', key + '.json');
  const original = hub.handle.bind(hub);
  hub.handle = async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/sessions/alpha/prompt') {
      // Preserve exactly the durable state at dispatch, then make only the post-reply receipt write fail.
      fs.renameSync(file, file + '.saved'); fs.mkdirSync(file);
    }
    await original(req, res);
  };
  const mark = hub.calls.length;
  try {
    const failed = await client.call('agent-prompt-send', [id]);
    assert.match(failed.error.report, /acknowledged by alpha.*durable send receipt failed/i);
    assert.match(failed.error.report, /Sent: alpha; retained for retry: beta/);
    assert.doesNotMatch(failed.error.report, /lost reply/i);
    assert.deepEqual((await value('agent-prompt-preview', [id])).targets, [beta]);
    assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 1);
    assert.match((await client.call('agent-prompt-targets', [id, [alpha]])).error?.report || '', /already acknowledged/i);
  } finally {
    hub.handle = original;
    if (fs.existsSync(file + '.saved')) { fs.rmdirSync(file); fs.renameSync(file + '.saved', file); }
  }
  client.close(); await stopEdwind(child, 'SIGKILL'); child = await startEdwind(dir); client = await connect();
  const recovered = await value('agent-prompt-preview', [id]);
  assert.deepEqual(recovered.targets, [beta]); assert.deepEqual(recovered.possiblySent, [alpha]);
  assert.equal((await client.request({ t: 'save', buf: id })).error, undefined);
  await value('agent-prompt-save', [id, 'receipt failure keeps blocks']);
  await value('agent-prompt-abandon', [id]); await value('kill-buffer', [id]); await value('agent-prompt-open', [id]);
  const retarget = await client.call('agent-prompt-targets', [id, [alpha, beta]]);
  assert.match(retarget.error?.report || '', /possibly sent/i);
  const preview = await value('agent-prompt-preview', [id]);
  assert.deepEqual(preview.targets, [beta]); assert.deepEqual(preview.blocks, blocks);
  const sent = await value('agent-prompt-send', [id]); assert.deepEqual(sent.sent, ['beta']);
  const sends = hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt'));
  assert.equal(sends.filter(c => c.path.includes('/alpha/')).length, 1);
  assert.equal(sends.filter(c => c.path.includes('/beta/')).length, 1);
  for (const send of sends) assert.deepEqual(send.body!.blocks, blocks);
  assert.match((await client.call('agent-prompt-targets', [id, [alpha]])).error?.report || '', /possibly sent/i);
});

test('a durable acknowledgement survives sudden restart and bars only its exact draft and incarnation', async () => {
  const sid = 'receipt-identity', old = hub.add(sid), seen = target(sid), id = await value('agent-prompt-create', [{ ...seen, text: 'once at this epoch' }]);
  const mark = hub.calls.length;
  assert.deepEqual((await value('agent-prompt-send', [id])).sent, [sid]);
  client.close(); await stopEdwind(child, 'SIGKILL'); child = await startEdwind(dir); client = await connect();
  assert.deepEqual((await value('agent-prompt-preview', [id])).targets, []);
  assert.match((await client.call('agent-prompt-targets', [id, [seen]])).error?.report || '', /already acknowledged/i);
  assert.ok((await client.call('agent-prompt-send', [id])).error);
  assert.equal(hub.calls.slice(mark).filter(c => c.path === `/v1/sessions/${sid}/prompt`).length, 1);
  const fresh = await value('agent-prompt-create', [{ ...seen, text: 'distinct draft' }]);
  assert.deepEqual((await value('agent-prompt-send', [fresh])).sent, [sid]);
  const replacement = hub.add(sid); replacement.createdAt = Math.max(replacement.createdAt, old.createdAt + 1); hub.emit('session', replacement);
  assert.deepEqual(await value('agent-prompt-targets', [id, [target(sid)]]), [target(sid)]);
  assert.deepEqual((await value('agent-prompt-send', [id])).sent, [sid]);
});

test('restart preserves captured destinations and migrates legacy SID-only drafts to unbound until explicit retarget', async () => {
  const sid = 'retained-prompt-epoch', old = hub.add(sid), captured = target(sid);
  const blocks = [{ type: 'text', text: 'retained incarnation-bound text' }, { type: 'resource_link', uri: 'file:///remote/incarnation', name: 'resource' }];
  const bound = await value('agent-prompt-create', [{ ...captured, blocks }]), legacy = await value('agent-prompt-create', [{ ...captured, blocks }]);
  client.close(); await stopEdwind(child);
  const key = /: ([A-Za-z0-9_-]+)\*$/.exec(legacy)![1], file = path.join(dir.dirs.state, 'agent-prompts', key + '.json'), record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.targets = [sid]; fs.writeFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  const replacement = hub.add(sid); replacement.createdAt = Math.max(replacement.createdAt, old.createdAt + 1); hub.emit('session', replacement);
  const selected = target(sid);
  child = await startEdwind(dir); client = await connect();
  const mark = hub.calls.length, stale = await client.call('agent-prompt-send', [bound]), unbound = await client.call('agent-prompt-send', [legacy]);
  assert.match(stale.error.report, /session.*replaced/i); assert.match(unbound.error.report, /unbound.*explicitly retarget/i);
  assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 0);
  assert.deepEqual((await value('agent-prompt-preview', [bound])).targets, [captured]);
  assert.deepEqual((await value('agent-prompt-preview', [legacy])).targets, [{ sid, epoch: null }]);
  for (const id of [bound, legacy]) {
    assert.deepEqual((await value('agent-prompt-preview', [id])).blocks, blocks);
    await value('agent-prompt-targets', [id, [selected]]);
    assert.deepEqual((await value('agent-prompt-send', [id])).sent, [sid]);
  }
  const sends = hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt'));
  assert.equal(sends.length, 2); for (const send of sends) assert.deepEqual(send.body!.blocks, blocks);
});

test('prompt send rechecks the captured incarnation after capability validation and immediately before POST', async () => {
  const sid = 'prompt-prepost-race', old = hub.add(sid), captured = target(sid), id = await value('agent-prompt-create', [{ ...captured, text: 'never send to its replacement' }]);
  const original = hub.handle.bind(hub); let reads = 0;
  hub.handle = async (req, res) => {
    if (req.method === 'GET' && req.url === `/v1/sessions/${sid}` && ++reads === 1) {
      await original(req, res);
      const replacement = hub.add(sid); replacement.createdAt = Math.max(replacement.createdAt, old.createdAt + 1); hub.emit('session', replacement); return;
    }
    await original(req, res);
  };
  try {
    const mark = hub.calls.length, failed = await client.call('agent-prompt-send', [id]);
    assert.match(failed.error.report, /session.*replaced/i); assert.ok(reads >= 2);
    assert.equal(hub.calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith('/prompt')).length, 0);
    assert.deepEqual((await value('agent-prompt-preview', [id])).targets, [captured]);
  } finally { hub.handle = original; }
});

test('recall preserves every immutable content block and named resources without editing the journal', async () => {
  const blocks = [{ type: 'text', text: 'first' }, { type: 'resource_link', uri: 'file:///remote/source', name: 'source' }, { type: 'text', text: 'second' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }];
  const prompt = hub.append('alpha', { e: 'prompt', prompt: blocks });
  const before = JSON.stringify(hub.journals.get('alpha'));
  const captured = target('alpha'), id = await value('agent-session-recall', [captured.sid, prompt.seq, captured.epoch]);
  assert.deepEqual((await value('agent-prompt-preview', [id])).blocks, blocks);
  await value('agent-prompt-save', [id, 'immutable recall']);
  const loaded = await value('agent-prompt-load', ['immutable recall', [target('beta')]]);
  assert.deepEqual((await value('agent-prompt-preview', [loaded])).blocks, blocks);
  assert.equal(JSON.stringify(hub.journals.get('alpha')), before, 'recall and reuse do not rewrite earlier prompts');
});
test('source buffer and Visual region attach to a draft elsewhere, without pasting text', async () => {
  await frame();
  const id = await value('agent-prompt-create', [{ ...target('alpha'), text: 'please review' }]);
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
  const captured = target('alpha'), id = await value('agent-prompt-create', [{ ...captured, blocks: [{ type: 'text', text: 'read' }, { type: 'resource', resource: { uri: 'edwin-buffer:fixture', text: 'content', mimeType: 'text/plain' } }] }]);
  const mark = hub.calls.length, reply = await client.call('agent-prompt-send', [id]);
  assert.match(reply.error.report, /embeddedContext/);
  assert.equal(hub.calls.slice(mark).filter(c => c.path.endsWith('/prompt')).length, 0);
  assert.deepEqual((await value('agent-prompt-preview', [id])).targets, [captured]);
  delete summary.acp.promptCapabilities;
});

test('a failed draft-file write cannot let kill discard acknowledged journal edits', async () => {
  const id = await value('agent-prompt-create', [{ ...target('alpha'), text: 'before' }]), opened = await client.open(id);
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

test('AS-C10: host RPC addresses a transcript without selecting it: folds, structural prompts, recall, quick text and steering', async () => {
  await frame();
  const sid = 'phone-controls', text = '# Inside the prompt\n```\n## Prompt #999\n```\nKeep this immutable';
  hub.add(sid, [
    { seq: 1, e: 'prompt', prompt: [{ type: 'text', text }] },
    { seq: 2, e: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought body\n' } } },
    { seq: 3, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'phone-tool', title: 'Read source', status: 'completed', rawOutput: 'retained output\n' } },
    { seq: 4, e: 'prompt', prompt: [{ type: 'text', text: 'second prompt' }] },
  ]);
  const rpc = Ed.agentSessions.rpc, id = await rpc('agent-session-open', [sid]), b = await Ed.sync.open(id);
  const epoch = b.meta.locals.agentSession.epoch, spans = b.meta.locals.agentSession.spans, first = spans[0], tool = spans[2], last = spans[3];
  show(Ed.getBufferCreate('*Phone host elsewhere*')); const other = E.current, point = other.pt;
  assert.equal(b.folds.length, 2);
  const toggled = await rpc('agent-session-toggle-fold', [id, tool.start]);
  assert.equal(toggled.bufferId, id); assert.equal(toggled.point, b.pt); assert.equal(toggled.folds.length, 1);
  assert.equal((await rpc('agent-session-open-folds', [id])).folds.length, 0);
  b.pt = first.foldStart + 1;
  const closed = await rpc('agent-session-close-folds', [id]);
  assert.equal(closed.folds.length, 4); assert.equal(closed.point, first.start);
  assert.equal((await rpc('agent-session-next-prompt', [id, first.start])).point, last.start);
  assert.equal((await rpc('agent-session-previous-prompt', [id, last.start])).point, first.start);
  await assert.rejects(rpc('agent-session-previous-prompt', [id, first.start]), /No previous prompt/);
  for (const pos of [-1, 1.5, b.rope.length + 1]) await assert.rejects(rpc('agent-session-toggle-fold', [id, pos]), /zero-based/);
  const recalled = await rpc('agent-session-recall', [sid, first.seq, epoch]);
  assert.deepEqual((await rpc('agent-prompt-preview', [recalled])).blocks, [{ type: 'text', text }]);
  const drafts = E.buffers.filter((x: Core) => x.meta?.locals?.agentPrompt).length;
  await rpc('agent-session-prompt', [sid, { text: 'Sent from an ordinary host text field', epoch, submissionId: 'phone-send-click' }]);
  await until(() => b.text.includes('Sent from an ordinary host text field'), 'host quick prompt replay');
  assert.equal(E.buffers.filter((x: Core) => x.meta?.locals?.agentPrompt).length, drafts, 'host text does not create a draft buffer');
  assert.deepEqual(hub.journals.get(sid)!.at(-1)!.prompt, [{ type: 'text', text: 'Sent from an ordinary host text field' }]);
  await rpc('agent-session-cancel', [sid, { epoch }]);
  await rpc('agent-session-mode', [sid, { modeId: 'auto', epoch }]);
  await rpc('agent-session-config', [sid, { id: 'model', value: 'large', epoch }]);
  await rpc('agent-session-revive', [sid, { epoch }]);
  await rpc('agent-session-remove', [sid, { epoch }]);
  assert.deepEqual(hub.calls.filter(c => c.method !== 'GET' && c.path.startsWith(`/v1/sessions/${sid}`)).map(c => [c.method, c.path.slice(`/v1/sessions/${sid}`.length), c.body]), [
    ['POST', '/prompt', { text: 'Sent from an ordinary host text field', epoch }], ['POST', '/cancel', { epoch }],
    ['POST', '/mode', { modeId: 'auto', epoch }], ['POST', '/config', { id: 'model', value: 'large', epoch }],
    ['POST', '/revive', { epoch }], ['DELETE', '?forget=true', { epoch }],
  ]);
  assert.equal(E.current, other); assert.equal(other.pt, point);
});

test('AS-C11: host state subscriptions expose offered requests and steering, reject stale answers, and unsubscribe', async () => {
  await frame();
  const sid = 'phone-state', modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Automatic' }] };
  const configOptions = [{ id: 'model', name: 'Model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] }];
  const summary = hub.add(sid, [{ seq: 1, e: 'session', modes, configOptions }]);
  const api = Ed.agentSessions, id = await api.rpc('agent-session-open', [sid]), b = await Ed.sync.open(id);
  const states: Core[] = [], off = api.onChange(b, (s: Core) => states.push(s));
  try {
    assert.equal(states.length, 1); assert.equal(states[0].state, 'idle'); assert.equal(states[0].steerable, true);
    assert.equal(states[0].epoch, summary.createdAt); assert.equal(states[0].modeId, 'ask');
    assert.deepEqual(states[0].modes, modes); assert.deepEqual(states[0].configOptions, configOptions);
    assert.deepEqual(await api.rpc('agent-session-state', [sid]), api.state(b));
    const version = b.sver, text = b.text;
    summary.state = 'running'; summary.updatedAt++; hub.emit('session', summary);
    await until(() => states.at(-1).state === 'running', 'summary-only state notification');
    assert.equal(b.sver, version); assert.equal(b.text, text);
    const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }];
    const req = hub.append(sid, { e: 'permission', toolCall: { title: 'Read on phone' }, options });
    await until(() => states.at(-1).pending[0]?.req === req.seq, 'phone permission');
    const shown = states.at(-1).pending[0];
    assert.deepEqual(shown.options, options); assert.equal(shown.epoch, summary.createdAt);
    const button = { req: shown.req, epoch: shown.epoch, requestKey: shown.requestKey };
    await api.rpc('agent-session-permission', [sid, { ...button, outcome: { outcome: 'selected', optionId: 'once' } }]);
    await until(() => !states.at(-1).pending.length, 'permission removed');
    await assert.rejects(api.rpc('agent-session-permission', [sid, { ...button, outcome: { outcome: 'cancelled' } }]), /already|resolved|pending/i);
    const request = { message: 'Phone form', requestedSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } };
    const elicitation = hub.append(sid, { e: 'elicitation', request });
    await until(() => states.at(-1).pending[0]?.req === elicitation.seq, 'phone elicitation');
    const form = states.at(-1).pending[0], formButton = { req: form.req, epoch: form.epoch, requestKey: form.requestKey };
    assert.deepEqual(form.request, request);
    await assert.rejects(api.rpc('agent-session-elicitation', [sid, { ...formButton, epoch: form.epoch - 1, response: { action: 'accept', content: { answer: 'obsolete' } } }]), /stale/i);
    await api.rpc('agent-session-elicitation', [sid, { ...formButton, response: { action: 'accept', content: { answer: 'phone answer' } } }]);
    await until(() => !states.at(-1).pending.length, 'elicitation removed');
    assert.deepEqual(hub.journals.get(sid)!.at(-1)!.response, { action: 'accept', content: { answer: 'phone answer' } });
    hub.append(sid, { e: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: 'auto' } });
    await until(() => states.at(-1).modeId === 'auto', 'mode notification');
    hub.append(sid, { e: 'update', update: { sessionUpdate: 'config_option_update', configOptions: [{ ...configOptions[0], currentValue: 'large' }] } });
    await until(() => states.at(-1).configOptions[0].currentValue === 'large', 'config notification');
    off(); const heard = states.length;
    summary.state = 'idle'; summary.updatedAt++; hub.emit('session', summary);
    await until(() => api.state(b).state === 'idle', 'unsubscribed metadata still updates');
    assert.equal(states.length, heard);
  } finally { off(); }
});
