/* Formatting a buffer with an external program (docs/steps.md, "format-buffer"): the buffer's text on the
   formatter's standard input, what it prints on its standard output put in the buffer's place as a line diff
   (Ed.applyLineDiff), so point, the mark and every marker on a line the formatter leaves alone stay where they
   were, and the whole change is one undo step. Past the diff's budget (more than 1000 differing lines, or its
   work limit: Rope.diffLines in src/text.ts) the diff is one replacement of everything between the common
   prefix and suffix; then point, the windows' points and the markers inside it keep their line number and
   column, clamped (keepLines), which is their line only where the formatter changed no line count above them.

   The formatter of each major mode is an argv declared by define-formatter (scm/prog.scm), through
   %format-declare here. The argv is kept here, not in a Scheme variable, and a declaration made while the image
   replays is skipped, with a message: an argv the image set would otherwise run on the user's next SPC b f
   (R16.15). An element of the argv that is the symbol file stands for the buffer's file name, absolute, so it
   never reads as an option.

   The child is Ed.proc's (src/proc.ts): only the desktop program runs one, on its own machine, never while the
   image replays (format-buffer asks Ed.proc.envFor before its first wait, which refuses then), in the file's
   directory, so the formatter finds its own settings there (.editorconfig, rustfmt.toml, pyproject.toml), with
   what direnv exports for that directory. The wait holds every key, so it is EdPool.interruptible: C-g kills
   the formatter and quits; past FORMAT_TIMEOUT it is killed.

   Nothing in the buffer changes unless the formatter exited 0 with whole UTF-8 output within FORMAT_MAX_BYTES,
   printed something for a buffer that holds something, and the buffer did not change while it ran. Else the
   echo area says why, and what it wrote to its error output is in *Format Output*. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { signal, CMD, D } = L;

/* How long a formatter may run, and how much it may print (output and error together). */
const FORMAT_TIMEOUT = 30_000;
const FORMAT_MAX_BYTES = 16 * 1024 * 1024;
const OUTPUT = '*Format Output*';
const ESC = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/* An argv element: a string as it is, or FILE for the buffer's file name. */
const FILE = Symbol('file');
type Arg = string | typeof FILE;
/* By major mode: its formatter's argv. */
const formatters = new Map<string, Arg[]>();

/* MODES (a mode, or a list of them) formatted by COMMAND (an argv, or #f for none). False when skipped. */
function declare(modes: SchemeValue, command: SchemeValue): boolean {
  const list = (v: SchemeValue) => { try { return L.arr(v) as unknown[]; } catch { return null; } };
  const given = modes instanceof L.S.Sym ? [modes] : list(modes);
  if (!given || !given.length || given.some(m => !(m instanceof L.S.Sym))) signal('error', 'define-formatter: the modes are not a mode or a non-empty list of modes:', modes);
  const ms = given!.map(m => (m as { name: string }).name);
  if (command === false) { for (const m of ms) formatters.delete(m); return true; }
  const argv = list(command);
  if (!argv || !argv.length || typeof argv[0] !== 'string' || !argv[0]
      || argv.some(a => typeof a !== 'string' && !(a instanceof L.S.Sym && a.name === 'file')))
    signal('error', 'define-formatter: the command is not a list of strings (and the symbol file), the program first, for', modes);
  if (Ed.proc.replaying()) {
    Ed.message(`define-formatter: ${ms.join(' ')} is not declared while the image replays`);
    return false;
  }
  const args: Arg[] = argv!.map(a => (typeof a === 'string' ? a : FILE));
  for (const m of ms) formatters.set(m, args);
  return true;
}

const parentOf = (p: string) => { const k = p.replace(/\/+$/, '').lastIndexOf('/'); return k <= 0 ? '/' : p.slice(0, k); };
/* B's file, absolute, when it is on this machine: not one of edwind's (a shared buffer, a served note). */
function localFile(b: EdBuffer): string | null {
  const f = Ed.host.files;
  if (!b.file || b.shared) return null;
  if (Ed.sync && Ed.sync.started && H.servedPath && H.servedPath(b.file)) return null;
  const p = f ? f.resolve(b.file) : b.file;
  return p.startsWith('/') ? p : null;
}

/* Its error output, without colours, in *Format Output*; its first non-blank line, or ''. */
function keepError(err: string): string {
  const text = err.replace(ESC, '').replace(/\r\n/g, '\n');
  const o = Ed.getBufferCreate(OUTPUT);
  o.readOnly = false; o.text = text; o.pt = 0; o.modified = false; o.undo = []; o.redo = []; Ed.forgetLog(o);
  o.mode = 'special-mode'; o.readOnly = true;
  const line = text.split('\n').map(l => l.trim()).find(l => l) || '';
  return line;
}

/* Offsets of the line starts of S. */
function lineStarts(s: string): number[] {
  const out = [0];
  for (let k = s.indexOf('\n'); k >= 0; k = s.indexOf('\n', k + 1)) out.push(k + 1);
  return out;
}
/* B's positions (point, the points of the windows on it, its markers) as they are in its text OLD, and a
   function that, when APPLIED (Ed.applyLineDiff's ops, giving NOW) is one replacement, puts each of them that
   was strictly inside it at its line number and column in NOW, clamped to that line and to the replacement.
   The diff is one replacement past its budget; a single hunk is one too, and the rule serves it as well. */
