// The server table and the servers' settings (scm/lsp.scm, src/lsp.ts) in the headless runtime: the servers the
// shipped table declares, settings given as JSON or worked out per root, answered by section to
// workspace/configuration and sent in workspace/didChangeConfiguration, the settings' refusals; against a stand-in
// server that is a real child through Ed.proc (fake-proc.mts). Then the table's own servers, found on PATH as the
// table names them, with nothing declared by the suite: nixd (a definition and an undefined name), pyright (the
// same) and harper-ls (a misspelling in a Markdown file). EDWIN_LSP_SERVERS=1 (the check sets it, with the three
// on PATH) makes those run; without it they are skipped.
import { test, after, beforeEach } from 'node:test';
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
L.evalText('(set! corfu-auto #f)');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-lsp-servers-')));
host.files = {
  cwd: tmp, exists: (p: string) => fs.existsSync(p), resolve: (p: string) => path.resolve(tmp, p),
  read: (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
  write: (p: string, v: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); },
  remove: (p: string) => { fs.rmSync(p, { force: true }); },
  list: () => [] as string[], truename: (p: string) => p, label: (p: string) => p, temp: [] as string[],
};
L.evalText(`(define-language fake-mode "Fake" :files '("\\\\.fake$"))`);
/* The table as the shipped scm/lsp.scm left it, before any test declares a server. */
const SHIPPED = Ed.lsp.servers().map((s: { name: string; modes: string[]; argv: string[]; settings: unknown }) => ({ ...s }));
after(async () => {
  await Ed.lsp.shutdownAll();
  for (const id of proc.running()) proc.kill(id, 'KILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DEFAULTS = { ...Ed.lsp.timing };
beforeEach(async () => {
  if (E.mini) await keys('C-g');
  await keys('ESC');
  await Ed.lsp.shutdownAll();
  for (const b of E.buffers.slice()) if (b.file) { b.modified = false; L.call('kill-buffer', [b]); }
  Object.assign(Ed.lsp.timing, DEFAULTS);
  await until(() => proc.running().length === 0, 'no child left by the test before', 5000);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(10); } };
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await until(() => E.running === 0, 'the command to end'); await Ed.whenIdle(); };
const isErr = (kind: string) => (e: unknown) => L.S.conditionIs(e, kind);

/* The stand-in: node SCRIPT LOG ITEMS. Once initialized it asks workspace/configuration for ITEMS (JSON). Each
   message it gets is logged as "METHOD PARAMS" (an answer as "answer RESULT"). */
const FAKE = `
const fs = require('fs');
const [log, items] = process.argv.slice(2);
const note = s => fs.appendFileSync(log, s + '\\n');
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
let buf = Buffer.alloc(0);
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1]);
    if (buf.length < end + 4 + n) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + n).toString('utf8'));
    buf = buf.subarray(end + 4 + n);
    note(m.method ? m.method + ' ' + JSON.stringify(m.params === undefined ? null : m.params) : 'answer ' + JSON.stringify(m.result));
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } });
    else if (m.method === 'initialized') send({ jsonrpc: '2.0', id: 'c1', method: 'workspace/configuration', params: { items: JSON.parse(items) } });
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(1));
`;
const script = path.join(tmp, 'fake-server.cjs');
fs.writeFileSync(script, FAKE);
let logs = 0;
/* A fresh log, and the stand-in declared for fake-mode with SETTINGS (Scheme text, none when null), asking for
   ITEMS once initialized. */
function fake(settings: string | null, items: unknown[] = [{ section: 'fake' }]) {
  const log = path.join(tmp, `log-${++logs}`);
  fs.writeFileSync(log, '');
  L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command (list ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(log)} ${JSON.stringify(JSON.stringify(items))})${settings === null ? '' : ` :settings ${settings}`})`);
  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { const i = l.indexOf(' '); return { method: l.slice(0, i), params: JSON.parse(l.slice(i + 1)) }; });
  return { log, lines };
}
/* A project directory holding FILES (name to text); their paths, and the directory as dir. Its repository marker
   is REPO: a .git directory by default, '.git-file' a worktree's .git file, '.jj' a jj-only repository, null none. */
function project(name: string, files: Record<string, string>, repo: '.git' | '.git-file' | '.jj' | null = '.git'): Record<string, string> {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (repo === '.git-file') fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nowhere/.git/worktrees/x\n');
  else if (repo) fs.mkdirSync(path.join(dir, repo), { recursive: true });
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) { const p = path.join(dir, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); out[f] = p; }
  return { dir, ...out };
}
type Buf = { text: string; file: string | null; mode: string; pt: number; name: string; modified: boolean };
/* P visited in the selected window, its server ready. */
async function open(p: string): Promise<Buf> {
  await keys('ESC');
  const b = L.call('find-file', [p]) as Buf;
  const s = Ed.lsp.sessionOf(b);
  assert.ok(s, `${E.echo} | ${messages().slice(-400)}`);
  await Ed.lsp.ready(s);
  return b;
}
const messages = () => (E.buffers.find((b: { name: string }) => b.name === '*Messages*') || { text: '' }).text as string;

test('the table: the servers of the owner\'s languages, their modes and their argv, each found on PATH', () => {
  assert.deepEqual(SHIPPED.map((s: { name: string; modes: string[]; argv: string[] }) => [s.name, s.modes, s.argv]), [
    ['nixd', ['nix-mode'], ['nixd']],
    ['rust-analyzer', ['rust-mode'], ['rust-analyzer']],
    ['gopls', ['go-mode'], ['gopls']],
    ['pyright', ['python-mode'], ['pyright-langserver', '--stdio']],
    ['terraform-ls', ['terraform-mode'], ['terraform-ls', 'serve']],
    ['clangd', ['c-mode', 'c++-mode'], ['clangd']],
    ['typescript-language-server', ['typescript-mode', 'tsx-mode', 'js-mode'], ['typescript-language-server', '--stdio']],
    ['harper-ls', ['markdown-mode'], ['harper-ls', '--stdio']],
  ]);
  /* every mode the table names is one Edwin has, reached from a file name */
  const files: Record<string, string> = { 'a.nix': 'nix-mode', 'a.rs': 'rust-mode', 'a.go': 'go-mode', 'a.py': 'python-mode', 'a.tf': 'terraform-mode', 'a.c': 'c-mode', 'a.cpp': 'c++-mode', 'a.ts': 'typescript-mode', 'a.tsx': 'tsx-mode', 'a.js': 'js-mode', 'a.md': 'markdown-mode' };
  for (const [f, mode] of Object.entries(files)) assert.equal(Ed.modeFor(f), mode, f);
  for (const s of SHIPPED) assert.equal(s.name === 'nixd' ? typeof s.settings : s.settings, s.name === 'nixd' ? 'function' : null, s.name);
});

test('nixd\'s settings: ROOT\'s flake\'s nixpkgs when it has a flake.nix, else <nixpkgs>; the root a Nix string, escaped', () => {
  const nixd = SHIPPED.find((s: { name: string }) => s.name === 'nixd');
  const plain = project('plain', { 'x.nix': '1\n' });
  assert.deepEqual(nixd.settings(plain.dir), { nixd: { nixpkgs: { expr: 'import <nixpkgs> { }' } } });
  const odd = project('fl "a" $b \\c ${d}', { 'flake.nix': '{ outputs = _: { }; }\n' });
  const expr = nixd.settings(odd.dir).nixd.nixpkgs.expr;
  const esc = odd.dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
  assert.equal(expr, `import (builtins.getFlake "${esc}").inputs.nixpkgs { }`);
  assert.ok(expr.includes('fl \\"a\\" \\$b \\\\c \\${d}'), expr);
  /* a newline in a name too */
  assert.equal(L.call('lsp--nix-string', ['a\nb']), '"a\\nb"');
  /* a ? or a # in the root's name would begin a flake reference's query or fragment: <nixpkgs> there */
  for (const name of ['q?dir=x', 'h#frag']) {
    const pr = project(name, { 'flake.nix': '{ outputs = _: { }; }\n' });
    assert.deepEqual(nixd.settings(pr.dir), { nixd: { nixpkgs: { expr: 'import <nixpkgs> { }' } } }, name);
  }
});

test('nixd\'s settings: the root\'s flake only in a git repository; a .jj-only root and a plain directory get <nixpkgs>', () => {
  const nixd = SHIPPED.find((s: { name: string }) => s.name === 'nixd');
  const flake = { 'flake.nix': '{ outputs = _: { }; }\n', 'untracked.txt': 'private\n' };
  /* getFlake on a directory that is no git repository copies all of it, untracked files included, into the
     world-readable store: never from here */
  for (const [name, repo] of [['jj-only', '.jj'], ['no-repo', null]] as [string, '.jj' | null][]) {
    const pr = project(name, flake, repo);
    assert.deepEqual(nixd.settings(pr.dir), { nixd: { nixpkgs: { expr: 'import <nixpkgs> { }' } } }, name);
  }
  /* a worktree's .git is a file: a git repository still */
  const wt = project('worktree', flake, '.git-file');
  assert.equal(nixd.settings(wt.dir).nixd.nixpkgs.expr, `import (builtins.getFlake "${wt.dir}").inputs.nixpkgs { }`);
  /* file-exists?, which the guard uses, is true of a directory too */
  assert.equal(L.call('file-exists?', [path.join(wt.dir, 'flake.nix')]), true);
  assert.equal(L.call('file-exists?', [path.join(tmp, 'no-repo')]), true);
  assert.equal(L.call('file-exists?', [path.join(tmp, 'no-repo', '.git')]), false);
});

test('in an edwinclient frame the shipped table stands: edwind\'s init.scm, replayed, cannot redeclare a server', async () => {
  const nixd = () => Ed.lsp.servers().find((s: { name: string }) => s.name === 'nixd');
  const shipped = SHIPPED.find((s: { name: string }) => s.name === 'nixd');
  /* as sync.ts evaluates edwind's init.scm in a frame: a well-formed declaration, skipped with a message */
  Ed.proc.replay(() => L.evalText(`(define-language-server 'nixd :modes '(nix-mode) :command '("my-nixd") :settings '((nixd (options . #()))))`));
  assert.match(E.echo, /nixd is not declared while the image replays/);
  assert.deepEqual(nixd().argv, ['nixd']);
  assert.equal(nixd().settings, shipped.settings, 'the shipped settings procedure');
  await until(() => !Ed.proc.replaying(), 'the replay window closed');
});

test('a key given twice in a settings alist: the first one\'s value, as assq finds it', () => {
  L.evalText(`(define-language-server 'fake2 :modes '(fake2-mode) :command '("x")
    :settings '((top (a . 1) (a . 2) (n (b . 1)) (n (b . 2))) (top . 0) (__proto__ . 1) (__proto__ . 2)))`);
  const s = Ed.lsp.servers().find((x: { name: string }) => x.name === 'fake2');
  assert.equal(JSON.stringify(s.settings), '{"top":{"a":1,"n":{"b":1}},"__proto__":1}');
  /* the pattern for adding to a procedure's answer: an entry consed in front shadows the one after it */
  L.evalText(`(define-language-server 'fake2 :modes '(fake2-mode) :command '("x")
    :settings (lambda (root) (cons '(nixd (extra . #t)) (lsp--nixd-settings root))))`);
  const t = Ed.lsp.servers().find((x: { name: string }) => x.name === 'fake2');
  assert.deepEqual(t.settings(tmp), { nixd: { extra: true } });
});

test('settings given as JSON: workspace/configuration answered by section, didChangeConfiguration once initialized', async () => {
  const f = fake(`'((fake (a . 1) (b . #(1 "two" #t #f)) (c (d . "e")) (big . 9007199254740991) (list . (1 2)) (empty . #())) (other . #f) (odd (__proto__ . "p")))`,
    [{ section: 'fake' }, { section: 'fake.c' }, { section: 'fake.c.d' }, { section: 'other' }, { section: 'none' }, { section: 'fake.a.x' }, { section: 'fake.list.0' }, { section: 'fake.toString' }, { section: 'fake.__proto__' }, { section: 'odd.__proto__' }, {}, { section: '' }]);
  const pr = project('json', { 'a.fake': 'x\n' });
  const b = await open(pr['a.fake']);
  const settings = { fake: { a: 1, b: [1, 'two', true, false], c: { d: 'e' }, big: 9007199254740991, list: [1, 2], empty: [] }, other: false, odd: JSON.parse('{"__proto__":"p"}') };
  assert.deepEqual(Ed.lsp.sessionOf(b).settings, settings);
  assert.ok(JSON.stringify(Ed.lsp.sessionOf(b).settings).endsWith('"odd":{"__proto__":"p"}}'), 'a key __proto__ is a key');
  await until(() => f.lines().some(l => l.method === 'answer'), 'the answer to workspace/configuration');
  const lines = f.lines();
  assert.deepEqual(lines.map(l => l.method).slice(0, 3), ['initialize', 'initialized', 'workspace/didChangeConfiguration']);
  assert.deepEqual(lines[2].params, { settings });
  assert.deepEqual(lines.find(l => l.method === 'answer')!.params, [settings.fake, { d: 'e' }, 'e', false, null, null, null, null, null, 'p', settings, settings]);
});

test('no settings: no didChangeConfiguration, and null for every item', async () => {
  const f = fake(null, [{ section: 'fake' }, {}]);
  const pr = project('none', { 'a.fake': 'x\n' });
  const b = await open(pr['a.fake']);
  assert.equal(Ed.lsp.sessionOf(b).settings, null);
  await until(() => f.lines().some(l => l.method === 'answer'), 'the answer');
  assert.ok(!f.lines().some(l => l.method === 'workspace/didChangeConfiguration'));
  assert.deepEqual(f.lines().find(l => l.method === 'answer')!.params, [null, null]);
});

test('settings from a procedure of the root: called once a session, per root; again by eglot-reconnect; kept across a crash', async () => {
  L.evalText(`(define lsp-servers-test-calls '())
    (define (lsp-servers-test-settings root)
      (set! lsp-servers-test-calls (cons root lsp-servers-test-calls))
      (list (list 'fake (cons 'root root) (cons 'n (length lsp-servers-test-calls)))))`);
  const f = fake('lsp-servers-test-settings');
  const one = project('proc-one', { 'a.fake': 'x\n', 'b.fake': 'y\n' }), two = project('proc-two', { 'a.fake': 'x\n' });
  const a = await open(one['a.fake']);
  const s = Ed.lsp.sessionOf(a);
  assert.deepEqual(s.settings, { fake: { root: one.dir, n: 1 } });
  await open(one['b.fake']);
  const c = await open(two['a.fake']);
  assert.deepEqual(Ed.lsp.sessionOf(c).settings, { fake: { root: two.dir, n: 2 } });
  assert.deepEqual(L.arr(L.get('lsp-servers-test-calls')), [two.dir, one.dir], 'once a session: the second buffer of a root uses the first\'s');
  await until(() => f.lines().filter(l => l.method === 'answer').length === 2, 'both answers');
  assert.deepEqual(f.lines().filter(l => l.method === 'answer').map(l => l.params), [[{ root: one.dir, n: 1 }], [{ root: two.dir, n: 2 }]]);
  /* a crash: started again with the settings it had */
  Ed.lsp.timing.restartDelay = 20;
  const first = s.proc.id;
  proc.kill(first, 'KILL');
  await until(() => s.state === 'running' && s.proc && s.proc.id !== first, 'started again');
  assert.deepEqual(s.settings, { fake: { root: one.dir, n: 1 } });
  assert.equal(L.arr(L.get('lsp-servers-test-calls')).length, 2, 'not called for a start again');
  /* eglot-reconnect works them out again */
  Ed.setWindowBuffer(a);
  const fresh = await Ed.lsp.reconnect(s);
  assert.deepEqual(fresh.settings, { fake: { root: one.dir, n: 3 } });
  await Ed.lsp.ready(fresh);
});

test('settings refused: each an lsp-error at the declaration, the declaration before kept', () => {
  fake(`'((fake . 1))`);
  const before = Ed.lsp.servers().find((s: { name: string }) => s.name === 'fake');
  for (const [bad, why] of [
    [`'((fake . sym))`, /hold sym, which is no JSON/],
    /* a key given twice: the shadowed value is refused too */
    [`'((fake (a . 1) (a . sym)))`, /hold sym, which is no JSON/],
    [`'((fake (a . 1) (a . (1 . 2))))`, /hold \(1 \. 2\), an improper list, which is no JSON/],
    /* an object's keys are symbols: a string-keyed alist is a list of pairs, each an improper list */
    [`'(("a" . 1))`, /hold \("a" \. 1\), an improper list, which is no JSON \(an object's keys are symbols\)/],
    [`'((fake . #\\a))`, /which is no JSON/],
    [`'((fake . ()))`, /hold \(\), which is no JSON/],
    [`(list (cons 'fake car))`, /which is no JSON/],
    [`'(1 . 2)`, /hold \(1 \. 2\), an improper list, which is no JSON/],
    /* an improper list holding a pair is not written out: a cycle through a car would have no end to write */
    [`(let ((x (list 1))) (set-car! x x) (cons x 2))`, /hold an improper list, which is no JSON/],
    [`'((fake . 99999999999999999999))`, /past a safe integer/],
    [`'((fake . +nan.0))`, /hold \+nan\.0, which is no JSON number/],
    [`'${'('.repeat(34)}1${')'.repeat(34)}`, /nest past 32 levels/],
    /* a cycle in the cdrs: the list, an object's entries, a value inside */
    [`(let ((x (list 1 2))) (set-cdr! (cdr x) x) x)`, /hold a circular list, which is no JSON/],
    [`(let ((x (list 1))) (set-cdr! x x) x)`, /hold a circular list, which is no JSON/],
    [`(let ((x (list '(a . 1) '(b . 2) '(c . 3)))) (set-cdr! (cddr x) (cdr x)) x)`, /hold a circular list, which is no JSON/],
    [`(let ((x (list 1 2 3))) (set-cdr! (cddr x) x) (list (cons 'fake x)))`, /hold a circular list, which is no JSON/],
  ] as [string, RegExp][]) {
    assert.throws(() => L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command '("x") :settings ${bad})`), (e: unknown) => isErr('lsp-error')(e) && why.test(Ed.errorText(e)), bad);
    assert.equal(Ed.lsp.servers().find((s: { name: string }) => s.name === 'fake'), before, bad);
  }
  /* 32 levels are taken */
  L.evalText(`(define-language-server 'fake2 :modes '(fake2-mode) :command '("x") :settings '${'('.repeat(32)}1${')'.repeat(32)})`);
  /* :settings with no value */
  assert.throws(() => L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command '("x") :settings)`), isErr('lsp-error'));
  /* a circular :modes or :command is no list: refused like an empty one */
  for (const [modes, command, why] of [
    [`(let ((x (list 'fake-mode))) (set-cdr! x x) x)`, `'("x")`, /:modes needs a non-empty list/],
    [`'(fake-mode)`, `(let ((x (list "x" "y"))) (set-cdr! (cdr x) x) x)`, /:command needs a non-empty list/],
  ] as [string, string, RegExp][]) {
    assert.throws(() => L.evalText(`(define-language-server 'fake :modes ${modes} :command ${command})`), (e: unknown) => isErr('lsp-error')(e) && why.test(Ed.errorText(e)), modes + command);
    assert.equal(Ed.lsp.servers().find((s: { name: string }) => s.name === 'fake'), before);
  }
});

test('settings a procedure gets wrong: refused at the start, nothing spawned, no session kept', async () => {
  const pr = project('badproc', { 'a.fake': 'x\n' });
  for (const [settings, why] of [
    [`(lambda (root) 'sym)`, /lsp-error.*the settings of fake hold sym/],
    [`(lambda (root) (car '()))`, /eglot: .*car/],
    [`(lambda (root) (let ((x (list 1 2))) (set-cdr! (cdr x) x) x))`, /lsp-error.*the settings of fake hold a circular list/],
  ] as [string, RegExp][]) {
    fake(settings);
    const calls = proc.calls.length;
    await keys('ESC');
    const b = L.call('find-file', [pr['a.fake']]) as Buf;
    assert.equal(proc.calls.length, calls, settings);
    assert.equal(Ed.lsp.sessionOf(b), null, settings);
    assert.equal(Ed.lsp.sessions().length, 0, settings);
    assert.match(messages().split('\n').filter(Boolean).pop()!, /^eglot: /, settings);
    assert.match(messages(), why, settings);
    assert.throws(() => { Ed.setWindowBuffer(b); L.call('eglot', []); }, settings);
    assert.equal(proc.calls.length, calls, settings);
    b.modified = false; L.call('kill-buffer', [b]);
  }
});

test('while the image replays a declaration with settings is skipped, its settings not looked at', async () => {
  fake(`'((fake . 1))`);
  const before = Ed.lsp.servers().find((s: { name: string }) => s.name === 'fake');
  Ed.proc.replay(() => L.evalText(`(define-language-server 'fake :modes '(fake-mode) :command '("x") :settings 'sym)`));
  assert.equal(Ed.lsp.servers().find((s: { name: string }) => s.name === 'fake'), before);
  assert.match(E.echo, /fake is not declared while the image replays/);
  await until(() => !Ed.proc.replaying(), 'the replay window closed');
});

/* The table's own servers, from PATH. */
const REAL = process.env.EDWIN_LSP_SERVERS === '1' ? false : 'EDWIN_LSP_SERVERS is not 1 (the check sets it, with nixd, pyright and harper-ls on PATH)';
const lineCol = (b: Buf) => { const before = b.text.slice(0, b.pt).split('\n'); return [before.length - 1, before[before.length - 1].length]; };
async function definitionAt(b: Buf, at: number) {
  b.pt = at;
  await keys('g d');
  assert.equal(E.current, b, E.echo);
  return lineCol(b);
}
const errorsOf = (b: Buf) => Ed.lsp.diagnostics(b) as { start: number; end: number; severity: number; message: string }[];

test('nixd from the table: a use to its binding, an undefined name an error at its place', { skip: REAL }, async () => {
  const pr = project('nixd', { 'default.nix': 'let\n  x = 1;\nin\n  x + nosuchname\n' });
  const b = await open(pr['default.nix']);
  const s = Ed.lsp.sessionOf(b);
  assert.equal(s.name, 'nixd');
  assert.deepEqual(s.settings, { nixd: { nixpkgs: { expr: 'import <nixpkgs> { }' } } });
  await until(() => errorsOf(b).some(d => d.severity === 1), 'nixd\'s diagnostics', 30_000);
  const at = b.text.indexOf('nosuchname');
  const e = errorsOf(b).find(d => d.severity === 1)!;
  assert.deepEqual([e.start, e.end], [at, at + 'nosuchname'.length], JSON.stringify(errorsOf(b)));
  assert.match(e.message, /undefined/i);
  assert.deepEqual(await definitionAt(b, b.text.indexOf('x +')), [1, 2]);
  await Ed.lsp.shutdown(s);
  await until(() => proc.running().length === 0, 'nixd ended');
});

test('pyright from the table: a use to its binding, an undefined name an error at its place', { skip: REAL }, async () => {
  const pr = project('pyright', { 'a.py': 'thing = 1\nprint(thing)\nprint(nosuchname)\n' });
  const b = await open(pr['a.py']);
  const s = Ed.lsp.sessionOf(b);
  assert.equal(s.name, 'pyright');
  await until(() => errorsOf(b).some(d => d.severity === 1), 'pyright\'s diagnostics', 60_000);
  const at = b.text.indexOf('nosuchname');
  const e = errorsOf(b).find(d => d.severity === 1)!;
  assert.deepEqual([e.start, e.end], [at, at + 'nosuchname'.length], JSON.stringify(errorsOf(b)));
  assert.match(e.message, /nosuchname/);
  assert.deepEqual(await definitionAt(b, b.text.indexOf('thing)')), [0, 0]);
  await Ed.lsp.shutdown(s);
  await until(() => proc.running().length === 0, 'pyright ended');
});

test('harper-ls from the table: a misspelling in a Markdown file', { skip: REAL }, async () => {
  const pr = project('harper', { 'notes.md': '# Notes\n\nThis sentense has a misspelling.\n' });
  const b = await open(pr['notes.md']);
  const s = Ed.lsp.sessionOf(b);
  assert.equal(s.name, 'harper-ls');
  assert.equal(b.mode, 'markdown-mode');
  await until(() => errorsOf(b).length, 'harper-ls\'s diagnostics', 30_000);
  const at = b.text.indexOf('sentense');
  const d = errorsOf(b).find(x => x.start === at);
  assert.ok(d, JSON.stringify(errorsOf(b)));
  assert.equal(d!.end, at + 'sentense'.length);
  await Ed.lsp.shutdown(s);
  await until(() => proc.running().length === 0, 'harper-ls ended');
});
