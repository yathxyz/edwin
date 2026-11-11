// brain as edwind talks to it (docs/steps.md, "Nodes from brain" and "Tasks from brain").
//
// brainRequest is the one way a request to brain is made; the note projector (projector.mts) writes with it.
//
// The commands here are how a frame reads brain and changes its tasks: Edwin finds a node by name, opens it,
// lists what links to it, shows the agenda and adds or changes a task by asking edwind, which holds the tokens,
// so no frame ever does.
//   brain-titles {q, kind?, limit?}    -> brain's GET /v1/titles answer: {results: [{id, kind, title, alias, scope,
//                                         org_id, path, updated_at}]}
//   brain-node REF                     -> brain's GET /v1/nodes/REF answer: the node, its identifiers and its links
//   brain-agenda {from, days?}         -> brain's GET /v1/agenda answer: {from, days, overdue, dated, next}
//   brain-tasks {state?, q?, tag?, limit?, offset?} -> brain's GET /v1/tasks answer: {tasks}
//   brain-task-add FIELDS              -> brain's POST /v1/tasks answer: the new task
//   brain-task-set REF FIELDS          -> brain's PATCH /v1/tasks/REF answer: the task, and `clashes`
//   brain-tasks-follow ON              -> with ON true, the client is told {t: 'tasks'} whenever a task changed
//                                         in brain, until it asks with another ON or disconnects (TaskFeed);
//                                         the value is whether edwind has its place in brain's feed of changes
// The four that read, and the feed, use brain.readCredential, a token brain takes on its GET routes only
// (brain's `readOnly`).
// The two that write use brain.taskCredential, a token brain takes on its task routes only, and send only the
// fields of a task (TASK_FIELDS, SET_FIELDS); brain checks their values. Each answers with the condition
// brain-unavailable when it has no token or brain cannot be reached, and brain-refused with brain's own words
// when it says no. Every client of the socket may call them, as every client may read every note file: what the
// read token is cleared for is what a process that can open the socket can read, and with a task token such a
// process adds and changes tasks as that token's actor.
//
// A token is a LoadCredential file, read for each request and never logged; neither is what was asked for or
// written (R15.10). Plain http goes only to this host: loopback, or an address the request can be bound to leave
// from.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Credential, isLoopback, readSecret } from './models.mts';
import type { Server, Log } from './main.mts';
import type { Client } from './session.mts';
import type { CallResult } from './proto.mts';

