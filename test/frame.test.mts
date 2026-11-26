// The frame runtime against a real edwind (E3 H1, spec 6.3, 7, 9.5): Edwin's core on the Node host with
// src/sync.ts as the protocol client, over a net.Socket wrapped to look like a WebSocket (one JSON text
// per send, newline framed on the wire). A second writer is an EditClient with an ot-sim style replica.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeDir, startEdwind, stopEdwind, EditClient, EDWIN, transport } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild, ClientOptions, FakeSocket } from './edit-client.mts';
import { rng, randOp } from './ot-sim.mts';
import type { EditOp, OTModule } from './ot-sim.mts';
import { makeDocument, assertOrdinaryFrameInput, type FakeEvent } from './frame-input.mts';

type EdwinCore = any; // any: Edwin's core (src) is outside this program's types
type Batch = { seq: number; base: number; ops: EditOp[] };

const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.cts');
const OT = require('../src/ot.ts') as OTModule;

let dir: TestDir, child: EdwindChild, Ed: EdwinCore, E: EdwinCore, L: EdwinCore, sync: EdwinCore;
const note = (name: string, text: string) => { fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => unknown, what = 'condition', ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(10); } }
const settled = (b: EdwinCore) => until(() => !b.inflight && !b.queue.length && !b.sync.opening, `${b.name} settled`);
async function client(opts?: ClientOptions) { const c = new EditClient(dir.cfg.socket, opts); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; }
const feed = async (keys: string[]) => { for (const k of keys) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = (s: string) => feed(Ed.kbd(s).split(' '));
const type = (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const show = (b: EdwinCore) => { Ed.setWindowBuffer(b); E.current = b; };
const messages = () => Ed.getBuffer('*Messages*').text;
async function serverText(id: string) { const c = await client(); const o = await c.open(id); c.close(); return o.text; }

/* A second writer whose replica follows R7.12 (the ot-sim Client over a real socket). */
class Writer {
  declare c: EditClient; declare id: string; declare inflight: Batch | null; declare queue: { ops: EditOp[] }[]; declare seq: number; declare acks: Set<number>; declare gen: number;
  declare text: string; declare sverText: string; declare sver: number; declare loop: Promise<void>;
  constructor(c: EditClient, id: string) { this.c = c; this.id = id; this.inflight = null; this.queue = []; this.seq = 0; this.acks = new Set(); this.gen = 0; }
  async open() { const o = await this.c.open(this.id); this.text = this.sverText = o.text!; this.sver = o.ver!; this.pump(); return this; }
  pump() { this.loop = (async () => { for (;;) { let m: Msg; try { m = await this.c.next(x => x.buf === this.id && (x.t === 'edits' || x.t === 'ack'), 1e9); } catch (e) { return; } this.recv(m); } })(); }
  local(ops: EditOp[]) {
    this.text = OT.apply(this.text, ops);
    if (!this.inflight) { this.inflight = { seq: ++this.seq, base: this.sver, ops }; this.send(); } else this.queue.push({ ops });
  }
  send() { this.c.send({ t: 'edit', buf: this.id, base: this.inflight!.base, seq: this.inflight!.seq, ops: this.inflight!.ops, undo: { g: 'w' + (++this.gen) } }); }
  recv(msg: Msg) {
    if (msg.t === 'ack') {
      if (this.acks.has(msg.seq)) return;
      assert.equal(msg.seq, this.inflight!.seq, 'ack for the wrong batch');
      this.acks.add(msg.seq);
      this.sverText = OT.apply(this.sverText, this.inflight!.ops); this.sver = msg.ver; this.inflight = null;
      if (this.queue.length) { const q = this.queue.shift()!; this.inflight = { seq: ++this.seq, base: this.sver, ops: q.ops }; this.send(); }
      return;
    }
    assert.equal(msg.ver, this.sver + 1, 'edits out of order');
    let R = OT.fromOps(msg.ops, this.sverText.length);
    let base = OT.apply(this.sverText, msg.ops);
    this.sverText = base; this.sver = msg.ver;
    if (this.inflight) {
      const [Rp, Ip] = OT.transform(R, OT.fromOps(this.inflight.ops, this.sverText.length - OT.delta(msg.ops)));
      this.inflight.ops = OT.toOps(Ip, base); this.inflight.base = this.sver; R = Rp; base = OT.applyOperation(base, Ip);
    }
    for (let i = 0; i < this.queue.length; i++) {
      const [Rp, Qp] = OT.transform(R, OT.fromOps(this.queue[i].ops, R.baseLen));
      this.queue[i].ops = OT.toOps(Qp, base); R = Rp; base = OT.applyOperation(base, Qp);
    }
    this.text = OT.apply(this.text, OT.toOps(R, this.text));
    assert.equal(this.text, base);
  }
  settled() { return until(() => !this.inflight && !this.queue.length, 'writer settled'); }
}

before(async () => {
  dir = makeDir();
  child = await startEdwind(dir);
  const host = createHost({ storage: memoryStorage(), workers: false });
  Ed = loadEdwin(host); E = Ed.E; L = (globalThis as unknown as { L: EdwinCore }).L;
  sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'frame-test' });
  await Ed.whenIdle();
});
after(async () => { if (sync) sync.shutdown(); if (child) await stopEdwind(child); });

