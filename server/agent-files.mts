// Prevent accidental editor reads and writes of the configured token and daemon config.
import fs from 'node:fs';
import path from 'node:path';
import { Authority, PathError, type AuthorityConfig } from './paths.mts';
import { FileError, readText, writeAtomic, type TextFile } from './files.mts';

export class ProtectedFileError extends PathError {
  constructor() { super('refused_path', 'Private file: access refused'); }
}

export type FileExclusions = readonly { path: string; dev: bigint; ino: bigint }[];

export function checkProtected(files: FileExclusions, file: string, fd?: number): void {
  let real: string | undefined;
  try { real = fs.realpathSync.native(file); } catch { /* let the caller handle filesystem errors */ }
  if (files.some(f => f.path === real)) throw new ProtectedFileError();
  let st: fs.BigIntStats;
  try { st = fd === undefined ? fs.statSync(file, { bigint: true }) : fs.fstatSync(fd, { bigint: true }); }
  catch { return; }
  if (files.some(f => f.dev === st.dev && f.ino === st.ino)) throw new ProtectedFileError();
}

export function readProtected<T>(files: FileExclusions, file: string, use: (fd: number) => T): T {
  const fd = fs.openSync(file, 'r');
  try { checkProtected(files, file, fd); return use(fd); } finally { fs.closeSync(fd); }
}

function protectedFile(file: string | undefined, setting: string): FileExclusions[number] {
  try {
    const real = fs.realpathSync.native(file!);
    const { dev, ino } = fs.statSync(real, { bigint: true });
    return { path: real, dev, ino };
  } catch { throw new Error(`Cannot resolve ${setting}`); }
}

export class AgentAuthority extends Authority {
  override readonly agent: AgentAuthority = this;
  readonly exclusions: FileExclusions;
  readonly promptDir: string;
  promptStore?: PrivateStore;
  private readonly credential: string;

  constructor(config: AuthorityConfig, credential: string, configFile: string | null | undefined) {
    super(config);
    this.credential = credential;
    this.promptDir = path.join(this.stateDir, 'agent-prompts');
    this.exclusions = configFile === null
      ? [protectedFile(credential, 'agentHub.tokenFile')] // The read-only inspector has no daemon config.
      : [protectedFile(credential, 'agentHub.tokenFile'), protectedFile(configFile, '--config')];
  }

  // The configured backend, not an Edwin file command, is the intended reader.
  readCredential(): string {
    const fd = fs.openSync(this.credential, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  }

  checkNamed(file: string): void { checkProtected(this.exclusions, file); }
  withRead<T>(file: string, use: (fd: number) => T): T { return readProtected(this.exclusions, file, use); }

  readText(file: string): TextFile {
    try { return this.withRead(file, fd => readText(file, fd)); }
    catch (e) {
      if (e instanceof FileError || e instanceof PathError) throw e;
      throw new FileError(e.code === 'ENOENT' ? 'no_buffer' : 'refused_path', `${file}: ${e.code}`);
    }
  }
}

/* The writer lock governs the prompt store. Receipts also require a successful directory sync. */
export class PrivateStore {
  readonly dir: string;
  private closed = false;
  private readonly auth: AgentAuthority;
  constructor(auth: AgentAuthority) {
    this.auth = auth;
    this.dir = auth.promptDir;
    try { fs.mkdirSync(this.dir, 0o700); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const fd = this.openDirectory();
    try { fs.fchmodSync(fd, 0o700); } finally { fs.closeSync(fd); }
  }
  // Revoke captured stores before releasing their writer lock.
  close(): void { this.closed = true; }
  openDirectory(): number {
    if (this.closed) throw new ProtectedFileError();
    return fs.openSync(this.dir, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  }
  private file(name: string): string {
    if (this.closed || !/^[A-Za-z0-9_-]+\.(md|json)$/.test(name)) throw new ProtectedFileError();
    return path.join(this.dir, name);
  }
  entries(): string[] {
    if (this.closed) throw new ProtectedFileError();
    return fs.readdirSync(this.dir);
  }
  // A named draft or receipt can itself be configured as a protected file.
  read(name: string): string { return this.auth.withRead(this.file(name), fd => fs.readFileSync(fd, 'utf8')); }
  write(name: string, data: string): fs.Stats { return this.replace(name, data, false); }
  writeReceipt(name: string, data: string): fs.Stats {
    if (!name.endsWith('.json')) throw new ProtectedFileError();
    return this.replace(name, data, true);
  }
  private replace(name: string, data: string, receipt: boolean): fs.Stats {
    const file = this.file(name);
    this.auth.checkNamed(file); // Draft writes bypass the general write roots, not the named exclusions.
    writeAtomic(file, data, receipt);
    return fs.statSync(file);
  }
}
