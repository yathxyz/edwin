// EditorConfig (src/editorconfig.ts) in the headless runtime: the core library's own test cases, read from
// editorconfig-core-c's source (EDITORCONFIG_CORE_TESTS, its tests directory; the edwin-prog check sets it), run
// against EditorConfig.properties; and what a visited file's .editorconfig sets in its buffer: the indent, the
// fill column, the final newline and the trimming on save, over the modes' own indent, again after a mode switch.
// One Edwin per process, so the cases run in order on fresh buffers.
// Run: EDITORCONFIG_CORE_TESTS=$(nix build --print-out-paths nixpkgs#editorconfig-core-c.src)/tests node --test test/editorconfig.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEdwin } from './headless.mts';

const ed = await startEdwin();
const ev = (src: string) => ed.eval(src);
ev('(set! corfu-auto #f)');
type Api = { properties(file: string, read: (p: string) => string | null, name?: string): Map<string, string>; matches(glob: string, rel: string): boolean; MAX_FILE: number; MAX_GLOBS: number; SECTION_COST: number };
const EC = (globalThis as typeof globalThis & { EditorConfig: Api }).EditorConfig;

/* ---------- the core library's test cases (editorconfig-core-c, tests/) ----------
   Each new_ec_test* call of a CMakeLists.txt there runs `editorconfig -f NAME FILE` and matches its output
   (NAME=VALUE lines) against a regular expression; the _multiline ones sort the lines first. Left out: the cli
   and meta directories (the program's switches) and new_ec_test_version (the output of version 0.8). */
const CORE = process.env.EDITORCONFIG_CORE_TESTS;

/* A CMake argument as CMake reads it: quoted with \t \n \r and \X for X, or bare; ${VAR} substituted from VARS
and CMAKE_CURRENT_SOURCE_DIR. */
function cmakeArgs(text: string, dir: string, vars: Map<string, string> = new Map()): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^\s"]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1] ?? m[2];
    const s = raw.replace(/\\(.)/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c));
    out.push(s.replace(/\$\{(\w+)\}/g, (all, v) => (v === 'CMAKE_CURRENT_SOURCE_DIR' ? dir : vars.get(v) ?? all)));
  }
  return out;
}
interface CoreCase { name: string; kind: string; conf: string; file: string; regex: RegExp }
function coreCases(sub: string): CoreCase[] {
  const dir = path.join(CORE!, sub);
  const text = fs.readFileSync(path.join(dir, 'CMakeLists.txt'), 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const out: CoreCase[] = [];
  // set(VAR VALUE): the last one stands, which in an if(WIN32) ... else block is the branch for this system.
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/^\s*set\((\w+)\s+("(?:[^"\\]|\\.)*")\)/gm)) vars.set(m[1], cmakeArgs(m[2], dir)[0]);
  for (const m of text.matchAll(/^\s*new_ec_test(|_multiline|_full_ec_file_path)\(([^)]*)\)/gm)) {
    const [name, conf, file, regex] = cmakeArgs(m[2], dir, vars);
    const kind = m[1] || '_plain';
    // CMake's [\] is a bracket holding a backslash; JavaScript reads \] as an escaped bracket.
    const src = regex.replaceAll('[\\]', '[\\\\]');
    out.push({ name, kind, conf, file: kind === '_full_ec_file_path' ? file : path.join(dir, file), regex: new RegExp(kind === '_multiline' ? `^[\r\n]*${src}$` : src) });
  }
  return out;
}
const readFile = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function runCore(sub: string, expected: number) {
  const cases = coreCases(sub), failed: string[] = [];
  for (const c of cases) {
    const lines = [...EC.properties(c.file, readFile, c.conf)].map(([k, v]) => `${k}=${v}`);
    const output = c.kind === '_multiline' ? lines.sort().join('\n') + '\n' : lines.map(l => l + '\n').join('');
    if (!c.regex.test(output)) failed.push(`${c.name}: ${JSON.stringify(output)} against ${c.regex}`);
  }
  assert.deepEqual(failed, []);
  assert.equal(cases.length, expected, `the number of ${sub} cases`);
}
for (const [sub, n] of [['glob', 130], ['parser', 33], ['properties', 9], ['filetree', 24]] as const)
  test(`editorconfig-core-test ${sub}: all ${n} cases`, () => {
    assert.ok(CORE, 'EDITORCONFIG_CORE_TESTS names the tests directory of editorconfig-core-c\'s source');
    runCore(sub, n);
  });

