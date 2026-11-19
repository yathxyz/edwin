// Linux / Node 24. Strip src first. node tools/front-start-bench.mts [source-tree]
// Fresh front process, warm filesystem cache, real pre-stripped assets as in nix/web.nix.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
if (process.argv[3]) {
  const web = process.argv[3], t = BigInt(process.argv[4]);
  const elapsed = () => Number(process.hrtime.bigint() - t) / 1e6;
  const { start }: typeof import('../server/front.mts') = await import(pathToFileURL(path.join(root, 'server/front.mts')).href);
  const secret = 'a'.repeat(48), host = 'front.invalid';
  const front = await start({ listen: { host: '127.0.0.1', port: 0 }, publicOrigin: `https://${host}`, host, trustedProxy: '127.0.0.1', secret: Buffer.from(secret), webRoot: web, editSocket: path.join(web, 'unused.sock') }, () => {});
  try {
    const listenMs = elapsed();
    const bodyBytes = await new Promise<number>((resolve, reject) => {
      get({ host: '127.0.0.1', port: (front.server.address() as AddressInfo).port, path: '/', headers: { host, 'x-edwin-proxy-secret': secret } }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(Error(`GET /: ${res.statusCode}`)); return; }
        let bytes = 0; res.on('data', chunk => bytes += chunk.length); res.on('end', () => resolve(bytes)); res.on('error', reject);
      }).on('error', reject);
    });
    const getMs = elapsed(), cpu = process.cpuUsage();
    const hwmKiB = Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))![1]);
    const io = readFileSync('/proc/self/io', 'utf8');
    assert.equal(bodyBytes, readFileSync(path.join(web, 'index.html')).length);
    console.log(JSON.stringify({ listenMs, getMs, cpuMs: (cpu.user + cpu.system) / 1000, hwmKiB, readChars: Number(/^rchar: (\d+)/m.exec(io)![1]), readBytes: Number(/^read_bytes: (\d+)/m.exec(io)![1]) }));
  } finally { await front.stop(); }
} else {
  const web = mkdtempSync(path.join(tmpdir(), 'edwin-front-bench-'));
  try {
    for (const file of ['index.html', 'manifest.json']) symlinkSync(path.join(root, 'console', file), path.join(web, file));
    for (const [sub, ext] of [['src', '.js'], ['scm', '.scm']]) {
      mkdirSync(path.join(web, sub));
      const files = readdirSync(path.join(root, sub)).filter(f => f.endsWith(ext));
      assert(files.length, `missing ${sub}/*${ext}; run node tools/strip.mts --in-place src first`);
      for (const file of files) symlinkSync(path.join(root, sub, file), path.join(web, sub, file));
    }
    const samples: Record<string, number>[] = [];
    for (let i = 0; i < 12; i++) samples.push(JSON.parse(execFileSync(process.execPath, [import.meta.filename, root, web, String(process.hrtime.bigint())], { encoding: 'utf8', env: { HOME: web, TMPDIR: web } })));
    const summary = Object.fromEntries(Object.keys(samples[0]).map(k => {
      const v = samples.map(s => s[k]).sort((a, b) => a - b), q = (p: number) => v[Math.ceil(v.length * p) - 1];
      return [k, { min: v[0], p50: q(.5), p95: q(.95), p99: q(.99), max: v.at(-1) }];
    }));
    console.log(JSON.stringify({ n: samples.length, root, summary, samples }));
  } finally { rmSync(web, { recursive: true, force: true }); }
}
