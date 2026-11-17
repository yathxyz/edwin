// JSON-RPC for language servers (src/lsp-rpc.ts): fast-check over random message streams cut into random chunks,
// cuts inside a header, its blank line and a surrogate pair included, each decoding as the whole stream does, and
// a broken stream failing at the same place with the same bodies before it; the framing's refusals (a header
// past its bound, a body past its bound, a bad, missing or doubled Content-Length, one that ends inside a
// character); requests matched by id out of order, error answers, cancellation and timeouts telling the server,
// late answers dropped, the server's requests answered, close; and a real child through Ed.proc (fake-proc.mts)
// whose own byte-level framing writes its answers a few bytes at a time.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

const require = createRequire(import.meta.url);
// fast-check is a dev dependency pinned in tools/package-lock.json (R15.1); NODE_PATH names its node_modules.
const fc = require('fast-check'); // any: fast-check's types are not resolvable from edwin/ (it lives in tools/node_modules)

const proc = fakeProc();
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc };
host.proc = proc;
const Ed: Edwin = loadEdwin(host);
const Rpc = (globalThis as unknown as { LspRpc: Edwin }).LspRpc;
const RUNS = { numRuns: Number(process.env.LSPRPC_RUNS || 1000) };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-rpc-'));
after(() => {
  for (const id of proc.running()) proc.kill(id, 'KILL');   // none, unless a test failed before its end
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* Decoding STREAM cut at CUTS (indexes into the string): the bodies, and the fault's text or null. */
function decode(stream: string, cuts: number[]) {
  const bodies: string[] = [];
  const d = Rpc.decoder((b: string) => { bodies.push(b); });
  let fault: string | null = null;
  const at = [...new Set(cuts.map(c => c % (stream.length + 1)))].sort((a, b) => a - b);
  let from = 0;
  for (const to of [...at, stream.length]) {
    try { d.push(stream.slice(from, to)); } catch (e) { fault = Ed.errorText(e); break; }
    from = to;
  }
  return { bodies, fault };
}

/* Strings from pieces that count differently in UTF-8, and pieces that look like framing. */
const piece = fc.constantFrom('a', 'é', '€', '\u{1F600}', '\r\n', '\r\n\r\n', 'Content-Length: 3\r\n\r\n', '"', '\\', '\u0000', '');
const str = fc.array(piece, { maxLength: 12 }).map((ps: string[]) => ps.join(''));
const message = fc.oneof(
  fc.record({ jsonrpc: fc.constant('2.0'), id: fc.nat(), method: str, params: fc.dictionary(str, str, { maxKeys: 3 }) }),
  fc.record({ jsonrpc: fc.constant('2.0'), method: str, params: fc.array(str, { maxLength: 4 }) }),
  fc.record({ jsonrpc: fc.constant('2.0'), id: fc.nat(), result: fc.oneof(str, fc.constant(null), fc.constant({})) }));
/* A header as servers write it: the length first or after a Content-Type, either case. */
const framing = fc.constantFrom(
  (n: number) => `Content-Length: ${n}\r\n\r\n`,
  (n: number) => `content-length:${n}\r\n\r\n`,
  (n: number) => `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${n}\r\n\r\n`);
const frame = fc.tuple(message, framing).map(([m, f]: [unknown, (n: number) => string]) => {
  const body = JSON.stringify(m);
  return { m, body, text: f(Buffer.byteLength(body)) + body };
});
/* Streams that break the framing, each after the good messages. */
const FAULTS: [string, string][] = [
  [`X-Pad: ${'a'.repeat(5000)}\r\n\r\n{}`, 'a header past 4096 bytes'],
  [`X-Pad: ${'a'.repeat(5000)}`, 'a header past 4096 bytes'],
  ['Content-Type: x\r\n\r\n{}', 'no Content-Length header'],
  ['Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}', 'two Content-Length headers'],
  ['Content-Length: -2\r\n\r\n{}', 'a Content-Length that is not a number'],
  ['Content-Length: 99999999999\r\n\r\n', 'a Content-Length that is not a number'],
  [`Content-Length: ${64 * 1024 * 1024 + 1}\r\n\r\n`, `a body of ${64 * 1024 * 1024 + 1} bytes, past ${64 * 1024 * 1024}`],
  ['Content-Length: 2\r\n\r\n"é"', 'a Content-Length that ends inside a character'],
  ['Content-Length: 3\r\n\r\n"\u{1F600}"', 'a Content-Length that ends inside a character'],
  ['Content-Length: 2\nbroken\r\n\r\n{}', 'a header line that is not NAME: VALUE'],
  ['Contént-Length: 2\r\n\r\n{}', 'a header that is not ASCII'],
];

test('any chunking of a stream decodes as the whole stream: the same bodies, the messages sent', () => {
  fc.assert(fc.property(fc.array(frame, { maxLength: 8 }), fc.array(fc.nat(), { maxLength: 30 }), (fs_: { m: unknown; body: string; text: string }[], cuts: number[]) => {
    const stream = fs_.map(f => f.text).join('');
    const whole = decode(stream, []);
    assert.equal(whole.fault, null);
    assert.deepEqual(whole.bodies, fs_.map(f => f.body));
    assert.deepEqual(whole.bodies.map(b => JSON.parse(b)), fs_.map(f => JSON.parse(JSON.stringify(f.m))));   // fast-check's records have no prototype
    assert.deepEqual(decode(stream, cuts), whole);
    /* one code unit at a time: every cut there is, both halves of a pair and the header's blank line among them */
    assert.deepEqual(decode(stream, Array.from({ length: stream.length }, (_, i) => i)), whole);
  }), RUNS);
});

test('a broken stream fails at the same place however it is cut, with every body before it and none after', () => {
  fc.assert(fc.property(fc.array(frame, { maxLength: 4 }), fc.constantFrom(...FAULTS), fc.array(frame, { maxLength: 2 }), fc.array(fc.nat(), { maxLength: 20 }),
    (before: { body: string; text: string }[], [bad, why]: [string, string], later: { text: string }[], cuts: number[]) => {
      const stream = before.map(f => f.text).join('') + bad + later.map(f => f.text).join('');
      const want = { bodies: before.map(f => f.body), fault: `The language server's output breaks its framing: ${why}` };
      assert.deepEqual(decode(stream, []), want);
      assert.deepEqual(decode(stream, cuts), want);
    }), { numRuns: Math.ceil(RUNS.numRuns / 4) });
});

test('encode counts the UTF-8 bytes of the body', () => {
  fc.assert(fc.property(message, (m: unknown) => {
    const text = Rpc.encode(m);
    const body = JSON.stringify(m);
    assert.equal(text, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }), RUNS);
  /* a lone surrogate is escaped by JSON.stringify, so a body is always well-formed */
  assert.equal(Rpc.encode({ s: '\uD800' }), 'Content-Length: 14\r\n\r\n{"s":"\\ud800"}');
});

test('an oversize header is refused at once, before its end comes, and the decoder refuses from then on', () => {
  const bodies: string[] = [];
  const d = Rpc.decoder((b: string) => { bodies.push(b); });
  d.push('Content-Length: 2\r\n\r\n{}');
  d.push('X-Pad: ' + 'a'.repeat(4000));
  assert.throws(() => d.push('a'.repeat(200)), (e: unknown) => /a header past 4096 bytes/.test(Ed.errorText(e)));
  assert.throws(() => d.push('\r\n\r\n{}'), (e: unknown) => /broke its framing: a header past 4096 bytes/.test(Ed.errorText(e)));
  assert.deepEqual(bodies, ['{}']);
  /* exactly at the bound is a header still */
  const ok: string[] = [];
  const h = 'X: ' + 'a'.repeat(4096 - 'Content-Length: 2\r\nX: '.length);
  Rpc.decoder((b: string) => { ok.push(b); }).push(`Content-Length: 2\r\n${h}\r\n\r\n{}`);
  assert.deepEqual(ok, ['{}']);
  assert.throws(() => Rpc.decoder(() => {}).push(`Content-Length: 2\r\n${h}a\r\n\r\n{}`), /header past/);
});

/* A connection whose writes are kept, decoded, in SENT. */
function pair(opts: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  const dec = Rpc.decoder((b: string) => { sent.push(JSON.parse(b)); });
  const closes: string[] = [];
  const c = Rpc.connect({ write: (t: string) => { dec.push(t); return true; }, onClose: (w: string) => { closes.push(w); }, ...opts });
  const answer = (m: unknown) => c.receive(Rpc.encode(m));
  return { c, sent, closes, answer };
}
const kind = (e: unknown) => (e as { kind: string }).kind;
const turn = () => new Promise(r => setTimeout(r, 0));

test('requests are matched by id in any order; an error answer rejects with its code; unknown and late ids are dropped', async () => {
  const { c, sent, answer } = pair();
  const a = c.request('a', { x: 1 }), b = c.request('b');
  assert.deepEqual(sent, [{ jsonrpc: '2.0', id: a.id, method: 'a', params: { x: 1 } }, { jsonrpc: '2.0', id: b.id, method: 'b' }]);
  assert.ok(b.id > a.id);
  c.notify('n', null);   // JSON-RPC's params is an array or an object, or absent
  assert.deepEqual(sent.pop(), { jsonrpc: '2.0', method: 'n' });
  answer({ jsonrpc: '2.0', id: 999, result: 'nobody' });
  answer({ jsonrpc: '2.0', id: String(b.id), result: 'a string id is not ours' });
  answer({ jsonrpc: '2.0', id: b.id, result: { y: '\u{1F600}' } });
  answer({ jsonrpc: '2.0', id: a.id, error: { code: -32602, message: 'bad params' } });
  assert.deepEqual(await b, { y: '\u{1F600}' });
  await assert.rejects(a, (e: unknown) => kind(e) === 'lsp-error' && (e as { irritants: unknown[] }).irritants[0] === -32602 && Ed.errorText(e) === 'a: bad params (-32602)');
  answer({ jsonrpc: '2.0', id: a.id, result: 'late' });
  /* a message with a method that is not a string is no response, though its id is one waiting: dropped */
  const m = c.request('m');
  answer({ jsonrpc: '2.0', id: m.id, method: 5 });
  answer({ jsonrpc: '2.0', id: m.id, method: null, result: 'not ours' });
  assert.equal(c.pending(), 1);
  answer({ jsonrpc: '2.0', id: m.id, result: 'ours' });
  assert.equal(await m, 'ours');
  const n = c.request('n');
  answer({ jsonrpc: '2.0', id: n.id });
  assert.equal(await n, null);
  /* "error": null beside a result is no error */
  const e = c.request('e');
  answer({ jsonrpc: '2.0', id: e.id, result: 5, error: null });
  assert.equal(await e, 5);
  /* not JSON, not an object: framed well, so dropped and the connection goes on */
  c.receive('Content-Length: 3\r\n\r\n{x}Content-Length: 2\r\n\r\n[]');
  assert.equal(c.closed(), null);
  assert.equal(c.pending(), 0);
});

test('cancel and a timeout reject the request, tell the server, and drop its late answer', async () => {
  const { c, sent, answer } = pair();
  const r = c.request('slow');
  r.cancel();
  await assert.rejects(r, (e: unknown) => kind(e) === 'lsp-error' && /slow: cancelled/.test(Ed.errorText(e)));
  assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: r.id } });
  answer({ jsonrpc: '2.0', id: r.id, error: { code: -32800, message: 'cancelled' } });
  r.cancel();   // a second cancel says nothing more
  assert.equal(sent.filter(m => m.method === '$/cancelRequest').length, 1);
  const t = c.request('slower', null, { timeout: 20 });
  await assert.rejects(t, (e: unknown) => kind(e) === 'timeout' && /slower: no answer from the language server in 0.02 s/.test(Ed.errorText(e)));
  assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: t.id } });
  answer({ jsonrpc: '2.0', id: t.id, result: 'late' });
  /* answered in time: its timer is gone, and no cancel is sent */
  const q = c.request('quick', null, { timeout: 20 });
  answer({ jsonrpc: '2.0', id: q.id, result: 1 });
  assert.equal(await q, 1);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(sent.filter(m => m.method === '$/cancelRequest').length, 2);
  /* none: 0, and a time past setTimeout's 2^31 - 1 ms, which the hosts would fire at once */
  const z = c.request('long', null, { timeout: 0 }), y = c.request('longer', null, { timeout: 3e9 });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(c.pending(), 2);
  z.cancel(); y.cancel();
  await assert.rejects(z); await assert.rejects(y, /longer: cancelled/);
  /* C-g: EdPool.interruptible cancels it */
  const g = c.request('waits');
  const w = (globalThis as unknown as { EdPool: Edwin }).EdPool.interruptible(g);
  Ed.feedKey('C-g');
  await assert.rejects(w, (e: unknown) => kind(e) === 'quit');
  await assert.rejects(g, /cancelled/);
  assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: g.id } });
  assert.equal(c.pending(), 0);
});

