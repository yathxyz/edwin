// edwin-front (server/front.mts): the floor on every request and upgrade, edwin-web from memory, and /edit as a
// line relay to a fake edwind with wb-web's close codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { start, loadConfig, CLOSE } from '../server/front.mts';
import { MAX_LINE } from '../server/proto.mts';
import type { Front, FrontConfig } from '../server/front.mts';

// ws resolves from server/, where edwind's package links its node_modules.
const { WebSocket } = createRequire(new URL('../server/front.mts', import.meta.url))('ws');

const SECRET = 'x'.repeat(48);
const ORIGIN = 'https://edwin.example';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-front-'));
const web = path.join(dir, 'web');
fs.mkdirSync(path.join(web, 'scm'), { recursive: true });
fs.writeFileSync(path.join(web, 'index.html'), '<p>console</p>');
fs.writeFileSync(path.join(web, 'scm', 'emacs.scm'), '(define x 1)');
fs.writeFileSync(path.join(web, '.hidden'), 'no');

/* A fake edwind: every line it reads comes back as `echo:LINE`; it greets each connection first. */
const sockPath = path.join(dir, 'edit.sock');
const peers = new Set<net.Socket>();
const edwind = net.createServer(s => {
  peers.add(s);
  s.on('close', () => peers.delete(s));
  s.on('error', () => {}); // the front drops connections it ends; the greeting may meet a closed peer
  s.write('{"t":"welcome"}\n');
  let buf = '';
  s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line === 'bye') s.destroy(); else if (line === 'flood') s.write(Buffer.alloc(MAX_LINE + 1, 'a')); else s.write(`echo:${line}\n`); } });
});
await new Promise<void>(r => edwind.listen(sockPath, () => r()));

const cfg = (over: Partial<FrontConfig> = {}): FrontConfig => ({
  listen: { host: '127.0.0.1', port: 0 }, publicOrigin: ORIGIN, host: 'edwin.example', trustedProxy: '127.0.0.1',
  secret: Buffer.from(SECRET), webRoot: web, editSocket: sockPath, ...over,
});
const fronts: Front[] = [];
const up = async (over?: Partial<FrontConfig>) => { const f = await start(cfg(over), () => {}); fronts.push(f); return (f.server.address() as net.AddressInfo).port; };
const port = await up();

const good = { host: 'edwin.example', 'x-edwin-proxy-secret': SECRET };
function get(p: string, headers: Record<string, string>, method = 'GET', at = port): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: at, path: p, method, headers, setHost: false }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Opened { ws: any; got: string[]; closed: Promise<{ code: number; reason: string }>; opened: Promise<void> } // any: a ws client
function open(headers: Record<string, string>, p = '/edit', at = port): Opened {
  const ws = new WebSocket(`ws://127.0.0.1:${at}${p}`, { headers, perMessageDeflate: false });
  const got: string[] = [];
  ws.on('message', (d: Buffer) => got.push(d.toString()));
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', (_req: unknown, res: http.IncomingMessage) => reject(new Error(`HTTP ${res.statusCode}`))); ws.once('error', reject); });
  const closed = new Promise<{ code: number; reason: string }>(r => ws.once('close', (code: number, reason: Buffer) => r({ code, reason: reason.toString() })));
  opened.catch(() => {});
  return { ws, got, closed, opened };
}
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

test.after(async () => { for (const f of fronts) await f.stop(); edwind.close(); for (const s of peers) s.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });

