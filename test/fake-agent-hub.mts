// Reference stand-in for the authenticated mesh API; never contacts an agent or another host.
import http from 'node:http';
type Json = Record<string, any>; // any: test wire fixtures mirror extensible ACP JSON
const uint = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function actionFields(body: Json, ...required: string[]) {
  return required.every(k => Object.hasOwn(body, k)) && Object.keys(body).every(k => k === 'epoch' || required.includes(k));
}
export class FakeAgentHub {
  token = 'a'.repeat(64);
  url = '';
  sessions = new Map<string, Json>();
  observed = new Map<string, Json>();
  journals = new Map<string, Json[]>();
  calls: { method: string; path: string; body: Json | undefined }[] = [];
  forwarded: { sid: string; epoch: number; action: string }[] = [];
  streams = new Set<http.ServerResponse>();
  server = http.createServer((req, res) => void this.handle(req, res));
  configSupported = true;
  sessionActionEpoch = true;
  refusal: { status: number; body: unknown } | null = null;
  truncated = false;
  async start(): Promise<this> {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Stub has no TCP listener');
    this.url = `http://127.0.0.1:${address.port}`; return this;
  }
  async stop(): Promise<void> { for (const res of this.streams) res.destroy(); this.server.closeAllConnections(); await new Promise<void>(r => this.server.close(() => r())); }
  emit(name: string, data: Json) { const wire = `event: ${name}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`; for (const res of this.streams) { res.write(wire.slice(0, 7)); res.write(wire.slice(7)); } }
  add(sid: string, events: Json[] = []): Json {
    const s = { sid, kind: 'acp', host: 'test', cwd: '/project', state: 'idle', alive: true, createdAt: Date.now(), updatedAt: Date.now(), acp: { agent: 'stub', title: 'Work', activity: 'none', pending: [], headSeq: events.at(-1)?.seq || 0, revivable: true } };
    this.sessions.set(sid, s); this.journals.set(sid, events); this.emit('session', s); return s;
  }
  append(sid: string, event: Json) {
    const s = this.sessions.get(sid)!, events = this.journals.get(sid)!;
    const ev: Json = { ts: Date.now(), ...event, seq: event.seq ?? (events.at(-1)?.seq || 0) + 1 };
    events.push(ev); s.acp.headSeq = ev.seq; s.updatedAt = Date.now();
    if (ev.e === 'permission' || ev.e === 'elicitation') s.acp.pending.push({ req: ev.seq, kind: ev.e, title: ev.toolCall?.title || ev.request?.message || '' });
    if (ev.e.endsWith('_resolved')) s.acp.pending = s.acp.pending.filter((p: Json) => p.req !== ev.req);
    this.emit('session', s); return ev;
  }
  async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${this.token}`) { reply(401, { error: 'unauthorized' }); return; }
    const badBody = () => reply(400, { code: 'bad_request', error: 'bad body' });
    const badQuery = () => reply(400, { code: 'bad_request', error: 'bad query' });
    const notFound = () => reply(404, { code: 'not_found', error: 'not found' });
    const target = req.url!, method = req.method!;
    let text = ''; for await (const chunk of req) text += chunk;
    let body: Json | undefined;
    try { body = text ? JSON.parse(text) : undefined; } catch { return badBody(); }
    this.calls.push({ method, path: target, body });
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) return badBody();
    if (this.refusal) { reply(this.refusal.status, this.refusal.body); return; }
    if (method === 'GET' && target === '/v1/info') { reply(200, { host: 'test', hub: { status: 'up' }, agents: [{ name: 'stub', label: 'Stub' }], hosts: [{ name: 'remote', agents: [{ name: 'stub', label: 'Remote stub' }] }] }); return; }
    if (method === 'GET' && target === '/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); this.streams.add(res); res.on('close', () => this.streams.delete(res));
      res.write('event: hub\ndata: {"status":"up"}\n\n');
      for (const s of this.sessions.values()) res.write(`event: session\ndata: ${JSON.stringify(s)}\n\n`);
      for (const o of this.observed.values()) res.write(`event: observed\ndata: ${JSON.stringify(o)}\n\n`);
      res.write('event: ready\ndata: {}\n\n'); return;
    }
    // Match the raw target so URL normalization cannot turn a different path into a valid action.
    const route = /^\/v1\/(sessions|observed)(?:\/([A-Za-z0-9_-]{1,64})(\/[^?]*)?)?(\?.*)?$/.exec(target);
    if (!route) return notFound();
    const [, collection, sid, action = '', query = ''] = route;
    if (collection === 'observed') {
      if (method !== 'GET' || action || query) return notFound();
      if (!sid) return reply(200, { sessions: [...this.observed.values()] });
      const o = this.observed.get(sid); return o ? reply(200, o) : notFound();
    }
    if (!sid) {
      if (query) return badQuery();
      if (method === 'GET') return reply(200, { host: 'test', sessions: [...this.sessions.values()] });
      if (method !== 'POST') return notFound();
      if (!body) return badBody();
      const sid = 'api_' + (this.sessions.size + 1), s = this.add(sid);
      Object.assign(s, { host: body.host || 'test', cwd: body.cwd }); s.acp.agent = body.agent;
      return reply(201, { sid, session: s });
    }
    const s = this.sessions.get(sid);
    if (!s) return reply(404, { error: 'no session', code: 'not_found' });
    if (method === 'GET' && action === '/events') {
      const cursor = /^(?:\?since=(\d+))?$/.exec(query), since = Number(cursor?.[1] ?? 0);
      if (!cursor || !uint(since)) return badQuery();
      const reset = since > s.acp.headSeq;
      const events = this.journals.get(sid)!.filter(e => reset || e.seq > since || s.acp.pending.some((p: Json) => p.req === e.seq));
      reply(200, { sid, epoch: s.createdAt, head: s.acp.headSeq, from: reset ? events[0]?.seq || 1 : since + 1, reset, truncated: this.truncated, events }); return;
    }
    if (method === 'GET' && !action && !query) return reply(200, s);
    if (method === 'POST' && (action === '/permission' || action === '/elicitation')) {
      if (query) return badQuery();
      if (!body) return badBody();
      if (body.epoch !== s.createdAt) return reply(409, { error: 'stale incarnation', code: 'stale' });
      if (!s.acp.pending.some((p: Json) => p.req === body.req)) return reply(409, { error: 'already answered', code: 'already_resolved' });
      this.append(sid, { e: action.slice(1) + '_resolved', ...body, by: 'user' });
      return reply(200, {});
    }

    const guarded = /^\/epochs\/(\d+)(\/cancel)?$/.exec(action);
    const endpoint = guarded ? guarded[2] || '' : action;
    const remove = method === 'DELETE' && !endpoint;
    let epoch: unknown;
    if (remove || method === 'POST' && (endpoint === '/cancel' || endpoint === '/revive')) {
      if (body !== undefined) return badBody();
      if (remove ? !/^\?forget=(true|false)$/.test(query) : query) return badQuery();
      if (guarded) epoch = Number(guarded[1]);
    } else {
      if (method !== 'POST') return notFound();
      switch (action) {
        case '/prompt':
          if (!body || !(actionFields(body, 'text') && typeof body.text === 'string' ||
                         actionFields(body, 'blocks') && Array.isArray(body.blocks))) return badBody();
          break;
        case '/mode':
          if (!body || !actionFields(body, 'modeId') || typeof body.modeId !== 'string') return badBody();
          break;
        case '/config':
          if (!this.configSupported) return notFound();
          if (!body || !actionFields(body, 'id', 'value') || typeof body.id !== 'string') return badBody();
          break;
        default: return notFound();
      }
      if (query) return badQuery();
      epoch = body.epoch;
    }

    if (epoch !== undefined) {
      if (!uint(epoch)) return reply(400, { code: 'bad_request', error: guarded ? 'bad epoch' : 'bad body' });
      if (!this.sessionActionEpoch) return reply(400, { code: 'bad_request', error: 'sessionActionEpoch is not supported' });
      if (epoch !== s.createdAt) return reply(409, { error: 'stale incarnation', code: 'stale' });
    }
    this.forwarded.push({ sid, epoch: s.createdAt, action: remove ? 'remove' : endpoint.slice(1) });
    if (remove) { this.sessions.delete(sid); this.emit('gone', { sid, epoch: s.createdAt }); }
    if (action === '/prompt') this.append(sid, { e: 'prompt', prompt: body!.blocks || [{ type: 'text', text: body!.text }] });
    reply(200, {});
  }
}
