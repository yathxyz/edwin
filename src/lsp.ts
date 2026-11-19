/* Language server sessions (docs/steps.md, "Language server sessions"): one server process per project root and
   server, run through Ed.proc and spoken to through LspRpc (src/lsp-rpc.ts). A session initializes its server,
   starts it again with a growing delay when it ends on its own (up to a bound), stops it once no buffer has used
   it for a while, and shuts it down (shutdown, exit, then KILL past a short bound) when asked and when the
   program ends.

   The servers are declared by name, the major modes they serve, their argv and their settings
   (define-language-server, in scm/lsp.scm, which also holds the table of the owner's servers; docs/steps.md, "The
   server table"). The settings, JSON or worked out from the root when a session is made, answer the server's
   workspace/configuration by section and are sent once it is initialized (workspace/didChangeConfiguration).
   A declaration made while the image replays is skipped, with a message: an argv the image set would
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
   C-t) returns to, across buffers.

   Hover and signature help (docs/steps.md, "Hover and signature help"): eldoc (K where eglot-mode is on) shows the
   server's hover at point in the echo area; while typing, the active signature of the call at point is asked for
   once no command came for timing.eldoc and shown there, one request at a time, cancelled when point moves.

   Diagnostics (docs/steps.md, "Diagnostics"): what a server publishes is kept per session and file; in a buffer
   attached to it they are placed as positions that follow its edits until the next publish. The mode line counts
   them, the echo area shows the ones at point, and flymake-show-buffer-diagnostics and
   flymake-show-project-diagnostics list them (RET visits one), the list becoming the error list (M-g n), kept up
   to date as the server publishes again.

   Workspace edits and rename (docs/steps.md, "Workspace edits and rename"): eglot-rename asks the buffer's server
   to rename the identifier at point and applies the workspace edit it answers to every file it names or to none:
   each file is checked (in the project, on this machine, writable, the text and version the server made the edit
   against, ranges that neither overlap nor run past the end) before any is changed. Each buffer's part is one
   batch and one undo step; a file not open is visited for it without being shown, and nothing is saved.

   Completion (docs/steps.md, "Completion"): the server's items in complete.ts's popup, before the words and file
   names. While typing, once a word has corfu-auto-prefix characters, the server is asked after timing.completion
   with no further key, one request at a time, cancelled by the next key; the keys never wait for it. Its answer
   is filtered again as the word grows, asked again only when the server says it is incomplete. TAB and C-SPC ask
   and wait (C-g quits). An item goes in with its textEdit and additionalTextEdits, all or none, one undo step;
   a snippet as its plain text.

   Code actions (docs/steps.md, "Code actions"): eglot-code-actions asks the buffer's server for the actions at point
   or of the region, with the diagnostics there, and carries out the one chosen; eglot-code-action-quickfix asks for
   quick fixes alone and carries out a single one at once. An action's workspace edit is applied as a rename's is.
   Its command is run by the server (workspace/executeCommand) only when the server names it among its own and the
   user says yes; while it runs, and only then, the server's own edits (workspace/applyEdit) are applied, as any
   workspace edit. Nothing a server names is run here.

   Symbols (docs/steps.md, "Symbols"): consult-imenu in a buffer whose server gives document symbols lists the
   server's (textDocument/documentSymbol), else the buffer's own definitions as before; consult-eglot-symbols (SPC p
   s) asks the buffer's server for the workspace's symbols matching what is typed (workspace/symbol), asked again
   timing.symbols after each change, and visits the one chosen as a definition is visited.

   Watched files (docs/steps.md, "Watched files"): a server's workspace/didChangeWatchedFiles registrations are
   kept, and each running server is told of the changes its globs match that Edwin makes (Ed.Store's writes and
   removals) or sees (auto-revert's looks at the visited files, a followed dired listing read again). */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD, D } = L;
const cur = () => E.current;

/* The bounds, in ms: initialize's answer; shutdown's answer, then the child's exit after exit, then after KILL
   (together under the 2 s a frame may block on quitting); the first delay before a start again, doubled each
   time, and how many starts again in a row before the session gives up; how long a server must have run for its
   end to count as a first one again; how long a session with no buffer lives; how long after an edit its change
   is sent (eglot's eglot-send-changes-idle-time); how long a cross-reference or hover command waits for its server to be
   ready, then for its answer; how long after the last command a signature is asked for while typing; how long a
   diagnostics list waits after a publish before it is drawn again (a run of publishes, one redraw); how long after
   the last key typed completions are asked for (corfu's corfu-auto-delay); how long after the last change of
   consult-eglot-symbols's input the workspace's symbols are asked for. Mutable for the suites. */
const timing = { connect: 30_000, shutdown: 1000, exitWait: 400, killWait: 200, restartDelay: 1000, restartMax: 5, healthy: 60_000, idle: 300_000, change: 500, request: 10_000, eldoc: 300, diagnostics: 100, completion: 200, symbols: 200 };
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
  /* the server's settings for this root (null: none), worked out when the session was made */
  settings: unknown;
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
  /* what the server last published, by absolute path */
  diags: Map<string, Diag[]>;
  /* the files its server watches (workspace/didChangeWatchedFiles), by registration id */
  watched: Map<string, Watcher[]>;
}

/* How a server wants documents synced (its textDocumentSync): whether opening and closing are told, changes as
   none (0), the whole text (1) or a range (2), and whether a save is told and with the text. */
interface Sync { openClose: boolean; change: number; save: { includeText: boolean } | null }
/* A buffer's document as its server holds it: the session and connection (the session's gen) it was opened on,
   the file, mode, URI and language it was opened with, the buffer's version and text the server last got, the
   version it was last told of (didOpen or a didChange sent; an edit undone before it was sent tells nothing), the
   pending change's timer. */
interface Doc {
  s: Session; gen: number; file: string; mode: string; uri: string; lang: string; ver: number; sent: number; text: string; sync: Sync;
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

function define(name: string, modes: string[], argv: string[], settings: LspServer['settings'] = null): LspServer | null {
  if (Ed.proc.replaying()) {
    Ed.message(`define-language-server: ${typeof name === 'string' ? name : 'a server'} is not declared while the image replays`);
    return null;
  }
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9+._-]*$/i.test(name)) signal('lsp-error', 'define-language-server: the name is not a plain symbol:', name);
  if (!Array.isArray(modes) || !modes.length || modes.some(m => typeof m !== 'string' || !m)) signal('lsp-error', `define-language-server: :modes needs a non-empty list of modes for ${name}`);
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string') || !argv[0]) signal('lsp-error', `define-language-server: :command needs a non-empty list of strings, the program first, for ${name}`);
  const s = { name, modes: modes.slice(), argv: argv.slice(), settings };
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

/* The settings of SERVER in ROOT: its procedure's answer, or its settings as declared. */
function settingsIn(server: LspServer, root: string): unknown {
  return typeof server.settings === 'function' ? (server.settings as (root: string) => unknown)(root) : server.settings;
}
/* The part of SETTINGS a workspace/configuration item asks for: its section, a dotted path (`python.analysis`),
   or all of them with none; null where there is nothing. */
function section(settings: unknown, item: unknown): unknown {
  const sec = item && typeof item === 'object' ? (item as { section?: unknown }).section : undefined;
  if (typeof sec !== 'string' || !sec) return settings;
  let v = settings;
  for (const k of sec.split('.')) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, k)) return null;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
/* What the server asks of the client. */
function serverRequests(s: Session): Record<string, (params: unknown) => unknown> {
  return {
    'workspace/configuration': (p: unknown) => {
      const items = p && typeof p === 'object' && Array.isArray((p as { items?: unknown }).items) ? (p as { items: unknown[] }).items : [];
      return items.map(item => section(s.settings, item));
    },
    'workspace/workspaceFolders': () => [{ uri: uri(s.root), name: s.root.split('/').pop() || s.root }],
    'workspace/applyEdit': (p: unknown) => serverEdit(s, p),
    'client/registerCapability': (p: unknown) => { register(s, p); return null; },
    'client/unregisterCapability': (p: unknown) => { unregister(s, p); return null; },
    'window/workDoneProgress/create': () => null,
    'window/showMessageRequest': () => null,
  };
}
const MESSAGE_TYPES = ['', 'error', 'warning', 'info', 'log'];
function notified(s: Session, method: string, params: unknown) {
  if (method === 'textDocument/publishDiagnostics') { published(s, params); return; }
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
  const name = s.root.split('/').pop() || s.root, symbolKind = { valueSet: SYMBOL_KINDS.map((_, k) => k).slice(1) };
  return {
    processId: null,
    clientInfo: { name: 'Edwin' },
    rootPath: s.root,
    rootUri: uri(s.root),
    workspaceFolders: [{ uri: uri(s.root), name }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      workspace: {
        configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true }, applyEdit: true, executeCommand: {}, symbol: { symbolKind },
        didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
      },
      textDocument: {
        synchronization: { didSave: true },
        definition: { linkSupport: true }, declaration: { linkSupport: true }, typeDefinition: { linkSupport: true },
        implementation: { linkSupport: true }, references: {}, rename: {},
        hover: { contentFormat: ['plaintext', 'markdown'] },
        signatureHelp: { signatureInformation: { documentationFormat: ['plaintext', 'markdown'], parameterInformation: { labelOffsets: true }, activeParameterSupport: true } },
        publishDiagnostics: { versionSupport: true },
        completion: { completionItem: { snippetSupport: false }, contextSupport: true },
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ACTION_KINDS } }, isPreferredSupport: true },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind },
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
    try {
      conn.notify('initialized', {});
      if (s.settings !== null) conn.notify('workspace/didChangeConfiguration', { settings: s.settings });
    } catch (e) { return; }   // closed: lost has run
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
  s.proc = null; s.conn = null; s.capabilities = null; unwatch(s);
  if (conn) conn.close(why);
  if (proc) proc.kill('KILL');
  dropDiags(s);
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
  for (const b of s.buffers) if (ofBuffer.get(b) === s) { ofBuffer.delete(b); forgetDoc(b); forgetEldoc(b); forgetCompletion(b); unplace(b); setFlag(b, false); }
  dropDiags(s); unwatch(s);
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
  closeDoc(b); forgetEldoc(b); forgetCompletion(b); unplace(b);
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
  place(s, b);
  const sync = syncOf(s.capabilities);
  if (!sync.openClose || !s.conn || !b.file) return;
  const text = b.text, d: Doc = { s, gen: s.gen, file: b.file, mode: b.mode, uri: fileUri(b), lang: languageId(b.mode), ver: b.ver, sent: b.ver, text, sync, timer: null };
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
  try { d.s.conn!.notify('textDocument/didChange', { textDocument: { uri: d.uri, version: d.ver }, contentChanges: changes }); d.sent = d.ver; }
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

/* ---- watched files ----
   A server registers the files it wants to hear of (client/registerCapability for
   workspace/didChangeWatchedFiles: glob patterns, each a string or relative to a base, with the kinds of change
   it wants) and is told of each change Edwin makes or sees there: a file written or deleted through Ed.Store
   (editor-core.ts), a visited file that global-auto-revert-mode's look finds changed, gone or back
   (editor-prims.ts), and a name that comes or goes in a directory listing read again (dired.ts). There is no
   inotify: a file no buffer visits and no listing shows changes unseen. Nothing is told of a path auto-revert does not look at
   (Ed.looksAt: a --private session, the temporary directory). The registrations are the child's: a start again
   or a shutdown drops them, and a new child registers its own. The patterns are the server's text, so they are
   bounded (PATTERN_MAX characters, ALTERNATIVES_MAX alternatives of its braces, WATCHED_MAX alternatives in all
   per session) and matched without backtracking. */
const PATTERN_MAX = 1024, ALTERNATIVES_MAX = 64, WATCHED_MAX = 256;
type GlobPart = { t: 'char'; c: string } | { t: '?' } | { t: '*' } | { t: '**' } | { t: '**/' } | { t: 'set'; not: boolean; ranges: [string, string][] };
/* One alternative of a pattern: its parts, and whether it names absolute paths. */
interface GlobAlt { abs: boolean; parts: GlobPart[] }
/* A watcher: its alternatives, matched against a path relative to BASE (null: the absolute path for an absolute
   alternative, else relative to the session's root), and the kinds it wants as LSP's WatchKind bits (create 1,
   change 2, delete 4). */
interface Watcher { base: string | null; alts: GlobAlt[]; kind: number }

/* P with its braces expanded ({a,b} nested to any depth), at most ALTERNATIVES_MAX of them; null for a brace not
   closed or more alternatives than that. */
function braces(p: string): string[] | null {
  const i = p.indexOf('{');
  if (i < 0) return [p];
  const cuts = [i];
  let depth = 0, j = i;
  for (; j < p.length; j++) {
    if (p[j] === '{') depth++;
    else if (p[j] === '}' && --depth === 0) break;
    else if (p[j] === ',' && depth === 1) cuts.push(j);
  }
  if (j === p.length) return null;
  cuts.push(j);
  const rest = braces(p.slice(j + 1));
  if (!rest) return null;
  const out: string[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const inner = braces(p.slice(cuts[k] + 1, cuts[k + 1]));
    if (!inner) return null;
    for (const a of inner) for (const r of rest) { if (out.length === ALTERNATIVES_MAX) return null; out.push(p.slice(0, i) + a + r); }
  }
  return out;
}
/* The parts of one alternative: * within a segment, ** across them (**\/ any leading segments, none too), ? one
   character of a segment, [...] and [!...] one character of a set or not of it (a ] first is a member, a [ never
   closed is itself), anything else itself. */
