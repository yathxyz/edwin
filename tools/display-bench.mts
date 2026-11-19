// Browser redisplay, Node 24+, no npm packages. CHROMIUM=/path/to/chromium node tools/display-bench.mts
// EDWIN_ROOT=.perf-base selects another checkout; SAMPLES (default 100), WARMUP (20), SCENARIO (substring),
// PROFILE=1 (sampling profiler; use in a separate diagnostic run). One private headless browser, loopback HTTP,
// local fonts and no existing profile. If your Chromium *requires* an unsandboxed launch set NO_SANDBOX=1.
// COVERAGE_DIR=dir records V8 block counts per scenario in a separate diagnostic run (not latency data).
// A synthetic keydown goes through the real textarea, keymap, command loop and DOM redisplay. keyDomMs ends
// when the loop goes idle. keyFrameMs ends at the next rAF callback after idle (vsync-quantized, not physical
// presentation/input latency). Browser counters span the measured keys, excluding setup, warmup and profiler IO.
// stream-reader-motion starts its timer before a remote-origin applyOps appends at the tail, then dispatches
// the reading key in the same task; no server/network time. navigationReadyMs includes on-demand TS stripping,
// local scheme fetch, boot, frame creation, idle and first rAF, not a packaged-page or Chromium startup time.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { strip } from './strip.mts';

