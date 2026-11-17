// Ed.syntax (src/syntax.ts): a buffer's syntax tree kept in step with its text through the edit log, with the
// desktop program's host.syntax stood in by one that keeps each tree's text and applies the edits it is given.
// fast-check over random edits, undo, whole-text replacement, a log forgotten and a log trimmed past the tree's
// version: whenever the tree is asked for, the stand-in's text is the buffer's, a run of edits crosses as the one
// span spanOf gives (an edit's inserted text, not the buffer's), and a whole parse happens only when the log
// cannot say what changed. Also: no host.syntax gives null; a grammar change, a refused edit and a killed buffer.
// The tree-sitter side (edit, reparse, the incremental tree against a whole parse) is native/src/syntax.rs's
// cargo tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const calls = { parse: 0, edit: 0, inserted: 0, refuse: false };
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
  free(id: number) { return trees.delete(id); },
};
const host = createHost({ workers: false }) as NodeHost & { syntax?: typeof syntax };
const Ed: Edwin = loadEdwin(host);
const E = Ed.E;

const reset = () => { calls.parse = calls.edit = calls.inserted = 0; calls.refuse = false; };
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

function L() { return (globalThis as unknown as { L: Edwin }).L; }
