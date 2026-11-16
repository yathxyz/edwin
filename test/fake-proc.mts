// host.proc for the suites: the desktop program's child processes (host-native.ts over native/src/proc.rs) in
// the shape the core sees, run here by node:child_process, so a suite on the Node host can use Ed.proc with
// real programs from PATH. argv only (no shell), each child in a session of its own, signals to its group;
// timeout (TERM, then KILL after 500 ms), maxBytes (killed, truncated), merge and lossy as the natives have
// them. Every spawn is recorded in `calls`, for a suite to check the argv and options it was given.
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, statSync, constants } from 'node:fs';
import path from 'node:path';

export type ProcExit = { code: number | null; signal: string | null; timedOut: boolean; truncated: boolean; error?: string };
export type ProcHandler = (kind: 'out' | 'err' | 'exit', data: string | ProcExit) => void;
export interface SpawnOptions { cwd?: string; env?: Record<string, string | null>; timeout?: number; maxBytes?: number; lossy?: boolean; merge?: boolean }
export interface FakeProc {
  spawn(argv: string[], opts: SpawnOptions, on: ProcHandler): number;
  write(id: number, text: string): boolean;
  closeStdin(id: number): void;
  kill(id: number, signal?: string): boolean;
  /* each spawn, in order */
  calls: { id: number; argv: string[]; opts: SpawnOptions }[];
  /* the children not yet ended */
  running(): number[];
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const runnable = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
function findProgram(name: string, PATH: string) {
  if (name.includes('/')) return runnable(name);
  return PATH.split(':').some(d => d && runnable(path.join(d, name)));
}

export function fakeProc(): FakeProc {
  let next = 1;
  const kids = new Map<number, { child: ChildProcess; ended: boolean; stdinOpen: boolean }>();
  const calls: FakeProc['calls'] = [];
  const group = (child: ChildProcess, sig: string) => { try { process.kill(-child.pid!, ('SIG' + sig) as NodeJS.Signals); return true; } catch { return false; } };
  return {
    calls,
    running: () => [...kids.keys()],
    spawn(argv, opts, on) {
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      for (const [k, v] of Object.entries(opts.env || {})) { if (v === null) delete env[k]; else env[k] = v; }
      /* As the natives say it, at once: a program or a directory that is not there. */
      if (!findProgram(argv[0], env.PATH || '') || (opts.cwd && !isDir(opts.cwd))) throw new Error(`cannot run ${argv[0]}: No such file or directory`);
      const child = nodeSpawn(argv[0], argv.slice(1), { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false });
      const id = next++;
      calls.push({ id, argv: argv.slice(), opts: { ...opts } });
      const k = { child, ended: false, stdinOpen: true };
      kids.set(id, k);
      let bytes = 0, truncated = false, timedOut = false, error: string | undefined, failed: string | null = null;
      const decoders = { out: new TextDecoder('utf-8', { fatal: !opts.lossy }), err: new TextDecoder('utf-8', { fatal: !opts.lossy }) };
      const take = (kind: 'out' | 'err') => (chunk: Buffer) => {
        if (truncated || error) return;
        if (opts.maxBytes !== undefined && bytes + chunk.length > opts.maxBytes) { chunk = chunk.subarray(0, opts.maxBytes - bytes); truncated = true; }
        bytes += chunk.length;
        let text: string;
        try { text = decoders[kind].decode(chunk, { stream: !truncated }); } catch { error = 'its output is not UTF-8 text'; group(child, 'KILL'); return; }
        if (text) on(opts.merge ? 'out' : kind, text);
        if (truncated) group(child, 'KILL');
      };
      child.stdout!.on('data', take('out'));
      child.stderr!.on('data', take('err'));
      child.stdin!.on('error', () => {});
      const timer = opts.timeout ? setTimeout(() => { timedOut = true; group(child, 'TERM'); setTimeout(() => group(child, 'KILL'), 500).unref(); }, opts.timeout) : null;
      child.on('error', e => { failed = `cannot run ${argv[0]}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'No such file or directory' : e.message}`; });
      child.on('close', (code, sig) => {
        if (timer) clearTimeout(timer);
        k.ended = true; kids.delete(id);
        on('exit', { code: failed ? 127 : code, signal: sig ? sig.replace(/^SIG/, '') : null, timedOut, truncated, ...(error || failed ? { error: error || failed! } : {}) });
      });
      return id;
    },
    write(id, text) { const k = kids.get(id); if (!k || !k.stdinOpen) return false; k.child.stdin!.write(text); return true; },
    closeStdin(id) { const k = kids.get(id); if (k && k.stdinOpen) { k.stdinOpen = false; k.child.stdin!.end(); } },
    kill(id, signal = 'TERM') { const k = kids.get(id); return !!k && !k.ended && group(k.child, signal); },
  };
}
