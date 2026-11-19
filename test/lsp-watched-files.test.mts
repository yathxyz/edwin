// Watched files (src/lsp.ts, workspace/didChangeWatchedFiles) in the headless runtime: a stand-in server, a real
// child through Ed.proc (fake-proc.mts), registers glob watchers when the suite tells it to and logs what it is
// told. The changes come from Ed.Store's writes and removals (editor-core.ts), global-auto-revert-mode's look
// (editor-prims.ts) and a dired listing read again (dired.ts), over a real directory with host.files as
// host-native.ts shapes it (stamps, a temporary directory, a tree). Absence is shown by a sentinel: a change to a
// watched file made after the one under test, which arrives after it on the same pipe.
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
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: unknown; dirs?: unknown; private?: boolean };
host.proc = proc;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-watched-')));
const HOME = path.join(tmp, 'home'), DIR = path.join(HOME, 'proj'), OTHER = path.join(HOME, 'other'), TEMP = path.join(DIR, 'tmp');
for (const d of [path.join(DIR, '.git'), path.join(DIR, 'sent'), path.join(DIR, 'sub', 'deeper'), OTHER, TEMP]) fs.mkdirSync(d, { recursive: true });
const at = (p: string) => path.join(DIR, p);
const BIG = path.join(DIR, 'big');
fs.mkdirSync(BIG);
const big = Array.from({ length: 10001 }, (_, i) => `n${i}.conf`);
/* VAR's names are whatever the test sets: a listing crossing the bound either way. */
const VAR = path.join(DIR, 'var');
fs.mkdirSync(VAR);
let varNames: string[] = [];
const replace = (p: string, text: string) => { fs.writeFileSync(p + '.new', text); fs.renameSync(p + '.new', p); };

