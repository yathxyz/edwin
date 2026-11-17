// Conflict markers (src/vc.ts, vc-conflict-mode) in the headless runtime: git's markers as `git merge-file` writes
// them in the merge, diff3 and zdiff3 styles, and jj's in its default style as jj writes them in a throwaway
// workspace, each resolved through the mode's keys to ours, theirs and both, the result compared byte for byte
// with what git (`merge-file --ours`, `--theirs`, `--union`) and jj (`jj resolve --tool :ours`, `:theirs`) give;
// nested and malformed markers left untouched with a message; the mode turned on by a visit and left on by the last
// resolution; ] n and [ n. One Edwin per process, so the cases run in order.
// Run: node --test test/vc-conflict.test.mts
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startEdwin, type Edwin, type NodeHost } from './headless.mts';

const ed = await startEdwin();
const { Ed, E } = ed;
const Vc = (globalThis as unknown as { Vc: Edwin }).Vc;
ed.eval('(set! corfu-auto #f)');
const lastMessage = (): string => { const t: string = Ed.getBuffer('*Messages*').text.replace(/\n+$/, ''); return t.slice(t.lastIndexOf('\n') + 1); };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-vc-conflict-')));
const HOME = path.join(root, 'home');
fs.mkdirSync(path.join(HOME, '.config'), { recursive: true });
/* The children inherit this process's environment: no config of the user's is read. */
Object.assign(process.env, {
  HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1',
  JJ_USER: 'Test', JJ_EMAIL: 'test@example.invalid', JJ_TIMESTAMP: '2026-01-01T00:00:00+00:00',
});
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'JJ_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'JJ_EDITOR', 'EDITOR', 'VISUAL']) delete process.env[k];
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const host = ed.host as NodeHost & { files?: Edwin };
host.files = {
  read(n: string) { try { return fs.readFileSync(n, 'utf8'); } catch (e) { return null; } },
  exists: (n: string) => fs.existsSync(n), resolve: (n: string) => path.resolve(root, n), truename: (n: string) => n, label: (n: string) => n,
  write(n: string, text: string) { fs.writeFileSync(n, text); return true; }, remove() { throw new Error('not here'); }, list: () => [] as string[], cwd: root,
};

const keys = async (k: string) => { await ed.keys(k); await Ed.whenIdle(); };
const L = (name: string, ...args: unknown[]) => ed.L.call(name, args);
const conflictOn = (b: Edwin) => Ed.minorOn(b, Ed.minorModes.get('vc-conflict-mode'));
let n = 0;
/* A new file holding TEXT, visited: its buffer. */
const visitText = (text: string, name = `f${++n}.txt`) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, text);
  L('find-file', file);
  assert.equal(E.current.file, file);
  return E.current;
};
const kill = (b: Edwin) => { b.modified = false; L('kill-buffer', b); };
/* Each conflict of the current buffer resolved with KEY, point put inside it first (on its last line, past the
   markers it starts with); the buffer's text after. */
const resolveAll = async (key: string) => {
  const b = E.current;
  for (let cs = Vc.conflicts(b.text); cs.length; cs = Vc.conflicts(b.text)) {
    const c = cs[0];
    b.pt = c.end - 1;
    await keys(key);
    assert.ok(Vc.conflicts(b.text).length < cs.length, `${key} resolved a conflict (${lastMessage()})`);
  }
  return b.text;
};

