// Language server sessions (src/lsp.ts, scm/lsp.scm) in the headless runtime, their servers real children through
// Ed.proc (fake-proc.mts): a scripted stand-in server whose behaviour its argv chooses, and nil, a Nix language
// server from nixpkgs, when EDWIN_LSP_REAL names it (the check does). Start and initialize, one process per root
// and server, a crash started again with a doubling delay and given up past its bound, a broken stream and an
// unanswered initialize taken as crashes, a clean shutdown and one that ends in KILL within its bounds, the idle
// stop, the refusals (the image's replay, a web frame, no host.proc, a buffer whose file is not on this machine),
// and no child left after any of it.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

const proc = fakeProc();
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: unknown };
host.proc = proc;
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-')));
host.files = { cwd: tmp, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(tmp, p) };
after(async () => {
  await Ed.lsp.shutdownAll();
  for (const id of proc.running()) proc.kill(id, 'KILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DEFAULTS = { ...Ed.lsp.timing };
beforeEach(async () => {
  await Ed.lsp.shutdownAll();
  Object.assign(Ed.lsp.timing, DEFAULTS);
  await until(() => proc.running().length === 0, 'no child left by the test before (a KILLed one reaped)', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
const isErr = (kind: string) => (e: unknown) => L.S.conditionIs(e, kind);

/* The stand-in server: node SCRIPT LOG MODE. Each message it gets is logged as "PID METHOD" (initialize also with
   its params), and its error output says it started. MODE: normal; crash (exits 2 at once); crash-after-init
   (exits 3 once initialized); crash-once (crash-after-init the first time a marker is missing, then normal);
   hang (never answers initialize); garbage (breaks the framing once initialized); deaf (answers shutdown, ignores
   exit and its input closing); mute (answers nothing after initialize, ignores exit). */
const FAKE = `
const fs = require('fs');
const [log, mode] = process.argv.slice(2);
const note = s => fs.appendFileSync(log, process.pid + ' ' + s + '\\n');
process.stderr.write('fake: started ' + mode + '\\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
let crashOnce = false;
if (mode === 'crash-once') { const mark = log + '.crashed'; if (!fs.existsSync(mark)) { fs.writeFileSync(mark, ''); crashOnce = true; } }
if (mode === 'crash') process.exit(2);
if (mode === 'deaf' || mode === 'mute') setInterval(() => {}, 1000);
let buf = Buffer.alloc(0), initialized = false;
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1]);
    if (buf.length < end + 4 + n) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + n).toString('utf8'));
    buf = buf.subarray(end + 4 + n);
    note(m.method === 'initialize' ? 'initialize ' + JSON.stringify(m.params) : m.method || ('answer ' + JSON.stringify(m.result)));
    if (mode === 'mute' && initialized) continue;
    if (m.method === 'initialize') {
      if (mode !== 'hang') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { hoverProvider: true, textDocumentSync: 1 }, serverInfo: { name: 'fake' } } });
    } else if (m.method === 'initialized') {
      initialized = true;
      send({ jsonrpc: '2.0', id: 'c1', method: 'workspace/configuration', params: { items: [{ section: 'fake' }, { section: 'other' }] } });
      if (mode === 'crash-after-init' || crashOnce) setTimeout(() => process.exit(3), 20);
      if (mode === 'garbage') process.stdout.write('Content-Length: x\\r\\n\\r\\n{}');
    } else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit' && mode !== 'deaf') process.exit(0);
  }
});
process.stdin.on('end', () => { if (mode !== 'deaf' && mode !== 'mute') process.exit(1); });
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
let logs = 0;
/* A fresh log, and the fake server declared for fake-mode in MODE. */
function fake(mode: string) {
  const log = path.join(tmp, `log-${++logs}`);
  fs.writeFileSync(log, '');
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(log)} ${JSON.stringify(mode)}))`);
  return { log, lines: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { const i = l.indexOf(' '); return { pid: Number(l.slice(0, i)), what: l.slice(i + 1) }; }) };
}
const methods = (lines: { what: string }[]) => lines.map(l => l.what.split(' ')[0]);
/* A project directory (with a .git) holding FILE, and a buffer visiting it in MODE. */
function project(name: string, files: string[] = ['a.fake'], mode = 'fake-mode') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return files.map(f => {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
    const b = Ed.getBufferCreate(`${name}/${f}`);
    b.file = p; b.mode = mode;
    return b;
  });
}
/* COMMAND run in buffer B, as M-x runs it. */
function run(command: string, b: unknown) {
  Ed.setWindowBuffer(b);
  return L.call(command, []);
}

test('eglot starts the server in the project, initializes it, and answers its questions; one process per root and server', async () => {
  const f = fake('normal');
  const [a, sub] = project('one two #3 %20 é', ['a.fake', 'deep/er/b.fake']);
  const before = proc.calls.length;
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  assert.equal(s.state, 'starting', 'the command returns once the child runs, before initialize is answered');
  assert.equal(proc.calls.length, before + 1);
  const call = proc.calls[proc.calls.length - 1];
  const root = path.join(tmp, 'one two #3 %20 é');
  assert.deepEqual(call.argv.slice(1), [script, f.log, 'normal']);
  assert.equal(call.opts.cwd, root, 'the server runs in the project root');
  assert.equal(call.opts.maxBytes, undefined); assert.equal(call.opts.timeout, undefined); assert.equal(call.opts.merge, undefined);
  await Ed.lsp.ready(s);
  assert.equal(s.state, 'running');
  assert.deepEqual(s.capabilities, { hoverProvider: true, textDocumentSync: 1 });
  assert.match(E.echo, /: ready$/);
  await until(() => f.lines().some(l => l.what.startsWith('answer')), 'the answer to workspace/configuration');
  const lines = f.lines();
  assert.deepEqual(methods(lines), ['initialize', 'initialized', 'textDocument/didOpen', 'answer'], 'the buffer opened at once after initialized');
  const params = JSON.parse(lines[0].what.slice('initialize '.length));
  const uri = 'file://' + root.split('/').map(encodeURIComponent).join('/');
  assert.equal(uri.endsWith('/one%20two%20%233%20%2520%20%C3%A9'), true);
  assert.equal(params.rootUri, uri);
  assert.equal(params.rootPath, root);
  assert.deepEqual(params.workspaceFolders, [{ uri, name: 'one two #3 %20 é' }]);
  assert.equal(params.processId, null);
  assert.deepEqual(params.capabilities.general.positionEncodings, ['utf-16']);
  assert.equal(lines[3].what, 'answer [null,null]', 'every configuration item is null: the server\'s defaults');
  assert.match(Ed.lsp.stderr(s), /^fake: started normal\n$/);

  /* the same root: the same process; another root, and another server in the same root: one more each */
  run('eglot', sub);
  assert.equal(Ed.lsp.sessionOf(sub), s);
  assert.equal(proc.calls.length, before + 1, 'a second buffer of the root uses the running server');
  assert.match(E.echo, /: already running$/);
  assert.equal(s.buffers.size, 2);
  const [other] = project('other');
  run('eglot', other);
  assert.notEqual(Ed.lsp.sessionOf(other), s);
  L.evalText(`(define-language-server 'fake2 :modes '(fake2-mode) :command (list ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(f.log)} "normal"))`);
  const [c] = project('one two #3 %20 é', ['c.fake2'], 'fake2-mode');
  run('eglot', c);
  assert.notEqual(Ed.lsp.sessionOf(c), s);
  assert.equal(proc.calls.length, before + 3);
  assert.equal(Ed.lsp.sessions().length, 3);
  assert.equal(proc.running().length, 3);
  await Promise.all(Ed.lsp.sessions().map((x: unknown) => Ed.lsp.ready(x)));

  /* eglot-stderr-buffer shows its error output */
  run('eglot-stderr-buffer', a);
  assert.equal(E.current.name, '*EGLOT fake stderr*');
  assert.equal(E.current.text, 'fake: started normal\n');
  assert.equal(E.current.readOnly, true);
});

test('shutdown: shutdown, then exit; the child ends with 0, and none is left', async () => {
  const f = fake('normal');
  const [a] = project('down');
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  await Ed.lsp.ready(s);
  await until(() => f.lines().some(l => l.what.startsWith('answer')), 'the answer to workspace/configuration');
  const p = s.proc;
  run('eglot-shutdown', a);
  assert.equal(s.state, 'stopping');
  assert.equal(Ed.lsp.sessionOf(a), null, 'the buffer has no server at once');
  assert.deepEqual(Ed.lsp.sessions(), []);
  const x = await p.exit;
  assert.equal(x.code, 0, 'it exited on exit, not killed');
  await Ed.lsp.shutdown(s);
  assert.equal(s.state, 'stopped');
  assert.deepEqual(methods(f.lines()), ['initialize', 'initialized', 'textDocument/didOpen', 'answer', 'shutdown', 'exit']);
  assert.deepEqual(proc.running(), []);
  assert.throws(() => L.call('eglot-shutdown', []), isErr('user-error'), 'no server for the buffer any more');

  /* shutdown-all, as the program does on quitting: every server, in parallel */
  const [b] = project('down2'), [c] = project('down3');
  run('eglot', b); run('eglot', c);
  await Promise.all([Ed.lsp.ready(Ed.lsp.sessionOf(b)), Ed.lsp.ready(Ed.lsp.sessionOf(c))]);
  const t = Date.now();
  await Ed.lsp.shutdownAll();
  assert.ok(Date.now() - t < 1500, 'servers that answer are done within the bounds');
  assert.deepEqual(proc.running(), []);
  assert.equal(f.lines().filter(l => l.what === 'exit').length, 3);
});

test('a server that does not exit is KILLed within the bounds; one that does not answer shutdown too', async () => {
  for (const mode of ['deaf', 'mute']) {
    const f = fake(mode);
    const [a] = project('stubborn-' + mode);
    run('eglot', a);
    const s = Ed.lsp.sessionOf(a);
    await Ed.lsp.ready(s);
    await until(() => f.lines().some(l => l.what.startsWith('answer')), 'the answer to workspace/configuration');
    const p = s.proc;
    const t = Date.now();
    await Ed.lsp.shutdown(s);
    const took = Date.now() - t, T = Ed.lsp.timing;
    const x = await p.exit;
    assert.equal(x.signal, 'KILL', mode);
    assert.ok(took < T.shutdown + T.exitWait + T.killWait + 300, `${mode}: ${took} ms`);
    if (mode === 'mute') assert.ok(took >= T.shutdown, 'shutdown waited for its answer up to its bound');
    else assert.ok(took < T.shutdown, 'shutdown was answered, only exit was ignored');
    assert.deepEqual(methods(f.lines()).slice(-3), mode === 'mute' ? ['shutdown', '$/cancelRequest', 'exit'] : ['answer', 'shutdown', 'exit']);
    assert.deepEqual(proc.running(), []);
  }
});

test('a server that ends is started again after a delay that doubles, up to the bound; then it is given up', async () => {
  Object.assign(Ed.lsp.timing, { restartDelay: 30, restartMax: 3 });
  const f = fake('crash-after-init');
  const [a] = project('crashy');
  const before = proc.calls.length;
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  await until(() => s.state === 'failed', 'giving up', 5000);
  assert.equal(proc.calls.length - before, 4, 'started once, and again three times');
  const pids = [...new Set(f.lines().map(l => l.pid))];
  assert.equal(pids.length, 4);
  assert.match(s.why, /exited with code 3/);
  assert.match(E.echo, /it ended 4 times in a row, so it is not started again/);
  await sleep(30 * 8 + 200);
  assert.equal(proc.calls.length - before, 4, 'nothing started after it gave up');
  assert.deepEqual(proc.running(), []);
  /* eglot starts it again, the count from zero */
  run('eglot', a);
  assert.equal(s.state, 'starting');
  assert.equal(s.restarts, 0);
  await until(() => s.state === 'failed', 'giving up again', 5000);
  assert.equal(proc.calls.length - before, 8);
  await Ed.lsp.shutdown(s);
  assert.deepEqual(proc.running(), []);
});

test('the delays double: about 1, 2, 4 times restartDelay between an end and the next start', async () => {
  Object.assign(Ed.lsp.timing, { restartDelay: 100, restartMax: 3 });
  fake('crash');
  const [a] = project('timed');
  const at: number[] = [];
  const spawn = proc.spawn;
  proc.spawn = (...args: Parameters<FakeProc['spawn']>) => { at.push(Date.now()); return spawn(...args); };
  let waited: Promise<void> = Promise.resolve();
  try {
    run('eglot', a);
    const s = Ed.lsp.sessionOf(a);
    waited = Ed.lsp.ready(s); waited.catch(() => {});
    await until(() => s.state === 'failed', 'giving up', 5000);
  } finally { proc.spawn = spawn; }
  await assert.rejects(waited, isErr('lsp-error'), 'a wait for it ends when it gives up');
  assert.equal(at.length, 4);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  for (const [i, g] of gaps.entries()) {
    const want = 100 * 2 ** i;
    assert.ok(g >= want && g < want + 1500, `gap ${i}: ${g} ms, want about ${want}`);
  }
  assert.deepEqual(proc.running(), []);
});

test('a crash once: started again, initialized again, a new process; a healthy run starts the count again', async () => {
  Object.assign(Ed.lsp.timing, { restartDelay: 20 });
  const f = fake('crash-once');
  const [a] = project('once');
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  await until(() => s.restarts === 1 && s.state === 'running', 'running again');
  const pids = [...new Set(f.lines().map(l => l.pid))];
  assert.equal(pids.length, 2);
  await until(() => f.lines().filter(l => l.pid === pids[1]).length >= 2, 'the new process logged initialized');   // its log is written as it reads
  assert.deepEqual(f.lines().filter(l => l.pid === pids[1]).map(l => l.what.split(' ')[0]).slice(0, 2), ['initialize', 'initialized']);
  assert.equal(proc.running().length, 1);
  assert.deepEqual(s.capabilities, { hoverProvider: true, textDocumentSync: 1 });

  /* killed after running past timing.healthy: a first end again */
  Object.assign(Ed.lsp.timing, { healthy: 0 });
  s.proc.kill('KILL');
  await until(() => s.state === 'running' && s.proc && s.restarts === 1 && [...new Set(f.lines().map(l => l.pid))].length === 3, 'running a third time');
  assert.match(s.why || '', /^$|killed by KILL/);
  await Ed.lsp.shutdown(s);
  assert.deepEqual(proc.running(), []);
});

test('a broken stream and an initialize past its time count as ends: the child is killed and started again', async () => {
  Object.assign(Ed.lsp.timing, { restartDelay: 20, restartMax: 1 });
  const g = fake('garbage');
  const [a] = project('garbled');
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  await until(() => s.state === 'failed', 'giving up');
  assert.match(s.why, /breaks its framing: a Content-Length that is not a number/);
  assert.equal([...new Set(g.lines().map(l => l.pid))].length, 2);
  await until(() => proc.running().length === 0, 'the children killed');
  await Ed.lsp.shutdown(s);

  Object.assign(Ed.lsp.timing, { connect: 1500, restartMax: 0 });
  const h = fake('hang');
  const [b] = project('hung');
  run('eglot', b);
  const t = Ed.lsp.sessionOf(b);
  await until(() => t.state === 'failed', 'giving up on initialize');
  assert.match(t.why, /^initialize: no answer from the language server in 1.5 s$/);
  assert.deepEqual(methods(h.lines()), ['initialize']);
  await until(() => proc.running().length === 0, 'the hung child killed');
  await Ed.lsp.shutdown(t);
});

test('a session no buffer uses stops after timing.idle; a buffer that comes back in time keeps it', async () => {
  Object.assign(Ed.lsp.timing, { idle: 150 });
  const f = fake('normal');
  const [a, b] = project('idle', ['a.fake', 'b.fake']);
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  await Ed.lsp.ready(s);
  L.call('kill-buffer', [a]);
  assert.equal(Ed.lsp.sessionOf(a), null);
  await sleep(50);
  run('eglot', b);
  assert.equal(Ed.lsp.sessionOf(b), s, 'the same session, its idle stop called off');
  await sleep(250);
  assert.equal(s.state, 'running');
  L.call('kill-buffer', [b]);
  await sleep(100);
  assert.equal(s.state, 'running', 'not before its time');
  await until(() => s.state === 'stopped', 'the idle stop');
  assert.deepEqual(methods(f.lines()).slice(-2), ['shutdown', 'exit']);
  assert.deepEqual(Ed.lsp.sessions(), []);
  assert.deepEqual(proc.running(), []);
});

test('eglot-reconnect: a new process, the buffers kept', async () => {
  const f = fake('normal');
  const [a, b] = project('again', ['a.fake', 'b.fake']);
  run('eglot', a); run('eglot', b);
  const s = Ed.lsp.sessionOf(a);
  await Ed.lsp.ready(s);
  await assert.rejects(async () => Ed.proc.replay(() => run('eglot-reconnect', a)), isErr('process-error'), 'not while the image replays');
  await sleep(10);
  assert.equal(s.state, 'running', 'the server left as it was');
  await run('eglot-reconnect', a);
  const n = Ed.lsp.sessionOf(a);
  assert.notEqual(n, s);
  assert.equal(Ed.lsp.sessionOf(b), n);
  assert.equal(s.state, 'stopped');
  await Ed.lsp.ready(n);
  assert.equal([...new Set(f.lines().map(l => l.pid))].length, 2);
  assert.equal(proc.running().length, 1);
});

test('eglot-reconnect racing eglot in another buffer of the root, and a second reconnect: one session, one process', async () => {
  const f = fake('normal');
  const [a, b] = project('race', ['a.fake', 'b.fake']);
  run('eglot', a); run('eglot', b);
  const s = Ed.lsp.sessionOf(a);
  await Ed.lsp.ready(s);
  /* eglot in b while a's reconnect waits for the old server to shut down */
  const pr = run('eglot-reconnect', a);
  await sleep(0);
  run('eglot', b);
  await pr;
  const n = Ed.lsp.sessionOf(a);
  assert.notEqual(n, s);
  assert.equal(Ed.lsp.sessionOf(b), n, 'both buffers on the one session');
  assert.equal(Ed.lsp.sessions().length, 1);
  assert.deepEqual(Ed.lsp.sessions(), [n]);
  await Ed.lsp.ready(n);
  assert.equal(proc.running().length, 1, 'one process for the root and server');
  /* two reconnects of the session at once (the second reconnect's buffers were detached by the first's shutdown) */
  await Promise.all([Ed.lsp.reconnect(n), Ed.lsp.reconnect(n)]);
  const m = Ed.lsp.sessionOf(a);
  assert.equal(Ed.lsp.sessionOf(b), m);
  assert.deepEqual(Ed.lsp.sessions(), [m]);
  await Ed.lsp.ready(m);
  assert.equal(proc.running().length, 1);
  assert.equal([...new Set(f.lines().map(l => l.pid))].length, 3);
  /* every child is a session's: shutdown-all leaves none */
  await Ed.lsp.shutdownAll();
  assert.deepEqual(proc.running(), []);
});

test('a buffer killed while eglot-reconnect waits is not attached to the new session, which then stops when idle', async () => {
  Object.assign(Ed.lsp.timing, { idle: 150 });
  const f = fake('normal');
  const [a, b] = project('killed', ['a.fake', 'b.fake']);
  run('eglot', a); run('eglot', b);
  const s = Ed.lsp.sessionOf(a);
  await Ed.lsp.ready(s);
  /* a killed while the old server shuts down: by then the shutdown has detached it, so its kill-buffer-hook finds
     no session, and only the reconnect knows it */
  let pr = run('eglot-reconnect', a);
  await sleep(0);
  L.call('kill-buffer', [a]);
  await pr;
  const n = Ed.lsp.sessionOf(b);
  assert.notEqual(n, s);
  assert.deepEqual([...n.buffers].map((x: { name: string }) => x.name), [b.name], 'the dead buffer is not on the new session');
  await Ed.lsp.ready(n);
  L.call('kill-buffer', [b]);
  await until(() => n.state === 'stopped', 'the idle stop with the dead buffer gone');
  assert.deepEqual(methods(f.lines()).slice(-2), ['shutdown', 'exit']);
  /* the only buffer killed while the reconnect waits: the new session has none, and stops when idle all the same */
  const [c] = project('killed', ['c.fake']);
  run('eglot', c);
  const t = Ed.lsp.sessionOf(c);
  await Ed.lsp.ready(t);
  pr = run('eglot-reconnect', c);
  await sleep(0);
  L.call('kill-buffer', [c]);
  await pr;
  const [u] = Ed.lsp.sessions();
  assert.notEqual(u, t);
  assert.equal(u.buffers.size, 0);
  await until(() => u.state === 'stopped', 'the idle stop of a session reconnected with no buffer left');
  assert.deepEqual(Ed.lsp.sessions(), []);
  assert.deepEqual(proc.running(), []);
});

/* eglot-reconnect in a buffer of a fresh project, and ALL (a shutdown of every server) run while the reconnect waits
   for the old server to shut down: nothing started again, nothing left, and a later eglot starts a server. */
async function reconnectThenShutdownAll(name: string, all: (b: unknown) => unknown) {
  const f = fake('normal');
  const [a] = project(name);
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  await Ed.lsp.ready(s);
  await until(() => f.lines().some(l => l.what.startsWith('answer')), 'the answer to workspace/configuration');
  const spawns = proc.calls.length;
  const pr = run('eglot-reconnect', a);
  await sleep(0);
  await all(a);
  await pr;
  await sleep(50);
  assert.equal(proc.calls.length, spawns, 'nothing spawned after shutdown-all');
  assert.deepEqual(proc.running(), []);
  assert.deepEqual(Ed.lsp.sessions(), []);
  assert.equal(Ed.lsp.sessionOf(a), null);
  assert.equal(s.state, 'stopped');
  assert.match(E.echo, /: not started again: every language server was shut down$/);
  assert.deepEqual(methods(f.lines()), ['initialize', 'initialized', 'textDocument/didOpen', 'answer', 'shutdown', 'exit']);
  run('eglot', a);
  await Ed.lsp.ready(Ed.lsp.sessionOf(a));
  assert.equal(proc.running().length, 1, 'a later eglot starts a server');
}
test('Ed.lsp.shutdownAll (quitting) while eglot-reconnect waits for the old server: no server started again', async () => {
  await reconnectThenShutdownAll('all-api', () => Ed.lsp.shutdownAll());
});
test('eglot-shutdown-all while eglot-reconnect waits for the old server: no server started again', async () => {
  await reconnectThenShutdownAll('all-cmd', b => run('eglot-shutdown-all', b));
});

test('the refusals: the image replaying, a web frame, no host.proc, no file here, no server, a missing program', async () => {
  const f = fake('normal');
  const [a] = project('refused');
  const before = proc.calls.length;
  Ed.setWindowBuffer(a);
  /* the image's replay: no start, and no declaration (its argv would run later); the declaration is skipped, not an
     error, so the forms after it in edwind's init.scm, which a served frame evaluates this way (src/sync.ts), run */
  assert.throws(() => Ed.proc.replay(() => L.call('eglot', [])), (e: unknown) => isErr('process-error')(e) && /while the image replays/.test(Ed.errorText(e)));
  const init = `(define-language-server 'fake :modes '(fake-mode) :command '("sh" "-c" "touch pwned"))
(define-language-server 'other :modes '(other-mode) :command '("sh"))
(define lsp-test-after-declaration 'ran)`;
  let failed: unknown = null;
  Ed.proc.replay(() => { try { for (const form of L.readAll(init)) { L.resetOps(); L.ev(form); } } catch (e) { failed = e; } });
  assert.equal(failed, null, 'no form of init.scm signals');
  assert.equal(L.evalText('lsp-test-after-declaration').name, 'ran', 'the form after the declarations ran');
  assert.match(E.echo, /define-language-server: other is not declared while the image replays/);
  await sleep(10);
  assert.deepEqual(Ed.lsp.servers().find((s: { name: string }) => s.name === 'fake').argv.slice(-2), [f.log, 'normal'], 'the declaration is the one before');
  assert.equal(Ed.lsp.servers().some((s: { name: string }) => s.name === 'other'), false);
  /* a web frame, and a host with no processes: refused before anything */
  const kind = Ed.host.kind;
  Ed.host.kind = 'browser';
  try { assert.throws(() => L.call('eglot', []), (e: unknown) => isErr('process-error')(e) && /web frame/.test(Ed.errorText(e))); }
  finally { Ed.host.kind = kind; }
  delete host.proc;
  try { assert.throws(() => L.call('eglot', []), isErr('process-error')); }
  finally { host.proc = proc; }
  /* no file, a file of edwind's, no server for the mode */
  const nofile = Ed.getBufferCreate('*nofile*'); nofile.mode = 'fake-mode';
  assert.throws(() => run('eglot', nofile), (e: unknown) => isErr('lsp-error')(e) && /visits no file/.test(Ed.errorText(e)));
  const shared = Ed.getBufferCreate('note.fake'); shared.mode = 'fake-mode'; shared.file = 'note.fake'; shared.shared = true;
  assert.throws(() => run('eglot', shared), (e: unknown) => isErr('lsp-error')(e) && /not a file on this machine/.test(Ed.errorText(e)));
  const [plain] = project('refused', ['x.txt'], 'text-mode');
  assert.throws(() => run('eglot', plain), (e: unknown) => isErr('lsp-error')(e) && /No language server is declared for text-mode/.test(Ed.errorText(e)));
  assert.equal(proc.calls.length, before, 'nothing spawned');
  /* a program that is not there: process-error, and no session kept */
  L.evalText(`(define-language-server 'gone :modes '(gone-mode) :command '("edwin-no-such-language-server"))`);
  const [g] = project('refused', ['y.gone'], 'gone-mode');
  assert.throws(() => run('eglot', g), (e: unknown) => isErr('process-error')(e) && /cannot run edwin-no-such-language-server/.test(Ed.errorText(e)));
  assert.equal(Ed.lsp.sessionOf(g), null);
  assert.deepEqual(Ed.lsp.sessions(), []);
  /* the declaration's own refusals */
  for (const [form, re] of [
    [`(define-language-server 'x :modes '() :command '("a"))`, /:modes needs a non-empty list/],
    [`(define-language-server 'x :modes '(m) :command '())`, /:command needs a non-empty list of strings/],
    [`(define-language-server 'x :modes '(m) :command '(a))`, /:command needs a non-empty list of strings/],
    [`(define-language-server 'x :modes '(m))`, /no :command/],
    [`(define-language-server 'x :command '("a"))`, /no :modes/],
    [`(define-language-server 'x :modes '(m) :command '("a") :other 1)`, /unknown option/],
    [`(define-language-server "a b" :modes '(m) :command '("a"))`, /not a plain symbol/],
  ] as [string, RegExp][]) assert.throws(() => L.evalText(form), (e: unknown) => isErr('lsp-error')(e) && re.test(Ed.errorText(e)), form);
  assert.equal(Ed.lsp.servers().some((s: { name: string }) => s.name === 'x'), false);
});

test('a session keeps the argv it started with: a later declaration changes only new sessions and reconnect', async () => {
  const f = fake('normal');
  const [a] = project('kept');
  Object.assign(Ed.lsp.timing, { restartDelay: 20 });
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  await Ed.lsp.ready(s);
  const g = fake('normal');
  s.proc.kill('KILL');
  await until(() => s.state === 'running' && s.restarts === 1, 'started again');
  const last = proc.calls[proc.calls.length - 1];
  assert.equal(last.argv[2], f.log, 'started again with its own argv');
  assert.equal(g.lines().length, 0);
  await Ed.lsp.shutdown(s);
});

/* nil (github.com/oxalica/nil), a Nix language server from nixpkgs: it initializes, is started again after a
   KILL, and exits on shutdown and exit. EDWIN_LSP_REAL names the program; the check sets it. */
test('a real server, nil: initialize, a KILL started again, shutdown and exit', { skip: !process.env.EDWIN_LSP_REAL && 'EDWIN_LSP_REAL is not set' }, async () => {
  Object.assign(Ed.lsp.timing, { restartDelay: 50 });
  L.evalText(`(define-language-server 'nil :modes '(nix-mode) :command '(${JSON.stringify(process.env.EDWIN_LSP_REAL)}))`);
  const [b] = project('nix', ['default.nix'], 'nix-mode');
  fs.writeFileSync(b.file, 'let x = 1; in x\n');
  run('eglot', b);
  const s = Ed.lsp.sessionOf(b);
  await Ed.lsp.ready(s);
  assert.ok(s.capabilities.definitionProvider, 'nil says it gives definitions');
  const first = s.proc.id;
  s.proc.kill('KILL');
  await until(() => s.state === 'running' && s.proc && s.proc.id !== first, 'nil started again');
  assert.equal(s.restarts, 1);
  const p = s.proc;
  await Ed.lsp.shutdown(s);
  const x = await p.exit;
  assert.equal(x.code, 0, 'nil exited on exit');
  assert.deepEqual(proc.running(), []);
});

test('a server whose program has gone is given up, even after a healthy run: a refused start is no run', async () => {
  const f = fake('normal');
  const wrapper = path.join(tmp, 'wrapped-server');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(f.log)} normal\n`, { mode: 0o755 });
  L.evalText(`(define-language-server 'wrapped :modes '(wrapped-mode) :command '(${JSON.stringify(wrapper)}))`);
  const [a] = project('gone', ['a.wrapped'], 'wrapped-mode');
  run('eglot', a);
  const s = Ed.lsp.sessionOf(a);
  await Ed.lsp.ready(s);
  Object.assign(Ed.lsp.timing, { restartDelay: 20, restartMax: 2, healthy: 50 });
  await sleep(80);
  fs.rmSync(wrapper);
  const before = proc.calls.length;
  s.proc.kill('KILL');
  await until(() => s.state === 'failed', 'giving up', 3000);
  assert.match(s.why, /cannot run .*wrapped-server/);
  assert.equal(proc.calls.length, before, 'each start again was refused before a child');
  await Ed.lsp.shutdown(s);
  assert.deepEqual(proc.running(), []);
});
