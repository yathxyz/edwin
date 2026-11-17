// format-buffer (src/format.ts) and define-formatter (scm/prog.scm): the buffer's mode's formatter run with the
// buffer's text on its standard input, its output applied as a line diff. Real formatters from PATH (alejandra,
// black, shfmt; the check puts them there), and sh for formatters that fail, hang or print garbage. Nothing
// changes when the formatter fails; nothing starts while the image replays, in a web frame or with no host.proc.
// Headless Edwin on the Node host, with the desktop program's host.proc stood in by fake-proc.mts. One Edwin per
// process, so the cases run in order.
// Run: node --test test/format.test.mts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { fakeProc } from './fake-proc.mts';
import type { FakeProc } from './fake-proc.mts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-format-')));
/* A stand-in direnv, first on PATH: in a directory under an .envrc it exports a PATH with bin/ of that directory
   first, where a formatter only direnv's environment has lives. */
const fakeBin = path.join(root, 'fake-bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'direnv'), `#!/bin/sh\nprintf '{"PATH":"%s/bin:%s","FMT_FROM_DIRENV":"yes"}' "$PWD" "$PATH"\n`, { mode: 0o755 });
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const proc = fakeProc();
const host = createHost({ workers: false }) as NodeHost & { proc?: FakeProc; files?: unknown };
host.proc = proc;
const Ed: Edwin = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const L: Edwin = (globalThis as unknown as { L: Edwin }).L, E: Edwin = Ed.E;
L.evalText('(set! corfu-auto #f)');
host.files = {
  cwd: root, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(root, p),
  stamp: (p: string) => { try { const s = fs.statSync(p); return s.isFile() ? `${s.ino}:${s.mtimeMs}:${s.size}` : null; } catch { return null; } },
};
after(() => { for (const id of proc.running()) proc.kill(id, 'KILL'); fs.rmSync(root, { recursive: true, force: true }); });

const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await Ed.whenIdle(); };
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 10)); } };
const settled = async () => { await until(() => proc.running().length === 0 && E.running === 0, 'the command to end'); await Ed.whenIdle(); };
const lastCall = () => proc.calls[proc.calls.length - 1];
/* SPC b f, waited for. */
const format = async () => { await keys('SPC b f'); await settled(); };

/* A buffer visiting FILE (under root) in MODE, holding TEXT, alone in the frame, unmodified, in Normal state. */
let n = 0;
function visit(file: string | null, mode: string, text: string) {
  Ed.deleteOtherWindows();
  const b = Ed.getBufferCreate(`*format-${++n}*`);
  Ed.setWindowBuffer(b);
  if (file) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); b.file = path.join(root, file); }
  L.call(mode, []);
  b.text = text; b.pt = 0; b.mark = null; b.modified = false; b.undo = []; b.redo = [];
  L.evalText('(evil-normal-state)');
  return b;
}
/* Line and column (from 0) of position P in B. */
const lineCol = (b: { text: string }, p: number) => { const before = b.text.slice(0, p).split('\n'); return [before.length - 1, before[before.length - 1].length]; };
const posOf = (b: { text: string }, line: number, col: number) => b.text.split('\n').slice(0, line).reduce((a, l) => a + l.length + 1, 0) + col;
/* What PROGRAM prints for INPUT, run directly. */
const direct = (argv: string[], input: string, cwd = root) => execFileSync(argv[0], argv.slice(1), { input, cwd, encoding: 'utf8' });

L.evalText('(define-derived-mode fmt-test-mode prog-mode "FmtTest" #f)');

test('alejandra formats a Nix buffer: its output in place, point and the mark on their lines, one undo step, modified', async () => {
  const src = '{ pkgs, ... }:\n{\n  keep = "this line";\n  a=1;b=  2;\n  also = "kept";\n}\n';
  const b = visit('nix/default.nix', 'nix-mode', src);
  b.pt = posOf(b, 2, 9); b.mark = posOf(b, 4, 3);
  await format();
  const want = direct(['alejandra', '--quiet', '-'], src);
  assert.notEqual(want, src, 'the fixture is not formatted already');
  assert.equal(b.text, want);
  assert.deepEqual(lastCall().argv, ['alejandra', '--quiet', '-']);
  assert.equal(lastCall().opts.cwd, path.join(root, 'nix'), "run in the file's directory");
  assert.equal(lastCall().opts.lossy, false);
  /* The first two lines become one, so the kept line is now the second. */
  assert.deepEqual(lineCol(b, b.pt), [1, 9], 'point stays on its unchanged line, at its column');
  assert.equal(b.text.split('\n')[1], '  keep = "this line";');
  assert.equal(b.text.split('\n')[lineCol(b, b.mark!)[0]], '  also = "kept";', 'the mark stays with its line');
  assert.equal(b.modified, true);
  assert.match(E.echo, /^Formatted \*format-\d+\* with alejandra$/);
  await keys('u');
  assert.equal(b.text, src, 'one undo brings the text back');
  await keys('C-r');
  assert.equal(b.text, want);
  /* Formatted text again: nothing changes. */
  b.modified = false;
  const undo = b.undo.length;
  await format();
  assert.equal(b.text, want); assert.equal(b.modified, false); assert.equal(b.undo.length, undo);
  assert.match(E.echo, /is formatted already \(alejandra\)/);
});

