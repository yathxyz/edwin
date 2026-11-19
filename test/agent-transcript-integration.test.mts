// AS-C3/C4/C9: daemon replay, live OT, and actual frame folding, with no ACP connection.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeAgentHub } from './fake-agent-hub.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
import { transcriptFixture } from './agent-render-fixture.mts';
import { AgentSessions } from '../server/agent-sessions.mts';
import { Transcript, type TranscriptReply } from '../server/agent-transcript.mts';
import type { Server } from '../server/main.mts';
const { createHost, loadEdwin } = createRequire(import.meta.url)('../src/host-node.cts');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => unknown) { for (let i = 0; i < 1200; i++) { if (f()) return; await sleep(10); } throw new Error('Journal state did not arrive'); }

// These transport tests exercise actual HTTP/SSE connections; only presentation and credential
// lookup are unnecessary. Timers can run on a shorter clock without changing socket inactivity.
async function boundsFixture(t: TestContext) {
  const stub = await new FakeAgentHub().start();
  const backend = new AgentSessions({ cfg: { agentHub: { url: stub.url, tokenFile: '/unused' } },
    buffers: { on: () => () => {}, byId: new Map() }, clients: [], log: { debug() {} } } as unknown as Server);
  backend.token = () => stub.token;
  t.after(async () => { backend.stop(); await stub.stop(); });
  return { backend, stub };
}
function scaleTimers(t: TestContext, delay: (ms: number) => number) {
  t.mock.method(globalThis, 'setTimeout', new Proxy(setTimeout, {
    apply(original, self, args) { return Reflect.apply(original, self, [args[0], delay(args[1]), ...args.slice(2)]); }
  }));
}

function viewFixture(t: TestContext) {
  const hub = new AgentSessions({ cfg: {}, buffers: { on: () => () => {} }, clients: [] } as unknown as Server);
  hub.publish = async (_name, _mode, _text, _locals, valid) => {
    assert.ok(valid()); return {} as Awaited<ReturnType<AgentSessions['publish']>>;
  };
  t.after(() => hub.stop());
  return hub;
}
const absent = () => Object.assign(new Error('absent fixture'), { status: 404 });

test('view reservation: missing sessions and rejected detail replies leave no retained views', async t => {
  const hub = viewFixture(t), routes: string[] = [];
  hub.request = async (_method, route) => { routes.push(route); throw absent(); };
  for (let i = 0; i < 100; i++) await assert.rejects(hub.open(`missing_${i}`), /absent/);
  assert.equal(routes.length, 200, 'both registries were queried for each missing session');
  assert.equal(hub.views.size, 0);
  hub.observed.set('reported', { id: 'reported' });
  await assert.rejects(hub.open('reported'), /absent/);
  hub.request = async () => { throw new Error('unavailable'); };
  await assert.rejects(hub.open('unavailable'), /unavailable/);
  hub.request = async () => ({ kind: 'pty', createdAt: 2 });
  await assert.rejects(hub.open('stale', 1), /replaced/);
  assert.equal(hub.views.size, 0);
});

test('view reservation: a failed fallback cannot release an existing or concurrent view', async t => {
  const hub = viewFixture(t), record = { sid: 'same', kind: 'pty', createdAt: 1 };
  const first = Promise.withResolvers<typeof record>(), second = Promise.withResolvers<typeof record>();
  const detail = [first, second];
  hub.request = async (_method, route) => {
    if (route === 'sessions/same') return detail.shift()!.promise;
    throw absent();
  };
  const missing = hub.open('same'), opening = hub.open('same');
  first.reject(absent()); await assert.rejects(missing, /absent/);
  second.resolve(record);
  const id = await opening, original = hub.views.get(id);
  assert.ok(original);
  hub.request = async () => { throw absent(); };
  await assert.rejects(hub.open('same'), /absent/);
  assert.deepEqual([...hub.views.keys()], [id]);
  assert.equal(hub.views.get(id), original, 'failed reopen must leave the published view alone');

  // An old waiter must not tear down the replacement established after kill/reopen.
  const late = Promise.withResolvers<typeof record>();
  hub.request = () => late.promise;
  const stale = hub.open('same'); hub.killed(id);
  hub.request = async () => record;
  assert.equal(await hub.open('same'), id);
  const replacement = hub.views.get(id); assert.notEqual(replacement, original);
  late.reject(absent()); await assert.rejects(stale, /closed/);
  assert.equal(hub.views.get(id), replacement);
});

