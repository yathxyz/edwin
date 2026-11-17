// Merge, cherry-pick, revert and rebase from git's status and log buffers (src/vc-git.ts: m, A, _ and r) in the
// headless runtime, with real git from PATH through Ed.proc over fake-proc.mts's host.proc, in throwaway
// repositories under a throwaway HOME; host.files is node:fs, as host-native.ts has it. Each operation is taken
// through a conflict to its end and to its abort, the status buffer's header compared at every step, and the
// history, the index and the work tree with what git must leave. One Edwin per process, so the cases run in order.
// Run: node --test test/vc-sequencer.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-sequencer-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's is read; fixed dates. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'EDITOR', 'VISUAL']) delete process.env[k];
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
const rev = (cwd: string, r: string) => git(cwd, 'rev-parse', '--verify', '--quiet', r).trim();
const short = (cwd: string, r: string) => git(cwd, 'rev-parse', '--short', r).trim();
const subjects = (cwd: string, n: number) => git(cwd, 'log', '--format=%s', '-' + n).split('\n').filter(l => l);
const messageOf = (cwd: string, r: string) => git(cwd, 'log', '-1', '--format=%B', r);
const porcelain = (cwd: string) => git(cwd, 'status', '--porcelain').split('\n').filter(l => l);
const headName = (cwd: string) => git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').trim();
const gitPath = (cwd: string, p: string) => path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', p).trim());

const visit = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-sequencer test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
/* Wait, up to 20 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}\n${lastMessage()}\n${E.current.text.slice(-2000)}`);
  await Ed.whenIdle();
};
/* The minibuffer's prompt once it asks, and a y-or-n question's. */
const asked = async (p: string) => { await until(() => (E.mini && E.mini.prompt) === p, `the prompt ${JSON.stringify(p)} (now ${JSON.stringify(E.mini && E.mini.prompt)})`); };
const question = async (p: string) => { await until(() => E.prompt === p + ' (y or n) ', `the question ${JSON.stringify(p)} (now ${JSON.stringify(E.prompt)})`); };
/* The command done: a message said since MARK that is not the one it starts with, every child ended. */
const marked = () => Ed.getBuffer('*Messages*').text.length;
const done = async (mark: number) => {
  await until(() => { const t: string = Ed.getBuffer('*Messages*').text.slice(mark); return /\n?[^\n]*[^…\n)]\)?\n?$/.test(t) && t.trim() !== '' && !/… \(see \*vc-process\*\)\n?$/.test(t) && !proc.running().length; }, 'the command\'s message');
};
/* Answer the minibuffer with TEXT, then wait for the command to end. */
const answer = async (text: string) => { await ed.type(text + '\n'); await Ed.whenIdle(); };
/* git's writes run since call N (every subcommand but the reads these commands make). */
const READS = new Set(['status', 'diff', 'log', 'config', 'rev-parse', 'for-each-ref', 'symbolic-ref', 'rev-list']);
const writes = (n: number) => proc.calls.slice(n).map(c => c.argv).filter(a => a[0] === 'git').map(a => a.find((x, i) => i > 0 && !x.startsWith('-') && a[i - 1] !== '-c')!).filter(s => !READS.has(s));
const callOf = (sub: string) => proc.calls.filter(x => x.argv.includes(sub)).at(-1)!;
const argvOf = (sub: string) => { const c = callOf(sub).argv; return c.slice(c.indexOf(sub)); };
/* The header's line for what is in progress (none: null), and the todo section's lines. */
/* The status header, whole: the lines above its first blank one. TOP: what it must be, from git's own reading of
   DIR (its branch, else its commit's hash, and the subject), then UP (an upstream line) and the line SEQ. */
const header = () => lines().slice(0, lines().indexOf(''));
const top = (seq: string | null, up: string[] = [], dir = work) =>
  [`Head:     ${headName(dir) || short(dir, 'HEAD')} ${subjects(dir, 1)[0]}`, ...up, ...(seq === null ? [] : [seq])];
const todoLines = () => { const ls = lines(), k = ls.findIndex(l => /^To (cherry-pick|revert|rebase) \(\d+\)$/.test(l)); return k < 0 ? null : ls.slice(k, ls.indexOf('', k)); };

