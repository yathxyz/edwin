// Nodes from brain (src/brain.ts, server/brain.mts) in a served Edwin against a real edwind and a loopback
// stand-in for brain: edwind sends the read token and logs neither it nor what was asked; brain's refusal and
// an edwind with no brain to read are told apart; brain-node-find names nodes as they are typed and opens a
// note as its file and anything else as a record; brain-node-insert links by id: or brain:, in Org and
// Markdown, and makes the note a new title names; brain-backlinks follows point; id: and title links find
// what only brain knows; a daily is made on disk through edwind.
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

const TOKEN = 'brain-read-token-for-the-tests-0123456789';
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
  const n = NODES.find(x => x.id === ref || (x.org_id && 'org-id:' + x.org_id === ref));
  if (!n) return null;
  return { id: n.id, kind: n.kind, title: n.title, body: n.body ?? null, props: n.kind === 'note' ? { sources: [n.path] } : n.props ?? {}, scope: n.scope, trust: 'owner', updated_at: '2026-11-10T10:00:00Z',
    identifiers: n.org_id ? [{ scheme: 'org-id', value: n.org_id }] : [],
    links: (n.links || []).map(([rel, to], i) => ({ rel, forward: rel !== 'linked from', edge_id: `e${i}`, id: to, kind: byId(to).kind, title: byId(to).title, scope: byId(to).scope })) };
}
const asked: { url: string; auth: string | undefined }[] = [];
const brain = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const u = new URL(req.url!, 'http://brain');
    asked.push({ url: req.url!, auth: req.headers.authorization });
    const send = (status: number, body: unknown, ms = 0) => setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }, ms);
    if (req.method !== 'GET') return send(200, {});
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
const makeCreds = (d: TestDir) => { const c = path.join(d.root, 'creds'); fs.mkdirSync(c, { mode: 0o700 }); for (const n of ['brain-token', 'brain-read-token']) fs.writeFileSync(path.join(c, n), TOKEN + '\n', { mode: 0o400 }); return c; };

before(async () => {
  url = await new Promise<string>(r => brain.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(brain.address() as AddressInfo).port}`)));
  dir = makeDir({ brain: { url, readCredential: 'brain-read-token' }, logLevel: 'debug' });
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

test('nothing typed or looked up reached edwind’s log, and offline the commands say so', async () => {
  assert.ok(!child.logs.includes(TOKEN));
  for (const typed of ['Brand new idea', 'Other new idea', 'standup', 'meeting', 'First letter', 'deep-id', 'zebra-query-text']) assert.ok(!child.logs.includes(typed), `${typed} is not in the log`);
  await visit('host.org');
  await stopEdwind(child);
  await until(() => sync.state !== 'online', 'the connection is seen to be gone');
  const before = asked.length;
  await keys('SPC n r f');
  await until(() => /Not connected to edwind/.test(messages()), 'the refusal');
  assert.equal(E.mini, null); assert.equal(asked.length, before);
});
