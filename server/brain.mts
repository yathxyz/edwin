// brain as edwind talks to it (docs/steps.md, "Nodes from brain").
//
// brainRequest is the one way a request to brain is made; the note projector (projector.mts) writes with it.
//
// The commands here are how a frame reads brain: Edwin finds a node by name, opens it and lists what links to
// it by asking edwind, which holds the token, so no frame ever does.
//   brain-titles {q, kind?, limit?}  -> brain's GET /v1/titles answer: {results: [{id, kind, title, alias, scope,
//                                       org_id, path, updated_at}]}
//   brain-node REF                   -> brain's GET /v1/nodes/REF answer: the node, its identifiers and its links
// They use brain.readCredential, a token brain takes on its GET routes only (brain's `readOnly`), and answer
// with the condition brain-unavailable when there is none or brain cannot be reached, and brain-refused with
// brain's own words when it says no. Every client of the socket may call them, as every client may read every
// note file: what that token is cleared for is what a process that can open the socket can read.
//
// A token is a LoadCredential file, read for each request and never logged; neither is what was asked for
// (R15.10). Plain http goes only to this host: loopback, or an address the request can be bound to leave from.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Credential, isLoopback, readSecret } from './models.mts';
import type { Server, Log } from './main.mts';
import type { CallResult } from './proto.mts';

export interface BrainAnswer { status: number; text: string; cut: boolean }
export interface BrainRequest {
  method: 'GET' | 'POST'; body?: Buffer; timeoutMs: number;
  /* How much of the answer is kept; `cut` says there was more. */
  maxBytes: number;
  /* Told the request while it is in flight and null when it is over, so its owner can abandon it. */
  track?: (req: http.ClientRequest | null) => void;
}
export function brainRequest(u: URL, credential: Credential, o: BrainRequest): Promise<BrainAnswer> {
  return new Promise((resolve, reject) => {
    /* Plain http only to this host. Off loopback, the request leaves from the address it goes to, and the
       kernel binds a socket only to an address this host holds: the check is the connection itself. */
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const local = u.protocol === 'http:' && !isLoopback(u.href);
    if (local && !net.isIP(host)) { reject(new Error(`plain http only to this host: ${host} must be one of its addresses, as a number`)); return; }
    const token = readSecret(credential);
    if (!token) { reject(new Error(`the credential ${credential.name} is not readable`)); return; }
    const track = o.track || (() => {});
    const headers: Record<string, string | number> = { authorization: `Bearer ${token}` };
    if (o.body) { headers['content-type'] = 'application/json'; headers['content-length'] = o.body.length; }
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: o.method, timeout: o.timeoutMs, ...(local ? { localAddress: host } : {}), headers }, res => {
      const chunks: Buffer[] = [];
      let size = 0, cut = false;
      res.on('data', (d: Buffer) => { if (size < o.maxBytes) { chunks.push(d); size += d.length; } else cut = true; });
      res.on('end', () => { track(null); resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).subarray(0, o.maxBytes).toString(), cut: cut || size > o.maxBytes }); });
      res.on('error', e => { track(null); reject(e); });
    });
    track(req);
    req.on('timeout', () => req.destroy(new Error('brain did not answer in time')));
    req.on('error', (e: NodeJS.ErrnoException) => { track(null); reject(local && e.code === 'EADDRNOTAVAIL' ? new Error(`plain http only to this host, and ${host} is not an address of it`) : e); });
    req.end(o.body);
  });
}

const READ_TIMEOUT_MS = 15 * 1000;
/* A node with a long body and many links fits; an answer past this is not one a frame should be sent. */
const READ_BYTES = 4 * 1024 * 1024;
const KIND = /^[a-z][a-z0-9_-]{0,40}$/;
const failed = (condition: string, report: string): CallResult => ({ error: { condition, report, restarts: [], backtrace: [] } });

export class BrainReader {
  declare log: Log; declare base: URL; declare credential: Credential | null;
  declare open: Set<http.ClientRequest>;
  constructor(server: Server) {
    const cfg = server.cfg.brain;
    this.log = server.log; this.open = new Set();
    this.base = new URL(cfg ? (cfg.url.endsWith('/') ? cfg.url : cfg.url + '/') : 'http://localhost/');
    this.credential = cfg && cfg.readCredential ? new Credential(cfg.readCredential, this.base.origin) : null;
  }
  async get(what: string, route: string, query: Record<string, string>): Promise<CallResult> {
    if (!this.credential) return failed('brain-unavailable', 'This edwind has no brain to read (brain.readCredential is not set)');
    const u = new URL(route, this.base);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const t = Date.now();
    let mine: http.ClientRequest | null = null;
    let a: BrainAnswer;
    try {
      a = await brainRequest(u, this.credential, { method: 'GET', timeoutMs: READ_TIMEOUT_MS, maxBytes: READ_BYTES,
        track: r => { if (r) { mine = r; this.open.add(r); } else if (mine) this.open.delete(mine); } });
    } catch (e) {
      this.log.warn('brain-read', { what, error: String((e as Error).message || e) });
      return failed('brain-unavailable', `brain cannot be reached: ${(e as Error).message || e}`);
    }
    this.log.debug('brain-read', { what, status: a.status, ms: Date.now() - t });
    let answer: unknown = null;
    if (!a.cut) try { answer = JSON.parse(a.text); } catch (e) { /* not brain's JSON */ }
    if (a.status >= 200 && a.status < 300 && answer && typeof answer === 'object') return { value: answer };
    const said = answer && typeof answer === 'object' && typeof (answer as { error?: unknown }).error === 'string' ? (answer as { error: string }).error : null;
    if (said && a.status >= 400 && a.status < 500) return failed('brain-refused', `brain: ${said}`);
    this.log.warn('brain-read', { what, status: a.status, cut: a.cut });
    return failed('brain-unavailable', a.cut ? 'brain\'s answer is too long to show' : `brain answered ${a.status}`);
  }
  titles(a: Record<string, unknown>): Promise<CallResult> {
    const q = typeof a.q === 'string' ? a.q.slice(0, 200) : '';
    const query: Record<string, string> = { q, limit: String(Number.isInteger(a.limit) ? Math.max(1, Math.min(200, a.limit as number)) : 50) };
    if (typeof a.kind === 'string' && KIND.test(a.kind)) query.kind = a.kind;
    return this.get('titles', 'v1/titles', query);
  }
  async node(ref: unknown): Promise<CallResult> {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 300) return failed('wrong-type-argument', 'brain-node: a node id or scheme:value');
    return this.get('node', 'v1/nodes/' + encodeURIComponent(ref.trim()), {});
  }
  stop() { for (const r of this.open) r.destroy(); this.open.clear(); }
}

let reader: BrainReader | null = null;
export async function install(server: Server): Promise<void> {
  const r = reader = new BrainReader(server);
  server.defineCommand('brain-titles', (_client, args) => r.titles(args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : {}));
  server.defineCommand('brain-node', (_client, args) => r.node(args[0]));
}
export async function shutdown(): Promise<void> { if (reader) reader.stop(); reader = null; }
export const name = 'brain';
