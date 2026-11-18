/* Language server sessions (docs/steps.md, "Language server sessions"): one server process per project root and
   server, run through Ed.proc and spoken to through LspRpc (src/lsp-rpc.ts). A session initializes its server,
   starts it again with a growing delay when it ends on its own (up to a bound), stops it once no buffer has used
   it for a while, and shuts it down (shutdown, exit, then KILL past a short bound) when asked and when the
   program ends.

   The servers are declared by name, the major modes they serve and their argv (define-language-server, in
   scm/lsp.scm). A declaration made while the image replays is skipped, with a message: an argv the image set would
   otherwise run when the user next starts a server (R16.15). It is no error, so the forms after it in the same
   file (edwind's init.scm, which a served frame evaluates as the image) still run. A session copies its server's argv when it is made, so a later
   declaration never changes what a running session starts again.

   Only the desktop program has processes (Ed.proc): in a web frame and on edwind's Node host every start is
   refused, and a buffer whose file is edwind's (a note, a shared buffer) gets no server, its file not being on
   this machine. Nothing here waits on the server while a key is held: a start returns once the child runs, and
   the session says when it is ready. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD, D } = L;
const cur = () => E.current;

/* The bounds, in ms: initialize's answer; shutdown's answer, then the child's exit after exit, then after KILL
   (together under the 2 s a frame may block on quitting); the first delay before a start again, doubled each
   time, and how many starts again in a row before the session gives up; how long a server must have run for its
   end to count as a first one again; how long a session with no buffer lives. Mutable for the suites. */
const timing = { connect: 30_000, shutdown: 1000, exitWait: 400, killWait: 200, restartDelay: 1000, restartMax: 5, healthy: 60_000, idle: 300_000 };
/* The tail of a server's error output a session keeps (eglot-stderr-buffer). */
const STDERR_MAX = 64 * 1024;

const servers = new Map<string, LspServer>();
/* By server name and root. */
const sessions = new Map<string, Session>();
const ofBuffer = new WeakMap<EdBuffer, Session>();
/* Counts the shutdowns of every server, so a reconnect waiting across one starts nothing. */
let allDown = 0;

type State = 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'failed';
interface Session extends LspSession {
  key: string;
  state: State;
  argv: string[];
  proc: EdProc | null;
  conn: LspRpcConnection | null;
  capabilities: Record<string, unknown> | null;
  buffers: Set<EdBuffer>;
  restarts: number;
  started: number;
  why: string | null;
  /* tells a child's events from those of the one it replaced */
  gen: number;
  timer: ReturnType<typeof setTimeout> | null;
  idle: ReturnType<typeof setTimeout> | null;
  waiters: { resolve: () => void; reject: (e: unknown) => void }[];
  err: string;
  done: Promise<void> | null;
}

const lspError = (msg: string) => new L.S.SchemeError('lsp-error', msg, []);
const parentOf = (p: string) => { const k = p.replace(/\/+$/, '').lastIndexOf('/'); return k <= 0 ? '/' : p.slice(0, k); };
const join = (d: string, n: string) => (d.endsWith('/') ? d + n : d + '/' + n);
function abbr(dir: string) {
  const home = Ed.host.dirs ? Ed.host.dirs.home.replace(/\/$/, '') : '';
  return home && (dir === home || dir.startsWith(home + '/')) ? '~' + dir.slice(home.length) : dir;
}
const label = (s: Session) => `${s.name} in ${abbr(s.root)}`;

/* A file: URI for the absolute path P: each segment percent-encoded as UTF-8. */
function uri(p: string) {
  return 'file://' + p.split('/').map(encodeURIComponent).join('/');
}

/* ---- the servers ---- */

function define(name: string, modes: string[], argv: string[]): LspServer | null {
  if (Ed.proc.replaying()) {
    Ed.message(`define-language-server: ${typeof name === 'string' ? name : 'a server'} is not declared while the image replays`);
    return null;
  }
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9+._-]*$/i.test(name)) signal('lsp-error', 'define-language-server: the name is not a plain symbol:', name);
  if (!Array.isArray(modes) || !modes.length || modes.some(m => typeof m !== 'string' || !m)) signal('lsp-error', `define-language-server: :modes needs a non-empty list of modes for ${name}`);
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string') || !argv[0]) signal('lsp-error', `define-language-server: :command needs a non-empty list of strings, the program first, for ${name}`);
  const s = { name, modes: modes.slice(), argv: argv.slice() };
  servers.delete(name);
  servers.set(name, s);
  return s;
}
/* The server for buffer B's major mode: the one declared last among those that serve it. */
function serverFor(b: EdBuffer): LspServer | null {
  let found: LspServer | null = null;
  for (const s of servers.values()) if (s.modes.includes(b.mode)) found = s;
  return found;
}
/* Where B's server runs: the nearest directory up from its file's with a .git or a .jj, else the file's own.
   Null for a buffer with no file, a file of edwind's (a note, a shared buffer: not on this machine) and a host
   with no file system. */
