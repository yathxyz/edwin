// Structural editing in Lisp buffers: the fix track of the Emacs-to-Edwin plan (structural-editing-audit.md in the
// fleet repository; its cases, structural-editing-cases.jsonl, copied here by their ids). se-lexer: the Lisp lexer
// (lex in src/editor-core.ts) reads a character literal whose character is a delimiter (#\( #\" #\;) as one
// character (B1), [ ] as brackets (B4) and #; as a comment over the next datum (B5); the sexp motions, %, = and the
// highlighting read its classes. se-pair-objects: the pair text objects (i( a( i[ ...), ds and cs, and expreg read
// them too, so a bracket in a string, a comment or a character literal is no delimiter (B2); i" passes an escaped
// backslash (B9) and takes a Lisp string over lines; i( and a( again in Visual state grow the selection (B10).
// The Visual-block case operators (~ U u g?) guard evil--block-ranges, which this package once dropped.
// One Edwin per process, so the cases run in order on fresh buffers.
// Run: node --test test/structural.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startEdwin } from './headless.mts';
import type { Edwin } from './headless.mts';

const ed = await startEdwin();
const Ed = ed.Ed;
type Globals = typeof globalThis & { EdPool: Edwin; EvilCore: { stateOf(b: unknown): string } };
const P = (globalThis as Globals).EdPool;
ed.eval('(set! corfu-auto #f)');
let n = 0;
/* A fresh buffer visiting a new file with extension EXT, holding TEXT, point at its start, Normal state. */
async function buffer(ext: string, text: string) {
  if ((globalThis as Globals).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
  await ed.type(`:e st${++n}.${ext}\n`);
  assert.equal(ed.text(), '');
  if (text) Ed.insertText(ed.E.current, text);
  ed.E.current.pt = 0;
  return ed.E.current;
}
/* KEYS as the audit wrote them: "K:NAME" is one key by its name (C-M-f, Escape), anything else is typed. */
async function press(keys: string[]) {
  for (const k of keys) if (k.startsWith('K:')) await ed.keys(k.slice(2) === 'Escape' ? 'ESC' : k.slice(2)); else await ed.type(k);
}
const C = Ed.C;
const classes = (t: string) => Array.from(Ed.lex(t) as Uint8Array);
/* The class of each character of T from FROM to TO, as one string of class numbers. */
const span = (t: string, cls: number[], from: number, to: number) => cls.slice(from, to).join('');
const all = (k: number, len: number) => String(k).repeat(len);

/* [id, extension, input, keys, expected]: the audit's cases. FAILED failed at Edwin 73d9f03 (B1, B4, B5, and
   =G-elisp-vector, which B4 settles: the line inside a vector lines up under its first element); GUARDS passed
   there and must still pass. */
type Case = [string, string, string, string[], string];
const FAILED: Case[] = [
  ["pct-charlit-open", "scm", "(list #\\( x)\n", ["%","iX","K:Escape"], "(list #\\( xX)\n"],
  ["pct-charlit-close", "scm", "(list #\\) x)\n", ["%","iX","K:Escape"], "(list #\\) xX)\n"],
  ["pct-charlit-dquote", "scm", "(list #\\\" x)\n(b)\n", ["%","iX","K:Escape"], "(list #\\\" xX)\n(b)\n"],
  ["pct-charlit-semicolon", "scm", "(list #\\; x)\n", ["%","iX","K:Escape"], "(list #\\; xX)\n"],
  ["pct-datum-comment", "scm", "(a #;(b) c)\n", ["%","iX","K:Escape"], "(a #;(b) cX)\n"],
  ["CMf-charlit", "scm", "(a #\\) b)\n", ["f#","K:C-M-f","iX","K:Escape"], "(a #\\)X b)\n"],
  ["CMf-list-with-charlit", "scm", "(a #\\( b) c\n", ["K:C-M-f","iX","K:Escape"], "(a #\\( b)X c\n"],
  ["CMf-elisp-vector", "el", "(a [b c] d)\n", ["f[","K:C-M-f","iX","K:Escape"], "(a [b c]X d)\n"],
  ["CMf-scheme-brackets", "scm", "(let ([x 1]) x)\n", ["f[","K:C-M-f","iX","K:Escape"], "(let ([x 1]X) x)\n"],
  ["=G-charlit", "scm", "(list #\\(\n1)\n", ["=G"], "(list #\\(\n      1)\n"],
  ["=G-elisp-vector", "el", "(foo [a\nb])\n", ["=G"], "(foo [a\n      b])\n"],
  ["=G-idem-evil-surround-pairs", "scm", "\n(define evil-surround-pairs\n  '((#\\( \"(\" \")\") (#\\) \"(\" \")\") (#\\b \"(\" \")\")\n    (#\\[ \"[\" \"]\") (#\\] \"[\" \"]\")\n    (#\\{ \"{\" \"}\") (#\\} \"{\" \"}\") (#\\B \"{\" \"}\")\n    (#\\< \"<\" \">\") (#\\> \"<\" \">\")\n    (#\\\" \"\\\"\" \"\\\"\") (#\\' \"'\" \"'\") (#\\` \"`\" \"`\"))\n  \"Characters that name a pair, with the strings that open and close it.\nAn opening bracket adds spaces inside; a closing one does not.\")\n", ["=G"], "\n(define evil-surround-pairs\n  '((#\\( \"(\" \")\") (#\\) \"(\" \")\") (#\\b \"(\" \")\")\n    (#\\[ \"[\" \"]\") (#\\] \"[\" \"]\")\n    (#\\{ \"{\" \"}\") (#\\} \"{\" \"}\") (#\\B \"{\" \"}\")\n    (#\\< \"<\" \">\") (#\\> \"<\" \">\")\n    (#\\\" \"\\\"\" \"\\\"\") (#\\' \"'\" \"'\") (#\\` \"`\" \"`\"))\n  \"Characters that name a pair, with the strings that open and close it.\nAn opening bracket adds spaces inside; a closing one does not.\")\n"],
];
const GUARDS: Case[] = [
  ["pct-string-paren", "scm", "(a \")\" b)\n", ["%","iX","K:Escape"], "(a \")\" bX)\n"],
  ["pct-comment-paren", "scm", "(a ; )\n b)\n", ["%","iX","K:Escape"], "(a ; )\n bX)\n"],
  ["pct-elisp-charlit", "el", "(list ?\\( x)\n", ["%","iX","K:Escape"], "(list ?\\( xX)\n"],
  ["pct-block-comment", "scm", "(a #| ) |# c)\n", ["%","iX","K:Escape"], "(a #| ) |# cX)\n"],
  ["pct-unbalanced", "scm", "(foo (bar\n", ["%","iX","K:Escape"], "X(foo (bar\n"],
  ["pct-bracket-scm", "scm", "(let ([x 1]) x)\n", ["f[","%","iX","K:Escape"], "(let ([x 1X]) x)\n"],
  ["di[", "scm", "(let ([x 1]) x)\n", ["fx","di["], "(let ([]) x)\n"],
  ["CMf-string", "scm", "(a \"x)y\" b)\n", ["f\"","K:C-M-f","iX","K:Escape"], "(a \"x)y\"X b)\n"],
  ["CMu", "scm", "(a (b c) d)\n", ["fc","K:C-M-u","iX","K:Escape"], "(a X(b c) d)\n"],
  ["CMu-string-paren", "scm", "(a \"(\" b)\n", ["fb","K:C-M-u","iX","K:Escape"], "X(a \"(\" b)\n"],
  ["count-CMf", "scm", "(a) (b) c\n", ["2","K:C-M-f","iX","K:Escape"], "(a) (b)X c\n"],
  ["CMf-unbalanced", "scm", "(foo (bar\n", ["K:C-M-f","iX","K:Escape"], "X(foo (bar\n"],
  ["CMb-2", "scm", "(a) (b c) d\n", ["fd","K:C-M-b","iX","K:Escape"], "(a) X(b c) d\n"],
  ["pct-elisp-charlit-dquote", "el", "(list ?\\\" x)\n", ["%","iX","K:Escape"], "(list ?\\\" xX)\n"],
  ["di[-elisp", "el", "(a [b (c) d] e)\n", ["fb","di["], "(a [] e)\n"],
];
for (const [label, cases] of [['failed at 73d9f03', FAILED], ['a guard', GUARDS]] as const)
  for (const [id, ext, input, keys, expected] of cases)
    test(`audit case ${id} (${label})`, async () => {
      await buffer(ext, input);
      await press(keys);
      assert.equal(ed.text(), expected);
    });

test('B1: after (list #\\" x) the next line is code, not a string, and each delimiter after #\\ is one character', () => {
  const t = '(list #\\" x)\n(b)\n', cls = classes(t);
  assert.equal(cls[t.indexOf('(b)')], C.PAR);
  assert.equal(span(t, cls, 6, 9), all(C.NUM, 3));
  for (const d of ['(', ')', '[', ']', '"', ';', "'", '`', ',', ' ', '\\']) {
    const u = `(f #\\${d} y)`, c = classes(u);
    assert.equal(span(u, c, 3, 6), all(C.NUM, 3), `#\\${d} is one character literal`);
    assert.equal(c[u.length - 1], C.PAR, `#\\${d}: the list closes at its )`);
    assert.equal(Ed.forwardSexp(u, c, 0), u.length, `#\\${d}: C-M-f crosses the whole list`);
    assert.equal(Ed.backwardSexp(u, c, u.length), 0, `#\\${d}: C-M-b back to its start`);
    assert.equal(Ed.forwardSexp(u, c, 3), 6, `#\\${d}: C-M-f over the literal alone`);
    assert.equal(Ed.backwardSexp(u, c, 6), 3, `#\\${d}: C-M-b over the literal alone`);
  }
  // A name runs to the next delimiter; a delimiter character ends the literal at once.
  for (const [u, len] of [['(f #\\space)', 7], ['(f #\\x41)', 5], ['(f #\\(x)', 3], ['(f #\\a)', 3]] as const) {
    const c = classes(u);
    assert.equal(span(u, c, 3, 3 + len), all(C.NUM, len), u);
    assert.notEqual(c[3 + len], C.NUM, u);
  }
  // #\\ then a string: the string is a string.
  const u = '(f #\\\\ "a)")', c = classes(u);
  assert.equal(span(u, c, 3, 11), all(C.NUM, 3) + '0' + all(C.STR, 4));
  assert.equal(Ed.forwardSexp(u, c, 0), u.length);
  // At the end of the text, #\ alone.
  assert.deepEqual(classes('#\\'), [C.NUM, C.NUM]);
});

test('% in Lisp passes over a bracket in a character literal, a string or a comment to the next real one', async () => {
  for (const [input, keys, expected] of [
    ['(list #\\( x)\n', ['f#', '%', 'iX', 'K:Escape'], 'X(list #\\( x)\n'],
    ['(a ")" b)\n', ['f"', '%', 'iX', 'K:Escape'], 'X(a ")" b)\n'],
    ['(a ; ] [\n b)\n', ['f;', '%'], '(a ; ] [\n b)\n'],
  ] as const) {
    await buffer('scm', input);
    await press([...keys]);
    assert.equal(ed.text(), expected, input);
  }
  assert.equal(ed.point(), 3, 'no bracket after the comment on its line: point stays');
});

test('B4: [ ] are brackets for the motions, up-list, the depths and %', async () => {
  const t = '(a [b (c) d] e)', cls = classes(t);
  assert.equal(cls[3], C.PAR); assert.equal(cls[11], C.PAR);
  assert.equal(Ed.forwardSexp(t, cls, 3), 12);
  assert.equal(Ed.backwardSexp(t, cls, 12), 3);
  assert.equal(Ed.upList(t, cls, 5), 3);
  assert.equal(Ed.matchParen(t, cls, 3), 11);
  assert.equal(Ed.matchParen(t, cls, 11), 3);
  // One depth for both kinds, as Emacs's scan-lists: ( closed by ] is crossed (show-paren marks it, below).
  const m = '(a ]', mc = classes(m);
  assert.equal(Ed.forwardSexp(m, mc, 0), 4);
  // The rainbow depths count [ too.
  const b = await buffer('scm', '(a [b (c)])\n');
  Ed.lexOf(b);
  assert.deepEqual([0, 3, 6, 8, 9, 10].map(k => (b._ld as Uint8Array)[k]), [0, 1, 2, 2, 1, 0]);
  // % from a [ in an Emacs Lisp vector, and from inside it.
  await buffer('el', '(a [b c] d)\n');
  await press(['f[', '%', 'iX', 'K:Escape']);
  assert.equal(ed.text(), '(a [b cX] d)\n');
  await buffer('el', '(a [b c] d)\n');
  await press(['fb', '%', 'iX', 'K:Escape']);
  assert.equal(ed.text(), '(a X[b c] d)\n', 'from inside, % goes to the next bracket on the line, ], and on to its [');
});

test('B5: #; comments out the next datum: a list, a vector, an atom, a string, a quoted datum, a character literal, over lines', () => {
  const t = '(a #;(b) c)', cls = classes(t);
  assert.equal(span(t, cls, 3, 8), all(C.CMT, 5));
  assert.equal(cls[10], C.PAR);
  assert.equal(Ed.forwardSexp(t, cls, 2), 10, 'C-M-f from after a crosses the comment and c');
  assert.equal(Ed.backwardSexp(t, cls, 10), 9, 'C-M-b from after c stops at c');
  assert.equal(Ed.backwardSexp(t, cls, 9), 1, 'C-M-b from before c crosses the comment to a');
  for (const [u, end] of [['#;x y', 3], ['#; "a)b" y', 8], ["#;'(1 2) y", 8], ['#;#\\( y', 5], ['#;[a (b)] y', 9], ['#; ; note\n (a) y', 14]] as const) {
    const c = classes(u);
    for (let k = 0; k < end; k++) if (!/\s/.test(u[k])) assert.equal(c[k], C.CMT, `${JSON.stringify(u)} at ${k}`);
    assert.equal(c[u.length - 1], C.PLAIN, `${JSON.stringify(u)}: y after it is code`);
  }
  // A vector, bytevector or record literal is one datum, as the reader takes #( whole.
  for (const [u, end] of [['#;#(a b) c', 8], ['#;#u8(1 2) c', 10], ["#;'#(a) x", 7], ['#;#s(r 1) c', 9], ['(a #;#(1 2) b)', 11]] as const) {
    const c = classes(u), from = u.indexOf('#;');
    for (let k = from; k < end; k++) if (!/\s/.test(u[k])) assert.equal(c[k], C.CMT, `${JSON.stringify(u)} at ${k}`);
    assert.notEqual(c[end + 1], C.CMT, `${JSON.stringify(u)}: the datum after it is code`);
    assert.equal(Ed.forwardSexp(u, c, from), from === 0 ? u.length : end + 2, `${JSON.stringify(u)}: C-M-f crosses the comment and the next datum`);
  }
  // A run of #; is lexed in linear time: each character is filled once (the quadratic fill took about 1.2 s).
  const run = '#;'.repeat(200000) + 'x '.repeat(200000), t0 = performance.now(), rc = Ed.lex(run) as Uint8Array, ms = performance.now() - t0;
  assert.ok(rc.every((k: number, q: number) => k === C.CMT || run[q] === ' '));
  assert.ok(ms < 600, `${ms.toFixed(0)} ms for 200,000 #; and their data`);
  // Two in a row comment out the two data after them; the third stays.
  const two = '#;#;a b c', tc = classes(two);
  assert.equal(span(two, tc, 0, 7), '1111111');
  assert.equal(tc[8], C.PLAIN);
  // A close bracket before any datum: nothing more is commented, the list closes.
  const none = '(a #;) b', nc = classes(none);
  assert.equal(nc[5], C.PAR);
  assert.equal(Ed.forwardSexp(none, nc, 0), 6);
  assert.equal(nc[7], C.PLAIN);
  // A datum the text ends inside comments out the rest, as an unterminated string does; so does a #; with no datum.
  for (const u of ['#;(a\n(b)\n(c x)\n', '(d) #;  \n']) {
    const c = classes(u), from = u.indexOf('#;');
    for (let k = from; k < u.length; k++) if (!/\s/.test(u[k])) assert.equal(c[k], C.CMT, `${JSON.stringify(u)} at ${k}`);
  }
  // A commented-out definition over lines: no docstring, no defined name, the next form is code.
  const def = '#;(define (f x)\n  "Doc (."\n  x)\n(g)\n', dc = Array.from(Ed.markDocstrings(def, Ed.lex(def)) as Uint8Array);
  assert.ok(dc.slice(0, def.indexOf('\n(g)')).every((k: number, i: number) => k === C.CMT || /\s/.test(def[i])));
  assert.equal(dc[def.indexOf('(g)')], C.PAR);
  // Block comments are crossed whole by C-M-f, not to the end of their line.
  const blk = '(a #| ) |# c)', bc = classes(blk);
  assert.equal(Ed.forwardSexp(blk, bc, 2), 12);
});

test('show-paren: a ( closed by ] shows as a mismatch, a matching pair as a match', async () => {
  const D = Ed.display;
  type Model = { lines: { x: number; w: number; f: number }[][]; faces: { bg?: string }[]; theme: 'light' | 'dark' };
  let model = null as Model | null;
  const frame = Ed.makeFrame(null, { backend: { size: () => ({ cols: 40, rows: 6 }), draw: (m: Model) => { model = m; } } });
  const cell = (m: Model, x: number) => m.lines[0].find(s => x >= s.x && x < s.x + s.w)!;
  try {
    Ed.selectFrame(frame);
    frame.focused = true;
    ed.eval('(set! display-line-numbers #f)');
    /* Point after the closing bracket, so the bracket it shows is not the cursor's cell. */
    for (const [text, x, face] of [['(a ]\n', 3, 'mismatch'], ['[a)\n', 2, 'mismatch'], ['[a]\n', 2, 'paren'], ['(a)\n', 2, 'paren'], ['(#\\] a)\n', 6, 'paren']] as const) {
      const b = Ed.getBufferCreate(`sp-${text}.scm`);
      Ed.setWindowBuffer(b); ed.E.current = b;
      ed.eval('(scheme-mode)');
      b.text = text; b.pt = text.length - 1; ed.E.sel.start = 0;
      Ed.render();
      const m = model as Model, s = cell(m, x);
      assert.equal(m.faces[s.f].bg, D.PALETTE[m.theme][face], `${JSON.stringify(text)}: the bracket at ${x} shows ${face}`);
      if (face === 'paren') { const o = cell(m, 0); assert.equal(m.faces[o.f].bg, D.PALETTE[m.theme].paren, `${JSON.stringify(text)}: its opening bracket too`); }
    }
  } finally {
    Ed.deleteFrame(frame);
  }
});

/* A small deterministic generator, so a failure names its seed. */
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; }; }

