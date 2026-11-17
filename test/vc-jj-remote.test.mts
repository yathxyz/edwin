// jj's remotes and bookmarks from its log and change view (src/vc-jj.ts: f fetch, p push, b bookmarks) in the
// headless runtime, with real jj and git from PATH (the check brings nixpkgs' jujutsu) through Ed.proc over
// fake-proc.mts's host.proc, against local bare remotes in throwaway workspaces under a throwaway HOME. Nothing
// reaches the network. Each operation's argv is checked after the runner's switches, and what it leaves is read
// back with jj's own template and plain git in the remote. One Edwin per process, so the cases run in order.
// Run: node --test test/vc-jj-remote.test.mts
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startEdwin, type Edwin, type NodeHost } from './headless.mts';
import { fakeProc, type FakeProc } from './fake-proc.mts';

const ed = await startEdwin();
const { Ed, E } = ed;
ed.eval('(set! corfu-auto #f)');
const lastMessage = (): string => { const t: string = Ed.getBuffer('*Messages*').text.replace(/\n+$/, ''); return t.slice(t.lastIndexOf('\n') + 1); };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-jj-remote-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config', 'jj'), { recursive: true });
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  JJ_USER: 'Test', JJ_EMAIL: 'test@example.invalid', JJ_TIMESTAMP: '2026-01-01T00:00:00+00:00',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'JJ_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_SSH', 'GIT_SSH_COMMAND', 'JJ_EDITOR', 'EDITOR', 'VISUAL']) delete process.env[k];
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const proc = fakeProc();
const host = ed.host as NodeHost & { proc?: FakeProc; files?: Edwin };
host.proc = proc;
/* As the native host (native/js/host-native.ts) names files: `..` dropped as text before the file system sees the
   name (path.resolve does so), and the true name the real path of that. */
const named = (n: string) => path.resolve(root, n);
host.files = {
  read(n: string) { try { return fs.readFileSync(named(n), 'utf8'); } catch (e) { return null; } },
  exists: (n: string) => fs.existsSync(named(n)), resolve: named, label: (n: string) => n,
  truename: (n: string) => { try { return fs.realpathSync(named(n)); } catch (e) { return named(n); } },
  write(n: string, text: string) { fs.writeFileSync(n, text); return true; }, remove() { throw new Error('not here'); }, list: () => [] as string[], cwd: root,
  tree: {
    names: (d: string) => fs.readdirSync(d),
    entry(p: string) {
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) { return null; }
      const dir = st.isSymbolicLink() ? (() => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } })() : undefined;
      return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777, dir };
    },
  },
};

const run = (cwd: string, prog: string, args: string[]) =>
  execFileSync(prog, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });
const jj = (cwd: string, ...args: string[]) => run(cwd, 'jj', ['--no-pager', '--color=never', ...args]);
const git = (cwd: string, ...args: string[]) => run(cwd, 'git', args);
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const of = (cwd: string, rev: string, template: string) => jj(cwd, 'log', '--no-graph', '--ignore-working-copy', '-r', rev, '-T', template + ' ++ "\\n"').replace(/\n$/, '');
const changeOf = (cwd: string, rev: string) => of(cwd, rev, 'change_id');
const commitOf = (cwd: string, rev: string) => of(cwd, rev, 'commit_id');
const shortOf = (cwd: string, rev: string) => of(cwd, rev, 'change_id.shortest(8)');
/* A remote's branch, by plain git in the bare repository: its commit, or '' when it has none. */
const remoteHas = (bare: string, branch: string) => { try { return git(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch).trim(); } catch (e) { return ''; } };
/* jj's bookmarks, as `NAME` (local) or `NAME@REMOTE`, with the commit each points to, read by jj itself. */
const bookmarks = (cwd: string) => jj(cwd, 'bookmark', 'list', '--all-remotes', '--ignore-working-copy', '-T',
  'if(remote, name ++ "@" ++ remote, name) ++ " " ++ if(tracked, "tracked ", "") ++ if(normal_target, normal_target.commit_id(), "-") ++ "\\n"')
  .split('\n').filter(l => l && !/@git /.test(l)).sort();