test("past the line diff's budget (1000 changed lines) point, the mark and the other windows' points keep their line and column, clamped", async () => {
  /* Every other line of 2000 changed: past MAX_D, so the diff is one replacement of nearly all the text. */
  const src = Array.from({ length: 2000 }, (_, i) => `${i % 2 ? 'odd' : 'even'} ${i}`).join('\n') + '\n';
  L.evalText(`(define-formatter 'fmt-test-mode '("sed" "s/^odd/ODD/"))`);
  const b = visit('t/big.txt', 'fmt-test-mode', src);
  b.pt = posOf(b, 400, 3); b.mark = posOf(b, 1000, 2);
  const after = b.marker(posOf(b, 1500, 4), 'after');
  Ed.splitWindow(E.sel, 'below');
  const other = Ed.allWindows().find((w: { buffer: unknown }) => w.buffer === b && w !== E.sel);
  assert.ok(other, 'a second window on the buffer');
  other.pt = posOf(b, 1201, 5);
  await format();
  assert.equal(b.text, src.replace(/^odd/gm, 'ODD'));
  assert.deepEqual(lineCol(b, b.pt), [400, 3], 'point');
  assert.deepEqual(lineCol(b, b.mark!), [1000, 2], 'the mark');
  assert.deepEqual(lineCol(b, after.pos), [1500, 4], 'a marker');
  assert.deepEqual(lineCol(b, other.pt), [1201, 5], "the other window's point");
  after.release();
  await keys('u');
  assert.equal(b.text, src, 'one undo brings the text back');
  /* Lines made shorter than the column: it is clamped to the line's end. */
  L.evalText(`(define-formatter 'fmt-test-mode '("sed" "s/^even [0-9]*$/e/"))`);
  const c = visit('t/big2.txt', 'fmt-test-mode', src);
  c.pt = posOf(c, 400, 6); c.mark = posOf(c, 401, 2);
  await format();
  assert.equal(c.text, src.replace(/^even \d+$/gm, 'e'));
  assert.deepEqual(lineCol(c, c.pt), [400, 0], "point on its shorter line's last character (Normal state)");
  assert.deepEqual(lineCol(c, c.mark!), [401, 2], 'the mark on an unchanged line');
});

test("a file whose directory does not exist yet is refused, naming the directory, with nothing spawned", async () => {
  L.evalText(`(define-formatter 'fmt-test-mode '("tr" "a-z" "A-Z"))`);
  const b = visit(null, 'fmt-test-mode', 'abc\n');
  b.file = path.join(root, 'no-such-dir', 'new.txt');
  const calls = proc.calls.length;
  await format();
  assert.equal(b.text, 'abc\n'); assert.equal(b.modified, false);
  assert.equal(E.echo, `tr runs in ${path.join(root, 'no-such-dir')}, which does not exist yet; create it first`);
  assert.equal(proc.calls.length, calls, 'nothing spawned');
});

test("black formats Python; shfmt gets the file's absolute name and reads the directory's .editorconfig", async () => {
  const py = 'x = ( 1,2 )\ndef f( a ):\n  return a\n';
  const b = visit('py/m.py', 'python-mode', py);
  await format();
  assert.equal(b.text, direct(['black', '--quiet', '-'], py));
  assert.equal(b.text, 'x = (1, 2)\n\n\ndef f(a):\n    return a\n');
  assert.deepEqual(lastCall().argv, ['black', '--quiet', '-']);
  fs.mkdirSync(path.join(root, 'sh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sh', '.editorconfig'), 'root = true\n[*]\nindent_style = space\nindent_size = 3\n');
  /* A name that starts with - and holds a space stays one argument, and an absolute one. */
  const s = visit('sh/-odd name.sh', 'sh-mode', 'if true; then\necho  x\nfi\n');
  await format();
  assert.deepEqual(lastCall().argv, ['shfmt', '--filename', path.join(root, 'sh', '-odd name.sh')]);
  assert.equal(s.text, 'if true; then\n   echo x\nfi\n', "the .editorconfig's indent_size = 3");
});

