// Agent-only file authority. Credential/config identities follow rotation; all reads consume the checked fd.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Authority, PathError, under, type AuthorityConfig } from './paths.mts';
import { BIG, FileError, encodeText, fsyncDir, sha256, type Eol, type Saved, type TextFile } from './files.mts';

// Linux O_PATH (not exposed by node:fs): inspect an entry without opening a FIFO/device for I/O.
const O_PATH = 0o10000000;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
const denied = () => new PathError('refused_path', 'Private file: access refused');
const identity = (st: fs.BigIntStats) => `${st.dev}:${st.ino}`;
type Reader<T> = (fd: number, stat: fs.Stats, real: string) => T;

/* Bind the config identity to the descriptor used to parse it, before its path can change. */
export function configSource(file: string, fd: number) {
  return { file: path.resolve(file), real: fs.readlinkSync(fdPath(fd)), id: identity(fs.fstatSync(fd, { bigint: true })) };
}

const decoder = new TextDecoder('utf-8', { fatal: true });
// Reopen the authorized inode, not its original pathname. Only content reads need read
// permission or a blocking open (notably a FIFO waiting for its writer).
export function readTextEntry(fd: number, stat: fs.Stats, real: string): TextFile {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(fdPath(fd)); }
  catch (e) { throw new FileError(e.code === 'ENOENT' ? 'no_buffer' : 'refused_path', `${real}: ${e.code}`); }
  let text: string;
  try { text = decoder.decode(bytes); } catch { throw new FileError('not_text', `${real}: not UTF-8 text`); }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let eol: Eol = 'lf';
  if (text.includes('\r\n')) { eol = 'crlf'; text = text.replace(/\r\n/g, '\n'); }
  return { text, eol, big: bytes.length > BIG, stat, bytes: bytes.length };
}

