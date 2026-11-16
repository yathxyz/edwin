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
