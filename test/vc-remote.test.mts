// Fetch, pull and push from git's status buffer (src/vc-git.ts: f, F and p) in the headless runtime, with real
// git from PATH through Ed.proc over fake-proc.mts's host.proc, against local bare remotes (and a loopback HTTP
// server that asks for credentials) in throwaway repositories under a throwaway HOME; host.files is node:fs, as
// host-native.ts has it. Nothing reaches the network. One Edwin per process, so the cases run in order.
// Run: node --test test/vc-remote.test.mts
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { startEdwin, type Edwin, type NodeHost } from './headless.mts';
import { fakeProc, type FakeProc } from './fake-proc.mts';

const ed = await startEdwin();
const { Ed, E } = ed;
ed.eval('(set! corfu-auto #f)');
const lastMessage = (): string => { const t: string = Ed.getBuffer('*Messages*').text.replace(/\n+$/, ''); return t.slice(t.lastIndexOf('\n') + 1); };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-remote-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's is read, no askpass of theirs runs;
   fixed dates. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_ALLOW_PROTOCOL', 'DISPLAY'])
  delete process.env[k];
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const proc = fakeProc();
const host = ed.host as NodeHost & { proc?: FakeProc; files?: Edwin };
host.proc = proc;
host.files = {
  read(n: string) { try { return fs.readFileSync(n, 'utf8'); } catch (e) { return null; } },
  exists: (n: string) => fs.existsSync(n), resolve: (n: string) => path.resolve(root, n), truename: (n: string) => n, label: (n: string) => n,
  write(n: string, text: string) { fs.writeFileSync(n, text); return true; }, remove() { throw new Error('not here'); }, list: () => [] as string[], cwd: root,
  tree: {
    names: (d: string) => fs.readdirSync(d),
    entry(p: string) {
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) { return null; }
      return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
    },
  },
};