/* A docstring is marked from the nearest column-0 paren before an edit, so one whose form starts above a column-0
   paren inside it may come back a plain string: that predates se-lexer and only colours it, so DOC counts as STR. */
const doc = (k: number) => (k === C.DOC ? C.STR : k);
test('the incremental lex agrees with a whole lex after random edits of #;, #\\(, [ ], strings and comments', async () => {
  const pieces = ['#;', '#\\(', '#\\)', '#\\"', '#\\;', '#(', '[', ']', '(', ')', '"', ';', '\n', '\n(', '(define (f)\n  "doc"\n  x)\n', ' ', 'x', '#|', '|#', "'"];
  const base = '(define (a x)\n  "Doc."\n  (list #\\( x [y z]))\n#;(define (b) 1)\n(c #;d e)\n(define (f) #\\" "s")\n';
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = rng(seed), b = await buffer('scm', base.repeat(4)), fresh = Ed.getBufferCreate(`lex-whole-${seed}`);
    Ed.lexOf(b);
    for (let step = 0; step < 150; step++) {
      const t = b.text, at = Math.floor(r() * (t.length + 1));
      if (r() < 0.35 && t.length > 0) { const len = 1 + Math.floor(r() * 3); b.pt = at; Ed.deleteText(b, at, Math.min(t.length, at + len)); }
      else { b.pt = at; Ed.insertText(b, pieces[Math.floor(r() * pieces.length)]); }
      const got = Array.from(Ed.lexOf(b) as Uint8Array, doc), gotD = Array.from((b._ld as Uint8Array).subarray(0, b.text.length));
      fresh.text = b.text; fresh._lc = null;
      const want = Array.from(Ed.lexOf(fresh) as Uint8Array, doc), wantD = Array.from(fresh._ld as Uint8Array);
      if (got.join() !== want.join() || gotD.join() !== wantD.join())
        assert.fail(`seed ${seed} step ${step}: the incremental lex differs from a whole one for ${JSON.stringify(b.text)}`);
    }
  }
});

