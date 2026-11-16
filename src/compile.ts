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
   M-g n steps through them while the command still runs.

   grep (M-s g) is the same with its own buffer, *grep*, and its own run: a shell line (rg by default) run in the
   buffer's directory, its rows FILE:LINE:[COLUMN:]TEXT the error list. A grep and a compilation run side by side,
   and neither kills the other. The shell's standard input is /dev/null, not the closed pipe compile has, since
   rg given no path searches a pipe on its standard input instead of the directory.

   Once a grep has ended, *grep* can be edited (grep-edit-mode, C-c C-p): the text after each row's
   FILE:LINE:[COLUMN:] is that line of its file, and C-c C-c writes the changed lines back, one whole write per
   file. A file is written only when it is as the search saw it: its stamp the one taken when its first row came
   (where the host gives stamps), and each of its rows' lines still the text rg printed; else nothing of it is
   written and the echo area says why.

   The shell commands (M-!, M-&, M-|, :! and the ! operator) run here too, the last part of this file: M-& is a
   third kind of run, into *Async Shell Command*; the others wait for their child and show its output, or filter
   text through it. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD, D, listOf } = L;
const cur = () => E.current;

const MAX_LINES = 20000;
const MAX_CHARS = 4 * 1024 * 1024;
const FLUSH_MS = 30;
/* How far past the bound a cut looks for a line start before it cuts mid-line. */
const LINE_SLACK = 64 * 1024;
/* What a shell line starts with when its standard input is /dev/null: rg given no path searches a pipe on its
   standard input (even a closed one) instead of the directory. */
const DEV_NULL = 'exec </dev/null\n';
const DROPPED = `[Earlier output dropped: the last ${MAX_LINES} lines and ${MAX_CHARS / 1024 / 1024} MiB are kept]\n`;

L.defvar('compile-command', 'make -k ', 'The command compile offers: the last one it ran.');
L.defvar('grep-command', 'rg -nSH --no-heading --column ', 'The command grep (M-s g) offers.');
Ed.MODE_NAMES['compilation-mode'] = 'Compilation';
Ed.modeParents.set('compilation-mode', 'special-mode');
Ed.MODE_NAMES['grep-mode'] = 'Grep';
Ed.modeParents.set('grep-mode', 'compilation-mode');

/* What a compilation, a grep and an async shell command differ in: the buffer, its mode, the words its lines use,
   how its output is read, whether it feeds the error list and has a header, whether its standard input is
   /dev/null, and what its exit status means. */
interface Kind { buffer: string; mode: string; word: string; label: string; owner: string; read: Reader; restarts: boolean; errors: boolean; header: boolean; devNull: boolean; ending(x: EdProcExit, r: Run): string }
/* The run of a kind its buffer shows now, or null. gen tells its events from those of a run it replaced. */
interface Run { kind: Kind; gen: number; command: string; dir: string | null; buffer: EdBuffer; proc: EdProc | null; started: number; head: number; lines: number; cut: boolean; pending: string; carry: string; timer: ReturnType<typeof setTimeout> | null; ended: boolean; parse: Parse; owner: string; stamps: Map<string, string | null> }
const runs = new Map<Kind, Run>();
let gens = 0;
/* The last command of each kind and its directory, for recompile. */
const last = new Map<Kind, { command: string; dir: string | null }>();

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
   from it with a .git or a .jj), else that directory; a grep, B's directory itself (PROJECT false). B's
   directory is its listing's, or its file's; a path on edwind's machine (a note, a served listing) is not this
   machine's, so then the program's own directory. *compilation* and *grep* have neither: theirs is the directory
   their run started in, so a grep from *grep* searches where the last one did. Null where there is no file system
   (no host.files): the child starts where the program runs. */
function directoryFor(b: EdBuffer, project: boolean): string | null {
  const f = Ed.host.files;
  if (!f) return null;
  const served = (p: string) => !!(Ed.sync && Ed.sync.started && H.servedPath && H.servedPath(p));
  let d: string | null = null;
  const listed = b.dired as { dir?: string } | undefined, ran = b.compile as { dir?: string | null } | undefined;
  if (ran && typeof ran.dir === 'string') d = ran.dir;
  else if (listed && typeof listed.dir === 'string' && !served(listed.dir)) d = f.resolve(listed.dir);
  else if (b.file && !b.shared && !served(b.file)) d = parentOf(f.resolve(b.file));
  if (!d) return f.cwd;
  if (!project) return d;
  for (let p = d; ; p = parentOf(p)) {
    if (f.exists(join(p, '.git')) || f.exists(join(p, '.jj'))) return p;
    if (p === '/') return d;
  }
}

/* Terminal escapes (colours, cursor moves, titles) are not shown. A carriage return starts its line again, as on
   a terminal: of each line only the text after its last \r stays (a progress line shows its last state), and \r\n
   is a newline. A grep's output is the text of files, not a terminal's (its kind does not restart lines): there
   \r\n is a newline and any other \r a character of its line, shown as ^M, so a matched line holding one keeps
   its FILE:LINE: prefix. An escape or a \r cut by the end of a batch waits for the rest. Gives the text, and
   whether its first line starts the buffer's last line again. */
