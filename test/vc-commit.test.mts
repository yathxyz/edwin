// Committing from git's status buffer (src/vc-git.ts: c c, c a, c w and c f) in the headless runtime, with real
// git from PATH through Ed.proc over fake-proc.mts's host.proc, in throwaway repositories under a throwaway HOME;
// host.files is node:fs, as host-native.ts has it. After each command the log (`git log`) and the index are
// compared with what the command must leave.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-commit.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-commit-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's is read; fixed dates. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS']) delete process.env[k];
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
const read = (file: string) => fs.readFileSync(file, 'utf8');
/* The log, newest first: each commit's whole message, and what it changed. */
const messages = (cwd: string) => git(cwd, 'log', '--format=%B%x00').split('\0\n').filter(m => m).map(m => m.replace(/^\n/, ''));
const changed = (cwd: string, rev = 'HEAD') => git(cwd, 'show', '--format=', '--name-only', rev).split('\n').filter(l => l).sort();
const staged = (cwd: string) => git(cwd, 'diff', '--cached', '--name-only').split('\n').filter(l => l);

const visit = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-commit test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
/* Wait, up to 20 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}`);
  await Ed.whenIdle();
};
const commits = () => proc.calls.filter(c => c.argv.includes('commit'));
/* The message buffer open, its text as the user leaves it (comment lines may stay: they are left out), then C-c C-c
   and the commit's end awaited: the status buffer back. */
const messageBuffer = async (name: string) => { await until(() => E.current.mode === 'vc-message-mode', 'the message buffer'); assert.equal(E.current.name, name); return E.current; };
const finish = async (text: string) => {
  const n = commits().length, said = Ed.getBuffer("*Messages*").text.length;
  E.current.text = text;
  await keys("C-c C-c");
  await until(() => commits().length > n && !proc.running().length && Ed.getBuffer("*Messages*").text.length > said && /^(\[|process-error: git commit failed)/.test(lastMessage()), "the commit");
};

/* ---------- the fixture ---------- */
const work = mkdir('work');
git(work, 'init', '-q', '-b', 'main');
write(path.join(work, 'a.txt'), 'a\n');
write(path.join(work, 'b.txt'), 'b\n');
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'first');
const NAME = '*git-commit: work*';

test('c c commits what is staged, with the message written in its buffer, on standard input', async () => {
  write(path.join(work, 'a.txt'), 'A\n');
  write(path.join(work, 'b.txt'), 'B\n');
  git(work, 'add', 'a.txt');
  visit(path.join(work, 'a.txt'));
  await keys('SPC g g');
  assert.equal(E.current.mode, 'git-status-mode');
  await keys('c c');
  const b = await messageBuffer(NAME);
  assert.equal(b.text, `\n\n# Committing on branch main in ${work}.\n# C-c C-c commits, C-c C-k aborts. Lines starting with # are left out.\n#\n# Changes to be committed:\n#\tmodified:   a.txt\n`);
  assert.equal(b.pt, 0);
  await finish('Change a\n\nThe body,  kept as written.\n#  a comment\n' + b.text);
  assert.deepEqual(messages(work), ['Change a\n\nThe body,  kept as written.\n', 'first\n']);
  assert.deepEqual(changed(work), ['a.txt'], 'only the staged change');
  assert.equal(read(path.join(work, 'b.txt')), 'B\n');
  assert.deepEqual(staged(work), []);
  assert.match(lastMessage(), /^\[main [0-9a-f]{7,}\] Change a$/);
  assert.ok(!E.current.text.includes('Staged changes'), 'the status read again');
  /* the message on standard input, never in the argv; commit keeps its hooks, the reads do not */
  const c = commits().at(-1)!;
  assert.deepEqual(c.argv.slice(c.argv.indexOf('commit')), ['commit', '--cleanup=verbatim', '-F', '-']);
  assert.ok(!c.argv.some(a => a.includes('Change a')));
  assert.ok(!c.argv.includes('core.hooksPath=/dev/null'), 'commit keeps the hooks');
  assert.ok(Ed.getBuffer('*vc-process*').text.includes('commit --cleanup=verbatim -F -'));
  assert.equal(Ed.getBuffer(NAME), null, 'the message buffer gone');
});

