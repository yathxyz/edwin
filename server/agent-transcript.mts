/* Derived ACP transcripts: the journal is the record, Markdown is only its presentation. No I/O here.
   Immutable blocks and event fragments are cached; publications replace only the changed block range. */
type Wire = Record<string, any>;
export interface TranscriptReply { epoch: number; head: number; from: number; reset: boolean; truncated: boolean; events: Wire[] }
export interface TranscriptPatch { start: number; remove: number; text: string; previousHead: number; previousEpoch: number }
interface TranscriptControls {
  sid: string; epoch: number; head: number;
  modes: unknown; modeId: unknown; configOptions: unknown; promptCapabilities: unknown; availableCommands: unknown; usage: unknown;
  pending: Wire[]; resolved: Wire[];
}
interface RenderedTranscript extends TranscriptControls {
  text: string; spans: Wire[]; from: number; truncated: boolean; gaps: Wire[]; patch?: TranscriptPatch;
}
interface Fragment { text: string; diffs: Wire[] }
interface RenderedBlock { text: string; span: Wire; bodyEnd: number; append?: { span: Wire; start: number } }
interface Block {
  id: string; kind: string; seq: number; lastSeq: number; events: Wire[];
  role?: string; variant?: string; messageId?: unknown; sessionId?: unknown;
  tool?: Wire; current?: Wire; rendered?: RenderedBlock; previous?: RenderedBlock;
}
interface RequestState extends Wire { req: number; kind: string; status: string }
const object = (v: unknown): v is Wire => !!v && typeof v === 'object' && !Array.isArray(v);
const json = (v: unknown) => JSON.stringify(v, null, 2) ?? String(v);
const line = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
const own = (v: Wire, k: string) => Object.prototype.hasOwnProperty.call(v, k);
const LONG_CHARS = 4000, LONG_LINES = 12;
const EVENT_LIMIT = 1024 * 1024;
const TRUNCATION = '\n[EVENT CONTENT TRUNCATED: rendered event limit is 1048576 UTF-16 code units]\n';
const UNAVAILABLE = 'no longer pending; resolution unavailable';

/* A single event shares one budget across its literal content, JSON, heading and current-plan summary.
   The journal itself is unchanged. An incomplete diff is visible as text, not advertised as a full diff. */
class EventText {
  private parts: string[] = [];
  pos = 0;
  truncated = false;
  diffs: Wire[] = [];
  declare private limit: number;
  constructor(limit: number) { this.limit = limit; }
  put(text: string) {
    if (!text || this.truncated) return;
    const remaining = this.limit - this.pos;
    if (text.length > remaining) {
      const end = remaining > 0 && /[\uD800-\uDBFF]/.test(text[remaining - 1]) ? remaining - 1 : remaining;
      this.parts.push(text.slice(0, end)); this.pos = this.limit; this.truncated = true;
    }
    else { this.parts.push(text); this.pos += text.length; }
  }
  finish(): Fragment {
    let text = this.parts.join('');
    let retained = this.truncated ? Math.max(0, this.limit - TRUNCATION.length) : text.length;
    if (retained > 0 && /[\uD800-\uDBFF]/.test(text[retained - 1])) retained--;
    if (this.truncated) text = text.slice(0, retained) + TRUNCATION.slice(0, this.limit - retained);
    return { text, diffs: this.diffs.filter(d => ['oldStart', 'oldEnd', 'newStart', 'newEnd'].every(k => typeof d[k] === 'number' && d[k] <= retained)) };
  }
}
function contentText(blocks: unknown[], out: EventText): void {
  for (const c of blocks) {
    if (out.truncated) break;
    if (typeof c === 'string') out.put(c);
    else if (object(c) && c.type === 'text' && typeof c.text === 'string') out.put(c.text);
    else if (object(c) && c.type === 'content' && own(c, 'content')) contentText([c.content], out);
    else if (object(c) && c.type === 'diff') {
      const d: Wire = { path: c.path };
      out.put(`\nDiff: ${line(c.path)}\nOld text:\n`);
      if (typeof c.oldText === 'string') { d.oldStart = out.pos; out.put(c.oldText); d.oldEnd = out.pos; }
      else out.put(json(c.oldText));
      out.put('\nNew text:\n');
      if (typeof c.newText === 'string') { d.newStart = out.pos; out.put(c.newText); d.newEnd = out.pos; }
      else out.put(json(c.newText));
      out.put('\n');
      if (!out.truncated) out.diffs.push(d);
    } else out.put('\n' + json(c) + '\n');
  }
}
function long(text: string) {
  if (text.length > LONG_CHARS) return true;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++n >= LONG_LINES) return true;
  return false;
}
function shifted(span: Wire, start: number): Wire {
  const result: Wire = { ...span, start, end: span.end + start };
  for (const k of ['foldStart', 'foldEnd']) if (typeof span[k] === 'number') result[k] = span[k] + start;
  if (span.diffs) result.diffs = span.diffs.map((d: Wire) => {
    const diff = { ...d };
    for (const k of ['oldStart', 'oldEnd', 'newStart', 'newEnd']) if (typeof diff[k] === 'number') diff[k] += start;
    return diff;
  });
  return result;
}

