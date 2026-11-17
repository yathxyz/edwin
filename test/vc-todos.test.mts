// The TODO section of git's status buffer (src/vc-git.ts) in the headless runtime, with real git from PATH through
// Ed.proc over fake-proc.mts's host.proc, in throwaway repositories under a throwaway HOME; host.files is node:fs,
// as host-native.ts has it. A fixture repository whose tracked files hold TODO and FIXME lines (and lines that only
// look like them, in tracked, untracked, ignored and binary files and in a submodule) is shown by SPC g g, under a
// repository configuration that would change git grep's output or have it run a program.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-todos.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-todos-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's is read. */
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

/* git run directly (not through Vc), for the fixtures: a failure throws. */
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const commitAll = (cwd: string, msg: string) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); };

/* A buffer as if visiting FILE (its directory is where SPC g g looks), shown in the selected window. */
const from = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-todos test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
const classes = (b: Edwin, n: number) => { const s = Ed.lineStartB(b, n), e = Ed.eol(b.rope, s), lx = Ed.hooks.lexSeg(b, s, e, b.rope.slice(s, e)); return [...lx.cls].map((c: number) => lx.names[c]); };
/* the TODO section's lines: from its heading to the buffer's end */
const todoLines = () => { const l = lines(), k = l.findIndex(x => x.startsWith('TODOs (')); return k < 0 ? [] : l.slice(k).filter(x => x !== ''); };
const greps = (n: number) => proc.calls.slice(n).filter(c => c.argv.includes('grep'));

/* ---------- the fixture ---------- */
/* a repository a submodule is cloned from, its own file holding a TODO */
const subSrc = mkdir('sub-src');
git(subSrc, 'init', '-q', '-b', 'main');
write(path.join(subSrc, 's.txt'), 'TODO: in the submodule\n');
commitAll(subSrc, 'sub');

const work = mkdir('work');
git(work, 'init', '-q', '-b', 'main');
const long = 'x'.repeat(250);
write(path.join(work, 'a.c'), [
  'int x; // TODO: tidy this',
  '// FIXME(me): broken',
  '// TODO without a colon',
  '// TODOS: not the keyword',
  '// XTODO: not a word',
  '// todo: lower case',
  '/* FIXME: */',
  `// TODO: ${long}`,
  '',
].join('\n'));
write(path.join(work, 'sp ace/-lead [x].txt'), 'first\nTODO:in a name with a space, a dash and brackets\n');
write(path.join(work, 'new\nline.txt'), 'FIXME: a name with a newline\n');
write(path.join(work, 'crlf.txt'), 'one\r\nTODO: windows line\r\n');
write(path.join(work, 'bin.dat'), Buffer.from('a\0b\nTODO: in a binary file\n'));
write(path.join(work, '.gitignore'), 'ignored.txt\n');
write(path.join(work, 'later.txt'), 'nothing yet\n');
commitAll(work, 'first');
git(work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc, 'sub');
git(work, 'commit', '-q', '-m', 'the submodule');
/* not tracked: untracked and ignored files */
write(path.join(work, 'untracked.txt'), 'TODO: untracked\n');
write(path.join(work, 'ignored.txt'), 'TODO: ignored\n');
/* a repository configuration that would change git grep's output, or have it look into the submodule or run a
   program: a textconv and a filter that would leave a mark */
const mark = path.join(root, 'ran');
for (const [k, v] of [
  ['grep.patternType', 'perl'], ['grep.column', 'true'], ['grep.lineNumber', 'false'], ['grep.fullName', 'false'],
  ['color.grep', 'always'], ['color.ui', 'always'], ['submodule.recurse', 'true'],
  ['diff.mark.textconv', `touch ${mark}; cat`], ['filter.mark.clean', `touch ${mark}; cat`], ['filter.mark.smudge', `touch ${mark}; cat`],
  ['core.fsmonitor', `touch ${mark}; false`],
]) git(work, 'config', k, v);
write(path.join(work, '.git', 'info', 'attributes'), '* diff=mark filter=mark\n');
const expected = [
  'TODOs (7)',
  'TODO  a.c:1 tidy this',
  'FIXME a.c:2 broken',
  'FIXME a.c:7 */',
  `TODO  a.c:8 ${long.slice(0, 200)}…`,
  'TODO  crlf.txt:2 windows line',
  'FIXME new?line.txt:1 a name with a newline',
  'TODO  sp ace/-lead [x].txt:2 in a name with a space, a dash and brackets',
];

