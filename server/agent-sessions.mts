// Agent sessions through the mesh HTTP API, never through ACP or the process hub socket (Step AS1).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomId } from './journal.mts';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { diffOps } from './watch.mts';
import { Transcript } from './agent-transcript.mts';
import type { TranscriptReply } from './agent-transcript.mts';
import type { SchemeGen } from './threads.mts';
import { installPrompts } from './agent-prompts.mts';
import type { Server, SchemeValue } from './main.mts';
import type { SBuf } from './buffers.mts';
import type { CallResult } from './proto.mts';

type Json = Record<string, any>; // any: verbatim hub JSON; unknown ACP variants remain inspectable
export interface AgentHubConfig { url: string; tokenFile: string }
export interface AgentBackend {
  request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<any>; // any: API JSON
  clean<T>(value: T): T;
  requireSession(sid: string, epoch?: number): Promise<Json>;
  open(sid: string): Promise<string>;
  promptBlocks(sid: string, seq: number, epoch: number): Promise<unknown[]>;
}
const modules = new WeakMap<Server, AgentSessions>();
const fail = (report: string, condition = 'agent-hub-error'): CallResult => ({ error: { condition, report, restarts: [], backtrace: [] } });
const sidOf = (sid: unknown): string => { if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sid)) throw new Error('Invalid agent session id'); return sid; };
const line = (x: unknown) => String(x ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
const modelOf = (options: unknown): string => {
  if (!Array.isArray(options)) return '';
  const option = options.find(o => o && (o.category === 'model' || o.id === 'model'));
  return typeof option?.currentValue === 'string' ? option.currentValue : '';
};
const RESPONSE_LIMIT = 32 * 1024 * 1024, SSE_LIMIT = 1024 * 1024, JOURNAL_READS = 4;
const replaced = () => new Error('Agent session was replaced (stale incarnation); refresh and explicitly select it again');
const expectedEpoch = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw replaced();
  return value;
};
type PresentationPatch = { start: number; remove: number; text: string; previousHead: number; previousEpoch: number };

