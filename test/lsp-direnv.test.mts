// Language servers in the project's direnv environment (src/lsp.ts's launch over Ed.proc.envFor) in the headless
// runtime, children through Ed.proc (fake-proc.mts), over a real directory with host.files giving stamps as
// host-native.ts does. A stand-in direnv first on PATH for the whole suite (this file runs in a process of its
// own) and a stand-in server that is only in a project's bin/, which only that project's .envrc puts on PATH.
// The real direnv is never run, and nothing here ever runs `direnv allow`.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-direnv-')));
/* The stand-in direnv: `export json` only (anything else exits 2). The nearest .envrc from its directory up
   decides: none prints nothing; else, after the milliseconds a .envrc.slow beside it holds, its directory's bin
   first on PATH and the .envrc's text as LSP_FROM_DIRENV. */
const FAKE_DIRENV = `#!${process.execPath}
const fs = require('fs'), path = require('path');
if (process.argv.slice(2).join(' ') !== 'export json') { process.stderr.write('fake direnv: only export json\\n'); process.exit(2); }
let d = process.cwd(), rc = null;
for (;;) { if (fs.existsSync(path.join(d, '.envrc'))) { rc = path.join(d, '.envrc'); break; } const up = path.dirname(d); if (up === d) break; d = up; }
if (!rc) process.exit(0);
const slow = fs.existsSync(rc + '.slow') ? Number(fs.readFileSync(rc + '.slow', 'utf8')) : 0;
setTimeout(() => { process.stdout.write(JSON.stringify({ PATH: path.join(d, 'bin') + ':' + process.env.PATH, LSP_FROM_DIRENV: fs.readFileSync(rc, 'utf8').trim() })); process.exit(0); }, slow);
`;
const fakeBin = path.join(tmp, 'fake-bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'direnv'), FAKE_DIRENV, { mode: 0o755 });
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

/* The stand-in server: logs "PID env LSP_FROM_DIRENV" when it starts, then each message's method, to
   server.log in its directory (the root); answers initialize and shutdown, exits on exit. */
const SERVER = `
const fs = require('fs'), path = require('path');
const log = path.join(process.cwd(), 'server.log');
const note = s => fs.appendFileSync(log, process.pid + ' ' + s + '\\n');
note('env ' + (process.env.LSP_FROM_DIRENV || '-'));
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
let buf = Buffer.alloc(0);
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1]);
    if (buf.length < end + 4 + n) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + n).toString('utf8'));
    buf = buf.subarray(end + 4 + n);
    note(m.method || 'answer');
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } });
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const serverScript = path.join(tmp, 'server.cjs');
fs.writeFileSync(serverScript, SERVER);
const SERVER_NAME = 'edwin-direnv-ls';

const proc = fakeProc();
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: unknown };
host.proc = proc;
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
L.evalText('(set! corfu-auto #f)');
const resolve = (p: string) => path.resolve(tmp, p);
host.files = {
  cwd: tmp, resolve, exists: (p: string) => fs.existsSync(resolve(p)),
  stamp: (p: string) => { try { const s = fs.statSync(resolve(p), { bigint: true }); return s.isFile() ? `${s.ino}:${s.mtimeNs}:${s.size}` : null; } catch { return null; } },
  read: (p: string) => { try { return fs.readFileSync(resolve(p), 'utf8'); } catch { return null; } },
  write: (p: string, v: string) => { fs.mkdirSync(path.dirname(resolve(p)), { recursive: true }); fs.writeFileSync(resolve(p), v); },
  remove: (p: string) => { fs.rmSync(resolve(p), { force: true }); },
  list: () => [] as string[], truename: (p: string) => resolve(p), temp: [] as string[],
};
L.evalText(`(define-language-server 'direnv-ls :modes '(fake-mode) :command '(${JSON.stringify(SERVER_NAME)}))`);
after(async () => {
  await Ed.lsp.shutdownAll();
  for (const id of proc.running()) proc.kill(id, 'KILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});
const DEFAULTS = { ...Ed.lsp.timing };
beforeEach(async () => {
  await Ed.lsp.shutdownAll();
  Object.assign(Ed.lsp.timing, DEFAULTS);
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
const isErr = (kind: string) => (e: unknown) => L.S.conditionIs(e, kind);
const direnvCalls = () => proc.calls.filter(c => c.argv[0] === 'direnv');
const serverCalls = () => proc.calls.filter(c => c.argv[0] === SERVER_NAME);
const on = (b: unknown) => L.truthy(Ed.localValue(b, 'eglot-enabled'));

/* A project NAME (a .git) holding sub/a.fake, with an .envrc of ENVRC (none when null) and the server in its bin/;
   a buffer visiting the file in fake-mode, not shown. */
let made = 0;
function project(name: string, envrc: string | null) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  const server = path.join(root, 'bin', SERVER_NAME);
  fs.writeFileSync(server, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)}\n`, { mode: 0o755 });
  if (envrc !== null) fs.writeFileSync(path.join(root, '.envrc'), envrc + '\n');
  const file = path.join(root, 'sub', 'a.fake');
  fs.writeFileSync(file, '');
  const b = Ed.getBufferCreate(`${name}-${++made}/a.fake`);
  b.file = file; b.mode = 'fake-mode';
  const log = () => { try { return fs.readFileSync(path.join(root, 'server.log'), 'utf8').split('\n').filter(Boolean).map(l => l.slice(l.indexOf(' ') + 1)); } catch { return []; } };
  return { root, b, log, envrc: path.join(root, '.envrc') };
}
function run(command: string, b: unknown) {
  Ed.setWindowBuffer(b);
  return L.call(command, []);
}

test("a server only on the project's direnv PATH is found and started there; with no .envrc it is not", async () => {
  const p = project('found', 'PATH_add bin # found');
  const n = direnvCalls().length, m = serverCalls().length;
  await run('eglot', p.b);
  const s = Ed.lsp.sessionOf(p.b);
  assert.equal(serverCalls().length, m + 1, 'the command returns once the server runs');
  const direnv = direnvCalls().slice(n);
  assert.equal(direnv.length, 1);
  assert.deepEqual(direnv[0].argv, ['direnv', 'export', 'json'], 'only ever export json: never allow');
  assert.equal(direnv[0].opts.cwd, p.root, "direnv runs in the server's root, not the file's directory");
  const call = serverCalls()[m];
  assert.equal(call.opts.cwd, p.root);
  assert.equal(call.opts.env!.PATH!.split(':')[0], path.join(p.root, 'bin'), "the root's bin first on the PATH it is given");
  assert.equal(call.opts.env!.LSP_FROM_DIRENV, 'PATH_add bin # found');
  await Ed.lsp.ready(s);
  assert.equal(s.state, 'running');
  assert.deepEqual(p.log().slice(0, 3), ['env PATH_add bin # found', 'initialize', 'initialized'], 'the server has the environment');

  /* a project with no .envrc: the same server is on no PATH; the command says so, no session is kept */
  const q = project('plain', null);
  const k = direnvCalls().length;
  await assert.rejects(run('eglot', q.b), (e: unknown) => isErr('process-error')(e) && new RegExp(`cannot run ${SERVER_NAME}`).test(Ed.errorText(e)));
  assert.equal(direnvCalls().length, k, 'no .envrc above it: direnv is not asked');
  assert.equal(Ed.lsp.sessionOf(q.b), null);
  assert.equal(on(q.b), false);
  await until(() => Ed.lsp.sessions().length === 1, 'only the first session kept');
  assert.equal(q.log().length, 0);
  assert.ok(direnvCalls().every(c => c.argv.join(' ') === 'direnv export json'));
});

test('each start asks again: a start again after a crash and eglot-reconnect after the .envrc changed get its new environment', async () => {
  Object.assign(Ed.lsp.timing, { restartDelay: 20 });
  const p = project('again', 'one');
  await run('eglot', p.b);
  const s = Ed.lsp.sessionOf(p.b);
  await Ed.lsp.ready(s);
  const n = direnvCalls().length;
  /* a crash: started again from the environment kept for the unchanged .envrc, direnv not run again */
  s.proc.kill('KILL');
  await until(() => s.state === 'running' && s.restarts === 1, 'started again');
  assert.equal(direnvCalls().length, n, 'the .envrc unchanged: its environment kept');
  assert.equal(serverCalls().at(-1)!.opts.env!.LSP_FROM_DIRENV, 'one');
  /* the .envrc changed: the next crash's start asks direnv again */
  fs.writeFileSync(p.envrc, 'two, longer\n');
  s.proc.kill('KILL');
  await until(() => s.state === 'running' && s.restarts === 2, 'started again');
  assert.equal(direnvCalls().length, n + 1);
  assert.equal(serverCalls().at(-1)!.opts.env!.LSP_FROM_DIRENV, 'two, longer');
  /* eglot-reconnect: a new session in the environment as it is now */
  fs.writeFileSync(p.envrc, 'three, longer still\n');
  await run('eglot-reconnect', p.b);
  const fresh = Ed.lsp.sessionOf(p.b);
  assert.notEqual(fresh, s);
  assert.equal(direnvCalls().length, n + 2);
  assert.equal(serverCalls().at(-1)!.opts.env!.LSP_FROM_DIRENV, 'three, longer still');
  await Ed.lsp.ready(fresh);
  assert.ok(p.log().includes('env three, longer still'));
});

test('a visit does not wait for a slow direnv: eglot-mode on at once, one session for the root, the server once direnv answers; C-g stops neither', async () => {
  const p = project('slow', 'slow');
  fs.writeFileSync(p.envrc + '.slow', '600');
  const m = serverCalls().length, n = direnvCalls().length;
  Ed.setWindowBuffer(p.b);
  L.call('lsp--ensure', []);
  assert.equal(on(p.b), true, 'eglot-mode is on at once');
  const s = Ed.lsp.sessionOf(p.b);
  assert.equal(s.state, 'starting');
  assert.equal(s.proc, null, 'no server before direnv answers');
  /* a second buffer of the root meanwhile: the same session, no second direnv or server */
  const b2 = Ed.getBufferCreate('slow/b.fake');
  b2.file = path.join(p.root, 'b.fake'); b2.mode = 'fake-mode';
  fs.writeFileSync(b2.file, '');
  await run('eglot-mode', b2);
  assert.equal(Ed.lsp.sessionOf(b2), s);
  /* C-g while direnv runs, no command waiting on it: direnv goes on (the key is not taken for it) */
  await sleep(100);
  const direnv = direnvCalls().slice(n);
  assert.equal(direnv.length, 1, 'one direnv for both');
  assert.ok(proc.running().includes(direnv[0].id), 'direnv still runs');
  Ed.feedKey('C-g');
  await sleep(50);
  assert.ok(proc.running().includes(direnv[0].id), 'C-g did not stop direnv');
  await Ed.lsp.ready(s);
  assert.equal(serverCalls().length, m + 1, 'one server');
  assert.equal(serverCalls()[m].opts.env!.LSP_FROM_DIRENV, 'slow');
  assert.equal(on(p.b), true); assert.equal(on(b2), true);
});

test('M-x eglot waits for direnv, and C-g quits that wait while the start goes on', async () => {
  const p = project('quit', 'quit');
  fs.writeFileSync(p.envrc + '.slow', '600');
  const m = serverCalls().length;
  Ed.setWindowBuffer(p.b);
  const waited = L.call('eglot', []);
  waited.catch(() => {});
  await sleep(100);
  Ed.feedKey('C-g');
  await assert.rejects(waited, isErr('quit'), 'the command quits');
  const s = Ed.lsp.sessionOf(p.b);
  assert.equal(s.state, 'starting');
  await Ed.lsp.ready(s);
  assert.equal(serverCalls().length, m + 1, 'the server started once direnv answered');
});

test('shut down, or reconnected, while direnv runs: no server from that start', async () => {
  const p = project('down', 'down');
  fs.writeFileSync(p.envrc + '.slow', '300');
  const m = serverCalls().length;
  Ed.setWindowBuffer(p.b);
  L.call('lsp--ensure', []);
  const s = Ed.lsp.sessionOf(p.b);
  assert.equal(s.state, 'starting');
  run('eglot-shutdown', p.b);
  assert.equal(on(p.b), false);
  await until(() => direnvCalls().every(c => !proc.running().includes(c.id)), 'direnv done');
  await sleep(50);
  assert.equal(serverCalls().length, m, 'no server started for a session shut down');
  assert.equal(s.state, 'stopped');
  assert.deepEqual(Ed.lsp.sessions(), []);
  /* a reconnect while the first start's direnv runs: one server, the reconnected session's */
  fs.writeFileSync(p.envrc, 'down, again\n');
  L.call('lsp--ensure', []);
  const t = Ed.lsp.sessionOf(p.b);
  const fresh = await Ed.lsp.reconnect(t);
  await Ed.lsp.ready(fresh);
  await sleep(50);
  assert.equal(serverCalls().length, m + 1, 'only the reconnected session started a server');
  assert.equal(t.state, 'stopped');
  assert.equal(proc.running().filter(id => serverCalls().some(c => c.id === id)).length, 1);
});

test('no environment (envFor refused or failing): the start fails, said, eglot-mode off, no session kept', async () => {
  const p = project('noenv', 'noenv');
  const envFor = Ed.proc.envFor;
  Ed.proc.envFor = () => Promise.reject(new L.S.SchemeError('process-error', 'direnv was stopped', []));
  try {
    await assert.rejects(run('eglot', p.b), (e: unknown) => isErr('process-error')(e) && /direnv was stopped/.test(Ed.errorText(e)));
    Ed.setWindowBuffer(p.b);
    L.call('lsp--ensure', []);
    assert.equal(on(p.b), true);
    await until(() => !on(p.b), 'eglot-mode off once the start failed');
    assert.match(E.echo, /^eglot: .*direnv was stopped/);
  } finally { Ed.proc.envFor = envFor; }
  assert.equal(Ed.lsp.sessionOf(p.b), null);
  await until(() => Ed.lsp.sessions().length === 0, 'no session kept');
});