let exists = 0;
const resolve = (n: string) => (n.startsWith('/') ? path.normalize(n) : path.resolve(DIR, n));
host.files = {
  resolve, cwd: DIR, temp: [TEMP],
  truename: (n: string) => { const p = resolve(n); try { return fs.realpathSync(p); } catch (e) { return p; } },
  label: (p: string) => p,
  read(n: string) { try { return fs.readFileSync(resolve(n), 'utf8'); } catch (e) { return null; } },
  write(n: string, t: string) { fs.mkdirSync(path.dirname(resolve(n)), { recursive: true }); replace(resolve(n), t); },
  remove(n: string) { fs.rmSync(resolve(n), { force: true }); },
  list: () => [] as string[],
  exists: (n: string) => { exists++; return fs.existsSync(resolve(n)); },
  stamp(n: string) { try { const s = fs.statSync(resolve(n), { bigint: true }); return s.isDirectory() ? null : `${s.ino}:${s.mtimeNs}:${s.size}`; } catch (e) { return null; } },
  tree: {
    entry(p: string) {
      if (path.dirname(p) === BIG || path.dirname(p) === VAR) return { kind: 'file', size: 1, mtime: 0, mode: 0o644 };
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) { return null; }
      return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
    },
    /* BIG holds 10001 names that are not there, each read turning them by one: a listing cut at 10000 keeps
       another set of them every time */
    names: (d: string) => (d === BIG ? (big.push(big.shift()!), big.slice()) : d === VAR ? varNames.slice() : fs.readdirSync(d)),
    rename: (src: string, dst: string) => fs.renameSync(src, dst),
    copy: (src: string, dst: string) => fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: true }),
    rmdir: (p: string, recursive: boolean) => (recursive ? fs.rmSync(p, { recursive: true }) : fs.rmdirSync(p)),
    mkdir: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
  },
};
host.dirs = { home: HOME, cwd: DIR, config: path.join(HOME, '.config/edwin'), state: path.join(HOME, '.local/state/edwin') };
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
L.evalText('(set! corfu-auto #f)');
/* The look runs by hand: the timer never fires. */
L.evalText('(set! auto-revert-interval 3600)');
L.evalText(`(define-language fake-mode "Fake" :files '("\\\\.fake$"))`);
after(async () => {
  await Ed.lsp.shutdownAll();
  for (const id of proc.running()) proc.kill(id, 'KILL');
  L.evalText('(global-auto-revert-mode 0)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DEFAULTS = { ...Ed.lsp.timing };
beforeEach(async () => {
  await Ed.lsp.shutdownAll();
  for (const b of E.buffers.slice()) if (b.file || b.dired) { b.modified = false; L.call('kill-buffer', [b]); }
  Object.assign(Ed.lsp.timing, DEFAULTS);
  host.private = false;
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
const look = (): number => L.call('auto-revert-buffers', []);

/* The stand-in: node SCRIPT LOG. Each message it gets is logged as its JSON; a test/send notification makes it send
   its params to the client. */
const FAKE = `
const fs = require('fs');
const [log] = process.argv.slice(2);
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
let buf = Buffer.alloc(0);
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1]);
    if (buf.length < end + 4 + n) return;
    const text = buf.subarray(end + 4, end + 4 + n).toString('utf8');
    buf = buf.subarray(end + 4 + n);
    fs.appendFileSync(log, text + '\\n');
    const m = JSON.parse(text);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } });
    else if (m.method === 'test/send') send(m.params);
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
let logs = 0;
type Msg = { id?: string | number; method?: string; params?: any; result?: unknown }; // any: what the stand-in was sent
let log = '';
/* The messages logged so far: the stand-in may be writing a last line, so only the text before the last newline is
   read. */
const lines = (): Msg[] => { const t = fs.readFileSync(log, 'utf8'); return t.slice(0, t.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(l => JSON.parse(l)); };
/* The changes the server was told of, by notification, each [path relative to DIR (or absolute outside it), type]. */
const told = () => lines().filter(m => m.method === 'workspace/didChangeWatchedFiles').map(m => (m.params.changes as { uri: string; type: number }[]).map(c => {
  const p = decodeURIComponent(c.uri.replace(/^file:\/\//, ''));
  return [p.startsWith(DIR + '/') ? p.slice(DIR.length + 1) : p, c.type] as [string, number];
}));

type Session = { conn: { notify(m: string, p: unknown): void }; state: string; proc: { id?: number } | null };
const SENTINEL = at('sent/sentinel');
/* A fresh log, the stand-in declared for fake-mode, a .fake file of DIR visited and its server ready, the sentinel
   watched (a registration of its own, id sentinel). */
async function serve(): Promise<Session> {
  log = path.join(tmp, `log-${++logs}`);
  fs.writeFileSync(log, '');
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(log)}))`);
  fs.writeFileSync(at('main.fake'), 'main\n');
  const b = L.call('find-file', [at('main.fake')]);
  const s = Ed.lsp.sessionOf(b);
  assert.ok(s, 'the .fake file has a session');
  await Ed.lsp.ready(s);
  await watch(s, [{ globPattern: '**/sentinel' }], 'sentinel');
  return s;
}
let regs = 0;
/* S's server sends the request METHOD with PARAMS, and Edwin has answered. */
async function ask(s: Session, method: string, params: unknown) {
  const rid = `req-${++regs}`;
  s.conn.notify('test/send', { jsonrpc: '2.0', id: rid, method, params });
  await until(() => lines().some(m => m.id === rid && 'result' in m), `${method} answered`);
}
const WATCH = 'workspace/didChangeWatchedFiles';
/* S's server registers WATCHERS under ID (a new one by default) for METHOD (watched files by default). */
async function watch(s: Session, watchers: unknown[], id: unknown = `w${++regs}`, method = WATCH) {
  await ask(s, 'client/registerCapability', { registrations: [{ id, method, registerOptions: { watchers } }] });
  return id as string;
}
const unwatch = (s: Session, id: string, method = WATCH) => ask(s, 'client/unregisterCapability', { unregisterations: [{ id, method }] });
let sent = 0;
/* The changes told of while ACTION runs, the sentinel's left out: the sentinel is written after it, and once its
   change has arrived so has every change before it. */
async function changes(action: () => unknown): Promise<[string, number][]> {
  const n = told().length;
  await action();
  Ed.Store.set(SENTINEL, String(++sent));
  await until(() => told().slice(n).flat().some(([p]) => p === 'sent/sentinel'), 'the sentinel');
  return told().slice(n).flat().filter(([p]) => p !== 'sent/sentinel');
}
/* FILE (TEXT on disk first, unless null) visited as the current buffer. */
function visit(file: string, text: string | null) {
  if (text !== null) fs.writeFileSync(file, text);
  const b = L.call('find-file', [file]);
  Ed.setWindowBuffer(b); E.current = b;
  return b;
}
const save = (b: unknown) => { E.current = b; Ed.setWindowBuffer(b); L.call('save-buffer', []); };

test('the client offers watched files with relative patterns; with no watcher the hook is unset and a write asks nothing more', async () => {
  log = path.join(tmp, `log-${++logs}`);
  fs.writeFileSync(log, '');
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(log)}))`);
  fs.writeFileSync(at('main.fake'), 'main\n');
  const s = Ed.lsp.sessionOf(L.call('find-file', [at('main.fake')]));
  await Ed.lsp.ready(s);
  const init = lines().find(m => m.method === 'initialize')!;
  assert.deepEqual(init.params.capabilities.workspace.didChangeWatchedFiles, { dynamicRegistration: true, relativePatternSupport: true });
  assert.ok(!Ed.hooks.filesChanged, 'no hook while no server watches');
  const n = exists;
  Ed.Store.set(at('quiet.fake'), 'x\n');
  assert.equal(exists, n, 'the write asked nothing of the disk beyond the write');
  await watch(s, [{ globPattern: '**/*.fake' }]);
  assert.equal(typeof Ed.hooks.filesChanged, 'function', 'set once a server watches');
  Ed.Store.set(at('loud.fake'), 'x\n');
  assert.equal(exists, n + 1, 'a watched write asks whether the file was there');
  await until(() => told().length, 'the change told');
  assert.deepEqual(told(), [[['loud.fake', 1]]]);
  /* the suite's own reading of the log: a line the stand-in is still writing is not read yet (this log is not read
     again) */
  const k = lines().length;
  fs.appendFileSync(log, '{"jsonrpc":"2.0","met');
  assert.equal(lines().length, k, 'a part line is not read');
});

test('a save: an existing file changed, a new one created; only what a watcher matches, under the root, of any buffer\'s mode', async () => {
  const s = await serve();
  await watch(s, [{ globPattern: '**/*.fake' }, { globPattern: '**/build.conf' }]);
  const b = visit(at('sub/a.fake'), 'one\n');
  L.call('insert', ['zero ']);
  assert.deepEqual(await changes(() => save(b)), [['sub/a.fake', 2]]);
  const nb = visit(at('sub/new.fake'), null);
  L.call('insert', ['fresh\n']);
  assert.deepEqual(await changes(() => save(nb)), [['sub/new.fake', 1]]);
  /* a file of a mode with no server: the session still hears of it */
  const conf = visit(at('build.conf'), 'a = 1\n');
  assert.equal(Ed.lsp.sessionOf(conf), null, 'build.conf has no server');
  L.call('insert', ['b = 2\n']);
  assert.deepEqual(await changes(() => save(conf)), [['build.conf', 2]]);
  /* not matched: another name, and a .fake outside the root (a relative pattern is the root's) */
  const txt = visit(at('notes.txt'), 'n\n');
  L.call('insert', ['m']);
  const out = visit(path.join(OTHER, 'x.fake'), 'x\n');
  L.call('insert', ['y']);
  assert.deepEqual(await changes(() => { save(txt); save(out); }), []);
});

test('Ed.Store\'s removal of a file that was there is told as deleted; of one that was not, nothing', async () => {
  const s = await serve();
  await watch(s, [{ globPattern: '**/*.fake' }]);
  fs.writeFileSync(at('gone.fake'), 'g\n');
  assert.deepEqual(await changes(() => { Ed.Store.del(at('gone.fake')); Ed.Store.del(at('never.fake')); }), [['gone.fake', 3]]);
});

test('a watcher\'s kind: create only, change only, delete only, none', async () => {
  const s = await serve();
  await watch(s, [{ globPattern: '**/c.fake', kind: 1 }, { globPattern: '**/m.fake', kind: 2 }, { globPattern: '**/d.fake', kind: 4 }, { globPattern: '**/z.fake', kind: 0 }]);
  const all = async (name: string) => changes(() => { Ed.Store.set(at(name), '1'); Ed.Store.set(at(name), '2'); Ed.Store.del(at(name)); });
  assert.deepEqual(await all('c.fake'), [['c.fake', 1]]);
  assert.deepEqual(await all('m.fake'), [['m.fake', 2]]);
  assert.deepEqual(await all('d.fake'), [['d.fake', 3]]);
  assert.deepEqual(await all('z.fake'), []);
});

test('relative patterns: a base by URI and by workspace folder; an absolute string pattern; nothing outside the root, whatever the pattern', async () => {
  const s = await serve();
  await watch(s, [
    { globPattern: { baseUri: Ed.lsp.uri(at('sub')), pattern: '*.fake' } },
    { globPattern: { baseUri: { uri: Ed.lsp.uri(OTHER), name: 'other' }, pattern: '**/*.fake' } },
    { globPattern: `${DIR}/abs/*.fake` },
    { globPattern: 'top/*.fake' },
  ]);
  const w = (p: string) => () => Ed.Store.set(p, 'x');
  assert.deepEqual(await changes(w(at('sub/r.fake'))), [['sub/r.fake', 1]]);
  assert.deepEqual(await changes(w(at('sub/deeper/r.fake'))), [], '* stays in its segment');
  assert.deepEqual(await changes(w(at('r.fake'))), [], 'not under the base');
  assert.deepEqual(await changes(w(path.join(OTHER, 'o.fake'))), [], 'a base outside the root');
  assert.deepEqual(await changes(w(at('abs/q.fake'))), [['abs/q.fake', 1]]);
  assert.deepEqual(await changes(w(at('top/t.fake'))), [['top/t.fake', 1]], 'a string pattern is the root\'s');
  await watch(s, [{ globPattern: '/**' }]);
  assert.deepEqual(await changes(w(path.join(HOME, '.dotfile'))), [], '/** outside the root');
  assert.deepEqual(await changes(w(at('any.txt'))), [['any.txt', 1]], '/** under it');
});

test('global-auto-revert-mode\'s look: changed, deleted once over two looks, back as created; a save then a look tells once; a modified buffer is not looked at', async () => {
  const s = await serve();
  await watch(s, [{ globPattern: '**/*.conf' }]);
  const b = visit(at('build.conf'), 'a = 1\n');
  assert.deepEqual(await changes(() => { replace(at('build.conf'), 'a = 2\n'); assert.equal(look(), 1); }), [['build.conf', 2]]);
  assert.equal(b.text, 'a = 2\n');
  assert.deepEqual(await changes(() => { fs.rmSync(at('build.conf')); look(); look(); }), [['build.conf', 3]]);
  assert.deepEqual(await changes(() => { fs.writeFileSync(at('build.conf'), 'a = 3\n'); look(); look(); }), [['build.conf', 1]]);
  assert.equal(b.text, 'a = 3\n');
  L.call('insert', ['# ']);
  assert.deepEqual(await changes(() => { save(b); look(); }), [['build.conf', 2]], 'the save is told, the next look finds nothing new');
  /* gone and back with the same stamp: still told as created */
  assert.deepEqual(await changes(() => { fs.renameSync(at('build.conf'), at('aside')); look(); fs.renameSync(at('aside'), at('build.conf')); look(); }), [['build.conf', 3], ['build.conf', 1]]);
  /* a file visited before it existed: the looks before it is there tell nothing (it was never deleted); made by
     another program, it is created */
  const nb = visit(at('later.conf'), null);
  assert.deepEqual(await changes(() => { look(); look(); }), [], 'a file not yet there is not deleted');
  assert.deepEqual(await changes(() => { fs.writeFileSync(at('later.conf'), 'l\n'); look(); }), [['later.conf', 1]]);
  assert.equal(nb.text, 'l\n');
  E.current = b; L.call('insert', ['x']);
  assert.ok(b.modified);
  assert.deepEqual(await changes(() => { replace(at('build.conf'), 'other\n'); look(); }), []);
  b.modified = false;
});

