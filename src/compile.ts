/* compile (docs/steps.md, "compile"): a shell command run in the project, its output streamed into the
   *compilation* buffer, then a line that says how it ended. recompile runs the same command in the same
   directory again; kill-compilation interrupts it.

   The child is Ed.proc's (src/proc.ts), so the desktop program alone runs one, on its own machine, and never
   while the image replays: start asks Ed.proc for the environment before its first wait, which refuses then,
   and after that wait kills the old child and spawns the new one in one run, with no wait between them. The
   command is a shell line, run as sh -c COMMAND with sh from PATH.

   The buffer keeps at most MAX_LINES lines and MAX_CHARS characters of output: past them the oldest go, below
   the header, and a line there says output was dropped. Output is taken in batches, every FLUSH_MS or at
   MAX_CHARS, so a flood is a few edits a second, not one per chunk, and neither the batch nor the buffer's edit
   log grows with it.

   Each line of output is read for the places errors name (file, line, column) in the shapes rustc, tsc, gcc,
   nix and python print, and those become the frame's error list (scm/next-error.scm), added to as they come, so
   M-g n steps through them while the command still runs. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD, D, listOf } = L;
const cur = () => E.current;

const BUFFER = '*compilation*';
const MAX_LINES = 20000;
const MAX_CHARS = 4 * 1024 * 1024;
const FLUSH_MS = 30;
/* How far past the bound a cut looks for a line start before it cuts mid-line. */
const LINE_SLACK = 64 * 1024;
const DROPPED = `[Earlier output dropped: the last ${MAX_LINES} lines and ${MAX_CHARS / 1024 / 1024} MiB are kept]\n`;

L.defvar('compile-command', 'make -k ', 'The command compile offers: the last one it ran.');
Ed.MODE_NAMES['compilation-mode'] = 'Compilation';
Ed.modeParents.set('compilation-mode', 'special-mode');

/* The run *compilation* shows now, or null. gen tells its events from those of a run it replaced. */
interface Run { gen: number; command: string; dir: string | null; buffer: EdBuffer; proc: EdProc | null; started: number; head: number; lines: number; cut: boolean; pending: string; carry: string; timer: ReturnType<typeof setTimeout> | null; ended: boolean; parse: Parse; owner: string }
let run: Run | null = null, gens = 0;
/* The last command and its directory, for recompile. */
let last: { command: string; dir: string | null } | null = null;

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function abbr(dir: string) {
  const home = Ed.host.dirs ? Ed.host.dirs.home.replace(/\/$/, '') : '';
  return home && (dir === home || dir.startsWith(home + '/')) ? '~' + dir.slice(home.length) : dir;
}
const parentOf = (p: string) => { const k = p.replace(/\/+$/, '').lastIndexOf('/'); return k <= 0 ? '/' : p.slice(0, k); };
const join = (d: string, n: string) => (d.endsWith('/') ? d + n : d + '/' + n);

/* Where a compilation started from buffer B runs: the project around B's directory (the nearest directory up
   from it with a .git or a .jj), else that directory. B's directory is its listing's, or its file's; a path on
   edwind's machine (a note, a served listing) is not this machine's, so then the program's own directory.
   Null where there is no file system (no host.files): the child starts where the program runs. */
function directoryFor(b: EdBuffer): string | null {
  const f = Ed.host.files;
  if (!f) return null;
  const served = (p: string) => !!(Ed.sync && Ed.sync.started && H.servedPath && H.servedPath(p));
  let d: string | null = null;
  const listed = b.dired as { dir?: string } | undefined;
  if (listed && typeof listed.dir === 'string' && !served(listed.dir)) d = f.resolve(listed.dir);
  else if (b.file && !b.shared && !served(b.file)) d = parentOf(f.resolve(b.file));
  if (!d) return f.cwd;
  for (let p = d; ; p = parentOf(p)) {
    if (f.exists(join(p, '.git')) || f.exists(join(p, '.jj'))) return p;
    if (p === '/') return d;
  }
}

/* Terminal escapes (colours, cursor moves, titles) are not shown. A carriage return starts its line again, as on
   a terminal: of each line only the text after its last \r stays (a progress line shows its last state), and \r\n
   is a newline. An escape or a \r cut by the end of a batch waits for the rest. Gives the text, and whether its
   first line starts the buffer's last line again. */
