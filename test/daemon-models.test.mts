// programs.edwin.daemon's settings and credentials (the edwin-daemon-models check): the daemon script
// (EDWIN_DAEMON, the package's edwin-daemon) run as the user unit runs it, as a throwaway user, with the settings
// fragment the module evaluated to (EDWIND_CONFIG_EXTRA) and a credentials directory as LoadCredential makes one
// (CREDENTIALS_DIRECTORY). The fragment's fields reach the edwind.json it writes and edwind takes them; then forms
// and frame requests over the socket try every way to a credential's bytes (a file read by load, include and
// require, a visit by the protocol and from Scheme, a symlink to one in the notes, an init.scm that is one, and
// the models' own introspection) and get none, from the copy in the credentials directory and from the file it
// was loaded from (laid out as sops-nix lays out /run/secrets, and still refused once sops re-points it): nothing any client is sent, nothing edwind logs and nothing it
// keeps in its state holds a key. Fragments that would set the daemon's own fields are refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EditClient } from './edit-client.mts';
import type { Msg, ClientOptions } from './edit-client.mts';

const DAEMON = process.env.EDWIN_DAEMON || '', EXTRA = process.env.EDWIND_CONFIG_EXTRA || '';
if (!DAEMON || !EXTRA) throw new Error('EDWIN_DAEMON (edwin-daemon) and EDWIND_CONFIG_EXTRA (the module\'s fragment) must be set; the edwin-daemon-models check sets them');
const FRAGMENT = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
/* Distinctive bytes, one per credential the fragment names; the whole run is scanned for them. */
const KEYS: Record<string, string> = { 'anthropic-api-key': 'sk-test-' + randomBytes(12).toString('hex'), 'brain-read-token': 'brain-' + randomBytes(12).toString('hex') };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface User { home: string; run: string; sock: string; creds: string; secrets: string; env: NodeJS.ProcessEnv }
const tmp = (p: string) => fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', p));
function user(extra: string): User {
  const home = tmp('u'), run = path.join(home, 'run'), creds = path.join(home, 'credentials');
  fs.mkdirSync(run, { mode: 0o700 }); fs.mkdirSync(creds, { mode: 0o700 });
  for (const [n, k] of Object.entries(KEYS)) fs.writeFileSync(path.join(creds, n), k + '\n', { mode: 0o400 });
  /* The files LoadCredential loads from, as sops-nix keeps them: secrets is a symlink to secrets.d/GENERATION. */
  const secrets = path.join(home, 'secrets');
  generation(secrets, 1);
  return { home, run, creds, secrets, sock: path.join(run, 'edwin/edit.sock'), env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: run, TMPDIR: home, EDWIND_CONFIG_EXTRA: extra, CREDENTIALS_DIRECTORY: creds } };
}
/* A sops-nix activation: the keys in secrets.d/N, secrets re-pointed there at once, the older generation pruned. */
function generation(secrets: string, n: number) {
  const dir = path.join(path.dirname(secrets), 'secrets.d', String(n)), next = secrets + '.new';
  fs.mkdirSync(dir, { recursive: true, mode: 0o751 });
  for (const [c, k] of Object.entries(KEYS)) fs.writeFileSync(path.join(dir, c), k + '\n', { mode: 0o400 });
  fs.symlinkSync(path.join('secrets.d', String(n)), next); fs.renameSync(next, secrets);
  if (n > 1) fs.rmSync(path.join(path.dirname(secrets), 'secrets.d', String(n - 1)), { recursive: true });
}
/* `edwin --fg-daemon` as the unit runs it: the script writes the config and execs edwind in this process. */
interface Daemon { p: ChildProcess; logs: string; code: number | null | undefined }
function daemon(u: User): Daemon {
  const d: Daemon = { p: spawn(DAEMON, ['--fg'], { env: u.env, stdio: ['ignore', 'pipe', 'pipe'] }), logs: '', code: undefined };
  d.p.stdout!.on('data', x => { d.logs += x; }); d.p.stderr!.on('data', x => { d.logs += x; });
  d.p.on('exit', c => { d.code = c; });
  return d;
}
const answers = (sock: string) => new Promise<boolean>(r => { const c = net.connect(sock); c.on('connect', () => { c.destroy(); r(true); }).on('error', () => r(false)); });
async function up(u: User, d: Daemon) {
  const end = Date.now() + 30000;
  while (!(await answers(u.sock))) { if (d.code !== undefined || Date.now() > end) throw new Error(`edwind did not answer (exit ${d.code}): ${d.logs}`); await sleep(50); }
}
const exited = (d: Daemon) => new Promise<number | null>(r => { if (d.code !== undefined) r(d.code); else d.p.on('exit', c => r(c)); });

