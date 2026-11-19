// Node 24: node tools/text-bench.mts [small|large] [index|find|miss|replace]
// Start in a fresh process for each size. No files, UI, services, or timing assertions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startEdwin } from '../test/headless.mts';

const [size = 'large', only] = process.argv.slice(2);
assert(['small', 'large'].includes(size) && (!only || ['index', 'find', 'miss', 'replace'].includes(only)));
const blockSize = size === 'small' ? 512 : 1024 * 1024;
const line = 'some ordinary text, with enough lines for scrolling and lookup.\n';
const block = 'Token \n' + line.repeat(Math.ceil(blockSize / line.length)).slice(0, blockSize - 8) + '\n';
const text = block.repeat(16);
const ed = await startEdwin({ configDir: null, workers: false });
ed.eval('(switch-to-buffer "bench.txt")');
const b = ed.E.current;
const pivot = 8 * blockSize;

async function bench(name: string, n: number, run: (i: number) => void | Promise<void>) {
  if (only && only !== name) return;
  b.text = text;
  b.pt = 0;
  for (let i = 0; i < 4; i++) await run(i);
  const latencies = [], rope = b.rope.constructor, f = rope.flattens;
  const start = performance.now(), cpu = process.cpuUsage();
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await run(i);
    latencies.push(performance.now() - t);
  }
  const used = process.cpuUsage(cpu), wall = performance.now() - start;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => +latencies[Math.ceil(p * n) - 1].toFixed(3);
  console.log(JSON.stringify({ name, size, chars: b.rope.length, n, p50ms: pct(.5), p95ms: pct(.95), p99ms: pct(.99),
    minMs: pct(1 / n), maxMs: pct(1), opsPerSec: +(n * 1000 / wall).toFixed(1), cpuMs: (used.user + used.system) / 1000,
    // Exact number of new whole-text strings built by Rope; this is not a count of every V8 allocation.
    flattens: rope.flattens - f, peakKiB: process.platform === 'linux'
      ? Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))![1]) : process.resourceUsage().maxRSS }));
}

// Overwrite one character in the interior, then look up point's line and its start as redisplay does.
function edit(i: number) { ed.Ed.editText(b, pivot + 7, 1, i % 2 ? 'a' : 'b'); }
await bench('index', 240, i => {
  edit(i);
  assert.equal(b.rope.lineStart(b.rope.lineOf(pivot + 10)), pivot + 7);
});

// Search a recently edited (non-flat) buffer through the actual incremental command, including smart case,
// overlapping search prefixes, and RET. Alternate which direction we approach the same nearby match from.
await bench('find', 80, async i => {
  edit(i);
  const backward = i % 2 !== 0;
  b.pt = pivot + (backward ? 32 : -32);
  ed.Ed.feedKey(backward ? '<cmd:isearch-backward>' : '<cmd:isearch-forward>');
  for (const key of ['t', 'o', 'k', 'e', 'n', 'RET']) ed.Ed.feedKey(key);
  await ed.Ed.whenIdle();
  assert.equal(b.pt, pivot + (backward ? 0 : 5));
});
await bench('miss', 40, async i => {
  edit(i);
  b.pt = 0;
  for (const key of ['<cmd:isearch-forward>', 'z', 'RET']) ed.Ed.feedKey(key);
  await ed.Ed.whenIdle();
  assert.equal(b.pt, 0);
});

// Run the shipped Scheme command, not a JS string replacement. Sixteen separated edits keep lengths stable;
// swap direction on each invocation so every iteration does the same number of searches and replacements.
await bench('replace', 24, i => {
  b.pt = 0;
  ed.eval(i % 2 ? '(replace-string "Value" "Token")' : '(replace-string "Token" "Value")');
  assert.equal(ed.E.echo, 'Replaced 16 occurrences');
  assert.equal(b.rope.slice(pivot, pivot + 5), i % 2 ? 'Token' : 'Value');
});
