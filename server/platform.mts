import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './paths.mts';

const windows = process.platform === 'win32';
const PIPE_PREFIX = '\\\\.\\pipe\\';

export function windowsPipe(name: string): string { return PIPE_PREFIX + name; }

export function daemonDefaults() {
  if (windows) {
    const profile = process.env.USERPROFILE || os.homedir();
    const roaming = process.env.APPDATA || path.join(profile, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(profile, 'AppData', 'Local');
    return {
      socket: windowsPipe(`edwin-${os.userInfo().username}-edit`),
      stateDir: path.join(local, 'edwin'),
      notesDir: path.join(profile, 'notes'),
      configDir: path.join(roaming, 'edwin'),
    };
  }
  const home = process.env.HOME || os.homedir(), runtime = process.env.XDG_RUNTIME_DIR;
  return {
    /* Where edwinclient looks after $EDWIN_SOCKET. */
    socket: runtime ? path.join(runtime, 'edwin/edit.sock') : undefined,
    stateDir: path.join(home, '.local/state/edwin/edwind'),
    notesDir: undefined,
    configDir: path.join(home, '.config/edwin'),
  };
}

export function resolveLocalEndpoint<V extends string | undefined>(file: string, key: string, value: V): V {
  if (value === undefined) return value;
  if (windows) {
    const name = value.slice(PIPE_PREFIX.length);
    if (!value.startsWith(PIPE_PREFIX) || !name || /[\\\0]/.test(name)) throw new Error(`${file}: ${key} must be a Windows named pipe (${windowsPipe('NAME')})`);
    return value;
  }
  if (!path.isAbsolute(expandHome(value))) throw new Error(`${file}: ${key} must be an absolute path`);
  return expandHome(value) as V;
}

/* Kept separate from resolution so Unix length checks still follow the write/refuse path checks. */
export function checkLocalEndpointLength(file: string, key: string, value: string | undefined): void {
  if (!windows && value && Buffer.byteLength(value) >= 108) throw new Error(`${file}: ${key} is too long for a socket path (108 bytes)`);
}

export function localEndpointDirectory(sock: string): string | undefined {
  return windows ? undefined : path.dirname(sock);
}

export function prepareLocalEndpoint(sock: string): number | undefined {
  const dir = localEndpointDirectory(sock);
  if (dir === undefined) return;
  const euid = process.geteuid!();
  let dst: fs.Stats;
  try { dst = fs.lstatSync(dir); } catch (e) { throw new Error(`${dir}: ${e.code}`); }
  if (!dst.isDirectory() || dst.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (dst.uid !== euid) throw new Error(`${dir} is owned by uid ${dst.uid}, not ${euid}`);
  if ((dst.mode & 0o777) !== 0o700) throw new Error(`${dir} has mode ${(dst.mode & 0o777).toString(8)}, not 700`);
  try { const st = fs.lstatSync(sock); if (st.isSymbolicLink() || !st.isSocket()) throw new Error(`${sock} exists and is not a socket`); fs.unlinkSync(sock); }
  catch (e) { if (e.code !== 'ENOENT') { if (e instanceof Error && !(e as NodeJS.ErrnoException).code) throw e; throw new Error(`${sock}: ${e.code}`); } }
  return euid;
}

export function verifyLocalEndpoint(sock: string, euid: number | undefined): void {
  if (windows) return;
  fs.chmodSync(sock, 0o600);
  const st = fs.lstatSync(sock);
  if (st.isSymbolicLink() || !st.isSocket()) throw new Error(`${sock} is not the socket edwind created`);
  if (st.uid !== euid) throw new Error(`${sock} is owned by uid ${st.uid}, not ${euid}`);
  if ((st.mode & 0o777) !== 0o600) throw new Error(`${sock} has mode ${(st.mode & 0o777).toString(8)}, not 600`);
}

export function removeLocalEndpoint(sock: string): void {
  if (windows) return;
  try { fs.unlinkSync(sock); } catch (e) { /* gone */ }
}
