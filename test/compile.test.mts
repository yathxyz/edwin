// compile (src/compile.ts): a shell command's output streamed into *compilation*, the line that says how it
// ended, recompile with the same command and directory, kill-compilation, the cap on lines, and the refusals
// (a web frame, no host.proc, the image's replay). Headless Edwin on the Node host, with the desktop
// program's host.proc stood in by fake-proc.mts (sh, seq, printf and sleep from PATH).
// One Edwin per process, so the cases run in order.
// Run: node --test test/compile.test.mts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

const proc = fakeProc();
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: unknown };
host.proc = proc;
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await Ed.whenIdle(); };
const type = async (s: string) => { for (const ch of s) Ed.feedKey(ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch); await Ed.whenIdle(); };
L.evalText('(set! corfu-auto #f)');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-compile-'));
after(() => { for (const id of proc.running()) proc.kill(id, 'KILL'); fs.rmSync(root, { recursive: true, force: true }); });

const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 10)); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const buf = () => Ed.getBuffer('*compilation*');
const text = (): string => buf().text;
/* The output: what lies between the header (four lines) and the status line. */
const output = () => text().split('\n').slice(4).join('\n');
const STATUS = (what: string) => new RegExp(`\\n\\n${what} at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d, duration \\d+\\.\\d\\d s\\n$`);
const isProcErr = (e: unknown) => L.S.conditionIs(e, 'process-error');
const scratch = () => { Ed.deleteOtherWindows(); Ed.setWindowBuffer(Ed.getBufferCreate('*compile-scratch*')); };

test('the output streams into *compilation* as it comes; the last line says it finished', async () => {
  scratch();
  const c = await Ed.compile.start('echo one; sleep 0.4; echo two >&2', root);
  const call = proc.calls[proc.calls.length - 1];
  assert.deepEqual(call.argv, ['sh', '-c', 'echo one; sleep 0.4; echo two >&2'], 'a shell line, run by sh');
  assert.equal(call.opts.cwd, root);
  assert.equal(call.opts.merge, true); assert.equal(call.opts.lossy, true); assert.equal(call.opts.env!.TERM, 'dumb');
  assert.equal(call.opts.maxBytes, undefined, 'a long build is not killed for its output');
  await until(() => text().includes('one\n'), 'the first line');
  assert.ok(Ed.compile.running() && proc.running().length === 1, 'the first line is shown while the command still runs');
  assert.ok(!output().includes('two'));
  const x = await c.exit;
  assert.equal(x.code, 0);
  const lines = text().split('\n');
  assert.equal(lines[0], `-*- mode: compilation; default-directory: "${root}/" -*-`);
  assert.match(lines[1], /^Compilation started at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(lines[2], ''); assert.equal(lines[3], 'echo one; sleep 0.4; echo two >&2');
  assert.match(output(), /^one\ntwo\n/, 'the error is in the output, in order');
  assert.match(text(), STATUS('Compilation finished'));
  assert.equal(E.echo, 'Compilation finished');
  const b = buf();
  assert.equal(b.mode, 'compilation-mode'); assert.equal(b.readOnly, true); assert.equal(b.modified, false);
  assert.equal(E.current.name, '*compile-scratch*', 'shown in another window, not selected');
  assert.ok(Ed.windowList().some((w: { buffer: unknown }) => w.buffer === b));
  assert.deepEqual(b.compile, { command: 'echo one; sleep 0.4; echo two >&2', dir: root });
  assert.equal(Ed.compile.running(), false); assert.equal(c.kill(), false, 'an ended compilation takes no signal');
});

test('SPC c c reads the command, offering the last one; g r runs it again in the same directory', async () => {
  scratch();
  L.evalText('(set! compile-command "")');
  host.files = { cwd: root, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(root, p) };
  try {
    await keys('SPC c c'); await type('echo built; exit 2\n');
    await until(() => !Ed.compile.running() && STATUS('Compilation exited abnormally with code 2').test(text()), 'the status line');
  } finally { delete host.files; }
  assert.equal(E.echo, 'Compilation exited abnormally with code 2');
  assert.equal(L.get('compile-command'), 'echo built; exit 2', 'the next compile offers it');
  const first = proc.calls[proc.calls.length - 1];
  assert.equal(first.opts.cwd, root, 'a buffer with no file: the program\'s directory');
  /* g r in *compilation*, from another directory: the same argv and directory. */
  const n = proc.calls.length;
  Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer === buf()));
  await keys('g r');
  await until(() => proc.calls.length === n + 1 && !Ed.compile.running() && /Compilation exited abnormally/.test(text()), 'the rerun');
  const again = proc.calls[n];
  assert.deepEqual(again.argv, first.argv); assert.equal(again.opts.cwd, first.opts.cwd);
  assert.equal(output().match(/built/g)!.length, 1, 'the buffer starts again');
  /* RET on an output line changes nothing; q leaves it, as in special-mode buffers. */
  const shown = text();
  await keys('G k RET');
  assert.equal(E.current, buf()); assert.equal(text(), shown);
  await keys('q');
  assert.notEqual(E.current, buf());
});