const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
/* Wait, up to 30 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 30000) assert.fail(`timed out waiting for ${what}\n${lastMessage()}`);
  await Ed.whenIdle();
};
const asked = async (p: string) => { await until(() => (E.mini && E.mini.prompt) === p, `the prompt ${JSON.stringify(p)} (now ${JSON.stringify(E.mini && E.mini.prompt)})`); };
const question = async (p: string) => { await until(() => E.prompt === p + ' (y or n) ', `the question ${JSON.stringify(p)} (now ${JSON.stringify(E.prompt)})`); };
const answer = async (text: string) => { await ed.type(text + '\n'); await Ed.whenIdle(); };
/* The operation done: a message said since MARK that is not the one saying it started, every child ended. */
const marked = () => Ed.getBuffer('*Messages*').text.length;
const done = async (mark: number) => {
  await until(() => !proc.running().length && Ed.getBuffer('*Messages*').text.slice(mark).split('\n').some((l: string) => l && !l.endsWith('… (see *vc-process*)')), 'the operation\'s message');
};
/* An argv's part after the runner's fixed switches; the jj calls since N whose subcommand starts with FIRST. */
const sub = (argv: string[]) => argv.slice(argv.indexOf('ui.log-word-wrap=false') + 1);
const jjCalls = (n: number, ...first: string[]) => proc.calls.slice(n).filter(c => c.argv[0] === 'jj' && first.every((w, k) => sub(c.argv)[k] === w));
const ops = (n: number, ...first: string[]) => jjCalls(n, ...first).map(c => sub(c.argv));
/* The settings the last jj call since N starting with FIRST got in its environment (GIT_CONFIG_COUNT, …), as [key, value]s. */
const configEnvOf = (n: number, ...first: string[]): [string, string][] => {
  const env = jjCalls(n, ...first).at(-1)!.opts.env || {};
  return Array.from({ length: +(env.GIT_CONFIG_COUNT ?? 0) }, (_, k) => [env['GIT_CONFIG_KEY_' + k]!, env['GIT_CONFIG_VALUE_' + k]!]);
};
const from = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-jj-remote test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const openLog = async (dir: string) => { from(path.join(dir, 'a.txt')); await keys('SPC g J'); assert.equal(E.current.mode, 'jj-log-mode'); await L('git-status-refresh'); await Ed.whenIdle(); };
/* Point to the log line of change ID (its first 8 letters). */
const onChange = (id: string) => {
  const i = lines().findIndex(l => l.split(' ')[1] === id.slice(0, 8));
  assert.ok(i >= 0, `a line of ${id} in\n${E.current.text}`);
  E.current.pt = Ed.lineStartB(E.current, i + 1);
};
const marker = (name: string) => path.join(root, 'marks', name);
fs.mkdirSync(path.join(root, 'marks'));
/* A script that records it ran in marks/NAME, then does what REST says (`exec git-receive-pack "$@"`, `exit 1`). */
const script = (name: string, rest: string) => {
  const p = path.join(root, 'bin-' + name);
  fs.writeFileSync(p, `#!/bin/sh\necho "$*" >> '${marker(name)}'\n${rest}\n`, { mode: 0o755 });
  return p;
};
const ranMark = (name: string) => fs.existsSync(marker(name));

/* ---------- the fixture ---------- */
/* remote.git, bare, main with one commit; other: a git clone pushing as someone else would; ws: a colocated jj
   clone, main tracked, @ described `local work` with w.txt on main. */
const remote = mkdir('remote.git');
git(remote, 'init', '-q', '--bare', '-b', 'main');
const other = mkdir('other');
git(other, 'init', '-q', '-b', 'main');
write(path.join(other, 'a.txt'), 'a\n');
git(other, 'add', 'a.txt'); git(other, 'commit', '-q', '-m', 'first');
git(other, 'remote', 'add', 'origin', remote);
git(other, 'push', '-q', 'origin', 'main');
const otherCommit = (file: string, msg: string, branch = 'main') => {
  write(path.join(other, file), msg + '\n');
  git(other, 'add', file); git(other, 'commit', '-q', '-m', msg); git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/' + branch);
  return git(other, 'rev-parse', 'HEAD').trim();
};
jj(root, 'git', 'clone', remote, 'ws');
const ws = path.join(root, 'ws');
write(path.join(ws, 'w.txt'), 'w\n');
jj(ws, 'describe', '-m', 'local work');
const W = changeOf(ws, '@');

test('f f fetches from jj\'s remote and says what moved, in the background; f a from every remote; the git jj starts gets the hardening in its environment', async () => {
  const pushed = otherCommit('b.txt', 'second');
  await openLog(ws);
  let n = proc.calls.length, m = marked();
  await keys('f f');
  await done(m);
  assert.deepEqual(ops(n, 'git'), [['git', 'fetch']]);
  assert.equal(lastMessage(), 'Fetched: bookmark: main@origin [updated] tracked');
  assert.equal(commitOf(ws, 'main@origin'), pushed);
  assert.equal(commitOf(ws, 'main'), pushed, 'the tracked bookmark follows');
  const env = configEnvOf(n, 'git', 'fetch');
  assert.deepEqual(env, [['protocol.ext.allow', 'never'], ['fetch.recurseSubmodules', 'false'], ['push.recurseSubmodules', 'no'], ['core.hooksPath', '/dev/null']]);
  assert.ok(lines().some(l => l.includes(' main ') && l.includes(' second ')), `the log read again:\n${E.current.text}`);
  /* the git configuration was read from the colocated git repository */
  assert.ok(proc.calls.slice(n).some(c => c.argv[0] === 'git' && c.argv.includes('--git-dir=' + ws + '/.jj/repo/store/../../../.git') && c.argv.includes('config')));
  n = proc.calls.length; m = marked();
  await keys('f f');
  await done(m);
  assert.equal(lastMessage(), 'Fetched: nothing new');
  n = proc.calls.length; m = marked();
  await keys('f a');
  await done(m);
  assert.deepEqual(ops(n, 'git'), [['git', 'fetch', '--all-remotes']]);
  assert.equal(lastMessage(), 'Fetched from every remote: nothing new');
});

