// Ed.proc (src/proc.ts): child processes for the core's TypeScript. A served frame on the Node host, attached to a
// real edwind, with the desktop program's host.proc stood in by fake-proc.mts (real programs from PATH): run gives
// the output, error and exit status; spawn streams, takes input and is killed; the refusals in a web frame, where
// no host gives processes (edwind's Node host), and while the image replays (R16.15), through the image edwind
// sends and edwind's init.scm.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHost, loadEdwin, memoryStorage } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
import type { TestDir, EdwindChild } from './edit-client.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

let dir: TestDir, child: EdwindChild, Ed: Edwin, L: Edwin, sync: Edwin, cli: EditClient;
const proc = fakeProc();
/* What the frame-side procedures below saw, in order: [tag, 'ran', output] or [tag, 'refused', report]. */
const seen: [string, string, string][] = [];
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 10)); } };
const turn = () => new Promise(r => setTimeout(r, 5));

/* Frame-side procedures a replayed form can call, as a command of compile or git would be called: one starts its
   child at once, one after awaits that settle in the same turn. No Scheme primitive of Edwin's reaches Ed.proc. */
function defineProbes() {
  const record = (tag: string, p: () => Promise<{ out: string }>) => p().then(r => { seen.push([tag, 'ran', r.out]); }, e => { seen.push([tag, 'refused', Ed.errorText(e)]); });
  L.D('proc-probe-now', 'TAG', 'Run echo TAG at once.', ([tag]: unknown[]) => { record(String(tag), () => { try { return Ed.proc.run(['echo', String(tag)]); } catch (e) { return Promise.reject(e); } }); return false; });
  L.D('proc-probe-later', 'TAG', 'Run echo TAG after two awaits.', ([tag]: unknown[]) => { record(String(tag), async () => { await null; await Promise.resolve(); return Ed.proc.run(['echo', String(tag)]); }); return false; });
}

