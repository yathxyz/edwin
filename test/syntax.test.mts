// Ed.syntax (src/syntax.ts): a buffer's syntax tree kept in step with its text through the edit log, with the
// desktop program's host.syntax stood in by one that keeps each tree's text and applies the edits it is given.
// fast-check over random edits, undo, whole-text replacement, a log forgotten and a log trimmed past the tree's
// version: whenever the tree is asked for, the stand-in's text is the buffer's, a run of edits crosses as the one
// span spanOf gives (an edit's inserted text, not the buffer's), and a whole parse happens only when the log
// cannot say what changed. Also: no host.syntax gives null; a grammar change, a refused edit and a killed buffer.
// Highlighting (the lexSeg syntax.ts adds), with the stand-in's query giving the captures a test sets: capture
// names to faces, which of one node's captures wins (punctuation last), nodes inside others, a segment inside a
// node begun above it, the cache, a failure, the size bounds (the buffer's and the shown lines'), the mode table
// against the bundle's grammars.json (EDWIN_GRAMMARS) and the frame's side of the 2 ms budget.
// Imenu (Ed.syntax.imenu), with the stand-in's tags query: definitions paired with their names by match, a name
// two patterns take listed once, references left out, null (the patterns of editor-prims instead) for each
// reason, and consult-imenu using it. Expreg (Ed.syntax.nodes, SPC v and SPC V), with the stand-in's nodes: the
// nodes holding a range, innermost first, null for each reason, and the selection grown and shrunk by keys.
// Indentation (Ed.syntax.indents, Ed.syntax.indent), with the stand-in's indents query for a grammar of brackets:
// the innermost holder and its base, @align, @none, @keep, no edit where the blanks are right, the level, an ERROR
// (queried once a re-indent), null for each reason, Python's statement lines (@offside); and RET, o, O, = and TAB
// by keys, in python-mode TAB after TAB too. The tree-sitter side (edit,
// reparse, the incremental tree against a whole parse, the nodes holding a range) is native/src/syntax.rs's cargo tests; the golden runs,
// imenu lists, expreg steps and formatted indent fixtures of each language with the real grammars are natives.rs's
// (`nix build .#edwin`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';

const require = createRequire(import.meta.url);
// fast-check is a dev dependency pinned in tools/package-lock.json (R15.1); NODE_PATH names its node_modules.
const fc = require('fast-check'); // any: fast-check's types are not resolvable from edwin/ (it lives in tools/node_modules)

/* The stand-in: trees by number, each its grammar and text; what crossed is counted. */
type Tree = { grammar: string; text: string };
const trees = new Map<number, Tree>();
let next = 0;
/* SPANS: the range of each indents query, in order. */
const calls = { parse: 0, edit: 0, inserted: 0, query: 0, refuse: false, spans: [] as [number, number][] };
/* What the stand-in's highlights query gives: the capture names and, for a tree's text and a segment, the
   captures as synQuery gives them (four numbers each: the name's index, start, end, pattern). */
let hl: { names: string[]; of: (text: string, start: number, end: number) => number[] } | null = null;
/* What its tags query gives: the capture names, and for a tree's text the captures and the match of each (what
   synQuery gives with MATCHES true; without it the matches are left out, as the native side leaves them). */
let tags: { names: string[]; of: (text: string) => { captures: number[]; matches: number[] } } | null = null;
/* What its nodes give: for a tree's text and a range, the extents of the nodes holding it, innermost first, two
   numbers each (synNodes); null: a grammar whose tree the test does not describe. */
let nd: ((text: string, start: number, end: number) => number[]) | null = null;
/* What its indents query gives: for a tree's text and a range, the captures of the nodes meeting the range;
   null: a grammar with no indents query. */
let ind: ((text: string, start: number, end: number) => { names: string[]; captures: number[] }) | null = null;
const syntax = {
  parse(grammar: string, text: string) { calls.parse++; trees.set(++next, { grammar, text }); return next; },
  edit(id: number, pos: number, del: number, ins: string) {
    const t = trees.get(id);
    if (!t) throw new Error(`no syntax tree ${id}`);
    if (pos < 0 || del < 0 || pos + del > t.text.length) throw new Error('synEdit: past the text');
    if (calls.refuse) { trees.delete(id); throw new Error('parsing took over 1000 ms; the tree is freed'); }
    calls.edit++; calls.inserted += ins.length;
    t.text = t.text.slice(0, pos) + ins + t.text.slice(pos + del);
  },
  query(id: number, kind: string, start: number, end: number, matches?: boolean) {
    const t = trees.get(id);
    if (!t) throw new Error(`no syntax tree ${id}`);
    if (kind === 'tags' && tags) {
      calls.query++;
      const r = tags.of(t.text);
      if (start !== 0 || end !== t.text.length) throw new Error('imenu asks for the whole text');
      return matches ? { names: tags.names, ...r } : { names: tags.names, captures: r.captures };
    }
    if (kind === 'indents' && ind) { calls.query++; calls.spans.push([start, end]); return ind(t.text, start, end); }
    if (kind !== 'highlights' || !hl) throw new Error(`${t.grammar} has no "${kind}" query`);
    calls.query++;
    return { names: hl.names, captures: hl.of(t.text, start, end) };
  },
  nodes(id: number, start: number, end: number) {
    const t = trees.get(id);
    if (!t) throw new Error(`no syntax tree ${id}`);
    if (!(start >= 0 && start <= end && end <= t.text.length)) throw new Error(`nodes asked for ${start}..${end} of ${t.text.length}`);
    if (!nd) throw new Error('the test describes no tree');
    calls.query++;
    return nd(t.text, start, end);
  },
  free(id: number) { return trees.delete(id); },
};
const host = createHost({ workers: false }) as NodeHost & { syntax?: typeof syntax };
const Ed: Edwin = loadEdwin(host);
const E = Ed.E;

const reset = () => { calls.parse = calls.edit = calls.inserted = calls.query = 0; calls.refuse = false; calls.spans = []; };
const fresh = (name: string, text: string) => {
  const b = Ed.getBufferCreate(name);
  Ed.replaceText(b, 0, b.rope.length, text);
  return b;
};
/* The tree, checked against the buffer. */
const tree = (b: Edwin, grammar = 'python') => {
  const id = Ed.syntax.tree(b, grammar);
  assert.equal(trees.get(id)?.text, b.rope.toString(), 'the tree\'s text is the buffer\'s');
  assert.equal(trees.get(id)?.grammar, grammar);
  return id;
};

test('with no tree-sitter in the host (a web frame, edwind) there is no tree', () => {
  const b = fresh('none', 'x = 1\n');
  assert.equal(Ed.syntax.tree(b, 'python'), null);
});

test('edits cross as the span that changed, not as the buffer\'s text', () => {
  host.syntax = syntax; reset();
  const b = fresh('span', 'def f(x):\n    return x\n'.repeat(1000));
  const id = tree(b);
  assert.equal(calls.parse, 1);
  // Nothing changed: no call at all.
  assert.equal(tree(b), id); assert.equal(calls.parse + calls.edit, 1);
  // One insertion: its two characters cross, at its place.
  Ed.replaceText(b, 15, 15, 'yz');
  assert.equal(tree(b), id); assert.deepEqual([calls.parse, calls.edit, calls.inserted], [1, 1, 2]);
  // A run of edits close together joins into one edit spanning them.
  Ed.replaceText(b, 100, 103, ''); Ed.replaceText(b, 110, 110, 'abc'); Ed.replaceText(b, 105, 106, 'Q');
  calls.inserted = 0;
  assert.equal(tree(b), id); assert.equal(calls.edit, 2); assert.ok(calls.inserted <= 15, `${calls.inserted} inserted`);
  // An edit undone by another still crosses (the tree's text is compared, not trusted).
  Ed.replaceText(b, 0, 3, 'DEF'); Ed.replaceText(b, 0, 3, 'def');
  assert.equal(tree(b), id); assert.equal(calls.edit, 3); assert.equal(calls.parse, 1);
});

test('a log that no longer reaches the tree\'s version gives a whole parse; so does a new grammar', () => {
  host.syntax = syntax; reset();
  const b = fresh('log', 'a = 1\n'.repeat(100));
  const first = tree(b);
  Ed.replaceText(b, 0, 1, 'b'); Ed.forgetLog(b);
  const second = tree(b);
  assert.notEqual(second, first); assert.equal(calls.parse, 2); assert.equal(trees.has(first), false, 'the old tree is freed');
  // Past 512 edits the log is trimmed from the front, past the tree's version.
  for (let i = 0; i < 700; i++) Ed.replaceText(b, i % 50, i % 50, 'x');
  assert.ok(Ed.spanOf(b, b.log[0].v - 2) === null, 'the log was trimmed');
  const third = tree(b);
  assert.equal(calls.parse, 3); assert.equal(trees.has(second), false);
  const other = tree(b, 'bash');
  assert.notEqual(other, third); assert.equal(calls.parse, 4); assert.equal(trees.has(third), false);
});

test('an edit the host refuses (its reparse past its bound frees the tree) gives a whole parse', () => {
  host.syntax = syntax; reset();
  const b = fresh('refused', 'x = [1, 2]\n');
  const first = tree(b);
  Ed.replaceText(b, 5, 6, '3'); calls.refuse = true;
  const again = tree(b);
  assert.notEqual(again, first); assert.equal(calls.parse, 2); assert.equal(trees.has(first), false);
});