test('b c creates a bookmark on the change at point, its name quoted (one starting with - too); p p pushes it, a new bookmark there, tracked', async () => {
  await openLog(ws);
  onChange(W);
  let n = proc.calls.length;
  await keys('b c');
  await asked(`Create bookmark at ${shortOf(ws, `change_id(${W})`)} local work: `);
  await answer('feat');
  assert.deepEqual(ops(n, 'bookmark', 'create'), [['bookmark', 'create', '-r', `change_id(${W})`, '--', '"feat"']]);
  assert.match(lastMessage(), /^Created 1 bookmarks pointing to /);
  assert.ok(bookmarks(ws).includes(`feat ${commitOf(ws, `change_id(${W})`)}`));
  /* a name jj would take as a switch, or a revset, is given as a string literal */
  n = proc.calls.length;
  await keys('b c');
  await answer('-lead');
  assert.deepEqual(ops(n, 'bookmark', 'create').at(-1), ['bookmark', 'create', '-r', `change_id(${W})`, '--', '"-lead"']);
  assert.ok(bookmarks(ws).includes(`"-lead" ${commitOf(ws, `change_id(${W})`)}`), bookmarks(ws).join("\n"));
  n = proc.calls.length;
  await keys('b c');
  await answer('main');
  assert.match(lastMessage(), /jj bookmark create failed \(exit 1\): Bookmark already exists: main/);
  /* forget -lead again (b f, asked) */
  n = proc.calls.length;
  await keys('b f');
  await asked('Forget bookmark (-lead): ');
  await answer('');
  await question('Forget bookmark -lead (jj stops knowing it here; its remotes keep it)?');
  await keys('y');
  assert.deepEqual(ops(n, 'bookmark', 'forget'), [['bookmark', 'forget', '--', 'exact:"-lead"']]);
  assert.ok(!bookmarks(ws).some(b => b.startsWith('"-lead"')));

  onChange(W);
  n = proc.calls.length;
  const m = marked(), at = commitOf(ws, `change_id(${W})`);
  await keys('p p');
  await done(m);
  assert.deepEqual(ops(n, 'git', 'push'), [['git', 'push', '--bookmark=exact:"feat"', '--dry-run'], ['git', 'push', '--bookmark=exact:"feat"']]);
  assert.equal(lastMessage(), `Pushed to origin: bookmark: feat [add to ${at.slice(0, 12)}]`);
  assert.equal(remoteHas(remote, 'feat'), at);
  assert.ok(bookmarks(ws).includes(`feat@origin tracked ${at}`), bookmarks(ws).join('\n'));
  /* push keeps the hooks (decision 12): no core.hooksPath for it */
  assert.deepEqual(configEnvOf(n, 'git', 'push'), [['protocol.ext.allow', 'never'], ['fetch.recurseSubmodules', 'false'], ['push.recurseSubmodules', 'no']]);
  /* pushing it again: nothing to push, said as jj says it */
  const k = marked();
  n = proc.calls.length;
  onChange(W);
  await keys('p p');
  await until(() => marked() > k && !proc.running().length, 'the message');
  assert.equal(lastMessage(), 'Nothing pushed: nothing changed');
  assert.equal(ops(n, 'git', 'push').length, 1, 'the dry run alone');
});