test('the project is the nearest directory up with a .git or a .jj, else the file\'s directory', async () => {
  const proj = path.join(root, 'proj'), sub = path.join(proj, 'src', 'deep'), lone = path.join(root, 'lone');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true }); fs.mkdirSync(sub, { recursive: true }); fs.mkdirSync(lone);
  const jj = path.join(root, 'jjrepo'); fs.mkdirSync(path.join(jj, '.jj'), { recursive: true }); fs.mkdirSync(path.join(jj, 'lib'));
  host.files = { cwd: root, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(root, p) };
  try {
    const at = async (file: string) => {
      scratch(); E.current.file = file;
      const c = await Ed.compile.start('true'); await c.exit; E.current.file = null; return c.dir;
    };
    assert.equal(await at(path.join(sub, 'main.rs')), proj);
    assert.equal(await at('proj/src/lib.rs'), proj, 'a relative name is resolved first');
    assert.equal(await at(path.join(jj, 'lib', 'x.nix')), jj);
    assert.equal(await at(path.join(lone, 'a.py')), lone);
    assert.equal(proc.calls[proc.calls.length - 1].opts.cwd, lone);
  } finally { delete host.files; }
});

test('kill-compilation (C-c C-k) interrupts it; the last line says so', async () => {
  scratch();
  await Ed.compile.start('echo started; sleep 10', root);
  await until(() => text().includes('started'), 'the output');
  Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer === buf()));
  await keys('C-c C-k');
  await until(() => !Ed.compile.running(), 'the end');
  assert.match(text(), STATUS('Compilation interrupted'));
  assert.deepEqual(proc.running(), []);
  assert.throws(() => L.call('kill-compilation', []), /No compilation is running/);
});

test('a new compilation replaces a running one: the old child is killed and its late output never shows', async () => {
  scratch();
  await Ed.compile.start('sleep 0.3; echo OLD', root);
  const old = proc.calls[proc.calls.length - 1].id;
  const c = await Ed.compile.start('echo NEW', root);
  await c.exit;
  await until(() => !proc.running().includes(old), 'the old child gone');
  await sleep(500);
  assert.ok(text().includes('NEW')); assert.ok(!text().includes('OLD'));
  assert.equal(text().match(/^Compilation /gm)!.length, 2, 'one started line and one status line');
  assert.match(text(), STATUS('Compilation finished'));
});

const DROPPED = '[Earlier output dropped: the last 20000 lines and 4 MiB are kept]';
/* The output below the line that says some was dropped. */
const kept = () => { const o = output(); assert.ok(o.startsWith(DROPPED + '\n'), 'a line says output was dropped'); return o.slice(DROPPED.length + 1); };
/* What the edit log of *compilation* holds, in characters. */
const logChars = () => buf().log.reduce((n: number, e: { del: string; ins: string }) => n + e.del.length + e.ins.length, 0);

test('past 20000 lines the oldest go, below the header; a line there says so', async () => {
  scratch();
  const c = await Ed.compile.start('seq 1 25000', root);
  await c.exit;
  const out = kept().split('\n');
  assert.equal(out[0], '5001'); assert.equal(out[19999], '25000'); assert.equal(out[20000], '');
  assert.match(text(), STATUS('Compilation finished'));
  assert.ok(text().startsWith('-*- mode: compilation;'), 'the header stays');
  assert.equal(text().split(DROPPED).length, 2, 'said once');
  assert.deepEqual([buf().undo.length, buf().modified], [0, false], 'no undo history kept');
});