test('a killed buffer\'s tree is freed before the next whole parse', () => {
  host.syntax = syntax; reset();
  const a = fresh('killed', 'x = 1\n'), id = tree(a);
  L().call('kill-buffer', [a]);
  assert.ok(!E.buffers.includes(a));
  tree(fresh('after-kill', 'y = 2\n'));
  assert.equal(trees.has(id), false);
});

test('fast-check: edits, undo, whole-text replacement and forgotten logs keep the tree\'s text the buffer\'s', () => {
  host.syntax = syntax; reset();
  const pieces = fc.constantFrom('', 'a', 'é', '𝔸', '\n', '    ', 'def f():\n', '"', '𝔸'.charAt(0), '𝔸'.charAt(1), 'xyz');
  const step = fc.oneof(
    fc.record({ t: fc.constant('edit'), at: fc.nat(), del: fc.nat({ max: 8 }), ins: fc.array(pieces, { maxLength: 4 }) }),
    fc.record({ t: fc.constantFrom('tree', 'undo', 'whole', 'forget') }),
  );
  fc.assert(fc.property(fc.array(step, { maxLength: 60 }), fc.string({ maxLength: 40 }), (steps: Edwin[], start: string) => {
    const b = fresh('prop', start);
    tree(b);
    const snaps: Edwin[] = [];
    for (const s of steps) {
      const len = b.rope.length;
      if (s.t === 'edit') {
        const at = s.at % (len + 1);
        snaps.push(Ed.snap(b));
        Ed.replaceText(b, at, Math.min(len, at + s.del), s.ins.join(''));
      } else if (s.t === 'undo' && snaps.length) {
        b.undo.push(snaps.pop()); Ed.undoStep(b);
      } else if (s.t === 'whole') {
        b.text = b.rope.toString().split('').reverse().join('');
      } else if (s.t === 'forget') {
        Ed.forgetLog(b); snaps.length = 0;   // undo cannot reach back past a forgotten log
      } else tree(b);
    }
    tree(b);
  }), { numRuns: Number(process.env.SYNTAX_RUNS || 300) });
});

/* ---------- highlighting ---------- */
/* A buffer in MODE showing TEXT. */
let nb = 0;
const inMode = (mode: string, text: string) => {
  const b = fresh(`hl-${++nb}`, text);
  Ed.switchMajorMode(b, mode);
  return b;
};
/* The classes of B's FROM..TO, as [class, text] runs with a face. */
const faces = (b: Edwin, from = 0, to = b.rope.length) => {
  const lx = Ed.hooks.lexSeg(b, from, to, b.rope.slice(from, to));
  const out: [string, string][] = [];
  if (!lx) return null;
  for (let i = 0; i < lx.cls.length;) {
    let j = i; while (j < lx.cls.length && lx.cls[j] === lx.cls[i]) j++;
    if (lx.names[lx.cls[i]]) out.push([lx.names[lx.cls[i]], b.rope.slice(from + i, from + j)]);
    i = j;
  }
  return out;
};
/* Captures from a list of [name, text, pattern] found in order in the text (the Nth occurrence after the last). */
const fixed = (names: string[], list: [string, string, number][]) => (text: string, start: number, end: number) => {
  const out: number[] = [];
  let at = 0;
  for (const [name, t, p] of list) {
    const s = text.indexOf(t, at); assert.ok(s >= 0, `${t} in the text`);
    if (s < end && s + t.length > start) out.push(names.indexOf(name), s, s + t.length, p);
    at = s;
  }
  return out;
};

test('capture names give faces by their longest known prefix; a predicate\'s, an unknown, a variable\'s and punctuation give none', () => {
  host.syntax = syntax; reset();
  const names = ['function.method.call', 'keyword', '_helper', 'spell', 'variable', 'type.builtin', 'comment.documentation', 'string.special.key', 'punctuation.bracket'];
  hl = { names, of: fixed(names, [['keyword', 'def', 0], ['function.method.call', 'run', 0], ['punctuation.bracket', '(', 0], ['_helper', 'x', 0], ['spell', 'x', 1], ['variable', 'y', 0],
    ['type.builtin', 'int', 0], ['comment.documentation', '# doc', 0], ['string.special.key', 'k', 0]]) };
  const b = inMode('python-mode', 'def run(x) y int # doc k\n');
  assert.deepEqual(faces(b), [['kw', 'def'], ['fn', 'run'], ['ty', 'int'], ['dc', '# doc'], ['pr', 'k']]);
});

test('of one node\'s captures the later pattern wins, or the earlier for the grammars written that way (nix); nodes inside others paint over them', () => {
  host.syntax = syntax; reset();
  const names = ['variable', 'function', 'property', 'string', 'escape', 'embedded'];
  hl = { names, of: fixed(names, [['variable', 'foo', 0], ['function', 'foo', 7], ['string', '"a\\nb ${c}"', 2], ['escape', '\\n', 3], ['embedded', 'c', 4]]) };
  const text = 'foo = "a\\nb ${c}";\n';
  assert.deepEqual(faces(inMode('js-mode', text)), [['fn', 'foo'], ['st', '"a'], ['co', '\\n'], ['st', 'b ${'], ['st', '}"']]);
  assert.deepEqual(faces(inMode('nix-mode', text)), [['st', '"a'], ['co', '\\n'], ['st', 'b ${'], ['st', '}"']], 'nix: the earlier, variable, wins');
  // The order the captures come in does not matter.
  const of = hl.of;
  hl = { names, of: (t, s, e) => { const c = of(t, s, e), out: number[] = []; for (let i = c.length - 4; i >= 0; i -= 4) out.push(...c.slice(i, i + 4)); return out; } };
  assert.deepEqual(faces(inMode('js-mode', text)), [['fn', 'foo'], ['st', '"a'], ['co', '\\n'], ['st', 'b ${'], ['st', '}"']]);
  // A bracket captured as punctuation does not take its node: Nix's interpolation braces are both kw, though its
  // `"}" @punctuation.bracket` comes first.
  const braces = ['punctuation.bracket', 'punctuation.special', 'punctuation.delimiter', 'variable'];
  hl = { names: braces, of: fixed(braces, [['punctuation.delimiter', ';', 1], ['punctuation.special', '${', 7], ['variable', 'c', 2], ['punctuation.bracket', '}', 3], ['punctuation.special', '}', 7]]) };
  assert.deepEqual(faces(inMode('nix-mode', 'a; "${c}"\n')), [['kw', '${'], ['kw', '}']]);
  // Punctuation alone on its node still paints no face over the node around it (C#'s interpolation braces).
  const inner = ['string', 'punctuation.bracket'];
  hl = { names: inner, of: fixed(inner, [['string', '"x{y}"', 0], ['punctuation.bracket', '{', 1], ['punctuation.bracket', '}', 1]]) };
  assert.deepEqual(faces(inMode('csharp-mode', 's = "x{y}";\n')), [['st', '"x'], ['st', 'y'], ['st', '"']]);
  hl = null;
});

test('a segment inside a node begun above it has the node\'s face; only the segment is queried', () => {
  host.syntax = syntax; reset();
  const text = 'x = 1\n/* a\nlong\ncomment */\ny = 2\n';
  const asked: [number, number][] = [];
  hl = { names: ['comment'], of: (t, s, e) => { asked.push([s, e]); const c = t.indexOf('/*'), d = t.indexOf('*/') + 2; return c < e && d > s ? [0, c, d, 0] : []; } };
  const b = inMode('c-mode', text), from = text.indexOf('long'), to = text.indexOf('y');
  assert.deepEqual(faces(b, from, to), [['cm', 'long\ncomment */']]);
  assert.deepEqual(asked, [[from, to]]);
  hl = null;
});

test('the classes of a segment are kept until the buffer or the segment changes; an edit queries again', () => {
  host.syntax = syntax; reset();
  hl = { names: ['keyword'], of: (t, s, e) => { const out: number[] = []; for (const m of t.matchAll(/\bif\b/g)) if (m.index! < e && m.index! + 2 > s) out.push(0, m.index!, m.index! + 2, 0); return out; } };
  const b = inMode('python-mode', 'if x:\n  y\n');
  faces(b); faces(b); assert.equal(calls.query, 1);
  faces(b, 0, 6); assert.equal(calls.query, 2);
  Ed.replaceText(b, 6, 6, 'if ');
  assert.deepEqual(faces(b), [['kw', 'if'], ['kw', 'if']]);
  assert.equal(calls.query, 3); assert.equal(calls.parse, 1, 'the edit crossed as an edit');
  hl = null;
});

