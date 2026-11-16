// Programming modes in the headless runtime: each mode's comment syntax (set-comment-syntax!, looked up through
// the modes a mode derives from, nearest first) and the comment commands that use it, gc, gcc and M-;.
// One Edwin per process, so the cases run in order on fresh buffers.
// Run: node --test test/prog.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startEdwin } from './headless.mts';

const ed = await startEdwin();
const ev = (src: string) => ed.eval(src);
ev('(set! corfu-auto #f)');
let n = 0;
/* A fresh buffer visiting NAME.EXT (NAME numbered when not given), holding TEXT, point at its start, Normal state;
   MODE, when given, is turned on after the visit. */
async function buffer(ext: string, text: string, mode?: string) {
  if ((globalThis as typeof globalThis & { EvilCore: { stateOf(b: unknown): string } }).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
  await ed.type(`:e cs${++n}.${ext}\n`);
  assert.equal(ed.text(), '');
  if (mode) ev(`(${mode})`);
  ev(`(insert ${JSON.stringify(text)})`);
  ev('(goto-char 1)');
  return ed.E.current;
}
const names = (v: unknown) => ed.L.arr(v).map((s: { name: string }) => s.name);

test('derived-mode-all-parents gives a mode and its ancestors, nearest first', () => {
  assert.deepEqual(names(ev("(derived-mode-all-parents 'markdown-mode)")), ['markdown-mode', 'text-mode']);
  assert.deepEqual(names(ev("(derived-mode-all-parents 'scheme-mode)")), ['scheme-mode']);
});

test('the shipped modes: Scheme ;;, Org and Fundamental #, Markdown <!-- -->; text-mode falls back to Fundamental', async () => {
  const syntax = (ext: string, mode?: string) => buffer(ext, '', mode).then(() => {
    const d = ev('(comment-delimiters)'); return [d.car, d.cdr];
  });
  assert.deepEqual(await syntax('scm'), [';;', '']);
  assert.deepEqual(await syntax('org'), ['#', '']);
  assert.deepEqual(await syntax('nix'), ['#', '']);
  assert.deepEqual(await syntax('md'), ['<!--', '-->']);
  assert.deepEqual(await syntax('txt', 'text-mode'), ['#', '']);
  const b = await buffer('txt', '');
  ev('(scheme-interaction-mode)');
  assert.equal(b.mode, 'scheme-interaction-mode');
  assert.equal(ev('(car (comment-delimiters))'), ';;');
});

test('the nearest declaration wins: a derived mode\'s own entry beats its parent\'s, and one with none takes its parent\'s', async () => {
  ev(`(define-derived-mode cs-parent-mode text-mode "CS parent" #f)
      (define-derived-mode cs-child-mode cs-parent-mode "CS child" #f)
      (define-derived-mode cs-grandchild-mode cs-child-mode "CS grandchild" #f)
      (set-comment-syntax! 'cs-child-mode "--")
      (set-comment-syntax! 'cs-parent-mode "//")`);
  // The parent's entry is the newer one, so a lookup in table order rather than mode order would take it.
  await buffer('txt', 'x', 'cs-grandchild-mode');
  assert.equal(ev('(car (comment-delimiters))'), '--');
  await buffer('txt', 'x', 'cs-parent-mode');
  assert.equal(ev('(car (comment-delimiters))'), '//');
  // A later declaration replaces the earlier one for the same mode.
  ev('(set-comment-syntax! \'cs-child-mode "%")');
  await buffer('txt', 'x', 'cs-grandchild-mode');
  assert.equal(ev('(car (comment-delimiters))'), '%');
});

test('set-comment-syntax! refuses a declaration with no usable comment: none, an empty or non-string delimiter', () => {
  assert.throws(() => ev("(set-comment-syntax! 'cs-bad-mode #f)"), /neither a line comment/);
  for (const form of ['""', '5'])
    assert.throws(() => ev(`(set-comment-syntax! 'cs-bad-mode ${form})`), /line comment is neither/);
  for (const block of ['"/*"', '"" "*/"', '"/*" ""', '5 "*/"', '"/*" "*/" "x"'])
    for (const line of ['#f', '"//"'])
      assert.throws(() => ev(`(set-comment-syntax! 'cs-bad-mode ${line} ${block})`), /block comment needs two/);
  assert.equal(ev("(assq 'cs-bad-mode comment-syntaxes)"), false);
});

test('gcc and gc in Scheme: ;; at the indentation, back again, blank lines left alone', async () => {
  await buffer('scm', '  (foo)\n');
  await ed.type('gcc');
  assert.equal(ed.text(), '  ;; (foo)\n');
  await ed.type('gcc');
  assert.equal(ed.text(), '  (foo)\n');
  await buffer('scm', '(a)\n\n(b)\n');
  await ed.type('Vjjgc');
  assert.equal(ed.text(), ';; (a)\n\n;; (b)\n');
  await ed.type('gcip');
  assert.equal(ed.text(), '(a)\n\n;; (b)\n');
});

test('gcc in a .nix buffer (Fundamental) and in Org: #', async () => {
  await buffer('nix', 'x = 1;\n');
  await ed.type('gcc');
  assert.equal(ed.text(), '# x = 1;\n');
  await buffer('org', 'text\n');
  await ed.type('gcc');
  assert.equal(ed.text(), '# text\n');
  await ed.type('gcc');
  assert.equal(ed.text(), 'text\n');
});

test('gc in Markdown wraps each line in an HTML comment and unwraps it; a line is not made a heading', async () => {
  await buffer('md', 'one\n  two\n');
  await ed.type('Vjgc');
  assert.equal(ed.text(), '<!-- one -->\n  <!-- two -->\n');
  await ed.type('Vjgc');
  assert.equal(ed.text(), 'one\n  two\n');
  // A line that opens but does not close a comment is not commented, so the range is commented again.
  await buffer('md', '<!-- a\nb -->\n');
  await ed.type('Vjgc');
  assert.equal(ed.text(), '<!-- <!-- a -->\n<!-- b --> -->\n');
});

test('a mode with block comments only: gc and M-; use its delimiters', async () => {
  ev('(define-derived-mode cs-block-mode #f "CS block" #f) (set-comment-syntax! \'cs-block-mode #f "/*" "*/")');
  await buffer('txt', 'a;\n', 'cs-block-mode');
  await ed.type('gcc');
  assert.equal(ed.text(), '/* a; */\n');
  await ed.type('gcc');
  assert.equal(ed.text(), 'a;\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), '/* a; */\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), 'a;\n');
});

test('M-; (comment-line) uses the mode: ;; in Scheme, # in .nix, <!-- --> in Markdown', async () => {
  await buffer('scm', '  (foo)\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), '  ;; (foo)\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), '  (foo)\n');
  await buffer('nix', 'x = 1;\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), '# x = 1;\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), 'x = 1;\n');
  await buffer('md', 'one\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), '<!-- one -->\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), 'one\n');
  // As gc: a line that opens a comment but does not close it is not commented, so M-; wraps it again.
  await buffer('md', '<!-- a\nb -->\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), '<!-- <!-- a -->\nb -->\n');
});

test('M-; still strips any run of a one-character opener: ;;; Header and ; x', async () => {
  await buffer('scm', ';;; Header\n; x\n');
  await ed.keys('M-;');
  assert.equal(ed.text(), 'Header\n; x\n');
  await ed.type('j');
  await ed.keys('M-;');
  assert.equal(ed.text(), 'Header\nx\n');
});