/* ---------- git's markers ---------- */
const BASE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
const OURS = 'one\nTWO\nthree\nfour\nfive\nsix\nsame\nours 8\nnine\nten\n';
const THEIRS = 'one\nzwei\nthree\nfour\nfive\nsix\nsame\ntheirs 8\nnine\nten\nmore\n';
/* git merge-file -p on the three texts, with FLAGS: what it prints (it exits with the number of conflicts). */
const mergeFile = (ours: string, base: string, theirs: string, ...flags: string[]) => {
  const d = fs.mkdtempSync(path.join(root, 'mf-'));
  for (const [f, t] of [['ours', ours], ['base', base], ['theirs', theirs]]) fs.writeFileSync(path.join(d, f), t);
  const r = spawnSync('git', ['merge-file', '-p', ...flags, '-L', 'ours', '-L', 'base', '-L', 'theirs', 'ours', 'base', 'theirs'], { cwd: d, encoding: 'utf8' });
  assert.ok(r.status !== null && r.status >= 0 && r.status < 127, r.stderr);
  return r.stdout;
};
const gitCases: { what: string; ours: string; base: string; theirs: string; flags: string[]; count?: number; both?: string; newline?: boolean }[] = [
  { what: 'two-way', ours: OURS, base: BASE, theirs: THEIRS, flags: [], count: 2 },
  /* diff3 keeps the lines both sides add in each side, so both has them twice where --union has them once */
  { what: 'diff3', ours: OURS, base: BASE, theirs: THEIRS, flags: ['--diff3'], count: 2, both: 'one\nTWO\nzwei\nthree\nfour\nfive\nsix\nsame\nours 8\nsame\ntheirs 8\nnine\nten\nmore\n' },
  { what: 'zdiff3', ours: OURS, base: BASE, theirs: THEIRS, flags: ['--zdiff3'], count: 2 },
  /* a side that deletes what the other changes */
  { what: 'two-way, a deletion', ours: 'a\nb\nc\n', base: 'a\nB\nc\n', theirs: 'a\nc\n', flags: [] },
  /* sides with no final newline: git ends each side with one before the next marker, so the text kept from
     the markers ends with one where merge-file's has none */
  { what: 'diff3, no final newline', ours: 'a\nours', base: 'a\nbase\n', theirs: 'a\ntheirs', flags: ['--diff3'], newline: true },
  /* CRLF lines; marker lines of another length inside are text */
  { what: 'diff3, CRLF', ours: 'x\r\nmine\r\ny\r\n', base: 'x\r\nbase\r\ny\r\n', theirs: 'x\r\nyours\r\ny\r\n', flags: ['--diff3'] },
  { what: 'zdiff3, marker size 9 over 7-character runs', ours: '=======\nours\n>>>>>>> q\n', base: '=======\nbase\n', theirs: '=======\ntheirs\n|||||||\n', flags: ['--zdiff3', '--marker-size=9'] },
  /* ours starting with a line of jj's marker characters: git's labels, so git's conflict */
  { what: 'two-way, ours starting with +++++++ and %%%%%%% lines', ours: 'a\n+++++++ x\n%%%%%%% y\n', base: 'a\nb\n', theirs: 'a\nt\n', flags: [] },
  /* an opening marker of another length, with no closing marker of its own, before the conflict */
  { what: 'two-way, an 8-character <<<<<<<< line before', ours: 'x\n<<<<<<<< note\na\nmine\n', base: 'x\n<<<<<<<< note\na\nbase\n', theirs: 'x\n<<<<<<<< note\na\nyours\n', flags: [] },
];

test('git\'s two-way, diff3 and zdiff3 markers: each resolution gives git merge-file\'s --ours, --theirs and --union text', async () => {
  for (const { what, ours, base, theirs, flags, count, both, newline } of gitCases) {
    const marked = mergeFile(ours, base, theirs, ...flags);
    const cs = Vc.conflicts(marked);
    assert.equal(cs.length, count ?? 1, `${what}: the conflicts in\n${marked}`);
    for (const c of cs) { assert.equal(c.why, null, `${what}: well formed`); assert.equal(c.style, 'git'); }
    for (const [key, flag] of [['C-c ^ u', '--ours'], ['C-c ^ l', '--theirs'], ['C-c ^ a', '--union']]) {
      const b = visitText(marked);
      assert.ok(conflictOn(b), `${what}: the visit turns vc-conflict-mode on`);
      const git = mergeFile(ours, base, theirs, flag), want = flag === '--union' && both !== undefined ? both : newline && !git.endsWith('\n') ? git + '\n' : git;
      assert.equal(await resolveAll(key), want, `${what}: ${key} as ${flag}`);
      assert.ok(conflictOn(b), `${what}: still on once the last conflict is resolved`);
      assert.equal(lastMessage(), 'No conflict left');
      kill(b);
    }
  }
});

