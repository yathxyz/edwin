// AS-C1/C2/C8: real edwind and served model frame, with an authenticated loopback API.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeAgentHub } from './fake-agent-hub.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
import type { TestDir } from './edit-client.mts';
import { AgentSessions } from '../server/agent-sessions.mts';
import type { Server } from '../server/main.mts';
const require = createRequire(import.meta.url);
const { createHost, loadEdwin } = require('../src/host-node.cts');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => unknown) { for (let i = 0; i < 800; i++) { if (f()) return; await sleep(10); } throw new Error('Agent session state did not arrive'); }
async function untilText(c: EditClient, id: string, needle: string) {
  for (let i = 0; i < 800; i++) {
    const text = (await c.open(id)).text || '';
    if (text.includes(needle)) return text;
    await sleep(10);
  }
  throw new Error(`Buffer did not display ${needle}`);
}

test('AS-C1/C2: daemon-owned list is live in a served frame; waiting first, both registries, remote start and reconnect', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir();
  const tokenFile = path.join(dir.root, 'api-token'); fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const idle = hub.add('idle'), waiting = hub.add('waiting'); waiting.acp.pending = [{ req: 7, kind: 'permission', title: 'Run command' }];
  hub.append('idle', { e: 'session', configOptions: [{ id: 'chosen-model', category: 'model', currentValue: 'hub-model-A' }] });
  hub.observed.set('o_report', { id: 'o_report', host: 'remote', harness: 'codex', project: 'demo', state: 'running', model: 'model-A', title: 'Reported work', lastAt: 1, pending: null });
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  const host = createHost({ scmDir: path.resolve('scm'), configDir: dir.dirs.config });
  const Ed = loadEdwin(host);
  await Ed.bootServed({ host, transport: transport(dir.cfg.socket), device: 'agent-sessions-test' });
  t.after(async () => { Ed.sync.shutdown(); c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  const opened = await c.call('agent-sessions'); assert.equal(opened.value, 'name:*Agent Sessions*');
  const b = await Ed.sync.open(opened.value); Ed.setWindowBuffer(b); Ed.E.current = b;
  await until(() => b.meta?.locals?.agentList?.rows?.length === 3);
  assert.equal(b.meta.locals.agentList.rows[0].sid, 'waiting');
  assert.match(b.text, /model-A/); assert.match(b.text, /remote/); assert.match(b.text, /Reported work/);
  await until(() => b.meta.locals.agentList.rows.find((r: { sid: string }) => r.sid === 'idle')?.model === 'hub-model-A');
  hub.append('idle', { e: 'update', update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'chosen-model', category: 'model', currentValue: 'hub-model-B' }] } });
  await until(() => b.text.includes('hub-model-B'));
  const draws: unknown[] = [];
  const frame = Ed.makeFrame(null, { buffer: b, backend: { size: () => ({ cols: 120, rows: 20 }), draw: (m: unknown) => draws.push(m) } });
  Ed.display.redraw(frame); Ed.render(); assert.ok(JSON.stringify(draws).includes('Agent Sessions'));
  // Exercise actual command/key dispatch, rather than calling the UI helper only.
  b.pt = Ed.lineStartB(b, 3); Ed.feedKey('RET'); await Ed.whenIdle();
  await until(() => Ed.E.current.id === 'name:*Agent: waiting*');
  assert.equal(hub.calls.filter(c => c.method === 'POST').length, 0, 'viewing never starts an agent');
  const reported = await c.call('agent-session-open', ['o_report']); const report = await c.open(reported.value);
  assert.match(report.text!, /cannot steer/);
  const reportedState = (await c.call('agent-session-state', ['o_report'])).value;
  assert.equal(reportedState.bufferId, reported.value); assert.equal(reportedState.state, 'running'); assert.equal(reportedState.steerable, false);
  assert.deepEqual(report.meta!.locals.agentState, reportedState);
  assert.match((await c.call('agent-session-cancel', ['o_report', { epoch: reportedState.epoch }])).error.report, /read-only|cannot be steered/);
  const start = await c.call('agent-session-start', [{ agent: 'stub', host: 'remote', cwd: '/work/demo' }]);
  assert.match(start.value, /^name:\*Agent: api_/);
  assert.deepEqual(hub.calls.find(c => c.path === '/v1/sessions' && c.method === 'POST')!.body, { agent: 'stub', host: 'remote', cwd: '/work/demo' });
  idle.acp.title = 'New activity'; hub.emit('session', idle);
  await until(() => b.text.includes('New activity'));
  hub.sessions.delete('idle'); for (const stream of hub.streams) stream.destroy();
  await until(() => !b.meta.locals.agentList.rows.some((r: { sid: string }) => r.sid === 'idle'));
  t.diagnostic('Model frame displayed the live daemon list; RET opened the waiting session without a spawn.');
});

