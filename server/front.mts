// edwin-front: Edwin in a browser on its own origin. It serves edwin-web (the console page, the frame runtime and
// its Scheme) from memory and relays `/edit` to edwind's socket: one browser WebSocket to one edit.sock connection,
// each text frame one line and each line one text frame, nothing parsed (the page sends `hello` itself). It is
// wb-web's `/edit` without the rest of Workbench, and it holds the same floor, since a frame can run Scheme as the
// edwind user:
//
//   - the peer is the trusted proxy, the request target is origin-form, and the proxy's secret header (exactly
//     one, compared in constant time) and the Host (exactly one, the public origin's) are present on every request;
//   - an upgrade or any method but GET and HEAD carries exactly one Origin, the public origin: the proxy's login
//     cookie rides on cross-site WebSocket upgrades, so without it any page could open the editor.
//
// Close codes, in the order they are checked: a failed connect is 1013; a binary frame or a text frame holding a
// newline is 1003; a frame or a line over MAX_LINE is 1009; edwind closing its end is 1011; edwin-front stopping is
// 1012; a browser silent for WS_DEAD_MS is 1001.
//
//   edwin-front --config front.json
//
// Logging: one line per event, never a header value, a path's query or a message.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { LineReader, MAX_LINE } from './proto.mts';

const ROUTE = '/edit';
const SECRET_HEADER = 'x-edwin-proxy-secret';
const CONNECT_TIMEOUT_MS = 5000;
export const WS_PING_MS = 25_000;
export const WS_DEAD_MS = 60_000;
/* Queued bytes past which one side stops reading from the other until the queue drains. */
const HIGH_WATER = 4 * 1024 * 1024;
const FILE_MAX = 32 << 20;
const TOTAL_MAX = 128 << 20;
const DEPTH_MAX = 16;
const LISTEN = /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):([0-9]{1,5})$/;

export const CLOSE = { GOING_AWAY: 1001, UNSUPPORTED: 1003, TOO_BIG: 1009, LOST: 1011, RESTART: 1012, UNAVAILABLE: 1013 } as const;

export interface FrontConfig {
  listen: { host: string; port: number };
  publicOrigin: string;
  /* The authority of publicOrigin, lowercase. */
  host: string;
  trustedProxy: string;
  secret: Buffer;
  webRoot: string;
  editSocket: string;
}

const FIELDS = new Set(['listen', 'publicOrigin', 'trustedProxy', 'proxySecretFile', 'webRoot', 'editSocket']);

/* front.json: unknown fields refused, every field required. The secret is read here, once. */
export function loadConfig(file: string): FrontConfig {
  let cfg: any; // any: front.json as parsed, checked field by field below
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file}: not an object`);
  for (const k of Object.keys(cfg)) if (!FIELDS.has(k)) throw new Error(`${file}: unknown field ${JSON.stringify(k)}`);
  for (const k of FIELDS) if (typeof cfg[k] !== 'string' || !cfg[k]) throw new Error(`${file}: ${k} is required (a string)`);
  for (const k of ['proxySecretFile', 'webRoot', 'editSocket']) if (!path.isAbsolute(cfg[k])) throw new Error(`${file}: ${k} must be an absolute path`);
  if (Buffer.byteLength(cfg.editSocket) >= 108) throw new Error(`${file}: editSocket is too long for a socket path (108 bytes)`);
  const m = String(cfg.listen).match(LISTEN);
  if (!m || !net.isIP(m[1] || m[2]) || Number(m[3]) < 1 || Number(m[3]) > 65535) throw new Error(`${file}: listen must be ADDRESS:PORT`);
  if (!net.isIP(cfg.trustedProxy)) throw new Error(`${file}: trustedProxy must be an IP address`);
  let u: URL;
  try { u = new URL(cfg.publicOrigin); } catch (e) { throw new Error(`${file}: publicOrigin is not a URL`); }
  /* What a browser sends as Origin: scheme://host[:port], no path, no default port. */
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== cfg.publicOrigin)
    throw new Error(`${file}: publicOrigin must be scheme://host[:port] as a browser sends it`);
  const secret = Buffer.from(fs.readFileSync(cfg.proxySecretFile, 'utf8').trim(), 'utf8');
  if (secret.length < 32) throw new Error(`${file}: the proxy secret must be at least 32 bytes`);
  return {
    listen: { host: m[1] || m[2], port: Number(m[3]) }, publicOrigin: u.origin, host: u.host.toLowerCase(),
    trustedProxy: canonicalIp(cfg.trustedProxy), secret, webRoot: cfg.webRoot, editSocket: cfg.editSocket,
  };
}

