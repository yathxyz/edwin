// Node 24: node tools/render-row-bench.mts /path/to/source-tree [plain|styled]
// Isolate the line builder from DOM layout, painting, vsync and browser process scheduling.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HeadlessEdwin } from '../test/headless.mts';

const { startEdwin } = await import(pathToFileURL(path.resolve(process.argv[2] || '.', 'test/headless.mts')).href);
const ed: HeadlessEdwin = await startEdwin({ configDir: null, workers: false });
ed.eval('(switch-to-buffer "rows.txt") (fundamental-mode)');
const b = ed.E.current;
const group = process.argv[3] || 'plain';
assert(['plain', 'styled'].includes(group));
if (group === 'plain') for (const width of [54, 128, 512, 2048, 8191, 8192, 12288]) {
  // 8192 units including EOL is the existing cache limit; exercise both sides.
  b.text = Array.from({ length: 40 }, (_, i) => String(i).padStart(2, '0') + 'a'.repeat(width - 2) + '\n').join('');
  const mid = 20 * (width + 1) + 13, count = Math.max(24, Math.min(800, Math.floor(8_000_000 / (40 * width))));
  const opts = { active: true, count: 40, pt: mid, cache: null };
  function draw(i: number) {
    opts.pt = mid + (i & 1); // 39 unchanged rows, one moving cursor; same HTML workload in both trees.
    const rows = ed.Ed.renderBuffer(b, opts);
    opts.cache = rows.cache;
    return rows;
  }
  for (let i = 0; i < 32; i++) draw(i);
  const cpu = process.threadCpuUsage();
  for (let i = 0; i < count; i++) draw(i);
  const used = process.threadCpuUsage(cpu), last = draw(0);
  assert.equal(last.length, 40);
  assert.match(last[20].html, /class="cur [^"]*" data-o="13"/);
  console.log(JSON.stringify({ width, count, mainThreadUsPerDraw: (used.user + used.system) / count }));
}

if (group === 'styled') for (const mode of ['markdown', 'org']) {
  const md = mode === 'markdown', n = md ? 16000 : 160;
  b.text = Array.from({ length: n }, (_, i) => md ? `- [ ] TODO ${i} **bold** [[A page]] and \`code\` #tag\n`
    : `* Section ${i}\n` + 'Measurements use a stable sentence for each section.\n'.repeat(128)).join('');
  ed.eval(`(${mode}-mode)`);
  if (!md) ed.eval('(org-overview)');
  const from = md ? ed.Ed.lineStartB(b, n / 2) : ed.Ed.bol(b.rope, b.folds[n / 2].s - 3);
  const views = [{ active: true, from, count: md ? 15 : 33, pt: from + 4, cache: null }];
  if (md) views.push({ active: false, from: ed.Ed.lineStartB(b, n / 4), count: 15, pt: ed.Ed.lineStartB(b, n / 4), cache: null });
  function draw(i: number) {
    if (md) ed.Ed.editText(b, from + 5, 1, i & 1 ? 'a' : 'b');
    views[0].pt = from + 4 + (i & 1);
    for (const v of views) {
      const rows = ed.Ed.renderBuffer(b, v);
      v.cache = rows.cache;
      assert.equal(rows.length, v.count);
    }
  }
  for (let i = 0; i < 96; i++) draw(i);
  const count = 512, cpu = process.threadCpuUsage();
  for (let i = 0; i < count; i++) draw(i);
  const used = process.threadCpuUsage(cpu);
  console.log(JSON.stringify({ mode, count, mainThreadUsPerDraw: (used.user + used.system) / count }));
}
