// The commit message buffer (src/vc.ts, vc-message-mode in scm/emacs.scm) in the headless runtime: the faces of
// the summary, its overlong part, a second line that is not blank and the comment lines; the message C-c C-c
// gives, cleaned as git stripspace --strip-comments cleans it; C-c C-k and killing the buffer abort; what is refused.
// Then the runner (Vc.repo, Vc.start, Vc.run) with real git and jj: see its section below.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc.test.mts
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
const Vc = (globalThis as unknown as { Vc: Edwin }).Vc;
ed.eval('(set! corfu-auto #f)');
const lastMessage = (): string => { const t: string = Ed.getBuffer('*Messages*').text.replace(/\n+$/, ''); return t.slice(t.lastIndexOf('\n') + 1); };
const PENDING = Symbol('pending');
/* What P has given by now, or PENDING. */
const settled = async (p: Promise<unknown>) => { await Ed.whenIdle(); return Promise.race([p, new Promise(r => setTimeout(() => r(PENDING), 20))]); };
/* The class of each character of buffer B from FROM to TO, as the mode's lexer gives it. */
const classes = (b: Edwin, from = 0, to = b.text.length) => { const lx = Ed.hooks.lexSeg(b, from, to, b.rope.slice(from, to)); return [...lx.cls].map((c: number) => lx.names[c]); };
const home = () => { const b = Ed.getBufferCreate('*vc-home*'); Ed.setWindowBuffer(b); return b; };

test('git stripspace --strip-comments: comment lines, trailing white space and runs of blank lines go', () => {
  assert.equal(Vc.cleanMessage('\n\n  \nSummary  \n\n\n\nBody\t\n# a comment\nmore\n\n# On branch x\n\n', '#'), 'Summary\n\nBody\nmore\n');
  assert.equal(Vc.cleanMessage('# only\n#comments\n\n', '#'), '');
  assert.equal(Vc.cleanMessage(' # not at the start\n', '#'), ' # not at the start\n', 'a comment starts the line');
  assert.equal(Vc.cleanMessage('Fix\n\n# kept: jj\'s comments are JJ:\nJJ: This commit contains\nJJ:     M a.txt\n', 'JJ:'), 'Fix\n\n# kept: jj\'s comments are JJ:\n');
  /* git's white space is space, tab and CR only: `printf 'a \v\f\r\t \nb \n\v\n\nc\n' | git stripspace`. */
  assert.equal(Vc.cleanMessage('a \v\f\r\t \nb \n\v\n\nc\n', '#'), 'a \v\f\nb \n\v\n\nc\n', 'no-break space, \\v and \\f stay');
  assert.equal(Vc.cleanMessage('Summary\r\n\r\nBody\r\n', '#'), 'Summary\n\nBody\n', 'CRLF lines');
});

test('faces: the summary, the part past vc-message-summary-max-length, a second line that is not blank, comments', async () => {
  const back = home();
  const summary = 'x'.repeat(70);
  const text = `\n# lead\n${summary}\nsecond line\n\nbody past ${'y'.repeat(80)}\n# trailing comment`;
  const p = Vc.message({ name: '*vc-msg-faces*', text });
  const b = E.current;
  assert.equal(b.name, '*vc-msg-faces*');
  assert.equal(Ed.windowList()[0].buffer, b, 'shown in the selected window');
  assert.equal(b.mode, 'vc-message-mode');
  assert.equal(Ed.MODE_NAMES['vc-message-mode'], 'Message');
  assert.ok(Ed.modeChain(b.mode).includes('text-mode'), 'derived from text-mode');
  assert.equal(b.pt, 0); assert.equal(b.modified, false); assert.deepEqual(b.undo, [], 'the opening text is not an edit');
  const cls = classes(b), at = (line: string) => text.indexOf(line);
  const s = at(summary);
  assert.deepEqual(cls.slice(0, s - 1), ['', ...Array(6).fill('cm')], 'a blank line, then a comment line before the summary');
  assert.deepEqual(cls.slice(s, s + 68), Array(68).fill('vc-message-summary'));
  assert.deepEqual(cls.slice(s + 68, s + 70), ['vc-message-warning', 'vc-message-warning'], 'past 68 characters');
  assert.deepEqual(new Set(cls.slice(at('second line'), at('second line') + 11)), new Set(['vc-message-warning']), 'a second line that is not blank');
  assert.deepEqual(new Set(cls.slice(at('body'), at('# trailing') - 1)), new Set(['']), 'the body has no face, however long its lines');
  assert.deepEqual(new Set(cls.slice(at('# trailing'))), new Set(['cm']));
  /* A segment that starts inside the summary line counts its columns from the line's start. */
  assert.deepEqual(classes(b, s + 60, s + 70), [...Array(8).fill('vc-message-summary'), 'vc-message-warning', 'vc-message-warning']);
  ed.eval('(set! vc-message-summary-max-length 72)');
  assert.deepEqual(new Set(classes(b).slice(s, s + 70)), new Set(['vc-message-summary']), 'the limit is the variable\'s');
  ed.eval('(set! vc-message-summary-max-length 68)');
  await ed.keys('C-c C-k');
  assert.equal(await settled(p), null);
  assert.equal(Ed.windowList()[0].buffer, back, 'the window shows what it showed before');
});

test('a second line that is blank or a comment is no warning; jj\'s JJ: lines are its comments', async () => {
  home();
  const p = Vc.message({ name: '*vc-msg-jj*', text: 'Summary\nJJ: This commit contains\n# a body line\n', comment: 'JJ:' });
  const b = E.current, cls = classes(b);
  assert.deepEqual(new Set(cls.slice(0, 7)), new Set(['vc-message-summary']));
  assert.deepEqual(new Set(cls.slice(8, 8 + 24)), new Set(['cm']), 'the second line is a comment');
  assert.deepEqual(new Set(cls.slice(8 + 25, 8 + 25 + 13)), new Set(['']), '# starts no comment for jj');
  b.text = 'Summary\n\nbody\n';
  assert.deepEqual(new Set(classes(b).slice(8)), new Set(['']), 'a blank second line');
  await ed.keys('C-c C-k');
  assert.equal(await settled(p), null);
});

