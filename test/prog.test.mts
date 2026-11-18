// Programming modes in the headless runtime: prog-mode and define-language (scm/prog.scm), each mode's comment
// syntax (set-comment-syntax!, looked up through the modes a mode derives from, nearest first) and the comment
// commands that use it, gc, gcc and M-;. Balanced brackets in Lisp buffers (lang-lisp-brackets): typing, Replace state,
// DEL, C-d and RET keep a balanced buffer balanced, by rule and by a property test of random keys; the list motions.
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

/* ---------- ws-butler: trailing blanks trimmed on save from the changed lines only (scm/prog.scm) ---------- */

/* Visit NAME, whose file holds TEXT (none when TEXT is null), in Normal state with point at its start. */
async function visit(name: string, text: string | null) {
  if ((globalThis as typeof globalThis & { EvilCore: { stateOf(b: unknown): string } }).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
  if (text !== null) ed.Ed.Store.set(name, text);
  await ed.type(`:e ${name}\n`);
  assert.equal(ed.text(), text ?? '');
  ev('(goto-char 1)');
  return ed.E.current;
}
const saved = (name: string) => ed.Ed.Store.get(name);
const DIRTY = 'a = 1;  \nb = 2;\t\nc = 3; \t \n';

test('ws-butler: untouched dirty lines survive a save; the changed line loses its trailing blanks', async () => {
  const b = await visit('ws1.nix', DIRTY);
  ev('(forward-line 1) (forward-char 5) (insert "2")');
  assert.equal(ed.text(), 'a = 1;  \nb = 22;\t\nc = 3; \t \n');
  await ed.type(':w\n');
  assert.equal(saved('ws1.nix'), 'a = 1;  \nb = 22;\nc = 3; \t \n');
  assert.equal(ed.text(), saved('ws1.nix'));
  assert.equal(b.modified, false);
});

test('ws-butler: an edit at a line\'s start, a line added and a line joined are changed lines; a deleted line changes none', async () => {
  await visit('ws2.nix', 'a  \nb  \nc  \nd  \ne  \nf  \n');
  // An edit at the start: the line diff's ops cover only the start, yet the whole line counts.
  ev('(forward-line 1) (insert "x")');
  // A deleted line (d) leaves its neighbours (c, e) untouched.
  ev('(goto-char 1) (forward-line 3) (let ((s (point))) (forward-line 1) (delete-region s (point)))');
  // e and f joined.
  ev('(goto-char 1) (forward-line 3) (end-of-line) (delete-char 1)');
  // A new line with trailing blanks after the first.
  ev('(goto-char 1) (end-of-line) (insert "\\nnew \\t")');
  assert.equal(ed.text(), 'a  \nnew \t\nxb  \nc  \ne  f  \n');
  await ed.type(':w\n');
  assert.equal(saved('ws2.nix'), 'a  \nnew\nxb\nc  \ne  f\n');
});

test('ws-butler: a new file is trimmed throughout, a Scheme buffer as well as a programming one', async () => {
  await visit('ws3.scm', null);
  ev('(insert "(define x 1)   \\n(define y 2)\\t")');
  await ed.type(':w\n');
  assert.equal(saved('ws3.scm'), '(define x 1)\n(define y 2)');
  await visit('ws3.py', null);
  ev('(insert "x = 1  \\n\\ny = 2 \\n")');
  await ed.type(':w\n');
  assert.equal(saved('ws3.py'), 'x = 1\n\ny = 2\n');
});

test('ws-butler: saving an unmodified buffer changes nothing and leaves it unmodified', async () => {
  const b = await visit('ws4.nix', DIRTY);
  await ed.type(':w\n');
  assert.equal(saved('ws4.nix'), DIRTY);
  assert.equal(ed.text(), DIRTY);
  assert.equal(b.modified, false);
  // Changed and changed back: the text is the file's again, so no line differs from it.
  ev('(forward-line 1) (end-of-line) (insert "x") (delete-char -1)');
  await ed.type(':w\n');
  assert.equal(saved('ws4.nix'), DIRTY);
});

test('ws-butler: off with ws-butler-mode #f, and never in a mode that is not a programming or Scheme one', async () => {
  try {
    ev('(set! ws-butler-mode #f)');
    await visit('ws5.nix', DIRTY);
    ev('(insert "# top  \\n")');
    await ed.type(':w\n');
    assert.equal(saved('ws5.nix'), '# top  \n' + DIRTY);
  } finally { ev('(set! ws-butler-mode #t)'); }
  for (const name of ['ws5.txt', 'ws5.org', 'ws5.md']) {
    await visit(name, 'one  \n');
    ev('(insert "two  \\n")');
    await ed.type(':w\n');
    assert.equal(saved(name), 'two  \none  \n', name);
  }
});

test('ws-butler: point and the mark stay on their lines and columns; point among the trimmed blanks goes to the line\'s end', async () => {
  const b = await visit('ws6.nix', 'one  \ntwo  \nthree  \n');
  ev('(insert "1") (forward-line 2) (forward-char 2) (set-mark (point))');
  ev('(goto-char 1) (forward-line 1) (forward-char 1) (insert "w")');
  assert.equal(ed.text(), '1one  \ntwwo  \nthree  \n');
  await ed.type(':w\n');
  assert.equal(saved('ws6.nix'), '1one\ntwwo\nthree  \n');
  assert.deepEqual([ev('(line-number-at-pos)'), ev('(current-column)')], [2, 2]);
  assert.equal(ev('(buffer-substring (mark) (+ (mark) 3))'), 'ree', 'the mark on an untouched line keeps its column');
  assert.equal(b.modified, false);
  // Saved by a call, not :w: after a command Normal state would put point back on the line's last character.
  ev('(end-of-line) (insert "x  ") (backward-char 1)');
  ev('(save-buffer)');
  assert.equal(saved('ws6.nix'), '1one\ntwwox\nthree  \n');
  assert.deepEqual([ev('(line-number-at-pos)'), ev('(current-column)')], [2, 5]);
});

test('buffer-changed-lines: the lines that differ from the file; every line of a new file; none in a buffer with no file', async () => {
  await visit('ws7.nix', 'a\nb\nc\nd\n');
  assert.deepEqual(ed.L.arr(ev('(buffer-changed-lines)')), []);
  ev('(insert "0\\n") (forward-line 2) (insert "B")');
  const pairs = (v: unknown) => ed.L.arr(v).map((p: { car: number; cdr: number }) => [p.car, p.cdr]);
  assert.deepEqual(pairs(ev("(buffer-changed-lines)")), [[1, 1], [4, 4]]);
  await visit('ws7.ts', null);
  ev('(insert "x\\ny\\n")');
  assert.deepEqual(pairs(ev('(buffer-changed-lines)')), [[1, 2]]);
  ev('(switch-to-buffer "*ws7 no file*")');
  assert.equal(ev('(buffer-changed-lines)'), false);
  // Past the line diff's limits: the lines between the common prefix and suffix of characters.
  const R = (globalThis as typeof globalThis & { Rope: { changedLines(a: string, b: string, limit?: number): [number, number][] } }).Rope;
  assert.deepEqual(R.changedLines('a\nb\nc\nd\n', 'a\nB\nc\nD\n'), [[1, 2], [3, 4]]);
  assert.deepEqual(R.changedLines('a\nb\nc\nd\n', 'a\nB\nc\nD\n', 0), [[1, 4]]);
  assert.deepEqual(R.changedLines('a\nb\n', 'a\n'), []);
  assert.deepEqual(R.changedLines('a\nb', 'a'), [[0, 1]]);
  assert.deepEqual(R.changedLines('', ''), []);
});

test('delete-trailing-blanks: the given lines only, the last line with no newline, ranges past the end; refused in a read-only buffer', async () => {
  await visit('ws8.nix', null);
  ev('(insert "a \\nb\\t\\n  \\nd  \\ne \\t")');
  ev('(delete-trailing-blanks (list (cons 1 1) (cons 3 3) (cons 5 9)))');
  assert.equal(ed.text(), 'a\nb\t\n\nd  \ne');
  ev('(delete-trailing-blanks (list (cons 2 2)))');
  assert.equal(ed.text(), 'a\nb\n\nd  \ne');
  ev('(read-only-mode)');
  try { assert.throws(() => ev('(delete-trailing-blanks (list (cons 4 4)))'), /read-only/); }
  finally { ev('(read-only-mode)'); }
  assert.equal(ed.text(), 'a\nb\n\nd  \ne');
});

/* lang-lisp-brackets: balanced insertion and deletion in Lisp buffers (src/extras.ts), the list motions
   (src/editor-prims.ts) and the audit's cases for them (structural-editing-cases.jsonl in the fleet repository).
   ‸ marks point: TEXT holds it once; the buffer starts in Insert state there. */
async function lisp(text: string, ext = 'scm') {
  const k = text.indexOf('‸');
  const b = await buffer(ext, text.slice(0, k) + text.slice(k + 1));
  b.pt = k;
  await ed.type('i');
  return b;
}
/* The same in Emacs state; C-z goes back to Normal state. */
async function emacsAt(text: string) {
  const k = text.indexOf('‸');
  const b = await buffer('scm', text.slice(0, k) + text.slice(k + 1));
  await ed.keys('C-z');
  b.pt = k;
  return b;
}
const shown = () => { const t = ed.text(), p = ed.point(); return t.slice(0, p) + '‸' + t.slice(p); };
/* Whether the Lisp text T is balanced, as the structural suite judges it: its brackets never close more than they
   opened and end closed, and no string, #| comment or #; datum runs on to its end. */
function balanced(t: string) {
  const info: { dirty?: boolean } = {}, cls = ed.Ed.lex(t, info) as Uint8Array;
  let d = 0;
  for (let k = 0; k < t.length; k++) if (cls[k] === ed.Ed.C.PAR) { d += '(['.includes(t[k]) ? 1 : -1; if (d < 0) return false; }
  return d === 0 && !info.dirty;
}
/* KEYS as the audit wrote them: "K:NAME" one key by its name, anything else typed. */
const AUDIT_KEYS: Record<string, string> = { Escape: 'ESC', BSpace: 'DEL' };
async function press(keys: string[]) {
  for (const k of keys) if (k.startsWith('K:')) await ed.keys(AUDIT_KEYS[k.slice(2)] ?? k.slice(2)); else await ed.type(k);
}
/* [id, extension, input, keys, expected]: the audit's cases this package decides, each with Edwin's answer; where it
   differs from the audit's expectation, docs/steps.md says why. */
const BRACKET_CASES: [string, string, string, string[], string][] = [
  ['ep-DEL-after-close', 'scm', '(foo)\n', ['A', 'K:BSpace', 'K:Escape'], '\n'],
  ['ep-DEL-after-open', 'scm', '(foo)\n', ['a', 'K:BSpace', 'K:Escape'], '\n'],
  // The audit's keys put point after the f, not the (: DEL deletes the f, as lispy does there.
  ['ep-DEL-open-with-content', 'scm', '(foo)\n', ['la', 'K:BSpace', 'K:Escape'], '(oo)\n'],
  // The audit expected electric-pair's (foo, which is unbalanced: the pair goes in, a blank before the word.
  ['ep-(-before-word', 'scm', 'foo\n', ['i(', 'K:Escape'], '() foo\n'],
  ['ep-"-inside-string', 'scm', '(f "ab")\n', ['fb', 'i"', 'K:Escape'], '(f "a\\"b")\n'],
  ['CMd-down-list', 'scm', '(a (b) c)\n', ['l', 'K:C-M-d', 'iX', 'K:Escape'], '(a (Xb) c)\n'],
  ['CMn-forward-list', 'scm', '(a (b) c)\n', ['l', 'K:C-M-n', 'iX', 'K:Escape'], '(a (b)X c)\n'],
  ['CMt-transpose-sexps', 'scm', '(a b)\n', ['fb', 'K:C-M-t'], '(b a)\n'],
  ['CMa-beginning-of-defun', 'scm', '(define (f)\n  (g))\n', ['jw', 'K:C-M-a', 'iX', 'K:Escape'], 'X(define (f)\n  (g))\n'],
  // Point is before the character the Normal-state cursor covers, so C-M-b from the last ) crosses c, as Emacs's
  // backward-sexp from there does; the audit expected the list.
  ['CMb', 'scm', '(a) (b c)\n', ['$', 'K:C-M-b', 'iX', 'K:Escape'], '(a) (b Xc)\n'],
  // { is a plain character in Lisp, no bracket to the lexer, so it no longer pairs; the audit expected {}.
  ['ep-{', 'scm', '\n', ['i{', 'K:Escape'], '{\n'],
];
for (const [id, ext, input, keys, expected] of BRACKET_CASES)
  test(`audit case ${id}`, async () => {
    await buffer(ext, input);
    await press(keys);
    assert.equal(ed.text(), expected);
  });

test('Lisp insertion: ( and [ pair, with a blank beside an atom; ) and ] leave the list; " pairs, escapes in a string, steps over its end', async () => {
  const cases: [string, string, string][] = [
    ['(foo‸)', '(', '(foo (‸))'], ['(‸foo)', '(', '((‸) foo)'], ["'‸", '(', "'(‸)"], ['#‸', '(', '#(‸)'], ['#u8‸', '(', '#u8(‸)'],
    ['(let ‸)', '[', '(let [‸])'], [',@‸', '(', ',@(‸)'], ['#\\a‸', '(', '#\\a (‸)'],
    ['(a (b‸) c)', ')', '(a (b)‸ c)'], ['(a (b‸) c)', ']', '(a (b)‸ c)'], ['(a\n  b‸\n  )', ')', '(a\n  b\n  )‸'],
    ['(f ‸)', '"', '(f "‸")'], ['(f "a‸b")', '"', '(f "a\\"‸b")'], ['(f "ab‸")', '"', '(f "ab"‸)'],
    ['(f "a‸")', '(', '(f "a(‸")'], ['(f "a‸")', ')', '(f "a)‸")'], ['(f ; a‸\n )', '(', '(f ; a(‸\n )'], ['(f ; a‸\n )', '"', '(f ; a"‸\n )'],
    ['(f #| a‸ |#)', ')', '(f #| a)‸ |#)'], ['(a #‸)', '|', '(a #|‸|#)'], ['(f {‸)', '}', '(f {}‸)'],
  ];
  for (const [before, keys, after] of cases) {
    await lisp(before);
    await ed.type(keys);
    assert.equal(shown(), after, `${keys} in ${JSON.stringify(before)}`);
  }
  // Typed whole, a list and a string come out as typed.
  await lisp('‸');
  await ed.type('(define (f x) "doc" (g [x 1]))');
  assert.equal(shown(), '(define (f x) "doc" (g [x 1]))‸');
});

test('Lisp insertion: a backslash takes the character after it, ; before code puts the code on its own line, and ) at top level is refused', async () => {
  await lisp('(list ‸)');
  await ed.type('#\\( #\\) #\\" #\;');
  assert.equal(shown(), '(list #\\( #\\) #\\" #\;‸)');
  assert.ok(balanced(ed.text()));
  await lisp('(f "a‸")');
  await ed.type('\\"');
  assert.equal(shown(), '(f "a\\"‸")');
  await lisp('(f ; a‸\n )');
  await ed.type('\\x');
  assert.equal(shown(), '(f ; a\\x‸\n )');
  // Point between a backslash and what it escapes: past it first.
  const b = await lisp('(list #\\(‸)');
  b.pt = 8;
  await ed.type('x');
  assert.equal(shown(), '(list #\\(x‸)');
  // ; with code after it on the line: that code goes on a line of its own, indented.
  await lisp('(a ‸b c)');
  await ed.type(';');
  assert.equal(shown(), '(a ;‸\n b c)');
  await lisp('(a b)‸  \n');
  await ed.type(';');
  assert.equal(shown(), '(a b);‸  \n');
  await lisp('(a ‸(b))');
  await ed.type('#;');
  assert.equal(shown(), '(a #;‸(b))');
  await lisp('(a)\n‸\n');
  await ed.type(')');
  assert.equal(shown(), '(a)\n‸\n');
  assert.equal(ed.E.echo, 'No list to close here');
});

test('Lisp insertion: a backslash then a key that is no character inserts nothing and runs that key', async () => {
  const state = () => (globalThis as typeof globalThis & { EvilCore: { stateOf(b: unknown): string } }).EvilCore.stateOf(ed.E.current);
  await lisp('(a ‸b)');
  await ed.type('\\');
  await ed.keys('ESC');
  assert.equal(ed.text(), '(a b)');
  assert.equal(state(), 'normal');
  await lisp('(a ‸b)');
  await ed.type('\\');
  await ed.keys('<left>');
  assert.equal(shown(), '(a‸ b)');
  assert.equal(state(), 'insert');
  assert.doesNotMatch(ed.E.echo, /Non-character/);
  await lisp('(a ‸b)');
  await ed.type('\\');
  await ed.keys('C-g');
  assert.equal(shown(), '(a ‸b)');
  await ed.type('\\(');
  assert.equal(shown(), '(a \\(‸b)');
  await ed.keys('ESC');
});

test('Lisp insertion that would unbalance the brackets is refused; a text already unbalanced is edited as typed', async () => {
  // x between the # and ; of a datum comment would make the ; a line comment over the ).
  await lisp('(a #‸;(b) c)');
  await ed.type('x');
  assert.equal(shown(), '(a #‸;(b) c)');
  assert.equal(ed.E.echo, 'That would unbalance the brackets');
  // Inside a #; datum a bracket goes in as typed, so ( would leave the datum open.
  await lisp('(a #;(b‸) c)');
  await ed.type('(');
  assert.equal(ed.text(), '(a #;(b) c)');
  // Unbalanced already: ) goes in, to repair it, and ( pairs as electric-pair-mode does.
  await lisp('(foo (bar‸\n');
  await ed.type(')');
  assert.equal(shown(), '(foo (bar)‸\n');
  await ed.type(')');
  assert.equal(shown(), '(foo (bar))‸\n');
  assert.ok(balanced(ed.text()));
});

test('Lisp insertion judged on an inner list (a bracket in column 0 inside a form) refuses a ; comment that would run past the list', async () => {
  // Between the # and ; of a datum comment, ) or ] makes the ; a line comment over the list's ) and the (c after
  // it, outside the span: refused, as it is at top level.
  for (const key of [')', ']']) {
    await lisp('(a\n(b #‸;(x)) (c\nd))\n');
    await ed.type(key);
    assert.equal(shown(), '(a\n(b #‸;(x)) (c\nd))\n');
    assert.equal(ed.E.echo, 'That would unbalance the brackets');
  }
  await lisp("(define t\n  '(\n(k #‸;v) (l\n m)))\n");
  await ed.type(')');
  assert.equal(shown(), "(define t\n  '(\n(k #‸;v) (l\n m)))\n");
  assert.equal(ed.E.echo, 'That would unbalance the brackets');
  const t = "(define t\n  '(\n(k #;v) (l\n m)))\n", cls = ed.Ed.lex(t), p = t.indexOf(';v');
  assert.deepEqual(ed.Ed.balanceSpan(t, cls, p, p), [t.indexOf('(k'), t.indexOf(') (l') + 1]);
  assert.equal(ed.Ed.keepsBalance(t, cls, [t.indexOf('(k'), t.indexOf(') (l') + 1], p, p, ')'), false);
  // The same span takes edits that keep its ) a bracket: a letter after the datum, and DEL making #x; a datum.
  await lisp('(a\n(b #;(x) ‸) (c\nd))\n');
  await ed.type('y');
  assert.equal(shown(), '(a\n(b #;(x) y‸) (c\nd))\n');
  await lisp('(a\n(b #x‸;(x)) (c\nd))\n');
  await ed.keys('DEL');
  assert.equal(shown(), '(a\n(b #‸;(x)) (c\nd))\n');
  assert.ok(balanced(ed.text()));
});

test('Lisp deletion: a bracket takes its list, a quote its string, an escape both characters; C-d from inside moves to the start; refused where it would unbalance', async () => {
  const del: [string, string, string][] = [
    ['(a (b c)‸ d)', 'DEL', '(a ‸ d)'], ['(a (‸b c) d)', 'DEL', '(a ‸ d)'], ["(a '(b)‸ d)", 'DEL', '(a ‸ d)'], ['(a (‸) d)', 'DEL', '(a ‸ d)'],
    ['(a ‸(b c) d)', '<deletechar>', '(a ‸ d)'], ["(a '‸(b) d)", '<deletechar>', "(a '‸ d)"],
    // C-d on a closing bracket or quote from inside deletes nothing and moves to the list's or string's start, as
    // lispy's C-d does by default (lispy-delete-sexp-from-within nil).
    ['(a (b c‸) d)', '<deletechar>', '(a ‸(b c) d)'], ["(a '(b‸) d)", '<deletechar>', "(a '‸(b) d)"], ['(a [‸] d)', '<deletechar>', '(a ‸[] d)'],
    ['(f "abc‸")', '<deletechar>', '(f ‸"abc")'], ['(f "‸")', '<deletechar>', '(f ‸"")'],
    ['(f "abc"‸)', 'DEL', '(f ‸)'], ['(f "‸abc")', 'DEL', '(f ‸)'], ['(f "‸")', 'DEL', '(f ‸)'], ['(f ‸"abc")', '<deletechar>', '(f ‸)'],
    ['(f "a\\"‸b")', 'DEL', '(f "a‸b")'], ['(f "a\\‸"b")', 'DEL', '(f "a‸b")'], ['(f "a‸\\"b")', '<deletechar>', '(f "a‸b")'],
    ['(list #\\(‸ x)', 'DEL', '(list ‸ x)'], ['(list ‸#\\) x)', '<deletechar>', '(list ‸ x)'], ['(list ‸#\\space x)', '<deletechar>', '(list ‸ x)'], ['(list #‸\\) x)', '<deletechar>', '(list ‸ x)'],
    ['(a #|‸|# b)', 'DEL', '(a ‸ b)'], ['(a #||#‸ b)', 'DEL', '(a ‸ b)'], ['(a ‸#||# b)', '<deletechar>', '(a ‸ b)'], ['(a #||‸# b)', 'DEL', '(a ‸ b)'],
    ['(a #| c |#‸ b)', 'DEL', '(a ‸ b)'], ['(a #‸| c |# b)', '<deletechar>', '(a ‸ b)'], ['(a #| c‸ |# b)', 'DEL', '(a #| ‸ |# b)'], ['(a #| ( ‸|# b)', '<deletechar>', '(a ‸ b)'],
    ['(el ?\\(‸ x)', 'DEL', '(el ‸ x)'], ['(a ; (b‸\n c)', 'DEL', '(a ; (‸\n c)'], ['(f "a(‸")', 'DEL', '(f "a‸")'],
    // Refused: the ; of a comment over a ), and a newline that would put a bracket into the comment above.
    ['(a ;‸ )\n b)', 'DEL', '(a ;‸ )\n b)'], [';; c\n‸(b\n c)', 'DEL', ';; c\n‸(b\n c)'],
    // The ; of a comment over ))((: refused at top level, where the first ) closes too much; inside two more lists the
    // brackets stay balanced, which only the whole form, lexed again, shows.
    ['(s ;‸))((\n r)', 'DEL', '(s ;‸))((\n r)'], ['(p (q (s ;‸))((\n r)))', 'DEL', '(p (q (s ‸))((\n r)))'],
    // Already unbalanced: as typed.
    ['(a))‸\n', 'DEL', '(a)‸\n'],
  ];
  for (const [before, key, after] of del) {
    await lisp(before);
    await ed.keys(key);
    assert.equal(shown(), after, `${key} in ${JSON.stringify(before)}`);
  }
  // #| typed and DEL straight after give back the text, as ( and " do.
  await lisp('(a ‸ b)');
  await ed.type('#|');
  assert.equal(shown(), '(a #|‸|# b)');
  await ed.keys('DEL');
  assert.equal(shown(), '(a ‸ b)');
  // C-d in Emacs state, and a count.
  await emacsAt('(a ‸(b) (c) d)');
  await ed.keys('C-d');
  assert.equal(shown(), '(a ‸ (c) d)');
  await ed.keys('C-u 2 C-d');
  assert.equal(shown(), '(a ‸ d)');
  await ed.keys('C-z');
  // A count ends at a move to the start, so C-d from inside never goes on to delete the list or string.
  await emacsAt('(a (b c‸) d)');
  await ed.keys('C-u 2 C-d');
  assert.equal(shown(), '(a ‸(b c) d)');
  await ed.keys('C-z');
  await emacsAt('(f "ab‸c")');
  await ed.keys('C-u 3 C-d');
  assert.equal(shown(), '(f ‸"ab")');
  await ed.keys('C-z');
  // A negative count deletes the other way, through the same rules: C-u -2 DEL takes the list and the blank after
  // point, C-u -1 C-d the list before it, and C-u -1 DEL of a comment's ; over a ) is refused.
  await emacsAt('‸(a) (b)');
  await ed.keys('C-u - 2 DEL');
  assert.equal(shown(), '‸(b)');
  await ed.keys('C-z');
  await emacsAt('(a) (b)‸');
  await ed.keys('C-u - 1 C-d');
  assert.equal(shown(), '(a) ‸');
  await ed.keys('C-z');
  await emacsAt('(a ‸; )\n b)');
  await ed.keys('C-u - 1 DEL');
  assert.equal(shown(), '(a ‸; )\n b)');
  assert.equal(ed.E.echo, 'That would unbalance the brackets');
  await ed.keys('C-g C-z');
});

test('Lisp Replace state: a character that would unbalance the brackets, typed or overwritten, is refused; plain characters replace as before', async () => {
  const cases: [string, string, string][] = [
    // Refused: a bracket, a quote, a ; or a backslash that would leave a bracket unmatched, and a bracket overwritten.
    ['(a ‸b)', ')', '(a ‸b)'], ['(a ‸b)', '(', '(a ‸b)'], ['(a ‸b)', ']', '(a ‸b)'], ['(a ‸b)', '"', '(a ‸b)'],
    ['(a ‸b)', ';', '(a ‸b)'], ['(a b‸)', '\\', '(a b‸)'], ['(a ‸(b) c)', 'x', '(a ‸(b) c)'], ['(a (b‸) c)', 'x', '(a (b‸) c)'],
    ['(f ‸"s")', 'x', '(f ‸"s")'], ['(a ‸b)\n', ')', '(a ‸b)\n'],
    // Accepted: plain over plain, a bracket over the same bracket, a bracket or quote in a string or a comment, and
    // a character typed at a line's end, which inserts.
    ['(a ‸b)', 'x', '(a x‸)'], ['(a ‸bc d)', 'xy', '(a xy‸ d)'], ['(a ‸)', ')', '(a )‸'], ['(a "‸b")', '(', '(a "(‸")'],
    ['(a ; ‸b\n c)', ')', '(a ; )‸\n c)'], ['(a b)‸\n', 'x', '(a b)x‸\n'],
  ];
  for (const [before, typed, after] of cases) {
    const k = before.indexOf('‸');
    await buffer('scm', before.slice(0, k) + before.slice(k + 1));
    ed.E.current.pt = k;
    ed.E.echo = '';
    await ed.type('R' + typed);
    assert.equal(shown(), after, `R${typed} in ${JSON.stringify(before)}`);
    if (after === before) assert.equal(ed.E.echo, 'That would unbalance the brackets', `R${typed} in ${JSON.stringify(before)}`);
    await ed.keys('ESC');
  }
  // The reviewer's case: R) then ESC on the b of (a b) leaves it as it was.
  await buffer('scm', '(a b)\n');
  await ed.type('fbR)');
  await ed.keys('ESC');
  assert.equal(ed.text(), '(a b)\n');
  // DEL puts back the replaced character before point, wherever point is now: refused where that would unbalance.
  await buffer('scm', '(a bc)\n');
  ed.E.current.pt = 3;
  await ed.type('Rx');
  await ed.keys('<left> <left> <left> DEL');
  assert.equal(shown(), '(‸a xc)\n');
  assert.equal(ed.E.echo, 'That would unbalance the brackets');
  await ed.keys('<right> <right> <right> DEL');
  assert.equal(shown(), '(a ‸bc)\n');
  await ed.keys('ESC');
});

test('RET in a ; comment goes on with the comment; RET elsewhere is a plain new line', async () => {
  await lisp('(a ;; b‸ (c)\n )');
  await ed.keys('RET');
  assert.equal(shown(), '(a ;; b\n ;; ‸ (c)\n )');
  assert.ok(balanced(ed.text()));
  await lisp('(a ;; b‸\n )');
  await ed.keys('RET');
  assert.equal(shown(), '(a ;; b\n ‸\n )');
  await emacsAt('(a ‸b)');
  await ed.keys('RET');
  assert.equal(shown(), '(a \n ‸b)');
  await ed.keys('C-z');
});

test('the balanced brackets are Lisp buffers\' only: a minibuffer, another mode and electric-pair-mode off type as before', async () => {
  await buffer('scm', 'a)b\n');
  await ed.type(':s/)/x/\n');
  assert.equal(ed.text(), 'axb\n');
  await lisp('x ‸', 'nix');
  await ed.type('(');
  assert.equal(shown(), 'x (‸)');
  await ed.type(')');
  assert.equal(shown(), 'x ()‸');
  await ed.type(')');
  assert.equal(shown(), 'x ())‸');
  ev('(electric-pair-mode -1)');
  try {
    await lisp('(a ‸)');
    await ed.type('(]');
    assert.equal(shown(), '(a (]‸)');
    await ed.keys('DEL DEL');
    assert.equal(shown(), '(a ‸)');
  } finally { ev('(electric-pair-mode 1)'); }
  await lisp('(a ‸)', 'el');
  await ed.type('[');
  assert.equal(shown(), '(a [‸])');
});

test('the list motions: up-list, down-list, forward-list, backward-list, beginning-of-defun, end-of-defun, transpose-sexps', async () => {
  const at = async (text: string, form: string) => {
    const k = text.indexOf('‸');
    await buffer('scm', text.slice(0, k) + text.slice(k + 1));
    ed.E.current.pt = k;
    ev(form);
    return shown();
  };
  assert.equal(await at('(a (b ‸c) d)', '(up-list)'), '(a (b c)‸ d)');
  assert.equal(await at('(a (b ‸c) d)', '(up-list 2)'), '(a (b c) d)‸');
  assert.equal(await at('(a (b ‸c) d)', '(up-list -1)'), '(a ‸(b c) d)');
  assert.equal(await at('(a "(" ‸b)', '(up-list)'), '(a "(" b)‸');
  assert.equal(await at('‸a (b (c))', '(down-list 2)'), 'a (b (‸c))');
  assert.equal(await at('(a (b c)‸ d)', '(down-list -1)'), '(a (b c‸) d)');
  assert.equal(await at('(a #\\( ‸ (b))', '(down-list)'), '(a #\\(  (‸b))');
  assert.equal(await at('‸a (b) c [d]', '(forward-list 2)'), 'a (b) c [d]‸');
  assert.equal(await at('a (b) c [d]‸', '(backward-list)'), 'a (b) c ‸[d]');
  assert.equal(await at("a '(b)‸", '(backward-list)'), "a ‸'(b)");
  for (const [text, form] of [['(a ‸b)', '(down-list)'], ['(a (b) ‸c)', '(forward-list)'], ['(a ‸(b) c)', '(backward-list)'], ['‸a b', '(up-list)']]) {
    await at(text, '#t');
    assert.throws(() => ev(form), /Containing expression ends prematurely/, `${form} in ${text}`);
  }
  const defs = '(define (f)\n  1)\n\n(define (g)\n  (h))\n';
  assert.equal(await at(defs.replace('(h)', '(‸h)'), '(beginning-of-defun)'), defs.replace('(define (g)', '‸(define (g)'));
  assert.equal(await at(defs.replace('(h)', '(‸h)'), '(beginning-of-defun 2)'), '‸' + defs);
  assert.equal(await at(defs.replace('(define (g)', '‸(define (g)'), '(beginning-of-defun)'), '‸' + defs);
  assert.equal(await at(defs.replace('1)', '‸1)'), '(end-of-defun)'), defs.replace('1)\n', '1)\n‸'));
  assert.equal(await at(defs.replace('1)', '‸1)'), '(end-of-defun 2)'), defs + '‸');
  assert.equal(await at(defs.replace('1)\n', '1)\n‸'), '(end-of-defun)'), defs + '‸');
  // A negative count goes the other way, as Emacs's does (emacs -Q --batch, 31.1, on these texts).
  const three = '(a)\n\n(b c)\n\n(d)\n';
  const atPos = (p: number, form: string) => at(three.slice(0, p) + '‸' + three.slice(p), form);
  const mark = (p: number) => three.slice(0, p) + '‸' + three.slice(p);
  assert.equal(await atPos(5, '(beginning-of-defun -1)'), mark(12));
  assert.equal(await atPos(0, '(beginning-of-defun -2)'), mark(12));
  assert.equal(await atPos(13, '(beginning-of-defun -1)'), mark(16));
  assert.equal(await atPos(12, '(end-of-defun -1)'), mark(11));
  assert.equal(await atPos(12, '(end-of-defun -2)'), mark(4));
  assert.equal(await atPos(16, '(end-of-defun -1)'), mark(11));
  assert.equal(await atPos(4, '(end-of-defun -1)'), mark(0));
  assert.equal(await at('(a)\n(b ‸c)\n', '(beginning-of-defun -1)'), '(a)\n(b c)\n‸');
  assert.equal(await at('(a)\n(b ‸c)\n', '(end-of-defun -1)'), '(a)\n‸(b c)\n');
  assert.equal(await at('(a ‸(b c) d)', '(transpose-sexps)'), '((b c) a‸ d)');
  assert.equal(await at('(a b‸)', '#t'), '(a b‸)');
  assert.throws(() => ev('(transpose-sexps)'), /Don't have two things to transpose/);
});

/* A small deterministic generator, so a failure names its seed. */
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; }; }
/* A random balanced Lisp text of 20 pieces drawn with R: lists and vectors (closed in order), strings with escapes,
   character literals, ; #| and #; comments, and lists in column 0, one with a #; datum and code after it. */