function globParts(p: string): GlobPart[] {
  const out: GlobPart[] = [];
  for (let i = 0; i < p.length;) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { out.push({ t: '**/' }); i += 3; } else { out.push({ t: '**' }); i += 2; }
    } else if (c === '*') { out.push({ t: '*' }); i++; }
    else if (c === '?') { out.push({ t: '?' }); i++; }
    else if (c === '[') {
      let j = i + 1;
      const not = p[j] === '!' || p[j] === '^';
      if (not) j++;
      const end = p.indexOf(']', j + 1);
      if (end < 0) { out.push({ t: 'char', c }); i++; continue; }
      const ranges: [string, string][] = [];
      for (let k = j; k < end; k++) {
        if (p[k + 1] === '-' && k + 2 < end) { ranges.push([p[k], p[k + 2]]); k += 2; } else ranges.push([p[k], p[k]]);
      }
      out.push({ t: 'set', not, ranges });
      i = end + 1;
    } else { out.push({ t: 'char', c }); i++; }
  }
  return out;
}
/* Whether PARTS match all of S: the places in S each part can end at, worked out part by part, so the time is the
   parts times S's length whatever the pattern. */
function globMatch(parts: GlobPart[], s: string): boolean {
  const n = s.length;
  let at = new Uint8Array(n + 1);
  at[0] = 1;
  for (const g of parts) {
    const nx = new Uint8Array(n + 1);
    let any = false;
    if (g.t === '*' || g.t === '**' || g.t === '**/') {
      let on = false;
      for (let q = 0; q <= n; q++) {
        const slash = q > 0 && s.charCodeAt(q - 1) === 47;
        if (g.t === '*') { if (slash) on = false; if (at[q]) on = true; if (on) nx[q] = 1; }
        else if (g.t === '**') { if (at[q]) on = true; if (on) nx[q] = 1; }
        else { if (slash && on) nx[q] = 1; if (at[q]) { nx[q] = 1; on = true; } }
        if (nx[q]) any = true;
      }
    } else {
      for (let q = 0; q < n; q++) {
        if (!at[q]) continue;
        const c = s[q];
        const ok = g.t === 'char' ? c === g.c : c !== '/' && (g.t === '?' || g.ranges.some(([a, z]) => c >= a && c <= z) !== g.not);
        if (ok) { nx[q + 1] = 1; any = true; }
      }
    }
    if (!any) return false;
    at = nx;
  }
  return at[n] === 1;
}
/* P (a path) relative to the directory D, or null when it is not under D. */
function under(p: string, d: string): string | null {
  const dd = d.replace(/\/+$/, '');
  return p.startsWith(dd + '/') && p.length > dd.length + 1 ? p.slice(dd.length + 1) : null;
}
/* A FileSystemWatcher as the server gave it, or null when it is malformed or past the bounds. A relative pattern's
   base is a file: URI or a workspace folder; its kind, absent, is every kind. */
function watcherOf(w: unknown): Watcher | null {
  if (!w || typeof w !== 'object') return null;
  const { globPattern: g, kind } = w as { globPattern?: unknown; kind?: unknown };
  let base: string | null = null, pattern: unknown = g;
  if (g && typeof g === 'object') {
    const { baseUri: bu, pattern: pt } = g as { baseUri?: unknown; pattern?: unknown };
    const u = typeof bu === 'string' ? bu : bu && typeof bu === 'object' ? (bu as { uri?: unknown }).uri : undefined;
    base = typeof u === 'string' ? pathOf(u) : null;
    if (!base) return null;
    pattern = pt;
  }
  if (typeof pattern !== 'string' || !pattern || pattern.length > PATTERN_MAX) return null;
  if (kind !== undefined && !(Number.isSafeInteger(kind) && (kind as number) >= 0 && (kind as number) <= 7)) return null;
  const alts = braces(pattern);
  if (!alts) return null;
  return { base, alts: alts.map(a => ({ abs: base === null && a.startsWith('/'), parts: globParts(a) })), kind: kind === undefined ? 7 : kind as number };
}
const WATCH_METHOD = 'workspace/didChangeWatchedFiles';
/* client/registerCapability: S's server's watchers kept by registration id, past WATCHED_MAX alternatives in
   all the rest dropped; a malformed watcher is dropped, the others kept. Other methods are not taken up. */
function register(s: Session, params: unknown) {
  const regs = params && typeof params === 'object' ? (params as { registrations?: unknown }).registrations : undefined;
  if (!Array.isArray(regs)) return;
  for (const r of regs) {
    if (!r || typeof r !== 'object') continue;
    const { id, method, registerOptions: o } = r as { id?: unknown; method?: unknown; registerOptions?: unknown };
    if (method !== WATCH_METHOD || typeof id !== 'string') continue;
    s.watched.delete(id);
    const ws = o && typeof o === 'object' ? (o as { watchers?: unknown }).watchers : undefined;
    if (!Array.isArray(ws)) continue;
    let count = 0;
    for (const v of s.watched.values()) for (const w of v) count += w.alts.length;
    const kept: Watcher[] = [];
    for (const x of ws) {
      const w = watcherOf(x);
      if (!w || count + w.alts.length > WATCHED_MAX) continue;
      count += w.alts.length;
      kept.push(w);
    }
    s.watched.set(id, kept);
  }
  rewatch();
}
/* client/unregisterCapability (its list is `unregisterations`, as LSP spells it). */
function unregister(s: Session, params: unknown) {
  const us = params && typeof params === 'object' ? (params as { unregisterations?: unknown }).unregisterations : undefined;
  if (!Array.isArray(us)) return;
  for (const u of us) if (u && typeof u === 'object' && (u as { method?: unknown }).method === WATCH_METHOD) s.watched.delete((u as { id?: unknown }).id as string);
  rewatch();
}
function unwatch(s: Session) { if (s.watched.size) { s.watched.clear(); rewatch(); } }
/* Whether S's watchers want a change of TYPE (1 created, 2 changed, 3 deleted) to the absolute path P. Only a path
   under S's root is ever told, whatever the pattern: a server registering an absolute pattern or a base elsewhere
   (`/**`) does not hear of the other files Edwin writes on this machine. */
function watches(s: Session, p: string, type: number) {
  if (under(p, s.root) === null) return false;
  const bit = type === 1 ? 1 : type === 2 ? 2 : 4;
  for (const ws of s.watched.values()) for (const w of ws) {
    if (!(w.kind & bit)) continue;
    const rel = w.base !== null ? under(p, w.base) : under(p, s.root);
    for (const a of w.alts) {
      const t = a.abs ? p : rel;
      if (t !== null && globMatch(a.parts, t)) return true;
    }
  }
  return false;
}
/* The changes CHANGES (absolute paths) told to each running server that watches them, one notification a server. */
function filesChanged(changes: { path: string; type: 1 | 2 | 3 }[]) {
  try {
    const looked = changes.filter(c => Ed.looksAt(c.path));
    for (const s of sessions.values()) {
      if (s.state !== 'running' || !s.conn || !s.watched.size) continue;
      const out = looked.filter(c => watches(s, c.path, c.type)).map(c => ({ uri: uri(c.path), type: c.type }));
      if (out.length) try { s.conn.notify(WATCH_METHOD, { changes: out }); } catch (e) { /* lost */ }
    }
  } catch (e) { Ed.message(`eglot: ${Ed.errorText(e)}`); }
}
/* The hook is set only while some server watches files, so with none a write, a look and a listing do no more
   than before. */
function rewatch() {
  H.filesChanged = [...sessions.values()].some(s => s.watched.size) ? filesChanged : null;
}

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
/* A new session of SERVER in ROOT, its child started (a refusal, or settings that fail, throw before the session is
   kept). */
function open(server: LspServer, root: string): Session {
  const settings = settingsIn(server, root);
  const s: Session = {
    key: `${server.name}\0${root}`, name: server.name, root, argv: server.argv.slice(), settings, state: 'starting', proc: null,
    conn: null, capabilities: null, buffers: new Set(), restarts: 0, started: 0, why: null, gen: 0, timer: null,
    idle: null, waiters: [], err: '', done: null, diags: new Map(), watched: new Map(),
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
  const fresh = sessionAt(servers.get(s.name)!, s.root);   // a declared name is only ever replaced, never removed
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
/* B's document and point as its server holds them (once flush has sent the pending change). */
function docParams(b: EdBuffer) {
  const d = docs.get(b);
  return { textDocument: { uri: d ? d.uri : fileUri(b) }, position: position(b.text, b.pt) };
}
/* B's session once its server is ready (waiting at most timing.request; C-g quits the wait), when its
   capabilities give CAP; else a user-error that it gives no WHAT. */
async function readyFor(b: EdBuffer, cap: string, what: string): Promise<Session> {
  const s = ofBuffer.get(b);
  if (!s) return signal('user-error', 'No language server for this buffer (M-x eglot starts one)');
  if (s.state !== 'running') {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bound = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(lspError(`${label(s)}: not ready after ${timing.request / 1000} s`)), timing.request); });
    try { await quittable(Promise.race([ready(s), bound])); } finally { if (timer) clearTimeout(timer); }
  }
  if (!(s.capabilities || {})[cap]) return signal('user-error', `${s.name} gives no ${what}`);
  return s;
}
/* Ask B's server METHOD about point, PARAMS beside the document and position, when its capabilities give CAP
   (else a user-error that it gives no WHAT): its answer. Waits for the server to be ready (readyFor) and then for
   its answer, at most timing.request; C-g quits either wait, cancelling the request. The pending change is sent
   first, and SENDING (when given) is called with the session just before the request is. */
async function askAt(b: EdBuffer, method: string, cap: string, what: string, params: Record<string, unknown> = {}, sending?: (s: Session) => void): Promise<unknown> {
  const s = await readyFor(b, cap, what);
  flush(b);
  const conn = s.conn;
  if (!conn || conn.closed() !== null || s.state !== 'running') return signal('lsp-error', `${label(s)}: not running`);
  if (sending) sending(s);
  return quittable(conn.request(method, { ...docParams(b), ...params }, { timeout: timing.request }));
}
/* Ask B's server KIND about point: the places it answers, at least one. */
async function ask(b: EdBuffer, kind: XrefKind): Promise<Xref[]> {
  const { xs, foreign } = places(await askAt(b, kind.method, kind.cap, kind.what, kind === XREF_KINDS.references ? { context: { includeDeclaration: true } } : {}));
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
/* The row at point of *xref* or a diagnostics list, the window to visit it in (another, not showing the list,
   split from it when there is none) and the list's own. */
function rowHere() {
  const b = cur(), xr = xrefRows.get(b), rows = xr || diagRows.get(b), x = rows && rows.get(Ed.lineNoB(b, b.pt));
  if (!x) return signal('user-error', xr ? 'No reference here' : 'No diagnostic here');
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
/* Visit the place of the row at point in another window, selecting it; with STAY the list's window stays selected. */
async function visitRow(stay: boolean) {
  const { x, here, there } = rowHere();
  Ed.selectWindow(there);
  try { await visitXref(x); } finally { if (stay && Ed.windowList().includes(here)) Ed.selectWindow(here); }
  return false;
}
CMD('xref-goto-xref', '', '', 'Visit the place of the *xref* row at point in another window and select it (RET); xref-go-back (M-,) returns to where the list was asked for.', () => visitRow(false));
CMD('xref-show-location-at-point', '', '', 'Show the place of the *xref* row at point in another window, staying in *xref* (o).', () => visitRow(true));
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

/* ---- hover and signature help ---- */

/* A hover's text is cut at HOVER_MAX characters and a signature's at SIGNATURE_MAX, '…' marking the cut. */
const HOVER_MAX = 4096, SIGNATURE_MAX = 500;
const cut = (t: string, n: number) => {
  if (t.length <= n) return t;
  const k = isHigh(t.charCodeAt(n - 1)) ? n - 1 : n;
  return t.slice(0, k) + '…';
};
/* A server's text made fit for the echo area: line ends as \n, every other control character (ESC above all: a
   terminal frame draws the echo area) a blank. */
const clean = (t: string) => t.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ' ');
/* The text of a hover's contents: a MarkupContent or a MarkedString ({language, value} or a string), or a list
   of MarkedStrings. */
function markupText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(markupText).filter(Boolean).join('\n\n');
  const v = c && typeof c === 'object' ? (c as { value?: unknown }).value : undefined;
  return typeof v === 'string' ? v : '';
}
/* What the echo area shows of a hover answer: its text cut, Markdown's code fences left out, a run of blank lines
   one; '' for none. */
