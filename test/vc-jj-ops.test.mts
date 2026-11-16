// jj's everyday operations from its log and change view (src/vc-jj.ts: o new, c describe, e edit, x abandon, s squash)
// in the headless runtime, with real jj from PATH (the check brings nixpkgs' jujutsu) through Ed.proc over
// fake-proc.mts's host.proc, in a throwaway workspace under a throwaway HOME. Each operation's argv is checked after
// the runner's switches, and its result read back with jj's own template.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-jj-ops.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-jj-ops-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config', 'jj'), { recursive: true });
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  JJ_USER: 'Test', JJ_EMAIL: 'test@example.invalid', JJ_TIMESTAMP: '2026-01-01T00:00:00+00:00',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'JJ_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'JJ_EDITOR', 'EDITOR', 'VISUAL']) delete process.env[k];
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

const run = (cwd: string, prog: string, args: string[]) =>
  execFileSync(prog, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });
const jj = (cwd: string, ...args: string[]) => run(cwd, 'jj', ['--no-pager', '--color=never', ...args]);
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
/* What jj itself says of REV, read with no snapshot. */
const of = (cwd: string, rev: string, template: string) => jj(cwd, 'log', '--no-graph', '--ignore-working-copy', '-r', rev, '-T', template + ' ++ "\\n"').replace(/\n$/, '');
const changeOf = (cwd: string, rev: string) => of(cwd, rev, 'change_id');
const shortOf = (cwd: string, rev: string) => of(cwd, rev, 'change_id.shortest(8)');
const descriptionOf = (cwd: string, rev: string) => JSON.parse(of(cwd, rev, 'json(description)'));
const opCount = (cwd: string) => jj(cwd, 'op', 'log', '--no-graph', '--ignore-working-copy', '-T', 'id ++ "\\n"').split('\n').filter(l => l).length;

const from = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-jj-ops test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
/* Point to the log line of change ID (its first 8 letters). */
const onChange = (id: string) => {
  const i = lines().findIndex(l => l.split(' ')[1] === id.slice(0, 8));
  assert.ok(i >= 0, `a line of ${id} in\n${E.current.text}`);
  E.current.pt = Ed.lineStartB(E.current, i + 1);
};
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
/* An argv's part after the runner's fixed switches. */
const sub = (argv: string[]) => argv.slice(argv.indexOf('ui.log-word-wrap=false') + 1);
const ops = (n: number, name: string) => proc.calls.slice(n).map(c => sub(c.argv)).filter(a => a[0] === name);
/* Wait, up to 20 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}`);
  await Ed.whenIdle();
};
const messageBuffer = async (name: string) => { await until(() => E.current.mode === 'vc-message-mode', 'the message buffer'); assert.equal(E.current.name, name); return E.current; };
/* C-c C-c on TEXT, then the operation's end: the log back and something said. */
const finish = async (text: string) => {
  const said = Ed.getBuffer('*Messages*').text.length;
  E.current.text = text;
  await keys('C-c C-c');
  await until(() => !proc.running().length && E.current.mode === 'jj-log-mode' && Ed.getBuffer('*Messages*').text.length > said, 'the operation');
};
const openLog = async () => { from(path.join(ws, 'a.txt')); await keys('SPC g J'); assert.equal(E.current.mode, 'jj-log-mode'); };

/* ---------- the fixture ---------- */
/*  @  (empty)
    ○ C  "third": c.txt
    ○ B  "second": a.txt two, b.txt
    ◆ A  "first", tag v1 (immutable) */
const ws = mkdir('ws');
jj(ws, 'git', 'init');
write(path.join(ws, 'a.txt'), 'one\n');
jj(ws, 'describe', '-m', 'first');
/* (the tag makes @ immutable: jj starts a new @ on it) */
jj(ws, 'tag', 'set', 'v1', '-r', '@');
const A = changeOf(ws, '@-');
jj(ws, 'describe', '-m', 'second');
write(path.join(ws, 'a.txt'), 'two\n'); write(path.join(ws, 'b.txt'), 'b\n');
jj(ws, 'status');
const B = changeOf(ws, '@');
jj(ws, 'new', '-m', 'third');
write(path.join(ws, 'c.txt'), 'c\n');
jj(ws, 'status');
const C = changeOf(ws, '@');
jj(ws, 'new');