test('resource bounds: incremental journal flood keeps a marked recent tail, not every earlier event or span', async t => {
  const { backend, stub } = await boundsFixture(t), tr = new Transcript('tail');
  stub.add('tail'); let head = 0;
  for (let page = 0; page < 4; page++) {
    const events = Array.from({ length: 10000 }, (_, i) => {
      const seq = ++head;
      return i === 0 || i === 9999 ? { seq, e: 'prompt', prompt: ['text-' + seq + '!'] } : { seq, e: 'mode', modeId: seq };
    });
    stub.journals.set('tail', events); stub.sessions.get('tail')!.acp.headSeq = head;
    tr.apply(await backend.readEvents('tail', tr.head, () => true));
    tr.render(); // materialize caches and spans before crossing the retention limit
  }
  assert.ok(tr.journal.length <= 32768);
  const r = tr.render();
  assert.match(r.text, /oldest events dropped/i); assert.doesNotMatch(r.text, /text-1!/);
  assert.match(r.text, /text-40000!/); assert.equal(r.head, 40000);
  assert.ok(r.spans.every(s => s.seq >= tr.journal[0].seq));
  tr.apply({ epoch: tr.epoch + 1, head: 0, from: 1, reset: true, truncated: false, events: [] });
  assert.doesNotMatch(tr.render().text, /oldest events dropped/i);
});

for (const kind of ['session', 'observed']) test(`resource bounds: ${kind} stream flood cannot overfill its registry`, async t => {
  const { backend, stub } = await boundsFixture(t);
  backend.start(); await until(() => backend.status === 'connected');
  const registry = kind === 'session' ? backend.sessions : backend.observed;
  const key = kind === 'session' ? 'sid' : 'id';
  for (let i = 0; i < 1050; i++) stub.emit(kind, { [key]: `record_${i}` });
  await until(() => backend.status.startsWith('offline') || registry.size > 1024);
  assert.ok(registry.size <= 1024); assert.match(backend.status, /registry.*limit/i);
});

test('resource bounds: a saturated journal queue refuses excess readers before scheduling HTTP', async t => {
  const { backend, stub } = await boundsFixture(t), release = Promise.withResolvers<void>();
  const handle = stub.handle.bind(stub); stub.add('slow');
  stub.handle = async (req, res) => { await release.promise; await handle(req, res); };
  const reads = Array.from({ length: 75 }, () => backend.readEvents('slow', 0, () => true));
  const done = Promise.allSettled(reads);
  const queued = backend.journalWaiters.length; release.resolve();
  const results = await done;
  assert.ok(queued <= 64);
  const refused = results.filter(r => r.status === 'rejected');
  assert.ok(refused.length > 0 && refused.every(r => /queue.*limit/i.test(String(r.reason))));
  assert.equal(stub.calls.length, results.length - refused.length); assert.equal(backend.journalActive, 0);
});