test('C-c C-c gives the message without its comments and kills the buffer, from Insert or Normal state', async () => {
  const back = home();
  let p = Vc.message({ name: '*vc-msg*', text: '\n# Please enter the commit message.\n# On branch main\n' });
  await ed.keys('i');
  await ed.type('Add the message mode\n\nIt has faces.  ');
  assert.equal(E.current.modified, true);
  await ed.keys('C-c C-c');
  assert.equal(await settled(p), 'Add the message mode\n\nIt has faces.\n');
  assert.ok(!Ed.getBuffer('*vc-msg*'), 'the buffer is gone');
  assert.equal(Ed.windowList()[0].buffer, back);
  p = Vc.message({ name: '*vc-msg*', text: 'Reword this\n# comment\n' });
  await ed.keys('ESC');
  await ed.keys('C-c C-c');
  assert.equal(await settled(p), 'Reword this\n', 'from Normal state, and the name can be used again');
  assert.ok(!Ed.getBuffer('*vc-msg*'));
});

test('C-c C-k and killing the buffer abort: the promise gives null', async () => {
  home();
  let p = Vc.message({ name: '*vc-msg*', text: 'Not this\n' });
  await ed.keys('C-c C-k');
  assert.equal(await settled(p), null);
  assert.equal(lastMessage(), 'Message aborted');
  assert.ok(!Ed.getBuffer('*vc-msg*'));
  p = Vc.message({ name: '*vc-msg*', text: 'Nor this\n' });
  ed.eval('(kill-buffer "*vc-msg*")');
  assert.equal(await settled(p), null);
  assert.ok(!Ed.getBuffer('*vc-msg*'));
});

test('refused: an empty message, a buffer with no message waiting, a name already in use', async () => {
  const back = home();
  const p = Vc.message({ name: '*vc-msg*', text: '\n# only a comment\n' });
  const b = E.current;
  await ed.keys('C-c C-c');
  assert.equal(await settled(p), PENDING, 'nothing is given');
  assert.equal(Ed.getBuffer('*vc-msg*'), b, 'the buffer stays');
  assert.match(lastMessage(), /The message is empty/);
  /* A second message under the same name, or over a buffer of the user's, is refused and changes nothing. */
  assert.throws(() => Vc.message({ name: '*vc-msg*', text: 'other' }), /already open/);
  assert.equal(b.text, '\n# only a comment\n');
  assert.equal(await settled(p), PENDING);
  const mine = Ed.getBufferCreate('*mine*'); mine.text = 'keep me';
  assert.throws(() => Vc.message({ name: '*mine*' }), /already open/);
  assert.equal(mine.text, 'keep me'); assert.notEqual(mine.mode, 'vc-message-mode');
  assert.throws(() => Vc.message({ name: '' }), /needs a buffer name/);
  await ed.keys('C-c C-k');
  assert.equal(await settled(p), null);
  /* The mode turned on by hand has no commit waiting: its keys say so. */
  Ed.setWindowBuffer(mine);
  ed.eval('(vc-message-mode)');
  await ed.keys('C-c C-c');
  assert.match(lastMessage(), /No commit waits for a message in this buffer/);
  assert.equal(Ed.getBuffer('*mine*'), mine, 'and the buffer stays');
  assert.equal(mine.text, 'keep me');
  Ed.setWindowBuffer(back);
});

test('a signal from vc-message-mode-hook leaves no buffer behind: the name can be used again', async () => {
  const back = home();
  ed.eval('(define (vc-test-boom) (error "boom"))');
  ed.eval("(add-hook! 'vc-message-mode-hook vc-test-boom)");
  assert.throws(() => Vc.message({ name: '*vc-msg-hook*', text: 'x\n' }), /boom/);
  assert.ok(!Ed.getBuffer('*vc-msg-hook*'), 'no leftover buffer');
  assert.equal(Ed.windowList()[0].buffer, back, 'the window is unchanged');
  ed.eval("(remove-hook! 'vc-message-mode-hook vc-test-boom)");
  const p = Vc.message({ name: '*vc-msg-hook*', text: 'x\n' });
  await ed.keys('C-c C-c');
  assert.equal(await settled(p), 'x\n');
  assert.ok(!Ed.getBuffer('*vc-msg-hook*'));
});

/* ---------- the runner: Vc.repo, Vc.start, Vc.run (git-runner) ---------- */
// Real git and jj from PATH (the check brings nixpkgs' git and jujutsu), through Ed.proc over fake-proc.mts's
// host.proc, in throwaway repositories under a throwaway HOME; host.files.tree is node:fs, as host-native.ts has it.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's, git's or jj's, is read. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
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
    entry(p: string) {
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch (e) { return null; }
      const e: { kind: string; size: number; mtime: number; mode: number; dir?: boolean } =
        { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777 };
      if (e.kind === 'link') { try { if (fs.statSync(p).isDirectory()) e.dir = true; } catch (err) { /* dangling */ } }
      return e;
    },
  },
};

/* A program run directly (not through Vc), for the fixtures and the control runs: no input, a time limit, and
   its failure is no exception. */