test('in a real merge: diff3 markers from git merge, resolved to ours, are the file as merge-file --ours gives it from the index stages', async () => {
  const w = path.join(root, 'repo');
  const git = (...a: string[]) => spawnSync('git', a, { cwd: w, encoding: 'utf8' });
  fs.mkdirSync(w);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(w, 'f'), BASE); git('add', 'f'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'other'); fs.writeFileSync(path.join(w, 'f'), THEIRS); git('commit', '-qam', 'theirs');
  git('checkout', '-q', 'main'); fs.writeFileSync(path.join(w, 'f'), OURS); git('commit', '-qam', 'ours');
  assert.notEqual(git('-c', 'merge.conflictStyle=diff3', 'merge', '-q', 'other').status, 0);
  const stage = (k: number) => git('show', `:${k}:f`).stdout;
  const want = mergeFile(stage(2), stage(1), stage(3), '--ours');
  L('find-file', path.join(w, 'f'));
  const b = E.current;
  assert.ok(conflictOn(b));
  assert.equal(await resolveAll('C-c ^ u'), want);
  kill(b);
});

/* ---------- jj's markers ---------- */
const jjRun = (cwd: string, ...args: string[]) => execFileSync('jj', ['--no-pager', '--color=never', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });

test('jj\'s markers in its default style: each resolution gives jj resolve\'s :ours and :theirs text, both is side #1 then side #2', async () => {
  const ws = path.join(root, 'jj');
  fs.mkdirSync(ws);
  jjRun(ws, 'git', 'init');
  assert.equal(jjRun(ws, 'config', 'get', 'ui.conflict-marker-style').trim(), 'diff', 'jj\'s default style');
  const put = (f: string, t: string) => fs.writeFileSync(path.join(ws, f), t);
  /* f: two conflicts, side #1 a snapshot and side #2 a diff, then side #1 a diff, the sides with no final newline;
     g: a text with runs of six marker characters, so that jj's markers are longer than seven */
  put('f', 'a\nb\nc\nd\ne\nf'); put('g', 'a\n------\nb\n');
  jjRun(ws, 'commit', '-m', 'base'); jjRun(ws, 'bookmark', 'create', '-r', '@-', 'base');
  put('f', 'Z\nY\nX\nd\ne\nf1'); put('g', 'a\n++++++\nb1\n');
  jjRun(ws, 'commit', '-m', 'one'); jjRun(ws, 'bookmark', 'create', '-r', '@-', 'one');
  jjRun(ws, 'new', 'base', '-m', 'two');
  put('f', 'a\nb2\nc\nd\ne\nf2'); put('g', 'a\nb2\n');
  jjRun(ws, 'new', 'one', '@');
  const marked = { f: fs.readFileSync(path.join(ws, 'f'), 'utf8'), g: fs.readFileSync(path.join(ws, 'g'), 'utf8') };
  assert.match(marked.f, /^\+{7} .*\n(?:.*\n)*%{7} diff from: .*\n\\{7} +to: /m, 'f: side #1 a snapshot, side #2 a diff');
  assert.match(marked.f, /%{7} diff from: .*\(no terminating newline\)\n\\{7} +to: .*\(no terminating newline\)/, 'f: sides with no final newline');
  assert.match(marked.g, /^<{8,} /m, 'g: longer markers');
  const resolved = (tool: string) => {
    jjRun(ws, 'resolve', '--tool', tool);
    const out = { f: fs.readFileSync(path.join(ws, 'f'), 'utf8'), g: fs.readFileSync(path.join(ws, 'g'), 'utf8') };
    jjRun(ws, 'undo');
    assert.deepEqual({ f: fs.readFileSync(path.join(ws, 'f'), 'utf8'), g: fs.readFileSync(path.join(ws, 'g'), 'utf8') }, marked, 'jj undo brings the conflicts back');
    return out;
  };
  const want = { ours: resolved(':ours'), theirs: resolved(':theirs') };
  assert.deepEqual(want.ours, { f: 'Z\nY\nX\nd\ne\nf1', g: 'a\n++++++\nb1\n' }, 'jj\'s :ours is side #1');
  for (const f of ['f', 'g'] as const) {
    for (const c of Vc.conflicts(marked[f])) { assert.equal(c.why, null, `${f}: well formed`); assert.equal(c.style, 'jj'); }
    for (const [key, w] of [['C-c ^ u', want.ours[f]], ['C-c ^ l', want.theirs[f]]]) {
      const b = visitText(marked[f], `jj-${f}-${++n}`);
      assert.ok(conflictOn(b));
      assert.equal(await resolveAll(key), w, `${f}: ${key}`);
      kill(b);
    }
  }
  const b = visitText(marked.f, `jj-f-${++n}`);
  assert.equal(await resolveAll('C-c ^ a'), 'Z\nY\nX\na\nb2\nc\nd\ne\nf1\nf2', 'both: side #1, then side #2, a newline between sides that end with none');
  kill(b);
});

