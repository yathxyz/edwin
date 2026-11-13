/* edwin, the program: Edwin in a terminal (DT1), as a Vim or Emacs would run, and a usable $EDITOR; or in a
   window of its own (DT2, --gui). Under the name edwinclient it is a frame of an edwind, as emacsclient is of an
   Emacs daemon; edwin never attaches to one.

     edwin [-nw | -g] [-R] [+LINE] [FILE | -]...
     edwinclient [-t | -c] [-R] [-a] [--socket PATH | --remote HOST:SOCKET] [+LINE] [FILE | -]...
     edwinclient [-a] [--socket PATH | --remote HOST:SOCKET] -e FORM...

   The core runs as a model frame (display.ts) drawn by term.ts, or by the window (gui.ts and the Rust side's
   gui/, which opened it before this file runs: N.guiSize() says so). Files are read and written directly
   (host-native.ts). edwinclient's edwind is the one main.rs attached to before anything was drawn (N.edwind()); the
   notes under its notes directory are opened through it, shared with the browser's frames. Through --remote
   HOST:SOCKET it is the edwind on another machine, reached through ssh (DT3); its notes are then named as they are
   under its notes directory. -e evaluates each FORM in edwind and prints its value, with no frame. The process
   ends with the status the user asked for: :q, :wq, ZZ and C-x C-c give 0, :cq gives 1 (or its argument), so git
   commit and sudoedit can tell an abort. C-z suspends to the shell; fg resumes (in the window, C-z iconifies it). */
