// File authority and buffer ids (spec R6.1, R14.8): the one module every file primitive of edwind goes
// through. Reads are allowed anywhere but the refusal list; writes only inside the write roots and never
// in the refusal list. Checks run on real paths: the parent directory resolved through the kernel, and
// the last component looked at with lstat so a symlink there is seen, never the string the client sent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentAuthority } from './agent-files.mts';

/* The codes a PathError carries; each is an error code of the protocol (§7.8). */
export type PathErrorCode = 'no_buffer' | 'refused_path' | 'bad_id';

export class PathError extends Error {
  declare code: PathErrorCode;
  constructor(code: PathErrorCode, msg: string) { super(msg); this.code = code; }
}

const windows = process.platform === 'win32';
const HOME = (windows ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
const slashWindows = (p: string): string => p.replace(/\\/g, '/');
const driveRoot = /^[a-z]:\//i;
const upperDrive = (p: string): string => /^[a-z]:/i.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
const deviceName = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³]) *(?:\.|$)/i;

/* Validate before path.join/resolve can erase a component or interpret a namespace. */
export function windowsPathId(raw: string): { id: string; kind: 'absolute' | 'home' | 'relative' } {
  const id = upperDrive(slashWindows(raw));
  const kind = driveRoot.test(id) ? 'absolute' : id === '~' || id.startsWith('~/') ? 'home' : 'relative';
  const rest = kind === 'absolute' ? id.slice(3) : kind === 'home' ? id.slice(2) : id;
  if (!(kind === 'absolute' && id.length === 3) && id !== '~' &&
      rest.split('/').some(s => !s || /[. ]$|[<>:"|?*\x00-\x1f]/.test(s) || deviceName.test(s)))
    throw new PathError('bad_id', `bad Windows path ${JSON.stringify(raw)}`);
  return { id, kind };
}

/* Convert a native path (or a relative path fragment) to the wire spelling. */
export const pathToId = (p: string): string => windows ? upperDrive(slashWindows(p)) : p;
const nativeWindowsPath = (id: string): string => path.win32.normalize(id);
const windowsAbsolute = (p: string): string => {
  const { id, kind } = windowsPathId(p);
  if (kind !== 'absolute') throw new PathError('bad_id', `expected a drive-rooted path: ${JSON.stringify(p)}`);
  return nativeWindowsPath(id);
};

/* Resolved paths grant access using exact component case: NTFS can also have case-sensitive directories.
   A lexical refusal can only restrict access, so for it err on the side of treating case as equivalent. */
export function windowsUnder(p: string, root: string, ignoreCase = false): boolean {
  p = upperDrive(slashWindows(p)); root = upperDrive(slashWindows(root));
  if (ignoreCase) { p = p.toUpperCase(); root = root.toUpperCase(); }
  return p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
}

/* Native realpath expands existing short aliases and uses filesystem casing. Never use the input spelling
   if resolution of an existing entry fails, or if the result is not a supported local path. */
function windowsReal(p: string): string {
  const real = fs.realpathSync.native(p);
  try { return windowsAbsolute(real); }
  catch { throw new PathError('refused_path', `${p}: unsupported resolved Windows path`); }
}

function windowsRealPath(abs: string, follow: boolean): RealPath {
  let parent: string;
  try { parent = windowsReal(path.dirname(abs)); }
  catch (e) { if (e instanceof PathError) throw e; throw new PathError(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'no_buffer' : 'refused_path', `${abs}: ${e.code}`); }
  const full = path.join(parent, path.basename(abs));
  let stat: fs.Stats;
  try { stat = fs.lstatSync(full); }
  catch (e) {
    if (e.code === 'ENOENT') return { real: full, exists: false, symlink: false, stat: null };
    throw new PathError('refused_path', `${full}: ${e.code}`);
  }
  const symlink = stat.isSymbolicLink();
  if (symlink && !follow) throw new PathError('refused_path', `${full}: cannot safely resolve the link's own spelling`);
  try { return { real: windowsReal(full), exists: true, symlink, stat: symlink ? undefined : stat }; }
  catch (e) { if (e instanceof PathError) throw e; throw new PathError('refused_path', `${full}: ${e.code}`); }
}

/* Resolve an existing path, or its nearest existing ancestor plus an as-yet uncreated tail. */
function windowsRealOrMissing(p: string): string {
  try {
    const r = windowsRealPath(p, true);
    return r.real;
  } catch (e) {
    if (!(e instanceof PathError) || e.code !== 'no_buffer') throw e;
    const parent = path.dirname(p);
    if (parent === p) return p; // an unavailable drive
    return path.join(windowsRealOrMissing(parent), path.basename(p));
  }
}

/* The file-operand grammar is also used by rename-file and fs-*. */
export function windowsOperand(raw: string, notesDir: string): { path: string; relative: boolean } {
  const { id, kind } = windowsPathId(raw);
  return { path: kind === 'absolute' ? nativeWindowsPath(id)
    : kind === 'home' ? path.join(windowsAbsolute(HOME), id.slice(2))
    : path.join(notesDir, id), relative: kind === 'relative' };
}

/* Windows entry operations keep the final entry rather than following a symlink. */
export const windowsEntry = (p: string): string => windowsRealPath(windowsAbsolute(p), false).real;

/* Configuration inputs may retain a trailing directory separator, not ambiguous components. */
export function absoluteFilePath(p: string): string {
  if (!windows) return path.resolve(expandHome(p));
  if (p.length > 3 && /[/\\]$/.test(p)) p = p.slice(0, -1);
  if (windowsPathId(p).kind === 'home') return windowsOperand(p, '').path;
  return windowsAbsolute(p);
}

export const canonicalFilePath = (p: string): string => windows ? windowsReal(windowsAbsolute(p)) : fs.realpathSync.native(p);

/* Match a configured path when it cannot yet be resolved, without using this to grant access. */
export const underConfigured = (p: string, root: string): boolean => windows ? windowsUnder(p, root, true) : under(p, root);

/* Expand a leading ~ to the service user's home. */
export const expandHome = (p: string): string => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);
export const home = (): string => HOME;

/* True when P equals ROOT or lies under it (both absolute, normalised). */
export const under = (p: string, root: string): boolean => windows ? windowsUnder(p, root)
  : p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

/* A wire ID strictly below ROOT, or null. Both inputs are native paths. */
export function relativeFileId(p: string, root: string): string | null {
  if (!under(p, root) || p.length === root.length) return null;
  return pathToId(p.slice(root.length + (windows && root.endsWith(path.sep) ? 0 : 1)));
}

/* The real path of P: its parent resolved by the kernel, the last component resolved if it exists and
   is a symlink (a symlink and its target name one buffer, R6.1). A missing parent is an error. */
/* A real path: REAL, whether it exists, whether the last component was a symlink, and its lstat when known. */
export interface RealPath { real: string; exists: boolean; symlink: boolean; stat?: fs.Stats | null }
export function realPath(p: string): RealPath {
  if (windows) return windowsRealPath(absoluteFilePath(p), true);
  const abs = path.resolve(expandHome(p));
  const parent = path.dirname(abs), base = path.basename(abs);
  let realParent: string;
  try { realParent = fs.realpathSync.native(parent); } catch (e) { throw new PathError(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'no_buffer' : 'refused_path', `${parent}: ${e.code}`); }
  const full = path.join(realParent, base);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') throw new PathError('refused_path', `${full}: ${e.code}`); }
  if (st && st.isSymbolicLink()) {
    try { return { real: fs.realpathSync.native(full), exists: true, symlink: true }; }
    catch (e) { return { real: full, exists: false, symlink: true }; }
  }
  return { real: full, exists: !!st, symlink: false, stat: st };
}

/* The authority: constructed once from edit.json. */
/* What the authority takes of edit.json. */
export interface AuthorityConfig { notesDir: string; stateDir: string; configDir: string; writablePaths?: string[]; refusePaths?: string[] }
/* A parsed buffer id (R6.1). */
export type ParsedId = { kind: 'name'; name: string } | { kind: 'file'; real: string; exists: boolean; stat?: fs.Stats | null };

export class Authority {
  declare notesDir: string;
  declare stateDir: string;
  declare configDir: string;
  declare writeRoots: string[];
  declare refuse: string[];
  declare realWriteRoots: string[];
  declare realRefuse: string[];
  declare readonly agent?: AgentAuthority;
  constructor({ notesDir, stateDir, configDir, writablePaths = [], refusePaths = [] }: AuthorityConfig) {
    this.notesDir = absoluteFilePath(notesDir); this.stateDir = absoluteFilePath(stateDir); this.configDir = absoluteFilePath(configDir);
    this.writeRoots = [...new Set([...writablePaths.map(absoluteFilePath), this.notesDir, this.stateDir, this.configDir])];
    this.refuse = refusePaths.map(absoluteFilePath);
    /* The roots as the kernel sees them, so a root reached through a symlinked parent still counts. */
    this.realWriteRoots = this.writeRoots.map(r => { try { return canonicalFilePath(r); } catch (e) { return r; } });
    this.realRefuse = this.refuse.map(r => {
      if (windows) return windowsRealOrMissing(r);
      try { return canonicalFilePath(r); } catch (e) { return r; }
    });
  }
  private matchesRefusal(real: string, above: boolean): boolean {
    const matches = (r: string) => underConfigured(real, r) || (above && underConfigured(r, real));
    return this.refuse.some(matches) || this.realRefuse.some(matches) ||
      (windows && this.refuse.some(r => matches(windowsRealOrMissing(r))));
  }
  /* Nothing in, on or above a refused path (the rule of POST /api/mv). */
  refused(real: string): boolean { return this.matchesRefusal(real, true); }
  /* In or on a refused path. A directory above one is not: it lists, and shows the refused name and nothing of
     its inside. */
  inRefused(real: string): boolean { return this.matchesRefusal(real, false); }
  /* In or on edwind's state directory (journals, snapshots, the image log), by either spelling. */
  inState(real: string): boolean {
    let r = this.stateDir; try { r = canonicalFilePath(r); } catch (e) { /* not made yet */ }
    return underConfigured(real, r) || underConfigured(real, this.stateDir);
  }
  /* A read of REAL: anywhere but the refusal list. Throws PathError refused_path. */
  checkRead(real: string): string { if (this.refused(real)) throw new PathError('refused_path', `${real}: refused`); return real; }
  /* A write of REAL (save, create, rename, delete). Throws PathError refused_path. */
  checkWrite(real: string): string {
    if (this.refused(real)) throw new PathError('refused_path', `${real}: refused`);
    const allowed = windows
      ? this.writeRoots.some(r => { try { return under(real, windowsReal(r)); } catch { return false; } })
      : this.realWriteRoots.some(r => under(real, r)) || this.writeRoots.some(r => under(real, r));
    if (!allowed) throw new PathError('refused_path', `${real}: outside the writable paths`);
    return real;
  }
  /* The write roots for the Node permission flags (R14.12). */
  writeRootsForFlags(): string[] { return [...new Set([...this.writeRoots, ...this.realWriteRoots])]; }

  /* ---------- buffer ids (R6.1) ---------- */

  /* Parse an id: {kind: 'name', name} or {kind: 'file', real, exists}. Throws PathError bad_id. */
  parseId(id: unknown): ParsedId {
    if (typeof id !== 'string' || !id) throw new PathError('bad_id', 'buffer id must be a non-empty string');
    if (id.startsWith('name:')) { const name = id.slice(5); if (!name) throw new PathError('bad_id', 'empty buffer name'); return { kind: 'name', name }; }
    if (id.includes('\0')) throw new PathError('bad_id', 'buffer id contains NUL');
    if (windows) {
      const operand = windowsOperand(id, this.notesDir);
      const r = windowsRealPath(operand.path, true);
      if (operand.relative && !under(r.real, this.realNotesDir())) throw new PathError('bad_id', `${JSON.stringify(id)} escapes the notes directory`);
      return { kind: 'file', real: r.real, exists: r.exists, stat: r.stat };
    }
    let p: string;
    if (id.startsWith('/')) p = id;
    else if (id === '~' || id.startsWith('~/')) p = expandHome(id);
    else {
      /* notesDir-relative: no empty segment, no . or .. segments. */
      const segs = id.split('/');
      if (segs.some(s => s === '' || s === '.' || s === '..')) throw new PathError('bad_id', `bad relative id ${JSON.stringify(id)}`);
      p = path.join(this.notesDir, id);
    }
    const segs = p.split('/');
    if (segs.some(s => s === '..' || s === '.')) throw new PathError('bad_id', `bad id ${JSON.stringify(id)}`);
    const r = realPath(p);
    if (!id.startsWith('/') && !id.startsWith('~') && !under(r.real, this.realNotesDir())) throw new PathError('bad_id', `${JSON.stringify(id)} escapes the notes directory`);
    return { kind: 'file', real: r.real, exists: r.exists, stat: r.stat };
  }
  realNotesDir(): string {
    if (windows) return windowsRealOrMissing(this.notesDir);
    try { return canonicalFilePath(this.notesDir); } catch (e) { return this.notesDir; }
  }
  /* The id of a real file path: notesDir-relative, ~/…, or absolute. */
  idOf(real: string): string {
    const nd = this.realNotesDir();
    const note = relativeFileId(real, nd);
    if (note !== null) return note;
    const h = (() => { try { return canonicalFilePath(HOME); } catch (e) { return HOME; } })();
    const local = relativeFileId(real, h);
    return local === null ? pathToId(real) : '~/' + local;
  }
}