const ESC = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const ESC_START = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/;
function clean(r: Run, text: string, final: boolean) {
  let s = r.carry + text; r.carry = '';
  const k = s.lastIndexOf('\x1b');
  if (!final && k >= 0 && s.length - k < 4096 && !ESC_START.test(s.slice(k))) { r.carry = s.slice(k); s = s.slice(0, k); }
  s = s.replace(ESC, '').replace(/\x1b/g, '');
  if (!r.kind.restarts) {
    if (!final && s.endsWith('\r')) { r.carry = '\r' + r.carry; s = s.slice(0, -1); }
    return { text: s.replace(/\r\n/g, '\n'), restart: false };
  }
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
/* How a line is read: compile's shapes (parseLine) or grep's rows (grepLine). */
type Reader = (p: Parse, line: string, out: Place[]) => void;
/* COLUMNS: grep's rows carry a column (rg --column or --vimgrep). MISSING: a program the shell did not find. */
interface Parse { read: Reader; dir: string | null; dirs: string[]; msg: string | null; info: boolean; carry: string; found: number; columns: boolean; missing: string | null }
const newParse = (dir: string | null, read: Reader = parseLine, columns = false): Parse => ({ read, dir, dirs: [], msg: null, info: false, carry: '', found: 0, columns, missing: null });
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
/* A place into OUT, unless LINE is no number or MAX_ERRORS are kept already. */
function addPlace(p: Parse, out: Place[], file: string, l: string, c: string | undefined, text: string, unit: Unit) {
  const n = num(l), col = num(c);
  if (!n || !file || p.found >= MAX_ERRORS) return;
  out.push([place(p, file), n, col, clip(text), col === null ? null : unit]); p.found++;
}
/* One line, its trailing white space dropped, into OUT. A line 0 is no place, a column 0 none. The header the
   line above set (p.msg, p.info) is taken here and goes: a header holds for one line. */
function parseLine(p: Parse, line: string, out: Place[]) {
  const msg = p.msg, info = p.info;
  p.msg = null; p.info = false;
  const colon = line.includes(':');
  if (!colon && !line.includes('File "') && !line.includes('…')) return;
  line = line.trimEnd();
  const add = (file: string, l: string, c: string | undefined, text: string, unit: Unit = null) => addPlace(p, out, file, l, c, text, unit);
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
/* grep's rows: FILE:LINE:TEXT, and FILE:LINE:COLUMN:TEXT when the command asked rg for columns, which count UTF-8
   bytes. FILE is the shortest prefix followed by :LINE:, so a file name holding a colon and digits is misread,
   and a FILE of digits only is none: it is rg's LINE:TEXT for a single file searched without -H.
   The shell's word that a program is not there (dash, bash and busybox say it so) is kept for the last line. */
/* s: a matched line may hold a \r, which . does not match otherwise. */
const GREP = /^(.+?):(\d+):(.*)$/s;
const GREP_COLUMN = /^(\d+):(.*)$/s;
const GREP_COLUMNS = /(?:^|\s)--(?:column|vimgrep)(?=\s|$)/;
const NOT_FOUND = /^sh: (?:line \d+: |\d+: )?([^\s:]+): (?:command )?not found$/;
function grepLine(p: Parse, line: string, out: Place[]) {
  let m = NOT_FOUND.exec(line);
  if (m) { p.missing = m[1]; return; }
  if (!(m = GREP.exec(line)) || !/\D/.test(m[1])) return;
  let col: string | undefined, text = m[3];
  const c = p.columns ? GREP_COLUMN.exec(text) : null;
  if (c) { col = c[1]; text = c[2]; }
  addPlace(p, out, m[1], m[2], col, text, 'byte');
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
    if (p.found < MAX_ERRORS) p.read(p, line.slice(0, SCAN), out);
    from = nl + 1;
  }
  if (from < text.length) p.carry = (p.carry + text.slice(from, from + SCAN)).slice(0, SCAN);
  if (final && p.carry) { if (p.found < MAX_ERRORS) p.read(p, p.carry, out); p.carry = ''; }
  return out;
}
const toList = (out: Place[]) => listOf(out.map(([f, l, c, m, u]) => L.list(f, l, c === null ? false : c, m === null ? false : m, u === null ? false : intern(u))));

const current = (r: Run) => runs.get(r.kind) === r;
const live = (r: Run) => current(r) && E.buffers.includes(r.buffer);
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
  const found = r.kind.errors ? scan(r.parse, text, restart, final) : [];
  /* A row's file is stamped as its first row comes, as close to rg's read of it as the output lets. */
  if (r.kind === GREP_KIND && canStamp()) for (const [f] of found) if (!r.stamps.has(f)) r.stamps.set(f, stampOf(f));
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
  if (!current(r)) return;
  r.pending += text;
  if (r.pending.length >= MAX_CHARS) flush(r);
  else if (!r.timer) r.timer = setTimeout(() => flush(r), FLUSH_MS);
}