before(async () => {
  dir = makeDir();
  fs.writeFileSync(path.join(dir.dirs.config, 'init.scm'), '(on-frames (proc-probe-now "from-init"))\n');
  child = await startEdwind(dir);
  const host = createHost({ storage: memoryStorage(), workers: false }) as NodeHost & { proc?: FakeProc };
  host.proc = proc;
  Ed = loadEdwin(host); L = (globalThis as unknown as { L: Edwin }).L;
  defineProbes();
  sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'proc-test' });
  await Ed.whenIdle();
  cli = new EditClient(dir.cfg.socket); await cli.connect(); await cli.hello();
});
after(async () => {
  for (const id of proc.running()) proc.kill(id, 'KILL');   // none, unless a test failed before its kill
  if (cli) cli.close(); if (sync) sync.shutdown(); if (child) await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

test('run returns the output, the error and the exit status; the argv is never a shell line', async () => {
  assert.equal(Ed.proc.available(), true);
  const r = await Ed.proc.run(['sh', '-c', 'cat; echo "to error" >&2; exit 3'], { input: 'given\n' });
  assert.equal(r.out, 'given\n'); assert.equal(r.err, 'to error\n');
  assert.equal(r.code, 3); assert.equal(r.signal, null); assert.equal(r.timedOut, false); assert.equal(r.truncated, false);
  const ok = await Ed.proc.run(['echo', '$HOME; touch x', '`id`']);
  assert.equal(ok.out, '$HOME; touch x `id`\n'); assert.equal(ok.code, 0);
  const merged = await Ed.proc.run(['sh', '-c', 'echo a; echo b >&2'], { merge: true, cwd: dir.root, env: { X: 'y' } });
  assert.equal(merged.out.split('\n').sort().join(' ').trim(), 'a b'); assert.equal(merged.err, '');
  const last = proc.calls[proc.calls.length - 1];
  assert.deepEqual(last.argv, ['sh', '-c', 'echo a; echo b >&2']);
  assert.equal(last.opts.cwd, dir.root); assert.deepEqual(last.opts.env, { X: 'y' }); assert.equal(last.opts.merge, true);
  assert.equal(last.opts.maxBytes, 16 * 1024 * 1024, 'run bounds what it keeps');
  const timed = await Ed.proc.run(['sleep', '10'], { timeout: 100 });
  assert.equal(timed.timedOut, true); assert.equal(timed.signal, 'TERM'); assert.equal(timed.code, null);
});

test('spawn streams the output as it comes, takes input, and is killed', async () => {
  const out: string[] = [];
  const p = Ed.proc.spawn(['cat'], { onOut: (s: string) => out.push(s) });
  assert.deepEqual(p.argv, ['cat']);
  assert.equal(p.write('one\n'), true);
  await until(() => out.join('') === 'one\n', 'the first line back');
  assert.ok(proc.running().includes(p.id));
  assert.equal(p.kill(), true);
  const x = await p.exit;
  assert.equal(x.signal, 'TERM'); assert.equal(x.code, null);
  assert.equal(p.kill(), false, 'an ended child takes no signal');
  assert.equal(proc.running().includes(p.id), false);
  const q = Ed.proc.spawn(['cat'], { onOut: (s: string) => out.push(s) });
  q.write('two\n'); q.closeStdin();
  assert.equal((await q.exit).code, 0);
  assert.equal(out.join(''), 'one\ntwo\n');
});

test('a program that cannot run and an argv that is no argv signal process-error', async () => {
  const isProcErr = (e: unknown) => L.S.conditionIs(e, 'process-error');
  assert.throws(() => Ed.proc.spawn(['edwin-no-such-program-here']), (e: unknown) => isProcErr(e) && /cannot run edwin-no-such-program-here: No such file or directory/.test(Ed.errorText(e)));
  await assert.rejects(Ed.proc.run(['true'], { cwd: path.join(dir.root, 'not-there') }), isProcErr);
  for (const bad of [[], [''], 'echo hi', ['echo', 1], null]) assert.throws(() => Ed.proc.spawn(bad), isProcErr, JSON.stringify(bad));
  /* the error is a Scheme condition, which Scheme can catch */
  assert.equal(L.S.conditionType('process-error').isa('error'), true);
});

test('envFor gives no changes yet, and refuses where spawn does', async () => {
  assert.deepEqual(await Ed.proc.envFor(dir.root), {});
  await assert.rejects(Ed.proc.envFor(''), (e: unknown) => L.S.conditionIs(e, 'process-error'));
});

test('no process in a web frame, nor where the host gives none (edwind\'s Node host)', async () => {
  const before = proc.calls.length;
  const host = Ed.host;
  const refused = async (why: RegExp) => {
    assert.equal(Ed.proc.available(), false);
    const check = (e: unknown) => L.S.conditionIs(e, 'process-error') && why.test(Ed.errorText(e));
    assert.throws(() => Ed.proc.spawn(['echo', 'x']), check);
    await assert.rejects(Ed.proc.run(['echo', 'x']), check);
    await assert.rejects(Ed.proc.envFor(dir.root), check);
  };
  host.kind = 'browser';
  try { await refused(/web frame/); } finally { host.kind = 'node'; }
  delete host.proc;
  try { await refused(/only the desktop program/); } finally { host.proc = proc; }
  assert.equal(proc.calls.length, before, 'nothing was spawned');
  assert.equal(Ed.proc.available(), true);
});

test('R16.15: a replayed image starts no process, at once or after an await; the same call outside it does', async () => {
  /* edwind's init.scm ran in the frame at boot, as the image does: refused. */
  await until(() => seen.some(s => s[0] === 'from-init'), 'the init.scm probe');
  assert.deepEqual(seen.find(s => s[0] === 'from-init'), ['from-init', 'refused', 'process-error: No process starts while the image replays']);
  const before = proc.calls.length;
  for (const form of ['(on-frames (proc-probe-now "image-now"))', '(on-frames (proc-probe-later "image-later"))', '(define proc-probe-value (on-frames (proc-probe-now "image-define")))']) {
    const r = await cli.form(form);
    assert.equal(r.t, 'result', JSON.stringify(r));
  }
  await until(() => ['image-now', 'image-later', 'image-define'].every(t => seen.some(s => s[0] === t)), 'the replayed probes');
  for (const t of ['image-now', 'image-later', 'image-define']) assert.deepEqual(seen.find(s => s[0] === t), [t, 'refused', 'process-error: No process starts while the image replays'], t);
  assert.equal(proc.calls.length, before, 'the replay spawned nothing');
  /* Once the replay's turn is over, the same procedures are the user's: they run. */
  await turn();
  assert.equal(Ed.proc.available(), true);
  L.evalText('(proc-probe-now "typed-now")'); L.evalText('(proc-probe-later "typed-later")');
  await until(() => seen.filter(s => s[0].startsWith('typed-')).length === 2, 'the typed probes');
  assert.deepEqual(seen.find(s => s[0] === 'typed-now'), ['typed-now', 'ran', 'typed-now\n']);
  assert.deepEqual(seen.find(s => s[0] === 'typed-later'), ['typed-later', 'ran', 'typed-later\n']);
  assert.equal(proc.calls.length, before + 2);
});
