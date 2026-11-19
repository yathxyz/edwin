// The directory commands behind dired and find-file's path reading: fs-list, fs-stat, fs-delete, fs-copy and
// fs-mkdir (a rename is rename-file, buffers.mts). Every path goes through the authority (paths.mts) on its real
// form. A read is anything not in or on a refused path; a write is checkWrite, and never edwind's own
// directories, a write root itself or anything inside stateDir. Deletes are permanent; nothing is overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { ProtoError } from './proto.mts';
import { PathError, home, under } from './paths.mts';
import { REFUSED_DST, lexicalPath, osMessage, realEntry } from './buffers.mts';
import { fsyncDir } from './files.mts';
import type { Server } from './main.mts';
import type { Authority } from './paths.mts';

/* The most entries one fs-list returns; a longer directory comes back cut, with truncated set. */
export const MAX_ENTRIES = 10000;

/* One name of a directory. kind is the entry's own (a symlink is 'link', with its target as written and dir set
   when it leads to a directory); mode is the permission bits; mtime is in milliseconds. */
export interface FsEntry { name: string; kind: 'dir' | 'file' | 'link' | 'other'; size: number; mtime: number; mode: number; target?: string; dir?: true }

function entryOf(auth: Authority, full: string, name: string): { entry: FsEntry; real: string } | null {
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
    if (!link || e.code !== 'ENOENT') return null;
    // A link may outlast a removed credential; don't publish a protected target spelling either.
    if (auth.inRefused(path.resolve(path.dirname(full), target!))) throw new PathError('refused_path', 'Private file: access refused');
  }
  const entry: FsEntry = { name, kind: link ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
  if (link) { entry.target = target; if (dir) entry.dir = true; }
  return { entry, real };
}

const bad = (e: unknown): ProtoError => (e instanceof ProtoError ? e : e instanceof PathError ? new ProtoError(e.code, e.message) : new ProtoError('bad_request', osMessage(e as NodeJS.ErrnoException)));
const arg = (args: unknown[]): Record<string, unknown> => (args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : {});

/* Every file read while copying a tree is a read under the same authority as a visit. A source
   replaced after open cannot change what is copied. Never follow a directory through a child name. */
async function copyGuardedEntry(auth: Authority, src: string, dst: string): Promise<void> {
  const entry = entryOf(auth, src, path.basename(src))?.entry;
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
        await copyGuardedEntry(auth, path.join(pinned, name), path.join(into, name));
      await target.chmod(st.mode & 0o777);
    } finally { await target.close(); }
  } finally { fs.closeSync(held); }
}

/* REAL may be written by a file operation: inside a write root and not refused (checkWrite), not one of
   edwind's directories or a write root or anything holding one, and not inside stateDir. */
function checkOperand(auth: Authority, real: string): void {
  try { auth.checkWrite(real); } catch (e) { throw bad(e); }
  for (const root of new Set([auth.notesDir, auth.stateDir, auth.configDir, ...auth.writeRootsForFlags()])) {
    let r = root; try { r = fs.realpathSync.native(root); } catch (e) { /* not made yet */ }
    if (under(root, real) || under(r, real)) throw new ProtoError('refused_path', `${real}: holds ${root}, a directory edwind is configured with`);
  }
  if (auth.inState(real)) throw new ProtoError('refused_path', `${real}: inside edwind's state directory`);
}

export class Fs {
  declare server: Server;
  declare auth: Authority;
  constructor(server: Server) { this.server = server; this.auth = server.buffers.auth; }

  /* fs-list [{dir}]: the entries of DIR (the notes directory when absent), unsorted. DIR is resolved, so a
     symlink to a directory lists what it leads to and dir names where that is. */
  list(dir: unknown): { dir: string; home: string; entries: FsEntry[]; truncated?: true } {
    const auth = this.auth;
    const absolute = dir === undefined || dir === null ? auth.notesDir : lexicalPath(auth, dir);
    try {
      return auth.withRead(absolute, (fd, _st, real) => {
        if (auth.inRefused(real)) throw new ProtoError('refused_path', `${real}: refused`);
        const root = `/proc/self/fd/${fd}`, names = fs.readdirSync(root);
        const r: { dir: string; home: string; entries: FsEntry[]; truncated?: true } = { dir: real, home: home(), entries: [] };
        if (names.length > MAX_ENTRIES) { names.length = MAX_ENTRIES; r.truncated = true; }
        for (const name of names) {
          try { const e = entryOf(auth, path.join(root, name), name); if (e) r.entries.push(e.entry); }
          catch (e) { if (e.code !== 'refused_path' && e.code !== 'ENOENT') throw e; }
        }
        return r;
      }, 'entry');
    } catch (e) { throw bad(e); }
  }

  /* fs-stat [{path}]: what PATH names. path is its real place, the last component left as written; entry is
     null when nothing is there; id is the buffer id a visit of it opens (a link and its target name one buffer,
     R6.1), also for a file yet to be made, and null for a directory. */
  stat(p: unknown): { path: string; id: string | null; entry: FsEntry | null } {
    const abs = lexicalPath(this.auth, p), real = realEntry(abs);
    if (this.auth.inRefused(real)) throw new ProtoError('refused_path', `${real}: refused`);
    let found: ReturnType<typeof entryOf>;
    try { found = entryOf(this.auth, real, path.basename(real)); } catch (e) { throw bad(e); }
    const entry = found?.entry ?? null;
    const id = entry?.kind === 'dir' || entry?.dir ? null : this.auth.idOf(found?.real ?? real);
    return { path: real, id, entry };
  }