/* ---------- the fixture ---------- */
/* main: first (a.txt, c.txt), second (a.txt a2); other, from first: `on other` (a.txt), `d on other` (d.txt);
   topic, from first: t1 and t2, each changing a.txt. */
const work = mkdir('work');
git(work, 'init', '-q', '-b', 'main');
write(path.join(work, 'a.txt'), 'a\n');
write(path.join(work, 'c.txt'), 'c\n');
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'first');
git(work, 'branch', 'other'); git(work, 'branch', 'topic');
write(path.join(work, 'a.txt'), 'a2\n');
git(work, 'commit', '-q', '-am', 'second');
git(work, 'switch', '-q', 'other');
write(path.join(work, 'a.txt'), 'other\n'); git(work, 'commit', '-q', '-am', 'on other');
write(path.join(work, 'd.txt'), 'd\n'); git(work, 'add', 'd.txt'); git(work, 'commit', '-q', '-m', 'd on other');
git(work, 'switch', '-q', 'topic');
write(path.join(work, 'a.txt'), 't1\n'); git(work, 'commit', '-q', '-am', 't1');
write(path.join(work, 'a.txt'), 't2\n'); git(work, 'commit', '-q', '-am', 't2');
git(work, 'switch', '-q', 'main');
const SECOND = rev(work, 'main'), TOPIC = rev(work, 'topic');
const status = async (dir = work) => { visit(path.join(dir, 'a.txt')); await keys('SPC g g'); assert.equal(E.current.mode, 'git-status-mode'); goTo(lines()[0]); };
/* Stage FILE's resolution TEXT with s on its line in the status buffer. */
const resolve = async (file: string, text: string, dir = work) => {
  write(path.join(dir, file), text);
  await keys('g r');
  goTo(`both modified ${file}`);
  await keys('s');
  await until(() => !proc.running().length, 'the stage');
};
const marker = (ours: string, theirs: string, label: string) => `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> ${label}\n`;
/* Back to main at second, nothing in progress (anything a failed case left aborted). */
const reset = () => { for (const op of ['merge', 'cherry-pick', 'revert', 'rebase']) git(work, op, '--abort'); git(work, 'switch', '-q', '-f', 'main'); git(work, 'reset', '-q', '--hard', SECOND); git(work, 'clean', '-fdq'); };

test('m m merges a branch through a conflict: the header at every step, m m refused while the conflict is left, then the merge committed with git\'s message', async () => {
  await status();
  assert.deepEqual(header(), top(null));
  const n = proc.calls.length;
  let m = marked();
  await keys('m m');
  await asked('Merge into main: ');
  await answer('other');
  await done(m);
  const OTHER = short(work, 'other');
  assert.equal(lastMessage(), `The merge of ${OTHER} d on other stopped with conflicts in a.txt: resolve them and stage them (s), then m m commits the merge, m a aborts it`);
  assert.deepEqual(argvOf('merge'), ['merge', '--no-edit', '--end-of-options', 'other']);
  assert.ok(!callOf('merge').argv.includes('core.hooksPath=/dev/null'), 'merge keeps the hooks');
  assert.deepEqual(writes(n), ['merge']);
  assert.deepEqual(header(), top(`Merging ${OTHER} d on other`));
  assert.ok(lines().includes('Unmerged paths (1)'));
  /* refused while the conflict is left: nothing run */
  m = marked();
  const k = proc.calls.length;
  await keys('m m');
  await done(m);
  assert.equal(lastMessage(), 'a.txt is still in conflict: resolve it and stage it (s) first');
  assert.deepEqual(writes(k), []);
  await resolve('a.txt', 'merged\n');
  assert.deepEqual(header(), top(`Merging ${OTHER} d on other`), 'still merging once the resolution is staged');
  assert.ok(!lines().includes('Unmerged paths (1)'));
  m = marked();
  await keys('m m');
  await done(m);
  assert.equal(lastMessage(), `Merge done: main at ${short(work, 'HEAD')} Merge branch 'other'`);
  assert.deepEqual(argvOf('merge'), ['merge', '--continue']);
  assert.equal(callOf('merge').opts.env!.GIT_EDITOR, ':', 'git\'s prepared message taken as it is');
  assert.equal(messageOf(work, 'HEAD'), "Merge branch 'other'\n\n", 'no # Conflicts lines');
  assert.equal(rev(work, 'HEAD^1'), SECOND);
  assert.equal(rev(work, 'HEAD^2'), rev(work, 'other'));
  assert.equal(read(path.join(work, 'a.txt')), 'merged\n');
  assert.deepEqual(header(), top(null), 'the header says nothing is in progress');
  assert.match(lines()[0], /^Head: {5}main Merge branch 'other'$/);
  /* a status read meanwhile runs with git's editor false, as every child but the sequencer's going on */
  assert.equal(callOf('status').opts.env!.GIT_EDITOR, 'false');
});

