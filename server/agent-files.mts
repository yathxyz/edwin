// With agentHub configured, Edwin's file commands cannot access the hub token or daemon config
// by name, including symlinked parents and leaves. Content operations also check device and inode.
//
// A process running as the daemon user already has direct access. This is not a defense against
// edited state, external links/renames, permission changes or check/use races. Recovery trusts state
// and uses the same code as a daemon without agentHub.
import fs from 'node:fs';
import path from 'node:path';
import { Authority, PathError, under, type AuthorityConfig } from './paths.mts';
import { FileError, readText, writeAtomic, type TextFile } from './files.mts';

export class ProtectedFileError extends PathError {
  constructor() { super('refused_path', 'Private file: access refused'); }
}

const identity = (st: fs.BigIntStats) => `${st.dev}:${st.ino}`;
export interface FileExclusions { names: string[]; ids: string[] }

function canonicalNames(file: string): string[] {
  const names = [path.isAbsolute(file) ? file : process.cwd() + path.sep + file];
  // realpath needs an existing leaf; resolve its parent separately for names that can be created.
  try { names.push(path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file))); } catch { /* absent or inaccessible parent */ }
  try { names.push(fs.realpathSync.native(file)); }
  catch (e) {
    // A dangling leaf can still name a protected file that doesn't exist yet.
    if (e.code === 'ENOENT') {
      let leaf = names.at(-1)!;
      for (let hops = 0; hops < 40; hops++) {
        try { leaf = path.resolve(path.dirname(leaf), fs.readlinkSync(leaf)); } catch { break; }
        try { leaf = path.join(fs.realpathSync.native(path.dirname(leaf)), path.basename(leaf)); } catch { /* absent parent */ }
        names.push(leaf);
      }
    }
  }
  return names;
}

function checkIdentity(exclusions: FileExclusions, stat: fs.BigIntStats): void {
  if (exclusions.ids.includes(identity(stat))) throw new ProtectedFileError();
}

function checkNames(exclusions: FileExclusions, names: string[]): void {
  if (names.some(name => exclusions.names.includes(name))) throw new ProtectedFileError();
}

export function checkProtected(exclusions: FileExclusions, file: string, stat?: fs.BigIntStats): void {
  checkNames(exclusions, canonicalNames(file));
  if (stat) checkIdentity(exclusions, stat);
}

function protect(files: string[]): FileExclusions {
  const names = new Set<string>(), ids = new Set<string>();
  for (const file of files) {
    for (const name of canonicalNames(file)) names.add(name);
    try { ids.add(identity(fs.statSync(file, { bigint: true }))); } catch { /* still protected by name */ }
  }
  return { names: [...names], ids: [...ids] };
}

export class AgentAuthority extends Authority {
  override readonly agent: AgentAuthority = this;
  readonly exclusions: FileExclusions;
  readonly promptDir: string;
  promptStore?: PrivateStore;
  private readonly credential: string;

  constructor(config: AuthorityConfig, credential: string, configFile?: string) {
    super(config);
    this.credential = credential;
    this.promptDir = path.join(this.stateDir, 'agent-prompts');
    this.exclusions = protect(configFile === undefined ? [credential] : [credential, configFile]);
  }

  // The configured backend, not an Edwin file command, is the intended reader.
  readCredential(): string {
    const fd = fs.openSync(this.credential, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
  }

  override refused(real: string): boolean {
    // An entry mutation on a containing directory would move or remove the protected name too.
    return super.refused(real) || this.exclusions.names.some(name => under(name, real) || under(real, name));
  }

  checkNamed(file: string, kind: 'content' | 'entry' = 'content'): void {
    checkProtected(this.exclusions, file);
    if (kind === 'entry') return; // The operation acts on the link itself, not on its target.
    let stat: fs.BigIntStats;
    try { stat = fs.statSync(file, { bigint: true }); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'ELOOP') return; throw e; }
    checkIdentity(this.exclusions, stat);
  }

  override checkRead(real: string): string {
    const names = canonicalNames(real);
    checkNames(this.exclusions, names);
    if (names.some(name => super.refused(name))) throw new PathError('refused_path', `${real}: refused`);
    return real;
  }

  withRead<T>(file: string, use: (fd: number) => T): T {
    this.checkRead(file);
    const fd = fs.openSync(file, 'r');
    try {
      // Check the file actually opened before any bytes reach the caller.
      checkIdentity(this.exclusions, fs.fstatSync(fd, { bigint: true }));
      return use(fd);
    } finally { fs.closeSync(fd); }
  }

  override checkWrite(real: string, kind: 'content' | 'entry' = 'content'): string {
    this.checkNamed(real, kind);
    return super.checkWrite(real);
  }

  readSource(file: string, root: string): string {
    const real = fs.realpathSync.native(file);
    if (!under(real, root) || real === root || !fs.statSync(real).isFile()) throw new ProtectedFileError();
    return this.withRead(file, fd => fs.readFileSync(fd, 'utf8'));
  }

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
