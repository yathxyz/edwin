// Reference stand-in for the authenticated mesh API; never contacts an agent or another host.
import http from 'node:http';
type Json = Record<string, any>; // any: test wire fixtures mirror extensible ACP JSON
export class FakeAgentHub {
  token = 'a'.repeat(64);
  url = '';
  sessions = new Map<string, Json>();
  observed = new Map<string, Json>();
  journals = new Map<string, Json[]>();
  calls: { method: string; path: string; body: Json | undefined }[] = [];
  streams = new Set<http.ServerResponse>();
  server = http.createServer((req, res) => void this.handle(req, res));
  configSupported = true;
  refusal: { status: number; body: Json } | null = null;
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
    const u = new URL(req.url!, 'http://stub/');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) as Json : undefined;
    this.calls.push({ method: req.method!, path: req.url!, body });
    if (this.refusal) { reply(this.refusal.status, this.refusal.body); return; }
    const route = u.pathname.slice(4).split('/');
    if (req.method === 'GET' && u.pathname === '/v1/info') { reply(200, { host: 'test', hub: { status: 'up' }, agents: [{ name: 'stub', label: 'Stub' }], hosts: [{ name: 'remote', agents: [{ name: 'stub', label: 'Remote stub' }] }] }); return; }
    if (req.method === 'GET' && u.pathname === '/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); this.streams.add(res); res.on('close', () => this.streams.delete(res));
      res.write('event: hub\ndata: {"status":"up"}\n\n');
      for (const s of this.sessions.values()) res.write(`event: session\ndata: ${JSON.stringify(s)}\n\n`);
      for (const o of this.observed.values()) res.write(`event: observed\ndata: ${JSON.stringify(o)}\n\n`);
      res.write('event: ready\ndata: {}\n\n'); return;
    }
    if (route[0] === 'observed') { const o = this.observed.get(route[1]); reply(route[1] && !o ? 404 : 200, route[1] ? o || { error: 'not found' } : { sessions: [...this.observed.values()] }); return; }
    if (route[0] === 'sessions' && !route[1]) {
      if (req.method === 'POST') { const sid = 'api_' + (this.sessions.size + 1), s = this.add(sid); Object.assign(s, { host: body!.host || 'test', cwd: body!.cwd }); s.acp.agent = body!.agent; reply(201, { sid, session: s }); }
      else reply(200, { host: 'test', sessions: [...this.sessions.values()] }); return;
    }
    const sid = route[1], s = this.sessions.get(sid);
    if (!s) { reply(404, { error: 'no session', code: 'not_found' }); return; }
    if (route[2] === 'events') { const since = Number(u.searchParams.get('since') || 0); reply(200, { sid, epoch: s.createdAt, head: s.acp.headSeq, from: since + 1, reset: since > s.acp.headSeq, truncated: this.truncated, events: this.journals.get(sid)!.filter(e => e.seq > since || s.acp.pending.some((p: Json) => p.req === e.seq)) }); return; }
    if (!route[2] && req.method === 'GET') { reply(200, s); return; }
    if (req.method === 'DELETE') { this.sessions.delete(sid); this.emit('gone', { sid, epoch: s.createdAt }); reply(200, {}); return; }
    if (route[2] === 'config' && !this.configSupported) { reply(404, { error: 'not found' }); return; }
    if (route[2] === 'permission' || route[2] === 'elicitation') {
      if (body!.epoch !== s.createdAt) { reply(409, { error: 'stale incarnation', code: 'stale' }); return; }
      if (!s.acp.pending.some((p: Json) => p.req === body!.req)) { reply(409, { error: 'already answered', code: 'already_resolved' }); return; }
      this.append(sid, { e: route[2] + '_resolved', ...body, by: 'user' });
    }
    if (route[2] === 'prompt') this.append(sid, { e: 'prompt', prompt: body!.blocks || [{ type: 'text', text: body!.text }] });
    reply(200, {});
  }
}