const canonicalIp = (ip: string) => (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip).toLowerCase();

/* ---------- the floor ---------- */
export type Deny = 'source' | 'target' | 'secret' | 'host' | 'origin';

const one = (req: IncomingMessage, name: string): string | undefined => { const v = req.headersDistinct[name]; return v && v.length === 1 ? v[0] : undefined; };

export function check(cfg: FrontConfig, req: IncomingMessage): Deny | null {
  if (canonicalIp(req.socket.remoteAddress || '') !== cfg.trustedProxy) return 'source';
  if (!req.url || !req.url.startsWith('/')) return 'target';
  const secret = one(req, SECRET_HEADER);
  if (secret === undefined) return 'secret';
  const got = Buffer.from(secret, 'utf8');
  /* timingSafeEqual is constant time for equal lengths; the length is not secret. */
  if (got.length !== cfg.secret.length || !crypto.timingSafeEqual(got, cfg.secret)) return 'secret';
  const host = one(req, 'host');
  if (host === undefined || host.toLowerCase() !== cfg.host) return 'host';
  const required = req.headers.upgrade !== undefined || (req.method !== 'GET' && req.method !== 'HEAD');
  const origins = req.headersDistinct.origin;
  if (!origins) return required ? 'origin' : null;
  return origins.length === 1 && origins[0] === cfg.publicOrigin ? null : 'origin';
}

/* ---------- edwin-web, from memory ---------- */
interface Asset { body: Buffer; etag: string; ctype: string }
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.scm': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/* Every file under ROOT by its URL path, symlinks followed, dot files skipped; `/` and every `<dir>/` with an
   index.html is that file. Requests are looked up by exact path, so there is no decoding and no traversal. */
export function loadAssets(root: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  let total = 0;
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > DEPTH_MAX) throw new Error(`webRoot is nested deeper than ${DEPTH_MAX} directories at ${dir}`);
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const file = path.join(dir, name), key = `${prefix}/${name}`, st = fs.statSync(file);
      if (st.isDirectory()) { walk(file, key, depth + 1); continue; }
      if (!st.isFile()) continue;
      if (st.size > FILE_MAX) throw new Error(`${file} is larger than 32 MiB`);
      const body = fs.readFileSync(file);
      if ((total += body.length) > TOTAL_MAX) throw new Error('webRoot holds more than 128 MiB');
      const etag = '"' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 32) + '"';
      assets.set(key, { body, etag, ctype: TYPES[path.extname(name)] || 'application/octet-stream' });
    }
  };
  walk(root, '', 0);
  if (!assets.has('/index.html')) throw new Error(`webRoot ${root} has no index.html`);
  for (const [key, a] of [...assets]) if (key.endsWith('/index.html')) assets.set(key.slice(0, -'index.html'.length), a);
  return assets;
}

const HEADERS = {
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // The editor runs Scheme as the edwind user: no page may frame it.
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

function serve(assets: Map<string, Asset>, req: IncomingMessage, res: ServerResponse) {
  const p = req.url!.split('?', 1)[0];
  if (p === ROUTE) { res.writeHead(400, HEADERS).end('websocket upgrade required\n'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...HEADERS, allow: 'GET, HEAD' }).end(); return; }
  const a = assets.get(p);
  if (!a) { res.writeHead(404, HEADERS).end('not found\n'); return; }
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some(t => { t = t.trim(); return t === '*' || t === a.etag || t === 'W/' + a.etag; })) { res.writeHead(304, { ...HEADERS, etag: a.etag }).end(); return; }
  res.writeHead(200, { ...HEADERS, 'content-type': a.ctype, 'content-length': a.body.length, etag: a.etag });
  res.end(req.method === 'HEAD' ? undefined : a.body);
}

/* ---------- /edit ---------- */
type Log = (event: string, fields?: Record<string, unknown>) => void;

