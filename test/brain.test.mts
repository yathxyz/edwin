// Nodes and tasks from brain (src/brain.ts, server/brain.mts) in a served Edwin against a real edwind and a
// loopback stand-in for brain: edwind sends the read token and logs neither it nor what was asked; brain's
// refusal and an edwind with no brain to read are told apart; brain-node-find names nodes as they are typed and
// opens a note as its file and anything else as a record; brain-node-insert links by id: or brain:, in Org and
// Markdown, and makes the note a new title names; brain-backlinks follows point; id: and title links find
// what only brain knows; a daily is made on disk through edwind. Tasks: edwind reads with the read token and
// writes with the task token, a task's fields only; the agenda shows the week and every open task; its keys
// change the task at point against the revision shown, say what brain replaced and what it refused;
// brain-task-add sends the selection and the note's id.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { TestDir, EdwindChild } from './edit-client.mts';

type EdwinCore = any; // any: Edwin's core (src) is outside this program's types

const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.cts');

const TOKEN = 'brain-read-token-for-the-tests-0123456789', TASK_TOKEN = 'brain-task-token-for-the-tests-9876543210';
interface Node { id: string; kind: string; title: string; aliases?: string[]; scope: string; org_id?: string; path?: string; body?: string; props?: Record<string, unknown>; links?: string[][] }
const id = (n: number, tail = '') => `${String(n).repeat(8)}-0000-4000-8000-${(tail || String(n).repeat(12)).padStart(12, '0')}`;
const ALPHA: Node = { id: id(1), kind: 'note', title: 'Alpha note', aliases: ['First letter'], scope: 'self', org_id: 'a-file', path: 'alpha.org' };
const SECTION: Node = { id: id(2), kind: 'note', title: 'Section', scope: 'self', org_id: 'a-section', path: 'alpha.org' };
const BETA: Node = { id: id(3), kind: 'note', title: 'Beta', scope: 'self', org_id: 'b-file', path: 'sub/beta.md' };
const DEEP: Node = { id: id(4), kind: 'note', title: 'Deep heading', scope: 'self', org_id: 'deep-id', path: 'deep/only.org' };
const TASK: Node = { id: id(5), kind: 'task', title: 'Ship the thing', scope: 'work', body: 'Do it.\n* a star line of the body\n', props: { status: 'open', priority: 2, nested: { x: 1 } } };
const MEET_NOTE: Node = { id: id(6), kind: 'note', title: 'Meeting', scope: 'self', org_id: 'm-file', path: 'meeting.org' };
const MEET_TASK: Node = { id: id(7), kind: 'task', title: 'Meeting', scope: 'work' };
const STAND_1: Node = { id: id(8, 'a1'), kind: 'memory', title: 'Standup', scope: 'self' };
const STAND_2: Node = { id: id(8, 'a2'), kind: 'memory', title: 'Standup', scope: 'self' };
const EXACT: Node = { id: id(8, 'b1'), kind: 'reference', title: 'Note', scope: 'ref' };
const WIP: Node = { id: id(8, 'b2'), kind: 'reference', title: '[WIP] Roadmap', scope: 'ref' };
const NODES = [ALPHA, SECTION, BETA, DEEP, TASK, MEET_NOTE, MEET_TASK, STAND_1, STAND_2, EXACT, WIP];
ALPHA.links = [['linked from', BETA.id], ['linked from', TASK.id], ['links_to', SECTION.id]];
TASK.links = [['about', ALPHA.id]];
const byId = (i: string) => NODES.find(n => n.id === i)!;
const row = (n: Node, alias: string | null = null) => ({ id: n.id, kind: n.kind, title: n.title, alias, scope: n.scope, org_id: n.org_id ?? null, path: n.path ?? null, updated_at: '2026-11-10T10:00:00Z' });
/* brain's GET /v1/titles: the nodes whose title or an alias holds q; with no q the two changed last. The query
   "al" is answered late and wrongly, as an answer that the next letters overtake. */
const SLOW_MS = 400;
function titles(q: string, kind: string | null) {
  const t = q.toLowerCase();
  if (t === 'al') return [{ ...row(ALPHA), id: id(9), title: 'Alpha stale answer', org_id: 'stale', path: 'stale.org' }];
  const rows = !t ? [row(TASK), row(ALPHA)] : NODES.flatMap(n => { if (n.title.toLowerCase().includes(t)) return [row(n)]; const a = (n.aliases || []).find(x => x.toLowerCase().includes(t)); return a ? [row(n, a)] : []; });
  return rows.filter(r => !kind || r.kind === kind);
}
function nodeOf(ref: string) {
  const n = NODES.find(x => x.id === ref || (x.org_id && 'org-id:' + x.org_id === ref)), t = TASKS.find(x => x.id === ref);
  if (t) return { ...taskView(t), identifiers: [], links: [] };
  if (!n) return null;
  return { id: n.id, kind: n.kind, title: n.title, body: n.body ?? null, props: n.kind === 'note' ? { sources: [n.path] } : n.props ?? {}, scope: n.scope, trust: 'owner', updated_at: '2026-11-10T10:00:00Z',
    identifiers: n.org_id ? [{ scheme: 'org-id', value: n.org_id }] : [],
    links: (n.links || []).map(([rel, to], i) => ({ rel, forward: rel !== 'linked from', edge_id: `e${i}`, id: to, kind: byId(to).kind, title: byId(to).title, scope: byId(to).scope })) };
}

/* brain's tasks. A task keeps what it was at each revision, as brain's history does. */
interface Task { id: string; number: number; title: string; body: string | null; scope: string; trust: string; revision: number; props: Record<string, unknown>; history: Map<number, Record<string, unknown>> }
type Send = (status: number, body: unknown) => void;
let TASKS: Task[] = [];
/* Every write brain was sent. */
const written: { method: string; path: string; auth: string | undefined; session: unknown; body: Record<string, unknown> }[] = [];
const fieldsOf = (t: Task): Record<string, unknown> => ({ title: t.title, body: t.body, scope: t.scope, trust: t.trust, ...t.props });
function task(number: number, title: string, scope: string, props: Record<string, unknown>, trust = 'owner', revision = 1): Task {
  const t: Task = { id: id(0, String(number)), number, title, body: null, scope, trust, revision, props, history: new Map() };
  t.history.set(revision, fieldsOf(t));
  return t;
}
/* The tasks as each case finds them, in brain's order. Today is Tuesday 10 November 2026. */
function resetTasks() {
  TASKS = [
    task(1, 'Pay the invoice', 'work', { state: 'todo', priority: 'A', due: '2026-11-07' }, 'owner', 3),
    task(2, 'Call the plumber', 'work', { state: 'todo', scheduled: '2026-11-10T14:30', tags: ['home', 'phone'] }),
    task(3, 'Write the report', 'work', { state: 'next', due: '2026-11-12' }, 'agent', 2),
    task(4, 'Read the paper', 'ref', { state: 'next' }),
    task(5, 'Water the plants', 'pub', { state: 'waiting', scheduled: '2026-11-08', recur: '+1w' }),
    task(6, 'Learn the cello', 'pub', { state: 'someday' }),
    task(7, 'Closed long ago', 'work', { state: 'done', closed: '2026-11-01T10:00:00Z' }),
  ];
  written.length = 0;
}
const taskN = (n: number) => TASKS.find(t => t.number === n)!;
const taskView = (t: Task) => ({ id: t.id, kind: 'task', title: t.title, body: t.body, props: t.props, scope: t.scope, trust: t.trust, revision: t.revision, number: t.number, updated_at: '2026-11-10T08:00:00Z' });
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const plusDays = (day: string, n: number) => new Date(Date.parse(day.slice(0, 10) + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
/* brain's PATCH: with base_revision a field left as it was then is not written, and one that changed on both
   sides is written and listed as a clash. Done on a task that repeats moves its dates a week on instead. */
function change(t: Task, fields: Record<string, unknown>) {
  const base = typeof fields.base_revision === 'number' ? t.history.get(fields.base_revision) : null, clashes: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'base_revision') continue;
    const was = fieldsOf(t)[k];
    if (base) { if (same(v, base[k])) continue; if (!same(was, base[k])) clashes.push({ field: k, was: was ?? null, base: base[k] ?? null, now: v }); }
    if (k === 'title' || k === 'scope' || k === 'trust') t[k] = String(v); else if (k === 'body') t.body = v as string | null; else if (v === null) delete t.props[k]; else t.props[k] = v;
  }
  if (t.props.state === 'done' && t.props.recur) { t.props.state = 'todo'; for (const k of ['due', 'scheduled']) if (typeof t.props[k] === 'string') t.props[k] = plusDays(t.props[k] as string, 7); }
  t.revision++; t.history.set(t.revision, fieldsOf(t));
  return clashes;
}
/* brain's GET /v1/agenda over the open tasks. */
function agendaOf(open: Task[], from: string, days: number) {
  const end = plusDays(from, days), overdue: unknown[] = [], dated: Record<string, unknown[]> = {}, next: unknown[] = [];
  for (const t of open) {
    let placed = false;
    for (const why of ['due', 'scheduled']) {
      if (typeof t.props[why] !== 'string') continue;
      const day = (t.props[why] as string).slice(0, 10); placed = true;
      if (day < from) { if (why === 'due' || !t.props.due) overdue.push({ ...taskView(t), why, day }); }
      else if (day < end) (dated[day] = dated[day] || []).push({ ...taskView(t), why });
    }
    if (!placed && t.props.state === 'next') next.push(taskView(t));
  }
  return { from, days, overdue, dated: Object.keys(dated).sort().map(date => ({ date, tasks: dated[date] })), next };
}
/* The task routes. brain takes the read token on the two that read and the task token on the two that write,
   and this token is cleared for three scopes. */