const SIGNALS: Record<string, string> = { INT: 'interrupted', TERM: 'terminated', KILL: 'killed', HUP: 'hung up' };
/* How the run ended, as the last line says it. */
const killed = (label: string, x: EdProcExit) => `${label} ${SIGNALS[x.signal!] || 'killed by SIG' + x.signal}`;
const ending = (label: string) => (x: EdProcExit) => {
  if (x.signal) return killed(label, x);
  if (x.code === 0) return `${label} finished`;
  return `${label} exited abnormally with code ${x.code}`;
};
/* grep's status: 1 is no match, not a failure; 127 with the shell's word that a program is not there names it. */
function grepEnding(x: EdProcExit, r: Run) {
  if (x.signal) return killed('Grep', x);
  if (x.code === 0) return 'Grep finished with matches found';
  if (x.code === 1) return 'Grep finished with no matches found';
  if (x.code === 127 && r.parse.missing) return `Grep failed: ${r.parse.missing} is not on PATH (exit 127)`;
  return `Grep exited abnormally with code ${x.code}`;
}
const COMPILATION: Kind = { buffer: '*compilation*', mode: 'compilation-mode', word: 'compilation', label: 'Compilation', owner: 'compile', read: parseLine, restarts: true, errors: true, header: true, devNull: false, ending: ending('Compilation') };
const GREP_KIND: Kind = { buffer: '*grep*', mode: 'grep-mode', word: 'grep', label: 'Grep', owner: 'grep', read: grepLine, restarts: false, errors: true, header: true, devNull: true, ending: grepEnding };
/* M-&: a shell command's output as it comes, with no header and no error list. */
const ASYNC: Kind = { buffer: '*Async Shell Command*', mode: 'async-shell-command-mode', word: 'shell command', label: 'Shell command', owner: 'shell', read: parseLine, restarts: true, errors: false, header: false, devNull: true, ending: ending('Shell command') };
/* The kind buffer B shows: grep's for *grep*, the shell command's for *Async Shell Command*, else compile's. */
const kindOf = (b: EdBuffer) => (b.mode === GREP_KIND.mode ? GREP_KIND : b.mode === ASYNC.mode ? ASYNC : COMPILATION);
function finish(r: Run, x: EdProcExit) {
  r.ended = true;
  flush(r, true);
  if (!live(r)) return;
  const b = r.buffer, now = Date.now(), why = r.kind.ending(x, r);
  const out = b.rope.length && b.rope.at(b.rope.length - 1) !== '\n' ? '\n' : '';
  /* The rows as line numbers (from 0), which an edit of a row's text leaves as they are: the line count of *grep*
     cannot change while it is edited. */
  if (r.kind === GREP_KIND) { const from = countLines(b.rope.slice(0, r.head)); b.grepRows = { from, to: from + r.lines + (out ? 1 : 0), columns: r.parse.columns, dir: r.dir, stamps: r.stamps }; }
  append(b, `${out}\n${why} at ${stamp(now)}, duration ${((now - r.started) / 1000).toFixed(2)} s${x.error ? ` (${x.error})` : ''}\n`);
  Ed.message(why);
  Ed.scheduleRender();
}

/* Kill the child of KIND's run shown now, if it still runs; its later events are dropped. */
function stop(kind: Kind, sig: EdProcSignal) {
  const r = runs.get(kind);
  if (!r || r.ended || !r.proc) return false;
  runs.delete(kind);
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  r.proc.kill(sig);
  return true;
}

/* Run COMMAND (a shell line) in DIR (absent: the project of the current buffer, for a grep its directory) into
   KIND's buffer, which is shown in another window. A run of the same kind still running is killed first. Gives
   the run once its child has started: its exit is a promise. */
async function start(kind: Kind, command: string, dir?: string | null): Promise<EdCompilation> {
  if (typeof command !== 'string' || !command.trim()) signal('user-error', 'No command to run');
  const where = dir === undefined ? directoryFor(cur(), kind === COMPILATION) : dir;
  /* Asked before the first wait, so that a replayed form is refused here (Ed.proc's gate, R16.15). */
  const env = await Ed.proc.envFor(where || (Ed.host.files ? Ed.host.files.cwd : '/'));
  /* From here to the spawn nothing waits. */
  stop(kind, 'KILL');
  const b = Ed.getBufferCreate(kind.buffer);
  editDone(b); delete b.grepRows;
  b.mode = kind.mode; b.readOnly = true; b.evilState = 'motion';
  const header = !kind.header ? '' : `-*- mode: ${kind.word}; default-directory: ${JSON.stringify(where ? abbr(where).replace(/\/?$/, '/') : './')} -*-\n${kind.label} started at ${stamp(Date.now())}\n\n${command}\n`;
  b.text = header; b.pt = 0; b.modified = false; b.undo = []; b.redo = []; Ed.forgetLog(b);
  b.compile = { command, dir: where };
  const grep = kind === GREP_KIND;
  const r: Run = { kind, gen: ++gens, command, dir: where, buffer: b, proc: null, started: Date.now(), head: header.length, lines: 0, cut: false, pending: '', carry: '', timer: null, ended: false, parse: newParse(where, kind.read, grep && GREP_COLUMNS.test(command)), owner: `${kind.owner} ${gens}`, stamps: new Map() };
  let settle: (x: EdProcExit) => void;
  const exit = new Promise<EdProcExit>(res => { settle = res; });
  let p: EdProc;
  try {
    p = Ed.proc.spawn(['sh', '-c', kind.devNull ? DEV_NULL + command : command], { cwd: where || undefined, env: { ...env, TERM: 'dumb' }, merge: true, lossy: true, onOut: s => take(r, s), onErr: s => take(r, s) });
  } catch (e) {
    append(b, `\n${kind.label} failed to start at ${stamp(Date.now())}: ${Ed.errorText(e)}\n`);
    show(b);
    throw e;
  }
  r.proc = p; runs.set(kind, r); last.set(kind, { command, dir: where });
  p.exit.then(x => { if (current(r)) { finish(r, x); runs.delete(kind); } settle(x); });
  p.closeStdin();
  /* The error list is this run's from now on, empty until its output names places. A refusal is reported, not
     thrown: the child runs and is watched, so the caller is told it started and sees the buffer. */
  if (kind.errors) try { L.call('next-error-set-list!', [L.list(), r.owner]); } catch (e) { Ed.reportError(e); }
  if (kind === COMPILATION) L.set('compile-command', command);
  show(b);
  return { command, dir: where, buffer: b, exit, kill: (sig?: EdProcSignal) => (current(r) && !r.ended ? p.kill(sig || 'INT') : false) };
}
function show(b: EdBuffer) {
  const w = Ed.popToBuffer(b);
  if (w !== E.sel) { w.pt = 0; w.start = 0; }
  Ed.scheduleRender();
}

/* KIND's command its buffer shows (else the last one) again, in its directory. */
async function again(kind: Kind): Promise<EdCompilation> {
  const b = Ed.getBuffer(kind.buffer), at = (b && b.compile) as { command: string; dir: string | null } | undefined || last.get(kind);
  if (!at) signal('user-error', kind === GREP_KIND ? 'No grep to run again: run grep first' : 'No compilation to run again: run compile first');
  return start(kind, at!.command, at!.dir);
}