test('a dired listing read again tells the names that came and went', async () => {
  const s = await serve();
  await watch(s, [{ globPattern: '**/*.conf' }]);
  await L.call('dired', [at('sub')]);
  await Ed.whenIdle();
  const d = E.buffers.find((x: { dired?: unknown }) => x.dired);
  assert.ok(d && d.autoRevert, 'the listing follows its directory');
  const shown = (name: string, there: boolean) => until(() => d.text.includes(name) === there, `${name} ${there ? 'listed' : 'gone from the listing'}`);
  assert.deepEqual(await changes(async () => { fs.writeFileSync(at('sub/made.conf'), 'm\n'); look(); await shown('made.conf', true); }), [['sub/made.conf', 1]]);
  assert.deepEqual(await changes(async () => { fs.rmSync(at('sub/made.conf')); look(); await shown('made.conf', false); }), [['sub/made.conf', 3]]);
  /* dired's own delete (D, then y): told by the listing it reads again */
  assert.deepEqual(await changes(async () => { fs.writeFileSync(at('sub/own.conf'), 'o\n'); look(); await shown('own.conf', true); }), [['sub/own.conf', 1]]);
  assert.deepEqual(await changes(async () => {
    E.current = d; Ed.setWindowBuffer(d);
    d.pt = Ed.lineStartB(d, d.text.split('\n').findIndex((l: string) => l.endsWith(' own.conf')) + 1);
    for (const k of ['D', 'y']) { Ed.feedKey(k); await Ed.whenIdle(); }
    await until(() => !fs.existsSync(at('sub/own.conf')), 'own.conf deleted');
    await shown('own.conf', false);
  }), [['sub/own.conf', 3]]);
  /* a listing cut at its bound, read again (g r) with another set of names kept: nothing told */
  await L.call('dired', [BIG]);
  await Ed.whenIdle();
  const bb = E.current;
  assert.equal(bb.dired.truncated, true);
  assert.ok(bb.autoRevert, 'the cut listing is still the program\'s own');
  assert.deepEqual(await changes(async () => { await L.call('dired-revert', []); await Ed.whenIdle(); }), []);
});