/* git run directly (not through Vc), for the fixtures and to look at the result: a failure gives ''. */
const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' }); }
  catch (e) { return String((e as { stdout?: string }).stdout || ''); }
};
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rev = (cwd: string, r: string) => git(cwd, 'rev-parse', '--verify', '--quiet', r).trim();
const short = (cwd: string, r: string) => git(cwd, 'rev-parse', '--short', r).trim();
const commit = (cwd: string, file: string, text: string, msg: string) => { write(path.join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', msg); };

const visit = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-remote test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
const vcLog = (): string => Ed.getBuffer('*vc-process*').text;
/* Wait, up to 30 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 30000) assert.fail(`timed out waiting for ${what}\n${lastMessage()}\n${E.current.text.slice(-2000)}`);
  await Ed.whenIdle();
};
const asked = async (p: string) => { await until(() => (E.mini && E.mini.prompt) === p, `the prompt ${JSON.stringify(p)} (now ${JSON.stringify(E.mini && E.mini.prompt)})`); };
const question = async (p: string) => { await until(() => E.prompt === p + ' (y or n) ', `the question ${JSON.stringify(p)} (now ${JSON.stringify(E.prompt)})`); };
/* The operation done: a message said since MARK that is not the one saying it started, every child ended. */
const marked = () => Ed.getBuffer('*Messages*').text.length;
const done = async (mark: number) => {
  await until(() => !proc.running().length && Ed.getBuffer('*Messages*').text.slice(mark).split('\n').some((l: string) => l && !l.endsWith('… (see *vc-process*)')), 'the operation\'s message');
};
const answer = async (text: string) => { await ed.type(text + '\n'); await Ed.whenIdle(); };
/* The last call of git SUB: its argv from SUB on, and the whole of it. */
const callOf = (sub: string) => proc.calls.filter(x => x.argv[0] === 'git' && x.argv.includes(sub)).at(-1)!.argv;
const argvOf = (sub: string) => { const c = callOf(sub); return c.slice(c.indexOf(sub)); };
/* The settings the last git SUB got in its environment (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_N, GIT_CONFIG_VALUE_N), as [key, value]s. */
const configEnvOf = (sub: string): [string, string][] => {
  const env = proc.calls.filter(x => x.argv[0] === 'git' && x.argv.includes(sub)).at(-1)!.opts.env || {};
  return Array.from({ length: +(env.GIT_CONFIG_COUNT ?? 0) }, (_, n) => [env['GIT_CONFIG_KEY_' + n]!, env['GIT_CONFIG_VALUE_' + n]!]);
};
const ran = (n: number, sub: string) => proc.calls.slice(n).some(c => c.argv[0] === 'git' && c.argv.includes(sub));

/* ---------- the fixture ---------- */
/* remote.git, bare; work: main with one commit, origin the bare remote, no upstream yet. */
const remote = mkdir('remote.git');
git(remote, 'init', '-q', '--bare', '-b', 'main');
const work = mkdir('work');
git(work, 'init', '-q', '-b', 'main');
commit(work, 'a.txt', 'a\n', 'first');
git(work, 'remote', 'add', 'origin', remote);
/* another clone, pushing as someone else would */
let other = '';
const status = async (dir = work) => { visit(path.join(dir, 'a.txt')); await keys('SPC g g'); assert.equal(E.current.mode, 'git-status-mode'); };

test('p u on a branch with no upstream asks the remote, pushes and sets the upstream, the hooks on, the progress in *vc-process*', async () => {
  await status();
  const m = marked();
  await keys('p u');
  await asked('Set upstream of main and push to remote (origin): ');
  await answer('');
  await done(m);
  assert.equal(lastMessage(), 'Pushed main to origin/main, a new branch there; origin/main is now its upstream');
  assert.equal(rev(remote, 'main'), rev(work, 'main'));
  assert.equal(git(work, 'config', 'branch.main.merge').trim(), 'refs/heads/main');
  assert.deepEqual(argvOf('push'), ['push', '--no-recurse-submodules', '--progress', '--porcelain', '--set-upstream', '--end-of-options', 'origin', 'refs/heads/main:refs/heads/main']);
  const argv = callOf('push');
  assert.ok(!argv.includes('core.hooksPath=/dev/null'), 'push keeps the hooks (owner decision 12)');
  assert.ok(argv.includes('protocol.ext.allow=never'));
  /* git's progress as it came, each run of updates shown as its last line only */
  const t = vcLog();
  assert.match(t, /\nWriting objects: 100% \(3\/3\), [^\n]*done\.\n/);
  assert.ok(!t.includes('\r'), 'no carriage return in the log');
  assert.doesNotMatch(t, /Writing objects: +\d+% \(\d+\/\d+\)\n/, 'the updates before the last are replaced');
  assert.match(lines()[1], /^Merge: {4}origin\/main first$/, 'the status read again');
  other = mkdir('other');
  execFileSync('git', ['clone', '-q', remote, other], { stdio: 'ignore' });
});

test('*vc-process* shows git\'s progress while git still runs', async () => {
  /* a remote whose pre-receive hook says it waits, then waits for a file: the push is held after its objects are sent */
  const slow = mkdir('slow.git'), gate = path.join(root, 'slow-gate');
  git(slow, 'init', '-q', '--bare', '-b', 'main');
  fs.writeFileSync(path.join(slow, 'hooks', 'pre-receive'), `#!/bin/sh\necho 'the hook waits' >&2\nwhile [ ! -e '${gate}' ]; do sleep 0.05; done\n`, { mode: 0o755 });
  const w = mkdir('slow-work');
  git(w, 'init', '-q', '-b', 'main');
  commit(w, 'a.txt', 'a\n', 'first');
  git(w, 'remote', 'add', 'origin', slow);
  await status(w);
  const m = marked();
  await keys('p u');
  await asked('Set upstream of main and push to remote (origin): ');
  await answer('');
  await until(() => /\nremote: the hook waits *\n/.test(vcLog()), 'the hook\'s line in *vc-process*');
  assert.ok(proc.running().length > 0, 'git still runs');
  assert.match(vcLog(), /\nWriting objects: 100% \(3\/3\), [^\n]*done\.\n/, 'the objects\' progress logged before git ends');
  assert.equal(rev(slow, 'main'), '', 'nothing pushed yet');
  fs.writeFileSync(gate, '');
  await done(m);
  assert.equal(lastMessage(), 'Pushed main to origin/main, a new branch there; origin/main is now its upstream');
});

test('p u runs the pre-push hook: one that says no stops the push; F u pulls what another clone pushed, the hooks off', async () => {
  commit(work, 'b.txt', 'b\n', 'second');
  const old = short(work, 'origin/main'), was = rev(remote, 'main');
  const hook = path.join(work, '.git', 'hooks', 'pre-push'), ranHook = path.join(root, 'pre-push-ran');
  fs.writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${ranHook}'\nexit 1\n`, { mode: 0o755 });
  await status();
  let m = marked();
  await keys('p u');
  await done(m);
  assert.equal(lastMessage(), 'process-error: Not pushed: the pre-push hook refused it (see *vc-process*)');
  assert.equal(fs.readFileSync(ranHook, 'utf8'), 'origin\n', 'the hook ran, given the remote');
  assert.equal(rev(remote, 'main'), was, 'nothing pushed');
  fs.writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${ranHook}'\n`, { mode: 0o755 });
  m = marked();
  await keys('p u');
  await done(m);
  assert.equal(lastMessage(), `Pushed main to origin/main (${old}..${short(work, 'main')})`);
  assert.equal(fs.readFileSync(ranHook, 'utf8'), 'origin\norigin\n');
  assert.equal(rev(remote, 'main'), rev(work, 'main'));
  fs.rmSync(hook);
  git(other, 'pull', '-q');
  commit(other, 'c.txt', 'c\n', 'third');
  git(other, 'push', '-q');
  m = marked();
  await keys('F u');
  await done(m);
  assert.equal(lastMessage(), `Pulled origin/main into main: now at ${short(work, 'main')} third (fast-forward)`);
  assert.equal(rev(work, 'main'), rev(remote, 'main'));
  assert.deepEqual(argvOf('pull'), ['pull', '--no-recurse-submodules', '--progress']);
  assert.ok(callOf('pull').includes('core.hooksPath=/dev/null'), 'pull runs no hook: decision 12 names commit, push and the sequencer');
  m = marked();
  await keys('F u');
  await done(m);
  assert.equal(lastMessage(), 'main is up to date with origin/main');
});

test('f u fetches the upstream\'s remote and the status shows what came; f a fetches every remote', async () => {
  commit(other, 'd.txt', 'd\n', 'fourth');
  git(other, 'push', '-q');
  await status();
  let m = marked();
  await keys('f u');
  await done(m);
  assert.equal(lastMessage(), 'Fetched origin: 1 ref updated');
  assert.equal(rev(work, 'origin/main'), rev(remote, 'main'));
  assert.deepEqual(argvOf('fetch'), ['fetch', '--no-recurse-submodules', '--progress', '--porcelain', '--end-of-options', 'origin']);
  assert.ok(callOf('fetch').includes('core.hooksPath=/dev/null'));
  assert.ok(lines().includes('Unpulled from origin/main (1)'), `the status read again:\n${E.current.text}`);
  m = marked();
  await keys('f u');
  await done(m);
  assert.equal(lastMessage(), 'Fetched origin: nothing new');
  const mirror = mkdir('mirror.git');
  execFileSync('git', ['clone', '-q', '--bare', remote, mirror], { stdio: 'ignore' });
  git(work, 'remote', 'add', 'mirror', mirror);
  m = marked();
  await keys('f a');
  await done(m);
  assert.equal(lastMessage(), 'Fetched all remotes: 1 ref updated');
  assert.equal(rev(work, 'mirror/main'), rev(remote, 'main'));
  assert.deepEqual(argvOf('fetch'), ['fetch', '--no-recurse-submodules', '--progress', '--porcelain', '--all']);
  git(work, 'merge', '-q', '--ff-only', 'origin/main');
});

test('a push the remote is ahead of is refused; p f asks, n pushes nothing, a lease someone pushed past is refused, y overwrites what was named', async () => {
  commit(other, 'e.txt', 'e\n', 'theirs');
  git(other, 'push', '-q');
  const theirs = rev(remote, 'main'), seen = rev(work, 'origin/main');
  commit(work, 'f.txt', 'f\n', 'mine');
  await status();
  let m = marked(), n = proc.calls.length;
  await keys('p u');
  await done(m);
  assert.equal(lastMessage(), 'Not pushed: origin/main has commits main does not: pull them (F u) first, or force push (p f)');
  assert.equal(rev(remote, 'main'), theirs);
  /* n: nothing pushed */
  n = proc.calls.length;
  await keys('p f');
  await question('Force push main to origin/main?');
  m = marked();
  await ed.type('n'); await Ed.whenIdle();
  assert.equal(lastMessage(), 'Nothing pushed');
  assert.ok(!ran(n, 'push'), 'no push ran');
  /* y, the lease the commit origin/main was at when asked; the remote has moved past it since */
  await keys('p f');
  await question('Force push main to origin/main?');
  m = marked();
  await ed.type('y');
  await done(m);
  assert.equal(lastMessage(), 'Not force-pushed: origin/main is no longer where it was when asked (someone pushed): f u fetches it, to see what a force push would discard');
  assert.ok(argvOf('push').includes(`--force-with-lease=refs/heads/main:${seen}`));
  assert.equal(rev(remote, 'main'), theirs, 'the commit someone pushed is kept');
  /* fetched, the question names what the push discards */
  m = marked();
  await keys('f u');
  await done(m);
  await keys('p f');
  await question(`Force push main to origin/main, discarding 1 commit of origin/main not in main (the last ${short(work, theirs)} theirs)?`);
  m = marked();
  await ed.type('y');
  await done(m);
  assert.equal(lastMessage(), `Force-pushed main to origin/main (${short(work, theirs)}...${short(work, 'main')} (forced update))`);
  assert.deepEqual(argvOf('push'), ['push', '--no-recurse-submodules', '--progress', '--porcelain', `--force-with-lease=refs/heads/main:${theirs}`, '--end-of-options', 'origin', 'refs/heads/main:refs/heads/main']);
  assert.equal(rev(remote, 'main'), rev(work, 'main'));
  git(other, 'fetch', '-q'); git(other, 'reset', '-q', '--hard', 'origin/main');
});

test('F u on diverged branches: git\'s refusal said when nothing says how to reconcile; merged under pull.rebase=false; a conflict named', async () => {
  commit(other, 'g.txt', 'g\n', 'other side');
  git(other, 'push', '-q');
  commit(work, 'h.txt', 'h\n', 'this side');
  await status();
  let m = marked();
  await keys('F u');
  await done(m);
  assert.equal(lastMessage(), 'Not pulled: main and origin/main have diverged, and your git configuration does not say how to reconcile them (pull.rebase, pull.ff)');
  git(work, 'config', 'pull.rebase', 'false');
  m = marked();
  await keys('F u');
  await done(m);
  assert.equal(lastMessage(), `Pulled origin/main into main: now at ${short(work, 'main')} Merge branch 'main' of ${remote.replace(/\.git$/, '')}`);
  assert.equal(git(work, 'log', '-1', '--format=%P').trim().split(' ').length, 2, 'a merge, made with no editor');
  git(work, 'push', '-q');
  git(other, 'pull', '-q');
  commit(other, 'a.txt', 'theirs\n', 'their a');
  git(other, 'push', '-q');
  commit(work, 'a.txt', 'ours\n', 'our a');
  m = marked();
  await keys('F u');
  await done(m);
  assert.equal(lastMessage(), 'Pulled origin/main with conflicts in a.txt: resolve them and stage them (s), then m m commits the merge, m a aborts it');
  assert.ok(lines().includes('Unmerged paths (1)'), `the status read again:\n${E.current.text}`);
  const n = proc.calls.length;
  await keys('F u');
  assert.equal(lastMessage(), 'Not pulled: a.txt is in conflict; resolve and stage it (s) first');
  assert.ok(!ran(n, 'pull'));
  git(work, 'merge', '--abort');
  git(work, 'reset', '-q', '--hard', 'origin/main');
  git(work, 'config', '--unset', 'pull.rebase');
});

/* ---------- the repository's own transport programs ---------- */
const marks = mkdir('marks'), bin = mkdir('bin');
/* A script that notes it ran (with its arguments) in marks/NAME, and fails. */
const marker = (name: string) => {
  const f = path.join(bin, name);
  fs.writeFileSync(f, `#!/bin/sh\necho "$@" >> '${path.join(marks, name)}'\nexit 1\n`, { mode: 0o755 });
  return f;
};
const marked_ = (name: string) => fs.existsSync(path.join(marks, name));
const clearMarks = () => { for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f)); };
/* git run directly, as a terminal would, for the controls: GIT_TERMINAL_PROMPT=0 so that nothing waits; not
   blocking this process, which serves the HTTP remote. Its failure (the markers fail) is ignored. */