const running = (kind: Kind) => { const r = runs.get(kind); return !!(r && !r.ended); };
/* A running compilation or grep is killed when asked (yes), else the command stops there. */
async function confirmKill(kind: Kind) {
  if (running(kind) && !await Ed.yesOrNo(`A ${kind.word} process is running; kill it?`)) signal('user-error', `A ${kind.word} is running in ${kind.buffer}`);
  /* A new grep starts *grep* again: edits not yet written go only when the user says so. */
  const g = kind === GREP_KIND ? Ed.getBuffer(kind.buffer) : null;
  if (g && g.grepEdit && g.grepEdit.writing) signal('user-error', WRITING);
  if (g && g.grepEdit && g.modified && !await Ed.yesOrNo(`${kind.buffer} has edits not written to their files; discard them?`)) signal('user-error', `The edits in ${kind.buffer} are kept: C-c C-c writes them, C-c C-k gives them up`);
}
/* No child where none can start: said before the command is read. */
function needProc(what: string) { if (!Ed.proc.available()) signal('process-error', `No process here: ${what} runs commands in the desktop program (edwin, edwinclient)`); }

CMD('compile', async () => {
  needProc('compile');
  const command = await Ed.readMini('Compile command: ', String(L.get('compile-command') || ''), null, { kind: 'compile' });
  await confirmKill(COMPILATION);
  return [command];
}, 'COMMAND', 'Run the shell command COMMAND in the project (the nearest directory up with a .git or a .jj, else the buffer\'s) and show its output in *compilation* (SPC c c). recompile runs it again.',
  async ([command]: SchemeValue[]) => { if (typeof command !== 'string') signal('wrong-type-argument', 'expected a string, got', command); await start(COMPILATION, command as string); return false; });
CMD('grep', async () => {
  needProc('grep');
  const command = await Ed.readMini('Run grep (like this): ', String(L.get('grep-command') || ''), null, { kind: 'grep-command' });
  await confirmKill(GREP_KIND);
  return [command];
}, 'COMMAND', 'Run the shell command COMMAND (rg by default: grep-command) in the buffer\'s directory and show its rows in *grep* (M-s g); M-g n visits them, g r runs it again.',
  async ([command]: SchemeValue[]) => { if (typeof command !== 'string') signal('wrong-type-argument', 'expected a string, got', command); await start(GREP_KIND, command as string); return false; });
/* In *grep*, recompile and kill-compilation act on the grep, as in Emacs's grep-mode. */
CMD('recompile', async () => { needProc('recompile'); await confirmKill(kindOf(cur())); return []; }, '', 'Run the last compile command again, in the same directory (g r in *compilation*); in *grep*, the grep.',
  async () => { await again(kindOf(cur())); return false; });
CMD('kill-compilation', '', '', 'Interrupt the running compilation (C-c C-k in *compilation*); in *grep*, the grep.', () => {
  const kind = kindOf(cur()), r = runs.get(kind);
  if (!r || r.ended || !r.proc) signal('user-error', `No ${kind.word} is running`);
  r!.proc!.kill('INT');
  return false;
});
CMD('compilation-mode', '', '', 'Switch the current buffer to Compilation mode.', () => Ed.switchMajorMode(cur(), 'compilation-mode'));
CMD('grep-mode', '', '', 'Switch the current buffer to Grep mode.', () => Ed.switchMajorMode(cur(), 'grep-mode'));
/* grep-mode's own keys, outside Evil and in Emacs state (scm/emacs.scm binds C-c C-p there). */
L.set('grep-mode-map', new Ed.Keymap('grep-mode-map'));
/* Killing *compilation* or *grep* kills its child: none is left behind. */
D('compilation--kill-buffer', '', 'Kill the compilation or grep of the current buffer when it shows one.', () => {
  for (const [kind, r] of runs) if (r.buffer === cur()) stop(kind, 'KILL');
  return false;
});
L.addHook('kill-buffer-hook', intern('compilation--kill-buffer'));

/* ---- Editing *grep* (grep-edit-mode) ----

   C-c C-p in *grep*, once its grep has ended, makes the buffer editable; C-c C-c (C-x C-s, ZZ) writes each
   changed row to its file and C-c C-k (ZQ) gives the edits up. A row is a line FILE:LINE:[COLUMN:]TEXT of the
   output, read as the error list reads it, but whole (not cut at SCAN, nor trimmed); its TEXT is that line of
   FILE as rg printed it. Only the text after a row's prefix is written. A changed line that is no row (the
   command line, which holds the pattern a wide :s changes too) is put back; a row whose prefix changed refuses
   its file; lines added or taken away refuse the whole write, and nothing is written.

   A file is written in one write (the native host's is atomic: a file renamed over it), and only when
   - its stamp, before and after it is read, is the one taken during the search (a file past the error list's
     MAX_ERRORS rows is stamped when the editing begins), where the host gives stamps;
   - every row of it still holds, on its line, the text the search found (a CRLF line's \r aside);
   - no buffer visiting it has unsaved changes, and it is not edwind's;
   - none of its rows' prefixes changed, and rows of one line (rg --vimgrep gives one per match) were not
     changed to different texts.
   Otherwise nothing of that file is written, the others are, and the echo area names each file left and why.
   The editing then goes on with the written rows taken as the search's, so a second C-c C-c writes the rest once
   their files are right, and C-c C-k gives back the refused rows' text. A buffer visiting a written file, not
   modified, takes its new text through the line diff, as a revert would. */
