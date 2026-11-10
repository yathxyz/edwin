// The directory commands behind dired (server/fs.mts): what fs-list and fs-stat show, what fs-delete, fs-copy and
// fs-mkdir do, and their share of the refusal list (R16.14, R14.8): nothing in, on or above ~/.ssh or a systemd
// user-unit directory, nothing outside the writable paths, none of edwind's own directories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { Msg, TestDir, EdwindChild } from './edit-client.mts';

let dir: TestDir, child: EdwindChild, c: EditClient, outside: string;
const at = (p: string) => path.join(dir.dirs.home, p);
const put = (p: string, text = 'x\n') => { fs.mkdirSync(path.dirname(at(p)), { recursive: true }); fs.writeFileSync(at(p), text); return at(p); };
const call = (cmd: string, a: Msg) => c.call(cmd, [a]);
const refused = async (cmd: string, a: Msg, why: string) => { const r = await call(cmd, a); assert.equal(r.t, 'error', why); assert.equal(r.code, 'refused_path', `${why}: ${r.msg}`); };

before(async () => {
  dir = makeDir(); child = await startEdwind(dir);
  c = new EditClient(dir.cfg.socket); await c.connect(); assert.equal((await c.hello()).t, 'welcome');
  for (const d of ['.ssh', '.config/systemd/user', '.local/share/systemd']) fs.mkdirSync(at(d), { recursive: true });
  fs.writeFileSync(at('.ssh/authorized_keys'), 'key\n');
  fs.symlinkSync(at('.ssh'), at('sshlink'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'edwind-outside-'));
  fs.writeFileSync(path.join(outside, 'o.md'), 'o\n');
});
after(async () => { c.close(); await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

test('fs-list: every name with its kind, size, mode and time; links with their target; the notes directory by default', async () => {
  put('ls/a.md', 'hello\n'); put('ls/.dot'); put('ls/sub/in.md');
  fs.chmodSync(at('ls/a.md'), 0o640);
  fs.symlinkSync('a.md', at('ls/to-file')); fs.symlinkSync('sub', at('ls/to-dir')); fs.symlinkSync('nowhere', at('ls/dangling'));
  const r = await call('fs-list', { dir: '~/ls' });
  assert.equal(r.t, 'result', JSON.stringify(r));
  assert.equal(r.value.dir, fs.realpathSync(at('ls'))); assert.equal(r.value.home, dir.dirs.home);
  const by: Record<string, Msg> = Object.fromEntries(r.value.entries.map((e: Msg) => [e.name, e]));
  assert.deepEqual(Object.keys(by).sort(), ['.dot', 'a.md', 'dangling', 'sub', 'to-dir', 'to-file']);
  assert.deepEqual({ kind: by['a.md'].kind, size: by['a.md'].size, mode: by['a.md'].mode }, { kind: 'file', size: 6, mode: 0o640 });
  assert.ok(Math.abs(by['a.md'].mtime - Date.now()) < 60000);
  assert.equal(by.sub.kind, 'dir');
  assert.deepEqual([by['to-file'].kind, by['to-file'].target, by['to-file'].dir], ['link', 'a.md', undefined]);
  assert.deepEqual([by['to-dir'].kind, by['to-dir'].target, by['to-dir'].dir], ['link', 'sub', true]);
  assert.deepEqual([by.dangling.kind, by.dangling.target, by.dangling.dir], ['link', 'nowhere', undefined]);
  // A link to a directory lists what it leads to, under its real name.
  assert.equal((await call('fs-list', { dir: '~/ls/to-dir' })).value.dir, fs.realpathSync(at('ls/sub')));
  fs.writeFileSync(path.join(dir.dirs.notes, 'n.md'), 'n\n');
  const notes = await call('fs-list', {});
  assert.equal(notes.value.dir, fs.realpathSync(dir.dirs.notes)); assert.deepEqual(notes.value.entries.map((e: Msg) => e.name), ['n.md']);
  assert.deepEqual((await call('fs-list', { dir: 'n.md' })).code, 'bad_request', 'a file does not list');
  assert.equal((await call('fs-list', { dir: '~/ls/none' })).code, 'bad_request');
  assert.equal((await call('fs-list', { dir: '../home' })).code, 'bad_request', 'a relative path may not climb');
});

test('fs-list and fs-stat: a directory above a refused path lists and names it; nothing in or on one is shown', async () => {
  const names = (await call('fs-list', { dir: '~' })).value.entries.map((e: Msg) => e.name);
  assert.ok(names.includes('.ssh') && names.includes('.config'));
  assert.equal((await call('fs-list', { dir: '~/.config' })).t, 'result', 'above ~/.config/systemd');
  for (const d of ['~/.ssh', '~/sshlink', '~/.config/systemd', '~/.config/systemd/user', '~/.local/share/systemd', '~/ls/../.ssh']) await refused('fs-list', { dir: d }, d);
  for (const p of ['~/.ssh/authorized_keys', '~/sshlink/authorized_keys', '~/.ssh']) await refused('fs-stat', { path: p }, p);
  const st = await call('fs-stat', { path: '~/sshlink' });
  assert.deepEqual([st.value.entry.kind, st.value.entry.dir, st.value.path, st.value.id], ['link', true, fs.realpathSync(dir.dirs.home) + '/sshlink', null], 'the link itself is an entry of ~');
  assert.deepEqual((await call('fs-stat', { path: '~/ls/sub' })).value.entry.kind, 'dir');
  // The id is the one a visit opens: ~/… under home, relative in the notes, a link as its target, a new file too.
  assert.equal((await call('fs-stat', { path: at('ls/a.md') })).value.id, '~/ls/a.md');
  assert.equal((await call('fs-stat', { path: '~/ls/to-file' })).value.id, '~/ls/a.md');
  assert.equal((await call('fs-stat', { path: path.join(dir.dirs.notes, 'n.md') })).value.id, 'n.md');
  assert.deepEqual((await call('fs-stat', { path: '~/ls/none' })).value, { path: fs.realpathSync(at('ls')) + '/none', id: '~/ls/none', entry: null });
  assert.equal((await call('fs-stat', { path: '~/nowhere/none' })).code, 'bad_request', 'no parent');
  // Reads reach outside the writable paths, as opening a file does.
  assert.deepEqual((await call('fs-list', { dir: outside })).value.entries.map((e: Msg) => e.name), ['o.md']);
});

test('fs-delete: files and links go, a link never takes its target, a full directory only with recursive', async () => {
  const f = put('rm/f.md'); put('rm/full/a/b.md'); fs.mkdirSync(at('rm/empty')); put('rm/target.md');
  fs.symlinkSync('target.md', at('rm/link')); fs.symlinkSync('full', at('rm/dirlink'));
  assert.deepEqual((await call('fs-delete', { path: f })).value, { deleted: true, path: fs.realpathSync(at('rm')) + '/f.md' });
  assert.equal(fs.existsSync(f), false);
  assert.equal((await call('fs-delete', { path: '~/rm/link' })).value.deleted, true);
  assert.ok(fs.existsSync(at('rm/target.md')), 'the target of a deleted link stays');
  assert.equal((await call('fs-delete', { path: '~/rm/dirlink', recursive: true })).value.deleted, true);
  assert.ok(fs.existsSync(at('rm/full/a/b.md')), 'a link to a directory is unlinked, never descended');
  assert.equal((await call('fs-delete', { path: '~/rm/empty' })).value.deleted, true);
  const full = await call('fs-delete', { path: '~/rm/full' });
  assert.deepEqual([full.value.deleted, full.value.nonEmpty], [false, true]); assert.ok(fs.existsSync(at('rm/full/a/b.md')));
  assert.equal((await call('fs-delete', { path: '~/rm/full', recursive: true })).value.deleted, true);
  assert.equal(fs.existsSync(at('rm/full')), false);
  assert.equal((await call('fs-delete', { path: '~/rm/none' })).code, 'bad_request');
  assert.deepEqual(fs.readdirSync(at('rm')), ['target.md']);
});

test('fs-delete: an open buffer of a deleted file stays, marked deleted', async () => {
  const f = put('rm2/open.md', 'kept in the buffer\n');
  const o = await c.open(f);
  assert.equal(o.text, 'kept in the buffer\n');
  const meta = c.next((m: Msg) => m.t === 'meta' && m.diskChanged === 'deleted');
  assert.equal((await call('fs-delete', { path: f })).value.deleted, true);
  await meta;
  assert.equal((await c.open(f)).text, 'kept in the buffer\n');
});

test('fs-delete refuses the refusal list, what is outside the writable paths and edwind\'s own directories', async () => {
  for (const p of ['~/.ssh/authorized_keys', '~/.ssh', '~/sshlink/authorized_keys', '~/.config', '~/.config/systemd/user', '~/.local/share', '~/ls/../.ssh']) await refused('fs-delete', { path: p, recursive: true }, p);
  await refused('fs-delete', { path: path.join(outside, 'o.md') }, 'outside');
  for (const p of [dir.dirs.notes, dir.dirs.state, dir.dirs.config, dir.root, dir.dirs.home + '/..']) await refused('fs-delete', { path: p, recursive: true }, p);
  // Inside the state directory: edwind's journals and image log.
  const inState = fs.readdirSync(dir.dirs.state)[0];
  assert.ok(inState, 'edwind keeps something in stateDir');
  await refused('fs-delete', { path: path.join(dir.dirs.state, inState), recursive: true }, 'inside stateDir');
  await refused('rename-file', { src: path.join(dir.dirs.state, inState), dst: '~/taken' }, 'rename out of stateDir');
  await refused('rename-file', { src: put('rm3/k.md'), dst: path.join(dir.dirs.state, 'k.md') }, 'rename into stateDir');
  assert.deepEqual(fs.readdirSync(at('.ssh')), ['authorized_keys']); assert.ok(fs.existsSync(path.join(outside, 'o.md')));
  assert.ok(fs.existsSync(path.join(dir.dirs.state, inState)));
  // The link to ~/.ssh is an entry of ~, inside the writable paths: it may go, and takes nothing with it.
  fs.symlinkSync(at('.ssh'), at('sshlink2'));
  assert.equal((await call('fs-delete', { path: '~/sshlink2' })).value.deleted, true);
  assert.deepEqual(fs.readdirSync(at('.ssh')), ['authorized_keys']);
});

test('fs-copy: files, links as links, whole directories; into a directory; never over what exists', async () => {
  put('cp/a.md', 'a\n'); put('cp/tree/x/y.md', 'y\n'); fs.symlinkSync('a.md', at('cp/link')); fs.symlinkSync('../a.md', at('cp/tree/up'));
  fs.mkdirSync(at('cp/into')); fs.chmodSync(at('cp/a.md'), 0o600);
  const r = await call('fs-copy', { src: '~/cp/a.md', dst: '~/cp/b.md' });
  assert.equal(r.t, 'result', JSON.stringify(r)); assert.equal(r.value.dir, false);
  assert.equal(fs.readFileSync(at('cp/b.md'), 'utf8'), 'a\n'); assert.equal(fs.statSync(at('cp/b.md')).mode & 0o777, 0o600);
  assert.equal((await call('fs-copy', { src: '~/cp/a.md', dst: '~/cp/into' })).value.dst, fs.realpathSync(at('cp/into')) + '/a.md');
  assert.equal((await call('fs-copy', { src: '~/cp/link', dst: '~/cp/link2' })).t, 'result');
  assert.equal(fs.readlinkSync(at('cp/link2')), 'a.md');
  const t = await call('fs-copy', { src: '~/cp/tree', dst: '~/cp/tree2' });
  assert.equal(t.value.dir, true);
  assert.equal(fs.readFileSync(at('cp/tree2/x/y.md'), 'utf8'), 'y\n'); assert.equal(fs.readlinkSync(at('cp/tree2/up')), '../a.md');
  for (const [s, d, why] of [['~/cp/a.md', '~/cp/b.md', 'a file exists'], ['~/cp/a.md', '~/cp/link', 'a link exists'], ['~/cp/a.md', '~/cp/into', 'the directory already holds the name'], ['~/cp/a.md', '~/cp/a.md', 'itself']]) {
    const e = await call('fs-copy', { src: s, dst: d });
    assert.equal(e.code, 'bad_request', why);
  }
  assert.match((await call('fs-copy', { src: '~/cp/tree', dst: '~/cp/tree/x/again' })).msg, /into itself/);
  assert.equal((await call('fs-copy', { src: '~/cp/none', dst: '~/cp/n2' })).code, 'bad_request');
  assert.equal(fs.readFileSync(at('cp/b.md'), 'utf8'), 'a\n');
  // A name an unsaved buffer already holds is taken.
  await c.open(at('cp/unsaved.md'), { create: true });
  assert.equal((await call('fs-copy', { src: '~/cp/a.md', dst: '~/cp/unsaved.md' })).code, 'bad_request');
});

test('fs-copy refuses a source in a refused path, a tree that holds one, and every destination a rename would refuse', async () => {
  for (const s of ['~/.ssh/authorized_keys', '~/sshlink/authorized_keys', '~/.ssh', '~/.config', '~/.local/share']) { await refused('fs-copy', { src: s, dst: '~/cp-taken' }, s); assert.equal(fs.existsSync(at('cp-taken')), false, s); }
  const src = put('cp2/k.md');
  for (const d of ['~/.ssh/k', '~/.ssh', '~/sshlink', '~/sshlink/k', '~/.config/systemd/user/x.service', '~/cp2/../.ssh/k']) {
    const r = await call('fs-copy', { src, dst: d });
    assert.equal(r.code, 'refused_path', d);
  }
  await refused('fs-copy', { src, dst: path.join(outside, 'k.md') }, 'outside the writable paths');
  await refused('fs-copy', { src, dst: path.join(dir.dirs.state, 'k.md') }, 'into stateDir');
  assert.deepEqual(fs.readdirSync(at('.ssh')), ['authorized_keys']); assert.deepEqual(fs.readdirSync(at('.config/systemd/user')), []); assert.deepEqual(fs.readdirSync(outside), ['o.md']);
  // Reading from outside the writable paths is a read: the copy lands inside them.
  assert.equal((await call('fs-copy', { src: path.join(outside, 'o.md'), dst: '~/cp2/o.md' })).t, 'result');
  assert.equal(fs.readFileSync(at('cp2/o.md'), 'utf8'), 'o\n');
});

test('fs-mkdir: a directory with the parents it lacks; refusals as for a write', async () => {
  const r = await call('fs-mkdir', { path: '~/mk/a/b' });
  assert.deepEqual(r.value, { ok: true, path: fs.realpathSync(dir.dirs.home) + '/mk/a/b' });
  assert.ok(fs.statSync(at('mk/a/b')).isDirectory());
  assert.equal((await call('fs-mkdir', { path: '~/mk/a' })).code, 'bad_request', 'exists');
  put('mk/file');
  assert.equal((await call('fs-mkdir', { path: '~/mk/file/under' })).code, 'bad_request', 'under a file');
  assert.equal((await call('fs-mkdir', { path: 'in-notes/deep' })).t, 'result'); assert.ok(fs.statSync(path.join(dir.dirs.notes, 'in-notes/deep')).isDirectory());
  for (const p of ['~/.ssh/new', '~/sshlink/new', '~/.config/systemd/user/new', '~/.local/share/systemd/new', path.join(outside, 'new'), path.join(dir.dirs.state, 'new'), '~/mk/../.ssh/new']) await refused('fs-mkdir', { path: p }, p);
  assert.deepEqual(fs.readdirSync(at('.ssh')), ['authorized_keys']); assert.deepEqual(fs.readdirSync(outside).sort(), ['o.md']);
});

test('the fs commands take one object and refuse anything that is not a path', async () => {
  for (const [cmd, a] of [['fs-list', { dir: 7 }], ['fs-list', { dir: '' }], ['fs-stat', {}], ['fs-delete', {}], ['fs-delete', { path: 'a\0b' }], ['fs-copy', { src: '~/cp/a.md' }], ['fs-mkdir', { path: 'name:x' }], ['fs-mkdir', { path: 'a//b' }]] as [string, Msg][]) {
    const r = await call(cmd, a);
    assert.equal(r.code, 'bad_request', `${cmd} ${JSON.stringify(a)}`);
  }
  assert.equal((await c.call('fs-delete', ['~/ls/a.md'])).code, 'bad_request', 'a bare string is not the argument');
  assert.ok(fs.existsSync(at('ls/a.md')));
});