function rootOf(b: EdBuffer): string | null {
  const f = Ed.host.files;
  if (!f || !b.file || b.shared) return null;
  if (Ed.sync && Ed.sync.started && H.servedPath && H.servedPath(b.file)) return null;
  const d = parentOf(f.resolve(b.file));
  for (let p = d; ; p = parentOf(p)) {
    if (f.exists(join(p, '.git')) || f.exists(join(p, '.jj'))) return p;
    if (p === '/') return d;
  }
}

/* ---- a session's server ---- */

function settleWaiters(s: Session, err?: unknown) {
  const ws = s.waiters; s.waiters = [];
  for (const w of ws) { if (err === undefined) w.resolve(); else w.reject(err); }
}
function clearTimers(s: Session) {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (s.idle) { clearTimeout(s.idle); s.idle = null; }
}

/* What the server asks of the client. Settings are lsp-servers'; until then every item is null (the server's
   defaults). */
function serverRequests(s: Session): Record<string, (params: unknown) => unknown> {
  return {
    'workspace/configuration': (p: unknown) => {
      const items = p && typeof p === 'object' && Array.isArray((p as { items?: unknown }).items) ? (p as { items: unknown[] }).items : [];
      return items.map(() => null);
    },
    'workspace/workspaceFolders': () => [{ uri: uri(s.root), name: s.root.split('/').pop() || s.root }],
    'client/registerCapability': () => null,
    'client/unregisterCapability': () => null,
    'window/workDoneProgress/create': () => null,
    'window/showMessageRequest': () => null,
  };
}
const MESSAGE_TYPES = ['', 'error', 'warning', 'info', 'log'];
function notified(s: Session, method: string, params: unknown) {
  if (method === 'window/showMessage' && params && typeof params === 'object') {
    const { type, message } = params as { type?: unknown; message?: unknown };
    if (typeof message === 'string' && (type === 1 || type === 2)) Ed.message(`${s.name}: ${MESSAGE_TYPES[type as number]}: ${message.slice(0, 500)}`);
  }
}
function stderr(s: Session, text: string) {
  s.err += text;
  if (s.err.length > STDERR_MAX * 2) s.err = s.err.slice(-STDERR_MAX);
}

function initializeParams(s: Session) {
  const name = s.root.split('/').pop() || s.root;
  return {
    processId: null,
    clientInfo: { name: 'Edwin' },
    rootPath: s.root,
    rootUri: uri(s.root),
    workspaceFolders: [{ uri: uri(s.root), name }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      workspace: { configuration: true, workspaceFolders: true },
      window: { workDoneProgress: false, showMessage: {} },
    },
  };
}

/* Start S's server: the child at once (a refusal, a missing program, throws here, before any wait), initialize
   once it answers. */
function launch(s: Session) {
  const gen = s.gen + 1;
  let p: EdProc | null = null;
  const conn = LspRpc.connect({
    write: t => (p ? p.write(t) : false),
    requests: serverRequests(s),
    onNotification: (m, params) => { if (s.gen === gen) notified(s, m, params); },
    onClose: why => { if (s.gen === gen) lost(s, gen, why); },
  });
  try {
    p = Ed.proc.spawn(s.argv, { cwd: s.root, onOut: c => conn.receive(c), onErr: t => { if (s.gen === gen) stderr(s, t); } });
  } catch (e) { conn.close('not started'); throw e; }
  s.gen = gen; s.state = 'starting'; s.capabilities = null;
  s.proc = p; s.conn = conn; s.started = Date.now();
  p.exit.then(x => {
    if (s.gen !== gen) return;
    lost(s, gen, x.error ? x.error : x.signal ? `killed by ${x.signal}` : `exited with code ${x.code}`);
  });
  conn.request('initialize', initializeParams(s), { timeout: timing.connect }).then(res => {
    if (s.gen !== gen) return;
    const caps = res && typeof res === 'object' ? (res as { capabilities?: unknown }).capabilities : null;
    s.capabilities = caps && typeof caps === 'object' ? caps as Record<string, unknown> : {};
    try { conn.notify('initialized', {}); } catch (e) { return; }   // closed: lost has run
    s.state = 'running'; s.why = null;
    Ed.message(`${label(s)}: ready`);
    settleWaiters(s);
  }, e => { if (s.gen === gen) lost(s, gen, Ed.errorText(e)); });
}