const direct = (cwd: string, prog: string, ...args: string[]) => {
  try { return execFileSync(prog, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' }); }
  catch (e) { return String((e as { stdout?: string }).stdout || ''); }
};
const mkdir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const T = { timeout: 20000 };
const last = () => proc.calls[proc.calls.length - 1];
const callsSince = (n: number) => proc.calls.slice(n);
const vcLog = () => Ed.getBuffer('*vc-process*').text as string;

/* A git repository with one commit and an untracked file. */
const gitDir = mkdir('git');
direct(gitDir, 'git', 'init', '-q', '-b', 'main');
write(path.join(gitDir, 'a.txt'), 'one\n');
direct(gitDir, 'git', 'add', 'a.txt'); direct(gitDir, 'git', 'commit', '-q', '-m', 'first');
write(path.join(gitDir, 'new.txt'), 'new\n');
write(path.join(gitDir, 'sub/deep/x.txt'), 'x\n');
/* A jj workspace (colocated: it has .git too), one file added. */
const jjDir = mkdir('jj');
direct(jjDir, 'jj', 'git', 'init');
write(path.join(jjDir, 'f.txt'), 'jj file\n');

test('Vc.repo: the nearest repository up from a directory, .jj first; none outside one or without a file tree', () => {
  assert.deepEqual(Vc.repo(gitDir), { vcs: 'git', root: gitDir });
  assert.deepEqual(Vc.repo(path.join(gitDir, 'sub/deep')), { vcs: 'git', root: gitDir }, 'from a directory inside');
  assert.ok(fs.existsSync(path.join(jjDir, '.git')), 'the jj workspace is colocated');
  assert.deepEqual(Vc.repo(jjDir + '/'), { vcs: 'jj', root: jjDir }, 'jj before git in the same directory');
  /* a git repository inside a jj workspace: the nearer one */
  const inner = mkdir('jj/inner');
  direct(inner, 'git', 'init', '-q');
  assert.deepEqual(Vc.repo(inner), { vcs: 'git', root: inner });
  fs.rmSync(inner, { recursive: true });
  /* a worktree's .git is a file */
  const wt = path.join(root, 'git-wt');
  direct(gitDir, 'git', 'worktree', 'add', '-q', wt);
  assert.ok(fs.lstatSync(path.join(wt, '.git')).isFile());
  assert.deepEqual(Vc.repo(wt), { vcs: 'git', root: wt });
  assert.equal(Vc.repo(mkdir('plain')), null);
  assert.equal(Vc.repo('relative/dir'), null, 'an absolute directory only');
  const files = host.files; host.files = undefined;
  try { assert.equal(Vc.repo(gitDir), null, 'no file tree (a web frame, edwind): no repository'); }
  finally { host.files = files; }
});

test('status of a git and a jj repository, in the root, with the fixed argv and environment', async () => {
  const g = Vc.repo(path.join(gitDir, 'sub'));
  const r = await Vc.run(g, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'], T);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# branch\.head main$/m);
  assert.match(r.out, /^\? new\.txt$/m); assert.match(r.out, /^\? sub\/deep\/x\.txt$/m);
  const c = last();
  assert.equal(c.argv[0], 'git'); assert.equal(c.opts.cwd, gitDir, 'run in the root');
  const conf = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a] : []));
  assert.deepEqual(c.argv.slice(1, 3), ['--no-pager', '--no-lazy-fetch'], 'a read fetches nothing a partial clone lacks');
  assert.deepEqual(conf(c.argv), ['core.fsmonitor=false', 'core.pager=cat', 'diff.external=', 'alias.status=', 'core.hooksPath=/dev/null', 'protocol.allow=never', 'log.showSignature=false']);
  assert.deepEqual(c.argv.slice(c.argv.indexOf('status')), ['status', '--ignore-submodules=dirty', '--porcelain=v2', '--branch', '--untracked-files=all']);
  assert.equal(c.argv.some(a => /safe\.directory/.test(a)), false, 'safe.directory is never set');
  assert.deepEqual(c.opts.env, {
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', GIT_PAGER: 'cat',
    GIT_DIR: null, GIT_WORK_TREE: null, GIT_INDEX_FILE: null, LC_ALL: null, LANGUAGE: null, LC_MESSAGES: 'C',
  });
  assert.deepEqual(proc.calls[proc.calls.length - 2].argv.slice(-5), ['config', '--show-scope', '--null', '--get-regexp', '^(filter|merge|diff|gpg)\\.'], 'a read asks for the repository\'s drivers and signature programs first');
  /* diff-producing subcommands get --no-ext-diff and --no-textconv after the subcommand; commit keeps hooks */
  await Vc.run(g, ['diff', '--stat'], T);
  assert.deepEqual(last().argv.slice(last().argv.indexOf('diff')), ['diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty', '--stat']);
  const j = Vc.repo(jjDir);
  const s = await Vc.run(j, ['status'], T);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /^Working copy changes:\nA f\.txt$/m);
  assert.deepEqual(last().argv, ['jj', '--no-pager', '--color=never', '--config', 'ui.diff-formatter=:git', '--config', 'ui.log-word-wrap=false', 'status']);
  assert.equal(last().opts.cwd, jjDir);
  assert.deepEqual(last().opts.env, { JJ_EDITOR: 'false', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'false' });
  const d = await Vc.run(j, ['log', '--no-graph', '-r', '@', '-T', 'change_id.short() ++ "|" ++ empty ++ "\\n"'], T);
  assert.match(d.out, /^[k-z]{12}\|false\n$/, 'a fixed template');
  const p = await Vc.start(g, ['log', '--format=%s'], { onOut: () => {} });
  assert.equal((await p.exit).code, 0, 'Vc.start gives the running child');
});

test('only git and jj run, and nothing that undoes the hardening', async () => {
  const g = Vc.repo(gitDir), n = proc.calls.length;
  const refused = async (p: Promise<unknown>, re: RegExp) => { await assert.rejects(p, (e: unknown) => re.test(Ed.errorText(e))); };
  await refused(Vc.run({ vcs: 'hg', root: gitDir }, ['status']), /git and jj only/);
  await refused(Vc.run({ vcs: 'sh', root: gitDir } as never, ['-c', 'touch x']), /git and jj only/);
  await refused(Vc.run({ vcs: 'git', root: 'git' }, ['status']), /absolute path/);
  await refused(Vc.run(g, ['-c', 'core.pager=touch x', 'log']), /Not a git subcommand: -c/);
  await refused(Vc.run(g, ['--exec-path=/tmp', 'status']), /Not a git subcommand/);
  await refused(Vc.run(g, []), /needs a subcommand/);
  await refused(Vc.run(g, ['diff', '--ext-diff']), /--ext-diff is not given to git/);
  await refused(Vc.run(g, ['log', '-p', '--textconv']), /--textconv is not given/);
  for (const a of ['--ignore-submodules=none', '--ignore-submodules', '--submodule=diff', '--recurse-submodules'])
    await refused(Vc.run(g, ['diff', a]), new RegExp(`${a} is not given to git`));
  /* git takes these by a prefix: status, ls-files and cat-file run them so */
  for (const c of [['status', '--ignore-sub=none'], ['ls-files', '--recurse'], ['cat-file', '--textc', 'HEAD:a.txt'], ['diff', '--text'], ['log', '--show-sig'],
    ['describe', '--dirty'], ['describe', '--broken'], ['describe', '--dirt'], ['describe', '--dirty=*']])
    await refused(Vc.run(g, c), new RegExp(`${c[1].replace('*', '\\*')} is not given to git`));
  await refused(Vc.run(Vc.repo(jjDir), ['diff', '--config=ui.diff-formatter=["sh"]']), /--config=.* is not given to jj/);
  await refused(Vc.run(Vc.repo(jjDir), ['diff', '--tool', 'x']), /--tool is not given to jj/);
  assert.equal(proc.calls.length, n, 'none of them started a child');
  /* after `--`, they are paths */
  const r = await Vc.run(g, ['log', '--format=%s', '--', '--ext-diff'], T);
  assert.equal(r.code, 0, r.err);
});