test('jj\'s longer markers around a file whose text holds a 7-character <<<<<<< line: the line is text, the conflict is resolved as jj resolve does', async () => {
  const ws = path.join(root, 'jj-long');
  fs.mkdirSync(ws);
  jjRun(ws, 'git', 'init');
  const put = (t: string) => fs.writeFileSync(path.join(ws, 'f'), t);
  const read = () => fs.readFileSync(path.join(ws, 'f'), 'utf8');
  put('doc\n<<<<<<< sample\nx\n=======\nmid\nend\n');
  jjRun(ws, 'commit', '-m', 'base'); jjRun(ws, 'bookmark', 'create', '-r', '@-', 'base');
  put('doc\n<<<<<<< sample\nx\n=======\nONE\nend\n');
  jjRun(ws, 'commit', '-m', 'one'); jjRun(ws, 'bookmark', 'create', '-r', '@-', 'one');
  jjRun(ws, 'new', 'base', '-m', 'two');
  put('doc\n<<<<<<< sample\nx\n=======\nTWO\nend\n');
  jjRun(ws, 'new', 'one', '@');
  const marked = read();
  assert.match(marked, /^<<<<<<< sample\n/m, 'the 7-character line is kept');
  assert.match(marked, /^<{8,} conflict 1 of 1\n/m, 'jj\'s markers are longer');
  const want: Record<string, string> = {};
  for (const tool of [':ours', ':theirs']) { jjRun(ws, 'resolve', '--tool', tool); want[tool] = read(); jjRun(ws, 'undo'); assert.equal(read(), marked); }
  const cs = Vc.conflicts(marked);
  assert.deepEqual(cs.map((c: Edwin) => [c.style, c.why]), [['jj', null]]);
  for (const [key, w] of [['C-c ^ u', want[':ours']], ['C-c ^ l', want[':theirs']], ['C-c ^ a', 'doc\n<<<<<<< sample\nx\n=======\nONE\nTWO\nend\n']]) {
    const b = visitText(marked, `jj-long-${++n}`);
    assert.ok(conflictOn(b));
    b.pt = 0;
    await keys('] n');
    assert.equal(b.pt, cs[0].start, `${key}: ] n goes to jj's conflict`);
    await keys(key);
    assert.equal(b.text, w, key);
    kill(b);
  }
});

