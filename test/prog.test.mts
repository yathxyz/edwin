// Programming modes in the headless runtime: prog-mode and define-language (scm/prog.scm), each mode's comment
// syntax (set-comment-syntax!, looked up through the modes a mode derives from, nearest first) and the comment
// commands that use it, gc, gcc and M-;.
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

test('gcc in a .nix buffer (Nix) and in Org: #', async () => {
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

/* ---------- prog-mode and define-language (scm/prog.scm) ---------- */

/* A file name of each declared language, and the mode it opens in. Bare names and paths: in a frame the
   mode is chosen from the name as given, on the server from the file's base name. */
const SAMPLES: [string, string][] = [
  ['main.rs', 'rust-mode'], ['default.nix', 'nix-mode'], ['main.go', 'go-mode'], ['x.c', 'c-mode'], ['x.h', 'c-mode'],
  ['x.cc', 'c++-mode'], ['x.cpp', 'c++-mode'], ['x.hpp', 'c++-mode'], ['Main.java', 'java-mode'], ['Program.cs', 'csharp-mode'],
  ['app.py', 'python-mode'], ['stub.pyi', 'python-mode'], ['a.js', 'js-mode'], ['a.mjs', 'js-mode'], ['a.cjs', 'js-mode'],
  ['a.jsx', 'js-mode'], ['a.ts', 'typescript-mode'], ['a.mts', 'typescript-mode'], ['a.cts', 'typescript-mode'],
  ['a.tsx', 'tsx-mode'], ['package.json', 'json-mode'], ['tsconfig.jsonc', 'json-mode'], ['flake.lock', 'json-mode'],
  ['ci.yml', 'yaml-mode'], ['ci.yaml', 'yaml-mode'], ['Cargo.toml', 'toml-mode'], ['run.sh', 'sh-mode'], ['run.bash', 'sh-mode'],
  ['.envrc', 'sh-mode'], ['main.tf', 'terraform-mode'], ['prod.tfvars', 'terraform-mode'], ['main.tofu', 'terraform-mode'],
  ['player.gd', 'gdscript-mode'], ['justfile', 'just-mode'], ['Justfile', 'just-mode'], ['.justfile', 'just-mode'],
  ['build.just', 'just-mode'], ['meson.build', 'meson-mode'], ['meson_options.txt', 'meson-mode'],
  ['meson.options', 'meson-mode'], ['boot.nasm', 'nasm-mode'], ['nginx.conf', 'nginx-mode'], ['paper.typ', 'typst-mode'],
];
const PATHS: [string, string][] = [
  ['src/lib.rs', 'rust-mode'], ['/home/u/proj/flake.nix', 'nix-mode'], ['proj/justfile', 'just-mode'],
  ['sub/meson.build', 'meson-mode'], ['/etc/nginx/nginx.conf', 'nginx-mode'], ['/etc/nginx/sites/site.conf', 'nginx-mode'],
  ['dir/.envrc', 'sh-mode'],
];
/* Names that must not be taken by a language. */
const OTHERS: [string, string][] = [
  ['notes.md', 'markdown-mode'], ['todo.org', 'org-mode'], ['init.scm', 'scheme-mode'], ['init.el', 'scheme-mode'],
  ['notes.txt', 'fundamental-mode'], ['site.conf', 'fundamental-mode'], ['myjustfile.txt', 'fundamental-mode'],
  ['x.json.bak', 'fundamental-mode'], ['a.ts.orig', 'fundamental-mode'], ['README', 'fundamental-mode'],
  // Case-sensitive, unlike Emacs's auto-mode-case-fold (docs/steps.md).
  ['X.RS', 'fundamental-mode'], ['x.JSON', 'fundamental-mode'], ['Main.C', 'fundamental-mode'],
];

test('each declared extension selects its mode, on visiting a file and from a path', async () => {
  const declared = names(ev('(map car languages)')).sort();
  assert.deepEqual([...new Set(SAMPLES.map(s => s[1]))].sort(), declared, 'every declared language has a sample');
  for (const [file, mode] of SAMPLES) {
    await ed.type(`:e lang${++n}/${file}\n`);
    assert.equal(ed.E.current.mode, mode, file);
    assert.equal(ev(`(and (derived-mode-p 'prog-mode) #t)`), true, file);
  }
  for (const [file, mode] of [...SAMPLES, ...PATHS, ...OTHERS]) assert.equal(ed.Ed.modeFor(file), mode, file);
});

test('visiting a file turns its mode on: the indent width is buffer-local, the hooks run once', async () => {
  ev(`(define cs-prog-ran 0) (define cs-rust-ran 0)
      (add-hook! 'prog-mode-hook (lambda () (set! cs-prog-ran (+ cs-prog-ran 1))))
      (add-hook! 'rust-mode-hook (lambda () (set! cs-rust-ran (+ cs-rust-ran 1))))`);
  const rs = await buffer('rs', 'fn main() {}\n');
  assert.equal(rs.mode, 'rust-mode');
  assert.equal(ev('cs-prog-ran'), 1);
  assert.equal(ev('cs-rust-ran'), 1);
  assert.equal(ev('tab-width'), 4);
  assert.equal(ev('evil-shift-width'), 4);
  assert.equal(ev("(local-variable-p 'evil-shift-width)"), true);
  await ed.type('>>');
  assert.equal(ed.text(), '    fn main() {}\n');
  const nix = await buffer('nix', 'x = 1;\n');
  assert.equal(ev('cs-prog-ran'), 2);
  assert.equal(ev('cs-rust-ran'), 1);
  assert.equal(ev('tab-width'), 2);
  await ed.type('>>');
  assert.equal(ed.text(), '  x = 1;\n');
  // A buffer of no language keeps the defaults init.scm sets (tab-width 4, evil-shift-width 2).
  await buffer('txt', 'plain\n');
  assert.equal(ev('tab-width'), 4);
  assert.equal(ev('evil-shift-width'), 2);
  assert.equal(ev("(local-variable-p 'evil-shift-width)"), false);
  // Visiting an open file again does not turn the mode on again.
  await ed.type(`:e ${rs.name}\n`);
  assert.equal(ed.E.current, rs);
  assert.equal(ev('cs-rust-ran'), 1);
  void nix;
});

test('a language\'s comment syntax: gcc writes //, # and ;', async () => {
  for (const [ext, out] of [['rs', '// a\n'], ['py', '# a\n'], ['nasm', '; a\n'], ['ts', '// a\n'], ['tf', '# a\n']]) {
    await buffer(ext, 'a\n');
    await ed.type('gcc');
    assert.equal(ed.text(), out, ext);
  }
});

test('define-language: BODY runs after prog-mode\'s, and M-x MODE turns the mode on as a visit does', async () => {
  ev(`(define-language cs-lang-mode "CS lang" :files '("\\\\.cslang$") :comment '("--") :indent 3
        (setq-local cs-lang-body tab-width))`);
  await buffer('cslang', 'a\n');
  assert.equal(ed.E.current.mode, 'cs-lang-mode');
  assert.equal(ev('cs-lang-body'), 3, 'the body sees the indent the language set');
  assert.equal(ev('(car (comment-delimiters))'), '--');
  const b = await buffer('txt', 'a\n');
  ev('(cs-lang-mode)');
  assert.equal(b.mode, 'cs-lang-mode');
  assert.equal(ev('tab-width'), 3);
  assert.equal(ed.Ed.MODE_NAMES['cs-lang-mode'], 'CS lang');
});

test('declaring a language again replaces it: its file patterns, comment syntax and indent', async () => {
  const entries = () => ed.L.arr(ev('auto-mode-alist')).filter((p: { cdr: { name: string } }) => p.cdr.name === 'cs-again-mode').map((p: { car: string }) => p.car);
  ev(`(define-language cs-again-mode "CS again" :files '("\\\\.csa$" "\\\\.csb$") :comment '("%") :indent 2)`);
  assert.deepEqual(entries(), ['\\.csa$', '\\.csb$']);
  ev(`(define-language cs-again-mode "CS again" :files '("\\\\.csc$") :comment '("!") :indent 6)`);
  assert.deepEqual(entries(), ['\\.csc$']);
  assert.equal(ed.Ed.modeFor('x.csa'), 'fundamental-mode');
  assert.equal(ed.Ed.modeFor('x.csc'), 'cs-again-mode');
  await buffer('csc', 'a\n');
  assert.equal(ev('tab-width'), 6);
  await ed.type('gcc');
  assert.equal(ed.text(), '! a\n');
  // A declaration with no :comment drops the earlier one's: the mode falls back to Fundamental's #.
  ev(`(define-language cs-again-mode "CS again" :files '("\\\\.csc$") :indent 6)`);
  await buffer('csc', 'a\n');
  await ed.type('gcc');
  assert.equal(ed.text(), '# a\n');
  // The earlier entries stay ahead of a language's: Markdown and Org are not taken over.
  const al = ed.L.arr(ev('auto-mode-alist'));
  assert.equal(al[0].cdr.name, 'markdown-mode');
  assert.equal(names(ev("(map car languages)")).filter((m: string) => m === 'cs-again-mode').length, 1);
});

test('write-file to a language\'s file name turns its mode on', async () => {
  const b = await buffer('txt', 'package main\n');
  assert.equal(b.mode, 'fundamental-mode');
  ev(`(write-file "cs-written${n}.go")`);
  assert.equal(b.mode, 'go-mode');
  assert.equal(ev('evil-shift-width'), 4);
});

test('define-language refuses a declaration it cannot use, and records nothing of it', () => {
  const bad = [
    [`"CS bad"`, /:files needs/],
    [`"CS bad" :files '()`, /:files needs/],
    [`"CS bad" :files '(5)`, /:files needs/],
    [`"CS bad" :files '("")`, /:files needs/],
    [`"CS bad" :files "\\\\.x$"`, /:files needs/],
    [`"CS bad" :files '("\\\\.x$") :indent 0`, /:indent is neither/],
    [`"CS bad" :files '("\\\\.x$") :indent 2.5`, /:indent is neither/],
    [`"CS bad" :files '("\\\\.x$") :indent "4"`, /:indent is neither/],
    [`"CS bad" :files '("\\\\.x$") :comment "#"`, /:comment needs a list/],
    [`"CS bad" :files '("\\\\.x$") :comment '("")`, /line comment is neither/],
    [`"CS bad" :files '("\\\\.x$") :tabs #t`, /unknown option/],
    [`5 :files '("\\\\.x$")`, /name is not a non-empty string/],
    [`"" :files '("\\\\.x$")`, /name is not a non-empty string/],
    [`#f :files '("\\\\.x$")`, /name is not a non-empty string/],
    // Patterns auto-mode-alist's lookup could not compile: it would put a never-matching one in their place.
    [`"CS bad" :files '("(")`, /not a JavaScript regexp/],
    [`"CS bad" :files '("\\\\.x$" "[a-")`, /not a JavaScript regexp/],
  ] as const;
  for (const [args, re] of bad) assert.throws(() => ev(`(define-language cs-bad-mode ${args})`), re, args);
  assert.throws(() => ev(`(define-language cs-bad-mode "CS bad" :files)`), /keyword without a value/);
  assert.equal(ev("(assq 'cs-bad-mode languages)"), false);
  assert.equal(ev("(assq 'cs-bad-mode comment-syntaxes)"), false);
  assert.equal(ed.Ed.MODE_NAMES['cs-bad-mode'], undefined, 'no mode was made');
  assert.equal(ed.Ed.modeFor('y.x'), 'fundamental-mode');
  assert.notEqual(ed.Ed.modeFor(''), 'cs-bad-mode');
  // A MODE that is not a symbol is refused before anything is recorded, so no file opens in a mode that does not exist.
  for (const mode of ['"cs-str-mode"', '5', '(cs-list-mode)'])
    assert.throws(() => ev(`(define-language ${mode} "CS str" :files '("\\\\.csz$"))`), /mode is not a symbol/, mode);
  assert.equal(ev('(assoc "cs-str-mode" languages)'), false);
  assert.equal(ed.Ed.modeFor('a.csz'), 'fundamental-mode');
});