test('c a amends: the last message to edit, the staged changes taken as well', async () => {
  git(work, 'add', 'b.txt');
  await keys('g r');
  await keys('c a');
  const b = await messageBuffer(NAME);
  const head = git(work, 'rev-parse', '--short', 'HEAD').trim();
  assert.equal(b.text, `Change a\n\nThe body,  kept as written.\n\n# Amending ${head} Change a on branch main in ${work}.\n# C-c C-c commits, C-c C-k aborts. Lines starting with # are left out.\n#\n# Staged changes it takes as well:\n#\tmodified:   b.txt\n`);
  await finish(b.text.replace('Change a', 'Change a and b'));
  assert.deepEqual(messages(work), ['Change a and b\n\nThe body,  kept as written.\n', 'first\n']);
  assert.deepEqual(changed(work), ['a.txt', 'b.txt']);
  assert.deepEqual(staged(work), []);
  assert.deepEqual(commits().at(-1)!.argv.slice(-4), ['--amend', '--cleanup=verbatim', '-F', '-']);
});

test('c w rewords the last commit alone: the staged changes stay staged, no pre-commit or commit-msg hook runs; c f fixes up with the hooks', async () => {
  const marker = path.join(root, 'commit-msg-ran'), pre = path.join(root, 'pre-commit-ran');
  for (const [hook, m] of [['commit-msg', marker], ['pre-commit', pre]]) {
    write(path.join(work, '.git/hooks', hook), `#!/bin/sh\ntouch '${m}'\n`);
    fs.chmodSync(path.join(work, '.git/hooks', hook), 0o755);
  }
  write(path.join(work, 'a.txt'), 'AA\n');
  git(work, 'add', 'a.txt');
  const tree = git(work, 'rev-parse', 'HEAD^{tree}');
  await keys('g r');
  await keys('c w');
  const b = await messageBuffer(NAME);
  assert.match(b.text, /^Change a and b\n\nThe body, {2}kept as written\.\n\n# Rewording [0-9a-f]+ Change a and b on branch main in .*\n# C-c C-c commits, C-c C-k aborts\. Lines starting with # are left out\.\n# Only the message changes: the staged changes stay staged, and no pre-commit or commit-msg hook runs\.\n$/);
  await finish('Reworded\n');
  assert.deepEqual(messages(work), ['Reworded\n', 'first\n']);
  assert.equal(git(work, 'rev-parse', 'HEAD^{tree}'), tree, 'the tree as it was');
  assert.deepEqual(staged(work), ['a.txt'], 'still staged');
  assert.equal(fs.existsSync(marker), false, 'reword runs no commit-msg hook');
  assert.equal(fs.existsSync(pre), false, 'nor pre-commit');
  assert.deepEqual(commits().at(-1)!.argv.slice(-6), ['--amend', '--only', '--no-verify', '--cleanup=verbatim', '-F', '-']);
  /* c f on the first commit's line in Recent commits: fixup! first, the staged change in it, the hook run */
  const first = git(work, 'rev-parse', '--short', 'HEAD~1').trim();
  goTo(`${first} first`);
  const n = commits().length;
  await keys('c f');
  await until(() => commits().length > n && !proc.running().length && lines().includes(`${git(work, 'rev-parse', '--short', 'HEAD').trim()} fixup! first`), 'the fixup');
  assert.deepEqual(messages(work), ['fixup! first\n', 'Reworded\n', 'first\n']);
  assert.deepEqual(changed(work), ['a.txt']);
  assert.equal(read(path.join(work, 'a.txt')), 'AA\n');
  assert.equal(fs.existsSync(marker), true, 'the fixup ran the commit-msg hook');
  assert.equal(fs.existsSync(pre), true, 'and pre-commit');
  assert.equal(commits().at(-1)!.argv.at(-1), '--fixup=' + git(work, 'rev-parse', 'HEAD~2').trim());
  for (const hook of ['commit-msg', 'pre-commit']) fs.rmSync(path.join(work, '.git/hooks', hook));
});

test('c f elsewhere asks for the commit: HEAD by default; what is typed is never a switch', async () => {
  write(path.join(work, 'b.txt'), 'BB\n');
  git(work, 'add', 'b.txt');
  visit(path.join(work, 'b.txt'));
  const n = commits().length;
  await keys('M-x'); await ed.type('git-commit-fixup\n'); await Ed.whenIdle();
  assert.equal(E.mini?.prompt, 'Fix up commit (HEAD): ');
  await ed.type('--amend\n'); await Ed.whenIdle();
  await until(() => /Not a commit: --amend/.test(lastMessage()), 'the refusal');
  assert.equal(commits().length, n, 'no commit');
  await keys('M-x'); await ed.type('git-commit-fixup\n'); await Ed.whenIdle();
  await keys('RET');
  await until(() => commits().length > n && !proc.running().length, 'the fixup');
  assert.deepEqual(messages(work).slice(0, 2), ['fixup! fixup! first\n', 'fixup! first\n']);
  assert.deepEqual(changed(work), ['b.txt']);
});

test('a commit a hook refuses: git\'s words said, the message kept for the next c c', async () => {
  write(path.join(work, '.git/hooks/pre-commit'), '#!/bin/sh\necho "not today" >&2\nexit 1\n');
  fs.chmodSync(path.join(work, '.git/hooks/pre-commit'), 0o755);
  write(path.join(work, 'a.txt'), 'AAA\n');
  git(work, 'add', 'a.txt');
  const head = git(work, 'rev-parse', 'HEAD');
  await keys('SPC g g');
  await keys('c c');
  await messageBuffer(NAME);
  await finish('Kept message\n\nIts body.\n');
  assert.match(lastMessage(), /^process-error: git commit failed \(exit 1\): not today; the message is kept for the next commit \(see \*vc-process\*\)$/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.deepEqual(staged(work), ['a.txt']);
  fs.rmSync(path.join(work, '.git/hooks/pre-commit'));
  await keys('c c');
  const b = await messageBuffer(NAME);
  assert.ok(b.text.startsWith('Kept message\n\nIts body.\n\n# Committing on branch main'), b.text);
  await finish(b.text);
  assert.equal(messages(work)[0], 'Kept message\n\nIts body.\n');
  /* used: the next c c starts empty */
  write(path.join(work, 'a.txt'), 'A4\n'); git(work, 'add', 'a.txt');
  await keys('g r');
  await keys('c c');
  assert.ok((await messageBuffer(NAME)).text.startsWith('\n\n# Committing'));
  const m = commits().length;
  await keys('C-c C-k');
  assert.equal(lastMessage(), 'Message aborted');
  assert.equal(Ed.getBuffer(NAME), null);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(commits().length, m, 'C-c C-k: no commit started');
  git(work, 'reset', '-q');
});

test('a hook that prints megabytes: the commit is not cut short; refused, its last line is said', async () => {
  const hook = path.join(work, '.git/hooks/pre-commit');
  const verbose = (exit: number, last: string) => {
    write(hook, `#!/bin/sh\nhead -c 3000000 /dev/zero | tr '\\000' x\necho\necho '${last}'\nexit ${exit}\n`);
    fs.chmodSync(hook, 0o755);
  };
  write(path.join(work, 'a.txt'), 'verbose\n'); git(work, 'add', 'a.txt');
  verbose(1, 'lint failed after all that');
  const head = git(work, 'rev-parse', 'HEAD');
  await keys('SPC g g');
  await keys('c c');
  await messageBuffer(NAME);
  await finish('Verbose\n');
  assert.match(lastMessage(), /^process-error: git commit failed \(exit 1\): lint failed after all that; the message is kept for the next commit/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'no commit');
  verbose(0, 'lint passed');
  await keys('c c');
  const b = await messageBuffer(NAME);
  await finish(b.text);
  assert.match(lastMessage(), /^\[main [0-9a-f]{7,}\] Verbose$/);
  assert.equal(messages(work)[0], 'Verbose\n');
  assert.deepEqual(changed(work), ['a.txt']);
  fs.rmSync(hook);
});

test('save first: the changed buffers of the repository are offered, one question; n commits what the files hold', async () => {
  const outside = mkdir('outside');
  const other = visit(path.join(outside, 'o.txt'));
  other.text = 'not asked about\n'; other.modified = true;
  write(path.join(work, 'b.txt'), 'B5\n'); git(work, 'add', 'b.txt');
  const a = visit(path.join(work, 'a.txt'));
  a.text = 'saved\n'; a.modified = true;
  await keys('SPC g g');
  await keys('c c');
  assert.equal(E.prompt, 'Save a.txt before committing? (y or n) ');
  await keys('y');
  await messageBuffer(NAME);
  assert.equal(read(path.join(work, 'a.txt')), 'saved\n');
  assert.equal(a.modified, false);
  assert.equal(fs.existsSync(path.join(outside, 'o.txt')), false, 'a buffer outside the repository is left');
  await keys('C-c C-k');
  a.text = 'not saved\n'; a.modified = true;
  const c = visit(path.join(work, 'c.txt'));
  c.text = 'c\n'; c.modified = true;
  await keys('SPC g g');
  await keys('c c');
  assert.equal(E.prompt, `Save 2 changed buffers of ${work} before committing? (y or n) `);
  await keys('n');
  await messageBuffer(NAME);
  await finish('B5\n');
  assert.deepEqual(changed(work), ['b.txt']);
  assert.equal(read(path.join(work, 'a.txt')), 'saved\n');
  assert.equal(fs.existsSync(path.join(work, 'c.txt')), false);
  for (const b of [a, c, other]) { b.modified = false; ed.L.call('kill-buffer', [b]); }
});

test('refused before any message is written: nothing staged, a conflict, no commit yet, a jj workspace, the image\'s replay', async () => {
  await keys('SPC g g');
  const n = commits().length;
  for (const k of ['c c', 'c f']) {
    await keys(k);
    assert.equal(lastMessage(), 'Nothing staged: stage changes with s first', k);
  }
  assert.equal(Ed.getBuffer(NAME), null);

  const fresh = mkdir('fresh');
  git(fresh, 'init', '-q', '-b', 'trunk');
  write(path.join(fresh, 'f.txt'), 'f\n'); git(fresh, 'add', 'f.txt');
  visit(path.join(fresh, 'f.txt'));
  await keys('SPC g g');
  await keys('c a');
  assert.equal(lastMessage(), 'No commit yet: nothing to amend');
  await keys('c w');
  assert.equal(lastMessage(), 'No commit yet: nothing to reword');
  await keys('c f');
  assert.equal(lastMessage(), 'No commit yet: nothing to fix up');
  assert.equal(commits().length, n);
  /* the first commit */
  await keys('c c');
  const b = await messageBuffer('*git-commit: fresh*');
  assert.match(b.text, /^\n\n# Committing on branch trunk in .*fresh\.\n/);
  await finish('Start\n');
  assert.deepEqual(messages(fresh), ['Start\n']);

  const cf = mkdir('conflict');
  git(cf, 'init', '-q', '-b', 'main');
  write(path.join(cf, 'c.txt'), 'base\n'); git(cf, 'add', '.'); git(cf, 'commit', '-q', '-m', 'base');
  git(cf, 'checkout', '-q', '-b', 'side'); write(path.join(cf, 'c.txt'), 'side\n'); git(cf, 'commit', '-q', '-am', 'side');
  git(cf, 'checkout', '-q', 'main'); write(path.join(cf, 'c.txt'), 'main\n'); git(cf, 'commit', '-q', '-am', 'main');
  git(cf, 'merge', '-q', 'side');
  visit(path.join(cf, 'c.txt'));
  await keys('SPC g g');
  await keys('c c');
  assert.equal(lastMessage(), '1 conflicted file: resolve and stage it first');

  const jj = mkdir('jj');
  fs.mkdirSync(path.join(jj, '.jj'));
  visit(path.join(jj, 'x.txt'));
  await keys('M-x'); await ed.type('git-commit\n'); await Ed.whenIdle();
  assert.equal(lastMessage(), `${jj} is a jj workspace: describe its change with jj, or commit from SPC g G's status buffer`);

  const m = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { for (const c of ['git-commit', 'git-commit-amend', 'git-commit-reword', 'git-commit-fixup']) ps.push(ed.L.call(c, [])); });
  for (const p of ps) { let e: unknown = null; try { await p; } catch (x) { e = x; } assert.match(String(Ed.errorText(e)), /while the image replays/); }
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, m, 'no child started');
});