const ESC = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const ESC_START = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/;
function clean(r: Run, text: string, final: boolean) {
  let s = r.carry + text; r.carry = '';
  const k = s.lastIndexOf('\x1b');
  if (!final && k >= 0 && s.length - k < 4096 && !ESC_START.test(s.slice(k))) { r.carry = s.slice(k); s = s.slice(0, k); }
  s = s.replace(ESC, '').replace(/\x1b/g, '');
  /* A run of \r acts as one, so one is carried. No regex: on a long run of \r one backtracks quadratically. */
  const end = trimCR(s);
  if (end < s.length) { if (!final) r.carry = '\r' + r.carry; s = s.slice(0, end); }
  if (!s.includes('\r')) return { text: s, restart: false };
  const lines = s.split('\n');
  let restart = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].slice(0, trimCR(lines[i])), j = l.lastIndexOf('\r');
    if (i === 0) restart = j >= 0;
    lines[i] = l.slice(j + 1);
  }
  return { text: lines.join('\n'), restart };
}
/* Where the run of \r that ends S starts. */
function trimCR(s: string) { let k = s.length; while (k > 0 && s.charCodeAt(k - 1) === 13) k--; return k; }

/* ---- The places errors name ----

   Each complete line of output is read once, as it comes, by the shapes below; a line is read in its first SCAN
   characters only, every pattern is anchored at the line's start and none nests a quantifier, and a file name
   never holds a colon, so a line costs time linear in at most SCAN characters. A shape that names its message on
   the line above (rustc's error[E0425]: ... over its --> line, nix's error: ... over its at line) takes that
   header; a header holds for the next line only, and a place with none above it has its own line as message.
   Notes, help and nix's trace frames (… while evaluating) are not errors: their places are skipped, as Emacs
   skips info by default. A relative name is taken from the directory make last said it entered (at most
   MAX_DIRS deep: past it the outermost goes), else the run's. At most MAX_ERRORS are kept: the first ones.

   Columns are in the unit the tool counts in, which visit-location converts on the line it visits: gcc's
   (GNU-shaped) are display columns (a tab to the next multiple of 8, a wide character 2), tsc's UTF-16 units,
   nix's UTF-8 bytes, the rest characters. */