test('output with no newlines is bounded too: at most 4 MiB of it is kept', async () => {
  scratch();
  const c = await Ed.compile.start("head -c 6000000 /dev/zero | tr '\\0' x; echo; echo tail", root);
  await c.exit;
  const b = buf(), head = text().indexOf('\n', text().indexOf('tr ')) + 1;
  assert.ok(text().startsWith('-*- mode: compilation;'), 'the header stays');
  assert.ok(b.rope.length - head <= 4 * 1024 * 1024 + 300, `kept ${b.rope.length - head}`);
  assert.match(kept(), /^(x*\n)?tail\n/); assert.match(text(), STATUS('Compilation finished'));
  assert.deepEqual([b.undo.length, b.modified], [0, false]);
});

test('a line longer than 4 MiB is cut mid-line: its last 4 MiB stay', async () => {
  scratch();
  const c = await Ed.compile.start("head -c 5000000 /dev/zero | tr '\\0' x; echo", root);
  await c.exit;
  const out = kept();
  const xs = out.match(/^x*/)![0].length;
  assert.ok(xs > 4 * 1024 * 1024 - 64 * 1024 && xs <= 4 * 1024 * 1024, `kept ${xs} of the line`);
  assert.match(out.slice(xs), /^\n\nCompilation finished/);
});

/* A flood: the batch and the buffer's edit log stay bounded, so memory does too, whether *compilation* is
   selected (its last command's version is a floor of the log) or only shown. */
for (const selected of [false, true]) test(`a flood keeps the edit log bounded (*compilation* ${selected ? 'selected' : 'not selected'})`, async () => {
  scratch();
  await (await Ed.compile.start('true', root)).exit;
  if (selected) { Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer === buf())); await keys('G'); }
  let most = 0;
  const watch = setInterval(() => { if (buf()) most = Math.max(most, logChars()); }, 5);
  try {
    const c = await Ed.compile.start("yes 'line of output 1234567890' | head -c 60000000", root);
    assert.equal((await c.exit).code, 0);
  } finally { clearInterval(watch); }
  most = Math.max(most, logChars());
  assert.ok(most <= 3 * 4 * 1024 * 1024, `the log held ${most} characters`);
  const out = kept().split('\n');
  assert.equal(out[0], 'line of output 1234567890'); assert.ok(out.length <= 20000 + 4, `${out.length} lines kept`);
  assert.match(text(), STATUS('Compilation finished'));
  if (selected) assert.equal(E.current, buf());
});

test('escapes are dropped, a carriage return starts its line again, bytes that are not UTF-8 shown as U+FFFD, stdin closed', async () => {
  scratch();
  const c = await Ed.compile.start("printf '\\033[1;31merror\\033[0m: \\377 bad\\r\\n'; printf '\\033]0;title\\007ok\\n'; cat; echo after-stdin", root);
  assert.equal((await c.exit).code, 0);
  assert.equal(output().split('\n\n')[0], 'error: � bad\nok\nafter-stdin');
  const shows = async (cmd: string, want: string) => {
    await (await Ed.compile.start(cmd, root)).exit;
    assert.equal(output().split('\n\n')[0], want, cmd);
  };
  await shows("printf '10%%\\r50%%\\r100%%\\n'; echo next", '100%\nnext');
  /* A \r in a later batch starts the line already shown again; a \r\n split between batches is a newline. */
  await shows("printf 'a\\n10%%\\r'; sleep 0.1; printf '100%%\\n'", 'a\n100%');
  await shows("printf 'ok\\r'; sleep 0.1; printf '\\nnext\\n'", 'ok\nnext');
  await shows("printf 'last\\r'", 'last');
  await shows("printf 'a\\r\\r\\r\\nb\\r\\rc\\n'", 'a\nc');
});

/* A long run of \r (a binary file on stdout) is taken in linear time: the frame never stalls on it. */
test('a run of 400000 carriage returns does not stall the frame', async () => {
  scratch();
  let stall = 0, at = Date.now();
  const tick = setInterval(() => { const now = Date.now(); stall = Math.max(stall, now - at); at = now; }, 5);
  const t0 = Date.now();
  try {
    const c = await Ed.compile.start("printf 'before\\n'; head -c 400000 /dev/zero | tr '\\0' '\\r'; echo x; head -c 400000 /dev/zero | tr '\\0' '\\r'", root);
    assert.equal((await c.exit).code, 0);
  } finally { clearInterval(tick); }
  assert.equal(output().split('\n\n')[0], 'before\nx');
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.ok(stall < 1000, `the frame stalled ${stall} ms`);
});