/* ---------- malformed and nested ---------- */
const BAD: [string, string, string][] = [
  ['nested', '<<<<<<< a\nx\n<<<<<<< b\ny\n=======\nz\n>>>>>>> b\n=======\nw\n>>>>>>> a\n', 'holds another conflict'],
  ['an opening marker inside, closed by the same marker', '<<<<<<< HEAD\no\n<<<<<<< text\n=======\nt\n>>>>>>> b\n', 'holds another conflict'],
  ['a closing marker inside theirs, so another of its length after it', 'a\n<<<<<<< ours\nx\n=======\n>>>>>>> q\ny\n>>>>>>> theirs\n', 'ends ambiguously, another closing marker of its length following it'],
  ['a closing marker of its length later in the text', '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\ntext\n>>>>>>> quoted\n', 'ends ambiguously, another closing marker of its length following it'],
  ['no separator','<<<<<<< a\nx\n>>>>>>> b\n', 'has its markers out of order, or one missing'],
  ['two separators', '<<<<<<< a\nx\n=======\ny\n=======\nz\n>>>>>>> b\n', 'has its markers out of order, or one missing'],
  ['base after the separator', '<<<<<<< a\nx\n=======\ny\n||||||| base\nz\n>>>>>>> b\n', 'has its markers out of order, or one missing'],
  ['jj: a diff line with no prefix', '<<<<<<< conflict 1 of 1\n%%%%%%% diff from: x\n\\\\\\\\\\\\\\        to: y\n-a\nb\n+++++++ z\nq\n>>>>>>> conflict 1 of 1 ends\n', 'has a diff line that starts with neither a space, - nor +'],
  ['jj: three sides', '<<<<<<< conflict 1 of 1\n+++++++ a\n1\n+++++++ b\n2\n+++++++ c\n3\n>>>>>>> conflict 1 of 1 ends\n', 'has 3 sides, not two'],
  ['jj: snapshot style', '<<<<<<< conflict 1 of 1\n+++++++ a\n1\n------- base\n0\n+++++++ b\n2\n>>>>>>> conflict 1 of 1 ends\n', 'is in jj\'s snapshot style, which is not read here'],
  ['jj: git\'s separator', '<<<<<<< conflict 1 of 1\n+++++++ a\n1\n=======\n2\n>>>>>>> conflict 1 of 1 ends\n', 'has a marker out of place'],
];

test('nested and malformed markers are left untouched with a message, by each resolution and by ] n', async () => {
  for (const [what, text, why] of BAD) {
    const cs = Vc.conflicts(text);
    assert.equal(cs.length, 1, what);
    assert.equal(cs[0].why, why, what);
    assert.equal(cs[0].style, null, what);
    const b = visitText(text);
    assert.ok(conflictOn(b), `${what}: the mode is on, so the conflict can be found`);
    for (const key of ['C-c ^ u', 'C-c ^ l', 'C-c ^ a']) {
      b.pt = cs[0].start + 2;
      await keys(key);
      assert.equal(b.text, text, `${what}: ${key} changes nothing`);
      assert.equal(lastMessage(), `This conflict ${why}: resolve it by hand`, `${what}: ${key}`);
      assert.ok(!b.modified, what);
    }
    b.pt = 0;
    if (cs[0].start > 0) { await keys('] n'); assert.equal(b.pt, cs[0].start); assert.equal(lastMessage(), `This conflict ${why}: resolve it by hand`, `${what}: ] n says it`); }
    kill(b);
  }
  /* a good conflict after a malformed one is still resolved, and the mode stays on for the one left */
  const text = '<<<<<<< a\nx\n>>>>>>> b\nmid\n<<<<<<< c\nours\n=======\ntheirs\n>>>>>>> d\nend\n';
  const b = visitText(text);
  b.pt = text.indexOf('ours');
  await keys('C-c ^ l');
  assert.equal(b.text, '<<<<<<< a\nx\n>>>>>>> b\nmid\ntheirs\nend\n');
  assert.ok(conflictOn(b), 'on while a malformed conflict is left');
  kill(b);
});