const EDIT_VAR = 'grep-edit-enabled';
/* A C-c C-c's writes run in slices of this many ms, one per turn of the event loop (a background slice's). */
const WRITE_SLICE_MS = 5;
const WRITING = 'The rows of *grep* are being written: wait for it to end';
const canStamp = () => !!(Ed.host.files && Ed.host.files.stamp);
function stampOf(f: string) { try { return Ed.host.files!.stamp!(f); } catch (e) { return null; } }
function editMode(b: EdBuffer, on: boolean) { Ed.makeLocal(b, EDIT_VAR); b.locals!.set(EDIT_VAR, on); }
/* Back to a read-only *grep*, its text as it is now. */
function editDone(b: EdBuffer) {
  if (!b.grepEdit) return;
  delete b.grepEdit; editMode(b, false);
  b.readOnly = true; if (b.evilState !== 'emacs') b.evilState = 'motion'; b.modified = false; b.undo = []; b.redo = []; Ed.forgetLog(b);
}
function editBegin(b: EdBuffer) {
  if (b.grepEdit) return;
  const r = runs.get(GREP_KIND);
  if (r && r.buffer === b && !r.ended) signal('user-error', 'The grep is still running: its rows can be edited once it has ended');
  const g = b.grepRows;
  if (b.mode !== GREP_KIND.mode || !g) signal('user-error', 'Not a grep\'s output: grep-edit-mode edits *grep* once its grep has ended');
  if (!Ed.host.files) signal('user-error', 'No files here: grep-edit-mode writes files in the desktop program');
  const text = b.text, lines = text.split('\n'), p = newParse(g!.dir, grepLine, g!.columns);
  const out = lines.slice(g!.from, g!.to);
  const rows: EdGrepRow[] = [];
  out.forEach((line, k) => {
    const m = GREP.exec(line), n = m ? num(m[2]) : null;
    if (!m || !n || !/\D/.test(m[1])) return;
    const c = g!.columns ? GREP_COLUMN.exec(m[3]) : null, rest = c ? c[2] : m[3];
    rows.push({ line: g!.from + k, prefix: line.slice(0, line.length - rest.length), file: place(p, m[1]), n, text: rest });
  });
  if (!rows.length) signal('user-error', 'No rows in *grep* to edit');
  if (canStamp()) for (const row of rows) if (!g!.stamps.has(row.file)) g!.stamps.set(row.file, stampOf(row.file));
  b.grepEdit = { text, lines, rows };
  b.readOnly = false; if (b.evilState !== 'emacs') b.evilState = 'normal'; b.modified = false; b.undo = []; b.redo = [];
  Ed.message('Editing *grep*: C-c C-c writes the changed rows to their files, C-c C-k gives the edits up');
  Ed.scheduleRender();
}
function editAbort(b: EdBuffer) {
  const e = b.grepEdit;
  if (!e) signal('user-error', 'Not editing *grep*');
  if (e!.writing) signal('user-error', WRITING);
  if (b.text !== e!.text) Ed.applyLineDiff(b, e!.text);
  editDone(b);
  Ed.message('Edits in *grep* given up');
  Ed.scheduleRender();
}
/* The rows of one file, and the new text of each of its lines that changed. BAD: why none of it may be written
   (a row's prefix changed, or a line was given two texts). */