const PIECES = ['(a ', '(b ', '[c ', ')', ']', ' "x)y" ', ' "(" ', ' #\\( ', ' #\\) ', ' #\\] ', ' #\\" ', ' #\\; ', ' ?\\( ', ' ; )\n', ' ;; "\n',
  ' #;(z) ', ' #| ( |# ', ' "a\\\\" ', ' "b\\"c" ', ' w ', '\n(d ', '\n(g #;(z) h ', " '(e) ", '\n'];
function randomLisp(r: () => number) {
  let text = '';
  const open: string[] = [];
  for (let i = 0; i < 20; i++) {
    const piece = PIECES[Math.floor(r() * PIECES.length)];
    if (piece === ')' || piece === ']') { if (open.length) text += open.pop(); continue; }
    if (!balanced(piece)) open.push(piece.trimStart()[0] === '(' ? ')' : ']');
    text += piece;
  }
  while (open.length) text += open.pop();
  text += '\n';
  assert.ok(balanced(text), JSON.stringify(text));
  return text;
}
test('property: random keys at random points of random balanced Lisp text, in Insert, Emacs and Replace state, keep it balanced', async () => {
  const insertKeys = ['a', 'SPC', '(', ')', '[', ']', '"', ';', '#', '\\', '|', "'", 'DEL', 'DEL', '<deletechar>', 'RET'];
  const emacsKeys = [...insertKeys, 'C-d', 'C-d'];
  /* Replace state overwrites; <left> and <right> move point away from the replacements, so DEL puts a character back
     elsewhere. */
  const replaceKeys = [...insertKeys, '<left>', '<right>'];
  let changed = 0, refused = 0, keys = 0;
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const r = rng(seed), pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    for (let round = 0; round < 25; round++) {
      const text = randomLisp(r);
      const state = (['insert', 'emacs', 'replace'] as const)[round % 3], ext = r() < 0.5 ? 'scm' : 'el';
      const emacs = state === 'emacs', b = await buffer(ext, text);
      if (emacs) await ed.keys('C-z');
      b.pt = Math.floor(r() * (text.length + 1));
      if (!emacs) await ed.type(state === 'insert' ? 'i' : 'R');
      const typed: string[] = [];
      for (let k = 0; k < 12; k++) {
        const key = pick(emacs ? emacsKeys : state === 'insert' ? insertKeys : replaceKeys), before = ed.text();
        typed.push(key);
        await ed.keys(key);
        keys++;
        if (ed.text() !== before) changed++;
        else if (ed.E.echo === 'That would unbalance the brackets') refused++;
        assert.ok(balanced(ed.text()), `seed ${seed} round ${round}: ${typed.join(' ')} from ${JSON.stringify(text)} gave ${JSON.stringify(ed.text())}`);
      }
      if (emacs) await ed.keys('C-g C-z'); else await ed.keys('C-g ESC');
    }
  }
  console.log(`brackets property: ${keys} keys, ${changed} changed the text, ${refused} refused`);
  assert.ok(changed >= 1000, `${changed} of ${keys} keys changed the text`);
  assert.ok(refused >= 5, `${refused} refused`);
});

