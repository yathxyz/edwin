// jj's log and change view (src/vc-jj.ts: SPC g g in a jj workspace, SPC g J, RET, + and g r) in the headless
// runtime, with real jj from PATH (the check brings nixpkgs' jujutsu, whose template language this pins) through
// Ed.proc over fake-proc.mts's host.proc, in throwaway workspaces under a throwaway HOME whose jj config changes
// the shape of jj's own log (its template, graph style, word wrap): the log is read from Edwin's template, never
// from the graph text. host.files is node:fs, as host-native.ts has it.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-jj.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-jj-')));
const HOME = path.join(root, 'home');
/* The user's jj config: its own log template, an ASCII graph and word wrap, none of which may change what is read. */
fs.mkdirSync(path.join(HOME, '.config', 'jj'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.config', 'jj', 'config.toml'), [
  '[templates]', 'log = \'"user template " ++ change_id ++ "\\n"\'',
  '[ui]', 'graph.style = "ascii"', 'log-word-wrap = true', '',
].join('\n'));
/* The children inherit this process's environment: no config of the user's, git's or jj's, is read; fixed dates. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  JJ_USER: 'Test', JJ_EMAIL: 'test@example.invalid', JJ_TIMESTAMP: '2026-01-01T00:00:00+00:00',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'JJ_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS']) delete process.env[k];
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

/* A program run directly (not through Vc), for the fixtures and to look at the result. */
const run = (cwd: string, prog: string, args: string[], input?: string) =>
  execFileSync(prog, args, { cwd, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });
const jj = (cwd: string, ...args: string[]) => run(cwd, 'jj', ['--no-pager', '--color=never', ...args]);
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
/* What jj itself says of REV, by a template of the test's own. */
const of = (cwd: string, rev: string, template: string) => jj(cwd, 'log', '--no-graph', '--ignore-working-copy', '-r', rev, '-T', template + ' ++ "\\n"').trim();
const ids = (cwd: string, rev: string) => of(cwd, rev, 'change_id.shortest(8) ++ " " ++ commit_id.short(8)');
const commitOf = (cwd: string, rev: string) => of(cwd, rev, 'commit_id');
const changeOf = (cwd: string, rev: string) => of(cwd, rev, 'change_id');

const from = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-jj test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text.slice(0, 4000)}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
const lineAtPoint = () => { const b = E.current, n = Ed.lineNoB(b, b.pt); return lines()[n - 1]; };
const classes = (b: Edwin, n: number) => { const s = Ed.lineStartB(b, n), e = Ed.eol(b.rope, s), lx = Ed.hooks.lexSeg(b, s, e, b.rope.slice(s, e)); return [...lx.cls].map((c: number) => lx.names[c]); };
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
const jjCalls = (n: number) => proc.calls.slice(n).map(c => c.argv);
/* An argv's part after the runner's fixed switches. */
const sub = (argv: string[]) => argv.slice(argv.indexOf('ui.log-word-wrap=false') + 1);

/* ---------- the fixture ---------- */
/*  @    (empty, the merge's conflict inherited)
    ×    merge: B and S, a conflict in a.txt
    ├ B  "second": a.txt two, b.txt added
    └ S  a description with quotes, brackets and a control character
    ◆ A  "first" and a body, bookmark main, tag v1 (immutable: a tag)
    ◆ root() */
