// Phase 3's exit gate, scripted (docs/emacs-to-edwin plan): one run through Edwin's version control commands in
// the headless runtime, with real git and jj from PATH through Ed.proc over fake-proc.mts's host.proc, in a
// throwaway repository under a throwaway HOME. A hunk staged and committed, an interactive rebase that reorders,
// drops and squashes, its conflict resolved by vc-conflict-mode's keys and gone on with, then the same repository
// colocated with jj, a change described and squashed from jj's log. Every step is a key in Edwin's buffers; git
// and jj are run directly only to set the fixture up and to read back what Edwin did.
// Run: node --test test/vc-flow.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-flow-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config', 'jj'), { recursive: true });
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  JJ_USER: 'Test', JJ_EMAIL: 'test@example.invalid', JJ_TIMESTAMP: '2026-01-01T00:00:00+00:00',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'JJ_CONFIG', 'JJ_EDITOR', 'EDITOR', 'VISUAL']) delete process.env[k];

const proc = fakeProc();
after(() => { for (const id of proc.running()) proc.kill(id, 'KILL'); fs.rmSync(root, { recursive: true, force: true }); });
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

const run = (cwd: string, prog: string, args: string[]) => execFileSync(prog, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });
const git = (cwd: string, ...args: string[]) => run(cwd, 'git', args);
const jj = (cwd: string, ...args: string[]) => run(cwd, 'jj', ['--no-pager', '--color=never', ...args]);
const of = (cwd: string, rev: string, template: string) => jj(cwd, 'log', '--no-graph', '--ignore-working-copy', '-r', rev, '-T', template + ' ++ "\\n"').replace(/\n$/, '');
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file: string) => fs.readFileSync(file, 'utf8');
const subjects = (cwd: string) => git(cwd, 'log', '--format=%s', 'HEAD').split('\n').filter(l => l);
const hashOf = (cwd: string, subject: string) => git(cwd, 'log', '--format=%h %s', 'HEAD').split('\n').find(l => l.slice(l.indexOf(' ') + 1) === subject)!.split(' ')[0];

