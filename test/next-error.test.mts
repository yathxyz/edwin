// The error list (scm/next-error.scm) in the headless runtime: a list seeded across files, stepped through with
// M-g n, M-g p, :cn, :cp and :cc; its ends, its refusals, clamping, and visits that go to edwind.
// One Edwin per process, so the cases run in order.
// Run: node --test test/next-error.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startEdwin } from './headless.mts';

const ed = await startEdwin();
const ev = (src: string) => ed.eval(src);
ev('(set! corfu-auto #f)');
const lastMessage = (): string => { const t: string = ed.Ed.getBuffer('*Messages*').text.replace(/\n+$/, ''); return t.slice(t.lastIndexOf('\n') + 1); };
/* Where point is: [file the current buffer visits, line, column], both from 1. */
const here = () => [ed.E.current.file, ev('(line-number-at-pos)'), ev('(- (point) (line-beginning-position) -1)')];
const files: Record<string, string> = {
  'ne-a.rs': 'fn main() {\n    let x = 1;\n    let y = 2;\n    x + y\n}\n',
  'ne-b.nix': '{\n  a = 1;\n  b = 2;\n}\n',
  'ne-c.py': 'def f():\n    return 1\n',
};
for (const [name, text] of Object.entries(files)) ed.Ed.Store.set(name, text);
const list = `'(("ne-a.rs" 2 9 "unused variable x")
               ("ne-b.nix" 3 3 "undefined b")
               ("ne-a.rs" 4 5)
               ("ne-c.py" 2))`;