function hoverText(res: unknown): string {
  const c = res && typeof res === 'object' ? (res as { contents?: unknown }).contents : undefined;
  const lines = clean(cut(markupText(c), HOVER_MAX)).split('\n').filter(l => !/^\s*(```|~~~)/.test(l)).map(l => l.trimEnd());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/* What the echo area shows of a signature help answer: the active signature's label on one line, its active
   parameter between ‹ and ›; '' for none. A parameter's label is its [start, end) in the signature's label (UTF-16
   units), or its text, found after the label's first '('. */
function signatureText(res: unknown): string {
  const h = res && typeof res === 'object' ? res as { signatures?: unknown; activeSignature?: unknown; activeParameter?: unknown } : null;
  if (!h || !Array.isArray(h.signatures) || !h.signatures.length) return '';
  const k = isCount(h.activeSignature) && h.activeSignature < h.signatures.length ? h.activeSignature : 0;
  const sig = h.signatures[k] as { label?: unknown; parameters?: unknown; activeParameter?: unknown } | null;
  if (!sig || typeof sig !== 'object' || typeof sig.label !== 'string') return '';
  const lab = sig.label, ps = Array.isArray(sig.parameters) ? sig.parameters : [];
  const ap = sig.activeParameter !== undefined ? sig.activeParameter : h.activeParameter;
  let span: [number, number] | null = null;
  const pl = isCount(ap) && ap < ps.length && ps[ap] && typeof ps[ap] === 'object' ? (ps[ap] as { label?: unknown }).label : undefined;
  if (Array.isArray(pl) && isCount(pl[0]) && isCount(pl[1]) && pl[0] <= pl[1] && pl[1] <= lab.length) span = [pl[0], pl[1]];
  else if (typeof pl === 'string' && pl) {
    const i = lab.indexOf(pl, Math.max(0, lab.indexOf('(')));
    if (i >= 0) span = [i, i + pl.length];
  }
  const text = span ? `${lab.slice(0, span[0])}‹${lab.slice(span[0], span[1])}›${lab.slice(span[1])}` : lab;
  return cut(clean(text).replace(/\s+/g, ' ').trim(), SIGNATURE_MAX);
}

/* The signature in the echo area (and the buffer it is of), shown again after each command that leaves the echo
   area empty until the next answer replaces it. */
let shown: { b: EdBuffer; text: string } | null = null;
/* The one signature request: where point was (buffer, offset, version) when it was scheduled, its timer while the
   debounce runs, then its request. */
interface SigAsk { b: EdBuffer; pt: number; ver: number; timer: ReturnType<typeof setTimeout> | null; req: LspRpcRequest | null }
let sig: SigAsk | null = null;
/* Where the last signature was asked, so a command that moves nothing asks nothing more. */
let asked: { b: EdBuffer; pt: number; ver: number } | null = null;

/* Whether B is being typed in: Insert, Replace or Emacs state (any, without Evil). */
const typing = (b: EdBuffer) => !E.evil || b.evilState === 'insert' || b.evilState === 'replace' || b.evilState === 'emacs';
/* Whether B gets signatures while typing: its server runs and gives signature help, and it is being typed in. */
function signatures(b: EdBuffer) {
  const s = ofBuffer.get(b);
  return !!s && s.state === 'running' && !!(s.capabilities || {}).signatureHelpProvider && !b.minibuf && typing(b);
}
/* The echo area shows nothing of anyone else's: no minibuffer, prompt or search, and no message but an Evil
   state's (-- INSERT --). */
const STATE_ECHO = /^-- [A-Za-z() ]+ --$/;
const echoFree = () => !E.mini && !E.isearch && (E.prompt === null || E.prompt === undefined) &&
  (E.echo === '' || STATE_ECHO.test(E.echo) || (!!shown && E.echo === shown.text) || (!!diagShown && E.echo === diagShown.text));
function cancelSig() {
  const a = sig;
  sig = null;
  if (!a) return;
  if (a.timer) clearTimeout(a.timer);
  if (a.req) a.req.cancel();
}
/* B no longer uses its server: nothing more asked or shown of it. */
function forgetEldoc(b: EdBuffer) {
  if (sig && sig.b === b) cancelSig();
  if (asked && asked.b === b) asked = null;
  if (shown && shown.b === b) shown = null;
}
/* The debounce of A ran out: ask for the signature at point, when point is still where A was scheduled. */
function askSignature(a: SigAsk) {
  a.timer = null;
  const b = a.b;
  if (sig !== a) return;
  if (cur() !== b || b.pt !== a.pt || b.ver !== a.ver || !signatures(b)) { sig = null; return; }
  flush(b);
  const s = ofBuffer.get(b), conn = s && s.conn;
  if (!s || !conn || conn.closed() !== null || !signatures(b)) { sig = null; return; }
  asked = { b, pt: a.pt, ver: a.ver };
  try { a.req = conn.request('textDocument/signatureHelp', docParams(b), { timeout: timing.request }); } catch (e) { sig = null; return; }
  a.req.then(res => {
    if (sig !== a) return;
    sig = null;
    if (cur() !== b || b.pt !== a.pt || b.ver !== a.ver || !echoFree()) return;
    const text = signatureText(res);
    if (text) { E.echo = text; shown = { b, text }; }
    else if (shown) { E.echo = ''; shown = null; }
    else return;
    Ed.scheduleRender();
  }, () => { if (sig === a) sig = null; });   // cancelled, timed out, an error answer, the session lost: nothing shown
}
/* After each command: a request that point moved away from (or out of the buffer, or out of typing) is cancelled;
   while typing in a buffer whose server gives signature help, point's place, once it changed, is asked about
   after timing.eldoc with no further command, one request at a time. */
const prevPostEldoc = H.postCommand;
H.postCommand = (def, b0, failed) => {
  if (prevPostEldoc) prevPostEldoc(def, b0, failed);
  if (E.depth > 0) return;
  const b = cur(), want = !E.mini && signatures(b);
  if (shown && (!want || shown.b !== b)) shown = null;
  else if (shown && E.echo === '') E.echo = shown.text;
  if (sig && (!want || sig.b !== b || sig.pt !== b.pt || sig.ver !== b.ver)) cancelSig();
  if (!want) { asked = null; return; }
  if (sig || (asked && asked.b === b && asked.pt === b.pt && asked.ver === b.ver)) return;
  const a: SigAsk = { b, pt: b.pt, ver: b.ver, timer: null, req: null };
  a.timer = setTimeout(() => askSignature(a), timing.eldoc);
  sig = a;
};
CMD('eldoc', '', '', "Show the documentation of the identifier at point in the echo area (K where eglot-mode is on), from this buffer's language server (its hover).", async () => {
  const b = cur(), pt = b.pt, ver = b.ver;
  const text = hoverText(await askAt(b, 'textDocument/hover', 'hoverProvider', 'hover documentation'));
  if (!E.buffers.includes(b) || cur() !== b || b.pt !== pt || b.ver !== ver) return false;
  if (!text) return signal('user-error', 'No documentation here');
  E.echo = text;
  return false;
});

/* ---- diagnostics ---- */

/* A file keeps at most DIAG_FILE_MAX diagnostics of a publish and a session at most DIAG_FILES_MAX files with
   some (a publish for one more is dropped); a message is cut at DIAG_MESSAGE_MAX characters, a source and code at
   DIAG_SOURCE_MAX, a list row's message at DIAG_ROW_MAX, and the echo area's text at HOVER_MAX. */
const DIAG_FILE_MAX = 1000, DIAG_FILES_MAX = 2000, DIAG_MESSAGE_MAX = 2000, DIAG_SOURCE_MAX = 100, DIAG_ROW_MAX = 500;
/* LSP's severities 1 to 4 as flymake names them: an information and a hint are both notes. */
const SEVERITY = ['', 'error', 'warning', 'note', 'note'];
/* A diagnostic as published: its range (from 0, UTF-16 units), severity (1 to 4, an absent one an error), message
   and where it comes from (its source and code, '' for none); RAW is the diagnostic as published, given back to the
   server in a code action request's context (its code and data are the server's own). */
interface Diag { line: number; character: number; endLine: number; endCharacter: number; severity: number; message: string; source: string; raw: Record<string, unknown> }
/* A buffer's diagnostics placed in its text: positions in buffer.temps that follow its edits until the next
   publish, and the counts of errors, warnings and notes. */
interface Placed { s: Session; path: string; items: { d: Diag; start: EdTempMarker; end: EdTempMarker }[]; counts: [number, number, number] }
const placed = new WeakMap<EdBuffer, Placed>();
/* A diagnostics list: the session it is of, the file it lists (null: every file the server published for), its
   owner name for the error list. */
interface DiagList { s: Session; path: string | null; owner: string }
const diagLists = new Map<EdBuffer, DiagList>();
/* The places of a list's rows, by line (from 1). */
const diagRows = new WeakMap<EdBuffer, Map<number, Xref>>();
/* The diagnostics at point in the echo area (and the buffer they are of). */
let diagShown: { b: EdBuffer; text: string } | null = null;

/* One published diagnostic, or null when it is not one (no range, no message). */
function diagOf(it: unknown): Diag | null {
  if (!it || typeof it !== 'object') return null;
  const o = it as { range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }; severity?: unknown; message?: unknown; source?: unknown; code?: unknown };
  const r = o.range, st = r && typeof r === 'object' ? r.start : undefined, en = r && typeof r === 'object' ? r.end : undefined;
  if (!st || !en || !isCount(st.line) || !isCount(st.character) || !isCount(en.line) || !isCount(en.character) || typeof o.message !== 'string') return null;
  const severity = o.severity === 1 || o.severity === 2 || o.severity === 3 || o.severity === 4 ? o.severity : 1;
  const code = typeof o.code === 'string' || (typeof o.code === 'number' && Number.isFinite(o.code)) ? String(o.code) : '';
  const source = cut(clean([typeof o.source === 'string' ? o.source : '', code].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim(), DIAG_SOURCE_MAX);
  const backwards = en.line < st.line || (en.line === st.line && en.character < st.character);
  return {
    line: st.line, character: st.character, endLine: backwards ? st.line : en.line, endCharacter: backwards ? st.character : en.character,
    severity, message: cut(clean(o.message).trim(), DIAG_MESSAGE_MAX), source, raw: o as Record<string, unknown>,
  };
}
const byPlace = (a: { line: number; character: number }, c: { line: number; character: number }) => a.line - c.line || a.character - c.character;

/* The attached buffer of S that visits PATH. */
function bufferAt(s: Session, path: string): EdBuffer | null {
  const f = Ed.host.files;
  if (!f) return null;
  for (const b of s.buffers) if (b.file && !b.shared && f.resolve(b.file) === path) return b;
  return null;
}
/* textDocument/publishDiagnostics: PARAMS' file's diagnostics replaced (none: forgotten), placed in the buffer
   visiting it. A publish naming a version older than the one its server was last told of the buffer is about text
   gone and is dropped (the server publishes again for the newer one); a URI of another scheme is left out. */
function published(s: Session, params: unknown) {
  if (!params || typeof params !== 'object') return;
  const { uri: u, diagnostics, version } = params as { uri?: unknown; diagnostics?: unknown; version?: unknown };
  const path = typeof u === 'string' ? pathOf(u) : null;
  if (!path || !Array.isArray(diagnostics)) return;
  const b = bufferAt(s, path), d = b ? docs.get(b) : undefined;
  if (d && isCount(version) && version < d.sent) return;
  const list: Diag[] = [];
  for (const it of diagnostics) { if (list.length >= DIAG_FILE_MAX) break; const x = diagOf(it); if (x) list.push(x); }
  list.sort((a, c) => byPlace(a, c) || a.severity - c.severity);
  if (!list.length) s.diags.delete(path);
  else if (s.diags.has(path) || s.diags.size < DIAG_FILES_MAX) s.diags.set(path, list);
  else return;
  if (b) place(s, b);
  diagsChanged(s);
}
/* The offsets in T of LSP positions, as offsetOf finds them, over an index of T's line starts made once. */
function offsetsIn(t: string) {
  const starts = [0];
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 10 || (c === 13 && t.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
  }
  return (line: number, character: number) => {
    if (line >= starts.length) return t.length;
    const i = starts[line];
    let end = line + 1 < starts.length ? starts[line + 1] - 1 : t.length;
    if (end > i && t.charCodeAt(end) === 10 && t.charCodeAt(end - 1) === 13) end--;
    let p = Math.min(end, i + character);
    if (p > i && isHigh(t.charCodeAt(p - 1)) && isLow(t.charCodeAt(p))) p--;
    return p;
  };
}
/* B's diagnostics from S placed in its text. They are of the text the server holds (its document's, else the
   buffer's own): an edit not yet sent (one change, from the common prefix and suffix) moves those after it. */
function place(s: Session, b: EdBuffer) {
  unplace(b);
  const f = Ed.host.files;
  if (!f || !b.file) return;
  const path = f.resolve(b.file), list = s.diags.get(path);
  if (!list) return;
  const d = docs.get(b), base = d && d.s === s && live(d) ? d.text : b.text, now = b.text;
  const at = offsetsIn(base);
  let pre = 0, suf = 0;
  if (now !== base) {
    const n = Math.min(base.length, now.length);
    while (pre < n && base.charCodeAt(pre) === now.charCodeAt(pre)) pre++;
    while (suf < n - pre && base.charCodeAt(base.length - 1 - suf) === now.charCodeAt(now.length - 1 - suf)) suf++;
  }
  /* P in BASE where it is in NOW: before the change kept, after it moved by its length, inside it its start (an end
     its end); at the place of an insertion a start goes after the text inserted and an end stays before it. */
  const cutEnd = base.length - suf, delta = now.length - base.length;
  const moved = (p: number, end: boolean) => {
    if (now === base || p < pre) return p;
    if (p > cutEnd || (p === cutEnd && (p > pre || !end))) return p + delta;
    if (p === pre) return p;
    return end ? now.length - suf : pre;
  };
  const counts: [number, number, number] = [0, 0, 0];
  const items = list.map(x => {
    const start = { pos: moved(at(x.line, x.character), false) }, end = { pos: Math.max(start.pos, moved(at(x.endLine, x.endCharacter), true)) };
    b.temps.add(start); b.temps.add(end);
    counts[Math.min(x.severity, 3) - 1]++;
    return { d: x, start, end };
  });
  placed.set(b, { s, path, items, counts });
}
function unplace(b: EdBuffer) {
  const p = placed.get(b);
  if (!p) return;
  for (const it of p.items) { b.temps.delete(it.start); b.temps.delete(it.end); }
  placed.delete(b);
  if (diagShown && diagShown.b === b) diagShown = null;
}
/* S's server ended or was shut down: what it published is forgotten (a server started again publishes afresh). */
function dropDiags(s: Session) {
  s.diags.clear();
  for (const b of s.buffers) if (placed.get(b)?.s === s) unplace(b);
  diagsChanged(s);
}

/* The mode line's counts of B's diagnostics: E errors, W warnings, N notes, those with none left out. */
function countText(b: EdBuffer) {
  const p = placed.get(b);
  if (!p) return '';
  return p.counts.map((n, i) => (n ? `${'EWN'[i]}${n}` : '')).filter(Boolean).join(' ');
}
const prevLookDiag = H.look;
H.look = (b, w) => {
  const o: EdLook = prevLookDiag ? prevLookDiag(b, w) : {};
  const t = countText(b);
  if (t) o.extra = (o.extra ? o.extra + ' ' : '') + t;
  return o;
};

/* What the echo area shows of B's diagnostics at point: each whose range holds point (an empty range the
   characters beside it), errors first, `SEVERITY: MESSAGE (SOURCE)` on lines of their own; '' for none. */
function diagText(b: EdBuffer) {
  const p = placed.get(b);
  if (!p) return '';
  const pt = b.pt, hits = p.items.filter(it => (it.start.pos === it.end.pos ? it.start.pos - 1 <= pt && pt <= it.start.pos : it.start.pos <= pt && pt < it.end.pos));
  hits.sort((a, c) => a.d.severity - c.d.severity);
  return cut(hits.map(it => `${SEVERITY[it.d.severity]}: ${it.d.message}${it.d.source ? ` (${it.d.source})` : ''}`).join('\n'), HOVER_MAX);
}
/* Show B's diagnostics at point in the echo area when it holds nothing of anyone else's and no signature of B's
   is shown (a signature while typing comes first); a message of them shown before is cleared when point left
   them. Never in *Messages*. */
function showDiagAt(b: EdBuffer) {
  if (diagShown && diagShown.b !== b) diagShown = null;
  if (shown && shown.b === b) return;
  const text = diagText(b);
  if (!text) {
    if (diagShown && E.echo === diagShown.text) E.echo = '';
    diagShown = null;
    return;
  }
  if (diagShown && E.echo === diagShown.text && diagShown.text === text) return;
  if (!echoFree()) return;
  E.echo = text; diagShown = { b, text };
}
const prevPostDiag = H.postCommand;
H.postCommand = (def, b0, failed) => {
  if (prevPostDiag) prevPostDiag(def, b0, failed);
  if (E.depth > 0 || E.mini) return;
  showDiagAt(cur());
};

/* The rows of PATH's diagnostics from S, by place: where they are now in the attached buffer that visits it,
   else where the server put them. */
function rowsOf(s: Session, path: string) {
  const b = bufferAt(s, path), p = b && placed.get(b);
  const out: { x: Xref; d: Diag }[] = [];
  if (b && p && p.s === s && p.path === path) {
    for (const it of p.items) {
      const pos = Math.min(it.start.pos, b.rope.length), n = Ed.lineNoB(b, pos);
      out.push({ x: { path, line: n - 1, character: pos - Ed.lineStartB(b, n) }, d: it.d });
    }
  } else for (const d of s.diags.get(path) || []) out.push({ x: { path, line: d.line, character: d.character }, d });
  return out.sort((a, c) => byPlace(a.x, c.x) || a.d.severity - c.d.severity);
}
/* Draw the list LB of DL: for each file (by name, relative to the session's root when under it) a heading, then
   a row for each diagnostic, `LINE:COL  SEVERITY  MESSAGE  (SOURCE)`, the message on one line; point stays on its
   line. The error list's entries for them, and how many. */
function drawDiags(lb: EdBuffer, dl: DiagList) {
  const s = dl.s, top = s.root.replace(/\/+$/, '') + '/';
  const paths = dl.path ? [dl.path] : [...s.diags.keys()].sort();
  const out: string[] = [], rows = new Map<number, Xref>(), errors: SchemeValue[] = [];
  for (const path of paths) {
    const rs = rowsOf(s, path);
    if (!rs.length) continue;
    out.push(path.startsWith(top) ? path.slice(top.length) : abbr(path));
    const w = Math.max(...rs.map(r => `${r.x.line + 1}:${r.x.character + 1}`.length));
    for (const { x, d } of rs) {
      const msg = cut(d.message.replace(/\s*\n\s*/g, ' '), DIAG_ROW_MAX), sev = SEVERITY[d.severity];
      out.push(`  ${`${x.line + 1}:${x.character + 1}`.padEnd(w)}  ${sev.padEnd(7)}  ${msg}${d.source ? `  (${d.source})` : ''}`);
      rows.set(out.length, x);
      errors.push(L.list(path, x.line + 1, x.character + 1, `${sev}: ${msg}`, intern('utf-16')));
    }
  }
  if (!errors.length) out.push(s.state === 'stopping' || s.state === 'stopped' ? `No diagnostics: ${label(s)} was shut down` : 'No diagnostics');
  const line = Ed.lineNoB(lb, lb.pt);
  lb.readOnly = false; lb.text = out.join('\n') + '\n'; lb.readOnly = true; lb.modified = false;
  lb.mode = 'flymake-diagnostics-buffer-mode'; lb.evilState = 'motion'; lb.undo = []; lb.redo = []; Ed.forgetLog(lb);
  lb.pt = Ed.lineStartB(lb, Math.min(line, Ed.lineCountB(lb)));
  for (const w of Ed.windowList()) if (w.buffer === lb && w !== E.sel) w.pt = lb.pt;
  diagRows.set(lb, rows);
  return errors;
}
/* The sessions whose diagnostics changed since the lists were last drawn, and the timer that draws them. */
const diagDirty = new Set<Session>();
let diagTimer: ReturnType<typeof setTimeout> | null = null;
/* S's diagnostics changed: the mode line drawn again, the echo area's diagnostics at point, and S's lists after
   timing.diagnostics, each list's error list replaced when it is still the list's (the place kept). */
function diagsChanged(s: Session) {
  Ed.scheduleRender();
  if (E.depth === 0 && !E.mini && ofBuffer.get(cur()) === s) showDiagAt(cur());
  diagDirty.add(s);
  if (diagTimer) return;
  diagTimer = setTimeout(() => {
    diagTimer = null;
    const dirty = new Set(diagDirty);
    diagDirty.clear();
    for (const [lb, dl] of diagLists) {
      if (!E.buffers.includes(lb) || lb.mode !== 'flymake-diagnostics-buffer-mode') { diagLists.delete(lb); continue; }
      if (!dirty.has(dl.s)) continue;
      const errors = drawDiags(lb, dl);
      try { L.call('next-error-replace-list!', [dl.owner, L.list(...errors)]); } catch (e) { Ed.reportError(e); }
    }
    Ed.scheduleRender();
  }, timing.diagnostics);
}
/* List the current buffer's diagnostics (of its file, or with PROJECT of every file its server published for)
   in a buffer of their own, shown and selected in another window, point on the first row; the rows become the
   error list. */
function showDiags(project: boolean) {
  const b = cur(), s = sessionHere() as Session;
  const path = project ? null : Ed.host.files!.resolve(b.file!);
  const name = project ? `*Flymake diagnostics for project ${abbr(s.root)}*` : `*Flymake diagnostics for ${b.name}*`;
  const lb = Ed.getBufferCreate(name), dl: DiagList = { s, path, owner: name };
  diagLists.set(lb, dl);
  lb.pt = 0;
  const errors = drawDiags(lb, dl);
  L.call('next-error-set-list!', [L.list(...errors), dl.owner]);
  const w = Ed.popToBuffer(lb, true);
  lb.pt = errors.length ? Ed.lineStartB(lb, 2) : 0; w.start = 0;
  Ed.message(`${errors.length} diagnostic${errors.length === 1 ? '' : 's'}`);
  return false;
}
CMD('flymake-show-buffer-diagnostics', '', '', "List this buffer's diagnostics from its language server in *Flymake diagnostics for NAME*, kept up to date as the server publishes: RET visits one, o shows it, M-g n and M-g p step through them.", () => showDiags(false));
CMD('flymake-show-project-diagnostics', '', '', "List the diagnostics of every file this buffer's language server published for, by file, kept up to date: RET visits one, o shows it, M-g n and M-g p step through them.", () => showDiags(true));
CMD('flymake-goto-diagnostic', '', '', 'Visit the place of the diagnostic on the row at point in another window and select it (RET).', () => visitRow(false));
CMD('flymake-show-diagnostic', '', '', 'Show the place of the diagnostic on the row at point in another window, staying in the list (o).', () => visitRow(true));
Ed.MODE_NAMES['flymake-diagnostics-buffer-mode'] = 'Flymake diagnostics';
Ed.modeParents.set('flymake-diagnostics-buffer-mode', 'special-mode');
L.set('flymake-diagnostics-buffer-mode-map', new Ed.Keymap('flymake-diagnostics-buffer-mode-map'));

/* ---- workspace edits and rename ---- */

/* A workspace edit changes at most EDIT_FILES_MAX files and makes at most EDIT_EDITS_MAX text edits. */
const EDIT_FILES_MAX = 1000, EDIT_EDITS_MAX = 100_000;
/* One file's part of a workspace edit: its absolute path, the version the server says the edits are of (null:
   none given), and the edits, each a range of the text it was made against (from 0, UTF-16 units) and its new
   text, in the server's order. */
interface FileEdit { path: string; version: number | null; edits: { start: { line: number; character: number }; end: { line: number; character: number }; text: string }[] }
/* Why an edit is not applied: a refusal says it and nothing has changed. */
const refuse = (why: string): never => signal('user-error', `The server's edit is not applied: ${why}`) as never;

/* The files of a WorkspaceEdit, as documentChanges (preferred when both are given) or changes give them. A
   resource operation (creating, renaming or deleting a file: never offered), a document that is no file, one
   named twice, a malformed edit and an edit past the bounds refuse the whole edit. */
function fileEdits(edit: unknown, nm: (p: string) => string): FileEdit[] {
  if (edit === null || edit === undefined) return [];
  if (typeof edit !== 'object') return refuse('it is not a workspace edit');
  const o = edit as { documentChanges?: unknown; changes?: unknown };
  const parts: { uri: unknown; version: unknown; edits: unknown }[] = [];
  if (Array.isArray(o.documentChanges)) {
    for (const dc of o.documentChanges) {
      if (!dc || typeof dc !== 'object') return refuse('a document change is malformed');
      const c = dc as { kind?: unknown; textDocument?: { uri?: unknown; version?: unknown }; edits?: unknown };
      if (c.kind !== undefined) return refuse(`it would ${typeof c.kind === 'string' ? clean(c.kind.slice(0, 20)).replace(/\n/g, ' ') : 'change'} a file, which is not done here`);
      if (!c.textDocument || typeof c.textDocument !== 'object') return refuse('a document change names no document');
      parts.push({ uri: c.textDocument.uri, version: c.textDocument.version, edits: c.edits });
    }
  } else if (o.changes && typeof o.changes === 'object') {
    for (const [u, es] of Object.entries(o.changes as Record<string, unknown>)) parts.push({ uri: u, version: null, edits: es });
  }
  if (parts.length > EDIT_FILES_MAX) return refuse(`it changes ${parts.length} files, more than ${EDIT_FILES_MAX}`);
  const out: FileEdit[] = [], seen = new Set<string>();
  let n = 0;
  for (const p of parts) {
    const path = typeof p.uri === 'string' ? pathOf(p.uri) : null;
    if (!path) return refuse(`${typeof p.uri === 'string' ? cut(clean(p.uri), 200) : 'a document'} is not a file`);
    if (seen.has(path)) return refuse(`it names ${nm(path)} twice`);
    seen.add(path);
    if (p.version !== null && p.version !== undefined && !Number.isSafeInteger(p.version)) return refuse(`the version of ${nm(path)} is not a number`);
    if (!Array.isArray(p.edits)) return refuse(`its edits of ${nm(path)} are not a list`);
    if ((n += p.edits.length) > EDIT_EDITS_MAX) return refuse(`it makes more than ${EDIT_EDITS_MAX} edits`);
    const edits: FileEdit['edits'] = [];
    for (const e of p.edits) {
      const r = e && typeof e === 'object' ? (e as { range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } }).range : undefined;
      const text = e && typeof e === 'object' ? (e as { newText?: unknown }).newText : undefined;
      const st = r && typeof r === 'object' ? r.start : undefined, en = r && typeof r === 'object' ? r.end : undefined;
      if (!st || !en || !isCount(st.line) || !isCount(st.character) || !isCount(en.line) || !isCount(en.character) || typeof text !== 'string') return refuse(`an edit of ${nm(path)} is malformed`);
      edits.push({ start: { line: st.line, character: st.character }, end: { line: en.line, character: en.character }, text });
    }
    out.push({ path, version: p.version === null || p.version === undefined ? null : p.version as number, edits });
  }
  return out;
}

/* Who visits a path (by name or true name): the open buffers' names and true names worked out once per edit,
   not once a file and buffer. */
function visitors(): (path: string) => EdBuffer | null {
  const f = Ed.host.files!, by = new Map<string, EdBuffer>();
  for (const o of E.buffers) {
    if (!o.file) continue;
    const p = f.resolve(o.file);
    if (!by.has(p)) by.set(p, o);
    const t = f.truename ? f.truename(p) : p;
    if (!by.has(t)) by.set(t, o);
  }
  return path => by.get(path) || (f.truename ? by.get(f.truename(path)) : undefined) || null;
}
/* PATH visited in a buffer of its own without showing it: the selected window keeps its buffer, point and
   history. Null when it could not be visited. */
function visitQuietly(path: string): EdBuffer | null {
  const w = E.sel, keep = w ? { buffer: w.buffer, pt: w.pt, start: w.start, prev: w.prev.slice() } : null;
  let v: unknown = null;
  try { v = Ed.visit(path); } catch (e) { v = null; }
  finally { if (w && keep) { Ed.setWindowBuffer(keep.buffer, w); w.pt = keep.pt; w.start = keep.start; w.prev = keep.prev; } }
  return v instanceof Ed.Buffer ? v : null;
}
/* The ops (descending, for one applyOps batch) that make FE's edits in T, or why not: a place past T's end (the
   start of the line after its last is its end, as a whole-document edit names it), a range ending before it starts, two that overlap. Inserts at one place keep the server's order. Each edit is cut
   to what it changes (the text it keeps at both ends left alone, never splitting a surrogate pair or a \r\n), so
   point and marks in an unchanged part stay. */
const pastEnd = (p: { line: number; character: number }, lines: number) => p.line > lines || (p.line === lines && p.character > 0);
function opsOf(t: string, fe: FileEdit, nm: (p: string) => string): EdEditOp[] | string {
  const at = offsetsIn(t);
  let lines = 1;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c === 10 || (c === 13 && t.charCodeAt(i + 1) !== 10)) lines++; }
  const es: { s: number; e: number; text: string; i: number }[] = [];
  for (const [i, x] of fe.edits.entries()) {
    if (pastEnd(x.start, lines) || pastEnd(x.end, lines)) return `an edit of ${nm(fe.path)} is past its last line, ${lines}`;
    if (byPlace(x.end, x.start) < 0) return `an edit of ${nm(fe.path)} ends before it starts`;
    es.push({ s: at(x.start.line, x.start.character), e: at(x.end.line, x.end.character), text: x.text, i });
  }
  /* by place; at one place an insertion first, then the server's order */
  es.sort((a, c) => a.s - c.s || (a.e === a.s ? 0 : 1) - (c.e === c.s ? 0 : 1) || a.i - c.i);
  for (let k = 1; k < es.length; k++) if (es[k].s < es[k - 1].e) return `two edits of ${nm(fe.path)} overlap`;
  const split = (p: number) => { const a = t.charCodeAt(p - 1), b = t.charCodeAt(p); return (isHigh(a) && isLow(b)) || (a === 13 && b === 10); };
  const ops: EdEditOp[] = [];
  for (let k = es.length - 1; k >= 0; k--) {
    const { s, e, text } = es[k], old = t.slice(s, e), n = Math.min(old.length, text.length);
    let pre = 0; while (pre < n && old.charCodeAt(pre) === text.charCodeAt(pre)) pre++;
    let suf = 0; while (suf < n - pre && old.charCodeAt(old.length - 1 - suf) === text.charCodeAt(text.length - 1 - suf)) suf++;
    if (pre > 0 && split(s + pre)) pre--;
    if (suf > 0 && split(e - suf)) suf--;
    if (pre + suf === old.length && pre + suf === text.length) continue;
    ops.push([s + pre, old.length - pre - suf, text.slice(pre, text.length - suf)]);
  }
  return ops;
}

