// Diffs as files and hunks (src/vc-diff.ts): VcDiff.parse over what git and jj print, and VcDiff.patch's partial
// patches. The property: for random files (changed, added, deleted, renamed, mode changes, binary, lines that
// read like diff syntax, CR, no newline at the end) and any pick of files, hunks and lines, the patch passes
// `git apply --cached --check`, and applied (forwards to stage, --reverse to unstage) leaves in the index exactly
// what the pick means; reversed onto the work tree (`git apply --reverse`, discarding) it leaves there what the
// pick means. Real git through Vc.run in throwaway repositories, under a throwaway HOME whose git
// configuration changes the diff's shape (colour, no prefixes, blank context lines).
// fast-check is a dev dependency pinned in tools/package-lock.json (R15.1); NODE_PATH names its node_modules.
// VCDIFF_RUNS raises the run count; VCDIFF_SEED and VCDIFF_PATH replay a failure fast-check reports.
// Run: NODE_PATH=tools/node_modules node --test test/vc-diff.test.mts
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startEdwin, type Edwin, type NodeHost } from './headless.mts';
import { fakeProc, type FakeProc } from './fake-proc.mts';

const require = createRequire(import.meta.url);
const fc = require('fast-check'); // any: fast-check's types are not resolvable from edwin/ (it lives in tools/node_modules)

const ed = await startEdwin();
const { Ed } = ed;
const g = globalThis as unknown as { Vc: Edwin; VcDiff: Edwin };
const { Vc, VcDiff } = g;
const RUNS = { numRuns: Number(process.env.VCDIFF_RUNS || 100), ...(process.env.VCDIFF_SEED ? { seed: Number(process.env.VCDIFF_SEED), path: process.env.VCDIFF_PATH } : {}) };
const T = { timeout: 20000, maxBytes: 16 * 1024 * 1024 };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-diff-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The user's git configuration, which would change what git diff prints but for VcDiff.gitArgs. */
fs.writeFileSync(path.join(HOME, '.gitconfig'), [
  '[color]', '\tui = always', '\tdiff = always',
  '[diff]', '\tnoprefix = true', '\tmnemonicPrefix = true', '\tsuppressBlankEmpty = true', '\trelative = true',
  '\tcontext = 0', '\tinterHunkContext = 10',
  '[core]', '\tquotePath = true', '[init]', '\tdefaultBranch = main', '',
].join('\n'));
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  JJ_USER: 'Test', JJ_EMAIL: 'test@example.invalid',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'JJ_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS']) delete process.env[k];
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const proc: FakeProc = fakeProc();
(ed.host as NodeHost & { proc?: FakeProc }).proc = proc;