interface FileEdit { rows: EdGrepRow[]; to: Map<number, string>; bad: string | null }
function editFinish(b: EdBuffer) {
  const e = b.grepEdit!;
  if (!e) signal('user-error', 'Not editing *grep*: C-c C-p there begins');
  if (e.writing) signal('user-error', WRITING);
  const lines = b.text.split('\n');
  if (lines.length !== e.lines.length) signal('user-error', 'Lines were added to *grep* or taken from it: only the text of its rows can change (C-c C-k gives the edits up)');
  const rowAt = new Map(e.rows.map(row => [row.line, row] as [number, EdGrepRow]));
  /* A changed line that is no row reaches no file: it is put back. */
  let back = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i] !== e.lines[i] && !rowAt.has(i)) { lines[i] = e.lines[i]; back++; }
  const files = new Map<string, FileEdit>();
  for (const row of e.rows) {
    let f = files.get(row.file);
    if (!f) files.set(row.file, f = { rows: [], to: new Map(), bad: null });
    f.rows.push(row);
    const line = lines[row.line];
    if (line === e.lines[row.line]) continue;
    if (!line.startsWith(row.prefix)) { f.bad = f.bad || `its row on line ${row.line + 1} of *grep* had its ${row.prefix} changed`; continue; }
    const now = line.slice(row.prefix.length);
    if (now === row.text) continue;
    const was = f.to.get(row.n);
    if (was !== undefined && was !== now) f.bad = f.bad || `two rows of its line ${row.n} were changed to different texts`; else f.to.set(row.n, now);
  }
  const stamps = b.grepRows ? b.grepRows.stamps : new Map<string, string | null>(), left: string[] = [];
  /* The buffers visiting files: by name, taken afresh each slice (a buffer may open or die between slices); by
     true name on demand, each buffer's true name looked up once per C-c C-c, not once per file. */
  const fh = Ed.host.files!, truename = (n: string) => { try { return fh.truename(n); } catch (e) { return n; } };
  const trueOf = new Map<string, string>();
  let byName = new Map<string, EdBuffer>(), byTrue: Map<string, EdBuffer> | null = null;
  const refresh = () => { byName = new Map(); byTrue = null; for (const x of E.buffers) if (x.file && !byName.has(x.file)) byName.set(x.file, x); };
  const visitor = (file: string) => {
    const v = byName.get(file);
    if (v) return v;
    if (!byTrue) {
      byTrue = new Map();
      for (const [n, x] of byName) { let t = trueOf.get(n); if (t === undefined) trueOf.set(n, t = truename(n)); if (!byTrue.has(t)) byTrue.set(t, x); }
    }
    return byTrue.get(truename(file));
  };
  const queue = [...files].filter(([, f]) => f.to.size || f.bad), asked = queue.length;
  let wrote = 0, changed = 0;
  /* The writes run in slices of WRITE_SLICE_MS, one per turn of the event loop, each file still its own fsync'd
     write: thousands of files do not hold the frame for seconds. *grep* is read-only until the last slice, and no
     second C-c C-c, C-c C-k or new grep gets in; a slice that finds the editing gone (the buffer killed, a grep
     started from code) writes no more. */
  const finish = () => {
    const shown = lines.join('\n');
    if (shown !== b.text) Ed.applyLineDiff(b, shown);
    e.text = e.lines.join('\n'); e.writing = false;
    const put = back ? `; ${back} changed line${back === 1 ? '' : 's'} that ${back === 1 ? 'is' : 'are'} no row put back` : '';
    const said = `Wrote ${changed} line${changed === 1 ? '' : 's'} in ${wrote} file${wrote === 1 ? '' : 's'}${put}`;
    if (!asked) { editDone(b); Ed.message(`(No changes to write${put})`); }
    else if (!left.length) { editDone(b); Ed.message(said); }
    else { b.readOnly = false; if (b.evilState !== 'emacs') b.evilState = 'normal'; b.modified = true; b.undo = []; b.redo = []; Ed.message(`${said}; not written: ${left.join('; ')}`); }
    Ed.scheduleRender();
  };
  const slice = () => {
    if (b.grepEdit !== e || !E.buffers.includes(b)) return;
    refresh();
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < WRITE_SLICE_MS) {
      const [file, f] = queue.shift()!;
      let why: string | null;
      /* What writeRows throws (its host calls are caught there) ends this file, not the write of the rest. */
      try { why = writeRows(file, f, stamps, visitor); } catch (x) { why = thrown(x); }
      if (why) { left.push(`${Ed.fileLabel(file)}: ${why}`); continue; }
      wrote++; changed += f.to.size;
      /* The written rows are the search's now; a row of a written line left as it was shows the new text too. */
      for (const row of f.rows) {
        const t = f.to.get(row.n);
        if (t !== undefined) { row.text = t; lines[row.line] = e.lines[row.line] = row.prefix + t; }
      }
    }
    if (!queue.length) { finish(); return; }
    E.echo = `Writing the rows of ${b.name}: ${asked - queue.length} of ${asked} files`;
    setTimeout(() => Ed.runCallback(slice), 0);
  };
  e.writing = true; b.readOnly = true; if (b.evilState !== 'emacs') b.evilState = 'motion';
  slice();
}
/* What a host file call threw: its message, as the host gives it (not a non-UTF-8 file's stack on the console). */
const thrown = (e: unknown) => String(e && (e as Error).message ? (e as Error).message : e);
/* FILE's changed lines into it, in one write; null when written, else why not (and nothing of it is written). */
function writeRows(file: string, f: FileEdit, stamps: Map<string, string | null>, visitor: (file: string) => EdBuffer | undefined): string | null {
  if (f.bad) return f.bad;
  if (Ed.sync && Ed.sync.started && H.servedPath && H.servedPath(file)) return 'it is edwind\'s: edit it there';
  const v = visitor(file);
  if (v && v.shared) return 'it is edwind\'s: edit it there';
  if (v && v.modified) return `${v.name} has unsaved changes to it`;
  const stamped = canStamp(), s = stamped ? stampOf(file) : null;
  if (stamped && (s === null || s !== stamps.get(file))) return s === null ? 'it is gone' : 'it changed since the search';
  let text: string | null;
  try { text = Ed.Store.get(file); } catch (e) { return `it cannot be read (${thrown(e)})`; }
  if (text === null) return 'it is gone';
  if (stamped && stampOf(file) !== s) return 'it changed since the search';
  const fl = text.split('\n'), cr = new Set<number>();
  for (const row of f.rows) {
    const l = fl[row.n - 1];
    if (row.n > fl.length || (l !== row.text && l !== row.text + '\r')) return `its line ${row.n} is not what the search found`;
    if (l !== row.text) cr.add(row.n);
  }
  for (const [n, to] of f.to) fl[n - 1] = to + (cr.has(n) ? '\r' : '');
  const out = fl.join('\n');
  try { Ed.Store.set(file, out); } catch (e) { return `it could not be written (${thrown(e)})`; }
  const now = stamped ? stampOf(file) : null;
  if (stamped) stamps.set(file, now);
  if (v) {
    if (v.text !== out) { v.undo.push(Ed.snap(v)); v.redo = []; Ed.applyLineDiff(v, out, 'disk'); }
    Ed.markSaved(v);
    if (v.disk && now !== null) v.disk = { stamp: now };
  }
  return null;
}
Ed.defineMinorMode({ name: 'grep-edit-mode', variable: EDIT_VAR, lighter: ' Edit', keymap: new Ed.Keymap('grep-edit-mode-map'),
  doc: 'Toggle grep-edit-mode in *grep*: on, its rows can be edited (C-c C-c writes them to their files); off, the edits are given up.',
  body: (on: boolean, b: EdBuffer) => {
    if (!on) { if (b.grepEdit) editAbort(b); return; }
    try { editBegin(b); } catch (e) { editMode(b, false); throw e; }
  } });
CMD('grep-change-to-grep-edit-mode', '', '', 'Make *grep* editable, once its grep has ended (C-c C-p): change the text of its rows, then C-c C-c writes them to their files, C-c C-k gives the edits up.', () => { L.call('grep-edit-mode', [1]); return false; });
CMD('grep-edit-finish', '', '', 'Write each changed row of *grep* to its file and leave grep-edit-mode (C-c C-c, C-x C-s, ZZ). A file changed since the search, or one whose row lines are no longer what it found, is not written.', () => { editFinish(cur()); return false; });
CMD('grep-edit-abort', '', '', 'Give up the edits in *grep* not yet written and leave grep-edit-mode (C-c C-k, ZQ).', () => { editAbort(cur()); return false; });
for (const n of ['grep-change-to-grep-edit-mode', 'grep-edit-finish', 'grep-edit-abort']) L.put(intern(n), 'evil-repeat', intern('abort'));