test('a listing opened tells nothing; one read again across the bound, cut or no longer cut, tells nothing', async () => {
  const s = await serve();
  await watch(s, [{ globPattern: '**/*.conf' }]);
  /* the first read of a new listing is no diff against an empty one */
  fs.mkdirSync(at('fresh dir'));
  fs.writeFileSync(at('fresh dir/x y.conf'), 'x\n');
  assert.deepEqual(await changes(async () => { await L.call('dired', [at('fresh dir')]); await Ed.whenIdle(); }), []);
  assert.ok(E.current.dired && E.current.autoRevert, 'the listing follows its directory');
  /* then a name made there is told, so the listing is one that tells */
  assert.deepEqual(await changes(async () => { fs.writeFileSync(at('fresh dir/z.conf'), 'z\n'); look(); await until(() => E.current.text.includes('z.conf'), 'z.conf listed'); }), [['fresh dir/z.conf', 1]]);
  /* a listing read again, now cut: z.conf is still there, past the cut */
  varNames = ['z.conf'];
  await L.call('dired', [VAR]);
  await Ed.whenIdle();
  const v = E.current;
  assert.equal(v.dired.truncated, false);
  varNames = [...Array.from({ length: 10000 }, (_, i) => `n${i}.conf`), 'z.conf'];
  assert.deepEqual(await changes(async () => { await L.call('dired-revert', []); await Ed.whenIdle(); }), []);
  assert.equal(v.dired.truncated, true);
  assert.ok(!v.text.includes('z.conf'), 'z.conf is past the cut');
  /* and read again no longer cut: the names kept out of the cut were there all along */
  varNames = ['n0.conf'];
  assert.deepEqual(await changes(async () => { await L.call('dired-revert', []); await Ed.whenIdle(); }), []);
  assert.equal(v.dired.truncated, false);
  assert.ok(v.text.includes('n0.conf'));
  /* a listing no longer cut does tell again */
  varNames = ['n0.conf', 'z.conf'];
  assert.deepEqual(await changes(async () => { await L.call('dired-revert', []); await Ed.whenIdle(); }), [['var/z.conf', 1]]);
});

