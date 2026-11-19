// Only configured prompt writers enter here. A store can still be read-only/unavailable without taking the hub down.
import fs from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { AgentAuthority, configSource, PrivateStore } from './agent-files.mts';
import type { Log } from './main.mts';

// The ordinary read only detects the feature. All configuration used for an agent boot, including its
// other fields, must come from the same descriptor whose identity we protect. Fail closed on disable mid-read.
export function readAgentConfig(file: string) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const cfg = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (cfg?.agentHub === undefined) throw new Error('agentHub changed while reading configuration');
      return { cfg, source: configSource(file, fd) };
    } finally { fs.closeSync(fd); }
  } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
}

export class PromptStoreBusy extends Error {
  readonly exitCode = 73; // EX_CANTCREAT; RestartPreventExitStatus in the edwind unit
  constructor() { super('Agent prompt store is already in use'); }
}

// An already-listening pathname socket is published with an exclusive link. Unlike an abstract socket,
// its ownership crosses network namespaces; unlike a POSIX record lock, an unrelated close cannot drop it.
// The highest numbered link is the owner. After death leave it in place until a new, higher number wins:
// two contenders observing a dead owner must never unlink a third contender's live socket. A successful
// handover prunes older generations; even repeated SIGKILLs need no PID checks or stale-lock timeout.
const slot = (n: bigint) => `.writer-${n}.sock`;
function generations(root: string): bigint[] {
  const out: bigint[] = [];
  for (const name of fs.readdirSync(root)) if (/^\.writer-(0|[1-9][0-9]*)\.sock$/.test(name)) out.push(BigInt(name.slice(8, -5)));
  return out;
}
const latest = (all: bigint[]) => all.reduce((max, n) => n > max ? n : max, -1n);
async function live(file: string) {
  // O_PATH (Linux): pin the directory entry itself, not a link target or a subsequently rebound path.
  const fd = fs.openSync(file, 0o10000000 | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isSocket() || st.uid !== process.getuid!()) throw new Error('Invalid agent prompt store lock');
    return await new Promise<boolean>((resolve, reject) => {
      const probe = net.connect(`/proc/self/fd/${fd}`);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', e => (e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? resolve(false) : reject(e));
    });
  } finally { fs.closeSync(fd); }
}
async function lockStore(store: PrivateStore) {
  const fd = store.openDirectory(), root = `/proc/self/fd/${fd}`;
  const candidate = `${root}/.candidate-${randomBytes(12).toString('hex')}.sock`;
  const owner = net.createServer(s => s.destroy());
  const close = async () => {
    if (owner.listening) await new Promise<void>(resolve => owner.close(() => resolve()));
    fs.closeSync(fd);
  };
  try {
    for (;;) {
      const current = latest(generations(root));
      if (current >= 0n) {
        try { if (await live(`${root}/${slot(current)}`)) throw new PromptStoreBusy(); }
        catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      }
      if (!owner.listening) {
        await new Promise<void>((resolve, reject) => {
          owner.once('error', reject);
          owner.listen(candidate, () => { owner.removeListener('error', reject); resolve(); });
        });
        owner.unref();
      }
      const next = current + 1n;
      try { fs.linkSync(candidate, `${root}/${slot(next)}`); }
      catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      const all = generations(root);
      if (latest(all) !== next) continue; // overtaken while paused; a lower slot never conveys ownership
      for (const n of all) if (n < next) {
        const old = `${root}/${slot(n)}`;
        if (fs.lstatSync(old, { throwIfNoEntry: false })?.isSocket()) fs.rmSync(old, { force: true });
      }
      fs.unlinkSync(candidate); // the published socket stays reachable until close (or SIGKILL)
      return close;
    }
  } catch (e) { await close(); throw e; }
}

export async function openPromptWriter(auth: AgentAuthority, log: Log): Promise<(() => Promise<void>) | undefined> {
  try {
    fs.mkdirSync(auth.stateDir, { recursive: true, mode: 0o700 });
    const store = new PrivateStore(auth), release = await lockStore(store);
    auth.promptStore = store;
    let held = true;
    return async () => {
      if (!held) return;
      held = false; store.close(); auth.promptStore = undefined; await release();
    };
  } catch (e) {
    if (e instanceof PromptStoreBusy) throw e;
    log.error('agent-prompt', { error: 'Draft store unavailable' });
  }
}