(function () {
'use strict';
const N = globalThis.__n, H = globalThis.EdNativeHost, T = globalThis.EdTerm;
const client = N.client(), NAME = client ? 'edwinclient' : 'edwin';
/* The command line, as parseArgs reads it. line: +LINE (Infinity for + alone); files: with -e, the FORMs (every
   argument after it, and a FILE before it too, as emacsclient takes them). */
interface MainOpts { files: string[]; line: number | null; readOnly: boolean; eval: boolean; stdin: boolean; help: boolean; version: boolean }
const VERSION = `${NAME} DT3`;
const LEAVE = `Leave with :q (or :wq, ZZ, C-x C-c); :cq leaves with exit status 1.
C-z suspends to the shell.`;
const USAGE = client ? `Usage: edwinclient [OPTION]... [+LINE] [FILE]...
       edwinclient [OPTION]... -e FORM...
Edit FILEs in a frame of edwind, Edwin's daemon (edwin --daemon), in this terminal or in a window.

  -t, -nw, --tty     a frame in this terminal (the default)
  -c, --create-frame a frame in a window of its own (EDWIN_FONT="Family 11" sets its font)
  --geometry=COLSxROWS  the window's first size in characters (100x36)
  -e, --eval         the arguments that follow are Scheme forms: evaluate each in edwind and print its value
  -R, --read-only    visit the files read-only
  --socket PATH      the edwind listening on PATH
  --remote HOST:SOCKET  the edwind listening on SOCKET on HOST, through ssh; FILEs are then its notes, by
                     their names under its notes directory
  -a, --start-daemon start your own edwind (edwin --daemon) when none answers
  +LINE, +           start on line LINE of the first file (+ alone: its last line)
  -                  edit what arrives on standard input
  -h, --help         show this text;  --version  show the version

Without --socket or --remote the edwind is the one on $EDWIN_SOCKET, else on $XDG_RUNTIME_DIR/edwin/edit.sock;
when none answers edwinclient says so and exits with status 1. Notes under edwind's notes directory are its
buffers, shared with its other frames; every other file is this frame's own.
${LEAVE} edwind's init file is the one that runs.
` : `Usage: edwin [OPTION]... [+LINE] [FILE]...
Edit FILEs in Edwin, in this terminal or in a window. edwin never attaches to edwind; edwinclient does.

  -nw, -t, --no-window  use this terminal (the default)
  -g, --gui          open a window (EDWIN_FONT="Family 11" sets its font)
  --geometry=COLSxROWS  the window's first size in characters (100x36)
  -R, --read-only    visit the files read-only
  --daemon           start your own edwind in the background (--fg-daemon: in the foreground), for
                     edwinclient to attach to, as emacsclient does to emacs --daemon
  +LINE, +           start on line LINE of the first file (+ alone: its last line)
  -                  edit what arrives on standard input
  -h, --help         show this text;  --version  show the version

${LEAVE} Your init file is ~/.config/edwin/init.scm.
`;
const ESC_MS = Number(N.env('EDWIN_ESC_MS')) || 25;     // how long a lone ESC waits for the rest of a sequence
const FENCE_MS = 60;                                     // how long the first draw waits for the terminal's replies
const DRAIN_MS = 5000;                                   // how long quitting waits for edwind to confirm edits
/* EDWIN_TRACE=1 logs how long each startup step took (in the log file, as console does). */
const trace = N.env('EDWIN_TRACE') ? ((what: string) => console.log(`startup ${what} ${N.now().toFixed(1)} ms`)) : () => {};
trace('main');

/* main.rs read the same command line before V8 started, and acted on it only when this finds nothing wrong. */
function parseArgs(argv: string[]) {
  const o: MainOpts = { files: [], line: null, readOnly: false, eval: false, stdin: false, help: false, version: false };
  let opts = true, named = 0, forms = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (o.eval) { o.files.push(a); forms++; continue; }
    if (!opts) { o.files.push(a); continue; }
    if (a === '--') opts = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--version') o.version = true;
    else if (a.startsWith('--geometry=')) {
      /* main.rs sized the window, from digits only, each within a u32, as here. */
      const g = /^(\d+)x(\d+)$/.exec(a.slice(11));
      if (!g || Number(g[1]) > 0xffffffff || Number(g[2]) > 0xffffffff) throw new Error(`--geometry wants COLSxROWS, not ${a.slice(11)}`);
    }
    else if (a === '-R' || a === '--read-only') o.readOnly = true;
    else if (a === '-') o.stdin = true;
    else if (/^\+\d*$/.test(a)) o.line = a === '+' ? Infinity : Number(a.slice(1));
    else if (!client && ['-nw', '--no-window', '-t', '-g', '--gui'].includes(a)) { /* main.rs chose */ }
    else if (client && ['-t', '-nw', '--tty', '-c', '--create-frame', '-a', '--start-daemon'].includes(a)) { /* main.rs chose, or started it */ }
    else if (client && (a === '-e' || a === '--eval')) o.eval = true;
    else if (client && /^--(socket|remote)(=|$)/.test(a)) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!v) throw new Error(`${a.replace(/=.*/, '')} needs ${a.startsWith('--socket') ? 'a path' : 'a host'}`);
      if (++named > 1) throw new Error('--socket and --remote name one edwind; give one of them once');
    }
    else if (a.startsWith('-') && a.length > 1) {
      const theirs = !client && /^(-a|-c|-e|--(standalone|socket|remote|start-daemon|create-frame|eval)(=.*)?)$/.test(a);
      throw new Error(`unknown option ${a} (${theirs ? 'edwin never attaches to edwind; edwinclient does' : NAME + ' --help lists them'})`);
    }
    else o.files.push(a);
  }
  if (o.eval && !forms && !o.help && !o.version) throw new Error('-e needs a form');
  return o;
}

let opts: MainOpts;
try { opts = parseArgs(N.args()); } catch (e) { N.eprint(`${NAME}: ${e.message}\n`); N.exit(2); return; }
if (opts.help) { N.print(USAGE); N.exit(0); return; }
if (opts.version) { N.print(VERSION + '\n'); N.exit(0); return; }
/* edwinclient's edwind: main.rs attached to it, or said why not and left. */
const edwind = client ? N.edwind() : null;
if (client && !edwind) { N.eprint('edwinclient: no edwind was attached\n'); N.exit(70); return; }
if (opts.eval) { evaluate(opts.files, edwind!); return; }