test('AS-C8: token and symlink are refused; API-echoed token is redacted from buffers, results and logs', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir();
  const tokenFile = path.join(dir.root, 'private-token'); fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  const alias = path.join(dir.root, 'alias'); fs.symlinkSync(tokenFile, alias);
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  hub.add('safe').acp.title = hub.token;
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  for (const p of [tokenFile, alias]) assert.equal((await c.open(p)).error?.code, 'refused_path');
  await c.call('agent-sessions');
  assert.ok(!(await c.open('name:*Agent Sessions*')).text!.includes(hub.token));
  const rotated = path.join(dir.root, 'rotated-token'); fs.writeFileSync(rotated, hub.token, { mode: 0o600 });
  fs.unlinkSync(tokenFile); fs.symlinkSync(rotated, tokenFile);
  await c.call('agent-session-info');
  assert.equal((await c.open(rotated)).error?.code, 'refused_path', 'a new symlink target is protected before its token is read');
  hub.refusal = { status: 403, body: { error: 'echo ' + hub.token } };
  const r = await c.call('agent-session-cancel', ['safe', { epoch: hub.sessions.get('safe')!.createdAt }]); assert.ok(!JSON.stringify(r).includes(hub.token)); assert.match(r.error.report, /redacted/);
  assert.ok(!child.logs.includes(hub.token));
});

test('AS-C1/C8: unconfigured commands explain; a runtime client cannot bind credentials to its own origin', async t => {
  const dir = makeDir(), child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { c.close(); await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });
  assert.match((await c.call('agent-sessions')).error.report, /No agent hub configured/);
  const hub = await new FakeAgentHub().start(); t.after(() => hub.stop());
  const tokenFile = path.join(dir.root, 'token'); fs.writeFileSync(tokenFile, hub.token);
  const r = await c.form(`(agent-hub-configure ${JSON.stringify(hub.url)} ${JSON.stringify(tokenFile)})`);
  assert.match(r.error.report, /init-only/); assert.equal(hub.calls.length, 0);
});

test('AS-C1: trusted user init configures only the URL and token-file path', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  fs.writeFileSync(path.join(dir.dirs.config, 'init.scm'), `(on-server (agent-hub-configure ${JSON.stringify(hub.url)} ${JSON.stringify(tokenFile)}))`);
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  assert.equal((await c.call('agent-sessions')).value, 'name:*Agent Sessions*');
  assert.ok(!child.logs.includes(hub.token));
});

test('AS-C1: a non-object API error is reported and does not hang the daemon', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token); hub.add('safe');
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  hub.refusal = { status: 503, body: null };
  assert.match((await c.call('agent-session-info')).error.report, /503/);
  hub.refusal = null; assert.equal((await c.call('agent-session-info')).value.host, 'test');
});

test('AS-C2: a stale HTTP fallback cannot overwrite a partially received SSE snapshot', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token); hub.add('obsolete');
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const streamStarted = Promise.withResolvers<void>(), listStarted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const handle = hub.handle.bind(hub);
  hub.handle = async (req, res) => {
    if (req.url === '/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); hub.streams.add(res);
      res.on('close', () => hub.streams.delete(res));
      res.write('event: hub\ndata: {"status":"up"}\n\n'); streamStarted.resolve(); return;
    }
    if (req.url === '/v1/sessions' && req.method === 'GET') {
      const stale = JSON.stringify({ sessions: [...hub.sessions.values()] });
      listStarted.resolve(); await release.promise;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(stale); return;
    }
    await handle(req, res);
  };
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { release.resolve(); c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  await streamStarted.promise;
  const listing = c.call('agent-sessions'); await listStarted.promise;
  hub.sessions.delete('obsolete'); hub.add('current');
  await untilText(c, 'name:*Agent Sessions*', 'current'); release.resolve();
  assert.equal((await listing).value, 'name:*Agent Sessions*');
  const text = (await c.open('name:*Agent Sessions*')).text!;
  assert.ok(text.includes('current')); assert.ok(!text.includes('obsolete'));
});

test('AS-C2/C3: lower-head replacement incarnation wins over in-flight old transcript and model reads', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token);
  const old = hub.add('epoch', [
    { seq: 1, e: 'session', configOptions: [{ id: 'model', currentValue: 'old-model' }] },
    { seq: 2, e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'obsolete transcript' } } }
  ]);
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const release = Promise.withResolvers<void>(); let held = 0;
  const handle = hub.handle.bind(hub);
  hub.handle = async (req, res) => {
    if (req.url?.startsWith('/v1/sessions/epoch/events?') && hub.sessions.get('epoch') === old) {
      const body = JSON.stringify({ sid: 'epoch', epoch: old.createdAt, head: 2, from: 1, reset: false, truncated: false, events: hub.journals.get('epoch') });
      held++; await release.promise;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return;
    }
    await handle(req, res);
  };
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { release.resolve(); c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  await c.call('agent-sessions');
  const opening = c.call('agent-session-open', ['epoch']); await until(() => held >= 2);
  const current = hub.add('epoch', [{ seq: 1, e: 'session', configOptions: [{ id: 'model', currentValue: 'current-model' }], note: 'current incarnation' }]);
  current.createdAt = old.createdAt + 1; current.acp.title = 'Replacement'; hub.emit('session', current);
  await untilText(c, 'name:*Agent Sessions*', 'Replacement'); release.resolve();
  const transcript = (await c.open((await opening).value)).text!;
  assert.ok(transcript.includes('current incarnation')); assert.ok(!transcript.includes('obsolete transcript'));
  let list = '';
  for (let i = 0; i < 100; i++) { list = (await c.open('name:*Agent Sessions*')).text!; if (list.includes('current-model')) break; await sleep(10); }
  assert.ok(list.includes('current-model')); assert.ok(!list.includes('old-model'));
});