test('m a aborts a merge after asking: n leaves it, y puts the index and the work tree back', async () => {
  reset();
  await status();
  let m = marked();
  await keys('m m');
  await asked('Merge into main: ');
  await answer('other');
  await done(m);
  const OTHER = short(work, 'other');
  assert.deepEqual(header(), top(`Merging ${OTHER} d on other`));
  write(path.join(work, 'a.txt'), 'half resolved\n');
  m = marked();
  await keys('m a');
  await question(`Abort the merge of ${OTHER} d on other, putting the index and the work tree back as HEAD has them (your resolutions discarded)?`);
  await keys('n');
  await done(m);
  assert.equal(lastMessage(), 'Nothing done: the merge is where it was');
  assert.ok(fs.existsSync(gitPath(work, 'MERGE_HEAD')));
  m = marked();
  await keys('m a');
  await question(`Abort the merge of ${OTHER} d on other, putting the index and the work tree back as HEAD has them (your resolutions discarded)?`);
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Merge aborted: main at ${short(work, 'HEAD')} second`);
  assert.deepEqual(argvOf('merge'), ['merge', '--abort']);
  assert.equal(rev(work, 'HEAD'), SECOND);
  assert.equal(read(path.join(work, 'a.txt')), 'a2\n');
  assert.deepEqual(porcelain(work), []);
  assert.deepEqual(header(), top(null));
  /* a merge with nothing to merge says so */
  m = marked();
  await keys('m m');
  await asked('Merge into main: ');
  await answer('main~1');
  await done(m);
  assert.equal(lastMessage(), `main already has ${short(work, 'main~1')} first: nothing merged`);
  assert.deepEqual(argvOf('merge'), ['merge', '--no-edit', '--end-of-options', rev(work, 'main~1')], 'a revision given as its hash');
});

test('A A cherry-picks a range through a conflict: the header and the todo at every step, then A A goes on with the rest', async () => {
  reset();
  await status();
  const ON = short(work, 'other~1'), D = short(work, 'other');
  let m = marked();
  await keys('A A');
  await asked(`Cherry-pick commit or range A..B (${short(work, 'HEAD')}): `);
  await answer('main..other');
  await done(m);
  assert.equal(lastMessage(), `Cherry-picking stopped at ${ON} on other with conflicts in a.txt: resolve them and stage them (s), then A A goes on, A s skips the commit, A a aborts`);
  assert.deepEqual(argvOf('cherry-pick'), ['cherry-pick', '--no-edit', '--end-of-options', `${SECOND}..${rev(work, 'other')}`]);
  assert.deepEqual(header(), top(`Cherry-picking ${ON} on other`));
  assert.deepEqual(todoLines(), ['To cherry-pick (1)', `pick ${D} d on other`]);
  await resolve('a.txt', 'picked\n');
  assert.deepEqual(header(), top(`Cherry-picking ${ON} on other`));
  assert.deepEqual(todoLines(), ['To cherry-pick (1)', `pick ${D} d on other`]);
  m = marked();
  await keys('A A');
  await done(m);
  assert.equal(lastMessage(), `Cherry-pick done: main at ${short(work, 'HEAD')} d on other`);
  assert.deepEqual(argvOf('cherry-pick'), ['cherry-pick', '--continue']);
  assert.equal(callOf('cherry-pick').opts.env!.GIT_EDITOR, ':');
  assert.deepEqual(subjects(work, 3), ['d on other', 'on other', 'second']);
  assert.equal(messageOf(work, 'HEAD~1'), 'on other\n\n', 'no # Conflicts lines');
  assert.equal(read(path.join(work, 'a.txt')), 'picked\n');
  assert.equal(read(path.join(work, 'd.txt')), 'd\n');
  assert.deepEqual(header(), top(null));
  assert.equal(todoLines(), null);
});

test('A s skips the commit a cherry-pick stopped at, after asking; A a aborts a single pick', async () => {
  reset();
  await status();
  const ON = short(work, 'other~1');
  let m = marked();
  await keys('A A');
  await asked(`Cherry-pick commit or range A..B (${short(work, 'HEAD')}): `);
  await answer('main..other');
  await done(m);
  assert.deepEqual(header(), top(`Cherry-picking ${ON} on other`));
  m = marked();
  await keys('A s');
  await question(`Skip ${ON} on other, leaving it out of the cherry-pick (its changes here and your resolution of them discarded)?`);
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Cherry-pick done: main at ${short(work, 'HEAD')} d on other`);
  assert.deepEqual(argvOf('cherry-pick'), ['cherry-pick', '--skip']);
  assert.deepEqual(subjects(work, 2), ['d on other', 'second']);
  assert.equal(read(path.join(work, 'a.txt')), 'a2\n');
  assert.deepEqual(header(), top(null));
  reset();
  await keys('g r');
  m = marked();
  await keys('A A');
  await asked(`Cherry-pick commit or range A..B (${short(work, 'HEAD')}): `);
  await answer('other~1');
  await done(m);
  assert.equal(lastMessage(), `Cherry-picking stopped at ${ON} on other with conflicts in a.txt: resolve them and stage them (s), then A A goes on, A s skips the commit, A a aborts`);
  assert.deepEqual(header(), top(`Cherry-picking ${ON} on other`));
  assert.equal(todoLines(), null, 'a single pick has no todo');
  m = marked();
  await keys('A a');
  await question('Abort the cherry-pick, putting HEAD back where it was before it (the commits it made and your resolutions discarded)?');
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Cherry-pick aborted: main at ${short(work, 'HEAD')} second`);
  assert.equal(rev(work, 'HEAD'), SECOND);
  assert.deepEqual(porcelain(work), []);
  assert.deepEqual(header(), top(null));
});

test('_ _ reverts a commit through a conflict and goes on; _ a aborts one; in the log, the commits selected are reverted newest first', async () => {
  reset();
  write(path.join(work, 'a.txt'), 'a3\n'); git(work, 'commit', '-q', '-am', 'third');
  await status();
  const S2 = short(work, 'main~1');
  let m = marked();
  await keys('_ _');
  await asked(`Revert commit or range A..B (${short(work, 'HEAD')}): `);
  await answer('main~1');
  await done(m);
  assert.equal(lastMessage(), `Reverting stopped at ${S2} second with conflicts in a.txt: resolve them and stage them (s), then _ _ goes on, _ s skips the commit, _ a aborts`);
  assert.deepEqual(argvOf('revert'), ['revert', '--no-edit', '--end-of-options', SECOND]);
  assert.deepEqual(header(), top(`Reverting ${S2} second`));
  await resolve('a.txt', 'a\n');
  assert.deepEqual(header(), top(`Reverting ${S2} second`));
  m = marked();
  await keys('_ _');
  await done(m);
  assert.equal(lastMessage(), `Revert done: main at ${short(work, 'HEAD')} Revert "second"`);
  assert.deepEqual(argvOf('revert'), ['revert', '--continue']);
  assert.equal(messageOf(work, 'HEAD'), `Revert "second"\n\nThis reverts commit ${SECOND}.\n\n`, 'no # Conflicts lines');
  assert.deepEqual(header(), top(null));
  /* abort */
  git(work, 'reset', '-q', '--hard', 'HEAD~1');
  await keys('g r');
  m = marked();
  await keys('_ _');
  await asked(`Revert commit or range A..B (${short(work, 'HEAD')}): `);
  await answer('main~1');
  await done(m);
  assert.deepEqual(header(), top(`Reverting ${S2} second`));
  m = marked();
  await keys('_ a');
  await question('Abort the revert, putting HEAD back where it was before it (the commits it made and your resolutions discarded)?');
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Revert aborted: main at ${short(work, 'HEAD')} third`);
  assert.equal(read(path.join(work, 'a.txt')), 'a3\n');
  assert.deepEqual(header(), top(null));
  /* two commits selected in the log, reverted newest first */
  await keys('l l');
  await until(() => E.current.mode === 'git-log-mode' && lines().some(l => l.startsWith(S2 + ' ')) && !proc.running().length, 'the log');
  goTo(lines().find(l => l.startsWith(short(work, 'HEAD') + ' '))!);
  await keys('V j');
  m = marked();
  await keys('_ _');
  await done(m);
  assert.equal(lastMessage(), `Reverted 2 commits: main at ${short(work, 'HEAD')} Revert "second"`);
  assert.deepEqual(argvOf('revert'), ['revert', '--no-edit', '--end-of-options', rev(work, 'HEAD~2'), SECOND]);
  assert.deepEqual(subjects(work, 4), ['Revert "second"', 'Revert "third"', 'third', 'second']);
  assert.equal(read(path.join(work, 'a.txt')), 'a\n');
  await keys('q');
});

