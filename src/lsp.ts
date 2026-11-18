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
   the session says when it is ready.

   Documents (docs/steps.md, "Document sync and eglot-mode"): a buffer attached to a session is a document its
   server is told of, as the server's textDocumentSync asks: didOpen once it is initialized (again after each
   start again), didChange as one change (a range, or the whole text) after an idle moment or before a request,
   didSave and didClose. eglot-mode is that attachment; visiting a file whose mode has a declared server turns it
   on. Positions are UTF-16 units, as LSP's default, the only encoding offered.

   Cross references (docs/steps.md, "Definition, references and implementation"): xref-find-definitions (g d,
   M-.), xref-find-references (g r, M-?), eglot-find-implementation, eglot-find-typeDefinition and
   eglot-find-declaration ask the buffer's server about point. A single place of a definition's kind is visited
   at once; references, and several places of any kind, are listed in *xref* (xref-mode: RET visits a row, o
   shows it, M-g n steps through them). Each visit first records where point was, which xref-go-back (M-, and
   C-t) returns to, across buffers. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD, D } = L;
const cur = () => E.current;

/* The bounds, in ms: initialize's answer; shutdown's answer, then the child's exit after exit, then after KILL
   (together under the 2 s a frame may block on quitting); the first delay before a start again, doubled each
   time, and how many starts again in a row before the session gives up; how long a server must have run for its
   end to count as a first one again; how long a session with no buffer lives; how long after an edit its change
   is sent (eglot's eglot-send-changes-idle-time); how long a cross-reference command waits for its server to be
   ready, then for its answer. Mutable for the suites. */
const timing = { connect: 30_000, shutdown: 1000, exitWait: 400, killWait: 200, restartDelay: 1000, restartMax: 5, healthy: 60_000, idle: 300_000, change: 500, request: 10_000 };
/* The tail of a server's error output a session keeps (eglot-stderr-buffer). */
const STDERR_MAX = 64 * 1024;

const servers = new Map<string, LspServer>();
/* By server name and root. */
const sessions = new Map<string, Session>();
const ofBuffer = new WeakMap<EdBuffer, Session>();
/* The documents the servers were told of, by buffer. */
const docs = new WeakMap<EdBuffer, Doc>();
/* eglot-mode's variable: on while the buffer is attached to a session. */
const MODE_VAR = 'eglot-enabled';
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

/* How a server wants documents synced (its textDocumentSync): whether opening and closing are told, changes as
   none (0), the whole text (1) or a range (2), and whether a save is told and with the text. */
interface Sync { openClose: boolean; change: number; save: { includeText: boolean } | null }
/* A buffer's document as its server holds it: the session and connection (the session's gen) it was opened on,
   the file, mode, URI and language it was opened with, the buffer's version and text the server last got, the
   pending change's timer. */