test('AS-C3: an old detail reply cannot replace a newer stream incarnation while opening', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token); const old = hub.add('detail');
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), handle = hub.handle.bind(hub);
  hub.handle = async (req, res) => {
    if (req.url === '/v1/sessions/detail') {
      const body = JSON.stringify(old); entered.resolve(); await release.promise;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return;
    }
    await handle(req, res);
  };
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { release.resolve(); c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  await c.call('agent-sessions');
  const opening = c.call('agent-session-open', ['detail']); await entered.promise;
  const current = hub.add('detail', [{ seq: 1, e: 'prompt', prompt: [{ type: 'text', text: 'new detail incarnation' }] }]);
  current.createdAt = old.createdAt + 1; current.acp.title = 'Detail replacement'; hub.emit('session', current);
  await untilText(c, 'name:*Agent Sessions*', 'Detail replacement'); release.resolve();
  const opened = await Promise.race([opening, sleep(2000).then(() => { throw new Error('Opening stuck on stale detail epoch'); })]);
  assert.ok((await c.open(opened.value)).text!.includes('new detail incarnation'));
});

test('host state exposes redacted journal controls and full requests; summary-only changes publish metadata without edits', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const session = hub.add('host_state');
  const modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Automatic' }] };
  const configOptions = [{ id: 'model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }], description: hub.token }];
  const schema = { type: 'object', required: ['count'], properties: { count: { type: 'number' }, labels: { type: 'array', items: { type: 'string' } } } };
  const url = 'https://approval.example.invalid/full/path?request=visible';
  hub.append('host_state', { e: 'session', modes, configOptions });
  const permission = hub.append('host_state', { e: 'permission', toolCall: { title: 'Read source', locations: [{ path: 'source.ts', line: 12 }] }, options: [{ optionId: 'once', name: 'Allow ' + hub.token, kind: 'allow_once' }] });
  const form = hub.append('host_state', { e: 'elicitation', request: { message: 'Supply form', requestedSchema: schema } });
  const linked = hub.append('host_state', { e: 'elicitation', request: { message: 'External approval ' + hub.token, mode: 'url', url, elicitationId: 'approval-1' } });
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  const result = await c.call('agent-session-state', ['host_state']); assert.equal(result.error, undefined);
  const state = result.value, id = state.bufferId, opened = await c.open(id);
  assert.equal(id, 'name:*Agent: host_state*'); assert.equal(state.sid, 'host_state'); assert.equal(state.epoch, session.createdAt);
  assert.equal(state.state, 'idle'); assert.equal(state.modeId, 'ask'); assert.deepEqual(state.modes, modes);
  assert.deepEqual(state.configOptions, [{ ...configOptions[0], description: '[redacted]' }]);
  assert.equal(state.pending.length, 3);
  const shownPermission = state.pending.find((p: { req: number }) => p.req === permission.seq);
  assert.equal(shownPermission.kind, 'permission'); assert.equal(shownPermission.epoch, session.createdAt);
  assert.deepEqual(shownPermission.toolCall, permission.toolCall);
  assert.deepEqual(shownPermission.options, [{ optionId: 'once', name: 'Allow [redacted]', kind: 'allow_once' }]);
  assert.deepEqual(state.pending.find((p: { req: number }) => p.req === form.seq).request, form.request);
  assert.deepEqual(state.pending.find((p: { req: number }) => p.req === linked.seq).request, { ...linked.request, message: 'External approval [redacted]' });
  assert.deepEqual(opened.meta!.locals.agentState, state);
  assert.ok(!JSON.stringify({ result, opened }).includes(hub.token), 'state results, text and metadata share the token-redaction path');
  session.state = 'running'; hub.emit('session', session);
  const running = await c.next(m => m.t === 'meta' && m.buf === id && m.locals?.agentState?.state === 'running');
  assert.equal(running.ver, opened.ver); assert.equal(running.locals.agentState.steerable, true);
  assert.deepEqual(running.locals.agentState.pending, state.pending);
  for (const stream of hub.streams) stream.destroy();
  const offline = await c.next(m => m.t === 'meta' && m.buf === id && m.locals?.agentState?.connection.startsWith('offline'));
  assert.equal(offline.ver, opened.ver); assert.equal(offline.locals.agentState.steerable, false);
  const online = await c.next(m => m.t === 'meta' && m.buf === id && m.locals?.agentState?.connection === 'connected');
  assert.equal(online.ver, opened.ver); assert.equal(online.locals.agentState.steerable, true);
  hub.sessions.delete('host_state'); hub.emit('gone', { sid: 'host_state', epoch: session.createdAt });
  const removed = await c.next(m => m.t === 'meta' && m.buf === id && m.locals?.agentState?.state === 'removed' && m.locals.agentState.connection === 'connected');
  assert.equal(removed.ver, opened.ver);
  assert.deepEqual(removed.locals.agentState, { ...state, epoch: null, state: 'removed', steerable: false, connection: 'connected', modeId: null, modes: null, configOptions: null, pending: [] });
  assert.deepEqual(removed.locals.agentSession.pending, []); assert.equal(removed.locals.agentSession.configOptions, null);
  assert.deepEqual((await c.call('agent-session-state', ['host_state'])).value, removed.locals.agentState);
  assert.ok(!c.queue.some(m => m.t === 'edits' && m.buf === id), 'state, connection and removal do not enter the transcript sequencer');
});

test('host answers require the exact request kind and epoch, accept only offered permission options, and preserve hub errors without retries', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const session = hub.add('host_answers');
  const permission = hub.append('host_answers', { e: 'permission', toolCall: { title: 'Read source' }, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }] });
  const elicitation = hub.append('host_answers', { e: 'elicitation', request: { message: 'Supply form', requestedSchema: { type: 'object', properties: { count: { type: 'number' } } } } });
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  const state = (await c.call('agent-session-state', ['host_answers'])).value;
  const shown = state.pending.find((p: { req: number }) => p.req === permission.seq);
  const answer = { req: shown.req, epoch: shown.epoch, outcome: { outcome: 'selected', optionId: 'once' } };
  assert.equal(shown.epoch, session.createdAt);
  for (const body of [{ ...answer, req: undefined }, { ...answer, req: '1' }]) {
    assert.match((await c.call('agent-session-permission', ['host_answers', body])).error.report, /exact.*request id/i);
  }
  for (const epoch of [undefined, String(session.createdAt), session.createdAt - 1]) {
    assert.match((await c.call('agent-session-permission', ['host_answers', { ...answer, epoch }])).error.report, /stale/i);
  }
  for (const req of [permission.seq + 100, elicitation.seq]) {
    assert.match((await c.call('agent-session-permission', ['host_answers', { ...answer, req }])).error.report, /already|resolved/i);
  }
  for (const outcome of [{ outcome: 'selected', optionId: 'not-offered' }, { outcome: 'allow' }]) {
    assert.match((await c.call('agent-session-permission', ['host_answers', { ...answer, outcome }])).error.report, /offered/i);
  }
  assert.equal(hub.calls.filter(call => call.method === 'POST').length, 0, 'invalid captures never reach a mutation route');
  assert.equal((await c.call('agent-session-permission', ['host_answers', answer])).error, undefined);
  const sent = hub.calls.filter(call => call.path.endsWith('/permission'));
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].body, answer);
  assert.match((await c.call('agent-session-permission', ['host_answers', answer])).error.report, /already|resolved/i);
  const response = { req: elicitation.seq, epoch: session.createdAt, response: { action: 'accept', content: { count: 2.5 } } };
  assert.match((await c.call('agent-session-elicitation', ['host_answers', { ...response, req: permission.seq }])).error.report, /already|resolved/i);
  assert.equal((await c.call('agent-session-elicitation', ['host_answers', response])).error, undefined);
  assert.match((await c.call('agent-session-elicitation', ['host_answers', response])).error.report, /already|resolved/i);
  const next = hub.append('host_answers', { e: 'permission', options: [{ optionId: 'no', name: 'Reject once', kind: 'reject_once' }] });
  assert.match((await c.call('agent-session-permission', ['host_answers', answer])).error.report, /already|resolved/i);
  const handle = hub.handle.bind(hub); let attempts = 0;
  hub.handle = async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/sessions/host_answers/permission') {
      attempts++; req.resume();
      res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'competing answer ' + hub.token, code: 'already_resolved' })); return;
    }
    await handle(req, res);
  };
  const refused = await c.call('agent-session-permission', ['host_answers', { req: next.seq, epoch: session.createdAt, outcome: { outcome: 'cancelled' } }]);
  assert.match(refused.error.report, /409.*already_resolved.*competing answer \[redacted\]/);
  assert.equal(attempts, 1); assert.ok(!JSON.stringify(refused).includes(hub.token));
});