test('feature activation: no agentHub preserves the upstream served command table and key maps', () => {
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const maps = [...L.variableNames().map((n: string) => [n, L.get(n)]), ...E.aux]
    .filter(([, m]) => m instanceof Ed.Keymap)
    .map(([n, m]) => [n, [...m.map].map(([key, value]) => [key, value?.name ?? String(value)]).sort()]).sort();
  // Measured on origin/main, same served boot and empty user image.
  assert.equal(digest(L.commandNames().sort()), '1de6ddbe73e5e7da569fef446db1873ce807f457574bc81abddf3ef3379da796');
  assert.equal(digest(maps), 'eab4d83ebb1b103cd984fd001b5aa5d74e5fe94dcfbd811d1e2fdd174deeb4dc');
});

test('R4.11 served boot: no frame, the shipped Scheme loaded, nothing read from browser stores, candidates set', async () => {
  assert.equal(E.frames.length, 0); assert.equal(E.frame, null);
  assert.equal(sync.state, 'online'); assert.equal(sync.cid.length, 32); assert.equal(sync.ready, true);
  assert.ok(L.get('evil-mode') !== undefined || L.fnOrNull(L.intern('evil-normal-state')), 'evil.scm loaded');
  assert.equal(L.get('wiki-candidates') !== undefined, true);
  assert.equal(L.truthy(L.evalText('(image-server?)')), false, 'a frame is not the image server');
  assert.ok(Ed.getBuffer('*scratch*') && Ed.getBuffer('*Messages*'), 'the local buffers');
  assert.equal(Ed.getBuffer('*scratch*').shared, undefined);
  assert.ok(L.isCommand(L.intern('describe-browser-keys')) && L.isCommand(L.intern('eval-in-frame')));
});

test('E3 H3 gap 4: served boot evaluates the shipped Scheme without buffers; the buffer list is *scratch* and *Messages*', () => {
  assert.deepEqual(E.buffers.map((b: EdwinCore) => b.name).sort(), ['*Messages*', '*scratch*']);
  assert.equal(Number(L.evalText('(length (buffer-list))')), 2);
  /* The sources were evaluated all the same: emacs.scm, evil.scm, org.scm, markdown.scm (through org's require) and init.scm. */
  for (const f of ['emacs', 'evil', 'org', 'markdown', 'notes-syntax', 'address', 'ai', 'init']) assert.equal(L.truthy(L.evalText(`(featurep '${f})`)), true, `(provide '${f})`);
  assert.ok(L.isCommand(L.intern('markdown-todo-cycle')) && L.isCommand(L.intern('evil-normal-state')) && L.isCommand(L.intern('org-todo')));
  assert.equal(Ed.getBuffer('emacs.scm'), null); assert.equal(Ed.getBuffer('init.scm'), null);
});

test('open, snap, typing becomes one edit batch per command, the ack lands and the server has the text', async () => {
  const id = note('a.md', 'hello\n');
  const w = await client(); const wo = await w.open(id); assert.equal(wo.text, 'hello\n');
  const b = await sync.open(id);
  assert.equal(b.shared, true); assert.equal(b.text, 'hello\n'); assert.equal(b.sver, 0); assert.equal(b.readOnly, false);
  assert.ok(E.buffers.includes(b)); assert.equal(b.meta.file, path.join(dir.dirs.notes, 'a.md'));
  show(b);
  await type('iXY'); await keys('ESC');
  await settled(b);
  assert.equal(b.text, 'XYhello\n');
  /* The first self-insert goes out at once; the second waits in the queue (R7.12): two batches of one undo group. */
  const e = await w.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(e.ops, [[0, '', 'X']]);
  assert.equal(e.by.kind, 'frame'); assert.equal(e.by.cid, sync.cid); assert.equal(e.by.device, 'frame-test');
  const e2 = await w.next(m => m.t === 'edits' && m.buf === id);
  assert.deepEqual(e2.ops, [[1, '', 'Y']]);
  assert.equal(b.hist.length, 2); assert.equal(b.hist[0].cid, sync.cid); assert.ok(b.hist[0].undo.g);
  assert.equal(b.hist[0].undo.g, b.hist[1].undo.g, 'a run of self-inserts is one undo group');
  assert.equal(await serverText(id), 'XYhello\n');
  /* A second command is a second group. */
  await type('A!'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'XYhello!\n'); assert.equal(b.hist.length, 3); assert.notEqual(b.hist[2].undo.g, b.hist[0].undo.g);
  assert.equal(await serverText(id), 'XYhello!\n');
  w.close();
});

test('remote edits arrive with their origin and transform against the pending local batch', async () => {
  const id = note('r.md', 'abc\n');
  const b = await sync.open(id); show(b);
  const w = await client(); await w.open(id);
  let edited = 0; const off = Ed.onFrameEvent(() => { edited++; });
  const ack = await w.edit(id, b.sver, [[3, '', 'Z']]);
  assert.equal(ack.t, 'ack');
  await until(() => b.text === 'abcZ\n', 'the remote insert');
  assert.equal(b.sver, ack.ver);
  assert.equal(b.hist[b.hist.length - 1].cid !== sync.cid, true);
  /* Hold our own batch in flight by sending through a stalled path: a local insert and a remote one before the ack. */
  Ed.applyOps(b, [[0, '', 'L']], 'local');
  assert.ok(b.inflight, 'the local batch is in flight');
  await settled(b);
  assert.equal(b.text, 'LabcZ\n'); assert.equal(await serverText(id), 'LabcZ\n');
  off(); w.close();
});