test('r e rebases a branch through two conflicts: the header and the todo at every step, r r refused while a conflict is left and asking over a staged conflict marker', async () => {
  reset();
  git(work, 'switch', '-q', 'topic');
  await status();
  const T1 = short(work, 'topic~1'), T2 = short(work, 'topic'), S2 = short(work, 'main');
  let m = marked();
  await keys('r e');
  await asked('Rebase topic onto: ');
  await answer('main');
  await done(m);
  assert.equal(lastMessage(), `Rebasing stopped at ${T1} t1 (1 of 2) with conflicts in a.txt: resolve them and stage them (s), then r r goes on, r s skips the commit, r a aborts`);
  assert.deepEqual(argvOf('rebase'), ['rebase', '--end-of-options', 'main']);
  assert.ok(!callOf('rebase').argv.includes('core.hooksPath=/dev/null'), 'rebase keeps the hooks');
  assert.deepEqual(header(), top(`Rebasing topic onto ${S2} second, stopped at ${T1} t1 (1 of 2)`));
  assert.deepEqual(todoLines(), ['To rebase (1)', `pick ${T2} t2`]);
  /* the other operations' keys are refused while the rebase is in progress */
  for (const [k, said] of [['A A', 'A rebase is in progress: r r goes on, r s skips the commit, r a aborts'],
    ['A s', 'No cherry-pick in progress: a rebase is (r r goes on, r s skips the commit, r a aborts)'],
    ['m m', 'A rebase is in progress: r r goes on, r s skips the commit, r a aborts'],
    ['r u', 'A rebase is in progress: r r goes on, r s skips the commit, r a aborts'],
    ['r r', 'a.txt is still in conflict: resolve it and stage it (s) first']]) {
    const n = proc.calls.length;
    m = marked();
    await keys(k);
    await done(m);
    assert.equal(lastMessage(), said);
    assert.deepEqual(writes(n), [], `nothing run by ${k}`);
  }
  await resolve('a.txt', 'r1\n');
  assert.deepEqual(header(), top(`Rebasing topic onto ${S2} second, stopped at ${T1} t1 (1 of 2)`));
  m = marked();
  await keys('r r');
  await done(m);
  assert.equal(lastMessage(), `Rebasing stopped at ${T2} t2 (2 of 2) with conflicts in a.txt: resolve them and stage them (s), then r r goes on, r s skips the commit, r a aborts`);
  assert.deepEqual(argvOf('rebase'), ['rebase', '--continue']);
  assert.equal(callOf('rebase').opts.env!.GIT_EDITOR, ':');
  assert.deepEqual(header(), top(`Rebasing topic onto ${S2} second, stopped at ${T2} t2 (2 of 2)`));
  assert.equal(todoLines(), null);
  /* a resolution staged with its markers still in: asked, n changes nothing */
  await resolve('a.txt', marker('r1\n', 't2\n', 'T2'));
  const n = proc.calls.length;
  m = marked();
  await keys('r r');
  await question('a.txt still holds a conflict marker: go on with the rebase, committing it as staged?');
  await keys('n');
  await done(m);
  assert.equal(lastMessage(), 'Nothing done: the rebase is where it was');
  assert.deepEqual(writes(n), []);
  write(path.join(work, 'a.txt'), 'r2\n');
  await keys('g r');
  goTo('modified   a.txt…');
  await keys('s');
  await until(() => !proc.running().length, 'the stage');
  m = marked();
  await keys('r r');
  await done(m);
  assert.equal(lastMessage(), `Rebase done: topic at ${short(work, 'HEAD')} t2`);
  assert.equal(headName(work), 'topic');
  assert.equal(rev(work, 'topic~2'), SECOND);
  assert.deepEqual(subjects(work, 3), ['t2', 't1', 'second']);
  assert.equal(messageOf(work, 'topic~1'), 't1\n\n', 'no # Conflicts lines');
  assert.equal(git(work, 'show', 'topic~1:a.txt'), 'r1\n');
  assert.equal(read(path.join(work, 'a.txt')), 'r2\n');
  assert.deepEqual(header(), top(null));
  assert.match(lines()[0], /^Head: {5}topic t2$/);
});