  /* fs-delete [{path, recursive}]: remove a file, a symlink (never its target) or a directory, for good. A
     directory that is not empty goes only with recursive; without it the answer is {deleted: false, nonEmpty:
     true} and nothing is touched, so a client can ask first. */
  async delete(p: unknown, recursive: boolean): Promise<{ deleted: boolean; path: string; nonEmpty?: true }> {
    const real = realEntry(lexicalPath(this.auth, p));
    checkOperand(this.auth, real);
    let st: fs.Stats;
    try { st = fs.lstatSync(real); } catch (e) { throw bad(e); }
    try {
      if (!st.isDirectory()) fs.unlinkSync(real);
      else if (recursive) await fs.promises.rm(real, { recursive: true });
      else {
        try { fs.rmdirSync(real); } catch (e) { if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') return { deleted: false, path: real, nonEmpty: true }; throw e; }
      }
    } catch (e) { throw bad(e); }
    fsyncDir(path.dirname(real));
    this.server.log.info('fs-delete', { path: real, dir: st.isDirectory(), recursive: st.isDirectory() && recursive });
    return { deleted: true, path: real };
  }

  /* fs-copy [{src, dst}]: copy a file, a symlink (as a link) or a whole directory. A DST that is a directory
     takes the copy under the source's name; a DST that exists is never overwritten. */
  async copy(src: unknown, dst: unknown): Promise<{ ok: true; src: string; dst: string; dir: boolean }> {
    const auth = this.auth;
    const srcAbs = lexicalPath(auth, src);
    let dstAbs = lexicalPath(auth, dst);
    try { if (fs.statSync(dstAbs).isDirectory()) dstAbs = path.join(dstAbs, path.basename(srcAbs)); } catch (e) { /* a new name */ }
    const srcReal = realEntry(srcAbs), dstReal = realEntry(dstAbs);
    let st: fs.Stats;
    try { st = fs.lstatSync(srcReal); } catch (e) { throw bad(e); }
    const dir = st.isDirectory();
    /* A directory above a refused path would carry it along; a file only has to be outside one. */
    if (dir ? auth.refused(srcReal) : auth.inRefused(srcReal)) throw new ProtoError('refused_path', `${srcReal}: refused`);
    if (auth.refused(dstReal)) throw new ProtoError('refused_path', REFUSED_DST);
    checkOperand(auth, dstReal);
    if (under(dstReal, srcReal)) throw new ProtoError('bad_request', dstReal === srcReal ? 'source and destination are the same' : 'cannot copy a directory into itself');
    let there = true;
    try { fs.lstatSync(dstReal); } catch (e) { if (e.code !== 'ENOENT') throw bad(e); there = false; }
    if (there || this.server.buffers.all().some(sb => sb.file && under(sb.file, dstReal))) throw new ProtoError('bad_request', 'destination exists');
    try {
      // Ordinary copies use asynchronous recursive I/O. With protected identities, cp's
      // pathname-based content reads cannot substitute for copying the checked, pinned source.
      if (auth.guardsCredential) await copyGuardedEntry(auth, srcReal, dstReal);
      else await fs.promises.cp(srcReal, dstReal, { recursive: dir, force: false, errorOnExist: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_EXCL });
    } catch (e) { throw bad(e); }
    fsyncDir(path.dirname(dstReal));
    this.server.log.info('fs-copy', { src: srcReal, dst: dstReal, dir });
    return { ok: true, src: srcReal, dst: dstReal, dir };
  }

  /* fs-mkdir [{path}]: make a directory and the parents it lacks. */
  mkdir(p: unknown): { ok: true; path: string } {
    const abs = lexicalPath(this.auth, p);
    /* The deepest ancestor that exists is resolved; what is to be made under it is taken as written. */
    let base = abs;
    const rest: string[] = [];
    for (;;) {
      try { base = fs.realpathSync.native(base); break; }
      catch (e) { if (e.code !== 'ENOENT' || base === '/') throw bad(e); rest.unshift(path.basename(base)); base = path.dirname(base); }
    }
    if (!rest.length) throw new ProtoError('bad_request', `${base} exists`);
    const real = path.join(base, ...rest);
    checkOperand(this.auth, real);
    try { fs.mkdirSync(real, { recursive: true }); } catch (e) { throw bad(e); }
    fsyncDir(path.dirname(real));
    this.server.log.info('fs-mkdir', { path: real });
    return { ok: true, path: real };
  }

  install(): void {
    const D = (name: string, fn: (a: Record<string, unknown>) => unknown) => this.server.defineCommand(name, async (_client, args) => ({ value: await fn(arg(args)) }));
    D('fs-list', a => this.list(a.dir));
    D('fs-stat', a => this.stat(a.path));
    D('fs-delete', a => this.delete(a.path, a.recursive === true));
    D('fs-copy', a => this.copy(a.src, a.dst));
    D('fs-mkdir', a => this.mkdir(a.path));
  }
}

export async function install(server: Server): Promise<void> { new Fs(server).install(); }
