// git's log and revision buffers (src/vc-git.ts: l l, + and RET) in the headless runtime, with real git from PATH
// through Ed.proc over fake-proc.mts's host.proc, in throwaway repositories under a throwaway HOME; host.files is
// node:fs, as host-native.ts has it. A 1,000-commit fixture is paged through while a probe measures how long the
// event loop is held; the commits shown are compared with `git log`'s.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc-log.test.mts
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-log-')));
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
const short = (cwd: string, rev: string) => git(cwd, 'rev-parse', '--short', rev).trim();

const from = (file: string) => { const b = Ed.getBufferCreate(path.basename(file) + ' (vc-log test)'); b.file = file; Ed.setWindowBuffer(b); return b; };
const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const lines = (): string[] => E.current.text.split('\n');
const lineOf = (s: string) => { const i = lines().indexOf(s); assert.ok(i >= 0, `a line ${JSON.stringify(s)} in\n${E.current.text.slice(0, 4000)}`); return i + 1; };
const goTo = (s: string) => { const b = E.current; b.pt = Ed.lineStartB(b, lineOf(s)); };
const lineAtPoint = () => { const b = E.current, n = Ed.lineNoB(b, b.pt); return lines()[n - 1]; };
const classes = (b: Edwin, n: number) => { const s = Ed.lineStartB(b, n), e = Ed.eol(b.rope, s), lx = Ed.hooks.lexSeg(b, s, e, b.rope.slice(s, e)); return [...lx.cls].map((c: number) => lx.names[c]); };
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return Ed.errorText(e) as string; } return null; };
/* Wait, up to 20 s, for what a child does after a key. */
const until = async (ok: () => boolean, what: string) => {
  for (const t = Date.now(); !ok(); await new Promise(r => setTimeout(r, 5))) if (Date.now() - t > 20000) assert.fail(`timed out waiting for ${what}\n${E.current.text.slice(-2000)}`);
  await Ed.whenIdle();
};
/* The log buffer done reading: no `(reading…)` line. */
const readingLine = () => /^\(reading/.test(lines().filter(l => l).at(-1) || '');
const settled = () => until(() => !readingLine() && !proc.running().length, 'the log page');
/* The short hashes of the log buffer's commit lines. */
const logHashes = () => lines().slice(1).filter(l => /^[0-9a-f]{7,} /.test(l)).map(l => l.slice(0, l.indexOf(' ')));
/* The longest the event loop is held between two ticks of a 2 ms timer, from now until the probe is stopped. */
const probe = () => {
  let last = performance.now(), max = 0;
  const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; }, 2);
  return () => { clearInterval(t); const n = performance.now(); return Math.max(max, n - last); };
};

/* ---------- the fixture: 1,000 commits, by one fast-import stream ---------- */
const big = mkdir('big');
git(big, 'init', '-q', '-b', 'main');
{
  const T0 = Date.parse('2026-01-01T00:00:00Z') / 1000;
  const parts: string[] = [];
  const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  for (let i = 1; i <= 1000; i++) {
    parts.push(`commit refs/heads/main\nmark :${i}\nauthor Test <test@example.invalid> ${T0 + i * 60} +0000\ncommitter Test <test@example.invalid> ${T0 + i * 60} +0000\n`
      + data(`commit ${i}\n`) + (i > 1 ? `from :${i - 1}\n` : '') + `M 100644 inline n.txt\n` + data(`${i}\n`));
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: big, input: parts.join(''), stdio: ['pipe', 'ignore', 'pipe'] });
  git(big, 'reset', '-q', '--hard', 'main');
  git(big, 'tag', 'v1', 'main');
  git(big, 'branch', 'old', 'main~300');
}
const allHashes = (cwd: string, rev = 'HEAD') => git(cwd, 'log', '--format=%h', rev).split('\n').filter(l => l);
const pageReads = () => proc.calls.filter(c => c.argv.includes('log') && c.argv.some(a => a.startsWith('--skip=')));
const PAGE = 256;

