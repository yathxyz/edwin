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

/* direnv (docs/steps.md, "direnv for child processes"): the environment of a directory under an .envrc the user
   has allowed. Only `direnv export json` is ever run, so direnv runs project code only where the user allowed it
   in a shell; Edwin never allows, denies or edits one. What it gives is kept in this frame's memory alone, never
   in storage, the image or a log: an .envrc often exports tokens. */
const DIRENV_ARGV = ['direnv', 'export', 'json'];
/* How long direnv may take (a nix-direnv shell built for the first time is slow), and when to say it loads. */
const DIRENV_TIMEOUT = 120_000, DIRENV_SLOW = 1000;
type Env = Record<string, string | null>;
/* By directory: its .envrc, the .envrc's stamp and what direnv gave. Only what an allowed .envrc gave is kept,
   so a blocked one is asked again, and runs once the user has allowed it. */
const direnvKept = new Map<string, { file: string; stamp: string; env: Env }>();
/* The direnv running for a directory and .envrc: its result, and C-g's way to stop it. */
const direnvAsked = new Map<string, { result: Promise<Env>; stop: () => void }>();
const parentDir = (d: string) => { const i = d.lastIndexOf('/'); return i <= 0 ? '/' : d.slice(0, i); };
/* The nearest .envrc from DIR up, with its stamp; null when there is none; undefined when the host cannot tell. */
function envrcOf(dir: string): { file: string; stamp: string } | null | undefined {
  const files = Ed.host.files;
  if (!files || !files.stamp) return undefined;
  for (let d = dir.replace(/\/+$/, '') || '/'; ; d = parentDir(d)) {
    const file = (d === '/' ? '' : d) + '/.envrc', stamp = files.stamp(file);
    if (stamp) return { file, stamp };
    if (d === '/') return null;
  }
}
/* direnv's error: the first line it marks as one, without its colours. Never another line of its error output:
   that is the .envrc's own, which may print a secret, and the echo area goes to *Messages*. */
function direnvError(err: string, code: number | null): string {
  const lines = err.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim());
  return lines.find(l => l.startsWith('direnv: error')) || `direnv ended with ${code === null ? 'a signal' : 'code ' + code}`;
}
/* direnv started in DIR: what it exports there, or null for the plain environment (said in the echo area when
   direnv says why); STOP kills it, and then the result is a process-error, never the plain environment. Spawned
   before this returns, so a refusal (the image's replay) is thrown here, before any wait. */
function askDirenv(dir: string, file: string | null): { result: Promise<Env | null>; stop: () => void } {
  const out: string[] = [], err: string[] = [];
  let p: EdProc;
  try { p = spawn(DIRENV_ARGV, { cwd: dir, timeout: DIRENV_TIMEOUT, maxBytes: RUN_MAX_BYTES, onOut: s => { out.push(s); }, onErr: s => { err.push(s); } }); }
  catch (e) {
    /* direnv not on PATH, or DIR gone (the caller's own child then says so): the plain environment */
    if (refusal()) throw e;
    return { result: Promise.resolve(null), stop: () => {} };
  }
  try { p.closeStdin(); } catch (e) { /* ended already: its exit says how */ }
  let stopped = false;
  const loading = `direnv: loading ${file || dir}`;
  const slow = setTimeout(() => Ed.message(loading), DIRENV_SLOW);
  const result = p.exit.then(x => {
    clearTimeout(slow);
    /* the loading note goes once direnv is done, unless something was said after it */
    if (Ed.E.echo === loading) Ed.message('');
    if (stopped) signal('process-error', 'direnv was stopped');
    const plain = (why: string) => { Ed.message(`${why}; the plain environment is used`); return null; };
    if (x.timedOut) return plain(`direnv took longer than ${DIRENV_TIMEOUT / 1000} s for ${file || dir}`);
    /* A blocked .envrc ends with 1 and still prints direnv's own DIRENV_ variables: none of it is used. */
    if (x.code !== 0 || x.truncated || x.error) return plain(direnvError(err.join(''), x.code));
    let env: unknown;
    const text = out.join('');
    try { env = text.trim() ? JSON.parse(text) : {}; } catch { env = null; }
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(v => v !== null && typeof v !== 'string')) return plain('direnv gave no environment Edwin can read');
    return env as Env;
  });
  return { result, stop: () => { stopped = true; p.kill('KILL'); } };
}

/* The environment changes a child started in DIR gets: what direnv exports for the .envrc above DIR; none where
   there is none, direnv is not on PATH or the .envrc is blocked. Refused at once where a child is (the image's
   replay above all). Kept per directory until its .envrc changes. A command awaiting it holds every key (pool.ts),
   so the wait is EdPool.interruptible: C-g kills direnv and quits, rather than the frame waiting up to the timeout
   for a slow nix-direnv. */
async function envFor(dir: string): Promise<Env> {
  allowed();
  if (typeof dir !== 'string' || !dir) signal('process-error', 'envFor needs a directory');
  const files = Ed.host.files;
  if (files) dir = files.resolve(dir);
  const at = envrcOf(dir);
  if (at === null) return {};
  const kept = at && direnvKept.get(dir);
  if (kept && kept.file === at.file && kept.stamp === at.stamp) return { ...kept.env };
  /* Two asks for the same directory and .envrc at once run direnv once. */
  const key = at ? `${dir}\0${at.file}\0${at.stamp}` : dir;
  let ask = direnvAsked.get(key);
  if (!ask) {
    const { result, stop } = askDirenv(dir, at ? at.file : null);
    /* A stopped run is forgotten at once: an ask made before it has ended starts direnv again. */
    const forget = () => { if (direnvAsked.get(key) === made) direnvAsked.delete(key); };
    const made = {
      result: result.then(env => {
        if (env && at) direnvKept.set(dir, { ...at, env });
        return env || {};
      }).finally(forget),
      stop: () => { forget(); stop(); },
    };
    direnvAsked.set(key, ask = made);
  }
  const wait = Object.assign(ask.result.then(env => ({ ...env })), { cancel: ask.stop });
  return EdPool.interruptible ? EdPool.interruptible(wait) : wait;
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