const root = path.resolve(process.env.EDWIN_ROOT || path.join(import.meta.dirname, '..'));
const warmup = Number(process.env.WARMUP ?? 20), samples = Number(process.env.SAMPLES ?? 100);
if (!Number.isSafeInteger(warmup) || warmup < 0 || !Number.isSafeInteger(samples) || samples < 1) throw Error('invalid WARMUP or SAMPLES');
const scenarios = ['many-type', 'many-motion', 'long-type', 'split-markdown-type', 'folded-org-motion', 'small-type', 'stream-reader-motion'].filter(s => s.includes(process.env.SCENARIO || ''));
if (!scenarios.length) throw Error('SCENARIO matched nothing');
const manifest = JSON.parse(readFileSync(path.join(root, 'console/manifest.json'), 'utf8'));
const server = createServer((req, res) => {
  const url = req.url || '/';
  try {
    if (url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Boot a real console-kind frame locally: no edwind connection, external fonts, or startup storage.
      res.end(`<!DOCTYPE html><meta charset=utf-8><style>html,body,#frame{height:100%;margin:0}</style><div id=frame></div>
        ${manifest.files.map((f: string) => `<script src="${f}"></script>`).join('')}
        <script>(async () => {
          EdHost.sources = Object.fromEntries(await Promise.all(${JSON.stringify(manifest.scm)}.map(async f => {
            const r = await fetch(f); if (!r.ok) throw Error(f); return [f.split('/').pop(), await r.text()];
          })));
          Ed.boot({host: EdHost}); Ed.makeFrame(document.getElementById('frame'), {kind:'console',fontSize:14}).focus();
          await Ed.whenIdle(); await new Promise(requestAnimationFrame); globalThis.edwinBenchReadyMs = performance.now();
        })()</script>`);
    } else if (/^\/src\/[\w-]+\.js$/.test(url)) {
      const file = path.join(root, url.slice(1, -3) + '.ts'); res.setHeader('Content-Type', 'text/javascript'); res.end(strip(readFileSync(file, 'utf8'), file));
    } else if (/^\/scm\/[\w-]+\.scm$/.test(url)) res.end(readFileSync(path.join(root, url.slice(1))));
    else { res.writeHead(404); res.end(); }
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address();
if (!address || typeof address !== 'object') throw Error('no loopback address');
const url = `http://127.0.0.1:${address.port}/`;
const dir = mkdtempSync(path.join(tmpdir(), 'edwin-display-'));
const chrome = spawn(process.env.CHROMIUM || 'chromium', ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--disable-dev-shm-usage', '--remote-debugging-pipe', `--user-data-dir=${dir}`, ...(process.env.NO_SANDBOX === '1' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'] });
// A private CDP pipe (NUL-delimited JSON), no debugging port or user Chrome session.
let id = 0, buf = '', failure: Error | undefined;
const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
const fail = (e: Error) => { failure = e; for (const p of pending.values()) p.reject(e); pending.clear(); };
chrome.on('error', fail); chrome.on('exit', code => fail(Error(`Chromium exited (${code})`)));
(chrome.stdio[4] as Readable).setEncoding('utf8').on('data', data => {
  buf += data; let end;
  while ((end = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, end)); buf = buf.slice(end + 1);
    if (msg.method === 'Runtime.exceptionThrown') fail(Error(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    const p = pending.get(msg.id); if (!p) continue; pending.delete(msg.id);
    if (msg.error) p.reject(Error(msg.error.message)); else p.resolve(msg.result);
  }
});
function call(method: string, params = {}, sessionId?: string): Promise<any> {
  if (failure) return Promise.reject(failure);
  return new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); (chrome.stdio[3] as Writable).write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}

// These two functions execute in the page, using Edwin's own window and mode setup.
async function prepare(scenario: string) {
  const { Ed, L } = globalThis as any, E = Ed.E;
  await Ed.whenIdle(); Ed.deleteOtherWindows();
  const b = Ed.getBufferCreate('bench-' + scenario); Ed.setWindowBuffer(b);
  const md = scenario.includes('markdown'), org = scenario.includes('org'), long = scenario.includes('long');
  L.evalText(`(${md ? 'markdown' : org ? 'org' : 'fundamental'}-mode) (evil-emacs-state) (set! truncate-lines #t)`);
  const paragraph = 'Measurements use a stable sentence for each section.\n';
  const lines = long ? 256 : md ? 16000 : org ? 160 : scenario === 'small-type' ? 24 : scenario === 'stream-reader-motion' ? 10000 : 40000;
  b.text = Array.from({ length: lines }, (_, i) => org ? `* Section ${i}\n` + paragraph.repeat(128) : md ? `- [ ] TODO ${i} **bold** [[A page]] and \`code\` #tag\n` : `${i} ${long ? 'abc def '.repeat(1536) : paragraph.trimEnd()}\n`).join('');
  if (org) L.evalText('(org-overview)');
  const split = md ? Ed.splitWindow(E.sel, 'below') : null;
  if (split) split.pt = split.start = Ed.lineStartB(b, Math.floor(lines / 4));
  b.pt = org ? b.folds[Math.floor(lines / 2)].s - 3 : Ed.lineStartB(b, Math.floor(lines / 2)) + (long ? 6000 : 5);
  E.sel.start = org ? Ed.bol(b.rope, b.pt) : scenario === 'small-type' ? 0 : Ed.lineStartB(b, Math.floor(lines / 2) - 2);
  // Start motion at the bottom so normal next-line keys scroll the viewport.
  E.frame.focus(); Ed.render();
  if (scenario === 'many-motion') { b.pt = Ed.lineStartB(b, E.sel.lastLine) + 5; Ed.render(); }
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  return { utf16Units: b.rope.length, lines: Ed.lineCountB(b), viewport: [innerWidth, innerHeight], windows: Ed.windowList().map((w: any) => ({ rows: w.rows, start: w.start })), folds: b.folds?.length || 0 };
}
async function drive(scenario: string, n: number) {
  const { Ed, Markdown, Rope } = globalThis as any, b = Ed.E.current, w = Ed.E.sel, inp = Ed.E.frame.el('input');
  const tDom: number[] = [], tFrame: number[] = [], stats = Markdown.MD.stats, startLex = stats.lexed, startFlatten = Rope.flattens;
  const previous = Ed.hooks.lexSeg;
  let segments = 0, segmentUnits = 0, lexHookMs = 0;
  Ed.hooks.lexSeg = (...a: any[]) => {
    const t = performance.now(), value = previous(...a); lexHookMs += performance.now() - t; segments++; segmentUnits += a[2] - a[1]; return value;
  };
  const start = w.start, startVer = b.ver, startSize = b.rope.length, stream = scenario === 'stream-reader-motion';
  const packet = 'A streaming producer appends to the tail.\n'.repeat(4);
  try {
    for (let i = 0; i < n; i++) {
      // A task after rAF, not a burst of keys coalesced inside a single callback.
      await new Promise(r => setTimeout(r, 0));
      const key = scenario === 'many-motion' ? 'ArrowDown' : scenario.includes('motion') ? (i % 2 ? 'ArrowLeft' : 'ArrowRight') : (i % 2 ? 'Backspace' : 'x');
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }), p = b.pt;
      const beforeStart = w.start, t = performance.now();
      if (stream) {
        const applied = Ed.applyOps(b, [[b.rope.length, '', packet]], 'remote');
        if (applied.length !== 1 || b.pt !== p || w.start !== beforeStart) throw Error('tail append displaced the reader');
      }
      inp.dispatchEvent(ev); await Ed.whenIdle(); tDom.push(performance.now() - t);
      await new Promise(requestAnimationFrame); tFrame.push(performance.now() - t);
      const cur = w.view.querySelector('.cur');
      if (!ev.defaultPrevented || p === b.pt || !cur || Number(cur.dataset.o) + Number(cur.closest('.ln').dataset.o) !== b.pt) throw Error(`${scenario} key ${key} did not move the drawn cursor at ${p}: ${b.pt}`);
      if (stream && (b.pt !== p + (key === 'ArrowRight' ? 1 : -1) || w.start !== beforeStart || b.rope.length !== startSize + (i + 1) * packet.length)) throw Error('reader drift or missing stream append');
    }
  } finally { Ed.hooks.lexSeg = previous; }
  return { keyDomMs: tDom, keyFrameMs: tFrame, segments, segmentUnits, lexHookMs, lexedMdUnits: stats.lexed - startLex, flattens: Rope.flattens - startFlatten, edits: b.ver - startVer, scrolled: w.start - start, appendedUnits: stream ? b.rope.length - startSize : 0 };
}
const quantiles = (a: number[]) => {
  const v = a.slice().sort((x, y) => x - y), q = (p: number) => +v[Math.ceil(p * v.length) - 1].toFixed(3);
  return { count: v.length, min: v[0], p50: q(.5), p95: q(.95), p99: q(.99), max: v.at(-1) };
};
try {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const tab = (method: string, params = {}) => call(method, params, sessionId);
  const ev = async (expression: string) => {
    const r = await tab('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value;
  };
  const run = (fn: Function, ...args: any[]) => ev(`(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`);
  await tab('Runtime.enable');
  await tab('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const coverageDir = process.env.COVERAGE_DIR;
  if (coverageDir) {
    mkdirSync(coverageDir, { recursive: true });
    await tab('Profiler.enable');
    // Enable before Edwin is compiled so V8 records individual branches, not just function entries.
    await tab('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  }
  await tab('Page.navigate', { url }); await tab('Page.bringToFront');
  const deadline = Date.now() + 30000;
  while (!await ev('Number.isFinite(globalThis.edwinBenchReadyMs)')) { if (Date.now() > deadline) throw Error(`page did not boot: ${await ev('document.body.innerText.slice(-500)')}`); await new Promise(r => setTimeout(r, 100)); }
  const navigationReadyMs = await ev('globalThis.edwinBenchReadyMs');
  await tab('Performance.enable');
  const metrics = async () => Object.fromEntries((await tab('Performance.getMetrics')).metrics.map((m: any) => [m.name, m.value]));
  const renderers = async () => (await call('SystemInfo.getProcessInfo')).processInfo.filter((p: any) => p.type === 'renderer');
  for (const scenario of scenarios) {
    const fixture = await run(prepare, scenario); await run(drive, scenario, warmup);
    if (process.env.PROFILE === '1') { await tab('Profiler.enable'); await tab('Profiler.start'); }
    if (coverageDir) await tab('Profiler.takePreciseCoverage'); // discard navigation, setup and warmup
    const cpu0 = await renderers(), m0 = await metrics(), r = await run(drive, scenario, samples), m1 = await metrics(), cpu1 = await renderers();
    if (coverageDir) {
      const { result } = await tab('Profiler.takePreciseCoverage');
      writeFileSync(path.join(coverageDir, scenario + '.json'), JSON.stringify(result));
    }
    let hot: Record<string, number> | undefined;
    if (process.env.PROFILE === '1') {
      const { profile } = await tab('Profiler.stop'); const names = new Map<number, string>(profile.nodes.map((n: any) => [n.id, n.callFrame.functionName + '@' + n.callFrame.url.split('/').pop() + ':' + (n.callFrame.lineNumber + 1)]));
      const counts: Record<string, number> = {}; for (const id of profile.samples) { const k = names.get(id)!; if (!k.startsWith('(idle)')) counts[k] = (counts[k] || 0) + 1; }
      hot = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 16));
    }
    // CDP supplies per-process CPU time in seconds. Linux /proc supplies renderer RSS at the end (sum, not PSS).
    let rendererRssKiB: number | null = null;
    if (process.platform === 'linux') rendererRssKiB = cpu1.reduce((sum: number, p: any) => sum + Number(/VmRSS:\s*(\d+)/.exec(readFileSync(`/proc/${p.id}/status`, 'utf8'))![1]), 0);
    const rendererCpuMs = 1000 * cpu1.reduce((sum: number, p: any) => sum + p.cpuTime - (cpu0.find((q: any) => p.id === q.id)?.cpuTime || 0), 0);
    console.log(JSON.stringify({ scenario, root, chrome: await ev('navigator.userAgent'), navigationReadyMs, warmup, ...fixture, rendererCpuMs, rendererRssKiB, layouts: m1.LayoutCount - m0.LayoutCount, layoutMs: (m1.LayoutDuration - m0.LayoutDuration) * 1000, dom: quantiles(r.keyDomMs), frame: quantiles(r.keyFrameMs), ...r, hot }));
  }
} finally {
  server.closeAllConnections(); server.close();
  if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) { const end = once(chrome, 'exit'); chrome.kill(); await end; }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
