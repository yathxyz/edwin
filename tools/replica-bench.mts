// Linux / Node 24. node tools/replica-bench.mts [source-tree] >run.json
// Install that tree's server dependencies first. Each invocation starts one fresh daemon with a private
// state directory; use TMPDIR on the filesystem whose journal syncs you want to measure. No paint/display.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EditClient, FakeSocket } from '../test/edit-client.mts';
import type { Edwin } from '../test/headless.mts';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const moduleUrl = (file: string) => pathToFileURL(path.join(root, file)).href;
const harness: typeof import('../test/edit-client.mts') = await import(moduleUrl('test/edit-client.mts'));
const { createHost, loadEdwin, memoryStorage }: typeof import('../test/headless.mts') = await import(moduleUrl('test/headless.mts'));
const dir = harness.makeDir();
const now = () => performance.now();
const tickMs = 1000 / Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const warm = 8, keys = 96, remote = 48, missed = 12, replays = 4, idleBuffers = 64, idleMs = 10500;
const samples: Record<string, number[]> = {};
const record = (name: string, ms: number) => (samples[name] ||= []).push(ms);
const resources: Record<string, unknown> = {};
const fsType = fs.statfsSync(dir.root).type.toString(16);
function meters(pid: number) {
  const read = (file: string) => fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
  const stat = read('stat').split(') ')[1].split(' ');
  const status = read('status');
  const io = Object.fromEntries(read('io').trim().split('\n').map(line => { const [k, v] = line.split(': '); return [k, Number(v)]; }));
  return { userMs: Number(stat[11]) * tickMs, systemMs: Number(stat[12]) * tickMs,
    rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)![1]), peakRssKiB: Number(/^VmHWM:\s+(\d+)/m.exec(status)![1]),
    io, clientCpu: process.cpuUsage(), clientRssKiB: process.memoryUsage.rss() / 1024 };
}
function delta(a: ReturnType<typeof meters>, b: ReturnType<typeof meters>) {
  return { daemonUserMs: b.userMs - a.userMs, daemonSystemMs: b.systemMs - a.systemMs, daemonRssKiB: b.rssKiB,
    daemonPeakRssKiB: b.peakRssKiB, daemonIo: Object.fromEntries(Object.keys(b.io).map(k => [k, b.io[k] - a.io[k]])),
    clientCpuMs: (b.clientCpu.user + b.clientCpu.system - a.clientCpu.user - a.clientCpu.system) / 1000, clientRssKiB: b.clientRssKiB };
}
function journalBytes() {
  const d = path.join(dir.dirs.state, 'buffers');
  return fs.readdirSync(d).filter(f => f.endsWith('.jsonl')).reduce((sum, f) => sum + fs.statSync(path.join(d, f)).size, 0);
}
async function peer(cid?: string) {
  const c = new harness.EditClient(dir.cfg.socket, { kind: 'frame', cid, device: 'peer' });
  await c.connect(); assert.equal((await c.hello()).t, 'welcome'); return c;
}

