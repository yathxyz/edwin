// The shell commands (src/compile.ts, its last part; the ! operator in src/evil-ex.ts): M-! with its output in the
// echo area or *Shell Command Output* and C-u M-! inserting it, M-& streaming into *Async Shell Command*, M-| with
// the region on standard input and C-u M-| replacing it, :! and :{range}!, and the ! operator. A filter replaces
// the text only when its command exits 0. C-g kills a command waited for; nothing starts while the image replays,
// in a web frame or with no host.proc. Headless Edwin on the Node host, with the desktop program's host.proc stood
// in by fake-proc.mts (sh, sort, printf, sleep from PATH). One Edwin per process, so the cases run in order.
// Run: node --test test/shell-command.test.mts
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-shell-'));
host.files = { cwd: root, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(root, p) };
after(() => { for (const id of proc.running()) proc.kill(id, 'KILL'); fs.rmSync(root, { recursive: true, force: true }); });

const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 10)); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isProcErr = (e: unknown) => L.S.conditionIs(e, 'process-error');
const lastCall = () => proc.calls[proc.calls.length - 1];
const output = () => Ed.getBuffer('*Shell Command Output*');
/* A fresh buffer holding TEXT, alone in the frame, point at its start, in Normal state. */
const fresh = (text: string) => {
  Ed.deleteOtherWindows();
  const old = Ed.getBuffer('*shell-scratch*');
  if (old) L.call('kill-buffer', [old]);
  const b = Ed.getBufferCreate('*shell-scratch*');
  Ed.setWindowBuffer(b);
  b.text = text; b.pt = 0; b.mark = null; b.modified = false; b.undo = []; b.redo = [];
  return b;
};
/* Wait for the command the keys started to end: the command loop is idle again with no child left. */
const settled = async () => { await until(() => proc.running().length === 0 && E.running === 0, 'the command to end'); await Ed.whenIdle(); };

test('C-u M-| replaces the region with sort\'s output, as one undo step; M-! is reached from Normal state', async () => {
  const b = fresh('pear\napple\nfig\n');
  L.evalText("(evil-emacs-state)");
  b.mark = 0; b.pt = b.rope.length;
  await keys('C-u M-|'); await type('sort\n'); await settled();
  assert.equal(b.text, 'apple\nfig\npear\n');
  const call = lastCall();
  assert.deepEqual(call.argv, ['sh', '-c', 'sort'], 'a shell line, run by sh; the region on its standard input');
  assert.equal(call.opts.cwd, root, 'a buffer with no file: the program\'s directory');
  assert.equal(call.opts.merge, false, 'the error is kept out of the text');
  assert.equal(call.opts.lossy, false);
  assert.equal(call.opts.env!.TERM, 'dumb');
  assert.equal(b.pt, 0); assert.equal(b.mark, b.rope.length);
  await keys('C-/');
  assert.equal(b.text, 'pear\napple\nfig\n', 'one undo step brings the text back');
  /* Without the prefix the output is shown and the text stays. */
  b.mark = 0; b.pt = b.rope.length;
  await keys('M-|'); await type('sort | head -1\n'); await settled();
  assert.equal(b.text, 'pear\napple\nfig\n');
  assert.equal(E.echo, 'apple'); assert.equal(output().text, 'apple\n');
  /* From Normal state M-! is the global key. */
  fresh('x\n');
  assert.equal(L.evalText('(evil-normal-state-p)'), true);
  await keys('M-!'); await type('echo from normal\n'); await settled();
  assert.equal(E.echo, 'from normal');
});