test('unregistering stops a watcher, the others stay; a server started again holds none of its old ones', async () => {
  Ed.lsp.timing.restartDelay = 10;
  const s = await serve();
  const id = await watch(s, [{ globPattern: '**/*.fake' }]);
  assert.deepEqual(await changes(() => Ed.Store.set(at('u.fake'), '1')), [['u.fake', 1]]);
  await unwatch(s, id);
  assert.deepEqual(await changes(() => Ed.Store.set(at('u.fake'), '2')), []);
  assert.equal(typeof Ed.hooks.filesChanged, 'function', 'the sentinel still watches');
  /* the child killed: started again, it has registered nothing */
  await watch(s, [{ globPattern: '**/*.fake' }]);
  const before = proc.running();
  for (const p of before) proc.kill(p, 'KILL');
  await until(() => s.state === 'running' && proc.running().some(p => !before.includes(p)), 'the server started again');
  assert.ok(!Ed.hooks.filesChanged, 'no watcher survives the start again');
  /* and the new child hears nothing until it registers */
  const n = told().length;
  Ed.Store.set(at('u.fake'), '3');
  await sleep(200);
  assert.equal(told().length, n);
  await watch(s, [{ globPattern: '**/*.fake' }]);
  await until(() => { Ed.Store.set(at('u.fake'), String(Date.now())); return told().length > n; }, 'the new registration heard');
  await Ed.lsp.shutdown(s);
  assert.ok(!Ed.hooks.filesChanged, 'a shutdown drops its watchers');
});