test('the worker pool\'s lexer (Ed.LEX_SOURCE in a thread, and pool.ts on the main thread) agrees with Ed.lexOf', async () => {
  const text = readFileSync(new URL('../scm/evil.scm', import.meta.url), 'utf8') + '\n(a [b] #;(c) #\\( #\\] "d")\n';
  const b = await buffer('scm', text);
  const want = Array.from(Ed.lexOf(b) as Uint8Array), wantD = Array.from(b._ld as Uint8Array);
  assert.equal(await P.ready, true);
  for (const res of [await P.run('lex', { id: b.id }, { buffers: [b] }), P.local('lex', { id: b.id }, [b])] as { cls: Uint8Array; d: Uint8Array }[]) {
    assert.deepEqual(Array.from(res.cls), want);
    assert.deepEqual(Array.from(res.d), wantD);
  }
});

/* The 1-based numbers of the lines gg=G changes in a Scheme buffer holding TEXT. */
async function reindented(text: string) {
  await buffer('scm', text);
  await ed.type('gg=G');
  const a = text.split('\n'), z = ed.text().split('\n');
  assert.equal(z.length, a.length);
  return a.flatMap((l, i) => (l === z[i] ? [] : [i + 1]));
}

test('gg=G on scm/evil.scm: its character literals no longer move any line', async () => {
  // The same file with every character literal of a delimiter made #\a, which the lexer has always read right.
  const text = readFileSync(new URL('../scm/evil.scm', import.meta.url), 'utf8');
  const plain = text.replace(/#\\[()[\]";'`,{}]/g, '#\\a');
  assert.ok(text.length === plain.length && text !== plain);
  const real = await reindented(text), neutral = await reindented(plain);
  console.log(`gg=G on scm/evil.scm changes ${real.length} of ${text.split('\n').length - 1} lines, as with the literals made #\\a (the indenter's own differences, se-indent's)`);
  assert.deepEqual(real, neutral);
});

test('a keystroke in a 10,000-line Scheme buffer re-lexes in 2 ms (median of 50)', async () => {
  const form = (i: number) => `(define (f${i} x)\n  "Doc ${i}."\n  (let ([y #\\(] [z #\\"])\n    #;(old ${i})\n    (list x y z ${i})))\n`;
  let text = ''; for (let i = 0; i < 2000; i++) text += form(i);
  const b = await buffer('scm', text);
  assert.equal(text.split('\n').length - 1, 10000);
  Ed.lexOf(b);
  ed.eval(`(goto-char ${text.indexOf('(list x y z 1000)') + 6})`);
  await ed.type('i');
  const times = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    await ed.type(i % 2 ? 'x' : ' ');
    Ed.lexOf(b);
    times.push(performance.now() - t0);
  }
  await ed.keys('ESC');
  times.sort((a, c) => a - c);
  console.log(`Lisp lex: median ${times[25].toFixed(3)} ms per keystroke, max ${times[49].toFixed(3)} ms`);
  assert.ok(times[25] <= 2, `median ${times[25]} ms`);
});

