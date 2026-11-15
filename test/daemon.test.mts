// edwin --daemon (the edwin-daemon script in nix/edwin.nix), run from the package as a user runs it, each test as a
// throwaway user (HOME and XDG_RUNTIME_DIR under TMPDIR): a start returns once the socket answers; of two starts at
// once one runs edwind and the other exits with status 3; --wait returns once the socket answers and fails after
// its timeout when edwind dies; the lock is never edwind's. EDWIN_BIN is the package's bin (the edwin-daemon check).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const BIN: string = process.env.EDWIN_BIN || '';
if (!BIN) throw new Error("EDWIN_BIN must name the edwin package's bin directory (the edwin-daemon check sets it)");
/* edwin-daemon's wait for an answer (wait_s). */
const WAIT_S = 30;

interface User { home: string; run: string; sock: string; cfg: string; lock: string; env: NodeJS.ProcessEnv }
const users: User[] = [];
function user(): User {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'u'));
  const run = path.join(home, 'run');
  fs.mkdirSync(run, { mode: 0o700 });
  const u = {
    home, run, sock: path.join(run, 'edwin/edit.sock'), cfg: path.join(run, 'edwin/edwind.json'),
    lock: path.join(home, '.local/state/edwin/edwind.lock'),
    env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: run, TMPDIR: home },
  };
  users.push(u);
  return u;
}

