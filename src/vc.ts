/* Version control for Edwin (docs/steps.md, "The commit message buffer"): the parts git and jj share. Here so
   far: the buffer a commit message is written in.

   Vc.message opens a buffer in vc-message-mode (scm/emacs.scm) holding a message to edit, and gives a promise
   of what the user leaves in it: C-c C-c (vc-message-finish) gives the message without its comment lines,
   cleaned as `git stripspace --strip-comments` cleans it; C-c C-k (vc-message-abort), or killing the buffer,
   gives null. The opener runs the program that takes the message (git commit, jj describe), from TypeScript:
   a Scheme form can finish or abort a message, never open one or say what is done with it.

   The mode shows the summary line (the first line that is neither blank nor a comment) in its own face, the
   characters past vc-message-summary-max-length and a second line that is not blank as warnings, and the
   comment lines (those that start with the opener's comment prefix, `#` for git, `JJ:` for jj) as comments. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD } = L;
const cur = () => E.current;

L.defvar('vc-message-summary-max-length', 68, 'The longest summary line a commit message should have: the characters past it show as a warning (vc-message-mode).');
function maxLength(): number {
  const n = L.get('vc-message-summary-max-length');
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 68;
}

/* White space as git stripspace counts it: space, tab and carriage return only (not \v, \f or Unicode spaces
   such as U+00A0). A blank line holds nothing else. */
const TRAILING_SPACE = /[ \t\r]+$/;
const isBlank = (line: string) => !/[^ \t\r]/.test(line);

/* TEXT without the lines that start with COMMENT, trailing white space and runs of blank lines, as
   `git stripspace --strip-comments` gives it: '' when nothing is left, else it ends in one newline. */
function cleanMessage(text: string, comment: string): string {
  const out: string[] = [];
  let blank = false;
  for (const line of text.split('\n')) {
    if (comment && line.startsWith(comment)) continue;
    const l = line.replace(TRAILING_SPACE, '');
    if (!l) { blank = out.length > 0; continue; }
    if (blank) out.push('');
    blank = false;
    out.push(l);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/* b.vcMessage: the comment prefix of a buffer whose message an opener waits for, and how to give it the
   message (null: none). Gone once it has its answer. */
function pendingOf(b: EdBuffer): VcPending {
  const p = b.vcMessage;
  if (!p) signal('user-error', 'No commit waits for a message in this buffer');
  return p!;
}
function settle(b: EdBuffer, msg: string | null) {
  const p = b.vcMessage;
  if (!p) return;
  delete b.vcMessage;
  p.done(msg);
}

/* Open a buffer named NAME holding TEXT (point at its start) in the selected window, in vc-message-mode, its
   comment lines those that start with COMMENT. The promise gives the cleaned message, or null when the user
   aborts or kills the buffer. NAME must not name a live buffer: a message is never written over another
   buffer, nor over a message still being written. */
function message(opts: VcMessageOptions): Promise<string | null> {
  const { name, text = '', comment = '#' } = opts;
  if (typeof name !== 'string' || !name) signal('error', 'Vc.message needs a buffer name');
  if (typeof text !== 'string' || typeof comment !== 'string' || !comment) signal('error', 'Vc.message: TEXT is a string and COMMENT a non-empty one');
  if (Ed.getBuffer(name)) signal('user-error', `${name} is already open: finish (C-c C-c) or abort (C-c C-k) the message there first`);
  const b = Ed.getBufferCreate(name);
  b.text = text; b.pt = 0; b.modified = false; b.undo = []; b.redo = [];
  /* A signal from the mode's hooks (a broken vc-message-mode-hook in init.scm) leaves no buffer behind: a
     leftover one, with no message waiting, would refuse every later message under its name. */
  try { Ed.switchMajorMode(b, 'vc-message-mode'); }
  catch (e) { L.call('kill-buffer', [b]); throw e; }
  return new Promise<string | null>(done => {
    b.vcMessage = { comment, done };
    Ed.setWindowBuffer(b); Ed.scheduleRender();
  });
}

CMD('vc-message-finish', '', '', 'Give the commit message in this buffer to what waits for it, without its comment lines, and kill the buffer (C-c C-c). An empty message is refused.', () => {
  const b = cur(), p = pendingOf(b), msg = cleanMessage(b.text, p.comment);
  if (!msg) signal('user-error', 'The message is empty: write one, or abort with C-c C-k');
  settle(b, msg);
  L.call('kill-buffer', [b]);
  return false;
});
CMD('vc-message-abort', '', '', 'Abort the commit this buffer\'s message is for, and kill the buffer (C-c C-k).', () => {
  const b = cur();
  pendingOf(b);
  settle(b, null);
  L.call('kill-buffer', [b]);
  Ed.message('Message aborted');
  return false;
});
/* A message buffer killed another way aborts its message. */
L.D('vc--message-killed', '', 'kill-buffer-hook: a commit message buffer killed before C-c C-c aborts its commit.', () => { settle(cur(), null); return false; });
L.addHook('kill-buffer-hook', intern('vc--message-killed'));
for (const n of ['vc-message-finish', 'vc-message-abort']) L.put(intern(n), 'evil-repeat', intern('abort'));

/* ---------- faces ---------- */
const FACES = ['', 'vc-message-summary', 'vc-message-warning', 'cm'];
const F = { SUMMARY: 1, WARNING: 2, COMMENT: 3 };
interface VcLex { ver: number; from: number; to: number; max: number; comment: string; cls: Uint8Array; names: string[] }
const prevLexSeg = H.lexSeg;
H.lexSeg = (b, from, to, seg) => {
  if (b.mode !== 'vc-message-mode') return prevLexSeg ? prevLexSeg(b, from, to, seg) : null;
  const comment = b.vcMessage ? b.vcMessage.comment : '#', max = maxLength();
  const c = b._vlx as VcLex | undefined;
  if (c && c.ver === b.ver && c.from === from && c.to === to && c.max === max && c.comment === comment) return c;
  const all = b.text, text = seg as string, cls = new Uint8Array(text.length);
  /* The summary line: the first that is neither blank nor a comment; the line after it is the second. */
  let summary = -1, second = -1;
  for (let ls = 0; ls < all.length;) {
    let le = all.indexOf('\n', ls); if (le < 0) le = all.length;
    const line = all.slice(ls, le);
    if (!isBlank(line) && !line.startsWith(comment)) { summary = ls; second = le < all.length ? le + 1 : -1; break; }
    ls = le + 1;
  }
  for (let ls = 0; ls < text.length;) {
    let le = text.indexOf('\n', ls); if (le < 0) le = text.length;
    const start = from + ls, line = text.slice(ls, le), lineStart = all.lastIndexOf('\n', start - 1) + 1;
    if (all.startsWith(comment, lineStart)) cls.fill(F.COMMENT, ls, le);
    else if (lineStart === summary) {
      const past = Math.max(ls, Math.min(le, ls + max - (start - lineStart)));
      cls.fill(F.SUMMARY, ls, past); cls.fill(F.WARNING, past, le);
    }
    else if (lineStart === second && !isBlank(line)) cls.fill(F.WARNING, ls, le);
    ls = le + 1;
  }
  return b._vlx = { ver: b.ver, from, to, max, comment, cls, names: FACES };
};
const CSS = `
.text .vc-message-summary { color: var(--fn); font-weight: 600; }
.text .vc-message-warning { color: var(--rb1); text-decoration: underline; }
`;
Ed.host.page.addStyle('vc-css', CSS);

globalThis.Vc = { message, cleanMessage };
})();