test('l l opens the log at once and reads its first page in the background: 256 commits, then a line that says more come', async () => {
  from(path.join(big, 'n.txt'));
  await keys('SPC g g');
  assert.equal(E.current.mode, 'git-status-mode');
  await keys('l l');
  const b = E.current;
  assert.equal(b.name, '*git-log: big*');
  assert.equal(b.mode, 'git-log-mode');
  assert.equal(Ed.MODE_NAMES['git-log-mode'], 'Git Log');
  assert.ok(b.readOnly);
  /* the command has ended while git still reads */
  assert.deepEqual(lines().filter(l => l), [`Commits in ${big}`, '(reading…)']);
  await settled();
  const head = short(big, 'HEAD'), all = allHashes(big);
  assert.equal(all.length, 1000);
  assert.equal(lines()[1], `${head} (HEAD -> main, tag: v1) commit 1000  Test 2026-01-01`);
  assert.deepEqual(logHashes(), all.slice(0, PAGE));
  assert.equal(lines().filter(l => l).at(-1), `(more: + or RET here reads the next ${PAGE})`);
  /* the page read: HEAD resolved once to its full hash, one commit more than the page */
  const c = pageReads().at(-1)!;
  const tail = c.argv.slice(c.argv.indexOf('log'));
  assert.deepEqual(tail.slice(-4), ['--skip=0', `--max-count=${PAGE + 1}`, git(big, 'rev-parse', 'HEAD').trim(), '--']);
  assert.ok(!tail.includes('--graph') && !tail.includes('--topo-order'));
  assert.ok(c.argv.includes('core.hooksPath=/dev/null'), 'a read: the hooks off');
  /* faces: the hash, the refs, the author and date */
  const cls = classes(b, 2), refs = '(HEAD -> main, tag: v1)';
  assert.deepEqual(new Set(cls.slice(0, head.length)), new Set(['git-hash']));
  assert.deepEqual(new Set(cls.slice(head.length + 1, head.length + 1 + refs.length)), new Set(['git-branch']));
  assert.deepEqual(new Set(cls.slice(-'Test 2026-01-01'.length)), new Set(['git-dim']));
  assert.deepEqual(new Set(classes(b, 1)), new Set(['git-section']));
});

test('the 1,000-commit log pages to its end without holding the event loop: + and RET on the last line, each page in the background', async () => {
  const b = E.current, all = allHashes(big);
  const held: number[] = [], waited: number[] = [];
  for (let page = 1; logHashes().length < 1000; page++) {
    const stop = probe(), t = performance.now();
    if (page % 2) await keys('+');
    else { goTo(lines().filter(l => l).at(-1)!); await keys('RET'); }
    waited.push(performance.now() - t);
    /* the command has ended; the page is still being read */
    assert.ok(readingLine(), `page ${page} is read in the background`);
    assert.equal(lines().filter(l => l).at(-1), `(reading the next ${PAGE}…)`);
    await settled();
    held.push(stop());
    assert.deepEqual(logHashes(), all.slice(0, Math.min(1000, (page + 1) * PAGE)), `page ${page}`);
    assert.equal(E.current, b);
  }
  assert.deepEqual(logHashes(), all, 'every commit once, in git log\'s order');
  assert.ok(!lines().some(l => l.startsWith('(more')), 'no more line at the end');
  await keys('+');
  assert.equal(lastMessage(), 'No more commits');
  assert.equal(pageReads().map(c => c.argv.find(a => a.startsWith('--skip='))).slice(-4).join(' '), '--skip=0 --skip=256 --skip=512 --skip=768');
  /* the frame deadline is 2 s (docs/edwin-architecture: frame command deadline); the loop is held far less than
     that, measured on ex44 at a few ms a page */
  /* the frame deadline is 2 s (a frame's command deadline): wall-clock time, so the bound is the deadline itself,
     not what was measured (a few ms a page on ex44), which a loaded build host could pass */
  const most = Math.max(...held);
  /* the lexer on a segment of the 1,000-line buffer, measured (per segment, not the whole buffer) */
  const s = Ed.lineStartB(b, 500), e = Ed.lineStartB(b, 560);
  const t = performance.now();
  for (let k = 0; k < 50; k++) { b._glx = undefined; Ed.hooks.lexSeg(b, s, e, b.rope.slice(s, e)); }
  const per = (performance.now() - t) / 50;
  console.log(`log paging: event loop held at most ${held.map(x => x.toFixed(1)).join(', ')} ms a page; keys returned in ${waited.map(x => x.toFixed(1)).join(', ')} ms; the lexer ${per.toFixed(3)} ms on 60 lines`);
  assert.ok(most < 2000, `the event loop held ${most.toFixed(1)} ms`);
  assert.ok(Math.max(...waited) < 2000, 'each key returns within the frame deadline');
});