test('registrations: only watched files under a string id; an id given again replaces its watchers, within the 256; an unregistration of another method keeps them', async () => {
  const s = await serve();
  await watch(s, [{ globPattern: '**/m.fake' }], 'other', 'workspace/didChangeConfiguration');
  await watch(s, [{ globPattern: '**/n.fake' }], 42);
  assert.deepEqual(await changes(() => { Ed.Store.set(at('m.fake'), 'x'); Ed.Store.set(at('n.fake'), 'x'); }), [], 'another method, a number id');
  await watch(s, [{ globPattern: '**/r1.fake' }], 'again');
  await watch(s, [{ globPattern: '**/r2.fake' }], 'again');
  assert.deepEqual(await changes(() => { Ed.Store.set(at('r1.fake'), 'x'); Ed.Store.set(at('r2.fake'), 'x'); }), [['r2.fake', 1]], 'the first watchers replaced');
  await unwatch(s, 'again', 'workspace/didChangeConfiguration');
  assert.deepEqual(await changes(() => Ed.Store.set(at('r2.fake'), 'y')), [['r2.fake', 2]], 'kept past an unregistration of another method');
  /* the sentinel and r2.fake hold 2 of 256: 254 fit under one id, and 254 others in their place fit again */
  await watch(s, Array.from({ length: 254 }, (_, i) => ({ globPattern: `**/g${i}.fake` })), 'many');
  await watch(s, Array.from({ length: 254 }, (_, i) => ({ globPattern: `**/h${i}.fake` })), 'many');
  assert.deepEqual(await changes(() => { Ed.Store.set(at('g253.fake'), 'x'); Ed.Store.set(at('h253.fake'), 'x'); }), [['h253.fake', 1]]);
});

test('a --private session and the temporary directory tell nothing', async () => {
  const s = await serve();
  await watch(s, [{ globPattern: '**/*.fake' }]);
  assert.deepEqual(await changes(() => Ed.Store.set(at('tmp/t.fake'), 'x')), [], 'under host.files.temp');
  assert.deepEqual(await changes(() => { host.private = true; try { Ed.Store.set(at('p.fake'), 'x'); } finally { host.private = false; } }), [], 'in a --private session');
  assert.deepEqual(await changes(() => Ed.Store.set(at('p.fake'), 'y')), [['p.fake', 2]], 'the same file told outside it');
});