test('a failing filter, a cut or non-UTF-8 output, a buffer changed meanwhile: the text is left as it was', async () => {
  const b = fresh('b\na\n');
  for (const [cmd, why] of [['sort; exit 3', /exited abnormally with code 3; the text is left as it was/], ['printf "\\377"', /not UTF-8.*left as it was/], ['kill -TERM $$', /terminated; the text is left as it was/], ['head -c 17000000 /dev/zero', /passed 16 MiB; the text is left as it was/]] as [string, RegExp][]) {
    const replaced = await L.evalText(`(shell-command-on-region 1 5 ${JSON.stringify(cmd)} #t)`);
    assert.equal(replaced, false, cmd);
    assert.equal(b.text, 'b\na\n', cmd); assert.equal(b.modified, false, cmd);
    assert.match(E.echo, why);
    if (cmd.startsWith('sort')) assert.equal(output().text, 'a\nb\n', 'what the failing sort printed is in *Shell Command Output*');
  }
  /* :%! with a failing command, through the ex line. */
  await keys(':'); await type('%!sort; echo broke >&2; exit 1\n'); await settled();
  assert.equal(b.text, 'b\na\n');
  assert.match(E.echo, /exited abnormally with code 1/);
  /* A command that succeeds but writes to its error: the error is shown, not put in the text. */
  await keys(':'); await type('%!sort; echo careful >&2\n'); await settled();
  assert.equal(b.text, 'a\nb\n'); assert.equal(E.echo, 'careful');
  /* The buffer changes while the command runs (a timer's edit): nothing is replaced. */
  b.text = 'b\na\n'; b.modified = false;
  const run = L.evalText('(shell-command-on-region 1 5 "sleep 0.3; sort" #t)') as Promise<unknown>;
  await sleep(100);
  Ed.runCallback(() => { b.pt = b.rope.length; Ed.insertText(b, 'c\n'); });
  assert.equal(await run, false);
  assert.equal(b.text, 'b\na\nc\n');
  assert.match(E.echo, /The buffer changed while the command ran/);
  /* A read-only buffer: refused before anything runs. */
  b.readOnly = true;
  const n = proc.calls.length;
  await assert.rejects(L.evalText('(shell-command-on-region 1 5 "sort" #t)') as Promise<unknown>, (e: unknown) => L.S.conditionIs(e, 'buffer-read-only'));
  await keys(':'); await type('%!sort\n'); await settled();
  assert.equal(proc.calls.length, n, 'nothing spawned'); assert.equal(b.text, 'b\na\nc\n');
  b.readOnly = false;
  /* A failing filter in *Shell Command Output* itself: its text stays too. */
  const o = output();
  Ed.setWindowBuffer(o); o.text = 'keep\n';
  await keys(':'); await type('%!echo gone; exit 1\n'); await settled();
  assert.equal(o.text, 'keep\n'); assert.match(E.echo, /code 1; the text is left as it was/);
});

test(':{range}!, the ! operator and ! in Visual state filter whole lines', async () => {
  const b = fresh('3\n1\n2\nz\ny\n');
  await keys(':'); await type('1,3!sort\n'); await settled();
  assert.equal(b.text, '1\n2\n3\nz\ny\n');
  assert.deepEqual(lastCall().argv, ['sh', '-c', 'sort']);
  /* !j reads the ex line .,.+1! and the command after it. */
  b.pt = Ed.lineStartOf(b.rope, 4);
  await keys('! j');
  assert.equal(E.minibuf.text, '.,.+1!');
  await type('sort\n'); await settled();
  assert.equal(b.text, '1\n2\n3\ny\nz\n');
  assert.equal(b.pt, Ed.lineStartOf(b.rope, 4), 'point at the first line filtered');
  /* !! on one line, with a count: 2!! filters two lines. */
  b.pt = 0;
  await keys('2 ! !'); await type('tac\n'); await settled();
  assert.equal(b.text, '2\n1\n3\ny\nz\n');
  /* Visual: V j ! gives '<,'>!. */
  b.pt = Ed.lineStartOf(b.rope, 3);
  await keys('V j !');
  assert.equal(E.minibuf.text, "'<,'>!");
  await type('sort -r\n'); await settled();
  assert.equal(b.text, '2\n1\ny\n3\nz\n');
  /* The last line without a newline stays without one. */
  const c = fresh('b\na');
  await keys(':'); await type('%!sort\n'); await settled();
  assert.equal(c.text, 'a\nb');
  /* A shell line whose first character an ex name could take: all of it after the ! is the command. */
  await keys(':'); await type('!~/no-such-program\n'); await settled();
  assert.deepEqual(lastCall().argv, ['sh', '-c', 'exec </dev/null\n~/no-such-program']);
  assert.match(E.echo, /exited abnormally with code 127/);
});