/* se-pair-objects: the delimiter text objects (i( a( i[ i{ i" ...), ds and cs, and expreg read the lexer in Lisp
   buffers (B2), i" handles an escaped backslash (B9), and a( or i( again in Visual state grows the selection (B10).
   PAIR_FAILED failed at Edwin 73d9f03 and still at se-lexer (58df99f); PAIR_GUARDS passed at both. */
const PAIR_FAILED: Case[] = [
  ["di(-string-close-paren","scm","(foo \"a)b\" bar)\n",["fr","di("],"()\n"],
  ["di(-string-open-paren","scm","(foo \"a(b\" bar)\n",["fr","di("],"()\n"],
  ["da(-string-paren","scm","(x (foo \"a)b\" bar) y)\n",["fr","da("],"(x  y)\n"],
  ["di(-comment-paren","scm","(foo\n ;; :)\n bar)\n",["jjl","di("],"()\n"],
  ["di(-charlit","scm","(list #\\( x)\n",["fx","di("],"()\n"],
  ["di(-charlit-close","scm","(list #\\) x)\n",["fx","di("],"()\n"],
  ["di(-elisp-charlit","el","(list ?\\( x)\n",["fx","di("],"()\n"],
  ["di\"-escaped-backslash","scm","(f \"a\\\\\" \"b\")\n",["fb","di\""],"(f \"a\\\\\" \"\")\n"],
  ["di\"-multiline","scm","(define (f)\n  \"doc\n  more\"\n  1)\n",["jjw","di\""],"(define (f)\n  \"\"\n  1)\n"],
  ["va(a(-expands","scm","(a (b c) d) e\n",["fb","va(","a(","d"]," e\n"],
  ["ds(-string-paren","scm","(foo \")\" bar)\n",["fb","ds("],"foo \")\" bar\n"],
  ["ds(-charlit","scm","(f #\\) x)\n",["fx","ds("],"f #\\) x\n"],
  ["expreg-string","scm","(foo \"a b\" c)\n",["fa"," v"," v","d"],"(foo \"\" c)\n"],
  ["expreg-string-paren","scm","(f \"x)\" y)\n",["fy"," v"," v","d"],"()\n"],
  ["msg-di(-string","scm","(foo \"a)b\" bar)\n",["fr","di("],"()\n"],
];
const PAIR_GUARDS: Case[] = [
  ["di(-inside","scm","(foo (bar baz) qux)\n",["fb","di("],"(foo () qux)\n"],
  ["da(-inside","scm","(foo (bar baz) qux)\n",["fb","da("],"(foo  qux)\n"],
  ["di(-on-open","scm","(foo (bar baz) qux)\n",["f(","di("],"(foo () qux)\n"],
  ["di(-on-close","scm","(foo (bar baz) qux)\n",["f)","di("],"(foo () qux)\n"],
  ["dib","scm","(foo (bar baz) qux)\n",["fb","dib"],"(foo () qux)\n"],
  ["di(-between-forms","scm","(a (b) (c))\n",["f)","l","di("],"()\n"],
  ["2di(","scm","(a (b c) d)\n",["fb","2di("],"()\n"],
  ["d2i(","scm","(a (b c) d)\n",["fb","d2i("],"()\n"],
  ["d2a(","scm","(a (b c) d) e\n",["fb","d2a("]," e\n"],
  ["ci(-empty","scm","(a () b)\n",["f(","ci(","X","K:Escape"],"(a (X) b)\n"],
  ["di(-empty","scm","(a () b)\n",["f(","di("],"(a () b)\n"],
  ["di(-linewise","scm","(\n  bar\n  baz\n)\n",["j","di("],"(\n)\n"],
  ["ya(-p","scm","(a (b c) d)\n",["fb","ya(","$","p"],"(a (b c) d)(b c)\n"],
  ["di{-nix","nix","{ a = 1; b = { c = 2; }; }\n",["fc","di{"],"{ a = 1; b = {}; }\n"],
  ["di\"","scm","(foo \"bar baz\" qux)\n",["fa","di\""],"(foo \"\" qux)\n"],
  ["da\"","scm","(foo \"bar baz\" qux)\n",["fa","da\""],"(foo qux)\n"],
  ["di\"-escaped-quote","scm","(foo \"a\\\"b\" c)\n",["fa","di\""],"(foo \"\" c)\n"],
  ["vi(d","scm","(a (b c) d)\n",["fb","vi(","d"],"(a () d)\n"],
  ["ci(-dot","scm","(a b) (c d)\n",["l","ci(","X","K:Escape","f(","l","."],"(X) (X)\n"],
  ["di(-undo","scm","(a (b c) d)\n",["fb","di(","u"],"(a (b c) d)\n"],
  ["di(-unbalanced","scm","(foo (bar\n",["fb","di("],"(foo (bar\n"],
  ["ysa()-wrap-list","scm","(a b) c\n",["ysa()"],"((a b)) c\n"],
  ["ci\"-from-before","scm","(f \"abc\")\n",["ci\"","X","K:Escape"],"(f \"X\")\n"],
  ["ds(","scm","(foo (bar) baz)\n",["fb","ds("],"(foo bar baz)\n"],
  ["ds(-on-open","scm","(a (b) c)\n",["ds("],"a (b) c\n"],
  ["ds(-trims","scm","( foo )\n",["fo","ds("],"foo\n"],
  ["ds\"","scm","(a \"b c\" d)\n",["fb","ds\""],"(a b c d)\n"],
  ["cs([","scm","(foo (bar) baz)\n",["fb","cs(["],"(foo [ bar ] baz)\n"],
  ["cs(]","scm","(foo (bar) baz)\n",["fb","cs(]"],"(foo [bar] baz)\n"],
  ["cs\"'","scm","(a \"b c\" d)\n",["fb","cs\"'"],"(a 'b c' d)\n"],
  ["ds(-dot","scm","(a) (b)\n",["l","ds(","f(","."],"a b\n"],
  ["cs([-dot","scm","(a) (b)\n",["l","cs([","f(","l","."],"[ a ] [ b ]\n"],
  ["ds(-undo","scm","(foo (bar) baz)\n",["fb","ds(","u"],"(foo (bar) baz)\n"],
  ["cs([-undo","scm","(foo (bar) baz)\n",["fb","cs([","u"],"(foo (bar) baz)\n"],
  ["expreg-2","scm","(foo (bar baz) qux)\n",["fb"," v"," v","d"],"(foo () qux)\n"],
  ["expreg-3","scm","(foo (bar baz) qux)\n",["fb"," v"," v"," v","d"],"(foo  qux)\n"],
  ["expreg-4","scm","(foo (bar baz) qux)\n",["fb"," v"," v"," v"," v","d"],"()\n"],
  ["expreg-contract","scm","(foo (bar baz) qux)\n",["fb"," v"," v"," V","d"],"(foo ( baz) qux)\n"],
  ["expreg-el","el","(a (b c))\n",["fb"," v"," v","d"],"(a ())\n"],
  ["ctl-SPCv","scm","(foo (bar baz) qux)\n",["fb"," v","d"],"(foo ( baz) qux)\n"],
];
for (const [label, cases] of [['failed at 58df99f', PAIR_FAILED], ['a guard', PAIR_GUARDS]] as const)
  for (const [id, ext, input, keys, expected] of cases)
    test(`audit case ${id} (${label})`, async () => {
      await buffer(ext, input);
      await press(keys);
      assert.equal(ed.text(), expected);
    });

