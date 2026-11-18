/* Editing extras that need the display or the key queue: avy jumps, pulse after a jump,
   electric pairs and balanced brackets in Lisp, fill-paragraph, centered view, bookmarks, the save hook, face colours. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, signal, truthy, listOf, arr, NIL } = L;
/* D and CMD as this file uses them: a procedure takes the argument array. */
type ExtrasPrim = (args: SchemeValue[]) => SchemeValue | void | Promise<SchemeValue | void>;
/* The interactive spec CMD takes. */
type ExtrasSpec = Parameters<LispApi['CMD']>[1];
/* A bookmark as storage keeps it. */
interface ExtrasBookmark { buffer: string; file: string | null; pt: number }
const { D, CMD }: {
  D: <F extends ExtrasPrim>(name: string, args: string, doc: string, fn: F) => F;
  CMD: <F extends ExtrasPrim>(name: string, spec: ExtrasSpec, args: string, doc: string, fn: F) => F;
} = L;
const cur = () => E.current;
const { bol, eol, lineNo } = Ed;
const str = (x: SchemeValue): string => { if (typeof x !== 'string') signal('wrong-type-argument', 'expected a string, got', x); return x as string; };

L.defvar('fill-column', 70, 'Column at which fill-paragraph wraps.');
L.defvar('avy-keys', 'asdfghjklqwertyuiopzxcvbnm', 'Letters used for avy labels, in order of preference.');
L.defvar('before-save-hook', NIL, 'Procedures called before a buffer is saved.');

