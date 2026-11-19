// Agent sessions through the mesh HTTP API, never through ACP or the process hub socket (Step AS1).
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomId } from './journal.mts';
import { sha256 } from './files.mts';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { diffOps } from './watch.mts';
import { Transcript, TranscriptPinLimitError } from './agent-transcript.mts';
import type { TranscriptReply } from './agent-transcript.mts';
import type { SchemeGen } from './threads.mts';
import { installPrompts } from './agent-prompts.mts';
import type { Server, SchemeValue } from './main.mts';
import type { SBuf } from './buffers.mts';
import type { CallResult } from './proto.mts';

type Json = Record<string, any>; // any: verbatim hub JSON; unknown ACP variants remain inspectable
export interface AgentHubConfig { url: string; tokenFile: string; allowCleartext?: boolean; steer?: boolean }
export interface AgentBackend {
  readonly requestBodyLimit: number;
  request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown, beforeDispatch?: () => void): Promise<Json>;
  clean<T>(value: T): T;
  cleanDiagnostic(text: string): string;
  requireSession(sid: string, epoch?: number): Promise<Json>;
  open(sid: string): Promise<string>;
  promptBlocks(sid: string, seq: number, epoch: number): Promise<unknown[]>;
}
const modules = new WeakMap<Server, AgentSessions>();
const fail = (report: string, condition = 'agent-hub-error'): CallResult => ({ error: { condition, report, restarts: [], backtrace: [] } });
const validSid = (sid: unknown): sid is string => typeof sid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sid);
const sidOf = (sid: unknown): string => { if (!validSid(sid)) throw new Error('Invalid agent session id'); return sid; };
const cursorOf = (n: unknown): number => {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Invalid agent journal cursor');
  return n;
};
const line = (x: unknown) => String(x ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const modelOf = (options: unknown): string => {
  if (!Array.isArray(options)) return '';
  const option = options.find(o => o && (o.category === 'model' || o.id === 'model'));
  return typeof option?.currentValue === 'string' ? option.currentValue : '';
};
const modelName = (value: unknown): string => {
  const name = line(value).replace(/\s+/g, ' ').trim();
  return name.toLowerCase() === 'unknown' ? '' : name;
};
const listColumns = [
  { key: 'sid', label: 'SESSION', cap: 18 }, { key: 'waiting', label: 'WAIT', cap: 4 },
  { key: 'state', label: 'STATE', cap: 10 }, { key: 'harness', label: 'HARNESS', cap: 12 },
  { key: 'model', label: 'MODEL', cap: 20 }, { key: 'host', label: 'HOST', cap: 16 },
  { key: 'project', label: 'PROJECT', cap: 24 }, { key: 'activity', label: 'ACTIVITY', cap: 48 }
] as const;
const cell = (value: unknown, cap: number, charWidth: (cp: number) => number): string => {
  const text = line(value).replace(/\s+/g, ' ').trim();
  let width = 0, at = 0, keep = 0;
  for (const ch of text) {
    const next = width + charWidth(ch.codePointAt(0)!);
    if (next > cap) return text.slice(0, keep) + '…';
    width = next; at += ch.length;
    if (width < cap) keep = at;
  }
  return text;
};
const RESPONSE_LIMIT = 32 * 1024 * 1024, SSE_LIMIT = 1024 * 1024, JOURNAL_READS = 4;
const JOURNAL_WAITERS = 64, REGISTRY_LIMIT = 1024, EPOCH_READS = 3;
const REGISTRY_FULL = 'Agent hub registry exceeds the 1024-record limit';
const SSE_OVERSIZE = 'Agent hub SSE event exceeds the 1 MiB limit';
const retryDelay = (attempt: number) => Math.min(5000, 250 * 2 ** Math.min(attempt, 5));
class EpochDisagreement extends Error {
  constructor() { super('Agent journal and registry epochs disagree; backing off'); }
}
function storeRecord(map: Map<string, Json>, id: string, value: Json) {
  if (map.size >= REGISTRY_LIMIT && !map.has(id)) throw new Error(REGISTRY_FULL);
  map.set(id, value);
}
const replaced = () => new Error('Agent session was replaced (stale incarnation); refresh and explicitly select it again');
const expectedEpoch = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw replaced();
  return value;
};
type PresentationPatch = { start: number; remove: number; text: string; previousHead: number; previousEpoch: number };
const loopbackHost = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);