test('a repository whose own configuration names programs runs none of them through status, diff, log and show', async () => {
  const dir = mkdir('hostile'), marks = mkdir('marks'), bin = mkdir('bin');
  direct(dir, 'git', 'init', '-q', '-b', 'main');
  write(path.join(dir, 'a.txt'), 'one\n'); write(path.join(dir, 'b.txt'), 'b\n');
  write(path.join(dir, '.gitattributes'), '* diff=evil filter=evil\nb.txt filter=inc\n');
  direct(dir, 'git', 'add', '-A'); direct(dir, 'git', 'commit', '-q', '-m', 'first');
  /* each program touches its own marker and exits */
  const sh = process.env.PATH!.split(':').map(d => path.join(d, 'sh')).find(p => fs.existsSync(p))!;
  const evil = (name: string) => { const p = path.join(bin, name); write(p, `#!${sh}\n: > ${path.join(marks, name)}\n`); fs.chmodSync(p, 0o755); return p; };
  for (const [k, v] of [['core.fsmonitor', 'fsmonitor'], ['core.pager', 'pager'], ['diff.external', 'external'], ['diff.evil.command', 'diff-command'],
    ['diff.evil.textconv', 'textconv'], ['filter.evil.clean', 'clean'], ['filter.evil.smudge', 'smudge'], ['filter.evil.process', 'process'], ['gpg.program', 'gpg'], ['include.path', '']])
    direct(dir, 'git', 'config', k, v ? evil(v) : path.join(dir, '..', 'included.cfg'));
  direct(dir, 'git', 'config', 'log.showSignature', 'true');
  /* a filter driver from a file the repository's config includes counts as the repository's */
  write(path.join(root, 'included.cfg'), `[filter "inc"]\n\tclean = ${evil('inc-clean')}\n`);
  write(path.join(dir, 'b.txt'), 'b\nc\n');
  write(path.join(dir, 'a.txt'), 'one\ntwo\n');
  const fired = () => fs.readdirSync(marks).sort();
  const clear = () => { for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f)); };
  const touch = () => { const t = new Date(); for (const f of ['a.txt', 'b.txt']) fs.utimesSync(path.join(dir, f), t, t); };
  const cases = [['status', '--porcelain=v2'], ['diff'], ['log', '-p'], ['show']];
  /* The control: plain git on the same repository runs them, so the scripts can run here. */
  const ran = new Set<string>();
  for (const c of cases) {
    clear(); touch();
    direct(dir, 'git', ...c);
    assert.notDeepEqual(fired(), [], `plain git ${c[0]} runs a script of the repository's`);
    for (const f of fired()) ran.add(f);
  }
  for (const f of ['fsmonitor', 'diff-command', 'textconv', 'process', 'inc-clean']) assert.ok(ran.has(f), `the control runs ${f}`);
  const g = Vc.repo(dir);
  for (const c of cases) {
    clear(); touch();
    const r = await Vc.run(g, c, T);
    assert.equal(r.code, 0, `${c[0]}: ${r.err}`);
    assert.deepEqual(fired(), [], `git ${c[0]} through Vc runs nothing of the repository's`);
    if (c[0] === 'diff') assert.match(r.out, /^\+two$/m, 'and the diff is there');
  }
  /* status -v prints a diff with the textconv driver and has no --no-textconv: the control runs it, Vc does not
     (git then refuses the emptied program, so the read fails rather than running it). */
  clear(); touch(); direct(dir, 'git', 'add', 'a.txt');
  direct(dir, 'git', 'status', '-v');
  assert.ok(fired().includes('textconv'), 'the control: plain git status -v runs the textconv driver');
  clear(); touch();
  await Vc.run(g, ['status', '-v'], T);
  assert.deepEqual(fired(), [], 'git status -v through Vc runs nothing of the repository\'s');
  direct(dir, 'git', 'reset', '-q');
  const status = proc.calls.filter(x => x.argv.includes('status')).pop()!.argv;
  for (const f of ['evil', 'inc']) for (const k of ['clean', 'smudge', 'process']) assert.ok(status.includes(`filter.${f}.${k}=`), `filter.${f}.${k} emptied`);
  /* The pager: Vc's children write to pipes, where git starts none whatever its configuration says, so the argv
     and environment Vc gave log and show run again here on a terminal (util-linux script), where git would. */
  const onTty = (argv: string[], env: Record<string, string | null> = {}) => {
    const e = { ...process.env } as Record<string, string>;
    for (const [k, v] of Object.entries(env)) { if (v === null) delete e[k]; else e[k] = v; }
    const cmd = argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    try { execFileSync('script', ['-qec', cmd, '/dev/null'], { cwd: dir, env: e, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }); }
    catch (err) { /* how it ended is no matter: the marker is */ }
  };
  for (const c of ['log', 'show']) {
    clear(); onTty(['git', c]);
    assert.ok(fired().includes('pager'), `the control: plain git ${c} on a terminal runs the pager`);
    const call = proc.calls.filter(x => x.argv.includes(c)).pop()!;
    clear(); onTty(call.argv, call.opts.env);
    assert.deepEqual(fired(), [], `Vc's git ${c} on a terminal runs no pager, nor anything else of the repository's`);
  }
  /* hooks: only commit, push and the sequencer keep them */
  write(path.join(dir, '.git/hooks/post-checkout'), `#!${sh}\n: > ${path.join(marks, 'post-checkout')}\n`);
  write(path.join(dir, '.git/hooks/pre-commit'), `#!${sh}\n: > ${path.join(marks, 'pre-commit')}\n`);
  for (const h of ['post-checkout', 'pre-commit']) fs.chmodSync(path.join(dir, '.git/hooks', h), 0o755);
  clear();
  direct(dir, 'git', 'checkout', '-q', '-b', 'control');
  assert.ok(fired().includes('post-checkout'), 'the control: plain checkout runs the hook');
  clear();
  assert.equal((await Vc.run(g, ['checkout', '-q', '-b', 'through-vc'], T)).code, 0);
  /* (a write keeps the repository's filter drivers: checkout may run them) */
  assert.ok(!fired().includes('post-checkout'), 'checkout through Vc runs no hook');
  assert.equal((await Vc.run(g, ['commit', '-q', '--allow-empty', '-m', 'hooked'], T)).code, 0);
  assert.ok(fired().includes('pre-commit'), 'commit keeps its hooks');
});

/* A program at BIN/NAME that touches MARKS/NAME, then copies its input or fails. */
const sh = process.env.PATH!.split(':').map(d => path.join(d, 'sh')).find(p => fs.existsSync(p))!;
const marker = (bin: string, marks: string, name: string, then = 'exit 1') => {
  const p = path.join(bin, name); write(p, `#!${sh}\n: > ${path.join(marks, name)}\n${then}\n`); fs.chmodSync(p, 0o755); return p;
};