interface Doc {
  s: Session; gen: number; file: string; mode: string; uri: string; lang: string; ver: number; text: string; sync: Sync;
  timer: ReturnType<typeof setTimeout> | null;
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
      textDocument: {
        synchronization: { didSave: true },
        definition: { linkSupport: true }, declaration: { linkSupport: true }, typeDefinition: { linkSupport: true },
        implementation: { linkSupport: true }, references: {},
      },
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
    for (const b of s.buffers) openDoc(s, b);
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
  for (const b of s.buffers) if (ofBuffer.get(b) === s) { ofBuffer.delete(b); forgetDoc(b); setFlag(b, false); }
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

/* B uses S: eglot-mode is on in it, and its document is opened now when S runs, else once S is initialized. */
function attach(s: Session, b: EdBuffer) {
  const was = ofBuffer.get(b);
  if (was && was !== s) detach(b);
  setFlag(b, true);
  if (was === s) return;
  s.buffers.add(b); ofBuffer.set(b, s);
  if (s.idle) { clearTimeout(s.idle); s.idle = null; }
  if (s.state === 'running') openDoc(s, b);
}
/* B no longer uses its session: its document closed, eglot-mode off. A session no buffer uses is shut down after
   timing.idle. */
function detach(b: EdBuffer) {
  const s = ofBuffer.get(b);
  if (!s) return;
  closeDoc(b);
  ofBuffer.delete(b); s.buffers.delete(b);
  setFlag(b, false);
  idleWhenUnused(s);
}
function setFlag(b: EdBuffer, on: boolean) {
  if (!on && !(b.locals && b.locals.has(MODE_VAR))) return;
  Ed.makeLocal(b, MODE_VAR); b.locals!.set(MODE_VAR, on);
}

/* ---- documents ---- */

/* SYNC as the server's capabilities give it. A number is the change kind, with opening, closing and saving told
   (as VS Code's client takes it); an object says each; none says nothing is told. */
function syncOf(caps: Record<string, unknown> | null): Sync {
  const t = caps ? caps.textDocumentSync : undefined;
  const kind = (k: unknown) => (k === 1 || k === 2 ? k : 0);
  if (typeof t === 'number') return { openClose: true, change: kind(t), save: { includeText: false } };
  if (!t || typeof t !== 'object') return { openClose: false, change: 0, save: null };
  const o = t as { openClose?: unknown; change?: unknown; save?: unknown };
  const save = o.save === true ? { includeText: false } : o.save && typeof o.save === 'object' ? { includeText: (o.save as { includeText?: unknown }).includeText === true } : null;
  return { openClose: o.openClose === true, change: kind(o.change), save };
}
/* The languageId of MODE: its name less -mode, but for the ids LSP names otherwise. */
const LANGUAGE_IDS: Record<string, string> = {
  'c++-mode': 'cpp', 'js-mode': 'javascript', 'tsx-mode': 'typescriptreact', 'sh-mode': 'shellscript',
};
const languageId = (mode: string) => (Object.prototype.hasOwnProperty.call(LANGUAGE_IDS, mode) ? LANGUAGE_IDS[mode] : mode.replace(/-mode$/, ''));

/* The LSP position (line, UTF-16 units into it) of offset P in T, lines ending at \n, \r\n or a lone \r. P never
   falls between a \r and its \n, nor inside a surrogate pair (change keeps both whole). */
function position(t: string, p: number) {
  let line = 0, start = 0;
  for (let i = 0; i < p; i++) {
    const c = t.charCodeAt(i);
    if (c === 10 || (c === 13 && t.charCodeAt(i + 1) !== 10)) { line++; start = i + 1; }
  }
  return { line, character: p - start };
}
const isHigh = (c: number) => (c & 0xfc00) === 0xd800, isLow = (c: number) => (c & 0xfc00) === 0xdc00;
/* The one change that makes OLD into NEW: the range of OLD between their common prefix and suffix, and NEW's text
   there. Neither end splits a surrogate pair or a \r\n. */
function change(old: string, now: string) {
  const n = Math.min(old.length, now.length);
  let pre = 0; while (pre < n && old.charCodeAt(pre) === now.charCodeAt(pre)) pre++;
  let suf = 0; while (suf < n - pre && old.charCodeAt(old.length - 1 - suf) === now.charCodeAt(now.length - 1 - suf)) suf++;
  /* a point between the halves of a pair, or between a \r and its \n, is moved out: the start back, the end on */
  const split = (p: number) => { const a = old.charCodeAt(p - 1), b = old.charCodeAt(p); return (isHigh(a) && isLow(b)) || (a === 13 && b === 10); };
  if (pre > 0 && split(pre)) pre--;
  if (suf > 0 && split(old.length - suf)) suf--;
  return { range: { start: position(old, pre), end: position(old, old.length - suf) }, text: now.slice(pre, now.length - suf) };
}

const fileUri = (b: EdBuffer) => uri(Ed.host.files!.resolve(b.file!));
const live = (d: Doc) => d.s.state === 'running' && d.s.gen === d.gen && !!d.s.conn && d.s.conn.closed() === null;
/* Tell S's server of B as it is now (didOpen), when the server wants it. Never throws: a connection that broke
   has made the session lost, which opens it again on the next start. */
function openDoc(s: Session, b: EdBuffer) {
  forgetDoc(b);
  const sync = syncOf(s.capabilities);
  if (!sync.openClose || !s.conn || !b.file) return;
  const text = b.text, d: Doc = { s, gen: s.gen, file: b.file, mode: b.mode, uri: fileUri(b), lang: languageId(b.mode), ver: b.ver, text, sync, timer: null };
  docs.set(b, d);
  try { s.conn.notify('textDocument/didOpen', { textDocument: { uri: d.uri, languageId: d.lang, version: d.ver, text } }); }
  catch (e) { docs.delete(b); }
}
function forgetDoc(b: EdBuffer) {
  const d = docs.get(b);
  if (!d) return;
  if (d.timer) clearTimeout(d.timer);
  docs.delete(b);
}
/* didClose for B's document, when its server holds it. */
function closeDoc(b: EdBuffer) {
  const d = docs.get(b);
  forgetDoc(b);
  if (d && live(d)) try { d.s.conn!.notify('textDocument/didClose', { textDocument: { uri: d.uri } }); } catch (e) { /* lost */ }
}
/* Send B's edits since its server last heard (didChange: the one range that changed, or the whole text when the
   server syncs so). A buffer whose file or mode changed since its document was opened is attached afresh instead
   (ensure), its old document closed, but no server is started from here: this also runs from a timer, after
   edits that may have been the image's. The suites and the requests of later packages call this before they ask. */
function flush(b: EdBuffer) {
  const d = docs.get(b);
  if (!d) return;
  if (d.timer) { clearTimeout(d.timer); d.timer = null; }
  if (!live(d)) return;
  if (d.file !== b.file || d.mode !== b.mode) { ensure(b, false); return; }
  if (d.ver === b.ver) return;
  const text = b.text;
  d.ver = b.ver;
  if (text === d.text || !d.sync.change) { d.text = text; return; }
  const changes = d.sync.change === 2 ? [change(d.text, text)] : [{ text }];
  d.text = text;
  try { d.s.conn!.notify('textDocument/didChange', { textDocument: { uri: d.uri, version: d.ver }, contentChanges: changes }); }
  catch (e) { /* lost: it is opened again on the next start */ }
}
const prevEdited = H.edited;
H.edited = b => {
  if (prevEdited) prevEdited(b);
  const d = docs.get(b);
  if (d && !d.timer) d.timer = setTimeout(() => { d.timer = null; if (docs.get(b) === d) flush(b); }, timing.change);
};
/* didSave once B was written; written to another file, it is attached afresh instead (the old file's document
   closed, the new one's opened, in its own project's session when that is another). */
const prevWrote = H.wrote;
H.wrote = (b, name) => {
  if (prevWrote) prevWrote(b, name);
  const d = docs.get(b);
  if (!d) return;
  if (d.file !== b.file || d.mode !== b.mode) { ensure(b); return; }
  flush(b);
  if (!d.sync.save || docs.get(b) !== d || !live(d)) return;
  const params: Record<string, unknown> = { textDocument: { uri: d.uri } };
  if (d.sync.save.includeText) params.text = d.text;
  try { d.s.conn!.notify('textDocument/didSave', params); } catch (e) { /* lost */ }
};

/* B on the session its server and root give now: it stays where it is when that is its session (its document
   opened again when its file or mode changed), else it is detached and attached afresh; with no server for its
   mode (or no root), detached. Nothing changes where no process may start (the image's replay, a web frame,
   edwind). A start that fails (the program missing) leaves it detached, said; with MAYSTART false only a
   session already kept there is used, none started. Visiting a file and changing a major mode call this: eglot-mode turns
   on per language, once a server is declared for its mode. */
function ensure(b: EdBuffer, mayStart = true) {
  if (Ed.proc.refusal()) return;
  const s = ofBuffer.get(b), server = serverFor(b), root = server ? rootOf(b) : null;
  if (s && server && root && s.name === server.name && s.root === root) {
    const d = docs.get(b);
    if (d && (d.file !== b.file || d.mode !== b.mode)) { closeDoc(b); if (s.state === 'running') openDoc(s, b); }
    setFlag(b, true);
    return;
  }
  if (s) detach(b);
  if (!server || !root) return;
  if (!mayStart) { const there = sessions.get(`${server.name}\0${root}`); if (there && there.state !== 'failed') attach(there, b); return; }
  try { attach(sessionAt(server, root), b); } catch (e) { Ed.message(`eglot: ${Ed.errorText(e)}`); }
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

/* ---- cross references ---- */

/* At most XREF_MAX places of an answer are kept. A file *xref* shows lines of, when no buffer visits it, is read only
   when it is a regular file of at most PREVIEW_MAX bytes, and while the files read for one list stay within
   PREVIEW_TOTAL (else its rows have no text); a row's text is cut at ROW_MAX characters. xref-go-back keeps the last
   BACK_MAX places. */
const XREF_MAX = 5000, PREVIEW_MAX = 4 * 1024 * 1024, PREVIEW_TOTAL = 16 * 1024 * 1024, ROW_MAX = 200, BACK_MAX = 50;
/* A place an answer names: an absolute path, and the LSP position there (from 0, UTF-16 units). */
interface Xref { path: string; line: number; character: number }
/* Each request: its method, the capability its server must give, the word for its places, and whether they are
   listed even when there is one (references). */
interface XrefKind { method: string; cap: string; what: string; list: boolean }
const XREF_KINDS: Record<string, XrefKind> = {
  definition: { method: 'textDocument/definition', cap: 'definitionProvider', what: 'definitions', list: false },
  references: { method: 'textDocument/references', cap: 'referencesProvider', what: 'references', list: true },
  implementation: { method: 'textDocument/implementation', cap: 'implementationProvider', what: 'implementations', list: false },
  typeDefinition: { method: 'textDocument/typeDefinition', cap: 'typeDefinitionProvider', what: 'type definitions', list: false },
  declaration: { method: 'textDocument/declaration', cap: 'declarationProvider', what: 'declarations', list: false },
};
/* The places of *xref*'s rows, by line (from 1). */
const xrefRows = new WeakMap<EdBuffer, Map<number, Xref>>();
/* Where point was before each visit, the newest last (xref-go-back). */
const back: EdMarker[] = [];

/* The absolute path a file: URI names (with no host, or localhost); null for another scheme or a malformed one. */
function pathOf(u: string): string | null {
  const m = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(u);
  if (!m) return null;
  let p: string;
  try { p = decodeURIComponent(m[1]); } catch (e) { return null; }
  return p.includes('\0') ? null : p;
}
/* The offset in T of the LSP position POS, lines ending at \n, \r\n or a lone \r as position counts them: a line
   past the last is T's end, a character past its line's end that end, one between the halves of a surrogate pair
   the pair's start. */
function offsetOf(t: string, pos: { line: number; character: number }) {
  let i = 0;
  for (let l = 0; l < pos.line; l++) {
    while (i < t.length && t.charCodeAt(i) !== 10 && t.charCodeAt(i) !== 13) i++;
    if (i >= t.length) return t.length;
    i += t.charCodeAt(i) === 13 && t.charCodeAt(i + 1) === 10 ? 2 : 1;
  }
  let end = i;
  while (end < t.length && t.charCodeAt(end) !== 10 && t.charCodeAt(end) !== 13) end++;
  let p = Math.min(end, i + pos.character);
  if (p > i && isHigh(t.charCodeAt(p - 1)) && isLow(t.charCodeAt(p))) p--;
  return p;
}
/* The lines LINES (from 0, ascending) of T, by the same line ends ('' past the last), in one pass over T. */
function linesOf(t: string, lines: number[]) {
  const out: string[] = [];
  let i = 0, l = 0;
  const eol = (k: number) => { while (k < t.length && t.charCodeAt(k) !== 10 && t.charCodeAt(k) !== 13) k++; return k; };
  for (const want of lines) {
    while (l < want && i < t.length) { i = eol(i); i += t.charCodeAt(i) === 13 && t.charCodeAt(i + 1) === 10 ? 2 : 1; l++; }
    out.push(l === want && i <= t.length ? t.slice(i, eol(i)) : '');
  }
  return out;
}
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
/* The places of an answer: null, a Location, or a list of Locations or LocationLinks (a link's targetSelectionRange,
   else its targetRange). Each once, in the answer's order, at most XREF_MAX; FOREIGN counts those in no file (another
   URI scheme). An item of another shape is left out. */
function places(res: unknown): { xs: Xref[]; foreign: number } {
  const xs: Xref[] = [], seen = new Set<string>();
  let foreign = 0;
  type Range = { start?: { line?: unknown; character?: unknown } } | undefined;
  for (const it of res === null || res === undefined ? [] : Array.isArray(res) ? res : [res]) {
    if (!it || typeof it !== 'object' || xs.length >= XREF_MAX) continue;
    const o = it as { uri?: unknown; range?: Range; targetUri?: unknown; targetSelectionRange?: Range; targetRange?: Range };
    const link = o.targetUri !== undefined, u = link ? o.targetUri : o.uri;
    const r = link ? o.targetSelectionRange || o.targetRange : o.range, start = r && typeof r === 'object' ? r.start : undefined;
    if (typeof u !== 'string' || !start || !isCount(start.line) || !isCount(start.character)) continue;
    const path = pathOf(u);
    if (!path) { foreign++; continue; }
    const key = `${path}\0${start.line}\0${start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    xs.push({ path, line: start.line, character: start.character });
  }
  return { xs, foreign };
}

/* P, which C-g quits (cancelling it when it can be), as the command loop holds every key while a command waits. */
const quittable = <T>(p: Promise<T>) => (EdPool.interruptible ? EdPool.interruptible(p) : p);
/* Ask B's server KIND about point: the places it answers, at least one. Waits for the server to be ready and then
   for its answer, each at most timing.request; C-g quits either wait, cancelling the request. */
async function ask(b: EdBuffer, kind: XrefKind): Promise<Xref[]> {
  const s = ofBuffer.get(b);
  if (!s) return signal('user-error', 'No language server for this buffer (M-x eglot starts one)');
  if (s.state !== 'running') {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bound = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(lspError(`${label(s)}: not ready after ${timing.request / 1000} s`)), timing.request); });
    try { await quittable(Promise.race([ready(s), bound])); } finally { if (timer) clearTimeout(timer); }
  }
  if (!(s.capabilities || {})[kind.cap]) return signal('user-error', `${s.name} gives no ${kind.what}`);
  flush(b);
  const conn = s.conn, d = docs.get(b);
  if (!conn || conn.closed() !== null || s.state !== 'running') return signal('lsp-error', `${label(s)}: not running`);
  const params: Record<string, unknown> = { textDocument: { uri: d ? d.uri : fileUri(b) }, position: position(b.text, b.pt) };
  if (kind === XREF_KINDS.references) params.context = { includeDeclaration: true };
  const { xs, foreign } = places(await quittable(conn.request(kind.method, params, { timeout: timing.request })));
  if (!xs.length) return signal('user-error', foreign ? `No ${kind.what} in a file: the server names ${foreign} elsewhere` : `No ${kind.what} found`);
  return xs;
}

/* Record where point is in B, for xref-go-back. */
function pushBack(b: EdBuffer) {
  back.push(b.marker(b.pt));
  while (back.length > BACK_MAX) back.shift()!.release();
}
/* X's file is there, else a user-error says it is not. */
function need(x: Xref) {
  const f = Ed.host.files;
  if (!f || !f.exists(x.path)) signal('user-error', `${abbr(x.path)}: no such file`);
}
/* Visit X in the selected window: its file, point at its position (a promise when edwind opens the file). */
function visitXref(x: Xref): EdBuffer | Promise<EdBuffer> {
  need(x);
  const place = (v: unknown) => {
    if (!(v instanceof Ed.Buffer)) return signal('user-error', `${abbr(x.path)} was not visited`);
    v.pt = offsetOf(v.text, x);
    return v;
  };
  const r = L.call('find-file', [x.path]) as unknown;
  return r && typeof (r as Promise<unknown>).then === 'function' ? (r as Promise<unknown>).then(place) : place(r);
}

/* *xref*, listing XS, shown and selected in another window: for each file (in the answer's order, its name
   relative to ROOT when under it) a heading, then a row for each place, `LINE: TEXT`, by line. The rows are also the
   error list (M-g n). Point is on the first row. */
function list(xs: Xref[], root: string, what: string) {
  const f = Ed.host.files!, files = new Map<string, Xref[]>(), top = root.replace(/\/+$/, '') + '/';
  for (const x of xs) { const g = files.get(x.path); if (g) g.push(x); else files.set(x.path, [x]); }
  const rows = new Map<number, Xref>(), out: string[] = [], errors: SchemeValue[] = [];
  let budget = PREVIEW_TOTAL;
  for (const [path, g] of files) {
    g.sort((a, c) => a.line - c.line || a.character - c.character);
    const open = E.buffers.find(o => o.file && !o.shared && f.resolve(o.file) === path);
    let text: string | null = open ? open.text : null;
    if (!open && budget > 0) try { text = f.read(path, Math.min(PREVIEW_MAX, budget)); } catch (e) { text = null; }
    if (!open && text !== null) budget -= text.length;
    const texts = text === null ? null : linesOf(text, g.map(x => x.line));
    out.push(path.startsWith(top) ? path.slice(top.length) : abbr(path));
    const w = String(g[g.length - 1].line + 1).length;
    for (const [k, x] of g.entries()) {
      let line = texts === null ? '' : texts[k].trim();
      if (line.length > ROW_MAX) line = line.slice(0, ROW_MAX) + '…';
      out.push(`${String(x.line + 1).padStart(w + 2)}: ${line}`);
      rows.set(out.length, x);
      errors.push(L.list(path, x.line + 1, x.character + 1, line || `${abbr(path)}:${x.line + 1}`, intern('utf-16')));
    }
  }
  const b = Ed.getBufferCreate('*xref*');
  b.readOnly = false; b.text = out.join('\n') + '\n'; b.readOnly = true; b.modified = false;
  b.mode = 'xref-mode'; b.evilState = 'motion'; b.undo = []; b.redo = []; Ed.forgetLog(b);
  xrefRows.set(b, rows);
  try { L.call('next-error-set-list!', [L.list(...errors), 'xref']); } catch (e) { Ed.reportError(e); }
  const w = Ed.popToBuffer(b, true);
  b.pt = Ed.lineStartB(b, 2); w.start = 0;
  Ed.message(`${xs.length} ${what}`);
  return b;
}

/* KIND about point in the current buffer: a single place of a definition's kind visited, else the places listed;
   point's place recorded first either way (xref-go-back, and C-o in the buffer). */
async function find(name: string) {
  const kind = XREF_KINDS[name], b = cur();
  const xs = await ask(b, kind), s = ofBuffer.get(b);
  if (!E.buffers.includes(b) || cur() !== b) return false;
  const one = xs.length === 1 && !kind.list;
  if (one) need(xs[0]);
  pushBack(b);
  EvilCore.pushJump(b, b.pt);
  if (one) await visitXref(xs[0]);
  else list(xs, s ? s.root : '/', kind.what);
  return false;
}
/* The *xref* row at point, the window to visit it in (another, not showing *xref*, split from it when there is
   none) and *xref*'s own. */
function rowHere() {
  const b = cur(), rows = xrefRows.get(b), x = rows && rows.get(Ed.lineNoB(b, b.pt));
  if (!x) return signal('user-error', 'No reference here');
  const here = E.sel!, others = Ed.windowList().filter(w => w !== here && w.buffer !== b);
  const there = others.find(w => !w.popup) || others[0] || Ed.splitWindow(here, 'above');
  return { x, here, there };
}
const XREF_DOC = "Asks this buffer's language server; point's place is recorded first, for xref-go-back (M-,). Several places are listed in *xref*.";
CMD('xref-find-definitions', '', '', `Go to the definition of the identifier at point (g d, M-.). ${XREF_DOC}`, () => find('definition'));
CMD('xref-find-references', '', '', "List the references to the identifier at point, its declaration among them, in *xref* (g r, M-?), from this buffer's language server: RET visits one, M-g n steps through them, M-, comes back.", () => find('references'));
CMD('eglot-find-implementation', '', '', `Go to the implementation of the identifier at point. ${XREF_DOC}`, () => find('implementation'));
CMD('eglot-find-typeDefinition', '', '', `Go to the definition of the type of the identifier at point. ${XREF_DOC}`, () => find('typeDefinition'));
CMD('eglot-find-declaration', '', '', `Go to the declaration of the identifier at point. ${XREF_DOC}`, () => find('declaration'));
CMD('xref-goto-xref', '', '', 'Visit the place of the *xref* row at point in another window and select it (RET); xref-go-back (M-,) returns to where the list was asked for.', async () => {
  const { x, there } = rowHere();
  Ed.selectWindow(there);
  await visitXref(x);
  return false;
});
CMD('xref-show-location-at-point', '', '', 'Show the place of the *xref* row at point in another window, staying in *xref* (o).', async () => {
  const { x, here, there } = rowHere();
  Ed.selectWindow(there);
  try { await visitXref(x); } finally { if (Ed.windowList().includes(here)) Ed.selectWindow(here); }
  return false;
});
CMD('xref-go-back', '', '', 'Go back to where point was before the last visit of a definition or reference (M-, and C-t), in its buffer; a killed buffer\'s place is skipped.', () => {
  for (let m = back.pop(); m; m = back.pop()) {
    const b = m.buffer, p = m.pos;
    m.release();
    if (!b || p === null || !E.buffers.includes(b)) continue;
    Ed.setWindowBuffer(b);
    b.pt = Math.min(p, b.rope.length);
    return false;
  }
  return signal('user-error', 'At the start of the xref history');
});
Ed.MODE_NAMES['xref-mode'] = 'XREF';
Ed.modeParents.set('xref-mode', 'special-mode');
/* xref-mode's own keys, outside Evil and in Emacs state (scm/emacs.scm binds RET and o there). */
L.set('xref-mode-map', new Ed.Keymap('xref-mode-map'));

/* ---- Scheme and commands ---- */

D('%lsp-declare', 'NAME MODES COMMAND', 'Declare the language server NAME for the major modes MODES, run as the argv COMMAND (define-language-server, scm/lsp.scm).',
  ([n, m, c]: SchemeValue[]) => {
    const name = n instanceof L.S.Sym ? n.name : n;
    const modes = L.arr(m).map(x => (x instanceof L.S.Sym ? x.name : x));
    return define(name as string, modes as string[], L.arr(c) as string[]) ? n : false;
  });
D('lsp--kill-buffer', '', 'kill-buffer-hook: the current buffer no longer uses its language server (didClose).', () => { detach(cur()); return false; });
L.addHook('kill-buffer-hook', intern('lsp--kill-buffer'));
D('lsp--ensure', '', "find-file-hook and after-change-major-mode-hook: turn eglot-mode on in the current buffer when a language server is declared for its mode, starting the server for its project when none runs there; off when none is.", () => { ensure(cur()); return false; });
L.addHook('find-file-hook', intern('lsp--ensure'));
L.addHook('after-change-major-mode-hook', intern('lsp--ensure'));

Ed.defineMinorMode({ name: 'eglot-mode', variable: MODE_VAR, pretty: 'Eglot',
  doc: "Toggle this buffer's use of the language server declared for its mode (define-language-server): on, the server for its project is started when none runs there and is told of the buffer's text and each change, save and close; off, it is told the buffer closed. Visiting a file turns it on when a server is declared for the file's mode. The state is eglot-enabled.",
  body: (on: boolean, b: EdBuffer) => {
    if (!on) { detach(b); return; }
    try { start(b); } catch (e) { setFlag(b, false); throw e; }
  } });

const sessionHere = () => {
  const s = ofBuffer.get(cur());
  if (!s) signal('user-error', 'No language server for this buffer (M-x eglot starts one)');
  return s!;
};
CMD('eglot', '', '', "Start the language server for this buffer's mode in its project (the nearest directory up with a .git or a .jj, else the file's), or use the one already running there, and turn eglot-mode on: the server is told of the buffer.", () => {
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
  timing, uri, define, serverFor, rootOf, start, ready, shutdown, shutdownAll, reconnect, flush, languageId,
  servers: () => [...servers.values()],
  sessions: () => [...sessions.values()],
  sessionOf: b => ofBuffer.get(b) || null,
  stderr: s => (s as Session).err.slice(-STDERR_MAX),
};
})();