test('r u rebases onto the upstream; r s skips a commit after asking; r a aborts, the branch back where it was', async () => {
  reset();
  git(work, 'branch', '-q', '-f', 'topic', TOPIC);
  git(work, 'switch', '-q', 'topic');
  git(work, 'branch', '-q', '--set-upstream-to=main', 'topic');
  await status();
  const T1 = short(work, 'topic~1'), T2 = short(work, 'topic'), S2 = short(work, 'main');
  let m = marked();
  await keys('r u');
  await done(m);
  assert.deepEqual(argvOf('rebase'), ['rebase', '--end-of-options', 'refs/heads/main']);
  assert.deepEqual(header(), top(`Rebasing topic onto ${S2} second, stopped at ${T1} t1 (1 of 2)`));
  m = marked();
  await keys('r s');
  await question(`Skip ${T1} t1, leaving it out of the rebase (its changes here and your resolution of them discarded)?`);
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Rebasing stopped at ${T2} t2 (2 of 2) with conflicts in a.txt: resolve them and stage them (s), then r r goes on, r s skips the commit, r a aborts`);
  assert.deepEqual(argvOf('rebase'), ['rebase', '--skip']);
  assert.deepEqual(header(), top(`Rebasing topic onto ${S2} second, stopped at ${T2} t2 (2 of 2)`));
  m = marked();
  await keys('r a');
  await question(`Abort the rebase, putting topic back at ${T2} t2 (the commits rebased so far and your resolutions discarded)?`);
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Rebase aborted: topic at ${T2} t2`);
  assert.equal(rev(work, 'topic'), TOPIC);
  assert.equal(headName(work), 'topic');
  assert.deepEqual(porcelain(work), []);
  assert.deepEqual(header(), top(null, ['Merge:    main second']));
});

