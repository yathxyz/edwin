// AS-C3/C4/C9: daemon replay, live OT, and actual frame folding, with no ACP connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeAgentHub } from './fake-agent-hub.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
const { createHost, loadEdwin } = createRequire(import.meta.url)('../src/host-node.cts');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => unknown) { for (let i = 0; i < 1200; i++) { if (f()) return; await sleep(10); } throw new Error('Journal state did not arrive'); }

test('AS-C3/C4/C9: long journal opens folded, streams off-point without undo, preserves Markdown prompt boundaries and replays on reopen', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir();
  const tokenFile = path.join(dir.root, 'token'); fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const events: Record<string, unknown>[] = [], push = (e: Record<string, unknown>) => events.push({ seq: events.length + 1, ts: 1, ...e });
  const prompt = '# Not a transcript heading\n```md\n## Still the same prompt\n```\nDo the work';
  push({ e: 'prompt', prompt: [{ type: 'text', text: prompt }] });
  for (let i = 0; i < 1200; i++) {
    push({ e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: `Read file ${i}`, kind: 'read', status: 'completed', locations: [{ path: 'example.ts', line: i + 1 }], content: [{ type: 'content', content: { type: 'text', text: `output ${i}\n` + 'details\n'.repeat(150) } }] } });
  }
  const s = hub.add('long', events);
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  const host = createHost({ scmDir: path.resolve('scm'), configDir: dir.dirs.config }), Ed = loadEdwin(host);
  await Ed.bootServed({ host, transport: transport(dir.cfg.socket), device: 'journal-test' });
  t.after(async () => { Ed.sync.shutdown(); c.close(); await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
  const start = performance.now(), opened = await c.call('agent-session-open', ['long']); assert.equal(opened.error, undefined);
  const b = await Ed.sync.open(opened.value); Ed.setWindowBuffer(b); Ed.E.current = b;
  await until(() => b.meta?.locals?.agentSession?.spans?.length > 1200);
  const elapsed = performance.now() - start;
  const draws: unknown[] = [], frame = Ed.makeFrame(null, { buffer: b, backend: { size: () => ({ cols: 100, rows: 25 }), draw: (m: unknown) => draws.push(m) } });
  Ed.display.redraw(frame); Ed.render();
  assert.ok(JSON.stringify(draws).includes('Read file')); assert.ok(b.folds.length >= 1200);
  assert.ok(b.text.includes('output 1199')); assert.ok(b.text.includes(prompt));
  const structure = b.meta.locals.agentSession;
  assert.equal(structure.spans.filter((x: { kind: string }) => x.kind === 'prompt').length, 1);
  b.pt = b.text.indexOf('Not a transcript heading'); const point = b.pt, undo = b.undo.length;
  hub.append('long', { e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\nLive answer arriving elsewhere\n' } } });
  await until(() => b.text.includes('Live answer arriving elsewhere'));
  assert.equal(b.pt, point); assert.equal(b.undo.length, undo);
  const callsBefore = hub.calls.filter(c => c.path.includes('/events?')).length;
  const again = await c.call('agent-session-open', ['long']); assert.equal(again.value, opened.value);
  assert.ok(hub.calls.filter(c => c.path.includes('/events?')).length > callsBefore);
  const rendered = await c.open(opened.value); assert.equal(rendered.text, b.text);
  assert.equal(s.acp.headSeq, b.meta.locals.agentSession.head);
  t.diagnostic(`Journal smoke: ${events.length} events, ${Buffer.byteLength(b.text)} transcript bytes, ${b.folds.length} folds; API replay + frame open ${elapsed.toFixed(1)} ms.`);
});