for (const stream of [false, true]) test(`resource bounds: drip cannot prolong the absolute ${stream ? 'snapshot' : 'journal request'} deadline`, async t => {
  const { backend, stub } = await boundsFixture(t);
  scaleTimers(t, ms => ms >= 10000 ? 100 : ms);
  const handle = stub.handle.bind(stub); let drips = 0;
  stub.handle = async (req, res) => {
    if (!(stream ? req.url === '/v1/stream' : req.url?.includes('/events?'))) return handle(req, res);
    res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' }); res.flushHeaders();
    const drip = setInterval(() => {
      drips++; res.write(stream ? ': heartbeat\n\n' : ' ');
      if (drips === 40) { clearInterval(drip); res.end(stream ? 'event: ready\ndata: {}\n\n' : '{}'); }
    }, 10);
    res.on('close', () => clearInterval(drip));
  };
  if (stream) {
    await backend.follow(backend.generation);
    assert.match(backend.status, /snapshot.*deadline/i);
  } else {
    await assert.rejects(backend.readEvents('slow', 0, () => true), /deadline/i);
    assert.equal(backend.journalActive, 0);
  }
  assert.ok(drips > 0 && drips < 40, 'stop the ongoing response, not just the caller');
});

for (const facts of [false, true]) test(`resource bounds: ${facts ? 'facts' : 'replay'} disagreement backs off, then recovers without a new summary`, async t => {
  const { backend, stub } = await boundsFixture(t), s = stub.add('epoch', [{ seq: 1, e: 'mode', modeId: 'ready' }]);
  const handle = stub.handle.bind(stub); let disagrees = true, reads = 0;
  stub.handle = async (req, res) => {
    if (!req.url?.includes('/events?')) return handle(req, res);
    reads++;
    if (!disagrees) return handle(req, res);
    res.end(JSON.stringify({ epoch: s.createdAt - 1, head: 0, events: [], from: 1, reset: false, truncated: false } satisfies TranscriptReply));
  };
  backend.sessions.set(s.sid, s);
  backend.queueList = async () => {};
  if (facts) { backend.listOpened = true; void backend.refreshFacts(s.sid).catch(() => {}); }
  else {
    backend.transcripts.set(s.sid, new Transcript(s.sid)); backend.views.set(`name:*Agent: ${s.sid}*`, { opened: true, opening: 0 });
    backend.publish = async () => ({} as Awaited<ReturnType<AgentSessions['publish']>>);
    void backend.replay(s.sid).catch(() => {});
  }
  await until(() => reads >= 2);
  await sleep(65); const immediate = reads;
  // Repeated equivalent summaries must not defeat the retry timer.
  for (let n = 0; n < 20; n++) backend.event('session', s);
  await sleep(40); const flooded = reads;
  disagrees = false;
  assert.ok(immediate <= 3 && flooded === immediate, `backoff allowed ${immediate} then ${flooded} GETs`);
  await until(() => facts ? backend.facts.get(s.sid)?.head === 1 : backend.transcripts.get(s.sid)?.head === 1);
});

test('resource bounds: reconnect uses capped jittered exponential delays and a fixed offline reason', async t => {
  const { backend, stub } = await boundsFixture(t), delays: number[] = [], statuses: string[] = [];
  scaleTimers(t, ms => {
    if (ms >= 100 && ms < 10000) { delays.push(ms); statuses.push(backend.status); return 5; }
    return ms;
  });
  let random = false; t.mock.method(Math, 'random', () => (random = !random) ? 0 : 1);
  const handle = stub.handle.bind(stub); let overflow = false;
  stub.handle = async (req, res) => {
    if (req.url === '/v1/stream') { overflow = true; res.writeHead(200); res.end('x'.repeat(1024 * 1024 + 1)); }
    else if (overflow) { res.writeHead(503); res.end('{}'); }
    else await handle(req, res);
  };
  backend.start(); await until(() => delays.length >= 12); backend.stop();
  assert.ok(delays[1] > delays[0] && delays[2] > delays[1]);
  assert.notEqual(delays[1], delays[0] * 2, 'vary the exponential delay with jitter');
  assert.ok(Math.max(...delays) <= 5000 && delays.at(-1)! >= 3750);
  assert.match(statuses[0], /SSE event exceeds/); assert.equal(new Set(statuses.slice(1)).size, 1);
  assert.ok(statuses.every(s => s.length <= 100));
});