let child: Awaited<ReturnType<typeof harness.startEdwind>> | undefined, other: EditClient | undefined, sync: Edwin;
try {
  // No inherited user agent sockets, credentials, edwind overrides, Node options or compile cache.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(k => [k, undefined]));
  Object.assign(env, { HOME: dir.dirs.home, XDG_RUNTIME_DIR: dir.dirs.sock, XDG_CONFIG_HOME: dir.dirs.config,
    XDG_STATE_HOME: dir.dirs.state, XDG_CACHE_HOME: path.join(dir.root, 'cache'), XDG_DATA_HOME: path.join(dir.root, 'data'), TMPDIR: dir.root });
  const start = now(); child = await harness.startEdwind(dir, { env });
  record('spawnToListening', now() - start); // launcher checks every 50 ms
  const pid = child.pid!; resources.startup = meters(pid);
  const connect = now(); other = await peer(); record('peerConnectHello', now() - connect);
  const boot = now(); const Ed = loadEdwin(createHost({ storage: memoryStorage(), configDir: dir.dirs.config, workers: false }));
  sync = await Ed.bootServed({ transport: harness.transport(dir.cfg.socket), device: 'writer' }); await Ed.whenIdle();
  record('headlessFrameBootHello', now() - boot);

  // Observe the completion of real src/sync message handling; no polling delay in ack/fanout timings.
  const ws = sync.sock as FakeSocket, receive = ws.onmessage!;
  let arrived: ((begin: number, end: number) => void) | null = null;
  ws.onmessage = e => { const begin = now(); receive(e); if (arrived) arrived(begin, now()); };
  function nextVersion(b: Edwin, ver: number) {
    return new Promise<{ at: number; handlerMs: number }>((resolve, reject) => {
      const timer = setTimeout(() => { arrived = null; reject(new Error(`frame never applied ${b.id} v${ver}`)); }, 10000);
      arrived = (begin, end) => { if (b.sver !== ver) return; arrived = null; clearTimeout(timer); resolve({ at: end, handlerMs: end - begin }); };
    });
  }

  for (const [name, size] of [['small', 4096], ['large', 4 * 1024 * 1024]] as const) {
    const line = 'first line of plain text   1234\n', text = line.repeat(Math.ceil(size / line.length)).slice(0, size);
    // Private writable file outside notesDir: real journals and watches, no notes index/autosave mixed into typing.
    const id = `~/${name}.txt`; fs.writeFileSync(path.join(dir.dirs.home, `${name}.txt`), text);
    const timed = (key: string, ms: number) => record(`${name}.${key}`, ms);
    let t = now(), bytes = other.sock.bytesRead; const first = await other.open(id); timed('open', now() - t);
    assert.equal(first.text, text); resources[`${name}.firstOpenPeerWireBytes`] = other.sock.bytesRead - bytes;
    t = now(); const b = await sync.open(id); timed('attach', now() - t); assert.equal(b.text, text);
    Ed.setWindowBuffer(b); Ed.E.current = b; b.pt = size >> 1;
    Ed.feedKey('i'); await Ed.whenIdle();
    let ver = 0, x = 0, y = 0;
    async function key(observe: boolean, fanout: boolean) {
      const ack = nextVersion(b, ++ver), delivered = fanout ? other!.next(m => m.t === 'edits' && m.buf === id).then(msg => ({ msg, at: now() })) : null;
      const begin = now(); Ed.feedKey('x'); await Ed.whenIdle();
      const a = await ack; x++;
      if (delivered) {
        const d = await delivered; assert.equal(d.msg.ver, ver); assert.equal(d.msg.ops[0][2], 'x');
        if (observe) { timed('keyToAppliedAck', a.at - begin); timed('keyToPeerFanout', d.at - begin); timed('ackHandler', a.handlerMs); }
      }
    }
    for (let i = 0; i < warm; i++) await key(false, true);
    let j = journalBytes(), a = meters(pid); bytes = other.sock.bytesRead;
    for (let i = 0; i < keys; i++) await key(true, true);
    resources[`${name}.typing`] = { ...delta(a, meters(pid)), peerWireBytes: other.sock.bytesRead - bytes, journalBytes: journalBytes() - j };
    Ed.feedKey('ESC'); await Ed.whenIdle();
    // Reverse direction: time protocol send -> durable ack and -> production receiver's applied edit.
    j = journalBytes(); a = meters(pid);
    for (let i = 0; i < remote; i++) {
      const seen = nextVersion(b, ver + 1), begin = now();
      const response = other.edit(id, ver, [[size / 2 + x + y, '', 'y']], { g: 'peer-type' }).then(msg => ({ msg, at: now() }));
      const d = await seen, r = await response; assert.equal(r.msg.t, 'ack'); assert.equal(r.msg.ver, ++ver); y++;
      timed('peerSendToAck', r.at - begin); timed('peerSendToFrameApplied', d.at - begin); timed('editsHandler', d.handlerMs);
    }
    resources[`${name}.remote`] = { ...delta(a, meters(pid)), journalBytes: journalBytes() - j };
    b.pt = size / 2 + x + y; Ed.feedKey('i'); await Ed.whenIdle();
    for (let r = 0; r < replays; r++) {
      const since = ver, cid = other.cid; other.close();
      for (let i = 0; i < missed; i++) await key(false, false);
      t = now(); other = await peer(cid); timed('reconnectHello', now() - t);
      bytes = other.sock.bytesRead; t = now(); const o = await other.open(id, { since }); timed('catchup', now() - t);
      assert.equal(o.text, null); assert.equal(o.ver, ver); assert.equal(o.edits.length, missed);
      for (const [i, m] of o.edits.entries()) { assert.equal(m.ver, since + i + 1); assert.equal(m.ops[0][2], 'x'); }
      resources[`${name}.catchupWireBytes`] = other.sock.bytesRead - bytes;
    }
    Ed.feedKey('ESC'); await Ed.whenIdle();
    const expected = text.slice(0, size / 2) + 'x'.repeat(warm + keys) + 'y'.repeat(y) + 'x'.repeat(missed * replays) + text.slice(size / 2);
    assert.equal(b.text, expected); assert.equal((await other.open(id)).text, expected);
    sync.close(id); other.send({ t: 'close', buf: id });
  }

  // Enough quiet time for the ten-second file stat sweep; file-backed buffers stay attached to one reader.
  for (let i = 0; i < idleBuffers; i++) {
    const file = `idle-${i}.txt`; fs.writeFileSync(path.join(dir.dirs.home, file), 'idle\n');
    assert.equal((await other.open('~/' + file)).text, 'idle\n');
  }
  await sleep(200); const a = meters(pid), t = now(); await sleep(idleMs);
  resources.idle = { ...delta(a, meters(pid)), elapsedMs: now() - t };
  const summary = Object.fromEntries(Object.entries(samples).map(([k, v]) => {
    const sorted = v.toSorted((a, b) => a - b), at = (q: number) => sorted[Math.ceil(q * v.length) - 1];
    return [k, { n: v.length, min: sorted[0], p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) }];
  }));
  console.log(JSON.stringify({ node: process.version, source: root, fsType, cpuTickMs: tickMs, warm, keys, remote, missed, replays, idleBuffers, idleMs, summaryMs: summary, resources, samplesMs: samples }));
} finally {
  sync?.shutdown(); other?.close(); if (child) await harness.stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true });
}