test('git\'s markers around a theirs that holds a >>>>>>> line: the conflict is refused, not cut at that line', async () => {
  /* git does not lengthen its markers for such a line, so the file reads the same as a conflict followed by a
     quoted >>>>>>> line: neither reading is taken */
  const marked = mergeFile('a\nx\n', 'a\n', 'a\n>>>>>>> q\ny\n');
  assert.equal(marked, 'a\n<<<<<<< ours\nx\n=======\n>>>>>>> q\ny\n>>>>>>> theirs\n');
  const cs = Vc.conflicts(marked);
  assert.deepEqual(cs.map((c: Edwin) => [c.start, c.end, c.style, c.why]), [[2, marked.indexOf('y\n'), null, 'ends ambiguously, another closing marker of its length following it']]);
  const b = visitText(marked);
  assert.ok(conflictOn(b));
  for (const key of ['C-c ^ u', 'C-c ^ l', 'C-c ^ a']) {
    b.pt = 4;
    await keys(key);
    assert.equal(b.text, marked, `${key} changes nothing`);
    assert.equal(lastMessage(), 'This conflict ends ambiguously, another closing marker of its length following it: resolve it by hand');
  }
  kill(b);
  /* the look past a closing marker stops at the next opening marker of its length: the first of two conflicts is
     read, the second, with a >>>>>>> line after it and no opening marker between, is refused */
  const two = '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n<<<<<<< c\no\n=======\nt\n>>>>>>> d\nmail\n>>>>>>> quoted\n';
  assert.deepEqual(Vc.conflicts(two).map((c: Edwin) => [c.style, c.ours, c.theirs, c.why]),
    [['git', 'x\n', 'y\n', null], [null, '', '', 'ends ambiguously, another closing marker of its length following it']]);
  /* a closing marker of another length after a conflict is text */
  assert.deepEqual(Vc.conflicts('<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n>>>>>>>> eight\n').map((c: Edwin) => c.why), [null]);
});

test('markers outside a conflict are text: a file with none does not turn the mode on, and nothing there is resolved', async () => {
  const text = 'Title\n=======\n\n>>>>>>> quoted\n||||||| bars\n<<<<<<<x\n<<<<<<< no closing marker\n=======\ny\n';
  assert.deepEqual(Vc.conflicts(text), []);
  /* an opening marker that no closing marker of its length follows is text, and the conflict after it is read */
  const lead = 'x\n<<<<<<<< note\na\n<<<<<<< HEAD\no\n=======\nt\n>>>>>>> b\n';
  assert.deepEqual(Vc.conflicts(lead), [{ start: lead.indexOf('<<<<<<< HEAD'), end: lead.length, style: 'git', ours: 'o\n', theirs: 't\n', why: null }]);
  const unclosed = 'top\n<<<<<<< a\nx\n<<<<<<<<< b\no\n=========\nt\n>>>>>>>>> b\n';
  assert.deepEqual(Vc.conflicts(unclosed).map((c: Edwin) => [c.start, c.style]), [[unclosed.indexOf('<<<<<<<<< b'), 'git']]);
  /* jj's marker characters starting git's ours are text: git's labels make it git's */
  assert.deepEqual(Vc.conflicts('<<<<<<< HEAD\n+++++++ x\no\n=======\nt\n>>>>>>> b\n').map((c: Edwin) => [c.style, c.ours, c.theirs, c.why]), [['git', '+++++++ x\no\n', 't\n', null]]);
  const b = visitText(text);
  assert.ok(!conflictOn(b));
  L('vc-conflict-mode', 1);
  b.pt = 8;
  await keys('C-c ^ u');
  assert.equal(lastMessage(), 'No conflict at point');
  assert.equal(b.text, text);
  kill(b);
});