/* S's server ended, its stream broke or its initialize failed, without being asked to: the child is killed if it
   still runs, and started again after a delay that doubles each time, unless it has been started again
   timing.restartMax times in a row (a server that ran timing.healthy starts the count again). */
function lost(s: Session, gen: number, why: string) {
  if (s.gen !== gen || s.state === 'stopping' || s.state === 'stopped') return;
  s.gen++;
  const { proc, conn } = s;
  s.proc = null; s.conn = null; s.capabilities = null;
  if (conn) conn.close(why);
  if (proc) proc.kill('KILL');
  s.why = why;
  if (Date.now() - s.started >= timing.healthy) s.restarts = 0;
  if (s.restarts >= timing.restartMax) {
    s.state = 'failed';
    Ed.message(`${label(s)}: ${why}; it ended ${s.restarts + 1} times in a row, so it is not started again (M-x eglot-reconnect starts it)`);
    settleWaiters(s, lspError(`${label(s)}: ${why}`));
    return;
  }
  const delay = timing.restartDelay * 2 ** s.restarts;
  s.restarts++;
  s.state = 'restarting';
  Ed.message(`${label(s)}: ${why}; starting it again in ${delay / 1000} s`);
  s.timer = setTimeout(() => {
    s.timer = null;
    if (s.state !== 'restarting') return;
    s.started = Date.now();   // a start refused here is no healthy run
    try { launch(s); } catch (e) { lost(s, s.gen, Ed.errorText(e)); }
  }, delay);
}

/* Shut S's server down: shutdown, exit and its input closed, then KILL when it has not ended within the bounds.
   The session is forgotten at once, so a start after this makes a new one. */
function shutdown(s: Session): Promise<void> {
  if (s.done) return s.done;
  clearTimers(s);
  if (sessions.get(s.key) === s) sessions.delete(s.key);
  for (const b of s.buffers) if (ofBuffer.get(b) === s) ofBuffer.delete(b);
  s.buffers.clear();
  const wasRunning = s.state === 'running';
  s.state = 'stopping';
  settleWaiters(s, lspError(`${label(s)}: shut down`));
  const { proc, conn } = s;
  s.done = (async () => {
    if (proc && conn && conn.closed() === null) {
      if (wasRunning) { try { await conn.request('shutdown', null, { timeout: timing.shutdown }); } catch (e) { /* past its bound: exit, then KILL */ } }
      try { conn.notify('exit'); } catch (e) { /* its input is closed */ }
    }
    if (proc) {
      try { proc.closeStdin(); } catch (e) { /* ended */ }
      const within = (ms: number) => Promise.race([proc.exit.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))]);
      if (!await within(timing.exitWait)) { proc.kill('KILL'); await within(timing.killWait); }
    }
    if (conn) conn.close('shut down');
    s.proc = null; s.conn = null; s.capabilities = null;
    s.state = 'stopped';
  })();
  return s.done;
}
function shutdownAll(): Promise<void> {
  allDown++;
  return Promise.all([...sessions.values()].map(shutdown)).then(() => {});
}

/* ---- buffers ---- */

function attach(s: Session, b: EdBuffer) {
  const was = ofBuffer.get(b);
  if (was && was !== s) detach(b);
  s.buffers.add(b); ofBuffer.set(b, s);
  if (s.idle) { clearTimeout(s.idle); s.idle = null; }
}
/* B no longer uses its session; a session no buffer uses is shut down after timing.idle. */
function detach(b: EdBuffer) {
  const s = ofBuffer.get(b);
  if (!s) return;
  ofBuffer.delete(b); s.buffers.delete(b);
  idleWhenUnused(s);
}
function idleWhenUnused(s: Session) {
  if (!s.buffers.size && !s.idle && s.state !== 'stopping' && s.state !== 'stopped')
    s.idle = setTimeout(() => { s.idle = null; if (!s.buffers.size) void shutdown(s); }, timing.idle);
}

/* The session of B's server and root, started (or started again, when it had given up) and B attached to it.
   Throws lsp-error when B has no server or no root here, and process-error when no child can start. */
function start(b: EdBuffer): Session {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const server = serverFor(b);
  if (!server) signal('lsp-error', `No language server is declared for ${b.mode}`);
  const root = rootOf(b);
  if (!root) signal('lsp-error', b.file ? `${b.name} is not a file on this machine: no language server for it` : `${b.name} visits no file: no language server for it`);
  const s = sessionAt(server!, root!);
  attach(s, b);
  return s;
}
/* The session of SERVER in ROOT: the one kept there (started again when it had given up), else a new one. Every
   session is made here, so one root and server never has two processes. */