/* The guard's soundness, apart from the keys: every edit keepsBalance accepts on balanceSpan's span leaves the whole
   text balanced. Every position of each random text, inserting each of a set of texts and replacing the character
   there with each; the guard judges the span alone, the test the whole text, lexed again. A refusal of an edit that
   would have kept the text balanced is the guard being careful (the ; of a comment two lists down), counted and
   logged, not a failure. */
test('property: every edit the guard accepts, at every point of random balanced Lisp text, leaves the whole text balanced', () => {
  const { balanceSpan, keepsBalance, balancedLisp, lex } = ed.Ed;
  const edits = ['a', ')', ']', '(', '"', ';', '#', '|', '\\', '\n', '#;', '||#', '()', ''];
  let judged = 0, careful = 0;
  for (const seed of [31, 32, 33, 34, 35, 36, 37, 38]) {
    const r = rng(seed);
    for (let round = 0; round < 25; round++) {
      const text = randomLisp(r), cls = lex(text);
      for (let from = 0; from <= text.length; from++) for (const to of [from, Math.min(text.length, from + 1)]) for (const ins of edits) {
        if (from === to && ins === '') continue;
        const span = balanceSpan(text, cls, from, to);
        if (!span) continue;
        judged++;
        const ok = keepsBalance(text, cls, span, from, to, ins), after = text.slice(0, from) + ins + text.slice(to);
        if (ok) assert.ok(balancedLisp(after), `seed ${seed} round ${round}: ${JSON.stringify(ins)} at ${from}..${to} of ${JSON.stringify(text)} accepted, giving ${JSON.stringify(after)}`);
        else if (balancedLisp(after)) careful++;
      }
    }
  }
  console.log(`guard soundness: ${judged} edits judged, ${careful} refused that would have kept the text balanced`);
  assert.ok(judged >= 100000, `${judged} edits judged`);
});