test('a linked worktree: its own merge shown and aborted, the main work tree\'s status untouched', async () => {
  reset();
  const wt = path.join(root, 'wt');
  git(work, 'worktree', 'add', '-q', '-b', 'wtb', wt, SECOND);
  await status(wt);
  let m = marked();
  await keys('m m');
  await asked('Merge into wtb (main): ');
  await answer('other');
  await done(m);
  assert.match(lastMessage(), /^The merge of [0-9a-f]+ d on other stopped with conflicts in a\.txt/);
  assert.deepEqual(header(), top(`Merging ${short(work, 'other')} d on other`, [], wt));
  assert.ok(fs.existsSync(gitPath(wt, 'MERGE_HEAD')) && !fs.existsSync(path.join(work, '.git', 'MERGE_HEAD')), 'the worktree\'s own MERGE_HEAD');
  await status();
  assert.deepEqual(header(), top(null), 'the main work tree merges nothing');
  await status(wt);
  m = marked();
  await keys('m a');
  await question(`Abort the merge of ${short(work, 'other')} d on other, putting the index and the work tree back as HEAD has them (your resolutions discarded)?`);
  await keys('y');
  await done(m);
  assert.equal(lastMessage(), `Merge aborted: wtb at ${short(work, 'main')} second`);
  assert.deepEqual(header(), top(null, [], wt));
  git(work, 'worktree', 'remove', '--force', wt);
  git(work, 'branch', '-q', '-D', 'wtb');
});