test('without host.syntax, in a mode with no grammar, after a failure and past the size bound the lexers before it answer', () => {
  reset();
  const b = inMode('python-mode', 'x = 1\n');
  host.syntax = undefined;
  assert.equal(faces(b), null, 'no host.syntax: a web frame, edwind');
  host.syntax = syntax;
  assert.equal(faces(inMode('text-mode', 'x\n')), null, 'no grammar for the mode');
  // A grammar whose query fails: off for that buffer, and not asked again on the next redraw.
  hl = null;
  assert.equal(faces(b), null);
  const q = calls.query, p = calls.parse;
  Ed.replaceText(b, 0, 0, 'y'); assert.equal(faces(b), null);
  assert.equal(calls.query + calls.parse, q + p, 'not asked again');
  // Another buffer in the mode is highlighted.
  hl = { names: ['number'], of: (t, s, e) => { const i = t.indexOf('1'); return i >= s && i < e ? [0, i, i + 1, 0] : []; } };
  assert.deepEqual(faces(inMode('python-mode', 'x = 1\n')), [['nu', '1']]);
  // Past 4 Mi characters no tree is made.
  const big = inMode('python-mode', 'x = 1\n'.repeat(700000)), before = calls.parse;
  assert.equal(faces(big, 0, 6), null); assert.equal(calls.parse, before);
  // Shown lines past 64 Ki characters (a minified file's one line) are not queried; the buffer's other lines are.
  hl = { names: ['number'], of: (t, s, e) => { const out: number[] = []; for (let i = t.indexOf('1', s); i >= 0 && i < e; i = t.indexOf('1', i + 1)) out.push(0, i, i + 1, 0); return out; } };
  const long = 'x = 1;'.repeat(11000) + '\nx = 1\n', nl = long.indexOf('\n') + 1;
  const lb = inMode('python-mode', long), q1 = calls.query;
  assert.ok(nl > 64 * 1024);
  assert.equal(faces(lb, 0, nl), null); assert.equal(calls.query, q1, 'the long line is not queried');
  assert.deepEqual(faces(lb, nl, long.length), [['nu', '1']]);
  assert.equal(faces(lb, 0, 64 * 1024)!.length, 10922, 'a segment of 64 Ki characters is');
  // The lexers before it still answer for their modes: Org's.
  assert.ok(faces(inMode('org-mode', '* A heading\n'))!.length > 0);
  hl = null;
});