/* A progress line that only replaces the last line never cuts: its edits do not pile up in the log either,
   even with *compilation* selected after a command (whose version is a floor of the log). */
test('a progress line keeps the edit log empty', async () => {
  scratch();
  await (await Ed.compile.start('true', root)).exit;
  Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer === buf())); await keys('G');
  let most = 0;
  const watch = setInterval(() => { if (buf()) most = Math.max(most, buf().log.length); }, 5);
  try {
    const c = await Ed.compile.start("i=0; while [ $i -lt 100 ]; do printf '\\r%s %0200d' $i 0; sleep 0.01; i=$((i+1)); done; echo", root);
    assert.equal((await c.exit).code, 0);
  } finally { clearInterval(watch); }
  assert.match(output(), /^99 0{200}\n\n/);
  assert.ok(most <= 2, `the log held ${most} entries`);
});

test('the header quotes the directory', async () => {
  scratch();
  const odd = path.join(root, 'a b "c\\d');
  fs.mkdirSync(odd);
  await (await Ed.compile.start('true', odd)).exit;
  assert.equal(text().split('\n')[0], `-*- mode: compilation; default-directory: "${root}/a b \\"c\\\\d/" -*-`);
});

test('killing *compilation* kills its child', async () => {
  scratch();
  await Ed.compile.start('sleep 10', root);
  assert.equal(proc.running().length, 1);
  L.call('kill-buffer', [buf()]);
  await until(() => proc.running().length === 0, 'the child gone');
  assert.equal(Ed.compile.running(), false);
  assert.equal(buf(), null);
});

test('a command that cannot start says so in the buffer and signals process-error', async () => {
  scratch();
  await assert.rejects(Ed.compile.start('true', path.join(root, 'not-there')), isProcErr);
  assert.match(text(), /\nCompilation failed to start at .*: process-error: cannot run sh: No such file or directory\n$/);
  await assert.rejects(Ed.compile.start('   ', root), /No command/);
});

test('R16.15: a replayed form starts no compilation and leaves the running one alone', async () => {
  scratch();
  const running = await Ed.compile.start('sleep 10', root);
  const n = proc.calls.length, before = text();
  await assert.rejects(Ed.proc.replay(() => Ed.compile.start('echo replayed', root)), (e: unknown) => isProcErr(e) && /while the image replays/.test(Ed.errorText(e)));
  await assert.rejects(Ed.proc.replay(() => Ed.compile.recompile()), isProcErr);
  /* The commands, as a replayed form calls them. */
  for (const form of ['(compile "echo replayed")', '(recompile)']) {
    let r: unknown;
    try { r = Ed.proc.replay(() => L.evalText(form)); } catch (e) { r = e; }
    if (r instanceof Promise) await r.catch(() => {});
  }
  await sleep(20);
  assert.equal(proc.calls.length, n, 'nothing spawned');
  assert.equal(Ed.compile.running(), true, 'the running compilation was not killed');
  assert.equal(text(), before);
  running.kill('KILL');
  await running.exit;
  assert.match(text(), STATUS('Compilation killed'));
});

test('no compilation in a web frame or where the host gives no processes; the command is not even read', async () => {
  scratch();
  const n = proc.calls.length, before = text();
  const check = async (why: RegExp) => {
    await keys('SPC c c');
    assert.match(E.echo, why); assert.equal(E.current.name, '*compile-scratch*', 'no minibuffer');
    await assert.rejects(Ed.compile.start('echo x', root), isProcErr);
  };
  Ed.host.kind = 'browser';
  try { await check(/No process here/); } finally { Ed.host.kind = 'node'; }
  delete host.proc;
  try { await check(/No process here/); } finally { host.proc = proc; }
  assert.equal(proc.calls.length, n); assert.equal(text(), before);
});

/* ---- The places errors name (proc-compile-errors) ---- */

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'compile');
type Row = [string, number, number | false, string | false];
/* The frame's error list, as rows, and the unit of each row's column. */
const entries = (): unknown[][] => L.evalText('(list->vector (map list->vector (vector->list next-error--errors)))');
const errorList = (): Row[] => entries().map(e => e.slice(0, 4) as Row);
const units = () => entries().map(e => (e[4] === false ? false : (e[4] as { name: string }).name));
const compileShows = async (cmd: string, dir: string | null = root) => { const c = await Ed.compile.start(cmd, dir); await c.exit; return errorList(); };