test('a branch or a tag named CHERRY_PICK_HEAD, REVERT_HEAD or REBASE_HEAD is no operation in progress, in a files and a reftable repository; a real one beside it is still read', async () => {
  reset();
  const ON = short(work, 'other~1');
  git(work, 'branch', 'CHERRY_PICK_HEAD', 'other~1'); git(work, 'tag', 'REVERT_HEAD', 'other'); git(work, 'branch', 'REBASE_HEAD', 'topic');
  await status();
  assert.deepEqual(header(), top(null));
  /* the start keys start, the step keys find nothing to go on with */
  const n = proc.calls.length;
  for (const [k, p] of [['m m', 'Merge into main: '], ['A A', `Cherry-pick commit or range A..B (${short(work, 'HEAD')}): `],
    ['_ _', `Revert commit or range A..B (${short(work, 'HEAD')}): `], ['r e', 'Rebase main onto: ']]) {
    await keys(k);
    await asked(p);
    await keys('C-g');
    assert.equal(E.mini, null);
  }
  for (const [k, said] of [['A s', 'No cherry-pick in progress'], ['_ a', 'No revert in progress'], ['r s', 'No rebase in progress']]) {
    const m = marked();
    await keys(k);
    await done(m);
    assert.equal(lastMessage(), said);
  }
  assert.deepEqual(writes(n), [], 'no write ran');
  /* a real pick beside the branch of its name */
  let m = marked();
  await keys('A A');
  await asked(`Cherry-pick commit or range A..B (${short(work, 'HEAD')}): `);
  await answer('other~1');
  await done(m);
  assert.deepEqual(header(), top(`Cherry-picking ${ON} on other`));
  git(work, 'cherry-pick', '--abort');
  /* a rebase stopped between two steps (a break first in its todo): no REBASE_HEAD, whatever the branch of that name is at */
  git(work, 'switch', '-q', 'topic');
  git(work, 'branch', '-q', '-D', 'REBASE_HEAD');
  git(work, '-c', 'sequence.editor=sed -i 1ibreak', 'rebase', '-q', '-i', 'main');
  await keys('g r');
  const between = header();
  assert.match(between.at(-1)!, /^Rebasing topic onto [0-9a-f]+ second, stopped after \d+ of \d+$/);
  git(work, 'branch', 'REBASE_HEAD', 'other');
  await keys('g r');
  assert.deepEqual(header(), between);
  m = marked();
  await keys('r s');
  await question('Skip the commit it stopped at, leaving it out of the rebase (its changes here and your resolution of them discarded)?');
  await keys('n');
  await done(m);
  git(work, 'rebase', '--abort');
  for (const b of ['CHERRY_PICK_HEAD', 'REBASE_HEAD']) git(work, 'branch', '-q', '-D', b);
  git(work, 'tag', '-d', 'REVERT_HEAD');
  /* reftable: the pseudorefs are refs there */
  const rt = mkdir('reftable');
  git(rt, 'init', '-q', '--ref-format=reftable', '-b', 'main');
  write(path.join(rt, 'a.txt'), 'a\n'); git(rt, 'add', '.'); git(rt, 'commit', '-q', '-m', 'one');
  git(rt, 'switch', '-q', '-c', 'side'); write(path.join(rt, 'a.txt'), 'side\n'); git(rt, 'commit', '-q', '-am', 'on side');
  git(rt, 'switch', '-q', 'main'); write(path.join(rt, 'a.txt'), 'main\n'); git(rt, 'commit', '-q', '-am', 'on main');
  git(rt, 'branch', 'CHERRY_PICK_HEAD', 'side'); git(rt, 'tag', 'REVERT_HEAD', 'side');
  await status(rt);
  assert.deepEqual(header(), top(null, [], rt));
  git(rt, 'cherry-pick', rev(rt, 'refs/heads/side'));
  await keys('g r');
  assert.deepEqual(header(), top(`Cherry-picking ${short(rt, 'refs/heads/side')} on side`, [], rt));
  assert.equal(callOf('for-each-ref').argv.slice(-4).join(' '), '--format=%(refname)%00%(objectname) CHERRY_PICK_HEAD REVERT_HEAD REBASE_HEAD');
  git(rt, 'cherry-pick', '--abort');
  await keys('g r');
  assert.deepEqual(header(), top(null, [], rt));
});