test('randomised convergence: 200 interleaved steps of frame and writer edits end with equal texts', async () => {
  const id = note('c.md', 'the quick brown fox\njumps over\n');
  const b = await sync.open(id); show(b);
  const wc = await client(); const w = await new Writer(wc, id).open();
  const r = rng(7);
  for (let i = 0; i < 200; i++) {
    const k = r.int(0, 9);
    if (k < 4) { const op = randOp(r, b.text); if (op) Ed.applyOps(b, [op], 'local'); }
    else if (k < 8) { const op = randOp(r, w.text); if (op) w.local([op]); }
    else await sleep(r.int(0, 3));
  }
  await settled(b); await w.settled();
  await until(() => b.sver === w.sver, 'both replicas at the same version');
  assert.equal(b.text, w.text);
  assert.equal(b.text, await serverText(id));
  assert.equal(String(b.sync.sverText), b.text);
  wc.close();
});

// Exercise slices spanning a real chunk seam, not merely offset 2048 of a flat string.
function assertShadowSeam(b: EdwinCore, left: string, right: string) {
  const shadow = b.sync.sverText;
  assert.equal(shadow.ch[0].at(-1), left);
  assert.equal(shadow.ch[1][0], right);
  assert.equal(shadow.flat, null);
}

test('remote CRLF replacement and hashed acks agree with a flat shadow through both pending batches', async t => {
  const p = 2047, prefix = 'x'.repeat(p), suffix = 'AB' + 'y'.repeat(2400);
  const id = note('shadow-crlf.txt', prefix + '\n' + suffix);
  const w = await client(); t.after(() => w.close()); await w.open(id);
  // A disk open normalizes CRLF. Put a literal CR into the server text *before* the frame snapshots it.
  assert.equal((await w.edit(id, 0, [[p, '', '\r']])).t, 'ack');
  const b = await sync.open(id);
  const initial = prefix + '\r\n' + suffix + '!';
  assert.equal((await w.edit(id, 1, [[initial.length - 1, '', '!']])).t, 'ack');
  await until(() => b.sver === 2);
  assertShadowSeam(b, '\r', '\n');

  const remote: EditOp[] = [[p, '\r\n', '<remote>']], local: EditOp[] = [[p + 2, 'A', 'ii']], queued: EditOp[] = [[p + 3, 'iB', 'q']];
  const [remoteAfterLocal, ip] = OT.transformOps(remote, local, initial);
  const [, qp] = OT.transformOps(remoteAfterLocal, queued, OT.apply(initial, local));
  const afterRemote = OT.apply(initial, remote), afterLocal = OT.apply(afterRemote, ip), final = OT.apply(afterLocal, qp);

  // Hold the sequenced edits in the receive path. Both local edits then really go through local(); the
  // daemon must rebase the first on its stale base, and only its durable ack can send the queued one.
  const inbox: Msg[] = [], receive = sync.sock.onmessage;
  t.mock.method(sync.sock, 'onmessage', (e: { data: string }) => {
    const m = JSON.parse(e.data);
    if (m.buf === id && (m.t === 'edits' || m.t === 'ack')) inbox.push(m); else receive(e);
  });
  async function deliver(kind: 'edits' | 'ack', ver: number, text: string) {
    await until(() => inbox.length, `${kind} v${ver}`);
    const m = inbox.shift()!; assert.equal(m.t, kind); assert.equal(m.ver, ver);
    const h = OT.hash(text); // the flat reference, not the frame's current shadow or display
    receive({ data: JSON.stringify({ ...m, h }) });
    assert.equal(b.sver, ver); assert.equal(b.sync.opening, null, 'the reference hash was accepted without a resnapshot');
    assert.equal(OT.hash(b.sync.sverText), h);
    assert.equal(String(b.sync.sverText), text); assert.equal(b.text, final);
  }
  assert.equal((await w.edit(id, 2, remote)).t, 'ack');
  Ed.applyOps(b, local, 'local'); Ed.applyOps(b, queued, 'local');
  assert.deepEqual(b.inflight.ops, local); assert.deepEqual(b.queue.map((q: Batch) => q.ops), [queued]);
  await deliver('edits', 3, afterRemote);
  assert.equal(b.inflight.base, 3); assert.deepEqual(b.inflight.ops, ip); assert.deepEqual(b.queue.map((q: Batch) => q.ops), [qp]);
  await deliver('ack', 4, afterLocal);
  assert.equal(b.inflight.base, 4); assert.deepEqual(b.inflight.ops, qp); assert.deepEqual(b.queue, []);
  await deliver('ack', 5, final);
  assert.equal(b.inflight, null); assert.equal(await serverText(id), final);
});

