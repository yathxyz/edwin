// The note projector (server/projector.mts) against a real edwind and a loopback stand-in for brain: one record
// per note file with the ids, titles and link names it holds and none of its text; only saved text; a file that
// goes sends an empty record; a failed request is retried and a refused one waits for the file to change; the
// ledger survives a restart; one failing file does not hold up the rest; a file the index leaves out and an
// empty notes directory delete nothing; plain http goes only to this host; the token is sent and never logged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { TestDir, EdwindChild } from './edit-client.mts';

const TOKEN = 'projector-token-for-the-tests-0123456789';
const ENV = { EDWIND_PROJECTOR_SETTLE_MS: '50', EDWIND_PROJECTOR_RETRY_MS: '50' };
interface Sent { path: string; scope: string; notes: Record<string, unknown>[] }
const sent: Sent[] = [];
/* What brain answers the next requests with: a status (with brain's JSON error when it is one), or a status and
   a body; 200 once they run out. A path in `broken` always gets 500. */
const answers: (number | [number, string])[] = [];
const broken = new Set<string>();
let auth: (string | undefined)[] = [];
const brain = http.createServer((req, res) => {
  let text = '';
  req.setEncoding('utf8'); req.on('data', d => { text += d; });
  req.on('end', () => {
    assert.equal(`${req.method} ${req.url}`, 'POST /v1/projection');
    const record = JSON.parse(text);
    auth.push(req.headers.authorization); sent.push(record);
    const next = broken.has(record.path) ? 500 : answers.shift() ?? 200;
    const [status, body] = typeof next === 'number' ? [next, next < 300 ? '{}' : '{"error":"no"}'] : next;
    res.writeHead(status); res.end(body);
  });
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/* The records sent for FILE so far, once there are N of them. */
const records = async (file: string, n: number): Promise<Sent[]> => {
  const t = Date.now();
  for (;;) { const got = sent.filter(s => s.path === file); if (got.length >= n) return got; if (Date.now() - t > 20000) throw new Error(`${file}: ${got.length} of ${n} records; ${child.logs}`); await sleep(20); }
};

const ALPHA = `:PROPERTIES:
:ID:       a-file
:ROAM_ALIASES: Alpha "Second name"
:END:
#+title: Alpha note
#+filetags: :one:two:

The text of the note, with [[id:b-file][B]], [[https://example.org][the web]] and [[file:plain.org][a file]].

* Section                                                        :sec:
:PROPERTIES:
:ID:       a-section
:END:
A link to [[task:12]].
** Deeper, without an id
[[id:b-file::*Part]] and [[id:b-file::*Part]] once more.
* Loose end
[[id:c-file]] is the file's.
** A copy of the section
:PROPERTIES:
:ID:       a-section
:END:
[[attachment:fig.png]]
`;
const ALPHA_NOTES = [
  { id: 'a-file', title: 'Alpha note', aliases: ['Alpha', 'Second name'], tags: ['one', 'two'], links: ['id:b-file', 'id:c-file'] },
  { id: 'a-section', title: 'Section', tags: ['sec'], parent: 'a-file', links: ['task:12', 'id:b-file::*Part', 'attachment:fig.png'] },
];

let dir: TestDir, child: EdwindChild, creds: string, url: string;
const note = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir.dirs.notes, p)), { recursive: true }); fs.writeFileSync(path.join(dir.dirs.notes, p), text); };
const withId = (id: string, title: string, more = '') => `:PROPERTIES:\n:ID: ${id}\n:END:\n#+title: ${title}\n${more}`;