test('a Visual selection in the status buffer picks the commits of its lists only, not the Head and Merge lines', async () => {
  reset();
  git(work, 'branch', '-q', '--set-upstream-to=other', 'main');
  await status();
  const D = short(work, 'other');
  assert.deepEqual(header(), top(null, ['Merge:    other d on other']));
  await keys('V');
  await keys(`${lineOf(`${D} d on other`) - 1} j`);
  const m = marked();
  await keys('A A');
  await done(m);
  assert.deepEqual(argvOf('cherry-pick'), ['cherry-pick', '--no-edit', '--end-of-options', rev(work, 'other')]);
  assert.equal(lastMessage(), `Cherry-picked ${D} d on other: main at ${short(work, 'HEAD')} d on other`);
  assert.deepEqual(subjects(work, 2), ['d on other', 'second']);
  git(work, 'branch', '-q', '--unset-upstream', 'main');
});

test('refused: a revision that would be a switch, a step with nothing in progress, a second command while one readies, a jj workspace, the image\'s replay', async () => {
  reset();
  await status();
  const n = proc.calls.length;
  let m = marked();
  await keys('m m');
  await asked('Merge into main: ');
  await answer('--upload-pack=touch x');
  await done(m);
  assert.equal(lastMessage(), 'Not a commit: --upload-pack=touch x');
  m = marked();
  await keys('A A');
  await asked(`Cherry-pick commit or range A..B (${short(work, 'HEAD')}): `);
  await answer('--x..main');
  await done(m);
  assert.equal(lastMessage(), 'Not a commit: --x');
  for (const [k, said] of [['r r', 'No rebase in progress'], ['r s', 'No rebase in progress'], ['A s', 'No cherry-pick in progress'], ['_ a', 'No revert in progress'], ['m a', 'No merge in progress']]) {
    m = marked();
    await keys(k);
    await done(m);
    assert.equal(lastMessage(), said);
  }
  assert.deepEqual(writes(n), [], 'no write ran');
  /* one at a time in a repository, with the remote commands */
  const first = errorOf(Promise.resolve(L('git-rebase-upstream')));
  assert.match(String(await errorOf(Promise.resolve().then(() => L('git-fetch')))), /^A merge, cherry-pick, revert or rebase still runs in .*: see \*vc-process\*$/);
  assert.equal(await first, 'main has no upstream: r e rebases it onto a revision asked for');
  /* a question quit with C-g frees the repository: r e asks again */
  for (let i = 0; i < 2; i++) {
    await keys('r e');
    await asked('Rebase main onto: ');
    await keys('C-g');
    assert.equal(E.mini, null);
  }
  const jj = mkdir('jj');
  execFileSync('jj', ['git', 'init'], { cwd: jj, stdio: 'ignore' });
  visit(path.join(jj, 'f.txt'));
  const k = proc.calls.length;
  await keys('M-x'); await ed.type('git-merge\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /is a jj workspace: jj has its own commands/);
  assert.equal(proc.calls.length, k, 'nothing ran');
  await status();
  const j = proc.calls.length, ps: Promise<unknown>[] = [];
  const cmds = ['git-merge', 'git-merge-abort', 'git-cherry-pick', 'git-cherry-pick-skip', 'git-cherry-pick-abort', 'git-revert', 'git-revert-skip', 'git-revert-abort',
    'git-rebase', 'git-rebase-upstream', 'git-rebase-continue', 'git-rebase-skip', 'git-rebase-abort'];
  Ed.proc.replay(() => { for (const c of cmds) { try { ps.push(Promise.resolve(L(c))); } catch (e) { ps.push(Promise.reject(e)); } } });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, j, 'no child started');
});
