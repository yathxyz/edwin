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