/* edwinclient -e: each form in turn, as a client of kind cli, whose failing form gives its error at once (a frame's
   would wait in the debugger). Its value goes to stdout as write prints it, and a newline; the first error ends
   the run with status 1. A definitional form enters edwind's image log as one typed in a frame does. */
function evaluate(forms: string[], [, id]: [string, number]) {
  let n = 0, done = false;
  const send = (m: object) => N.sockSend(id, JSON.stringify(m));
  const end = (code: number, why?: string) => { if (done) return; done = true; if (why) N.eprint(`edwinclient: ${why}\n`); N.exit(code); };
  const next = () => { if (n === forms.length) end(0); else send({ t: 'call', rid: 'e' + n, form: forms[n], ctx: {} }); };
  globalThis.__native.handlers.sock = (sid, line) => {
    if (sid !== id || done) return;
    if (line === null) { end(1, 'edwind closed the connection' + (N.sockError(id) ? ': ' + N.sockError(id) : '')); return; }
    let m: { t: string; rid?: string; msg?: string; value?: unknown; error?: { report: string } };
    try { m = JSON.parse(line); } catch (e) { end(1, 'edwind sent a line that is not JSON'); return; }
    if (m.t === 'ping') send({ t: 'pong', rid: m.rid });
    else if (m.t === 'welcome') next();
    else if (m.t === 'error') end(1, m.msg || 'edwind refused the request');
    else if (m.t === 'result' && m.rid === 'e' + n) {
      if (m.error) { end(1, m.error.report); return; }
      N.print(String(m.value) + '\n');
      n++; next();
    }
  };
  globalThis.__native.handlers.signal = name => {
    const code = ({ HUP: 1, INT: 130, QUIT: 131, TERM: 143 } as Record<string, number>)[name];
    if (code) end(code);
  };
  send({ t: 'hello', proto: 1, cid: crypto.randomUUID().replace(/-/g, ''), kind: 'cli', device: 'edwinclient', caps: {} });
}

/* Standard input as a buffer (edwin -), read before the terminal is taken. */
const stdinText = opts.stdin ? N.readStdin() : null;
/* The window main.rs opened (edwin -g, edwinclient -c), else the terminal. */
const gui = N.guiSize() !== null;
if (gui) N.load('native/gui');
if (!gui && !N.ttyOpen()) { N.eprint(`${NAME}: no terminal to draw on (/dev/tty)\n`); N.exit(1); return; }
const screen = gui ? globalThis.EdGui.screen() : null;

/* ---------- the terminal ---------- */
const envOf = (k: string) => H.env(k) || '';
const enc = gui ? null : T.encoder({ color: envOf('EDWIN_COLOR') || T.colorMode({ COLORTERM: envOf('COLORTERM'), TERM: envOf('TERM'), TERM_PROGRAM: envOf('TERM_PROGRAM') }), defaultColors: envOf('EDWIN_DEFAULT_COLORS') === '1' });
const dec = gui ? null : T.decoder();
const out = gui ? () => {} : (s: string) => N.ttyWrite(s);
let size = gui ? null : N.ttySize();
const backend: EdDisplayBackend = gui ? screen!.backend : {
  tty: true,
  size: () => ({ cols: Math.max(8, size![0]), rows: Math.max(3, size![1]) }),
  draw: m => out(enc!.draw(m)),
  bell: () => out(enc!.bell()),
};
/* The theme: EDWIN_THEME, else the background colour the terminal reports (the desktop's, in the window), else
   COLORFGBG, else dark. */
const forced = /^(dark|light)$/.test(envOf('EDWIN_THEME')) ? envOf('EDWIN_THEME') as 'dark' | 'light' : null;
const fgbg = /;(\d+)$/.exec(envOf('COLORFGBG'));
let theme = forced || (gui && screen!.theme()) || (fgbg ? (Number(fgbg[1]) === 7 || Number(fgbg[1]) >= 9 ? 'light' : 'dark') : 'dark');
/* The first draw waits briefly for the terminal's replies (its background colour); a window has none. */
let fenceDone: (() => void) | null = null;
const fence = new Promise<void>(r => { fenceDone = r; setTimeout(r, gui ? 0 : FENCE_MS); });
if (!gui) { out(enc!.enter()); N.ttyFlush(); }

