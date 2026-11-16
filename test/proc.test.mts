// Ed.proc (src/proc.ts): child processes for the core's TypeScript. A served frame on the Node host, attached to a
// real edwind, with the desktop program's host.proc stood in by fake-proc.mts (real programs from PATH): run gives
// the output, error and exit status; spawn streams, takes input and is killed; the refusals in a web frame, where
// no host gives processes (edwind's Node host), and while the image replays (R16.15), through the image edwind
// sends and edwind's init.scm; envFor asking a stand-in direnv, and the real one for a blocked .envrc.
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

/* A stand-in direnv, first on PATH for the whole suite: `export json` only (anything else exits 2). The nearest
   .envrc from its directory up decides: none prints nothing; allowed (a .envrc.allowed marker beside it) prints
   its directory's bin first on PATH, a variable of its own and an unset; garbage (.envrc.garbage) prints no JSON;
   failing (.envrc.failing) is the .envrc's own error output with no direnv error line, exit 1; else it is blocked,
   as direnv 2.38 says it: its DIRENV_ variables on the output, the error in colour, exit 1. A .envrc.slow beside
   it holds how many milliseconds it takes first, as nix-direnv building a shell does. */
const FAKE_DIRENV = `#!${process.execPath}
const fs = require('fs'), path = require('path');
if (process.argv.slice(2).join(' ') !== 'export json') { process.stderr.write('fake direnv: only export json\\n'); process.exit(2); }
let d = process.cwd(), rc = null;
for (;;) { if (fs.existsSync(path.join(d, '.envrc'))) { rc = path.join(d, '.envrc'); break; } const up = path.dirname(d); if (up === d) break; d = up; }
if (!rc) process.exit(0);
const slow = fs.existsSync(rc + '.slow') ? Number(fs.readFileSync(rc + '.slow', 'utf8')) : 0;
setTimeout(() => answer(rc, d), slow);
function answer(rc, d) {
if (fs.existsSync(rc + '.failing')) { process.stderr.write('direnv: loading ' + rc + '\\nTOKEN=from-the-envrc\\n'); process.exit(1); }
if (fs.existsSync(rc + '.garbage')) { process.stdout.write('not json'); process.exit(0); }
if (fs.existsSync(rc + '.allowed')) {
  process.stdout.write(JSON.stringify({ PATH: path.join(d, 'bin') + ':' + process.env.PATH, FROM_ENVRC: fs.readFileSync(rc, 'utf8').trim(), PROC_TEST_UNSET: null, DIRENV_FILE: rc }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ DIRENV_DIR: '-' + d, DIRENV_FILE: rc }));
process.stderr.write('\\x1b[31mdirenv: error ' + rc + ' is blocked. Run \\x60direnv allow\\x60 to approve its content\\x1b[0m');
process.exit(1);
}
`;
let realPath = '';