test('a summary-only incarnation reset immediately clears stale controls while its new journal replay is in flight', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const old = hub.add('host_epoch');
  hub.append('host_epoch', { e: 'session', modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Automatic' }] }, configOptions: [{ id: 'model', currentValue: 'old' }] });
  const request = hub.append('host_epoch', { e: 'permission', options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }] });
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  const release = Promise.withResolvers<void>();
  t.after(async () => { release.resolve(); c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  const state = (await c.call('agent-session-state', ['host_epoch'])).value, opened = await c.open(state.bufferId);
  assert.equal(state.pending[0].req, request.seq); assert.equal(state.modeId, 'auto');
  const replacement = { ...old, createdAt: old.createdAt + 1, acp: { ...old.acp, pending: [], headSeq: 1 } };
  const entered = Promise.withResolvers<void>(), handle = hub.handle.bind(hub);
  hub.handle = async (req, res) => {
    if (req.url?.startsWith('/v1/sessions/host_epoch/events?') && hub.sessions.get('host_epoch') === replacement) {
      entered.resolve(); await release.promise;
    }
    await handle(req, res);
  };
  hub.sessions.set('host_epoch', replacement);
  hub.journals.set('host_epoch', [{ seq: 1, e: 'session', note: 'fresh incarnation without old controls' }]);
  hub.emit('session', replacement); await entered.promise;
  const reset = await c.next(m => m.t === 'meta' && m.buf === state.bufferId && m.locals?.agentState?.epoch === replacement.createdAt);
  assert.equal(reset.ver, opened.ver);
  assert.deepEqual(reset.locals.agentState.pending, []); assert.equal(reset.locals.agentState.modeId, null);
  assert.equal(reset.locals.agentState.modes, null); assert.equal(reset.locals.agentState.configOptions, null);
  assert.deepEqual(reset.locals.agentSession.pending, []); assert.equal(reset.locals.agentSession.configOptions, null);
  assert.ok(!c.queue.some(m => m.t === 'edits' && m.buf === state.bufferId), 'incarnation invalidation is metadata-only before journal replay');
  const stale = await c.call('agent-session-permission', ['host_epoch', { req: request.seq, epoch: old.createdAt, outcome: { outcome: 'selected', optionId: 'once' } }]);
  assert.match(stale.error.report, /stale/i); assert.equal(hub.calls.filter(call => call.method === 'POST').length, 0);
  release.resolve();
  const fresh = (await c.call('agent-session-state', ['host_epoch'])).value;
  assert.equal(fresh.epoch, replacement.createdAt); assert.deepEqual(fresh.pending, []);
  assert.equal(fresh.modes, null); assert.equal(fresh.configOptions, null);
  assert.match((await c.open(state.bufferId)).text!, /fresh incarnation without old controls/);
});

async function reviewFixture(t: TestContext, setup?: (hub: FakeAgentHub, dir: TestDir) => void) {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  setup?.(hub, dir);
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket, { kind: 'frame' }); await c.connect(); await c.hello();
  t.after(async () => { c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  return { hub, dir, child, c };
}

test('review 2: oversized HTTP bodies fail visibly, including chunked bodies without Content-Length', async t => {
  let oversized = '';
  const { c, hub } = await reviewFixture(t, hub => {
    const handle = hub.handle.bind(hub);
    hub.handle = async (req, res) => {
      if (req.url === '/v1/info' && oversized) {
        res.writeHead(200, { 'content-type': 'application/json', ...(oversized === 'length' ? { 'content-length': 33 * 1024 * 1024 } : {}) });
        if (oversized === 'length') { res.flushHeaders(); return; }
        const part = Buffer.alloc(1024 * 1024, 120);
        for (let i = 0; i < 33; i++) res.write(part);
        res.end(); return;
      }
      if (req.url?.startsWith('/v1/sessions/oversize_facts/events?')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': 33 * 1024 * 1024 }); res.flushHeaders(); return;
      }
      await handle(req, res);
    };
  });
  for (const kind of ['length', 'chunked']) {
    oversized = kind;
    assert.match((await c.call('agent-session-info')).error.report, /response exceeds.*32 MiB/);
  }
  oversized = '';
  assert.equal((await c.call('agent-session-info')).value.host, 'test', 'the daemon remains usable after a bounded refusal');
  hub.add('oversize_facts', [{ seq: 1, e: 'session' }]);
  const id = (await c.call('agent-sessions')).value;
  assert.match(await untilText(c, id, 'unavailable ('), /unavailable \(.*response exceeds.*32 MiB/);
});

test('review 2: an unterminated oversized SSE event closes its connection and reports the limit', async t => {
  let closed = 0;
  const { c } = await reviewFixture(t, hub => {
    const handle = hub.handle.bind(hub);
    hub.handle = async (req, res) => {
      if (req.url === '/v1/stream') {
        res.on('close', () => closed++);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: session\ndata: ');
        for (let i = 0; i < 18; i++) res.write('x'.repeat(65536));
        return;
      }
      await handle(req, res);
    };
  });
  await until(() => closed > 0);
  const id = (await c.call('agent-sessions')).value;
  assert.match((await c.open(id)).text!, /SSE event exceeds the 1 MiB limit/);
  assert.equal((await c.call('agent-session-info')).value.host, 'test');
});

test('review 2: list model discovery and transcript opens share four concurrent journal read slots', async t => {
  const release = Promise.withResolvers<void>(); let active = 0, maximum = 0;
  t.after(() => release.resolve());
  const { hub, c } = await reviewFixture(t, hub => {
    for (let i = 0; i < 12; i++) hub.add(`bounded_${i}`, [{ seq: 1, e: 'session', configOptions: [{ id: 'model', currentValue: `model-${i}` }] }]);
    const handle = hub.handle.bind(hub);
    hub.handle = async (req, res) => {
      if (req.url?.includes('/events?')) {
        active++; maximum = Math.max(maximum, active);
        await release.promise;
        try { await handle(req, res); } finally { active--; }
      } else await handle(req, res);
    };
  });
  await c.call('agent-sessions');
  const opens = [...hub.sessions.keys()].map(sid => c.call('agent-session-open', [sid]));
  await until(() => active >= 4);
  assert.equal((await c.call('agent-session-info')).value.host, 'test', 'journal saturation does not block other API reads');
  release.resolve();
  for (const result of await Promise.all(opens)) assert.equal(result.error, undefined);
  await untilText(c, 'name:*Agent Sessions*', 'model-11');
  assert.equal(maximum, 4, 'facts and open transcripts use one shared concurrency bound');
});

test('review 4: selected relative tool locations cannot be resolved using a replacement session cwd', async t => {
  const { hub, dir, c } = await reviewFixture(t);
  const a = path.join(dir.dirs.notes, 'A'), b = path.join(dir.dirs.notes, 'B');
  for (const p of [a, b]) { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'config.ts'), p + '\n'); }
  const location = { path: 'config.ts', line: 1 }, session = hub.add('location', [
    { seq: 1, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read config', locations: [location] } }
  ]);
  session.cwd = a; hub.emit('session', session);
  await c.call('agent-session-open', ['location']);
  const shown = { sid: 'location', epoch: session.createdAt, seq: 1, location };
  assert.equal((await c.call('agent-session-location', [shown])).value, 'A/config.ts');
  const replacement = hub.add('location', [{ seq: 1, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'read', locations: [location] } }]);
  replacement.createdAt = session.createdAt + 1; replacement.cwd = b; hub.emit('session', replacement);
  assert.match((await c.call('agent-session-location', [shown])).error.report, /session was replaced/i);
  assert.match((await c.call('agent-session-open', ['location', session.createdAt])).error.report, /session was replaced/i);
  assert.ok(!(await c.call('buffer-list')).value.some((v: { file: string }) => v.file === path.join(b, 'config.ts')));
  assert.equal(hub.calls.filter(v => v.method !== 'GET').length, 0);
});

test('review 5: split-token response chunks leave subsequent prompt and diff offsets aligned on every frame', async t => {
  const { hub, child, c } = await reviewFixture(t);
  const events = [
    { seq: 1, e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: hub.token.slice(0, 32) } } },
    { seq: 2, e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: hub.token.slice(32) } } },
    { seq: 3, e: 'prompt', prompt: [{ type: 'text', text: '# embedded heading\n```\nnot structure\n```' }] },
    { seq: 4, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', content: [{ type: 'diff', path: 'a.ts', oldText: 'before\n', newText: 'after\n' }] } },
    { seq: 5, e: 'prompt', prompt: [{ type: 'text', text: hub.token.slice(0, 32) }, { type: 'text', text: hub.token.slice(32) }] }
  ];
  hub.add('redacted_spans', events);
  const id = (await c.call('agent-session-open', ['redacted_spans'])).value, view = await c.open(id);
  const meta = view.meta!.locals.agentSession, prompt = meta.spans.find((s: { kind: string }) => s.kind === 'prompt'), tool = meta.spans.find((s: { kind: string }) => s.kind === 'tool');
  assert.ok(!JSON.stringify(view).includes(hub.token)); assert.ok(!child.logs.includes(hub.token));
  assert.equal(view.text!.slice(prompt.start, prompt.start + '## Prompt #3'.length), '## Prompt #3');
  const diff = tool.diffs[0];
  assert.equal(view.text!.slice(diff.oldStart, diff.oldEnd), 'before\n'); assert.equal(view.text!.slice(diff.newStart, diff.newEnd), 'after\n');
  for (const span of meta.spans) {
    assert.equal(view.text![span.foldStart], '\n'); assert.equal(view.text![span.foldEnd], '\n');
    assert.ok(span.start < span.end && span.end <= view.text!.length);
  }
  const recalled = (await c.call('agent-session-recall', ['redacted_spans', 5, meta.epoch])).value;
  assert.ok(!(await c.open(recalled)).text!.includes(hub.token));
  hub.append('redacted_spans', { e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cross-publication boundary: ' + hub.token.slice(0, 32) } } });
  await untilText(c, id, 'cross-publication boundary: ' + hub.token.slice(0, 32));
  hub.append('redacted_spans', { e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: hub.token.slice(32) + '\nafter split token\n' } } });
  assert.ok(!(await untilText(c, id, 'after split token')).includes(hub.token));
  hub.append('redacted_spans', { e: 'prompt', prompt: [{ type: 'text', text: 'prompt after streamed redaction' }] });
  await untilText(c, id, 'prompt after streamed redaction');
  const streamed = await c.open(id), last = streamed.meta!.locals.agentSession.spans.at(-1);
  assert.equal(streamed.text!.slice(last.start, last.start + '## Prompt #8'.length), '## Prompt #8');
  assert.ok(!child.logs.includes(hub.token)); assert.ok(!JSON.stringify(c.queue).includes(hub.token));
});