test('each tool\'s log, streamed through compile, gives the exact places of its errors and warnings', async () => {
  scratch();
  const D = path.join(root, 'tool'); fs.mkdirSync(D, { recursive: true });
  const cases: Record<string, Row[]> = {
    'rustc.log': [
      [`${D}/src/main.rs`, 3, 20, 'error[E0425]: cannot find value `missing` in this scope'],
      [`${D}/src/main.rs`, 4, 18, 'error[E0308]: mismatched types'],
    ],
    'rustc-run.log': [
      [`${D}/src/main.rs`, 2, 9, 'warning: unused variable: `unused`'],
      [`${D}/src/main.rs`, 4, 21, "thread 'main' (4179928) panicked at src/main.rs:4:21:"],
    ],
    'tsc.log': [
      [`${D}/a.ts`, 1, 7, "error TS2322: Type 'string' is not assignable to type 'number'."],
      [`${D}/a.ts`, 3, 3, "error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'."],
    ],
    /* tsc --pretty: its colours are dropped, then the same places. */
    'tsc-pretty.log': [
      [`${D}/a.ts`, 1, 7, "error TS2322: Type 'string' is not assignable to type 'number'."],
      [`${D}/a.ts`, 3, 3, "error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'."],
    ],
    /* make -C sub: the names are taken from the directory make entered; the note is skipped. */
    'gcc.log': [
      ['/work/fx/c/sub/a.c', 3, 17, 'a.c:3:17: error: ‘y’ undeclared (first use in this function)'],
      ['/work/fx/c/sub/a.c', 4, 16, 'a.c:4:16: error: returning ‘char *’ from a function with return type ‘int’ makes integer from pointer without a cast [-Wint-conversion]'],
      ['/work/fx/c/sub/a.c', 3, 13, 'a.c:3:13: warning: unused variable ‘x’ [-Wunused-variable]'],
    ],
    'python.log': [
      ['/work/fx/py/t.py', 7, false, 'File "/work/fx/py/t.py", line 7, in <module>'],
      ['/work/fx/py/t.py', 5, false, 'File "/work/fx/py/t.py", line 5, in f'],
      ['/work/fx/py/t.py', 2, false, 'File "/work/fx/py/t.py", line 2, in g'],
    ],
    'nix.log': [['/work/fx/nx/default.nix', 2, 14, "error: undefined variable 'undefinedThing'"]],
    /* The trace frame (… while evaluating) is skipped: the error is the place nix names under error:. */
    'nix-trace.log': [['/work/fx/nx/flake-ish.nix', 3, 19, "error: attribute 'version' missing"]],
    /* nix counts UTF-8 bytes: 26 is the zz at character 23, after three two-byte é (nix 2.34). */
    'nix-utf8.log': [['/work/fx/nx/u.nix', 2, 26, "error: undefined variable 'zz'"]],
  };
  for (const [log, want] of Object.entries(cases)) {
    assert.deepEqual(await compileShows(`cat '${path.join(FIXTURES, log)}'`, D), want, log);
    /* gcc counts display columns, tsc UTF-16 units, nix UTF-8 bytes, the rest characters. */
    const unit = log.startsWith('gcc') ? 'screen' : log.startsWith('tsc') ? 'utf-16' : log.startsWith('nix') ? 'byte' : false;
    assert.deepEqual(units(), want.map(([, , c]) => (c === false ? false : unit)), log + ': the units');
    assert.deepEqual(Ed.compile.errors(fs.readFileSync(path.join(FIXTURES, log), 'utf8').replace(/\x1b\[[0-9;]*m/g, ''), D), want.map(([f, l, c, m]) => [f, l, c === false ? null : c, m === false ? null : m, c === false || unit === false ? null : unit]), log + ' through Ed.compile.errors');
  }
  /* With no directory (no file system), a relative name stays relative. */
  assert.deepEqual(await compileShows(`cat '${path.join(FIXTURES, 'tsc.log')}'`, null), cases['tsc.log'].map(([, l, c, m]) => ['a.ts', l, c, m]));
});

test('the header and the status line are not output: a command that looks like a place gives none', async () => {
  scratch();
  assert.deepEqual(await compileShows('a.c:3:4: x 2>/dev/null; true'), []);
  assert.ok(text().split('\n')[3].startsWith('a.c:3:4: x'), 'the command is in the header');
  assert.deepEqual(await compileShows("printf 'x.c:1:2: error: y\\n'; exit 1"), [[`${root}/x.c`, 1, 2, 'x.c:1:2: error: y']]);
  assert.match(text(), /Compilation exited abnormally/);
});

test('a place split across two batches is read once it is whole; the last line needs no newline', async () => {
  scratch();
  assert.deepEqual(await compileShows("printf 'src/a.c:1'; sleep 0.15; printf '2:3: error: split\\nb.c:4:5: error: last'"), [
    [`${root}/src/a.c`, 12, 3, 'src/a.c:12:3: error: split'], [`${root}/b.c`, 4, 5, 'b.c:4:5: error: last']]);
  /* A line a carriage return starts again is read as it ends. */
  assert.deepEqual(await compileShows("printf 'q.c:1:1: error: old\\r'; sleep 0.15; printf 'q.c:9:9: error: new\\n'"), [[`${root}/q.c`, 9, 9, 'q.c:9:9: error: new']]);
});

test('lines that only look like places are none: line 0, times, versions, URLs, hosts, pseudo-files, huge numbers', async () => {
  scratch();
  const lines = ['a.c:0:3: error: zero', 'b.c:2:0: error: column 0', '07:52:09 started', '1.2.3:4: version', 'http://h:80/ x',
    'localhost:8080: refused', 'Makefile:3: *** missing separator.  Stop.', '<stdin>:1:2: x', '  File "<string>", line 1',
    'c.c:99999999999999999999: big', '  at «string»:1:1:', 'In file included from d.h:3:2,', 'e.c:5:1: note: a note',
    'a.c: In function ‘main’:', ' --> f.rs:x:1'];
  const cmd = `printf '%s\\n' ${lines.map(l => `'${l.replace(/'/g, `'\\''`)}'`).join(' ')}`;
  assert.deepEqual(await compileShows(cmd), [[`${root}/b.c`, 2, false, 'b.c:2:0: error: column 0'], [`${root}/Makefile`, 3, false, 'Makefile:3: *** missing separator.  Stop.']]);
});