test('b s moves a bookmark sideways only after asking; p p then asks before moving it sideways on the remote, and n pushes nothing', async () => {
  /* S: a sibling of W, on main */
  jj(ws, 'new', '-m', 'sibling', 'main');
  const S = changeOf(ws, '@');
  await openLog(ws);
  onChange(S);
  let n = proc.calls.length;
  await keys('b s');
  await asked(`Set bookmark to ${shortOf(ws, `change_id(${S})`)} sibling: `);
  await answer('feat');
  await question(`Move bookmark feat backwards or sideways to ${shortOf(ws, `change_id(${S})`)} sibling?`);
  await keys('n');
  assert.equal(lastMessage(), 'Nothing moved');
  assert.deepEqual(ops(n, 'bookmark', 'set'), [['bookmark', 'set', '-r', `change_id(${S})`, '--', '"feat"']]);
  assert.equal(commitOf(ws, 'feat'), commitOf(ws, `change_id(${W})`));
  onChange(S);
  n = proc.calls.length;
  await keys('b s');
  await answer('feat');
  await question(`Move bookmark feat backwards or sideways to ${shortOf(ws, `change_id(${S})`)} sibling?`);
  await keys('y');
  assert.deepEqual(ops(n, 'bookmark', 'set').at(-1), ['bookmark', 'set', '-r', `change_id(${S})`, '--allow-backwards', '--', '"feat"']);
  const s = commitOf(ws, `change_id(${S})`), w = commitOf(ws, `change_id(${W})`);
  assert.equal(commitOf(ws, 'feat'), s);

  onChange(S);
  n = proc.calls.length;
  await keys('p p');
  await question(`Push to origin, bookmark: feat [move sideways from ${w.slice(0, 12)} to ${s.slice(0, 12)}]?`);
  await keys('n');
  assert.equal(lastMessage(), 'Nothing pushed');
  assert.equal(ops(n, 'git', 'push').length, 1, 'the dry run alone');
  assert.equal(remoteHas(remote, 'feat'), w);
  onChange(S);
  const m = marked();
  await keys('p p');
  await question(`Push to origin, bookmark: feat [move sideways from ${w.slice(0, 12)} to ${s.slice(0, 12)}]?`);
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Pushed to origin: bookmark: feat [move sideways from ${w.slice(0, 12)} to ${s.slice(0, 12)}]`);
  assert.equal(remoteHas(remote, 'feat'), s);

  /* backwards: feat set to main's change, S's parent, then pushed there; both asked */
  const M = changeOf(ws, 'main'), mc = commitOf(ws, 'main');
  await L('git-status-refresh'); await Ed.whenIdle();
  onChange(M);
  await keys('b s');
  await answer('feat');
  await question(`Move bookmark feat backwards or sideways to ${shortOf(ws, `change_id(${M})`)} second?`);
  await keys('y');
  assert.equal(commitOf(ws, 'feat'), mc);
  onChange(M);
  n = proc.calls.length;
  const b = marked();
  await keys('p p');
  await question(`Push to origin, bookmark: feat [move backward from ${s.slice(0, 12)} to ${mc.slice(0, 12)}]?`);
  await keys('y');
  await done(b);
  assert.deepEqual(ops(n, 'git', 'push').at(-1), ['git', 'push', '--bookmark=exact:"feat"', '--bookmark=exact:"main"']);
  assert.equal(lastMessage(), `Pushed to origin: bookmark: feat [move backward from ${s.slice(0, 12)} to ${mc.slice(0, 12)}]`);
  assert.equal(remoteHas(remote, 'feat'), mc);
});

test('p p on a change with no bookmark is refused; p c pushes it under the bookmark jj names for it', async () => {
  await openLog(ws);
  onChange(W);
  let n = proc.calls.length;
  await keys('p p');
  assert.equal(lastMessage(), `No bookmark on ${shortOf(ws, `change_id(${W})`)} local work: b c makes one, p c pushes it under a new one`);
  assert.equal(ops(n, 'git').length, 0);
  n = proc.calls.length;
  const m = marked(), w = commitOf(ws, `change_id(${W})`), name = 'push-' + W.slice(0, 12);
  await keys('p c');
  await done(m);
  assert.deepEqual(ops(n, 'git', 'push'), [['git', 'push', '--change', `change_id(${W})`, '--dry-run'], ['git', 'push', '--change', `change_id(${W})`]]);
  assert.equal(lastMessage(), `Pushed to origin: bookmark: ${name} [add to ${w.slice(0, 12)}]`);
  assert.equal(remoteHas(remote, name), w);
});

test('b r renames, b d deletes after asking and p d pushes the deletion after naming it; b t and b u track and untrack a remote bookmark', async () => {
  await openLog(ws);
  const name = 'push-' + W.slice(0, 12), w = commitOf(ws, `change_id(${W})`);
  onChange(W);
  let n = proc.calls.length;
  await keys('b r');
  await asked(`Rename bookmark (${name}): `);
  await answer('');
  await asked(`Rename ${name} to: `);
  await answer('q"x');
  assert.deepEqual(ops(n, 'bookmark', 'rename'), [['bookmark', 'rename', '--', `"${name}"`, '"q\\"x"']]);
  assert.ok(bookmarks(ws).includes(`"q\\"x" ${w}`), bookmarks(ws).join('\n'));
  /* back, and delete it */
  jj(ws, 'bookmark', 'rename', '--', '"q\\"x"', name);
  await L('git-status-refresh'); await Ed.whenIdle();
  onChange(W);
  n = proc.calls.length;
  await keys('b d');
  await asked(`Delete bookmark (${name}): `);
  await answer('');
  await question(`Delete bookmark ${name} (p d then deletes it on its remotes)?`);
  await keys('n');
  assert.equal(lastMessage(), 'Nothing deleted');
  assert.equal(ops(n, 'bookmark', 'delete').length, 0);
  onChange(W);
  await keys('b d');
  await answer('');
  await question(`Delete bookmark ${name} (p d then deletes it on its remotes)?`);
  await keys('y');
  assert.deepEqual(ops(n, 'bookmark', 'delete'), [['bookmark', 'delete', '--', `exact:"${name}"`]]);
  assert.equal(remoteHas(remote, name), w, 'the remote keeps it until the push');
  n = proc.calls.length;
  let m = marked();
  await keys('p d');
  await question(`Push to origin, bookmark: ${name} [delete from ${w.slice(0, 12)}]?`);
  await keys('y');
  await done(m);
  assert.deepEqual(ops(n, 'git', 'push'), [['git', 'push', '--deleted', '--dry-run'], ['git', 'push', '--deleted']]);
  assert.equal(lastMessage(), `Pushed to origin: bookmark: ${name} [delete from ${w.slice(0, 12)}]`);
  assert.equal(remoteHas(remote, name), '');

  /* a branch someone else pushed comes untracked; b t tracks it, b u untracks it */
  const o = otherCommit('o.txt', 'theirs', 'topic');
  m = marked();
  await keys('f f');
  await done(m);
  assert.equal(lastMessage(), 'Fetched: bookmark: topic@origin [new] untracked');
  n = proc.calls.length;
  await keys('b t');
  await asked('Track remote bookmark: ');
  await answer('topic@origin');
  assert.deepEqual(ops(n, 'bookmark', 'track'), [['bookmark', 'track', '--', '"topic"@"origin"']]);
  assert.ok(bookmarks(ws).includes(`topic ${o}`) && bookmarks(ws).includes(`topic@origin tracked ${o}`), bookmarks(ws).join('\n'));
  n = proc.calls.length;
  await keys('b u');
  await asked('Untrack remote bookmark: ');
  /* the tracked ones: feat@origin, main@origin, topic@origin */
  await answer('topic@origin');
  assert.deepEqual(ops(n, 'bookmark', 'untrack'), [['bookmark', 'untrack', '--', '"topic"@"origin"']]);
  assert.ok(bookmarks(ws).includes(`topic@origin ${o}`), bookmarks(ws).join('\n'));
  await keys('b u');
  await answer('nope@origin');
  /* a name not among them is not taken: the prompt stays, C-g quits it with nothing run */
  assert.equal(E.mini && E.mini.prompt, 'Untrack remote bookmark: ');
  n = proc.calls.length;
  await keys('C-g');
  assert.equal(proc.calls.length, n);
});