test('review 7: concurrent attached-list replacements keep visible rows and structural command targets identical', async t => {
  const { hub, c } = await reviewFixture(t, hub => {
    for (const sid of ['row_a', 'row_b', 'row_c']) hub.add(sid).acp.title = sid + 'A'.repeat(90000);
  });
  const id = (await c.call('agent-sessions')).value; await c.open(id);
  const listings = Array.from({ length: 12 }, () => c.call('agent-sessions'));
  for (let i = 0; i < 40; i++) {
    const s = hub.sessions.get('row_b')!;
    s.acp.title = `${i === 39 ? 'FINAL' : i}-` + 'B'.repeat(90000);
    s.updatedAt++; hub.emit('session', s);
  }
  for (const result of await Promise.all(listings)) assert.equal(result.error, undefined);
  await untilText(c, id, 'FINAL-');
  const view = await c.open(id), rows = view.meta!.locals.agentList.rows;
  const expected = rows.map((r: Record<string, unknown>) => `${r.sid}  ${r.waiting ? 'WAIT' : '    '}  ${[r.state, r.harness, r.model, r.host, r.project, r.activity].join('  ')}`).join('\n') + '\n';
  assert.equal(view.text!.slice(view.text!.indexOf('\n', view.text!.indexOf('\n') + 1) + 1), expected);
  assert.deepEqual(rows.map((r: { sid: string }) => r.sid).sort(), ['row_a', 'row_b', 'row_c']);
});

