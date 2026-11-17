/* Derived ACP transcripts: the journal is the record, Markdown is only its presentation. No I/O here.
   Fold once per reply, render once per publication; streaming chunks are collected, never repeatedly joined. */
type Wire = Record<string, any>;
export interface TranscriptReply { epoch: number; head: number; from: number; reset: boolean; truncated: boolean; events: Wire[] }
interface Block {
  id: string; kind: string; seq: number; lastSeq: number; events: Wire[];
  role?: string; variant?: string; messageId?: unknown; sessionId?: unknown;
  content?: unknown[]; blocks?: unknown[]; tool?: Wire; current?: Wire;
}
interface RequestState extends Wire { req: number; kind: string; status: string }
const object = (v: unknown): v is Wire => !!v && typeof v === 'object' && !Array.isArray(v);
const json = (v: unknown) => JSON.stringify(v, null, 2) ?? String(v);
const line = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
const own = (v: Wire, k: string) => Object.prototype.hasOwnProperty.call(v, k);
const LONG_CHARS = 4000, LONG_LINES = 12;

/* Text is not escaped, elided or split at Markdown-looking input. Non-text resources retain their full JSON.
   Consecutive text chunks have no separator: a journal boundary is not a message boundary. */
function contentText(blocks: unknown[], diffs?: Wire[], base = 0): string {
  const out: string[] = []; let pos = 0;
  const put = (s: string) => { out.push(s); pos += s.length; };
  for (const c of blocks) {
    if (typeof c === 'string') put(c);
    else if (object(c) && c.type === 'text' && typeof c.text === 'string') put(c.text);
    else if (object(c) && c.type === 'content' && own(c, 'content')) put(contentText([c.content], diffs, base + pos));
    else if (object(c) && c.type === 'diff') {
      const d: Wire = { path: c.path };
      put(`\nDiff: ${line(c.path)}\nOld text:\n`);
      if (typeof c.oldText === 'string') { d.oldStart = base + pos; put(c.oldText); d.oldEnd = base + pos; }
      else put(json(c.oldText));
      put('\nNew text:\n');
      if (typeof c.newText === 'string') { d.newStart = base + pos; put(c.newText); d.newEnd = base + pos; }
      else put(json(c.newText));
      put('\n'); if (diffs) diffs.push(d);
    } else put('\n' + json(c) + '\n');
  }
  return out.join('');
}
function long(text: string) {
  if (text.length > LONG_CHARS) return true;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++n >= LONG_LINES) return true;
  return false;
}
/* Raw tool payloads remain inspectable, as do overwritten output/location/content values. Literal content is
   shown too: JSON alone would turn the bytes of multiline output into escaped strings. */
function toolHistory(events: Wire[]) {
  const out: string[] = [], diffs: Wire[] = []; let pos = 0;
  const put = (s: string) => { out.push(s); pos += s.length; };
  for (const e of events) {
    const u = object(e.update) ? e.update : e;
    put(`### Update #${e.seq}\n`);
    if (Array.isArray(u.content)) { put(contentText(u.content, diffs, pos)); put('\n'); }
    if (typeof u.rawOutput === 'string') { put(u.rawOutput); put('\n'); }
    put(json(e)); put('\n\n');
  }
  return { text: out.join(''), diffs };
}

export class Transcript {
  readonly sid: string;
  epoch = 0;
  head = 0;
  private events: Wire[] = [];
  private seen = new Set<number>();
  private blocks: Block[] = [];
  private tools = new Map<string, Block>();
  private requests = new Map<number, RequestState>();
  private plans = new Map<string, Block>();
  private messageBlock: Block | null = null;
  private modes: unknown = null;
  private modeId: unknown = null;
  private configOptions: unknown = null;
  private promptCapabilities: unknown = null;
  private availableCommands: unknown = null;
  private usage: unknown = null;
  private from = 1;
  private truncated = false;
  private gaps: Wire[] = [];
  private cached: ReturnType<Transcript['build']> | null = null;