const ws = mkdir('ws');
jj(ws, 'git', 'init');
write(path.join(ws, 'a.txt'), 'one\n');
jj(ws, 'describe', '-m', 'first\n\nThe body\nof it.');
jj(ws, 'new', '-m', 'second');
jj(ws, 'bookmark', 'create', 'main', '-r', '@-');
jj(ws, 'tag', 'set', 'v1', '-r', '@-');
const A = changeOf(ws, '@-');
write(path.join(ws, 'a.txt'), 'two\n'); write(path.join(ws, 'b.txt'), 'b\nadded\n');
jj(ws, 'status');
const B = changeOf(ws, '@');
jj(ws, 'new', '-m', 'side "quoted" ]["x"]\n\u0007 not the first line', `change_id(${A})`);
write(path.join(ws, 'a.txt'), 'side\n');
jj(ws, 'status');
const S = changeOf(ws, '@');
jj(ws, 'new', '-m', 'merge', `change_id(${B})`, `change_id(${S})`);
const M = changeOf(ws, '@');
jj(ws, 'new');
const DATE = '2026-01-01';
const expectedLog = () => [
  `Changes in ${ws}`,
  `@ ${ids(ws, '@')} (conflict) (empty) (no description set)  Test ${DATE}`,
  `× ${ids(ws, `change_id(${M})`)} (conflict) (empty) merge  Test ${DATE}`,
  `○ ${ids(ws, `change_id(${S})`)} side "quoted" ]["x"]  Test ${DATE}`,
  `○ ${ids(ws, `change_id(${B})`)} second  Test ${DATE}`,
  `◆ ${ids(ws, `change_id(${A})`)} main v1 first  Test ${DATE}`,
  `◆ ${ids(ws, 'root()')} root()`,
];

test('SPC g g in a jj workspace shows its log, read from Edwin\'s template, not the graph text the user\'s config would make', async () => {
  /* the control: the user's jj log is their template on an ASCII graph */
  assert.match(jj(ws, 'log', '--ignore-working-copy'), /^@ {2}user template [k-z]{32}\n/);
  from(path.join(ws, 'a.txt'));
  const n = proc.calls.length;
  await keys('SPC g g');
  const b = E.current;
  assert.equal(b.name, '*jj-log: ws*');
  assert.equal(b.mode, 'jj-log-mode');
  assert.equal(Ed.MODE_NAMES['jj-log-mode'], 'jj Log');
  assert.ok(b.readOnly);
  assert.equal(b.text, expectedLog().join('\n') + '\n');
  /* one read: jj log with no graph and Edwin's template, every field a JSON value; no revset of Edwin's, so the
     user's revsets.log chooses the changes */
  const calls = jjCalls(n);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 7), ['jj', '--no-pager', '--color=never', '--config', 'ui.diff-formatter=:git', '--config', 'ui.log-word-wrap=false']);
  const a = sub(calls[0]);
  assert.deepEqual(a.slice(0, 4), ['log', '--no-graph', '--limit', '257']);
  assert.equal(a[4], '-T');
  assert.match(a[5], /^"\[" \+\+ json\(change_id\) \+\+ "," \+\+ json\(commit_id\)/);
  assert.equal(a.length, 6, 'no -r');
  /* the order is jj's */
  assert.deepEqual(lines().slice(1).filter(l => l).map(l => l.split(' ')[2]),
    jj(ws, 'log', '--no-graph', '--ignore-working-copy', '-T', 'commit_id.short(8) ++ "\\n"').trim().split('\n'));
  /* faces: the node, the change id's unique prefix and the rest, the commit id, bookmarks and tags, the states */
  const cls = classes(b, 6), line = lines()[5], [ch, co] = ids(ws, `change_id(${A})`).split(' ');
  const prefix = of(ws, `change_id(${A})`, 'change_id.shortest(8).prefix()');
  assert.equal(cls[0], 'git-dim');
  assert.deepEqual(new Set(cls.slice(2, 2 + prefix.length)), new Set(['git-remote']));
  assert.deepEqual(new Set(cls.slice(2 + prefix.length, 2 + ch.length)), new Set(['git-dim']));
  assert.deepEqual(new Set(cls.slice(3 + ch.length, 3 + ch.length + co.length)), new Set(['git-hash']));
  for (const ref of ['main', 'v1']) assert.deepEqual(new Set(cls.slice(line.indexOf(ref), line.indexOf(ref) + ref.length)), new Set(['git-branch']));
  assert.deepEqual(new Set(classes(b, 2).slice(lines()[1].indexOf('(conflict)'), lines()[1].indexOf('(conflict)') + 10)), new Set(['git-removed']));
  assert.equal(classes(b, 2)[0], 'git-branch', 'the working copy\'s @');
  assert.deepEqual(new Set(classes(b, 1)), new Set(['git-section']));
});