test('a repository naming its own transport programs: receivepack and uploadpack refused, its sshCommand set back to the user\'s, fetch\'s reference-transaction hook off; plain jj runs each (the controls)', async () => {
  const cfg = path.join(ws, '.git', 'config');
  const saved = fs.readFileSync(cfg, 'utf8');
  try {
    /* receivepack: plain jj's push runs it */
    jj(ws, 'bookmark', 'set', '-r', 'feat', 'ctl');
    git(ws, 'config', 'remote.origin.receivepack', script('receivepack', 'exec git-receive-pack "$@"'));
    jj(ws, 'git', 'push', '--bookmark', 'ctl');
    assert.ok(ranMark('receivepack'), 'the control: plain jj runs the repository\'s receivepack');
    fs.rmSync(marker('receivepack'));
    jj(ws, 'bookmark', 'set', '-r', 'main', '--allow-backwards', 'ctl');
    await openLog(ws);
    let n = proc.calls.length;
    assert.match(String(await errorOf(L('jj-git-push-deleted'))), /'s own configuration names a program as origin's receivepack: not run here/);
    await Ed.whenIdle();
    assert.equal(ops(n, 'git').length, 0, 'no jj git push run');
    let m = marked();
    await keys('f f');
    await done(m);
    assert.match(lastMessage(), /'s own configuration names a program as origin's receivepack: not run here/);
    assert.equal(ops(n, 'git').length, 0, 'no jj git fetch run');
    assert.ok(!ranMark('receivepack'));
    git(ws, 'config', '--unset', 'remote.origin.receivepack');

    /* uploadpack */
    git(ws, 'config', 'remote.origin.uploadpack', script('uploadpack', 'exec git-upload-pack "$@"'));
    jj(ws, 'git', 'fetch');
    assert.ok(ranMark('uploadpack'), 'the control: plain jj runs the repository\'s uploadpack');
    fs.rmSync(marker('uploadpack'));
    n = proc.calls.length; m = marked();
    await keys('f a');
    await done(m);
    assert.match(lastMessage(), /'s own configuration names a program as origin's uploadpack: not run here/);
    assert.equal(ops(n, 'git').length, 0);
    assert.ok(!ranMark('uploadpack'));
    git(ws, 'config', '--unset', 'remote.origin.uploadpack');

    /* core.sshCommand of the repository and of the user, against an ssh:// remote */
    git(ws, 'remote', 'add', 'far', 'ssh://example.invalid/x.git');
    git(ws, 'config', 'core.sshCommand', script('repo-ssh', 'exit 1'));
    const userSsh = script('user-ssh', "echo 'git@example.invalid: Permission denied (publickey).' >&2; exit 255");
    git(HOME, 'config', '--global', 'core.sshCommand', userSsh);
    try { jj(ws, 'git', 'fetch', '--remote', 'far'); } catch (e) { /* the marker exits 1 */ }
    assert.ok(ranMark('repo-ssh'), 'the control: plain jj runs the repository\'s sshCommand');
    fs.rmSync(marker('repo-ssh'));
    fs.rmSync(marker('user-ssh'), { force: true });
    n = proc.calls.length; m = marked();
    await keys('f a');
    await done(m);
    assert.match(lastMessage(), /^process-error: jj git fetch failed \(exit 1\): Git process failed: .*; jj asks no credentials here: they come from your credential helper or ssh agent \(see \*vc-process\*\)$/);
    assert.ok(!ranMark('repo-ssh'), 'the repository\'s sshCommand not run');
    assert.ok(ranMark('user-ssh'), 'the user\'s ran');
    assert.deepEqual(configEnvOf(n, 'git', 'fetch').at(-1), ['core.sshCommand', userSsh]);
    git(ws, 'config', '--unset', 'core.sshCommand');
    git(HOME, 'config', '--global', '--unset', 'core.sshCommand');
    git(ws, 'remote', 'remove', 'far');

    /* an ext:: remote (a command line as a URL) the repository allows */
    git(ws, 'config', 'protocol.allow', 'always');
    git(ws, 'config', 'protocol.ext.allow', 'always');
    git(ws, 'remote', 'add', 'extr', `ext::sh -c touch% ${marker('ext')}`);
    try { jj(ws, 'git', 'fetch', '--remote', 'extr'); } catch (e) { /* touch is no git server */ }
    assert.ok(ranMark('ext'), 'the control: plain jj runs the ext:: command');
    fs.rmSync(marker('ext'));
    n = proc.calls.length; m = marked();
    await keys('f a');
    await done(m);
    assert.match(lastMessage(), /^process-error: jj git fetch failed \(exit 1\): /);
    assert.match(Ed.getBuffer('*vc-process*').text, /transport 'ext' not allowed/);
    assert.ok(!ranMark('ext'), 'no ext:: command ran');
    git(ws, 'remote', 'remove', 'extr');
    git(ws, 'config', '--unset', 'protocol.allow');
    git(ws, 'config', '--unset', 'protocol.ext.allow');

    /* fetch runs no hook: the reference-transaction hook of the repository */
    const hook = path.join(ws, '.git', 'hooks', 'reference-transaction');
    fs.writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${marker('hook')}'\n`, { mode: 0o755 });
    otherCommit('c.txt', 'third');
    jj(ws, 'git', 'fetch');
    assert.ok(ranMark('hook'), 'the control: plain jj\'s fetch runs it');
    fs.rmSync(marker('hook'));
    const pushed = otherCommit('d.txt', 'fourth');
    m = marked();
    await keys('f f');
    await done(m);
    assert.equal(lastMessage(), 'Fetched: bookmark: main@origin [updated] tracked');
    assert.equal(commitOf(ws, 'main@origin'), pushed);
    assert.ok(!ranMark('hook'), 'no hook ran');
    fs.rmSync(hook);
  } finally {
    fs.writeFileSync(cfg, saved);
  }
});