test('M-g n during the build keeps its place as more errors come; a list another producer set is left alone', async () => {
  scratch();
  const D = path.join(root, 'tool'); fs.mkdirSync(D, { recursive: true });
  Ed.Store.set(`${D}/src/main.rs`, 'fn main() {\n    let unused = 1;\n    println!("{}", missing);\n    let s: u32 = "text";\n}\n');
  Ed.Store.set(`${D}/a.ts`, 'const n: number = "text";\nfunction f(x: string) { return x; }\nf(3);\n');
  const c = await Ed.compile.start(`cat '${path.join(FIXTURES, 'rustc.log')}'; sleep 0.5; cat '${path.join(FIXTURES, 'tsc.log')}'`, D);
  await until(() => errorList().length === 2, 'the first errors');
  assert.equal(Ed.compile.running(), true);
  await keys('M-g n');
  assert.deepEqual([E.current.file, L.evalText('(line-number-at-pos)')], [`${D}/src/main.rs`, 3]);
  await c.exit;
  assert.equal(errorList().length, 4, 'the later errors are added');
  assert.equal(L.evalText('next-error--index'), 0, 'the place stepped to is kept');
  await keys('M-g n'); await keys('M-g n');
  assert.deepEqual([E.current.file, L.evalText('(line-number-at-pos)')], [`${D}/a.ts`, 1]);
  /* Another producer's list, set while a compilation runs, gets none of its errors. */
  scratch();
  const d = await Ed.compile.start(`sleep 0.3; cat '${path.join(FIXTURES, 'tsc.log')}'`, D);
  L.evalText(`(next-error-set-list! '(("x.rs" 1)))`);
  await d.exit;
  assert.deepEqual(errorList(), [['x.rs', 1, false, false]]);
  /* A new compilation takes the list over at once, empty until its output names places. */
  const e = await Ed.compile.start('sleep 0.2', D);
  assert.deepEqual(errorList(), []);
  await e.exit;
});