test('M-! shows one line in the echo area and more in *Shell Command Output*; C-u M-! inserts it at point', async () => {
  const b = fresh('one\n');
  await keys('M-!'); await type('echo hi\n'); await settled();
  assert.equal(E.echo, 'hi');
  const call = lastCall();
  assert.deepEqual(call.argv, ['sh', '-c', 'exec </dev/null\necho hi'], 'standard input is /dev/null');
  assert.equal(call.opts.merge, true); assert.equal(call.opts.lossy, true);
  assert.equal(Ed.windowList().length, 1, 'one line: no window for it');
  await keys('M-!'); await type('printf "a\\nb\\n"; echo c >&2; exit 4\n'); await settled();
  assert.equal(output().text, 'a\nb\nc\n', 'the error merged in');
  assert.ok(Ed.windowList().some((w: { buffer: unknown }) => w.buffer === output()), 'more lines: shown in another window');
  assert.equal(E.current, b, 'not selected');
  assert.equal(E.echo, 'Shell command exited abnormally with code 4');
  await keys('M-!'); await type('true\n'); await settled();
  assert.equal(E.echo, '(Shell command succeeded with no output)');
  await keys('M-!'); await type('exit 2\n'); await settled();
  assert.equal(E.echo, '(Shell command exited abnormally with code 2, with no output)');
  /* Colours are dropped from what is shown. */
  await L.evalText('(shell-command "printf \\"\\\\033[31mred\\\\033[0m\\\\n\\"")');
  assert.equal(E.echo, 'red');
  /* C-u M-! (from Emacs state, where C-u is the prefix): the output at point, point before it. */
  Ed.deleteOtherWindows();
  L.evalText("(evil-emacs-state)");
  b.pt = 0;
  await keys('C-u M-!'); await type('echo inserted\n'); await settled();
  assert.equal(b.text, 'inserted\none\n'); assert.equal(b.pt, 0); assert.equal(b.mark, 9);
  /* …only when it exits 0. */
  await keys('C-u M-!'); await type('echo no; exit 1\n'); await settled();
  assert.equal(b.text, 'inserted\none\n');
  /* From Scheme, and :! with no range: shown, not inserted. */
  await L.evalText('(shell-command "echo scheme")');
  assert.equal(E.echo, 'scheme');
  L.evalText('(evil-normal-state)');
  await keys(':'); await type('!echo ex\n'); await settled();
  assert.equal(E.echo, 'ex'); assert.equal(b.text, 'inserted\none\n');
});

test('C-g stops a command waited for and kills its child', async () => {
  fresh('x\n');
  await keys('M-!'); await type('sleep 30');
  Ed.feedKey('RET');   /* not waited for: the loop is not idle again until the command ends */
  await until(() => proc.running().length === 1, 'the child');
  const id = proc.running()[0];
  Ed.feedKey('C-g');
  await until(() => !proc.running().includes(id), 'the child gone');
  await until(() => E.running === 0, 'the command over');
  assert.equal(E.echo, 'Quit');
  /* The frame takes keys again. */
  await keys('M-!'); await type('echo after\n'); await settled();
  assert.equal(E.echo, 'after');
});