/* Whether the Lisp text T is balanced: its brackets never close more than they opened and end closed, and no
   string, block comment or datum comment runs to its end. */
function balanced(t: string) {
  const info: { dirty?: boolean } = {}, cls = Ed.lex(t, info) as Uint8Array;
  let d = 0;
  for (let k = 0; k < t.length; k++) if (cls[k] === C.PAR) { d += '(['.includes(t[k]) ? 1 : -1; if (d < 0) return false; }
  return d === 0 && !info.dirty;
}
test('no case of the suite that starts from a balanced Lisp buffer leaves it unbalanced', async () => {
  let n = 0;
  for (const [id, ext, input, keys] of [...FAILED, ...GUARDS, ...PAIR_FAILED, ...PAIR_GUARDS]) {
    if (ext !== 'scm' && ext !== 'el') continue;
    if (!balanced(input)) continue;
    await buffer(ext, input);
    await press(keys);
    assert.ok(balanced(ed.text()), `${id}: ${JSON.stringify(ed.text())}`);
    n++;
  }
  assert.ok(n >= 60, `${n} cases`);
});

test('i( a( i[ ds( cs([ and d i" at random points of random Lisp text keep it balanced', async () => {
  const pieces = ['(a ', '(b ', '[c ', ')', ']', ' "x)y" ', ' "(" ', ' #\\( ', ' #\\) ', ' #\\] ', ' #\\" ', ' ; )\n', ' #;(z) ', ' #| ( |# ', ' "a\\\\" ', ' w '];
  const ops = ['di(', 'da(', 'di[', 'da[', 'ds(', 'ds[', 'cs([', 'cs[(', 'di"', 'da"', 'ci(Q\x1b'];
  let changed = 0;
  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
    const r = rng(seed);
    for (let round = 0; round < 25; round++) {
      // A balanced text: open and close the brackets in order, with atoms, strings, literals and comments between.
      let text = '', open: string[] = [];
      for (let i = 0; i < 24; i++) {
        const piece = pieces[Math.floor(r() * pieces.length)];
        if (piece === ')' || piece === ']') { if (open.length) text += open.pop(); continue; }
        if (piece[0] === '(' || piece[0] === '[') open.push(piece[0] === '(' ? ')' : ']');
        text += piece;
      }
      while (open.length) text += open.pop();
      text += '\n';
      const ext = r() < 0.5 ? 'scm' : 'el';
      assert.ok(balanced(text), JSON.stringify(text));
      const op = ops[Math.floor(r() * ops.length)];
      const b = await buffer(ext, text);
      b.pt = Math.floor(r() * text.length);
      await ed.type(op);
      if ((globalThis as Globals).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
      if (ed.text() !== text) changed++;
      assert.ok(balanced(ed.text()), `seed ${seed} round ${round}: ${op} at ${b.pt} of ${JSON.stringify(text)} gave ${JSON.stringify(ed.text())}`);
    }
  }
  assert.ok(changed >= 50, `${changed} of 200 operations changed the text`);
});