function sessionAt(server: LspServer, root: string): Session {
  const s = sessions.get(`${server.name}\0${root}`);
  if (!s) return open(server, root);
  if (s.state === 'failed') { s.restarts = 0; launch(s); Ed.message(`${label(s)}: starting`); }
  return s;
}
/* A new session of SERVER in ROOT, its child started (a refusal throws before the session is kept). */
function open(server: LspServer, root: string): Session {
  const s: Session = {
    key: `${server.name}\0${root}`, name: server.name, root, argv: server.argv.slice(), state: 'starting', proc: null,
    conn: null, capabilities: null, buffers: new Set(), restarts: 0, started: 0, why: null, gen: 0, timer: null,
    idle: null, waiters: [], err: '', done: null,
  };
  launch(s);
  sessions.set(s.key, s);
  Ed.message(`${label(s)}: starting`);
  return s;
}
/* A promise that settles when S's server has been initialized, or rejects when it is shut down or gives up. */
function ready(s: Session): Promise<void> {
  if (s.state === 'running') return Promise.resolve();
  if (s.state === 'failed' || s.state === 'stopping' || s.state === 'stopped') return Promise.reject(lspError(`${label(s)}: ${s.state}`));
  return new Promise((resolve, reject) => { s.waiters.push({ resolve, reject }); });
}
/* S shut down and started afresh (with its server's argv as declared now), its buffers attached to the new
   session. A session of the root and server made while S shut down (eglot in another buffer, a second reconnect)
   is the one used: no second process. A buffer killed while S shut down (detached by then, so its kill-buffer-hook
   found no session) is not attached; with none left the new session gets its idle stop like any other. Null, with
   a message, when every server was shut down while S shut down (eglot-shutdown-all, quitting): nothing starts. */
async function reconnect(s: Session): Promise<Session | null> {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', why);
  const bs = [...s.buffers], down = allDown;
  await shutdown(s);
  if (allDown !== down) { Ed.message(`${label(s)}: not started again: every language server was shut down`); return null; }
  const fresh = sessionAt(servers.get(s.name) || { name: s.name, modes: [], argv: s.argv }, s.root);
  for (const b of bs) if (E.buffers.includes(b)) attach(fresh, b);
  idleWhenUnused(fresh);
  return fresh;
}

/* ---- Scheme and commands ---- */

D('%lsp-declare', 'NAME MODES COMMAND', 'Declare the language server NAME for the major modes MODES, run as the argv COMMAND (define-language-server, scm/lsp.scm).',
  ([n, m, c]: SchemeValue[]) => {
    const name = n instanceof L.S.Sym ? n.name : n;
    const modes = L.arr(m).map(x => (x instanceof L.S.Sym ? x.name : x));
    return define(name as string, modes as string[], L.arr(c) as string[]) ? n : false;
  });
D('lsp--kill-buffer', '', 'kill-buffer-hook: the current buffer no longer uses its language server.', () => { detach(cur()); return false; });
L.addHook('kill-buffer-hook', intern('lsp--kill-buffer'));

const sessionHere = () => {
  const s = ofBuffer.get(cur());
  if (!s) signal('user-error', 'No language server for this buffer (M-x eglot starts one)');
  return s!;
};
CMD('eglot', '', '', "Start the language server for this buffer's mode in its project (the nearest directory up with a .git or a .jj, else the file's), or use the one already running there.", () => {
  const had = new Map([...sessions.values()].map(s => [s, s.state]));
  const s = start(cur());
  const was = had.get(s);
  if (was && was !== 'failed') Ed.message(`${label(s)}: ${s.state === 'running' ? 'already running' : s.state}`);
  return false;
});
CMD('eglot-shutdown', '', '', "Shut down this buffer's language server.", () => { void shutdown(sessionHere()); return false; });
CMD('eglot-shutdown-all', '', '', 'Shut down every language server.', () => { void shutdownAll(); return false; });
CMD('eglot-reconnect', '', '', "Shut down this buffer's language server and start it again.", async () => { await reconnect(sessionHere()); return false; });
CMD('eglot-stderr-buffer', '', '', "Show the last of what this buffer's language server wrote to its error output.", () => {
  const s = sessionHere();
  const b = Ed.getBufferCreate(`*EGLOT ${s.name} stderr*`);
  b.readOnly = false; b.text = s.err.slice(-STDERR_MAX); b.readOnly = true; b.modified = false;
  Ed.setWindowBuffer(b);
  return false;
});

Ed.lsp = {
  timing, uri, define, serverFor, rootOf, start, ready, shutdown, shutdownAll, reconnect,
  servers: () => [...servers.values()],
  sessions: () => [...sessions.values()],
  sessionOf: b => ofBuffer.get(b) || null,
  stderr: s => (s as Session).err.slice(-STDERR_MAX),
};
})();