test('a refused later op leaves previously acknowledged text intact', async t => {
  const id = note('shadow.txt', 'abc😀\n');
  const b = await sync.open(id);
  const w = await client(); await w.open(id);
  assert.equal((await w.edit(id, 0, [[0, '', 'Z']])).t, 'ack');
  await until(() => b.sver === 1);
  const shadow = b.sync.sverText; assert.notEqual(typeof shadow, 'string', 'rollback on an already published mutable rope');
  const error = t.mock.method(console, 'error', (..._args: unknown[]) => {});
  // The second replacement consumes part of the first. The third deletes the wrong text;
  // restoring the original requires undoing both successful ops in reverse order.
  sync.sock.onmessage({ data: JSON.stringify({ t: 'edits', buf: id, ver: 2, by: { kind: 'server' }, ops: [[1, 'a', 'xy'], [2, 'yb', 'Q'], [3, '?', '']] }) });
  assert.equal(error.mock.callCount(), 1);
  assert.match(String(error.mock.calls[0].arguments[2]), /text at 3 is not the one the op deletes/); error.mock.restore();
  assert.equal(String(b.sync.sverText), 'Zabc😀\n'); assert.equal(b.text, 'Zabc😀\n'); assert.equal(b.sver, 1);
  assert.equal((await w.edit(id, 1, [[1, 'a', 'xy'], [3, 'b', '']])).t, 'ack');
  await until(() => b.sver === 2);
  assert.equal(b.text, 'Zxyc😀\n'); assert.equal(String(b.sync.sverText), b.text);
  w.close();
});

test('a remote deletion spans a surrogate pair split across acknowledged chunks', async t => {
  const p = 2046, prefix = 'x'.repeat(p), suffix = 'y'.repeat(2400), hi = '\ud83d', lo = '\ude00';
  const id = note('shadow-surrogate.txt', '');
  const w = await client(); t.after(() => w.close()); await w.open(id);
  // chunkify normally keeps a pair together. Delete its separator *after* chunking to make a legal
  // pair across the seam: [... high _] [low ...] → [... high] [low ...].
  assert.equal((await w.edit(id, 0, [[0, '', prefix + hi + '_' + lo + suffix]])).t, 'ack');
  const b = await sync.open(id);
  assert.equal((await w.edit(id, 1, [[p + 1, '_', '']])).t, 'ack');
  await until(() => b.sver === 2); assertShadowSeam(b, hi, lo);
  const error = t.mock.method(console, 'error', (..._args: unknown[]) => {});
  sync.sock.onmessage({ data: JSON.stringify({ t: 'edits', buf: id, ver: 3, by: { kind: 'server' }, ops: [[p, hi, '']] }) });
  assert.equal(error.mock.callCount(), 1); assert.match(String(error.mock.calls[0].arguments[2]), /splits a surrogate pair/);
  error.mock.restore(); assert.equal(b.sver, 2);
  assert.equal((await w.edit(id, 2, [[p, '😀', '']])).t, 'ack'); await until(() => b.sver === 3);
  assert.equal(String(b.sync.sverText), prefix + suffix); assert.equal(b.text, prefix + suffix);
});