test('SPC g g lists the TODO and FIXME lines of the tracked files last, by one git grep', async () => {
  from(path.join(work, 'a.c'));
  const n = proc.calls.length;
  await keys('SPC g g');
  const b = E.current;
  assert.equal(b.mode, 'git-status-mode');
  assert.deepEqual(todoLines().sort(), [...expected].sort());
  assert.equal(todoLines()[0], 'TODOs (7)', 'the heading first');
  assert.ok(lines().indexOf('TODOs (7)') > lines().indexOf('Recent commits'), 'the last section');
  assert.equal(b.text.endsWith(`${expected[expected.length - 1]}\n`), true, 'the buffer ends with it');
  /* one git grep, hardened by the runner, with the switches that fix its output */
  const g = greps(n);
  assert.equal(g.length, 1);
  const argv = g[0].argv, at = argv.indexOf('grep');
  assert.deepEqual(argv.slice(at), ['grep', '--no-textconv', '--no-recurse-submodules', '--no-color', '--no-column', '--full-name', '-n', '-z', '-I', '-E', '-e',
    '(^|[^[:alnum:]_])(TODO|FIXME)(\\([^)]*\\))?:', '--']);
  for (const s of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', '--no-lazy-fetch', 'filter.mark.clean=', 'diff.mark.textconv=']) assert.ok(argv.includes(s), s);
  assert.equal(g[0].opts.cwd, work);
  assert.equal(fs.existsSync(mark), false, 'no program of the repository ran');
  /* faces: the heading, a keyword, the place */
  const l = lineOf('FIXME a.c:2 broken');
  assert.deepEqual(new Set(classes(b, lineOf('TODOs (7)'))), new Set(['git-section']));
  assert.deepEqual(classes(b, l).slice(0, 12), [...Array(5).fill('git-hash'), '', ...Array(5).fill('git-dim'), '']);
});

test('RET visits the line; s on a TODO line stages nothing; TAB folds the section', async () => {
  const status = E.current;
  goTo('TODO  sp ace/-lead [x].txt:2 in a name with a space, a dash and brackets');
  await keys('RET');
  assert.equal(E.current.file, path.join(work, 'sp ace/-lead [x].txt'));
  assert.equal(Ed.lineNoB(E.current, E.current.pt), 2);
  Ed.setWindowBuffer(status);
  goTo('FIXME new?line.txt:1 a name with a newline');
  await keys('RET');
  assert.equal(E.current.file, path.join(work, 'new\nline.txt'), 'the name as git has it, not as it is shown');
  Ed.setWindowBuffer(status);
  goTo('FIXME a.c:2 broken');
  /* the index's bytes: a git run here directly would run the planted fsmonitor */
  const index = () => fs.readFileSync(path.join(work, '.git', 'index')), text = status.text, was = index();
  await keys('s');
  assert.equal(lastMessage(), 'Nothing to stage here');
  await keys('u');
  assert.equal(lastMessage(), 'Nothing to unstage here');
  await keys('x');
  assert.equal(lastMessage(), 'Nothing to discard here');
  assert.deepEqual(index(), was, 'the index unchanged');
  assert.equal(status.text, text);
  /* g j from the section before it goes to its heading; C-k from its first line too */
  goTo('Recent commits');
  await keys('g j');
  assert.equal(lines()[Ed.lineNoB(status, status.pt) - 1], 'TODOs (7)');
  goTo('TODO  a.c:1 tidy this');
  await keys('C-k');
  assert.equal(lines()[Ed.lineNoB(status, status.pt) - 1], 'TODOs (7)');
  goTo('TODOs (7)');
  await keys('TAB');
  assert.equal(lines()[lines().length - 2], 'TODOs (7)…');
  await keys('g r');
  assert.equal(lines()[lines().length - 2], 'TODOs (7)…', 'kept folded through a refresh');
  await keys('TAB');
  assert.deepEqual(todoLines().sort(), [...expected].sort());
});

test('g r reads them again: from the work tree, a file changed and not staged, one removed', async () => {
  write(path.join(work, 'later.txt'), 'nothing yet\n// TODO(ann): later\n');
  fs.rmSync(path.join(work, 'crlf.txt'));
  const n = proc.calls.length;
  await keys('g r');
  assert.equal(greps(n).length, 1, 'once per refresh');
  assert.deepEqual(todoLines().sort(), [...expected.filter(x => !x.includes('crlf.txt')), 'TODO  later.txt:2 later'].sort());
  assert.equal(todoLines()[0], 'TODOs (7)');
  assert.equal(fs.existsSync(mark), false, 'no program of the repository ran');
});

test('none: no section; more than 200: the first 200 and how many more', async () => {
  const plain = mkdir('plain');
  git(plain, 'init', '-q', '-b', 'main');
  write(path.join(plain, 'f.txt'), 'TODO without a colon\n');
  commitAll(plain, 'one');
  from(path.join(plain, 'f.txt'));
  await keys('SPC g g');
  const one = git(plain, 'rev-parse', '--short', 'HEAD').trim();
  assert.equal(E.current.text, `Head:     main one\n\nRecent commits\n${one} one\n`, 'git grep found nothing (exit 1): no section, no note');
  const many = mkdir('many');
  git(many, 'init', '-q', '-b', 'main');
  write(path.join(many, 'f.txt'), Array.from({ length: 205 }, (_, k) => `TODO: item ${k + 1}\n`).join(''));
  commitAll(many, 'many');
  from(path.join(many, 'f.txt'));
  await keys('SPC g g');
  const t = todoLines();
  assert.equal(t.length, 202);
  assert.equal(t[0], 'TODOs (205)');
  assert.equal(t[1], 'TODO  f.txt:1 item 1');
  assert.equal(t[200], 'TODO  f.txt:200 item 200');
  assert.equal(t[201], '(5 more)');
});

test('a git grep that fails is the section\'s note; the status is still shown', async () => {
  const broken = mkdir('broken');
  git(broken, 'init', '-q', '-b', 'main');
  write(path.join(broken, 'f.txt'), 'TODO: here\n');
  commitAll(broken, 'one');
  /* a setting git grep alone reads, with a value it refuses */
  git(broken, 'config', 'grep.threads', 'many');
  from(path.join(broken, 'f.txt'));
  await keys('SPC g g');
  assert.match(E.current.text, /^Head:     main one\n/);
  assert.match(E.current.text, /\nTODOs \(the TODOs are not listed: git grep failed \(exit 128\): see \*vc-process\*\)\n$/);
});

test('c c reads what is staged without git grep', async () => {
  const plain = path.join(root, 'plain');
  write(path.join(plain, 'g.txt'), 'TODO: staged\n');
  git(plain, 'add', 'g.txt');
  from(path.join(plain, 'g.txt'));
  await keys('SPC g g');
  assert.deepEqual(todoLines(), ['TODOs (1)', 'TODO  g.txt:1 staged']);
  const n = proc.calls.length;
  await keys('c c');
  for (const t = Date.now(); E.current.mode !== 'vc-message-mode'; await new Promise(r => setTimeout(r, 10))) if (Date.now() - t > 20000) assert.fail('the message buffer');
  assert.ok(proc.calls.length > n, 'the status read for the commit');
  assert.equal(greps(n).length, 0);
  await keys('C-c C-k');
});

test('refused under the image\'s replay: no git grep', async () => {
  from(path.join(work, 'a.c'));
  const n = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { ps.push(ed.L.call('vc-status', [])); });
  for (const p of ps) { let err: unknown = null; try { await p; } catch (e) { err = e; } assert.match(String(Ed.errorText(err)), /while the image replays/); }
  assert.equal(greps(n).length, 0);
});