test('every subcommand that is no write is a read, named or not; difftool, mergetool and help are refused', async () => {
  const dir = mkdir('unlisted'), marks = mkdir('ul-marks'), bin = mkdir('ul-bin');
  const fired = () => fs.readdirSync(marks).sort();
  const clear = () => { for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f)); };
  direct(dir, 'git', 'init', '-q', '-b', 'main');
  write(path.join(dir, '.gitattributes'), '* diff=evil\n'); write(path.join(dir, 'a.txt'), 'one\n');
  direct(dir, 'git', 'add', '-A'); direct(dir, 'git', 'commit', '-q', '-m', 'first');
  write(path.join(dir, 'a.txt'), 'one\ntwo\n'); direct(dir, 'git', 'commit', '-q', '-am', 'second');
  write(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  for (const [k, v] of [['diff.evil.textconv', marker(bin, marks, 'textconv', 'exec cat "$1"')], ['diff.tool', 'evil'], ['difftool.prompt', 'false'],
    ['difftool.evil.cmd', marker(bin, marks, 'difftool')], ['merge.tool', 'evil'], ['mergetool.prompt', 'false'], ['mergetool.evil.cmd', marker(bin, marks, 'mergetool')],
    ['help.format', 'man'], ['man.viewer', 'evil'], ['man.evil.cmd', marker(bin, marks, 'man')]])
    direct(dir, 'git', 'config', k, v);
  const g = Vc.repo(dir);
  /* Reads no list names: the control runs the repository's textconv driver; through Vc they run nothing (reflog
     takes no --no-textconv, so with the driver emptied git fails rather than run it). */
  const reads = [['reflog', '-p'], ['annotate', 'a.txt', 'HEAD~1']];
  for (const c of reads) {
    clear(); direct(dir, 'git', ...c);
    assert.ok(fired().includes('textconv'), `the control: plain git ${c.join(' ')} runs the textconv driver`);
    clear();
    const r = await Vc.run(g, c, T);
    if (c[0] !== 'reflog') assert.equal(r.code, 0, `${c[0]}: ${r.err}`);
    assert.deepEqual(fired(), [], `git ${c.join(' ')} through Vc runs nothing of the repository's`);
    for (const a of ['--no-lazy-fetch', 'protocol.allow=never', 'diff.evil.textconv=']) assert.ok(last().argv.includes(a), `${c[0]} gets ${a}`);
  }
  assert.ok(last().argv.includes('--no-textconv'), 'annotate gets blame\'s --no-textconv');
  /* a name of no builtin is a read too (its alias emptied, git refuses it) */
  await Vc.run(g, ['zz-none'], T);
  assert.ok(last().argv.includes('--no-lazy-fetch'), 'a name in no list is a read');
  /* a write keeps the repository's drivers and transport */
  assert.equal((await Vc.run(g, ['add', 'a.txt'], T)).code, 0);
  assert.equal(last().argv.includes('--no-lazy-fetch'), false, 'add is a write');
  direct(dir, 'git', 'reset', '-q');
  /* difftool, mergetool and help run the repository's tool commands: the control runs them, Vc starts nothing */
  for (const [c, m] of [[['difftool', '-y'], 'difftool'], [['difftool', 'HEAD~1', '--', 'a.txt'], 'difftool'], [['help', 'log'], 'man']] as const) {
    clear(); direct(dir, 'git', ...c);
    assert.ok(fired().includes(m), `the control: plain git ${c.join(' ')} runs the repository's ${m} command`);
  }
  /* a conflicted merge for mergetool */
  direct(dir, 'git', 'commit', '-q', '-am', 'third');
  direct(dir, 'git', 'checkout', '-q', '-b', 'side', 'HEAD~1'); write(path.join(dir, 'a.txt'), 'side\n'); direct(dir, 'git', 'commit', '-q', '-am', 'side');
  direct(dir, 'git', 'checkout', '-q', 'main'); direct(dir, 'git', 'merge', '-q', 'side');
  clear(); direct(dir, 'git', 'mergetool');
  assert.ok(fired().includes('mergetool'), 'the control: plain git mergetool runs the repository\'s merge tool');
  const n = proc.calls.length;
  for (const c of [['difftool', '-y'], ['difftool', 'HEAD~1', '--', 'a.txt'], ['mergetool'], ['help', 'log'], ['instaweb'], ['web--browse', 'x']]) {
    clear();
    await assert.rejects(Vc.run(g, c), (e: unknown) => new RegExp(`git ${c[0]} is not run here`).test(Ed.errorText(e)));
    assert.deepEqual(fired(), []);
  }
  assert.equal(proc.calls.length, n, 'none of them started a child');
});

test('a repository\'s signature programs never run for a read, for any signature format; the user\'s own one does', async () => {
  const dir = mkdir('signed'), marks = mkdir('sig-marks'), bin = mkdir('sig-bin');
  const fired = () => fs.readdirSync(marks).sort();
  const clear = () => { for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f)); };
  direct(dir, 'git', 'init', '-q', '-b', 'main');
  write(path.join(dir, 'a.txt'), 'one\n');
  direct(dir, 'git', 'add', 'a.txt'); direct(dir, 'git', 'commit', '-q', '-m', 'first');
  /* commits whose signature header git hands to the format's program to verify */
  const tree = direct(dir, 'git', 'rev-parse', 'HEAD^{tree}').trim();
  const signed = (kind: string) => execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: dir, encoding: 'utf8',
    input: `tree ${tree}\nauthor T <t@x> 1 +0000\ncommitter T <t@x> 1 +0000\ngpgsig -----BEGIN ${kind}-----\n xx\n -----END ${kind}-----\n\nsigned\n`,
  }).trim();
  const commits: Record<string, string> = { openpgp: signed('PGP SIGNATURE'), ssh: signed('SSH SIGNATURE'), x509: signed('SIGNED MESSAGE') };
  direct(dir, 'git', 'update-ref', 'refs/heads/main', commits.openpgp);
  for (const [k, n] of [['gpg.program', 'openpgp'], ['gpg.ssh.program', 'ssh'], ['gpg.x509.program', 'x509']]) direct(dir, 'git', 'config', k, marker(bin, marks, n));
  write(path.join(dir, '.git/allowed-signers'), '');
  direct(dir, 'git', 'config', 'gpg.ssh.allowedSignersFile', path.join(dir, '.git/allowed-signers'));
  direct(dir, 'git', 'config', 'log.showSignature', 'true');
  /* The control: plain git verifies each with the repository's program. */
  for (const [n, c] of Object.entries(commits)) {
    clear(); direct(dir, 'git', 'log', '--format=%G?', '-1', c);
    assert.deepEqual(fired(), [n], `plain git log --format=%G? runs the repository's ${n} program`);
  }
  clear(); direct(dir, 'git', 'log', '-1');
  assert.deepEqual(fired(), ['openpgp'], 'plain git log runs it for log.showSignature');
  const g = Vc.repo(dir);
  for (const c of [...Object.values(commits).map(c => ['log', '--format=%G?', '-1', c]), ['log', '-1'], ['show']]) {
    clear();
    const r = await Vc.run(g, c, T);
    assert.equal(r.code, 0, `${c.join(' ')}: ${r.err}`);
    assert.deepEqual(fired(), [], `git ${c.join(' ')} through Vc runs no signature program of the repository's`);
  }
  /* The user's own program (global scope) is the one a read runs. */
  const mine = marker(bin, marks, 'user-gpg');
  write(path.join(HOME, '.gitconfig'), `[gpg]\n\tprogram = ${mine}\n`);
  try {
    clear();
    await Vc.run(g, ['log', '--format=%G?', '-1', commits.openpgp], T);
    assert.deepEqual(fired(), ['user-gpg']);
    for (const s of [`gpg.program=${mine}`, `gpg.openpgp.program=${mine}`, 'gpg.ssh.program=ssh-keygen', 'gpg.x509.program=gpgsm']) assert.ok(last().argv.includes(s), s);
  } finally { fs.rmSync(path.join(HOME, '.gitconfig')); }
});