test('RET on a change shows it: its header, description and diff by file and hunk, read one after the other', async () => {
  goTo(expectedLog()[4]);
  const n = proc.calls.length;
  await keys('RET');
  const b = E.current;
  assert.equal(b.name, '*jj-change: ws*');
  assert.equal(b.mode, 'jj-change-mode');
  assert.equal(Ed.MODE_NAMES['jj-change-mode'], 'jj Change');
  const commit = commitOf(ws, `change_id(${B})`), parent = commitOf(ws, `change_id(${A})`), pch = changeOf(ws, `change_id(${A})`).slice(0, 8);
  assert.equal(b.text, [
    `Change:    ${B}`,
    `Commit:    ${commit}`,
    `Parent:    ${pch} ${parent}`,
    'Author:    Test <test@example.invalid> 2026-01-01T00:00:00+00:00',
    '',
    '    second',
    '',
    'modified   a.txt',
    '@@ -1,1 +1,1 @@',
    '-one',
    '+two',
    'new file   b.txt',
    '@@ -0,0 +1,2 @@',
    '+b',
    '+added',
    '',
  ].join('\n'));
  /* the header by the line's change id, then the diff by the commit id it read, with --ignore-working-copy: the
     header's read took the snapshot; both through revsets Edwin builds (a bookmark named like an id cannot
     stand for it) */
  const calls = jjCalls(n).map(sub);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 6), ['log', '--no-graph', '--limit', '2', '-r', `change_id(${B})`]);
  assert.deepEqual(calls[1], ['diff', '--ignore-working-copy', '--git', '-r', `commit_id(${commit})`]);
  /* faces of the header and the diff */
  assert.deepEqual(new Set(classes(b, 1).slice(11)), new Set(['git-remote']));
  assert.deepEqual(new Set(classes(b, 2).slice(11)), new Set(['git-hash']));
  assert.deepEqual(new Set(classes(b, 6)), new Set(['git-section']));
  assert.deepEqual(new Set(classes(b, 9)), new Set(['git-hunk']));
  assert.deepEqual(new Set(classes(b, 11)), new Set(['git-added']));
  /* TAB folds a file, C-j steps to the next section, RET on an added line visits the work tree's file there */
  goTo('modified   a.txt');
  await keys('TAB');
  assert.ok(lines().includes('modified   a.txt…'));
  assert.ok(!lines().includes('-one'));
  await keys('C-j');
  assert.equal(lineAtPoint(), 'new file   b.txt');
  await keys('C-j');
  assert.equal(lineAtPoint(), '@@ -0,0 +1,2 @@');
  await keys('j j');
  assert.equal(lineAtPoint(), '+added');
  await keys('RET');
  assert.equal(E.current.file, path.join(ws, 'b.txt'));
  assert.equal(Ed.lineNoB(E.current, E.current.pt), 2);
  L('switch-to-buffer', b);
  await Ed.whenIdle();
});