test('M-& streams into *Async Shell Command*, leaving compile\'s error list and command alone; a trailing & in M-! does the same', async () => {
  fresh('x\n');
  L.evalText('(set! compile-command "make -k ")');
  const errorsBefore = L.evalText('next-error--errors');
  await keys('M-&'); await type('echo first; sleep 0.4; echo second\n');
  const a = () => Ed.getBuffer('*Async Shell Command*');
  await until(() => a() && a().text.includes('first\n'), 'the first line');
  assert.ok(!a().text.includes('second'), 'shown as it comes');
  assert.equal(a().mode, 'async-shell-command-mode'); assert.equal(a().readOnly, true);
  assert.equal(E.current.name, '*shell-scratch*', 'not selected');
  await until(() => /\n\nShell command finished at /.test(a().text), 'the status line');
  assert.match(a().text, /^first\nsecond\n\nShell command finished at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d, duration \d+\.\d\d s\n$/, 'no header');
  assert.deepEqual(lastCall().argv, ['sh', '-c', 'exec </dev/null\necho first; sleep 0.4; echo second']);
  assert.equal(L.get('compile-command'), 'make -k ');
  assert.equal(L.evalText('next-error--errors'), errorsBefore);
  /* M-! with a trailing &. */
  await keys('M-!'); await type('echo bg &\n');
  await until(() => /^bg\n\nShell command finished/.test(a().text), 'the async run');
  /* C-c C-k in the buffer interrupts it; killing the buffer kills its child. */
  await L.evalText('(async-shell-command "sleep 30")');
  Ed.selectWindow(Ed.windowList().find((w: { buffer: unknown }) => w.buffer === a()));
  await keys('C-c C-k');
  await until(() => /Shell command interrupted/.test(a().text), 'interrupted');
  await L.evalText('(async-shell-command "sleep 30")');
  await until(() => proc.running().length === 1, 'the child');
  L.call('kill-buffer', [a()]);
  await until(() => proc.running().length === 0, 'no child left');
});

test('R16.15: no shell command starts while the image replays', async () => {
  const b = fresh('b\na\n');
  const n = proc.calls.length;
  /* Each entry, as a replayed form calls it: refused with process-error. */
  for (const form of ['(shell-command "echo r")', '(shell-command "echo r" #t)', '(shell-command "echo r &")', '(async-shell-command "echo r")',
    '(shell-command-on-region 1 5 "sort")', '(shell-command-on-region 1 5 "sort" #t)', '(evil-ex-shell-command 1 2 "sort")', '(evil-ex-shell-command #f #f "echo r")']) {
    let r: unknown;
    try { r = Ed.proc.replay(() => L.evalText(form)); } catch (e) { r = Promise.reject(e); }
    await assert.rejects(r as Promise<unknown>, (e: unknown) => isProcErr(e) && /while the image replays/.test(Ed.errorText(e)), form);
  }
  /* An ex line run by a replayed form (evil-ex-execute reports its error rather than raising it). */
  E.echo = '';
  Ed.proc.replay(() => L.evalText('(evil-ex-execute "%!sort")'));
  await until(() => /No process here/.test(E.echo), 'the refusal');
  await sleep(50);
  assert.equal(proc.calls.length, n, 'nothing spawned');
  assert.equal(b.text, 'b\na\n');
});

test('no shell command in a web frame or where the host gives no processes; the command is not even read', async () => {
  const b = fresh('b\na\n');
  const n = proc.calls.length;
  const check = async () => {
    for (const k of ['M-!', 'M-&', 'M-|', '!']) {
      if (k === 'M-|') { b.mark = 0; b.pt = 2; }
      await keys(k);
      assert.match(E.echo, /No process here/, k); assert.equal(E.current, b, `${k}: no minibuffer`);
      await keys('ESC');
    }
    await keys(':'); await type('%!sort\n');
    assert.match(E.echo, /No process here/);
  };
  Ed.host.kind = 'browser';
  try { await check(); } finally { Ed.host.kind = 'node'; }
  delete host.proc;
  try { await check(); } finally { host.proc = proc; }
  assert.equal(proc.calls.length, n); assert.equal(b.text, 'b\na\n');
});
