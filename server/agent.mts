// pi agents (scm/pi.scm): Edwin's AI is a pi-agent-core Agent per session, on the model layer of models.mts.
//
// gptel sent a prompt and streamed one answer. A pi session keeps a conversation, runs the agent loop (model call,
// tool calls, model call, …), takes steering while it runs and follow-ups after, and can change backend and model
// between runs; pi-ai carries the context across providers. The loop is pi-agent-core's; what is Edwin's:
//
// - Model calls go through Models.agentStream: the gate, the deadline, the credential rules, usage.jsonl.
// - Tools are Scheme procedures (define-pi-tool). pi-agent-core calls them from outside the Scheme threads, so each
//   run has one Scheme thread, attributed to the agent `pi:<session>`, that drains the run's queue: agent events
//   for the chat buffer, tool calls, and confirmations. Every Scheme effect of a run (text streaming into the
//   buffer, a tool's edit) is that thread's, so every frame sees it and undo-writer undoes it.
// - A tool marked :confirm asks first: beforeToolCall puts a confirm job on the queue, and the Scheme handler
//   answers #t or #f (scm/pi.scm writes the question into the chat buffer and waits for pi-allow or pi-deny).
// - A session's messages are saved after each run in <stateDir>/pi/<name>.json (mode 0600) and loaded again by
//   %pi-session with the same name.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonToScheme } from './threads.mts';
import type { Server, Lisp, SchemeValue } from './main.mts';
import type { Backend, Models, PiAssistant } from './models.mts';
import type { SchemeGen, Thread } from './threads.mts';

type Scheme = Lisp['S'];
type PrimFn = (args: SchemeValue[]) => SchemeValue;
type PrimGen = (args: SchemeValue[]) => SchemeGen;