test("the server's requests are answered: by their handler, method not found, or an internal error; notifications delivered", async () => {
  const notes: [string, unknown][] = [];
  const { c, sent, answer } = pair({
    requests: { 'workspace/configuration': (p: { items: unknown[] }) => p.items.map(() => null), 'later': async () => { await turn(); return 'done'; }, 'fails': () => { throw new Error('no'); } },
    onNotification: (m: string, p: unknown) => { notes.push([m, p]); },
  });
  answer({ jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{}, {}] } });
  answer({ jsonrpc: '2.0', id: 'two', method: 'later' });
  answer({ jsonrpc: '2.0', id: 3, method: 'window/showDocument', params: {} });
  answer({ jsonrpc: '2.0', id: 4, method: 'constructor' });
  answer({ jsonrpc: '2.0', id: 5, method: '__proto__' });
  answer({ jsonrpc: '2.0', id: 6, method: 'fails' });
  answer({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///x', diagnostics: [] } });
  answer({ jsonrpc: '2.0', method: '$/progress', params: { token: 1 } });
  await turn(); await turn();
  const byId = new Map(sent.map(m => [m.id, m]));
  assert.deepEqual(byId.get(1), { jsonrpc: '2.0', id: 1, result: [null, null] });
  assert.deepEqual(byId.get('two'), { jsonrpc: '2.0', id: 'two', result: 'done' });
  for (const id of [3, 4, 5]) assert.equal((byId.get(id) as { error: { code: number } }).error.code, -32601);
  assert.deepEqual(byId.get(6), { jsonrpc: '2.0', id: 6, error: { code: -32603, message: 'Internal error: no' } });
  assert.deepEqual(notes, [['textDocument/publishDiagnostics', { uri: 'file:///x', diagnostics: [] }], ['$/progress', { token: 1 }]]);
  assert.equal(c.closed(), null);
});