export function validateAgentHub(value: unknown): AgentHubConfig {
  const c = value as Partial<AgentHubConfig>;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['url', 'tokenFile', 'allowCleartext', 'steer'].includes(k))) throw new Error('Invalid agentHub configuration fields');
  if (c.steer !== undefined && typeof c.steer !== 'boolean') throw new Error('agentHub.steer must be a boolean');
  if (c.allowCleartext !== undefined && typeof c.allowCleartext !== 'boolean') throw new Error('agentHub.allowCleartext must be a boolean');
  let u: URL; try { u = new URL(c.url!); } catch { throw new Error('agentHub.url must be an HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || /[?#]/.test(u.href)) throw new Error('agentHub.url must be HTTP or HTTPS without credentials, query or fragment');
  if (u.protocol !== 'https:' && !loopbackHost(u.hostname) && !c.allowCleartext) throw new Error('agentHub.url requires HTTPS outside loopback; allowCleartext is only for an encrypted private network');
  if (typeof c.tokenFile !== 'string' || !path.isAbsolute(c.tokenFile)) throw new Error('agentHub.tokenFile must be an absolute path');
  return { url: u.href.replace(/\/$/, ''), tokenFile: c.tokenFile, allowCleartext: c.allowCleartext === true, steer: c.steer === true };
}
type RetryQueue = Map<string, NodeJS.Timeout>;
type SessionView = { opening: number; opened: boolean };
export class AgentSessions implements AgentBackend {
  readonly requestBodyLimit = 1024 * 1024;
  declare server: Server; declare config: AgentHubConfig | undefined;
  declare sessions: Map<string, Json>; declare observed: Map<string, Json>;
  declare status: string; declare info: Json; declare stopped: boolean;
  declare stream: http.ClientRequest | null; declare requests: Set<http.ClientRequest>;
  private loopbackAgent?: http.Agent;
  declare reconnect: NodeJS.Timeout | undefined; declare generation: number;
  reconnectAttempt = 0;
  declare listOpened: boolean;
  private openingLists = 0;
  listGeneration = 0;
  listDirty = false;
  listJob?: Promise<void>;
  exitedExpanded = false;
  publications = new Map<string, Promise<SBuf>>();
  views = new Map<string, SessionView>();
  retries: RetryQueue = new Map();
  factRetries: RetryQueue = new Map();
  replayErrors = new Map<string, string>();
  journalActive = 0;
  journalWaiters: (() => void)[] = [];
  offKill: () => void;
  transcripts = new Map<string, Transcript>();
  replaying = new Map<string, Promise<void>>();
  openedObserved = new Set<string>();
  announced = new Set<string>();
  stopPrompts?: () => Promise<void>;
  facts = new Map<string, { epoch: number; head: number; model: string }>();
  factReads = new Map<string, Promise<void>>();
  hubStatus = 'unknown';
  streamActive = false;
  registryRevision = 0;
  #secrets = new Set<string>();
  constructor(server: Server) {
    this.server = server; this.config = server.cfg.agentHub; this.sessions = new Map(); this.observed = new Map();
    this.status = this.config ? 'connecting' : 'unconfigured'; this.info = {}; this.stopped = false;
    this.stream = null; this.requests = new Set(); this.generation = 0; this.listOpened = false;
    this.offKill = server.buffers.on('killed', sb => this.killed(sb.id));
  }
  clean<T>(value: T): T {
    if (value === undefined) return value;
    const redact = (s: string) => { for (const token of this.#secrets) s = s.split(token).join('[redacted]'); return s; };
    return typeof value === 'string' ? redact(value) as T : JSON.parse(redact(JSON.stringify(value))) as T;
  }
  cleanDiagnostic(text: string): string {
    return this.clean(this.config ? text.replaceAll(this.config.tokenFile, '[redacted]') : text);
  }
  // Presentation offsets remain valid even when a secret only appears after text chunks are assembled.
  redactText(value: string): string {
    for (const token of this.#secrets) value = value.split(token).join('[redacted]'.padEnd(token.length, ' '));
    return value;
  }
  token(): string {
    if (!this.config) throw new Error('No agent hub configured');
    let token: string; try { token = this.server.auth.agent!.readCredential().trimEnd(); } catch { throw new Error('Agent hub token file is not readable'); }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Agent hub token file must contain 64 lowercase hexadecimal characters');
    this.#secrets.add(token); return token;
  }
  private apiURL(route: string): URL {
    if (!this.config) throw new Error('No agent hub configured');
    // Inspect the spelling before URL normalization: encoded separators, dot segments, absolute
    // addresses and fragments are never part of this API. Check the resolved destination too.
    const match = /^(?:info|stream|(?:sessions|observed)(?:\/([A-Za-z0-9_-]+)(?:\/[a-z_]+)?)?)(?:\?(?:forget=true|since=(\d+)))?$/.exec(route);
    if (!match) throw new Error('Invalid agent API route');
    if (match[1]) sidOf(match[1]);
    if (match[2]) cursorOf(Number(match[2]));
    const base = new URL(this.config.url + '/v1/'), u = new URL(route, base);
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) throw new Error('Agent route outside the configured API prefix');
    return u;
  }
  private connect(u: URL, method: string, headers: http.OutgoingHttpHeaders, receive: (res: http.IncomingMessage) => void, timeout?: number) {
    const options: http.RequestOptions = { method, headers, timeout };
    if (u.protocol === 'https:') return https.request(u, options, receive);
    if (loopbackHost(u.hostname)) {
      // Bypass the process-wide agent (which may use an environment proxy) and DNS for
      // loopback HTTP. Only the socket destination changes, never the API origin or Host.
      options.agent = this.loopbackAgent ??= new http.Agent({ keepAlive: true, timeout: 5000 });
      if (u.hostname === 'localhost') { options.hostname = '127.0.0.1'; headers.host = u.host; }
    }
    return http.request(u, options, receive);
  }
  async request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown, beforeDispatch?: () => void): Promise<Json> {
    const u = this.apiURL(route), token = this.token(), generation = this.generation;
    const data = body === undefined ? undefined : JSON.stringify(body), bytes = data === undefined ? 0 : Buffer.byteLength(data);
    if (bytes > this.requestBodyLimit) throw new Error('Agent hub request exceeds its 1 MiB body limit');
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = { authorization: `Bearer ${token}` };
      if (data !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = bytes; }
      beforeDispatch?.(); // A prompt must persist its intent only after all local preflight checks pass.
      const req = this.connect(u, method, headers, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        const oversize = () => {
          reject(Object.assign(new Error('Agent hub response exceeds the 32 MiB limit'), { retryable: false }));
          res.destroy(); req.destroy();
        };
        if (Number(res.headers['content-length']) > RESPONSE_LIMIT) { oversize(); return; }
        res.on('data', (d: Buffer) => {
          bytes += d.length;
          if (bytes > RESPONSE_LIMIT) oversize(); else chunks.push(d);
        });
        res.on('error', () => reject(new Error('Agent hub response was interrupted')));
        res.on('end', () => {
          if (generation !== this.generation) { reject(new Error('Agent hub configuration changed during the request')); return; }
          const status = res.statusCode || 0;
          this.server.log.debug('agent-api', { method, status });
          let answer: Json;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            // Identify the original pinned request before redaction; never accept a hub-provided key.
            if (method === 'GET' && route.includes('/events?') && Array.isArray(parsed?.events)) {
              for (const e of parsed.events) if (e?.e === 'permission' || e?.e === 'elicitation')
                e.requestKey = sha256(JSON.stringify([parsed.sid, parsed.epoch, e]));
            }
            answer = this.clean(parsed);
          } catch { reject(new Error(`Agent hub answered ${status} with invalid JSON`)); return; }
          if (status >= 200 && status < 300) {
            if (method === 'GET' && (route === 'sessions' || route === 'observed') && Array.isArray(answer?.sessions))
              answer.sessions = answer.sessions.filter((s: Json) => validSid(route === 'sessions' ? s?.sid : s?.id));
            if ((route === 'sessions' || route === 'observed') && answer?.sessions?.length > REGISTRY_LIMIT) { reject(new Error(REGISTRY_FULL)); return; }
            resolve(answer);
          }
          else if (route.endsWith('/config') && [404, 405, 501].includes(status)) reject(new Error('This hub does not support agent config options (POST /config is unavailable)'));
          else {
            const error = answer && typeof answer === 'object' ? answer : {};
            reject(Object.assign(new Error(`Agent hub ${status}${error.code ? ' (' + line(error.code).slice(0, 128) + ')' : ''}: ${typeof error.error === 'string' ? error.error.slice(0, 1024) : 'request refused'}`), { status }));
          }
        });
      });
      const deadline = setTimeout(() => {
        reject(new Error('Agent hub request deadline exceeded; a write may already have acted')); req.destroy();
      }, 45000);
      this.requests.add(req); req.on('close', () => { clearTimeout(deadline); this.requests.delete(req); });
      req.on('error', () => reject(new Error('Agent hub cannot be reached or did not answer; a write may already have acted')));
      req.end(data);
    });
  }
  async readEvents(sid: string, since: number, valid: () => boolean): Promise<TranscriptReply> {
    sidOf(sid); cursorOf(since);
    if (this.journalActive >= JOURNAL_READS) {
      if (this.journalWaiters.length >= JOURNAL_WAITERS) throw new Error('Agent journal queue at its 64-waiter limit');
      await new Promise<void>(resolve => this.journalWaiters.push(resolve));
    }
    else this.journalActive++;
    try {
      if (this.stopped || !valid()) throw new Error('Agent view was closed; reopen it');
      const reply = await this.request('GET', `sessions/${sid}/events?since=${since}`) as TranscriptReply;
      cursorOf(reply.head); cursorOf(reply.from);
      for (const e of reply.events) cursorOf(e.seq);
      return reply;
    } finally {
      const next = this.journalWaiters.shift();
      if (next) next(); else this.journalActive--;
    }
  }
  start() { if (this.config && !this.stopped) void this.follow(++this.generation); }
  async follow(gen: number) {
    if (this.stopped || gen !== this.generation) return;
    let reason = 'last known records', readyAt = 0;
    try {
      this.info = await this.request('GET', 'info');
      if (this.stopped || gen !== this.generation) return;
      const u = this.apiURL('stream'), token = this.token();
      await new Promise<void>((resolve, reject) => {
        const req = this.connect(u, 'GET', { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, res => {
          if (res.statusCode !== 200) { res.destroy(); req.destroy(); reject(new Error('stream refused')); return; }
          // Every connection is a fresh authoritative snapshot, including observed removals while offline.
          this.streamActive = true; this.registryRevision++;
          this.sessions.clear(); this.observed.clear(); this.status = 'snapshot'; this.changed();
          res.setEncoding('utf8'); let rest = '', event = '', data: string[] = [], bytes = 0;
          res.on('data', (chunk: string) => {
            if (gen !== this.generation) return;
            rest += chunk; let nl: number;
            while ((nl = rest.indexOf('\n')) >= 0) {
              const raw = rest.slice(0, nl + 1);
              bytes += Buffer.byteLength(raw);
              if (bytes > SSE_LIMIT) { reason = SSE_OVERSIZE; req.destroy(); return; }
              const s = raw.slice(0, -1).replace(/\r$/, ''); rest = rest.slice(nl + 1);
              if (!s) {
                if (data.length) {
                  try {
                    this.event(event, this.clean(JSON.parse(data.join('\n'))));
                    if (event === 'ready' && !readyAt) { clearTimeout(deadline); readyAt = Date.now(); }
                  } catch (e) { if (e.message === REGISTRY_FULL) reason = REGISTRY_FULL; req.destroy(); return; }
                }
                event = ''; data = []; bytes = 0;
              } else if (s.startsWith('event:')) event = s.slice(6).trim();
              else if (s.startsWith('data:')) data.push(s.slice(5).replace(/^ /, ''));
            }
            if (bytes + Buffer.byteLength(rest) > SSE_LIMIT) { reason = SSE_OVERSIZE; req.destroy(); }
          });
          res.on('end', resolve); res.on('error', reject);
        }, 40000);
        const deadline = setTimeout(() => { reason = 'initial snapshot deadline exceeded'; req.destroy(); }, 40000);
        this.stream = req; this.requests.add(req);
        req.on('close', () => { clearTimeout(deadline); this.requests.delete(req); if (this.stream === req) this.stream = null; });
        req.on('timeout', () => req.destroy()); req.on('error', reject);
        req.on('close', resolve);
        req.end();
      });
    } catch { /* transport diagnostics deliberately contain no remote text or headers */ }
    if (this.stopped || gen !== this.generation) return;
    this.streamActive = false; this.status = `offline (${reason})`; this.changed();
    if (readyAt && Date.now() - readyAt >= 5000) this.reconnectAttempt = 0;
    const delay = Math.min(5000, Math.round(retryDelay(this.reconnectAttempt) * (0.75 + Math.random() * 0.5)));
    this.reconnectAttempt = Math.min(5, this.reconnectAttempt + 1);
    this.reconnect = setTimeout(() => void this.follow(gen), delay); this.reconnect.unref();
  }
  private clearRetry(queue: RetryQueue, sid: string) {
    clearTimeout(queue.get(sid));
    queue.delete(sid);
  }
  private deferRead(queue: RetryQueue, sid: string, attempt: number, run: () => void) {
    this.clearRetry(queue, sid);
    const timer = setTimeout(() => {
      queue.delete(sid);
      if (!this.stopped && this.sessions.has(sid)) run();
    }, retryDelay(attempt));
    timer.unref(); queue.set(sid, timer);
  }
  private discardTranscript(sid: string) {
    this.transcripts.delete(sid); this.replaying.delete(sid); this.clearRetry(this.retries, sid);
    this.replayErrors.delete(sid);
  }
  killed(id: string) {
    this.views.delete(id);
    if (id === 'name:*Agent Sessions*') {
      this.listOpened = false; this.listGeneration++; this.listDirty = false; this.listJob = undefined;
      this.openingLists = 0;
      this.exitedExpanded = false;
      this.facts.clear(); this.factReads.clear();
      for (const sid of this.factRetries.keys()) this.clearRetry(this.factRetries, sid);
      return;
    }
    const transcript = /^name:\*Agent: ([A-Za-z0-9_-]{1,64})\*$/.exec(id);
    const observed = /^name:\*Agent Observed: ([A-Za-z0-9_-]{1,64})\*$/.exec(id);
    if (observed) this.openedObserved.delete(observed[1]);
    if (!transcript) return;
    const sid = transcript[1];
    this.discardTranscript(sid);
    if (!this.listOpened) this.facts.delete(sid);
    for (const key of this.announced) if (key.startsWith(sid + '/')) this.announced.delete(key);
  }
  event(name: string, data: Json) {
    if ((name === 'session' || name === 'gone') && !validSid(data?.sid) ||
      (name === 'observed' || name === 'observed_gone') && !validSid(data?.id)) return;
    this.registryRevision++;
    // A live registry can satisfy a pending open before either fallback GET finishes.
    if (this.openingLists && this.streamActive && (name === 'session' || name === 'observed' || name === 'ready')) this.listOpened = true;
    if (name === 'hub') { this.sessions.clear(); this.hubStatus = line(data.status); this.status = `hub ${this.hubStatus}`; }
    if (name === 'session') storeRecord(this.sessions, data.sid, data);
    if (name === 'session') {
      const t = this.transcripts.get(data.sid), known = t?.controls().pending || [], offered = data.acp?.pending || [];
      const requestsChanged = known.length !== offered.length || known.some(p => !offered.some((q: Json) => q.req === p.req && q.kind === p.kind));
      if (t && !this.retries.has(data.sid) && (t.head !== (data.acp?.headSeq || 0) || t.epoch !== data.createdAt || requestsChanged))
        void this.replay(data.sid).catch(() => {});
      if (this.listOpened) this.scheduleFacts(data.sid);
      for (const p of data.acp?.pending || []) {
        const key = `${data.sid}/${data.createdAt}/${p.req}`;
        if (!this.announced.has(key)) {
          if (this.announced.size >= REGISTRY_LIMIT) throw new Error(REGISTRY_FULL);
          this.announced.add(key);
          for (const c of this.server.clients) if (c.hello && !c.closed && c.kind !== 'cli') c.send({ t: 'msg', level: 'info', text: `Agent ${line(data.sid)} awaits ${line(p.kind)}: ${line(p.title).slice(0, 256)} — M-x agent-session-answer` });
        }
      }
    }
    if (name === 'gone' && this.sessions.get(data.sid)?.createdAt === data.epoch) this.sessions.delete(data.sid);
    if (name === 'observed') storeRecord(this.observed, data.id, data);
    if (name === 'observed' && this.openedObserved.has(data.id)) void this.openView(data.id, undefined, true).catch(() => {});
    if (name === 'observed_gone') this.observed.delete(data.id);
    if (name === 'ready') this.status = 'connected';
    this.changed();
  }
  changed() {
    if (this.listOpened) void this.queueList().catch(() => {});
    for (const sid of this.transcripts.keys()) this.publishState(sid);
    for (const sid of this.openedObserved) this.publishState(sid);
    if (!this.streamActive || this.status === 'connected') {
      for (const sid of this.facts.keys()) if (!this.sessions.has(sid)) this.facts.delete(sid);
      for (const key of this.announced) {
        const [sid, epoch, req] = key.split('/'), s = this.sessions.get(sid);
        if (!s || s.createdAt !== Number(epoch) || !s.acp?.pending?.some((p: Json) => p.req === Number(req))) this.announced.delete(key);
      }
      for (const queue of [this.retries, this.factRetries])
        for (const sid of queue.keys()) if (!this.sessions.has(sid)) this.clearRetry(queue, sid);
    }
  }
  scheduleFacts(sid: string) {
    const s = this.sessions.get(sid), f = this.facts.get(sid);
    if (!this.factRetries.has(sid) && s?.kind === 'acp' && (!f || f.epoch !== s.createdAt || f.head !== (s.acp?.headSeq || 0)))
      void this.refreshFacts(sid).catch(() => {});
  }
  refreshFacts(sid: string, attempt = 0): Promise<void> {
    const existing = this.factReads.get(sid); if (existing) return existing;
    if (this.factRetries.has(sid)) return Promise.resolve();
    const generation = this.listGeneration, valid = () => this.listOpened && this.listGeneration === generation;
    const work = (async () => {
      let mismatches = 0;
      do {
        const s = this.sessions.get(sid); if (!s || !valid()) return;
        let f = this.facts.get(sid);
        if (!f || f.epoch !== s.createdAt || f.head < 0) f = { epoch: s.createdAt, head: 0, model: '' };
        const reply = await this.readEvents(sid, f.head, valid);
        const current = this.sessions.get(sid);
        if (!valid() || !current) return;
        if (current.createdAt !== reply.epoch) {
          if (++mismatches >= EPOCH_READS) throw new EpochDisagreement();
          continue;
        }
        if (reply.reset || reply.epoch !== f.epoch) f = { epoch: reply.epoch, head: 0, model: '' };
        for (const e of reply.events) {
          if (e.sessionId) continue;
          if (Array.isArray(e.configOptions)) f.model = modelOf(e.configOptions);
          if (Array.isArray(e.update?.configOptions)) f.model = modelOf(e.update.configOptions);
        }
        f.head = reply.head; this.facts.set(sid, f);
        if (this.listOpened) void this.queueList().catch(() => {});
        if ((current.acp?.headSeq || 0) === f.head || current.acp?.headSeq === s.acp?.headSeq) break;
      } while (!this.stopped);
    })().catch(e => {
      const s = this.sessions.get(sid);
      if (valid() && s) {
        this.facts.set(sid, { epoch: s.createdAt, head: -1, model: `unavailable (${line(this.cleanDiagnostic(String(e.message || e))).slice(0, 512)})` });
        if (e instanceof EpochDisagreement) this.deferRead(this.factRetries, sid, attempt, () => {
          if (valid()) void this.refreshFacts(sid, attempt + 1).catch(() => {});
        });
        void this.queueList().catch(() => {});
      }
      throw e;
    }).finally(() => { if (this.factReads.get(sid) === work) this.factReads.delete(sid); });
    this.factReads.set(sid, work); return work;
  }
  rows(): Json[] {
    const rows: Json[] = [], linked = new Map<string, Json>();
    for (const o of this.observed.values()) if (o.wbSession) linked.set(JSON.stringify([o.host, o.wbSession]), o);
    for (const s of this.sessions.values()) {
      const o = linked.get(JSON.stringify([s.host, s.sid]));
      const facts = this.facts.get(s.sid), transcript = this.transcripts.get(s.sid);
      rows.push({ sid: s.sid, epoch: s.createdAt, state: s.state || (s.alive ? 'running' : 'ended'), harness: o?.harness || s.acp?.agent || s.kind,
        model: modelName(o?.model) || modelName(facts && facts.epoch === s.createdAt ? facts.model : '') ||
          modelName(transcript && transcript.epoch === s.createdAt ? modelOf(transcript.controls().configOptions) : ''), host: s.host, project: o?.project || s.cwd,
        activity: [s.acp?.title, s.acp?.activity, o?.tool?.name].filter(Boolean).join(' — '),
        waiting: !!(s.acp?.pending?.length || o?.pending), exited: s.alive === false, updated: s.updatedAt || 0 });
    }
    for (const o of this.observed.values()) if (this.sessions.get(o.wbSession)?.host !== o.host) rows.push({ observedId: o.id, state: o.state, harness: o.harness, model: modelName(o.model), host: o.host,
      project: o.project, activity: o.pending?.message || o.tool?.name || o.lastMessage || o.title, waiting: !!o.pending,
      exited: o.endedAt != null || !!o.endReason || o.state === 'exited', updated: o.lastAt || 0 });
    const group = (r: Json) => r.waiting ? 0 : r.exited ? 2 : 1;
    return rows.sort((a, b) => group(a) - group(b) || b.updated - a.updated || String(a.sid || a.observedId).localeCompare(String(b.sid || b.observedId)));
  }
  publish(name: string, mode: string, text: string, locals: Json, valid: () => boolean, patch?: PresentationPatch): Promise<SBuf> {
    const B = this.server.buffers, id = 'name:' + name, previous = this.publications.get(id);
    const work = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      const check = () => { if (this.stopped || !valid()) throw new Error('Agent view was closed; reopen it'); };
      check();
      let sb = B.byId.get(id);
      if (!sb) sb = B.create({ id, jid: randomId(), name, file: null, text: '', special: true });
      sb.ed.mode = mode; sb.setReadOnly('Agent session view is read-only');
      const old = sb.ed.agentLocals?.agentSession;
      // Transcript text was redacted before its offsets were materialised; do not rescan full history.
      const clean = mode === 'agent-transcript-mode' ? text : this.clean(text);
      const edits = patch && old?.head === patch.previousHead && old?.epoch === patch.previousEpoch
        ? [[patch.start, sb.ed.rope.slice(patch.start, patch.start + patch.remove), patch.text] as [number, string, string]]
        : diffOps(sb.text, clean);
      sb.ed.agentLocals = {};
      for (const [pos, del, ins] of edits) {
        for (const [body, deleting] of [[del, true], [ins, false]] as const) {
          for (let at = 0; at < body.length;) {
            check();
            let end = Math.min(body.length, at + 65536);
            if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end--;
            const part = body.slice(at, end), point = deleting ? pos : pos + at;
            const entry = B.seq.applyBatch(sb, [[point, deleting ? part : '', deleting ? '' : part]], { kind: 'server', thread: 'agent sessions' });
            await B.seq.commit(sb, entry, null); await yieldTurn();
            at = end;
          }
        }
      }
      check();
      sb.ed.undo = []; sb.ed.redo = []; sb.ed.modified = false;
      if (!sb.replayMeta) {
        const oldMeta = sb.meta.bind(sb);
        sb.replayMeta = true;
        sb.meta = () => ({ ...oldMeta(), modified: false, locals: (sb!.ed.agentLocals || {}) });
      }
      const sid = locals.agentSession?.sid;
      sb.ed.agentLocals = this.clean(sid ? this.withState(sid, locals) : locals);
      B.sendMeta(sb); return sb;
    }).finally(() => { if (this.publications.get(id) === work) this.publications.delete(id); });
    this.publications.set(id, work); return work;
  }
  queueList(): Promise<void> {
    this.listDirty = true;
    if (this.listJob) return this.listJob;
    const generation = this.listGeneration, valid = () => this.listOpened && this.listGeneration === generation;
    const work = (async () => {
      await yieldTurn();
      while (valid() && this.listDirty && !this.stopped) {
        this.listDirty = false;
        await this.drawList(valid);
      }
    })().finally(() => { if (this.listJob === work) this.listJob = undefined; });
    this.listJob = work; return work;
  }
  async drawList(valid: () => boolean) {
    const { charWidth, strWidth } = this.server.buffers.Ed.display;
    const all = this.rows(), active = all.filter(r => r.waiting || !r.exited), exitedRows = all.filter(r => !r.waiting && r.exited);
    const shown = this.exitedExpanded ? exitedRows : exitedRows.slice(0, 5);
    const rows = [...active, ...shown].map(r => ({ ...r, line: 0, cells: listColumns.map(c =>
      cell(c.key === 'sid' ? r.sid || r.observedId : c.key === 'waiting' ? r.waiting ? 'WAIT' : '' : r[c.key], c.cap, charWidth)) }));
    const columns = listColumns.map((c, i) => {
      let width = strWidth(c.label);
      for (const r of rows) width = Math.max(width, strWidth(r.cells[i]));
      return { ...c, width };
    });
    const format = (cells: string[]) => cells.map((text, i) => text + ' '.repeat(columns[i].width - strWidth(text))).join('  ');
    const status = this.status === 'connected' ? `${this.status} (hub ${this.hubStatus})` : this.status;
    const lines = [`Agent Sessions — ${status}`, format(columns.map(c => c.label))];
    const exited = { expanded: this.exitedExpanded, total: exitedRows.length, hidden: exitedRows.length - shown.length, line: null as number | null };
    for (const [index, r] of rows.entries()) {
      if (index === active.length && exitedRows.length) {
        exited.line = lines.length + 1;
        lines.push(`Exited sessions — ${shown.length} of ${exitedRows.length} shown [e / TAB: ${this.exitedExpanded ? 'show latest 5' : 'show all'}; agent-sessions-toggle-exited]`);
      }
      r.line = lines.length + 1; lines.push(format(r.cells));
    }
    await this.publish('*Agent Sessions*', 'agent-sessions-mode', lines.join('\n') + '\n', { agentList: { rows, columns, exited, status } }, valid);
  }
  async toggleExited() {
    if (!this.listOpened) throw new Error('Open the agent session list first');
    this.exitedExpanded = !this.exitedExpanded;
    await this.queueList(); return 'name:*Agent Sessions*';
  }
  async list() {
    this.token();
    const generation = this.listGeneration;
    const revision = this.registryRevision;
    this.openingLists++;
    const [sessions, observed] = await Promise.allSettled([this.request('GET', 'sessions'), this.request('GET', 'observed')])
      .finally(() => { if (this.listGeneration === generation) this.openingLists--; });
    if (this.listGeneration !== generation) throw new Error('Agent list was closed; reopen it');
    const liveRegistry = this.streamActive && (this.status === 'connected' || this.sessions.size > 0 || this.observed.size > 0);
    if (!liveRegistry && sessions.status === 'rejected' && observed.status === 'rejected') throw sessions.reason;
    // A snapshot begun or updated during this listing is newer, even before its ready event.
    if (!this.streamActive && revision === this.registryRevision) {
      this.sessions = new Map((sessions.status === 'fulfilled' ? sessions.value.sessions || [] : []).map((s: Json) => [s.sid, s]));
      this.observed = new Map((observed.status === 'fulfilled' ? observed.value.sessions || [] : []).map((s: Json) => [s.id, s]));
      if (sessions.status === 'rejected' || observed.status === 'rejected') this.status = 'partial — hub or observed registry unavailable';
    }
    this.listOpened = true;
    this.changed();
    for (const sid of this.sessions.keys()) this.scheduleFacts(sid);
    await this.queueList(); return 'name:*Agent Sessions*';
  }
  async requireSession(sid: string, epoch?: number): Promise<Json> {
    sidOf(sid); if (this.observed.has(sid) && !this.sessions.has(sid)) throw new Error('Reported session is read-only and cannot be steered');
    const s = await this.request('GET', 'sessions/' + sid);
    if (s.kind !== 'acp') throw new Error('This session is not a hub-run ACP agent and cannot be steered');
    if (epoch !== undefined && (s.createdAt !== expectedEpoch(epoch) ||
      this.sessions.has(sid) && this.sessions.get(sid)!.createdAt !== epoch)) throw replaced();
    const t = this.transcripts.get(sid);
    if (t && t.epoch === s.createdAt) s.promptCapabilities ??= t.controls().promptCapabilities;
    return s;
  }
  snapshot(sid: string): Json {
    const s = this.sessions.get(sid), observed = !s ? this.observed.get(sid) : undefined, t = this.transcripts.get(sid);
    const observedView = !s && (!!observed || this.openedObserved.has(sid));
    // Journal data is usable only inside the current summary's incarnation.
    const view = s && s.kind === 'acp' && t && t.epoch === s.createdAt ? t.controls() : undefined;
    const pending = view?.pending.filter(p => s!.acp?.pending?.some((q: Json) => q.req === p.req && q.kind === p.kind)) || [];
    return {
      sid, bufferId: `name:*Agent${observedView ? ' Observed' : ''}: ${sid}*`, epoch: s?.createdAt ?? null,
      state: s ? s.state || (s.alive ? 'running' : 'ended') : observed?.state || (observed ? 'reported' : 'removed'),
      steerable: this.config?.steer === true && !!s && s.kind === 'acp' && s.alive !== false && this.status === 'connected',
      connection: this.status, modeId: view?.modeId ?? null, modes: view?.modes ?? null,
      configOptions: view?.configOptions ?? null, usage: view?.usage ?? null, sessionInfo: view?.sessionInfo ?? null, pending
    };
  }
  withState(sid: string, locals: Json): Json {
    const state = this.snapshot(sid), session = locals.agentSession;
    return { ...locals, agentState: state, ...(session ? { agentSession: {
      ...session, pending: state.pending, modeId: state.modeId, modes: state.modes, configOptions: state.configOptions,
      usage: state.usage, sessionInfo: state.sessionInfo,
      ...(session.epoch !== state.epoch ? { resolved: [] } : {})
    } } : {}) };
  }
  publishState(sid: string) {
    const state = this.clean(this.snapshot(sid)), sb = this.server.buffers.byId.get(state.bufferId);
    if (!sb?.ed.agentLocals || JSON.stringify(state) === JSON.stringify(sb.ed.agentLocals.agentState)) return;
    const locals = this.clean(this.withState(sid, sb.ed.agentLocals));
    sb.ed.agentLocals = locals; this.server.buffers.sendMeta(sb);
  }
  async state(sid: string): Promise<Json> {
    sidOf(sid);
    if (this.sessions.has(sid) || !this.transcripts.has(sid)) await this.open(sid);
    return this.snapshot(sid);
  }
  async pendingRequest(sid: string, req: number, epoch: number, kind?: string): Promise<Json> {
    if (!Number.isSafeInteger(req) || req < 1) throw new Error('An exact pending request id is required');
    const s = await this.requireSession(sid, expectedEpoch(epoch));
    const offered = s.acp?.pending?.find((p: Json) => p.req === req && (!kind || p.kind === kind));
    if (!offered) throw new Error('Request is already resolved or no longer pending; refresh the session');
    // Pending requests are pinned even at the current head. Read the pin itself: the folded transcript
    // deduplicates seqs and may not yet have observed a same-incarnation journal rewind.
    const journal = await this.readEvents(sid, s.acp.headSeq, () => !this.stopped);
    if (journal.epoch !== epoch) throw replaced();
    const event = journal.events.find(e => e.seq === req && e.e === offered.kind);
    if (!event || journal.head !== s.acp.headSeq) throw new Error('Request changed or is no longer pending; refresh the session');
    return { ...event, sid, req, kind: offered.kind, epoch, status: 'pending' };
  }
  async answer(sid: string, kind: 'permission' | 'elicitation', body: Json): Promise<Json> {
    const pending = await this.pendingRequest(sid, body?.req, body?.epoch, kind);
    if (typeof body.requestKey !== 'string' || body.requestKey !== pending.requestKey)
      throw new Error('Request changed; refresh and review its details before answering');
    if (kind === 'permission') {
      const outcome = body.outcome;
      if (!outcome || (outcome.outcome !== 'cancelled' && (outcome.outcome !== 'selected' ||
        !Array.isArray(pending.options) || !pending.options.some((option: Json) => typeof option.optionId === 'string' && option.optionId === outcome.optionId)))) {
        throw new Error('Permission outcome must select an offered option or cancel the request');
      }
    }
    const wire = { req: pending.req, epoch: pending.epoch, ...(kind === 'permission' ? { outcome: body.outcome } : { response: body.response }) };
    return this.request('POST', `sessions/${sid}/${kind}`, wire);
  }
  async open(sid: string, epoch?: number): Promise<string> {
    sidOf(sid);
    return this.openView(sid, epoch, this.observed.has(sid) && !this.sessions.has(sid));
  }
  private async openView(sid: string, epoch: number | undefined, observed: boolean): Promise<string> {
    const registered = this.sessions.has(sid), revision = this.registryRevision;
    const name = observed ? `*Agent Observed: ${sid}*` : `*Agent: ${sid}*`, id = 'name:' + name;
    // Object identity is the kill/reopen generation. Each racing open owns one reservation,
    // and a successful publication keeps the view alive independently of pending callers.
    let view = this.views.get(id);
    if (!view) { view = { opening: 0, opened: false }; this.views.set(id, view); }
    view.opening++;
    const valid = () => this.views.get(id) === view;
    try {
      let s: Json;
      try { s = await this.request('GET', (observed ? 'observed/' : 'sessions/') + sid); }
      catch (e) {
        if (observed || e.status !== 404) throw e;
        if (!valid()) throw new Error('Agent view was closed; reopen it');
        return this.openView(sid, epoch, true);
      }
      if (!valid()) throw new Error('Agent view was closed; reopen it');
      const current = observed ? this.observed.get(sid) : this.sessions.get(sid);
      if (!observed && registered && !current && revision !== this.registryRevision) throw new Error('Agent session was removed; refresh the sessions list');
      // A detail reply begun before a stream update cannot undo its state, removal, incarnation or head.
      if (current && (this.streamActive && revision !== this.registryRevision ||
        (observed ? current.lastAt > s.lastAt : current.createdAt > s.createdAt ||
        current.createdAt === s.createdAt && (current.updatedAt > s.updatedAt || (current.acp?.headSeq || 0) > (s.acp?.headSeq || 0))))) s = current;
      if (epoch !== undefined && s.createdAt !== expectedEpoch(epoch)) throw replaced();
      storeRecord(observed ? this.observed : this.sessions, sid, s);
      if (!observed && s.kind === 'acp') {
        // token() validates exactly 64 hexadecimal characters, including rotated tokens retained for redaction.
        if (!this.transcripts.has(sid)) this.transcripts.set(sid, new Transcript(sid, value => this.redactText(value), 63));
        await this.replay(sid);
        if (epoch !== undefined && this.sessions.get(sid)?.createdAt !== epoch) throw replaced();
      } else {
        if (observed) this.openedObserved.add(sid);
        await this.publish(name, 'agent-session-mode', `# ${sid}\n\n${observed ? 'Reported session: read-only; this hub cannot steer it. Only the reported record and bounded tail are available.\n\n' : 'PTY record: this HTTP API offers no terminal input.\n\n'}${JSON.stringify(s, null, 2)}\n`, { agentSession: { sid, observed: true, epoch: s.createdAt, spans: [] } }, valid);
      }
      if (!valid()) throw new Error('Agent view was closed; reopen it');
      view.opened = true;
      return id;
    } finally {
      if (--view.opening === 0 && !view.opened && valid()) {
        this.views.delete(id);
        if (observed) this.openedObserved.delete(sid); else this.discardTranscript(sid);
      }
    }
  }
  replay(sid: string, attempt = 0): Promise<void> {
    const existing = this.replaying.get(sid); if (existing) return existing;
    const t = this.transcripts.get(sid), generation = this.views.get(`name:*Agent: ${sid}*`);
    if (!t || generation === undefined) return Promise.resolve();
    const valid = () => this.views.get(`name:*Agent: ${sid}*`) === generation && this.transcripts.get(sid) === t;
    if (this.retries.has(sid)) return Promise.reject(new Error('Agent journal retry is backing off'));
    const work = (async () => {
      let mismatches = 0;
      do {
        const wanted = this.sessions.get(sid);
        if (!valid() || !wanted) return;
        if (t.epoch !== wanted.createdAt) t.reset(wanted.createdAt);
        const reply = await this.readEvents(sid, t.head, valid);
        const current = this.sessions.get(sid);
        if (!valid() || !current) return;
        if (current.createdAt !== reply.epoch) {
          if (++mismatches >= EPOCH_READS) throw new EpochDisagreement();
          continue;
        }
        t.apply(reply);
        // Only an equally current registry can declare a request absent; older/newer summaries cannot.
        if ((current.acp?.headSeq || 0) === reply.head) t.reconcilePending(current.acp?.pending || []);
        const view = t.render();
        await this.publish(`*Agent: ${sid}*`, 'agent-transcript-mode', view.text,
          { agentSession: { ...view, text: undefined, patch: undefined, host: current.host } }, valid, view.patch);
        const latest = this.sessions.get(sid);
        if (latest?.createdAt === t.epoch && ((latest.acp?.headSeq || 0) === t.head ||
          latest === current && current.acp?.headSeq === wanted.acp?.headSeq)) break;
      } while (!this.stopped);
      if (valid()) this.replayErrors.delete(sid);
    })().catch(e => {
      const current = this.sessions.get(sid);
      if (!this.stopped && valid() && current) {
        const report = this.cleanDiagnostic(String(e.message || e)).slice(0, 1024);
        if (e instanceof TranscriptPinLimitError) this.publishState(sid);
        if (this.replayErrors.get(sid) !== report) {
          this.replayErrors.set(sid, report);
          for (const c of this.server.clients) if (c.hello && !c.closed && c.kind !== 'cli')
            c.send({ t: 'msg', level: 'error', text: `Agent ${sid} journal read failed: ${report}` });
        }
        if (e.retryable !== false && (e instanceof EpochDisagreement || t.epoch !== current.createdAt || t.head !== (current.acp?.headSeq || 0)))
          this.deferRead(this.retries, sid, attempt, () => {
            if (valid()) void this.replay(sid, attempt + 1).catch(() => {});
          });
      }
      throw e;
    }).finally(() => { if (this.replaying.get(sid) === work) this.replaying.delete(sid); });
    this.replaying.set(sid, work); return work;
  }
  async promptBlocks(sid: string, seq: number, epoch: number): Promise<unknown[]> {
    sidOf(sid);
    if (!Number.isInteger(seq) || seq < 1) throw new Error('A journal prompt sequence is required');
    await this.open(sid, expectedEpoch(epoch));
    const event = this.transcripts.get(sid)?.journal.find(e => e.seq === seq && e.e === 'prompt');
    if (!event || !Array.isArray(event.prompt)) throw new Error('That prompt is not available in the hub journal replay');
    return event.prompt;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.generation++; clearTimeout(this.reconnect);
    for (const queue of [this.retries, this.factRetries]) for (const sid of queue.keys()) this.clearRetry(queue, sid);
    for (const req of this.requests) req.destroy();
    this.loopbackAgent?.destroy();
    this.offKill(); this.views.clear(); this.transcripts.clear(); this.openedObserved.clear();
    this.facts.clear(); this.factReads.clear(); this.announced.clear(); this.replayErrors.clear();
  }
}
export async function install(server: Server, registryOnly = false) {
  const hub = new AgentSessions(server); modules.set(server, hub);
  const cmd = (name: string, fn: (args: any[]) => unknown) => server.defineCommand(name, async (_c, args) => { // any: API command arguments validated per command
    try { return { value: hub.clean(await fn(args)) }; } catch (e) { return fail(hub.clean(String(e.message || e))); }
  });
  cmd('agent-sessions', () => hub.list());
  cmd('agent-sessions-toggle-exited', () => hub.toggleExited());
  cmd('agent-session-open', a => hub.open(a[0], a[1]));
  cmd('agent-session-info', () => hub.request('GET', 'info'));
  cmd('agent-session-list', async () => (await hub.request('GET', 'sessions')).sessions.filter((s: Json) => s.kind === 'acp'));
  cmd('agent-session-details', async a => { await hub.open(a[0], a[1]); return hub.transcripts.get(a[0])?.controls(); });
  cmd('agent-session-state', a => hub.state(a[0]));
  cmd('agent-session-pending', () => [...hub.sessions.values()].flatMap(s => (s.acp?.pending || []).map((p: Json) => ({ ...p, sid: s.sid, epoch: s.createdAt }))));
  cmd('agent-session-request', a => hub.pendingRequest(a[0], a[1], a[2]));
  cmd('agent-session-location', async a => {
    const { sid, epoch, seq, location } = a[0], s = await hub.requireSession(sid, expectedEpoch(epoch));
    const t = hub.transcripts.get(sid), span = t && t.epoch === epoch ? t.render().spans.find(p => p.seq === seq && p.kind === 'tool') : undefined;
    if (!span?.locations?.some((l: Json) => JSON.stringify(l) === JSON.stringify(location))) throw new Error('Tool location is no longer available; refresh the transcript');
    if (s.host !== server.cfg.host) throw new Error(`Tool file is on ${line(s.host)}, not this edwind host; open it there`);
    if (!location || typeof location.path !== 'string') throw new Error('Tool has no file location');
    const file = path.resolve(s.cwd, location.path);
    server.auth.agent!.withRead(file, (_fd, st) => { if (!st.isFile()) throw new Error('Tool location is not a file'); });
    const found = server.buffers.resolve(file, false);
    if (!('id' in found)) throw new Error('Tool file moved');
    return found.id;
  });
  if (server.cfg.agentHub?.steer) {
    cmd('agent-session-start', async a => { const r = await hub.request('POST', 'sessions', a[0]); return hub.open(r.sid); });
    for (const action of ['cancel', 'revive', 'mode', 'config']) cmd('agent-session-' + action, async a => {
      const sid = sidOf(a[0]), body = a[1];
      await hub.requireSession(sid, body?.epoch); expectedEpoch(body?.epoch);
      return hub.request('POST', `sessions/${sid}/${action}`, body);
    });
    for (const action of ['permission', 'elicitation'] as const) cmd('agent-session-' + action, a => hub.answer(a[0], action, a[1]));
    cmd('agent-session-remove', async a => {
      const sid = sidOf(a[0]), epoch = a[1]?.epoch;
      await hub.requireSession(sid, epoch); expectedEpoch(epoch);
      return hub.request('DELETE', 'sessions/' + sid + '?forget=true', { epoch });
    });
  }
  server.statusProviders.push(() => ({ agentHub: hub.status, agentSessions: hub.sessions.size, agentObserved: hub.observed.size }));
  const primitive = server.L.D('agent-session-open', 'sid', 'Materialise the shared transcript and return name:*Agent: SID* without starting an agent.', () => { throw new server.L.S.SchemeError('cannot-block', 'agent-session-open must run on a Scheme thread', []); });
  primitive.where = 'server';
  primitive.gen = function* ([sid]: SchemeValue[]): SchemeGen { return yield new server.L.S.Block(hub.open(sid), 'agent journal'); };
  if (registryOnly) return;
  try { hub.stopPrompts = (await installPrompts(server, hub)).stop; }
  catch { server.log.error('agent-prompt', { error: 'Draft store unavailable' }); }
  hub.start();
}
export async function shutdown(server: Server) { const hub = modules.get(server); hub?.stop(); await hub?.stopPrompts?.(); }
