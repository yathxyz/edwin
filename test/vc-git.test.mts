// git's status buffer (src/vc-git.ts) in the headless runtime, with real git (and jj) from PATH through Ed.proc over
// fake-proc.mts's host.proc, in throwaway repositories under a throwaway HOME; host.files.tree is node:fs, as
// host-native.ts has it. A fixture repository with every section (untracked, a conflict, unstaged and staged
// changes, a rename, a deletion, a stash, commits to pull and to push) is shown by SPC g g, and its text compared
// line by line; then folding, refresh, visiting, moving between sections, and the cases around them.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-git.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-git-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's, git's or jj's, is read; fixed dates. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  JJ_USER: 'Test', JJ_EMAIL: 'test@example.invalid',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'JJ_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS']) delete process.env[k];
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const proc = fakeProc();
const host = ed.host as NodeHost & { proc?: FakeProc; files?: Edwin };
host.proc = proc;
host.files = {
  read(n: string) { try { return fs.readFileSync(n, 'utf8'); } catch (e) { return null; } },
  exists: (n: string) => fs.existsSync(n), resolve: (n: string) => path.resolve(root, n), truename: (n: string) => n, label: (n: string) => n,
  write() { throw new Error('not here'); }, remove() { throw new Error('not here'); }, list: () => [] as string[], cwd: root,
  tree: {
    names: (d: string) => fs.readdirSync(d),
    entry(p: string) {
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) { return null; }
      return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
    },
  },
};

/* A program run directly (not through Vc), for the fixtures: a failure is no exception. */
const run = (cwd: string, prog: string, ...args: string[]) => {
  try { return execFileSync(prog, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' }); }
  catch (e) { return String((e as { stdout?: string }).stdout || ''); }
};
const git = (cwd: string, ...args: string[]) => run(cwd, 'git', ...args);
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const short = (cwd: string, rev: string) => git(cwd, 'rev-parse', '--short', rev).trim();

/* A buffer as if visiting FILE (its directory is where SPC g g looks), shown in the selected window. */
const from = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-git test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
/* Keys, then the commands they start, to the end. */
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = () => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
const lineAtPoint = () => { const b = E.current, n = Ed.lineNoB(b, b.pt); return lines()[n - 1]; };
/* The class of each character of line N of buffer B, as the mode's lexer gives it. */
const classes = (b: Edwin, n: number) => { const s = Ed.lineStartB(b, n), e = Ed.eol(b.rope, s), lx = Ed.hooks.lexSeg(b, s, e, b.rope.slice(s, e)); return [...lx.cls].map((c: number) => lx.names[c]); };
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };

/* ---------- the fixture ---------- */
const up = mkdir('up.git');
git(up, 'init', '-q', '--bare', '-b', 'main');
const work = mkdir('work');
git(work, 'init', '-q', '-b', 'main');
write(path.join(work, 'a.txt'), 'one\ntwo\nthree\n');
write(path.join(work, 'del.txt'), 'gone soon\n');
write(path.join(work, 'old.txt'), 'renamed whole\n');
write(path.join(work, 'conf.txt'), 'base\n');
write(path.join(work, 'sp ace.txt'), 'first\nsecond\nthird\n');
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'first');
git(work, 'remote', 'add', 'origin', up);
git(work, 'push', '-q', '-u', 'origin', 'main');
/* upstream moves on from another clone */
const other = path.join(root, 'other');
git(root, 'clone', '-q', up, other);
write(path.join(other, 'u.txt'), 'upstream\n');
git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'upstream change'); git(other, 'push', '-q');
git(work, 'fetch', '-q');
/* a stash */
write(path.join(work, 'a.txt'), 'stashed\n');
git(work, 'stash', 'push', '-q', '-m', 'a stash');
/* a branch and a local commit that conflict on conf.txt, merged */
git(work, 'checkout', '-q', '-b', 'side');
write(path.join(work, 'conf.txt'), 'side\n'); git(work, 'commit', '-q', '-am', 'side');
git(work, 'checkout', '-q', 'main');
write(path.join(work, 'conf.txt'), 'main\n'); git(work, 'commit', '-q', '-am', 'local change');
git(work, 'merge', '-q', 'side');
/* staged: a new file, a deletion, a rename, a change; unstaged: a change, and another on the staged file */
write(path.join(work, 'added.txt'), 'added\n'); git(work, 'add', 'added.txt');
git(work, 'rm', '-q', 'del.txt');
git(work, 'mv', 'old.txt', 'new.txt');
write(path.join(work, 'sp ace.txt'), 'first\nsecond, staged\nthird\n'); git(work, 'add', 'sp ace.txt');
write(path.join(work, 'sp ace.txt'), 'first\nsecond, staged\nthird, not\n');
write(path.join(work, 'a.txt'), 'one\nTWO\nthree\n');
/* untracked: a file and a directory */
write(path.join(work, 'untracked.txt'), 'u\n');
write(path.join(work, 'dir/x.txt'), 'x\n');