test('a message that is not JSON fails alone: its request rejects, its notify throws, its answer is -32603; the connection goes on', async () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  const { c, sent, closes, answer } = pair({ requests: { q: () => circular, big: () => ({ n: 2n ** 64n }) } });
  const a = c.request('a');
  const b = c.request('b', { n: 1n }), d = c.request('d', circular);
  await assert.rejects(b, (e: unknown) => kind(e) === 'lsp-error' && Ed.errorText(e) === 'b: params that are not JSON');
  await assert.rejects(d, /d: params that are not JSON/);
  assert.throws(() => c.notify('n', { n: 1n }), /n: params that are not JSON/);
  assert.deepEqual(sent.map(m => m.method), ['a']);
  answer({ jsonrpc: '2.0', id: 7, method: 'q' });
  answer({ jsonrpc: '2.0', id: 8, method: 'big' });
  await turn(); await turn();
  for (const id of [7, 8])
    assert.deepEqual(sent.find(m => m.id === id), { jsonrpc: '2.0', id, error: { code: -32603, message: 'Edwin answered with a result that is not JSON' } });
  assert.equal(c.closed(), null);
  assert.deepEqual(closes, []);
  assert.equal(c.pending(), 1);
  answer({ jsonrpc: '2.0', id: a.id, result: 1 });
  assert.equal(await a, 1);
});

