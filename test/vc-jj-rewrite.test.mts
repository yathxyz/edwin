// jj's rewrites from its log and change view (src/vc-jj.ts: r rebase, S split by file, u undo, C-r redo) in the
// headless runtime, with real jj from PATH (the check brings nixpkgs' jujutsu) through Ed.proc over fake-proc.mts's
// host.proc, in a throwaway workspace under a throwaway HOME. Each operation's argv is checked after the runner's
// switches, and the graph it leaves read back with jj's own template.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-jj-rewrite.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-jj-rewrite-')));
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
const filesOf = (cwd: string, rev: string) => JSON.parse(of(cwd, rev, '"[" ++ diff.files().map(|f| json(f.path())).join(",") ++ "]"')).sort();
const opCount = (cwd: string) => jj(cwd, 'op', 'log', '--no-graph', '--ignore-working-copy', '-T', 'id ++ "\\n"').split('\n').filter(l => l).length;
/* The whole graph: each commit's id with its parents' ids, a line each, sorted. */
const graph = (cwd: string) => of(cwd, 'all()', 'commit_id ++ " " ++ parents.map(|c| c.commit_id()).join(",")').split('\n').sort().join('\n');

const from = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-jj-rewrite test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
/* Point to the log line of change ID (its first 8 letters). */
const onChange = (id: string) => {
  const i = lines().findIndex(l => l.split(' ')[1] === id.slice(0, 8));
  assert.ok(i >= 0, `a line of ${id} in\n${E.current.text}`);
  E.current.pt = Ed.lineStartB(E.current, i + 1);
};
const lineOf = (id: string) => lines().find(l => l.split(' ')[1] === id.slice(0, 8))!;
/* Point to the line of the change view that is TEXT. */
const onLine = (text: string) => {
  const i = lines().indexOf(text);
  assert.ok(i >= 0, `a line ${text} in\n${E.current.text}`);
  E.current.pt = Ed.lineStartB(E.current, i + 1);
  return i;
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
/* C-c C-c on TEXT, then the operation's end: the view MODE back and something said. */
const finish = async (text: string, mode: string) => {
  const said = Ed.getBuffer('*Messages*').text.length;
  E.current.text = text;
  await keys('C-c C-c');
  await until(() => !proc.running().length && E.current.mode === mode && Ed.getBuffer('*Messages*').text.length > said, 'the operation');
};
const openLog = async () => { from(path.join(ws, 'a.txt')); await keys('SPC g J'); assert.equal(E.current.mode, 'jj-log-mode'); };
const showChange = async (id: string) => { await openLog(); onChange(id); await keys('RET'); assert.equal(E.current.mode, 'jj-change-mode'); };

/* ---------- the fixture ---------- */
/*  @  (empty)
    ○ C  "third": c.txt
    ○ B  "second": b.txt
    │ ○ D  "side": d.txt
    ├─╯
    ◆ A  "first", tag v1 (immutable) */
const ws = mkdir('ws');
jj(ws, 'git', 'init');
write(path.join(ws, 'a.txt'), 'one\n');
jj(ws, 'describe', '-m', 'first');
jj(ws, 'tag', 'set', 'v1', '-r', '@');
const A = changeOf(ws, '@-');
jj(ws, 'describe', '-m', 'second');
write(path.join(ws, 'b.txt'), 'b\n');
jj(ws, 'new', '-m', 'third');
const B = changeOf(ws, '@-');
write(path.join(ws, 'c.txt'), 'c\n');
jj(ws, 'new');
const C = changeOf(ws, '@-');
jj(ws, 'new', '-m', 'side', `change_id(${A})`);
write(path.join(ws, 'd.txt'), 'd\n');
jj(ws, 'new', `change_id(${C})`);
const D = changeOf(ws, `children(change_id(${A})) ~ change_id(${B})`);

test('r marks the source, r on another change rebases it and its descendants there; u undoes it and C-r redoes it, the graph each time as expected', async () => {
  await openLog();
  const before = graph(ws), at = changeOf(ws, '@');
  onChange(C);
  let n = proc.calls.length;
  await keys('r');
  assert.equal(lastMessage(), `Rebasing ${shortOf(ws, `change_id(${C})`)} third and its descendants: r on the change to put them on, r on it again to stop`);
  assert.ok(lineOf(C).endsWith(' [rebase source]'), lineOf(C));
  assert.ok(!lineOf(B).includes('[rebase source]'));
  /* the mark is kept across g r */
  await L('git-status-refresh'); await Ed.whenIdle();
  assert.ok(lineOf(C).endsWith(' [rebase source]'), lineOf(C));
  onChange(D);
  await keys('r');
  assert.equal(E.prompt, `Rebase ${shortOf(ws, `change_id(${C})`)} third and its descendants onto ${shortOf(ws, `change_id(${D})`)} side? (y or n) `);
  await keys('y');
  assert.deepEqual(ops(n, 'rebase'), [['rebase', '--source', `change_id(${C})`, '--onto', `change_id(${D})`]]);
  assert.equal(changeOf(ws, `change_id(${C})-`), D, "C's parent is D");
  assert.equal(changeOf(ws, '@-'), C, '@ came with it');
  assert.equal(changeOf(ws, '@'), at);
  assert.equal(changeOf(ws, `change_id(${B})+`), '', 'B has no child now');
  assert.ok(fs.existsSync(path.join(ws, 'd.txt')) && fs.existsSync(path.join(ws, 'c.txt')), "the work tree on D's and C's files");
  assert.equal(lastMessage(), 'Rebased 2 commits to destination.');
  assert.ok(!lines().some(l => l.includes('[rebase source]')), 'the mark is gone');
  const rebased = graph(ws);
  assert.notEqual(rebased, before);

  /* u: the question names jj's last operation */
  n = proc.calls.length;
  await keys('u');
  assert.match(E.prompt!, /^Undo jj's last operation, rebase commit [0-9a-f]+ and descendants\? \(y or n\) $/);
  await keys('y');
  assert.deepEqual(ops(n, 'undo'), [['undo']]);
  assert.equal(graph(ws), before, 'the graph as it was before the rebase, commit for commit');
  assert.equal(changeOf(ws, `change_id(${C})-`), B);
  assert.equal(fs.existsSync(path.join(ws, 'd.txt')), false, "the work tree off D's files again");
  assert.match(lastMessage(), /^Undid operation: [0-9a-f]+ .* rebase commit /);
  /* C-r: the rebase again, the very commits it made */
  n = proc.calls.length;
  await keys('C-r');
  assert.deepEqual(ops(n, 'redo'), [['redo']]);
  assert.equal(graph(ws), rebased);
  assert.match(lastMessage(), /^Restored to operation: [0-9a-f]+ .* rebase commit /);
  /* nothing left to redo: jj's refusal said, no operation written */
  const count = opCount(ws);
  await keys('C-r');
  assert.equal(lastMessage(), 'process-error: jj redo failed (exit 1): Nothing to redo (see *vc-process*)');
  assert.equal(opCount(ws), count);
  /* u after a redo names the operation redone, not the redo's own description (that operation's full id); n: nothing undone */
  n = proc.calls.length;
  await keys('u');
  assert.match(E.prompt!, /^Undo jj's redo of rebase commit [0-9a-f]+ and descendants\? \(y or n\) $/);
  assert.deepEqual(ops(n, 'op').map(a => a.slice(0, 2)), [['op', 'log'], ['op', 'show']]);
  await keys('n');
  assert.equal(lastMessage(), 'Nothing undone');
  assert.deepEqual(ops(n, 'undo'), []);
  assert.equal(graph(ws), rebased);
  /* a file written while it asks: jj's last operation would be that snapshot, not the one asked about */
  await keys('u');
  assert.match(E.prompt!, /^Undo jj's redo of /);
  write(path.join(ws, 'meanwhile.txt'), 'm\n');
  await keys('y');
  assert.equal(lastMessage(), "jj's operations changed while asking: nothing undone");
  assert.deepEqual(ops(n, 'undo'), []);
  assert.equal(fs.readFileSync(path.join(ws, 'meanwhile.txt'), 'utf8'), 'm\n');
  fs.rmSync(path.join(ws, 'meanwhile.txt'));
  jj(ws, 'status');
});

test('r on the source again unmarks it; n rebases nothing; an immutable source is refused; jj\'s refusal of a cycle is said', async () => {
  await openLog();
  const n = proc.calls.length;
  onChange(B);
  await keys('r');
  assert.ok(lineOf(B).endsWith(' [rebase source]'));
  await keys('r');
  assert.equal(lastMessage(), 'No rebase');
  assert.ok(!lines().some(l => l.includes('[rebase source]')));
  /* n: the mark goes, nothing run */
  await keys('r');
  onChange(D);
  await keys('r');
  await keys('n');
  assert.equal(lastMessage(), 'Nothing rebased');
  assert.ok(!lines().some(l => l.includes('[rebase source]')));
  assert.deepEqual(ops(n, 'rebase'), []);
  /* the immutable first change: refused, no mark */
  onChange(A);
  await keys('r');
  assert.equal(lastMessage(), `${shortOf(ws, `change_id(${A})`)} first is immutable: jj does not rebase it`);
  assert.ok(!lines().some(l => l.includes('[rebase source]')));
  /* D onto its own descendant C: jj refuses, Edwin says why, no operation written */
  const count = opCount(ws);
  onChange(D);
  await keys('r');
  onChange(C);
  await keys('r');
  await keys('y');
  assert.deepEqual(ops(n, 'rebase'), [['rebase', '--source', `change_id(${D})`, '--onto', `change_id(${C})`]]);
  assert.match(lastMessage(), /^process-error: jj rebase failed \(exit 1\): Cannot rebase [0-9a-f]+ onto descendant [0-9a-f]+ \(see \*vc-process\*\)$/);
  assert.equal(opCount(ws), count);
  /* marked in the change view, put on from the log */
  await showChange(B);
  await keys('r');
  assert.match(lastMessage(), /^Rebasing [k-z]+ second and its descendants/);
  L('switch-to-buffer', '*jj-log: ws*'); await Ed.whenIdle();
  assert.ok(lineOf(B).endsWith(' [rebase source]'), lineOf(B));
  onChange(B);
  await keys('r');
  assert.equal(lastMessage(), 'No rebase');
});

test('u on a snapshot of the working copy says so: undoing it puts the files written since back as they were', async () => {
  await openLog();
  write(path.join(ws, 'new.txt'), 'written since\n');
  const n = proc.calls.length;
  await keys('u');
  assert.equal(E.prompt, "Undo jj's snapshot of the working copy (the files written since jj last looked go back as they were)? (y or n) ");
  await keys('n');
  assert.equal(lastMessage(), 'Nothing undone');
  assert.equal(fs.readFileSync(path.join(ws, 'new.txt'), 'utf8'), 'written since\n');
  await keys('u');
  assert.match(E.prompt!, /^Undo jj's snapshot/);
  await keys('y');
  assert.deepEqual(ops(n, 'undo'), [['undo']]);
  assert.equal(fs.existsSync(path.join(ws, 'new.txt')), false);
  assert.match(lastMessage(), /^Undid operation: [0-9a-f]+ .* snapshot working copy$/);
});

test('u after u names the operation jj undo goes back over, a snapshot among them said, each as jj then says it undid', async () => {
  /* a workspace of its own: new (empty), a file written, new again (its snapshot first) */
  const w = mkdir('twice');
  jj(w, 'git', 'init');
  write(path.join(w, 'a.txt'), 'a\n');
  jj(w, 'describe', '-m', 'one');
  jj(w, 'new', '-m', 'two');
  write(path.join(w, 'b.txt'), 'b\n');
  jj(w, 'new', '-m', 'three');
  from(path.join(w, 'a.txt')); await keys('SPC g J');
  assert.equal(E.current.mode, 'jj-log-mode');
  const undid = () => { const m = /^Undid operation: [0-9a-f]+ \([^)]*\) (.*)$/.exec(lastMessage()); assert.ok(m, lastMessage()); return m![1]; };
  const n = proc.calls.length;
  await keys('u');
  assert.equal(E.prompt, "Undo jj's last operation, new empty commit? (y or n) ");
  await keys('y');
  assert.equal(undid(), 'new empty commit');
  assert.equal(fs.readFileSync(path.join(w, 'b.txt'), 'utf8'), 'b\n');
  /* the last operation is that undo; jj undo now undoes the snapshot of b.txt, and the question says so */
  await keys('u');
  assert.equal(E.prompt, "Undo jj's snapshot of the working copy (the files written since jj last looked go back as they were)? (y or n) ");
  await keys('n');
  assert.equal(lastMessage(), 'Nothing undone');
  await keys('u');
  assert.match(E.prompt!, /^Undo jj's snapshot/);
  await keys('y');
  assert.equal(undid(), 'snapshot working copy');
  assert.equal(fs.existsSync(path.join(w, 'b.txt')), false);
  /* and again: the new before it */
  await keys('u');
  assert.equal(E.prompt, "Undo jj's operation before that too, new empty commit? (y or n) ");
  await keys('y');
  assert.equal(undid(), 'new empty commit');
  assert.equal(descriptionOf(w, '@'), 'one\n');
  assert.deepEqual(ops(n, 'undo'), [['undo'], ['undo'], ['undo']]);
  assert.deepEqual(ops(n, 'op').map(a => a.slice(0, 2)), [['op', 'log'], ['op', 'log'], ['op', 'log'], ['op', 'show'], ['op', 'log'], ['op', 'show'], ['op', 'log'], ['op', 'log'], ['op', 'show'], ['op', 'log']]);
});

/* E, "fifth" on C, changes five files: names with a space, a quote and a backslash, a leading -, and a rename. */
const odd = 'q"\\x.txt';
let F = '';
test('S in the change view splits the file at point off the change, its description written first; the rest keeps the old one', async () => {
  jj(ws, 'new', '-m', 'fifth', `change_id(${C})`);
  write(path.join(ws, 'a b.txt'), 'space\n'); write(path.join(ws, odd), 'odd\n'); write(path.join(ws, '-lead.txt'), 'lead\n'); write(path.join(ws, 'keep.txt'), 'keep\n');
  fs.renameSync(path.join(ws, 'c.txt'), path.join(ws, 'moved.txt'));
  jj(ws, 'status');
  const E5 = changeOf(ws, '@');
  F = E5;
  jj(ws, 'new');
  assert.deepEqual(filesOf(ws, `change_id(${E5})`), ['-lead.txt', 'a b.txt', 'keep.txt', 'moved.txt', odd].sort());
  await showChange(E5);
  onLine(`new file   ${odd}`);
  const n = proc.calls.length;
  await keys('S');
  const b = await messageBuffer('*jj-split: ws*');
  const short = shortOf(ws, `change_id(${E5})`);
  assert.equal(b.text, `fifth\n\nJJ: Splitting ${odd} off ${short} in ${ws}: the description of the change that takes them; the rest keeps ${short}'s.\nJJ: C-c C-c splits, C-c C-k aborts. Lines starting with JJ: are left out.\n`);
  await finish('the odd one\n', 'jj-change-mode');
  assert.deepEqual(ops(n, 'split'), [['split', '-r', `change_id(${E5})`, '--message=the odd one\n', '--', 'root-file:"q\\"\\\\x.txt"']]);
  /* jj keeps the change id on the part split off; the rest is its child */
  assert.deepEqual(filesOf(ws, `change_id(${E5})`), [odd]);
  assert.equal(descriptionOf(ws, `change_id(${E5})`), 'the odd one\n');
  assert.equal(changeOf(ws, `change_id(${E5})-`), C);
  const rest = changeOf(ws, `change_id(${E5})+`);
  assert.deepEqual(filesOf(ws, `change_id(${rest})`), ['-lead.txt', 'a b.txt', 'keep.txt', 'moved.txt'], 'the rename and the rest');
  assert.equal(descriptionOf(ws, `change_id(${rest})`), 'fifth\n');
  assert.equal(lastMessage(), 'Rebased 1 descendant commits.', "jj's first line: @ moved onto the rest");
  F = rest;
});

test('S in Visual state splits every file of the selected lines; a rename takes its old name with it; every file, a stale file and an immutable change are refused', async () => {
  await showChange(F);
  const i = onLine('new file   -lead.txt'), k = lines().indexOf('new file   a b.txt');
  assert.ok(k > i, E.current.text);
  await keys('V');
  for (let j = i; j < k; j++) await keys('j');
  const n = proc.calls.length;
  await keys('S');
  await messageBuffer('*jj-split: ws*');
  assert.match(E.current.text, /^fifth\n\nJJ: Splitting -lead\.txt, a b\.txt off /);
  await finish('lead and space\n', 'jj-change-mode');
  assert.deepEqual(ops(n, 'split'), [['split', '-r', `change_id(${F})`, '--message=lead and space\n', '--', 'root-file:"-lead.txt"', 'root-file:"a b.txt"']]);
  assert.deepEqual(filesOf(ws, `change_id(${F})`), ['-lead.txt', 'a b.txt']);
  const rest = changeOf(ws, `change_id(${F})+`);
  assert.deepEqual(filesOf(ws, `change_id(${rest})`), ['keep.txt', 'moved.txt']);
  /* the rename: both its names go */
  await showChange(rest);
  onLine('renamed    c.txt -> moved.txt');
  let m = proc.calls.length;
  await keys('S');
  await messageBuffer('*jj-split: ws*');
  await finish('moved\n', 'jj-change-mode');
  assert.deepEqual(ops(m, 'split'), [['split', '-r', `change_id(${rest})`, '--message=moved\n', '--', 'root-file:"moved.txt"', 'root-file:"c.txt"']]);
  assert.deepEqual(filesOf(ws, `change_id(${rest})`), ['moved.txt'], 'the rename split off whole');
  const last = changeOf(ws, `change_id(${rest})+`);
  assert.deepEqual(filesOf(ws, `change_id(${last})`), ['keep.txt']);
  /* every file picked: refused before anything is written */
  await showChange(last);
  onLine('new file   keep.txt');
  m = proc.calls.length;
  await keys('S');
  assert.equal(lastMessage(), `Every file of ${shortOf(ws, `change_id(${last})`)} fifth is picked: nothing would be left`);
  assert.equal(E.current.mode, 'jj-change-mode', 'no message buffer');
  /* a file the change no longer changes: refused, g r asked for */
  write(path.join(ws, 'other.txt'), 'x\n');
  jj(ws, 'squash', '--into', `change_id(${last})`);
  jj(ws, 'restore', '--into', `change_id(${last})`, '--from', `change_id(${last})-`, 'keep.txt');
  onLine('new file   keep.txt');
  await keys('S');
  assert.equal(lastMessage(), `keep.txt is not changed in ${shortOf(ws, `change_id(${last})`)} fifth now: g r, then pick again`);
  assert.deepEqual(ops(m, 'split'), []);
  /* the immutable first change */
  await showChange(A);
  onLine('new file   a.txt');
  await keys('S');
  assert.equal(lastMessage(), `${shortOf(ws, `change_id(${A})`)} first is immutable: jj does not split it`);
  assert.deepEqual(ops(m, 'split'), []);
  /* in the log: S is said to be the change view's */
  await openLog();
  await keys('M-x'); await ed.type('jj-split\n'); await Ed.whenIdle();
  assert.equal(lastMessage(), 'S splits from the change view: RET on a change, then S on its files');
});

test('S offers the save before checking the files: a saved file snapshotted into @ changes what the change has, and every file picked is refused', async () => {
  /* a workspace of its own: m.txt committed, @ changes m.txt and adds k.txt */
  const w = mkdir('save');
  jj(w, 'git', 'init');
  write(path.join(w, 'm.txt'), 'm\n');
  jj(w, 'describe', '-m', 'one');
  jj(w, 'new', '-m', 'two');
  write(path.join(w, 'm.txt'), 'm2\n'); write(path.join(w, 'k.txt'), 'k\n');
  jj(w, 'status');
  const at = changeOf(w, '@');
  assert.deepEqual(filesOf(w, '@'), ['k.txt', 'm.txt']);
  /* a buffer visiting m.txt holds the committed text again, unsaved */
  const m = from(path.join(w, 'm.txt'));
  m.text = 'm\n'; m.modified = true;
  from(path.join(w, 'k.txt')); await keys('SPC g J');
  onChange(at); await keys('RET');
  assert.equal(E.current.mode, 'jj-change-mode');
  onLine('new file   k.txt');
  const n = proc.calls.length;
  await keys('S');
  assert.equal(E.prompt, 'Save m.txt before jj split? (y or n) ');
  await keys('y');
  assert.equal(fs.readFileSync(path.join(w, 'm.txt'), 'utf8'), 'm\n', 'saved');
  assert.equal(lastMessage(), `Every file of ${shortOf(w, '@')} two is picked: nothing would be left`);
  assert.equal(E.current.mode, 'jj-change-mode', 'no message buffer');
  assert.deepEqual(ops(n, 'split'), []);
  assert.deepEqual(filesOf(w, '@'), ['k.txt'], 'the snapshot of the save is the change now');
  assert.equal(changeOf(w, '@'), at, 'no child made');
  m.modified = false;
  L('kill-buffer', m);
});

test('under the image\'s replay none of them starts anything', async () => {
  await openLog();
  onChange(B);
  const m = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { for (const c of ['jj-rebase', 'jj-split', 'jj-undo', 'jj-redo']) { try { ps.push(Promise.resolve(L(c))); } catch (e) { ps.push(Promise.reject(e)); } } });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, m, 'no child started');
});