const gitPlain = (cwd: string, ...args: string[]) => new Promise<void>(r => { execFile('git', args, { cwd, timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, () => r()); });

test('a repository\'s own uploadpack, receivepack, core.gitProxy, core.alternateRefsCommand, a vcs helper path, a remote named as a switch and a remote group holding one are refused, its ext:: transport not run, through f, F and p', async () => {
  const hostile = mkdir('hostile');
  execFileSync('git', ['clone', '-q', remote, hostile], { stdio: 'ignore' });
  git(hostile, 'config', 'protocol.allow', 'always');
  git(hostile, 'config', 'protocol.ext.allow', 'always');
  git(hostile, 'remote', 'add', 'ext', 'ext::' + marker('ext'));
  await gitPlain(hostile, 'fetch', 'ext');
  assert.ok(marked_('ext'), 'the control ran the ext:: command');
  clearMarks();
  await status(hostile);
  /* f a reaches ext too: refused by git (protocol.ext.allow=never), its command not run */
  let m = marked();
  await keys('f a');
  await done(m);
  assert.match(lastMessage(), /^process-error: Not fetched from all remotes: .* \(see \*vc-process\*\)$/);
  assert.match(vcLog(), /transport 'ext' not allowed/);
  assert.ok(callOf('fetch').includes('protocol.ext.allow=never'));
  assert.deepEqual(fs.readdirSync(marks), [], 'the ext:: command did not run');
  /* uploadpack, receivepack and core.gitProxy: git takes the first configured, so no later setting undoes them
     (and fetch --all passes no --upload-pack on); core.alternateRefsCommand, run when the repository has
     alternates, has no value meaning none: refused before anything reaches the remote */
  const refusals: [string, string, string][] = [['remote.origin.uploadpack', 'uploadpack', 'a program as origin\'s uploadpack'],
    ['remote.origin.receivepack', 'receivepack', 'a program as origin\'s receivepack'], ['core.gitProxy', 'proxy', 'a core.gitProxy program'],
    ['core.alternateRefsCommand', 'altrefs', 'a core.alternateRefsCommand program'],
    ['remote.origin.vcs', 'vcs', 'a remote helper that is no plain name as origin\'s vcs']];
  const alternates = path.join(hostile, '.git', 'objects', 'info', 'alternates');
  /* f u, f a, F u and p u each refused with WHAT, no fetch, pull or push run */
  const refusedAll = async (what: string, label: string) => {
    for (const k of ['f u', 'f a', 'F u', 'p u']) {
      const n = proc.calls.length, mk = marked();
      await keys(k);
      await done(mk);
      assert.equal(lastMessage(), `${hostile}'s own configuration names ${what}: not run here (see *vc-process*)`, `${label}, ${k}`);
      assert.ok(!['fetch', 'pull', 'push'].some(s => ran(n, s)), `${k} reached no remote`);
    }
  };
  for (const [key, name, what] of refusals) {
    git(hostile, 'config', key, name === 'vcs' ? '../../bin/vcs' : marker(name));
    if (name === 'altrefs') {
      write(alternates, path.join(remote, 'objects') + '\n');
      /* the control: git with the switches Vc gives a fetch runs it */
      await gitPlain(hostile, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', 'fetch', '--no-recurse-submodules', '--porcelain', 'origin');
      assert.ok(marked_(name), 'the control ran the alternate refs command');
    }
    await gitPlain(hostile, 'fetch', 'origin');
    await gitPlain(hostile, 'push', 'origin', 'main');
    if (name === 'uploadpack' || name === 'receivepack') assert.ok(marked_(name), `the control ran ${name}`);   // the proxy is for git:// alone
    clearMarks();
    await refusedAll(what, key);
    git(hostile, 'config', '--unset', key);
    fs.rmSync(alternates, { force: true });
  }
  /* A remote whose name starts with `-`: fetch --all starts a fetch per remote with no --end-of-options before
     its name, which git takes as a switch. A remote group holding such a name: a fetch or a push of the group,
     or of the remote a group of the same name shadows, does the same. (`git remote add` and `git config` refuse
     to write either, a repository's own .git/config holds them anyway.) */
  const cfg = path.join(hostile, '.git', 'config'), saved = fs.readFileSync(cfg, 'utf8');
  fs.appendFileSync(cfg, `[remote "--upload-pack=${marker('dash')};:"]\n\turl = ${remote}\n`);
  await gitPlain(hostile, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', 'fetch', '--no-recurse-submodules', '--progress', '--porcelain', '--all');
  assert.ok(marked_('dash'), 'the control (f a\'s switches) ran the remote\'s name as a switch');
  clearMarks();
  await refusedAll('a remote whose name starts with `-`, which git would take as a switch', 'a remote named --upload-pack=');
  fs.writeFileSync(cfg, saved);
  fs.appendFileSync(cfg, `[remotes]\n\torigin = "--upload-pack=${marker('group-fetch')};: --receive-pack=${marker('group-push')};:"\n`);
  await gitPlain(hostile, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', 'fetch', '--no-recurse-submodules', '--progress', '--porcelain', '--end-of-options', 'origin');
  await gitPlain(hostile, '-c', 'protocol.ext.allow=never', 'push', '--no-recurse-submodules', '--progress', '--porcelain', '--end-of-options', 'origin', 'refs/heads/main:refs/heads/main');
  assert.ok(marked_('group-fetch') && marked_('group-push'), `the controls (f u's and p u's switches) ran the group's names as switches: ${fs.readdirSync(marks)}`);
  clearMarks();
  await refusedAll('a name starting with `-` in the remote group origin, which git would take as a switch', 'remotes.origin');
  fs.writeFileSync(cfg, saved);
  assert.deepEqual(fs.readdirSync(marks), [], 'none of the repository\'s programs ran');
  m = marked();
  await keys('f u');
  await done(m);
  assert.equal(lastMessage(), 'Fetched origin: nothing new');
});
test('core.sshCommand is the user\'s, never the repository\'s', async () => {
  const sshRepo = mkdir('ssh-repo');
  git(sshRepo, 'init', '-q', '-b', 'main');
  commit(sshRepo, 'a.txt', 'a\n', 'first');
  git(sshRepo, 'remote', 'add', 'origin', 'ssh://git@127.0.0.1/x.git');
  git(sshRepo, 'config', 'core.sshCommand', marker('repo-ssh'));
  await gitPlain(sshRepo, 'fetch', 'origin');
  assert.ok(marked_('repo-ssh'), 'the control ran the repository\'s');
  clearMarks();
  git(HOME, 'config', '--global', 'core.sshCommand', marker('user-ssh'));
  try {
    await status(sshRepo);
    const m = marked();
    await keys('f u');
    await asked('Fetch from remote (origin): ');
    await answer('');
    await done(m);
    assert.match(lastMessage(), /^process-error: Not fetched from origin: Could not read from remote repository\. \(see \*vc-process\*\)$/);
    assert.deepEqual(configEnvOf('fetch'), [['core.sshCommand', path.join(bin, 'user-ssh')]]);
    assert.ok(!callOf('fetch').some(a => a.includes('user-ssh')), 'not on the command line');
    assert.ok(marked_('user-ssh'), 'the user\'s ran');
    assert.ok(!marked_('repo-ssh'), 'the repository\'s did not');
  } finally { git(HOME, 'config', '--global', '--unset', 'core.sshCommand'); clearMarks(); }
});

test('credentials: the user\'s helpers are asked, never the repository\'s helper or askpass, and named in the environment, not the command line; nothing waits for a prompt', async () => {
  let asks = 0;
  const server = http.createServer((req, res) => { asks++; res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }); res.end(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const httpRepo = mkdir('http-repo');
    git(httpRepo, 'init', '-q', '-b', 'main');
    commit(httpRepo, 'a.txt', 'a\n', 'first');
    git(httpRepo, 'remote', 'add', 'origin', `http://127.0.0.1:${port}/x.git`);
    git(httpRepo, 'config', 'credential.helper', '!' + marker('repo-cred'));
    git(httpRepo, 'config', `credential.http://127.0.0.1:${port}.helper`, '!' + marker('repo-url-cred'));
    git(httpRepo, 'config', 'core.askPass', marker('repo-askpass'));
    await gitPlain(httpRepo, 'fetch', 'origin');
    assert.ok(marked_('repo-cred') && marked_('repo-url-cred') && marked_('repo-askpass'), `the control ran them: ${fs.readdirSync(marks)}`);
    clearMarks();
    git(HOME, 'config', '--global', 'credential.helper', '!' + marker('user-cred'));
    /* a key `-c` could not name: its URL holds `=` */
    const urlKey = 'credential.https://example.invalid/a=b.helper';
    git(HOME, 'config', '--global', urlKey, '!' + marker('user-url-cred'));
    try {
      await status(httpRepo);
      const m = marked(), t = Date.now();
      await keys('f u');
      await asked('Fetch from remote (origin): ');
      await answer('');
      await done(m);
      assert.ok(Date.now() - t < 20000, 'it ended at once, with no prompt waiting');
      assert.equal(lastMessage(), `process-error: Not fetched from origin: could not read Username for 'http://127.0.0.1:${port}': terminal prompts disabled; git asks no credentials here: they come from your credential helper or ssh agent (see *vc-process*)`);
      assert.ok(asks > 0, 'the server was asked');
      assert.ok(marked_('user-cred'), 'the user\'s helper was asked');
      assert.deepEqual(fs.readdirSync(marks), ['user-cred'], 'none of the repository\'s ran');
      assert.deepEqual(configEnvOf('fetch'), [['credential.helper', ''], ['credential.helper', '!' + path.join(bin, 'user-cred')],
        [urlKey, '!' + path.join(bin, 'user-url-cred')], ['core.askPass', '']]);
      assert.ok(!callOf('fetch').some(a => a.includes('user-cred')), 'no helper on the command line');
      assert.ok(!vcLog().includes('user-cred'), 'no helper in *vc-process*');
      /* a repository that names no helper of its own: nothing set, the `=` in the user's key no matter */
      await status();
      const w = marked();
      await keys('f u');
      await done(w);
      assert.match(lastMessage(), /^Fetched origin: /);
      assert.deepEqual(configEnvOf('fetch'), []);
    } finally { git(HOME, 'config', '--global', '--unset', 'credential.helper'); git(HOME, 'config', '--global', '--unset', urlKey); clearMarks(); }
  } finally { server.close(); }
});

test('refused: a detached HEAD, p f with no upstream, a local upstream, a second operation while one readies or runs, a jj workspace, the image\'s replay', async () => {
  await status();
  git(work, 'switch', '-q', '--detach');
  await keys('p u');
  assert.equal(lastMessage(), 'HEAD is detached: check out a branch (b b) to push it');
  await keys('F u');
  assert.equal(lastMessage(), 'HEAD is detached: check out a branch (b b) to pull into it');
  git(work, 'switch', '-q', '-c', 'topic');
  await keys('p f');
  assert.equal(lastMessage(), 'topic has no upstream: p u pushes it and sets one');
  git(work, 'branch', '-q', '--set-upstream-to=main', 'topic');
  await keys('p u');
  assert.equal(lastMessage(), 'topic\'s upstream is the local branch main: nothing to push to a remote');
  /* a question quit with C-g frees the repository: f u asks again, not refused */
  const q = proc.calls.length;
  for (let i = 0; i < 2; i++) {
    await keys('f u');
    await asked('Fetch from remote (origin): ');
    await keys('C-g');
    assert.equal(E.mini, null);
  }
  assert.ok(!ran(q, 'fetch'), 'no fetch ran');
  git(work, 'switch', '-q', 'main');
  /* one at a time in a repository: from the start, while the first still reads its upstream, and while it runs */
  const m = marked(), first = L('git-fetch');
  assert.match(String(await errorOf(Promise.resolve().then(() => L('git-fetch')))), /^A remote command still runs in .*: see \*vc-process\*$/);
  await first;
  assert.match(String(await errorOf(Promise.resolve().then(() => L('git-fetch')))), /^Fetching origin still runs in .*: see \*vc-process\*$/);
  await done(m);
  assert.match(lastMessage(), /^Fetched origin: /);
  const jj = mkdir('jj');
  execFileSync('jj', ['git', 'init'], { cwd: jj, stdio: 'ignore' });
  visit(path.join(jj, 'f.txt'));
  const n = proc.calls.length;
  await keys('M-x'); await ed.type('git-fetch\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /is a jj workspace: jj fetches and pushes with its own commands/);
  assert.equal(proc.calls.length, n, 'nothing ran');
  await status();
  const k = proc.calls.length, ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { for (const c of ['git-fetch', 'git-fetch-all', 'git-pull', 'git-push', 'git-push-force']) { try { ps.push(Promise.resolve(L(c))); } catch (e) { ps.push(Promise.reject(e)); } } });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, k, 'no child started');
});
