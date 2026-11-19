// The fd-based alternatives to fs-list, fs-stat and fs-copy when agent credentials are configured.
import fs from 'node:fs';
import path from 'node:path';
import { PathError, home } from './paths.mts';
import { ProtoError } from './proto.mts';
import type { AgentAuthority } from './agent-files.mts';
import type { FsEntry } from './fs.mts';

function guardedEntry(auth: AgentAuthority, full: string, name: string): { entry: FsEntry; real: string } | null {
  let own: fs.Stats;
  try { own = fs.lstatSync(full); } catch { return null; }
  const link = own.isSymbolicLink(), target = link ? fs.readlinkSync(full) : undefined;
  if (target !== undefined) {
    // Authorize the captured link text too: the link may have been replaced before its fd opens.
    const dst = path.resolve(path.dirname(full), target);
    try { auth.withRead(dst, () => {}, 'entry'); } catch (e) { if (e.code === 'refused_path') throw e; }
  }
  let real = full, st = own, dir = false;
  try {
    auth.withRead(full, (_fd, opened, resolved) => {
      real = resolved; dir = opened.isDirectory();
      if (!link) st = opened;
    }, 'entry');
  } catch (e) {
    if (e.code === 'refused_path') throw e;
    if (!link || (e.code !== 'ENOENT' && e.code !== 'ELOOP')) return null;
    // An unresolved link still has metadata. Don't publish either private spelling, even
    // when listing relative to a pinned directory rather than its canonical pathname.
    const parent = fs.realpathSync.native(path.dirname(full));
    if (auth.inRefused(path.join(parent, name)) || auth.inRefused(path.resolve(parent, target!)))
      throw new PathError('refused_path', 'Private file: access refused');
  }
  const entry: FsEntry = { name, kind: link ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
  if (link) { entry.target = target; if (dir) entry.dir = true; }
  return { entry, real };
}

export function guardedList(auth: AgentAuthority, dir: string, maxEntries: number) {
  return auth.withRead(dir, (fd, _st, real) => {
    if (auth.inRefused(real)) throw new ProtoError('refused_path', `${real}: refused`);
    const root = `/proc/self/fd/${fd}`, names = fs.readdirSync(root);
    const r: { dir: string; home: string; entries: FsEntry[]; truncated?: true } = { dir: real, home: home(), entries: [] };
    if (names.length > maxEntries) { names.length = maxEntries; r.truncated = true; }
    for (const name of names) {
      try { const e = guardedEntry(auth, path.join(root, name), name); if (e) r.entries.push(e.entry); }
      catch (e) { if (e.code !== 'refused_path' && e.code !== 'ENOENT') throw e; }
    }
    return r;
  }, 'entry');
}

export function guardedStat(auth: AgentAuthority, real: string) {
  const found = guardedEntry(auth, real, path.basename(real)), entry = found?.entry ?? null;
  const id = entry?.kind === 'dir' || entry?.dir ? null : auth.idOf(found?.real ?? real);
  return { path: real, id, entry };
}

/* Every file read while copying a tree is a read under the same authority as a visit. A source
   replaced after open cannot change what is copied. Never follow a directory through a child name. */
export async function guardedCopy(auth: AgentAuthority, src: string, dst: string): Promise<void> {
  const entry = guardedEntry(auth, src, path.basename(src))?.entry;
  if (!entry) throw new ProtoError('bad_request', 'Missing copy source');
  if (entry.kind === 'link') { await fs.promises.symlink(entry.target!, dst); return; }
  // withRead lends its descriptor only during the callback. Take a reference to the checked
  // inode before returning, never reopening src after an await.
  const { held, st } = auth.withRead(src, (fd, st) => {
    if (!st.isDirectory() && !st.isFile()) throw new ProtoError('bad_request', 'Unsupported copy source');
    return { held: fs.openSync(`/proc/self/fd/${fd}`, fs.constants.O_RDONLY), st };
  });
  try {
    const pinned = `/proc/self/fd/${held}`;
    if (st.isFile()) { await fs.promises.copyFile(pinned, dst, fs.constants.COPYFILE_EXCL); return; }
    await fs.promises.mkdir(dst, 0o700);
    const target = await fs.promises.open(dst, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const into = `/proc/self/fd/${target.fd}`;
      for await (const { name } of await fs.promises.opendir(pinned))
        await guardedCopy(auth, path.join(pinned, name), path.join(into, name));
      await target.chmod(st.mode & 0o777);
    } finally { await target.close(); }
  } finally { fs.closeSync(held); }
}
