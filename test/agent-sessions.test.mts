// AS-C1/C2/C8: real edwind and served model frame, with an authenticated loopback API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeAgentHub } from './fake-agent-hub.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
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
  assert.match((await c.call('agent-session-cancel', ['o_report'])).error.report, /read-only|cannot be steered/);
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
  const r = await c.call('agent-session-cancel', ['safe']); assert.ok(!JSON.stringify(r).includes(hub.token)); assert.match(r.error.report, /redacted/);
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