test('the mode table is the grammar bundle\'s (grammars.json\'s modes)', { skip: !process.env.EDWIN_GRAMMARS && 'EDWIN_GRAMMARS names no bundle' }, () => {
  const manifest = JSON.parse(readFileSync(`${process.env.EDWIN_GRAMMARS}/grammars.json`, 'utf8')) as Record<string, { mode: string }>;
  const prog = readFileSync(new URL('../scm/prog.scm', import.meta.url), 'utf8');
  const modes = [...prog.matchAll(/^\(define-language (\S+) /gm)].map(m => m[1]);
  assert.equal(modes.length, Object.keys(manifest).length);
  for (const [name, m] of Object.entries(manifest)) assert.equal(Ed.syntax.grammarOf(m.mode), name, m.mode);
  for (const mode of modes) assert.ok(Ed.syntax.grammarOf(mode), mode);
  assert.equal(Ed.syntax.grammarOf('text-mode'), null);
  assert.equal(Ed.syntax.grammarOf('constructor'), null, 'not an Object property');
});

test('the frame\'s side of the 2 ms budget: a keystroke in 10,000 lines redraws a window\'s faces in 2 ms (median of 50)', () => {
  host.syntax = syntax; reset();
  /* The stand-in's query costs little; what is measured is syntax.ts's and the renderer's work: a capture a
     word of the shown lines, nested in a capture of each line. */
  const names = ['keyword', 'variable', 'function', 'comment'];
  hl = { names, of: (t, s, e) => {
    const out: number[] = [];
    for (let ls = t.lastIndexOf('\n', s) + 1; ls < e;) {
      let le = t.indexOf('\n', ls); if (le < 0) le = t.length;
      out.push(3, ls, le, 0);
      for (const m of t.slice(ls, le).matchAll(/\w+/g)) out.push(m[0] === 'def' ? 0 : m.index! % 3 ? 1 : 2, ls + m.index!, ls + m.index! + m[0].length, 1);
      ls = le + 1;
    }
    return out;
  } };
  const b = inMode('python-mode', 'def f(x, y):\n    return g(x) + h(y) * 2  # note\n'.repeat(5000));
  const mid = b.rope.indexOf('\n', b.rope.length >> 1) + 1;
  const o = { from: mid - 1500, count: 60, runs: true, html: false };
  Ed.renderBuffer(b, o);
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    Ed.replaceText(b, mid + i, mid + i, 'x');
    Ed.renderBuffer(b, o);
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  console.log(`syntax faces: median ${times[25].toFixed(3)} ms, max ${times[49].toFixed(3)} ms per keystroke and redraw of 60 lines`);
  assert.ok(times[25] <= 2, `median ${times[25]} ms`);
  assert.equal(calls.parse, 1);
  hl = null;
});

/* ---------- Org source blocks: each body highlighted with its language's grammar ---------- */
/* A highlights query giving each word of WORDS a keyword and each "string" a string, wherever they are in a
   tree's text (the stand-in does not parse). */
const KW_ST = ['keyword', 'string'];
const wordsQuery = (words: string[]) => ({
  names: KW_ST,
  of: (t: string, s: number, e: number) => {
    const out: number[] = [];
    for (const m of t.matchAll(/"[^"\n]*"|\w+/g)) {
      const a = m.index!, z = a + m[0].length;
      if (a >= e || z <= s) continue;
      if (m[0][0] === '"') out.push(1, a, z, 0); else if (words.includes(m[0])) out.push(0, a, z, 0);
    }
    return out;
  },
});
/* The runs of B's FROM..TO that a block's grammar gave a face ('osb kw', 'osb st', ...). */
const blockFaces = (b: Edwin, from = 0, to = b.rope.length) => faces(b, from, to)!.filter(([c]) => c.startsWith('osb '));
/* The block trees the stand-in holds now: their grammars and texts. */
const liveTrees = () => [...trees.values()];
const NOTE = '* Notes\n#+begin_src python\ndef f(x):\n    return "s"\n#+end_src\nText def "t"\n'
  + '#+begin_src elisp\n(def g ())\n#+end_src\n#+begin_src nosuch\ndef\n#+end_src\n#+begin_src\ndef\n#+end_src\n'
  + '#+BEGIN_SRC sh :results output\necho "hi"\n#+END_SRC\n- item\n  #+begin_src js\n  return "x"\n  #+end_src\n';

test('Org source blocks: a body in its language\'s grammar\'s faces over the block\'s background, its text alone parsed', () => {
  host.syntax = syntax; reset();
  hl = wordsQuery(['def', 'return', 'echo']);
  const b = inMode('org-mode', NOTE);
  const before = new Set(trees.keys());
  assert.deepEqual(blockFaces(b), [['osb kw', 'def'], ['osb kw', 'return'], ['osb st', '"s"'], ['osb kw', 'echo'], ['osb st', '"hi"'],
    ['osb kw', 'return'], ['osb st', '"x"']]);
  // The block's other characters keep the background; text outside blocks, the elisp block (no grammar: Lisp has
  // Edwin's own lexer), an unknown language and a block with none are as before (the runs above are all there are).
  const all = faces(b)!;
  assert.ok(all.some(([c, t]) => c === 'osb' && t === ' f(x):'));
  for (const t of ['(def g ())', 'def']) assert.ok(all.some(([c, s]) => c === 'osb' && s === t), t);
  // One tree a block, of its body's text only, by the grammar its language names (sh: bash, js: javascript).
  const made = [...trees.entries()].filter(([id]) => !before.has(id)).map(([, t]) => [t.grammar, t.text]);
  assert.deepEqual(made, [['python', 'def f(x):\n    return "s"\n'], ['bash', 'echo "hi"\n'], ['javascript', '  return "x"\n']]);
  assert.equal(calls.parse, 3);
  hl = null;
});

test('Org source blocks: a window beginning or ending inside a block has the faces of the whole block\'s tree', () => {
  host.syntax = syntax; reset();
  const asked: [number, number][] = [];
  hl = { names: KW_ST, of: (t, s, e) => { asked.push([s, e]); return t.startsWith('a = """') ? [1, 4, t.indexOf('"""', 7) + 3, 0] : []; } };
  const text = '* H\n#+begin_src python\na = """one\ntwo\nthree"""\n#+end_src\n';
  const b = inMode('org-mode', text);
  const two = text.indexOf('two'), three = text.indexOf('three');
  assert.deepEqual(blockFaces(b, two, three), [['osb st', 'two']], 'begun above the window');
  assert.deepEqual(asked.at(-1), [two - text.indexOf('a = '), three - text.indexOf('a = ')], 'only the shown part is queried');
  assert.deepEqual(blockFaces(b, 0, two), [['osb st', '"""one']], 'ended below it');
  assert.equal(calls.parse, 1, 'one tree for both windows');
  // A headline ends a block left open; so does the buffer's end.
  const open = inMode('org-mode', '#+begin_src python\na = """x"""\n* Next\n');
  assert.deepEqual(blockFaces(open), [['osb st', '"""x"""']]);
  assert.equal(liveTrees().at(-1)!.text, 'a = """x"""\n');
  const tail = inMode('org-mode', '#+begin_src python\na = """y"""');
  assert.deepEqual(blockFaces(tail, tail.rope.indexOf('a')), [['osb st', '"""y"""']]);
  hl = null;
});

test('Org source blocks: no tree-sitter, a failed query or a body past 32 Ki characters leave the block as it was drawn before', () => {
  /* Each character's class, a block grammar's taken back to the block's background. */
  const chars = (b: Edwin) => { const lx = Ed.hooks.lexSeg(b, 0, b.rope.length, b.rope.toString()); return Array.from(lx.cls as Uint8Array, c => lx.names[c].replace(/^osb .*/, 'osb')); };
  host.syntax = undefined;
  const b = inMode('org-mode', NOTE), before = faces(b), beforeChars = chars(b);
  assert.ok(!before!.some(([c]) => c.startsWith('osb ')));
  host.syntax = syntax; reset();
  hl = null; // the stand-in's highlights query fails
  assert.deepEqual(faces(inMode('org-mode', NOTE)), before, 'a failure');
  hl = wordsQuery(['def']);
  const lit = inMode('org-mode', NOTE);
  assert.ok(blockFaces(lit).length > 0);
  assert.deepEqual(chars(lit), beforeChars, 'only the faces are added');
  const big = inMode('org-mode', `#+begin_src python\n${'def x\n'.repeat(6000)}#+end_src\n* After\n`);
  const q = calls.parse;
  assert.deepEqual(blockFaces(big, 0, 200), [], 'past the bound');
  assert.equal(calls.parse, q);
  hl = null;
});

test('Org source blocks: an edit in a block crosses to its tree; a block moved or shown again is not parsed again; at most 32 trees are kept', () => {
  host.syntax = syntax; reset();
  hl = wordsQuery(['def', 'return']);
  const b = inMode('org-mode', '* A\n#+begin_src python\ndef f():\n    return 1\n#+end_src\n');
  blockFaces(b);
  assert.equal(calls.parse, 1);
  const at = b.rope.indexOf('return');
  Ed.replaceText(b, at, at, 'x = 2\n    ');
  assert.deepEqual(blockFaces(b), [['osb kw', 'def'], ['osb kw', 'return']]);
  assert.deepEqual([calls.parse, calls.edit], [1, 1], 'the edit crossed, no parse');
  assert.equal(liveTrees().filter(t => t.grammar === 'python' && t.text.includes('x = 2')).length, 1);
  // A line typed above moves the block: its tree is found by its text.
  Ed.replaceText(b, 0, 0, 'Intro\n');
  blockFaces(b);
  assert.deepEqual([calls.parse, calls.edit], [1, 1]);
  // Many blocks shown one window after another: the trees kept stay at 32, the oldest freed.
  const many = inMode('org-mode', Array.from({ length: 100 }, (_, i) => `#+begin_src python\ndef f${i}():\n    return ${i}\n#+end_src\n`).join(''));
  const held = trees.size;
  for (let p = 0; p < many.rope.length; p = Ed.eol(many.rope, p) + 1) blockFaces(many, p, Math.min(many.rope.length, p + 200));
  assert.equal(calls.parse, 101);
  assert.ok(trees.size <= held + 32 && trees.size >= 32, `${trees.size} trees kept, ${held} before`);
  hl = null;
});

test('Org source blocks: the 2 ms budget in a note of 200 blocks (a keystroke in a block and a redraw of 60 lines, median of 50)', () => {
  host.syntax = syntax; reset();
  hl = wordsQuery(['def', 'return']);
  const block = (i: number) => `** Block ${i}\n#+begin_src python\ndef f(x, y):\n    return g(x) + h(y) * ${i}  # note\n#+end_src\n`;
  const b = inMode('org-mode', Array.from({ length: 200 }, (_, i) => block(i)).join(''));
  const mid = b.rope.indexOf('return', b.rope.indexOf('** Block 100\n'));
  const o = { from: Ed.bol(b.rope, mid) - 30 * 30, count: 60, runs: true, html: false };
  assert.ok(Ed.renderBuffer(b, o).some((l: Edwin) => l.runs.some((r: Edwin) => r.cls === 'osb kw')), 'a keyword drawn');
  const shown = calls.parse;
  assert.ok(shown >= 10 && shown <= 14, `${shown} blocks parsed for one window, not 200`);
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    if (i % 2 === 0) Ed.replaceText(b, mid, mid, 'z'); else Ed.replaceText(b, mid, mid + 1, '');
    Ed.renderBuffer(b, o);
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  console.log(`org source blocks: median ${times[25].toFixed(3)} ms, max ${times[49].toFixed(3)} ms per keystroke and redraw of 60 lines of 200 blocks`);
  assert.ok(times[25] <= 2, `median ${times[25]} ms`);
  assert.equal(calls.parse, shown, 'the keystrokes cross as edits');
  hl = null;
});

/* ---------- imenu: the definitions a tags query names ---------- */
/* A tags query's answer from a list of [match, name, text, pattern], each text found in TEXT at or after the one
   before it: the captures in that order, and the match of each. */
const tagged = (names: string[], list: [number, string, string, number][]) => (text: string) => {
  const captures: number[] = [], matches: number[] = [];
  let at = 0;
  for (const [m, name, t, p] of list) {
    const s = text.indexOf(t, at); assert.ok(s >= 0, `${t} in the text`);
    captures.push(names.indexOf(name), s, s + t.length, p); matches.push(m);
    at = s;
  }
  return { captures, matches };
};
const imenu = (b: Edwin) => Ed.syntax.imenu(b)?.map((it: Edwin) => [it.kind, it.name, it.pos]) ?? null;
const PY = 'class Point:\n    def norm(self):\n        return sqrt(self.x)\n\n# entry\ndef main():\n    def inner():\n        pass\n    run = lambda: inner()\n';
const TAGS = ['name', 'definition.class', 'definition.function', 'definition.method', 'reference.call', 'doc'];
const PY_TAGS = tagged(TAGS, [
  [1, 'definition.class', 'class Point:\n    def norm(self):\n        return sqrt(self.x)', 0], [1, 'name', 'Point', 0],
  // Two patterns take norm: the method's (pattern 1) and the function's (2), each its own match.
  [2, 'definition.method', 'def norm(self):\n        return sqrt(self.x)', 1], [3, 'definition.function', 'def norm(self):\n        return sqrt(self.x)', 2],
  [3, 'name', 'norm', 2], [2, 'name', 'norm', 1],
  [4, 'reference.call', 'sqrt(self.x)', 3], [4, 'name', 'sqrt', 3],
  [5, 'doc', '# entry', 2], [5, 'definition.function', 'def main():\n    def inner():\n        pass\n    run = lambda: inner()', 2],
  [5, 'name', 'main', 2], [6, 'definition.function', 'def inner():\n        pass', 2], [6, 'name', 'inner', 2],
  // A name beside its definition, before it (Nix's binding: the attrpath, then the function).
  [7, 'name', 'run', 4], [7, 'definition.function', 'lambda: inner()', 4],
  [8, 'reference.call', 'inner()', 3], [8, 'name', 'inner', 3],
]);
const PY_ITEMS = [['class', 'Point', 0], ['method', 'norm', PY.indexOf('def norm')], ['function', 'main', PY.indexOf('def main')],
  ['function', 'inner', PY.indexOf('def inner')], ['function', 'run', PY.indexOf('run =')]];

test('imenu: a tags query\'s definitions paired with their names by match, a name two patterns take once (the earlier), no references', () => {
  host.syntax = syntax; reset();
  tags = { names: TAGS, of: PY_TAGS };
  const b = inMode('python-mode', PY);
  assert.deepEqual(imenu(b), PY_ITEMS);
  // The order the captures come in does not matter: the match says which name is whose.
  tags = { names: TAGS, of: t => { const r = PY_TAGS(t), captures: number[] = [], matches: number[] = [];
    for (let i = r.matches.length - 1; i >= 0; i--) { captures.push(...r.captures.slice(4 * i, 4 * i + 4)); matches.push(r.matches[i]); }
    return { captures, matches }; } };
  assert.deepEqual(imenu(b), PY_ITEMS);
  // A name over lines is listed on one; the tree follows an edit.
  tags = { names: TAGS, of: tagged(TAGS, [[1, 'definition.function', 'f(a,\n  b) = 1', 0], [1, 'name', 'f(a,\n  b)', 0]]) };
  const c = inMode('python-mode', 'x\nf(a,\n  b) = 1\n');
  assert.deepEqual(imenu(c), [['function', 'f(a, b)', 2]]);
  Ed.replaceText(c, 0, 0, 'y = 2\n');
  assert.deepEqual(imenu(c), [['function', 'f(a, b)', 8]]);
  assert.equal(calls.parse, 2, 'one parse a buffer; the edit crossed as an edit');
  // A grammar with a tags query and a buffer with no definitions: none, not the patterns of editor-prims.
  tags = { names: TAGS, of: () => ({ captures: [], matches: [] }) };
  assert.deepEqual(imenu(inMode('python-mode', 'Heading\n\nText\n')), []);
  tags = null;
});

test('imenu: no tree, no grammar, no tags query, a failing query or a buffer past the bound gives null; highlighting is left alone', () => {
  reset();
  tags = { names: TAGS, of: PY_TAGS };
  const b = inMode('python-mode', PY);
  host.syntax = undefined;
  assert.equal(imenu(b), null, 'no host.syntax: a web frame, edwind');
  host.syntax = syntax;
  assert.equal(imenu(inMode('text-mode', PY)), null, 'no grammar for the mode');
  // A grammar with no tags query (JSON's, YAML's...), and a query that throws (past its time bound): null, and the
  // buffer is still highlighted.
  hl = { names: ['number'], of: (t, s, e) => { const i = t.indexOf('1'); return i >= s && i < e ? [0, i, i + 1, 0] : []; } };
  tags = null;
  const j = inMode('json-mode', '{"a": 1}\n');
  assert.equal(imenu(j), null);
  assert.deepEqual(faces(j), [['nu', '1']]);
  tags = { names: TAGS, of: () => { throw new Error('the query took over 1000 ms'); } };
  const p = inMode('python-mode', 'x = 1\n');
  assert.equal(imenu(p), null);
  Ed.replaceText(p, 0, 0, ' ');
  assert.deepEqual(faces(p), [['nu', '1']]);
  // Past 4 Mi characters no tree is made.
  tags = { names: TAGS, of: PY_TAGS };
  const big = inMode('python-mode', PY + 'x = 1\n'.repeat(700000)), before = calls.parse;
  assert.equal(imenu(big), null); assert.equal(calls.parse, before);
  // A host whose query gives no matches (an older native side) pairs nothing.
  const older = { ...syntax, query: (id: number, kind: string, s: number, e: number) => syntax.query(id, kind, s, e) };
  host.syntax = older as typeof syntax;
  assert.equal(imenu(b), null);
  host.syntax = syntax;
  tags = hl = null;
});


/* ---------- expreg: the nodes a selection grows by ---------- */
/* A tree of the nodes whose texts LIST names, each the first occurrence of its text: the extents holding a
   range, innermost first, each once, as synNodes gives them. */
const shaped = (list: string[]) => (text: string, start: number, end: number) => {
  const spans = list.map(t => { const s = text.indexOf(t); assert.ok(s >= 0, `${JSON.stringify(t)} in the text`); return [s, s + t.length]; });
  const out: number[] = [];
  for (const [s, e] of spans.filter(([s, e]) => s <= start && e >= end && (start < end || start < e)).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0])))
    if (out[out.length - 2] !== s || out[out.length - 1] !== e) out.push(s, e);
  return out;
};
const NIX = '{ a = [ 1 2 ]; }\n';
const NIX_NODES = shaped(['1', '2', 'a', '[ 1 2 ]', 'a = [ 1 2 ];', '{ a = [ 1 2 ]; }', NIX]);
const PY2 = 'x = foo(\n  a)\ny = 2\n';
const PY2_NODES = shaped(['a', 'foo', '(\n  a)', 'foo(\n  a)', 'x = foo(\n  a)', 'y = 2', PY2]);
const texts = (b: Edwin, ns: [number, number][] | null) => ns && ns.map(([s, e]) => b.rope.slice(s, e));