/* ---- Shell commands: M-!, M-&, M-|, :! and the ! operator ----

   A shell line the user typed, run as sh -c COMMAND (sh from PATH, as compile's) in the buffer's directory, through
   Ed.proc only, so under its gates: the desktop program alone runs one, and never while the image replays, since
   each entry reaches Ed.proc.envFor before its first wait.

   shell-command waits for its child, and C-g stops the wait and kills it (KILL to its group). Its standard input
   is /dev/null, or the region's text for shell-command-on-region. What it prints, its error merged in, goes to
   *Shell Command Output*, and is shown in the echo area when it is one line, else in that buffer in another
   window. A command that ends in & runs as async-shell-command: its output streamed into *Async Shell Command* as
   a compilation's is, with no header and no error list.

   A filter (C-u M-|, :{range}!, the ! operator) and an insert (C-u M-!) put the command's standard output in the
   buffer only when the command exited 0, its output was whole UTF-8 text within SHELL_MAX_BYTES, and the buffer did
   not change while it ran; else the text stays as it was and the output and error go to *Shell Command Output*.
   Its error never enters the text: when it succeeded, the error's first line is shown in the echo area. */
const OUTPUT = '*Shell Command Output*';
const SHELL_MAX_BYTES = 16 * 1024 * 1024;
const SHELL_HISTORY = 'shell-command';
Ed.MODE_NAMES['async-shell-command-mode'] = 'Shell';
Ed.modeParents.set('async-shell-command-mode', 'special-mode');
interface ShellResult extends EdProcExit { out: string; err: string }

/* COMMAND run in DIR with INPUT (null: /dev/null) on its standard input, waited for; C-g kills it. MERGE puts its
   error in its output, in order; LOSSY shows a byte that is not UTF-8 as U+FFFD instead of stopping it. */
async function shellRun(command: string, dir: string | null, input: string | null, merge: boolean, lossy: boolean): Promise<ShellResult> {
  if (typeof command !== 'string' || !command.trim()) signal('user-error', 'No command to run');
  /* Before the first wait: a replayed form is refused here (R16.15). */
  const env = await Ed.proc.envFor(dir || (Ed.host.files ? Ed.host.files.cwd : '/'));
  const out: string[] = [], err: string[] = [];
  const p = Ed.proc.spawn(['sh', '-c', input === null ? DEV_NULL + command : command], { cwd: dir || undefined, env: { ...env, TERM: 'dumb' }, merge, lossy, maxBytes: SHELL_MAX_BYTES, onOut: s => { out.push(s); }, onErr: s => { err.push(s); } });
  try { if (input) p.write(input); p.closeStdin(); } catch (e) { p.kill('KILL'); throw e; }
  const exit = Object.assign(p.exit, { cancel: () => { p.kill('KILL'); } });
  const x = await (EdPool.interruptible ? EdPool.interruptible(exit) : exit);
  return { ...x, out: out.join(''), err: err.join('') };
}
/* What went wrong, or '' when the command exited 0 with all of its output. */
function failure(x: ShellResult) {
  if (x.error) return `Shell command stopped: ${x.error}`;
  if (x.truncated) return `Shell command killed: its output passed ${SHELL_MAX_BYTES / 1024 / 1024} MiB`;
  if (x.signal) return killed('Shell command', x);
  return x.code === 0 ? '' : `Shell command exited abnormally with code ${x.code}`;
}
/* TEXT in *Shell Command Output*: shown in the echo area when it is one line, else the buffer in another window.
   WHY, when not empty, is said in the echo area. */
function display(text: string, why: string) {
  text = text.replace(ESC, '').replace(/\x1b/g, '').replace(/\r\n/g, '\n');
  const b = Ed.getBufferCreate(OUTPUT);
  b.readOnly = false; b.text = text; b.pt = 0; b.modified = false; b.undo = []; b.redo = []; Ed.forgetLog(b);
  const line = text.replace(/\n$/, '');
  if (!line) Ed.message(why ? `(${why}, with no output)` : '(Shell command succeeded with no output)');
  else if (!line.includes('\n')) Ed.message(why ? `${line}  [${why}]` : line);
  else { show(b); Ed.message(why); }
}
const shellCommandAsync = (command: string) => /(?<!&)&\s*$/.test(command);

/* M-!: COMMAND, its output shown, or with INSERT put at point in the current buffer. */
async function shellCommand(command: string, insert: boolean) {
  if (typeof command !== 'string') signal('wrong-type-argument', 'expected a string, got', command);
  if (shellCommandAsync(command)) { await start(ASYNC, command.replace(/&\s*$/, ''), directoryFor(cur(), false)); return false; }
  const b = cur();
  if (insert) return filterText(b, b.pt, b.pt, command, null, false);
  const x = await shellRun(command, directoryFor(b, false), null, true, true);
  display(x.out, failure(x));
  return false;
}
/* The text of B from S to E replaced by COMMAND's standard output, INPUT on its standard input; LINES: whole lines
   are filtered, and when the last has no newline the output's last newline is dropped. Point goes to S and the
   mark after the output (to the first non-blank of S's line when LINES). True when the text was replaced. */
