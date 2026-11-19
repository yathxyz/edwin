import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeAgentHub } from './fake-agent-hub.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
import { validateAgentHub } from '../server/agent-sessions.mts';

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
  const { createHost, loadEdwin, memoryStorage } = createRequire(import.meta.url)('../src/host-node.cts');
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