before(async () => {
  dir = makeDir();
  realPath = process.env.PATH || '';
  const bin = path.join(dir.root, 'fake-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'direnv'), FAKE_DIRENV); fs.chmodSync(path.join(bin, 'direnv'), 0o755);
  process.env.PATH = bin + ':' + realPath;
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

/* The host's files where they matter to envFor: the true name and the stamp of a file, null when there is none. */
const withFiles = async (fn: () => Promise<void>) => {
  const host = Ed.host;
  host.files = { cwd: dir.root, resolve: (p: string) => path.resolve(dir.root, p), exists: (p: string) => fs.existsSync(p),
    stamp: (p: string) => { try { const s = fs.statSync(p); return s.isFile() ? `${s.ino}:${s.mtimeMs}:${s.size}` : null; } catch { return null; } } };
  try { await fn(); } finally { delete host.files; }
};
const direnvCalls = () => proc.calls.filter(c => c.argv[0] === 'direnv');
/* A project under ROOT/NAME: its .envrc, a program only its bin has, and a directory below it. */
function project(name: string, allowed: boolean) {
  const p = path.join(dir.root, name);
  fs.mkdirSync(path.join(p, 'bin'), { recursive: true }); fs.mkdirSync(path.join(p, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(p, '.envrc'), `PATH_add bin # ${name}\n`);
  if (allowed) fs.writeFileSync(path.join(p, '.envrc.allowed'), '');
  const tool = path.join(p, 'bin', `only-in-${name}`);
  fs.writeFileSync(tool, `#!${process.execPath}\nprocess.stdout.write('ran from ' + ${JSON.stringify(name)} + ' ' + process.env.FROM_ENVRC + '\\n');\n`); fs.chmodSync(tool, 0o755);
  return { root: p, deep: path.join(p, 'src', 'deep'), tool: `only-in-${name}` };
}

test('envFor: an allowed .envrc changes PATH for a child, in compile as well; nothing above, no direnv run', async () => {
  await withFiles(async () => {
    const n = direnvCalls().length;
    const lone = path.join(dir.root, 'lone'); fs.mkdirSync(lone);
    assert.deepEqual(await Ed.proc.envFor(lone), {}, 'no .envrc from here up');
    assert.equal(direnvCalls().length, n, 'and direnv is not asked');
    const p = project('allowed', true);
    const env = await Ed.proc.envFor(p.deep);
    assert.equal(env.PATH, path.join(p.root, 'bin') + ':' + process.env.PATH);
    assert.equal(env.FROM_ENVRC, 'PATH_add bin # allowed'); assert.equal(env.PROC_TEST_UNSET, null);
    const call = direnvCalls()[n];
    assert.deepEqual(call.argv, ['direnv', 'export', 'json'], 'only ever export json: never allow');
    assert.equal(call.opts.cwd, p.deep);
    const r = await Ed.proc.run([p.tool], { cwd: p.deep, env });
    assert.equal(r.out, 'ran from allowed PATH_add bin # allowed\n');
    assert.throws(() => Ed.proc.spawn([p.tool], { cwd: p.deep }), (e: unknown) => L.S.conditionIs(e, 'process-error'), 'not on the plain PATH');
    /* compile asks envFor for its directory: the program on the .envrc's PATH runs */
    const c = await Ed.compile.start(p.tool, p.deep);
    assert.equal((await c.exit).code, 0);
    assert.match(c.buffer.text, /ran from allowed PATH_add bin # allowed\n/);
    assert.equal(direnvCalls().length, n + 1, 'compile was given the kept environment');
  });
});

test('envFor keeps a directory\'s environment until its .envrc changes; two asks at once run direnv once', async () => {
  await withFiles(async () => {
    const p = project('kept', true);
    const n = direnvCalls().length;
    const [a, b] = await Promise.all([Ed.proc.envFor(p.deep), Ed.proc.envFor(p.deep)]);
    assert.deepEqual(a, b); assert.equal(direnvCalls().length, n + 1, 'one direnv for both');
    a.PATH = 'changed by a caller';
    assert.equal((await Ed.proc.envFor(p.deep)).FROM_ENVRC, 'PATH_add bin # kept');
    assert.notEqual((await Ed.proc.envFor(p.deep)).PATH, 'changed by a caller', 'each caller gets its own copy');
    assert.equal(direnvCalls().length, n + 1, 'kept');
    await Ed.proc.envFor(p.root);
    assert.equal(direnvCalls().length, n + 2, 'another directory is asked of its own');
    fs.writeFileSync(path.join(p.root, '.envrc'), 'PATH_add bin # kept, edited\n');
    const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(p.root, '.envrc'), later, later);
    assert.equal((await Ed.proc.envFor(p.deep)).FROM_ENVRC, 'PATH_add bin # kept, edited');
    assert.equal(direnvCalls().length, n + 3, 'a changed .envrc is asked again');
  });
});

test('envFor: a blocked .envrc is said and gives the plain environment, and is asked again once allowed', async () => {
  await withFiles(async () => {
    const p = project('blocked', false);
    const n = direnvCalls().length;
    Ed.message('');
    assert.deepEqual(await Ed.proc.envFor(p.deep), {}, 'not even direnv\'s own variables');
    assert.equal(Ed.E.echo, `direnv: error ${path.join(p.root, '.envrc')} is blocked. Run \`direnv allow\` to approve its content; the plain environment is used`);
    const c = await Ed.compile.start(p.tool, p.deep);
    assert.notEqual((await c.exit).code, 0, 'the program on the .envrc\'s PATH is not found');
    assert.equal(direnvCalls().length, n + 2, 'compile asked again: nothing blocked is kept');
    /* the user allows it in a shell, the .envrc as it was */
    fs.writeFileSync(path.join(p.root, '.envrc.allowed'), '');
    assert.equal((await Ed.proc.envFor(p.deep)).FROM_ENVRC, 'PATH_add bin # blocked');
    fs.writeFileSync(path.join(p.root, '.envrc.garbage'), '');
    fs.writeFileSync(path.join(p.root, '.envrc'), 'PATH_add bin # garbage\n');
    const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(p.root, '.envrc'), later, later);
    assert.deepEqual(await Ed.proc.envFor(p.deep), {});
    assert.equal(Ed.E.echo, 'direnv gave no environment Edwin can read; the plain environment is used');
    assert.ok(direnvCalls().every(c => c.argv.join(' ') === 'direnv export json'));
  });
});

test('envFor: no direnv on PATH gives the plain environment; it refuses where spawn does, the replay above all', async () => {
  await withFiles(async () => {
    const p = project('nodirenv', true);
    const saved = process.env.PATH;
    process.env.PATH = realPath.split(':').filter(d => !fs.existsSync(path.join(d, 'direnv'))).join(':');
    try { assert.deepEqual(await Ed.proc.envFor(p.deep), {}); } finally { process.env.PATH = saved; }
    await assert.rejects(Ed.proc.envFor(''), (e: unknown) => L.S.conditionIs(e, 'process-error'));
    const n = proc.calls.length;
    await assert.rejects(Ed.proc.replay(() => Ed.proc.envFor(p.deep)), (e: unknown) => L.S.conditionIs(e, 'process-error') && /while the image replays/.test(Ed.errorText(e)));
    assert.equal(proc.calls.length, n, 'no direnv while the image replays');
    await turn();
  });
});

test('envFor with the real direnv: a blocked .envrc reports and gives the plain environment', async (t) => {
  const real = realPath.split(':').find(d => d && fs.existsSync(path.join(d, 'direnv')));
  if (!real) { t.skip('no direnv on PATH'); return; }
  await withFiles(async () => {
    /* the stand-in would take the marker as allowed: the real direnv does not */
    const p = project('real', true);
    fs.writeFileSync(path.join(p.root, '.envrc'), `touch ${JSON.stringify(path.join(p.root, 'ran'))}\nexport FROM_ENVRC=yes\n`);
    /* a throwaway HOME and XDG directories: direnv's allow list is the suite's own, and empty */
    const saved = { ...process.env };
    const home = path.join(dir.root, 'direnv-home');
    Object.assign(process.env, { PATH: realPath, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache') });
    try {
      assert.deepEqual(await Ed.proc.envFor(p.deep), {});
      assert.equal(Ed.E.echo, `direnv: error ${path.join(p.root, '.envrc')} is blocked. Run \`direnv allow\` to approve its content; the plain environment is used`);
      assert.equal(fs.existsSync(path.join(p.root, 'ran')), false, 'the blocked .envrc did not run');
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  });
});

/* Every direnv spawned while FN runs is given TIMEOUT ms instead of the 120 s envFor asks, so a timeout is seen. */
async function direnvTimeout(timeout: number, fn: (asked: number[]) => Promise<void>) {
  const spawn = proc.spawn, asked: number[] = [];
  proc.spawn = (argv, opts, on) => { if (argv[0] === 'direnv' && opts.timeout) { asked.push(opts.timeout); opts = { ...opts, timeout }; } return spawn(argv, opts, on); };
  try { await fn(asked); } finally { proc.spawn = spawn; }
}
const direnvRunning = () => direnvCalls().filter(c => proc.running().includes(c.id));

test('envFor: a load past a second says it loads, and the note goes when it is done; one past the timeout is said, killed and not kept', async () => {
  await withFiles(async () => {
    const p = project('slow', true), rc = path.join(p.root, '.envrc');
    fs.writeFileSync(rc + '.slow', '1600');
    Ed.message('');
    const n = direnvCalls().length;
    const env = Ed.proc.envFor(p.deep);
    await until(() => Ed.E.echo === `direnv: loading ${rc}`, 'the loading note');
    assert.equal((await env).FROM_ENVRC, 'PATH_add bin # slow');
    assert.equal(Ed.E.echo, '', 'the note is gone once the load is done');
    /* a fast load says nothing */
    fs.writeFileSync(rc, 'PATH_add bin # slow, edited\n'); fs.rmSync(rc + '.slow');
    const later = new Date(Date.now() + 5000); fs.utimesSync(rc, later, later);
    Ed.message('before');
    assert.equal((await Ed.proc.envFor(p.deep)).FROM_ENVRC, 'PATH_add bin # slow, edited');
    assert.equal(Ed.E.echo, 'before');
    assert.equal(direnvCalls().length, n + 2);
    /* past the timeout: killed, said, the plain environment, and asked again next time */
    fs.writeFileSync(rc + '.slow', '30000');
    fs.writeFileSync(rc, 'PATH_add bin # slow, timed out\n'); fs.utimesSync(rc, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    await direnvTimeout(300, async asked => {
      assert.deepEqual(await Ed.proc.envFor(p.deep), {});
      assert.deepEqual(asked, [120_000], 'envFor gives direnv 120 s');
      assert.equal(Ed.E.echo, `direnv took longer than 120 s for ${rc}; the plain environment is used`);
      assert.deepEqual(direnvRunning(), [], 'killed');
      fs.rmSync(rc + '.slow');
      assert.equal((await Ed.proc.envFor(p.deep)).FROM_ENVRC, 'PATH_add bin # slow, timed out', 'a timeout is not kept');
      assert.equal(direnvCalls().length, n + 4);
    });
  });
});

test('envFor: C-g stops a slow direnv and quits, through M-! as well; nothing is kept, and the frame takes keys again', async () => {
  const p = project('hung', true), rc = path.join(p.root, '.envrc');
  fs.writeFileSync(rc + '.slow', '60000');
  await withFiles(async () => {
    let n = direnvCalls().length;
    const env = Ed.proc.envFor(p.deep);
    await until(() => direnvRunning().length === 1, 'direnv started');
    Ed.feedKey('C-g');
    await assert.rejects(env, (e: unknown) => L.S.conditionIs(e, 'quit'));
    /* asked again before the killed direnv has ended: a direnv of its own, not the stopped one's result */
    const again = Ed.proc.envFor(p.deep);
    assert.equal(direnvCalls().length, n + 2, 'a new direnv');
    await until(() => direnvRunning().length === 1, 'only the new direnv left');
    Ed.feedKey('C-g');
    await assert.rejects(again, (e: unknown) => L.S.conditionIs(e, 'quit'));
    await until(() => direnvRunning().length === 0, 'direnv killed');
    n += 1;
    assert.equal(direnvCalls().length, n + 1);
    /* M-! in a buffer whose directory is under the .envrc: the command waits for direnv, and C-g ends it */
    Ed.host.files!.cwd = p.deep;
    const b = Ed.getBufferCreate('*direnv-scratch*'); Ed.setWindowBuffer(b);
    const keys = (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); };
    keys('M-!'); for (const ch of 'echo ran') Ed.feedKey(ch === ' ' ? 'SPC' : ch);
    Ed.feedKey('RET');
    await until(() => direnvRunning().length === 1, 'direnv for M-!');
    Ed.feedKey('C-g');
    await until(() => direnvRunning().length === 0 && Ed.E.running === 0, 'the command over');
    assert.equal(Ed.E.echo, 'Quit');
    assert.equal(direnvCalls().length, n + 2);
    assert.ok(!proc.calls.slice(-1)[0].argv.includes('sh'), 'the shell command never started');
    /* nothing was kept: once direnv is quick again it is asked, and M-! runs in its environment */
    fs.rmSync(rc + '.slow');
    keys('M-!'); for (const ch of 'only-in-hung') Ed.feedKey(ch === ' ' ? 'SPC' : ch);
    Ed.feedKey('RET');
    await until(() => Ed.E.running === 0 && /^ran from hung/.test(Ed.E.echo), 'M-! in the .envrc\'s environment');
    assert.equal(direnvCalls().length, n + 3);
  });
});

test('envFor: a failing .envrc\'s own error output is never shown, only that direnv failed', async () => {
  await withFiles(async () => {
    const p = project('failing', true);
    fs.writeFileSync(path.join(p.root, '.envrc.failing'), '');
    const messages = () => { const m = Ed.getBuffer('*Messages*'); return m ? m.text : ''; };
    assert.deepEqual(await Ed.proc.envFor(p.deep), {});
    assert.equal(Ed.E.echo, 'direnv ended with code 1; the plain environment is used');
    assert.ok(!messages().includes('TOKEN=from-the-envrc'), 'not in *Messages*');
  });
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