test('a read in a partial clone fetches nothing, whatever transport the repository allows', async () => {
  const src = mkdir('pc-src'), marks = mkdir('pc-marks'), dir = path.join(root, 'pc-clone'), mark = path.join(marks, 'fetch');
  direct(src, 'git', 'init', '-q', '-b', 'main');
  write(path.join(src, 'a.txt'), 'one\n'); direct(src, 'git', 'add', 'a.txt'); direct(src, 'git', 'commit', '-q', '-m', 'first');
  write(path.join(src, 'a.txt'), 'one\ntwo\n'); direct(src, 'git', 'commit', '-q', '-am', 'second');
  direct(src, 'git', 'config', 'uploadpack.allowFilter', 'true');
  direct(root, 'git', 'clone', '-q', '--no-local', '--filter=blob:none', `file://${src}`, dir);
  /* HEAD~1's a.txt is not in the clone: reading it would fetch it from origin, whose transport now runs a
     command (protocol.ext.allow beats protocol.allow=never). */
  direct(dir, 'git', 'config', 'remote.origin.url', `ext::${sh} -c touch% ${mark}`);
  direct(dir, 'git', 'config', 'protocol.ext.allow', 'always');
  direct(dir, 'git', 'show', 'HEAD~1');
  assert.ok(fs.existsSync(mark), 'the control: plain git show fetches, running the transport');
  const g = Vc.repo(dir);
  for (const c of [['show', 'HEAD~1'], ['log', '-p'], ['diff', 'HEAD~1', 'HEAD'], ['cat-file', '-p', 'HEAD~1:a.txt']]) {
    fs.rmSync(mark, { force: true });
    await Vc.run(g, c, T);   // it fails: the object is not there
    assert.equal(fs.existsSync(mark), false, `git ${c.join(' ')} through Vc fetches nothing`);
  }
});

test('a read in a superproject runs nothing a submodule\'s own configuration names, and shows the submodule by its commit', async () => {
  const sub = mkdir('sm-sub'), sup = mkdir('sm-sup'), marks = mkdir('sm-marks'), bin = mkdir('sm-bin');
  const fired = () => fs.readdirSync(marks).sort();
  const clear = () => { for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f)); };
  direct(sub, 'git', 'init', '-q', '-b', 'main');
  write(path.join(sub, 'f'), 'a\n'); write(path.join(sub, '.gitattributes'), '* filter=evil diff=evil\n');
  direct(sub, 'git', 'add', '-A'); direct(sub, 'git', 'commit', '-q', '-m', 'one');
  direct(sup, 'git', 'init', '-q', '-b', 'main');
  direct(sup, 'git', '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 's');
  direct(sup, 'git', 'commit', '-q', '-m', 'the submodule'); direct(sup, 'git', 'tag', 'v1');
  const s = path.join(sup, 's');
  direct(s, 'git', 'config', 'filter.evil.clean', marker(bin, marks, 'clean', 'exec cat'));
  direct(s, 'git', 'config', 'diff.evil.textconv', marker(bin, marks, 'textconv', 'exec cat "$1"'));
  /* Whether git reads a file through its clean filter must not hang on timing. A file whose size differs from its
     index entry's is changed without reading it, and is read only while the entry is racily clean (its time that
     of the index's own write, which the kernel's coarse clock makes so most of the time, not always). So the
     changed file keeps its committed size and gets a time long past, a new one each time (a commit takes the
     last into its entry), so never the entry's and never racy: git sees the time differ, the size not, and
     compares the content, through the clean filter, every time. */
  let when = 1e9;
  const touch = () => { when += 1; fs.utimesSync(path.join(s, 'f'), when, when); };
  const g = Vc.repo(sup);
  /* The submodule's file changed, its commit not moved: describe --dirty and --broken compare its work tree (a
     moved commit would end the comparison first), and no switch keeps them out of it, so they are refused. */
  write(path.join(s, 'f'), 'b\n');
  for (const a of ['--dirty', '--broken']) {
    touch(); clear(); direct(sup, 'git', 'describe', a);
    assert.ok(fired().includes('clean'), `the control: plain git describe ${a} runs the submodule's clean filter`);
    clear();
    await assert.rejects(Vc.run(g, ['describe', a]), (e: unknown) => new RegExp(`${a} is not given to git`).test(Ed.errorText(e)));
    assert.deepEqual(fired(), []);
  }
  touch(); clear();
  const d = await Vc.run(g, ['describe', '--tags'], T);
  assert.equal(d.code, 0, d.err); assert.equal(d.out, 'v1\n');
  assert.deepEqual(fired(), [], 'describe through Vc runs nothing of the submodule\'s');
  /* the submodule moves on a commit, and its file is changed again */
  direct(s, 'git', '-c', 'filter.evil.clean=', 'commit', '-q', '-am', 'two');
  write(path.join(s, 'f'), 'c\n');
  direct(sup, 'git', 'config', 'diff.submodule', 'diff');
  touch(); clear(); direct(sup, 'git', 'status', '--porcelain=v2');
  assert.ok(fired().includes('clean'), 'the control: plain git status runs the submodule\'s clean filter');
  for (const c of [['status', '--porcelain=v2'], ['diff'], ['diff-files', '-p'], ['diff-index', '-p', 'HEAD'], ['log', '-p'], ['show']]) {
    touch(); clear();
    const r = await Vc.run(g, c, T);
    assert.equal(r.code, 0, `${c[0]}: ${r.err}`);
    assert.deepEqual(fired(), [], `git ${c[0]} through Vc runs nothing of the submodule's`);
    if (c[0] === 'status') assert.match(r.out, /^1 \.M SC\.\. .* s$/m, 'the submodule\'s new commit shows');
    if (c[0] === 'diff') assert.match(r.out, /^\+Subproject commit [0-9a-f]{40}$/m, 'by its commit, though diff.submodule says diff');
  }
});