test('o starts a new change on the change at point; the log is read again and shows it', async () => {
  await openLog();
  onChange(B);
  const n = proc.calls.length;
  await keys('o');
  assert.deepEqual(ops(n, 'new'), [['new', '-r', `change_id(${B})`]]);
  assert.equal(changeOf(ws, '@-'), B, "@'s parent is B");
  assert.equal(of(ws, '@', 'empty'), 'true');
  /* the log after it, read again in the same buffer: the new @ there */
  assert.equal(E.current.name, '*jj-log: ws*');
  const at = lines().find(l => l.startsWith('@ '))!;
  assert.ok(at.includes(changeOf(ws, '@').slice(0, 8)), at);
  assert.match(lastMessage(), /^Working copy +\(@\) now at: /);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(fs.existsSync(path.join(ws, 'c.txt')), false, "the working copy is B's child: no c.txt");
});

test('e makes the change at point the working copy, after offering to save the changed buffers', async () => {
  const a = from(path.join(ws, 'b.txt'));
  a.text = 'b saved\n'; a.modified = true;
  await openLog();
  onChange(C);
  const n = proc.calls.length;
  await keys('e');
  assert.equal(E.prompt, 'Save b.txt before jj edit? (y or n) ');
  await keys('n');
  assert.deepEqual(ops(n, 'edit'), [['edit', '-r', `change_id(${C})`]]);
  assert.equal(changeOf(ws, '@'), C);
  assert.equal(fs.readFileSync(path.join(ws, 'c.txt'), 'utf8'), 'c\n', "C's files in the work tree");
  assert.equal(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8'), 'b\n', 'n saved nothing');
  assert.ok(lines().find(l => l.startsWith('@ '))!.includes(C.slice(0, 8)));
  assert.match(lastMessage(), /^Working copy +\(@\) now at: /);
  a.modified = false;
  L('kill-buffer', a);
});

test('c describes the change at point in a buffer, given to jj describe --stdin; C-c C-k leaves it', async () => {
  await openLog();
  onChange(B);
  const n = proc.calls.length;
  await keys('c');
  const b = await messageBuffer('*jj-describe: ws*');
  assert.equal(b.text, `second\n\nJJ: Describing ${shortOf(ws, `change_id(${B})`)} in ${ws}.\nJJ: C-c C-c describes, C-c C-k aborts. Lines starting with JJ: are left out.\n`);
  await finish('second, described   \n\n\nwith a body\nJJ: left out\n');
  assert.deepEqual(ops(n, 'describe'), [['describe', '-r', `change_id(${B})`, '--stdin']]);
  assert.equal(descriptionOf(ws, `change_id(${B})`), 'second, described\n\nwith a body\n');
  assert.ok(lines().some(l => l.includes(B.slice(0, 8)) && l.includes(' second, described ')), E.current.text);
  /* aborted: nothing run, the description as it was */
  onChange(B);
  const k = proc.calls.length;
  await keys('c');
  await messageBuffer('*jj-describe: ws*');
  assert.equal(E.current.text.split('\nJJ: ')[0], 'second, described\n\nwith a body\n');
  await keys('C-c C-k');
  assert.deepEqual(ops(k, 'describe'), []);
  assert.equal(descriptionOf(ws, `change_id(${B})`), 'second, described\n\nwith a body\n');
});

test('a description jj refuses is said and kept: the next c on that change starts from it', async () => {
  await openLog();
  onChange(B);
  await keys('c');
  await messageBuffer('*jj-describe: ws*');
  /* B becomes immutable while its description is written */
  jj(ws, 'tag', 'set', 'hold', '-r', `change_id(${B})`);
  await finish('refused for now\n');
  assert.match(lastMessage(), /^process-error: jj describe failed \(exit 1\): Commit [0-9a-f]+ is immutable \(see \*vc-process\*\)$/);
  assert.equal(descriptionOf(ws, `change_id(${B})`), 'second, described\n\nwith a body\n');
  jj(ws, 'tag', 'delete', 'hold');
  await L('git-status-refresh'); await Ed.whenIdle();
  onChange(B);
  await keys('c');
  await messageBuffer('*jj-describe: ws*');
  assert.equal(E.current.text.split('\nJJ: ')[0], 'refused for now\n');
  await keys('C-c C-k');
  /* taken: an abort lets it go */
  await keys('c');
  await messageBuffer('*jj-describe: ws*');
  assert.equal(E.current.text.split('\nJJ: ')[0], 'second, described\n\nwith a body\n');
  await keys('C-c C-k');
});

test('c in the change view describes the change it shows', async () => {
  await openLog();
  onChange(C);
  await keys('RET');
  assert.equal(E.current.mode, 'jj-change-mode');
  const n = proc.calls.length;
  await keys('c');
  await messageBuffer('*jj-describe: ws*');
  const said = Ed.getBuffer('*Messages*').text.length;
  E.current.text = 'third, from its view\n';
  await keys('C-c C-c');
  await until(() => !proc.running().length && E.current.mode === 'jj-change-mode' && Ed.getBuffer('*Messages*').text.length > said, 'the describe');
  assert.deepEqual(ops(n, 'describe'), [['describe', '-r', `change_id(${C})`, '--stdin']]);
  assert.equal(descriptionOf(ws, `change_id(${C})`), 'third, from its view\n');
  /* the view read again: its new description */
  assert.ok(lines().includes('    third, from its view'), E.current.text);
  await keys('q');
});

test('immutable changes are refused before anything is written; jj\'s own refusal is said', async () => {
  await openLog();
  onChange(A);
  const n = proc.calls.length;
  for (const [k, doing] of [['c', 'describe'], ['x', 'abandon'], ['s', 'squash']]) {
    await keys(k);
    assert.equal(lastMessage(), `${shortOf(ws, `change_id(${A})`)} first is immutable: jj does not ${doing} it`);
    assert.equal(E.current.mode, 'jj-log-mode', 'no message buffer');
  }
  /* s on B, described, whose parent A (described) is immutable: refused from the flag, no buffer */
  onChange(B);
  await keys('s');
  assert.equal(lastMessage(), `The parent of ${shortOf(ws, `change_id(${B})`)} second, described is immutable: jj does not squash into it`);
  assert.equal(E.current.mode, 'jj-log-mode', 'no message buffer');
  assert.deepEqual(proc.calls.slice(n).map(c => sub(c.argv)[0]), ['log', 'log', 'log', 'log'], 'only reads');
  /* e on the root: jj refuses it, Edwin says why; no operation written */
  const before = opCount(ws);
  onChange('zzzzzzzz');
  await keys('e');
  assert.match(lastMessage(), /^process-error: jj edit failed \(exit 1\): The root commit [0-9a-f]+ is immutable \(see \*vc-process\*\)$/);
  assert.equal(opCount(ws), before);
  /* no change at point: the heading */
  E.current.pt = 0;
  await keys('o');
  assert.equal(lastMessage(), 'No change at point');
  from(path.join(ws, 'a.txt'));
  await keys('M-x'); await ed.type('jj-new\n'); await Ed.whenIdle();
  assert.equal(lastMessage(), 'Not a jj log or change buffer');
});

test('s squashes into the parent: with one description, at once; with both, the result\'s written in a buffer and given as one --message=', async () => {
  /* D (no description, d.txt) on C: squashed at once, C keeps its description */
  jj(ws, 'new', `change_id(${C})`);
  write(path.join(ws, 'd.txt'), 'd\n');
  jj(ws, 'status');
  const D = changeOf(ws, '@');
  jj(ws, 'new');
  await openLog();
  onChange(D);
  let n = proc.calls.length;
  await keys('s');
  assert.deepEqual(ops(n, 'squash'), [['squash', '-r', `change_id(${D})`]]);
  assert.equal(of(ws, `change_id(${D})`, 'change_id'), '', 'D is gone');
  assert.equal(descriptionOf(ws, `change_id(${C})`), 'third, from its view\n');
  assert.match(of(ws, `change_id(${C})`, 'diff.files().map(|f| f.path()).join(" ")'), /d\.txt/);
  /* G, described, on C: both described, so the buffer; a message that starts like a switch stays one argument */
  jj(ws, 'new', '-m', 'fourth', `change_id(${C})`);
  write(path.join(ws, 'g.txt'), 'g\n');
  jj(ws, 'status');
  const G = changeOf(ws, '@');
  jj(ws, 'new');
  await L('git-status-refresh'); await Ed.whenIdle();
  onChange(G);
  n = proc.calls.length;
  await keys('s');
  const b = await messageBuffer('*jj-squash: ws*');
  const short = shortOf(ws, `change_id(${G})`);
  assert.equal(b.text, `third, from its view\n\nfourth\n\nJJ: Squashing ${short} into its parent in ${ws}: the description of what it makes, the parent's above and ${short}'s below.\nJJ: C-c C-c squashes, C-c C-k aborts. Lines starting with JJ: are left out.\n`);
  await finish('-R /elsewhere --config ui.editor=evil\n\nthird and fourth\n');
  assert.deepEqual(ops(n, 'squash'), [['squash', '-r', `change_id(${G})`, '--message=-R /elsewhere --config ui.editor=evil\n\nthird and fourth\n']]);
  assert.equal(descriptionOf(ws, `change_id(${C})`), '-R /elsewhere --config ui.editor=evil\n\nthird and fourth\n');
  assert.equal(of(ws, `change_id(${G})`, 'change_id'), '');
  /* a merge is refused before anything is written */
  jj(ws, 'new', '-m', 'merge', `change_id(${B})`, `change_id(${C})`);
  const M = changeOf(ws, '@');
  jj(ws, 'new');
  await L('git-status-refresh'); await Ed.whenIdle();
  onChange(M);
  n = proc.calls.length;
  await keys('s');
  assert.equal(lastMessage(), `${shortOf(ws, `change_id(${M})`)} merge is a merge: squash it from a terminal, naming the parent with --into`);
  assert.deepEqual(ops(n, 'squash'), []);
  /* a description of only a space is not empty to jj, which would ask: the buffer, not a bare jj squash */
  jj(ws, 'new', '-m', ' ', `change_id(${C})`);
  const S = changeOf(ws, '@');
  assert.equal(descriptionOf(ws, `change_id(${S})`), ' \n');
  jj(ws, 'new', '-m', 'on a space');
  write(path.join(ws, 'h.txt'), 'h\n');
  jj(ws, 'status');
  const H = changeOf(ws, '@');
  jj(ws, 'new');
  await L('git-status-refresh'); await Ed.whenIdle();
  onChange(H);
  n = proc.calls.length;
  await keys('s');
  await messageBuffer('*jj-squash: ws*');
  assert.equal(E.current.text.split('\nJJ: ')[0], ' \n\non a space\n');
  await finish('on a space\n');
  assert.deepEqual(ops(n, 'squash'), [['squash', '-r', `change_id(${H})`, '--message=on a space\n']]);
  assert.equal(descriptionOf(ws, `change_id(${S})`), 'on a space\n');
  assert.equal(of(ws, `change_id(${H})`, 'change_id'), '', 'H is gone');
});

test('x abandons the change at point after asking; a change view of it goes with it', async () => {
  jj(ws, 'new', '-m', 'doomed', `change_id(${B})`);
  const X = changeOf(ws, '@');
  jj(ws, 'new', '-m', 'child of doomed');
  const Y = changeOf(ws, '@');
  await openLog();
  onChange(X);
  await keys('RET');
  assert.equal(E.current.mode, 'jj-change-mode');
  await keys('q');
  L('switch-to-buffer', '*jj-log: ws*'); await Ed.whenIdle();
  onChange(X);
  const n = proc.calls.length;
  await keys('x');
  assert.equal(E.prompt, `Abandon ${shortOf(ws, `change_id(${X})`)} doomed? (y or n) `);
  await keys('n');
  assert.equal(lastMessage(), 'Nothing abandoned');
  assert.deepEqual(ops(n, 'abandon'), []);
  await keys('x');
  await keys('y');
  assert.deepEqual(ops(n, 'abandon'), [['abandon', '-r', `change_id(${X})`]]);
  assert.equal(of(ws, `change_id(${X})`, 'change_id'), '', 'X is gone');
  assert.equal(changeOf(ws, `change_id(${Y})-`), B, 'its child rebased onto its parent');
  assert.match(lastMessage(), /^Abandoned 1 commits:/);
  assert.equal(Ed.getBuffer('*jj-change: ws*'), null, 'the view of X is killed');
  assert.ok(!lines().some(l => l.includes(X.slice(0, 8))), E.current.text);
});

test('a divergent change is acted on by its commit id', async () => {
  jj(ws, 'new', '-m', 'start', `change_id(${B})`);
  const V = changeOf(ws, '@');
  jj(ws, 'new');
  const op = jj(ws, 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim();
  jj(ws, 'describe', '-r', `change_id(${V})`, '-m', 'one side');
  jj(ws, '--at-op', op, 'describe', '-r', `change_id(${V})`, '-m', 'other side');
  jj(ws, 'status');
  const commits = of(ws, `change_id(${V})`, 'commit_id').split('\n');
  assert.equal(commits.length, 2, 'divergent');
  await openLog();
  const i = lines().findIndex(l => l.includes('other side'));
  assert.ok(i >= 0, E.current.text);
  E.current.pt = Ed.lineStartB(E.current, i + 1);
  const other = commits.find(c => of(ws, c, 'description.first_line()') === 'other side')!;
  const n = proc.calls.length;
  await keys('x');
  assert.match(E.prompt, /^Abandon [k-z]+ other side\? \(y or n\) $/);
  await keys('y');
  assert.deepEqual(ops(n, 'abandon'), [['abandon', '-r', `commit_id(${other})`]]);
  assert.equal(of(ws, `change_id(${V})`, 'description.first_line()'), 'one side', 'one commit left');
});

test('under the image\'s replay none of them starts anything', async () => {
  await openLog();
  onChange(B);
  const m = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { for (const c of ['jj-new', 'jj-describe', 'jj-edit', 'jj-abandon', 'jj-squash']) { try { ps.push(Promise.resolve(L(c))); } catch (e) { ps.push(Promise.reject(e)); } } });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, m, 'no child started');
});