before(async () => {
  url = await new Promise<string>(r => brain.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(brain.address() as AddressInfo).port}`)));
  dir = makeDir({ brain: { url, credential: 'brain-token' } });
  creds = path.join(dir.root, 'creds');
  fs.mkdirSync(creds, { mode: 0o700 });
  fs.writeFileSync(path.join(creds, 'brain-token'), TOKEN + '\n', { mode: 0o400 });
  note('alpha.org', ALPHA);
  note('journal/2026-11-10.org', '* Morning\nNo ids here, only [[id:a-file]].\n');
  note('area/scoped.org', withId('s-file', 'Scoped', '#+brain_scope: work.notes\n'));
  note('alpha.sync-conflict-20261110-101010-ABCDEFG.org', ALPHA);
  child = await startEdwind(dir, { env: { CREDENTIALS_DIRECTORY: creds, ...ENV } });
});
after(async () => { await stopEdwind(child); brain.close(); brain.closeAllConnections(); fs.rmSync(dir.root, { recursive: true, force: true }); });

test('at start every note file is sent once: ids, titles, aliases, tags and link names, never text', async () => {
  const [alpha] = await records('alpha.org', 1);
  assert.deepEqual(alpha, { path: 'alpha.org', scope: 'self', notes: ALPHA_NOTES });
  assert.deepEqual(await records('journal/2026-11-10.org', 1), [{ path: 'journal/2026-11-10.org', scope: 'self', notes: [] }], 'a file without ids is an empty record');
  assert.deepEqual(await records('area/scoped.org', 1), [{ path: 'area/scoped.org', scope: 'work.notes', notes: [{ id: 's-file', title: 'Scoped' }] }]);
  await sleep(300);
  assert.equal(sent.length, 3, 'once each, and no copy of a sync conflict');
  assert.ok(auth.every(a => a === `Bearer ${TOKEN}`));
  assert.ok(!JSON.stringify(sent).includes('The text of the note'));
});

test('an edit is projected when it is saved, not before', async () => {
  const c = new EditClient(dir.cfg.socket); await c.connect(); assert.equal((await c.hello()).t, 'welcome');
  const o = await c.open('alpha.org');
  const ack = await c.edit('alpha.org', o.ver!, [[o.text!.length, '', '[[id:d-file]]\n']]);
  assert.equal(ack.t, 'ack', JSON.stringify(ack));
  await sleep(700);
  assert.equal(sent.filter(s => s.path === 'alpha.org').length, 1, 'unsaved text stays here');
  assert.equal((await c.request({ t: 'save', buf: 'alpha.org' })).t, 'result');
  const [, saved] = await records('alpha.org', 2);
  assert.deepEqual(saved.notes[1].links, ['task:12', 'id:b-file::*Part', 'attachment:fig.png', 'id:d-file']);
  c.close();
});

test('a file that goes sends an empty record; a renamed one is sent under its new path', async () => {
  fs.renameSync(path.join(dir.dirs.notes, 'area/scoped.org'), path.join(dir.dirs.notes, 'area/moved.org'));
  assert.deepEqual((await records('area/moved.org', 1))[0].notes, [{ id: 's-file', title: 'Scoped' }]);
  assert.deepEqual((await records('area/scoped.org', 2))[1], { path: 'area/scoped.org', scope: 'self', notes: [] });
});

test('a failed request is retried; a refused record waits for the file to change', async () => {
  answers.push(500, 401);
  note('retry.org', withId('r-file', 'Retried'));
  const tries = await records('retry.org', 3);
  assert.deepEqual(tries[0], tries[2]);
  answers.push(400);
  note('refused.org', withId('x-file', 'Refused'));
  await records('refused.org', 1);
  await sleep(500);
  assert.equal(sent.filter(s => s.path === 'refused.org').length, 1, 'not sent again as it is');
  note('refused.org', withId('x-file', 'Refused, then changed'));
  assert.equal((await records('refused.org', 2))[1].notes[0].title, 'Refused, then changed');
});

test('after a restart only what changed meanwhile is sent; the token is in no log and not in the ledger', async () => {
  await stopEdwind(child);
  const before = sent.length;
  note('retry.org', withId('r-file', 'Changed while edwind was down'));
  fs.rmSync(path.join(dir.dirs.notes, 'refused.org'));
  child = await startEdwind(dir, { env: { CREDENTIALS_DIRECTORY: creds, ...ENV } });
  assert.equal((await records('retry.org', 4))[3].notes[0].title, 'Changed while edwind was down');
  assert.deepEqual((await records('refused.org', 3))[2].notes, []);
  await sleep(400);
  assert.equal(sent.length, before + 2);
  const ledger = fs.readFileSync(path.join(dir.dirs.state, 'projector.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(ledger).files).sort(), ['alpha.org', 'area/moved.org', 'journal/2026-11-10.org', 'retry.org']);
  assert.ok(!ledger.includes(TOKEN) && !child.logs.includes(TOKEN));
});

test('only brain\'s own refusal parks a record; one file it cannot take does not hold up the rest', async () => {
  /* What Python's http.server says of a request line it cannot read. */
  answers.push([400, '<html><body>Bad request syntax</body></html>']);
  note('page.org', withId('p-file', 'Answered with a page'));
  assert.deepEqual((await records('page.org', 2))[1].notes, [{ id: 'p-file', title: 'Answered with a page' }]);
  broken.add('stuck.org');
  note('stuck.org', withId('k-file', 'Stuck'));
  await records('stuck.org', 1);
  note('zz-after.org', withId('z-file', 'After'));
  await records('zz-after.org', 1);
  const tries = (await records('stuck.org', 3)).length;
  broken.delete('stuck.org');
  await records('stuck.org', tries + 1);
  await sleep(300);
  assert.equal(sent.filter(s => s.path === 'stuck.org').length, tries + 1, 'taken, and not sent again');
});

test('a file the index leaves out is not a deleted one; an empty notes directory deletes nothing', async () => {
  note('big.org', withId('g-file', 'Big'));
  await records('big.org', 1);
  /* Over the index's 4 MiB limit: the index drops it, and brain keeps what it was told. */
  note('big.org', withId('g-file', 'Big', 'x'.repeat(4 * 1024 * 1024 + 1)));
  const c = new EditClient(dir.cfg.socket); await c.connect(); assert.equal((await c.hello()).t, 'welcome');
  const t = Date.now();
  for (;;) {
    const rid = c.newRid();
    c.send({ t: 'call', cmd: 'notes-nodes', args: [{ limit: 1000 }], ctx: {}, rid });
    const r = await c.next(m => m.rid === rid && (m.t === 'result' || m.t === 'error'), 10000);
    assert.equal(r.t, 'result', JSON.stringify(r));
    if (!JSON.stringify(r.value).includes('g-file')) break;
    if (Date.now() - t > 20000) throw new Error('big.org is still indexed');
    await sleep(50);
  }
  c.close();
  await sleep(400);
  assert.equal(sent.filter(s => s.path === 'big.org').length, 1, 'still on disk: nothing sent');
  /* Gone for good: seen at the next pass, which any change to the index starts. */
  fs.rmSync(path.join(dir.dirs.notes, 'big.org'));
  note('nudge.org', withId('u-file', 'Nudge'));
  assert.deepEqual((await records('big.org', 2))[1].notes, []);

  const d = makeDir({ brain: { url, credential: 'brain-token' } });
  fs.writeFileSync(path.join(d.dirs.notes, 'only.org'), withId('o-file', 'The only note'));
  let e = await startEdwind(d, { env: { CREDENTIALS_DIRECTORY: creds, ...ENV } });
  await records('only.org', 1);
  await stopEdwind(e);
  fs.rmSync(path.join(d.dirs.notes, 'only.org'));
  e = await startEdwind(d, { env: { CREDENTIALS_DIRECTORY: creds, ...ENV } });
  await sleep(600);
  assert.equal(sent.filter(s => s.path === 'only.org').length, 1, 'an empty directory is taken for a failed mount');
  await stopEdwind(e);
  fs.rmSync(d.root, { recursive: true, force: true });
});

test('plain http goes only to this host; a brain credential is not one Scheme can name', async () => {
  const d = makeDir({ brain: { url: 'http://192.0.2.1:7676', credential: 'brain-token' } });
  fs.writeFileSync(path.join(d.dirs.notes, 'n.org'), withId('n-file', 'Nowhere'));
  const e = await startEdwind(d, { env: { CREDENTIALS_DIRECTORY: creds, ...ENV } });
  const t = Date.now();
  while (!e.logs.includes('is not an address of it')) { if (Date.now() - t > 20000) throw new Error(e.logs); await sleep(20); }
  await stopEdwind(e);
  fs.rmSync(d.root, { recursive: true, force: true });
  const { loadConfig } = await import('../server/main.mts');
  for (const [brainCfg, why] of [
    [{ url, credential: 'spare' }, /also a models credential/],
    [{ url: 'ftp://brain.example', credential: 'brain-token' }, /http or https/],
    [{ url, credential: 'brain-token', scope: 'everywhere' }, /brain scope/],
    [{ url, credential: 'brain-token', extra: 1 }, /unknown field/],
  ] as const) {
    const bad = makeDir({ brain: brainCfg, models: { credentials: { spare: { origin: 'https://example.invalid' } } } });
    assert.throws(() => loadConfig(bad.file), why);
    fs.rmSync(bad.root, { recursive: true, force: true });
  }
});