function keepLines(b: EdBuffer, old: string) {
  const ws = Ed.allWindows().filter(w => w.buffer === b);
  const pt = b.pt, wpts = ws.map(w => w.pt), marks = [...b.markers].map(m => [m, m.pos] as const);
  return (applied: EdAppliedOp[], now: string) => {
    if (applied.length !== 1) return;
    const [pos, removed, ins] = applied[0], end = pos + removed.length;
    const inside = (p: number | null): p is number => p !== null && p > pos && p < end;
    const a = lineStarts(old), n = lineStarts(now);
    const move = (p: number) => {
      let lo = 0, hi = a.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= p) lo = m; else hi = m - 1; }
      const line = Math.min(lo, n.length - 1), eol = line + 1 < n.length ? n[line + 1] - 1 : now.length;
      return Math.max(pos, Math.min(pos + ins.length, n[line] + (p - a[lo]), eol));
    };
    if (inside(pt)) b.pt = move(pt);
    ws.forEach((w, i) => { if (inside(wpts[i])) w.pt = move(wpts[i]); });
    for (const [m, p] of marks) if (inside(p) && m.pos !== null) m.pos = move(p);
  };
}

async function formatBuffer(b: EdBuffer): Promise<boolean> {
  const why = Ed.proc.refusal();
  if (why) signal('process-error', `format-buffer: ${why}`);
  Ed.checkRO(b);
  const argv = formatters.get(b.mode);
  if (!argv) signal('user-error', `No formatter for ${b.mode} (define-formatter declares one)`);
  const file = localFile(b);
  const prog = argv![0] as string;   /* a string: declare refuses another first element */
  if (argv!.includes(FILE) && !file) signal('user-error', `${prog} needs the buffer's file name, and this buffer has none on this machine`);
  const args = argv!.map(a => (a === FILE ? file! : a));
  const files = Ed.host.files;
  const dir = file ? parentOf(file) : files ? files.cwd : null;
  if (dir && files && !files.exists(dir)) signal('user-error', `${prog} runs in ${dir}, which does not exist yet; create it first`);
  /* Before the first wait: a replayed form is refused here (R16.15). */
  const env = await Ed.proc.envFor(dir || '/');
  const ver = b.ver, text = b.text;
  const out: string[] = [], err: string[] = [];
  const p = Ed.proc.spawn(args, { cwd: dir || undefined, env, timeout: FORMAT_TIMEOUT, maxBytes: FORMAT_MAX_BYTES, lossy: false, onOut: s => { out.push(s); }, onErr: s => { err.push(s); } });
  try { if (text) p.write(text); p.closeStdin(); } catch (e) { p.kill('KILL'); throw e; }
  const exit = Object.assign(p.exit, { cancel: () => { p.kill('KILL'); } });
  const x = await (EdPool.interruptible ? EdPool.interruptible(exit) : exit);
  const result = out.join('');
  const left = (msg: string) => { Ed.message(`${msg}; the buffer is left as it was`); return false; };
  const failed = (msg: string) => { const line = keepError(err.join('')); return left(line ? `${msg}: ${line}` : msg); };
  if (x.error) return failed(`${prog} stopped: ${x.error}`);
  if (x.timedOut) return failed(`${prog} took longer than ${FORMAT_TIMEOUT / 1000} s`);
  if (x.truncated) return failed(`${prog} printed more than ${FORMAT_MAX_BYTES / 1024 / 1024} MiB`);
  if (x.signal) return failed(`${prog} was killed by ${x.signal}`);
  if (x.code !== 0) return failed(`${prog} exited with code ${x.code}`);
  if (!result && text.trim()) return failed(`${prog} printed nothing`);
  if (!E.buffers.includes(b)) return left(`${b.name} was killed while ${prog} ran`);
  if (Ed.changedSince(b, ver)) return left(`${b.name} changed while ${prog} ran`);
  if (result === text) { Ed.message(`${b.name} is formatted already (${prog})`); return false; }
  Ed.checkRO(b);
  const keep = keepLines(b, text), applied = Ed.applyLineDiff(b, result);
  keep(applied, result);
  if (applied.length) b.modified = true;
  Ed.message(`Formatted ${b.name} with ${prog}`);
  return true;
}

D('%format-declare', 'MODES COMMAND', 'Declare COMMAND (an argv, or #f) the formatter of MODES (define-formatter, scm/prog.scm).',
  ([m, c]: SchemeValue[]) => declare(m, c));

CMD('format-buffer', '', '', "Format the buffer with its major mode's formatter (define-formatter), run in the file's directory with the buffer's text on its standard input (SPC b f). Its output takes the buffer's place line by line, so point stays on an unchanged line (past 1000 changed lines, on its line number); nothing changes when it fails.",
  async () => formatBuffer(E.current));
})();