test('a repository\'s merge drivers never run for a read: a remerge diff merges with none of them', async () => {
  const dir = mkdir('remerge'), marks = mkdir('rm-marks'), bin = mkdir('rm-bin');
  const fired = () => fs.readdirSync(marks).sort();
  const clear = () => { for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f)); };
  direct(dir, 'git', 'init', '-q', '-b', 'main');
  write(path.join(dir, '.gitattributes'), 'f merge=evil\n'); write(path.join(dir, 'f'), 'base\n');
  direct(dir, 'git', 'add', '-A'); direct(dir, 'git', 'commit', '-q', '-m', 'base');
  /* a merge commit whose parents conflict on f: showing it again merges them again */
  direct(dir, 'git', 'checkout', '-q', '-b', 'side'); write(path.join(dir, 'f'), 'side\n'); direct(dir, 'git', 'commit', '-q', '-am', 'side');
  direct(dir, 'git', 'checkout', '-q', 'main'); write(path.join(dir, 'f'), 'main\n'); direct(dir, 'git', 'commit', '-q', '-am', 'main');
  direct(dir, 'git', 'merge', '-q', 'side'); write(path.join(dir, 'f'), 'merged\n'); direct(dir, 'git', 'add', 'f'); direct(dir, 'git', 'commit', '-q', '-m', 'merge');
  direct(dir, 'git', 'config', 'merge.evil.driver', `${marker(bin, marks, 'merge-driver')} %O %A %B`);
  /* The control: plain git runs the repository's driver for --remerge-diff, and for -m under log.diffMerges. */
  clear(); direct(dir, 'git', 'show', '--remerge-diff');
  assert.deepEqual(fired(), ['merge-driver'], 'plain git show --remerge-diff runs the repository\'s merge driver');
  direct(dir, 'git', 'config', 'log.diffMerges', 'remerge');
  clear(); direct(dir, 'git', 'log', '-p', '-m', '-1');
  assert.deepEqual(fired(), ['merge-driver'], 'so does plain git log -p -m with log.diffMerges=remerge');
  const g = Vc.repo(dir);
  for (const c of [['show', '--remerge-diff'], ['log', '-p', '--remerge-diff', '-1'], ['log', '-p', '--diff-merges=remerge', '-1'], ['log', '-p', '-m', '-1'], ['show', '-m']]) {
    clear();
    const r = await Vc.run(g, c, T);
    assert.equal(r.code, 0, `${c.join(' ')}: ${r.err}`);
    assert.deepEqual(fired(), [], `git ${c.join(' ')} through Vc runs no merge driver of the repository's`);
    assert.match(r.out, /^remerge CONFLICT \(content\): Merge conflict in f$/m, 'and the remerge diff is there');
    assert.ok(last().argv.includes('merge.evil.driver='), 'the driver is emptied');
  }
});

test('a name that is no builtin runs no alias of the repository\'s', async () => {
  const dir = mkdir('aliased'), marks = mkdir('al-marks');
  direct(dir, 'git', 'init', '-q', '-b', 'main');
  write(path.join(dir, 'a.txt'), 'one\n'); direct(dir, 'git', 'add', 'a.txt'); direct(dir, 'git', 'commit', '-q', '-m', 'first');
  for (const n of ['zz', 'status', 'st']) direct(dir, 'git', 'config', `alias.${n}`, `!: > ${path.join(marks, n)}`);
  const fired = () => fs.readdirSync(marks).sort();
  direct(dir, 'git', 'zz'); direct(dir, 'git', 'st');
  assert.deepEqual(fired(), ['st', 'zz'], 'the control: plain git runs the shell aliases');
  for (const f of fired()) fs.rmSync(path.join(marks, f));
  const g = Vc.repo(dir);
  for (const n of ['zz', 'st']) {
    const r = await Vc.run(g, [n], T);
    assert.notEqual(r.code, 0, `${n} is refused by git`); assert.match(r.err, /expansion of alias '\w+' failed/);
    assert.ok(last().argv.includes(`alias.${n}=`));
  }
  const s = await Vc.run(g, ['status', '--porcelain=v2'], T);
  assert.equal(s.code, 0, s.err);
  assert.deepEqual(fired(), [], 'nothing ran; the builtin status is git\'s own, alias or not');
});

