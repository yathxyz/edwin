// Buffer file operations used only by a daemon with an agent authority.
import fs from 'node:fs';
import path from 'node:path';
import { readTextFd } from './agent-files.mts';
import type { AgentAuthority } from './agent-files.mts';
import type { Buffers, SBuf, VisitInfo } from './buffers.mts';
import { BIG, diskState, sameDisk, sha256 } from './files.mts';
import type { TextFile } from './files.mts';
import type { IndexEntry, JournalContents } from './journal.mts';
import { PathError, under } from './paths.mts';
import { ProtoError } from './proto.mts';
import { Watcher } from './watch.mts';

const refused = () => new PathError('refused_path', 'Private file: access refused');

export function readState(agent: AgentAuthority, file: string): string {
  return agent.withRead(file, fd => fs.readFileSync(fd, 'utf8'), 'state');
}

function indexedDraft(dir: string, e: IndexEntry): boolean {
  if (typeof e.file !== 'string' || path.dirname(e.file) !== dir) return false;
  const key = /^name:\*Agent Prompt: ([A-Za-z0-9_-]+)\*$/.exec(e.id)?.[1];
  return !!key && e.file === path.join(dir, key + '.md');
}

export function reloadGuarded(buffers: Buffers): void {
  const dir = path.join(buffers.stateDir, 'agent-prompts');
  for (const e of [...buffers.index.buffers.values()]) {
    try {
      if (typeof e.id !== 'string' || !e.id || (e.file != null && typeof e.file !== 'string')) throw refused();
      if (indexedDraft(dir, e)) continue; // the prompt installer alone reads and verifies this journal
      buffers.reloadOne(e);
    } catch (err) {
      buffers.log.error('reload', err.code === 'refused_path' ? { error: 'Private file: access refused' } : { error: err.message });
    }
  }
}

/* Only the prompt installer can recover a store journal. Both the index and the journal must
   identify the same private draft; a stale/corrupt row cannot launder its snapshot into an
   ordinary buffer. A similarly named buffer outside this directory remains ordinary. */
export function checkRecovery(agent: AgentAuthority, e: IndexEntry, read: JournalContents, file: string | null, expected?: string): void {
  const dir = path.join(agent.stateDir, 'agent-prompts');
  const inside = (f: string | null) => typeof f === 'string' && under(path.resolve(f), dir);
  if (expected) {
    if (!agent.promptStore || !indexedDraft(dir, e) || expected !== e.file || file !== expected ||
        read.header.id !== e.id || read.header.file !== expected || read.mv.some(m => m.id !== e.id || m.file !== expected)) throw refused();
    agent.promptStore.withRead(path.basename(expected), () => {});
  } else if (inside(e.file) || inside(read.header.file) || read.mv.some(m => inside(m.file))) {
    throw refused();
  } else if (file) {
    // The snapshot is not an alternative route to a credential that now occupies the file.
    try { agent.withRead(file, () => {}); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

export function checkedLive(agent: AgentAuthority, sb: SBuf): SBuf {
  if (sb.file) {
    try {
      const store = agent.promptStore;
      if (store && path.dirname(sb.file) === store.dir) store.checkLive(path.basename(sb.file));
      else agent.withRead(sb.file, () => {}, 'entry');
    } catch (e) { if (e.code !== 'ENOENT') throw new ProtoError('refused_path', 'Private file: access refused'); }
  }
  return sb;
}

export function visitGuarded(agent: AgentAuthority, file: string): VisitInfo {
  try {
    return agent.withRead(file, (fd, st, real) => {
      if (!st.isFile()) throw new ProtoError('not_text', `${real}: not a regular file`);
      const buf = agent.idOf(real);
      try { agent.checkWrite(real); } catch { return { buf, readOnly: 'outside the writable paths' }; }
      if (st.size > BIG) return { buf, readOnly: `file larger than ${BIG >> 20} MiB: read-only` };
      readTextFd(fd, st, real);
      return { buf, readOnly: false };
    });
  } catch (e) { throw new ProtoError(e.code === 'ENOENT' ? 'no_buffer' : e.code === 'not_text' ? 'not_text' : 'refused_path', e.message); }
}

export class AgentWatcher extends Watcher {
  override check(sb: SBuf): void {
    if (!sb.file || sb.big) return;
    let r: TextFile | null;
    try {
      r = this.buffers.auth.agent!.withRead(sb.file, (fd, st, real) =>
        sameDisk(diskState(st), sb.disk) ? null : readTextFd(fd, st, real));
    } catch (e) {
      // An alias may have become private since this buffer was opened. Never identify it in a refusal.
      if (e.code !== 'ENOENT') { this.log.warn('disk', { error: e.code }); return; }
      if (sb.disk !== null) { sb.disk = null; sb.setDiskChanged('deleted'); this.log.info('disk', { buf: sb.id, change: 'deleted' }); }
      return;
    }
    if (!r) { if (sb.diskChanged === 'deleted') sb.setDiskChanged(null); return; }
    sb.disk = diskState(r.stat);
    if (sb.diskChanged === 'deleted') sb.setDiskChanged(null);
    const hash = sha256(r.text);
    if (hash === sb.savedHash) { sb.eol = r.eol; return; }
    this.buffers.diskChanged(sb, r.text, r.eol, hash);
  }
}