test('AS-C3/C4/C9: long tool journal folds, assistant stays open, live OT preserves point and prompt boundaries, and replay survives reopen', async t => {
  const hub = await new FakeAgentHub().start(), dir = makeDir();
  const tokenFile = path.join(dir.root, 'token'); fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  const events: Record<string, unknown>[] = [], push = (e: Record<string, unknown>) => events.push({ seq: events.length + 1, ts: 1, ...e });
  const prompt = '# Not a transcript heading\n```md\n## Still the same prompt\n```\nDo the work';
  push({ e: 'prompt', prompt: [{ type: 'text', text: prompt }] });
  for (let i = 0; i < 1200; i++) {
    const content = [{ type: 'content', content: { type: 'text', text: `output ${i}\n` + 'details\n'.repeat(150) } }, ...(i === 0 ? [{ type: 'diff', path: 'example.ts', oldText: 'old content\n', newText: 'new content\n' }] : [])];
    push({ e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: `Read file ${i}`, kind: 'read', status: 'completed', locations: [{ path: 'example.ts', line: i === 0 ? 2 : i + 1 }], content } });
  }
  const s = hub.add('long', events);
  s.cwd = dir.dirs.notes; fs.writeFileSync(path.join(dir.dirs.notes, 'example.ts'), 'first\nsecond\nthird\n');
  const child = await startEdwind(dir), c = new EditClient(dir.cfg.socket); await c.connect(); await c.hello();
  const host = createHost({ scmDir: path.resolve('scm'), configDir: dir.dirs.config }), Ed = loadEdwin(host);
  let connected = true;
  const dial = transport(dir.cfg.socket);
  await Ed.bootServed({ host, transport: () => { if (!connected) throw new Error('test disconnected'); return dial(); }, device: 'journal-test' });
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
  assert.equal(JSON.parse((await c.form('(agent-session-open \"long\")')).value), opened.value);
  const immutable = await c.open(opened.value);
  assert.equal((await c.edit(opened.value, immutable.ver!, [[0, '', 'illegal edit']])).code, 'read_only');
  const tool = b.meta.locals.agentSession.spans.find((x: { kind: string }) => x.kind === 'tool');
  b.pt = tool.start; Ed.feedKey('TAB'); await Ed.whenIdle(); assert.equal(b.folds.length, 1199);
  Ed.feedKey('TAB'); await Ed.whenIdle(); assert.equal(b.folds.length, 1200);
  Ed.feedKey('RET'); await Ed.whenIdle();
  assert.equal(Ed.E.current.file, path.join(dir.dirs.notes, 'example.ts'));
  assert.equal(Ed.E.current.pt, Ed.lineStartB(Ed.E.current, 2));
  Ed.setWindowBuffer(b); b.pt = tool.start;
  Ed.feedKey('d'); await Ed.whenIdle();
  assert.ok(Ed.E.current.text.includes('old content')); assert.ok(Ed.E.current.text.includes('new content'));
  Ed.setWindowBuffer(b); b.pt = b.meta.locals.agentSession.spans.find((x: { kind: string }) => x.kind === 'prompt').start; Ed.feedKey('R'); await Ed.whenIdle();
  assert.deepEqual((await c.call('agent-prompt-preview', [Ed.E.current.id])).value.blocks, [{ type: 'text', text: prompt }]);
  Ed.setWindowBuffer(b);
  b.pt = b.rope.length;
  hub.append('long', { e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tail-follow-proof' } } });
  await until(() => b.meta.locals.agentSession.head === s.acp.headSeq);
  assert.equal(b.pt, b.rope.length);
  connected = false; Ed.sync.sock.close(); await until(() => Ed.sync.state !== 'online');
  hub.append('long', { e: 'prompt', prompt: [{ type: 'text', text: 'while-frame-offline' }] });
  assert.equal((await c.call('agent-session-open', ['long'])).error, undefined);
  connected = true;
  await until(() => Ed.sync.state === 'online' && b.meta.locals.agentSession.head === s.acp.headSeq);
  b.pt = b.meta.locals.agentSession.spans.find((x: { kind: string }) => x.kind === 'tool').start;
  Ed.feedKey('TAB'); await Ed.whenIdle(); assert.equal(b.folds.length, 1199, 'replay reinstalled versioned structure');
  const large = 'x'.repeat(3 * 1024 * 1024) + 'large-output-end';
  hub.append('long', { e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'large', title: 'Large live output', status: 'completed', rawOutput: large } });
  await until(() => b.meta.locals.agentSession.head === s.acp.headSeq);
  assert.equal(Ed.sync.state, 'online'); assert.match(b.text, /EVENT CONTENT TRUNCATED/); assert.ok(!b.text.includes('large-output-end'));
  assert.equal(b.undo.length, undo);
  t.diagnostic(`Journal smoke: initial 1201 events opened in ${elapsed.toFixed(1)} ms; final ${events.length} events, ${Buffer.byteLength(b.text)} bytes, ${b.folds.length} folds; 3 MiB live output visibly bounded without reconnect.`);
  const fixture = transcriptFixture();
  hub.truncated = true;
  hub.add('render-fixture', fixture.events);
  const fixtureOpened = await c.call('agent-session-open', ['render-fixture']);
  assert.equal(fixtureOpened.error, undefined);
  const shared = await Ed.sync.open(fixtureOpened.value);
  Ed.setWindowBuffer(shared); Ed.E.current = shared;
  await until(() => shared.meta?.locals?.agentSession?.head === fixture.head);
  const fixtureState = shared.meta.locals.agentSession;
  const spanAt = (seq: number) => fixtureState.spans.find((span: { seq: number }) => span.seq === seq);
  assert.equal(shared.folds.length, 4, 'only the thought, two tools and unknown event start folded');
  assert.equal(spanAt(28680).folded, false, 'long final assistant text stays open');
  assert.equal(spanAt(27723).folded, false);
  assert.equal(spanAt(27729).folded, false);
  assert.ok(spanAt(27725).start < spanAt(27729).start);
  assert.equal(fixtureState.spans.some((span: { seq: number }) => span.seq === 27726), false);
  assert.deepEqual(fixtureState.usage, { size: 4096, used: 768 });
  assert.deepEqual(fixtureState.sessionInfo, { title: 'Browser frame verified' });
  assert.match(shared.text.split('\n')[0], /^Earlier history unavailable from hub; transcript starts at event \d+\.$/);
  assert.equal(shared.text.slice(spanAt(28683).start, spanAt(28683).end), 'Turn ended: end_turn\n\n');
  const sharedTool = spanAt(27725);
  shared.pt = sharedTool.start; Ed.feedKey('TAB'); await Ed.whenIdle();
  assert.equal(shared.folds.length, 3, 'tool content can still be explicitly unfolded');
  const sharedToolText = shared.text.slice(sharedTool.start, sharedTool.end);
  assert.match(sharedToolText, /```sh\nnix build \.#edwin -L\n```\nthis derivation will be built:/);
  assert.ok(sharedToolText.includes('Browser checks passed.\n'));
  assert.doesNotMatch(sharedToolText, /"sessionUpdate"|### Update #/);
  const livePlan = hub.append('render-fixture', { e: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'A newly published plan', status: 'completed' }] } });
  await until(() => shared.meta.locals.agentSession.head === livePlan.seq);
  const liveState = shared.meta.locals.agentSession;
  const livePlanSpan = liveState.spans.find((span: { kind: string }) => span.kind === 'plan');
  const liveToolSpan = liveState.spans.find((span: { seq: number }) => span.seq === 27725);
  assert.equal(livePlanSpan.seq, livePlan.seq); assert.equal(livePlanSpan.folded, false);
  assert.ok(liveToolSpan.start < livePlanSpan.start); assert.equal(liveToolSpan.lastSeq, 27734);
  assert.ok(shared.text.includes('A newly published plan'));
  assert.doesNotMatch(shared.text, /\[completed\] Report the result|\[in_progress\] Run the browser frame/);
});