  constructor(sid: string) { this.sid = sid; }
  /* Inspection without putting the full replay into buffer metadata or duplicating it on edit.sock. */
  get journal(): readonly Wire[] { return this.events; }
  reset(epoch: number) {
    this.epoch = epoch; this.head = 0; this.from = 1; this.truncated = false; this.gaps = [];
    this.events = []; this.seen.clear(); this.clearFold(); this.cached = null;
  }
  private clearFold() {
    this.blocks = []; this.tools.clear(); this.requests.clear(); this.plans.clear(); this.messageBlock = null;
    this.modes = this.modeId = this.configOptions = this.promptCapabilities = this.availableCommands = this.usage = null;
  }
  apply(reply: TranscriptReply): void {
    if (reply.reset || reply.epoch !== this.epoch) this.reset(reply.epoch);
    const oldHead = this.head, fresh: Wire[] = [];
    for (const e of reply.events) {
      if (!this.seen.has(e.seq)) { this.seen.add(e.seq); fresh.push(e); }
    }
    /* A pinned request can be older than our cursor but not yet present locally. Keep it, at its proper
       place. Usually replies append in order; only late/unsorted events need a batch-wide merge/refold. */
    let ordered = true, previous = this.events.length ? this.events[this.events.length - 1].seq : -Infinity;
    for (const e of fresh) { if (e.seq <= previous) ordered = false; previous = e.seq; }
    if (ordered) { for (const e of fresh) { this.events.push(e); this.fold(e); } }
    else {
      for (const e of fresh) this.events.push(e);
      this.events.sort((a, b) => a.seq - b.seq); this.clearFold();
      for (const e of this.events) this.fold(e);
    }
    if (!oldHead) this.from = reply.from;
    if (reply.truncated) {
      this.truncated = true;
      const gap = { after: oldHead, from: reply.from, head: reply.head };
      if (!this.gaps.some(g => g.after === gap.after && g.from === gap.from && g.head === gap.head)) this.gaps.push(gap);
    }
    this.head = Math.max(this.head, reply.head, this.events.length ? this.events[this.events.length - 1].seq : 0);
    this.cached = null;
  }
  private block(e: Wire, kind: string): Block {
    const b: Block = { id: `${this.epoch}:${kind}:${e.seq}`, seq: e.seq, lastSeq: e.seq, kind, events: [e], sessionId: e.sessionId };
    this.blocks.push(b); return b;
  }
  private setup(v: Wire) {
    if (own(v, 'modes')) {
      this.modes = v.modes;
      this.modeId = object(v.modes) && own(v.modes, 'currentModeId') ? v.modes.currentModeId : null;
    }
    if (own(v, 'modeId')) {
      this.modeId = v.modeId;
      this.modes = { ...(object(this.modes) ? this.modes : {}), currentModeId: v.modeId };
    }
    if (own(v, 'configOptions')) this.configOptions = v.configOptions;
    if (own(v, 'promptCapabilities')) this.promptCapabilities = v.promptCapabilities;
    else if (object(v.agentCapabilities) && own(v.agentCapabilities, 'promptCapabilities')) this.promptCapabilities = v.agentCapabilities.promptCapabilities;
    if (own(v, 'availableCommands')) this.availableCommands = v.availableCommands;
    if (own(v, 'usage')) this.usage = v.usage;
  }
  private fold(e: Wire) {
    const lastMessage = this.messageBlock; this.messageBlock = null;
    if (e.e === 'session' || e.e === 'initialize') this.setup(e);
    if (e.e === 'mode') this.setup(e);
    if (e.e === 'prompt') {
      const b = this.block(e, 'prompt'); b.blocks = Array.isArray(e.prompt) ? e.prompt : [e.prompt]; return;
    }
    if (e.e === 'permission' || e.e === 'elicitation') {
      const req: RequestState = { ...e, req: e.seq, kind: e.e, status: 'pending', event: e, epoch: this.epoch };
      this.requests.set(req.req, req); this.block(e, e.e); return;
    }
    if (e.e === 'permission_resolved' || e.e === 'elicitation_resolved') {
      const kind = e.e === 'permission_resolved' ? 'permission' : 'elicitation';
      const req = this.requests.get(e.req) || { req: e.req, kind, epoch: this.epoch };
      this.requests.set(e.req, { ...req, status: 'resolved', resolution: e }); this.block(e, e.e); return;
    }
    if (e.e === 'elicitation_complete') {
      for (const req of this.requests.values()) if (req.kind === 'elicitation' && req.event?.request?.elicitationId === e.elicitationId) {
        req.complete = e; req.status = 'complete';
      }
      this.block(e, e.e); return;
    }
    if (e.e === 'update' && object(e.update)) {
      const u = e.update, variant = u.sessionUpdate;
      if (variant === 'agent_message_chunk' || variant === 'agent_thought_chunk' || variant === 'user_message_chunk') {
        const last = lastMessage;
        const same = last && last.variant === variant && (last.messageId ?? null) === (u.messageId ?? null) && (last.sessionId ?? null) === (e.sessionId ?? null);
        const b = same ? last! : this.block(e, variant === 'agent_thought_chunk' ? 'thought' : 'message');
        if (same) b.events.push(e);
        b.lastSeq = e.seq; b.variant = variant; b.messageId = u.messageId; b.sessionId = e.sessionId;
        b.role = variant === 'user_message_chunk' ? 'user' : 'assistant';
        (b.content ||= []).push(u.content); this.messageBlock = b; return;
      }
      if (variant === 'tool_call' || variant === 'tool_call_update') {
        const key = JSON.stringify([e.sessionId ?? null, u.toolCallId ?? e.seq]);
        let b = this.tools.get(key);
        if (!b) { b = this.block(e, 'tool'); b.tool = {}; this.tools.set(key, b); }
        else b.events.push(e);
        b.lastSeq = e.seq;
        for (const k of Object.keys(u)) if (u[k] !== null && u[k] !== undefined) b.tool![k] = u[k];
        return;
      }
      if (variant === 'plan') {
        const key = e.sessionId || '';
        let b = this.plans.get(key);
        if (!b) { b = this.block(e, 'plan'); this.plans.set(key, b); } else b.events.push(e);
        b.lastSeq = e.seq; b.current = u; return;
      }
      if (!e.sessionId) {
        this.setup(u);
        if (variant === 'current_mode_update' && own(u, 'currentModeId')) this.setup({ modeId: u.currentModeId });
      }
      this.block(e, typeof variant === 'string' ? variant : 'update'); return;
    }
    this.block(e, typeof e.e === 'string' ? e.e : 'unknown');
  }
  private build() {
    const text: string[] = [`# Agent: ${line(this.sid)}\n\n`], spans: Wire[] = [];
    let pos = text[0].length;
    const put = (s: string) => { text.push(s); pos += s.length; };
    if (this.truncated) {
      put(`> HISTORY TRUNCATED BY HUB: replay starts at/from seq ${this.from}; earlier or intervening events may be unavailable.\n> The API has a bounded replay and no backward pagination. All supplied events are retained here.\n`);
      for (const g of this.gaps) put(`> Truncated replay after #${g.after}: from #${g.from}, head #${g.head}.\n`);
      put('\n');
    }
    for (const b of this.blocks) {
      const span: Wire = { id: b.id, seq: b.seq, lastSeq: b.lastSeq, kind: b.kind, start: pos, end: pos, eventCount: b.events.length };
      let title: string, body: string, folded = false, prefix = '';
      if (b.kind === 'prompt') { title = `Prompt #${b.seq}`; body = contentText(b.blocks!); span.hasBlocks = true; }
      else if (b.content) {
        title = `${b.kind === 'thought' ? 'Thought' : b.role === 'user' ? 'User' : 'Assistant'} #${b.seq}`;
        body = contentText(b.content); folded = b.kind === 'thought' || long(body);
        span.role = b.role; span.messageId = b.messageId ?? null;
      } else if (b.tool) {
        const t = b.tool, locations = Array.isArray(t.locations) ? t.locations : [];
        title = `Tool: ${line(t.title || t.name || t.kind || t.toolCallId || 'unknown')} [${line(t.status || 'pending')}] #${b.seq}`;
        if (locations.length) title += ' — ' + locations.map((l: Wire) => `${line(l.path)}${typeof l.line === 'number' ? ':' + l.line : ''}`).join(', ');
        const history = toolHistory(b.events); body = history.text; folded = true;
        Object.assign(span, { toolCallId: t.toolCallId, title: t.title, status: t.status || 'pending', toolKind: t.kind, locations, diffs: history.diffs });
      } else if (b.kind === 'plan' && b.current) {
        title = `Plan (current) #${b.lastSeq}`;
        prefix = (Array.isArray(b.current.entries) ? b.current.entries : []).map((e: Wire) => `- [${line(e.status || 'pending')}] ${line(e.content ?? e.title ?? '')}${e.priority ? ` (${line(e.priority)})` : ''}\n`).join('');
        body = 'Plan update history:\n' + b.events.map(e => json(e) + '\n').join(''); folded = true;
      } else {
        const req = this.requests.get(b.seq);
        title = `${line(b.kind)}${req ? ` [${req.status}]` : ''} #${b.seq}`;
        body = b.events.map(e => json(e)).join('\n'); folded = long(body);
        if (req) Object.assign(span, { req: req.req, status: req.status, epoch: req.epoch });
      }
      put(`## ${title}\n`);
      if (prefix) put(prefix);
      const foldStart = pos - 1;
      if (span.diffs) for (const d of span.diffs) for (const k of ['oldStart', 'oldEnd', 'newStart', 'newEnd']) if (typeof d[k] === 'number') d[k] += pos;
      put(body); if (!body.endsWith('\n')) put('\n');
      const foldEnd = pos - 1;
      if (foldEnd > foldStart) Object.assign(span, { foldStart, foldEnd, folded });
      put('\n'); span.end = pos; spans.push(span);
    }
    const requests = [...this.requests.values()];
    return {
      text: text.join(''), spans, sid: this.sid, epoch: this.epoch, head: this.head, from: this.from,
      truncated: this.truncated, gaps: this.gaps,
      modes: this.modes, modeId: this.modeId, configOptions: this.configOptions, promptCapabilities: this.promptCapabilities,
      availableCommands: this.availableCommands, usage: this.usage,
      pending: requests.filter(r => r.status === 'pending').map(r => ({ ...r.event, sid: this.sid, req: r.req, kind: r.kind, status: r.status, epoch: r.epoch })),
      resolved: requests.filter(r => r.status !== 'pending').map(r => ({ sid: this.sid, req: r.req, kind: r.kind, status: r.status, epoch: r.epoch, by: r.resolution?.by, seq: r.resolution?.seq })),
    };
  }
  render(): ReturnType<Transcript['build']> {
    return this.cached ||= this.build();
  }
}