const isRemote = (p: string) => p.startsWith('ssh://');
/* The connection main.rs opened to edwind: the first of the boot (for a remote edwind, the one ssh). */
let firstId: number | null = edwind ? edwind[1] : null;

/* ---------- the core: in the startup snapshot already (boot.ts, edwin's), or loaded now (edwinclient's) ---------- */
if (!globalThis.EdBooted) { globalThis.EdBootAttach = client; N.load('native/boot'); trace('core loaded'); }
const host = globalThis.EdHost;
host.init!();
globalThis.__native.thaw();
host.onClipboard = gui ? s => screen!.clipboard(s) : s => { if (s.length <= 100000 && envOf('EDWIN_OSC52') !== '0') out(enc!.clipboard(s)); };
const Ed = globalThis.Ed, L = globalThis.L, E = Ed.E;

let frame: EdFrame | null = null, quitting = false, escTimer: number | null = null;
function leaveTerminal() { if (gui) return; out(enc!.leave()); N.ttyFlush(); N.ttyClose(); }
/* End the program: storage flushed, the terminal given back, then exit with CODE. */
async function quit(code: number) {
  if (quitting) return;
  quitting = true;
  const saving = attached ? [...Ed.sync.buffers.values()].filter(b => b.saving) : [];
  if (attached) await drain();
  /* A save edwind refused (a full disk, a lost file) keeps the program open, as Vim stays when :wq cannot write. */
  const refused = saving.filter(b => b.saveError);
  if (refused.length) {
    quitting = false;
    Ed.message(`${refused[0].name}: ${refused[0].saveError}; not quitting`); Ed.scheduleRender();
    return;
  }
  try { host.suspend!(); } catch (e) { console.error(e); }
  leaveTerminal();
  if (attached && attached.unconfirmed) N.eprint(`edwinclient: edwind had not confirmed ${attached.unconfirmed} edit(s) when edwinclient quit\n`);
  N.exit(code);
}
Ed.hooks.killEmacs = code => { quit(code); };
Ed.hooks.suspendFrame = () => {
  try { host.suspend!(); } catch (e) { console.error(e); }
  if (gui) { screen!.iconify(); return; }
  out(enc!.leave()); N.ttyFlush();
  N.suspend();              // returns once the shell has resumed us (SIGCONT)
  resumed();
};
function resumed() {
  size = N.ttySize();
  enc!.invalidate(); out(enc!.enter()); N.ttyFlush();
  if (frame) Ed.display.input(frame, { type: 'resize' });
}

/* Modified files when the terminal hangs up or edwin is killed: copied into the state directory's rescue/,
   since nobody can be asked any more. */