test('review 8: a final failed journal GET catches up without another summary, and killing the view cancels retries', async t => {
  let refuse = false, failures = 0;
  const { hub, c } = await reviewFixture(t, hub => {
    hub.add('retry', [{ seq: 1, e: 'prompt', prompt: [{ type: 'text', text: 'initial' }] }]);
    const handle = hub.handle.bind(hub);
    hub.handle = async (req, res) => {
      if (req.url?.includes('/retry/events?') && refuse) {
        refuse = false; failures++; res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"transient"}'); return;
      }
      await handle(req, res);
    };
  });
  const id = (await c.call('agent-session-open', ['retry'])).value; await c.open(id);
  refuse = true; hub.append('retry', { e: 'prompt', prompt: [{ type: 'text', text: 'the final event' }] });
  await untilText(c, id, 'the final event');
  assert.equal(failures, 1);
  refuse = true; hub.append('retry', { e: 'prompt', prompt: [{ type: 'text', text: 'closed before retry' }] });
  await until(() => failures === 2);
  await c.call('kill-buffer', [id]);
  const reads = hub.calls.filter(v => v.path.includes('/retry/events?')).length;
  await sleep(600);
  assert.equal(hub.calls.filter(v => v.path.includes('/retry/events?')).length, reads);
  assert.ok(!(await c.call('buffer-list')).value.some((v: { id: string }) => v.id === id));
});