let u: User, d: Daemon, refusePaths: string[];
const received: string[] = [];
before(async () => {
  u = user(EXTRA);
  /* The module refuses each credential's file (/run/secrets/...): the fragment as the module makes it for files
     at this user's secrets, since the check's sandbox has no /run/secrets. */
  refusePaths = [...(FRAGMENT.refusePaths || []), ...Object.keys(KEYS).map(n => path.join(u.secrets, n))];
  u.env.EDWIND_CONFIG_EXTRA = path.join(u.home, 'extra.json');
  fs.writeFileSync(u.env.EDWIND_CONFIG_EXTRA, JSON.stringify({ ...FRAGMENT, refusePaths }));
  /* A symlink in the notes to a credential, and an init.scm that is one. */
  fs.mkdirSync(path.join(u.home, 'notes'));
  fs.symlinkSync(path.join(u.creds, 'anthropic-api-key'), path.join(u.home, 'notes', 'leak.org'));
  fs.mkdirSync(path.join(u.home, '.config/edwin'), { recursive: true });
  fs.symlinkSync(path.join(u.creds, 'anthropic-api-key'), path.join(u.home, '.config/edwin/init.scm'));
  d = daemon(u);
  await up(u, d);
});
after(async () => {
  if (d && d.code === undefined) { d.p.kill('SIGTERM'); await exited(d); }
});
const client = async (opts?: ClientOptions) => {
  const c = new EditClient(u.sock, opts); await c.connect();
  const push = c.push.bind(c); c.push = (m: Msg) => { received.push(JSON.stringify(m)); push(m); };
  assert.equal((await c.hello()).t, 'welcome'); return c;
};
const leaks = (s: string) => Object.values(KEYS).filter(k => s.includes(k));

test('the fragment the module evaluated to is merged into the edwind.json the daemon writes, and edwind takes it', async () => {
  const written = JSON.parse(fs.readFileSync(path.join(u.run, 'edwin/edwind.json'), 'utf8'));
  for (const [k, v] of Object.entries(FRAGMENT)) if (k !== 'refusePaths') assert.deepEqual(written[k], v, k);
  assert.equal(written.socket, u.sock); assert.equal(written.notesDir, fs.realpathSync(path.join(u.home, 'notes')));
  assert.deepEqual(written.refusePaths, ['~/.ssh', '~/.config/systemd', '~/.local/share/systemd', ...refusePaths], 'the fragment adds refusals and drops none');
  assert.equal(leaks(JSON.stringify(written)).length, 0, 'the config names credentials, never holds one');
  const c = await client();
  const bs = (await c.call('model-backends')).value;
  assert.equal(bs[0].name, 'anthropic'); assert.equal(bs[0].credential, FRAGMENT.models.anthropic.credential); assert.equal(bs[0].usable, true, 'edwind reads the credential');
  assert.deepEqual((await c.call('status')).value.models, FRAGMENT.models.tiers);
  c.close();
});

test('no form and no frame request gets a credential\'s bytes', async () => {
  const s = await client(), f = await client({ kind: 'frame' });
  const key = path.join(u.creds, 'anthropic-api-key'), q = JSON.stringify(key), dirq = JSON.stringify(u.creds);
  const forms = [
    `(load ${q})`,
    `(let () (include ${q}))`,
    `(require 'anthropic-api-key ${q})`,
    `(begin (set! load-path (cons ${dirq} load-path)) (require 'anthropic-api-key))`,
    `(begin (find-file ${q}) (buffer-string))`,
    `(begin (find-file "leak.org") (buffer-string))`,
    `(credential "anthropic-api-key")`,
    `(credential "brain-read-token")`,
    `(gptel-backend-info)`,
    `(model-backends)`,
  ];
  const out: string[] = [];
  for (const form of forms) { const r = await s.form(form); out.push(form + ' => ' + JSON.stringify(r)); }
  assert.match(out[0], /Cannot open file/, 'load: no such file, as far as Scheme can tell');
  assert.match(out[7], /no credential named/, 'brain\'s token is no handle Scheme can name');
  assert.equal((await s.form('(credential-available? (credential "anthropic-api-key"))')).value, '#t');
  /* The symlink by its absolute path is refused as its target is; by its notes-relative id it escapes the notes. */
  for (const [id, code] of [[key, 'refused_path'], [path.join(u.home, 'notes/leak.org'), 'refused_path'], ['leak.org', 'bad_id']]) {
    const o = await f.open(id);
    assert.equal(o.error?.code, code, `${id}: ${JSON.stringify(o.error)}`); assert.equal(o.text, null);
    out.push(JSON.stringify(o), JSON.stringify(await f.call('visit-id', [id])));
  }
  out.push(JSON.stringify((await f.call('status')).value), JSON.stringify((await f.call('model-backends')).value));
  assert.deepEqual(out.flatMap(leaks), [], out.join('\n'));
  s.close(); f.close();
});

