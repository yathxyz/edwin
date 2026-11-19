// Only notes workers of agent-enabled daemons use this protocol. The daemon owns the full
// private-file history; the worker holds each open descriptor until the daemon authorizes it.
import fs from 'node:fs';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import type { AgentAuthority } from './agent-files.mts';
import type { Notes } from './notes.mts';
import type { GrepHit, GrepJob, NoteRead, SyncReply } from './notes-parse.mts';

const WAKE_SEQUENCE = 0, READ_DECISION = 1;
interface ReadRequest { t: 'check-read'; file: string; fd: number }
type NoteBytes = { st: fs.Stats; bytes: Buffer } | Extract<NoteRead, { skipped: string }>;

/* The worker side. Only this worker uses READ_DECISION, one request at a time. */
export class AgentNoteReader {
  private port: MessagePort;
  private signal: Int32Array;
  constructor(port: MessagePort, signal: Int32Array) { this.port = port; this.signal = signal; }
  wakeDaemon(): void { Atomics.add(this.signal, WAKE_SEQUENCE, 1); Atomics.notify(this.signal, WAKE_SEQUENCE); }
  private withRead<T>(file: string, use: (fd: number, st: fs.Stats) => T): T {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      Atomics.store(this.signal, READ_DECISION, 0);
      this.port.postMessage({ t: 'check-read', file, fd } satisfies ReadRequest);
      this.wakeDaemon();
      Atomics.wait(this.signal, READ_DECISION, 0);
      if (Atomics.load(this.signal, READ_DECISION) !== 1) throw new Error('Private file: access refused');
      return use(fd, fs.fstatSync(fd));
    } finally { fs.closeSync(fd); }
  }
  stat(file: string): fs.Stats { return this.withRead(file, (_fd, st) => st); }
  bytes(file: string, max: number): NoteBytes {
    try {
      return this.withRead(file, (fd, st): NoteBytes => {
        if (!st.isFile()) return { skipped: 'missing' };
        if (st.size > max) return { skipped: 'big', mtimeMs: st.mtimeMs, size: st.size };
        return { st, bytes: fs.readFileSync(fd) };
      });
    } catch (e) { return { skipped: e.code === 'ENOENT' ? 'missing' : 'error' }; }
  }
}

/* The daemon side. In addition to sharing an inode, the descriptor must name the path that passed
   the live authority's checks (including private-store rules). A concurrent replacement fails closed. */
function authorizeRead(auth: AgentAuthority, { file, fd }: ReadRequest, signal: Int32Array): void {
  let allowed = false;
  try {
    allowed = auth.withRead(file, (checked, _, real) => {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== real) return false;
      const a = fs.fstatSync(checked, { bigint: true }), b = fs.fstatSync(fd, { bigint: true });
      return a.dev === b.dev && a.ino === b.ino;
    });
  } catch { /* do not pass private names back to the worker */ }
  Atomics.store(signal, READ_DECISION, allowed ? 1 : -1);
  Atomics.notify(signal, READ_DECISION);
}

export function startAgentNotesWorker(notes: Notes, auth: AgentAuthority, parser: URL): Worker {
  const signal = notes.signal = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const { port1, port2 } = new MessageChannel();
  notes.syncPort = port1;
  const worker = new Worker(parser, { workerData: { notesWorker: true, agentReader: true, grammar: notes.grammar, syncPort: port2, signal }, transferList: [port2] });
  port1.on('message', (msg: ReadRequest | SyncReply) => { if ('t' in msg) authorizeRead(auth, msg, signal); });
  port1.unref();
  worker.once('exit', () => port1.close());
  return worker;
}

export function syncAgentGrep(notes: Notes, auth: AgentAuthority, job: GrepJob & { jobId: number }, timeout: number): Extract<SyncReply, { hits: GrepHit[] }> {
  const deadline = Date.now() + timeout;
  notes.syncPort.postMessage(job);
  // Scheme is blocking the daemon's event loop. Service checks for any in-flight worker job,
  // not just this grep. Sample the sequence before dequeueing to avoid a lost wake.
  while (Date.now() < deadline) {
    const seq = Atomics.load(notes.signal, WAKE_SEQUENCE);
    const msg: ReadRequest | SyncReply | undefined = receiveMessageOnPort(notes.syncPort)?.message;
    if (!msg) { Atomics.wait(notes.signal, WAKE_SEQUENCE, seq, deadline - Date.now()); continue; }
    if ('t' in msg) { authorizeRead(auth, msg, notes.signal); continue; }
    if (msg.jobId !== job.jobId) continue; // a late reply to a timed-out grep
    if (msg.error !== undefined) throw new Error(msg.error);
    return msg;
  }
  throw new Error('the notes worker did not answer in time');
}