function tasksRoute(method: string, u: URL, auth: string | undefined, session: unknown, body: Record<string, unknown>, send: Send) {
  if (method === 'GET') {
    if (auth !== `Bearer ${TOKEN}`) return send(403, { error: 'this token does not read' });
    const open = TASKS.filter(t => !['done', 'cancelled'].includes(String(t.props.state)));
    if (u.pathname === '/v1/agenda') return send(200, agendaOf(open, u.searchParams.get('from')!, Number(u.searchParams.get('days'))));
    const offset = Number(u.searchParams.get('offset'));
    return send(200, { tasks: open.slice(offset, offset + Number(u.searchParams.get('limit'))).map(taskView) });
  }
  written.push({ method, path: u.pathname, auth, session, body });
  if (auth !== `Bearer ${TASK_TOKEN}`) return send(403, { error: 'this token does not write tasks' });
  if (typeof body.scope === 'string' && !['pub', 'ref', 'work'].includes(body.scope)) return send(403, { error: `scope ${body.scope} is outside this token` });
  if (method === 'POST' && u.pathname === '/v1/tasks') {
    const { title, body: text, scope, ...props } = body;
    const t = task(Math.max(...TASKS.map(x => x.number)) + 1, String(title), String(scope || 'work'), { state: 'todo', ...props });
    t.body = typeof text === 'string' ? text : null; TASKS.push(t);
    return send(201, taskView(t));
  }
  const t = method === 'PATCH' ? TASKS.find(x => x.id === decodeURIComponent(u.pathname.slice('/v1/tasks/'.length))) : null;
  if (!t) return send(404, { error: 'no such task' });
  const clashes = change(t, body);
  return send(200, { ...taskView(t), clashes });
}
const asked: { url: string; auth: string | undefined }[] = [];
/* While set, brain answers no question about tasks: a write is taken and the view after it is not given. */
let readsFail = false;
/* brain's feed of changes (GET /v1/changes), as edwind follows it. What it was asked is in `fed`, not in
   `asked`, with how many other questions came before it. The feed has a change when a case says so
   (taskChanged), not when a task is written, so a case that counts brain's questions counts its own. A question
   with `wait` and nothing to answer is held until there is, as brain holds it. */
const fed: { url: string; auth: string | undefined; before: number; at: number }[] = [];
const held = new Set<() => void>();
/* What a change in the feed says of its task, which edwind has no use for and passes on to nobody. */
const FEED_TITLE = 'Feed-only-title-words';
let feedAt = 100, feedAway = false;
function feedRoute(u: URL, auth: string | undefined, res: http.ServerResponse, send: Send) {
  const after = u.searchParams.get('after');
  const answer = () => {
    if (feedAway) return send(503, { error: 'brain is away' });
    if (auth !== `Bearer ${TOKEN}`) return send(403, { error: 'this token does not read' });
    if (after === 'now') return send(200, { changes: [], cursor: String(feedAt) });
    const node = { id: taskN(1).id, kind: 'task', title: FEED_TITLE, props: {}, scope: 'work', trust: 'owner', revision: 9, deleted_at: null, updated_at: '2026-11-10T08:00:00Z', number: 1 };
    send(200, Number(after) < feedAt ? { changes: [{ cursor: String(feedAt), op: 'update', at: '2026-11-10T08:00:00Z', node }], cursor: String(feedAt) } : { changes: [], cursor: after });
  };
  if (feedAway || after === 'now' || Number(after) < feedAt || !u.searchParams.get('wait')) return answer();
  held.add(answer); res.on('close', () => held.delete(answer));
}
const answerHeld = () => { for (const answer of [...held]) { held.delete(answer); answer(); } };
/* A task changed in brain, from anywhere. */
function taskChanged() { feedAt++; answerHeld(); }
function feedIsAway(away: boolean) { feedAway = away; answerHeld(); }
const brain = http.createServer((req, res) => {
  let sent = '';
  req.setEncoding('utf8'); req.on('data', d => { sent += d; });
  req.on('end', () => {
    const u = new URL(req.url!, 'http://brain');
    const send = (status: number, body: unknown, ms = 0) => setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }, ms);
    if (u.pathname === '/v1/changes') { fed.push({ url: req.url!, auth: req.headers.authorization, before: asked.length, at: Date.now() }); return feedRoute(u, req.headers.authorization, res, send); }
    asked.push({ url: req.url!, auth: req.headers.authorization });
    if (readsFail && req.method === 'GET' && (u.pathname === '/v1/agenda' || u.pathname === '/v1/tasks')) return send(503, { error: 'brain is away' });
    if (u.pathname === '/v1/agenda' || u.pathname === '/v1/tasks' || u.pathname.startsWith('/v1/tasks/')) return tasksRoute(req.method!, u, req.headers.authorization, req.headers['x-brain-session'], sent ? JSON.parse(sent) : {}, send);
    if (req.method !== 'GET') return send(404, { error: 'no such route' });
    if (u.pathname === '/v1/titles') return send(200, { results: titles(u.searchParams.get('q') || '', u.searchParams.get('kind')).slice(0, Number(u.searchParams.get('limit'))) }, u.searchParams.get('q') === 'al' ? SLOW_MS : 0);
    const n = u.pathname.startsWith('/v1/nodes/') ? nodeOf(decodeURIComponent(u.pathname.slice('/v1/nodes/'.length))) : null;
    return n ? send(200, n) : send(404, { error: 'no such node' });
  });
});

const ALPHA_ORG = `:PROPERTIES:
:ID:       a-file
:ROAM_ALIASES: "First letter"
:END:
#+title: Alpha note

Some text, and the id of the section quoted where no entry holds it:
#+begin_example
:ID:       a-section
#+end_example

* Section
:PROPERTIES:
:ID:       a-section
:END:
Under the section.
* Unknown to brain
:PROPERTIES:
:ID:       not-in-brain
:END:
`;
const DEEP_ORG = '#+title: Deep file\n\n* First\n** Deep heading\n:PROPERTIES:\n:ID: deep-id\n:END:\nDown here.\n* Last\n';

