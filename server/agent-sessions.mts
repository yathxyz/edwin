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
  requireSession(sid: string): Promise<Json>;
  open(sid: string): Promise<string>;
  promptBlocks(sid: string, seq: number): Promise<unknown[]>;
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
  declare publishing: Promise<void>; declare listOpened: boolean;
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
    this.stream = null; this.requests = new Set(); this.generation = 0; this.publishing = Promise.resolve(); this.listOpened = false;
  }
  clean<T>(value: T): T {
    if (value === undefined) return value;
    const redact = (s: string) => { for (const token of this.#secrets) s = s.split(token).join('[redacted]'); return s; };
    return typeof value === 'string' ? redact(value) as T : JSON.parse(redact(JSON.stringify(value))) as T;
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
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
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
            reject(Object.assign(new Error(`Agent hub ${status}${error.code ? ' (' + error.code + ')' : ''}: ${typeof error.error === 'string' ? error.error : 'request refused'}`), { status }));
          }
        });
      });
      this.requests.add(req); req.on('close', () => this.requests.delete(req));
      req.on('timeout', () => req.destroy());
      req.on('error', () => reject(new Error('Agent hub cannot be reached or did not answer; a write may already have acted')));
      req.end(data);
    });
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
          if (res.statusCode !== 200) { res.resume(); reject(new Error('stream refused')); return; }
          // Every connection is a fresh authoritative snapshot, including observed removals while offline.
          this.streamActive = true; this.registryRevision++;
          this.sessions.clear(); this.observed.clear(); this.status = 'snapshot'; this.changed();
          res.setEncoding('utf8'); let rest = '', event = '', data: string[] = [];
          res.on('data', (chunk: string) => {
            if (gen !== this.generation) return;
            rest += chunk; let nl: number;
            while ((nl = rest.indexOf('\n')) >= 0) {
              const s = rest.slice(0, nl).replace(/\r$/, ''); rest = rest.slice(nl + 1);
              if (!s) { if (data.length) { try { this.event(event, this.clean(JSON.parse(data.join('\n')))); } catch { req.destroy(); } } event = ''; data = []; }
              else if (s.startsWith('event:')) event = s.slice(6).trim();
              else if (s.startsWith('data:')) data.push(s.slice(5).replace(/^ /, ''));
            }
          });
          res.on('end', resolve); res.on('error', reject);
        });
        this.stream = req; req.on('timeout', () => req.destroy()); req.on('error', reject);
        req.on('close', resolve);
      });
    } catch { /* transport diagnostics deliberately contain no remote text or headers */ }
    this.streamActive = false;
    if (this.stopped || gen !== this.generation) return;
    this.status = 'offline (last known records)'; this.changed();
    this.reconnect = setTimeout(() => void this.follow(gen), 1000); this.reconnect.unref();
  }
  event(name: string, data: Json) {
    this.registryRevision++;
    if (name === 'hub') { this.sessions.clear(); this.hubStatus = line(data.status); this.status = `hub ${this.hubStatus}`; }
    if (name === 'session' && typeof data.sid === 'string') this.sessions.set(data.sid, data);
    if (name === 'session') {
      const t = this.transcripts.get(data.sid);
      if (t && (t.head < data.acp?.headSeq || t.epoch !== data.createdAt)) void this.replay(data.sid).catch(() => {});
      for (const p of data.acp?.pending || []) {
        const key = `${data.sid}/${data.createdAt}/${p.req}`;
        if (!this.announced.has(key)) {
          this.announced.add(key);
          for (const c of this.server.clients) if (c.hello && !c.closed && c.kind !== 'cli') c.send({ t: 'msg', level: 'info', text: `Agent ${line(data.sid)} awaits ${line(p.kind)}: ${line(p.title)} — M-x agent-session-answer` });
        }
      }
    }
    if (name === 'gone' && this.sessions.get(data.sid)?.createdAt === data.epoch) this.sessions.delete(data.sid);
    if (name === 'observed' && typeof data.id === 'string') this.observed.set(data.id, data);
    if (name === 'observed' && this.openedObserved.has(data.id)) void this.open(data.id).catch(() => {});
    if (name === 'observed_gone') this.observed.delete(data.id);
    if (name === 'ready') this.status = 'connected';
    this.changed();
  }
  changed() {
    if (this.listOpened) for (const s of this.sessions.values()) {
      const f = this.facts.get(s.sid);
      if (s.kind === 'acp' && (!f || f.epoch !== s.createdAt || f.head < s.acp?.headSeq)) void this.refreshFacts(s.sid).catch(() => {});
    }
    if (this.listOpened) this.publishing = this.publishing.then(() => this.drawList()).catch(() => {});
  }
  refreshFacts(sid: string): Promise<void> {
    const existing = this.factReads.get(sid); if (existing) return existing;
    const work = (async () => {
      do {
        const s = this.sessions.get(sid); if (!s) return;
        let f = this.facts.get(sid);
        if (!f || f.epoch !== s.createdAt) f = { epoch: s.createdAt, head: 0, model: '' };
        const reply = await this.request('GET', `sessions/${sid}/events?since=${f.head}`) as TranscriptReply;
        if (this.sessions.get(sid)?.createdAt !== reply.epoch) continue;
        if (reply.reset || reply.epoch !== f.epoch) f = { epoch: reply.epoch, head: 0, model: '' };
        for (const e of reply.events) {
          if (e.sessionId) continue;
          if (Array.isArray(e.configOptions)) f.model = modelOf(e.configOptions);
          if (Array.isArray(e.update?.configOptions)) f.model = modelOf(e.update.configOptions);
        }
        f.head = reply.head; this.facts.set(sid, f);
        if (this.listOpened) this.publishing = this.publishing.then(() => this.drawList()).catch(() => {});
        if ((this.sessions.get(sid)?.acp?.headSeq || 0) <= f.head) break;
      } while (!this.stopped);
    })().finally(() => this.factReads.delete(sid));
    this.factReads.set(sid, work); return work;
  }
  rows(): Json[] {
    const rows: Json[] = [];
    for (const s of this.sessions.values()) {
      const o = [...this.observed.values()].find(o => o.wbSession === s.sid && o.host === s.host);
      rows.push({ sid: s.sid, state: s.state || (s.alive ? 'running' : 'ended'), harness: o?.harness || s.acp?.agent || s.kind,
        model: o?.model || this.facts.get(s.sid)?.model || modelOf(this.transcripts.get(s.sid)?.render().configOptions) || 'unknown', host: s.host, project: o?.project || s.cwd,
        activity: [s.acp?.title, s.acp?.activity, o?.tool?.name].filter(Boolean).join(' — '),
        waiting: !!(s.acp?.pending?.length || o?.pending), updated: s.updatedAt || 0 });
    }
    for (const o of this.observed.values()) if (!rows.some(r => r.sid === o.wbSession && r.host === o.host)) rows.push({ observedId: o.id, state: o.state, harness: o.harness, model: o.model, host: o.host,
      project: o.project, activity: o.pending?.message || o.tool?.name || o.lastMessage || o.title, waiting: !!o.pending, updated: o.lastAt });
    return rows.sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.updated - a.updated || String(a.sid || a.observedId).localeCompare(String(b.sid || b.observedId)));
  }
  async publish(name: string, mode: string, text: string, locals: Json): Promise<SBuf> {
    const B = this.server.buffers, id = 'name:' + name;
    let sb = B.byId.get(id);
    if (!sb) sb = B.create({ id, jid: randomId(), name, file: null, text: '', special: true });
    sb.ed.mode = mode; sb.setReadOnly('Agent session view is read-only');
    const clean = this.clean(text);
    if (!sb.clients.size) await B.replaceText(sb, clean, { kind: 'server', thread: 'agent sessions' });
    else {
      sb.ed.agentLocals = {};
      for (const [pos, del, ins] of diffOps(sb.text, clean)) {
        for (const [body, deleting] of [[del, true], [ins, false]] as const) {
          for (let at = 0; at < body.length;) {
            let end = Math.min(body.length, at + 65536);
            if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end--;
            const part = body.slice(at, end), point = deleting ? pos : pos + at;
            const entry = B.seq.applyBatch(sb, [[point, deleting ? part : '', deleting ? '' : part]], { kind: 'server', thread: 'agent sessions' });
            await B.seq.commit(sb, entry, null); await yieldTurn();
            at = end;
          }
        }
      }
    }
    sb.ed.undo = []; sb.ed.redo = []; sb.ed.modified = false;
    const oldMeta = sb.meta.bind(sb);
    if (!(sb as SBuf & { agentMeta?: boolean }).agentMeta) {
      (sb as SBuf & { agentMeta?: boolean }).agentMeta = true;
      sb.meta = () => ({ ...oldMeta(), modified: false, locals: (sb!.ed.agentLocals || {}) });
    }
    sb.ed.agentLocals = this.clean(locals); B.sendMeta(sb); return sb;
  }
  async drawList() {
    const rows = this.rows();
    const status = this.status === 'connected' ? `${this.status} (hub ${this.hubStatus})` : this.status;
    await this.publish('*Agent Sessions*', 'agent-sessions-mode', `Agent Sessions — ${status}\nSESSION  WAIT  STATE  HARNESS  MODEL  HOST  PROJECT  ACTIVITY\n` + rows.map(r => `${line(r.sid || r.observedId)}  ${r.waiting ? 'WAIT' : '    '}  ${[r.state, r.harness, r.model, r.host, r.project, r.activity].map(line).join('  ')}`).join('\n') + '\n', { agentList: { rows, status } });
  }
  async list() {
    this.token(); this.listOpened = true;
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
    await this.drawList(); return 'name:*Agent Sessions*';
  }
  async requireSession(sid: string): Promise<Json> {
    sidOf(sid); if (this.observed.has(sid) && !this.sessions.has(sid)) throw new Error('Reported session is read-only and cannot be steered');
    const s = await this.request('GET', 'sessions/' + sid);
    if (s.kind !== 'acp') throw new Error('This session is not a hub-run ACP agent and cannot be steered');
    s.promptCapabilities ??= this.transcripts.get(sid)?.render().promptCapabilities;
    return s;
  }
  async open(sid: string): Promise<string> {
    sidOf(sid);
    let observed = this.observed.has(sid) && !this.sessions.has(sid), s: Json;
    try { s = await this.request('GET', (observed ? 'observed/' : 'sessions/') + sid); }
    catch (e) {
      if (observed || e.status !== 404) throw e;
      s = await this.request('GET', 'observed/' + sid); observed = true;
    }
    const current = observed ? this.observed.get(sid) : this.sessions.get(sid);
    // An in-flight detail reply must not undo a newer stream incarnation or head.
    if (current && (observed ? current.lastAt > s.lastAt : current.createdAt > s.createdAt ||
      current.createdAt === s.createdAt && (current.updatedAt > s.updatedAt || (current.acp?.headSeq || 0) > (s.acp?.headSeq || 0)))) s = current;
    if (observed) this.observed.set(sid, s);
    if (!observed && s.kind === 'acp') {
      this.sessions.set(sid, s);
      if (!this.transcripts.has(sid) || !this.server.buffers.byId.has(`name:*Agent: ${sid}*`)) this.transcripts.set(sid, new Transcript(sid));
      await this.replay(sid);
      return `name:*Agent: ${sid}*`;
    }
    const name = observed ? `*Agent Observed: ${sid}*` : `*Agent: ${sid}*`;
    if (observed) this.openedObserved.add(sid);
    await this.publish(name, 'agent-session-mode', `# ${sid}\n\n${observed ? 'Reported session: read-only; this hub cannot steer it. Only the reported record and bounded tail are available.\n\n' : 'PTY record: this HTTP API offers no terminal input.\n\n'}${JSON.stringify(s, null, 2)}\n`, { agentSession: { sid, observed: true, epoch: s.createdAt, spans: [] } });
    return 'name:' + name;
  }
  replay(sid: string): Promise<void> {
    const existing = this.replaying.get(sid); if (existing) return existing;
    const work = (async () => {
      const t = this.transcripts.get(sid)!;
      do {
        const epoch = this.sessions.get(sid)?.createdAt;
        if (typeof epoch === 'number' && t.epoch !== epoch) t.reset(epoch);
        const reply = await this.request('GET', `sessions/${sid}/events?since=${t.head}`) as TranscriptReply;
        if (this.sessions.get(sid)?.createdAt !== reply.epoch) continue;
        t.apply(reply);
        const view = t.render();
        await this.publish(`*Agent: ${sid}*`, 'agent-transcript-mode', view.text, { agentSession: { ...view, text: undefined, host: this.sessions.get(sid)?.host } });
        if ((this.sessions.get(sid)?.acp?.headSeq || 0) <= t.head) break;
      } while (!this.stopped);
    })().finally(() => this.replaying.delete(sid));
    this.replaying.set(sid, work); return work;
  }
  async promptBlocks(sid: string, seq: number): Promise<unknown[]> {
    sidOf(sid);
    if (!Number.isInteger(seq) || seq < 1) throw new Error('A journal prompt sequence is required');
    await this.open(sid);
    const event = this.transcripts.get(sid)?.journal.find(e => e.seq === seq && e.e === 'prompt');
    if (!event || !Array.isArray(event.prompt)) throw new Error('That prompt is not available in the hub journal replay');
    return event.prompt;
  }
  stop() { this.stopped = true; this.generation++; clearTimeout(this.reconnect); this.stream?.destroy(); for (const req of this.requests) req.destroy(); }
}
export async function install(server: Server) {
  const hub = new AgentSessions(server); modules.set(server, hub);
  if (hub.config) protect(server, hub.config);
  const cmd = (name: string, fn: (args: any[]) => unknown) => server.defineCommand(name, async (_c, args) => { // any: API command arguments validated per command
    try { return { value: hub.clean(await fn(args)) }; } catch (e) { return fail(hub.clean(String(e.message || e))); }
  });
  cmd('agent-sessions', () => hub.list());
  cmd('agent-session-open', a => hub.open(a[0]));
  cmd('agent-session-info', () => hub.request('GET', 'info'));
  cmd('agent-session-list', async () => (await hub.request('GET', 'sessions')).sessions.filter((s: Json) => s.kind === 'acp'));
  cmd('agent-session-details', async a => { await hub.open(a[0]); return { ...hub.transcripts.get(a[0])?.render(), text: undefined }; });
  cmd('agent-session-pending', () => [...hub.sessions.values()].flatMap(s => (s.acp?.pending || []).map((p: Json) => ({ ...p, sid: s.sid, epoch: s.createdAt }))));
  cmd('agent-session-request', async a => {
    await hub.open(a[0]);
    const r = hub.transcripts.get(a[0])?.render().pending.find((p: Json) => p.req === a[1]);
    if (!r) throw new Error('Request is no longer pending; refresh the session');
    return { ...r, sid: a[0] };
  });
  cmd('agent-session-location', async a => {
    const { sid, location } = a[0], s = await hub.requireSession(sid);
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
  for (const action of ['cancel', 'revive', 'mode', 'config', 'prompt', 'permission', 'elicitation']) cmd('agent-session-' + action, async a => { const sid = sidOf(a[0]); await hub.requireSession(sid); return hub.request('POST', `sessions/${sid}/${action}`, a[1]); });
  cmd('agent-session-remove', a => hub.request('DELETE', 'sessions/' + sidOf(a[0]) + '?forget=true'));
  server.statusProviders.push(() => ({ agentHub: hub.status, agentSessions: hub.sessions.size, agentObserved: hub.observed.size }));
  const primitive = server.L.D('agent-session-open', 'sid', 'Materialise the shared transcript and return name:*Agent: SID* without starting an agent.', () => { throw new server.L.S.SchemeError('cannot-block', 'agent-session-open must run on a Scheme thread', []); });
  primitive.where = 'server';
  primitive.gen = function* ([sid]: SchemeValue[]): SchemeGen { return yield new server.L.S.Block(hub.open(sid), 'agent journal'); };
  hub.stopPrompts = (await installPrompts(server, hub)).stop;
  hub.start();
}
export async function shutdown(server: Server) { const hub = modules.get(server); hub?.stop(); await hub?.stopPrompts?.(); }