/* git run directly, for the fixtures and the checks: its output as bytes; a failure throws */
const git = (cwd: string, args: string[], input?: Buffer | string) =>
  execFileSync('git', args, { cwd, input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
let n = 0;
const repoDir = () => { const d = path.join(root, `r${n++}`); fs.mkdirSync(d); git(d, ['init', '-q']); return d; };
const diffOf = async (dir: string, cached: boolean) => {
  const r = await Vc.run({ vcs: 'git', root: dir }, ['diff', ...(cached ? ['--cached'] : []), ...VcDiff.gitArgs, '--binary'], T);
  assert.equal(r.code, 0, r.err);
  return r.out as string;
};
const errorOf = (f: () => unknown) => { try { f(); } catch (e) { return Ed.errorText(e) as string; } return null; };

/* ---------- parse ---------- */

test('parse: hunks read by their counts, lines that look like diff syntax, quoted names, renames, modes, binary', () => {
  const text = [
    'diff --git a/x.txt b/x.txt', 'index 1111111..2222222 100644', '--- a/x.txt', '+++ b/x.txt',
    '@@ -1,4 +1,4 @@ fn', '--- x', '+++ y', '', ' @@ -1 +1 @@', '-diff --git a/q b/q', '+\\ not a marker',
    '@@ -9 +9 @@', '-z', '\\ No newline at end of file', '+z',
    'diff --git "a/\\303\\251 \\"q\\".txt" "b/\\303\\251 \\"q\\".txt"', 'new file mode 100755', 'index 0000000..3333333',
    '--- /dev/null', '+++ "b/\\303\\251 \\"q\\".txt"', '@@ -0,0 +1 @@', '+new',
    'diff --git a/old name b/new name', 'similarity index 100%', 'rename from old name', 'rename to new name',
    'diff --git a/m b/m', 'old mode 100644', 'new mode 100755',
    'diff --git a/sp ace b/sp ace', 'deleted file mode 100644', 'index 4444444..0000000',
    'diff --git a/bin b/bin', 'index 5555555..6666666 100644', 'Binary files a/bin and b/bin differ',
    'diff --cc conflicted.txt', 'index 7,8..9', '@@@ -1,1 -1,1 +1,5 @@@', '++<<<<<<< ours', '* Unmerged path other.txt', '',
  ].join('\n');
  const fs_ = VcDiff.parse(text);
  assert.equal(fs_.length, 8);
  const [x, e, r, m, d, b, c, u] = fs_;
  assert.deepEqual([x.oldPath, x.newPath, x.status, x.oldMode, x.newMode, x.binary], ['x.txt', 'x.txt', 'modified', '100644', '100644', false]);
  assert.equal(x.hunks.length, 2);
  assert.deepEqual(x.hunks[0], { header: '@@ -1,4 +1,4 @@ fn', oldStart: 1, oldLines: 4, newStart: 1, newLines: 4,
    lines: ['--- x', '+++ y', ' ', ' @@ -1 +1 @@', '-diff --git a/q b/q', '+\\ not a marker'] }, 'an empty line is a blank context line');
  assert.deepEqual(x.hunks[1], { header: '@@ -9 +9 @@', oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: ['-z', '\\ No newline at end of file', '+z'] });
  assert.deepEqual([e.oldPath, e.newPath, e.status, e.newMode], [null, 'é "q".txt', 'added', '100755']);
  assert.deepEqual([r.oldPath, r.newPath, r.status, r.hunks.length], ['old name', 'new name', 'renamed', 0]);
  assert.deepEqual([m.oldPath, m.status, m.oldMode, m.newMode], ['m', 'modified', '100644', '100755']);
  assert.deepEqual([d.oldPath, d.newPath, d.status, d.oldMode], ['sp ace', null, 'deleted', '100644']);
  assert.deepEqual([b.newPath, b.binary, b.hunks.length], ['bin', true, 0]);
  assert.deepEqual([c.newPath, c.status, c.header.length], ['conflicted.txt', 'unmerged', 4]);
  assert.deepEqual([u.oldPath, u.newPath, u.status, u.hunks.length], ['other.txt', 'other.txt', 'unmerged', 0]);
  assert.equal(fs_.map((f: Edwin) => f.text).join(''), text, 'each file\'s text is its part of the diff, as given');
  assert.deepEqual(VcDiff.parse(''), []);
  for (const bad of ['hello\n', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n-a\n', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n',
    'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\nstray\n', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n?b\n'])
    assert.match(errorOf(() => VcDiff.parse(bad))!, /Not a diff git gives/, JSON.stringify(bad));
});

test('VcDiff.gitArgs keep the user\'s configuration from changing the diff: colour, prefixes', async () => {
  const dir = repoDir();
  fs.writeFileSync(path.join(dir, 'a b.txt'), 'one\n'); git(dir, ['add', '.']);
  fs.writeFileSync(path.join(dir, 'a b.txt'), 'two\n');
  const plain = git(dir, ['diff']).toString();
  assert.match(plain, /\x1b\[/, 'the control: the user\'s configuration colours the diff');
  assert.match(plain, /diff --git a b\.txt a b\.txt/, 'and drops the prefixes');
  const [f] = VcDiff.parse(await diffOf(dir, false));
  assert.deepEqual([f.oldPath, f.newPath, f.hunks[0].lines], ['a b.txt', 'a b.txt', ['-one', '+two']]);
});

test('VcDiff.gitArgs keep the user\'s configuration from changing the diff: context lines, hunks joined', async () => {
  const dir = repoDir();
  const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  fs.writeFileSync(path.join(dir, 'f'), lines.join('\n') + '\n'); git(dir, ['add', '.']);
  lines[2] = 'L3'; lines[3] = 'L4'; lines[20] = 'L21';
  fs.writeFileSync(path.join(dir, 'f'), lines.join('\n') + '\n');
  const plain = git(dir, ['diff', '--no-color']).toString();
  assert.match(plain, /^@@ -3,2 \+3,2 @@/m, 'the control: diff.context = 0 drops the context lines');
  const files = VcDiff.parse(await diffOf(dir, false));
  assert.deepEqual(files[0].hunks.map((h: Edwin) => h.lines.filter((l: string) => l[0] === ' ').length), [5, 6],
    'three lines of context each side (line 3 has two above it), and two hunks (diff.interHunkContext would join them)');
  for (const picks of [[{ file: 0, hunk: 0, lines: [files[0].hunks[0].lines.indexOf('+L3')] }], [{ file: 0, hunk: 1 }], [{ file: 0 }]])
    git(dir, ['apply', '--cached', '--check'], VcDiff.patch(files, picks, false));
});

test('parse: jj diff --git', async () => {
  const dir = path.join(root, 'jj'); fs.mkdirSync(dir);
  execFileSync('jj', ['git', 'init'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\n');
  execFileSync('jj', ['new'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nc');
  fs.writeFileSync(path.join(dir, 'n.txt'), 'n\n');
  const r = await Vc.run({ vcs: 'jj', root: dir }, ['diff', '--git'], T);
  assert.equal(r.code, 0, r.err);
  const files = VcDiff.parse(r.out);
  const f = files.find((x: Edwin) => x.newPath === 'f.txt'), a = files.find((x: Edwin) => x.newPath === 'n.txt');
  assert.deepEqual(f.hunks.map((h: Edwin) => h.lines), [[' a', '-b', '+c', '\\ No newline at end of file']]);
  assert.deepEqual([a.status, a.oldPath, a.hunks[0].lines], ['added', null, ['+n']]);
});

/* ---------- patch: examples ---------- */

test('patch: nothing picked is null; a pick out of range, a copy staged in part and a binary file without its data are refused', () => {
  const [f] = VcDiff.parse('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n');
  assert.equal(VcDiff.patch([f], []), null);
  assert.equal(VcDiff.patch([f], [{ file: 0, hunk: 0, lines: [2] }]), null, 'context lines picked mean nothing');
  for (const p of [{ file: 1 }, { file: 0, hunk: 1 }, { file: 0, hunk: 0, lines: [3] }, { file: -1 }])
    assert.match(errorOf(() => VcDiff.patch([f], [p]))!, /no such/);
  const [c] = VcDiff.parse('diff --git a/x b/y\nsimilarity index 90%\ncopy from x\ncopy to y\n--- a/x\n+++ b/y\n@@ -1 +1,2 @@\n a\n+b\n+c\n'.replace('+1,2', '+1,3'));
  assert.equal(c.status, 'copied');
  assert.match(errorOf(() => VcDiff.patch([c], [{ file: 0, hunk: 0, lines: [1] }]))!, /copy's changes/);
  assert.match(VcDiff.patch([c], [{ file: 0, hunk: 0, lines: [1] }], true), /^diff --git a\/y b\/y\n--- a\/y\n\+\+\+ b\/y\n@@ -1,2 \+1,3 @@\n a\n\+b\n c\n$/);
  const [b] = VcDiff.parse('diff --git a/b b/b\nindex 1..2 100644\nBinary files a/b and b/b differ\n');
  assert.match(errorOf(() => VcDiff.patch([b], [{ file: 0 }]))!, /--binary/);
});

test('a name that is not UTF-8 is shown one character per byte and can be picked only whole', () => {
  const text = 'diff --git "a/\\377x" "b/\\377x"\n--- "a/\\377x"\n+++ "b/\\377x"\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n';
  const [f] = VcDiff.parse(text);
  assert.deepEqual([f.oldPath, f.notUtf8], ['\u00ffx', true]);
  assert.match(errorOf(() => VcDiff.patch([f], [{ file: 0, hunk: 0, lines: [1] }], true))!, /not UTF-8/);
  assert.match(errorOf(() => VcDiff.patch([f], [{ file: 0, hunk: 0, lines: [0] }]))!, /not UTF-8/);
  assert.equal(VcDiff.patch([f], [{ file: 0 }]), text, 'the whole file is as git printed it');
  assert.equal(VcDiff.parse('diff --git "a/\\303\\251" "b/\\303\\251"\nold mode 100644\nnew mode 100755\n')[0].notUtf8, false);
});

test('patch: a pick that would leave a line with no newline before another is refused', () => {
  const [f] = VcDiff.parse('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n');
  assert.match(errorOf(() => VcDiff.patch([f], [{ file: 0, hunk: 0, lines: [2] }]))!, /no newline before another/);
  assert.match(VcDiff.patch([f], [{ file: 0, hunk: 0, lines: [0] }]), /@@ -1,1 \+0,0 @@\n-a\n\\ No newline at end of file\n$/);
  assert.match(errorOf(() => VcDiff.patch([f], [{ file: 0, hunk: 0, lines: [0] }], true))!, /no newline before another/);
});

/* ---------- patch: the property ---------- */

/* Lines that read like diff syntax once a prefix is put before them, blank ones, a CR, and lines that tell
   places apart, so a file has several hunks. */
const SYNTAX = ['-- x', '++ y', '@@ -1 +1 @@', 'diff --git a/x b/x', '\\ No newline at end of file', '', 'x\r', ' lead', '--- a/z', '+++ b/z', '\t tab'];
const line = fc.oneof({ weight: 1, arbitrary: fc.constantFrom(...SYNTAX) }, { weight: 3, arbitrary: fc.nat(60).map((k: number) => `line ${k}`) });
const NAMES = ['a.txt', 'b c.txt', 'é.txt', 'q"t.txt', 'd/x.txt', 'tab\tx.txt', 'back\\slash.txt', 'z.txt'];
const KINDS = ['modify', 'modify', 'add', 'delete', 'mode', 'binary', 'rename'];
const fileSpec = fc.record({
  kind: fc.constantFrom(...KINDS),
  old: fc.array(line, { maxLength: 40, size: 'medium' }), oldEol: fc.boolean(),
  /* per old line, and one more for the end: keep it, drop it, change it, or add a line before it */
  edits: fc.array(fc.constantFrom('keep', 'keep', 'keep', 'keep', 'keep', 'keep', 'del', 'chg', 'ins'), { minLength: 41, maxLength: 41 }),
  extra: line, newEol: fc.boolean(), alsoContent: fc.boolean(), bin: fc.uint8Array({ minLength: 1, maxLength: 64 }),
});
const scenario = fc.tuple(fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 4 }), fc.array(fileSpec, { minLength: 4, maxLength: 4 }), fc.integer());

type Spec = { kind: string; old: string[]; oldEol: boolean; edits: string[]; extra: string; newEol: boolean; alsoContent: boolean; bin: Uint8Array };
const textOf = (ls: string[], eol: boolean) => (ls.length ? ls.join('\n') + (eol ? '\n' : '') : '');
function newLines(s: Spec): string[] {
  const out: string[] = [];
  s.old.forEach((l, i) => {
    const e = s.edits[i];
    if (e === 'ins') out.push(s.extra + ' ins', l);
    else if (e === 'chg') out.push(l + ' chg');
    else if (e !== 'del') out.push(l);
  });
  if (s.edits[40] === 'ins') out.push(s.extra);
  return out;
}
/* What a file of SPEC holds before and after, and its mode: null when it is not there. */
function states(s: Spec): { old: Buffer | null; new: Buffer | null; oldExec: boolean; newExec: boolean } {
  if (s.kind === 'binary') return { old: Buffer.from([0, ...s.bin]), new: Buffer.from([0, ...s.bin.map(b => b ^ 1), 7]), oldExec: false, newExec: false };
  const old = Buffer.from(textOf(s.old, s.oldEol)), changed = Buffer.from(textOf(newLines(s), s.newEol));
  switch (s.kind) {
    case 'add': return { old: null, new: changed, oldExec: false, newExec: false };
    case 'delete': return { old, new: null, oldExec: false, newExec: false };
    case 'mode': return { old, new: s.alsoContent ? changed : old, oldExec: false, newExec: true };
    case 'rename': return { old: Buffer.from(textOf([...s.old, 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'], true)), new: Buffer.from(textOf([...s.old, 'r1', 'r2', 'r3', 'r4', 'r5', 'r6 chg'], true)), oldExec: false, newExec: false };
    default: return { old, new: changed, oldExec: false, newExec: false };
  }
}
const put = (dir: string, name: string, data: Buffer | null, exec: boolean) => {
  const p = path.join(dir, name);
  if (data === null) { fs.rmSync(p, { force: true }); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data); fs.chmodSync(p, exec ? 0o755 : 0o644);
};

/* The index, path to [mode, blob] */
function index(dir: string): Map<string, [string, string]> {
  const m = new Map<string, [string, string]>();
  for (const e of git(dir, ['ls-files', '-s', '-z']).toString().split('\0').filter(Boolean)) {
    const tab = e.indexOf('\t'), [mode, blob] = e.slice(0, tab).split(' ');
    m.set(e.slice(tab + 1), [mode, blob]);
  }
  return m;
}
const blob = (dir: string, data: string | Buffer) => git(dir, ['hash-object', '--stdin'], data).toString().trim();
const content = (dir: string, rev: string) => git(dir, ['cat-file', 'blob', rev]).toString();

type HunkPick = true | Set<number>;
/* The text a pick of hunks of F leaves of TARGET, the side the patch is applied to (the old side forwards, the
   new one reversed), worked out from the target's own lines; null when it cannot be a file: a line with no
   newline before another. */
function applied(target: string, f: Edwin, pick: Map<number, HunkPick>, reverse: boolean): string | null {
  const t = target === '' ? [] : target.split('\n');
  const eols = t.map((_, i) => i < t.length - 1);
  if (t.length && t[t.length - 1] === '') { t.pop(); eols.pop(); } else if (t.length) eols[t.length - 1] = false;
  const out: [string, boolean][] = [];
  let at = 0;
  f.hunks.forEach((h: Edwin, k: number) => {
    const start = reverse ? (h.newLines ? h.newStart - 1 : h.newStart) : (h.oldLines ? h.oldStart - 1 : h.oldStart);
    for (; at < start; at++) out.push([t[at], eols[at]]);
    const hp = pick.get(k);
    h.lines.forEach((l: string, x: number) => {
      const c = l[0], eol = h.lines[x + 1]?.[0] !== '\\', picked = hp === true || !!hp && hp.has(x);
      if (c === '\\') return;
      if (c === ' ' || c === (reverse ? '+' : '-')) {
        assert.equal(t[at], l.slice(1), 'the hunk\'s line is the target\'s');
        assert.equal(eols[at], eol);
        if (c === ' ' || !picked) out.push([t[at], eols[at]]);
        at++;
      } else if (picked) out.push([l.slice(1), eol]);
    });
  });
  for (; at < t.length; at++) out.push([t[at], eols[at]]);
  if (out.slice(0, -1).some(([, eol]) => !eol)) return null;
  return out.map(([l, eol]) => l + (eol ? '\n' : '')).join('');
}

/* Picks of FILES from RND: per file nothing, the whole file, or hunks, each whole or (LINES) by random lines. */
function choose(files: Edwin[], rnd: (k: number) => number, lines: boolean) {
  const picks: Pick[] = [];
  files.forEach((f, i) => {
    const r = rnd(5);
    if (r === 0) return;
    if (r === 1 || !f.hunks.length) { if (rnd(3)) picks.push({ file: i }); return; }
    f.hunks.forEach((h: Edwin, k: number) => {
      if (!rnd(3)) return;
      if (!lines || !rnd(4)) picks.push({ file: i, hunk: k });
      else picks.push({ file: i, hunk: k, lines: h.lines.map((_: string, x: number) => x).filter(() => rnd(2)) });
    });
  });
  return picks;
}
function mulberry(seed: number) {
  let a = seed >>> 0;
  return (k: number) => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % k);
  };
}

/* What the runs met, so a change to the generators that stops them making a kind of file is seen. */
const seen = new Set<string>();

/* The work tree, path to [mode, blob] */
function workTree(dir: string): Map<string, [string, string]> {
  const m = new Map<string, [string, string]>();
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (p === '.git') continue;
      if (e.isDirectory()) walk(p);
      else m.set(p, [fs.statSync(path.join(dir, p)).mode & 0o111 ? '100755' : '100644', blob(dir, fs.readFileSync(path.join(dir, p)))]);
    }
  };
  walk('');
  return m;
}

type How = 'stage' | 'unstage' | 'discard';
/* One run: the repository set up, its diff parsed and checked against the files, a pick's patch checked and
   applied, and the index (or the work tree) compared with what the pick means. Staging: the index holds the old
   files, the work tree the new ones, `git diff` is applied with `git apply --cached`. Unstaging: HEAD holds the
   old files, the index the new ones, `git diff --cached` is applied with `git apply --cached --reverse`.
   Discarding: as staging, but the patch is reversed onto the work tree, `git apply --reverse`. PICK gives the
   picks of the parsed files in place of random ones. What came of the pick: refused, no patch, or applied. */
type Pick = { file: number; hunk?: number; lines?: number[] };
async function run(names: string[], specs: Spec[], seed: number, how: How, lines: boolean, pick?: (files: Edwin[]) => Pick[]): Promise<'refused' | 'none' | 'applied'> {
  const reverse = how !== 'stage', cached = how === 'unstage', state = how === 'discard' ? workTree : index;
  const dir = repoDir();
  const files = names.map((name, i) => {
    const s = { ...specs[i] };
    if (!cached && s.kind === 'rename') s.kind = 'modify';   // a work tree has no renames against the index
    return { name, s, st: states(s), to: s.kind === 'rename' ? 'renamed/' + name : name };
  });
  for (const f of files) put(dir, f.name, f.st.old, f.st.oldExec);
  git(dir, ['add', '-A']);
  if (cached) git(dir, ['commit', '-q', '--allow-empty', '-m', 'old']);
  for (const f of files) {
    if (f.to !== f.name) put(dir, f.name, null, false);
    put(dir, f.to, f.st.new, f.st.newExec);
    if (!cached && f.s.kind === 'add') git(dir, ['add', '-N', '--', f.name]);
  }
  if (cached) git(dir, ['add', '-A']);

  const parsed = VcDiff.parse(await diffOf(dir, cached));
  const inIndex = index(dir), before = state(dir);
  /* the parse is true to the files: its hunks take each file's old text to its new one */
  const oldText = (p: string) => (cached ? content(dir, `HEAD:${p}`) : inIndex.has(p) ? content(dir, `:${p}`) : '');
  const newText = (p: string) => (cached ? content(dir, `:${p}`) : fs.readFileSync(path.join(dir, p), 'utf8'));
  for (const f of parsed) {
    seen.add(f.status);
    if (f.binary) seen.add('binary');
    if (f.oldMode && f.newMode && f.oldMode !== f.newMode) seen.add('mode');
    const spec = files.find(x => x.name === (f.oldPath ?? f.newPath) || x.to === f.newPath);
    assert.ok(spec, `a file of the scenario: ${f.oldPath} ${f.newPath}`);
    if (f.binary || !f.hunks.length) continue;
    const all = new Map<number, HunkPick>(f.hunks.map((_: Edwin, k: number) => [k, true]));
    const oldSide = f.oldPath ? oldText(f.oldPath) : '', newSide = f.newPath ? newText(f.newPath) : '';
    assert.equal(applied(reverse ? newSide : oldSide, f, all, reverse), reverse ? oldSide : newSide);
  }

  const picks = pick ? pick(parsed) : choose(parsed, mulberry(seed), lines);
  /* what the index (or the work tree) should hold after */
  const want = new Map(before);
  let refused = false;
  const byFile = new Map<number, true | Map<number, HunkPick>>();
  for (const p of picks) {
    if (p.hunk === undefined) { byFile.set(p.file, true); continue; }
    let fp = byFile.get(p.file);
    if (fp === true) continue;
    if (!fp) byFile.set(p.file, fp = new Map());
    const hp = fp.get(p.hunk);
    if (hp === true) continue;
    fp.set(p.hunk, p.lines ? new Set([...(hp || []), ...p.lines]) : true);
  }
  for (const [k, fp] of byFile) {
    const f = parsed[k];
    const every = fp === true || f.hunks.every((h: Edwin, x: number) => { const hp = fp.get(x); return hp === true || !!hp && h.lines.every((l: string, y: number) => !'+-'.includes(l[0]) || hp.has(y)); });
    if (every) {
      /* the whole file: renames, modes, creation and deletion with it */
      const [from, to] = reverse ? [f.newPath, f.oldPath] : [f.oldPath, f.newPath];
      if (from) want.delete(from);
      if (to) want.set(to, [(reverse ? f.oldMode : f.newMode) ?? '100644', how === 'stage' ? blob(dir, fs.readFileSync(path.join(dir, to))) : git(dir, ['rev-parse', `${cached ? 'HEAD' : ''}:${to}`]).toString().trim()]);
      continue;
    }
    /* lines picked that are no change (context, or none at all) mean nothing */
    if (![...(fp as Map<number, HunkPick>)].some(([x, hp]) => f.hunks[x].lines.some((l: string, y: number) => '+-'.includes(l[0]) && (hp === true || hp.has(y))))) continue;
    const p = reverse ? f.newPath ?? f.oldPath : f.oldPath ?? f.newPath;
    const target = reverse ? (f.newPath ? newText(f.newPath) : '') : (f.oldPath ? oldText(f.oldPath) : '');
    const text = applied(target, f, fp as Map<number, HunkPick>, reverse);
    seen.add(`part of ${f.status}`);
    if (text === null) { refused = true; continue; }
    /* a partial patch changes no mode: a file it creates (staged) or restores (unstaged, discarded) gets the diff's */
    const created = !reverse && f.status === 'added' || reverse && f.status === 'deleted';
    want.set(p, [created ? (reverse ? f.oldMode : f.newMode) : before.get(p)![0], blob(dir, text)]);
  }

  let patch: string | null = null;
  const err = errorOf(() => { patch = VcDiff.patch(parsed, picks, reverse); });
  if (refused) { assert.match(err ?? '', /no newline before another/, 'refused: the pick cannot be a file'); return 'refused'; }
  assert.equal(err, null, 'a pick that can be a file is not refused');
  if (patch === null) { assert.deepEqual(want, before, 'no patch: nothing of meaning was picked'); return 'none'; }
  const apply = ['apply', ...(how === 'discard' ? [] : ['--cached']), ...(reverse ? ['--reverse'] : [])];
  try { git(dir, [...apply, '--check'], patch); }
  catch (e) { assert.fail(`git apply --check refused the patch: ${(e as { stderr?: Buffer }).stderr}\n${patch}`); }
  git(dir, apply, patch);
  assert.deepEqual(state(dir), want, `the ${how === 'discard' ? 'work tree' : 'index'} holds what the pick means\n${patch}`);
  return 'applied';
}

const HOW: [How, string][] = [['stage', 'staged: git diff, git apply --cached'], ['unstage', 'unstaged: git diff --cached, git apply --cached --reverse'],
  ['discard', 'discarded: git diff, git apply --reverse onto the work tree']];
for (const [how, said] of HOW) {
  test(`a patch of any hunk subset applies with git apply --check and leaves what the pick means, ${said}`, async () => {
    await fc.assert(fc.asyncProperty(scenario, async ([names, specs, seed]: [string[], Spec[], number]) => { await run(names, specs, seed, how, false); }), RUNS);
  });
  test(`a patch of any lines of any hunks applies with git apply --check and leaves what the pick means, ${said}`, async () => {
    await fc.assert(fc.asyncProperty(scenario, async ([names, specs, seed]: [string[], Spec[], number]) => { await run(names, specs, seed, how, true); }), RUNS);
  });
}

/* Two cases the random runs meet only a few times in a hundred, made sure of. */
const spec = (kind: string, old: string[], oldEol: boolean, newEol: boolean): Spec =>
  ({ kind, old, oldEol, edits: Array(41).fill('keep'), extra: '', newEol, alsoContent: false, bin: new Uint8Array([1]) });
const lineOf = (files: Edwin[], text: string): Pick[] => [{ file: 0, hunk: 0, lines: [files[0].hunks[0].lines.indexOf(text)] }];
test('a line of a staged rename unstaged: the rename stays, the line goes back', async () => {
  const outcome = await run(['a.txt'], [spec('rename', ['one', 'two'], true, true)], 0, 'unstage', true, files => {
    assert.equal(files[0].status, 'renamed');
    return lineOf(files, '+r6 chg');
  });
  assert.equal(outcome, 'applied');
});
test('the added line after a changed last line with no newline, staged alone: refused', async () => {
  const outcome = await run(['a.txt'], [spec('modify', ['a'], false, true)], 0, 'stage', true, files => {
    assert.deepEqual(files[0].hunks[0].lines, ['-a', '\\ No newline at end of file', '+a']);
    return lineOf(files, '+a');
  });
  assert.equal(outcome, 'refused');
});

test('the random runs met every kind of file and of partial pick', () => {
  for (const k of ['modified', 'added', 'deleted', 'renamed', 'binary', 'mode', 'part of modified', 'part of added', 'part of deleted'])
    assert.ok(seen.has(k), k);
});