function rescue() {
  const dir = H.join(host.dirs!.state, 'rescue'), stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { N.mkdirs(dir); } catch (e) { return; }
  for (const b of E.buffers) {
    if (!b.file || !b.modified || b.shared) continue;
    const name = H.resolve(b.file).replace(/\//g, '%');
    try { N.writeFile(H.join(dir, `${name}.${stamp}`), b.text); } catch (e) { console.error('rescue: ' + e.message); }
  }
}

/* ---------- input ---------- */
function dispatch(evs: EdTermEvent[]) {
  for (const ev of evs) {
    if (ev.type === 'reply') {
      if (ev.kind === 'background' && !forced) {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(ev.value.slice(i, i + 2), 16));
        const t = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light';
        if (t !== theme) { theme = t; if (frame) Ed.display.setTheme(frame, theme); }
      } else if (ev.kind === 'da1') fenceDone!();
      continue;
    }
    if (frame) Ed.display.input(frame, ev);
  }
}
globalThis.__native.handlers.input = s => {
  if (escTimer !== null) { clearTimeout(escTimer); escTimer = null; }
  dispatch(dec!.feed(s));
  if (dec!.pending()) escTimer = setTimeout(() => { escTimer = null; dispatch(dec!.flush()); }, ESC_MS);
};
/* The window's events (keys, text, mouse, focus, resize, its close button, dropped files). */
globalThis.__native.handlers.gui = json => {
  if (!frame) return;
  globalThis.EdGui.handle(json, frame, {
    close: () => Ed.display.input(frame!, { type: 'key', key: '<cmd:save-buffers-kill-terminal>' }),
    drop: path => { Promise.resolve(Ed.visit(path)).then(() => Ed.render(), e => { Ed.message(Ed.errorText(e)); Ed.render(); }); },
  });
};
globalThis.__native.handlers.signal = name => {
  if (gui && (name === 'WINCH' || name === 'TSTP' || name === 'CONT')) return;
  if (name === 'WINCH') { size = N.ttySize(); if (frame) Ed.display.input(frame, { type: 'resize' }); }
  else if (name === 'TSTP') Ed.hooks.suspendFrame!();
  else if (name === 'CONT') resumed();
  else if (name === 'HUP' || name === 'TERM' || name === 'INT' || name === 'QUIT') {
    rescue();
    try { host.suspend!(); } catch (e) { /* best effort */ }
    if (name !== 'HUP') leaveTerminal();
    N.exit(name === 'HUP' ? 1 : 128 + ({ INT: 2, QUIT: 3, TERM: 15 })[name]);
  }
};

/* ---------- edwind: edwinclient's frame is one of its clients ---------- */
let attached: { socket: string; unconfirmed: number } | null = null;
const sockets = new Map<number, EdTransport>();
globalThis.__native.handlers.sock = (id, line) => {
  const ws = sockets.get(id);
  if (!ws) return;
  if (line === null) {
    sockets.delete(id);
    const why = N.sockError(id);
    if (why) console.error(`edwind connection closed: ${why}`);
    if (ws.onclose) ws.onclose({ code: 1006 });
  }
  else if (ws.onmessage) ws.onmessage({ data: line });
};
/* A WebSocket-shaped transport over edwind's Unix socket (one JSON message per line), as sync.ts wants. A remote
   one reconnects without waiting: ssh connects while the editor runs, and a failure is a close. */
const transport = (path: string) => (): EdTransport => {
  const ws: EdTransport = { onopen: null, onmessage: null, onclose: null, onerror: null, readyState: 0 };
  let id: number;
  try { if (firstId !== null) { id = firstId; firstId = null; } else id = N.sockOpen(path); } catch (e) { setTimeout(() => { if (ws.onerror) ws.onerror(e); if (ws.onclose) ws.onclose({ code: 1006 }); }, 0); return ws; }
  sockets.set(id, ws);
  ws.send = s => N.sockSend(id, s);
  ws.close = () => { sockets.delete(id); N.sockClose(id); ws.readyState = 3; };
  setTimeout(() => { ws.readyState = 1; if (ws.onopen) ws.onopen(); }, 0);
  return ws;
};
/* Before quitting attached: wait until edwind has acknowledged every edit and answered every call. */
function drain() {
  const sync = Ed.sync;
  const busy = () => [...sync.buffers.values()].reduce((n, b) => n + (b.inflight ? 1 : 0) + (b.queue ? b.queue.length : 0), 0) + sync.calls.size;
  return new Promise<void>(resolve => {
    const t0 = N.now();
    const check = () => {
      const n = busy();
      if (!n || sync.state !== 'online' || N.now() - t0 > DRAIN_MS) { attached!.unconfirmed = n; resolve(); }
      else setTimeout(check, 10);
    };
    check();
  });
}

/* ---------- start ---------- */
function lineMessage(b: EdBuffer) {
  const n = b.rope.length ? Ed.lineCountB(b) : 0;
  return `"${Ed.fileLabel(b.file!)}" ${n}L, ${b.rope.length}C${b.readOnly ? ' [readonly]' : ''}`;
}
/* Attached to a remote edwind, a FILE argument that is not a path here (not /…, ~…, ./… or ../…) is one of its
   notes, named as under its notes directory, and every other one is a file here, even where the two machines share
   the notes directory's path. Inside, names resolve against the buffer's directory, as in TRAMP: from a note, the
   remote notes directory. */