test('SPC g g shows the sections of a repository with every kind of change', async () => {
  from(path.join(work, 'a.txt'));
  await keys('SPC g g');
  const b = E.current;
  assert.equal(b.name, '*git-status: work*');
  assert.equal(b.mode, 'git-status-mode');
  assert.equal(Ed.MODE_NAMES['git-status-mode'], 'Git Status');
  assert.ok(b.readOnly); assert.equal(b.evilState, 'motion'); assert.equal(b.modified, false); assert.deepEqual(b.undo, []);
  assert.equal(b.text, [
    'Head:     main local change',
    'Merge:    origin/main upstream change',
    '',
    'Untracked files (2)',
    'dir/',
    'untracked.txt',
    '',
    'Unmerged paths (1)',
    'both modified conf.txt',
    '',
    'Unstaged changes (2)',
    'modified   a.txt…',
    'modified   sp ace.txt…',
    '',
    'Staged changes (4)',
    'new file   added.txt…',
    'deleted    del.txt…',
    'renamed    old.txt -> new.txt',
    'modified   sp ace.txt…',
    '',
    'Stashes (1)…',
    '',
    'Unpulled from origin/main (1)',
    `${short(work, 'origin/main')} upstream change`,
    '',
    `Unpushed to origin/main (1)`,
    `${short(work, 'main')} local change`,
    '',
  ].join('\n'));
  assert.equal(b.pt, 0, 'point at the start');
  /* only reads ran: status, diff and log, each hardened by the runner */
  const subs = proc.calls.map(c => c.argv[c.argv.findIndex((a: string, i: number) => i > 0 && !a.startsWith('-') && c.argv[i - 1] !== '-c')]);
  assert.deepEqual([...new Set(subs)].sort(), ['config', 'diff', 'log', 'status']);
  for (const c of proc.calls) assert.ok(c.argv.includes('core.hooksPath=/dev/null') && (c.argv.includes('config') || c.argv.includes('--no-lazy-fetch')), c.argv.join(' '));
  /* faces: a section heading, the head's branch and upstream, a label, a hash */
  assert.deepEqual(new Set(classes(b, lineOf('Untracked files (2)'))), new Set(['git-section']));
  assert.deepEqual(classes(b, 1).slice(0, 14), [...Array(5).fill('git-dim'), ...Array(5).fill(''), ...Array(4).fill('git-branch')]);
  assert.deepEqual(new Set(classes(b, 2).slice(10, 21)), new Set(['git-remote']));
  assert.deepEqual(new Set(classes(b, lineOf('modified   a.txt…')).slice(0, 8)), new Set(['git-dim']));
  const hash = short(work, 'main');
  assert.deepEqual(new Set(classes(b, lineOf(`${hash} local change`)).slice(0, hash.length)), new Set(['git-hash']));
});