test('review 9: a lower same-incarnation head replaces text, structure and discovered model together', async t => {
  const { hub, c } = await reviewFixture(t, hub => hub.add('reset_head', [
    { seq: 10, e: 'session', configOptions: [{ id: 'model', currentValue: 'obsolete-model' }] },
    { seq: 20, e: 'prompt', prompt: [{ type: 'text', text: 'obsolete prompt' }] }
  ]));
  await c.call('agent-sessions');
  const id = (await c.call('agent-session-open', ['reset_head'])).value; await c.open(id);
  await untilText(c, 'name:*Agent Sessions*', 'obsolete-model');
  const session = hub.sessions.get('reset_head')!;
  hub.journals.set('reset_head', [
    { seq: 1, e: 'session', configOptions: [{ id: 'model', currentValue: 'replacement-model' }] },
    { seq: 2, e: 'prompt', prompt: [{ type: 'text', text: 'replacement prompt' }] }
  ]);
  session.acp.headSeq = 2; session.updatedAt++; hub.emit('session', session);
  await untilText(c, id, 'replacement prompt'); await untilText(c, 'name:*Agent Sessions*', 'replacement-model');
  const view = await c.open(id);
  assert.ok(!view.text!.includes('obsolete')); assert.equal(view.meta!.locals.agentSession.head, 2);
  assert.deepEqual(view.meta!.locals.agentSession.spans.map((s: { seq: number }) => s.seq), [1, 2]);
  assert.ok(!(await c.open('name:*Agent Sessions*')).text!.includes('obsolete-model'));
});

test('review 10: a truncated catchup retires requests whose resolution is no longer available', async t => {
  const { hub, c } = await reviewFixture(t, hub => {
    hub.add('lost_resolution');
    hub.append('lost_resolution', { e: 'permission', toolCall: { title: 'Read' }, options: [{ optionId: 'once', name: 'Allow once' }] });
  });
  const session = hub.sessions.get('lost_resolution')!, id = (await c.call('agent-session-open', ['lost_resolution'])).value;
  await c.open(id);
  hub.truncated = true;
  hub.journals.set('lost_resolution', [{ seq: 100, e: 'prompt', prompt: [{ type: 'text', text: 'recent retained tail' }] }]);
  session.acp.pending = []; session.acp.headSeq = 100; session.updatedAt++; hub.emit('session', session);
  await untilText(c, id, 'no longer pending; resolution unavailable');
  const view = await c.open(id), meta = view.meta!.locals.agentSession;
  assert.deepEqual(meta.pending, []); assert.deepEqual(view.meta!.locals.agentState.pending, []);
  assert.equal(meta.spans.find((s: { seq: number }) => s.seq === 1).status, 'unavailable');
  assert.equal(meta.resolved[0].seq, undefined); assert.equal(meta.resolved[0].by, undefined);
  assert.match((await c.call('agent-session-request', ['lost_resolution', 1, session.createdAt])).error.report, /no longer pending/);
});