/* Apply S's server's workspace EDIT, all of it or none: every file is checked before any is changed, and a
   refusal (a user-error saying why) changes nothing and leaves no buffer it opened. A file must be in S's root and
   on this machine; an open one must be writable and hold the text the server made the edit against: a version
   given must be the one it was last told of, and the buffer must have no edit it was not told of (no version:
   the same, or for a buffer that is not its document, no unsaved change). A file not open is visited (its mode
   on, so its server is told of it) without being shown. Each buffer's edits are one batch and one undo step;
   OWN's step is the command's (the command loop records it). The buffers are left unsaved. Gives how many edits
   were made in how many files, and how many files were visited for it. HELD, for an edit answering a request, is
   the text the server held of each of its documents when the request was sent, by path (heldBy): a document whose
   text changed since (a didChange sent while the server worked), opened since, or closed since (its buffer killed,
   so the file would be visited afresh from the disk) is refused too, a version named or not. */
function applyEdit(s: Session, edit: unknown, own: EdBuffer | null, held: Map<string, string> | null): { edits: number; files: number; opened: number; changed: EdBuffer[] } {
  /* Visiting a file asks every open buffer's true name (Ed.visit's same-file check), so a thousand files visited
     would ask a million: each path's true name is asked of the disk once while the edit is checked and applied,
     all of it in one turn of the loop. */
  const f = Ed.host.files, real = f && f.truename;
  if (!f || !real) return applyEditNow(s, edit, own, held);
  const known = new Map<string, string>();
  f.truename = (p: string) => { let t = known.get(p); if (t === undefined) known.set(p, t = real.call(f, p)); return t; };
  try { return applyEditNow(s, edit, own, held); } finally { f.truename = real; }
}
/* The text S's server holds of each of its documents, now, by the document's path and true name: by path, not by
   buffer, so a document closed before the answer comes is still known to have been the server's. */