const SCAN = 4096;
const MAX_ERRORS = 20000;
const MSG_MAX = 500;
const MAX_DIRS = 64;
/* A place: [FILE LINE COLUMN MESSAGE UNIT], COLUMN and MESSAGE null when not given, UNIT null for characters. */
type Unit = 'screen' | 'utf-16' | 'byte' | null;
type Place = [string, number, number | null, string | null, Unit];
interface Parse { dir: string | null; dirs: string[]; msg: string | null; info: boolean; carry: string; found: number }
const newParse = (dir: string | null): Parse => ({ dir, dirs: [], msg: null, info: false, carry: '', found: 0 });
const MAKE_DIR = /^\S*make(?:\[\d+\])?: (Entering|Leaving) directory [`'‘"](.*)['’"]$/;
const HEADER = /^\s*(error|warning|note|help)(?:\[[^\]\s]*\])?:/;
const TRACE = /^\s*… /;
const RUST = /^\s*--> ([^:]+):(\d+):(\d+)$/;
const PANIC = /^thread '[^']*' (?:\(\d+\) )?panicked at ([^:]+):(\d+):(\d+):$/;
const NIX = /^\s*at (\/[^:]+):(\d+):(\d+):$/;
const PYTHON = /^\s*File "([^"]+)", line (\d+)/;
const TSC = /^([^\s(:][^(:]*)\((\d+),(\d+)\): ((?:error|warning) .*)$/;
const TSC_PRETTY = /^([^\s:]+):(\d+):(\d+) - ((?:error|warning) .*)$/;
const GNU = /^([^\s:"'()<>|]+):(\d+):(?:(\d+):)?(?: (.*))?$/;
const GNU_INFO = /^(?:note|remark|info):/;
const MAKEFILE = /^(?:GNUmakefile|[Mm]akefile)$/;
/* FILE taken from the directory make is in, else the run's; ./ dropped. */
function place(p: Parse, file: string) {
  while (file.startsWith('./')) file = file.slice(2);
  if (file.startsWith('/')) return file;
  const base = p.dirs.length ? p.dirs[p.dirs.length - 1] : p.dir;
  return base ? join(base, file) : file;
}
const num = (s: string | undefined) => { const n = s === undefined ? NaN : Number(s); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const clip = (s: string) => { s = s.trim(); return s.length > MSG_MAX ? s.slice(0, MSG_MAX) + '…' : s; };
/* One line, its trailing white space dropped, into OUT. A line 0 is no place, a column 0 none. The header the
   line above set (p.msg, p.info) is taken here and goes: a header holds for one line. */
function parseLine(p: Parse, line: string, out: Place[]) {
  const msg = p.msg, info = p.info;
  p.msg = null; p.info = false;
  const colon = line.includes(':');
  if (!colon && !line.includes('File "') && !line.includes('…')) return;
  line = line.trimEnd();
  const add = (file: string, l: string, c: string | undefined, text: string, unit: Unit = null) => {
    const n = num(l), col = num(c);
    if (!n || !file || p.found >= MAX_ERRORS) return;
    out.push([place(p, file), n, col, clip(text), col === null ? null : unit]); p.found++;
  };
  let m: RegExpExecArray | null;
  if ((m = RUST.exec(line))) { if (!info) add(m[1], m[2], m[3], msg === null ? line : msg); return; }
  if ((m = NIX.exec(line))) { if (!info) add(m[1], m[2], m[3], msg === null ? line : msg, 'byte'); return; }
  if ((m = HEADER.exec(line))) { p.msg = line.trim(); p.info = m[1] === 'note' || m[1] === 'help'; return; }
  if (TRACE.test(line)) { p.msg = line.trim(); p.info = true; return; }
  if (!colon) { if ((m = PYTHON.exec(line)) && !m[1].startsWith('<')) add(m[1], m[2], undefined, line); return; }
  if ((m = MAKE_DIR.exec(line))) {
    if (m[1] === 'Entering') { if (p.dirs.length >= MAX_DIRS) p.dirs.shift(); p.dirs.push(place(p, m[2])); }
    else p.dirs.pop();
    return;
  }
  if ((m = PANIC.exec(line))) { add(m[1], m[2], m[3], line); return; }
  if ((m = TSC.exec(line)) || (m = TSC_PRETTY.exec(line))) { add(m[1], m[2], m[3], m[4], 'utf-16'); return; }
  if ((m = GNU.exec(line))) {
    const file = m[1], rest = m[4] || '';
    if (!/[^\d.]/.test(file) || !(file.includes('.') || file.includes('/') || MAKEFILE.test(file)) || GNU_INFO.test(rest)) return;
    add(file, m[2], m[3], line, 'screen');
  }
}
/* The places in TEXT, output that follows what P has read: complete lines, and the last one too when FINAL.
   RESTART: TEXT starts the line P holds again. */
function scan(p: Parse, text: string, restart: boolean, final: boolean) {
  const out: Place[] = [];
  if (restart) p.carry = '';
  let from = 0;
  for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', from)) {
    const line = p.carry + text.slice(from, Math.min(nl, from + SCAN));
    p.carry = '';
    if (p.found < MAX_ERRORS) parseLine(p, line.slice(0, SCAN), out);
    from = nl + 1;
  }
  if (from < text.length) p.carry = (p.carry + text.slice(from, from + SCAN)).slice(0, SCAN);
  if (final && p.carry) { if (p.found < MAX_ERRORS) parseLine(p, p.carry, out); p.carry = ''; }
  return out;
}
const toList = (out: Place[]) => listOf(out.map(([f, l, c, m, u]) => L.list(f, l, c === null ? false : c, m === null ? false : m, u === null ? false : intern(u))));

const live = (r: Run) => run === r && E.buffers.includes(r.buffer);
/* Put TEXT in place of the buffer's text from FROM to its end: points at the end stay at the end. The buffer is
   read-only and never modified. */
function append(b: EdBuffer, text: string, from = b.rope.length) {
  if (!text && from === b.rope.length) return;
  Ed.editText(b, from, b.rope.length - from, text);
  b.modified = false; b.undo = []; b.redo = [];
}
const countLines = (s: string) => { let n = 0; for (let k = s.indexOf('\n'); k >= 0; k = s.indexOf('\n', k + 1)) n++; return n; };
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/* The output taken since the last flush, into the buffer; then the oldest output past MAX_LINES lines or
   MAX_CHARS characters goes, and the first time a line below the header says so. The edit log of the buffer is
   then dropped: it would keep every cut text and every appended one until it grew past its own bound, which a
   progress line that only replaces the last line never makes it do, so output would fill memory. */
function flush(r: Run, final = false) {
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  const { text, restart } = clean(r, r.pending, final); r.pending = '';
  if (!live(r)) return;
  const found = scan(r.parse, text, restart, final);
  if (text || restart) output(r, text, restart);
  /* After the output is in, so a refused hand-over loses none of it. */
  if (found.length) { try { L.call('next-error-add-to-list!', [r.owner, toList(found)]); } catch (e) { Ed.reportError(e); } }
}
/* TEXT into the buffer (in place of its last line when RESTART), then the bounds. */
function output(r: Run, text: string, restart: boolean) {
  const b = r.buffer;
  append(b, text, restart ? Math.max(r.head, b.rope.lastIndexOf('\n', b.rope.length - 1) + 1) : b.rope.length);
  r.lines += countLines(text);
  let end = r.head;
  if (r.lines > MAX_LINES) {
    for (let i = r.lines - MAX_LINES; i > 0; i--) end = b.rope.indexOf('\n', end) + 1;
    r.lines = MAX_LINES;
  }
  /* Output with few newlines is bounded too: cut at the first line start past the bound when it is near,
     else mid-line (not inside a surrogate pair). */
  if (b.rope.length - end > MAX_CHARS) {
    let at = b.rope.length - MAX_CHARS;
    const nl = b.rope.indexOf('\n', at);
    if (nl >= 0 && nl - at < LINE_SLACK) at = nl + 1;
    else if (isLow(b.rope.charCodeAt(at))) at++;
    r.lines -= countLines(b.rope.slice(end, at));
    end = at;
  }
  const cuts = end > r.head;
  if (cuts) {
    const mark = r.cut ? '' : DROPPED;
    Ed.editText(b, r.head, end - r.head, mark);
    b.modified = false; b.undo = []; b.redo = [];
    r.head += mark.length; r.cut = true;
  }
  /* What a restart edit deleted is in no bound: only its log entry keeps it. */
  if (restart || cuts) Ed.forgetLog(b);
}
/* A batch is flushed at once when it reaches MAX_CHARS, so a flood within one FLUSH_MS is bounded too. */
function take(r: Run, text: string) {
  if (run !== r) return;
  r.pending += text;
  if (r.pending.length >= MAX_CHARS) flush(r);
  else if (!r.timer) r.timer = setTimeout(() => flush(r), FLUSH_MS);
}

const SIGNALS: Record<string, string> = { INT: 'interrupted', TERM: 'terminated', KILL: 'killed', HUP: 'hung up' };
/* How the run ended, as the last line says it. */
function ending(x: EdProcExit) {
  if (x.signal) return `Compilation ${SIGNALS[x.signal] || 'killed by SIG' + x.signal}`;
  if (x.code === 0) return 'Compilation finished';
  return `Compilation exited abnormally with code ${x.code}`;
}
function finish(r: Run, x: EdProcExit) {
  r.ended = true;
  flush(r, true);
  if (!live(r)) return;
  const b = r.buffer, now = Date.now(), why = ending(x);
  const out = b.rope.length && b.rope.at(b.rope.length - 1) !== '\n' ? '\n' : '';
  append(b, `${out}\n${why} at ${stamp(now)}, duration ${((now - r.started) / 1000).toFixed(2)} s${x.error ? ` (${x.error})` : ''}\n`);
  Ed.message(why);
  Ed.scheduleRender();
}

/* Kill the child of the run shown now, if it still runs; its later events are dropped. */
function stop(sig: EdProcSignal) {
  const r = run;
  if (!r || r.ended || !r.proc) return false;
  run = null;
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  r.proc.kill(sig);
  return true;
}

/* Run COMMAND (a shell line) in DIR (absent: the project of the current buffer) into *compilation*, which is
   shown in another window. A compilation still running is killed first. Gives the run once its child has
   started: its exit is a promise. */
async function start(command: string, dir?: string | null): Promise<EdCompilation> {
  if (typeof command !== 'string' || !command.trim()) signal('user-error', 'No command to run');
  const where = dir === undefined ? directoryFor(cur()) : dir;
  /* Asked before the first wait, so that a replayed form is refused here (Ed.proc's gate, R16.15). */
  const env = await Ed.proc.envFor(where || (Ed.host.files ? Ed.host.files.cwd : '/'));
  /* From here to the spawn nothing waits. */
  stop('KILL');
  const b = Ed.getBufferCreate(BUFFER);
  b.mode = 'compilation-mode'; b.readOnly = true; b.evilState = 'motion';
  const header = `-*- mode: compilation; default-directory: ${JSON.stringify(where ? abbr(where).replace(/\/?$/, '/') : './')} -*-\nCompilation started at ${stamp(Date.now())}\n\n${command}\n`;
  b.text = header; b.pt = 0; b.modified = false; b.undo = []; b.redo = []; Ed.forgetLog(b);
  b.compile = { command, dir: where };
  const r: Run = { gen: ++gens, command, dir: where, buffer: b, proc: null, started: Date.now(), head: header.length, lines: 0, cut: false, pending: '', carry: '', timer: null, ended: false, parse: newParse(where), owner: `compile ${gens}` };
  let settle: (x: EdProcExit) => void;
  const exit = new Promise<EdProcExit>(res => { settle = res; });
  let p: EdProc;
  try {
    p = Ed.proc.spawn(['sh', '-c', command], { cwd: where || undefined, env: { ...env, TERM: 'dumb' }, merge: true, lossy: true, onOut: s => take(r, s), onErr: s => take(r, s) });
  } catch (e) {
    append(b, `\nCompilation failed to start at ${stamp(Date.now())}: ${Ed.errorText(e)}\n`);
    show(b);
    throw e;
  }
  r.proc = p; run = r; last = { command, dir: where };
  p.exit.then(x => { if (run === r) { finish(r, x); run = null; } settle(x); });
  p.closeStdin();
  /* The error list is this run's from now on, empty until its output names places. A refusal is reported, not
     thrown: the child runs and is watched, so the caller is told it started and sees the buffer. */
  try { L.call('next-error-set-list!', [L.list(), r.owner]); } catch (e) { Ed.reportError(e); }
  L.set('compile-command', command);
  show(b);
  return { command, dir: where, buffer: b, exit, kill: (sig?: EdProcSignal) => (run === r && !r.ended ? p.kill(sig || 'INT') : false) };
}
function show(b: EdBuffer) {
  const w = Ed.popToBuffer(b);
  if (w !== E.sel) { w.pt = 0; w.start = 0; }
  Ed.scheduleRender();
}

async function recompile(): Promise<EdCompilation> {
  const b = Ed.getBuffer(BUFFER), at = (b && b.compile) as { command: string; dir: string | null } | undefined || last;
  if (!at) signal('user-error', 'No compilation to run again: run compile first');
  return start(at!.command, at!.dir);
}

/* A running compilation is killed when asked (yes), else the command stops there. */
async function confirmKill() {
  if (run && !run.ended && !await Ed.yesOrNo('A compilation process is running; kill it?')) signal('user-error', 'A compilation is running in *compilation*');
}
/* No child where none can start: said before the command is read. */
function needProc() { if (!Ed.proc.available()) signal('process-error', 'No process here: compile runs commands in the desktop program (edwin, edwinclient)'); }

CMD('compile', async () => {
  needProc();
  const command = await Ed.readMini('Compile command: ', String(L.get('compile-command') || ''), null, { kind: 'compile' });
  await confirmKill();
  return [command];
}, 'COMMAND', 'Run the shell command COMMAND in the project (the nearest directory up with a .git or a .jj, else the buffer\'s) and show its output in *compilation* (SPC c c). recompile runs it again.',
  async ([command]: SchemeValue[]) => { if (typeof command !== 'string') signal('wrong-type-argument', 'expected a string, got', command); await start(command as string); return false; });
CMD('recompile', async () => { needProc(); await confirmKill(); return []; }, '', 'Run the last compile command again, in the same directory (g r in *compilation*).',
  async () => { await recompile(); return false; });
CMD('kill-compilation', '', '', 'Interrupt the running compilation (C-c C-k in *compilation*).', () => {
  if (!run || run.ended || !run.proc) signal('user-error', 'No compilation is running');
  run!.proc!.kill('INT');
  return false;
});
CMD('compilation-mode', '', '', 'Switch the current buffer to Compilation mode.', () => Ed.switchMajorMode(cur(), 'compilation-mode'));
/* Killing *compilation* kills its child: none is left behind. */
D('compilation--kill-buffer', '', 'Kill the compilation of the current buffer when it is *compilation*.', () => { if (run && run.buffer === cur()) stop('KILL'); return false; });
L.addHook('kill-buffer-hook', intern('compilation--kill-buffer'));

Ed.compile = { start, recompile, running: () => !!(run && !run.ended),
  errors: (text: string, dir: string | null) => scan(newParse(dir), text, false, true) };
})();