test('edwin-web from memory: the page at /, Scheme as text, no dot files, no framing', async () => {
  const root = await get('/', good);
  assert.equal(root.status, 200);
  assert.equal(root.body, '<p>console</p>');
  assert.match(root.headers['content-type']!, /^text\/html/);
  assert.equal(root.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(root.headers['x-content-type-options'], 'nosniff');
  const scm = await get('/scm/emacs.scm?v=1', good);
  assert.equal(scm.status, 200);
  assert.equal(scm.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal((await get('/.hidden', good)).status, 404);
  assert.equal((await get('/scm/../index.html', good)).status, 404);
  assert.equal((await get('/', { ...good, 'if-none-match': root.headers.etag! })).status, 304);
  assert.equal((await get('/', good, 'HEAD')).body, '');
  assert.equal((await get('/edit', good)).status, 400);
});

test('the floor: secret, Host and Origin on requests', async () => {
  assert.equal((await get('/', { host: 'edwin.example' })).status, 403, 'no secret');
  assert.equal((await get('/', { ...good, 'x-edwin-proxy-secret': 'y'.repeat(48) })).status, 403, 'wrong secret, same length');
  assert.equal((await get('/', { ...good, 'x-edwin-proxy-secret': SECRET.slice(1) })).status, 403, 'secret one short');
  assert.equal((await get('/', { ...good, host: 'evil.example' })).status, 403, 'wrong Host');
  assert.equal((await get('/', { ...good, host: 'EDWIN.example' })).status, 200, 'Host is case-insensitive');
  assert.equal((await get('/', { ...good, origin: 'https://evil.example' })).status, 403, 'a wrong Origin on GET');
  assert.equal((await get('/', good, 'POST')).status, 403, 'POST without Origin');
  assert.equal((await get('/', { ...good, origin: ORIGIN }, 'POST')).status, 405, 'POST with Origin passes the floor');
  const other = await up({ trustedProxy: '10.9.9.9' });
  assert.equal((await get('/', good, 'GET', other)).status, 403, 'not from the trusted proxy');
});

test('the floor on the upgrade: Origin required and exact', async () => {
  await assert.rejects(open(good).opened, /HTTP 403/, 'no Origin');
  await assert.rejects(open({ ...good, origin: 'https://evil.example' }).opened, /HTTP 403/, 'wrong Origin');
  await assert.rejects(open({ host: 'edwin.example', origin: ORIGIN }).opened, /HTTP 403/, 'no secret');
  await assert.rejects(open({ ...good, origin: ORIGIN }, '/other').opened, /HTTP 404/, 'only /edit upgrades');
});

test('/edit relays lines both ways, verbatim', async () => {
  const c = open({ ...good, origin: ORIGIN });
  await c.opened;
  await until(() => c.got.length === 1);
  assert.equal(c.got[0], '{"t":"welcome"}');
  c.ws.send('{"t":"hello"}');
  c.ws.send('ünïcode');
  await until(() => c.got.length === 3);
  assert.deepEqual(c.got.slice(1), ['echo:{"t":"hello"}', 'echo:ünïcode']);
  c.ws.close();
  await c.closed;
});

test('/edit: a newline in a frame or a binary frame closes with 1003', async () => {
  const a = open({ ...good, origin: ORIGIN });
  await a.opened;
  a.ws.send('one\n{"t":"injected"}');
  assert.equal((await a.closed).code, CLOSE.UNSUPPORTED);
  const b = open({ ...good, origin: ORIGIN });
  await b.opened;
  b.ws.send(Buffer.from('bin'), { binary: true });
  assert.equal((await b.closed).code, CLOSE.UNSUPPORTED);
});

test('/edit: edwind closing is 1011, edwind absent is 1013', async () => {
  const a = open({ ...good, origin: ORIGIN });
  await a.opened;
  a.ws.send('bye');
  assert.equal((await a.closed).code, CLOSE.LOST);
  const gone = await up({ editSocket: path.join(dir, 'missing.sock') });
  const b = open({ ...good, origin: ORIGIN }, '/edit', gone);
  await b.opened;
  assert.equal((await b.closed).code, CLOSE.UNAVAILABLE);
});

test('/edit: a line from edwind over MAX_LINE closes with 1009', async () => {
  const c = open({ ...good, origin: ORIGIN });
  await c.opened;
  c.ws.send('flood');
  assert.equal((await c.closed).code, CLOSE.TOO_BIG);
});

test('/edit: a stop closes open relays with 1012', async () => {
  const p = await up();
  const c = open({ ...good, origin: ORIGIN }, '/edit', p);
  await c.opened;
  await fronts.pop()!.stop();
  assert.equal((await c.closed).code, CLOSE.RESTART);
});

test('front.json: unknown fields refused, the secret read once, listen checked', () => {
  const secret = path.join(dir, 'secret');
  fs.writeFileSync(secret, SECRET + '\n');
  const write = (o: object) => { const f = path.join(dir, 'front.json'); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  const base = { listen: '10.0.0.2:8091', publicOrigin: ORIGIN, trustedProxy: '10.0.0.1', proxySecretFile: secret, webRoot: web, editSocket: sockPath };
  const c = loadConfig(write(base));
  assert.deepEqual(c.listen, { host: '10.0.0.2', port: 8091 });
  assert.equal(c.host, 'edwin.example');
  assert.equal(c.secret.toString(), SECRET);
  assert.throws(() => loadConfig(write({ ...base, extra: 1 })), /unknown field/);
  assert.throws(() => loadConfig(write({ ...base, listen: 'edwin:80' })), /listen/);
  assert.throws(() => loadConfig(write({ ...base, publicOrigin: 'https://edwin.example/' })), /publicOrigin/);
  fs.writeFileSync(secret, 'short\n');
  assert.throws(() => loadConfig(write(base)), /at least 32 bytes/);
});