function heldBy(s: Session): Map<string, string> {
  const m = new Map<string, string>(), f = Ed.host.files!;
  for (const b of E.buffers) {
    const d = docs.get(b);
    if (!d || d.s !== s || !live(d)) continue;
    const p = f.resolve(d.file);
    m.set(p, d.text);
    if (f.truename) m.set(f.truename(p), d.text);
  }
  return m;
}
function applyEditNow(s: Session, edit: unknown, own: EdBuffer | null, held: Map<string, string> | null): { edits: number; files: number; opened: number; changed: EdBuffer[] } {
  const f = Ed.host.files;
  if (!f) return refuse('there are no files here');
  const root = s.root.replace(/\/+$/, '') || '/', rootTrue = f.truename ? f.truename(root) : root;
  const inRoot = (p: string) => root === '/' || p === root || p.startsWith(root + '/');
  /* a file as the messages name it: from the root when under it */
  const nm = (p: string) => cut(clean(root !== '/' && p.startsWith(root + '/') ? p.slice(root.length + 1) : abbr(p)).replace(/\n/g, ' '), 200);
  const visiting = visitors();
  const fes = fileEdits(edit, nm).filter(fe => fe.edits.length);
  const plan: { fe: FileEdit; b: EdBuffer | null }[] = [];
  for (const fe of fes) {
    const shown = nm(fe.path);
    const t = f.truename ? f.truename(fe.path) : fe.path;
    if (!inRoot(fe.path) || !(rootTrue === '/' || t === rootTrue || t.startsWith(rootTrue + '/'))) refuse(`${shown} is not in ${nm(root)}`);
    if (Ed.sync && Ed.sync.started && H.servedPath && H.servedPath(fe.path)) refuse(`${shown} is edwind's: edit it there`);
    /* the text the server held of this file when the request was sent; undefined when it was not its document then */
    const was = held ? (held.has(fe.path) ? held.get(fe.path) : held.get(t)) : undefined;
    const b = visiting(fe.path);
    if (!b) {
      if (was !== undefined) refuse(`${shown} was closed while the server worked`);
      if (!f.exists(fe.path)) refuse(`${shown}: no such file`);
      if (fe.version !== null) refuse(`${shown} is not open, but the edit is of its version ${fe.version}`);
      plan.push({ fe, b: null });
      continue;
    }
    if (b.shared) refuse(`${nm(fe.path)} is edwind's: edit it there`);
    if (b.readOnly) refuse(`${nm(fe.path)} is read-only`);
    const d = docs.get(b), ours = !!d && d.s === s && live(d);
    /* held: the file must hold the text the server held of it, and a document of the server not held then was opened since */
    if (held && (was !== undefined ? was !== b.text : ours)) refuse(`${nm(fe.path)} has changed since the server made the edit`);
    if (ours && b.text !== d!.text) refuse(`${nm(fe.path)} has changed since the server made the edit`);
    if (fe.version !== null && (!ours || fe.version !== d!.sent)) refuse(`${nm(fe.path)} is not the version the edit is of (${fe.version}${ours ? `; the server was told of ${d!.sent}` : ''})`);
    if (!ours && b.modified) refuse(`${nm(fe.path)} has changes its server was not told of`);
    plan.push({ fe, b });
  }
  const opened: EdBuffer[] = [];
  const give = (why: string): never => {
    for (const b of opened) if (E.buffers.includes(b)) { b.modified = false; L.call('kill-buffer', [b]); }
    return refuse(why);
  };
  for (const p of plan) {
    if (p.b) continue;
    const b = visitQuietly(p.fe.path);
    if (!b) give(`${nm(p.fe.path)} could not be visited`);
    if (!opened.includes(b!)) opened.push(b!);
    if (b!.readOnly) give(`${nm(p.fe.path)} is read-only`);
    p.b = b;
  }
  const batches: { b: EdBuffer; ops: EdEditOp[] }[] = [];
  for (const p of plan) {
    if (batches.some(x => x.b === p.b)) give(`it names ${nm(p.fe.path)} twice`);
    const ops = opsOf(p.b!.text, p.fe, nm);
    if (typeof ops === 'string') give(ops);
    batches.push({ b: p.b!, ops: ops as EdEditOp[] });
  }
  let edits = 0;
  const changed: EdBuffer[] = [];
  for (const { b, ops } of batches) {
    if (!ops.length) continue;
    if (b !== own) {
      if (b.pendingUndo) { if (Ed.changedSince(b, b.pendingUndo.ver)) b.undo.push(b.pendingUndo); b.pendingUndo = null; }
      b.undo.push(Ed.snap(b)); b.redo = [];
    }
    Ed.applyOps(b, ops);
    b.modified = true;
    edits += ops.length; changed.push(b);
  }
  return { edits, files: changed.length, opened: opened.length, changed };
}

/* The identifier at point in B, offered as the new name's start: letters, digits, _ and $. */
function identifierAt(b: EdBuffer) {
  const t = b.rope, re = /[\p{L}\p{N}_$]/u;
  let s = b.pt, e = b.pt;
  while (s > 0 && re.test(t.slice(s - 1, s))) s--;
  while (e < t.length && re.test(t.slice(e, e + 1))) e++;
  return t.slice(s, e);
}
CMD('eglot-rename', async () => {
  const b = cur(), old = identifierAt(b);
  return [await Ed.readMini(old ? `Rename ${old} to: ` : 'Rename to: ', old)];
}, 'NEWNAME', "Rename the identifier at point to NEWNAME everywhere this buffer's language server finds it: its edit is applied to every file it names or to none, each buffer's part one undo step; files not open are visited for it, and nothing is saved.", async ([n]: SchemeValue[]) => {
  const b = cur(), name = (typeof n === 'string' ? n : '').trim();
  if (!name) return signal('user-error', 'No new name given');
  let held: Map<string, string> | null = null;
  const res = await askAt(b, 'textDocument/rename', 'renameProvider', 'renames', { newName: name }, s => { held = heldBy(s); });
  const s = ofBuffer.get(b);
  if (!E.buffers.includes(b)) return false;
  if (!s || cur() !== b) { Ed.message(`Rename to ${cut(clean(name), 200)} dropped: ${cut(clean(b.name), 200)} ${s ? 'is no longer the current buffer' : 'left its language server'}`); return false; }
  if (res === null || res === undefined) return signal('user-error', `${s.name} renames nothing here`);
  const r = applyEdit(s, res, b, held);
  if (!r.files) { Ed.message(`Nothing to rename: the server's edit changes nothing`); return false; }
  Ed.message(`Renamed to ${cut(clean(name), 200)}: ${editCount(r)}, not saved`);
  return false;
});
const editCount = (r: { edits: number; files: number; opened: number }) =>
  `${r.edits} edit${r.edits === 1 ? '' : 's'} in ${r.files} file${r.files === 1 ? '' : 's'}${r.opened ? ` (${r.opened} visited for it)` : ''}`;

/* ---- code actions ---- */

/* The kinds of code action initialize names (a server sends others too, shown as they are). An answer keeps at most
   ACTION_MAX actions; a title is cut at LABEL_MAX characters and a kind at ANN_MAX. */
const ACTION_KINDS = ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'];
const ACTION_MAX = 500;
/* A code action as kept: its title and kind made fit to show, whether the server prefers it, its workspace edit
   (null: none) and its command (null: none): the name the server knows it by and its arguments, given back as they
   came. A bare Command is an action with a command alone. */
interface CodeAction { title: string; kind: string; preferred: boolean; edit: object | null; command: { name: string; args: unknown[] | undefined } | null }
/* The command a server runs for a code action while it runs: the session, the buffer it was chosen in and what the
   server's own edits (workspace/applyEdit) did meanwhile: their edits, the buffers they changed (one edited twice
   counted once) and the files visited for them. One at a time: the command loop holds the keys while it waits. */
let executing: { s: Session; b: EdBuffer; edits: number; changed: Set<EdBuffer>; opened: number; refused: string | null } | null = null;

/* A Command ({title, command, arguments}) as code action requests give it, or null when it is malformed. */
function commandOf(c: unknown): CodeAction['command'] {
  const o = c && typeof c === 'object' ? c as { command?: unknown; arguments?: unknown } : null;
  if (!o || typeof o.command !== 'string' || !o.command || (o.arguments !== undefined && !Array.isArray(o.arguments))) return null;
  return { name: o.command, args: o.arguments as unknown[] | undefined };
}
/* One item of a code action answer, or null when it is malformed, disabled, or does nothing (an action whose edit
   would come from codeAction/resolve, which initialize does not offer). */
function actionOf(it: unknown): CodeAction | null {
  if (!it || typeof it !== 'object') return null;
  const o = it as { title?: unknown; kind?: unknown; isPreferred?: unknown; disabled?: unknown; edit?: unknown; command?: unknown };
  if (typeof o.title !== 'string') return null;
  const title = oneLine(o.title, LABEL_MAX);
  if (!title) return null;
  if (typeof o.command === 'string') {
    const command = commandOf(o);
    return command && { title, kind: '', preferred: false, edit: null, command };
  }
  if (o.disabled !== undefined && o.disabled !== null) return null;
  const edit = o.edit === undefined || o.edit === null ? null : o.edit;
  if (edit !== null && typeof edit !== 'object') return null;
  let command: CodeAction['command'] = null;
  if (o.command !== undefined && o.command !== null) { command = commandOf(o.command); if (!command) return null; }
  if (!edit && !command) return null;
  return { title, kind: typeof o.kind === 'string' ? oneLine(o.kind, ANN_MAX) : '', preferred: o.isPreferred === true, edit: edit as object | null, command };
}

/* The range code actions are asked about in B: Evil's visual selection, else the active region, else point. */
function actionRange(b: EdBuffer): [number, number] {
  if (EvilCore.stateOf(b) === 'visual' && b.mark !== null) { const [s, e] = EvilCore.visualRange(b, true); return [s, e]; }
  if (b.markActive && b.mark !== null) return [Math.min(b.pt, b.mark), Math.max(b.pt, b.mark)];
  return [b.pt, b.pt];
}
/* The diagnostics B's server published that its text holds from LO to HI (a diagnostic touching either end among them), as the
   server published them but at their range now: the context of a code action request. */
function diagnosticsIn(b: EdBuffer, lo: number, hi: number): Record<string, unknown>[] {
  const p = placed.get(b), t = b.text;
  if (!p) return [];
  const at = (pos: number) => position(t, Math.min(pos, t.length));
  return p.items.filter(it => it.start.pos <= hi && lo <= it.end.pos).map(it => ({ ...it.d.raw, range: { start: at(it.start.pos), end: at(it.end.pos) } }));
}