test('a failing formatter leaves text, point, the mark, undo and the modified flag as they were', async () => {
  /* alejandra prints its input back on its standard output when it fails, then exits 1. */
  const src = '{\n  a = 1;\n  b =\n';
  const b = visit('nix/broken.nix', 'nix-mode', src);
  b.pt = 5; b.mark = 2;
  const check = (what: string) => {
    assert.equal(b.text, src, what); assert.equal(b.pt, 5, what); assert.equal(b.mark, 2, what);
    assert.equal(b.modified, false, what); assert.equal(b.undo.length, 0, what);
  };
  await format();
  check('alejandra');
  assert.match(E.echo, /^alejandra exited with code 1: Failed! .*; the buffer is left as it was$/);
  assert.match(Ed.getBuffer('*Format Output*').text, /unexpected end of file/, 'its whole error is kept');
  /* Formatters that fail in the other ways, as sh. */
  const cases: [string, RegExp][] = [
    ['printf "half"; echo bad >&2; exit 2', /^sh exited with code 2: bad; the buffer is left as it was$/],
    ['cat >/dev/null', /^sh printed nothing; the buffer is left as it was$/],
    ['printf "\\377"', /^sh stopped: .*; the buffer is left as it was$/],
    ['kill -TERM $$', /^sh was killed by (SIG)?TERM; the buffer is left as it was$/],
    ['head -c 17000000 /dev/zero', /^sh printed more than 16 MiB; the buffer is left as it was$/],
  ];
  for (const [line, why] of cases) {
    L.evalText(`(define-formatter 'fmt-test-mode '("sh" "-c" ${JSON.stringify(line)}))`);
    const t = visit('t/x.txt', 'fmt-test-mode', src);
    t.pt = 5; t.mark = 2;
    await format();
    assert.equal(t.text, src, line); assert.equal(t.pt, 5, line); assert.equal(t.mark, 2, line);
    assert.equal(t.modified, false, line); assert.equal(t.undo.length, 0, line);
    assert.match(E.echo, why, line);
  }
  /* A program not on PATH. */
  L.evalText(`(define-formatter 'fmt-test-mode '("edwin-no-such-formatter"))`);
  const t = visit('t/x.txt', 'fmt-test-mode', src);
  await format();
  assert.equal(t.text, src); assert.equal(t.modified, false);
  assert.match(E.echo, /cannot run edwin-no-such-formatter/);
});

test('a buffer changed while its formatter ran, or killed, is left alone', async () => {
  L.evalText(`(define-formatter 'fmt-test-mode '("sh" "-c" "sleep 0.3; tr a-z A-Z"))`);
  const b = visit('t/y.txt', 'fmt-test-mode', 'abc\n');
  await keys('SPC b'); Ed.feedKey('f');
  await until(() => proc.running().length === 1, 'the formatter');
  Ed.replaceText(b, 0, 0, 'z');   /* as an edit from elsewhere would */
  await settled();
  assert.equal(b.text, 'zabc\n');
  assert.match(E.echo, /changed while sh ran; the buffer is left as it was/);
  const k = visit('t/z.txt', 'fmt-test-mode', 'abc\n');
  await keys('SPC b'); Ed.feedKey('f');
  await until(() => proc.running().length === 1, 'the formatter');
  L.call('kill-buffer', [k]);
  await settled();
  assert.match(E.echo, /was killed while sh ran/);
});

test('C-g kills a formatter that hangs and leaves the text; the frame takes keys again', async () => {
  L.evalText(`(define-formatter 'fmt-test-mode '("sh" "-c" "sleep 30"))`);
  const b = visit('t/w.txt', 'fmt-test-mode', 'abc\n');
  await keys('SPC b');
  Ed.feedKey('f');   /* not waited for: the loop is idle again only once the command ends */
  await until(() => proc.running().length === 1, 'the formatter');
  const id = proc.running()[0];
  Ed.feedKey('C-g');
  await until(() => !proc.running().includes(id), 'the formatter gone');
  await until(() => E.running === 0, 'the command over');
  assert.equal(E.echo, 'Quit');
  assert.equal(b.text, 'abc\n'); assert.equal(b.modified, false);
  L.evalText(`(define-formatter 'fmt-test-mode '("tr" "a-z" "A-Z"))`);
  await format();
  assert.equal(b.text, 'ABC\n');
});

