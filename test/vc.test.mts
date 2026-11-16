// The commit message buffer (src/vc.ts, vc-message-mode in scm/emacs.scm) in the headless runtime: the faces of
// the summary, its overlong part, a second line that is not blank and the comment lines; the message C-c C-c
// gives, cleaned as git stripspace --strip-comments cleans it; C-c C-k and killing the buffer abort; what is refused.
// One Edwin per process, so the cases run in order.
// Run: node --test test/vc.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startEdwin, type Edwin } from './headless.mts';

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