test('the bounds: malformed and oversized watchers dropped, the rest of the registration kept; at most 256 alternatives a session', async () => {
  const s = await serve();
  await watch(s, [
    { globPattern: '**/k9.fake', kind: 9 },
    { globPattern: 42 },
    { globPattern: 'x'.repeat(1025) },
    { globPattern: '{a' },
    { globPattern: '{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}.fake' },
    { globPattern: { baseUri: 'http://example.com/', pattern: '*.fake' } },
    'not a watcher',
    { globPattern: '**/kept.fake' },
  ]);
  assert.deepEqual(await changes(() => { Ed.Store.set(at('k9.fake'), 'x'); Ed.Store.set(at('aaaaaaa.fake'), 'x'); Ed.Store.set(at('kept.fake'), 'x'); }), [['kept.fake', 1]]);
  /* the sentinel and kept.fake hold 2 of 256: f0 to f253 fit, f254 on do not */
  await watch(s, Array.from({ length: 300 }, (_, i) => ({ globPattern: `**/f${i}.fake` })));
  assert.deepEqual(await changes(() => { Ed.Store.set(at('f253.fake'), 'x'); Ed.Store.set(at('f254.fake'), 'x'); }), [['f253.fake', 1]]);
});

test('globs: *, **, ?, braces and sets, matched without backtracking', () => {
  const m = (p: string, s: string) => Ed.lsp.globMatches(p, s);
  assert.equal(m('**/*.rs', 'src/main.rs'), true);
  assert.equal(m('**/*.rs', 'main.rs'), true);
  assert.equal(m('**/*.rs', '/abs/x/main.rs'), true);
  assert.equal(m('**/*.rs', 'src/main.rsx'), false);
  assert.equal(m('*.rs', 'src/main.rs'), false);
  assert.equal(m('src/*', 'src/a/b'), false);
  assert.equal(m('src/**', 'src/a/b'), true);
  assert.equal(m('src/**', 'src'), false);
  assert.equal(m('**', 'any/thing/at/all'), true);
  assert.equal(m('a/**/b', 'a/b'), true);
  assert.equal(m('a/**/b', 'a/x/y/b'), true);
  assert.equal(m('a/**/b', 'ab'), false);
  assert.equal(m('?.go', 'a.go'), true);
  assert.equal(m('?.go', 'ab.go'), false);
  assert.equal(m('?/x', '//x'), false);
  assert.equal(m('**/*.{ts,tsx}', 'b/c.tsx'), true);
  assert.equal(m('**/*.{ts,tsx}', 'd.js'), false);
  assert.equal(m('{src,lib}/**/*.c', 'lib/x/y.c'), true);
  assert.equal(m('{a,{b,c}}.x', 'c.x'), true);
  assert.equal(m('[abc].txt', 'b.txt'), true);
  assert.equal(m('[!abc].txt', 'd.txt'), true);
  assert.equal(m('[!abc].txt', 'a.txt'), false);
  assert.equal(m('[^abc].txt', 'd.txt'), true);
  assert.equal(m('[^abc].txt', 'a.txt'), false);
  assert.equal(m('[a-c]x', 'bx'), true);
  assert.equal(m('[a-c]x', 'dx'), false);
  assert.equal(m('[]]', ']'), true);
  assert.equal(m('[!x]', '/'), false);
  assert.equal(m('a[b', 'a[b'), true);
  assert.equal(m('', 'x'), null);
  assert.equal(m('{a', 'a'), null);
  assert.equal(m('x'.repeat(1025), 'x'), null);
  assert.equal(m('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}', 'aaaaaaa'), null, '128 alternatives');
  assert.equal(m('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}', 'abbaba'), true, '64 alternatives');
  /* a pattern a backtracking matcher takes exponential time on */
  const t0 = Date.now();
  assert.equal(m('*a'.repeat(30) + '*b', 'a'.repeat(400)), false);
  assert.equal(m('**/'.repeat(30) + 'b', 'a/'.repeat(400)), false);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});