interface Run { code: number | null; out: string; err: string; ms: number }
/* PROGRAM (in the package's bin) with ARGS as U, to its end. */
function run(u: User, program: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return finish(spawn(path.join(BIN, program), args, { env: { ...u.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }));
}
function finish(p: ChildProcess): Promise<Run> {
  const t0 = Date.now();
  let out = '', err = '';
  p.stdout!.on('data', d => { out += d; });
  p.stderr!.on('data', d => { err += d; });
  return new Promise(resolve => p.on('close', code => resolve({ code, out, err, ms: Date.now() - t0 })));
}

/* Whether something accepts on SOCK now. */
function answers(sock: string): Promise<boolean> {
  return new Promise(resolve => {
    const c = net.connect(sock);
    c.on('connect', () => { c.destroy(); resolve(true); }).on('error', () => resolve(false));
  });
}

/* The live edwinds run with --config CFG (zombies are not). */
function edwinds(cfg: string): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      const i = argv.indexOf('--config');
      if (i < 0 || argv[i + 1] !== cfg || !argv.some(a => a.endsWith('/server/main.mts'))) continue;
      if (/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${d}/stat`, 'utf8'))) continue;
      out.push(Number(d));
    } catch { /* gone meanwhile */ }
  }
  return out;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/* Stops every edwind with --config CFG and waits until each has exited: a stopping edwind unlinks the socket last,
   which would take a new edwind's socket away. */
async function stop(cfg: string) {
  for (const pid of edwinds(cfg)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const end = Date.now() + 20000;
  while (edwinds(cfg).length) {
    assert.ok(Date.now() < end, `an edwind with ${cfg} did not stop`);
    await sleep(20);
  }
}
/* Whether the lock file is free: flock -n takes it at once. */
const lockFree = (u: User) => spawnSync('flock', ['-n', u.lock, 'true']).status === 0;
/* Whether process PID holds a descriptor of FILE. */
function holds(pid: number, file: string): boolean {
  const dir = `/proc/${pid}/fd`;
  return fs.readdirSync(dir).some(fd => { try { return fs.readlinkSync(path.join(dir, fd)) === file; } catch { return false; } });
}

after(async () => { for (const u of users) await stop(u.cfg); });

test('edwin --daemon returns once the socket answers; edwind never holds the lock', async () => {
  const u = user();
  const r = await run(u, 'edwin', ['--daemon']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^edwin: edwind started \(log: /m);
  assert.ok(await answers(u.sock), 'the socket answers when edwin --daemon returns');
  const pids = edwinds(u.cfg);
  assert.equal(pids.length, 1);
  assert.ok(!holds(pids[0], u.lock), 'edwind holds no descriptor of the lock');
  assert.ok(lockFree(u), 'the lock is free once the start has returned');
  // An edwind that answers at once: refused with status 1, as before.
  const again = await run(u, 'edwin', ['--daemon']);
  assert.equal(again.code, 1);
  assert.match(again.err, /an edwind already runs on /);
  const w = await run(u, 'edwin-daemon', ['--wait']);
  assert.equal(w.code, 0, w.err);
  assert.ok(w.ms < 5000, `--wait on an edwind that answers took ${w.ms} ms`);
  assert.equal(edwinds(u.cfg).length, 1);
  await stop(u.cfg);
});

test('`edwin --daemon && edwinclient -e 1` succeeds 100 times in a row', async () => {
  const u = user();
  for (let i = 0; i < 100; i++) {
    const r = await finish(spawn('bash', ['-c', `"$B/edwin" --daemon && "$B/edwinclient" -e 1`],
      { env: { ...u.env, B: BIN }, stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(r.code, 0, `run ${i + 1}: ${r.err}`);
    assert.equal(r.out, '1\n', `run ${i + 1}`);
    await stop(u.cfg);
  }
});

test('two starts at once give one edwind and one exit with status 3', async () => {
  const u = user();
  for (let i = 0; i < 5; i++) {
    const rs = await Promise.all([run(u, 'edwin', ['--daemon']), run(u, 'edwin', ['--daemon'])]);
    assert.deepEqual(rs.map(r => r.code).sort(), [0, 3], rs.map(r => r.err).join(''));
    assert.match(rs.find(r => r.code === 3)!.err, /another start started the edwind on /);
    assert.ok(await answers(u.sock));
    assert.equal(edwinds(u.cfg).length, 1, `round ${i + 1}`);
    assert.ok(lockFree(u));
    await stop(u.cfg);
  }
  // A second start while the first's edwind is still coming up waits on the lock rather than starting another.
  for (const ms of [50, 150, 300]) {
    const first = run(u, 'edwin', ['--daemon']);
    await sleep(ms);
    const second = await run(u, 'edwin', ['--daemon']);
    assert.equal((await first).code, 0);
    assert.ok(second.code === 3 || second.code === 1, `${ms} ms later: ${second.code} ${second.err}`);
    assert.equal(edwinds(u.cfg).length, 1, `${ms} ms later`);
    await stop(u.cfg);
  }
});

test("the user service's start (--fg-daemon) and edwin --daemon give one edwind", async () => {
  const u = user();
  const fg = spawn(path.join(BIN, 'edwin'), ['--fg-daemon'], { env: u.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = finish(fg);
  // Once the service start holds the lock (a probe that takes it for an instant only delays that start).
  const held = Date.now() + 10000;
  while (lockFree(u)) { assert.ok(Date.now() < held, 'the service start never took the lock'); await sleep(5); }
  const r = await run(u, 'edwin', ['--daemon']);
  assert.ok(r.code === 3 || r.code === 1, `${r.code} ${r.err}`);
  assert.ok(await answers(u.sock));
  assert.deepEqual(edwinds(u.cfg), [fg.pid], 'the one edwind is the service start (exec keeps its pid)');
  assert.ok(!holds(fg.pid!, u.lock), 'the foreground edwind holds no descriptor of the lock');
  // The helper that kept the lock lets it go once edwind answers.
  const end = Date.now() + 5000;
  while (!lockFree(u)) { assert.ok(Date.now() < end, 'the lock stayed held after edwind answered'); await sleep(20); }
  fg.kill('SIGTERM');
  assert.equal((await ended).code, 0);
});

test('--wait returns only once the socket answers', async () => {
  const u = user();
  const fg = spawn(path.join(BIN, 'edwin'), ['--fg-daemon'], { env: u.env, stdio: 'ignore' });
  const exited = new Promise(r => fg.on('exit', r));
  assert.ok(!(await answers(u.sock)), 'edwind does not answer the moment it is started');
  const w = await run(u, 'edwin-daemon', ['--wait']);
  assert.equal(w.code, 0, w.err);
  assert.ok(await answers(u.sock), 'the socket answers when --wait returns');
  fg.kill('SIGTERM');
  await exited;
});

test('a start and --wait fail after the timeout when edwind dies', async () => {
  // edwind refuses a socket directory that is not mode 700, after it has started: it exits with status 1.
  const bg = user(), fgu = user();
  for (const u of [bg, fgu]) { fs.mkdirSync(path.join(u.run, 'edwin')); fs.chmodSync(path.join(u.run, 'edwin'), 0o755); }
  const fg = spawn(path.join(BIN, 'edwin'), ['--fg-daemon'], { env: fgu.env, stdio: 'ignore' });
  const fgCode = new Promise<number | null>(r => fg.on('exit', r));
  const [start, wait] = await Promise.all([run(bg, 'edwin', ['--daemon']), run(fgu, 'edwin-daemon', ['--wait'])]);
  assert.equal(start.code, 1);
  assert.match(start.err, new RegExp(`the edwind started did not answer on .* within ${WAIT_S} s \\(log: `));
  assert.ok(start.ms >= WAIT_S * 1000 - 500, `the start gave up after ${start.ms} ms`);
  assert.equal(wait.code, 1);
  assert.match(wait.err, new RegExp(`no edwind answered on .* within ${WAIT_S} s`));
  assert.ok(wait.ms >= WAIT_S * 1000 - 500, `--wait gave up after ${wait.ms} ms`);
  assert.equal(await fgCode, 1);
  assert.equal(edwinds(bg.cfg).length, 0);
  assert.ok(lockFree(bg), 'a start whose edwind died leaves the lock free');
  assert.match(fs.readFileSync(path.join(bg.home, '.local/state/edwin/edwind.log'), 'utf8'), /has mode 755, not 700/);
});

test('with EDWIND_CONFIG a start waits on the socket the config names', async () => {
  const u = user();
  const sock = path.join(u.home, 'own/edit.sock');
  fs.mkdirSync(path.dirname(sock), { mode: 0o700 });
  fs.mkdirSync(path.join(u.home, 'notes'));
  const cfg = path.join(u.home, 'edit.json');
  fs.writeFileSync(cfg, JSON.stringify({ socket: sock, notesDir: path.join(u.home, 'notes') }));
  u.cfg = cfg;
  const r = await run(u, 'edwin', ['--daemon'], { EDWIND_CONFIG: cfg });
  assert.equal(r.code, 0, r.err);
  assert.ok(await answers(sock));
  const w = await run(u, 'edwin-daemon', ['--wait'], { EDWIND_CONFIG: cfg });
  assert.equal(w.code, 0, w.err);
  await stop(cfg);
  // A config edwind would refuse is refused before anything starts, in edwind's words.
  const bad = path.join(u.home, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ socket: sock, notesDir: path.join(u.home, 'notes'), bogus: 1 }));
  const b = await run(u, 'edwin', ['--daemon'], { EDWIND_CONFIG: bad });
  assert.equal(b.code, 1);
  assert.match(b.err, /^edwin: .*bad\.json: unknown field "bogus"$/m);
  assert.ok(!(await answers(sock)));
});