export interface BrainAnswer { status: number; text: string; cut: boolean }
export interface BrainRequest {
  method: 'GET' | 'POST' | 'PATCH'; body?: Buffer; timeoutMs: number;
  /* X-Brain-Session: what brain records beside a write as the session it was made in. */
  session?: string;
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
    if (o.session) headers['x-brain-session'] = o.session;
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

const TIMEOUT_MS = 15 * 1000;
/* A node with a long body and many links fits; an answer past this is not one a frame should be sent. */
const ANSWER_BYTES = 4 * 1024 * 1024;
const KIND = /^[a-z][a-z0-9_-]{0,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/* The fields of a task a frame may write (brain's API §5), and those of a change to one. */
const TASK_FIELDS = ['title', 'body', 'scope', 'state', 'priority', 'due', 'scheduled', 'recur', 'tags', 'waiting_on'];
const SET_FIELDS = [...TASK_FIELDS, 'base_revision'];
/* What brain records as the session of a task written through here. */
const SESSION = 'edwind';
const NO_READ = 'This edwind has no brain to read (brain.readCredential is not set)';
const failed = (condition: string, report: string): CallResult => ({ error: { condition, report, restarts: [], backtrace: [] } });
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const within = (x: unknown, lo: number, hi: number): number | null => (Number.isInteger(x) ? Math.max(lo, Math.min(hi, x as number)) : null);
const only = (a: Record<string, unknown>, names: string[]) => { const o: Record<string, unknown> = {}; for (const k of names) if (Object.hasOwn(a, k)) o[k] = a[k]; return o; };

/* brain's feed of changes (GET /v1/changes), followed for the clients that asked (brain-tasks-follow): one
   follower for all of them, which runs from the first to ask until the last one stops or disconnects. It takes
   its place at the end of the feed (`after=now`) and then asks what changed since, of the tasks only, in a
   request brain holds open until something did or FEED_WAIT_S passed. A watcher is told that tasks changed,
   and nothing of which or how: it asks brain again for what it shows. */
const FEED_WAIT_S = 50;
/* brain answers a held request by FEED_WAIT_S; one it has not answered this long after is lost. */
const FEED_TIMEOUT_MS = (FEED_WAIT_S + 15) * 1000;
/* Between the starts of two requests, whatever brain answered; doubled while brain cannot answer, up to the cap. */
const FEED_GAP_MS = 1000;
const FEED_BACKOFF_MAX_MS = 60 * 1000;
export class TaskFeed {
  declare log: Log; declare base: URL; declare credential: Credential;
  declare watchers: Set<Client>;
  /* The follower that may go on is the one started with this number. */
  declare run: number;
  /* Over once the follower has asked for its place, whatever brain said; null while none runs. */
  declare first: Promise<void> | null;
  /* brain's cursor: where the next request starts. null without a place in the feed. */
  declare cursor: string | null;
  declare req: http.ClientRequest | null;
  declare timer: NodeJS.Timeout | undefined;
  declare wake: (() => void) | null;
  constructor(log: Log, base: URL, credential: Credential) {
    this.log = log; this.base = base; this.credential = credential;
    this.watchers = new Set(); this.run = 0; this.first = null; this.cursor = null; this.req = null; this.wake = null;
  }
  /* CLIENT watches from now. The answer is whether the feed has its place: what changes after it is told. When
     it has none yet, the client is told once brain answers, since something may have changed meanwhile. */
  async follow(client: Client): Promise<boolean> {
    this.watchers.add(client);
    if (!this.first) { const run = ++this.run; this.first = new Promise(placed => { void this.loop(run, placed); }); }
    await this.first;
    return this.cursor !== null && this.watchers.has(client);
  }
  leave(client: Client) { if (this.watchers.delete(client) && !this.watchers.size) this.halt(); }
  /* End the follower: the request brain holds is dropped, and a wait between two is over. */
  halt() {
    this.run++; this.first = null; this.cursor = null;
    if (this.req) this.req.destroy(); this.req = null;
    clearTimeout(this.timer);
    const wake = this.wake; this.wake = null; if (wake) wake();
  }
  stop() { this.watchers.clear(); this.halt(); }
  async loop(run: number, placed: () => void) {
    const live = () => run === this.run;
    /* WAIT is how long brain is left alone after an answer that was not one. MISSED: brain did not answer
       for a while, so a change may have gone by unseen, here without a place in the feed or by a watcher
       whose own question brain did not answer either. */
    let wait = 0, failing = false, missed = false;
    try {
      while (live()) {
        const t = Date.now(), u = new URL('v1/changes', this.base), held = this.cursor !== null;
        for (const [k, v] of Object.entries(held ? { after: this.cursor!, kind: 'task', limit: '200', wait: String(FEED_WAIT_S) } : { after: 'now' })) u.searchParams.set(k, v);
        let a: BrainAnswer | null = null, error = '';
        try {
          a = await brainRequest(u, this.credential, { method: 'GET', timeoutMs: held ? FEED_TIMEOUT_MS : TIMEOUT_MS, maxBytes: ANSWER_BYTES,
            track: r => { if (live()) this.req = r; } });
        } catch (e) { error = String((e as Error).message || e); }
        if (!live()) return;
        let answer: unknown = null;
        if (a && !a.cut) try { answer = JSON.parse(a.text); } catch (e) { /* not brain's JSON */ }
        if (a && a.status === 200 && isObj(answer) && typeof answer.cursor === 'string' && Array.isArray(answer.changes)) {
          /* The log has that the feed was asked and how it went, never what changed. The first answer after
             some that were not is in a log that leaves debug lines out, so it shows when brain was back. */
          this.log[failing ? 'info' : 'debug']('brain-read', { what: 'changes', status: a.status, ms: Date.now() - t });
          this.cursor = answer.cursor;
          if (answer.changes.length || missed) for (const w of this.watchers) w.send({ t: 'tasks' });
          wait = 0; failing = false; missed = false;
        } else {
          /* Said once for as long as it lasts. */
          if (!failing) this.log.warn('brain-read', a ? { what: 'changes', status: a.status, cut: a.cut } : { what: 'changes', error });
          failing = true;
          /* A brain that is away or failing takes the same cursor when it is back, and answers with what
             changed meanwhile. One that refuses the request, or answers something else, is asked for a new place. */
          if (a && a.status < 500) this.cursor = null;
          missed = true;
          wait = Math.min(FEED_BACKOFF_MAX_MS, wait ? wait * 2 : FEED_GAP_MS);
        }
        placed();
        const pause = Math.max(wait, FEED_GAP_MS - (Date.now() - t));
        if (pause > 0) await new Promise<void>(r => { this.wake = r; this.timer = setTimeout(r, pause); this.timer.unref(); });
      }
    } finally { placed(); }
  }
}

export class BrainClient {
  declare log: Log; declare base: URL; declare read: Credential | null; declare write: Credential | null;
  declare open: Set<http.ClientRequest>;
  declare feed: TaskFeed | null;
  constructor(server: Server) {
    const cfg = server.cfg.brain;
    this.log = server.log; this.open = new Set();
    this.base = new URL(cfg ? (cfg.url.endsWith('/') ? cfg.url : cfg.url + '/') : 'http://localhost/');
    this.read = cfg && cfg.readCredential ? new Credential(cfg.readCredential, this.base.origin) : null;
    this.write = cfg && cfg.taskCredential ? new Credential(cfg.taskCredential, this.base.origin) : null;
    this.feed = this.read ? new TaskFeed(this.log, this.base, this.read) : null;
  }
  /* One request to brain and its answer as a command's result. WHAT names it in the log, which holds neither
     the route's query nor the body. */
  async ask(what: string, credential: Credential, method: 'GET' | 'POST' | 'PATCH', route: string, query: Record<string, string>, body?: Record<string, unknown>): Promise<CallResult> {
    const u = new URL(route, this.base);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const event = method === 'GET' ? 'brain-read' : 'brain-write', t = Date.now();
    let mine: http.ClientRequest | null = null;
    let a: BrainAnswer;
    try {
      a = await brainRequest(u, credential, { method, timeoutMs: TIMEOUT_MS, maxBytes: ANSWER_BYTES,
        ...(body ? { body: Buffer.from(JSON.stringify(body)), session: SESSION } : {}),
        track: r => { if (r) { mine = r; this.open.add(r); } else if (mine) this.open.delete(mine); } });
    } catch (e) {
      this.log.warn(event, { what, error: String((e as Error).message || e) });
      return failed('brain-unavailable', `brain cannot be reached: ${(e as Error).message || e}`);
    }
    this.log.debug(event, { what, status: a.status, ms: Date.now() - t });
    let answer: unknown = null;
    if (!a.cut) try { answer = JSON.parse(a.text); } catch (e) { /* not brain's JSON */ }
    if (a.status >= 200 && a.status < 300 && answer && typeof answer === 'object') return { value: answer };
    const said = answer && typeof answer === 'object' && typeof (answer as { error?: unknown }).error === 'string' ? (answer as { error: string }).error : null;
    if (said && a.status >= 400 && a.status < 500) return failed('brain-refused', `brain: ${said}`);
    this.log.warn(event, { what, status: a.status, cut: a.cut });
    return failed('brain-unavailable', a.cut ? 'brain\'s answer is too long to show' : `brain answered ${a.status}`);
  }
  get(what: string, route: string, query: Record<string, string>): Promise<CallResult> {
    if (!this.read) return Promise.resolve(failed('brain-unavailable', NO_READ));
    return this.ask(what, this.read, 'GET', route, query);
  }
  put(what: string, method: 'POST' | 'PATCH', route: string, body: Record<string, unknown>): Promise<CallResult> {
    if (!this.write) return Promise.resolve(failed('brain-unavailable', 'This edwind cannot write tasks to brain (brain.taskCredential is not set)'));
    return this.ask(what, this.write, method, route, {}, body);
  }
  titles(a: Record<string, unknown>): Promise<CallResult> {
    const q = typeof a.q === 'string' ? a.q.slice(0, 200) : '';
    const query: Record<string, string> = { q, limit: String(within(a.limit, 1, 200) ?? 50) };
    if (typeof a.kind === 'string' && KIND.test(a.kind)) query.kind = a.kind;
    return this.get('titles', 'v1/titles', query);
  }
  async node(ref: unknown): Promise<CallResult> {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 300) return failed('wrong-type-argument', 'brain-node: a node id or scheme:value');
    return this.get('node', 'v1/nodes/' + encodeURIComponent(ref.trim()), {});
  }
  async agenda(a: Record<string, unknown>): Promise<CallResult> {
    if (typeof a.from !== 'string' || !DAY.test(a.from)) return failed('wrong-type-argument', 'brain-agenda: from is a day, as 2026-10-20');
    return this.get('agenda', 'v1/agenda', { from: a.from, days: String(within(a.days, 1, 366) ?? 7) });
  }
  /* A filter that is not one is refused, not left out: without it brain would answer for other tasks. */
  async tasks(a: Record<string, unknown>): Promise<CallResult> {
    const query: Record<string, string> = { limit: String(within(a.limit, 1, 200) ?? 100), offset: String(within(a.offset, 0, 1e9) ?? 0) };
    for (const [k, ok] of [['state', /^[a-z,]{1,80}$/], ['q', /^[^]{1,200}$/], ['tag', /^[^\s,]{1,64}$/]] as [string, RegExp][]) {
      const v = a[k];
      if (v === undefined || v === null || v === false) continue;
      if (typeof v !== 'string' || !ok.test(v)) return failed('wrong-type-argument', `brain-tasks: ${k} is not one brain takes`);
      query[k] = v;
    }
    return this.get('tasks', 'v1/tasks', query);
  }
  async taskAdd(fields: unknown): Promise<CallResult> {
    if (!isObj(fields) || typeof fields.title !== 'string' || !fields.title.trim()) return failed('wrong-type-argument', 'brain-task-add: the fields of a task, with a title');
    return this.put('task-add', 'POST', 'v1/tasks', only(fields, TASK_FIELDS));
  }
  async taskSet(ref: unknown, fields: unknown): Promise<CallResult> {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 300) return failed('wrong-type-argument', 'brain-task-set: a task, as its id or task:N');
    if (!isObj(fields)) return failed('wrong-type-argument', 'brain-task-set: the fields to change');
    return this.put('task-set', 'PATCH', 'v1/tasks/' + encodeURIComponent(ref.trim()), only(fields, SET_FIELDS));
  }
  async follow(client: Client, on: unknown): Promise<CallResult> {
    if (on !== true) { if (this.feed) this.feed.leave(client); return { value: false }; }
    if (!this.feed) return failed('brain-unavailable', NO_READ);
    return { value: await this.feed.follow(client) };
  }
  stop() { for (const r of this.open) r.destroy(); this.open.clear(); if (this.feed) this.feed.stop(); }
}

let client: BrainClient | null = null;
export async function install(server: Server): Promise<void> {
  const c = client = new BrainClient(server);
  const fields = (x: unknown) => (isObj(x) ? x : {});
  server.defineCommand('brain-titles', (_client, args) => c.titles(fields(args[0])));
  server.defineCommand('brain-node', (_client, args) => c.node(args[0]));
  server.defineCommand('brain-agenda', (_client, args) => c.agenda(fields(args[0])));
  server.defineCommand('brain-tasks', (_client, args) => c.tasks(fields(args[0])));
  server.defineCommand('brain-task-add', (_client, args) => c.taskAdd(args[0]));
  server.defineCommand('brain-task-set', (_client, args) => c.taskSet(args[0], args[1]));
  server.defineCommand('brain-tasks-follow', (cl, args) => c.follow(cl, args[0]));
  server.onDisconnect(cl => { if (c.feed) c.feed.leave(cl); });
}
export async function shutdown(): Promise<void> { if (client) client.stop(); client = null; }
export const name = 'brain';
