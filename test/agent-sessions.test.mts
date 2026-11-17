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

test('AS-C1/C2: daemon-owned list is live in a served frame; waiting first, both registries, remote start and reconnect', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir();
  const tokenFile = path.join(dir.root, 'api-token'); fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const idle = hub.add('idle'), waiting = hub.add('waiting'); waiting.acp.pending = [{ req: 7, kind: 'permission', title: 'Run command' }];
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
  const draws: unknown[] = [];
  const frame = Ed.makeFrame(null, { buffer: b, backend: { size: () => ({ cols: 120, rows: 20 }), draw: (m: unknown) => draws.push(m) } });
  Ed.display.redraw(frame); Ed.render(); assert.ok(JSON.stringify(draws).includes('Agent Sessions'));
  // Exercise actual command/key dispatch, rather than calling the UI helper only.
  b.pt = Ed.lineStartB(b, 3); Ed.feedKey('RET'); await Ed.whenIdle();
  await until(() => Ed.E.current.id === 'name:*Agent: waiting*');
  assert.equal(hub.calls.filter(c => c.method === 'POST').length, 0, 'viewing never starts an agent');
  const reported = await c.call('agent-session-open', ['o_report']); const report = await c.open(reported.value);
  assert.match(report.text!, /cannot steer/);
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
  hub.refusal = { status: 403, body: { error: 'echo ' + hub.token } };
  const r = await c.call('agent-session-cancel', ['safe']); assert.ok(!JSON.stringify(r).includes(hub.token)); assert.match(r.error.report, /redacted/);
  assert.ok(!child.logs.includes(hub.token));
});

test('AS-C1: unconfigured hub says so; init configures URL and token file without token values', async t => {
  const dir = makeDir(), child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  t.after(async () => { c.close(); await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });
  assert.match((await c.call('agent-sessions')).error.report, /No agent hub configured/);
  const hub = await new FakeAgentHub().start(); t.after(() => hub.stop());
  const tokenFile = path.join(dir.root, 'token'); fs.writeFileSync(tokenFile, hub.token);
  const r = await c.form(`(agent-hub-configure ${JSON.stringify(hub.url)} ${JSON.stringify(tokenFile)})`); assert.equal(r.error, undefined);
  assert.equal((await c.call('agent-sessions')).value, 'name:*Agent Sessions*');
});
