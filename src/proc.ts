/* Child processes for the core's TypeScript (docs/steps.md, "Ed.proc"): compile, grep, shell commands, git,
   formatters and language servers start their programs through Ed.proc and nothing else.

   A child is an argv, never a shell line, run by the host (host.proc): only the desktop program has one
   (host-native.ts, over native/src/proc.rs), in edwin and in edwinclient's frames, whose children run on the
   frame's own machine. A web frame never starts one, nor does edwind, whose Node host has none (R4.45).

   The image never reaches a process (R16.15): sync.ts replays the image's forms inside Ed.proc.replay, and
   every entry point here refuses while it runs and until the loop's next turn, so a command a replayed form
   calls is refused whether it starts its child at once or after an await that settles in the same turn.

   Ed.proc.spawn gives a running child (input, signals, its exit as a promise); Ed.proc.run gives a child's
   whole output, error and exit. A refusal and a child that cannot run signal process-error. Ed.openUrl hands a
   URL or a file to the desktop's application, under the same replay gate. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed;
const { signal } = L;

/* What run keeps of a child's output and error together when the caller says no other bound: past it the
   child is killed and the result says truncated. */
const RUN_MAX_BYTES = 16 * 1024 * 1024;

let replays = 0;
/* Why no child can start now, or null. */
function refusal(): string | null {
  const host = Ed.host;
  if (host.kind === 'browser') return 'No processes in a web frame: they run in the desktop program (edwin, edwinclient)';
  if (!host.proc) return 'No processes here: only the desktop program (edwin, edwinclient) starts them';
  if (replays > 0) return 'No process starts while the image replays';
  return null;
}
function allowed(): EdHostProc {
  const why = refusal();
  if (why) signal('process-error', why);
  return Ed.host.proc!;
}
function checkArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string')) signal('process-error', 'A process is an argv: a list of strings, the program first');
  if (!(argv as string[])[0]) signal('process-error', 'A process needs a program');
  return (argv as string[]).slice();
}

function spawn(argv: string[], opts: EdProcOptions = {}): EdProc {
  const host = allowed();
  argv = checkArgv(argv);
  const { onOut, onErr, ...spawnOpts } = opts;
  let settle: (x: EdProcExit) => void;
  const exit = new Promise<EdProcExit>(r => { settle = r; });
  let id: number;
  try {
    id = host.spawn(argv, spawnOpts, (kind, data) => {
      if (kind === 'exit') settle(data as EdProcExit);
      else {
        const f = kind === 'out' ? onOut : onErr;
        if (f) try { f(data as string); } catch (e) { Ed.reportError(e); }
      }
    });
  } catch (e) { return signal('process-error', e && (e as Error).message ? (e as Error).message : String(e)) as never; }
  return {
    id, argv, exit,
    write: text => host.write(id, String(text)),
    closeStdin: () => host.closeStdin(id),
    kill: sig => host.kill(id, sig),
  };
}

/* The child's whole output and error, with its exit, once it has ended. INPUT is written to its standard input,
   which is then closed (at once without one). */
async function run(argv: string[], opts: EdProcSpawnOptions & { input?: string } = {}): Promise<EdProcResult> {
  const { input, ...rest } = opts;
  const out: string[] = [], err: string[] = [];
  const p = spawn(argv, { maxBytes: RUN_MAX_BYTES, ...rest, onOut: s => { out.push(s); }, onErr: s => { err.push(s); } });
  try {
    if (input !== undefined && input !== '') p.write(input);
    p.closeStdin();
  } catch (e) { p.kill('KILL'); throw e; }
  const x = await p.exit;
  return { ...x, out: out.join(''), err: err.join('') };
}

/* The environment changes a child started in DIR gets: none yet (proc-direnv will ask direnv). */
async function envFor(dir: string): Promise<Record<string, string | null>> {
  allowed();
  if (typeof dir !== 'string' || !dir) signal('process-error', 'envFor needs a directory');
  return {};
}

/* FN runs as the image's replay: no child starts in it, nor until the loop's next turn, by which time every
   continuation its microtasks started has run up to its first wait on something outside the turn. */
function replay<T>(fn: () => T): T {
  replays++;
  try { return fn(); }
  finally { setTimeout(() => { replays--; }, 0); }
}

/* TARGET (a URL, or an absolute file name) in the desktop's application, through the host: the desktop
   program's opener (native/src/open.rs, which checks the scheme and the file), a web page's new tab; edwind's
   Node host opens nothing. Null when it is on its way, else why not. Like a process, never while the image
   replays: a replayed form could otherwise hand the desktop a file to run. CONFIRMED says the user asked for a
   file whose type is not on the opener's allow-list; it never opens a program, a script or a .desktop file. */
function openUrl(target: string, opts: { confirmed?: boolean } = {}): string | null {
  if (typeof target !== 'string' || !target) return 'Nothing to open';
  if (replays > 0) return 'Nothing opens while the image replays';
  return Ed.host.openUrl(target, opts.confirmed === true);
}

Ed.proc = { available: () => refusal() === null, spawn, run, envFor, replay };
Ed.openUrl = openUrl;
})();