/* Ask B's server for the code actions of the range (ONLY: of those kinds alone), point or the region, with the
   diagnostics there. Gives the session, the actions (malformed and disabled ones left out, at most ACTION_MAX) and
   the text the server held of each document when it was asked (heldBy); null when the answer is dropped (the buffer
   killed, no longer current, or out of its server, said). */
async function askActions(b: EdBuffer, only: string[] | null) {
  const [lo0, hi0] = actionRange(b);
  /* kept as positions that follow edits while the server is waited for */
  const lo = { pos: lo0 }, hi = { pos: hi0 };
  b.temps.add(lo); b.temps.add(hi);
  let held: Map<string, string> | null = null;
  const params: Record<string, unknown> = { position: undefined };
  let res: unknown;
  try {
    res = await askAt(b, 'textDocument/codeAction', 'codeActionProvider', 'code actions', params, s => {
      held = heldBy(s);
      params.range = { start: position(b.text, lo.pos), end: position(b.text, hi.pos) };
      params.context = { diagnostics: diagnosticsIn(b, lo.pos, hi.pos), ...(only ? { only } : {}), triggerKind: 1 };
    });
  } finally { b.temps.delete(lo); b.temps.delete(hi); }
  const s = ofBuffer.get(b);
  if (!E.buffers.includes(b)) return null;
  if (!s || cur() !== b) { Ed.message(`Code actions dropped: ${cut(clean(b.name), 200)} ${s ? 'is no longer the current buffer' : 'left its language server'}`); return null; }
  const actions: CodeAction[] = [];
  /* the kinds asked for alone, as LSP has the client filter them (a bare Command has no kind) */
  const wanted = (a: CodeAction) => !only || only.some(k => a.kind === k || a.kind.startsWith(k + '.'));
  for (const it of Array.isArray(res) ? res : []) { if (actions.length >= ACTION_MAX) break; const a = actionOf(it); if (a && wanted(a)) actions.push(a); }
  return { s, actions, held: held as Map<string, string> | null };
}

/* Choose one of ACTIONS in the minibuffer, the server's preferred ones first (the first selected), each shown by its
   title (a title given twice numbered) and kind. */
async function pickAction(actions: CodeAction[]): Promise<CodeAction> {
  const order = actions.filter(a => a.preferred).concat(actions.filter(a => !a.preferred));
  const by = new Map<string, CodeAction>();
  for (const a of order) {
    let name = a.title;
    for (let n = 2; by.has(name); n++) name = `${a.title} (${n})`;
    by.set(name, a);
  }
  const name = await Ed.readMini('Code action: ', '', () => [...by.keys()], { require: true, keepOrder: true, kind: 'eglot-code-action', annotate: n => (by.get(n) || { kind: '' }).kind });
  return by.get(name)!;   // require: one of them
}

/* Carry out A, chosen in B from S's answer (HELD: the text the server held of each document when it was asked): a
   command the server does not name among its own (executeCommandProvider) is refused, and one it does is run only
   once the user says yes. Then the edit, all or none (applyEdit, one undo step a buffer, the current buffer's the
   command's), and then the command (workspace/executeCommand), during which the server's own edits are applied as
   any workspace edit is (serverEdit). A refused edit runs no command. */
async function runAction(s: Session, b: EdBuffer, a: CodeAction, held: Map<string, string> | null) {
  const cmd = a.command, shown = cmd ? cut(clean(cmd.name), 200) : '';
  /* after each wait for the user: B still current and on S, which runs */
  const still = () => {
    if (!E.buffers.includes(b) || cur() !== b || ofBuffer.get(b) !== s || s.state !== 'running')
      signal('user-error', `${a.title}: dropped, as ${cut(clean(b.name), 200)} is no longer current or its server no longer runs`);
  };
  still();
  if (cmd) {
    const ec = (s.capabilities || {}).executeCommandProvider as { commands?: unknown } | undefined;
    if (!ec || typeof ec !== 'object' || !Array.isArray(ec.commands) || !ec.commands.includes(cmd.name))
      return signal('user-error', `${a.title}: ${shown} is not a command ${s.name} runs, and Edwin runs none of a server's commands itself`);
    if (!await Ed.yesOrNo(`${a.title}: let ${s.name} run its command ${shown}?`)) { Ed.message(`${a.title}: nothing done`); return false; }
    still();
  }
  const done: string[] = [];
  let changed = false, touched: EdBuffer[] = [];
  if (a.edit) {
    const r = applyEdit(s, a.edit, b, held);
    done.push(r.files ? editCount(r) : 'its edit changes nothing');
    changed = r.files > 0;
    touched = r.changed;
  }
  if (cmd) {
    /* the command runs on the text as it now is: this buffer and every buffer the edit changed sent first */
    for (const c of new Set([b, ...touched])) flush(c);
    /* S runs: nothing has waited since still() */
    const conn = s.conn!;
    const x = executing = { s, b, edits: 0, changed: new Set<EdBuffer>(), opened: 0, refused: null as string | null };
    try { await quittable(conn.request('workspace/executeCommand', { command: cmd.name, ...(cmd.args ? { arguments: cmd.args } : {}) }, { timeout: timing.request })); }
    finally { if (executing === x) executing = null; }
    const files = x.changed.size;
    done.push(`${shown} run${files ? `, its edits ${editCount({ edits: x.edits, files, opened: x.opened })}` : ''}${x.refused ? `; an edit of it refused: ${x.refused}` : ''}`);
    changed = changed || files > 0;
  }
  Ed.message(`${a.title}: ${done.join('; ')}${changed ? ', not saved' : ''}`);
  return false;
}

/* workspace/applyEdit, a server asking for an edit: applied, all or none, only while a command the user let the
   server run is running; any other edit is refused, the server told why. Each buffer's part is one undo step: the
   command's own buffer's is the command's while it is still current. */
function serverEdit(s: Session, params: unknown) {
  const x = executing;
  if (!x || x.s !== s) return { applied: false, failureReason: 'Edwin applies a server\'s edit only while it runs a command the user chose' };
  const edit = params && typeof params === 'object' ? (params as { edit?: unknown }).edit : undefined;
  try {
    const r = applyEdit(s, edit, cur() === x.b ? x.b : null, null);
    x.edits += r.edits; x.opened += r.opened;
    for (const c of r.changed) x.changed.add(c);
    /* sent before the answer, so the server's next edit is of the text it now holds */
    for (const c of r.changed) flush(c);
    Ed.scheduleRender();
    return { applied: true };
  } catch (e) {
    const why = Ed.errorText(e);
    x.refused = why;
    Ed.message(why);
    return { applied: false, failureReason: why };
  }
}

/* The code actions at point or of the region, ONLY those kinds when given: one chosen and carried out; with SOLE,
   a single action is carried out without being chosen. */
async function codeActions(only: string[] | null, sole: boolean) {
  const b = cur(), got = await askActions(b, only);
  if (!got) return false;
  const { s, actions, held } = got;
  if (!actions.length) return signal('user-error', only ? `No ${only.join(', ')} code actions here` : 'No code actions here');
  const a = sole && actions.length === 1 ? actions[0] : await pickAction(actions);
  return runAction(s, b, a, held);
}
CMD('eglot-code-actions', '', '', "Choose one of the code actions this buffer's language server offers at point (or for the region) and carry it out: its edit applied to every file it names or to none, each buffer's part one undo step, nothing saved; a command of the server's run only once you say yes.", () => codeActions(null, false));
CMD('eglot-code-action-quickfix', '', '', 'Carry out the quick fix this buffer\'s language server offers for the diagnostics at point (or in the region): a single one at once, else the one chosen; as eglot-code-actions does.', () => codeActions(['quickfix'], true));

/* ---- symbols ---- */

/* An answer keeps at most SYMBOL_MAX symbols, and a document symbol's children are followed SYMBOL_DEPTH levels
   down; a name is cut at LABEL_MAX characters, a container at ANN_MAX, and a name under others (`outer.inner`)
   past LABEL_MAX keeps its end, '…' in place of the start. */
const SYMBOL_MAX = 5000, SYMBOL_DEPTH = 32;
/* LSP's SymbolKind (1 to 26; not CompletionItemKind), the annotation of a symbol. */
const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];
const symbolKind = (k: unknown) => (Number.isSafeInteger(k) && (k as number) > 0 && (k as number) < SYMBOL_KINDS.length ? SYMBOL_KINDS[k as number] : '');
const cutStart = (t: string) => {
  if (t.length <= LABEL_MAX) return t;
  const k = t.length - LABEL_MAX;
  return '…' + t.slice(isLow(t.charCodeAt(k)) ? k + 1 : k);
};
/* The start of the LSP range R, or null when it has none. */
function startOf(r: unknown): LspPos | null {
  const st = r && typeof r === 'object' ? (r as { start?: unknown }).start : undefined;
  const o = st && typeof st === 'object' ? st as { line?: unknown; character?: unknown } : null;
  return o && isCount(o.line) && isCount(o.character) ? { line: o.line, character: o.character } : null;
}
/* A symbol as kept: its name (under its parents', `outer.inner`, or its container's), its kind and where it is. */
interface LspSymbol { name: string; kind: string; container: string; x: Xref }
type SymbolItem = { name?: unknown; kind?: unknown; containerName?: unknown; location?: unknown; range?: unknown; selectionRange?: unknown; children?: unknown };
/* The symbols of a textDocument/documentSymbol or workspace/symbol answer, in its order, at most SYMBOL_MAX:
   DocumentSymbols, each at its selectionRange's start (else its range's), followed into their children, named
   under their parent; SymbolInformation and WorkspaceSymbols at their location's range's start. Left out: an item
   that is no object or has no name or a blank one (its children with it), one with no place (a WorkspaceSymbol
   whose location has no range, to be resolved, which initialize does not offer), one in no file (another URI
   scheme). A DocumentSymbol's path is IN. */
function symbolsOf(res: unknown, inPath: string | null): LspSymbol[] {
  const out: LspSymbol[] = [];
  const walk = (items: unknown, parent: string, depth: number) => {
    if (!Array.isArray(items) || depth > SYMBOL_DEPTH) return;
    for (const it of items) {
      if (out.length >= SYMBOL_MAX) return;
      /* anything but an object has no name */
      const o = (it || {}) as SymbolItem;
      const name = typeof o.name === 'string' ? oneLine(o.name, LABEL_MAX) : '';
      if (!name) continue;
      const kind = symbolKind(o.kind);
      if (o.location !== undefined) {
        const loc = o.location && typeof o.location === 'object' ? o.location as { uri?: unknown; range?: unknown } : {};
        const path = typeof loc.uri === 'string' ? pathOf(loc.uri) : null, at = startOf(loc.range);
        const container = typeof o.containerName === 'string' ? oneLine(o.containerName, ANN_MAX) : '';
        if (path && at) out.push({ name, kind, container, x: { path, ...at } });
        continue;
      }
      const at = startOf(o.selectionRange) || startOf(o.range);
      if (!at || inPath === null) continue;
      const full = parent ? cutStart(`${parent}.${name}`) : name;
      out.push({ name: full, kind, container: '', x: { path: inPath, ...at } });
      walk(o.children, full, depth + 1);
    }
  };
  walk(res, '', 0);
  return out;
}

/* B's symbols from its server for consult-imenu (name, kind, offset), in the order of the text; null, for the
   buffer's own definitions, when the server is not asked (B has no session, or its server gives no
   documentSymbolProvider, as one still starting gives none) or its answer is not used (an error answer, none in
   timing.request, no symbol of B in it, or B changed while it was asked). The pending change is sent first; C-g
   quits the wait. The answer to a buffer killed or no longer current meanwhile is dropped with a user-error. */
async function serverImenu(b: EdBuffer): Promise<{ name: string; kind: string; pos: number }[] | null> {
  const s = ofBuffer.get(b);
  /* a server has capabilities (and a connection) only while it runs */
  if (!s || !(s.capabilities || {}).documentSymbolProvider) return null;
  flush(b);
  const conn = s.conn!, d = docs.get(b), u = d ? d.uri : fileUri(b), ver = b.ver;
  /* an error answer, or none in time: no symbol */
  let res: unknown = null;
  try { res = await quittable(conn.request('textDocument/documentSymbol', { textDocument: { uri: u } }, { timeout: timing.request })); }
  catch (e) { if (L.isQuit(e)) throw e; }
  /* a killed buffer is in no window, so never the current one */
  if (cur() !== b) return signal('user-error', `Symbols dropped: ${cut(clean(b.name), 200)} is no longer the current buffer`);
  if (b.ver !== ver) return null;
  const path = pathOf(u), t = b.text;
  const items = symbolsOf(res, path).filter(y => y.x.path === path)
    .map(y => ({ name: y.container ? cutStart(`${y.container}.${y.name}`) : y.name, kind: y.kind, pos: offsetOf(t, y.x) }));
  /* in the order of the text, symbols at one place in the answer's */
  items.sort((a, c) => a.pos - c.pos);
  return items.length ? items : null;
}
/* consult-imenu: the server's symbols where serverImenu gives them, else as before (the buffer's own definitions,
   a Markdown buffer's headings), chosen with the same live preview and visited by the same command. */
{
  const orig = L.toFn(intern('consult-imenu'));
  const spec = async () => {
    const b = cur(), items = await serverImenu(b);
    if (!items) return (orig.interactive as () => unknown)();
    const w = E.sel!, start = b.pt, startScroll = w.start;
    const names = items.map((it, i) => it.name + (items.findIndex(x => x.name === it.name) !== i ? ' <' + (i + 1) + '>' : ''));
    let cancelled = true, v;
    try {
      v = await Ed.readMini('Go to symbol: ', '', () => names, { kind: 'imenu', require: true, keepOrder: true, annotate: c => items[names.indexOf(c)].kind,
        onSelect: c => { if (!c) return; b.pt = items[names.indexOf(c)].pos; E.recenter = 'center'; } });
      cancelled = false;
    } finally { if (cancelled) { b.pt = start; w.start = startScroll; } }
    return [items[names.indexOf(v)].pos + 1];
  };
  const g: SchemeProcedure = CMD('consult-imenu', spec, orig.params as string, `${orig.doc} In a buffer whose language server gives document symbols, its symbols.`, (args: SchemeValue[]) => orig(args));
  if (orig.props) g.props = new Map(orig.props);
}