/* ---------- globs: what the core cases leave out ---------- */

test('globs: a negated class and ? never match /; numbers signed, in either order of the bounds; a glob with / is anchored', () => {
  const m = EC.matches;
  assert.equal(m('a[!b]c', 'a/c'), false);
  assert.equal(m('a[!b]c', 'axc'), true);
  assert.equal(m('{-3..3}', '-2'), true);
  assert.equal(m('{3..-3}', '+3'), true);
  assert.equal(m('{-3..3}', '4'), false);
  assert.equal(m('x{1..9}y', 'x10y'), false);
  assert.equal(m('src/*.ts', 'src/a.ts'), true);
  assert.equal(m('src/*.ts', 'lib/src/a.ts'), false);
  assert.equal(m('*.ts', 'lib/src/a.ts'), true);
  assert.equal(m('/a.ts', 'a.ts'), true);
  assert.equal(m('/a.ts', 'b/a.ts'), false);
  assert.equal(m('**', 'any/depth/at/all'), true);
  assert.equal(m('a\\', 'a\\'), true);
});

test('globs: a leading **/ or /**/ matches in the directory itself too, as the core library\'s does', () => {
  const conf = 'root=true\n[**/Makefile]\na=1\n[/**/*.md]\nb=1\n[**/*.js]\nc=1\n[x/**/y]\nd=1\n';
  const props = (f: string) => [...EC.properties(f, p => (p === '/d/.editorconfig' ? conf : null))];
  assert.deepEqual(props('/d/Makefile'), [['a', '1']]);
  assert.deepEqual(props('/d/README.md'), [['b', '1']]);
  assert.deepEqual(props('/d/a.js'), [['c', '1']]);
  assert.deepEqual(props('/d/x/Makefile'), [['a', '1']]);
  assert.deepEqual(props('/d/doc/sub/README.md'), [['b', '1']]);
  assert.deepEqual(props('/d/x/y'), [['d', '1']]);
  assert.deepEqual(props('/d/x/p/q/y'), [['d', '1']]);
  assert.deepEqual(props('/d/xy'), []);
  assert.equal(EC.matches('**/a', 'ba'), false);
  assert.equal(EC.matches('/**/a', 'b/a'), true);
});

test('globs: a hostile pattern against a long path costs its length times the path\'s, not a backtracking search', () => {
  const glob = '*a'.repeat(2000) + 'b', rel = 'a'.repeat(4000);
  let t = performance.now();
  assert.equal(EC.matches(glob, rel), false);
  assert.ok(performance.now() - t < 2000, `matches took ${performance.now() - t} ms`);
  // Such sections up to the bound on section names in a .editorconfig in each of 20 directories, for a file
  // 4000 characters deep: the files past the bound are not read.
  const section = `[${'{a,*a}'.repeat(40)}b]\nk=v\n`, globLength = section.indexOf(']') - 1;
  const text = section.repeat(Math.floor(EC.MAX_GLOBS / (globLength + EC.SECTION_COST)));
  const dirs = Array.from({ length: 20 }, (_, k) => '/h' + '/d'.repeat(k));
  const file = dirs[19] + '/' + 'a'.repeat(4000);
  const read: string[] = [];
  t = performance.now();
  assert.equal(EC.properties(file, p => { read.push(p); return p.endsWith('/.editorconfig') ? text : null; }).size, 0);
  assert.ok(performance.now() - t < 2000, `properties took ${performance.now() - t} ms`);
  assert.deepEqual(read, [dirs[19] + '/.editorconfig', dirs[18] + '/.editorconfig']);
  // Many short sections cost their nodes, not only their names: a whole file of empty and one-character ones, in
  // each of 20 directories, the same.
  for (const one of ['[]\nk=v\n', '[a]\nk=v\n']) {
    const many = one.repeat(Math.floor(EC.MAX_FILE / one.length));
    read.length = 0;
    t = performance.now();
    assert.equal(EC.properties(file, p => { read.push(p); return p.endsWith('/.editorconfig') ? many : null; }).size, 0);
    assert.ok(performance.now() - t < 2000, `properties of ${JSON.stringify(one)} took ${performance.now() - t} ms`);
    assert.deepEqual(read, [dirs[19] + '/.editorconfig'], 'the first file is past the bound already');
  }
  const fits = '[a]\nk=v\n'.repeat(Math.floor(EC.MAX_GLOBS / (1 + EC.SECTION_COST)));
  t = performance.now();
  assert.equal(EC.properties('/h/' + 'a'.repeat(4000), p => (p === '/h/.editorconfig' ? fits : null)).size, 0);
  assert.ok(performance.now() - t < 2000, `properties of short sections up to the bound took ${performance.now() - t} ms`);
  // Within the bound the search goes on up; past the size bound a file is skipped, as if absent.
  assert.deepEqual([...EC.properties('/h/d/x', p => (p === '/h/d/.editorconfig' ? `[${'x'.repeat(EC.MAX_GLOBS - 2 * EC.SECTION_COST - 1)}]\nk=1\n` : p === '/h/.editorconfig' ? '[*]\nk=2\nj=2\n' : null))], [['k', '2'], ['j', '2']]);
  assert.deepEqual([...EC.properties('/h/d/x', p => (p === '/h/d/.editorconfig' ? `[${'x'.repeat(EC.MAX_GLOBS - 2 * EC.SECTION_COST)}]\nk=1\n` : p === '/h/.editorconfig' ? '[*]\nk=2\nj=2\n' : null))], []);
  assert.equal(EC.properties('/h/x', p => (p === '/h/.editorconfig' ? '[*]\nk=v\n' + ' '.repeat(EC.MAX_FILE) : null)).size, 0);
});

