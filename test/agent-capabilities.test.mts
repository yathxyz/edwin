import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FILES, createHost, loadEdwin, memoryStorage } from './headless.mts';
import { FakeAgentHub } from './fake-agent-hub.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
import { validateAgentHub } from '../server/agent-sessions.mts';
import { clientSurface } from './agent-client-surface.mts';

test('unconfigured served clients: loading the three scripts adds only dormant Ed installers', async t => {
  // Core load order on main (8fe116b), not an agent-name filter applied to the subject under test.
  // These ordinary scripts and shipped Scheme are shared by the control and subject in packaged suites.
  const main = 'scheme runtime text editor-core editor-prims evil-core pool complete extras stack ai evil-ex org markdown dired brain ot sync display'.split(' ');
  const installers = ['installAgentSessions', 'installAgentTranscript', 'installAgentPrompts'];
  // Native boot's FILES is checked against host-node's in native.test.mts. Check the pages' load order too.
  for (const page of ['index.html', 'console/index.html']) {
    const html = fs.readFileSync(new URL('../' + page, import.meta.url), 'utf8');
    assert.deepEqual(Array.from(html.matchAll(/<script src="src\/([^"]+)\.js"><\/script>/g), m => m[1]), ['host-browser', ...FILES], page);
  }
  const dir = makeDir(); t.after(() => fs.rmSync(dir.root, { recursive: true, force: true }));
  const daemon = await startEdwind(dir, { env: { CREDENTIALS_DIRECTORY: undefined } });
  try {
    for (const host of ['browser', 'node'] as const) await t.test(host, async () => {
      const control = await clientSurface(dir.cfg.socket, main, host);
      const loaded = await clientSurface(dir.cfg.socket, FILES, host);
      for (const name of installers) {
        assert.ok(!Object.hasOwn(control.ed, name), name);
        control.ed[name] = 'function';
      }
      for (const key of Object.keys(control) as (keyof typeof control)[])
        assert.deepEqual(loaded[key], control[key], `${host}: ${key}`);
    });
  } finally { await stopEdwind(daemon); }
});

const mutations = ['agent-prompt-send', ...['start', 'prompt', 'permission', 'elicitation', 'cancel', 'revive', 'mode', 'config', 'remove', 'answer', 'quick-prompt'].map(action => 'agent-session-' + action)];
test('read-only hub: no steering commands for frames, host pages or terminals; drafts remain writable', async t => {
  const dir = makeDir(), hub = await new FakeAgentHub().start();
  const tokenFile = path.join(dir.root, 'token'); fs.writeFileSync(tokenFile, hub.token);
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  hub.add('read-only'); const child = await startEdwind(dir);
  t.after(async () => { await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  for (const kind of ['frame', 'web', 'cli']) {
    const c = new EditClient(dir.cfg.socket, { kind }); await c.connect(); await c.hello();
    try {
      for (const cmd of mutations) {
        const reply = await c.call(cmd);
        assert.equal(reply.t, 'error', `${kind}: ${cmd} must not dispatch`);
        assert.match(reply.msg, /unknown server command/);
      }
      const draft = (await c.call('agent-prompt-create', [{ text: kind }])).value;
      assert.equal((await c.call('agent-prompt-preview', [draft])).value.blocks[0].text, kind);
      assert.equal((await c.call('agent-session-state', ['read-only'])).value.steerable, false);
    } finally { c.close(); }
  }
  const Ed = loadEdwin(createHost({ storage: memoryStorage(), workers: false }));
  const sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'read-only' });
  try {
    // loadEdwin installs the classic-script Scheme runtime on globalThis.
    const runtime = globalThis as unknown as { L: { commandNames(): string[] } };
    const names = runtime.L.commandNames();
    for (const cmd of mutations) assert.ok(!names.includes(cmd), cmd);
    for (const cmd of ['agent-sessions', 'agent-session-open', 'agent-prompt-compose', 'agent-prompt-save']) assert.ok(names.includes(cmd), cmd);
    assert.ok(hub.calls.every(call => call.method === 'GET'));
  } finally { sync.shutdown(); }
});

test('steer is strictly boolean', () => {
  for (const steer of [null, 'true', 1]) assert.throws(() => validateAgentHub({ url: 'https://host-a', tokenFile: '/token', steer }), /steer.*boolean/);
});