const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}\n${lastMessage()}\n${E.current.name}\n${E.current.text.slice(-2000)}`);
  await Ed.whenIdle();
};
const asked = async (p: string) => { await until(() => (E.mini && E.mini.prompt) === p, `the prompt ${JSON.stringify(p)} (now ${JSON.stringify(E.mini && E.mini.prompt)})`); };
const inMode = async (mode: string, name: string) => { await until(() => E.current.mode === mode, `a buffer in ${mode}`); assert.equal(E.current.name, name); };
const marked = () => Ed.getBuffer('*Messages*').text.length;
const done = async (mark: number) => {
  await until(() => { const t: string = Ed.getBuffer('*Messages*').text.slice(mark); return t.trim() !== '' && !/… \(see \*vc-process\*\)\n?$/.test(t) && !/C-c C-k \(Z Q\) aborts\n?$/.test(t) && !proc.running().length; }, 'the command\'s message');
};
const unfold = async (heading: string) => { if (lines().includes(heading + '…')) { goTo(heading + '…'); await keys('TAB'); } lineOf(heading); };

/* ---------- the fixture: base, a.txt of twenty lines ---------- */
const work = path.join(root, 'work');
fs.mkdirSync(work);
const N = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
const text = (changes: Record<number, string> = {}) => N.map((l, i) => changes[i + 1] ?? l).join('\n') + '\n';
git(work, 'init', '-q', '-b', 'main');
write(path.join(work, 'a.txt'), text());
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'base');

test('phase 3 end to end: stage a hunk, commit, rebase interactively through a conflict, then jj describe and squash', async () => {
  /* ---- stage one hunk of two and commit it, then the rest, then a change over the first ---- */
  write(path.join(work, 'a.txt'), text({ 2: 'L2', 18: 'L18' }));
  const f = Ed.getBufferCreate('a.txt (vc-flow test)'); f.file = path.join(work, 'a.txt'); Ed.setWindowBuffer(f);
  await keys('SPC g g');
  assert.equal(E.current.mode, 'git-status-mode');
  /* (the buffer the status was opened from, never read from the file, goes: RET visits the file afresh) */
  ed.L.call('kill-buffer', [f]);
  const commit = async (subject: string) => {
    const m = marked();
    await keys('c c');
    await inMode('vc-message-mode', '*git-commit: work*');
    E.current.text = subject + '\n' + E.current.text;
    await keys('C-c C-c');
    await until(() => E.current.mode === 'git-status-mode' && lastMessage().endsWith('] ' + subject) && !proc.running().length && marked() > m, `the commit ${subject}`);
  };
  await unfold('modified   a.txt');
  goTo('+L2');
  await keys('s');
  assert.equal(git(work, 'show', ':a.txt'), text({ 2: 'L2' }), 'the hunk alone staged');
  await commit('first hunk');
  assert.equal(git(work, 'show', 'HEAD:a.txt'), text({ 2: 'L2' }));
  assert.equal(read(path.join(work, 'a.txt')), text({ 2: 'L2', 18: 'L18' }), 'the other hunk left in the work tree');
  goTo(lines().find(l => /^modified   a\.txt…?$/.test(l))!);
  await keys('s');
  await commit('rest');
  write(path.join(work, 'a.txt'), text({ 2: 'L2b', 18: 'L18' }));
  await keys('g r');
  goTo(lines().find(l => /^modified   a\.txt…?$/.test(l))!);
  await keys('s');
  await commit('second');
  assert.deepEqual(subjects(work), ['second', 'rest', 'first hunk', 'base']);

  /* ---- r i from `first hunk`: drop it, second above rest, rest squashed into second ---- */
  const [A, B, C] = ['first hunk', 'rest', 'second'].map(s => hashOf(work, s));
  goTo(`${A} first hunk`);
  let m = marked();
  await keys('r i');
  await asked(`Rebase interactively from commit (${A}): `);
  await ed.type('\n'); await Ed.whenIdle();
  await inMode('git-rebase-todo-mode', '*git-rebase-todo: work*');
  const steps = () => lines().filter(l => l && !l.startsWith('#'));
  assert.deepEqual(steps(), [`pick ${A} # first hunk`, `pick ${B} # rest`, `pick ${C} # second`]);
  goTo(`pick ${C} # second`);
  await keys('M-k');
  goTo(`pick ${A} # first hunk`);
  await keys('d');
  goTo(`pick ${B} # rest`);
  await keys('s');
  assert.deepEqual(steps(), [`drop ${A} # first hunk`, `pick ${C} # second`, `squash ${B} # rest`]);
  await keys('Z Z');
  await done(m);
  /* second, on base, conflicts at line 2 */
  assert.equal(lastMessage(), `Rebasing stopped at ${C} second (2 of 3) with conflicts in a.txt: resolve them and stage them (s), then r r goes on, r s skips the commit, r a aborts`);
  assert.equal(E.current.mode, 'git-status-mode');
  assert.ok(lines().includes('both modified a.txt'), E.current.text);

  /* ---- resolve it: RET visits the file in vc-conflict-mode, C-c ^ l keeps the commit's side; save, s, r r ---- */
  goTo('both modified a.txt');
  await keys('RET');
  const a = E.current;
  assert.equal(a.file, path.join(work, 'a.txt'));
  assert.ok(Ed.minorOn(a, Ed.minorModes.get('vc-conflict-mode')), 'vc-conflict-mode on');
  a.pt = 0;
  await keys('] n');
  await keys('C-c ^ l');
  assert.equal(a.text, text({ 2: 'L2b' }));
  await keys('C-x C-s');
  assert.equal(read(path.join(work, 'a.txt')), text({ 2: 'L2b' }));
  await keys('SPC g g');
  assert.equal(E.current.mode, 'git-status-mode');
  goTo('both modified a.txt');
  await keys('s');
  await until(() => !proc.running().length && !lines().includes('both modified a.txt'), 'the resolution staged');
  m = marked();
  await keys('r r');
  /* the squash after it: its message written in the frame */
  await inMode('vc-message-mode', '*git-rebase-message: work*');
  assert.match(E.current.text, /^# This is a combination of 2 commits\.[^]*\nsecond\n[^]*\nrest\n/);
  E.current.text = 'second and rest\n';
  await keys('C-c C-c');
  await done(m);
  assert.equal(lastMessage(), `Rebase done: main at ${hashOf(work, 'second and rest')} second and rest`);
  assert.deepEqual(subjects(work), ['second and rest', 'base']);
  assert.equal(git(work, 'show', 'HEAD:a.txt'), text({ 2: 'L2b', 18: 'L18' }));
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(work, '.git', 'rebase-merge')), false);

  /* ---- the same repository with jj: describe a change, then squash it into its parent ---- */
  jj(work, 'git', 'init', '--colocate');
  write(path.join(work, 'j.txt'), 'j\n');
  Ed.setWindowBuffer(a);
  await keys('SPC g g');
  await inMode('jj-log-mode', '*jj-log: work*');
  const at = of(work, '@', 'change_id'), parent = of(work, '@-', 'change_id');
  assert.equal(of(work, '@-', 'description'), 'second and rest\n');
  const onChange = (id: string) => {
    const i = lines().findIndex(l => l.split(' ')[1] === id.slice(0, 8));
    assert.ok(i >= 0, `a line of ${id} in\n${E.current.text}`);
    E.current.pt = Ed.lineStartB(E.current, i + 1);
  };
  const finish = async (body: string) => {
    const said = marked();
    E.current.text = body;
    await keys('C-c C-c');
    await until(() => !proc.running().length && E.current.mode === 'jj-log-mode' && marked() > said, 'the jj operation');
  };
  onChange(at);
  await keys('c');
  await inMode('vc-message-mode', '*jj-describe: work*');
  await finish('add j\n');
  assert.equal(of(work, `change_id(${at})`, 'description'), 'add j\n');
  onChange(at);
  await keys('s');
  await inMode('vc-message-mode', '*jj-squash: work*');
  assert.equal(E.current.text.split('\nJJ: ')[0], 'second and rest\n\nadd j\n');
  await finish('second, rest and j\n');
  assert.equal(of(work, `change_id(${parent})`, 'description'), 'second, rest and j\n');
  assert.equal(of(work, `change_id(${at})`, 'change_id'), '', 'the described change squashed away');
  assert.equal(of(work, `change_id(${parent})`, 'diff.files().map(|f| f.path()).join(" ")'), 'a.txt j.txt');
});