test('TAB folds and unfolds: a file\'s hunks, a hunk, a section; the stashes', async () => {
  const b = E.current;
  goTo('modified   a.txt…');
  await keys('TAB');
  const at = lineOf('modified   a.txt');
  assert.deepEqual(lines().slice(at - 1, at + 6), ['modified   a.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', 'modified   sp ace.txt…']);
  assert.equal(lineAtPoint(), 'modified   a.txt', 'point stays on the file');
  assert.deepEqual(new Set(classes(b, at + 1)), new Set(['git-hunk']));
  assert.deepEqual(classes(b, at + 3), ['git-removed', 'git-removed', 'git-removed', 'git-removed']);
  assert.deepEqual(classes(b, at + 4), ['git-added', 'git-added', 'git-added', 'git-added']);
  /* a hunk line folds its hunk, point to the hunk's heading */
  goTo('+TWO');
  await keys('TAB');
  assert.deepEqual(lines().slice(at - 1, at + 2), ['modified   a.txt', '@@ -1,3 +1,3 @@…', 'modified   sp ace.txt…']);
  assert.equal(lineAtPoint(), '@@ -1,3 +1,3 @@…');
  await keys('TAB');
  assert.equal(lines()[at + 1], ' one', 'unfolded again');
  /* a whole section */
  goTo('Untracked files (2)');
  await keys('TAB');
  assert.deepEqual(lines().slice(3, 5), ['Untracked files (2)…', '']);
  await keys('TAB');
  assert.deepEqual(lines().slice(3, 6), ['Untracked files (2)', 'dir/', 'untracked.txt']);
  /* a section folded and unfolded again shows its files as they were: a.txt still unfolded */
  goTo('Unstaged changes (2)');
  await keys('TAB');
  await keys('g r');
  assert.equal(lineAtPoint(), 'Unstaged changes (2)…');
  await keys('TAB');
  assert.deepEqual(lines().slice(at - 1, at + 1), ['modified   a.txt', '@@ -1,3 +1,3 @@'], 'its folds kept under the folded section, through a refresh');
  goTo('Stashes (1)…');
  await keys('TAB');
  assert.deepEqual(lines().slice(lineOf('Stashes (1)') - 1, lineOf('Stashes (1)') + 1), ['Stashes (1)', 'stash@{0} On main: a stash']);
  await keys('TAB');
  /* a line with nothing under it */
  const text = b.text;
  for (const l of ['renamed    old.txt -> new.txt', 'Head:     main local change', '']) {
    goTo(l);
    await keys('TAB');
    assert.equal(b.text, text); assert.equal(lastMessage(), 'Nothing to fold here');
  }
});