test('a workspace that is not colocated: the configuration of the git repository in its store is read, and its receivepack refused', async () => {
  const nc = mkdir('nc');
  jj(nc, 'git', 'init', '--no-colocate');
  write(path.join(nc, 'a.txt'), 'a\n');
  jj(nc, 'describe', '-m', 'mine');
  jj(nc, 'git', 'remote', 'add', 'origin', remote);
  jj(nc, 'bookmark', 'create', '-r', '@', 'nc-one');
  const store = path.join(nc, '.jj', 'repo', 'store', 'git');
  assert.ok(fs.existsSync(path.join(store, 'config')) && !fs.existsSync(path.join(nc, '.git')));
  git(store, 'config', 'remote.origin.receivepack', script('nc-receivepack', 'exec git-receive-pack "$@"'));
  jj(nc, 'git', 'push', '--bookmark', 'nc-one');
  assert.ok(ranMark('nc-receivepack'), 'the control: plain jj runs it');
  fs.rmSync(marker('nc-receivepack'));
  jj(nc, 'bookmark', 'create', '-r', '@', 'nc-two');
  await openLog(nc);
  onChange(changeOf(nc, '@'));
  const n = proc.calls.length;
  assert.match(String(await errorOf(L('jj-git-push'))), /'s own configuration names a program as origin's receivepack: not run here/);
  await Ed.whenIdle();
  assert.ok(proc.calls.slice(n).some(c => c.argv[0] === 'git' && c.argv.includes('--git-dir=' + store)), 'read from the store\'s git repository');
  assert.equal(ops(n, 'git').length, 0);
  assert.ok(!ranMark('nc-receivepack'));
  assert.equal(remoteHas(remote, 'nc-two'), '');

  /* a secondary workspace of it: its .jj/repo names the first one's, whose store is read */
  jj(nc, 'workspace', 'add', '--name', 'second', path.join(root, 'nc-second'));
  const sec = path.join(root, 'nc-second');
  assert.equal(fs.statSync(path.join(sec, '.jj', 'repo')).isFile(), true);
  write(path.join(sec, 'a.txt'), 'second\n');
  jj(sec, 'describe', '-m', 'from the second');
  jj(sec, 'bookmark', 'create', '-r', '@', 'nc-three');
  await openLog(sec);
  onChange(changeOf(sec, '@'));
  const k = proc.calls.length;
  assert.match(String(await errorOf(L('jj-git-push'))), /'s own configuration names a program as origin's receivepack: not run here/);
  assert.ok(proc.calls.slice(k).some(c => c.argv[0] === 'git' && c.argv.some(a => a.startsWith('--git-dir=') && a.endsWith('/.jj/repo/store/git') && a.includes('nc/.jj/repo'))),
    'read from the first workspace\'s store');
  assert.equal(ops(k, 'git').length, 0);
  assert.ok(!ranMark('nc-receivepack'));
});

test('a .jj/repo that is a symlink: the git repository jj reaches through it is the one read, not the one its path names as text', async () => {
  /* sl/.jj/repo -> ../a/b/c/repo, so the store's ../../../.git is sl/a/b/.git on disk (where jj's git goes), while
     sl/.git, the text's answer, is a clean repository of its own */
  const sl = mkdir('sl');
  jj(sl, 'git', 'init');
  write(path.join(sl, 'a.txt'), 'a\n');
  jj(sl, 'describe', '-m', 'linked');
  jj(sl, 'bookmark', 'create', '-r', '@', 'sl-one');
  fs.mkdirSync(path.join(sl, 'a', 'b', 'c'), { recursive: true });
  fs.renameSync(path.join(sl, '.jj', 'repo'), path.join(sl, 'a', 'b', 'c', 'repo'));
  fs.symlinkSync('../a/b/c/repo', path.join(sl, '.jj', 'repo'));
  fs.renameSync(path.join(sl, '.git'), path.join(sl, 'a', 'b', '.git'));
  git(sl, 'init', '-q');
  const real = path.join(sl, 'a', 'b', '.git');
  git(real, 'remote', 'add', 'origin', remote);
  git(real, 'config', 'remote.origin.receivepack', script('sl-receivepack', 'exec git-receive-pack "$@"'));
  jj(sl, 'git', 'push', '--bookmark', 'sl-one');
  assert.ok(ranMark('sl-receivepack'), 'the control: plain jj runs the receivepack of sl/a/b/.git');
  fs.rmSync(marker('sl-receivepack'));
  jj(sl, 'bookmark', 'create', '-r', '@', 'sl-two');
  await openLog(sl);
  onChange(changeOf(sl, '@'));
  const n = proc.calls.length;
  assert.match(String(await errorOf(L('jj-git-push'))), /'s own configuration names a program as origin's receivepack: not run here/);
  assert.equal(ops(n, 'git').length, 0);
  assert.ok(!ranMark('sl-receivepack'));
  assert.equal(remoteHas(remote, 'sl-two'), '');
});