test('expreg: the nodes holding a range, innermost first; the tree follows an edit; null with no tree, and highlighting is left alone', () => {
  host.syntax = syntax; reset();
  nd = NIX_NODES;
  const b = inMode('nix-mode', NIX), one = NIX.indexOf('1');
  assert.deepEqual(texts(b, Ed.syntax.nodes(b, one, one + 1)), ['1', '[ 1 2 ]', 'a = [ 1 2 ];', '{ a = [ 1 2 ]; }', NIX]);
  assert.deepEqual(texts(b, Ed.syntax.nodes(b, one, one + 3)), ['[ 1 2 ]', 'a = [ 1 2 ];', '{ a = [ 1 2 ]; }', NIX], 'a range over two nodes');
  assert.deepEqual(Ed.syntax.nodes(b, -5, 1e9), [[0, NIX.length]], 'a range past the text is the text');
  // An edit crosses as an edit, and the nodes are the edited text's.
  Ed.replaceText(b, 0, 0, '  ');
  assert.deepEqual(texts(b, Ed.syntax.nodes(b, one + 2, one + 3))!.slice(0, 2), ['1', '[ 1 2 ]']);
  assert.deepEqual([calls.parse, calls.edit], [1, 1]);
  // No tree: no host.syntax (a web frame, edwind), no grammar for the mode, a buffer past the bound.
  host.syntax = undefined;
  assert.equal(Ed.syntax.nodes(b, 0, 1), null);
  host.syntax = syntax;
  assert.equal(Ed.syntax.nodes(inMode('text-mode', NIX), 0, 1), null);
  const before = calls.parse;
  assert.equal(Ed.syntax.nodes(inMode('nix-mode', NIX + ' '.repeat(4 * 1024 * 1024)), 0, 1), null);
  assert.equal(calls.parse, before, 'no parse past the bound');
  // A host that throws gives null, and the buffer is still highlighted.
  hl = { names: ['number'], of: (t, s, e) => { const i = t.indexOf('2'); return i >= s && i < e ? [0, i, i + 1, 0] : []; } };
  nd = null;
  const c = inMode('nix-mode', NIX);
  assert.equal(Ed.syntax.nodes(c, 0, 1), null);
  assert.deepEqual(faces(c), [['nu', '2']]);
  hl = null;
});
/* ---------- indentation ---------- */
/* The stand-in's indents query, for a grammar of brackets: { } an @indent and ( ) an @align, each with its closer
   an @outdent,
[ ] an @indent and a @none, "..." a @keep; a { left open makes the whole text an ERROR with it an @error.open.
   The captures are those of the nodes meeting START..END, as tree-sitter's range gives them. */
const IND = ['indent', 'outdent', 'keep', 'align', 'none', 'open', 'error', 'error.open', 'error.close', 'offside'];
const brackets = (text: string, start: number, end: number) => {
  const captures: number[] = [], open: number[] = [];
  const add = (name: string, s: number, e: number) => { if (s < end && e > start) captures.push(IND.indexOf(name), s, e, 0); };
  for (let i = 0, str = -1; i < text.length; i++) {
    const c = text[i];
    if (str >= 0) { if (c === '"') { add('keep', str, i + 1); str = -1; } continue; }
    if (c === '"') str = i;
    else if ('{(['.includes(c)) open.push(i);
    else if ('})]'.includes(c) && open.length) {
      const o = open.pop()!;
      if (text[o] === '{') { add('indent', o, i + 1); add('outdent', i, i + 1); }
      else if (text[o] === '(') { add('align', o, i + 1); add('outdent', i, i + 1); }
      else { add('indent', o, i + 1); add('none', o, i + 1); }
    }
  }
  if (open.some(o => text[o] === '{')) {
    add('error', 0, text.length);
    for (const o of open) if (text[o] === '{') add('error.open', o, o + 1);
  }
  return { names: IND, captures };
};
const RS = 'fn f(a,\n     b) {\n    if a {\n        g();\n    }\n    [\n    1,\n    ]\n}\n';
const lines = (t: string) => t.split('\n');
const stripped = (t: string) => lines(t).map(l => l.trimStart()).join('\n');
/* B with a level of four spaces (rust-mode's, before the image is booted). */
const spaced = (b: Edwin) => {
  for (const [k, v] of [['evil-shift-width', 4], ['indent-tabs-mode', false]] as const) { Ed.makeLocal(b, k); b.locals!.set(k, v); }
  return b;
};

test('indent: each line by the innermost node holding it, from the base of the line it starts on; a re-indent of indented text changes nothing', () => {
  host.syntax = syntax; reset();
  ind = brackets;
  const b = spaced(inMode('rust-mode', RS));
  // The lines after "(a," go under the a; the block's base is "fn f(a,"'s, the line its "(" closed on began
  // inside; [ ] is a @none, its lines at the block's level; a closing } is at its block's base.
  assert.deepEqual(Ed.syntax.indents(b, 0, RS.length)!.want, lines(RS).map(l => l.slice(0, l.length - l.trimStart().length)));
  const ver = b.ver; b.modified = false;
  assert.equal(Ed.syntax.indent(b, 0, RS.length, false), 9);
  assert.equal(b.ver, ver, 'no edit when the blanks are already right');
  assert.equal(b.modified, false);
  // The same text with no blanks at all comes back.
  const s = spaced(inMode('rust-mode', stripped(RS)));
  Ed.syntax.indent(s, 0, s.rope.length, false);
  assert.equal(s.rope.toString(), RS);
  // One line, with point in its blanks: point goes to its first non-blank character; past them it stays put.
  Ed.replaceText(s, s.rope.indexOf('g();') - 8, s.rope.indexOf('g();'), '');
  s.pt = s.rope.indexOf('g();');
  assert.equal(Ed.syntax.indent(s, s.pt, s.pt, true), 1);
  assert.equal(s.rope.toString(), RS); assert.equal(s.pt, RS.indexOf('g();'));
  Ed.replaceText(s, s.rope.indexOf('g();') - 8, s.rope.indexOf('g();'), '  ');
  s.pt = s.rope.indexOf('();');
  Ed.syntax.indent(s, s.pt, s.pt, true);
  assert.equal(s.pt, RS.indexOf('();'));
  ind = null;
});

test('indent: a base goes up through each line whose holder closed before the node began, however many (nested conditions)', () => {
  host.syntax = syntax; reset();
  ind = brackets;
  // The block's line begins inside (b || c), which closed on it; that line began inside (a && …), closed too: the
  // block's base is the if's line's, and g(); is a level in from it.
  const T = 'fn f() {\n    if (a &&\n        (b ||\n         c)) {\n        g();\n    }\n}\n';
  const b = spaced(inMode('rust-mode', T));
  assert.deepEqual(Ed.syntax.indents(b, 0, T.length)!.want, lines(T).map(l => l.slice(0, l.length - l.trimStart().length)));
  const s = spaced(inMode('rust-mode', stripped(T)));
  Ed.syntax.indent(s, 0, s.rope.length, false);
  assert.equal(s.rope.toString(), T);
  ind = null;
});

test('indent: a level is evil-shift-width spaces, or a tab under indent-tabs-mode (what .editorconfig sets); a string begun above keeps its blanks', () => {
  host.syntax = syntax; reset();
  ind = brackets;
  const text = 'fn f() {\ng(x,\ny);\nlet s = "a\n  b";\n}\n';
  const run = (vars: Record<string, unknown>) => {
    const b = inMode('rust-mode', text);
    for (const [k, v] of Object.entries(vars)) { Ed.makeLocal(b, k); b.locals!.set(k, v); }
    Ed.syntax.indent(b, 0, b.rope.length, false);
    return b.rope.toString();
  };
  assert.equal(run({ 'evil-shift-width': 4, 'indent-tabs-mode': false }), 'fn f() {\n    g(x,\n      y);\n    let s = "a\n  b";\n}\n');
  assert.equal(run({ 'evil-shift-width': 2, 'indent-tabs-mode': false }), 'fn f() {\n  g(x,\n    y);\n  let s = "a\n  b";\n}\n');
  // Under a tab the aligned line takes the tab, then spaces to the column.
  assert.equal(run({ 'evil-shift-width': 4, 'indent-tabs-mode': true }), 'fn f() {\n\tg(x,\n\t  y);\n\tlet s = "a\n  b";\n}\n');
  const b = inMode('rust-mode', text);
  assert.equal(Ed.syntax.indents(b, text.indexOf('  b'), text.indexOf('  b'))!.want[0], null, 'the string\'s line is left alone');
  ind = null;
});