let remote = false, notesRoot = '', visitHere = (name: string) => Ed.visit(name);
const remoteNote = (name: string) => remote && notesRoot && !/^(\/|~|\.\.?(\/|$))/.test(name);
async function start() {
  Ed.reloadPersistent();
  L.set('load-path', L.listOf(host.loadPath));
  if (edwind) {
    const sock = edwind[0];
    remote = isRemote(sock);
    await Ed.bootServed({ transport: transport(sock), device: gui ? 'window' : 'terminal' });
    attached = { socket: sock, unconfirmed: 0 };
    const served = Ed.hooks.visit, dir = String(L.get('notes-directory') || '');
    /* Compared by true name, so ./notes/a.md, a link into the notes and a linked notes directory all count. A
       remote edwind's notes directory is on its machine: compared as written. */
    const root = notesRoot = !dir ? '' : remote ? dir.replace(/\/$/, '') : H.truename(dir).replace(/\/$/, '');
    /* Notes go through edwind; every other file is this program's own. */
    const hook = (name: string) => {
      const n = String(name), abs = remote ? n : H.truename(n);
      /* edwind names a note by its path under the notes directory. */
      if (root && abs.startsWith(root + '/')) return served!(abs.slice(root.length + 1));
      return visitHere(name);
    };
    visitHere = (name: string) => { Ed.hooks.visit = null; try { return Ed.visit(name); } finally { Ed.hooks.visit = hook; } };
    Ed.hooks.visit = hook;
    /* Dired likewise: the notes directory and what is under it are listed and changed by edwind. */
    Ed.hooks.servedPath = (p: string) => { const abs = remote ? p : H.truename(p); return !!root && (abs === root || abs.startsWith(root + '/')); };
  } else {
    Ed.loadUserInit();
  }
  trace('booted');
  let first: EdBuffer | null = null;
  if (stdinText !== null) {
    const b = Ed.getBufferCreate('*stdin*'); b.text = stdinText; b.pt = 0; b.modified = false; Ed.setWindowBuffer(b); first = b;
  }
  const visited: EdBuffer[] = [], fresh = new Set<EdBuffer>(), failed: string[] = [];
  for (const f of opts.files.slice().reverse()) {
    try {
      const isNew = !remoteNote(f) && N.stat(H.resolve(f)) === null;
      const b = await (remoteNote(f) ? Ed.visit(notesRoot + '/' + f) : remote ? visitHere(f) : Ed.visit(f));
      if (b) { if (opts.readOnly) b.readOnly = true; visited.unshift(b); if (isNew) fresh.add(b); }
    } catch (e) { failed.push(Ed.errorText(e)); }
  }
  first = visited[0] || first;
  if (first) { Ed.setWindowBuffer(first); E.current = first; }
  trace('visited');
  await fence;
  trace('fence');
  frame = Ed.makeFrame(null, { backend, kind: 'console', theme, buffer: first || undefined });
  frame.focused = true;
  if (first && opts.line !== null) {
    const n = opts.line === Infinity ? Ed.lineCountB(first) : opts.line;
    first.pt = Ed.lineStartB(first, Math.min(n, Ed.lineCountB(first)));
    frame.sel!.pt = first.pt;
  }
  /* Said once the frame is there: the echo area belongs to a frame. */
  if (failed.length) Ed.message(failed.join('; '));
  else if (first && first.file) Ed.message(fresh.has(first) ? `"${Ed.fileLabel(first.file)}" [New]` : lineMessage(first));
  Ed.render();
  if (N.env('EDWIN_TRACE')) setTimeout(() => trace('first draw'), 0);
}
start().catch(e => { console.error(e); leaveTerminal(); N.eprint(`${NAME}: ` + (e && e.stack || e) + '\n'); N.exit(70); });
})();