test('a workspace whose .jj is a symlink to a secondary workspace\'s: the git repository jj reaches through it on disk is the one read, not the one its path names as text', async () => {
  /* real/w colocated, its .git naming a receivepack; real/w2 a secondary workspace of it (.jj/repo the text
     ../../w/.jj/repo). top/w a copy of real/w whose store names a clean bare repository; top/w2/.jj a link to
     real/w2/.jj. In top/w2 jj resolves ../../w from real/w2/.jj on disk, so its git is real/w/.git; the text
     top/w2/.jj/../../w is top/w. */
  const w = mkdir('real', 'w');
  jj(w, 'git', 'init');
  write(path.join(w, 'a.txt'), 'a\n');
  jj(w, 'describe', '-m', 'first');
  jj(w, 'git', 'remote', 'add', 'origin', remote);
  git(w, 'config', 'remote.origin.receivepack', script('ln-receivepack', 'exec git-receive-pack "$@"'));
  jj(w, 'workspace', 'add', '--name', 'w2', path.join(root, 'real', 'w2'));
  const text = fs.readFileSync(path.join(root, 'real', 'w2', '.jj', 'repo'), 'utf8');
  assert.ok(!text.startsWith('/') && text.includes('..'), `a relative repo path: ${text}`);
  const clean = mkdir('clean.git');
  git(clean, 'init', '-q', '--bare');
  git(clean, 'remote', 'add', 'origin', remote);
  fs.cpSync(w, path.join(root, 'top', 'w'), { recursive: true, verbatimSymlinks: true });
  fs.writeFileSync(path.join(root, 'top', 'w', '.jj', 'repo', 'store', 'git_target'), clean);
  const w2 = mkdir('top', 'w2');
  write(path.join(w2, 'a.txt'), 'a\n');
  fs.symlinkSync('../../real/w2/.jj', path.join(w2, '.jj'));
  assert.equal(jj(w2, 'workspace', 'root').trim(), w2);
  jj(w2, 'describe', '-m', 'linked');
  jj(w2, 'bookmark', 'create', '-r', '@', 'ln-one');
  jj(w2, 'git', 'push', '--bookmark', 'ln-one');
  assert.ok(ranMark('ln-receivepack'), 'the control: plain jj in top/w2 runs the receivepack of real/w/.git');
  fs.rmSync(marker('ln-receivepack'));
  jj(w2, 'bookmark', 'create', '-r', '@', 'ln-two');
  await openLog(w2);
  onChange(changeOf(w2, '@'));
  const n = proc.calls.length;
  assert.match(String(await errorOf(L('jj-git-push'))), /'s own configuration names a program as origin's receivepack: not run here/);
  await Ed.whenIdle();
  const gitDirs = proc.calls.slice(n).flatMap(c => c.argv[0] === 'git' ? c.argv.filter(a => a.startsWith('--git-dir=')).map(a => fs.realpathSync(a.slice(10))) : []);
  assert.deepEqual(gitDirs, [path.join(root, 'real', 'w', '.git')], 'read from real/w\'s git repository');
  assert.equal(ops(n, 'git').length, 0);
  assert.ok(!ranMark('ln-receivepack'));
  assert.equal(remoteHas(remote, 'ln-two'), '');
});