// The caller controls directory durability: only a delivery ledger requires a successful directory sync.
function replaceFile(file: string, data: string, mode?: number, faultSave = false): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${randomBytes(4).toString('hex')}~`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      if (faultSave && process.env.EDWIND_FAULT === 'enospc-save') {
        const buf = Buffer.from(data); fs.writeSync(fd, buf, 0, buf.length >> 1);
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      fs.writeFileSync(fd, data);
      if (mode !== undefined) fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* preserve the write, close or rename error */ }
    throw e;
  }
}

export class AgentAuthority extends Authority {
  override readonly agent: AgentAuthority = this;
  private readonly credential: string;
  private readonly protectedFiles: string[];
  private readonly protectedIds = new Set<string>();
  private readonly protectedNames = new Set<string>();
  readonly promptDir: string;
  promptStore?: PrivateStore;

  constructor(config: AuthorityConfig, credential: string, source?: ReturnType<typeof configSource>) {
    super(config);
    this.promptDir = path.join(this.stateDir, 'agent-prompts');
    this.credential = credential;
    this.protectedFiles = source ? [credential, source.file] : [credential];
    this.protectedNames.add(path.resolve(credential));
    if (source) {
      this.protectedNames.add(source.file); this.protectedNames.add(source.real);
      this.protectedIds.add(source.id);
    }
    try { this.withCredential(O_PATH, () => {}); } catch { /* its name remains private while absent */ }
  }
  private withCredential<T>(flags: number, use: (fd: number) => T): T {
    const fd = fs.openSync(this.credential, flags | fs.constants.O_NONBLOCK);
    try {
      this.protectedIds.add(identity(fs.fstatSync(fd, { bigint: true })));
      this.protectedNames.add(fs.readlinkSync(fdPath(fd)));
      return use(fd);
    } finally { fs.closeSync(fd); }
  }
  readCredential(): string { return this.withCredential(fs.constants.O_RDONLY, fd => fs.readFileSync(fd, 'utf8')); }
  private checkPrivate(fd: number, real: string): void {
    if (this.protectedNames.has(real)) throw denied();
    const id = identity(fs.fstatSync(fd, { bigint: true }));
    if (this.protectedIds.has(id)) throw denied();
    // Protect replacements as well as previously seen objects. The candidate fd stays pinned.
    for (const file of this.protectedFiles) {
      let current: string;
      try { current = identity(fs.statSync(file, { bigint: true })); }
      catch (e) { if (e.code === 'ENOENT') continue; throw denied(); }
      this.protectedIds.add(current);
      if (id === current) throw denied();
    }
  }
  override refused(real: string): boolean {
    for (const name of this.protectedNames) if (under(real, name) || under(name, real)) return true;
    return super.refused(real);
  }
  override inRefused(real: string): boolean { return this.protectedNames.has(real) || super.inRefused(real); }
  override checkRead(real: string): string {
    if (this.protectedNames.has(real)) throw denied();
    return super.checkRead(real);
  }
  override checkWrite(real: string, kind: 'entry' | 'entry-no-follow' = 'entry'): string {
    try { this.withRead(real, () => {}, kind); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return super.checkWrite(real);
  }
  // The directory is reserved even before a writer acquires it, and after shutdown. Compare
  // both stateDir spellings: generic buffer ids may already have resolved a symlinked parent.
  private isPromptDir(dir: string): boolean {
    if (dir === this.promptDir) return true;
    if (path.basename(dir) !== 'agent-prompts') return false;
    try { return path.dirname(dir) === fs.realpathSync.native(this.stateDir); }
    catch (e) { if (e.code === 'ENOENT') return false; throw denied(); }
  }
  private storeFor(dir: string): PrivateStore | undefined {
    if (!this.isPromptDir(dir)) return;
    if (!this.promptStore) throw denied();
    return this.promptStore;
  }
  /* No callback may reopen the pathname for its data. */
  withRead<T>(file: string, use: Reader<T>, kind: 'read' | 'inspect' | 'entry' | 'entry-no-follow' | 'state' | 'private' | 'private-live' = 'read'): T {
    const privateEntry = kind === 'private' || kind === 'private-live';
    if (!privateEntry) {
      const store = this.storeFor(path.dirname(file));
      if (store) return store.withRead(path.basename(file), use);
    }
    if (this.protectedNames.has(file)) throw denied();
    const flags = kind === 'entry' || kind === 'entry-no-follow' || kind === 'inspect' ? O_PATH : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
    const fd = fs.openSync(file, flags | (privateEntry || kind === 'entry-no-follow' ? fs.constants.O_NOFOLLOW : 0));
    try {
      const real = fs.readlinkSync(fdPath(fd));
      // An indirect alias must not turn a private leaf into a generic fd read.
      if (!privateEntry && this.isPromptDir(path.dirname(real))) throw denied();
      this.checkPrivate(fd, real);
      if (kind === 'read' || kind === 'inspect') this.checkRead(real);
      const stat = fs.fstatSync(fd);
      if (privateEntry && !(kind === 'private-live' && stat.isDirectory()) && (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!())) throw denied();
      return use(fd, stat, real);
    } finally { fs.closeSync(fd); }
  }
  readSource(file: string, root: string): string {
    return this.withRead(file, (fd, stat, real) => {
      if (!stat.isFile() || !real.startsWith(root + path.sep)) throw denied();
      return fs.readFileSync(fd, 'utf8');
    });
  }
  readText(file: string): TextFile {
    try { return this.withRead(file, readTextEntry, 'inspect'); }
    catch (e) {
      // Recovery may use a snapshot after an I/O failure on a checked inode, never after
      // an authorization failure or a failure to establish the identity of an existing file.
      if (e instanceof FileError || e instanceof PathError) throw e;
      if (e.code === 'ENOENT') throw new FileError('no_buffer', `${file}: ENOENT`);
      throw new PathError('refused_path', `${file}: ${e.code}`);
    }
  }
  saveAtomic(file: string, text: string, { eol = 'lf' }: { eol?: Eol } = {}): Saved {
    const dir = path.dirname(file);
    const store = this.storeFor(dir) ?? this.storeFor(fs.realpathSync.native(dir));
    let mode: number | undefined, trailing = true;
    try {
      this.withRead(file, (fd, stat) => {
        mode = stat.mode & 0o7777;
        if (stat.size) {
          const reader = fs.openSync(fdPath(fd), 'r');
          try { const b = Buffer.allocUnsafe(1); trailing = fs.readSync(reader, b, 0, 1, stat.size - 1) === 1 && b[0] === 10; }
          finally { fs.closeSync(reader); }
        }
      }, 'inspect');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const data = encodeText(text, eol, trailing);
    let stat: fs.Stats;
    if (store) stat = store.write(path.basename(file), data);
    else {
      replaceFile(file, data, mode, true);
      fsyncDir(dir);
      stat = this.withRead(file, (_fd, st) => st, 'entry');
    }
    return { bytes: Buffer.byteLength(data), stat, hash: sha256(text), trailing };
  }
}

/* Operate relative to an opened, non-symlink private directory. A concurrent replacement cannot
   redirect a temp file, rename, chmod or read. The final rename never follows a destination link. */
export class PrivateStore {
  readonly dir: string;
  private readonly auth: AgentAuthority;
  private rootId?: string;
  private closed = false;
  constructor(auth: AgentAuthority) {
    this.auth = auth; this.dir = auth.promptDir;
    try { fs.mkdirSync(this.dir, 0o700); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.at((_, fd) => { this.rootId = identity(fs.fstatSync(fd, { bigint: true })); fs.fchmodSync(fd, 0o700); });
  }
  // Revoke captured stores before releasing their writer lock.
  close(): void { this.closed = true; }
  // Caller owns the descriptor. The delivery lock and all store operations must refer to this inode.
  openDirectory(): number {
    if (this.closed) throw denied();
    const fd = fs.openSync(this.dir, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const root = fs.fstatSync(fd, { bigint: true });
      if (root.uid !== BigInt(process.getuid!()) || (this.rootId !== undefined && this.rootId !== identity(root))) throw denied();
      return fd;
    } catch (e) { fs.closeSync(fd); throw e; }
  }
  private at<T>(fn: (root: string, fd: number) => T): T {
    const fd = this.openDirectory();
    try { return fn(fdPath(fd), fd); } finally { fs.closeSync(fd); }
  }
  private leaf(name: string): string {
    if (!/^[A-Za-z0-9_-]+\.(md|json)$/.test(name)) throw denied();
    return name;
  }
  entries(): string[] { return this.at(root => fs.readdirSync(root)); }
  // A failed write (the target became a directory) must leave an in-memory draft recoverable
  // without following a substituted link or reading the target.
  checkLive(name: string): void {
    this.at(root => this.auth.withRead(path.join(root, this.leaf(name)), () => {}, 'private-live'));
  }
  withRead<T>(name: string, use: Reader<T>): T {
    return this.at(root => this.auth.withRead(path.join(root, this.leaf(name)), use, 'private'));
  }
  read(name: string): string { return this.withRead(name, fd => fs.readFileSync(fd, 'utf8')); }
  write(name: string, data: string): fs.Stats { return this.replace(name, data, false); }
  writeReceipt(name: string, data: string): fs.Stats {
    if (!name.endsWith('.json')) throw denied();
    return this.replace(name, data, true);
  }
  private replace(name: string, data: string, receipt: boolean): fs.Stats {
    return this.at((root, dirFd) => {
      const file = path.join(root, this.leaf(name));
      try { this.auth.withRead(file, () => {}, 'private'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      replaceFile(file, data);
      if (receipt) fs.fsyncSync(dirFd);
      else { try { fs.fsyncSync(dirFd); } catch { /* best effort, like ordinary editor writes */ } }
      return this.auth.withRead(file, (_fd, stat) => stat, 'private');
    });
  }
}