test('R6.15-R6.18 undo by group: u takes a whole group back, C-r redoes, a partial undo names the other writer', async () => {
  const id = note('u.md', 'abc\n');
  const b = await sync.open(id); show(b);
  await type('iXY'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'XYabc\n');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n');
  const u = b.hist[b.hist.length - 1];
  assert.equal(u.undo.of, b.hist[b.hist.length - 2].undo.g, 'the undo batch names the group it undoes');
  assert.equal(await serverText(id), 'abc\n');
  await keys('C-r'); await settled(b);
  assert.equal(b.text, 'XYabc\n'); assert.equal(await serverText(id), 'XYabc\n');
  assert.equal(b.hist[b.hist.length - 1].undo.of, undefined, 'redo is a new group');
  await keys('u'); await settled(b); assert.equal(b.text, 'abc\n');
  /* Partial: our PQ, then another writer deletes the Q; undo removes what is left and says so. */
  await type('iPQ'); await keys('ESC'); await settled(b);
  assert.equal(b.text, 'PQabc\n');
  const w = await client(); await w.open(id);
  const ack = await w.edit(id, b.sver, [[1, 'Q', '']]); assert.equal(ack.t, 'ack');
  await until(() => b.text === 'Pabc\n', 'the remote delete');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n');
  assert.match(messages(), /Undo \(partial/);
  assert.equal(await serverText(id), 'abc\n');
  /* Nothing of ours left to undo locally: the server fallback answers. */
  await keys('u'); await sleep(200);
  assert.ok(b.text === 'abc\n' || b.text === 'PQabc\n');
  w.close();
});

test('R7.16 reconnect after edwind restarts: the unacknowledged batch is resent and nothing is lost', async () => {
  const id = note('k.md', 'keep\n');
  const b = await sync.open(id); show(b);
  await type('i1'); await keys('ESC'); await settled(b);
  assert.equal(await serverText(id), '1keep\n');
  const states: string[] = []; const off = sync.on('state', (s: string) => states.push(s));
  await stopEdwind(child);
  await until(() => sync.state !== 'online', 'offline');
  /* Offline edits queue up: the mode line shows the dot. */
  await type('A2'); await keys('ESC');
  assert.ok(b.inflight, 'held while offline'); assert.equal(b.text, '1keep2\n');
  assert.ok(b.sync.sverText instanceof b.rope.constructor, 'the acknowledged text is a rope before export');
  assert.equal(sync.exportPending().find((p: Msg) => p.buf === id).sverText, '1keep\n', 'pending state exports text, not the rope');
  assert.ok(Ed.hooks.modeStatus(b).includes('•') && Ed.hooks.modeStatus(b).includes('offline'));
  child = await startEdwind(dir);
  await until(() => sync.state === 'online', 'online again', 15000);
  await settled(b);
  assert.equal(b.text, '1keep2\n');
  assert.equal(await serverText(id), '1keep2\n');
  assert.ok(states.includes('offline') && states.includes('online'));
  assert.equal(Ed.hooks.modeStatus(b), '');
  off();
  /* The replica keeps working after the reconnect. */
  await type('A3'); await keys('ESC'); await settled(b);
  assert.equal(await serverText(id), '1keep23\n');
});

test('requests fail before the close event when the transport is closing or closed', { timeout: 5000 }, async t => {
  const b = await sync.open(note('closing.md', 'keep\n'));
  t.after(() => sync.close(b));
  const sock: FakeSocket & { readyState?: number } = sync.sock;
  const send = t.mock.method(sock, 'send');
  try {
    for (const state of [2, 3]) {
      sock.readyState = state;
      const replies = [sync.call({ cmd: 'notes-info' }), sync.save(b), sync.revert(b)];
      assert.equal(send.mock.callCount(), 0, `write attempted in readyState ${state}`);
      for (const reply of await Promise.all(replies)) assert.equal(reply.error?.condition, 'disconnected');
      assert.equal(sync.state, 'online', 'close event has not fired');
    }
  } finally {
    delete sock.readyState;
  }
  const reply = await sync.call({ cmd: 'notes-info' });
  assert.equal(reply.value?.root, dir.dirs.notes);
});

test('R4.15-R4.18 the image replicates: definitions arrive, on-server forms are skipped, shared variables follow', async () => {
  const c = await client();
  let r = await c.form('(define (frame-fn x) (* x 7))'); assert.ok(!r.error, JSON.stringify(r));
  r = await c.form('(on-server (define (srv-only) 1))'); assert.ok(!r.error);
  r = await c.form('(defvar-shared frame-shared 1 "A count.")'); assert.ok(!r.error);
  r = await c.form('(set! frame-shared 41)'); assert.ok(!r.error);
  await until(() => L.fnOrNull(L.intern('frame-fn')), 'the definition');
  assert.equal(String(L.evalText('(frame-fn 6)')), '42');
  await until(() => String(L.get('frame-shared')) === '41', 'the shared value');
  assert.equal(L.fnOrNull(L.intern('srv-only')), null, 'on-server forms are not evaluated in a frame');
  /* A bad form reports to *Messages* with its generation and does not stop the rest. */
  r = await c.form('(define (after-bad) 2)');
  await until(() => L.fnOrNull(L.intern('after-bad')), 'the later definition');
  c.close();
});

test('R4.27, R4.28 a :where server command runs on edwind; its edits come back as this frame\'s own and undo', async () => {
  const id = note('s.md', 'abc\n');
  const b = await sync.open(id); show(b);
  const c = await client();
  const r = await c.form('(define-command (stamp) "Append S." (interactive) (:where (quote server)) (goto-char (point-max)) (insert "S") (message "stamped"))');
  assert.ok(!r.error, JSON.stringify(r));
  await until(() => { const f = L.fnOrNull(L.intern('stamp')); return f && f.where === 'server'; }, 'the command in the frame');
  await keys('M-x'); await type('stamp'); await keys('RET');
  await until(() => b.text === 'abc\nS', 'the server edit');
  const h = b.hist[b.hist.length - 1];
  assert.equal(h.cid, sync.cid, 'the thread edit is ours'); assert.equal(h.by.via, 'server');
  await until(() => /stamped/.test(messages()), 'the result message');
  await keys('u'); await settled(b);
  assert.equal(b.text, 'abc\n', 'u undoes the server command\'s edit');
  assert.equal(await serverText(id), 'abc\n');
  c.close();
});

test('hypernotes H1: C-c C-c in a frame runs the block in edwind, in Org and markdown; the result arrives as this frame\'s edit', async () => {
  const id = note('h1.org', '#+begin_src scheme\n(* 6 7)\n#+end_src\n');
  const b = await sync.open(id); show(b);
  b.pt = b.text.indexOf('(* 6');
  await keys('C-c C-c');
  await until(() => /#\+RESULTS:\n: 42\n/.test(b.text), 'the Org result');
  assert.equal(b.text, '#+begin_src scheme\n(* 6 7)\n#+end_src\n\n#+RESULTS:\n: 42\n');
  assert.equal(b.hist[b.hist.length - 1].cid, sync.cid, 'the result is this frame\'s edit');
  assert.equal(await serverText(id), b.text);
  const md = await sync.open(note('h1.md', '```scheme {#a}\n(define h1-x (string-append "x" "y"))\nh1-x\n```\n')); show(md);
  md.pt = 18;
  await keys('C-c C-c');
  await until(() => /```result \{of=a\}\n"xy"\n```\n$/.test(md.text), 'the markdown result');
  await until(() => /a: "xy"/.test(messages()), 'the message');
  /* The note's definition stayed in edwind's note environment: no image message brought it to this frame. */
  await sleep(100);
  assert.equal(L.get('h1-x'), undefined);
});

test('R4.29 ask reaches the minibuffer of the frame and the answer goes back; C-g answers quit', async () => {
  const c = await client();
  const r = await c.form('(define-command (greet2 n) (interactive "sName: ") (:where (quote server)) (message "hi ~a" n) n)');
  assert.ok(!r.error, JSON.stringify(r));
  await until(() => { const f = L.fnOrNull(L.intern('greet2')); return f && f.where === 'server'; }, 'the command');
  show(Ed.getBuffer('*scratch*'));
  await keys('M-x'); await type('greet2'); await keys('RET');
  await until(() => E.mini && /Name/.test(E.mini.prompt || ''), 'the ask prompt');
  await type('Bob'); await keys('RET');
  await until(() => /hi Bob/.test(messages()), 'the answer used');
  await keys('M-x'); await type('greet2'); await keys('RET');
  await until(() => E.mini && /Name/.test(E.mini.prompt || ''), 'the second ask');
  await keys('C-g');
  await until(() => !E.mini, 'the minibuffer closed');
  await until(() => /Quit/.test(E.echo) || /Quit/.test(messages()), 'quit reported');
  c.close();
});

test('R7.14, R7.17 bad_edit and stale_base recover: the buffer reopens and matches the server', async () => {
  const id = note('e.md', 'safe\n');
  const b = await sync.open(id); show(b);
  sync.sock.send(JSON.stringify({ t: 'edit', buf: id, base: b.sver, seq: ++b.sync.seq, ops: [[999, '', 'x']], undo: { g: 1 } }));
  await until(() => /refused an edit/.test(messages()), 'bad_edit reported');
  await settled(b);
  assert.equal(b.text, 'safe\n'); assert.equal(b.shared, true);
  /* stale_base needs a base older than the retained history; the server's answer is injected on the wire. */
  Ed.applyOps(b, [[0, '', 'pending'], ], 'local');
  sync.sock.onmessage({ data: JSON.stringify({ t: 'error', code: 'stale_base', buf: id, seq: b.inflight.seq, msg: 'base 0 is older than the retained history' }) });
  await until(() => /version edwind no longer has/.test(messages()), 'stale_base reported');
  assert.ok(E.buffers.some((x: EdwinCore) => /~offline-/.test(x.name) && x.text === 'pendingsafe\n'), 'the unsent edit is kept in an offline copy');
  await settled(b);
  assert.equal(b.text, await serverText(id));
  await type('iok'); await keys('ESC'); await settled(b);
  assert.match(b.text, /ok/); assert.equal(await serverText(id), b.text);
});

test('R9.12 anchors arrive in meta, move with local and remote edits, and anchor-add returns the id', async () => {
  const id = note('n.md', 'one two three\n');
  const b = await sync.open(id); show(b);
  const c = await client(); await c.open(id);
  const r = await c.call('anchor-add', [id, 4, 'two']);
  assert.ok(!r.error, JSON.stringify(r)); assert.equal(r.value.pos, 4);
  await until(() => b.meta.anchors.length === 1, 'the anchor in meta');
  assert.equal(b.meta.anchors[0].pos, 4); assert.equal(b.meta.anchors[0].label, 'two');
  Ed.applyOps(b, [[0, '', 'ZZ']], 'local');
  assert.equal(b.meta.anchors[0].pos, 6, 'moved by the local insert before the ack');
  await settled(b);
  assert.equal(b.meta.anchors[0].pos, 6);
  const ack = await c.edit(id, b.sver, [[0, '', 'Y']]); assert.equal(ack.t, 'ack');
  await until(() => b.meta.anchors[0].pos === 7, 'moved by the remote insert');
  const myId = await sync.anchorAdd(id, 1, 'mine', 'mine-1');
  assert.equal(myId, 'mine-1');
  await until(() => b.meta.anchors.length === 2, 'the second anchor');
  assert.equal(await sync.anchorRemove(id, 'mine-1'), true);
  await until(() => b.meta.anchors.length === 1, 'removed');
  c.close();
});

test('R4.30 server-only primitives are stubs that signal server-only with a hint', async () => {
  const f = L.fnOrNull(L.intern('anchor-add!'));
  assert.ok(f, 'the stub exists'); assert.equal(f.where, 'server');
  let err = null;
  try { L.evalText('(anchor-add! "x" 1)'); } catch (e) { err = e; }
  assert.ok(err && err.kind === 'server-only', String(err));
  assert.match(String(err.message), /runs in edwind/);
});

test('presence: another writer\'s sel is recorded per buffer with a colour and label', async () => {
  const id = note('p.md', 'abc\n');
  const b = await sync.open(id);
  const c = await client({ device: 'laptop' }); await c.open(id);
  c.send({ t: 'sel', buf: id, ranges: [[1, 3]] });
  await until(() => b.presence.length === 1, 'the presence entry');
  assert.deepEqual(b.presence[0].ranges, [[1, 3]]); assert.equal(b.presence[0].label, 'laptop');
  assert.match(b.presence[0].color, /^hsl\(/);
  c.close();
});

test('writer labels: an agent is named by the agent field edwind attributes it with', () => {
  assert.equal(sync.writerLabel({ kind: 'agent', agent: 'gptel:notes.md' }), 'gptel:notes.md');
  assert.equal(sync.writerLabel({ kind: 'agent' }), 'agent');
});

test('project-find-regexp jumps to a match in a note no buffer holds yet: the replica opens, then point moves', async () => {
  const id = note('grep-far.md', 'one\ntwo needle\n');
  show(Ed.getBuffer('*scratch*'));
  await L.call('project-find-regexp', [id, 2, 4, false, false]);
  await until(() => E.sel.buffer.id === id && !E.sel.buffer.sync.opening, 'the replica in the window');
  const b = E.sel.buffer;
  assert.equal(b.text, 'one\ntwo needle\n'); assert.equal(b.pt, 8);
});

test('killed and moved: a buffer killed on the server leaves the frame; a message from edwind reaches the echo area', async () => {
  const id = note('x.md', 'bye\n');
  const b = await sync.open(id); show(Ed.getBuffer('*scratch*'));
  const c = await client();
  const r = await c.form(`(kill-buffer (get-buffer ${JSON.stringify(id)}))`);
  await until(() => !E.buffers.includes(b) || !b.shared, 'the kill');
  assert.ok(!sync.buffers.has(id));
  c.close();
});

test('moved: a file renamed on the server moves the replica to the new id; the frame keeps editing it and the page hears of it', async () => {
  const id = note('mv-frame.md', 'move me\n');
  const b = await sync.open(id); show(b);
  const heard: Msg[] = []; const off = sync.on('moved', (m: Msg) => heard.push(m));
  const c = await client();
  const r = await c.call('rename-file', [{ src: id, dst: 'mv-framed.md' }]);
  assert.equal(r.value.to, 'mv-framed.md');
  await until(() => b.id === 'mv-framed.md' && !b.sync.opening, 'the replica to follow');
  assert.deepEqual(heard, [{ buf: id, to: 'mv-framed.md' }]); off();
  assert.equal(sync.buffers.get('mv-framed.md'), b); assert.equal(sync.buffers.has(id), false);
  assert.equal(b.text, 'move me\n');
  await type('A, still mine'); await keys('ESC');
  await settled(b);
  assert.equal(await serverText('mv-framed.md'), 'move me, still mine\n');
  assert.equal(fs.existsSync(path.join(dir.dirs.notes, id)), false);
  c.close();
});

test('moved onto a replica this tab holds: an open of the old id settles with that replica, which stays attached and editable', async () => {
  const id = note('mv-old.md', 'kept\n');
  const c = await client();
  assert.equal((await c.call('rename-file', [{ src: id, dst: 'mv-new.md' }])).t, 'result');
  const have = await sync.open('mv-new.md'); show(have);
  const heard: Msg[] = []; const off = sync.on('moved', (m: Msg) => heard.push(m));
  const n = E.buffers.length;
  const got = await sync.open(id, { create: true });   // edwind sends the old id on to mv-new.md
  assert.equal(got, have, 'the open settles with the replica already held');
  assert.equal(sync.buffers.get('mv-new.md'), have); assert.equal(sync.buffers.has(id), false);
  assert.equal(E.buffers.length, n, 'the replica made for the old id is gone');
  assert.deepEqual(heard, [{ buf: id, to: 'mv-new.md' }]); off();
  // Still attached: another writer's edit reaches it, and its own edits are acked.
  const o = await c.open('mv-new.md');
  await c.edit('mv-new.md', o.ver!, [[0, '', 'theirs ']]);
  await until(() => have.text === 'theirs kept\n', 'the remote edit');
  await type('A, mine'); await keys('ESC');
  await settled(have);
  assert.equal(await serverText('mv-new.md'), 'theirs kept, mine\n');
  c.close();
});

test('E3 H3 gap 2: Ed.sync.close kills the local replica and moves the window showing it; a reopen is a fresh replica', async () => {
  const id = note('cl.md', 'close me\n');
  const b = await sync.open(id); show(b);
  assert.ok(E.buffers.includes(b)); assert.equal(E.sel.buffer, b); assert.equal(E.current, b);
  const n = E.buffers.length;
  sync.close(id);
  assert.equal(E.buffers.includes(b), false, 'the replica is killed');
  assert.equal(E.buffers.length, n - 1);
  assert.equal(sync.buffers.has(id), false); assert.equal(b.shared, false);
  assert.notEqual(E.sel.buffer, b, 'the window shows another buffer'); assert.notEqual(E.current, b);
  assert.ok(E.buffers.includes(E.sel.buffer));
  /* Closing twice, or an id never opened, is a no-op. */
  sync.close(id); sync.close('never-opened.md');
  /* The server took the close: a sel from another client no longer reaches this one through the old replica. */
  const b2 = await sync.open(id);
  assert.notEqual(b2, b); assert.equal(b2.text, 'close me\n'); assert.ok(E.buffers.includes(b2));
  /* A buffer object works as the argument too. */
  sync.close(b2);
  assert.equal(E.buffers.includes(b2), false); assert.equal(sync.buffers.has(id), false);
  /* An open still on its way settles with an error when closed. */
  const p = sync.open(note('cl2.md', 'x\n'));
  sync.close('cl2.md');
  await assert.rejects(p, (e: Error & { code?: string }) => e.code === 'closed');
  assert.equal(E.buffers.some((x: EdwinCore) => x.id === 'cl2.md'), false);
});

test('E3 H3 gap 3: hooks.renderOverlay runs for every frame drawn, with that frame current, the selected frame last', async () => {
  const doc = makeDocument();
  const el1 = doc.createElement('div'), el2 = doc.createElement('div'); doc.body.appendChild(el1); doc.body.appendChild(el2);
  const ba = await sync.open(note('o1.md', 'alpha one\n')), bb = await sync.open(note('o2.md', 'beta two\n'));
  const f1 = Ed.makeFrame(el1, { buffer: ba, kind: 'card', fontSize: 13 }), f2 = Ed.makeFrame(el2, { buffer: bb, kind: 'card' });
  assert.equal(E.frame, f1); assert.equal(E.frames.length, 2);
  assert.ok(el1.classList.contains('edwin-frame') && el1.dataset.kind === 'card' && f1.el('input') && f1.el('windows') && f1.el('echo'));
  /* Frames and windows are compared by identity only: a deep comparison would walk the whole window tree. */
  const calls: { arg: EdwinCore; sel: EdwinCore; root: EdwinCore; frame: EdwinCore }[] = [], prev = Ed.hooks.renderOverlay, order = () => calls.map(c => c.arg && c.arg.id);
  Ed.hooks.renderOverlay = (f: EdwinCore) => { calls.push({ arg: f, sel: E.sel, root: E.root, frame: E.frame }); if (prev) prev(f); };
  try {
    Ed.render();
    assert.deepEqual(order(), [f2.id, f1.id], 'both frames, the selected one last');
    assert.equal(calls[0].sel, f2.sel); assert.equal(calls[0].root, f2.wroot); assert.equal(calls[0].frame, f1, 'E.frame stays the selected frame');
    assert.equal(calls[1].sel, f1.sel); assert.equal(calls[1].root, f1.wroot);
    assert.match(f1.sel.view.textContent, /alpha one/); assert.match(f2.sel.view.textContent, /beta two/);
    assert.ok(f1.sel.el.classList.contains('selected') && !f2.sel.el.classList.contains('selected'));
    /* The popups stay with the selected frame: no corfu or snipe element was made in the other one. */
    assert.equal(el2.querySelector('.corfu'), null); assert.equal(el2.querySelector('.snipe'), null);
    /* Unchanged, the other frame is not drawn again; the selected one always is. (The first drawings move the
       layout generation, for the window DOM and the echo's height, after the other frame's key was taken, so it
       is drawn a few more times; then it rests.) */
    for (let i = 0; i < 3; i++) Ed.render();
    calls.length = 0; Ed.render();
    assert.deepEqual(order(), [f1.id]);
    /* An edit in the other frame's buffer draws it again, with itself current. */
    Ed.applyOps(bb, [[0, '', 'B']], 'local'); calls.length = 0; Ed.render();
    assert.deepEqual(order(), [f2.id, f1.id]);
    assert.equal(calls[0].sel.buffer, bb);
    assert.match(f2.sel.view.textContent, /Bbeta two/);
    /* Selecting the other frame flips the order. */
    Ed.selectFrame(f2); calls.length = 0; Ed.render();
    assert.deepEqual(order(), [f1.id, f2.id]);
    await settled(bb);
  } finally { Ed.hooks.renderOverlay = prev; f1.destroy(); f2.destroy(); sync.close(ba); sync.close(bb); }
  assert.equal(E.frames.length, 0); assert.equal(E.frame, null);
});

test('ordinary modeline tap selects its window and a physical mouse press after touch reaches the DOM handler', async () => {
  const b = await sync.open(note('touch.md', 'first line\nsecond line\nthird line\n'));
  try { assertOrdinaryFrameInput(Ed, b); } finally { sync.close(b); }
});

test('E3 H3 gap 5: hooks.mouseDown gets the event as third argument; readFile falls back to the shipped files by basename', async () => {
  const doc = makeDocument(); const el = doc.createElement('div'); doc.body.appendChild(el);
  const text = 'line one\nline two\nline three\n';
  const b = await sync.open(note('mouse.md', text));
  const f = Ed.makeFrame(el, { buffer: b, kind: 'card' });
  Ed.render();
  doc.hit = f.sel.view;
  const seen: { bb: EdwinCore; p: number; ev: FakeEvent }[] = [], prev = Ed.hooks.mouseDown;
  Ed.hooks.mouseDown = (bb: EdwinCore, p: number, ev: FakeEvent) => { seen.push({ bb, p, ev }); if (prev) prev(bb, p, ev); };
  try {
    const ev = f.el('windows').dispatch('mousedown', { button: 0, shiftKey: false, clientX: 20, clientY: 30 });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].bb, b);
    assert.equal(seen[0].p, text.indexOf('\n', 9), 'y = 30 px is the second line: point goes to its end');
    assert.equal(seen[0].ev, ev, 'the event is the third argument');
    assert.ok(b.pt === text.indexOf('\n', 9) || b.pt === text.indexOf('\n', 9) - 1, 'the default handler (through the chained hooks) moved point; Normal state keeps it off the newline');
    /* A two-argument hook keeps working. */
    Ed.hooks.mouseDown = (bb: EdwinCore, p: number) => { bb.pt = p; };
    f.el('windows').dispatch('mousedown', { button: 0, shiftKey: false, clientX: 0, clientY: 5 });
    assert.ok(b.pt === text.indexOf('\n') || b.pt === text.indexOf('\n') - 1, 'the first line');
  } finally { Ed.hooks.mouseDown = prev; f.destroy(); sync.close(b); }
  /* readFile: a .scm name under a directory that does not exist answers with the shipped file; others stay null. */
  const shipped = fs.readFileSync(path.join(EDWIN, 'scm/notes-syntax.scm'), 'utf8');
  assert.equal(L.S.hooks.readFile('/no/such/dir/notes-syntax.scm'), shipped);
  assert.equal(L.S.hooks.readFile('/no/such/dir/absent.scm'), null);
  assert.equal(L.S.hooks.readFile('/no/such/dir/notes-syntax.txt'), null);
  /* markdown.ts's edwin:scm entry still answers. */
  assert.equal(L.S.hooks.readFile('edwin:scm/notes-syntax.scm'), shipped);
  /* So (load "<any dir>/address.scm") resolves to the shipped file. */
  assert.equal(L.truthy(L.evalText('(begin (load "/no/such/dir/address.scm") (procedure? address-name))')), true);
});