test('a git_target or .jj/repo with a blank at an end or a control character: refused, since jj reads it untrimmed and would go to another directory', async () => {
  /* pad: not colocated; `store/git ` (the space jj keeps) a copy of store/git whose config names a receivepack,
     store/git clean */
  const pad = mkdir('pad');
  jj(pad, 'git', 'init', '--no-colocate');
  write(path.join(pad, 'a.txt'), 'a\n');
  jj(pad, 'describe', '-m', 'padded');
  jj(pad, 'git', 'remote', 'add', 'origin', remote);
  jj(pad, 'bookmark', 'create', '-r', '@', 'pad-one');
  const store = path.join(pad, '.jj', 'repo', 'store'), target = path.join(store, 'git_target');
  fs.cpSync(path.join(store, 'git'), path.join(store, 'git '), { recursive: true });
  git(path.join(store, 'git '), 'config', 'remote.origin.receivepack', script('pad-receivepack', 'exec git-receive-pack "$@"'));
  fs.writeFileSync(target, 'git ');
  jj(pad, 'git', 'push', '--bookmark', 'pad-one');
  assert.ok(ranMark('pad-receivepack'), 'the control: plain jj runs the receivepack of `store/git `');
  fs.rmSync(marker('pad-receivepack'));
  jj(pad, 'bookmark', 'create', '-r', '@', 'pad-two');
  await openLog(pad);
  onChange(changeOf(pad, '@'));
  for (const t of ['git ', 'git\n', ' ' + path.join(store, 'git'), 'git\t', 'g\u0001it']) {
    /* the directory jj would go to, planted with the receivepack, so that jj itself works there */
    if (!fs.existsSync(path.join(store, t))) fs.cpSync(path.join(store, 'git '), path.join(store, t), { recursive: true });
    fs.writeFileSync(target, t);
    const n = proc.calls.length;
    assert.match(String(await errorOf(L('jj-git-push'))), /'s jj repository names no git repository it keeps its commits in that Edwin reads as jj does/, JSON.stringify(t));
    assert.equal(ops(n, 'git').length, 0, `no jj git run for ${JSON.stringify(t)}`);
    assert.ok(!proc.calls.slice(n).some(c => c.argv[0] === 'git'), `no git configuration read for ${JSON.stringify(t)}`);
  }
  assert.ok(!ranMark('pad-receivepack'));
  assert.equal(remoteHas(remote, 'pad-two'), '');

  /* ps: a secondary workspace of pc, its .jj/repo given a trailing blank, `pc/.jj/repo ` beside pc/.jj/repo a
     copy of it whose store's git names a receivepack */
  const pc = mkdir('pc');
  jj(pc, 'git', 'init', '--no-colocate');
  write(path.join(pc, 'a.txt'), 'a\n');
  jj(pc, 'describe', '-m', 'first');
  jj(pc, 'git', 'remote', 'add', 'origin', remote);
  const ps = path.join(root, 'ps');
  jj(pc, 'workspace', 'add', '--name', 'ps', ps);
  write(path.join(ps, 'a.txt'), 'second\n');
  jj(ps, 'describe', '-m', 'second');
  jj(ps, 'bookmark', 'create', '-r', '@', 'ps-one');
  const repoFile = path.join(ps, '.jj', 'repo'), text = fs.readFileSync(repoFile, 'utf8');
  fs.cpSync(path.join(pc, '.jj', 'repo'), path.join(pc, '.jj', 'repo '), { recursive: true });
  git(path.join(pc, '.jj', 'repo ', 'store', 'git'), 'config', 'remote.origin.receivepack', script('ps-receivepack', 'exec git-receive-pack "$@"'));
  fs.writeFileSync(repoFile, text + ' ');
  jj(ps, 'git', 'push', '--bookmark', 'ps-one');
  assert.ok(ranMark('ps-receivepack'), 'the control: plain jj runs the receivepack of `pc/.jj/repo `\'s store');
  fs.rmSync(marker('ps-receivepack'));
  jj(ps, 'bookmark', 'create', '-r', '@', 'ps-two');
  for (const t of [text + ' ', text + '\n', ' ' + text]) {
    fs.writeFileSync(repoFile, t);
    from(path.join(ps, 'a.txt'));
    const n = proc.calls.length;
    await keys('SPC g J');
    assert.match(lastMessage(), /'s \.jj\/repo names no jj repository Edwin reads as jj does/, JSON.stringify(t));
    assert.equal(proc.calls.length, n, `no jj run for ${JSON.stringify(t)}`);
  }
  assert.ok(!ranMark('ps-receivepack'));
  assert.equal(remoteHas(remote, 'ps-two'), '');
});

test('one remote command at a time in a workspace:a second is refused while a push runs; nothing starts under the image\'s replay', async () => {
  /* a remote whose pre-receive hook waits for a file */
  const slow = mkdir('slow.git'), gate = path.join(root, 'slow-gate');
  git(slow, 'init', '-q', '--bare', '-b', 'main');
  fs.writeFileSync(path.join(slow, 'hooks', 'pre-receive'), `#!/bin/sh\necho 'the hook waits' >&2\nwhile [ ! -e '${gate}' ]; do sleep 0.05; done\n`, { mode: 0o755 });
  const sw = mkdir('slow-ws');
  jj(sw, 'git', 'init');
  write(path.join(sw, 'a.txt'), 'a\n');
  jj(sw, 'describe', '-m', 'slow one');
  jj(sw, 'git', 'remote', 'add', 'origin', slow);
  jj(sw, 'bookmark', 'create', '-r', '@', 'main');
  await openLog(sw);
  onChange(changeOf(sw, '@'));
  const m = marked();
  await keys('p p');
  await until(() => /\nremote: the hook waits *\n/.test(Ed.getBuffer('*vc-process*').text), 'the hook\'s line in *vc-process*');
  assert.ok(proc.running().length > 0, 'jj still runs');
  const n = proc.calls.length;
  await keys('f f');
  assert.equal(lastMessage(), `Pushing main to origin still runs in ${sw}: see *vc-process*`);
  assert.equal(proc.calls.length, n, 'nothing started');
  fs.writeFileSync(gate, '');
  await done(m);
  assert.match(lastMessage(), /^Pushed to origin: bookmark: main \[add to [0-9a-f]{12}\]$/);

  const k = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => {
    for (const c of ['jj-git-fetch', 'jj-git-fetch-all', 'jj-git-push', 'jj-git-push-change', 'jj-git-push-deleted', 'jj-bookmark-create', 'jj-bookmark-set',
      'jj-bookmark-rename', 'jj-bookmark-delete', 'jj-bookmark-forget', 'jj-bookmark-track', 'jj-bookmark-untrack']) {
      try { ps.push(Promise.resolve(L(c))); } catch (e) { ps.push(Promise.reject(e)); }
    }
  });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, k, 'no child started');
});