export function validateAgentHub(value: unknown): AgentHubConfig {
  const c = value as Partial<AgentHubConfig>;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['url', 'tokenFile'].includes(k))) throw new Error('agentHub must be {url, tokenFile}');
  let u: URL; try { u = new URL(c.url!); } catch { throw new Error('agentHub.url must be an HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('agentHub.url must be HTTP or HTTPS without credentials, query or fragment');
  if (typeof c.tokenFile !== 'string' || !path.isAbsolute(c.tokenFile)) throw new Error('agentHub.tokenFile must be an absolute path');
  return { url: u.href.replace(/\/$/, ''), tokenFile: c.tokenFile };
}
function protect(server: Server, c: AgentHubConfig) {
  let real = c.tokenFile; try { real = fs.realpathSync(c.tokenFile); } catch { /* refusal also covers a missing file */ }
  if (server.buffers?.all().some(b => b.file === real)) throw new Error('Agent token file is already visited; choose a private credential file');
  if (!server.auth.refuse.includes(c.tokenFile)) server.auth.refuse.push(c.tokenFile);
  if (!server.auth.realRefuse.includes(real)) server.auth.realRefuse.push(real);
}
// Installed before user init, which is evaluated before server modules. Only paths, never tokens, cross Scheme.
export function prepare(server: Server) {
  const f = server.L.D('agent-hub-configure', 'url token-file', 'Configure the mesh API address and private token file; never a token value.', ([url, tokenFile]: SchemeValue[]) => {
    if (modules.has(server)) throw new Error('agent-hub-configure is init-only; runtime clients cannot rebind a credential to another origin');
    const c = validateAgentHub({ url, tokenFile }); protect(server, c); server.cfg.agentHub = c;
    return true;
  });
  f.where = 'server';
}

export class AgentSessions implements AgentBackend {
  declare server: Server; declare config: AgentHubConfig | undefined;
  declare sessions: Map<string, Json>; declare observed: Map<string, Json>;
  declare status: string; declare info: Json; declare stopped: boolean;
  declare stream: http.ClientRequest | null; declare requests: Set<http.ClientRequest>;
  declare reconnect: NodeJS.Timeout | undefined; declare generation: number;
  declare listOpened: boolean;
  listGeneration = 0;
  listDirty = false;
  listJob?: Promise<void>;
  publications = new Map<string, Promise<SBuf>>();
  views = new Map<string, number>();
  nextView = 0;
  retries = new Map<string, { timer: NodeJS.Timeout; attempt: number; epoch: number; view: number }>();
  retryAttempts = new Map<string, number>();
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
  // Presentation offsets remain valid even when a secret only appears after text chunks are assembled.
  redactText(value: string): string {
    for (const token of this.#secrets) value = value.split(token).join('[redacted]'.padEnd(token.length, ' '));
    return value;
  }
  token(): string {
    if (!this.config) throw new Error('No agent hub configured: set agentHub.url and agentHub.tokenFile in edit.json, or agent-hub-configure in init.scm');
    protect(this.server, this.config);
    let token: string; try { token = fs.readFileSync(this.config.tokenFile, 'utf8').trimEnd(); } catch { throw new Error('Agent hub token file is not readable'); }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Agent hub token file must contain 64 lowercase hexadecimal characters');
    this.#secrets.add(token); return token;
  }
  async request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<Json> {
    const token = this.token(), u = new URL(this.config!.url + '/v1/' + route), generation = this.generation;
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (data && data.length > 1024 * 1024) throw new Error('Agent hub request exceeds its 1 MiB body limit');
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = { authorization: `Bearer ${token}` };
      if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
      const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout: 45000 }, res => {
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
          let answer: Json; try { answer = this.clean(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error(`Agent hub answered ${status} with invalid JSON`)); return; }
          if (status >= 200 && status < 300) resolve(answer);
          else if (route.endsWith('/config') && [404, 405, 501].includes(status)) reject(new Error('This hub does not support agent config options (POST /config is unavailable)'));
          else {
            const error = answer && typeof answer === 'object' ? answer : {};
            reject(Object.assign(new Error(`Agent hub ${status}${error.code ? ' (' + line(error.code).slice(0, 128) + ')' : ''}: ${typeof error.error === 'string' ? error.error.slice(0, 1024) : 'request refused'}`), { status }));
          }
        });
      });
      this.requests.add(req); req.on('close', () => this.requests.delete(req));
      req.on('timeout', () => req.destroy());
      req.on('error', () => reject(new Error('Agent hub cannot be reached or did not answer; a write may already have acted')));
      req.end(data);
    });
  }
  async readEvents(sid: string, since: number, valid: () => boolean): Promise<TranscriptReply> {
    if (this.journalActive >= JOURNAL_READS) await new Promise<void>(resolve => this.journalWaiters.push(resolve));
    else this.journalActive++;
    try {
      if (this.stopped || !valid()) throw new Error('Agent view was closed; reopen it');
      return await this.request('GET', `sessions/${sid}/events?since=${since}`) as TranscriptReply;
    } finally {
      const next = this.journalWaiters.shift();
      if (next) next(); else this.journalActive--;
    }
  }
  start() { if (this.config && !this.stopped) void this.follow(++this.generation); }
  async follow(gen: number) {
    if (this.stopped || gen !== this.generation) return;
    try {
      this.info = await this.request('GET', 'info');
      if (this.stopped || gen !== this.generation) return;
      const token = this.token(), u = new URL(this.config!.url + '/v1/stream');
      await new Promise<void>((resolve, reject) => {
        const req = (u.protocol === 'https:' ? https : http).get(u, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, timeout: 40000 }, res => {
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
              if (bytes > SSE_LIMIT) { this.status = 'Agent hub SSE event exceeds the 1 MiB limit'; this.changed(); res.destroy(); req.destroy(); return; }
              const s = raw.slice(0, -1).replace(/\r$/, ''); rest = rest.slice(nl + 1);
              if (!s) {
                if (data.length) { try { this.event(event, this.clean(JSON.parse(data.join('\n')))); } catch { res.destroy(); req.destroy(); return; } }
                event = ''; data = []; bytes = 0;
              } else if (s.startsWith('event:')) event = s.slice(6).trim();
              else if (s.startsWith('data:')) data.push(s.slice(5).replace(/^ /, ''));
            }
            if (bytes + Buffer.byteLength(rest) > SSE_LIMIT) { this.status = 'Agent hub SSE event exceeds the 1 MiB limit'; this.changed(); res.destroy(); req.destroy(); }
          });
          res.on('end', resolve); res.on('error', reject);
        });
        this.stream = req; this.requests.add(req);
        req.on('close', () => { this.requests.delete(req); if (this.stream === req) this.stream = null; });
        req.on('timeout', () => req.destroy()); req.on('error', reject);
        req.on('close', resolve);
      });
    } catch { /* transport diagnostics deliberately contain no remote text or headers */ }
    this.streamActive = false;
    if (this.stopped || gen !== this.generation) return;
    this.status = this.status.includes('exceeds') ? `offline (${this.status})` : 'offline (last known records)'; this.changed();
    this.reconnect = setTimeout(() => void this.follow(gen), 1000); this.reconnect.unref();
  }
  clearRetry(sid: string) {
    const retry = this.retries.get(sid);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(sid);
  }
  killed(id: string) {
    this.views.delete(id);
    if (id === 'name:*Agent Sessions*') {
      this.listOpened = false; this.listGeneration++; this.listDirty = false; this.listJob = undefined;
      this.facts.clear(); this.factReads.clear();
      return;
    }
    const transcript = /^name:\*Agent: ([A-Za-z0-9_-]{1,64})\*$/.exec(id);
    const observed = /^name:\*Agent Observed: ([A-Za-z0-9_-]{1,64})\*$/.exec(id);
    if (observed) this.openedObserved.delete(observed[1]);
    if (!transcript) return;
    const sid = transcript[1];
    this.transcripts.delete(sid); this.replaying.delete(sid); this.clearRetry(sid);
    this.retryAttempts.delete(sid); this.replayErrors.delete(sid);
    if (!this.listOpened) this.facts.delete(sid);
    for (const key of this.announced) if (key.startsWith(sid + '/')) this.announced.delete(key);
  }
  event(name: string, data: Json) {
    this.registryRevision++;
    if (name === 'hub') { this.sessions.clear(); this.hubStatus = line(data.status); this.status = `hub ${this.hubStatus}`; }
    if (name === 'session' && typeof data.sid === 'string') this.sessions.set(data.sid, data);
    if (name === 'session') {
      const t = this.transcripts.get(data.sid), known = t?.controls().pending || [], offered = data.acp?.pending || [];
      const requestsChanged = known.length !== offered.length || known.some(p => !offered.some((q: Json) => q.req === p.req && q.kind === p.kind));
      if (t && (t.head !== (data.acp?.headSeq || 0) || t.epoch !== data.createdAt || requestsChanged)) void this.replay(data.sid).catch(() => {});
      const retry = this.retries.get(data.sid);
      if (retry && retry.epoch !== data.createdAt) { this.clearRetry(data.sid); this.retryAttempts.delete(data.sid); }
      if (this.listOpened) this.scheduleFacts(data.sid);
      for (const p of data.acp?.pending || []) {
        const key = `${data.sid}/${data.createdAt}/${p.req}`;
        if (!this.announced.has(key)) {
          this.announced.add(key);
          for (const c of this.server.clients) if (c.hello && !c.closed && c.kind !== 'cli') c.send({ t: 'msg', level: 'info', text: `Agent ${line(data.sid)} awaits ${line(p.kind)}: ${line(p.title).slice(0, 256)} — M-x agent-session-answer` });
        }
      }
    }
    if (name === 'gone' && this.sessions.get(data.sid)?.createdAt === data.epoch) this.sessions.delete(data.sid);
    if (name === 'observed' && typeof data.id === 'string') this.observed.set(data.id, data);
    if (name === 'observed' && this.openedObserved.has(data.id)) void this.open(data.id, undefined, this.views.get(`name:*Agent Observed: ${data.id}*`)).catch(() => {});
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
      for (const sid of this.retries.keys()) if (!this.sessions.has(sid)) this.clearRetry(sid);
    }
  }
  scheduleFacts(sid: string) {
    const s = this.sessions.get(sid), f = this.facts.get(sid);
    if (s?.kind === 'acp' && (!f || f.epoch !== s.createdAt || f.head !== (s.acp?.headSeq || 0)))
      void this.refreshFacts(sid).catch(() => {});
  }
  refreshFacts(sid: string): Promise<void> {
    const existing = this.factReads.get(sid); if (existing) return existing;
    const generation = this.listGeneration, valid = () => this.listOpened && this.listGeneration === generation;
    const work = (async () => {
      do {
        const s = this.sessions.get(sid); if (!s || !valid()) return;
        let f = this.facts.get(sid);
        if (!f || f.epoch !== s.createdAt) f = { epoch: s.createdAt, head: 0, model: '' };
        const reply = await this.readEvents(sid, f.head, valid);
        const current = this.sessions.get(sid);
        if (!valid() || !current) return;
        if (current.createdAt !== reply.epoch) continue;
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
        this.facts.set(sid, { epoch: s.createdAt, head: -1, model: `unavailable (${line(this.clean(String(e.message || e).slice(0, 512)))})` });
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
      rows.push({ sid: s.sid, epoch: s.createdAt, state: s.state || (s.alive ? 'running' : 'ended'), harness: o?.harness || s.acp?.agent || s.kind,
        model: o?.model || this.facts.get(s.sid)?.model || modelOf(this.transcripts.get(s.sid)?.controls().configOptions) || 'unknown', host: s.host, project: o?.project || s.cwd,
        activity: [s.acp?.title, s.acp?.activity, o?.tool?.name].filter(Boolean).join(' — '),
        waiting: !!(s.acp?.pending?.length || o?.pending), updated: s.updatedAt || 0 });
    }
    for (const o of this.observed.values()) if (this.sessions.get(o.wbSession)?.host !== o.host) rows.push({ observedId: o.id, state: o.state, harness: o.harness, model: o.model, host: o.host,
      project: o.project, activity: o.pending?.message || o.tool?.name || o.lastMessage || o.title, waiting: !!o.pending, updated: o.lastAt });
    return rows.sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.updated - a.updated || String(a.sid || a.observedId).localeCompare(String(b.sid || b.observedId)));
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
      const oldMeta = sb.meta.bind(sb);
      if (!(sb as SBuf & { agentMeta?: boolean }).agentMeta) {
        (sb as SBuf & { agentMeta?: boolean }).agentMeta = true;
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
    const rows = this.rows();
    const status = this.status === 'connected' ? `${this.status} (hub ${this.hubStatus})` : this.status;
    await this.publish('*Agent Sessions*', 'agent-sessions-mode', `Agent Sessions — ${status}\nSESSION  WAIT  STATE  HARNESS  MODEL  HOST  PROJECT  ACTIVITY\n` + rows.map(r => `${line(r.sid || r.observedId)}  ${r.waiting ? 'WAIT' : '    '}  ${[r.state, r.harness, r.model, r.host, r.project, r.activity].map(line).join('  ')}`).join('\n') + '\n', { agentList: { rows, status } }, valid);
  }
  async list() {
    this.token();
    if (!this.listOpened) { this.listOpened = true; this.listGeneration++; }
    const generation = this.listGeneration;
    const revision = this.registryRevision;
    const [sessions, observed] = await Promise.allSettled([this.request('GET', 'sessions'), this.request('GET', 'observed')]);
    // A snapshot begun or updated during this listing is newer, even before its ready event.
    if (!this.streamActive && revision === this.registryRevision) {
      if (sessions.status === 'rejected' && observed.status === 'rejected') throw sessions.reason;
      this.sessions = new Map((sessions.status === 'fulfilled' ? sessions.value.sessions || [] : []).map((s: Json) => [s.sid, s]));
      this.observed = new Map((observed.status === 'fulfilled' ? observed.value.sessions || [] : []).map((s: Json) => [s.id, s]));
      if (sessions.status === 'rejected' || observed.status === 'rejected') this.status = 'partial — hub or observed registry unavailable';
    }
    this.changed();
    for (const sid of this.sessions.keys()) this.scheduleFacts(sid);
    if (!this.listOpened || this.listGeneration !== generation) throw new Error('Agent list was closed; reopen it');
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
      steerable: !!s && s.kind === 'acp' && s.alive !== false && this.status === 'connected',
      connection: this.status, modeId: view?.modeId ?? null, modes: view?.modes ?? null,
      configOptions: view?.configOptions ?? null, pending
    };
  }
  withState(sid: string, locals: Json): Json {
    const state = this.snapshot(sid), session = locals.agentSession;
    return { ...locals, agentState: state, ...(session ? { agentSession: {
      ...session, pending: state.pending, modeId: state.modeId, modes: state.modes, configOptions: state.configOptions,
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
  async answer(sid: string, kind: 'permission' | 'elicitation', body: Json): Promise<Json> {
    sidOf(sid);
    if (!body || typeof body !== 'object' || !Number.isInteger(body.req) || body.req < 1) throw new Error('An exact pending request id is required');
    const epoch = expectedEpoch(body.epoch), s = await this.requireSession(sid, epoch);
    if (!s.acp?.pending?.some((p: Json) => p.req === body.req && p.kind === kind)) throw new Error('Request is already resolved or no longer pending; refresh the session');
    await this.open(sid, epoch);
    const state = this.snapshot(sid);
    if (epoch !== state.epoch) throw replaced();
    const pending = state.pending.find((p: Json) => p.req === body.req && p.kind === kind);
    if (!pending) throw new Error('Request is already resolved or no longer pending; refresh the session');
    if (kind === 'permission') {
      const outcome = body.outcome;
      if (!outcome || (outcome.outcome !== 'cancelled' && (outcome.outcome !== 'selected' ||
        !Array.isArray(pending.options) || !pending.options.some((option: Json) => typeof option.optionId === 'string' && option.optionId === outcome.optionId)))) {
        throw new Error('Permission outcome must select an offered option or cancel the request');
      }
    }
    return this.request('POST', `sessions/${sid}/${kind}`, body);
  }
  async open(sid: string, epoch?: number, followingView?: number): Promise<string> {
    sidOf(sid);
    const registered = this.sessions.has(sid), revision = this.registryRevision;
    let observed = this.observed.has(sid) && !this.sessions.has(sid), s: Json;
    let id = `name:*Agent${observed ? ' Observed' : ''}: ${sid}*`;
    let generation = followingView ?? this.views.get(id);
    if (generation === undefined) { generation = ++this.nextView; this.views.set(id, generation); }
    const valid = () => this.views.get(id) === generation;
    try { s = await this.request('GET', (observed ? 'observed/' : 'sessions/') + sid); }
    catch (e) {
      if (observed || e.status !== 404) throw e;
      if (!valid()) throw new Error('Agent view was closed; reopen it');
      this.views.delete(id); id = `name:*Agent Observed: ${sid}*`;
      generation = this.views.get(id) ?? ++this.nextView; this.views.set(id, generation);
      s = await this.request('GET', 'observed/' + sid); observed = true;
    }
    if (!valid()) throw new Error('Agent view was closed; reopen it');
    const current = observed ? this.observed.get(sid) : this.sessions.get(sid);
    if (!observed && registered && !current && revision !== this.registryRevision) throw new Error('Agent session was removed; refresh the sessions list');
    // A detail reply begun before a stream update cannot undo its state, removal, incarnation or head.
    if (current && (this.streamActive && revision !== this.registryRevision ||
      (observed ? current.lastAt > s.lastAt : current.createdAt > s.createdAt ||
      current.createdAt === s.createdAt && (current.updatedAt > s.updatedAt || (current.acp?.headSeq || 0) > (s.acp?.headSeq || 0))))) s = current;
    if (epoch !== undefined && s.createdAt !== expectedEpoch(epoch)) throw replaced();
    if (observed) this.observed.set(sid, s); else this.sessions.set(sid, s);
    if (!observed && s.kind === 'acp') {
      // token() validates exactly 64 hexadecimal characters, including rotated tokens retained for redaction.
      if (!this.transcripts.has(sid)) this.transcripts.set(sid, new Transcript(sid, value => this.redactText(value), 63));
      await this.replay(sid);
      if (!valid()) throw new Error('Agent view was closed; reopen it');
      if (epoch !== undefined && this.sessions.get(sid)?.createdAt !== epoch) throw replaced();
      return `name:*Agent: ${sid}*`;
    }
    const name = observed ? `*Agent Observed: ${sid}*` : `*Agent: ${sid}*`;
    if (observed) this.openedObserved.add(sid);
    await this.publish(name, 'agent-session-mode', `# ${sid}\n\n${observed ? 'Reported session: read-only; this hub cannot steer it. Only the reported record and bounded tail are available.\n\n' : 'PTY record: this HTTP API offers no terminal input.\n\n'}${JSON.stringify(s, null, 2)}\n`, { agentSession: { sid, observed: true, epoch: s.createdAt, spans: [] } }, valid);
    return 'name:' + name;
  }
  replay(sid: string): Promise<void> {
    const existing = this.replaying.get(sid); if (existing) return existing;
    const t = this.transcripts.get(sid), generation = this.views.get(`name:*Agent: ${sid}*`);
    if (!t || generation === undefined) return Promise.resolve();
    const valid = () => this.views.get(`name:*Agent: ${sid}*`) === generation && this.transcripts.get(sid) === t;
    this.clearRetry(sid);
    const work = (async () => {
      do {
        const wanted = this.sessions.get(sid);
        if (!valid() || !wanted) return;
        if (t.epoch !== wanted.createdAt) t.reset(wanted.createdAt);
        const reply = await this.readEvents(sid, t.head, valid);
        const current = this.sessions.get(sid);
        if (!valid() || !current) return;
        if (current.createdAt !== reply.epoch) continue;
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
      if (valid()) { this.retryAttempts.delete(sid); this.replayErrors.delete(sid); }
    })().catch(e => {
      const current = this.sessions.get(sid);
      if (!this.stopped && valid() && current) {
        const report = this.clean(String(e.message || e)).slice(0, 1024);
        if (this.replayErrors.get(sid) !== report) {
          this.replayErrors.set(sid, report);
          for (const c of this.server.clients) if (c.hello && !c.closed && c.kind !== 'cli')
            c.send({ t: 'msg', level: 'error', text: `Agent ${sid} journal read failed: ${report}` });
        }
        if (e.retryable !== false && (t.epoch !== current.createdAt || t.head !== (current.acp?.headSeq || 0))) {
          const attempt = (this.retryAttempts.get(sid) || 0) + 1, epoch = current.createdAt;
          this.retryAttempts.set(sid, attempt);
          const timer = setTimeout(() => {
            this.retries.delete(sid);
            if (valid() && this.sessions.get(sid)?.createdAt === epoch) void this.replay(sid).catch(() => {});
          }, Math.min(5000, 250 * 2 ** Math.min(attempt - 1, 5)));
          timer.unref(); this.retries.set(sid, { timer, attempt, epoch, view: generation });
        }
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
    for (const sid of this.retries.keys()) this.clearRetry(sid);
    for (const req of this.requests) req.destroy();
    this.offKill(); this.views.clear(); this.transcripts.clear(); this.openedObserved.clear();
    this.facts.clear(); this.factReads.clear(); this.announced.clear(); this.retryAttempts.clear(); this.replayErrors.clear();
  }
}
export async function install(server: Server) {
  const hub = new AgentSessions(server); modules.set(server, hub);
  if (hub.config) protect(server, hub.config);
  const cmd = (name: string, fn: (args: any[]) => unknown) => server.defineCommand(name, async (_c, args) => { // any: API command arguments validated per command
    try { return { value: hub.clean(await fn(args)) }; } catch (e) { return fail(hub.clean(String(e.message || e))); }
  });
  cmd('agent-sessions', () => hub.list());
  cmd('agent-session-open', a => hub.open(a[0], a[1]));
  cmd('agent-session-info', () => hub.request('GET', 'info'));
  cmd('agent-session-list', async () => (await hub.request('GET', 'sessions')).sessions.filter((s: Json) => s.kind === 'acp'));
  cmd('agent-session-details', async a => { await hub.open(a[0], a[1]); return hub.transcripts.get(a[0])?.controls(); });
  cmd('agent-session-state', a => hub.state(a[0]));
  cmd('agent-session-pending', () => [...hub.sessions.values()].flatMap(s => (s.acp?.pending || []).map((p: Json) => ({ ...p, sid: s.sid, epoch: s.createdAt }))));
  cmd('agent-session-request', async a => {
    await hub.open(a[0], expectedEpoch(a[2]));
    const r = hub.snapshot(a[0]).pending.find((p: Json) => p.req === a[1]);
    if (!r) throw new Error('Request is no longer pending; refresh the session');
    return { ...r, sid: a[0] };
  });
  cmd('agent-session-location', async a => {
    const { sid, epoch, seq, location } = a[0], s = await hub.requireSession(sid, expectedEpoch(epoch));
    const t = hub.transcripts.get(sid), span = t && t.epoch === epoch ? t.render().spans.find(p => p.seq === seq && p.kind === 'tool') : undefined;
    if (!span?.locations?.some((l: Json) => JSON.stringify(l) === JSON.stringify(location))) throw new Error('Tool location is no longer available; refresh the transcript');
    if (s.host !== server.cfg.host) throw new Error(`Tool file is on ${line(s.host)}, not this edwind host; open it there`);
    if (!location || typeof location.path !== 'string') throw new Error('Tool has no file location');
    const file = path.resolve(s.cwd, location.path), real = fs.realpathSync(file);
    server.auth.checkRead(real);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error('Tool location is not a file');
    const found = server.buffers.resolve(file, false);
    if (!('id' in found)) throw new Error('Tool file moved');
    return found.id;
  });
  cmd('agent-session-start', async a => { const r = await hub.request('POST', 'sessions', a[0]); return hub.open(r.sid); });
  for (const action of ['cancel', 'revive', 'mode', 'config', 'prompt']) cmd('agent-session-' + action, async a => {
    const sid = sidOf(a[0]), { epoch, ...body } = a[1] || {};
    await hub.requireSession(sid, epoch);
    expectedEpoch(epoch);
    return hub.request('POST', `sessions/${sid}/${action}`, Object.keys(body).length ? body : undefined);
  });
  for (const action of ['permission', 'elicitation'] as const) cmd('agent-session-' + action, a => hub.answer(a[0], action, a[1]));
  cmd('agent-session-remove', async a => {
    const sid = sidOf(a[0]), epoch = a[1]?.epoch;
    await hub.requireSession(sid, epoch); expectedEpoch(epoch);
    return hub.request('DELETE', 'sessions/' + sid + '?forget=true');
  });
  server.statusProviders.push(() => ({ agentHub: hub.status, agentSessions: hub.sessions.size, agentObserved: hub.observed.size }));
  const primitive = server.L.D('agent-session-open', 'sid', 'Materialise the shared transcript and return name:*Agent: SID* without starting an agent.', () => { throw new server.L.S.SchemeError('cannot-block', 'agent-session-open must run on a Scheme thread', []); });
  primitive.where = 'server';
  primitive.gen = function* ([sid]: SchemeValue[]): SchemeGen { return yield new server.L.S.Block(hub.open(sid), 'agent journal'); };
  hub.stopPrompts = (await installPrompts(server, hub)).stop;
  hub.start();
}
export async function shutdown(server: Server) { const hub = modules.get(server); hub?.stop(); await hub?.stopPrompts?.(); }
