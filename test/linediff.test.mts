// The line diff (Rope.diffLines in src/text.ts) and Ed.applyLineDiff (src/editor-core.ts): fast-check over
// random texts. Applying the diff of A to B yields B, through the ops and through a buffer; point and the
// markers on a line the diff leaves alone stay on it, at the same column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin } from './headless.mts';

const require = createRequire(import.meta.url);
// fast-check is a dev dependency pinned in tools/package-lock.json (R15.1); NODE_PATH names its node_modules.
const fc = require('fast-check'); // any: fast-check's types are not resolvable from edwin/ (it lives in tools/node_modules)

const Ed: Edwin = loadEdwin(createHost({ workers: false }));
type Op = [number, number, string];
const diff = (a: string, b: string, limit?: number): Op[] => (globalThis as unknown as { Rope: { diffLines(a: string, b: string, l?: number): Op[] } }).Rope.diffLines(a, b, limit);
const apply = (t: string, ops: Op[]) => ops.reduce((s, [p, d, i]) => s.slice(0, p) + i + s.slice(p + d), t);
/* One buffer for every case, so the runs do not pile up buffers. */
const buf0 = Ed.getBufferCreate('linediff');
function buffer(text: string) { buf0.text = text; buf0.pt = 0; buf0.mark = null; buf0.undo = []; buf0.redo = []; return buf0; }
const RUNS = { numRuns: Number(process.env.LINEDIFF_RUNS || 2000) };

/* Texts from a few lines, so lines repeat as they do in code: empty lines, CR, an astral character. */
const piece = fc.constantFrom('', 'a', 'b', 'ab', '  x', 'x\r', '\u{1F600}', 'a\u{1F600}', '\u{1F601}b');
const text = fc.tuple(fc.array(piece, { maxLength: 30 }), fc.boolean()).map(([ls, nl]: [string[], boolean]) => ls.join('\n') + (nl && ls.length ? '\n' : ''));

test('the diff of A to B applied to A gives B: ops, a buffer, and the whole-replace fallback', () => {
  fc.assert(fc.property(text, text, (a: string, b: string) => {
    for (const limit of [undefined, 3]) {
      const ops = diff(a, b, limit);
      let len = a.length;
      for (const [p, d, i] of ops) { assert.ok(p >= 0 && d >= 0 && p + d <= len); assert.ok(d || i); len += i.length - d; }
      assert.equal(apply(a, ops), b);
      const buf = buffer(a);
      Ed.applyLineDiff(buf, b, undefined, limit);
      assert.equal(buf.text, b);
    }
    assert.deepEqual(diff(a, a), []);
  }), RUNS);
});

test('no op splits a surrogate pair', () => {
  fc.assert(fc.property(text, text, (a: string, b: string) => {
    let t = a;
    for (const op of diff(a, b)) {
      const [p, d] = op, lo = (c: number) => c >= 0xDC00 && c <= 0xDFFF;
      assert.ok(!lo(t.charCodeAt(p)) && !lo(t.charCodeAt(p + d)), JSON.stringify({ a, b, op }));
      t = apply(t, [op]);
    }
  }), RUNS);
});

/* A of unique lines, and B made from it by deleting, changing and inserting lines: every line of A that is
   in B is one the diff must leave alone. */
const edits = fc.array(fc.tuple(fc.constantFrom('keep', 'del', 'chg', 'ins'), fc.nat(5)), { minLength: 1, maxLength: 40 });
test('point and markers on an unchanged line stay on it, at the same column', () => {
  fc.assert(fc.property(edits, fc.nat(), fc.nat(), fc.nat(), (es: [string, number][], r1: number, r2: number, r3: number) => {
    const A: string[] = [], B: string[] = [];
    es.forEach(([e, k], i) => {
      const line = `L${i}` + 'x'.repeat(k);
      if (e !== 'ins') A.push(line);
      if (e === 'keep') B.push(line);
      else if (e === 'chg') B.push(`C${i}`);
      else if (e === 'ins') for (let j = 0; j <= k % 3; j++) B.push(`N${i}.${j}`);
    });
    const kept = A.filter(l => B.includes(l));
    if (!kept.length) return;
    const a = A.join('\n') + '\n', b = B.join('\n') + '\n';
    const at = (t: string, l: string, col: number) => (t.startsWith(l + '\n') ? 0 : t.indexOf('\n' + l + '\n') + 1) + col;
    const pl = kept[r1 % kept.length], pc = r2 % (pl.length + 1);
    const ml = kept[r3 % kept.length], al = kept[(r1 + r3) % kept.length], ac = r3 % (al.length + 1);
    const buf = buffer(a);
    buf.pt = at(a, pl, pc); buf.mark = at(a, ml, 0);
    const before = buf.marker(at(a, ml, 0), 'before'), after = buf.marker(at(a, al, ac), 'after');
    Ed.applyLineDiff(buf, b);
    assert.equal(buf.text, b);
    assert.equal(buf.pt, at(b, pl, pc), 'point');
    assert.equal(buf.mark, at(b, ml, 0), 'the mark');
    assert.equal(before.pos, at(b, ml, 0), 'a before marker at a line start');
    assert.equal(after.pos, at(b, al, ac), 'an after marker');
    before.release(); after.release();
  }), RUNS);
});

test('a before marker moved past inserted lines goes back on undo', () => {
  const buf = buffer('a\nb\nc\n');
  const m = buf.marker(2, 'before');
  buf.undo.push(Ed.snap(buf));
  Ed.applyLineDiff(buf, 'a\nnew\nb\nc\n');
  assert.equal(m.pos, 6);
  Ed.undoStep(buf);
  assert.equal(buf.text, 'a\nb\nc\n');
  assert.equal(m.pos, 2);
});

test('a whole-line edit is a line edit, a changed line is changed in its differing characters', () => {
  assert.deepEqual(diff('a\nb\nc\n', 'a\nc\n'), [[2, 2, '']]);
  assert.deepEqual(diff('a\nb\nc\n', 'a\nb\nx\nc\n'), [[4, 0, 'x\n']]);
  assert.deepEqual(diff('foo bar\nbaz\n', 'foo bat\nbaz\n'), [[6, 1, 't']]);
  // A last line with no newline: lines appended after it change that line.
  assert.deepEqual(diff('a\nb', 'a\nb\nc'), [[3, 0, '\nc']]);
});

test('a large file with two changed lines costs two small ops; a diff past the budget is one span', () => {
  const big = Array.from({ length: 200000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const changed = big.replace('line 10\n', 'line ten\n').replace('line 190000\n', '');
  const t0 = performance.now();
  const ops = diff(big, changed);
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(ops.length, 2);
  assert.equal(apply(big, ops), changed);
  /* every other line changed: far more than the budget's edit distance */
  const other = big.split('\n').map((l, i) => (i % 2 ? l + '!' : l)).join('\n');
  const t1 = performance.now(), one = diff(big, other);
  assert.ok(performance.now() - t1 < 2000);
  assert.equal(one.length, 1);
  assert.equal(apply(big, one), other);
});