test('M-g n on gcc\'s errors lands where gcc points on a tab-indented line: its columns are display columns', async () => {
  scratch();
  Ed.Store.set('/work/fx/c/sub/a.c', 'int main(void)\n{\n\tint x = y;\n\treturn "s";\n}\n');
  await compileShows(`cat '${path.join(FIXTURES, 'gcc.log')}'`);
  const col = () => L.evalText('(- (point) (line-beginning-position) -1)');
  const at = () => L.evalText('(buffer-substring (point) (+ (point) 1))');
  await keys('M-g n');
  assert.deepEqual([E.current.file, L.evalText('(line-number-at-pos)'), col(), at()], ['/work/fx/c/sub/a.c', 3, 10, 'y'], 'a.c:3:17 is the y');
  await keys('M-g n');
  assert.deepEqual([L.evalText('(line-number-at-pos)'), at()], [4, '"'], 'a.c:4:16 is the string');
  await keys('M-g n');
  assert.deepEqual([L.evalText('(line-number-at-pos)'), col(), at()], [3, 6, 'x'], 'a.c:3:13 is the x');
});

test('M-g n on nix\'s error lands where nix points past non-ASCII text: its columns are UTF-8 bytes', async () => {
  scratch();
  Ed.Store.set('/work/fx/nx/u.nix', '# Dépendances — tout\nlet a = "ééé"; in a + zz\n');
  await compileShows(`cat '${path.join(FIXTURES, 'nix-utf8.log')}'`);
  await keys('M-g n');
  assert.deepEqual([E.current.file, L.evalText('(line-number-at-pos)'), L.evalText('(- (point) (line-beginning-position) -1)'), L.evalText('(buffer-substring (point) (+ (point) 2))')],
    ['/work/fx/nx/u.nix', 2, 23, 'zz'], 'u.nix:2:26 is the zz, three characters left of character 26');
});

test('a header names the place on the line below it only; a nix at line ends in a colon, so a JS stack frame is none', () => {
  assert.deepEqual(Ed.compile.errors('error: x\n    at /x/z.js:3:4\n', '/w'), []);
  assert.deepEqual(Ed.compile.errors('note: n\n --> a.rs:1:2\nfoo.py:3: warn\n --> b.rs:5:6\n', '/w'),
    [['/w/foo.py', 3, null, 'foo.py:3: warn', null], ['/w/b.rs', 5, 6, '--> b.rs:5:6', null]]);
  /* A line between them, even one with no colon, ends the header. */
  assert.deepEqual(Ed.compile.errors('error[E1]: old\nbuilding\n --> c.rs:1:1\n', '/w'), [['/w/c.rs', 1, 1, '--> c.rs:1:1', null]]);
  assert.deepEqual(Ed.compile.errors('error[E1]: now\n --> c.rs:1:1\n', '/w'), [['/w/c.rs', 1, 1, 'error[E1]: now', null]]);
});

test('make\'s directory stack keeps the innermost 64: past it the outermost goes', () => {
  let text = '';
  for (let i = 0; i <= 64; i++) text += `make[${i + 1}]: Entering directory '/d${i}'\n`;
  for (let i = 64; i >= 1; i--) text += `make[${i + 1}]: Leaving directory '/d${i}'\n`;
  assert.deepEqual(Ed.compile.errors(text + 'x.c:1:1: error: e\n', '/w'), [['/w/x.c', 1, 1, 'x.c:1:1: error: e', 'screen']]);
});

test('a refused hand-over to the error list loses no output; a refused new list still starts and shows the compilation', async () => {
  scratch();
  L.evalText('(define compile-test--add next-error-add-to-list!)');
  L.evalText('(define compile-test--set next-error-set-list!)');
  try {
    L.evalText('(set! next-error-add-to-list! (lambda args (error "refused")))');
    await compileShows("printf 'a.c:1:1: error: x\\nafter\\n'");
    assert.match(output(), /^a\.c:1:1: error: x\nafter\n/);
    assert.match(text(), STATUS('Compilation finished'));
    L.evalText('(set! next-error-add-to-list! compile-test--add)');
    L.evalText('(set! next-error-set-list! (lambda args (error "refused")))');
    /* The refusal is reported (*Messages*), not thrown: the caller gets the run and *compilation* is shown. */
    const c = await Ed.compile.start("sleep 0.1; printf 'late\\n'", root);
    assert.equal(c.buffer, buf()); assert.equal(Ed.compile.running(), true);
    assert.ok(Ed.windowList().some((w: { buffer: unknown }) => w.buffer === c.buffer), '*compilation* is shown');
    assert.match(Ed.getBuffer('*Messages*').text, /refused/);
    await c.exit;
    await until(() => STATUS('Compilation finished').test(text()), 'the status line');
    assert.match(output(), /^late\n/);
  } finally {
    L.evalText('(set! next-error-add-to-list! compile-test--add)');
    L.evalText('(set! next-error-set-list! compile-test--set)');
  }
});