/* pi-agent-core's shapes, the parts this file builds and reads. */
interface PiAgentTool {
  name: string; label: string; description: string; parameters: object;
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: { type: 'text'; text: string }[]; details: unknown; isError?: boolean }>;
}
interface PiAgentEvent { type: string; assistantMessageEvent?: { type: string; delta?: string }; message?: { role?: string }; toolCallId?: string; toolName?: string; args?: unknown; result?: { content?: { text?: string }[] }; isError?: boolean; messages?: unknown[] }
interface PiAgent {
  state: { model: unknown; tools: PiAgentTool[]; messages: unknown[]; systemPrompt: string };
  subscribe(fn: (e: PiAgentEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(m: unknown): void; followUp(m: unknown): void; abort(): void;
  readonly isStreaming?: boolean;
}
type AgentCtor = new (o: Record<string, unknown>) => PiAgent;
let agentCtor: Promise<AgentCtor> | null = null;
const loadAgent = () => (agentCtor ??= import('@earendil-works/pi-agent-core').then(m => m.Agent as unknown as AgentCtor));

/* One job for a run's Scheme thread. */
type Job =
  | { kind: 'event'; name: string; data: Record<string, unknown> }
  | { kind: 'tool'; tool: SchemeTool; id: string; args: Record<string, unknown>; resolve: (r: { text: string; error: boolean }) => void }
  | { kind: 'confirm'; tool: SchemeTool; id: string; args: Record<string, unknown>; resolve: (ok: boolean) => void }
  | { kind: 'end'; error: unknown };
/* A tool defined in Scheme: PARAMS is ((name type "description") …), all required; type is string, number,
   integer or boolean. */
interface SchemeTool { name: string; description: string; params: [string, string, string][]; proc: SchemeValue; confirm: boolean }

class Queue<T> {
  declare items: T[]; declare waiter: ((x: T) => void) | null;
  constructor() { this.items = []; this.waiter = null; }
  push(x: T) { const w = this.waiter; if (w) { this.waiter = null; w(x); } else this.items.push(x); }
  next(): Promise<T> { return this.items.length ? Promise.resolve(this.items.shift()!) : new Promise(r => { this.waiter = r; }); }
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const SESSION_DIR = 'pi';

export class Session {
  declare name: string; declare backend: Backend; declare model: string | null; declare tier: string;
  declare system: string; declare agent: PiAgent | null; declare thread: Thread | null; declare queue: Queue<Job> | null;
  declare messages: unknown[];
  constructor(name: string, backend: Backend, tier: string, model: string | null, system: string, messages: unknown[]) {
    this.name = name; this.backend = backend; this.tier = tier; this.model = model; this.system = system;
    this.agent = null; this.thread = null; this.queue = null; this.messages = messages;
  }
  get running() { return !!this.thread && this.thread.alive; }
  __print() { return `#<pi-session ${this.name}>`; }
  toString() { return this.__print(); }
  toJSON() { return this.__print(); }
}

export class Agents {
  declare server: Server; declare models: Models; declare L: Lisp; declare S: Scheme;
  declare tools: Map<string, SchemeTool>; declare sessions: Map<string, Session>; declare dir: string;
  constructor(server: Server) {
    this.server = server; this.models = server.models; this.L = server.L; this.S = server.L.S;
    this.tools = new Map(); this.sessions = new Map();
    this.dir = path.join(server.cfg.stateDir, SESSION_DIR);
  }
  file(name: string) { return path.join(this.dir, name + '.json'); }
  save(s: Session) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.file(s.name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ name: s.name, backend: s.backend.name, tier: s.tier, model: s.model, system: s.system, messages: s.messages }), { mode: 0o600 });
    fs.renameSync(tmp, this.file(s.name));
  }
  load(name: string): { backend?: string; tier?: string; model?: string | null; system?: string; messages?: unknown[] } | null {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch (e) { return null; }
  }
  /* The session NAME: the live one, else the saved one, else a new one on BACKEND. */
  session(name: string, backend: Backend, tier: string, model: string | null, system: string): Session {
    const S = this.S;
    if (!NAME_RE.test(name)) throw new S.SchemeError('user-error', `pi: a session name is 1 to 64 of A-Z a-z 0-9 . _ -, not ${JSON.stringify(name)}`, []);
    const live = this.sessions.get(name); if (live) return live;
    const saved = this.load(name);
    const b = saved && saved.backend && this.models.backends.get(saved.backend) || backend;
    const s = new Session(name, b, saved?.tier || tier, saved ? saved.model ?? null : model, saved?.system ?? system, Array.isArray(saved?.messages) ? saved!.messages! : []);
    this.sessions.set(name, s);
    return s;
  }
  /* pi-agent-core's tool for T: its JSON Schema, and an execute that hands the call to the run's Scheme thread. */
  agentTool(t: SchemeTool, q: Queue<Job>): PiAgentTool {
    const properties: Record<string, object> = {};
    for (const [n, ty, d] of t.params) properties[n] = { type: ty, description: d };
    return {
      name: t.name, label: t.name, description: t.description,
      parameters: { type: 'object', properties, required: t.params.map(p => p[0]) },
      execute: (id, args, signal) => new Promise(resolve => {
        if (signal) signal.addEventListener('abort', () => resolve({ text: 'The tool call was aborted.', error: true }), { once: true });
        q.push({ kind: 'tool', tool: t, id, args: args || {}, resolve });
      }).then(r => { const x = r as { text: string; error: boolean }; return { content: [{ type: 'text' as const, text: x.text }], details: null, isError: x.error }; }),
    };
  }
  /* Run PROMPT in session S: the agent loop on pi-agent-core, its effects on a new Scheme thread that calls
     ON-EVENT (kind alist) for text, tool-start, tool-end, confirm (answers #t or #f), done and error. */
  run(s: Session, prompt: string, onEvent: SchemeValue): Thread {
    const S = this.S, self = this;
    if (s.running) throw new S.SchemeError('user-error', `pi: session ${s.name} is running (pi-steer adds to it, pi-abort stops it)`, []);
    const b = this.models.requireUsable(s.backend, 'pi');
    const { model, tier } = b.resolve(s.tier, s.model);
    const q = new Queue<Job>();
    s.queue = q;
    const tools = [...this.tools.values()];
    const ev = (name: string, data: Record<string, unknown>) => q.push({ kind: 'event', name, data });
    const piModel = this.models.modelOf(b, { model, tier, messages: [], tools: [], caller: 'pi' });
    const start = loadAgent().then(Agent => {
      const agent = new Agent({
        initialState: { systemPrompt: s.system, model: piModel, tools: tools.map(t => this.agentTool(t, q)), messages: s.messages },
        streamFn: this.models.agentStream(b, 'pi'),
        beforeToolCall: async (ctx: { toolCall: { id: string; name: string; arguments?: Record<string, unknown> } }) => {
          const t = this.tools.get(ctx.toolCall.name);
          if (!t || !t.confirm) return undefined;
          const ok = await new Promise<boolean>(resolve => q.push({ kind: 'confirm', tool: t, id: ctx.toolCall.id, args: ctx.toolCall.arguments || {}, resolve }));
          return ok ? undefined : { block: true, reason: 'The user declined this tool call.' };
        },
      });
      s.agent = agent;
      agent.subscribe(e => {
        if (e.type === 'message_update' && e.assistantMessageEvent && e.assistantMessageEvent.type === 'text_delta') ev('text', { delta: e.assistantMessageEvent.delta || '' });
        else if (e.type === 'tool_execution_start') ev('tool-start', { name: e.toolName, id: e.toolCallId, args: e.args });
        else if (e.type === 'tool_execution_end') ev('tool-end', { name: e.toolName, id: e.toolCallId, error: !!e.isError, result: (e.result?.content || []).map(c => c.text || '').join('') });
      });
      return agent.prompt(prompt).then(() => agent);
    });
    start.then(agent => {
      s.messages = agent.state.messages;
      const last = s.messages[s.messages.length - 1] as PiAssistant | undefined;
      q.push({ kind: 'end', error: last && last.role === 'assistant' && last.stopReason === 'error' ? new S.SchemeError('http-error', last.errorMessage || 'the model call failed', []) : last && last.role === 'assistant' && last.stopReason === 'aborted' ? new S.SchemeError('cancelled', 'pi: aborted', []) : null });
    }, e => q.push({ kind: 'end', error: e }));
    const handler = S.proc(onEvent, 'pi');
    const sym = (n: string) => S.intern(n);
    s.thread = this.server.threads.spawn(function* () {
      try {
        for (;;) {
          const job: Job = yield new S.Block(q.next(), `pi ${s.name}`);
          if (job.kind === 'end') {
            try { self.save(s); } catch (e) { self.server.log.warn('pi', { session: s.name, save: (e as Error).message }); }
            const usage = s.messages.filter(m => (m as PiAssistant).role === 'assistant').slice(-1)[0] as PiAssistant | undefined;
            if (job.error) { yield* S.applyG(handler, [sym('error'), job.error instanceof S.SchemeError ? job.error : new S.SchemeError('error', self.models.messageOf(job.error), [])]); return false; }
            yield* S.applyG(handler, [sym('done'), jsonToScheme(S, { model, tier, 'input-tokens': usage?.usage.input || 0, 'output-tokens': usage?.usage.output || 0, messages: s.messages.length })]);
            return true;
          }
          if (job.kind === 'event') { yield* S.applyG(handler, [sym(job.name), jsonToScheme(S, job.data)]); continue; }
          const args = jsonToScheme(S, job.args);
          if (job.kind === 'confirm') {
            let ok = false;
            try { ok = (yield* S.applyG(handler, [sym('confirm'), jsonToScheme(S, { name: job.tool.name, id: job.id, args: job.args })])) !== false; }
            finally { job.resolve(ok); }
            continue;
          }
          try { const r = yield* S.applyG(job.tool.proc, [args]); job.resolve({ text: typeof r === 'string' ? r : S.write(r), error: false }); }
          catch (e) { if (e instanceof S.Unwind) { job.resolve({ text: 'The tool was interrupted.', error: true }); throw e; } job.resolve({ text: `Error: ${self.models.messageOf(e)}`, error: true }); }
        }
      } finally {
        if (s.agent) s.agent.abort();
        /* Answer what the agent still waits for, so its loop can end. */
        for (const j of q.items) { if (j.kind === 'tool') j.resolve({ text: 'The session stopped.', error: true }); else if (j.kind === 'confirm') j.resolve(false); }
        s.agent = null; s.queue = null;
      }
    }, { kind: 'background', name: `pi ${s.name}`, by: { kind: 'agent', agent: `pi:${s.name}` }, debugOnError: false });
    return s.thread;
  }
  install() {
    const { L, S } = this, self = this;
    const D = (nm: string, args: string, doc: string, fn: PrimFn, gen?: PrimGen) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; if (gen) f.gen = gen; return f; };
    const sess = (x: SchemeValue, who: string): Session => { if (x instanceof Session) return x; throw S.typeErr('pi-session', x, who); };
    const str = (x: SchemeValue, who: string): string => { if (typeof x !== 'string') throw S.typeErr('string', x, who); return x; };
    const opt = (v: SchemeValue): string | null => v === undefined || v === false ? null : v instanceof S.Sym ? v.name : typeof v === 'string' ? v : null;
    D('%pi-define-tool', 'name description params proc confirm', 'Define the agent tool NAME: PARAMS is ((name type "description") …), PROC takes the arguments as an alist and returns a string; CONFIRM #t asks before each call.', ([n, d, params, proc, confirm]) => {
      const name = opt(n); if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new S.SchemeError('user-error', `define-pi-tool: a tool name is 1 to 64 of a-z A-Z 0-9 _ -`, []);
      const ps: [string, string, string][] = [];
      for (const p of S.arr(params)) {
        const [pn, pt, pd] = S.arr(p).map((x: SchemeValue) => opt(x) ?? (typeof x === 'string' ? x : ''));
        if (!pn || !['string', 'number', 'integer', 'boolean'].includes(pt)) throw new S.SchemeError('user-error', `define-pi-tool ${name}: a parameter is (name type "description") with type string, number, integer or boolean`, [p]);
        ps.push([pn, pt, pd || '']);
      }
      self.tools.set(name, { name, description: str(d, 'define-pi-tool'), params: ps, proc: S.proc(proc, 'define-pi-tool'), confirm: confirm !== false && confirm !== undefined });
      return S.intern(name);
    });
    D('%pi-tools', '', 'The names of the agent tools.', () => S.listOf([...self.tools.keys()]));
    D('%pi-session', 'name [backend tier model system]', 'The pi session NAME: the live one, else the one saved in stateDir, else a new one on BACKEND (default the current gptel-backend).', ([n, bx, t, m, sys]) => {
      const b = bx === undefined || bx === false ? self.models.currentBackend() : self.models.backendNamed(bx, 'pi');
      if (!b) throw new S.SchemeError('user-error', 'pi: no backend is configured', []);
      return self.session(str(n, 'pi'), b, opt(t) || 'default', opt(m), typeof sys === 'string' ? sys : '');
    });
    D('pi-session?', 'x', '#t if X is a pi session.', ([x]) => x instanceof Session);
    D('%pi-run', 'session prompt on-event', 'Run PROMPT in SESSION on a new background thread attributed to the agent pi:<name>; ON-EVENT gets (kind alist) for text, tool-start, tool-end, confirm (its value allows or denies), done and error. Returns the thread.', ([x, p, f]) => self.run(sess(x, '%pi-run'), str(p, '%pi-run'), f));
    D('%pi-steer', 'session text', 'Give the running SESSION TEXT as a steering message (delivered after its current tool calls), or as a follow-up when it is idle.', ([x, t]) => {
      const s = sess(x, '%pi-steer'), m = { role: 'user', content: str(t, '%pi-steer'), timestamp: Date.now() };
      if (!s.agent) throw new S.SchemeError('user-error', `pi: session ${s.name} is not running`, []);
      s.agent.steer(m); return true;
    });
    D('%pi-abort', 'session', 'Stop the run of SESSION, if any.', ([x]) => { const s = sess(x, '%pi-abort'); if (s.agent) s.agent.abort(); return !!s.agent; });
    D('%pi-running?', 'session', '#t while SESSION runs.', ([x]) => sess(x, '%pi-running?').running);
    D('%pi-set-model', 'session backend [tier model]', 'Switch SESSION to BACKEND (and TIER or MODEL) for its next run; the conversation carries over.', ([x, bx, t, m]) => {
      const s = sess(x, '%pi-set-model'); if (s.running) throw new S.SchemeError('user-error', `pi: session ${s.name} is running`, []);
      s.backend = self.models.backendNamed(bx, 'pi'); s.tier = opt(t) || 'default'; s.model = opt(m); return true;
    });
    D('%pi-session-info', 'session', 'An alist: name backend tier model messages running.', ([x]) => { const s = sess(x, '%pi-session-info'); return jsonToScheme(S, { name: s.name, backend: s.backend.name, tier: s.tier, model: s.model || false, messages: s.messages.length, running: s.running }); });
    D('%pi-forget', 'session', 'Drop SESSION and its saved conversation.', ([x]) => { const s = sess(x, '%pi-forget'); if (s.running && s.agent) s.agent.abort(); self.sessions.delete(s.name); try { fs.rmSync(self.file(s.name)); } catch (e) { /* none */ } return true; });
    D('%pi-sessions', '', 'The names of the live and saved sessions.', () => {
      const names = new Set(self.sessions.keys());
      try { for (const f of fs.readdirSync(self.dir)) if (f.endsWith('.json')) names.add(f.slice(0, -5)); } catch (e) { /* none yet */ }
      return S.listOf([...names].sort());
    });
    /* The built-in tools, then those init.scm defined before these primitives existed (pi.scm kept them), which
       replace a built-in of the same name. */
    L.evalText('(set! pi--ready #t)');
    L.evalText(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scm', 'pi-tools.scm'), 'utf8'));
    L.evalText('(pi--define-pending-tools!)');
  }
  shutdown() { for (const s of this.sessions.values()) if (s.agent) s.agent.abort(); }
}

export const name = 'agents';
export async function install(server: Server) { const a = new Agents(server); server.agents = a; a.install(); }
export async function shutdown(server: Server) { if (server.agents) server.agents.shutdown(); }