test('the pages come from the commit HEAD was when the log opened; g r reads it again from HEAD, as many commits as shown', async () => {
  /* a new log: its first page, then a commit made, then the next page */
  L('kill-buffer', '*git-log: big*');
  from(path.join(big, 'n.txt'));
  await keys('SPC g g'); await keys('l l'); await settled();
  const before = allHashes(big);
  write(path.join(big, 'n.txt'), 'new\n');
  git(big, 'commit', '-q', '-am', 'made while paging');
  await keys('+'); await settled();
  assert.deepEqual(logHashes(), before.slice(0, 2 * PAGE), 'no commit twice, none skipped');
  await keys('g r');
  assert.equal(lines().filter(l => l).at(-1), '(reading…)', 'g r reads it all again, not a next page');
  await settled();
  const now = allHashes(big);
  assert.equal(lines()[1], `${short(big, 'HEAD')} (HEAD -> main) made while paging  Test 2026-01-01`);
  assert.deepEqual(logHashes(), now.slice(0, 2 * PAGE), 'as many as were shown, from HEAD');
  /* a second + while a page is read says so and reads nothing more */
  const n = pageReads().length;
  await keys('+'); await keys('+');
  assert.equal(lastMessage(), 'Still reading the log');
  await settled();
  assert.equal(pageReads().length, n + 1);
  assert.deepEqual(logHashes(), now.slice(0, 3 * PAGE));
});

/* ---------- the revision buffer ---------- */
const small = mkdir('small');
git(small, 'init', '-q', '-b', 'main');
write(path.join(small, 'a.txt'), 'one\ntwo\nthree\n');
write(path.join(small, 'old.txt'), 'moved\nmoved\nmoved\n');
git(small, 'add', '.'); git(small, 'commit', '-q', '-m', 'root');
write(path.join(small, 'a.txt'), 'one\nTWO\nthree\n');
write(path.join(small, 'new.txt'), 'added\n');
git(small, 'mv', 'old.txt', 'moved.txt');
git(small, 'add', '.');
git(small, 'commit', '-q', '-m', 'Change things\n\nThe body\nof it.');
const SECOND = () => git(small, 'rev-parse', 'HEAD').trim();

test('RET on a commit of the log shows it: the header, the message, and its diff by file and hunk', async () => {
  from(path.join(small, 'none.txt'));
  await keys('SPC g g'); await keys('l l'); await settled();
  assert.deepEqual(lines().filter(l => l), [`Commits in ${small}`, `${short(small, 'HEAD')} (HEAD -> main) Change things  Test 2026-01-01`, `${short(small, 'HEAD~')} root  Test 2026-01-01`]);
  goTo(lines()[1]);
  await keys('RET');
  const b = E.current;
  assert.equal(b.name, '*git-revision: small*');
  assert.equal(b.mode, 'git-revision-mode');
  assert.equal(Ed.MODE_NAMES['git-revision-mode'], 'Git Revision');
  const parent = git(small, 'rev-parse', 'HEAD~').trim();
  assert.equal(b.text, [
    `Commit:    ${SECOND()}`,
    `Parent:    ${parent}`,
    'Refs:      HEAD -> main',
    'Author:    Test <test@example.invalid> 2026-01-01T00:00:00Z',
    '',
    '    Change things',
    '',
    '    The body',
    '    of it.',
    '',
    'modified   a.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    'renamed    old.txt -> moved.txt',
    'new file   new.txt',
    '@@ -0,0 +1 @@',
    '+added',
    '',
  ].join('\n'));
  assert.equal(b.pt, 0);
  assert.deepEqual(new Set(classes(b, 6).slice(4)), new Set(['git-section']), 'the summary');
  assert.deepEqual(new Set(classes(b, 1).slice(11)), new Set(['git-hash']));
  assert.deepEqual(new Set(classes(b, 14)), new Set(['git-removed']));
  /* only reads, the hooks off; the diff against the first parent */
  const shows = proc.calls.filter(c => c.argv.includes('show')).slice(-2);
  for (const c of shows) assert.ok(c.argv.includes('core.hooksPath=/dev/null'));
  assert.ok(shows.some(c => c.argv.includes('--diff-merges=first-parent') && c.argv.includes('--root')));
  /* TAB folds a file; C-j steps to the next file or hunk; RET on a hunk line visits the work tree's file there */
  goTo('modified   a.txt');
  await keys('TAB');
  assert.ok(lines().includes('modified   a.txt…'));
  assert.ok(!lines().includes('-two'));
  await keys('TAB');
  goTo('modified   a.txt');
  await keys('C-j');
  assert.equal(lineAtPoint(), '@@ -1,3 +1,3 @@');
  goTo('+TWO');
  await keys('RET');
  assert.equal(E.current.file, path.join(small, 'a.txt'));
  assert.equal(Ed.lineNoB(E.current, E.current.pt), 2);
  /* RET on the parent shows it, in the same buffer: a root commit, its files added */
  Ed.setWindowBuffer(b);
  goTo(`Parent:    ${parent}`);
  await keys('RET');
  assert.equal(E.current, b);
  assert.ok(!lines().some(l => l.startsWith('Parent')), 'a root commit has none');
  assert.match(b.text, /^new file   a\.txt\n@@ -0,0 \+1,3 @@\n\+one\n/m);
  assert.match(b.text, /^new file   old\.txt$/m);
  /* a path a commit's tree names out of the repository is never visited */
  for (const bad of ['../outside.txt', '/etc/passwd', 'a/../../x']) {
    b.gitView.rows[0].visit = { path: bad, line: 1 };
    b.pt = 0;
    assert.match(String(await errorOf(Promise.resolve().then(() => L('git-status-visit')))), /is not in the work tree/, bad);
  }
  assert.equal(E.current, b);
  await keys('g r');
  await keys('q');
});