test('jj settings a repository brings are refused, from its own workspaces and others; no tool of theirs runs', async () => {
  const dir = mkdir('hostile-jj'), marks = mkdir('jj-marks'), bin = mkdir('jj-bin');
  direct(dir, 'jj', 'git', 'init');
  write(path.join(dir, 'f.txt'), 'one\n');
  direct(dir, 'jj', 'status');
  const second = path.join(root, 'hostile-jj-second');
  direct(dir, 'jj', 'workspace', 'add', second);
  assert.ok(fs.lstatSync(path.join(second, '.jj/repo')).isFile(), 'a secondary workspace names the store in .jj/repo');
  write(path.join(dir, 'f.txt'), 'one\ntwo\n');
  const sh = process.env.PATH!.split(':').map(d => path.join(d, 'sh')).find(p => fs.existsSync(p))!;
  const evil = (name: string) => { const p = path.join(bin, name); write(p, `#!${sh}\n: > ${path.join(marks, name)}\n`); fs.chmodSync(p, 0o755); return p; };
  const planted = path.join(dir, '.jj/repo/config.toml');
  write(planted, `[ui]\npager = ["${evil('pager')}"]\ndiff-formatter = ["${evil('diff')}", "$left", "$right"]\n`);
  const fired = () => fs.readdirSync(marks).sort();
  /* The control, on a copy: plain jj adopts the settings and runs their diff tool. */
  const copy = path.join(root, 'hostile-jj-copy');
  fs.cpSync(dir, copy, { recursive: true, verbatimSymlinks: true });
  direct(copy, 'jj', 'diff');
  assert.deepEqual(fired(), ['diff'], 'plain jj runs the repository\'s diff tool');
  assert.ok(fs.lstatSync(path.join(copy, '.jj/repo/config.toml')).isSymbolicLink(), 'and has moved them beside the user\'s config');
  fs.rmSync(path.join(marks, 'diff'));
  const j = Vc.repo(dir), n = proc.calls.length;
  const refusal = (file: string) => (e: unknown) => Ed.errorText(e).includes(`${file} is jj settings the repository brings, which jj would take as yours for good (they may run programs). Look at them, then run jj there once in a terminal to take them`);
  await assert.rejects(Vc.run(j, ['status'], T), refusal(planted));
  assert.deepEqual(Vc.repo(second), { vcs: 'jj', root: second });
  await assert.rejects(Vc.run(Vc.repo(second), ['status'], T), (e: unknown) => /jj not run in .*hostile-jj-second: .*\.jj\/repo\/config\.toml is jj settings/.test(Ed.errorText(e)), 'from the secondary workspace too');
  /* the workspace's own file counts the same */
  const ws = path.join(second, '.jj/workspace-config.toml');
  write(ws, '[ui]\ncolor = "always"\n');
  fs.renameSync(planted, planted + '.aside');
  await assert.rejects(Vc.run(Vc.repo(second), ['status'], T), refusal(ws));
  fs.renameSync(planted + '.aside', planted); fs.rmSync(ws);
  /* -R would point jj at a repository not looked at */
  await assert.rejects(Vc.run(Vc.repo(jjDir), ['status', '-R', dir]), (e: unknown) => /-R is not given to jj/.test(Ed.errorText(e)));
  await assert.rejects(Vc.run(Vc.repo(jjDir), ['status', `-R${dir}`]), (e: unknown) => /-R.* is not given to jj/.test(Ed.errorText(e)));
  await assert.rejects(Vc.run(Vc.repo(jjDir), ['status', `--repository=${dir}`]), (e: unknown) => /--repository=.* is not given to jj/.test(Ed.errorText(e)));
  assert.equal(proc.calls.length, n, 'no jj ran');
  assert.ok(fs.lstatSync(planted).isFile(), 'the settings are where they were, not taken');
  /* The user takes them by running jj there once; then Vc runs, and still no tool of theirs. */
  direct(dir, 'jj', 'status');
  assert.ok(fs.lstatSync(planted).isSymbolicLink());
  for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f));
  for (const c of [['status'], ['diff'], ['log', '-p'], ['show']]) {
    const x = await Vc.run(j, c, T);
    assert.equal(x.code, 0, `${c[0]}: ${x.err}`);
    if (c[0] === 'diff') assert.match(x.out, /^diff --git a\/f\.txt b\/f\.txt$/m, 'git\'s diff format');
  }
  assert.deepEqual(fired(), [], 'no tool of the repository\'s ran');
});

test('a repository git refuses as unsafe is shown as such, not retried, with safe.directory never set', async () => {
  const g = Vc.repo(gitDir), n = proc.calls.length;
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  process.env.LC_ALL = 'de_DE.UTF-8'; process.env.LANGUAGE = 'de';
  try {
    await assert.rejects(Vc.run(g, ['status'], T), (e: unknown) => /git refuses .* as unsafe: it belongs to another user \(safe\.directory\)/.test(Ed.errorText(e)));
  } finally { delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER; delete process.env.LC_ALL; delete process.env.LANGUAGE; }
  const calls = callsSince(n);
  assert.equal(calls.filter(c => c.argv.includes('status')).length, 1, 'one status, no retry');
  assert.equal(calls.some(c => c.argv.some(a => /safe\.directory/.test(a))), false);
  assert.match(lastMessage(), /as unsafe/);
  assert.match(vcLog(), /detected dubious ownership/);
});

test('nothing starts while the image replays, at once or after awaits in the same turn, nor without host.proc', async () => {
  const g = Vc.repo(gitDir), j = Vc.repo(jjDir), n = proc.calls.length;
  const ps: Promise<unknown>[] = [];
  Ed.proc.replay(() => {
    ps.push(Vc.run(g, ['status']), Vc.run(j, ['status']), Vc.start(g, ['commit', '-m', 'x']));
    ps.push((async () => { await null; await Promise.resolve(); return Vc.run(g, ['log']); })());
  });
  for (const p of ps) await assert.rejects(p, (e: unknown) => /while the image replays/.test(Ed.errorText(e)));
  assert.equal(proc.calls.length, n, 'no child started');
  host.proc = undefined;
  try { await assert.rejects(Vc.run(g, ['status']), (e: unknown) => /No processes here/.test(Ed.errorText(e))); }
  finally { host.proc = proc; }
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await Vc.run(g, ['status'], T)).code, 0, 'after the replay, it runs');
});

test('*vc-process*: each child\'s argv, its error output and how it ended, bounded', async () => {
  const g = Vc.repo(gitDir);
  const r = await Vc.run(g, ['show', 'no-such-revision'], T);
  assert.equal(r.code, 128);
  const b = Ed.getBuffer('*vc-process*'), id = last().id;
  assert.ok(b.readOnly); assert.equal(b.modified, false); assert.deepEqual(b.undo, []);
  assert.ok(vcLog().includes(`$ git --no-pager --no-lazy-fetch -c core.fsmonitor=false -c core.pager=cat -c diff.external= -c alias.show= -c core.hooksPath=/dev/null`));
  assert.ok(vcLog().includes(`  [${id}] in ${gitDir}\n`));
  assert.match(vcLog(), new RegExp(`fatal: ambiguous argument 'no-such-revision'[^]*\\n  \\[${id}\\] exit 128\\n$`));
  await Vc.run(g, ['rev-parse', '--verify', "it's a b"], T);
  assert.ok(vcLog().includes(` rev-parse --verify 'it'\\''s a b'\n`), 'an argument is quoted where a shell would need it');
  for (let i = 0; i < 30; i++) await Vc.run(g, ['rev-parse', '--verify', 'x'.repeat(10000)], T);
  const t = vcLog();
  assert.ok(t.length <= 256 * 1024, `kept to 256 KiB (${t.length})`);
  assert.ok(t.startsWith('$ ') || t.startsWith('  ['), 'from a line\'s start');
});