test('g r reads the repository again, keeping the folds and point; a second SPC g g reuses the buffer', async () => {
  const b = E.current;
  goTo('-two');
  b.pt += 2;
  write(path.join(work, 'later.txt'), 'later\n');
  write(path.join(work, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  await keys('g r');
  assert.equal(E.current, b);
  assert.deepEqual(lines().slice(3, 7), ['Untracked files (3)', 'dir/', 'later.txt', 'untracked.txt']);
  const at = lineOf('modified   a.txt');
  assert.deepEqual(lines().slice(at, at + 6), ['@@ -1,3 +1,4 @@', ' one', '-two', '+TWO', ' three', '+four'], 'a.txt stays unfolded, with its new hunk');
  assert.equal(lineAtPoint(), '-two'); assert.equal(b.pt - Ed.lineStartB(b, lineOf('-two')), 2, 'point on its line and column');
  /* on a blank line between sections: the same one after a refresh */
  b.pt = Ed.lineStartB(b, lineOf('Staged changes (4)') - 1);
  await keys('g r');
  assert.equal(Ed.lineNoB(b, b.pt), lineOf('Staged changes (4)') - 1);
  /* SPC g g from the status buffer itself, and from a file of the repository, reads it again into the same buffer */
  fs.rmSync(path.join(work, 'later.txt'));
  const n = proc.calls.length;
  await keys('SPC g g');
  assert.ok(proc.calls.length > n, 'read again');
  assert.equal(E.current, b);
  assert.equal(lines()[3], 'Untracked files (2)');
  from(path.join(work, 'dir', 'x.txt'));
  await keys('SPC g g');
  assert.equal(E.current, b, 'one buffer per repository');
  assert.equal(E.buffers.filter((x: Edwin) => x.mode === 'git-status-mode').length, 1);
});

test('C-j, C-k, g j and g k move between sections; RET visits the file at its line', async () => {
  goTo('Head:     main local change');
  await keys('C-j');
  assert.equal(lineAtPoint(), 'Untracked files (2)');
  await keys('g j');
  assert.equal(lineAtPoint(), 'Unmerged paths (1)', 'the next section of the same depth');
  await keys('g j');
  assert.equal(lineAtPoint(), 'Unstaged changes (2)');
  await keys('C-j');
  assert.equal(lineAtPoint(), 'modified   a.txt', 'C-j goes into a section');
  await keys('C-j');
  assert.equal(lineAtPoint(), '@@ -1,3 +1,4 @@');
  await keys('C-k');
  assert.equal(lineAtPoint(), 'modified   a.txt');
  await keys('g k');
  assert.equal(lineAtPoint(), 'modified   a.txt', 'no earlier sibling: stays');
  assert.equal(lastMessage(), 'No previous section');
  /* RET on an added line visits the file there (the buffer from() made visits it: the headless host keeps no disk) */
  const status = E.current;
  E.buffers.find((x: Edwin) => x.file === path.join(work, 'a.txt')).text = fs.readFileSync(path.join(work, 'a.txt'), 'utf8');
  goTo('+four');
  await keys('RET');
  assert.equal(E.current.file, path.join(work, 'a.txt'));
  assert.equal(Ed.lineNoB(E.current, E.current.pt), 4);
  Ed.setWindowBuffer(status);
  goTo('-two');
  await keys('RET');
  assert.equal(Ed.lineNoB(E.current, E.current.pt), 2, 'a removed line: where it was');
  Ed.setWindowBuffer(status);
  goTo('deleted    del.txt…');
  await keys('RET');
  assert.equal(E.current, status, 'a deleted file is not visited');
  assert.match(lastMessage(), /del\.txt is not in the work tree/);
  goTo('dir/');
  await keys('RET');
  assert.equal(E.current.mode, 'dired-mode', 'an untracked directory: its listing');
  Ed.setWindowBuffer(status);
  /* q leaves it; SPC is the leader there too */
  await keys('q');
  assert.notEqual(E.current, status);
});

test('a repository with no commit yet, a detached HEAD, a branch without upstream', async () => {
  const fresh = mkdir('fresh');
  git(fresh, 'init', '-q', '-b', 'trunk');
  write(path.join(fresh, 'f.txt'), 'f\n');
  from(path.join(fresh, 'f.txt'));
  await keys('SPC g g');
  assert.equal(E.current.text, 'Head:     trunk (no commit yet)\n\nUntracked files (1)\nf.txt\n');
  const det = mkdir('det');
  git(det, 'init', '-q', '-b', 'main');
  for (const n of ['one', 'two']) { write(path.join(det, n), n); git(det, 'add', n); git(det, 'commit', '-q', '-m', n); }
  git(det, 'checkout', '-q', '--detach', 'HEAD~1');
  from(path.join(det, 'one'));
  await keys('SPC g G');
  const one = short(det, 'HEAD');
  assert.equal(E.current.text, `Head:     ${one} one\n\nRecent commits\n${one} one\n`);
  assert.deepEqual(new Set(classes(E.current, 1).slice(10, 10 + one.length)), new Set(['git-hash']));
  git(det, 'checkout', '-q', 'main');
  await keys('g r');
  const two = short(det, 'HEAD');
  assert.equal(E.current.text, `Head:     main two\n\nRecent commits\n${two} two\n${one} one\n`, 'no upstream: the recent commits');
  /* an upstream that is gone */
  git(det, 'remote', 'add', 'origin', up);
  git(det, 'config', 'branch.main.remote', 'origin'); git(det, 'config', 'branch.main.merge', 'refs/heads/nowhere');
  await keys('g r');
  assert.equal(E.current.text.split('\n').slice(0, 2).join('\n'), 'Head:     main two\nMerge:    origin/nowhere (gone)');
});

test('refused: outside a repository; a jj workspace shows jj\'s log (SPC g G takes its git repository); under the image\'s replay', async () => {
  const plain = mkdir('plain');
  from(path.join(plain, 'f.txt'));
  const n = proc.calls.length;
  await keys('SPC g g');
  assert.match(lastMessage(), new RegExp(`Not in a repository: ${plain}`));
  assert.equal(proc.calls.length, n, 'nothing ran');
  const jj = mkdir('jj');
  run(jj, 'jj', 'git', 'init');
  write(path.join(jj, 'f.txt'), 'jj file\n');
  from(path.join(jj, 'f.txt'));
  await keys('SPC g g');
  assert.equal(E.current.mode, 'jj-log-mode', 'jj\'s log, the status view of a jj workspace (test/vc-jj.test.mts)');
  assert.ok(proc.calls.slice(n).every(c => c.argv[0] === 'jj'), 'jj alone ran');
  await keys('SPC g G');
  assert.equal(E.current.mode, 'git-status-mode', 'the colocated git repository');
  assert.match(E.current.text, /^Head:     /);
  /* the replay of the image starts nothing */
  from(path.join(work, 'a.txt'));
  const m = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { ps.push(ed.L.call('vc-status', []), ed.L.call('git-status', [])); });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, m, 'no child started');
});