let dir: TestDir, child: EdwindChild, creds: string, url: string, Ed: EdwinCore, E: EdwinCore, L: EdwinCore, sync: EdwinCore;
const note = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir.dirs.notes, p)), { recursive: true }); fs.writeFileSync(path.join(dir.dirs.notes, p), text); };
const onDisk = (p: string) => { try { return fs.readFileSync(path.join(dir.dirs.notes, p), 'utf8'); } catch (e) { return null; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => unknown, what = 'condition', ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(10); } }
/* A WebSocket-like object over the unix socket, as frame.test.mts has it. */
function transport(sockPath: string) {
  return () => {
    const s = net.connect(sockPath); s.setEncoding('utf8');
    const ws: { onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null; onclose: (() => void) | null; onerror: ((e: Error) => void) | null; send(str: string): void; close(): void } =
      { onopen: null, onmessage: null, onclose: null, onerror: null, send: str => { s.write(str + '\n'); }, close: () => s.destroy() };
    let buf = '';
    s.on('connect', () => ws.onopen && ws.onopen());
    s.on('data', d => { buf += d; let i: number; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line && ws.onmessage) ws.onmessage({ data: line }); } });
    s.on('close', () => ws.onclose && ws.onclose());
    s.on('error', e => ws.onerror && ws.onerror(e));
    return ws;
  };
}
const feed = async (ks: string[]) => { for (const k of ks) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = (s: string) => feed(Ed.kbd(s).split(' '));
const type = (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch)));
const messages = (): string => Ed.getBuffer('*Messages*').text;
const cur = () => E.current;
const lineAt = (b = cur()): string => b.text.split('\n')[Ed.lineNoB(b, b.pt) - 1];
const candidates = (): string[] => Ed.miniCandidates();
const annotation = (label: string): string => E.mini.opts.annotate(label);
/* Empty the minibuffer, a key at a time as a hand would. */
const clear = () => feed([...E.minibuf.text].map(() => 'DEL'));
/* Visit the notes file P in the only window; a minibuffer that a failed case left open is closed first. */
async function visit(p: string) {
  if (E.mini) await keys('C-g');
  Ed.deleteOtherWindows();
  const b = await Ed.visit(p); await Ed.whenIdle();
  assert.ok(b instanceof Ed.Buffer, `${p} is visited`); assert.equal(cur(), b);
  return b;
}
/* Start a command that reads a node and wait for its minibuffer. */
async function ask(k: string) { await keys(k); await until(() => E.mini, 'the minibuffer'); assert.equal(E.mini.prompt, 'Node: '); }
const closedPort = () => new Promise<number>(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const makeCreds = (d: TestDir) => { const c = path.join(d.root, 'creds'); fs.mkdirSync(c, { mode: 0o700 }); for (const n of ['brain-token', 'brain-read-token']) fs.writeFileSync(path.join(c, n), TOKEN + '\n', { mode: 0o400 }); fs.writeFileSync(path.join(c, 'brain-task-token'), TASK_TOKEN + '\n', { mode: 0o400 }); return c; };

before(async () => {
  url = await new Promise<string>(r => brain.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(brain.address() as AddressInfo).port}`)));
  dir = makeDir({ brain: { url, readCredential: 'brain-read-token', taskCredential: 'brain-task-token' }, logLevel: 'debug' });
  creds = makeCreds(dir);
  note('alpha.org', ALPHA_ORG);
  note('sub/beta.md', '---\nid: b-file\ntitle: Beta\n---\n\nSee [Alpha](id:a-file).\n');
  note('deep/only.org', DEEP_ORG);
  note('host.org', '#+title: Host\n\n');
  note('page.md', '# Page\n\n');
  child = await startEdwind(dir, { env: { CREDENTIALS_DIRECTORY: creds } });
  const host = createHost({ storage: memoryStorage(), workers: false });
  Ed = loadEdwin(host); E = Ed.E; L = (globalThis as unknown as { L: EdwinCore }).L;
  sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'brain-test' });
  await Ed.whenIdle();
});
after(async () => { if (sync) sync.shutdown(); if (child) await stopEdwind(child); brain.close(); brain.closeAllConnections(); fs.rmSync(dir.root, { recursive: true, force: true }); });

test('edwind asks brain with the read token, and logs neither the token nor what was asked', async () => {
  const r = await sync.call({ cmd: 'brain-titles', args: [{ q: 'zebra-query-text', kind: 'note', limit: 7 }] });
  assert.deepEqual(r.value, { results: [] });
  const last = asked[asked.length - 1];
  assert.equal(last.auth, `Bearer ${TOKEN}`);
  assert.equal(last.url, '/v1/titles?q=zebra-query-text&limit=7&kind=note');
  const n = await sync.call({ cmd: 'brain-node', args: ['org-id:a-file'] });
  assert.equal(n.value.id, ALPHA.id); assert.deepEqual(n.value.props, { sources: ['alpha.org'] });
  assert.equal(asked[asked.length - 1].url, '/v1/nodes/org-id%3Aa-file');
  assert.match(child.logs, /brain-read/, 'the request is logged');
  assert.ok(!child.logs.includes(TOKEN), 'no token in the log');
  assert.ok(!child.logs.includes('zebra-query-text') && !child.logs.includes('a-file'), 'nothing asked for in the log');
});

test('brain’s refusal is brain-refused in its words; no token to read with and no brain to reach are brain-unavailable', async () => {
  const r = await sync.call({ cmd: 'brain-node', args: ['org-id:nobody'] });
  assert.equal(r.error.condition, 'brain-refused'); assert.equal(r.error.report, 'brain: no such node');
  const errorOf = async (extra: Record<string, unknown>) => {
    const d = makeDir(extra), c = await startEdwind(d, { env: { CREDENTIALS_DIRECTORY: makeCreds(d) } });
    try {
      const cl = new EditClient(d.cfg.socket); await cl.connect(); assert.equal((await cl.hello()).t, 'welcome');
      const m = await cl.call('brain-titles', [{ q: 'x' }]); cl.close();
      assert.ok(!c.logs.includes(TOKEN));
      return m.error || m;
    } finally { await stopEdwind(c); fs.rmSync(d.root, { recursive: true, force: true }); }
  };
  const none = await errorOf({ brain: { url, credential: 'brain-token' } });
  assert.equal(none.condition, 'brain-unavailable'); assert.match(none.report, /no brain to read/);
  const away = await errorOf({ brain: { url: `http://127.0.0.1:${await closedPort()}`, readCredential: 'brain-read-token' } });
  assert.equal(away.condition, 'brain-unavailable'); assert.match(away.report, /^brain cannot be reached/);
});

test('brain-node-find: candidates follow the typing, a late answer is dropped, and a note opens as its file on its heading', async () => {
  await visit('host.org');
  assert.equal(Ed.getBuffer('alpha.org'), null, 'the note’s file is not open');
  await ask('SPC n r f');
  assert.deepEqual(candidates(), ['Ship the thing', 'Alpha note'], 'with nothing typed, the nodes changed last, in brain’s order');
  assert.equal(annotation('Ship the thing'), 'task       work'); assert.equal(annotation('Alpha note'), 'note       alpha.org');
  // "al" is answered late; by then the input is "alpha" and its own answer is shown.
  await type('al'); await sleep(200); await type('pha');
  await until(() => asked.some(a => a.url.startsWith('/v1/titles?q=alpha&')), 'brain is asked for the input');
  await sleep(SLOW_MS + 150);
  assert.deepEqual(candidates(), ['Alpha note'], 'the answer for "al" came after and is not shown');
  await clear(); await type('sect');
  await until(() => candidates()[0] === 'Section', 'the names for what is typed now');
  assert.deepEqual(candidates(), ['Section']);
  await keys('RET');
  await until(() => cur().id === 'alpha.org', 'the note’s file');
  assert.equal(cur().shared, true); assert.equal(lineAt(), '* Section', 'point is on the entry that holds the id');
  assert.equal(E.mini, null);
});

test('an alias names its note; a file-level note opens at the top', async () => {
  await visit('host.org');
  await ask('SPC n r f');
  await type('first');
  await until(() => candidates()[0] === 'First letter', 'the alias');
  assert.deepEqual(candidates(), ['First letter']);
  assert.equal(annotation('First letter'), 'note       alpha.org  → Alpha note');
  await keys('RET');
  await until(() => cur().id === 'alpha.org', 'the note’s file');
  assert.equal(cur().pt, 0);
});

test('nodes with one title are told apart by kind, then by the end of their id', async () => {
  await visit('host.org');
  await ask('SPC n r f');
  await type('meeting');
  await until(() => candidates().length === 2 && candidates()[0].startsWith('Meeting'), 'both meetings');
  assert.deepEqual(candidates(), ['Meeting (note)', 'Meeting (task)']);
  assert.equal(annotation('Meeting (note)'), 'note       meeting.org'); assert.equal(annotation('Meeting (task)'), 'task       work');
  await clear(); await type('standup');
  await until(() => candidates().length === 2 && candidates()[0].startsWith('Standup'), 'both standups');
  assert.deepEqual(candidates(), ['Standup (memory 000000a1)', 'Standup (memory 000000a2)']);
  await keys('C-n RET');
  await until(() => cur().name === '*brain: Standup*', 'the record');
  assert.deepEqual(cur().brain, { ref: STAND_2.id }, 'the second of the two is the one opened');
});

test('RET typed ahead of brain’s answer takes brain’s node for what was typed: not an earlier name, not a new note', async () => {
  await visit('host.org');
  await ask('SPC n r f');
  // "Alpha note", a name of the empty input, holds "note"; brain's answer for it has a node titled just so.
  await feed(['n', 'o', 't', 'e', 'RET']);
  await until(() => cur().name === '*brain: Note*', 'the node titled as typed');
  assert.deepEqual(cur().brain, { ref: EXACT.id });
  await visit('host.org');
  const made = messages().split('New note').length;
  await ask('SPC n r f');
  // No earlier name holds "sect" and no node is titled so: brain's first node for it.
  await feed(['s', 'e', 'c', 't', 'RET']);
  await until(() => cur().id === 'alpha.org', 'brain’s first node for what was typed');
  assert.equal(lineAt(), '* Section', 'on the entry whose drawer holds the id, not where a block quotes it');
  assert.equal(messages().split('New note').length, made, 'no note was made');
});

test('brain’s answer is listed as brain gave it: capitals in the input, and a title with brackets links', async () => {
  note('brackets.org', '#+title: Brackets\n\n');
  const b = await visit('brackets.org');
  await ask('SPC n r f');
  await type('Thing');
  await until(() => candidates().length === 1, 'the node brain found, whatever the case');
  assert.deepEqual(candidates(), ['Ship the thing']);
  await keys('C-g');
  b.pt = b.text.length;
  await ask('SPC n r i');
  await type('roadmap'); await until(() => candidates()[0] === '[WIP] Roadmap', 'the title as it is');
  await keys('RET');
  await until(() => b.text.includes(`[[brain:${WIP.id}][(WIP) Roadmap]]`), 'a description that cannot end the link');
  b.pt = b.text.indexOf('(WIP)');
  await Ed.callInteractively(L.intern('org-open-at-point'));
  await until(() => cur().name === '*brain: [WIP] Roadmap*', 'the link opens its node');
});

test('a highlight moved off the first name stays on its node when brain answers, and a completed name is not asked for', async () => {
  await visit('host.org');
  await ask('SPC n r f');
  await type('meeting');
  await until(() => candidates().length === 2 && candidates()[0] === 'Meeting (note)', 'both meetings');
  // The input loses a letter, and the highlight moves to the task before brain has answered for it.
  const n = asked.length;
  await feed(['DEL', 'C-n']);
  await until(() => asked.slice(n).some(a => a.url.startsWith('/v1/titles?q=meetin&')), 'brain is asked again');
  await sleep(100);
  assert.deepEqual(candidates(), ['Meeting (note)', 'Meeting (task)']);
  assert.equal(candidates()[E.mini.index], 'Meeting (task)');
  await keys('TAB');
  assert.equal(E.minibuf.text, 'Meeting (task)');
  const m = asked.length;
  await sleep(300);
  assert.ok(!asked.slice(m).some(a => a.url.startsWith('/v1/titles')), 'the name of a candidate is not a question');
  await keys('RET');
  await until(() => cur().name === '*brain: Meeting*', 'the record');
  assert.deepEqual(cur().brain, { ref: MEET_TASK.id });
});

test('a node that is not a note opens as a record: read only, in Motion state, RET follows a link, q leaves', async () => {
  await visit('host.org');
  await L.call('brain-node-find', [TASK.id]);
  const b = cur();
  assert.equal(b.name, '*brain: Ship the thing*'); assert.equal(b.mode, 'brain-mode'); assert.equal(b.readOnly, true); assert.equal(b.evilState, 'motion');
  assert.equal(b.text, `#+title: Ship the thing\ntask · work · owner\n\nstatus: open\npriority: 2\n\nDo it.\n * a star line of the body\n\n* about (1)\n** [[brain:${ALPHA.id}][Alpha note]] · note\n`);
  b.pt = b.text.indexOf('** [[brain:'); await keys('RET');
  await until(() => cur().id === 'alpha.org', 'the note the record links to');
  await L.call('brain-node-find', [TASK.id]);
  assert.equal(cur().name, '*brain: Ship the thing*');
  await keys('q');
  assert.equal(cur().id, 'alpha.org');
});

test('brain-node-insert in Org: id: to a note, brain: to anything else, and a selection is the description', async () => {
  const b = await visit('host.org');
  b.pt = b.text.length;
  await ask('SPC n r i');
  await type('alpha note'); await until(() => candidates()[0] === 'Alpha note', 'the note');
  await keys('RET');
  await until(() => b.text.includes('[[id:a-file][Alpha note]]'), 'the link to the note');
  assert.equal(cur(), b, 'the buffer stays');
  await keys('o'); await type('see Ship the thing here'); await keys('ESC');
  b.pt = b.text.indexOf('Ship'); await keys('v e e e');
  await ask('SPC n r i');
  assert.equal(E.minibuf.text, 'Ship the thing', 'the selection is what is looked for');
  assert.deepEqual(candidates(), ['Ship the thing']);
  await keys('RET');
  await until(() => b.text.includes('[[brain:'), 'the link to the task');
  assert.equal(b.text, `#+title: Host\n\n[[id:a-file][Alpha note]]\nsee [[brain:${TASK.id}][Ship the thing]] here`);
});

test('brain-node-insert in Markdown writes [title](id:…) and [title](brain:…), and the links open their nodes', async () => {
  const b = await visit('page.md');
  b.pt = b.text.length;
  await L.call('brain-node-insert', [ALPHA.id]);
  Ed.insertText(b, '\n');
  await L.call('brain-node-insert', [TASK.id]);
  assert.equal(b.text, `# Page\n\n[Alpha note](id:a-file)\n[Ship the thing](brain:${TASK.id})`);
  b.pt = b.text.indexOf('[Ship') + 2;
  await Ed.callInteractively(L.intern('wiki-follow'));
  await until(() => cur().name === '*brain: Ship the thing*', 'the task’s record');
  await visit('page.md');
  b.pt = b.text.indexOf('[Alpha') + 2;
  await Ed.callInteractively(L.intern('wiki-follow'));
  await until(() => cur().id === 'alpha.org', 'the note’s file');
});

test('a title brain has no node for makes a note file through edwind, with an :ID: the link names', async () => {
  const b = await visit('host.org');
  b.pt = b.text.length; Ed.insertText(b, '\n');
  await ask('SPC n r i');
  await type('Brand new idea');
  await until(() => candidates().length === 0, 'no candidate');
  await keys('RET');
  await until(() => /Capture template/.test(E.prompt || ''), 'the template is asked for');
  await type('n');
  await until(() => /\[\[id:[0-9a-f-]{36}\]\[Brand new idea\]\]$/.test(b.text), 'the link to the new note');
  assert.equal(cur(), b, 'the new note is not shown');
  const newId = /\[\[id:([0-9a-f-]{36})\]\[Brand new idea\]\]$/.exec(b.text)![1];
  const file = fs.readdirSync(dir.dirs.notes).find(f => /^\d{14}-brand_new_idea\.org$/.test(f));
  assert.ok(file, `the note’s file is in the notes directory: ${fs.readdirSync(dir.dirs.notes)}`);
  await until(() => (onDisk(file!) || '').includes('#+title'), 'the file is saved');
  assert.match(onDisk(file!)!, new RegExp(`^:PROPERTIES:\\n:ID: ${newId}\\n:END:\\n#\\+title: Brand new idea\\n#\\+created: \\[[^\\]]+\\]\\n\\n$`));
  // The same from brain-node-find, which visits the note; a Markdown template carries the id in its front matter.
  await ask('SPC n r f');
  await type('Other new idea'); await until(() => candidates().length === 0, 'no candidate');
  await keys('RET');
  await until(() => /Capture template/.test(E.prompt || ''), 'the template is asked for');
  await type('m');
  await until(() => /-other_new_idea\.md$/.test(cur().id || ''), 'the new note is visited');
  assert.match(cur().text, /^---\nid: [0-9a-f-]{36}\ntitle: Other new idea\n/);
  assert.ok(cur().pt >= cur().text.length - 1, 'point is where the template’s %? was, at the end');
  await until(() => (onDisk(cur().id) || '').startsWith('---\nid: '), 'the file is saved');
  assert.match(messages(), /New note \d{14}-other_new_idea\.md/);
});

test('brain-backlinks: a side window with what links to the note at point, following point; RET opens a link, q closes', async () => {
  const b = await visit('alpha.org');
  b.pt = 0;
  await keys('SPC n r b');
  await until(() => Ed.getBuffer('*brain-backlinks*') && Ed.windowFor(Ed.getBuffer('*brain-backlinks*')), 'the backlinks window');
  const rb = Ed.getBuffer('*brain-backlinks*');
  assert.equal(cur(), b, 'the note keeps the selection'); assert.equal(Ed.windowList().length, 2);
  assert.equal(rb.mode, 'brain-mode'); assert.equal(rb.readOnly, true);
  assert.equal(rb.text, `#+title: Alpha note\n\n* Backlinks (2)\n** [[brain:${BETA.id}][Beta]] · note\n** [[brain:${TASK.id}][Ship the thing]] · task\n* links to (1)\n** [[brain:${SECTION.id}][Section]] · note\n`);
  // Point moves into the section, a note of its own with nothing linking to it.
  b.pt = b.text.indexOf('Under the section'); await keys('l');
  await until(() => rb.text.startsWith('#+title: Section\n'), 'the section’s backlinks');
  assert.equal(rb.text, '#+title: Section\n\n* Backlinks (0)\n');
  // A note brain does not know is said in the window, and nothing is signalled.
  const before = messages();
  b.pt = b.text.indexOf('* Unknown to brain'); await keys('l');
  await until(() => rb.text.includes('no such node'), 'brain’s answer');
  assert.equal(rb.text, '#+title: not-in-brain\n\nbrain: no such node\n');
  assert.equal(messages(), before, 'no error for it');
  b.pt = 0; await keys('l');
  await until(() => rb.text.startsWith('#+title: Alpha note\n'), 'the file’s backlinks again');
  // RET on a backlink opens it in the note's window.
  Ed.selectWindow(Ed.windowFor(rb)); rb.pt = rb.text.indexOf('** [[brain:'); await keys('RET');
  await until(() => cur().id === 'sub/beta.md', 'the note that links here');
  assert.equal(Ed.windowList().length, 2); assert.ok(Ed.windowFor(rb), 'the backlinks stay');
  assert.equal(cur().pt, 0);
  Ed.selectWindow(Ed.windowFor(rb)); await keys('q');
  assert.equal(Ed.windowList().length, 1); assert.equal(Ed.windowFor(rb), null);
  // The command toggles.
  await visit('alpha.org'); await keys('SPC n r b');
  await until(() => Ed.windowFor(rb), 'the window again');
  await keys('SPC n r b'); await Ed.whenIdle();
  assert.equal(Ed.windowFor(rb), null);
  // A buffer with no note in it has none.
  E.current = Ed.getBuffer('*scratch*'); Ed.setWindowBuffer(E.current);
  await keys('SPC n r b');
  await until(() => /No note at point/.test(messages()), 'the refusal');
});

test('an id: link opens a file here at once, and one only brain knows through brain; a title link finds its note', async () => {
  const b = await visit('host.org');
  b.pt = b.text.length; Ed.insertText(b, '\n[[id:deep-id][Deep]] [[First letter]] [[roam:beta]] [[roam:No such title]]\n');
  assert.equal(Ed.getBuffer('deep/only.org'), null, 'no buffer holds the id');
  const count = asked.length;
  b.pt = b.text.indexOf('[[id:deep-id') + 3;
  await Ed.callInteractively(L.intern('org-open-at-point'));
  await until(() => cur().id === 'deep/only.org', 'the file that holds the id');
  assert.equal(lineAt(), '** Deep heading');
  assert.equal(asked[asked.length - 1].url, '/v1/nodes/org-id%3Adeep-id');
  // alpha.org is open: its ids are known here and brain is not asked.
  assert.ok(Ed.getBuffer('alpha.org'));
  const known = asked.length; assert.ok(known > count);
  await visit('host.org'); b.pt = b.text.length; Ed.insertText(b, '[[id:a-section][S]]'); b.pt -= 3;
  await Ed.callInteractively(L.intern('org-open-at-point'));
  await until(() => cur().id === 'alpha.org', 'the open file');
  assert.equal(lineAt(), '* Section'); assert.equal(asked.length, known, 'brain is not asked for an id a file here holds');
  // A bare title is an alias of the note; roam: takes a title whatever its case.
  await visit('host.org'); b.pt = b.text.indexOf('[[First letter') + 3;
  Ed.getBuffer('alpha.org').pt = 40;
  await Ed.callInteractively(L.intern('org-open-at-point'));
  await until(() => cur().id === 'alpha.org', 'the note of the alias');
  assert.equal(cur().pt, 0);
  await visit('host.org'); b.pt = b.text.indexOf('[[roam:beta') + 3;
  await Ed.callInteractively(L.intern('org-open-at-point'));
  await until(() => cur().id === 'sub/beta.md', 'the note of the title');
  await visit('host.org'); b.pt = b.text.indexOf('[[roam:No such') + 3;
  await assert.rejects(Ed.callInteractively(L.intern('org-open-at-point')), /No note titled "No such title"/);
});

test('a daily is made on disk through edwind and visited; a second visit makes nothing', async () => {
  await visit('host.org');
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, file = `daily/${day}.org`;
  assert.equal(onDisk(file), null);
  await keys('SPC n r d t');
  await until(() => cur().id === file, 'the daily');
  assert.match(cur().text, new RegExp(`^:PROPERTIES:\\n:ID: [0-9a-f-]{36}\\n:END:\\n#\\+title: ${day}\\n\\* \\d\\d:\\d\\d \\n$`));
  assert.match(lineAt(), /^\* \d\d:\d\d $/, 'point is on the entry the template made');
  await until(() => onDisk(file) === cur().text, 'the daily is saved');
  const text = cur().text;
  await visit('host.org'); await keys('SPC n r d t');
  await until(() => cur().id === file, 'the daily again');
  assert.equal(cur().text, text);
  await L.call('dailies-goto-date', ['2026-01-02']);
  assert.equal(cur().id, 'daily/2026-01-02.org');
  await until(() => (onDisk('daily/2026-01-02.org') || '').includes('#+title: 2026-01-02\n'), 'the daily of the date is saved');
});

/* ---------- tasks ---------- */
const OrgCore = (): EdwinCore => (globalThis as unknown as { Org: EdwinCore }).Org;
const agenda = (): EdwinCore => Ed.getBuffer('*Agenda*');
const body = (): string[] => agenda().text.split('\n');
/* The agenda (a) or the task list (t) from host.org, with brain's tasks as new and today a Tuesday. */
async function showTasks(k: 'a' | 't') {
  OrgCore().ORG.now = () => new Date(2026, 10, 10, 9, 0);
  resetTasks();
  await visit('host.org');
  const was = agenda() && agenda().agenda;
  await keys('SPC m a'); await until(() => E.prompt, 'the key prompt'); await keys(k);
  await until(() => cur().name === '*Agenda*' && cur().agenda !== was, 'the agenda');
}
/* Point on the line of task N, the first when it has two. */
function onTask(n: number) { const b = agenda(), i = body().findIndex(l => l.startsWith(`  task:${n} `)); assert.ok(i >= 0, `task:${n} is shown`); b.pt = Ed.lineStartB(b, i + 1); }
/* Do WHAT and wait for the echo area to say SAID. */
async function saying(said: string, what: () => Promise<unknown>) { const from = messages().length; await what(); await until(() => messages().slice(from).includes(said), `the message ${said}; said: ${messages().slice(from)}`); }
/* A key that asks for one more: KEY, then THEN at its prompt. */
const pick = async (key: string, then: string) => { await keys(key); await until(() => E.prompt, 'the key prompt'); await keys(then); };
/* A key that reads in the minibuffer: KEY, then TEXT and RET. */
const answer = async (key: string, text: string) => { await keys(key); await until(() => E.mini, 'the minibuffer'); await type(text + '\n'); };
const lastWrite = () => written[written.length - 1];
const classAt = (b: EdwinCore, at: number): string => { const r = Ed.hooks.lexSeg(b, 0, b.text.length, b.text); return r.names[r.cls[at]]; };

test('edwind reads tasks with the read token and writes them with the task token: a task’s fields only, and none of it logged', async () => {
  resetTasks();
  const a = await sync.call({ cmd: 'brain-agenda', args: [{ from: '2026-11-10', days: 3, q: 'not-passed-on' }] });
  assert.equal(asked[asked.length - 1].url, '/v1/agenda?from=2026-11-10&days=3'); assert.equal(asked[asked.length - 1].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(a.value.overdue.map((t: EdwinCore) => [t.number, t.why, t.day]), [[1, 'due', '2026-11-07'], [5, 'scheduled', '2026-11-08']]);
  const n = asked.length;
  for (const from of [undefined, 'today', '2026-11-10T10:00']) assert.equal((await sync.call({ cmd: 'brain-agenda', args: [{ from }] })).error.condition, 'wrong-type-argument');
  assert.equal(asked.length, n, 'a day that is not one is not sent');
  await sync.call({ cmd: 'brain-agenda', args: [{ from: '2026-11-10', days: 9999 }] });
  assert.equal(asked[asked.length - 1].url, '/v1/agenda?from=2026-11-10&days=366');
  const l = await sync.call({ cmd: 'brain-tasks', args: [{ state: 'open', q: 'zebra-task-words', tag: 'home', limit: 2, offset: 1 }] });
  assert.equal(asked[asked.length - 1].url, '/v1/tasks?limit=2&offset=1&state=open&q=zebra-task-words&tag=home'); assert.equal(asked[asked.length - 1].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(l.value.tasks.map((t: EdwinCore) => t.number), [2, 3]);
  for (const bad of [{ state: 'Open' }, { state: 7 }, { tag: 'two words' }, { q: 'x'.repeat(201) }]) assert.equal((await sync.call({ cmd: 'brain-tasks', args: [bad] })).error.condition, 'wrong-type-argument');
  assert.equal(asked[asked.length - 1].url, '/v1/tasks?limit=2&offset=1&state=open&q=zebra-task-words&tag=home', 'a filter that is not one is not left out of a question that is sent');

  const made = await sync.call({ cmd: 'brain-task-add', args: [{ title: 'Quiet-title-words', scope: 'pub', body: 'Quiet-body-words', priority: 'B', tags: ['x'], props: { other: 1 }, client_id: 'c', links: [], identifiers: [], trust: 'owner' }] });
  assert.equal(made.value.number, 8); assert.equal(made.value.scope, 'pub');
  assert.deepEqual(lastWrite(), { method: 'POST', path: '/v1/tasks', auth: `Bearer ${TASK_TOKEN}`, session: 'edwind', body: { title: 'Quiet-title-words', body: 'Quiet-body-words', scope: 'pub', priority: 'B', tags: ['x'] } });
  const set = await sync.call({ cmd: 'brain-task-set', args: [taskN(8).id, { state: 'next', due: null, base_revision: 1, trust: 'owner', deleted: true, expect_revision: 7, set_props: { other: 1 }, props: {} }] });
  assert.equal(set.value.props.state, 'next'); assert.deepEqual(set.value.clashes, []);
  assert.deepEqual(lastWrite(), { method: 'PATCH', path: `/v1/tasks/${taskN(8).id}`, auth: `Bearer ${TASK_TOKEN}`, session: 'edwind', body: { state: 'next', due: null, base_revision: 1, trust: 'owner' } }, 'a task is not deleted through edwind');
  await sync.call({ cmd: 'brain-task-set', args: ['task:8', { priority: 'A' }] });
  assert.equal(asked[asked.length - 1].url, '/v1/tasks/task%3A8', 'a reference is one path segment');

  const refused = await sync.call({ cmd: 'brain-task-add', args: [{ title: 'Private', scope: 'self' }] });
  assert.equal(refused.error.condition, 'brain-refused'); assert.equal(refused.error.report, 'brain: scope self is outside this token');
  const w = written.length;
  for (const args of [[{ scope: 'work' }], [{ title: '  ' }], ['a title'], []]) assert.equal((await sync.call({ cmd: 'brain-task-add', args })).error.condition, 'wrong-type-argument');
  for (const args of [['', { state: 'done' }], [taskN(1).id], [taskN(1).id, 'done'], [7, {}]]) assert.equal((await sync.call({ cmd: 'brain-task-set', args })).error.condition, 'wrong-type-argument');
  assert.equal(written.length, w, 'what is not a task or a change is not sent');

  assert.match(child.logs, /brain-write/, 'a write is logged');
  for (const secret of [TOKEN, TASK_TOKEN, 'Quiet-title-words', 'Quiet-body-words', 'zebra-task-words', 'not-passed-on', taskN(8).id]) assert.ok(!child.logs.includes(secret), `${secret} is not in the log`);
});

test('an edwind with no task token reads tasks and says it cannot write them; the projector’s token is not a task token', async () => {
  const d = makeDir({ brain: { url, readCredential: 'brain-read-token' } }), c = await startEdwind(d, { env: { CREDENTIALS_DIRECTORY: makeCreds(d) } });
  try {
    resetTasks();
    const cl = new EditClient(d.cfg.socket); await cl.connect(); assert.equal((await cl.hello()).t, 'welcome');
    assert.equal((await cl.call('brain-agenda', [{ from: '2026-11-10' }])).value.days, 7);
    for (const m of [await cl.call('brain-task-add', [{ title: 'Nowhere' }]), await cl.call('brain-task-set', [taskN(1).id, { state: 'done' }])]) {
      assert.equal(m.error.condition, 'brain-unavailable'); assert.match(m.error.report, /^This edwind cannot write tasks to brain/);
    }
    cl.close();
    assert.equal(written.length, 0, 'brain is sent nothing');
  } finally { await stopEdwind(c); fs.rmSync(d.root, { recursive: true, force: true }); }
  const bad = makeDir({ brain: { url, credential: 'brain-token', taskCredential: 'brain-token' } });
  try { await assert.rejects(startEdwind(bad, { env: { CREDENTIALS_DIRECTORY: makeCreds(bad) } }), /brain\.taskCredential must not be the projector's/); }
  finally { fs.rmSync(bad.root, { recursive: true, force: true }); }
});

test('SPC m a a: the week from today, what is overdue first and the undated next actions last; q leaves', async () => {
  await showTasks('a');
  const b = cur();
  assert.equal(b.mode, 'brain-agenda-mode'); assert.equal(b.readOnly, true); assert.equal(b.evilState, 'motion');
  assert.equal(b.text, [
    'Agenda for 7 days from 2026-11-10',
    'Overdue',
    '  task:1    3 d. ago:   TODO [#A] Pay the invoice  work',
    '  task:5    Sched. 2x:  WAITING Water the plants  pub',
    'Tuesday    10 November 2026',
    '  task:2    Scheduled:  14:30 TODO Call the plumber  :home:phone:  work',
    'Wednesday  11 November 2026',
    'Thursday   12 November 2026',
    '  task:3    Due:        NEXT (proposal) Write the report  work',
    'Friday     13 November 2026',
    'Saturday   14 November 2026',
    'Sunday     15 November 2026',
    'Monday     16 November 2026',
    'Next',
    '  task:4    NEXT Read the paper  ref',
    ''].join('\n'));
  assert.equal(lineAt(), 'Tuesday    10 November 2026', 'point is on today');
  assert.equal(asked[asked.length - 1].url, '/v1/agenda?from=2026-11-10&days=7');
  const at = (s: string) => classAt(b, b.text.indexOf(s));
  assert.deepEqual(['Agenda for', 'Overdue', '3 d. ago:', 'Tuesday', 'Wednesday', 'Scheduled:', '14:30', 'TODO', '[#A]', '(proposal)', ':home:', 'Pay the'].map(at),
    ['ba-title', 'ba-head', 'ba-over', 'ba-today', 'ba-head', 'ba-label', 'ba-time', 'ba-state', 'ba-pri', 'ba-proposal', 'ba-tags', '']);
  assert.equal(Ed.windowList().length, 2, 'the agenda has a window of its own');
  await saying('No task on this line', () => keys('x'));
  assert.equal(written.length, 0);
  await keys('q');
  assert.equal(cur().id, 'host.org'); assert.equal(Ed.windowList().length, 1);
});

test('SPC m a t: every open task by state, in brain’s order, asked for a page at a time', async () => {
  await showTasks('t');
  assert.equal(cur().text, [
    'Open tasks (6)',
    'Next (2)',
    '  task:3    NEXT (proposal) Write the report  work  due 2026-11-12',
    '  task:4    NEXT Read the paper  ref',
    'To do (2)',
    '  task:1    TODO [#A] Pay the invoice  work  due 2026-11-07',
    '  task:2    TODO Call the plumber  :home:phone:  work  scheduled 2026-11-10 14:30',
    'Waiting (1)',
    '  task:5    WAITING Water the plants  pub  scheduled 2026-11-08',
    'Someday (1)',
    '  task:6    SOMEDAY Learn the cello  pub',
    ''].join('\n'));
  assert.equal(lineAt(), '  task:3    NEXT (proposal) Write the report  work  due 2026-11-12', 'point is on the first task');
  for (let k = 0; k < 200; k++) TASKS.push(task(100 + k, `Filler ${k}`, 'pub', { state: 'hold' }));
  const n = asked.length, was = agenda().agenda;
  await keys('r');
  await until(() => agenda().agenda !== was, 'the list again');
  assert.deepEqual(asked.slice(n).map(a => a.url), ['/v1/tasks?limit=200&offset=0&state=open', '/v1/tasks?limit=200&offset=200&state=open']);
  assert.equal(body()[0], 'Open tasks (206)'); assert.ok(body().includes('Hold (200)'));
  assert.equal(lineAt(), '  task:3    NEXT (proposal) Write the report  work  due 2026-11-12', 'point stays on its task');
  // Exactly as many as are shown: one more question says that nothing follows the last full page.
  for (let k = 0; k < 1794; k++) TASKS.push(task(1000 + k, `More ${k}`, 'pub', { state: 'hold' }));
  const m = asked.length, then = agenda().agenda;
  await keys('r');
  await until(() => agenda().agenda !== then, 'the list again');
  assert.equal(asked[asked.length - 1].url, '/v1/tasks?limit=1&offset=2000&state=open');
  assert.equal(asked.length - m, 11);
  assert.equal(body()[0], 'Open tasks (2000)');
  TASKS.push(task(5000, 'One too many', 'pub', { state: 'hold' }));
  const last = agenda().agenda;
  await keys('r');
  await until(() => agenda().agenda !== last, 'the list again');
  assert.equal(body()[0], 'Open tasks (2000, and more that are not shown)');
  await keys('q');
});

test('RET opens the task’s record; t, x, s, d and p change the task at point against the revision shown', async () => {
  await showTasks('a');
  onTask(1); await keys('RET');
  await until(() => cur().name === '*brain: Pay the invoice*', 'the record');
  assert.match(cur().text, /^#\+title: Pay the invoice\ntask · work · owner\n\nstate: todo\npriority: A\ndue: 2026-11-07\n/);
  await showTasks('a');

  onTask(1); await saying('task:1: next', () => pick('t', 'n'));
  assert.deepEqual(lastWrite(), { method: 'PATCH', path: `/v1/tasks/${taskN(1).id}`, auth: `Bearer ${TASK_TOKEN}`, session: 'edwind', body: { state: 'next', base_revision: 3 } });
  assert.equal(lineAt(), '  task:1    3 d. ago:   NEXT [#A] Pay the invoice  work', 'the view is asked for again and point stays on the task');
  await saying('Invalid key z', () => pick('t', 'z'));
  assert.equal(written.length, 1);

  onTask(2); await saying('task:2: done', () => keys('x'));
  assert.deepEqual(lastWrite().body, { state: 'done', base_revision: 1 });
  assert.ok(!agenda().text.includes('task:2 '), 'a closed task leaves the agenda');
  onTask(5); await saying('task:5: done; it repeats, scheduled 2026-11-15', () => keys('x'));
  assert.equal(lineAt(), '  task:5    Scheduled:  TODO Water the plants  pub', 'a task that repeats moved on, and point with it');
  assert.equal(body()[body().indexOf(lineAt()) - 1], 'Sunday     15 November 2026');

  onTask(4); await saying('task:4: scheduled 2026-11-13 09:15', () => answer('s', '2026-11-13 09:15'));
  assert.deepEqual(lastWrite().body, { scheduled: '2026-11-13T09:15', base_revision: 1 });
  assert.equal(lineAt(), '  task:4    Scheduled:  09:15 NEXT Read the paper  ref');
  assert.equal(body()[body().indexOf(lineAt()) - 1], 'Friday     13 November 2026');
  await saying('task:4: due 2026-11-10', () => answer('d', ''));
  assert.deepEqual(lastWrite().body, { due: '2026-11-10', base_revision: 2 }, 'nothing typed is today, and a day has no time');
  await saying('task:4: not scheduled', () => keys('C-u s'));
  assert.deepEqual(lastWrite().body, { scheduled: null, base_revision: 3 });
  assert.equal(E.mini, null, 'C-u asks for no date');
  assert.equal(lineAt(), '  task:4    Due:        NEXT Read the paper  ref');
  await saying('task:4: not due', () => L.call('brain-task-due', [false]));
  assert.deepEqual(body().slice(-3), ['Next', '  task:4    NEXT Read the paper  ref', '']);
  await saying('Not a date: someday maybe', () => answer('d', 'someday maybe'));

  await saying('task:4: priority B', () => pick('p', 'b'));
  assert.deepEqual(lastWrite().body, { priority: 'B', base_revision: 5 });
  assert.equal(lineAt(), '  task:4    NEXT [#B] Read the paper  ref');
  await saying('task:4: no priority', () => pick('p', 'SPC'));
  assert.deepEqual(lastWrite().body, { priority: null, base_revision: 6 });
  await keys('q');
});

test('e, m and c: a new title, another scope, a proposal confirmed; what brain refuses is said in its words', async () => {
  await showTasks('t');
  onTask(4);
  await keys('e'); await until(() => E.mini, 'the minibuffer');
  assert.equal(E.mini.prompt, 'Title: '); assert.equal(E.minibuf.text, 'Read the paper', 'the title is there to edit');
  await saying('task:4: Read the paper twice', () => type(' twice\n'));
  assert.deepEqual(lastWrite().body, { title: 'Read the paper twice', base_revision: 1 });
  assert.equal(lineAt(), '  task:4    NEXT Read the paper twice  ref');

  await keys('m'); await until(() => E.mini, 'the minibuffer');
  assert.deepEqual(candidates(), ['pub', 'ref', 'work', 'infra']);
  await saying('task:4: in pub', () => type('pub\n'));
  assert.deepEqual(lastWrite().body, { scope: 'pub', base_revision: 2 });
  const shown = agenda().text;
  await saying('brain: scope infra is outside this token', () => answer('m', 'infra'));
  assert.equal(taskN(4).scope, 'pub'); assert.equal(agenda().text, shown, 'a refusal changes nothing');

  onTask(3); await saying('task:3: confirmed', () => keys('c'));
  assert.deepEqual(lastWrite().body, { trust: 'owner', base_revision: 2 });
  assert.equal(lineAt(), '  task:3    NEXT Write the report  work  due 2026-11-12', 'it is a proposal no longer');
  const w = written.length;
  await saying('task:3 is not a proposal', () => keys('c'));
  assert.equal(written.length, w);
  await keys('q');
});

test('a change is made against the revision shown: brain keeps what changed since, and says what this one replaced', async () => {
  await showTasks('a');
  // Elsewhere the task got another title and another priority; the agenda still shows revision 3.
  change(taskN(1), { title: 'Pay the big invoice', priority: 'C' });
  onTask(1); await saying('task:1: waiting', () => pick('t', 'w'));
  assert.deepEqual(lastWrite().body, { state: 'waiting', base_revision: 3 });
  assert.equal(lineAt(), '  task:1    3 d. ago:   WAITING [#C] Pay the big invoice  work', 'what changed elsewhere is kept and shown');
  change(taskN(1), { priority: 'A', due: '2026-11-09' });
  await saying('task:1: priority B; replaced what had changed since: priority was A', () => pick('p', 'b'));
  assert.deepEqual(lastWrite().body, { priority: 'B', base_revision: 5 });
  assert.equal(lineAt(), '  task:1    1 d. ago:   WAITING [#B] Pay the big invoice  work');
  await keys('q');
});

test('a prompt changes the task it was opened on, only #f clears a field, and a title is one line of plain text', async () => {
  await showTasks('t');
  // Point moves while the minibuffer reads: the task is the one the prompt was opened on.
  onTask(4); await keys('e'); await until(() => E.mini, 'the minibuffer');
  onTask(3);
  await saying('task:4: Read the paper again', () => type(' again\n'));
  assert.equal(lastWrite().path, `/v1/tasks/${taskN(4).id}`);
  assert.equal(taskN(3).title, 'Write the report');
  onTask(4); await keys('s'); await until(() => E.mini, 'the minibuffer');
  onTask(6);
  await saying('task:4: scheduled 2026-11-14 00:30', () => type('2026-11-13 24:30\n'));
  assert.equal(lastWrite().path, `/v1/tasks/${taskN(4).id}`);
  assert.deepEqual(lastWrite().body, { scheduled: '2026-11-14T00:30', base_revision: 2 }, 'the day and the time are those of one moment');
  await assert.rejects(async () => L.call('brain-task-priority', ['A', 'no-such-id']), /The agenda does not show that task any more/);

  // A value that is neither text nor #f is a mistake, not a field to clear.
  const w = written.length;
  await assert.rejects(async () => L.call('brain-task-due', [7]), /No date/);
  await assert.rejects(async () => L.call('brain-task-schedule', ['  ']), /No date/);
  await assert.rejects(async () => L.call('brain-task-priority', [7]), /No priority/);
  assert.equal(written.length, w);

  // A title that would break the line, or turn its direction, is shown as plain text; a task with none is shown.
  taskN(6).title = 'Learn\u202e the\u2028cello\u0085';
  (taskN(4) as unknown as { title: null }).title = null;
  await keys('r');
  await until(() => body().includes('  task:6    SOMEDAY Learn  the cello  pub'), `the title on one line: ${JSON.stringify(body())}`);
  assert.ok(body().includes('  task:4    NEXT (no title)  ref  scheduled 2026-11-14 00:30'), JSON.stringify(body()));
  await keys('q');
});

test('after a change the agenda could not show, it takes no change until it is asked for again', async () => {
  await showTasks('a');
  onTask(5);
  readsFail = true;
  try {
    await saying('task:5: done; it repeats, scheduled 2026-11-15; the agenda is not refreshed (r asks again): brain answered 503', () => keys('x'));
    assert.equal(lineAt(), '  task:5    Sched. 2x:  WAITING Water the plants  pub', 'the line is the old one');
    const w = written.length;
    // The same key again would close the next occurrence too.
    await saying('The agenda does not show the last change: r asks brain again', () => keys('x'));
    await saying('The agenda does not show the last change: r asks brain again', () => pick('p', 'a'));
    assert.equal(written.length, w);
    assert.equal(taskN(5).props.scheduled, '2026-11-15');
  } finally { readsFail = false; }
  const was = agenda().agenda;
  await keys('r');
  await until(() => agenda().agenda !== was, 'the agenda again');
  onTask(5); await saying('task:5: priority A', () => pick('p', 'a'));
  await keys('q');
});

test('q closes a window made for the agenda, and gives a window the agenda took back what it showed', async () => {
  await visit('host.org');
  // One window that is not a popup: the one left from an earlier case may have been made as one.
  Ed.deleteOtherWindows(); E.sel.popup = false;
  await showTasks('a');
  assert.equal(Ed.windowList().length, 2);
  // A record opened from the agenda is in the agenda's window, and the agenda asked for from there has it back.
  onTask(4); await keys('RET'); await until(() => cur().name.startsWith('*brain: '), 'the record');
  await keys('SPC m a'); await until(() => E.prompt, 'the key prompt'); await keys('t');
  await until(() => cur().name === '*Agenda*', 'the agenda');
  assert.equal(Ed.windowList().length, 2);
  await keys('q');
  assert.equal(Ed.windowList().length, 1, 'its own window is closed');
  assert.equal(cur().id, 'host.org');

  // A popup window that shows something else: the agenda takes it, and q gives it back.
  const side = Ed.popToBuffer(Ed.getBuffer('alpha.org'), false);
  assert.ok(side.popup); assert.equal(Ed.windowList().length, 2);
  await keys('SPC m a'); await until(() => E.prompt, 'the key prompt'); await keys('a');
  await until(() => cur().name === '*Agenda*', 'the agenda');
  assert.equal(E.sel, side, 'the agenda is in the window that was there');
  await keys('q');
  assert.deepEqual(Ed.windowList().map((w: EdwinCore) => [w.buffer.id, w.popup]), [['host.org', false], ['alpha.org', true]], 'the window is not closed, and shows what it did');
  assert.equal(cur().id, 'host.org');
  Ed.deleteOtherWindows();
});

test('SPC o adds a task in brain-task-scope: the selection is its body, and the note at point is named by its id alone', async () => {
  resetTasks();
  await visit('host.org');
  await saying('task:8 added (work)', () => answer('SPC o', 'Buy milk'));
  assert.deepEqual(lastWrite(), { method: 'POST', path: '/v1/tasks', auth: `Bearer ${TASK_TOKEN}`, session: 'edwind', body: { title: 'Buy milk', scope: 'work' } });
  const w = written.length;
  await saying('No title', () => answer('SPC o', '  '));
  assert.equal(written.length, w);

  const b = await visit('alpha.org');
  b.pt = b.text.indexOf('Under the section.');
  await keys('V'); await keys('SPC o'); await until(() => E.mini, 'the minibuffer');
  assert.equal(E.mini.prompt, 'Task: ');
  L.set('brain-task-scope', 'pub');
  try { await saying('task:9 added (pub)', () => type('Follow this up\n')); } finally { L.set('brain-task-scope', 'work'); }
  assert.deepEqual(lastWrite().body, { title: 'Follow this up', scope: 'pub', body: 'Under the section.\n\n[[id:a-section]]' });
  assert.notEqual((globalThis as unknown as { EvilCore: EdwinCore }).EvilCore.stateOf(b), 'visual', 'the selection is over');
  b.pt = 0;
  await saying('task:10 added (work)', () => L.call('brain-task-add', ['From Scheme', 'Its body']));
  assert.deepEqual(lastWrite().body, { title: 'From Scheme', scope: 'work', body: 'Its body' });
  L.set('brain-task-scope', 'self');
  try { await assert.rejects(L.call('brain-task-add', ['Private']), /^Error: brain: scope self is outside this token$/); } finally { L.set('brain-task-scope', 'work'); }
  assert.equal(TASKS.length, 10);
});

test('a in the agenda adds a task, and an agenda that is shown follows a task added from another window', async () => {
  await showTasks('t');
  onTask(1);
  await saying('task:8 added (work)', () => answer('a', 'Ring the bank'));
  assert.ok(body().includes('  task:8    TODO Ring the bank  work'), 'the list shows the new task');
  assert.equal(body()[0], 'Open tasks (7)');
  assert.equal(lineAt(), '  task:1    TODO [#A] Pay the invoice  work  due 2026-11-07', 'point stays on its task');
  onTask(6);
  const shown = Ed.windowFor(agenda()), other = Ed.windowList().find((w: EdwinCore) => w.buffer !== agenda());
  Ed.selectWindow(other);
  assert.equal(cur().id, 'host.org');
  await saying('task:9 added (work)', () => L.call('brain-task-add', ['Post the letter']));
  assert.ok(body().includes('  task:9    TODO Post the letter  work'));
  assert.equal(body()[Ed.lineNoB(agenda(), shown.pt) - 1], '  task:6    SOMEDAY Learn the cello  pub', 'the agenda’s window is not the selected one, and its point is on its task still');
  await saying('task:6: next', () => L.call('brain-task-state', ['next', taskN(6).id]));
  assert.equal(body()[Ed.lineNoB(agenda(), shown.pt) - 1], '  task:6    NEXT Learn the cello  pub', 'and when its line moves to another place, the window’s point goes with it');
  assert.equal(cur().id, 'host.org', 'the window that added it stays selected');
  // An agenda in no window is left as it is.
  Ed.selectWindow(Ed.windowFor(agenda())); await keys('q');
  const text = agenda().text;
  await saying('task:10 added (work)', () => L.call('brain-task-add', ['Unseen']));
  assert.equal(agenda().text, text);
});

/* The agenda's window, with another one selected. */
function agendaAside() { const shown = Ed.windowFor(agenda()); Ed.selectWindow(Ed.windowList().find((w: EdwinCore) => w.buffer !== agenda())); return shown; }
const lineIn = (w: EdwinCore): string => body()[Ed.lineNoB(agenda(), w.pt) - 1];
/* The agenda is asked for again, with no key: what it then shows. */
async function followed(what: () => unknown) { const was = agenda().agenda; await what(); await until(() => agenda().agenda !== was, 'the agenda follows brain'); }
const FOLLOW = '/v1/changes?after=100&kind=task&limit=200&wait=50';

test('an agenda in a window follows brain: a task changed elsewhere is in it without r, and point stays on its task', async () => {
  const f = fed.length, a = asked.length;
  await showTasks('a');
  assert.equal(fed[f].url, '/v1/changes?after=now'); assert.equal(fed[f].auth, `Bearer ${TOKEN}`, 'the read token');
  assert.equal(fed[f].before, a, 'edwind has its place in the feed before the agenda is asked for');
  await until(() => held.size === 1, 'edwind asks what changes');
  assert.equal(fed.length, f + 2); assert.equal(fed[f + 1].url, FOLLOW); assert.equal(fed[f + 1].auth, `Bearer ${TOKEN}`);
  // From the CLI, say: the task at point moves a day on, and another is closed.
  onTask(3);
  const n = asked.length;
  await followed(() => { change(taskN(3), { due: '2026-11-13' }); change(taskN(2), { state: 'done' }); taskChanged(); });
  assert.ok(!body().some(l => l.includes('Call the plumber')), 'what was closed is gone');
  assert.equal(body()[body().indexOf('Friday     13 November 2026') + 1], '  task:3    Due:        NEXT (proposal) Write the report  work');
  assert.equal(lineAt(), '  task:3    Due:        NEXT (proposal) Write the report  work', 'point is on its task');
  assert.deepEqual(asked.slice(n).map(x => x.url), ['/v1/agenda?from=2026-11-10&days=7'], 'the agenda is asked for once');
  assert.equal(agenda().modified, false); assert.equal(agenda().readOnly, true);
  // In a window that is not the selected one, while the minibuffer reads: both are left alone.
  const shown = agendaAside();
  await keys('SPC n r f'); await until(() => E.mini, 'the minibuffer');
  const mini = E.mini;
  await followed(() => { change(taskN(3), { state: 'todo', priority: 'B' }); change(taskN(4), { title: 'Read the other paper' }); taskChanged(); });
  assert.equal(lineIn(shown), '  task:3    Due:        TODO [#B] (proposal) Write the report  work', 'the window’s point is on its task');
  assert.ok(body().includes('  task:4    NEXT Read the other paper  ref'));
  assert.equal(E.mini, mini, 'the minibuffer reads on');
  await keys('C-g');
  assert.equal(cur().id, 'host.org', 'and the selected window is the one it was');
  // Changes that come together are one question.
  const m = asked.length;
  await followed(async () => { change(taskN(6), { state: 'next' }); taskChanged(); await until(() => held.size === 1, 'edwind asks again'); change(taskN(6), { priority: 'C' }); taskChanged(); });
  await sleep(600);
  assert.ok(asked.length - m <= 2, `${asked.length - m} questions for two changes`);
  assert.ok(body().includes('  task:6    NEXT [#C] Learn the cello  pub'));
  // The task at point is gone: point stays on its line.
  const at = Ed.lineNoB(agenda(), shown.pt);
  await followed(() => { change(taskN(3), { state: 'cancelled' }); taskChanged(); });
  assert.equal(Ed.lineNoB(agenda(), shown.pt), at);
  Ed.selectWindow(shown); await keys('q');
});

test('edwind follows brain only while an agenda is shown, once for every frame that shows one', async () => {
  await visit('host.org');
  await until(() => held.size === 0, 'no question is held with no agenda in a window');
  // No agenda: edwind asks the feed nothing, whatever changes.
  const f = fed.length;
  taskChanged(); await sleep(1200);
  assert.equal(fed.length, f, 'the feed is not asked');
  // Another client watches, then this frame: one follower, with one place in the feed.
  const cl = new EditClient(dir.cfg.socket); await cl.connect(); assert.equal((await cl.hello()).t, 'welcome');
  assert.equal((await cl.call('brain-tasks-follow', [true])).value, true);
  assert.equal(fed.length, f + 1); assert.equal(fed[f].url, '/v1/changes?after=now');
  await showTasks('a');
  await until(() => held.size === 1, 'edwind asks what changes');
  assert.deepEqual(fed.slice(f).map(x => x.url), ['/v1/changes?after=now', `/v1/changes?after=${feedAt}&kind=task&limit=200&wait=50`]);
  await followed(() => { change(taskN(4), { title: 'Read both papers' }); taskChanged(); });
  assert.deepEqual(await cl.next(x => x.t === 'tasks'), { t: 'tasks' }, 'a watcher is told that tasks changed, and nothing of them');
  // One stops watching: the other is still told, and it is not.
  assert.equal((await cl.call('brain-tasks-follow', [false])).value, false);
  await followed(() => { change(taskN(4), { title: 'Read no paper' }); taskChanged(); });
  assert.ok(body().includes('  task:4    NEXT Read no paper  ref'));
  await until(() => held.size === 1, 'edwind asks again');
  // The agenda leaves its window: the frame stops watching, and edwind drops the question brain holds.
  await keys('q');
  await until(() => held.size === 0, 'the question is dropped');
  const g = fed.length, text = agenda().text;
  change(taskN(4), { title: 'Unseen change' }); taskChanged(); await sleep(1200);
  assert.equal(fed.length, g); assert.equal(agenda().text, text, 'an agenda in no window is left as it is');
  assert.ok(!cl.queue.some(x => x.t === 'tasks'), 'the client that stopped was told nothing more');
  // The last watcher leaves by disconnecting.
  assert.equal((await cl.call('brain-tasks-follow', [true])).value, true);
  await until(() => held.size === 1, 'edwind asks what changes');
  cl.close();
  await until(() => held.size === 0, 'the question is dropped with the connection');
  // An agenda shown some other way than asked for is followed too, and asked for again.
  const w = Ed.windowFor(cur());
  await followed(async () => { await keys('M-x'); await type('switch-to-buffer\n'); await until(() => E.mini && /buffer/i.test(E.mini.prompt), 'the buffer prompt'); await type('*Agenda*\n'); });
  assert.ok(body().includes('  task:4    NEXT Unseen change  ref'));
  // A new connection is a new client to edwind: the frame asks it to follow again, and asks for the agenda.
  const h = fed.length;
  await followed(() => { change(taskN(4), { title: 'Changed while away' }); sync.sock.close(); });
  assert.ok(body().includes('  task:4    NEXT Changed while away  ref'));
  await until(() => held.size === 1, 'edwind asks what changes');
  assert.equal(fed[h].url, '/v1/changes?after=now');
  assert.equal(Ed.windowFor(agenda()), w); await keys('q');
  await until(() => held.size === 0, 'the question is dropped');
});

test('a brain that is away is asked again more and more slowly, and what changed meanwhile is shown when it is back', async () => {
  await showTasks('a');
  await until(() => held.size === 1, 'edwind asks what changes');
  const f = fed.length, warned = () => child.logs.split('\n').filter(l => l.includes('"what":"changes"') && !l.includes('"ms"')).length, w = warned();
  onTask(1);
  const t = Date.now();
  feedIsAway(true);
  change(taskN(1), { priority: 'C' }); feedAt++;
  await until(() => fed.length === f + 1, 'another question');
  feedIsAway(false);
  await followed(() => {});
  assert.equal(lineAt(), '  task:1    3 d. ago:   TODO [#C] Pay the invoice  work');
  const again = fed.slice(f);
  assert.equal(again.length, 2, 'brain was asked twice in all');
  assert.ok(again.every(x => x.url === fed[f - 1].url), 'from the place edwind had: brain has kept what changed');
  const gaps = [again[0].at - t, again[1].at - again[0].at];
  assert.ok(gaps[0] >= 900 && gaps[1] >= 1900, `the wait doubles: ${gaps}`);
  assert.equal(warned(), w + 1, 'the log says once that brain did not answer');
  // The agenda's own question fails: the view is left as it is, takes no change, and that is said once.
  const text = agenda().text, from = messages().length;
  readsFail = true;
  try {
    change(taskN(1), { title: 'Pay both invoices' });
    taskChanged();
    await until(() => agenda().agenda.stale, 'the agenda is known not to show brain’s tasks');
    const q = asked.length;
    taskChanged();
    await until(() => asked.length > q, 'the agenda is asked for again'); await sleep(100);
    assert.equal(agenda().text, text);
    assert.equal(messages().slice(from).split('The agenda could not follow a change in brain (r asks again): brain answered 503').length, 2, 'said once');
    await saying('The agenda does not show the last change: r asks brain again', () => keys('x'));
  } finally { readsFail = false; }
  await followed(() => taskChanged());
  assert.equal(agenda().agenda.stale, false);
  assert.equal(lineAt(), '  task:1    3 d. ago:   TODO [#C] Pay both invoices  work');
  await keys('q');
});

test('an edwind with no brain to read follows nothing, and an agenda there is as it was', async () => {
  const d = makeDir({ brain: { url, credential: 'brain-token' } }), c = await startEdwind(d, { env: { CREDENTIALS_DIRECTORY: makeCreds(d) } });
  try {
    const f = fed.length, cl = new EditClient(d.cfg.socket); await cl.connect(); assert.equal((await cl.hello()).t, 'welcome');
    const m = await cl.call('brain-tasks-follow', [true]);
    assert.equal(m.error.condition, 'brain-unavailable'); assert.match(m.error.report, /no brain to read/);
    assert.equal((await cl.call('brain-tasks-follow', [false])).value, false);
    cl.close(); await sleep(300);
    assert.equal(fed.length, f, 'brain is asked nothing');
  } finally { await stopEdwind(c); fs.rmSync(d.root, { recursive: true, force: true }); }
});

test('nothing typed or looked up reached edwind’s log, and offline the commands say so', async () => {
  assert.ok(!child.logs.includes(TOKEN));
  assert.ok(!child.logs.includes(TASK_TOKEN));
  assert.ok(child.logs.includes('"what":"changes"'), 'the feed is in the log by its name');
  for (const fromFeed of [FEED_TITLE, 'after=', 'wait=', taskN(1).id]) assert.ok(!child.logs.includes(fromFeed), `${fromFeed} is not in the log`);
  for (const typed of ['Brand new idea', 'Other new idea', 'standup', 'meeting', 'First letter', 'deep-id', 'zebra-query-text', 'Buy milk', 'Follow this up', 'Under the section', 'invoice', 'plumber', 'twice', '2026-11-13'])
    assert.ok(!child.logs.includes(typed), `${typed} is not in the log`);
  await visit('host.org');
  await stopEdwind(child);
  await until(() => sync.state !== 'online', 'the connection is seen to be gone');
  const before = asked.length;
  await keys('SPC n r f');
  await until(() => /Not connected to edwind/.test(messages()), 'the refusal');
  assert.equal(E.mini, null); assert.equal(asked.length, before);
});