/* Relay WS to a fresh edit.sock connection; returns what ends it from outside (a stop). */
function relay(cfg: FrontConfig, ws: WebSocket, log: Log): (code: number, reason: string) => void {
  /* Nothing is read from the browser until edwind has accepted: its frames wait in the socket. */
  ws.pause();
  let up: net.Socket | null = null, ended = false, seen = Date.now();
  const end = (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    clearInterval(ping);
    clearTimeout(timer);
    sock.destroy();
    /* A paused ws would not read the browser's close frame, and the handshake would wait out ws's timeout. */
    ws.resume();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
    log('close', { code });
  };
  const ping = setInterval(() => {
    if (Date.now() - seen >= WS_DEAD_MS) end(CLOSE.GOING_AWAY, 'no answer');
    else ws.ping();
  }, WS_PING_MS);
  /* Any frame from the browser counts as an answer, a pong as well. */
  ws.on('pong', () => { seen = Date.now(); });
  ws.on('ping', () => { seen = Date.now(); });
  ws.on('close', () => { ended = true; clearInterval(ping); clearTimeout(timer); sock.destroy(); });
  /* ws reports a frame over maxPayload (and invalid UTF-8) as an error and closes with 1009 (1007) itself. */
  ws.on('error', e => { log('ws-error', { code: (e as NodeJS.ErrnoException).code }); });

  const sock = net.createConnection(cfg.editSocket);
  const timer = setTimeout(() => end(CLOSE.UNAVAILABLE, 'edwind did not accept the connection'), CONNECT_TIMEOUT_MS);
  sock.on('error', e => { if (!up) { log('connect-failed', { code: (e as NodeJS.ErrnoException).code }); end(CLOSE.UNAVAILABLE, 'edwind is not running'); } });
  sock.once('connect', () => {
    clearTimeout(timer);
    if (ended) return;
    up = sock;
    const lines = new LineReader(line => {
      if (ended) return;
      ws.send(line, () => { if (!ended && sock.isPaused() && ws.bufferedAmount < HIGH_WATER) sock.resume(); });
      if (ws.bufferedAmount >= HIGH_WATER) sock.pause();
    }, () => end(CLOSE.TOO_BIG, 'line too long'));
    sock.on('data', chunk => lines.push(chunk));
    sock.on('close', () => end(CLOSE.LOST, 'edwind connection lost'));
    sock.on('drain', () => { if (!ended) ws.resume(); });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      seen = Date.now();
      if (ended) return;
      if (isBinary) return end(CLOSE.UNSUPPORTED, 'binary frames are not accepted');
      if (data.includes(10)) return end(CLOSE.UNSUPPORTED, 'a frame must hold one line without a newline');
      if (!sock.write(Buffer.concat([data, Buffer.from('\n')]))) ws.pause();
    });
    ws.resume();
  });
  return end;
}

/* ---------- the server ---------- */
export interface Front { server: http.Server; stop(): Promise<void> }

export function start(cfg: FrontConfig, log: Log): Promise<Front> {
  const assets = loadAssets(cfg.webRoot);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINE, perMessageDeflate: false, clientTracking: false });
  const stops = new Map<WebSocket, (code: number, reason: string) => void>();
  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    const deny = check(cfg, req);
    if (deny) { log('deny', { why: deny }); res.writeHead(403, HEADERS).end('forbidden\n'); return; }
    serve(assets, req, res);
  });
  const refuse = (socket: Duplex, status: string) => { socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); };
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const deny = check(cfg, req);
    if (deny) { log('deny', { why: deny, upgrade: true }); return refuse(socket, '403 Forbidden'); }
    if (req.url!.split('?', 1)[0] !== ROUTE) return refuse(socket, '404 Not Found');
    wss.handleUpgrade(req, socket, head, ws => {
      log('open');
      stops.set(ws, relay(cfg, ws, log));
      ws.on('close', () => stops.delete(ws));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.listen.port, cfg.listen.host, () => {
      server.off('error', reject);
      log('listen', { address: cfg.listen.host, port: (server.address() as net.AddressInfo).port, assets: assets.size });
      resolve({
        server,
        stop: () => new Promise(done => {
          for (const stop of stops.values()) stop(CLOSE.RESTART, 'edwin-front restarting');
          server.close(() => done());
          server.closeIdleConnections();
        }),
      });
    });
  });
}

const makeLog = (): Log => (event, fields) => { process.stderr.write(`edwin-front ${event} ${JSON.stringify(fields || {})}\n`); };

export async function main(argv: string[]): Promise<number | undefined> {
  if (argv.length !== 2 || argv[0] !== '--config') { process.stderr.write('usage: edwin-front --config PATH\n'); return 2; }
  const log = makeLog();
  let front: Front;
  try { front = await start(loadConfig(argv[1]), log); } catch (e) { process.stderr.write(`edwin-front: ${e.message}\n`); return 1; }
  const quit = () => { front.stop().then(() => process.exit(0)); };
  process.once('SIGTERM', quit);
  process.once('SIGINT', quit);
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { if (code !== undefined) process.exit(code); });
}