/* ---------- avy: jump to a visible place by typing its label ---------- */
function visibleRange(w: EdWindow) {
  const b = w.buffer, t = b.rope;
  const lastLs = Ed.lineStartB(b, Math.max(1, w.lastLine || Ed.lineNoB(b, w.start)));
  return [w.start, eol(t, lastLs)];
}
function labelsFor(n: number) {
  const keys = String(L.get('avy-keys') || 'asdfghjkl');
  if (n <= keys.length) return [...keys].slice(0, n);
  const out: string[] = [];
  const single = Math.max(0, keys.length - Math.ceil((n - keys.length) / (keys.length - 1)));
  for (let i = 0; i < single && out.length < n; i++) out.push(keys[i]);
  for (let i = single; i < keys.length && out.length < n; i++) for (let j = 0; j < keys.length && out.length < n; j++) out.push(keys[i] + keys[j]);
  return out;
}
async function avyPick(positions: number[], w: EdWindow) {
  if (!positions.length) signal('user-error', 'No matches on screen');
  if (positions.length === 1) return positions[0];
  const labels = labelsFor(positions.length);
  let live = positions.map((p, i) => ({ p, label: labels[i] }));
  let typed = '';
  try {
    for (;;) {
      E.avy = { win: w, labels: new Map(live.map(x => [x.p, x.label.slice(typed.length)])) };
      const k = await Ed.nextKey();
      if (k === 'ESC' || k === 'C-g') Ed.quietQuit();
      const ch = Ed.keyChar(k);
      if (!ch) continue;
      typed += ch;
      live = live.filter(x => x.label.startsWith(typed));
      if (!live.length) signal('user-error', 'No match for ' + typed);
      if (live.length === 1 || live.every(x => x.label === typed)) return live[0].p;
    }
  } finally { E.avy = null; }
}
function jumpTo(p: number) { const b = cur(); EC.pushJump(b, b.pt); b.pt = p; pulse(b); }
function pulse(b: EdBuffer) { E.pulse = { b, ls: bol(b.rope, b.pt), t: Date.now() }; setTimeout(() => { if (E.pulse && Date.now() - E.pulse.t >= 350) { E.pulse = null; Ed.render(); } }, 400); }
CMD('avy-goto-char', async () => [await Ed.readChar('char: ')], 'char', 'Jump to a visible occurrence of CHAR, chosen by its label (SPC a).', async ([c]) => {
  const b = cur(), w = E.sel!, [s, e] = visibleRange(w), ch = L.chr(c)!.toLowerCase(), t = b.rope, out = [];
  for (let k = s; k <= e && k < t.length; k++) if (t.at(k)!.toLowerCase() === ch) out.push(k);
  jumpTo(await avyPick(out, w)); return false;
});
CMD('avy-goto-char-2', async () => { const a = await Ed.readChar('char 1: '); const b = await Ed.readChar('char 2: '); return [a, b]; }, 'c1 c2', 'Jump to a visible pair of characters.', async ([c1, c2]) => {
  const b = cur(), w = E.sel!, [s, e] = visibleRange(w), pair = (L.chr(c1)! + L.chr(c2)!).toLowerCase(), t = b.rope.slice(s, e + 2).toLowerCase(), out = [];
  for (let k = t.indexOf(pair); k >= 0 && s + k <= e; k = t.indexOf(pair, k + 1)) out.push(s + k);
  jumpTo(await avyPick(out, w)); return false;
});
CMD('avy-goto-line', '', '', 'Jump to a visible line, chosen by its label (SPC l).', async () => {
  const b = cur(), w = E.sel!, [s, e] = visibleRange(w), t = b.rope, out = [];
  for (let ls = bol(t, s); ls <= e; ) { out.push(ls); const le = eol(t, ls); if (le >= t.length) break; ls = le + 1; }
  const p = await avyPick(out, w); jumpTo(EC.firstNonBlank(b.rope, p)); return false;
});
CMD('avy-goto-symbol-1', async () => [await Ed.readChar('char: ')], 'char', 'Jump to a visible symbol that starts with CHAR (SPC s).', async ([c]) => {
  const b = cur(), w = E.sel!, [s, e] = visibleRange(w), ch = L.chr(c)!.toLowerCase(), t = b.rope, out = [];
  const sym = /[\p{L}\p{N}_\-!?*<>=+\/]/u;
  for (let k = s; k <= e && k < t.length; k++) if (t.at(k)!.toLowerCase() === ch && (k === 0 || !sym.test(t.at(k - 1)!))) out.push(k);
  jumpTo(await avyPick(out, w)); return false;
});
CMD('avy-goto-word-1', async () => [await Ed.readChar('char: ')], 'char', 'Jump to a visible word that starts with CHAR.', async ([c]) => L.call('avy-goto-symbol-1', [c]));
for (const n of ['avy-goto-char', 'avy-goto-char-2', 'avy-goto-line', 'avy-goto-symbol-1', 'avy-goto-word-1']) { L.put(intern(n), 'evil-jump', true); L.put(intern(n), 'evil-repeat', intern('abort')); }
D('pulse-line', '', 'Flash the line at point for a moment.', () => { pulse(cur()); return false; });
for (const n of ['evil-goto-line', 'evil-goto-first-line', 'evil-jump-backward', 'evil-jump-forward', 'evil-search-next', 'evil-search-previous', 'evil-goto-mark', 'evil-goto-mark-line', 'consult-line', 'consult-imenu'])
  L.addHook('post-command-pulse', intern(n));
const prevPost = H.postCommand;
H.postCommand = (def, b, failed) => {
  if (prevPost) prevPost(def, b, failed);
  if (failed || E.depth > 0) return;
  const s = L.cmdSym(def);
  if (arr(L.get('post-command-pulse') ?? NIL).includes(s)) pulse(E.current);
};

/* ---------- electric pairs in Insert state, and balanced brackets in Lisp buffers ---------- */
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"' };
/* A buffer of Lisp code that keeps its brackets balanced: a buffer of a Lisp dialect, not a minibuffer, with
   electric-pair-mode on (SPC t e turns it all off). */
const lispBrackets = (b: EdBuffer) => Ed.isLisp(b) && !b.minibuf && !b.readOnly && truthy(L.get('electric-pair-enabled'));
const dia = (b: EdBuffer) => Ed.lispDialect(b) || 'scheme';
const unbalanced = () => signal('user-error', 'That would unbalance the brackets');
/* Replace FROM..TO with TEXT and put point at PT, or refuse when that leaves the brackets unbalanced. SPAN is
   balanceSpan's. */