test('RET on a commit of the status buffer shows it: a recent commit, the head, a stash', async () => {
  write(path.join(small, 'a.txt'), 'stashed\n');
  git(small, 'stash', 'push', '-q', '-m', 'kept');
  from(path.join(small, 'a.txt'));
  await keys('SPC g g');
  goTo(`${short(small, 'HEAD~')} root`);
  await keys('RET');
  assert.equal(E.current.name, '*git-revision: small*');
  assert.equal(lines()[0], `Commit:    ${git(small, 'rev-parse', 'HEAD~').trim()}`);
  await keys('q');
  assert.equal(E.current.mode, 'git-status-mode');
  goTo(lines().find(l => l.startsWith('Head:'))!);
  await keys('RET');
  assert.equal(lines()[0], `Commit:    ${SECOND()}`);
  await keys('q');
  goTo('Stashes (1)…');
  await keys('TAB');
  goTo('stash@{0} On main: kept');
  await keys('RET');
  assert.equal(lines()[0], `Commit:    ${git(small, 'rev-parse', 'stash@{0}').trim()}`);
  /* a stash is a merge: its diff against its first parent, HEAD, is the work tree's change */
  assert.match(E.current.text, /^Parents:   /m);
  assert.match(E.current.text, /^modified   a\.txt\n@@ -1,3 \+1 @@\n-one\n-TWO\n-three\n\+stashed$/m);
  await keys('q');
  git(small, 'stash', 'drop', '-q');
});

test('a merge shows its diff against its first parent; a repository with no commit yet says so', async () => {
  const m = mkdir('merge');
  git(m, 'init', '-q', '-b', 'main');
  write(path.join(m, 'a.txt'), 'a\n'); git(m, 'add', '.'); git(m, 'commit', '-q', '-m', 'base');
  git(m, 'checkout', '-q', '-b', 'side');
  write(path.join(m, 's.txt'), 'side\n'); git(m, 'add', '.'); git(m, 'commit', '-q', '-m', 'side');
  git(m, 'checkout', '-q', 'main');
  write(path.join(m, 'b.txt'), 'main\n'); git(m, 'add', '.'); git(m, 'commit', '-q', '-m', 'on main');
  git(m, 'merge', '-q', '--no-edit', 'side');
  from(path.join(m, 'a.txt'));
  await keys('SPC g g'); await keys('l l'); await settled();
  goTo(lines()[1]);
  await keys('RET');
  assert.equal(lines()[1], `Parents:   ${git(m, 'rev-parse', 'HEAD^1').trim()}`);
  assert.equal(lines()[2], `           ${git(m, 'rev-parse', 'HEAD^2').trim()}`);
  assert.match(E.current.text, /\nnew file   s\.txt\n@@ -0,0 \+1 @@\n\+side\n$/);
  assert.ok(!E.current.text.includes('b.txt'), 'against the first parent only');
  const empty = mkdir('empty');
  git(empty, 'init', '-q', '-b', 'main');
  from(path.join(empty, 'f.txt'));
  await keys('M-x'); await ed.type('git-log\n'); await Ed.whenIdle(); await settled();
  assert.equal(E.current.text, 'No commit yet\n');
});