test('indent: while typing, a { left open (an ERROR) holds the lines after it; null with no rules, and highlighting is left alone', () => {
  host.syntax = syntax; reset();
  ind = brackets;
  const b = spaced(inMode('rust-mode', 'fn f() {\nif x {\ng();\n\n'));
  Ed.syntax.indent(b, 0, b.rope.length - 1, true);
  assert.equal(b.rope.toString(), 'fn f() {\n    if x {\n        g();\n        \n');
  // No rules: no host.syntax (a web frame, edwind), a mode with no grammar, no indents query, a host that throws.
  host.syntax = undefined;
  assert.equal(Ed.syntax.indent(b, 0, 1, true), null);
  host.syntax = syntax;
  assert.equal(Ed.syntax.indent(inMode('text-mode', 'a {\nb\n'), 0, 5, true), null);
  ind = null;
  assert.equal(Ed.syntax.indent(inMode('rust-mode', 'a {\nb\n'), 0, 5, true), null);
  hl = { names: ['number'], of: (t, s, e) => { const i = t.indexOf('2'); return i >= s && i < e ? [0, i, i + 1, 0] : []; } };
  ind = () => { throw new Error('query failed'); };
  const c = inMode('rust-mode', 'a {\n2\n');
  assert.equal(Ed.syntax.indent(c, 0, 5, true), null);
  assert.deepEqual(faces(c), [['nu', '2']], 'still highlighted');
  hl = null; ind = null;
});
test('indent: a re-indent queries the lines asked for once and each ERROR once, not each line a base is looked up on (a file with one unclosed bracket costs about what a closed one does)', () => {
  host.syntax = syntax; reset();
  ind = brackets;
  /* An unclosed { at the top makes the whole text one ERROR; each if's { is a holder whose line a base is looked
     up on. The first engine queried each of those lines on its own and, from each, the whole ERROR again. */
  const n = 12, text = 'fn g() {\n' + 'if x {\ng();\n}\n'.repeat(n);
  const b = spaced(inMode('rust-mode', text));
  Ed.syntax.indent(b, 0, text.length, false);
  assert.equal(b.rope.toString(), 'fn g() {\n' + '    if x {\n        g();\n    }\n'.repeat(n));
  assert.deepEqual(calls.spans, [[0, text.length], [0, text.length]], 'the region, then the ERROR');
  /* One line in the middle: the line and the non-blank line before it (its base is on that one), and the ERROR. */
  reset();
  const now = b.rope.toString(), mid = now.indexOf('g();', now.length / 2), ls = Ed.bol(b.rope, mid), above = Ed.bol(b.rope, ls - 1);
  assert.equal(Ed.syntax.indent(b, mid, mid, true), 1);
  assert.deepEqual(calls.spans, [[above, Ed.eol(b.rope, ls) + 1], [0, b.rope.length]]);
  /* A base on a line above those: one query over that line (RS's `if a {` is under `fn f(a,`, two lines up). */
  reset();
  const r = spaced(inMode('rust-mode', RS)), at = RS.indexOf('if a {');
  assert.equal(Ed.syntax.indent(r, at, at, true), 1);
  assert.deepEqual(calls.spans, [[Ed.bol(RS, Ed.bol(RS, at) - 1), Ed.eol(RS, at) + 1], [0, Ed.eol(RS, 0) + 1]]);
  ind = null;
});
/* A stand-in query of the captures CAPS, each [name, start, end] in the text, for the captures the bracket grammar
   has no use for (Nix's). */
const NIXCAPS = ['indent', 'outdent', 'keep', 'keep.all', 'indent.inner', 'indent.twice', 'shift', 'error', 'error.open', 'error.close', 'dedent', 'either', 'align'];
const standIn = (caps: [string, number, number][]) => (_text: string, start: number, end: number) => ({
  names: NIXCAPS,
  captures: caps.filter(([, s, e]) => s < end && e > start).flatMap(([name, s, e]) => [NIXCAPS.indexOf(name), s, e, 0]),
});
/* T's captures: [name, the text the node starts with at its Nth occurrence, the text it ends with after that]. */
const capAt = (t: string, name: string, from: string, to: string, nth = 0): [string, number, number] => {
  let s = -1;
  for (let i = 0; i <= nth; i++) s = t.indexOf(from, s + 1);
  return [name, s, t.indexOf(to, s) + to.length];
};
const reindented = (t: string, caps: [string, number, number][]) => {
  ind = standIn(caps);
  const b = inMode('rust-mode', t);
  for (const [k, v] of [['evil-shift-width', 2], ['indent-tabs-mode', false]] as const) { Ed.makeLocal(b, k); b.locals!.set(k, v); }
  Ed.syntax.indent(b, 0, b.rope.length, false);
  return b.rope.toString();
};
test('indent: Nix\'s captures: @indent.inner no level at the margin, @shift a level when a line would sit at its line\'s, @keep.all over an inner holder (a @keep not), an ERROR\'s pairs of brackets and of let/in and =/;', () => {
  host.syntax = syntax; reset();
  // A lambda's body (@indent.inner): at the margin no level, inside a holder a level in from its line's base.
  assert.equal(reindented('x:\ny\n', [['indent.inner', 0, 4]]), 'x:\ny\n');
  const L = '{\na = x:\ny;\n}\n';
  assert.equal(reindented(L, [capAt(L, 'indent', '{', '}'), capAt(L, 'outdent', '}', '}'), capAt(L, 'indent.inner', 'x:', 'y')]), '{\n  a = x:\n    y;\n}\n');
  // A @shift ( ) whose lines would otherwise sit at its line's level (the }) gives the lines a node begun on its
  // line holds a level more; a } beginning `}:` (a lambda's formals) does not count; nor does one of two lines.
  const caps = (t: string): [string, number, number][] => [capAt(t, 'indent', '(', ')'), capAt(t, 'shift', '(', ')'),
    capAt(t, 'indent', '{', '}'), capAt(t, 'outdent', '}', '}')];
  const P = '(f {\nb\n}\nc)\n';
  assert.equal(reindented(P, caps(P)), '(f {\n    b\n  }\n  c)\n');
  const F = '(f {\nb\n}: c\nd)\n';
  assert.equal(reindented(F, caps(F)), '(f {\n  b\n}: c\n  d)\n');
  const two = '(f {\nb})\n';
  assert.equal(reindented(two, caps(two)), '(f {\n    b})\n');
  // A @keep.all node's lines are kept though an @indent inside it holds them (an interpolation in a '' string); a
  // @keep's only where it is the innermost holder.
  const K = 'x = "a\n   {\n b\n }"\n';
  assert.equal(reindented(K, [['keep.all', K.indexOf('"'), K.lastIndexOf('"') + 1], capAt(K, 'indent', '{', '}'), capAt(K, 'outdent', '}', '}')]), K);
  assert.equal(reindented(K, [['keep', K.indexOf('"'), K.lastIndexOf('"') + 1], capAt(K, 'indent', '{', '}'), capAt(K, 'outdent', '}', '}')]),
    'x = "a\n   {\n     b\n   }"\n');
  // An ERROR: a pair of brackets holds the lines between them, the one left open the lines after it.
  const E = 'f {\na {\nb\n}\nc\n';
  assert.equal(reindented(E, [['error', 0, E.length], capAt(E, 'error.open', '{', '{'), capAt(E, 'error.open', '{', '{', 1),
    capAt(E, 'error.close', '}', '}')]), 'f {\n  a {\n    b\n  }\n  c\n');
  // let pairs with in and = with ; within one level of brackets; a } closes over the = and let left open in it.
  const W = 'let\na =\n1;\nb = 2;\nin\nc\n';
  assert.equal(reindented(W, [['error', 0, W.length], capAt(W, 'error.open', 'let', 'let'), capAt(W, 'error.open', '=', '='),
    capAt(W, 'error.open', '=', '=', 1), capAt(W, 'error.close', ';', ';'), capAt(W, 'error.close', ';', ';', 1),
    capAt(W, 'error.close', 'in', 'in')]), 'let\n  a =\n    1;\n  b = 2;\nin\nc\n');
  const B = 'a = {\nb = 1\n}\nc\n';
  assert.equal(reindented(B, [['error', 0, B.length], capAt(B, 'error.open', '=', '='), capAt(B, 'error.open', '{', '{'),
    capAt(B, 'error.open', '=', '=', 1), capAt(B, 'error.close', '}', '}')]), 'a = {\n  b = 1\n}\n  c\n');
  ind = null;
});
test('indent: @indent.twice two levels in (google-java-format\'s continuation lines), its closer at its base, a block inside it a level in from its own line', () => {
  host.syntax = syntax; reset();
  const J = '{\nx =\ny(\na,\nb);\n}\n';
  const caps = (t: string): [string, number, number][] => [capAt(t, 'indent', '{', '}'), capAt(t, 'outdent', '}', '}'),
    capAt(t, 'indent.twice', 'x =', ';'), capAt(t, 'indent.twice', '(', ')')];
  assert.equal(reindented(J, caps(J)), '{\n  x =\n      y(\n          a,\n          b);\n}\n');
  const C = '{\nf(\nb\n);\n}\n';
  assert.equal(reindented(C, [capAt(C, 'indent', '{', '}', 0), capAt(C, 'outdent', '}', '}'), capAt(C, 'indent.twice', '(', ')'),
    capAt(C, 'outdent', ')', ')')]), '{\n  f(\n      b\n  );\n}\n');
  ind = null;
});
test('indent: @either keeps a @dedent line a level in as well as at its base (shfmt\'s comment before an elif); @align after a node\'s `:` (C++\'s constructor initializers)', () => {
  host.syntax = syntax; reset();
  // The comment at the block's base or a level in is kept; two levels in it goes to the base.
  const caps = (t: string): [string, number, number][] => [capAt(t, 'indent', '{', '}'), capAt(t, 'outdent', '}', '}'),
    capAt(t, 'dedent', '# c', '# c'), capAt(t, 'either', '# c', '# c'), capAt(t, 'dedent', 'else', 'else')];
  for (const [t, want] of [
    ['{\na\n# c\nelse\n}\n', '{\n  a\n# c\nelse\n}\n'],
    ['{\na\n  # c\nelse\n}\n', '{\n  a\n  # c\nelse\n}\n'],
    ['{\na\n    # c\nelse\n}\n', '{\n  a\n# c\nelse\n}\n'],
  ]) assert.equal(reindented(t, caps(t)), want);
  const I = '{\n: a(0),\nb(1) {}\n}\n';
  const end = I.lastIndexOf('}');
  assert.equal(reindented(I, [['indent', 0, end + 1], ['outdent', end, end + 1], capAt(I, 'align', ':', 'b(1)')]),
    '{\n  : a(0),\n    b(1) {}\n}\n');
  ind = null;
});
/* The stand-in's brackets, and the whole text an @offside node: Python's line rules for the lines no bracket or
   string holds. */