test('a merge: its parents, its conflict; RET on a parent shows it in the same buffer, its folds forgotten', async () => {
  L('switch-to-buffer', '*jj-log: ws*'); await Ed.whenIdle();
  goTo(expectedLog()[2]);
  await keys('RET');
  const b = E.current;
  assert.equal(b.name, '*jj-change: ws*');
  const pb = commitOf(ws, `change_id(${B})`), ps = commitOf(ws, `change_id(${S})`);
  assert.deepEqual(lines().slice(0, 9), [
    `Change:    ${M}`,
    `Commit:    ${commitOf(ws, `change_id(${M})`)}`,
    `Parents:   ${B.slice(0, 8)} ${pb}`,
    `           ${S.slice(0, 8)} ${ps}`,
    'State:     empty, conflict',
    'Author:    Test <test@example.invalid> 2026-01-01T00:00:00+00:00',
    '',
    '    merge',
    '',
  ]);
  /* RET on the second parent: the side change, whose description holds a control character, shown as ? */
  goTo(`           ${S.slice(0, 8)} ${ps}`);
  await keys('RET');
  assert.equal(E.current, b);
  assert.equal(b.pt, 0, 'another change: point at its start');
  assert.deepEqual(lines().slice(0, 9), [
    `Change:    ${S}`,
    `Commit:    ${ps}`,
    `Parent:    ${A.slice(0, 8)} ${commitOf(ws, `change_id(${A})`)}`,
    'Author:    Test <test@example.invalid> 2026-01-01T00:00:00+00:00',
    '',
    '    side "quoted" ]["x"]',
    '    ? not the first line',
    '',
    'modified   a.txt',
  ]);
  /* the immutable first change: bookmarks, tags, its state and its body */
  goTo(`Parent:    ${A.slice(0, 8)} ${commitOf(ws, `change_id(${A})`)}`);
  await keys('RET');
  assert.deepEqual(lines().slice(0, 11), [
    `Change:    ${A}`,
    `Commit:    ${commitOf(ws, `change_id(${A})`)}`,
    `Parent:    zzzzzzzz ${'0'.repeat(40)}`,
    'Bookmarks: main',
    'Tags:      v1',
    'State:     immutable',
    'Author:    Test <test@example.invalid> 2026-01-01T00:00:00+00:00',
    '',
    '    first',
    '',
    '    The body',
  ]);
  /* and the root */
  goTo(`Parent:    zzzzzzzz ${'0'.repeat(40)}`);
  await keys('RET');
  assert.deepEqual(lines(), [`Change:    ${'z'.repeat(32)}`, `Commit:    ${'0'.repeat(40)}`, 'State:     root, immutable, empty', '']);
  await keys('q');
});

test('g r reads the log again; the change view follows its change as it is rewritten', async () => {
  L('switch-to-buffer', '*jj-log: ws*'); await Ed.whenIdle();
  goTo(expectedLog()[4]);
  /* a change made outside Edwin: the log read again shows it first, point kept on its change */
  jj(ws, 'new', '-m', 'made outside');
  await keys('g r');
  assert.equal(lines()[1], `@ ${ids(ws, '@')} (conflict) (empty) made outside  Test ${DATE}`);
  assert.equal(lineAtPoint(), expectedLog()[4]);
  assert.equal(lines().filter(l => l).length, expectedLog().length + 1);
  /* SPC g g again in the workspace reads it again, in the same buffer */
  jj(ws, 'describe', '-m', 'described outside');
  from(path.join(ws, 'a.txt'));
  await keys('SPC g g');
  assert.equal(E.current.name, '*jj-log: ws*');
  assert.match(lines()[1], / described outside {2}Test /);
  /* the working copy's change: a file written, then g r in its view shows the new diff (the change id, not
     the commit id it was opened by, which the snapshot replaced) */
  goTo(lines()[1]);
  await keys('RET');
  assert.ok(!lines().includes('new file   c.txt'));
  const before = commitOf(ws, '@');
  write(path.join(ws, 'c.txt'), 'c\n');
  await keys('g r');
  assert.ok(lines().includes('new file   c.txt'), E.current.text);
  assert.notEqual(commitOf(ws, '@'), before, 'the snapshot rewrote the working copy\'s commit');
  assert.equal(lines()[1], `Commit:    ${commitOf(ws, '@')}`);
  fs.rmSync(path.join(ws, 'c.txt'));
  jj(ws, 'abandon', '@');
  await keys('q');
});

test('RET on the working copy\'s line after a file is written shows the change as the snapshot leaves it', async () => {
  L('switch-to-buffer', '*jj-log: ws*'); await Ed.whenIdle();
  await keys('g r');
  const drawn = commitOf(ws, '@');
  goTo(lines()[1]);
  assert.ok(lineAtPoint().startsWith(`@ ${ids(ws, '@')}`));
  /* the work tree changes after the log was drawn: the next jj command's snapshot rewrites @ into a new commit
     and hides the one the line was drawn from */
  write(path.join(ws, 'd.txt'), 'd\n');
  await keys('RET');
  const now = commitOf(ws, '@');
  assert.notEqual(now, drawn, 'the snapshot rewrote the working copy\'s commit');
  assert.equal(E.current.name, '*jj-change: ws*');
  assert.equal(lines()[0], `Change:    ${changeOf(ws, '@')}`);
  assert.equal(lines()[1], `Commit:    ${now}`);
  assert.ok(lines().some(l => /^State: +working copy/.test(l)), E.current.text);
  assert.ok(lines().includes('new file   d.txt'), E.current.text);
  fs.rmSync(path.join(ws, 'd.txt'));
  jj(ws, 'abandon', '@');
  await keys('q');
});