test('review 10: an authoritative pending snapshot arriving after its journal head still retires a lost resolution', async t => {
  const { hub, c } = await reviewFixture(t);
  const session = hub.add('late_pending');
  hub.append('late_pending', { e: 'permission', toolCall: { title: 'Old question' }, options: [{ optionId: 'once', name: 'Allow once' }] });
  const id = (await c.call('agent-session-open', ['late_pending'])).value;
  const delayed = structuredClone(session);
  hub.truncated = true;
  hub.journals.set('late_pending', [{ seq: 100, e: 'prompt', prompt: [{ type: 'text', text: 'tail before summary' }] }]);
  session.acp.headSeq = 100; session.acp.pending = [];
  delayed.acp.headSeq = 2; hub.emit('session', delayed);
  await untilText(c, id, 'tail before summary');
  assert.equal((await c.open(id)).meta!.locals.agentSession.pending.length, 1, 'an older summary cannot claim a lost resolution');
  hub.emit('session', session);
  await untilText(c, id, 'no longer pending; resolution unavailable');
  assert.deepEqual((await c.open(id)).meta!.locals.agentState.pending, []);
});

test('review 11: killed transcript/list/reported views stay killed after in-flight reads and later summaries', async t => {
  const release = Promise.withResolvers<void>(); let hold = false, entered = 0;
  t.after(() => release.resolve());
  const { hub, c } = await reviewFixture(t, hub => {
    hub.add('closed', [{ seq: 1, e: 'prompt', prompt: [{ type: 'text', text: 'first' }] }]);
    hub.observed.set('reported_closed', { id: 'reported_closed', host: 'remote', state: 'running', title: 'reported', lastAt: 1 });
    const handle = hub.handle.bind(hub);
    hub.handle = async (req, res) => {
      if (hold && req.url?.includes('/closed/events?')) { entered++; await release.promise; }
      await handle(req, res);
    };
  });
  const list = (await c.call('agent-sessions')).value, id = (await c.call('agent-session-open', ['closed'])).value;
  const reported = (await c.call('agent-session-open', ['reported_closed'])).value;
  for (const buffer of [list, id, reported]) await c.open(buffer);
  hold = true; hub.append('closed', { e: 'prompt', prompt: [{ type: 'text', text: 'held event' }] });
  await until(() => entered > 0);
  for (const buffer of [list, id, reported]) await c.call('kill-buffer', [buffer]);
  release.resolve(); await sleep(100);
  const reads = hub.calls.filter(v => v.path.includes('/closed/events?') || v.path === '/v1/observed/reported_closed').length;
  hub.append('closed', { e: 'prompt', prompt: [{ type: 'text', text: 'latest event' }] });
  const observed = hub.observed.get('reported_closed')!; observed.lastAt++; hub.emit('observed', observed);
  await c.call('agent-session-info'); await sleep(100);
  assert.equal(hub.calls.filter(v => v.path.includes('/closed/events?') || v.path === '/v1/observed/reported_closed').length, reads);
  const buffers = (await c.call('buffer-list')).value;
  for (const buffer of [list, id, reported]) assert.ok(!buffers.some((v: { id: string }) => v.id === buffer));
  assert.equal(hub.calls.filter(v => v.method !== 'GET').length, 0, 'view teardown never cancels the underlying agent');
  const reopened = await c.call('agent-session-open', ['closed']); assert.equal(reopened.error, undefined);
  assert.match((await c.open(reopened.value)).text!, /latest event/);
});

test('review 12: rejected streaming responses close immediately and stop destroys every outstanding attempt', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir(), tokenFile = path.join(dir.root, 'token');
  fs.writeFileSync(tokenFile, hub.token); let active = 0, attempts = 0;
  const handle = hub.handle.bind(hub);
  hub.handle = async (req, res) => {
    if (req.url === '/v1/stream') {
      active++; attempts++;
      const heartbeat = setInterval(() => res.write('still refused\n'), 20);
      res.on('close', () => { active--; clearInterval(heartbeat); });
      res.writeHead(503, { 'content-type': 'text/plain' }); res.write('refused\n'); return;
    }
    await handle(req, res);
  };
  // Only construction dependencies are inert; HTTP requests, SSE bodies, sockets and shutdown are real.
  const server = { cfg: { agentHub: { url: hub.url, tokenFile } }, buffers: { all: () => [], on: () => () => {} },
    auth: { refuse: [], realRefuse: [] }, log: { debug: () => {} }, clients: [] } as unknown as Server;
  const backend = new AgentSessions(server);
  t.after(async () => { backend.stop(); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  backend.start();
  await until(() => attempts >= 2 && active === 0);
  assert.equal(active, 0, 'a refusal is not a draining live connection during reconnect');
  backend.stop(); await until(() => backend.requests.size === 0);
  assert.equal(active, 0); assert.equal(backend.stream, null);
});