test('a committer other than the author has its own line, aligned; a file that is not UTF-8 is shown lossily, its diff with the rest', async () => {
  const a = mkdir('amended');
  git(a, 'init', '-q', '-b', 'main');
  write(path.join(a, 'plain.txt'), 'plain\n');
  fs.writeFileSync(path.join(a, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  git(a, 'add', '.'); git(a, 'commit', '-q', '-m', 'mixed');
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: a, stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_NAME: 'Other', GIT_COMMITTER_EMAIL: 'other@example.invalid', GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z' } });
  from(path.join(a, 'plain.txt'));
  await keys('SPC g g'); await keys('l l'); await settled();
  goTo(lines()[1]);
  await keys('RET');
  assert.equal(E.current.text, [
    `Commit:    ${git(a, 'rev-parse', 'HEAD').trim()}`,
    'Refs:      HEAD -> main',
    'Author:    Test <test@example.invalid> 2026-01-01T00:00:00Z',
    'Committer: Other <other@example.invalid> 2026-02-01T00:00:00Z',
    '',
    '    mixed',
    '',
    'new file   latin1.txt',
    '@@ -0,0 +1 @@',
    '+caf�',
    'new file   plain.txt',
    '@@ -0,0 +1 @@',
    '+plain',
    '',
  ].join('\n'));
  await keys('q');
});

test('a log that cannot be read says so, and not that the repository has no commit', async () => {
  const c = mkdir('nogit');
  git(c, 'init', '-q', '-b', 'main');
  write(path.join(c, 'f.txt'), 'f\n'); git(c, 'add', '.'); git(c, 'commit', '-q', '-m', 'one');
  from(path.join(c, 'f.txt'));
  const PATH = process.env.PATH;
  process.env.PATH = path.join(root, 'nonexistent');
  try { await keys('M-x'); await ed.type('git-log\n'); await Ed.whenIdle(); await settled(); }
  finally { process.env.PATH = PATH; }
  assert.equal(E.current.name, '*git-log: nogit*');
  assert.equal(E.current.text, `Commits in ${c}\n(the log could not be read: see *vc-process*)\n`);
  assert.match(lastMessage(), /cannot run git/);
});

test('a repository git refuses (exit 128) is not an empty history: the log says it could not be read, RET on its commit fails the same way', async () => {
  const c = mkdir('refused');
  git(c, 'init', '-q', '-b', 'main');
  write(path.join(c, 'f.txt'), 'f\n'); git(c, 'add', '.'); git(c, 'commit', '-q', '-m', 'one');
  from(path.join(c, 'f.txt'));
  await keys('SPC g g'); await keys('l l'); await settled();
  const one = `${short(c, 'HEAD')} (HEAD -> main) one  Test 2026-01-01`;
  assert.equal(lines()[1], one);
  goTo(lines()[1]);
  /* git starts, then refuses the repository: `fatal: unknown repository extension`, exit 128 */
  git(c, 'config', 'core.repositoryformatversion', '1'); git(c, 'config', 'extensions.bogusext', 'true');
  const shown = Promise.resolve().then(() => L('git-status-visit'));
  assert.match(String(await errorOf(shown)), /git rev-parse failed \(exit 128\): see \*vc-process\*/);
  await keys('M-x'); await ed.type('git-log\n'); await Ed.whenIdle(); await settled();
  assert.equal(E.current.name, '*git-log: refused*');
  /* the page already shown stays, the note under it: no `No commit yet` */
  assert.equal(E.current.text, `Commits in ${c}\n${one}\n(the log could not be read: see *vc-process*)\n`);
  assert.match(lastMessage(), /git rev-parse failed \(exit 128\): see \*vc-process\*/);
  assert.match(Ed.getBuffer('*vc-process*').text, /unknown repository extension/);
});

test('a commit with an empty message: one blank line between the header and the diff', async () => {
  const e = mkdir('nomessage');
  git(e, 'init', '-q', '-b', 'main');
  write(path.join(e, 'f.txt'), 'f\n'); git(e, 'add', '.'); git(e, 'commit', '-q', '--allow-empty-message', '-m', '');
  from(path.join(e, 'f.txt'));
  await keys('SPC g g'); await keys('l l'); await settled();
  goTo(lines()[1]);
  await keys('RET');
  assert.equal(E.current.text, [
    `Commit:    ${git(e, 'rev-parse', 'HEAD').trim()}`,
    'Refs:      HEAD -> main',
    'Author:    Test <test@example.invalid> 2026-01-01T00:00:00Z',
    '',
    'new file   f.txt',
    '@@ -0,0 +1 @@',
    '+f',
    '',
  ].join('\n'));
  await keys('q');
});

test('refused: outside a repository, a jj workspace, an unknown revision; under the image\'s replay nothing starts', async () => {
  const plain = mkdir('plain');
  from(path.join(plain, 'f.txt'));
  const n = proc.calls.length;
  await keys('M-x'); await ed.type('git-log\n'); await Ed.whenIdle();
  assert.match(lastMessage(), new RegExp(`Not in a repository: ${plain}`));
  const jj = mkdir('jj');
  execFileSync('jj', ['git', 'init'], { cwd: jj, stdio: 'ignore' });
  from(path.join(jj, 'f.txt'));
  await keys('M-x'); await ed.type('git-log\n'); await Ed.whenIdle();
  assert.match(lastMessage(), /is a jj workspace: use jj log/);
  assert.equal(proc.calls.length, n, 'nothing ran');
  /* a log open, then under the replay: git-log, + and RET on a commit start nothing */
  from(path.join(small, 'a.txt'));
  await keys('SPC g g'); await keys('l l'); await settled();
  goTo(lines()[1]);
  const k = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => { for (const c of ['git-log', 'git-log-more', 'git-status-visit']) { try { ps.push(Promise.resolve(L(c))); } catch (e) { ps.push(Promise.reject(e)); } } });
  for (const p of ps) assert.match(String(await errorOf(p)), /while the image replays/);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(proc.calls.length, k, 'no child started');
  /* an unknown revision is refused */
  const shown: Promise<unknown>[] = [];
  E.current.gitView.rows[1].show = '--output=/tmp/x';
  shown.push(Promise.resolve().then(() => L('git-status-visit')));
  assert.match(String(await errorOf(shown[0])), /Not a commit: --output=\/tmp\/x/);
});

test('a repository whose own configuration names programs runs none of them for its log and for a merge\'s revision buffer', async () => {
  const evil = mkdir('evil'), marker = path.join(root, 'evil-ran');
  git(evil, 'init', '-q', '-b', 'main');
  write(path.join(evil, 'a.txt'), 'one\n'); git(evil, 'add', '.'); git(evil, 'commit', '-q', '-m', 'one');
  git(evil, 'checkout', '-q', '-b', 'side');
  write(path.join(evil, 'a.txt'), 'side\n'); git(evil, 'commit', '-q', '-am', 'side');
  git(evil, 'checkout', '-q', 'main');
  write(path.join(evil, 'b.txt'), 'main\n'); git(evil, 'add', '.'); git(evil, 'commit', '-q', '-m', 'main');
  git(evil, 'merge', '-q', '--no-edit', 'side');
  const script = path.join(root, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat\n`, { mode: 0o755 });
  for (const [k, v] of [['core.fsmonitor', script], ['core.pager', script], ['diff.external', script], ['diff.evil.textconv', script], ['diff.evil.command', script],
    ['filter.evil.clean', script], ['filter.evil.smudge', script], ['merge.evil.driver', script], ['gpg.program', script], ['log.showSignature', 'true'],
    ['log.diffMerges', 'remerge'], ['alias.log', '!' + script], ['alias.show', '!' + script], ['alias.rev-parse', '!' + script]]) git(evil, 'config', k, v);
  write(path.join(evil, '.git/info/attributes'), '* diff=evil filter=evil merge=evil\n');
  /* the control: plain git runs them */
  git(evil, 'show', '-p', 'HEAD~');
  assert.ok(fs.existsSync(marker), 'plain git show runs the repository\'s programs');
  fs.rmSync(marker);
  from(path.join(evil, 'a.txt'));
  await keys('SPC g g'); await keys('l l'); await settled();
  assert.equal(logHashes().length, 4, E.current.text + Ed.getBuffer('*vc-process*').text.slice(-3000));
  goTo(lines()[1]);
  await keys('RET');
  assert.match(E.current.text, /^Parents:   /m);
  assert.match(E.current.text, /^modified   a\.txt\n@@ -1 \+1 @@\n-one\n\+side$/m, 'git\'s own diff, not the textconv\'s, against the first parent');
  goTo(lines().find(l => l.startsWith('Parents:'))!);
  await keys('RET');
  assert.match(E.current.text, /^new file   b\.txt$/m);
  assert.equal(fs.existsSync(marker), false, 'nothing of the repository\'s ran');
});