test('a diff larger than 16 MiB is not shown: a note says so', async () => {
  const big = mkdir('big');
  jj(big, 'git', 'init');
  /* 17 MiB in one file, past jj's own limit on a new file's size for this snapshot only */
  write(path.join(big, 'big.txt'), 'x'.repeat(1023).concat('\n').repeat(17 * 1024));
  jj(big, '--config', 'snapshot.max-new-file-size=100000000', 'describe', '-m', 'big');
  from(path.join(big, 'big.txt'));
  await keys('SPC g J');
  goTo(lines()[1]);
  await keys('RET');
  assert.equal(E.current.name, '*jj-change: big*');
  assert.ok(E.current.text.endsWith('\n    big\n\n(the diff is not shown: it is larger than 16 MiB)\n'), E.current.text);
  assert.ok(!lines().some(l => l.startsWith('new file')));
  await keys('q');
  L('kill-buffer', '*jj-log: big*');
});

test('a bookmark named like a change id stands for nothing: the ids Edwin gives back are inside commit_id() and change_id()', async () => {
  /* a bookmark named as B's change id, on S: jj's own `-r ID` takes the bookmark */
  jj(ws, 'bookmark', 'create', B, '-r', `change_id(${S})`);
  assert.equal(of(ws, B, 'change_id'), S, 'the control: a bare id is the bookmark');
  L('switch-to-buffer', '*jj-log: ws*'); await Ed.whenIdle();
  await keys('g r');
  const line = lines().find(l => l.startsWith(`○ ${ids(ws, `change_id(${B})`)} second`))!;
  goTo(line);
  await keys('RET');
  assert.equal(lines()[0], `Change:    ${B}`);
  await keys('g r');
  assert.equal(lines()[0], `Change:    ${B}`, 'read again by change_id(), still B');
  jj(ws, 'bookmark', 'delete', B);
  await keys('q');
});

test('+ reads more changes, the log read again with a larger limit; at the end it says so', async () => {
  /* 300 commits on a branch of the colocated git repository, which jj imports */
  const long = mkdir('long');
  jj(long, 'git', 'init');
  const parts: string[] = [];
  const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  for (let i = 1; i <= 300; i++)
    parts.push(`commit refs/heads/long\nmark :${i}\nauthor Test <test@example.invalid> 1767225600 +0000\ncommitter Test <test@example.invalid> 1767225600 +0000\n`
      + data(`change ${i}\n`) + (i > 1 ? `from :${i - 1}\n` : '') + 'M 100644 inline n.txt\n' + data(`${i}\n`));
  run(long, 'git', ['fast-import', '--quiet'], parts.join(''));
  const all = jj(long, 'log', '--no-graph', '-T', 'commit_id.short(8) ++ "\\n"').trim().split('\n');
  assert.equal(all.length, 302, '300, the working copy\'s and the root');
  from(path.join(long, 'n.txt'));
  await keys('SPC g J');
  assert.equal(E.current.name, '*jj-log: long*');
  const shownIds = () => lines().slice(1).filter(l => /^[@○◆×] /.test(l)).map(l => l.split(' ')[2]);
  assert.deepEqual(shownIds(), all.slice(0, 256));
  assert.equal(lines().filter(l => l).at(-1), '(more: + or RET here reads the next 256)');
  /* a + whose read fails keeps the limit it had: g r then asks for the same */
  const cfg = path.join(HOME, '.config', 'jj', 'config.toml'), was = fs.readFileSync(cfg, 'utf8');
  fs.writeFileSync(cfg, was + '[template-aliases]\nempty = \'"not a boolean"\'\n');
  try {
    await keys('+');
    assert.equal(lastMessage(), 'process-error: jj log printed what Edwin cannot read (see *vc-process*)');
  } finally { fs.writeFileSync(cfg, was); }
  const k = proc.calls.length;
  await keys('g r');
  assert.deepEqual(sub(proc.calls[k].argv).slice(0, 4), ['log', '--no-graph', '--limit', '257']);
  assert.deepEqual(shownIds(), all.slice(0, 256));
  const n = proc.calls.length;
  await keys('+');
  assert.deepEqual(sub(proc.calls[n].argv).slice(0, 4), ['log', '--no-graph', '--limit', '513']);
  assert.deepEqual(shownIds(), all);
  assert.ok(!lines().some(l => l.startsWith('(more')));
  await keys('+');
  assert.equal(lastMessage(), 'No more changes');
  /* RET on the more line reads more too */
  L('kill-buffer', '*jj-log: long*');
  from(path.join(long, 'n.txt'));
  await keys('SPC g J');
  goTo(lines().filter(l => l).at(-1)!);
  await keys('RET');
  assert.deepEqual(shownIds(), all);
  await keys('q');
});

