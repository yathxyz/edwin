// Image generations and safe mode (server/image.mts): the log can be copied, listed and rolled back, a
// rollback is itself a generation, generations never repeat after one, image-restart exits for the service
// manager, and starts that do not settle put the next one in safe mode (no init.scm, no replay).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild } from './edit-client.mts';

let dir: TestDir, child: EdwindChild;
before(async () => {
  dir = makeDir();
  fs.writeFileSync(path.join(dir.cfg.configDir as string, 'init.scm'), '(define init-ran #t)\n');
  child = await startEdwind(dir);
});
after(async () => { await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

const cli = async () => { const c = new EditClient(dir.cfg.socket as string); await c.connect(); const w = await c.hello({ kind: 'cli', session: 'gen-1' }); assert.equal(w.t, 'welcome'); c.welcome = w; return c; };
const status = async (c: EditClient) => (await c.call('status')).value;
const forms = async (c: EditClient) => (await c.call('image-entries')).value.map((e: Msg) => e.form);
const restart = async (sig: NodeJS.Signals = 'SIGTERM') => { await stopEdwind(child, sig); child = await startEdwind(dir); };

test('image-checkpoint, image-generations and image-rollback: the log goes back to a copy, the log before it is a generation, generations never repeat', async () => {
  const a = await cli();
  await a.form('(define (f1) 1)');
  const g1 = (await a.call('image-checkpoint', ['one'])).value;
  assert.equal(g1.entries, 1); assert.equal(g1.label, 'one'); assert.equal(g1.origin, 'cli:gen-1');
  const same = await a.call('image-checkpoint', []);
  assert.equal(same.value.id, g1.id, 'an unchanged log without a label shares the generation it equals'); assert.match(same.msg, /unchanged/);
  await a.form('(define (f2) 2)'); await a.form('(define (f1) 11)');
  assert.deepEqual(await forms(a), ['(define (f1) 1)', '(define (f2) 2)', '(define (f1) 11)']);
  const epoch0 = (await status(a)).imageEpoch, gen0 = (await status(a)).imageGen;

  const refused = await a.call('image-rollback', [{ id: g1.id }]);
  assert.equal(refused.t, 'error'); assert.equal(refused.code, 'bad_request'); assert.match(refused.msg, /force/);
  const r = (await a.call('image-rollback', [{ id: g1.id, force: true }])).value;
  assert.equal(r.id, g1.id); assert.equal(r.entries, 1); assert.equal(r.restart, false);
  assert.deepEqual(await forms(a), ['(define (f1) 1)']);
  const b = await cli();
  const st = await status(b);
  assert.notEqual(st.imageEpoch, epoch0, 'frames rebuild: a new epoch');
  assert.equal(st.imageGen, gen0, 'the generation counter does not go back');
  const gens = (await b.call('image-generations')).value;
  const pre = gens.find((g: Msg) => g.id === r.before);
  assert.ok(pre && pre.entries === 3 && /before rollback/.test(pre.reason), 'the log before the rollback is a generation');

  /* The next definition takes a new generation number, never one the dropped entries had. */
  await b.form('(define (f3) 3)');
  const es = (await b.call('image-entries')).value;
  assert.equal(es[es.length - 1].gen, gen0 + 1);
  /* Rolling back to the copy undoes the rollback. */
  await b.call('image-rollback', [{ id: r.before, force: true }]);
  const c = await cli();
  assert.deepEqual(await forms(c), ['(define (f1) 1)', '(define (f2) 2)', '(define (f1) 11)']);
  a.close(); b.close(); c.close();
});

test('a restart keeps the generation floor and copies a cleanly replayed log once', async () => {
  let a = await cli();
  const before = await status(a);
  const n = (await a.call('image-generations')).value.length;
  a.close();
  await restart();
  a = await cli();
  const st = await status(a);
  assert.equal(st.imageGen, before.imageGen, 'the floor in the epoch line survives the restart');
  assert.equal((await a.form('(f1)')).value, '11');
  const gens = (await a.call('image-generations')).value;
  assert.equal(gens.length, n, 'the log equals a kept generation (the one rolled back to): no new one');
  await a.form('(define (f4) 4)'); a.close();
  await restart();
  a = await cli();
  const gens2 = (await a.call('image-generations')).value;
  assert.equal(gens2.length, n + 1); assert.equal(gens2[gens2.length - 1].reason, 'start');
  a.close();
});

test('%image-record logs definitions made by the running thread and refuses other forms; %edwin-source reads the shipped tree only', async () => {
  const a = await cli();
  const g = (await status(a)).imageGen;
  const r = await a.form('(begin (define (rec1) 5) (%image-record "(define (rec1) 5)"))');
  assert.equal(r.value, `(${g + 1})`);
  const last = (await a.call('image-entries')).value.pop();
  assert.equal(last.form, '(define (rec1) 5)'); assert.equal(last.by.kind, 'cli');
  const bad = await a.form('(%image-record "(display 1)")');
  assert.match(bad.error.report, /not definitional/);
  assert.equal((await a.form('(%image-record "(display 1)" #t)')).error.condition, 'error');
  assert.equal((await a.form('(%image-record "(define x 1)" #t)')).value, '#t');
  const src = (await a.form('(%edwin-source "edwin/scm/emacs.scm" 1 2)')).value;
  assert.match(src, /^"1: ;;;/);
  assert.match((await a.form('(%edwin-source "../../../etc/passwd" 1 2)')).error.report, /not in the shipped tree/);
  a.close();
});

test('two starts that end before settling put the next in safe mode: no init.scm, no replay, a safe epoch; a clean stop leaves it', async () => {
  let a = await cli();
  assert.equal((await a.form('init-ran')).value, '#t');
  const normalEpoch = (await status(a)).imageEpoch;
  a.close();
  await restart('SIGKILL'); await restart('SIGKILL');
  /* The third start: two before it never settled (SIGKILL inside EDWIND_BOOT_SETTLE_MS). */
  await stopEdwind(child, 'SIGKILL'); child = await startEdwind(dir);
  a = await cli();
  const st = await status(a);
  assert.ok(st.imageSafe, 'status reports safe mode'); assert.match(st.imageSafe.reason, /starts in a row/);
  assert.equal((await a.form("(bound? 'init-ran)")).value, '#f', 'no init.scm');
  assert.equal((await a.form("(bound? 'f1)")).value, '#f', 'no image replay');
  assert.ok((await a.call('image-entries')).value.length > 0, 'the log is kept for repair');
  const f = new EditClient(dir.cfg.socket as string); await f.connect();
  const w = await f.hello({ kind: 'frame' });
  assert.equal(w.imageEpoch, 'safe-' + normalEpoch);
  await f.request({ t: 'image?', from: 0 });
  const msgs = f.queue.filter(m => m.t === 'msg').map(m => m.text);
  assert.ok(msgs.some((t: string) => /safe mode/.test(t)), 'a frame is told');
  assert.ok(!f.queue.some(m => m.t === 'image'), 'a frame gets no entry from before the boot');
  f.close(); a.close();
  await restart(); // SIGTERM: a clean stop settles
  a = await cli();
  assert.ok(!(await status(a)).imageSafe);
  assert.equal((await a.form('init-ran')).value, '#t');
  assert.equal((await a.form('(f1)')).value, '11');
  a.close();
});

test('image-restart needs {force: true} and exits with 75 for the service manager', async () => {
  const a = await cli();
  const refused = await a.call('image-restart', []);
  assert.equal(refused.code, 'bad_request'); assert.match(refused.msg, /force/);
  const exited = new Promise<number | null>(r => child.once('exit', code => r(code)));
  const r = await a.call('image-restart', [{ force: true }]);
  assert.equal(r.value.exit, 75);
  assert.equal(await exited, 75);
  child = await startEdwind(dir);
  const b = await cli();
  assert.ok(!(await status(b)).imageSafe, 'a restart is a clean stop: no safe mode');
  b.close();
});