const offside = (text: string, start: number, end: number) => {
  const r = brackets(text, start, end);
  return { names: r.names, captures: [...r.captures, IND.indexOf('offside'), 0, text.length, 0] };
};
const PYS = 'def f(a,\n      b):\n    if a:\n        return g(\n            1)\n    elif b:\n        pass\n    else:\n'
  + '        x = 1\n    y = "s\n  t"\n    while y:\n        break\n    try:\n        h()\n    except E:\n        raise\n'
  + '    finally:\n        z = 1 + \\\n            2\n    return z\nw = 0\n';
test('indent: Python\'s statement lines (@offside) by the statement before them; a re-indent keeps each line\'s blanks where they are a level Python takes there', () => {
  host.syntax = syntax; reset();
  ind = offside;
  const b = spaced(inMode('python-mode', PYS));
  assert.deepEqual(Ed.syntax.indents(b, 0, PYS.length)!.want, lines(PYS).map((l, i) => i === 10 ? null : l.slice(0, l.length - l.trimStart().length)));
  const ver = b.ver;
  Ed.syntax.indent(b, 0, PYS.length, false);
  assert.equal(b.ver, ver, 'no edit');
  // [text, re-indented]: under a `:` the one level a level in; else, elif, except, finally and case at a
  // statement's they go with; a level Python does not take there to the likeliest; a backslash's line a level in.
  for (const [text, want] of [
    ['if a:\nb\n', 'if a:\n    b\n'],
    ['if a:\n    b\n      c\n', 'if a:\n    b\n    c\n'],
    ['if a:\n    if b:\n        c\n    d\ne\n', 'if a:\n    if b:\n        c\n    d\ne\n'],
    ['if a:\n    b\n    else:\n        c\n', 'if a:\n    b\nelse:\n    c\n'],
    ['for x in y:\n    if a:\n        b\n        else:\n', 'for x in y:\n    if a:\n        b\n    else:\n'],
    ['if a:\n    b\nc = 1\n    else:\n', 'if a:\n    b\nc = 1\nelse:\n'],
    ['match x:\n    case 1:\n        a\n        case 2:\n', 'match x:\n    case 1:\n        a\n    case 2:\n'],
    ['try:\n    a\n    finally:\n', 'try:\n    a\nfinally:\n'],
    ['def f():\n    return 1\n      x\n', 'def f():\n    return 1\nx\n'],
    ['x = 1 + \\\n2\n', 'x = 1 + \\\n    2\n'],
    ['x = 1 + \\\n        2\n', 'x = 1 + \\\n        2\n'],
    ['x = 1  # a: \\\ny\n', 'x = 1  # a: \\\ny\n'],
    ['x = "a:"\n  y\n', 'x = "a:"\ny\n'],
    ['  x\n', 'x\n'],
    // The levels are the text's own, at another width than evil-shift-width's or in tabs: no block changes.
    ['if a:\n  if b:\n    c\n  d\ne\n', 'if a:\n  if b:\n    c\n  d\ne\n'],
    ['def f():\n  x = 1\n  if y:\n    z\n  w\n', 'def f():\n  x = 1\n  if y:\n    z\n  w\n'],
    ['if a:\n\tb\n\tif c:\n\t\td\n\te\n', 'if a:\n\tb\n\tif c:\n\t\td\n\te\n'],
    ['def f():\n  if a:\n    return\n  x\n', 'def f():\n  if a:\n    return\n  x\n'],
    ['if a:\n  b\n   c\n', 'if a:\n  b\n  c\n'],
  ]) {
    const s = spaced(inMode('python-mode', text));
    Ed.syntax.indent(s, 0, text.length, false);
    assert.equal(s.rope.toString(), want, JSON.stringify(text));
  }
  // A line just opened ('new') takes the likeliest level, not its own; 'cycle' the next level down, then the top.
  const at = (text: string, line: number, how?: 'new' | 'cycle') => {
    const s = spaced(inMode('python-mode', text)), ls = lines(text).slice(0, line).join('\n').length + (line ? 1 : 0);
    Ed.syntax.indent(s, ls, ls, true, how);
    const l = lines(s.rope.toString())[line];
    return l.slice(0, l.length - l.trimStart().length);
  };
  assert.equal(at('def f():\n    x = 1\ny\n', 2), '');
  assert.equal(at('def f():\n    x = 1\ny\n', 2, 'new'), '    ');
  assert.equal(at('def f():\n    return\n\n', 2), '');
  assert.equal(at('def f():\n    if a:\n        return\n\n', 3), '    ');
  assert.equal(at('def f():\n    if a:\n        b\n    \n', 3, 'cycle'), '');
  assert.equal(at('def f():\n    if a:\n        b\n\n', 3, 'cycle'), '        ');
  assert.equal(at('def f():\n    if a:\n        b\n        \n', 3, 'cycle'), '    ');
  assert.equal(at('if a:\n    if b:\n        c\n    else:\n', 3, 'cycle'), '');
  assert.equal(at('if a:\n    if b:\n        c\nelse:\n', 3, 'cycle'), '    ');
  // Two spaces a level in the text: TAB keeps a dedented line, a blank one after return goes one block out, and
  // TAB after TAB steps through the text's own levels.
  assert.equal(at('if a:\n  if b:\n    c\n  d\n', 3), '  ');
  assert.equal(at('def f():\n  if a:\n    return\n\n', 3), '  ');
  assert.equal(at('if a:\n  if b:\n    c\n    \n', 3, 'cycle'), '  ');
  assert.equal(at('if a:\n  if b:\n    c\n  \n', 3, 'cycle'), '');
  assert.equal(at('if a:\n  if b:\n    c\n\n', 3, 'cycle'), '    ');
  // Inside a bracket the bracket's rule, whatever HOW says.
  assert.equal(at('x = g(\n\n)\n', 1, 'cycle'), '    ');
  ind = null;
});
/* Near the end: it boots the image (keymaps, the minibuffer), which the tests above do without. */
test('consult-imenu lists a tree\'s definitions and jumps to the one chosen; without a tags query, its own patterns', async () => {
  host.syntax = syntax; reset();
  Ed.boot({ host });
  await Ed.whenIdle();
  const feed = async (ks: string[]) => { for (const k of ks) Ed.feedKey(k); await Ed.whenIdle(); };
  const keys = (s: string) => feed(Ed.kbd(s).split(' ')), type = (s: string) => feed([...s].map(ch => ch === '\n' ? 'RET' : ch));
  tags = { names: TAGS, of: PY_TAGS };
  const b = inMode('python-mode', PY);
  Ed.setWindowBuffer(b);
  b.pt = PY.length;
  await keys('M-g i');
  assert.ok(E.mini, 'the definition prompt is open');
  await type('inner\n');
  assert.equal(E.mini, null);
  assert.equal(b.pt, PY.indexOf('def inner'));
  // Lisp has no grammar in the bundle: the patterns of editor-prims list its definitions.
  tags = null;
  const s = inMode('scheme-mode', '(define (f x) x)\n(define (g y) y)\n');
  Ed.setWindowBuffer(s);
  await keys('M-g i');
  assert.ok(E.mini);
  await type('g\n');
  assert.equal(s.pt, s.rope.indexOf('(define (g'));
});