test('at most 20000 errors are kept, the first ones; handing them over does not stall the frame', async () => {
  scratch();
  let stall = 0, at = Date.now();
  const tick = setInterval(() => { const now = Date.now(); stall = Math.max(stall, now - at); at = now; }, 5);
  let list: Row[];
  try { list = await compileShows("printf 'a.c:1:1: error: x%s\\n' $(seq 1 30000)"); } finally { clearInterval(tick); }
  assert.ok(stall < 250, `the frame stalled ${stall} ms`);
  console.log(`# 30000 error lines: the longest stall ${stall} ms`);
  assert.equal(list.length, 20000);
  assert.deepEqual(list[0], [`${root}/a.c`, 1, 1, 'a.c:1:1: error: x1']);
  assert.equal(list[19999][3], 'a.c:1:1: error: x20000');
});

/* The budget: 10,000 lines of mixed output (every tool's log, and plain build noise) are read in under 20 ms, and
   lines past SCAN characters cost no more than SCAN does, whatever they hold. Best of five, on a busy machine. */
test('reading 10,000 lines stays within 20 ms; long lines are read in their first 4096 characters only', () => {
  const logs = fs.readdirSync(FIXTURES).map(f => fs.readFileSync(path.join(FIXTURES, f), 'utf8').replace(/\x1b\[[0-9;]*m/g, '')).join('');
  const noise = '   Compiling serde v1.0.200\nbuilding \'/nix/store/abc-x.drv\'...\n[ 42%] Building C object src/foo.o\n';
  let mixed = '';
  while (mixed.split('\n').length < 10000) mixed += logs + noise;
  mixed = mixed.split('\n').slice(0, 10000).join('\n') + '\n';
  const best = (text: string) => { let t = Infinity; for (let i = 0; i < 5; i++) { const t0 = performance.now(); Ed.compile.errors(text, '/w'); t = Math.min(t, performance.now() - t0); } return t; };
  const mixedMs = best(mixed);
  assert.ok(Ed.compile.errors(mixed, '/w').length > 1000);
  assert.ok(mixedMs < 20, `10,000 mixed lines took ${mixedMs.toFixed(2)} ms`);
  /* And what the frame pays to hand them to the error list: the rows into Scheme, checked and appended. */
  const handMs = (() => { let t = Infinity; for (let i = 0; i < 5; i++) {
    L.evalText(`(next-error-set-list! '() "budget")`);
    const t0 = performance.now(), rows = Ed.compile.errors(mixed, '/w');
    L.call('next-error-add-to-list!', ['budget', L.listOf(rows.map(([f, l, c, m, u]: [string, number, number | null, string | null, string | null]) => L.list(f, l, c ?? false, m ?? false, u === null ? false : L.intern(u))))]);
    t = Math.min(t, performance.now() - t0);
  } return t; })();
  assert.ok(handMs < 50, `10,000 mixed lines read and handed over in ${handMs.toFixed(2)} ms`);
  /* Near misses as long as they come: colons, digits and parentheses all along the line. */
  const longs = ['a'.repeat(100000) + ':1:1: x', ('a:1' + ' ').repeat(25000), 'x('.repeat(50000) + '1,1): error x', ' --> ' + 'b:'.repeat(50000), ':9'.repeat(50000), '  File "' + '"'.repeat(100000)];
  let long = '';
  for (let i = 0; i < 1000; i++) long += longs[i % longs.length] + '\n';
  const longMs = best(long);
  assert.deepEqual(Ed.compile.errors(long, '/w'), []);
  assert.ok(longMs < 100, `1,000 lines of 100,000 characters took ${longMs.toFixed(2)} ms`);
  console.log(`# parse: 10,000 mixed lines ${mixedMs.toFixed(2)} ms (${Ed.compile.errors(mixed, '/w').length} places), handed over ${handMs.toFixed(2)} ms; 1,000 long lines ${longMs.toFixed(2)} ms`);
});