test('the desktop-only stubs of SPC g g and SPC g G are gone; the keys name the new commands', () => {
  assert.equal(ed.eval("(bound? 'vile-vcs-status)"), false);
  assert.equal(ed.eval("(bound? 'vile-magit-status)"), false);
  assert.equal(ed.eval("(bound? 'vile-majutsu-status)"), false);
  const L = ed.L;
  assert.equal(L.call('lookup-key', [L.get('evil-normal-state-map'), 'SPC g g']).name, 'vc-status');
  assert.equal(L.call('lookup-key', [L.get('evil-normal-state-map'), 'SPC g G']).name, 'git-status');
  assert.equal(L.call('lookup-key', [L.get('evil-normal-state-map'), 'SPC g J']).name, 'jj-log');
});

test('a diff that is not UTF-8 shows its files without hunks; a name with a newline is shown on one line; a refresh of a killed buffer draws nothing', async () => {
  const odd = mkdir('odd');
  git(odd, 'init', '-q', '-b', 'main');
  write(path.join(odd, 'latin1.txt'), 'cafe\n');
  write(path.join(odd, 'line\nbreak.txt'), 'x\n');
  git(odd, 'add', '.'); git(odd, 'commit', '-q', '-m', 'odd');
  fs.writeFileSync(path.join(odd, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  write(path.join(odd, 'line\nbreak.txt'), 'y\n');
  from(path.join(odd, 'latin1.txt'));
  await keys('SPC g g');
  const b = E.current;
  assert.deepEqual(lines().slice(2, 6), ['Unstaged changes (2)', '(the diff is not shown: its text is not UTF-8)', 'modified   latin1.txt', 'modified   line?break.txt'],
    'the files, with no hunks to unfold');
  assert.deepEqual(new Set(classes(b, 4)), new Set(['git-dim']));
  /* killed while it reads: nothing is drawn into it, and nothing fails */
  const p = ed.L.call('git-status-refresh', []);
  ed.eval(`(kill-buffer "${b.name}")`);
  await p;
  assert.ok(!E.buffers.includes(b));
});

test('a repository whose own configuration names programs runs none of them for its status buffer', async () => {
  const evil = mkdir('evil'), marker = path.join(root, 'evil-ran');
  git(evil, 'init', '-q', '-b', 'main');
  write(path.join(evil, 'a.txt'), 'one\n');
  git(evil, 'add', '.'); git(evil, 'commit', '-q', '-m', 'one');
  /* a stash, read through its reflog under log.showSignature */
  write(path.join(evil, 'a.txt'), 'stashed\n'); git(evil, 'stash', 'push', '-q', '-m', 'kept');
  const script = path.join(root, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat\n`, { mode: 0o755 });
  for (const [k, v] of [['core.fsmonitor', script], ['core.pager', script], ['diff.external', script], ['diff.evil.textconv', script], ['diff.evil.command', script],
    ['filter.evil.clean', script], ['filter.evil.smudge', script], ['gpg.program', script], ['log.showSignature', 'true'], ['alias.status', '!' + script]]) git(evil, 'config', k, v);
  write(path.join(evil, '.gitattributes'), '* diff=evil filter=evil\n');
  write(path.join(evil, 'a.txt'), 'two\n');
  git(evil, 'add', '.gitattributes');
  /* the control: plain git runs them */
  git(evil, 'diff');
  assert.ok(fs.existsSync(marker), 'plain git diff runs the repository\'s programs');
  fs.rmSync(marker);
  from(path.join(evil, 'a.txt'));
  await keys('SPC g g');
  assert.equal(E.current.mode, 'git-status-mode');
  assert.match(E.current.text, /^Unstaged changes \(1\)\nmodified   a\.txt…$/m);
  assert.match(E.current.text, /^Stashes \(1\)…$/m);
  goTo('modified   a.txt…');
  await keys('TAB');
  assert.ok(lines().includes('+two'), 'the diff is git\'s own, not the textconv\'s');
  assert.equal(fs.existsSync(marker), false, 'nothing of the repository\'s ran');
});