/* After the image is booted (the test above). */
test('expreg: SPC v grows the selection by the tree\'s nodes, not by the line, and SPC V shrinks it; with no tree, the steps it had', async () => {
  host.syntax = syntax; reset();
  const feed = async (ks: string[]) => { for (const k of ks) Ed.feedKey(k); await Ed.whenIdle(); };
  const keys = (s: string) => feed(Ed.kbd(s).split(' '));
  const EvilCore = (globalThis as unknown as { EvilCore: Edwin }).EvilCore;
  const run = async (mode: string, text: string, ks: string) => {
    const b = inMode(mode, text);
    Ed.setWindowBuffer(b);
    b.pt = 0;
    if (EvilCore.stateOf(b) !== 'normal') await keys('ESC');
    await keys(ks);
    if (EvilCore.stateOf(b) !== 'normal') await keys('ESC');
    return b.rope.toString();
  };
  nd = NIX_NODES;
  // The audit's expreg-nix-list: from 1, the number, then the list.
  assert.equal(await run('nix-mode', NIX, 'f 1 SPC v SPC v d'), '{ a = ; }\n');
  assert.equal(await run('nix-mode', NIX, 'f 1 SPC v SPC v SPC v d'), '{  }\n');
  assert.equal(await run('nix-mode', NIX, 'f 1 SPC v SPC v SPC v SPC V d'), '{ a = ; }\n');
  // From a selection: the nodes holding it, not point's.
  assert.equal(await run('nix-mode', NIX, 'f [ v f 2 SPC v d'), '{ a = ; }\n');
  assert.equal(await run('nix-mode', NIX, 'f [ v f ] SPC v d'), '{  }\n');
  // From a closing bracket: the list, not the word "];" cutting across it and its binding.
  assert.equal(await run('nix-mode', NIX, 'f ] SPC v d'), '{ a = ; }\n');
  assert.equal(await run('nix-mode', NIX, 'f ] SPC v SPC v d'), '{  }\n');
  // Over lines: the arguments, then the call, where the line steps would have taken "  a)" first.
  nd = PY2_NODES;
  assert.equal(await run('python-mode', PY2, 'j f a SPC v SPC v d'), 'x = foo\ny = 2\n');
  assert.equal(await run('python-mode', PY2, 'j f a SPC v SPC v SPC v d'), 'x = \ny = 2\n');
  // No tree (a web frame, edwind; a host that throws): the word, the WORD, the line.
  nd = null;
  assert.equal(await run('nix-mode', NIX, 'f 1 SPC v SPC v d'), '');
  host.syntax = undefined;
  assert.equal(await run('python-mode', PY2, 'j f a SPC v SPC v d'), 'x = foo(\n  \ny = 2\n');
  host.syntax = syntax;
});

/* After the image is booted. */
test('indent: RET, o, O, = and TAB indent by the tree; RET after {, ( and a closing }, between { and the } electric-pair-mode put opening a line between them; in a string, the line above\'s blanks', async () => {
  host.syntax = syntax; reset();
  ind = brackets;
  const feed = async (ks: string[]) => { for (const k of ks) Ed.feedKey(k); await Ed.whenIdle(); };
  const keys = (s: string) => feed(Ed.kbd(s).split(' ')), type = (s: string) => feed([...s].map(ch => ch === '\n' ? 'RET' : ch === ' ' ? 'SPC' : ch));
  const EvilCore = (globalThis as unknown as { EvilCore: Edwin }).EvilCore;
  const start = async (mode: string, text: string, pt: number) => {
    const b = inMode(mode, text);
    Ed.setWindowBuffer(b);
    if (EvilCore.stateOf(b) !== 'normal') await keys('ESC');
    b.pt = pt;
    return b;
  };
  // Typed: rust-mode's width is 4 (prog.scm); the { puts its }, and RET opens the line between them.
  let b = await start('rust-mode', 'fn f() \n', 7);
  await keys('a'); await type('{\nif x {\ng();');
  assert.equal(b.rope.toString(), 'fn f() {\n    if x {\n        g();\n    }\n}\n');
  assert.equal(b.pt, b.rope.indexOf('g();') + 4);
  // RET after a line's last token: the blanks before point go, and the new line is at the line's level.
  await type('  \n');
  assert.equal(b.rope.toString(), 'fn f() {\n    if x {\n        g();\n        \n    }\n}\n');
  await keys('ESC');
  // RET between ( and its ): the line between them a level in, the ) at the call's line's blanks; after a
  // closing }, the line at the block's level around it.
  b = await start('rust-mode', 'fn f() {\n    g()\n}\n', 15);
  await keys('i'); await type('\nx');
  assert.equal(b.rope.toString(), 'fn f() {\n    g(\n        x\n    )\n}\n');
  await keys('ESC');
  b = await start('rust-mode', 'fn f() {\n    if x {\n        g();\n    }\n}\n', 37);
  await keys('a'); await type('\nh();');
  assert.equal(b.rope.toString(), 'fn f() {\n    if x {\n        g();\n    }\n    h();\n}\n');
  await keys('ESC');
  // In a string the rules leave the line alone: RET takes the line above's blanks.
  b = await start('rust-mode', 'fn f() {\n    let s = "ab";\n}\n', 22);
  await keys('a'); await type('\n');
  assert.equal(b.rope.toString(), 'fn f() {\n    let s = "a\n    b";\n}\n');
  await keys('ESC');
  // With electric-pair-mode off, RET after { gives the next line a level more.
  L().resetOps(); L().evalText('(electric-pair-mode -1)');
  b = await start('rust-mode', 'fn f() \n', 7);
  await keys('a'); await type('{\ng();\n}');
  assert.equal(b.rope.toString(), 'fn f() {\n    g();\n    }\n');
  L().resetOps(); L().evalText('(electric-pair-mode 1)');
  await keys('ESC');
  // o and O.
  b = await start('rust-mode', 'fn f() {\n    g();\n}\n', 0);
  await keys('o'); await type('h();'); await keys('ESC');
  assert.equal(b.rope.toString(), 'fn f() {\n    h();\n    g();\n}\n');
  await keys('G O'); await type('i();'); await keys('ESC');
  assert.equal(b.rope.toString(), 'fn f() {\n    h();\n    g();\n    i();\n}\n');
  // o leaves the line it opens below alone: a line the rules would move keeps its blanks, and those after its
  // last token.
  b = await start('rust-mode', 'fn f() {\n        g();  \n}\n', 12);
  await keys('o'); await type('h();'); await keys('ESC');
  assert.equal(b.rope.toString(), 'fn f() {\n        g();  \n    h();\n}\n');
  // = over the buffer, and TAB on one line.
  b = await start('rust-mode', stripped(RS), 0);
  await keys('g g = G');
  assert.equal(b.rope.toString(), RS);
  b = await start('rust-mode', 'fn f() {\ng();\n}\n', 10);
  await keys('a TAB ESC');
  assert.equal(b.rope.toString(), 'fn f() {\n    g();\n}\n');
  // No rules (a mode with no grammar): = says so, and RET takes the line above's blanks.
  b = await start('text-mode', '  a {\n', 5);
  await keys('A'); await type('\nb'); await keys('ESC');
  assert.equal(b.rope.toString(), '  a {\n  b\n');
  ind = null;
});

/* After the image is booted. */
test('indent: Python by keys: RET after a `:` a level in, after return a level out, a typed else back to its if; TAB after TAB a level down; o and =', async () => {
  host.syntax = syntax; reset();
  ind = offside;
  const feed = async (ks: string[]) => { for (const k of ks) Ed.feedKey(k); await Ed.whenIdle(); };
  const keys = (s: string) => feed(Ed.kbd(s).split(' ')), type = (s: string) => feed([...s].map(ch => ch === '\n' ? 'RET' : ch === ' ' ? 'SPC' : ch));
  const EvilCore = (globalThis as unknown as { EvilCore: Edwin }).EvilCore;
  const start = async (text: string, pt: number) => {
    const b = inMode('python-mode', text);
    Ed.setWindowBuffer(b);
    if (EvilCore.stateOf(b) !== 'normal') await keys('ESC');
    b.pt = pt;
    return b;
  };
  // python-mode's width is 4 (prog.scm).
  let b = await start('\n', 0);
  await keys('i'); await type('def f():\nif a:\nreturn 1\nx = 2');
  assert.equal(b.rope.toString(), 'def f():\n    if a:\n        return 1\n    x = 2\n');
  await keys('ESC');
  b = await start('\n', 0);
  await keys('i'); await type('if a:\nb\nelse:\nc');
  assert.equal(b.rope.toString(), 'if a:\n    b\nelse:\n    c\n');
  await keys('ESC');
  // TAB on the new line keeps the likeliest level; TAB again goes a level down, and after the margin the top.
  b = await start('\n', 0);
  await keys('i'); await type('if a:\nb\n'); await keys('TAB TAB'); await type('c');
  assert.equal(b.rope.toString(), 'if a:\n    b\nc\n');
  await keys('RET TAB TAB TAB'); await type('d');
  assert.equal(b.rope.toString(), 'if a:\n    b\nc\nd\n', 'one level only: the margin, again and again');
  await keys('ESC');
  b = await start('if a:\n    b\n    c\n', 13);
  await keys('I TAB TAB');
  assert.equal(b.rope.toString(), 'if a:\n    b\nc\n', 'a line at a level Python takes: TAB keeps it, TAB again a level down');
  await keys('TAB ESC');
  assert.equal(b.rope.toString(), 'if a:\n    b\n    c\n', 'after the margin, the top');
  // o after a return; = over the buffer.
  b = await start('def f():\n    return 1\n', 10);
  await keys('o'); await type('x'); await keys('ESC');
  assert.equal(b.rope.toString(), 'def f():\n    return 1\nx\n');
  b = await start('if a:\nb\n  c\n', 0);
  await keys('g g = G');
  assert.equal(b.rope.toString(), 'if a:\n    b\n    c\n');
  ind = null;
});

function L() { return (globalThis as unknown as { L: Edwin }).L; }