async function filterText(b: EdBuffer, s: number, e: number, command: string, input: string | null, lines: boolean) {
  Ed.checkRO(b);
  const ver = b.ver;
  const x = await shellRun(command, directoryFor(b, false), input, false, false);
  const why = failure(x);
  /* What it printed goes to *Shell Command Output*, unless that is the buffer whose text is to stay. */
  const refuse = (msg: string) => { if (b.name === OUTPUT) Ed.message(msg); else display(x.out + x.err, msg); return false; };
  if (why) return refuse(`${why}; the text is left as it was`);
  if (!E.buffers.includes(b) || Ed.changedSince(b, ver)) return refuse('The buffer changed while the command ran; its text is left as it was');
  let out = x.out;
  if (lines && e > s && b.rope.at(e - 1) !== '\n' && out.endsWith('\n')) out = out.slice(0, -1);
  Ed.replaceText(b, s, e, out);
  b.pt = lines ? EvilCore.firstNonBlank(b.rope, s) : s;
  b.mark = s + out.length; b.markActive = false;
  const err = x.err.replace(ESC, '').trim();
  if (err) Ed.message(err.split('\n')[0]);
  return true;
}
/* M-|: the region's text on COMMAND's standard input; the output shown, or with REPLACE in place of the region. */
async function onRegion(beg: number, end: number, command: string, replace: boolean) {
  if (typeof command !== 'string') signal('wrong-type-argument', 'expected a string, got', command);
  const b = cur(), s = Math.max(0, Math.min(beg, end)), e = Math.min(b.rope.length, Math.max(beg, end));
  const input = b.rope.slice(s, e);
  if (replace) return filterText(b, s, e, command, input, false);
  const x = await shellRun(command, directoryFor(b, false), input, true, true);
  display(x.out, failure(x));
  return false;
}
/* The whole lines of B from L1 to L2 (from 1) through COMMAND. */
function filterLines(b: EdBuffer, l1: number, l2: number, command: string) {
  const t = b.rope, s = Ed.lineStartOf(t, l1), e = Math.min(t.length, Ed.eol(t, Ed.lineStartOf(t, l2)) + 1);
  return filterText(b, s, e, command, t.slice(s, e), true);
}
/* The region for M-|: Visual state's selection (which it leaves), else point and mark. */
function region(b: EdBuffer): [number, number] {
  if (EvilCore.stateOf(b) === 'visual') { const [s, e] = EvilCore.visualRange(b, true); return [s, e]; }
  if (b.mark === null) signal('user-error', 'The mark is not set now, so there is no region');
  return [Math.min(b.pt, b.mark!), Math.max(b.pt, b.mark!)];
}
const readShell = (prompt: string) => Ed.readMini(prompt, '', null, { kind: SHELL_HISTORY });

CMD('shell-command', async () => {
  needProc('shell-command');
  /* The prefix is this command's, not the minibuffer's: it would repeat each character typed there. */
  const insert = E.prefixArg !== null; E.prefixArg = null;
  const command = await readShell('Shell command: ');
  if (shellCommandAsync(command)) await confirmKill(ASYNC);
  return [command, insert];
}, 'COMMAND &optional INSERT', 'Run the shell line COMMAND in the buffer\'s directory and show its output: one line in the echo area, more in *Shell Command Output* (M-!). With a prefix argument (INSERT), put its output at point, only when it exits 0. A COMMAND ending in & runs as async-shell-command.',
  async ([command, insert]: SchemeValue[]) => shellCommand(command as string, insert !== undefined && insert !== false));
CMD('async-shell-command', async () => {
  needProc('async-shell-command');
  const command = await readShell('Async shell command: ');
  await confirmKill(ASYNC);
  return [command];
}, 'COMMAND', 'Run the shell line COMMAND in the buffer\'s directory and show its output in *Async Shell Command* as it comes (M-&); C-c C-k there interrupts it, and killing the buffer kills it.',
  async ([command]: SchemeValue[]) => { if (typeof command !== 'string') signal('wrong-type-argument', 'expected a string, got', command); await start(ASYNC, command as string, directoryFor(cur(), false)); return false; });
CMD('shell-command-on-region', async () => {
  needProc('shell-command-on-region');
  const replace = E.prefixArg !== null, b = cur(), [s, e] = region(b);
  E.prefixArg = null;
  if (replace) Ed.checkRO(b);
  const command = await readShell(replace ? 'Shell command on region (replace): ' : 'Shell command on region: ');
  return [s + 1, e + 1, command, replace];
}, 'START END COMMAND &optional REPLACE', 'Run the shell line COMMAND with the region\'s text on its standard input and show its output as shell-command does (M-|). With a prefix argument (REPLACE), its standard output takes the place of the region, only when it exits 0.',
  async ([s, e, command, replace]: SchemeValue[]) => onRegion((s as number) - 1, (e as number) - 1, command as string, replace !== undefined && replace !== false));
/* :!COMMAND shows COMMAND's output; :{range}!COMMAND filters those lines through it. */
CMD('evil-ex-shell-command', async () => {
  needProc(':!');
  const ex = E.ex, command = (ex && ex.arg) || '';
  return ex && ex.lines ? [ex.lines[0], ex.lines[1], command] : [false, false, command];
}, 'L1 L2 COMMAND', 'Filter the lines L1 to L2 (from 1) through the shell line COMMAND, its standard output in their place only when it exits 0 (:{range}!COMMAND); with no lines, run it as shell-command does (:!COMMAND).',
  async ([l1, l2, command]: SchemeValue[]) => {
    if (typeof command !== 'string') signal('wrong-type-argument', 'expected a string, got', command);
    if (l1 === false) return shellCommand(command as string, false);
    const b = cur(), last = Ed.lineNo(b.rope, Ed.lastLineStart(b.rope)), a = Math.min(l1 as number, l2 as number), z = Math.max(l1 as number, l2 as number);
    if (!Number.isInteger(a) || a < 1 || z > last) signal('user-error', 'E16: Invalid range');
    return filterLines(b, a, z, command as string);
  });
L.put(intern('evil-ex-shell-command'), 'evil-repeat', intern('abort'));

Ed.compile = { start: (command, dir) => start(COMPILATION, command, dir), recompile: () => again(COMPILATION), running: () => running(COMPILATION),
  grep: (command, dir) => start(GREP_KIND, command, dir), regrep: () => again(GREP_KIND), grepping: () => running(GREP_KIND),
  errors: (text: string, dir: string | null) => scan(newParse(dir), text, false, true) };
})();