/* The guard's own cost per key: the buffer's lex is brought up to date before each key, untimed, as redisplay does
   after every command, and its time is logged apart. That incremental lex restarts at a bracket in column 0, so
   inside one large form it costs in proportion to the form, with or without the guard. */
test('the bracket guard adds at most 2 ms to a keystroke (median of 50) in a 10,000-line Lisp buffer, inside one large indented form too, typing and DEL', async () => {
  const form = (i: number) => `(define (f${i} x)\n  "Doc ${i}."\n  (let ([y #\\(] [z #\\"])\n    #;(old ${i})\n    (list x y z ${i})))\n`;
  let forms = ''; for (let i = 0; i < 2000; i++) forms += form(i);
  const k = forms.indexOf('(list x y z 1000)');
  let data = "(define table\n  '(\n"; for (let i = 0; i < 10000; i++) data += `(e${i} ${i})\n`; data += '))\n';
  let nested = "(define table\n  '(\n"; for (let i = 0; i < 5000; i++) nested += `(e${i}\n(x)\n${i})\n`; nested += '))\n';
  let quoted = "(define table\n  '((e0 \"s\" 0)"; for (let i = 1; i < 10000; i++) quoted += `\n    (e${i} "s" ${i})`; quoted += '))\n';
  let library = '(define-library (big)\n  (export f0)\n  (import (scheme base))\n  (begin\n';
  for (let i = 0; i < 3332; i++) library += `    (define (f${i} x)\n      (let ((y ${i}))\n        (+ x y)))\n`; library += '    ))\n';
  const cases: [string, string, number][] = [
    ['top-level forms', forms, k + 6],
    ['entries of a list in column 0', data, data.indexOf('(e5000 ') + 3],
    ['column-0 lists inside the entries', nested, nested.indexOf('\n2500)') + 3],
    ['a form left open (a buffer being repaired)', forms.slice(0, k) + '(' + forms.slice(k), k + 7],
    ['inside an entry of an indented quoted list', quoted, quoted.indexOf('(e5000 ') + 4],
    ['between the entries of an indented quoted list', quoted, quoted.indexOf('(e5000 ') - 1],
    ['an indented define in an R7RS library', library, library.indexOf('(f1600 x)') + 3],
  ];
  const median = (xs: number[]) => xs.sort((x, y) => x - y)[xs.length >> 1];
  for (const [what, text, at] of cases) {
    await ed.type(':e budget.scm\n');
    const b = ed.E.current;
    ed.Ed.deleteText(b, 0, b.text.length); ed.Ed.insertText(b, text); b.pt = at; ed.Ed.lexOf(b);
    await ed.type('i');
    const keys: number[] = [], dels: number[] = [], lexes: number[] = [];
    for (let i = 0; i < 50; i++) {
      let t0 = performance.now(); ed.Ed.lexOf(b); lexes.push(performance.now() - t0);
      t0 = performance.now(); await ed.type(i % 2 ? 'x' : ' '); keys.push(performance.now() - t0);
    }
    assert.equal(b.text.length, text.length + 50, `${what}: every key went in`);
    for (let i = 0; i < 50; i++) {
      ed.Ed.lexOf(b);
      const t0 = performance.now(); await ed.keys('DEL'); dels.push(performance.now() - t0);
    }
    await ed.keys('ESC');
    assert.equal(b.text, text, `${what}: every DEL took one character`);
    const key = median(keys), del = median(dels);
    console.log(`bracket guard, ${what}: key median ${key.toFixed(3)} ms (max ${keys[49].toFixed(3)}), DEL median ${del.toFixed(3)} ms, the buffer's lex ${median(lexes).toFixed(3)} ms`);
    assert.ok(key <= 2, `${what}: key median ${key} ms`);
    assert.ok(del <= 2, `${what}: DEL median ${del} ms`);
    ed.Ed.deleteText(b, 0, b.text.length); b.modified = false;
  }
});