/* The labels of SYMS for the minibuffer: each its name, numbered when given before (`name (2)`), past a label
   taken. NEXT keeps each name's next number, so many symbols of one name are labelled in linear time. */
function labelSymbols(syms: LspSymbol[]) {
  const labels: string[] = [], by = new Map<string, LspSymbol>(), next = new Map<string, number>();
  for (const y of syms) {
    let l = y.name, n = next.get(y.name) || 2;
    while (by.has(l)) l = `${y.name} (${n++})`;
    next.set(y.name, n);
    by.set(l, y); labels.push(l);
  }
  return { labels, by };
}
/* consult-eglot-symbols: the workspace's symbols from the current buffer's server, asked for (workspace/symbol)
   timing.symbols after the input last changed, one request at a time (the one before cancelled), none for a blank
   input. The candidates are those of the last answer: while it is the answer for the input shown, in the server's
   order as it matched them, else filtered by the minibuffer. An answer for an input no longer shown is dropped; an
   error answer is flashed after the input. The one chosen is visited as a definition is (its place recorded for
   xref-go-back and C-o). Leaving the minibuffer cancels what is pending. */
async function workspaceSymbols() {
  const b = cur(), s = await readyFor(b, 'workspaceSymbolProvider', 'workspace symbols');
  const top = s.root.replace(/\/+$/, '') + '/';
  let shown = labelSymbols([]), answered = '', timer: ReturnType<typeof setTimeout> | null = null, req: LspRpcRequest | null = null;
  const stop = () => { if (timer) clearTimeout(timer); timer = null; if (req) req.cancel(); req = null; };
  const annotate = (l: string) => {
    const y = shown.by.get(l);
    if (!y) return '';
    const where = (y.x.path.startsWith(top) ? y.x.path.slice(top.length) : abbr(y.x.path)) + ':' + (y.x.line + 1);
    return [y.kind, y.container && `in ${y.container}`, where].filter(Boolean).join('  ');
  };
  const take = (m: EdMini, text: string, syms: LspSymbol[]) => {
    shown = labelSymbols(syms); answered = text;
    /* new candidates for the same input: the minibuffer's cache dropped, the first highlighted */
    m.cache = null; m.scroll = 0; m.index = 0;
    Ed.scheduleRender();
  };
  /* called by the minibuffer after each change of its input, so a request or an answer outlives no input */
  const onChange = (text: string) => {
    const m = E.mini!;
    stop();
    if (text === answered) return;
    if (!text.trim()) { take(m, text, []); return; }
    timer = setTimeout(() => {
      timer = null;
      if (s.state !== 'running') return;
      const r = req = s.conn!.request('workspace/symbol', { query: text }, { timeout: timing.request });
      /* a request is cancelled whenever the input changes: an answer is for the input shown */
      r.then(res => {
        req = null;
        take(m, text, symbolsOf(res, null));
      }, e => {
        if (req !== r) return;   // cancelled
        req = null;
        E.miniFlash = ` [${Ed.errorText(e)}]`; Ed.scheduleRender();
      });
    }, timing.symbols);
  };
  let label: string;
  try { label = await Ed.readMini('Workspace symbol: ', '', () => shown.labels, { kind: 'eglot-symbol', require: true, keepOrder: true, filtered: t => t === answered, annotate, onChange }); }
  finally { stop(); }
  const y = shown.by.get(label)!;   // require: one of them
  need(y.x);
  pushBack(b);
  EvilCore.pushJump(b, b.pt);
  await visitXref(y.x);
  return false;
}
CMD('consult-eglot-symbols', '', '', "Visit a symbol of the workspace, chosen from those this buffer's language server finds for what is typed (SPC p s), asked again as it changes; point's place is recorded first, for xref-go-back (M-,).", () => workspaceSymbols());

/* ---- completion ---- */

/* An answer keeps at most COMPLETION_MAX items and the popup shows at most COMPLETION_SHOWN; an item whose text (or
   an other edit's) is past COMPLETION_TEXT_MAX characters, or with more than COMPLETION_EDITS_MAX other edits, is
   left out; a label is cut at LABEL_MAX characters and its annotation at ANN_MAX. A word is looked for at most
   WORD_MAX characters back from point. */
const COMPLETION_MAX = 5000, COMPLETION_SHOWN = 200, COMPLETION_TEXT_MAX = 10_000, COMPLETION_EDITS_MAX = 100, LABEL_MAX = 200, ANN_MAX = 80, WORD_MAX = 256;
/* LSP's CompletionItemKind, the annotation of an item with no detail. */
const KINDS = ['', 'text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module', 'property', 'unit', 'value', 'enum', 'keyword', 'snippet', 'color', 'file', 'reference', 'folder', 'enum member', 'constant', 'struct', 'event', 'operator', 'type parameter'];
type LspPos = { line: number; character: number };
type LspRange = { start: LspPos; end: LspPos };
/* An item as kept: its label (made fit for the popup), what it is matched by (its filterText, else label, in lower
   case) and sorted by (its sortText, else label), the text it inserts (a snippet's plain text), the range that
   text replaces (null: the word before point), its other edits (an import) and its annotation. */
interface CompletionItem { label: string; key: string; sort: string; text: string; range: LspRange | null; extra: (LspRange & { text: string })[]; ann: string }
/* A server's answer: the buffer, point when it was asked (REQ), the word's start there (START) and the word up to
   point then (HEAD); the text the server held (TEXT), its items in order and whether the server says typing more
   gives other items (INCOMPLETE). */
interface CompletionAnswer { b: EdBuffer; req: number; start: number; head: string; text: string; items: CompletionItem[]; incomplete: boolean }
let answer: CompletionAnswer | null = null;
/* The one request while typing: where point was when it was scheduled, the shortest word that opens the popup,
   its debounce timer, then its request. */
interface CompletionAsk { b: EdBuffer; pt: number; ver: number; min: number; timer: ReturnType<typeof setTimeout> | null; req: LspRpcRequest | null }
let asking: CompletionAsk | null = null;

/* A snippet's plain text: a tab stop ($1, ${1}) and a variable ($NAME) left out, a placeholder (${1:text}, ${NAME:text})
   its text, a choice (${1|a,b|}) its first, an escape (\$, \}, \\) the character. Linear in the text: the end of
   a choice is looked for only at a ${N| and only until a look finds none (i only grows, so none is found after
   that either), and a choice found is consumed. */
function snippetText(s: string): string {
  let i = 0, noChoice = false;
  const stop = /\$(\d+|[A-Za-z_][A-Za-z0-9_]*)/y, open = /\$\{(\d+|[A-Za-z_][A-Za-z0-9_]*)/y;
  const run = (inner: boolean): string => {
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && '$}\\,|'.includes(s[i + 1])) { out += s[i + 1]; i += 2; continue; }
      if (inner && c === '}') return out;
      if (c === '$') {
        stop.lastIndex = i;
        if (stop.test(s)) { i = stop.lastIndex; continue; }
        open.lastIndex = i;
        if (open.test(s)) {
          const j = open.lastIndex;
          if (s[j] === '}') { i = j + 1; continue; }
          if (s[j] === ':') { i = j + 1; out += run(true); if (s[i] === '}') i++; continue; }
          if (s[j] === '|' && !noChoice) {
            const k = s.indexOf('|}', j + 1);
            if (k < 0) noChoice = true;
            else { out += s.slice(j + 1, k).split(/(?<!\\),/)[0].replace(/\\(.)/g, '$1'); i = k + 2; continue; }
          }
        }
      }
      out += c; i++;
    }
    return out;
  };
  return run(false);
}
/* A Range of whole non-negative numbers, else null. */
function rangeOf(r: unknown): LspRange | null {
  const o = r && typeof r === 'object' ? r as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } : null;
  const st = o ? o.start : undefined, en = o ? o.end : undefined;
  if (!st || !en || !isCount(st.line) || !isCount(st.character) || !isCount(en.line) || !isCount(en.character)) return null;
  return { start: { line: st.line, character: st.character }, end: { line: en.line, character: en.character } };
}
const oneLine = (t: string, n: number) => cut(clean(t).replace(/\s+/g, ' ').trim(), n);
/* One CompletionItem of an answer, or null when it is malformed or past the bounds. */
function itemOf(it: unknown): CompletionItem | null {
  if (!it || typeof it !== 'object') return null;
  const o = it as { label?: unknown; filterText?: unknown; sortText?: unknown; insertText?: unknown; insertTextFormat?: unknown; textEdit?: unknown; additionalTextEdits?: unknown; detail?: unknown; kind?: unknown };
  if (typeof o.label !== 'string') return null;
  const label = oneLine(o.label, LABEL_MAX);
  if (!label) return null;
  let text = typeof o.insertText === 'string' ? o.insertText : o.label, range: LspRange | null = null;
  if (o.textEdit !== undefined && o.textEdit !== null) {
    const te = o.textEdit as { newText?: unknown; range?: unknown; insert?: unknown };
    if (typeof te !== 'object' || typeof te.newText !== 'string') return null;
    /* an InsertReplaceEdit inserts: the text after point stays */
    range = rangeOf(te.range !== undefined ? te.range : te.insert);
    if (!range) return null;
    text = te.newText;
  }
  /* bounded before a snippet is read (its plain text is never longer), so its nesting is too */
  if (text.length > COMPLETION_TEXT_MAX) return null;
  if (o.insertTextFormat === 2) text = snippetText(text);
  const extra: CompletionItem['extra'] = [];
  if (o.additionalTextEdits !== undefined && o.additionalTextEdits !== null) {
    if (!Array.isArray(o.additionalTextEdits) || o.additionalTextEdits.length > COMPLETION_EDITS_MAX) return null;
    for (const e of o.additionalTextEdits) {
      const r = rangeOf(e && typeof e === 'object' ? (e as { range?: unknown }).range : undefined), t = e && typeof e === 'object' ? (e as { newText?: unknown }).newText : undefined;
      if (!r || typeof t !== 'string' || t.length > COMPLETION_TEXT_MAX) return null;
      extra.push({ ...r, text: t });
    }
  }
  const detail = typeof o.detail === 'string' ? oneLine(o.detail, ANN_MAX) : '';
  const kind = typeof o.kind === 'number' && Number.isInteger(o.kind) && o.kind > 0 && o.kind < KINDS.length ? KINDS[o.kind] : '';
  return {
    label, key: (typeof o.filterText === 'string' ? o.filterText : o.label).toLowerCase(), sort: typeof o.sortText === 'string' ? o.sortText : o.label,
    text, range, extra, ann: detail || kind,
  };
}
/* The answer RES (a list of items, or a CompletionList) to a request about B at REQ, the word from START, the
   server holding TEXT: its items by sortText, then label. */
function answerOf(b: EdBuffer, req: number, start: number, text: string, res: unknown): CompletionAnswer {
  const list = Array.isArray(res) ? res : res && typeof res === 'object' && Array.isArray((res as { items?: unknown }).items) ? (res as { items: unknown[] }).items : [];
  const items: CompletionItem[] = [];
  for (const it of list) { if (items.length >= COMPLETION_MAX) break; const x = itemOf(it); if (x) items.push(x); }
  const by = (a: string, c: string) => (a < c ? -1 : a > c ? 1 : 0);
  items.sort((x, y) => by(x.sort, y.sort) || by(x.label, y.label));
  const incomplete = !Array.isArray(res) && !!res && typeof res === 'object' && (res as { isIncomplete?: unknown }).isIncomplete === true;
  return { b, req, start, head: text.slice(start, req), text, items, incomplete };
}

/* The start of the word before point in B: letters, digits, _ and $ (a Lisp's symbol characters in a Lisp). */
const WORD_CHAR = /[\p{L}\p{N}_$]/u, LISP_CHAR = /[\p{L}\p{N}_\-!?*<>=+\/.:$]/u;
function wordStart(b: EdBuffer) {
  const t = b.rope, re = Ed.isLisp(b) ? LISP_CHAR : WORD_CHAR;
  let s = b.pt;
  while (s > 0 && b.pt - s < WORD_MAX && re.test(t.slice(s - 1, s))) s--;
  return s;
}
/* Whether B's server completes in it now: it runs and gives completions. */
function completes(b: EdBuffer) {
  const s = ofBuffer.get(b);
  return !!s && s.state === 'running' && !!(s.capabilities || {}).completionProvider;
}
/* Whether A still answers about B's word: point at or after where it was asked, the word starting where it did and
   as it was up to there (word characters typed on since). Cheap, for each key: a list shown that no longer fits
   the text is refused when an item is inserted, which checks the whole text. */
function fits(a: CompletionAnswer, b: EdBuffer) {
  return a.b === b && b.pt >= a.req && wordStart(b) === a.start && b.rope.slice(a.start, a.req) === a.head;
}
/* The candidates of A for B's word as typed now: the items it matches the start of (ignoring case), then those
   holding it, each in A's order. */
function candidatesOf(a: CompletionAnswer, b: EdBuffer): EdCompletion[] {
  const typed = b.rope.slice(a.start, b.pt).toLowerCase(), first: CompletionItem[] = [], then: CompletionItem[] = [];
  for (const it of a.items) {
    const k = it.key.indexOf(typed);
    if (k === 0) first.push(it); else if (k > 0 && then.length < COMPLETION_SHOWN) then.push(it);
    if (first.length >= COMPLETION_SHOWN) break;
  }
  return first.concat(then).slice(0, COMPLETION_SHOWN).map(it => ({ text: it.label, score: 0, ann: it.ann, apply: (buf: EdBuffer) => insertItem(a, it, buf) }));
}
/* The popup over A's candidates in B (AUTO: opened by typing), when it has any. */
function showAnswer(a: CompletionAnswer, b: EdBuffer, auto: boolean) {
  const cs = candidatesOf(a, b);
  if (!cs.length) return false;
  Complete.show(a.start, b.rope.slice(a.start, b.pt), cs, auto);
  Ed.scheduleRender();
  return true;
}