test('refused: outside a jj workspace; git\'s commands in a jj buffer; under the image\'s replay nothing starts', async () => {
  const plain = mkdir('plain');
  from(path.join(plain, 'f.txt'));
  const n = proc.calls.length;
  await keys('SPC g J');
  assert.equal(lastMessage(), `Not in a jj workspace: ${plain}`);
  const gitOnly = mkdir('git-only');
  run(gitOnly, 'git', ['init', '-q']);
  from(path.join(gitOnly, 'f.txt'));
  await keys('SPC g J');
  assert.equal(lastMessage(), `Not in a jj workspace: ${gitOnly}`);
  assert.equal(proc.calls.length, n, 'nothing ran');
  /* git's log and commit from a jj buffer: the jj workspace refused, no git run with jj's repository */
  from(path.join(ws, 'a.txt'));
  await keys('SPC g g');
  const k = proc.calls.length;
  await keys('M-x'); await ed.type('git-log\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /is a jj workspace: use jj log/);
  await keys('M-x'); await ed.type('git-commit\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /is a jj workspace: describe its change with jj/);
  assert.equal(proc.calls.length, k, 'nothing ran');
  /* SPC g G there is git's status of the colocated repository */
  await keys('SPC g G');
  assert.equal(E.current.mode, 'git-status-mode');
  /* the image's replay: jj-log, jj-log-more and RET on a change start nothing */
  L('switch-to-buffer', '*jj-log: ws*'); await Ed.whenIdle();
  goTo(lines()[1]);
  const m = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { for (const c of ['jj-log', 'jj-log-more', 'git-status-visit', 'git-status-refresh']) { try { ps.push(Promise.resolve(L(c))); } catch (e) { ps.push(Promise.reject(e)); } } });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, m, 'no child started');
  /* the desktop-only stub is gone; SPC g J names jj-log */
  assert.equal(ed.eval("(bound? 'vile-majutsu-status)"), false);
  assert.equal(ed.L.call('lookup-key', [ed.L.get('evil-normal-state-map'), 'SPC g J']).name, 'jj-log');
});

test('a log line jj prints that is not the template\'s shape is refused whole, not half read', async () => {
  /* a user template alias that shadows a field the template uses gives a line of another shape */
  const cfg = path.join(HOME, '.config', 'jj', 'config.toml'), was = fs.readFileSync(cfg, 'utf8');
  fs.writeFileSync(cfg, was + '[template-aliases]\nempty = \'"not a boolean"\'\n');
  try {
    L('switch-to-buffer', '*jj-log: ws*'); await Ed.whenIdle();
    const text = E.current.text;
    await keys('g r');
    assert.equal(lastMessage(), 'process-error: jj log printed what Edwin cannot read (see *vc-process*)');
    assert.equal(E.current.text, text, 'the buffer keeps what it showed');
  } finally { fs.writeFileSync(cfg, was); }
});
