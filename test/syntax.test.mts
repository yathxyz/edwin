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
// reason, and consult-imenu using it. The tree-sitter side (edit, reparse, the incremental tree against a whole
// parse) is native/src/syntax.rs's cargo tests; the golden runs and imenu lists of each language with the real
// grammars are natives.rs's (`nix build .#edwin`).
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
const calls = { parse: 0, edit: 0, inserted: 0, query: 0, refuse: false };
/* What the stand-in's highlights query gives: the capture names and, for a tree's text and a segment, the
   captures as synQuery gives them (four numbers each: the name's index, start, end, pattern). */
let hl: { names: string[]; of: (text: string, start: number, end: number) => number[] } | null = null;
/* What its tags query gives: the capture names, and for a tree's text the captures and the match of each (what
   synQuery gives with MATCHES true; without it the matches are left out, as the native side leaves them). */
let tags: { names: string[]; of: (text: string) => { captures: number[]; matches: number[] } } | null = null;
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
    if (kind !== 'highlights' || !hl) throw new Error(`${t.grammar} has no "${kind}" query`);
    calls.query++;
    return { names: hl.names, captures: hl.of(t.text, start, end) };
  },
  free(id: number) { return trees.delete(id); },
};
const host = createHost({ workers: false }) as NodeHost & { syntax?: typeof syntax };
const Ed: Edwin = loadEdwin(host);
const E = Ed.E;

const reset = () => { calls.parse = calls.edit = calls.inserted = calls.query = 0; calls.refuse = false; };
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

/* Last: it boots the image (keymaps, the minibuffer), which the tests above do without. */
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

function L() { return (globalThis as unknown as { L: Edwin }).L; }