test('B10: i( and a( again in Visual state grow to the next pair out; a one-character selection does not grow', async () => {
  for (const [input, keys, expected] of [
    ['(a (b c) d) e\n', ['fb', 'vi(', 'i(', 'd'], '() e\n'],
    // No pair beyond the outermost: the third a( fails and the selection stays.
    ['(a (b c) d) e\n', ['fb', 'va(', 'a(', 'a(', 'd'], ' e\n'],
    ['(x (a (b c) d))\n', ['fb', 'va(', '2a(', 'd'], '\n'],
    ['(x [a (b c) d])\n', ['fb', 'va(', 'a[', 'd'], '(x )\n'],
    ['(a (b) c)\n', ['fb', 'vi(', 'd'], '(a () c)\n'],
    // vi( on (b) selects one character, which i( cannot tell from a fresh v: it selects b again, not (a ...)'s inside.
    ['(a (b) c)\n', ['fb', 'vi(', 'i(', 'd'], '(a () c)\n'],
    ['(a (b c) d)\n', ['fb', 'vl', 'a(', 'd'], '(a  d)\n'],
  ] as const) {
    await buffer('scm', input);
    await press([...keys]);
    if ((globalThis as Globals).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
    assert.equal(ed.text(), expected, `${keys.join(' ')} on ${JSON.stringify(input)}`);
  }
});

test('a count or Visual growth from a pair in a string or a comment goes on to the lists around it', async () => {
  for (const [input, keys, expected] of [
    ['(display "(hi)" x)\n', ['fh', '2di('], '()\n'],
    ['(display "(hi)" x)\n', ['fh', 'va(', 'a(', 'd'], '\n'],
    ['(f ;; (b) c\n x)\n', ['fb', '2di('], '()\n'],
    ['(f "(a (b))" x)\n', ['fb', '2di('], '(f "()" x)\n'],
    ['(f "(a (b))" x)\n', ['fb', '3di('], '()\n'],
    ['(g (f "(a (b))" x))\n', ['fb', '4di('], '()\n'],
    ['(g (f "(a (b))" x))\n', ['fb', 'va(', '2a(', 'd'], '(g )\n'],
  ] as const) {
    await buffer('scm', input);
    await press([...keys]);
    if ((globalThis as Globals).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
    assert.equal(ed.text(), expected, `${keys.join(' ')} on ${JSON.stringify(input)}`);
  }
});

test('a pair object from linewise Visual selects charwise, and growth from a linewise i( stays inside the outer pair', async () => {
  for (const [input, keys, expected] of [
    ['(a\n (\n  bar\n  baz\n  )\n c)\n', ['jj', 'vi(', 'i(', 'd'], '()\n'],
    ['(a\n (\n  bar\n  baz\n  )\n c)\n', ['jj', 'vi(', 'a(', 'd'], '(a\n \n c)\n'],
    ['(a\n (b\n  c))\n', ['jl', 'V', 'a(', 'd'], '(a\n )\n'],
    ['(a\n (b\n  c)\n d)\n', ['j', 'V', 'j', 'i(', 'd'], '()\n'],
  ] as const) {
    await buffer('scm', input);
    await press([...keys]);
    if ((globalThis as Globals).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
    assert.equal(ed.text(), expected, `${keys.join(' ')} on ${JSON.stringify(input)}`);
  }
});

test('Visual-block case operators (~ U u g?) change each line of the block (evil--block-ranges)', async () => {
  for (const [input, keys, expected] of [
    ['abc\nabc\n', ['K:C-v', 'j', '~'], 'Abc\nAbc\n'],
    ['abc\nabc\n', ['K:C-v', 'jl', 'U'], 'ABc\nABc\n'],
    ['ABC\nABC\n', ['K:C-v', 'jl', 'u'], 'abC\nabC\n'],
    ['abc\nabc\n', ['K:C-v', 'jl', 'g?'], 'noc\nnoc\n'],
  ] as const) {
    await buffer('scm', input);
    await press([...keys]);
    if ((globalThis as Globals).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
    assert.equal(ed.text(), expected, `${keys.join(' ')} on ${JSON.stringify(input)}`);
  }
});

test('B2: in a string or a comment the pair inside it comes first, then the list around it; { } skip strings and literals', async () => {
  for (const [ext, input, keys, expected] of [
    ['scm', ';; (foo bar)\n(x)\n', ['fb', 'di('], ';; ()\n(x)\n'],
    ['scm', '(f "a (b) c")\n', ['fb', 'di('], '(f "a () c")\n'],
    ['scm', '(f "a (b c")\n', ['fb', 'di('], '()\n'],
    ['scm', '(f #\\{ {a "}" b})\n', ['fa', 'di{'], '(f #\\{ {})\n'],
    ['scm', '(f #\\" "a b")\n', ['di"'], '(f #\\" "")\n'],
    ['scm', '(f "a""b c")\n', ['fc', 'di"'], '(f "a""")\n'],
    ['scm', '(f "a""b c")\n', ['fa', 'di"'], '(f """b c")\n'],
    ['scm', '(f "a" x) ; say "hi"\n', ['fh', 'di"'], '(f "a" x) ; say ""\n'],
    ['scm', '(f #\\" x)\n', ['di"'], '(f #\\" x)\n'],
    ['scm', '(f "a" "b")\n', ['f"', 'ds"'], '(f a "b")\n'],
    ['py', 'f("a\\\\", "b")\n', ['fb', 'di"'], 'f("a\\\\", "")\n'],
    ['py', "f('a\\\\', 'b')\n", ['fb', "di'"], "f('a\\\\', '')\n"],
    ['py', 'f("a\\"b", "c")\n', ['fc', 'di"'], 'f("a\\"b", "")\n'],
  ] as const) {
    await buffer(ext, input);
    await press([...keys]);
    assert.equal(ed.text(), expected, `${keys.join(' ')} on ${JSON.stringify(input)}`);
  }
});

test('expreg: the string point is in is a step, and a string elsewhere on the line is not', async () => {
  for (const [input, keys, expected] of [
    ['(foo "a b" c)\n', ['fa', ' v', ' v', ' v', 'd'], '(foo  c)\n'],
    ['(foo "a b" c)\n', ['fa', ' v', ' v', ' v', ' v', 'd'], '()\n'],
    ['(foo x "a b")\n', ['fx', ' v', ' v', 'd'], '()\n'],
    ['(foo "a)" "b(" c)\n', ['fc', ' v', ' v', ' v', 'd'], '\n'],
  ] as const) {
    await buffer('scm', input);
    await press([...keys]);
    if ((globalThis as Globals).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
    assert.equal(ed.text(), expected, `${keys.join(' ')} on ${JSON.stringify(input)}`);
  }
});