test('] n and [ n go to the conflicts in order; a resolution is one change, undone with u; a buffer visited again is looked at again', async () => {
  const marked = mergeFile(OURS, BASE, THEIRS, '--diff3');
  const cs = Vc.conflicts(marked);
  const b = visitText(marked);
  b.pt = 0;
  await keys('] n'); assert.equal(b.pt, cs[0].start);
  await keys('] n'); assert.equal(b.pt, cs[1].start);
  await keys('] n'); assert.equal(b.pt, cs[1].start); assert.equal(lastMessage(), 'No later conflict');
  await keys('[ n'); assert.equal(b.pt, cs[0].start);
  await keys('[ n'); assert.equal(b.pt, cs[0].start); assert.equal(lastMessage(), 'No earlier conflict');
  await keys('C-c ^ n'); assert.equal(b.pt, cs[1].start, 'C-c ^ n');
  await keys('C-c ^ p'); assert.equal(b.pt, cs[0].start, 'C-c ^ p');
  await keys('C-c ^ u');
  assert.equal(Vc.conflicts(b.text).length, 1);
  assert.equal(b.pt, cs[0].start, 'point at the resolved text');
  await keys('u');
  assert.equal(b.text, marked, 'u brings the markers back');
  /* in Insert state too */
  await keys('i C-c ^ l');
  assert.equal(b.text.slice(cs[0].start, cs[0].start + 7), 'zwei\nth');
  await keys('<escape>');
  /* the last conflict resolved, the mode stays on: u brings the markers back with their keys */
  b.pt = Vc.conflicts(b.text)[0].start;
  await keys('C-c ^ u');
  assert.equal(Vc.conflicts(b.text).length, 0);
  assert.equal(lastMessage(), 'No conflict left');
  assert.ok(conflictOn(b), 'on after the last resolution');
  await keys('u');
  assert.equal(Vc.conflicts(b.text).length, 1, 'u brings the last conflict back');
  b.pt = 0;
  await keys('] n');
  assert.equal(b.pt, Vc.conflicts(b.text)[0].start, '] n goes to it');
  await keys('C-c ^ l');
  assert.equal(Vc.conflicts(b.text).length, 0, 'C-c ^ l resolves it');
  kill(b);
  /* the buffer was open with no conflict when its file was given markers (auto-revert takes them in as text): the
     next visit turns the mode on */
  const c = visitText('one\n');
  assert.ok(!conflictOn(c));
  c.text = marked; c.modified = false;
  L('switch-to-buffer', '*scratch*');
  L('find-file', c.file);
  assert.equal(E.current, c);
  assert.ok(conflictOn(c), 'on at the second visit');
  kill(c);
  /* the same through visit-location, as the status buffer's RET visits a file at a hunk's line */
  const d = visitText('one\n');
  d.text = marked; d.modified = false;
  L('switch-to-buffer', '*scratch*');
  L('visit-location', d.file, 2);
  assert.equal(E.current, d);
  assert.ok(conflictOn(d), 'on at a visit-location');
  kill(d);
});

test('the mode\'s keys leave the others of their prefixes alone: ] b, the major mode\'s ] ] and C-c C-t', async () => {
  const b = visitText('# One\n- TODO task\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n# Two\n', `keys-${++n}.md`);
  assert.equal(b.mode, 'markdown-mode');
  assert.ok(conflictOn(b));
  b.pt = 0;
  await keys('] ]');
  assert.equal(b.pt, b.text.indexOf('# Two'), '] ] goes to the next heading');
  b.pt = b.text.indexOf('task');
  await keys('C-c C-t');
  assert.doesNotMatch(b.text, /TODO task/, 'C-c C-t cycles the task');
  const other = Ed.getBufferCreate('*vc-conflict other*');
  await keys('] b');
  assert.notEqual(E.current, b, '] b goes to another buffer');
  L('switch-to-buffer', b);
  await keys('[ b');
  assert.notEqual(E.current, b, '[ b goes to another buffer');
  L('kill-buffer', other);
  kill(b);
});

test('read-only: a resolution changes nothing', async () => {
  const marked = mergeFile('a\nx\n', 'a\n', 'a\ny\n');
  const b = visitText(marked);
  b.readOnly = true;
  b.pt = 2;
  await keys('C-c ^ u');
  assert.equal(b.text, marked);
  kill(b);
});