/* Why an item is not inserted: nothing has changed. */
const refuseItem = (why: string): never => signal('user-error', `The completion is not inserted: ${why}`) as never;
/* Insert IT of A in B: its text over its range (the word before point when it has none), the range's end moved on
   by what was typed since the server answered, and its other edits; all or none, as one batch (the command's undo
   step), point after its text. Refused when the text is no longer the server's with the word typed on, when its
   range is not on point's line around where it was asked (LSP's rule: a server may not replace text elsewhere
   through it), and when an other edit runs past the end, ends before it starts, overlaps another or the item's. */
function insertItem(a: CompletionAnswer, it: CompletionItem, b: EdBuffer) {
  Ed.checkRO(b);
  const typed = b.pt - a.req;
  if (b.pt < a.req || b.rope.slice(0, a.req) !== a.text.slice(0, a.req) || b.rope.slice(b.pt) !== a.text.slice(a.req))
    refuseItem('the buffer has changed since its server answered');
  const at = offsetsIn(a.text), here = position(a.text, a.req);
  let lines = 1;
  for (let i = 0; i < a.text.length; i++) { const c = a.text.charCodeAt(i); if (c === 10 || (c === 13 && a.text.charCodeAt(i + 1) !== 10)) lines++; }
  let ms = a.start, me = a.req;
  if (it.range) {
    const r = it.range;
    if (r.start.line !== here.line || r.end.line !== here.line || byPlace(r.start, here) > 0 || byPlace(r.end, here) < 0)
      refuseItem('its edit is not on the line of point, around where it was asked');
    ms = at(r.start.line, r.start.character); me = at(r.end.line, r.end.character);
  }
  /* in the text as it is now: before the item's range as the server had it, after it moved on by what was typed */
  /* RANK: 0 an other edit before the item's text, 1 the item's, 2 one after it; I the server's order */
  const main = { s: ms, e: me + typed, text: it.text, rank: 1, i: 0 };
  const all = [main];
  for (const [i, x] of it.extra.entries()) {
    if (pastEnd(x.start, lines) || pastEnd(x.end, lines)) refuseItem(`one of its other edits is past the last line, ${lines}`);
    if (byPlace(x.end, x.start) < 0) refuseItem('one of its other edits ends before it starts');
    const s = at(x.start.line, x.start.character), e = at(x.end.line, x.end.character);
    if (e <= ms) all.push({ s, e, text: x.text, rank: 0, i });
    else if (s >= me) all.push({ s: s + typed, e: e + typed, text: x.text, rank: 2, i });
    else refuseItem('one of its other edits overlaps its text');
  }
  /* by place; at one place an insertion first (an other edit's before the item's), then the server's order, as
     opsOf: the item's text never overlaps an other edit, so two that overlap are other edits */
  const empty = (x: typeof main) => (x.e === x.s ? 0 : 1);
  all.sort((x, y) => x.s - y.s || empty(x) - empty(y) || x.rank - y.rank || x.i - y.i);
  for (let k = 1; k < all.length; k++) if (all[k].s < all[k - 1].e) refuseItem('two of its other edits overlap');
  /* from the last to the first, so each place is of the text as it was and each edit at one place goes in front
     of those after it */
  const ops = all.slice().reverse().map(x => [x.s, x.e - x.s, x.text] as EdEditOp);
  Ed.applyOps(b, ops);
  b.modified = true;
  b.pt = main.s + main.text.length + all.reduce((n, x) => n + (x.rank === 0 ? x.text.length - (x.e - x.s) : 0), 0);
}

function cancelCompletion() {
  const c = asking;
  asking = null;
  if (!c) return;
  if (c.timer) clearTimeout(c.timer);
  if (c.req) c.req.cancel();
}
/* B no longer uses its server: nothing more asked of it, its answer forgotten. */
function forgetCompletion(b: EdBuffer) {
  if (asking && asking.b === b) cancelCompletion();
  if (answer && answer.b === b) answer = null;
}
/* Ask about point in B after timing.completion, the request scheduled before cancelled. */
function scheduleCompletion(b: EdBuffer, min: number) {
  cancelCompletion();
  const c: CompletionAsk = { b, pt: b.pt, ver: b.ver, min, timer: null, req: null };
  c.timer = setTimeout(() => askCompletion(c), timing.completion);
  asking = c;
}
/* Whether the popup may open in B now: it is current and typed in, no minibuffer. */
const mayShow = (b: EdBuffer) => cur() === b && !E.mini && typing(b);
/* The debounce of C ran out: the pending change sent, then the request, when point is still where C was
   scheduled. Its answer opens the popup when point is still there; with no candidate, or an error, the words and file names
   are tried. */
function askCompletion(c: CompletionAsk) {
  c.timer = null;
  if (asking !== c) return;
  const b = c.b;
  if (b.pt !== c.pt || b.ver !== c.ver || !mayShow(b) || !completes(b)) { asking = null; return; }
  flush(b);
  const s = ofBuffer.get(b), conn = s && s.conn;
  if (!conn || conn.closed() !== null) { asking = null; return; }
  const req = b.pt, start = wordStart(b), text = b.text, again = !!answer && answer.b === b && answer.incomplete && fits(answer, b);
  try { c.req = conn.request('textDocument/completion', { ...docParams(b), context: { triggerKind: again ? 3 : 1 } }, { timeout: timing.request }); }
  catch (e) { asking = null; return; }
  c.req.then(res => {
    if (asking !== c) return;
    asking = null;
    if (b.pt !== c.pt || b.ver !== c.ver || !mayShow(b)) return;
    answer = answerOf(b, req, start, text, res);
    if (!showAnswer(answer, b, true)) { Complete.open(b, true, c.min); Ed.scheduleRender(); }
  }, () => {
    if (asking !== c) return;   // cancelled: nothing shown
    asking = null;
    /* timed out, an error answer, the session lost: the words and file names, as for an empty answer */
    if (b.pt === c.pt && b.ver === c.ver && mayShow(b)) { Complete.open(b, true, c.min); Ed.scheduleRender(); }
  });
}
Complete.setSource({
  /* after a key typed: the answer kept, filtered again, while it fits (asked again when incomplete); else a
     request once the keys stop. A word shorter than MIN is the words' and file names' (a path). */
  typed(b, min) {
    if (!completes(b)) return false;
    const start = wordStart(b);
    if (b.pt - start < min) { cancelCompletion(); return false; }
    const a = answer && fits(answer, b) ? answer : null;
    if (!a) { answer = null; scheduleCompletion(b, min); return true; }
    if (a.incomplete) scheduleCompletion(b, min);
    return showAnswer(a, b, true) || a.incomplete;
  },
  /* TAB and C-SPC: ask about the word before point, or after a character the server names as a trigger */
  ask(b) {
    if (!completes(b)) return null;
    const start = wordStart(b), s = ofBuffer.get(b)!, cp = (s.capabilities || {}).completionProvider as { triggerCharacters?: unknown } | true;
    const triggers = cp && typeof cp === 'object' && Array.isArray(cp.triggerCharacters) ? cp.triggerCharacters : [];
    const prev = b.pt > 0 ? b.rope.slice(b.pt - 1, b.pt) : '', trigger = start === b.pt && triggers.includes(prev) ? prev : null;
    if (start === b.pt && !trigger) return null;
    cancelCompletion();
    return (async () => {
      const pt = b.pt, ver = b.ver;
      let req = pt, text = '';
      const moved = () => !E.buffers.includes(b) || cur() !== b || b.pt !== pt || b.ver !== ver;
      let res: unknown;
      /* an error (C-g's quit aside) after moving on is dropped as an answer is; else complete.ts tries the words */
      try { res = await askAt(b, 'textDocument/completion', 'completionProvider', 'completions', { context: trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 } }, () => { req = b.pt; text = b.text; }); }
      catch (e) { if (!L.isQuit(e) && moved()) return true; throw e; }
      if (moved()) return true;   // moved on while it waited: dropped
      answer = answerOf(b, req, start, text, res);
      if (!showAnswer(answer, b, false)) return false;
      if (E.corfu!.cands.length === 1) Complete.accept();
      return true;
    })();
  },
});
/* After each command: the request waiting is cancelled once point moved, the text changed (but by the key that
   scheduled it), B is no longer current or typed in; the answer kept is forgotten once its buffer is not current
   or typed in (Normal state: the next insertion asks afresh). */
const prevPostCompletion = H.postCommand;
H.postCommand = (def, b0, failed) => {
  if (prevPostCompletion) prevPostCompletion(def, b0, failed);
  if (E.depth > 0) return;
  if (answer && !mayShow(answer.b)) answer = null;
  if (!asking) return;
  const b = asking.b;
  if (b.pt !== asking.pt || b.ver !== asking.ver || !mayShow(b)) cancelCompletion();
};

/* ---- Scheme and commands ---- */

/* The elements of V when it is a proper list, else null: an improper list, a circular one (two pointers, the slow
   one a step for the fast one's two, so a cycle in the cdrs ends the walk) and a non-list alike. */
function listItems(v: SchemeValue): SchemeValue[] | null {
  const r = listWalk(v);
  return typeof r === 'string' ? null : r;
}
/* listItems's walk: the elements, or why V is no proper list. */
function listWalk(v: SchemeValue): SchemeValue[] | 'improper' | 'circular' {
  const out: SchemeValue[] = [];
  let slow = v;
  for (let x = v; ; ) {
    if (!(x instanceof L.S.Pair)) return x === L.S.NIL ? out : 'improper';
    out.push(x.car); x = x.cdr;
    if (!(x instanceof L.S.Pair)) return x === L.S.NIL ? out : 'improper';
    out.push(x.car); x = x.cdr;
    slow = (slow as SchemePair).cdr;
    if (x === slow) return 'circular';
  }
}
/* Whether the improper list V holds atoms only (no pair or vector in a car or at its end): one that is safe to
   write out. */
function flat(v: SchemePair): boolean {
  const atom = (x: SchemeValue) => !(x instanceof L.S.Pair) && !Array.isArray(x);
  let x: SchemeValue = v;
  for (; x instanceof L.S.Pair; x = x.cdr) if (!atom(x.car)) return false;
  return atom(x);
}
/* JSON of the Scheme value V, a server's settings: an alist with symbol keys an object (of a key given twice the
   first, as assq finds it), a vector or another proper list an array, a string, a finite number, #t or #f. Anything
   else (a symbol, a character, a procedure, '() as neither object nor array, an improper or circular list, an exact
   integer past 2^53, which is a BigInt, a nesting past 32) signals lsp-error. */
function settingsJson(name: string, v: SchemeValue, depth = 0): unknown {
  const bad = (why: string) => signal('lsp-error', `define-language-server: the settings of ${name} ${why}`);
  if (depth > 32) bad('nest past 32 levels');
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : bad(`hold ${L.S.write(v)}, which is no JSON number`);
  if (typeof v === 'bigint') bad(`hold ${v}, past a safe integer`);   // an exact integer within 2^53 is a number
  if (Array.isArray(v)) return v.map(x => settingsJson(name, x, depth + 1));
  const items = v instanceof L.S.Pair ? listWalk(v) : null;
  if (Array.isArray(items)) {
    if (items.every(x => x instanceof L.S.Pair && x.car instanceof L.S.Sym)) {
      const o: Record<string, unknown> = {};
      for (const x of items as SchemePair[]) {
        const key = (x.car as SchemeSym).name, value = settingsJson(name, x.cdr, depth + 1);
        /* of a key given twice the first, as assq finds it: a later one is shadowed (though refused like any other
           when it is no JSON); defined, not assigned: a key __proto__ is a key like any other */
        if (!Object.prototype.hasOwnProperty.call(o, key)) Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    return items.map(x => settingsJson(name, x, depth + 1));
  }
  /* a circular list is not written out: it has no end to write. An improper one is when it is flat (the writer
     follows cars with no guard against a cycle through them), with the likeliest cause named: an object's entry
     whose key is no symbol (a string, say) is a pair, not an alist */
  if (items === 'circular') bad('hold a circular list, which is no JSON');
  if (items === 'improper') bad(`hold ${flat(v as SchemePair) ? L.S.write(v).slice(0, 80) + ', ' : ''}an improper list, which is no JSON (an object's keys are symbols)`);
  return bad(`hold ${L.S.write(v).slice(0, 80)}, which is no JSON`);
}
D('%lsp-declare', 'NAME MODES COMMAND [SETTINGS]', 'Declare the language server NAME for the major modes MODES, run as the argv COMMAND, with SETTINGS (a value, or a procedure of the root) when given (define-language-server, scm/lsp.scm).',
  ([n, m, c, st]: SchemeValue[]) => {
    const name = n instanceof L.S.Sym ? n.name : n;
    /* a :modes or :command that is no proper list (a circular one too) is an empty one, which define refuses */
    const modes = (listItems(m) || []).map(x => (x instanceof L.S.Sym ? x.name : x));
    /* nothing of the settings is looked at while the image replays: the declaration is skipped */
    const settings = st === undefined || Ed.proc.replaying() ? null
      : typeof st === 'function' ? (root: string) => settingsJson(String(name), L.apply(st, [root]))
      : settingsJson(String(name), st);
    return define(name as string, modes as string[], (listItems(c) || []) as string[], settings) ? n : false;
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
  /* the suites: whether PATTERN (a server's glob, braces expanded) matches the path P; null for a pattern refused */
  globMatches: (pattern, p) => { const w = watcherOf({ globPattern: pattern }); return w ? w.alts.some(a => globMatch(a.parts, p)) : null; },
  sessionOf: b => ofBuffer.get(b) || null,
  stderr: s => (s as Session).err.slice(-STDERR_MAX),
  diagnostics: b => {
    const p = placed.get(b);
    return p ? p.items.map(it => ({ start: it.start.pos, end: it.end.pos, severity: it.d.severity, message: it.d.message, source: it.d.source })) : [];
  },
};
})();