export class Transcript {
  declare readonly sid: string;
  epoch = 0;
  head = 0;
  private events: Wire[] = [];
  private seen = new Set<number>();
  private blocks: Block[] = [];
  private tools = new Map<string, Block>();
  private requests = new Map<number, RequestState>();
  private requestBlocks = new Map<number, Block>();
  private authority: { head: number; pending: Set<string> } | null = null;
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
  private fragments = new WeakMap<Wire, Map<string, Fragment>>();
  private cached: RenderedTranscript | null = null;
  private previous: { rendered: RenderedTranscript; header: string; blocks: RenderedBlock[] } | null = null;

  /* cleanString must preserve UTF-16 length. It receives assembled content, including split chunks,
     before any published structural positions are materialized. */
  declare private cleanString: (text: string) => string;
  declare private cleanOverlap: number;
  constructor(sid: string, cleanString: (text: string) => string = text => text, cleanOverlap = Infinity) {
    this.sid = sid; this.cleanString = cleanString; this.cleanOverlap = cleanOverlap;
  }
  get journal(): readonly Wire[] { return this.events; }
  reset(epoch: number) {
    this.epoch = epoch; this.head = 0; this.from = 1; this.truncated = false; this.gaps = []; this.authority = null;
    this.events = []; this.seen.clear(); this.clearFold(); this.fragments = new WeakMap(); this.cached = null;
  }
  private clearFold() {
    this.blocks = []; this.tools.clear(); this.requests.clear(); this.requestBlocks.clear(); this.plans.clear(); this.messageBlock = null;
    this.modes = this.modeId = this.configOptions = this.promptCapabilities = this.availableCommands = this.usage = null;
  }
  apply(reply: TranscriptReply): void {
    if (reply.reset || reply.epoch !== this.epoch) this.reset(reply.epoch);
    const oldHead = this.head, fresh: Wire[] = [];
    for (const e of reply.events) {
      if (!this.seen.has(e.seq)) { this.seen.add(e.seq); fresh.push(e); }
    }
    /* Only late pinned/unsorted events require refolding. Authority survives that refold, not resets. */
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
  /* The caller must first establish that this registry describes this exact epoch and journal head. */
  reconcilePending(pending: Array<{ req: number; kind: string }>): void {
    this.authority = { head: this.head, pending: new Set(pending.map(r => JSON.stringify([r.req, r.kind]))) };
    for (const req of this.requests.values()) {
      if (req.status !== 'pending' && req.status !== 'unavailable') continue;
      const status = this.pendingStatus(req.req, req.kind);
      if (status !== req.status) {
        req.status = status;
        const b = this.requestBlocks.get(req.req); if (b) b.rendered = undefined;
      }
    }
    this.cached = null;
  }
  private pendingStatus(req: number, kind: string) {
    return this.authority && req <= this.authority.head && !this.authority.pending.has(JSON.stringify([req, kind])) ? 'unavailable' : 'pending';
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
    if (e.e === 'session' || e.e === 'initialize' || e.e === 'mode') this.setup(e);
    if (e.e === 'prompt') { this.block(e, 'prompt'); return; }
    if (e.e === 'permission' || e.e === 'elicitation') {
      const req: RequestState = { ...e, req: e.seq, kind: e.e, status: this.pendingStatus(e.seq, e.e), event: e, epoch: this.epoch };
      this.requests.set(req.req, req); this.requestBlocks.set(req.req, this.block(e, e.e)); return;
    }
    if (e.e === 'permission_resolved' || e.e === 'elicitation_resolved') {
      const kind = e.e === 'permission_resolved' ? 'permission' : 'elicitation';
      const req = this.requests.get(e.req) || { req: e.req, kind, epoch: this.epoch };
      this.requests.set(e.req, { ...req, status: 'resolved', resolution: e });
      const b = this.requestBlocks.get(e.req); if (b) b.rendered = undefined;
      this.block(e, e.e); return;
    }
    if (e.e === 'elicitation_complete') {
      for (const req of this.requests.values()) if (req.kind === 'elicitation' && req.event?.request?.elicitationId === e.elicitationId) {
        req.complete = e; req.status = 'complete';
        const b = this.requestBlocks.get(req.req); if (b) b.rendered = undefined;
      }
      this.block(e, e.e); return;
    }
    if (e.e === 'update' && object(e.update)) {
      const u = e.update, variant = u.sessionUpdate;
      if (variant === 'agent_message_chunk' || variant === 'agent_thought_chunk' || variant === 'user_message_chunk') {
        const last = lastMessage;
        const same = last && last.variant === variant && (last.messageId ?? null) === (u.messageId ?? null) && (last.sessionId ?? null) === (e.sessionId ?? null);
        const b = same ? last! : this.block(e, variant === 'agent_thought_chunk' ? 'thought' : 'message');
        if (same) { b.previous ||= b.rendered; b.events.push(e); }
        b.rendered = undefined; b.lastSeq = e.seq; b.variant = variant; b.messageId = u.messageId; b.sessionId = e.sessionId;
        b.role = variant === 'user_message_chunk' ? 'user' : 'assistant'; this.messageBlock = b; return;
      }
      if (variant === 'tool_call' || variant === 'tool_call_update') {
        const key = JSON.stringify([e.sessionId ?? null, u.toolCallId ?? e.seq]);
        let b = this.tools.get(key);
        if (!b) { b = this.block(e, 'tool'); b.tool = {}; this.tools.set(key, b); }
        else b.events.push(e);
        b.rendered = undefined; b.lastSeq = e.seq;
        for (const k of Object.keys(u)) if (u[k] !== null && u[k] !== undefined) b.tool![k] = u[k];
        return;
      }
      if (variant === 'plan') {
        const key = e.sessionId || '';
        let b = this.plans.get(key);
        if (!b) { b = this.block(e, 'plan'); this.plans.set(key, b); } else b.events.push(e);
        b.rendered = undefined; b.lastSeq = e.seq; b.current = u; return;
      }
      if (!e.sessionId) {
        this.setup(u);
        if (variant === 'current_mode_update' && own(u, 'currentModeId')) this.setup({ modeId: u.currentModeId });
      }
      this.block(e, typeof variant === 'string' ? variant : 'update'); return;
    }
    this.block(e, typeof e.e === 'string' ? e.e : 'unknown');
  }
  private eventText(e: Wire, kind: string, budget: number): Fragment {
    const key = `${kind}:${budget}`, cache = this.fragments.get(e);
    const existing = cache?.get(key); if (existing) return existing;
    const out = new EventText(budget);
    if (kind === 'prompt') contentText(Array.isArray(e.prompt) ? e.prompt : [e.prompt], out);
    else if (kind === 'message' || kind === 'thought') contentText([e.update.content], out);
    else if (kind === 'tool') {
      const u = object(e.update) ? e.update : e;
      out.put(`### Update #${e.seq}\n`);
      if (Array.isArray(u.content)) { contentText(u.content, out); out.put('\n'); }
      if (typeof u.rawOutput === 'string') { out.put(u.rawOutput); out.put('\n'); }
      if (!out.truncated) { out.put(json(e)); out.put('\n\n'); }
    } else { out.put(json(e)); if (kind === 'plan') out.put('\n'); }
    const fragment = out.finish();
    if (cache) cache.set(key, fragment); else this.fragments.set(e, new Map([[key, fragment]]));
    return fragment;
  }
  private clean(text: string) {
    const clean = this.cleanString(text);
    if (clean.length !== text.length) throw new Error('Transcript cleanString must preserve UTF-16 length');
    return clean;
  }
  private renderBlock(b: Block): RenderedBlock {
    const previous = b.previous; b.previous = undefined;
    if (b.variant && previous && previous.span.eventCount < b.events.length) {
      const parts: string[] = [];
      for (let i = previous.span.eventCount; i < b.events.length; i++) parts.push(this.eventText(b.events[i], b.kind, EVENT_LIMIT).text);
      const added = parts.join(''), bodyStart = previous.text.indexOf('\n') + 1, bodyEnd = previous.bodyEnd + added.length;
      const last = added.length ? added[added.length - 1] : previous.text[previous.bodyEnd - 1];
      const newline = last === '\n' ? '' : '\n', start = Math.max(0, previous.bodyEnd - this.cleanOverlap);
      const text = previous.text.slice(0, start) + this.clean(previous.text.slice(start, previous.bodyEnd) + added + newline + '\n');
      const foldEnd = bodyEnd + newline.length - 1;
      const span = { ...previous.span, lastSeq: b.lastSeq, eventCount: b.events.length, end: text.length,
        foldStart: bodyStart - 1, foldEnd, folded: previous.span.folded || long(text.slice(bodyStart, foldEnd + 1)) };
      return { text, span, bodyEnd, append: { span: previous.span, start } };
    }
    const span: Wire = { id: b.id, seq: b.seq, lastSeq: b.lastSeq, kind: b.kind, start: 0, end: 0, eventCount: b.events.length };
    let title: string, folded = false, prefix = '';
    if (b.kind === 'prompt') { title = `Prompt #${b.seq}`; span.hasBlocks = true; }
    else if (b.variant) {
      title = `${b.kind === 'thought' ? 'Thought' : b.role === 'user' ? 'User' : 'Assistant'} #${b.seq}`;
      span.role = b.role; span.messageId = b.messageId ?? null;
    } else if (b.tool) {
      const t = b.tool, locations = Array.isArray(t.locations) ? t.locations : [];
      title = `Tool: ${line(t.title || t.name || t.kind || t.toolCallId || 'unknown')} [${line(t.status || 'pending')}] #${b.seq}`;
      if (locations.length) title += ' — ' + locations.map((l: Wire) => `${line(l.path)}${typeof l.line === 'number' ? ':' + l.line : ''}`).join(', ');
      folded = true;
      Object.assign(span, { toolCallId: t.toolCallId, title: t.title, status: t.status || 'pending', toolKind: t.kind, locations, diffs: [] });
    } else if (b.kind === 'plan' && b.current) { title = `Plan (current) #${b.lastSeq}`; folded = true; }
    else {
      const req = this.requests.get(b.seq);
      title = `${line(b.kind)}${req ? ` [${req.status === 'unavailable' ? UNAVAILABLE : req.status}]` : ''} #${b.seq}`;
      if (req) Object.assign(span, { req: req.req, status: req.status, epoch: req.epoch });
    }
    const heading = new EventText(EVENT_LIMIT - TRUNCATION.length - 2);
    heading.put(`## ${title}\n`);
    const header = heading.finish().text;
    if (b.kind === 'plan' && b.current) {
      const summary = new EventText(EVENT_LIMIT - header.length - 2 - TRUNCATION.length);
      for (const e of Array.isArray(b.current.entries) ? b.current.entries : []) {
        if (summary.truncated) break;
        summary.put(`- [${line(e.status || 'pending')}] ${line(e.content ?? e.title ?? '')}${e.priority ? ` (${line(e.priority)})` : ''}\n`);
      }
      prefix = summary.finish().text;
    }
    const parts: string[] = [], diffs: Wire[] = [];
    const headingEvent = b.tool || b.current ? b.events.length - 1 : 0;
    let bodyLength = 0;
    for (let i = 0; i < b.events.length; i++) {
      const overhead = (i === headingEvent ? header.length + 2 : 0) + (i === b.events.length - 1 ? prefix.length : 0);
      const fragment = this.eventText(b.events[i], b.kind, EVENT_LIMIT - overhead);
      for (const d of fragment.diffs) {
        const diff = { ...d };
        for (const k of ['oldStart', 'oldEnd', 'newStart', 'newEnd']) diff[k] += bodyLength;
        diffs.push(diff);
      }
      parts.push(fragment.text); bodyLength += fragment.text.length;
    }
    const body = parts.join('');
    const text = this.clean(header + prefix + body + (body.endsWith('\n') ? '' : '\n') + '\n');
    const bodyStart = header.length + prefix.length;
    const foldEnd = bodyStart + body.length + (body.endsWith('\n') ? 0 : 1) - 1;
    if (foldEnd > bodyStart - 1) {
      if (!folded) folded = b.kind === 'thought' || long(text.slice(bodyStart, foldEnd + 1));
      Object.assign(span, { foldStart: bodyStart - 1, foldEnd, folded });
    }
    if (span.diffs) span.diffs = diffs.map(d => {
      const diff = { ...d };
      for (const k of ['oldStart', 'oldEnd', 'newStart', 'newEnd']) diff[k] += bodyStart;
      return diff;
    });
    span.end = text.length;
    return { text, span, bodyEnd: bodyStart + body.length };
  }
  /* Current steering values, without rendering or walking the journal. */
  controls(): TranscriptControls {
    const pending: Wire[] = [], resolved: Wire[] = [];
    for (const r of this.requests.values()) {
      if (r.status === 'pending') pending.push({ ...r.event, sid: this.sid, req: r.req, kind: r.kind, status: r.status, epoch: r.epoch });
      else resolved.push({ sid: this.sid, req: r.req, kind: r.kind, status: r.status, epoch: r.epoch, by: r.resolution?.by, seq: r.resolution?.seq });
    }
    return {
      sid: this.sid, epoch: this.epoch, head: this.head,
      modes: this.modes, modeId: this.modeId, configOptions: this.configOptions, promptCapabilities: this.promptCapabilities,
      availableCommands: this.availableCommands, usage: this.usage, pending, resolved,
    };
  }
  private header() {
    const text = [`# Agent: ${line(this.sid)}\n\n`];
    if (this.truncated) {
      text.push(`> HISTORY TRUNCATED BY HUB: replay starts at/from seq ${this.from}; earlier or intervening events may be unavailable.\n> The API has a bounded replay and no backward pagination. All supplied events are retained here.\n`);
      for (const g of this.gaps) text.push(`> Truncated replay after #${g.after}: from #${g.from}, head #${g.head}.\n`);
      text.push('\n');
    }
    return this.clean(text.join(''));
  }
  private build(): RenderedTranscript {
    const previous = this.previous, header = this.header();
    const blocks = this.blocks.map(b => b.rendered ||= this.renderBlock(b));
    const spans: Wire[] = []; let pos = header.length;
    for (let i = 0; i < blocks.length; i++) {
      const oldSpan = previous?.rendered.spans[i];
      spans.push(previous?.blocks[i] === blocks[i] && oldSpan?.start === pos ? oldSpan : shifted(blocks[i].span, pos));
      pos += blocks[i].text.length;
    }
    let text: string, patch: TranscriptPatch | undefined;
    if (!previous) text = header + blocks.map(b => b.text).join('');
    else {
      let first = 0, oldLast = previous.blocks.length, last = blocks.length;
      const sameHeader = header === previous.header;
      if (sameHeader) while (first < oldLast && first < last && previous.blocks[first] === blocks[first]) first++;
      while (oldLast > first && last > first && previous.blocks[oldLast - 1] === blocks[last - 1]) { oldLast--; last--; }
      let start = sameHeader ? (first < previous.blocks.length ? previous.rendered.spans[first].start : previous.rendered.text.length) : 0;
      let end = oldLast < previous.blocks.length ? previous.rendered.spans[oldLast].start : previous.rendered.text.length;
      const appended = sameHeader && blocks[first]?.append;
      let replacement: string;
      if (appended && previous.blocks[first]?.span === appended.span) {
        start += appended.start;
        replacement = blocks[first].text.slice(appended.start) + blocks.slice(first + 1, last).map(b => b.text).join('');
        let prefix = 0, suffix = 0;
        while (start + prefix < end && prefix < replacement.length && previous.rendered.text[start + prefix] === replacement[prefix]) prefix++;
        while (end - suffix > start + prefix && replacement.length - suffix > prefix && previous.rendered.text[end - suffix - 1] === replacement[replacement.length - suffix - 1]) suffix++;
        start += prefix; end -= suffix;
        replacement = replacement.slice(prefix, replacement.length - suffix);
      } else replacement = (sameHeader ? '' : header) + blocks.slice(first, last).map(b => b.text).join('');
      patch = { start, remove: end - start, text: replacement, previousHead: previous.rendered.head, previousEpoch: previous.rendered.epoch };
      text = previous.rendered.text.slice(0, start) + replacement + previous.rendered.text.slice(end);
    }
    const rendered = {
      text, spans, ...this.controls(), from: this.from, truncated: this.truncated, gaps: this.gaps, patch,
    };
    this.previous = { rendered, header, blocks };
    return rendered;
  }
  render(): RenderedTranscript { return this.cached ||= this.build(); }
}