/* ---------- in the editor ---------- */

/* Store FILES (path to text), then visit NAME in Normal state with point at its start. */
async function visit(name: string, files: Record<string, string> = {}) {
  if ((globalThis as typeof globalThis & { EvilCore: { stateOf(b: unknown): string } }).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
  for (const [p, t] of Object.entries(files)) ed.Ed.Store.set(p, t);
  await ed.type(`:e ${name}\n`);
  ev('(goto-char 1)');
  return ed.E.current;
}
const saved = (name: string) => ed.Ed.Store.get(name);
const vars = () => ({ tabs: ev('indent-tabs-mode'), tab: ev('tab-width'), shift: ev('evil-shift-width'), fill: ev('fill-column') });

test('the nearest .editorconfig wins over the outer one, both over the mode\'s indent; other buffers keep theirs', async () => {
  await visit('/e1/sub/a.nix', {
    '/e1/.editorconfig': 'root = true\n[*]\nindent_style = space\nindent_size = 8\nmax_line_length = 100\n',
    '/e1/sub/.editorconfig': '[*.nix]\nindent_size = 3\n',
  });
  assert.deepEqual(vars(), { tabs: false, tab: 3, shift: 3, fill: 100 });
  await visit('/e1/b.nix');
  assert.deepEqual(vars(), { tabs: false, tab: 8, shift: 8, fill: 100 });
  // Outside the tree: the mode's indent (Nix 2) and the defaults.
  await visit('/elsewhere/c.nix');
  assert.deepEqual(vars(), { tabs: false, tab: 2, shift: 2, fill: 70 });
  assert.deepEqual(ed.L.arr(ev('(editorconfig-properties "/e1/sub/a.nix")')).map((p: { car: string; cdr: string }) => [p.car, p.cdr]),
    [['indent_style', 'space'], ['indent_size', '3'], ['max_line_length', '100'], ['tab_width', '3']]);
});

test('indent_style = tab: TAB inserts a tab; the indent width is tab_width', async () => {
  await visit('/e2/a.txt', { '/e2/.editorconfig': 'root=true\n[*.txt]\nindent_style=tab\ntab_width=4\n' });
  assert.deepEqual(vars(), { tabs: true, tab: 4, shift: 4, fill: 70 });
  await ed.type('i');
  await ed.keys('TAB');
  await ed.keys('ESC');
  assert.equal(ed.text(), '\t');
});

test('root = true stops the search: the outer file is not read', async () => {
  await visit('/e3/in/a.py', { '/e3/.editorconfig': '[*]\nindent_size=7\n', '/e3/in/.editorconfig': 'root = true\n' });
  assert.deepEqual(vars(), { tabs: false, tab: 4, shift: 4, fill: 70 });
  assert.equal(ed.L.arr(ev('(editorconfig-properties "/e3/in/a.py")')).length, 0);
  await visit('/e3/b.py');
  assert.deepEqual([ev('tab-width'), ev('evil-shift-width')], [7, 7]);
});

test('unset takes a value back: the mode\'s own indent applies', async () => {
  await visit('/e4/a.py', { '/e4/.editorconfig': 'root=true\n[*]\nindent_size=2\n[*.py]\nindent_size=unset\n' });
  assert.deepEqual([ev('tab-width'), ev('evil-shift-width')], [4, 4]);
});

test('a major mode switch keeps the file\'s values; a buffer with no file or a relative name gets none', async () => {
  await visit('/e5/a.nix', { '/e5/.editorconfig': 'root=true\n[*]\nindent_size=5\nmax_line_length=90\n' });
  ev('(python-mode)');
  assert.equal(ed.E.current.mode, 'python-mode');
  assert.deepEqual(vars(), { tabs: false, tab: 5, shift: 5, fill: 90 });
  ev('(switch-to-buffer "*e5 no file*") (python-mode)');
  assert.deepEqual([ev('tab-width'), ev('fill-column')], [4, 70]);
  assert.equal(ed.E.current.editorconfig, undefined);
  ed.Ed.Store.set('.editorconfig', 'root=true\n[*]\nindent_size=5\n');
  await visit('e5.py');
  assert.equal(ev('tab-width'), 4);
  ed.Ed.Store.del('.editorconfig');
});

test('insert_final_newline: true adds the newline on save, false keeps a file without one', async () => {
  const conf = { '/e6/.editorconfig': 'root=true\n[yes.*]\ninsert_final_newline=true\n[no.*]\ninsert_final_newline = FALSE\n' };
  await visit('/e6/yes.txt', conf);
  ev('(insert "x")');
  await ed.type(':w\n');
  assert.equal(saved('/e6/yes.txt'), 'x\n');
  try {
    ev("(set-default 'require-final-newline #t)");
    await visit('/e6/no.txt');
    ev('(insert "x")');
    await ed.type(':w\n');
    assert.equal(saved('/e6/no.txt'), 'x');
    await visit('/e6/other.txt');
    ev('(insert "x")');
    await ed.type(':w\n');
    assert.equal(saved('/e6/other.txt'), 'x\n', 'a file no section matches keeps the global value');
  } finally { ev("(set-default 'require-final-newline #f)"); }
});

test('trim_trailing_whitespace = true trims every line on save, in any mode; an unmodified buffer is not touched', async () => {
  const dirty = 'a  \nb\t\nc \n';
  await visit('/e7/a.md', { '/e7/.editorconfig': 'root=true\n[*]\ntrim_trailing_whitespace=true\n', '/e7/a.md': dirty, '/e7/b.nix': dirty });
  await ed.type(':w\n');
  assert.equal(saved('/e7/a.md'), dirty);
  ev('(goto-char (point-max)) (insert "d  \\n")');
  await ed.type(':w\n');
  assert.equal(saved('/e7/a.md'), 'a\nb\nc\nd\n');
  // In a programming buffer the untouched lines go too, not only ws-butler's changed ones.
  await visit('/e7/b.nix');
  ev('(insert "# top  \\n")');
  await ed.type(':w\n');
  assert.equal(saved('/e7/b.nix'), '# top\na\nb\nc\n');
});

test('trim_trailing_whitespace = false keeps ws-butler from trimming that buffer only', async () => {
  await visit('/e8/a.nix', { '/e8/.editorconfig': 'root=true\n[a.nix]\ntrim_trailing_whitespace = false\n', '/e8/a.nix': 'x  \n' });
  ev('(insert "y  \\n")');
  await ed.type(':w\n');
  assert.equal(saved('/e8/a.nix'), 'y  \nx  \n');
  assert.equal(ev('ws-butler-mode'), false);
  await visit('/e8/b.nix', { '/e8/b.nix': 'x  \n' });
  assert.equal(ev('ws-butler-mode'), true);
  ev('(insert "y  \\n")');
  await ed.type(':w\n');
  assert.equal(saved('/e8/b.nix'), 'y\nx  \n');
});

test('values out of range set nothing: a width of 0, a word, more than 9999', async () => {
  await visit('/e9/a.py', { '/e9/.editorconfig': 'root=true\n[*]\nindent_size=0\nmax_line_length=off\nindent_style=both\n[a.py]\ntab_width=10000\n' });
  assert.deepEqual(vars(), { tabs: false, tab: 4, shift: 4, fill: 70 });
  assert.equal(ed.E.current.editorconfig.get('max_line_length'), 'off');
});