/* Run KEYS in Normal state from a scratch buffer that visits no file. */
async function from(keys: string) {
  if ((globalThis as typeof globalThis & { EvilCore: { stateOf(b: unknown): string } }).EvilCore.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
  await ed.keys(keys);
}
const isOpen = (name: string) => ed.E.buffers.some((b: { file: string | null }) => b.file === name);

test('a seeded list across three files: M-g n, :cn, :cp, M-g p and :cc step through it, each showing its message', async () => {
  ed.Ed.setWindowBuffer(ed.Ed.getBufferCreate('*ne-scratch*'));
  assert.equal(ev(`(next-error-set-list! ${list})`), 4);
  assert.ok(!isOpen('ne-b.nix') && !isOpen('ne-c.py'), 'the later files are not open yet, so a step visits them');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-a.rs', 2, 9]);
  assert.equal(lastMessage(), '(1 of 4) unused variable x');
  await ed.type(':cn\n');
  assert.deepEqual(here(), ['ne-b.nix', 3, 3]);
  assert.equal(ed.E.current.mode, 'nix-mode', 'a visited file opens in its mode');
  assert.equal(lastMessage(), '(2 of 4) undefined b');
  await from('M-g M-n');
  assert.deepEqual(here(), ['ne-a.rs', 4, 5]);
  assert.equal(lastMessage(), '(3 of 4) ne-a.rs:4', 'no message: the place is shown');
  await ed.type(':cn\n');
  assert.deepEqual(here(), ['ne-c.py', 2, 1], 'no column: the line start');
  await ed.type(':cp\n');
  assert.deepEqual(here(), ['ne-a.rs', 4, 5]);
  await from('M-g p');
  assert.deepEqual(here(), ['ne-b.nix', 3, 3]);
  await ed.type(':cc 1\n');
  assert.deepEqual(here(), ['ne-a.rs', 2, 9]);
  await ed.type(':cc4\n');
  assert.deepEqual(here(), ['ne-c.py', 2, 1]);
  await ed.type(':cN\n');
  assert.deepEqual(here(), ['ne-a.rs', 4, 5]);
  await ed.type(':cc\n');
  assert.deepEqual(here(), ['ne-a.rs', 4, 5], ':cc alone visits the current error again');
  await ed.type(':cp 2\n');
  assert.deepEqual(here(), ['ne-a.rs', 2, 9]);
  await ed.type(':cnext 3\n');
  assert.deepEqual(here(), ['ne-c.py', 2, 1]);
  await from('M-g M-p');
  assert.deepEqual(here(), ['ne-a.rs', 4, 5]);
  // A prefix argument counts too, and first-error goes to the Nth from the start.
  await from('C-u 2 M-g p');
  assert.deepEqual(here(), ['ne-a.rs', 2, 9]);
  ev('(first-error 2)');
  assert.deepEqual(here(), ['ne-b.nix', 3, 3]);
});

test('the ends of the list, an empty list and a bad count are refused, and point stays', async () => {
  ev(`(next-error-set-list! ${list})`);
  await ed.type(':cc 4\n');
  const at = here();
  await from('M-g n');
  assert.equal(lastMessage(), 'No more errors');
  assert.deepEqual(here(), at);
  await ed.type(':cn 1\n');
  assert.equal(lastMessage(), 'No more errors');
  await ed.type(':cp 4\n');
  assert.equal(lastMessage(), 'No previous error');
  await ed.type(':cc 5\n');
  assert.equal(lastMessage(), 'No error 5: the list has 4');
  await ed.type(':cn x\n');
  assert.equal(lastMessage(), 'E488: Trailing characters: x');
  await ed.type(':cn 0\n');
  assert.equal(lastMessage(), 'E488: Trailing characters: 0');
  assert.deepEqual(here(), at);
  // A new list starts again from its first entry; previous-error before the first is refused.
  ev(`(next-error-set-list! '(("ne-b.nix" 2 3 "first again")))`);
  await from('M-g p');
  assert.equal(lastMessage(), 'No previous error');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-b.nix', 2, 3]);
  ev("(next-error-set-list! '())");
  for (const k of ['M-g n', 'M-g p']) { await from(k); assert.equal(lastMessage(), 'No error list'); }
  await ed.type(':cc\n');
  assert.equal(lastMessage(), 'No error list');
});

test('a line past the end of the file and a column past the end of its line are clamped', async () => {
  ev(`(next-error-set-list! '(("ne-b.nix" 2 40) ("ne-b.nix" 99 2) ("ne-b.nix" 1 1)))`);
  await from('M-g n');
  assert.deepEqual(here(), ['ne-b.nix', 2, 8], 'the end of "  a = 1;": its last character, where Normal state keeps point');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-b.nix', 4, 1], 'the last line, "}" (the empty line after the final newline is none)');
  // An open buffer is visited as it is now: its lines are counted afresh, not followed from the list's making.
  await from('M-g n');
  ev('(insert "# top\\n")');
  ev(`(next-error-set-list! '(("ne-b.nix" 2 3)))`);
  await from('M-g n');
  assert.equal(ev('(buffer-substring (line-beginning-position) (line-end-position))'), '{');
});

test('a file that is gone is refused by name and the step still counts, so the next one goes past it', async () => {
  ev(`(next-error-set-list! '(("ne-gone.rs" 1 1) ("ne-c.py" 1 5)))`);
  await from('M-g n');
  assert.equal(lastMessage(), '(1 of 2) ne-gone.rs: no such file');
  assert.ok(!isOpen('ne-gone.rs'), 'no buffer was made for it');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-c.py', 1, 5]);
});

test('next-error-set-list! refuses a bad entry and keeps the list it had', async () => {
  ev(`(next-error-set-list! '(("ne-a.rs" 3 5 "kept")))`);
  for (const bad of ['5', "'(\"ne-a.rs\")", "'((\"ne-a.rs\"))", "'((\"\" 1))", "'((\"ne-a.rs\" 0))", "'((\"ne-a.rs\" 1.5))",
    "'((\"ne-a.rs\" 1 0))", "'((\"ne-a.rs\" 1 2 3))", "'((\"ne-a.rs\" 1 2 \"m\" 4))", "'((ne-a 1))", "'((\"ne-a.rs\" 1) (\"ne-b.nix\" -2))"])
    assert.throws(() => ev(`(next-error-set-list! ${bad})`), /next-error-set-list!/, bad);
  await from('M-g n');
  assert.deepEqual(here(), ['ne-a.rs', 3, 5]);
  assert.equal(lastMessage(), '(1 of 1) kept');
});

test('next-error-add-to-list! adds to the list its owner set, keeping the place; nothing once another list replaced it', async () => {
  ed.Ed.setWindowBuffer(ed.Ed.getBufferCreate('*ne-scratch*'));
  assert.equal(ev(`(next-error-set-list! '(("ne-a.rs" 2 9 "one")) "producer 1")`), 1);
  await from('M-g n');
  assert.deepEqual(here(), ['ne-a.rs', 2, 9]);
  assert.equal(ev(`(next-error-add-to-list! "producer 1" '(("ne-b.nix" 3 3 "two") ("ne-c.py" 2)))`), 3);
  assert.equal(ev(`(next-error-add-to-list! "producer 1" '())`), 3);
  await from('M-g n');
  assert.deepEqual(here(), ['ne-b.nix', 3, 3], 'the step goes on from the error visited');
  assert.equal(lastMessage(), '(2 of 3) two');
  /* A bad entry adds none of them. */
  assert.throws(() => ev(`(next-error-add-to-list! "producer 1" '(("ne-a.rs" 1) ("ne-a.rs" 0)))`), /next-error/);
  assert.equal(ev('(vector-length next-error--errors)'), 3);
  /* Another owner, no owner, and a list set with no owner take nothing. */
  assert.equal(ev(`(next-error-add-to-list! "producer 2" '(("ne-a.rs" 1)))`), false);
  ev(`(next-error-set-list! '(("ne-a.rs" 4 5)))`);
  assert.equal(ev(`(next-error-add-to-list! "producer 1" '(("ne-a.rs" 1)))`), false);
  assert.equal(ev(`(next-error-add-to-list! #f '(("ne-a.rs" 1)))`), false);
  assert.equal(ev('(vector-length next-error--errors)'), 1);
});

test('a step is a jump, by key and by ex command: C-o goes back to where point was in that buffer', async () => {
  ev(`(next-error-set-list! '(("ne-a.rs" 5 1) ("ne-a.rs" 3 5)))`);
  await ed.type(':e ne-a.rs\n');
  ev('(goto-char 1)');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-a.rs', 5, 1]);
  await ed.type(':cn\n');
  assert.deepEqual(here(), ['ne-a.rs', 3, 5]);
  await from('C-o');
  assert.deepEqual(here(), ['ne-a.rs', 5, 1], 'back from :cn');
  await from('C-o');
  assert.deepEqual(here(), ['ne-a.rs', 1, 1], 'back from M-g n, recorded once');
});

test('a refused step records no jump', async () => {
  ev(`(next-error-set-list! '(("ne-a.rs" 3 5) ("ne-gone.rs" 1)))`);
  await ed.type(':e ne-a.rs\n');
  ev('(goto-char 1)');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-a.rs', 3, 5]);
  const jumps = () => ed.E.current.jumps.map((j: { pos: number } | number) => (typeof j === 'number' ? j : j.pos));
  ev('(forward-line -1)');
  const before = jumps();
  await from('M-g n');
  assert.equal(lastMessage(), '(2 of 2) ne-gone.rs: no such file');
  assert.deepEqual(here(), ['ne-a.rs', 2, 1]);
  assert.deepEqual(jumps(), before, 'no jump at the unmoved point');
});

test('a column counts characters, a surrogate pair being one; a bignum line or column is clamped', async () => {
  ed.Ed.Store.set('ne-u.txt', '\u{1F600}\u{1F600}xy\n');
  ev(`(next-error-set-list! '(("ne-u.txt" 1 3) ("ne-u.txt" 1 2)
                               ("ne-b.nix" 100000000000000000000000 100000000000000000000000)
                               ("ne-b.nix" 3 100000000000000000000000)))`);
  const atPoint = () => ev('(buffer-substring (point) (min (point-max) (+ (point) 2)))');
  await from('M-g n');
  assert.equal(atPoint().slice(0, 1), 'x', 'column 3 is the third character');
  await from('M-g n');
  assert.equal(atPoint(), '\u{1F600}', 'column 2 is the second emoji, not inside the first');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-b.nix', 5, 1], 'the last line (the buffer was given a line above earlier), its end');
  assert.equal(lastMessage(), '(3 of 4) ne-b.nix:100000000000000000000000');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-b.nix', 3, 8], 'the end of the line');
});

test('a column in unit screen counts display cells (a tab to the next multiple of 8, a wide character 2); in utf-16 UTF-16 units; in byte UTF-8 bytes', async () => {
  ed.Ed.Store.set('ne-t.c', '\tint x = y;\n\treturn "s";\n日本 z\n');
  ed.Ed.Store.set('ne-v.nix', 'let a = "ééé"; in a + zz\n');
  ev(`(next-error-set-list! '(("ne-t.c" 1 17 #f screen) ("ne-t.c" 1 13 #f screen) ("ne-t.c" 2 16 #f screen)
                               ("ne-t.c" 3 6 #f screen) ("ne-t.c" 3 99 #f screen)
                               ("ne-u.txt" 1 5 #f utf-16) ("ne-u.txt" 1 2 #f utf-16) ("ne-u.txt" 1 3)
                               ("ne-v.nix" 1 26 #f byte) ("ne-v.nix" 1 11 #f byte) ("ne-v.nix" 1 99 #f byte) ("ne-u.txt" 1 9 #f byte)))`);
  const atPoint = () => ev('(buffer-substring (point) (min (point-max) (+ (point) 1)))');
  await from('M-g n');
  assert.deepEqual([...here(), atPoint()], ['ne-t.c', 1, 10, 'y'], 'cell 17 is the y after the tab');
  await from('M-g n');
  assert.equal(atPoint(), 'x');
  await from('M-g n');
  assert.equal(atPoint(), '"');
  await from('M-g n');
  assert.equal(atPoint(), 'z', 'each of 日本 takes two cells');
  await from('M-g n');
  assert.deepEqual([...here(), atPoint()], ['ne-t.c', 3, 4, 'z'], 'past the end: the end of the line (Normal state: its last character)');
  await from('M-g n');
  assert.equal(atPoint(), 'x', 'unit 5 is after two emoji');
  await from('M-g n');
  assert.deepEqual(here(), ['ne-u.txt', 1, 1], 'inside a pair: the pair');
  await from('M-g n');
  assert.equal(atPoint(), 'x', 'characters: the third');
  await from('M-g n');
  assert.deepEqual([...here(), atPoint()], ['ne-v.nix', 1, 23, 'z'], 'byte 26 is the z after three two-byte é (as nix counts)');
  await from('M-g n');
  assert.deepEqual([...here(), atPoint()], ['ne-v.nix', 1, 10, 'é'], 'byte 11, the second byte of the first é: that é');
  await from('M-g n');
  assert.deepEqual([...here(), atPoint()], ['ne-v.nix', 1, 24, 'z'], 'past the end: the end of the line');
  await from('M-g n');
  assert.deepEqual([...here(), atPoint()], ['ne-u.txt', 1, 5, 'x'], 'byte 9 is after two four-byte emoji (column 5 in the rope\'s UTF-16 units)');
  assert.throws(() => ev(`(next-error-set-list! '(("ne-t.c" 1 1 #f bytes)))`), /unit/);
  assert.throws(() => ev(`(visit-location "ne-t.c" 1 1 'bytes)`), /unit/);
});

test('in a served page a note is not looked for in the store: the visit goes to edwind, which may wait or refuse', async () => {
  const saved = ed.Ed.hooks.visit;
  const asked: string[] = [];
  const text: Record<string, string> = { 'notes/todo.org': '* one\n* two words\n' };
  /* edwind's visit as sync.ts answers it: a buffer 20 ms later, or false (it has shown why) for a note it cannot open. */
  ed.Ed.hooks.visit = (name: string) => { asked.push(name); return new Promise(resolve => setTimeout(() => {
    if (!(name in text)) { ed.Ed.message(`no file ${name}`); resolve(false); return; }
    const b = ed.Ed.getBufferCreate('todo.org'); b.text = text[name]; b.file = name; b.pt = 0;
    ed.Ed.setWindowBuffer(b); resolve(b);
  }, 20)); };
  try {
    assert.equal(ed.Ed.Store.get('notes/todo.org'), null, 'the note is not a stored file');
    ev(`(next-error-set-list! '(("notes/todo.org" 2 3 "a note") ("notes/gone.org" 1)))`);
    ed.Ed.setWindowBuffer(ed.Ed.getBufferCreate('*ne-scratch*'));
    await from('M-g n');
    assert.deepEqual(asked, ['notes/todo.org']);
    assert.deepEqual(here(), ['notes/todo.org', 2, 3]);
    assert.equal(lastMessage(), '(1 of 2) a note');
    await from('M-g n');
    assert.deepEqual(asked, ['notes/todo.org', 'notes/gone.org']);
    assert.equal(lastMessage(), 'no file notes/gone.org');
    assert.deepEqual(here(), ['notes/todo.org', 2, 3], 'a refused visit leaves point');
  } finally { ed.Ed.hooks.visit = saved; }
});

test('the desktop program attached to edwind: a note goes to edwind unasked, its own files are asked of the file system', async () => {
  const savedVisit = ed.Ed.hooks.visit, savedServed = ed.Ed.hooks.servedPath;
  const disk: Record<string, string> = { '/ne/ne-here.rs': 'fn a() {}\nfn b() {}\n' };
  const asked: string[] = [];
  let reads = 0;
  const resolve = (n: string) => (n.startsWith('/') ? n : '/ne/' + n);
  ed.Ed.host.files = {
    resolve, truename: resolve, label: (p: string) => p.replace(/^\/ne\//, ''), cwd: '/ne', list: () => [],
    read: (n: string) => { reads++; return disk[resolve(n)] ?? null; },
    exists: (n: string) => resolve(n) in disk,
    write() { throw new Error('not written'); }, remove() { throw new Error('not removed'); },
  };
  /* As native/js/main.ts sets them: notes go to edwind, every other file is opened here. */
  ed.Ed.hooks.servedPath = (p: string) => resolve(p).startsWith('/ne/notes/');
  const hook = (name: string) => {
    if (ed.Ed.hooks.servedPath(name)) { asked.push(name); ed.Ed.message(`no file ${name}`); return Promise.resolve(false); }
    ed.Ed.hooks.visit = null; try { return ed.Ed.visit(name); } finally { ed.Ed.hooks.visit = hook; }
  };
  ed.Ed.hooks.visit = hook;
  try {
    ev(`(next-error-set-list! '(("notes/gone.org" 1) ("ne-there.rs" 1) ("ne-here.rs" 2 4)))`);
    ed.Ed.setWindowBuffer(ed.Ed.getBufferCreate('*ne-scratch*'));
    await from('M-g n');
    assert.deepEqual(asked, ['notes/gone.org'], 'the note went to edwind without being looked for here');
    await from('M-g n');
    assert.equal(lastMessage(), '(2 of 3) ne-there.rs: no such file');
    assert.equal(reads, 0, 'whether it exists was asked, the file not read');
    assert.ok(!ed.E.buffers.some((b: { file: string | null }) => b.file === '/ne/ne-there.rs'), 'no buffer was made for it');
    await from('M-g n');
    assert.deepEqual(here(), ['/ne/ne-here.rs', 2, 4]);
  } finally { delete ed.Ed.host.files; ed.Ed.hooks.visit = savedVisit; ed.Ed.hooks.servedPath = savedServed; }
});