test('close, a broken stream and closed input reject every waiting request, once, and nothing more is sent', async () => {
  const { c, sent, closes } = pair();
  const a = c.request('a'), b = c.request('b', null, { timeout: 50 });
  c.close('the server ended');
  await assert.rejects(a, (e: unknown) => kind(e) === 'lsp-error' && Ed.errorText(e) === 'a: the server ended');
  await assert.rejects(b, /b: the server ended/);
  c.close('again');
  assert.deepEqual(closes, ['the server ended']);
  const n = sent.length;
  await assert.rejects(c.request('c'), /c: the server ended/);
  assert.throws(() => c.notify('n'), /n: the server ended/);
  await new Promise(r => setTimeout(r, 70));   // b's timer was cleared: no cancel goes out
  assert.equal(sent.length, n);

  const s = pair();
  const w = s.c.request('w');
  s.c.receive('Content-Length: x\r\n\r\n');
  await assert.rejects(w, /w: The language server's output breaks its framing: a Content-Length that is not a number/);
  assert.equal(s.closes.length, 1);
  s.c.receive(Rpc.encode({ jsonrpc: '2.0', id: w.id, result: 1 }));   // ignored

  let open = true;
  const closes2: string[] = [];
  const c3 = Rpc.connect({ write: () => open, onClose: (w: string) => { closes2.push(w); } });
  c3.notify('fine');
  open = false;
  await assert.rejects(c3.request('x'), /x: The language server's input is closed/);
  assert.deepEqual(closes2, ["The language server's input is closed"]);
  const c4 = Rpc.connect({ write: () => { throw new Error('process 1 has not taken the 64 MiB already sent to it'); } });
  await assert.rejects(c4.request('y'), /input is closed/);

  /* closed partway through a chunk: the rest of that chunk is neither delivered nor answered */
  const log: string[] = [];
  const c5 = Rpc.connect({ write: (t: string) => { log.push('sent'); return true; }, onClose: (w: string) => { log.push('close ' + w); },
    requests: { r: () => { log.push('handler'); } },
    onNotification: (m: string) => { log.push('note ' + m); if (m === 'a') c5.close('bye'); } });
  c5.receive(['a', 'b'].map(m => Rpc.encode({ jsonrpc: '2.0', method: m })).join('') + Rpc.encode({ jsonrpc: '2.0', id: 1, method: 'r' }));
  await turn();
  assert.deepEqual(log, ['note a', 'close bye']);
  log.length = 0;
  const c6 = Rpc.connect({ write: () => false, onClose: () => { log.push('close'); }, onNotification: (m: string) => { log.push('note ' + m); } });
  c6.receive(Rpc.encode({ jsonrpc: '2.0', id: 1, method: 'unknown' }) + Rpc.encode({ jsonrpc: '2.0', method: 'after' }));
  assert.deepEqual(log, ['close']);
});

/* A stand-in language server: its own framing over bytes (Buffer), independent of lsp-rpc.ts. It answers echo
   with its params, asks the client workspace/configuration and reports the answer in a notification, and ends on
   exit. Each of its writes is a few bytes, so characters are cut across the client's chunks. */
const FAKE_SERVER = `
let buf = Buffer.alloc(0);
const out = [];
function send(m) {
  const body = Buffer.from(JSON.stringify(m));
  const all = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]);
  for (let i = 0; i < all.length; i += 3) out.push(all.subarray(i, i + 3));
  pump();
}
let pumping = false;
function pump() {
  if (pumping) return; pumping = true;
  const next = () => { const b = out.shift(); if (!b) { pumping = false; return; } process.stdout.write(b, () => setImmediate(next)); };
  next();
}
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1]);
    if (buf.length < end + 4 + n) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + n).toString('utf8'));
    buf = buf.subarray(end + 4 + n);
    if (m.method === 'echo') send({ jsonrpc: '2.0', id: m.id, result: m.params });
    else if (m.method === 'ask') send({ jsonrpc: '2.0', id: 'q1', method: 'workspace/configuration', params: { items: [{ section: 'x' }] } }), send({ jsonrpc: '2.0', id: m.id, result: 'asked' });
    else if (m.id === 'q1') send({ jsonrpc: '2.0', method: 'told', params: m.result });
    else if (m.method === 'exit') { const wait = () => out.length || pumping ? setTimeout(wait, 5) : process.exit(0); wait(); }
  }
});
`;

test('over a real child through Ed.proc: requests, the server asking, notifications, characters cut across chunks', async () => {
  const script = path.join(tmp, 'server.cjs');
  fs.writeFileSync(script, FAKE_SERVER);
  const notes: [string, unknown][] = [];
  let conn: Edwin = null;
  const p = Ed.proc.spawn([process.execPath, script], { onOut: (s: string) => conn.receive(s) });
  conn = Rpc.connect({
    write: (t: string) => p.write(t),
    requests: { 'workspace/configuration': (params: { items: unknown[] }) => params.items.map(() => ({ answer: 'é€\u{1F600}' })) },
    onNotification: (m: string, params: unknown) => { notes.push([m, params]); },
  });
  const text = 'x\u{1F600}é€\r\n\r\nContent-Length: 1'.repeat(50);
  const results = await Promise.all([conn.request('echo', { text }), conn.request('echo', [1, 'two']), conn.request('ask')]);
  assert.deepEqual(results, [{ text }, [1, 'two'], 'asked']);
  const until = Date.now() + 5000;
  while (!notes.length && Date.now() < until) await turn();
  assert.deepEqual(notes, [['told', [{ answer: 'é€\u{1F600}' }]]]);
  conn.notify('exit');
  const x = await p.exit;
  conn.close('the server ended');
  assert.equal(x.code, 0);
  assert.equal(conn.pending(), 0);
  assert.deepEqual(proc.running(), []);
});