function balancedEdit(b: EdBuffer, span: [number, number], from: number, to: number, text: string, pt: number) {
  if (!Ed.keepsBalance(b.rope, Ed.lexOf(b)!, span, from, to, text, dia(b))) unbalanced();
  Ed.replaceText(b, from, to, text); b.pt = pt;
}
/* Type CH at point in a Lisp buffer (ESC the character read after a backslash), keeping the brackets balanced;
   false when the text around point is not balanced to begin with, for the caller to insert CH as typed.
   In code ( and [ (and { in Clojure) insert a pair, with a blank between it and an atom next to it; ) and ] (and })
   move out of the list around point; " inserts an empty string; ; before more code on the line puts that code on a line of its own;
   | after # opens and closes a #| |# comment. In a string " inserts \", or steps over the closing quote. A
   backslash comes with the character after it. Anything else is inserted as typed, if that keeps the brackets
   balanced. Point between a backslash and the character it escapes is taken past that character first. */
function lispSelfInsert(b: EdBuffer, ch: string, esc: string | null) {
  const t = b.rope, cls = Ed.lexOf(b)!, n = t.length;
  let p = b.pt;
  if (p > 0 && p < n && Ed.escapingAt(t, cls, p - 1)) p++;
  const span = Ed.balanceSpan(t, cls, p, p, dia(b));
  if (!span) return false;
  const put = (text: string, at = text.length) => balancedEdit(b, span, p, p, text, p + at);
  const prev = p > 0 ? t.charAt(p - 1) : '', next = p < n ? t.charAt(p) : '';
  if (ch === '\\' && esc !== null && !Ed.inCommentAt(t, cls, p)) return put('\\' + esc), true;
  if (Ed.inStringAt(t, cls, p)) {
    const s = Ed.stringAt(t, cls, p - 1)!;
    if (ch === '"' && s[2] && p === s[1] - 1) b.pt = p + 1;
    else put(ch === '"' ? '\\"' : ch);
    return true;
  }
  if (Ed.inCommentAt(t, cls, p)) return put(ch), true;
  const braces = dia(b) === 'clojure';
  if (ch === '(' || ch === '[' || (braces && ch === '{')) {
    let q = p; while (q > 0 && !/[\s()[\]{}";'`,]/.test(t.charAt(q - 1))) q--;
    /* No blank after a # prefix (#( #u8( #s(, Clojure's #{ and #?( ), as the reader takes it with its list. */
    const hash = q < p && t.charAt(q) === '#' && !t.slice(q, p).includes('\\');
    const pre = prev && !/[\s([{`',@~]/.test(prev) && !hash ? ' ' : '';
    const post = next && !/[\s)\]}]/.test(next) ? ' ' : '';
    put(pre + ch + PAIRS[ch] + post, pre.length + 1);
  } else if (ch === ')' || ch === ']' || (braces && ch === '}')) {
    const e = Ed.upListForward(t, cls, p);
    if (e === null) signal('user-error', 'No list to close here');
    b.pt = e!;
  } else if (ch === '"') put('""', 1);
  else if (ch === ';' && prev !== '#') {
    let code = false;
    for (let k = p, e = Ed.eol(t, p); k < e && !code; k++) code = !/\s/.test(t.charAt(k)) && cls[k] !== Ed.C.CMT;
    if (!code) return put(';'), true;
    put(';\n', 1);
    const at = b.pt; b.pt = at + 1; Ed.indentLine(b); b.pt = at;
  } else if (ch === '|' && prev === '#') put('||#', 1);
  else put(ch);
  return true;
}
{
  const sic = L.toFn(intern('self-insert-command'));
  /* A backslash typed in Lisp code or a string reads the character it escapes, so the two go in together. A key
     that is no character (ESC, C-g, <left>) inserts nothing and is run as typed, so ESC still leaves Insert state. */
  const spec = async () => {
    const args = await Ed.specArgs(sic.interactive as string);
    const b = cur(), ch = L.chr(L.get('last-command-event'));
    if (ch === '\\' && lispBrackets(b) && EC.stateOf(b) !== 'replace' && !Ed.inCommentAt(b.rope, Ed.lexOf(b)!, b.pt)) {
      const k = await Ed.nextKey(), c = Ed.keyChar(k);
      if (c === null) { Ed.unreadKeys([k], E.lastKeyReal); args.push(false); } else args.push(L.mkchar(c));
    }
    return args;
  };
  CMD('self-insert-command', spec, sic.params!, sic.doc!, ([n, esc]) => {
    const b = cur(), ch = L.chr(L.get('last-command-event'));
    const st = EC.stateOf(b);
    const count = Math.max(1, L.absent(n) ? 1 : n as number);
    if (esc === false) return false;
    if (ch && st === 'replace' && lispBrackets(b)) {
      /* Replace state overwrites the character at point, as evil-core's command does, or inserts at a line's end:
         each such edit is judged by the guard first and refused when it would unbalance the brackets. */
      for (let k = 0; k < count; k++) {
        const t = b.rope, cls = Ed.lexOf(b)!, p = b.pt;
        const to = p < t.length && t.charAt(p) !== '\n' && ch !== '\n' ? p + 1 : p;
        const span = Ed.balanceSpan(t, cls, p, to, dia(b));
        if (span && !Ed.keepsBalance(t, cls, span, p, to, ch, dia(b))) unbalanced();
        sic([1]);
      }
      return false;
    }
    if (ch && st !== 'replace' && lispBrackets(b)) {
      const e = esc === undefined ? null : L.chr(esc);
      let done = 0;
      while (done < count && lispSelfInsert(b, ch, e)) done++;
      if (done === count) return false;
      if (e !== null) { Ed.insertText(b, '\\' + e); return false; }
      if (done) return sic([count - done]);
    }
    if (truthy(L.get('electric-pair-enabled')) && st !== 'replace' && ch && (ch in PAIRS || ch === ')' || ch === ']' || ch === '}') && !b.readOnly) {
      const next = b.rope.at(b.pt), prev = b.rope.at(b.pt - 1);
      if (count === 1) {
        if ((ch === ')' || ch === ']' || ch === '}') && next === ch) { b.pt++; return false; }
        if (ch === '"' && next === '"' && prev !== '\\') { b.pt++; return false; }
        if (ch in PAIRS && !(ch === '"' && /[\p{L}\p{N}]/u.test(prev || ''))) {
          Ed.insertText(b, ch + PAIRS[ch]); b.pt--; return false;
        }
      }
    }
    return sic([n]);
  });
}
/* DEL in Replace state puts back the character the last replacement took, before point wherever point now is: in a
   Lisp buffer that edit is judged by the guard too, and refused, the character kept for a later DEL, when it would
   unbalance the brackets. */
{
  const rb = L.toFn(intern('evil-replace-backspace'));
  CMD('evil-replace-backspace', '', '', rb.doc!, () => {
    const b = cur(), replaced = E.ins ? E.ins.replaced : [];
    if (lispBrackets(b) && b.pt > 0 && replaced.length) {
      const t = b.rope, cls = Ed.lexOf(b)!, p = b.pt, old = replaced[replaced.length - 1];
      const span = Ed.balanceSpan(t, cls, p - 1, p, dia(b));
      if (span && !Ed.keepsBalance(t, cls, span, p - 1, p, old ?? '', dia(b))) unbalanced();
    }
    return rb([]);
  });
}
/* The ad hoc toggles are minor modes (R4.25). Each one's state is its -enabled variable. */
Ed.defineMinorMode({ name: 'rainbow-delimiters-mode', global: true, init: true, pretty: 'Rainbow delimiters', doc: 'Toggle colouring parentheses by depth in Scheme buffers. The state is rainbow-delimiters-enabled.' });
Ed.defineMinorMode({ name: 'electric-pair-mode', global: true, init: true, pretty: 'Electric pairs', doc: 'Toggle inserting the closing bracket or quote when you type the opening one. The state is electric-pair-enabled.' });
/* The #| |# comment whose #| or |# holds the character at K, as [START, END], or null. The comment starts where its
   run of comment classes does, and ends at the first |# after its #|, as the lexer reads it. */
function blockCommentAt(t: EdText, cls: ArrayLike<number>, k: number): [number, number] | null {
  if (cls[k] !== Ed.C.CMT || (t.charAt(k) !== '#' && t.charAt(k) !== '|')) return null;
  let s = k; while (s > 0 && cls[s - 1] === Ed.C.CMT) s--;
  if (t.charAt(s) !== '#' || t.charAt(s + 1) !== '|') return null;
  const c = t.indexOf('|#', s + 2);
  return c >= 0 && (k <= s + 1 || k === c || k === c + 1) ? [s, c + 2] : null;
}
/* The text a deletion at point takes in a Lisp buffer, as [FROM, TO]: the character before point (FORWARD #f) or
   after it, widened to the whole list when it is a bracket, to the whole string when it is a string's quote, to
   both characters of a backslash escape, to the whole of a character literal and to the whole #| |# comment when it
   is a character of the comment's #| or |#. A forward deletion of a list's closing bracket or a string's closing
   quote from inside deletes nothing: it gives the position of the list's opening bracket or the string's opening
   quote, for point to move to, as lispy's C-d does (lispy-delete-sexp-from-within nil). */
function lispDeletion(t: EdText, cls: ArrayLike<number>, p: number, forward: boolean): [number, number] | number {
  const k = forward ? p : p - 1, c = t.charAt(k);
  /* In code a # or ? before the backslash (#\( ?\() makes a character literal of it, taken whole. */
  const escape = (s: number): [number, number] =>
    !Ed.inStringAt(t, cls, s + 1) && s > 0 && (t.charAt(s - 1) === '#' || t.charAt(s - 1) === '?') && (s === 1 || /[\s()[\]";'`,]/.test(t.charAt(s - 2))) ? [s - 1, s + 2] : [s, s + 2];
  if ((c === '#' || c === '?') && Ed.escapingAt(t, cls, k + 1) && !Ed.inStringAt(t, cls, k + 1) && (k === 0 || /[\s()[\]";'`,]/.test(t.charAt(k - 1))))
    return [k, Ed.forwardSexp(t, cls, k) ?? k + 3];
  if (Ed.escapingAt(t, cls, k)) return escape(k);
  if (Ed.escapingAt(t, cls, k - 1)) return escape(k - 1);
  if (cls[k] === Ed.C.PAR) {
    if (c === '(' || c === '[' || c === '{') {
      const e = Ed.forwardSexp(t, cls, k);
      if (e !== null) { let s = k; while (s > 0 && cls[s - 1] === Ed.C.QUO) s--; return [forward ? k : s, e]; }
    } else if (forward) {
      const s = Ed.upList(t, cls, p);
      if (s !== null) return s;
    } else {
      const s = Ed.backwardSexp(t, cls, k + 1);
      if (s !== null) return [s, k + 1];
    }
  }
  const block = blockCommentAt(t, cls, k);
  if (block) return block;
  if (c === '"') {
    const s = Ed.stringAt(t, cls, k);
    if (s && s[2] && forward && k === s[1] - 1 && k > s[0]) return s[0];
    if (s && s[2] && (k === s[0] || k === s[1] - 1)) return [s[0], s[1]];
  }
  return [k, k + 1];
}
D('electric-pair-delete', '&optional N FORWARD', `Delete as DEL (FORWARD #f) or C-d does when that is not plain: return #t if it did.
In a Lisp buffer with electric-pair-mode on, the N characters before or after point go one at a time (a negative N the
other way), a bracket taking its whole list, a string's quote its whole string, a backslash escape both its characters;
C-d on a list's closing bracket or a string's closing quote from inside moves point to the list's or string's start
and deletes nothing, ending the count there; a deletion that would leave the brackets unbalanced is refused.
Elsewhere, DEL between an empty pair of brackets or quotes deletes both.`, ([n, fwd]) => {
  const b = cur();
  let forward = truthy(fwd ?? false), count = L.absent(n) ? 1 : n as number;
  if (b.markActive) return false;
  if (lispBrackets(b) && count !== 0) {
    if (count < 0) { forward = !forward; count = -count; }
    for (let k = 0; k < count; k++) {
      const t = b.rope, cls = Ed.lexOf(b)!, p = b.pt;
      if (forward ? p >= t.length : p <= 0) signal(forward ? 'end-of-buffer' : 'beginning-of-buffer');
      const d = lispDeletion(t, cls, p, forward);
      const span = typeof d === 'number' ? Ed.balanceSpan(t, cls, p, p, dia(b)) : Ed.balanceSpan(t, cls, d[0], d[1], dia(b));
      if (!span) { if (k === 0) return false; Ed.deleteText(b, forward ? p : p - 1, forward ? p + 1 : p); continue; }
      if (typeof d === 'number') { b.pt = d; break; }
      balancedEdit(b, span, d[0], d[1], '', d[0]);
    }
    return true;
  }
  const prev = b.rope.at(b.pt - 1), next = b.rope.at(b.pt);
  if (!forward && count === 1 && truthy(L.get('electric-pair-enabled')) && prev! in PAIRS && PAIRS[prev!] === next && !b.readOnly) { Ed.deleteText(b, b.pt - 1, b.pt + 1); return true; }
  return false;
});
/* RET in a Lisp buffer: the text to put after the new line's indentation. Inside a ; comment with more of it after
   point, the comment goes on there, with its run of ; and a blank, so the rest of the comment stays a comment; else
   the empty string. Point between a backslash and the character it escapes is taken past that character first, and
   a new line that would still unbalance the brackets (between the # and ; of a datum comment) is refused. */
D('lisp-newline-prefix', '', 'The text RET puts after the new line\'s indentation in a Lisp buffer: the comment\'s ; and a blank inside a ; comment with more of it after point, else "". Refuses a new line that would unbalance the brackets.', () => {
  const b = cur();
  if (!lispBrackets(b)) return '';
  const t = b.rope, cls = Ed.lexOf(b)!;
  if (b.pt > 0 && b.pt < t.length && Ed.escapingAt(t, cls, b.pt - 1)) b.pt++;
  const p = b.pt;
  let prefix = '';
  if (Ed.inCommentAt(t, cls, p) && !/^\s*$/.test(t.slice(p, Ed.eol(t, p)))) {
    let s = p - 1; while (s > 0 && cls[s - 1] === Ed.C.CMT && t.charAt(s - 1) !== '\n') s--;
    const m = /^;+/.exec(t.slice(s, p));
    if (m) prefix = m[0] + ' ';
  }
  const span = Ed.balanceSpan(t, cls, p, p, dia(b));
  if (span && !Ed.keepsBalance(t, cls, span, p, p, '\n' + prefix, dia(b))) unbalanced();
  return prefix;
});

/* ---------- paragraphs, centred view, bookmarks ---------- */
CMD('fill-paragraph', '*', '', 'Re-wrap the paragraph at point to fill-column (SPC y w).', () => {
  const b = cur(), t = b.rope, width = Number(L.get('fill-column')) || 70;
  let s = bol(t, b.pt), e = eol(t, b.pt);
  if (/^\s*$/.test(t.slice(s, e))) return false;
  while (s > 0) { const ps = bol(t, s - 1); if (/^\s*$/.test(t.slice(ps, s - 1))) break; s = ps; }
  while (e < t.length) { const ne = eol(t, e + 1); if (/^\s*$/.test(t.slice(e + 1, ne))) break; e = ne; }
  const para = t.slice(s, e);
  const indent = (para.match(/^[ \t]*/) || [''])[0];
  const prefix = (para.match(/^[ \t]*((?:;+|#+|\/\/+|>)\s?)/) || ['', ''])[1];
  const words = para.split('\n').map(l => l.replace(/^[ \t]*/, '').replace(prefix ? new RegExp('^' + prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s?') : /$^/, '')).join(' ').split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const w of words) {
    if (line && (indent + prefix + line + ' ' + w).length > width) { lines.push(indent + prefix + line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(indent + prefix + line);
  const out = lines.join('\n');
  if (out !== para) { Ed.replaceText(b, s, e, out); b.pt = Math.min(b.pt, s + out.length); }
  return false;
});
L.defvar('centered-view-width', 100, 'Columns of text that centered-view-mode centres in the window (yath/centered-view-width).');
Ed.defineMinorMode({ name: 'centered-view-mode', pretty: 'Centered view', doc: 'Toggle centring this buffer’s text in a column of centered-view-width characters (SPC y c). The state is centered-view-enabled.',
  body: () => Ed.host.page.setVar('center-cols', String(Math.max(20, Number(L.get('centered-view-width')) || 100))) });
/* visual-line-mode is per buffer, as in Emacs: the buffer wraps whatever truncate-lines says, and j and k
   move by screen lines when evil-respect-visual-line-mode is on (init.scm binds them to the -visual-line motions). */
Ed.defineMinorMode({ name: 'visual-line-mode', lighter: ' Wrap', pretty: 'Visual-Line mode', doc: 'Toggle Visual Line mode in this buffer: long lines wrap and j and k move by screen lines (SPC y v). The state is visual-line-enabled.' });
const VERT = ['evil-next-line', 'evil-previous-line', 'evil-next-visual-line', 'evil-previous-visual-line'];
/* Move by screen rows using the rendered lines: the row below or above the cursor at the same x, kept
   as a goal across consecutive j and k. Rows that are not on screen fall back to buffer lines. */
D('evil--visual-line-move', 'COUNT', 'Move COUNT screen lines down (up if COUNT is negative) in a visual-line-mode buffer, keeping the x position; #f when this buffer is not in visual-line-mode.', ([n]) => {
  const b = cur(), w = E.sel, c = Number(n) || 0;
  if (!truthy(Ed.localValue(b, 'visual-line-enabled')) || !w || w.buffer !== b || !w.view) return false;
  const last = E.lastCommand instanceof L.Sym ? E.lastCommand.name : '';
  if (!VERT.includes(last)) E.goalX = null;
  const st = EC.stateOf(b), dir = c > 0 ? 1 : -1, t = b.rope;
  const rest = (k: number) => L.call('evil--line-move', [dir * (Math.abs(c) - k)]);
  for (let k = 0; k < Math.abs(c); k++) {
    Ed.render();
    const el = w.view.querySelector('.cur');
    if (!el) { rest(k); break; }
    const r = el.getBoundingClientRect(), lh = Ed.metrics(w).lh, vr = w.view.getBoundingClientRect();
    if (E.goalX === null || E.goalX === undefined) E.goalX = r.left + 1;
    const y = dir > 0 ? r.bottom + lh / 2 : r.top - lh / 2;
    if (y < vr.top || y > vr.bottom) { rest(k); break; }
    let q = Ed.posFromPoint(E.goalX, y, w);
    if (q === null) { rest(k); break; }
    const ls = bol(t, q), le = eol(t, q);
    if ((st === 'normal' || st === 'motion') && q >= le && le > ls) q = le - 1;
    if (q === b.pt) { rest(k); break; }
    b.pt = q;
  }
  L.set('evil-this-type', intern('exclusive'));
  return true;
});
Ed.defineMinorMode({ name: 'auto-fill-mode', lighter: ' Fill', pretty: 'Auto fill', doc: 'Toggle wrapping as you type past fill-column (SPC y a). The state is auto-fill-enabled.' });
const prevPost2 = H.postCommand;
H.postCommand = (def, b, failed) => {
  if (prevPost2) prevPost2(def, b, failed);
  if (failed || E.depth > 0 || !truthy(Ed.localValue(E.current, 'auto-fill-enabled'))) return;
  if (L.cmdSym(def) === intern('self-insert-command') && L.chr(L.get('last-command-event')) === ' ') {
    const buf = E.current, t = buf.rope, ls = bol(t, buf.pt);
    if (Ed.column(t, buf.pt) > (Number(L.get('fill-column')) || 70)) {
      let k = buf.pt - 1; while (k > ls && t.at(k) === ' ') k--;
      while (k > ls && t.at(k) !== ' ') k--;
      if (k > ls) { Ed.replaceText(buf, k, k + 1, '\n'); }
    }
  }
};
const BM = 'edwin:bookmarks';
function bookmarks(): Record<string, ExtrasBookmark> { try { return JSON.parse(Ed.host.storage.get(BM) || '{}'); } catch (e) { return E.bookmarks || {}; } }
function saveBookmarks(m: Record<string, ExtrasBookmark>) { E.bookmarks = m; try { Ed.host.storage.set(BM, JSON.stringify(m)); } catch (e) { /* in memory only */ } }
CMD('bookmark-set', async () => [await Ed.readMini('Bookmark name: ', '', () => Object.keys(bookmarks()), { kind: 'bookmark', def: cur().name })], 'name', 'Remember this place under NAME (SPC b m).', ([name]) => {
  const b = cur(), m = bookmarks(); m[name as string] = { buffer: b.name, file: b.file, pt: b.pt }; saveBookmarks(m); Ed.message(`Set bookmark ${name}`); return false;
});
CMD('bookmark-jump', async () => [await Ed.readMini('Jump to bookmark: ', '', () => Object.keys(bookmarks()), { kind: 'bookmark', require: true, annotate: n => { const x = bookmarks()[n]; return x ? `${x.file || x.buffer} L${x.pt}` : ''; } })], 'name', 'Go to the bookmark NAME (SPC RET).', ([name]) => {
  const x = bookmarks()[name as string]; if (!x) signal('user-error', `No bookmark named ${name}`);
  let b = Ed.getBuffer(x.buffer) || (x.file ? L.call('find-file', [x.file]) : null);
  if (!b) signal('user-error', `The buffer of bookmark ${name} is gone`);
  if (b instanceof Ed.Buffer) Ed.setWindowBuffer(b); b = E.win;
  (b as EdBuffer).pt = Math.min(x.pt, (b as EdBuffer).rope.length); pulse(b as EdBuffer); return false;
});
CMD('bookmark-delete', async () => [await Ed.readMini('Delete bookmark: ', '', () => Object.keys(bookmarks()), { kind: 'bookmark', require: true })], 'name', 'Forget the bookmark NAME.', ([name]) => { const m = bookmarks(); delete m[name as string]; saveBookmarks(m); return false; });

/* ---------- saving: before-save-hook (ws-butler, scm/prog.scm, is on it) ---------- */
{
  const save = L.toFn(intern('save-buffer'));
  CMD('save-buffer', save.interactive as ExtrasSpec, save.params!, save.doc!, args => {
    L.runHook('before-save-hook');
    return save(args);
  });
}

/* ---------- faces: colours and fonts are CSS variables ---------- */
D('set-face-color!', 'face color', 'Set the colour of FACE: bg fg dim cursor region kw fn st cm co pa or any CSS token name.', ([f, c]) => { Ed.host.page.setVar(f instanceof L.Sym ? f.name : str(f), str(c)); return false; });
D('set-font-size!', 'px', 'Set the text size in pixels.', ([n]) => { for (const f of E.frames) for (const v of f.root!.querySelectorAll<HTMLElement>('.text')) v.style.fontSize = n + 'px'; Ed.host.page.setVar('text-size', n + 'px'); E.metricsGen++; return false; });
D('set-font-family!', 'family', 'Set the text font family.', ([f]) => { Ed.host.page.setVar('font-mono', str(f) + ', ' + 'ui-monospace, monospace'); E.metricsGen++; return false; });
D('theme-dark?', '', '#t when the selected frame shows the dark theme (Ed.display.themeOf).', () => Ed.display.themeOf(E.frame) === 'dark');
})();