test('no form and no frame request gets a credential\'s bytes from the file it was loaded from, before and after sops re-points it', async () => {
  const s = await client(), f = await client({ kind: 'frame' });
  const out: string[] = [];
  const tryAll = async (file: string) => {
    const q = JSON.stringify(file);
    for (const form of [`(load ${q})`, `(let () (include ${q}))`, `(require 'anthropic ${q})`,
      /* The visit makes an empty buffer of the file ("(New file)"); it goes, or the next load would read it. */
      `(begin (find-file ${q}) (let ((t (buffer-string))) (kill-buffer (current-buffer)) t))`]) {
      const r = await s.form(form); out.push(form + ' => ' + JSON.stringify(r));
      if (form.startsWith('(load')) assert.match(JSON.stringify(r), /Cannot open file/, `${form}: ${JSON.stringify(r)}`);
    }
    const o = await f.open(file);
    assert.equal(o.error?.code, 'refused_path', `${file}: ${JSON.stringify(o.error)}`); assert.equal(o.text, null);
    out.push(JSON.stringify(o), JSON.stringify(await f.call('visit-id', [file])));
  };
  const source = path.join(u.secrets, 'anthropic-api-key');
  await tryAll(source); await tryAll(fs.realpathSync(source));
  generation(u.secrets, 2);
  assert.equal(fs.realpathSync(source), path.join(fs.realpathSync(u.home), 'secrets.d/2/anthropic-api-key'));
  await tryAll(source); await tryAll(fs.realpathSync(source));
  assert.deepEqual(out.flatMap(leaks), [], out.join('\n'));
  s.close(); f.close();
});

test('the init.scm that is a credential is not read, and nothing edwind sent, logged or kept holds a key', async () => {
  const s = await client();
  /* edwind started: the refused init.scm is as absent. */
  assert.equal((await s.form('1')).value, '1');
  s.close();
  d.p.kill('SIGTERM'); await exited(d);
  const state = path.join(u.home, '.local/state/edwin');
  const files: string[] = [];
  const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else if (e.isFile()) files.push(q); } };
  walk(state); walk(path.join(u.run, 'edwin'));
  assert.ok(files.length > 0, 'edwind kept state');
  for (const file of files) assert.deepEqual(leaks(fs.readFileSync(file, 'latin1')), [], file);
  assert.deepEqual(leaks(d.logs), [], 'edwind\'s log (the journal of the unit)');
  assert.deepEqual(received.flatMap(leaks), [], 'every message edwind sent');
});

test('a fragment that would set the daemon\'s own fields, or is no object, is refused before edwind starts', async () => {
  for (const [name, text] of [['socket', '{"socket": "/tmp/elsewhere.sock"}'], ['notesDir', '{"notesDir": "/"}'], ['list', '[]'], ['refusePaths', '{"refusePaths": "~/.ssh"}']]) {
    const dir = tmp('x'), file = path.join(dir, 'extra.json');
    fs.writeFileSync(file, text);
    const v = user(file), e = daemon(v), code = await exited(e);
    assert.equal(code, 1, `${name}: ${e.logs}`); assert.match(e.logs, /EDWIND_CONFIG_EXTRA/, name);
    assert.equal(fs.existsSync(path.join(v.run, 'edwin/edwind.json')), false, `${name}: no config written`);
  }
  /* With EDWIND_CONFIG the fragment would be ignored: refused instead. */
  const v = user(EXTRA), e = spawn(DAEMON, [], { env: { ...v.env, EDWIND_CONFIG: path.join(v.home, 'edit.json') }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; e.stderr!.on('data', x => { err += x; });
  const code = await new Promise(r => e.on('exit', r));
  assert.equal(code, 1); assert.match(err, /EDWIND_CONFIG_EXTRA is merged into the config made at a start/);
});