test("the formatter runs in the directory's direnv environment: one only on direnv's PATH is found", async () => {
  const dir = path.join(root, 'envrc');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.envrc'), 'PATH_add bin\n');
  fs.writeFileSync(path.join(dir, 'bin', 'fmt-from-direnv'), '#!/bin/sh\nprintf "%s\\n" "$FMT_FROM_DIRENV"; cat\n', { mode: 0o755 });
  L.evalText(`(define-formatter 'fmt-test-mode '("fmt-from-direnv"))`);
  const b = visit('envrc/sub.txt', 'fmt-test-mode', 'body\n');
  await format();
  assert.equal(b.text, 'yes\nbody\n');
  assert.equal(lastCall().opts.env!.FMT_FROM_DIRENV, 'yes');
  /* Outside it the program is not found. */
  const c = visit('t/v.txt', 'fmt-test-mode', 'body\n');
  await format();
  assert.equal(c.text, 'body\n');
  assert.match(E.echo, /cannot run fmt-from-direnv/);
});

test('refused before anything runs: no formatter for the mode, a read-only buffer, a file name the buffer has not', async () => {
  const calls = proc.calls.length;
  visit('t/u.txt', 'text-mode', 'x\n');
  await format();
  assert.match(E.echo, /No formatter for text-mode/);
  const r = visit('nix/ro.nix', 'nix-mode', '{a=1;}\n');
  r.readOnly = true;
  await format();
  assert.equal(r.text, '{a=1;}\n');
  assert.match(E.echo, /read-only/i);
  visit(null, 'sh-mode', 'echo  x\n');
  await format();
  assert.match(E.echo, /shfmt needs the buffer's file name/);
  assert.equal(proc.calls.length, calls, 'nothing spawned');
  /* The declaration's own checks. */
  for (const bad of [`'fmt-test-mode '()`, `'fmt-test-mode '(1)`, `'fmt-test-mode '(file)`, `"x" '("cat")`, `'() '("cat")`])
    assert.throws(() => L.evalText(`(define-formatter ${bad})`), /define-formatter/, bad);
  /* #f takes the formatter away. */
  L.evalText(`(define-formatter 'fmt-test-mode #f)`);
  visit('t/u.txt', 'fmt-test-mode', 'x\n');
  await format();
  assert.match(E.echo, /No formatter for fmt-test-mode/);
});

test('R16.15: a declaration while the image replays is skipped, and format-buffer starts nothing; nor in a web frame or with no host.proc', async () => {
  L.evalText(`(define-formatter 'fmt-test-mode '("tr" "a-z" "A-Z"))`);
  Ed.proc.replay(() => L.evalText(`(define-formatter 'fmt-test-mode '("sh" "-c" "echo replayed"))`));
  assert.match(E.echo, /define-formatter: fmt-test-mode is not declared while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  const b = visit('t/s.txt', 'fmt-test-mode', 'abc\n');
  await format();
  assert.equal(b.text, 'ABC\n', 'the declaration made outside the replay stands');
  assert.deepEqual(lastCall().argv, ['tr', 'a-z', 'A-Z']);
  const c = visit('t/s2.txt', 'fmt-test-mode', 'abc\n');
  const calls = proc.calls.length;
  let r: unknown;
  try { r = Ed.proc.replay(() => L.evalText('(format-buffer)')); } catch (e) { r = e; }
  if (r instanceof Promise) await r.catch(() => {});
  await new Promise(r => setTimeout(r, 20));
  Ed.host.kind = 'browser';
  try { await format(); assert.match(E.echo, /No processes in a web frame/); } finally { Ed.host.kind = 'node'; }
  delete host.proc;
  try { await format(); assert.match(E.echo, /No processes here/); } finally { host.proc = proc; }
  assert.equal(proc.calls.length, calls, 'nothing spawned');
  assert.equal(c.text, 'abc\n'); assert.equal(c.modified, false);
});

test('SPC b f is format-buffer, and the desktop-only stub is gone', () => {
  assert.equal(L.evalText('(symbol->string (lookup-key evil-normal-state-map "SPC b f"))'), 'format-buffer');
  assert.equal(L.evalText("(bound? 'apheleia-format-buffer)"), false);
});
