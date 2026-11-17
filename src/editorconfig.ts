/* EditorConfig (docs/steps.md, "EditorConfig"): a visited file's .editorconfig files, read from its directory up
   to the one that says root = true, set its buffer's indent, fill column, final newline and trimming.

   EditorConfig.properties is the core library's job (editorconfig-core-c, whose test suite edwin-prog runs it
   against): every .editorconfig from the outermost to the nearest, each one's sections in order, a section's
   pairs taken when its glob matches the file's path from that file's directory, the later pair winning; names
   lowercased, and the values of the standard properties; then indent_size and tab_width filled in from each
   other. A value of unset is kept as the core library keeps it, and applies as no value.

   The globs are matched by a table over (pattern position, path position), never by a regular expression, so a
   hostile pattern from a cloned repository costs its length times the path's, with no backtracking; and the
   search upward stops before a file that would bring the sections read past MAX_GLOBS (each counted as its
   name's length and SECTION_COST), which bounds a visit's matching at about MAX_GLOBS times the path's length.

   What the properties set, in the buffer only (buffer-local), on find-file-hook after the file's mode set its
   own indent, and again after a later major mode switch (which drops buffer-local values):
     indent_style            indent-tabs-mode (tab #t, space #f)
     indent_size, tab_width  tab-width (TAB's stops) and evil-shift-width (> and <): indent_size, or tab_width
                             where indent_size is tab
     max_line_length         fill-column
     insert_final_newline    require-final-newline
     trim_trailing_whitespace true: a save deletes the trailing blanks of every line; false: ws-butler-mode #f
   Files are read through the store (Ed.Store), so the desktop program reads its disk, edwind its own under its
   path rules, and a buffer whose file is edwind's (a shared one) or has no absolute path is left alone. The
   search runs on every visit, in every directory up to /, so a cloned repository decides what it reads: the
   store is asked for a regular file of at most MAX_FILE bytes (links followed), and refuses a device, a FIFO
   or a larger file before reading a byte of it; a refusal is as if the file were absent. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E;
const { intern, signal, listOf } = L;

/* A .editorconfig past MAX_FILE bytes (characters, where the store is the host's storage) is skipped, as if
   absent. The sections of all files of one search together, each counted as its name's length and SECTION_COST
   more (the nodes every match adds, whatever the name), past MAX_GLOBS end the search: a real file's come to a
   few hundred. */
const MAX_FILE = 1 << 20, MAX_GLOBS = 8192, SECTION_COST = 16;
/* The properties the core library lowercases the values of. */
const KNOWN = new Set(['indent_style', 'indent_size', 'tab_width', 'end_of_line', 'charset', 'insert_final_newline', 'trim_trailing_whitespace', 'max_line_length']);

type EcFile = EditorConfigFile;

/* One file's text: comment lines (# or ;, after blanks) and blank lines skipped; [NAME] opens a section, NAME
   kept as written between the first [ and the last ]; KEY = VALUE, split at the first =, both trimmed. The pairs
   before the first section are the preamble, where only root counts. A # or ; inside a value is part of it. */
function parse(text: string): EcFile {
  const out: EcFile = { root: false, sections: [] };
  let pairs: [string, string][] | null = null;
  for (const line of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (!t || t[0] === '#' || t[0] === ';') continue;
    if (t[0] === '[') {
      if (t.length > 1 && t[t.length - 1] === ']') { pairs = []; out.sections.push([t.slice(1, -1), pairs]); }
      continue;
    }
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim().toLowerCase();
    let value = t.slice(eq + 1).trim();
    if (!key) continue;
    if (KNOWN.has(key)) value = value.toLowerCase();
    if (pairs) pairs.push([key, value]);
    else if (key === 'root') out.root = value.toLowerCase() === 'true';
  }
  return out;
}

/* ---------- globs ----------
   * any characters but /; ** any characters; ? one character but /; [abc], [a-z], [!abc] one character but /
   (a [ with no ] after it, or with a / before its ], is itself); {a,b} either (nested, a part may be empty);
   {N1..N2} an integer in that range written with no leading zero; a { with one part, or none ({}, {word}), is
   itself, as is one with no closing }; \ makes the next character itself. A glob with no / matches in any
   directory below its file's; one with a / matches from its file's directory, a leading / or not, and a
   leading **\/ or /**\/ matches no directory too.
   Characters are code points. */
type EcItem =
  | { k: 'lit'; c: string } | { k: 'one' } | { k: 'star' } | { k: 'globstar' } | { k: 'dirs' }
  | { k: 'cls'; neg: boolean; set: [string, string][] } | { k: 'alt'; alts: EcItem[][] } | { k: 'num'; lo: number; hi: number };

/* The index of the ] closing the [ at I, or -1 when there is none, or a / comes first. */
function bracketEnd(p: string[], i: number, to: number) {
  for (let j = i + 1; j < to; j++) {
    if (p[j] === '\\') { j++; continue; }
    if (p[j] === '/') return -1;
    if (p[j] === ']' && j > i + 1 && !(j === i + 2 && (p[i + 1] === '!' || p[i + 1] === '^'))) return j;
  }
  return -1;
}
/* The index of the } closing the { at I, counting nested braces, or -1. */
function braceEnd(p: string[], i: number, to: number) {
  let depth = 0;
  for (let j = i; j < to; j++) {
    if (p[j] === '\\') { j++; continue; }
    if (p[j] === '{') depth++;
    else if (p[j] === '}' && --depth === 0) return j;
  }
  return -1;
}
function parseGlob(p: string[], from: number, to: number): EcItem[] {
  const out: EcItem[] = [];
  const lit = (c: string) => out.push({ k: 'lit', c });
  for (let i = from; i < to;) {
    const c = p[i];
    if (c === '\\') { lit(i + 1 < to ? p[i + 1] : '\\'); i += 2; }
    else if (c === '*') { if (i + 1 < to && p[i + 1] === '*') { out.push({ k: 'globstar' }); i += 2; } else { out.push({ k: 'star' }); i++; } }
    else if (c === '?') { out.push({ k: 'one' }); i++; }
    else if (c === '/' && i + 3 < to && p[i + 1] === '*' && p[i + 2] === '*' && p[i + 3] === '/') { out.push({ k: 'dirs' }); i += 4; }
    else if (c === '[') {
      const end = bracketEnd(p, i, to);
      if (end < 0) { lit('['); i++; continue; }
      let j = i + 1;
      const neg = p[j] === '!' || p[j] === '^';
      if (neg) j++;
      const set: [string, string][] = [];
      while (j < end) {
        let a = p[j++];
        if (a === '\\' && j < end) a = p[j++];
        if (p[j] === '-' && j + 1 < end) {
          j++;
          let z = p[j++];
          if (z === '\\' && j < end) z = p[j++];
          set.push([a, z]);
        } else set.push([a, a]);
      }
      out.push({ k: 'cls', neg, set });
      i = end + 1;
    } else if (c === '{') {
      const end = braceEnd(p, i, to);
      if (end < 0) { lit('{'); i++; continue; }
      const parts: [number, number][] = [];
      let start = i + 1, depth = 0;
      for (let j = i + 1; j < end; j++) {
        if (p[j] === '\\') { j++; continue; }
        if (p[j] === '{') depth++;
        else if (p[j] === '}') depth--;
        else if (p[j] === ',' && depth === 0) { parts.push([start, j]); start = j + 1; }
      }
      parts.push([start, end]);
      const range = parts.length === 1 ? /^([+-]?\d+)\.\.([+-]?\d+)$/.exec(p.slice(i + 1, end).join('')) : null;
      if (parts.length > 1) out.push({ k: 'alt', alts: parts.map(([s, e]) => parseGlob(p, s, e)) });
      else if (range) { const a = +range[1], b = +range[2]; out.push({ k: 'num', lo: Math.min(a, b), hi: Math.max(a, b) }); }
      else { lit('{'); out.push(...parseGlob(p, i + 1, end)); lit('}'); }
      i = end + 1;
    } else { lit(c); i++; }
  }
  return out;
}

/* The pattern as a graph of nodes, each created after the nodes it continues to (so creation order is an order
   in which a node's successors at the same position come first); node 0 accepts at the path's end. */
type EcNode =
  | { t: 'end' } | { t: 'lit'; c: string; next: number } | { t: 'one'; next: number } | { t: 'star'; next: number }
  | { t: 'globstar'; next: number } | { t: 'cls'; neg: boolean; set: [string, string][]; next: number }
  | { t: 'split'; alts: number[] } | { t: 'num'; lo: number; hi: number; next: number };
function compile(items: EcItem[], nodes: EcNode[], next: number): number {
  const add = (n: EcNode) => nodes.push(n) - 1;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    switch (it.k) {
      case 'lit': next = add({ t: 'lit', c: it.c, next }); break;
      case 'one': next = add({ t: 'one', next }); break;
      case 'star': next = add({ t: 'star', next }); break;
      case 'globstar': next = add({ t: 'globstar', next }); break;
      case 'cls': next = add({ t: 'cls', neg: it.neg, set: it.set, next }); break;
      case 'num': next = add({ t: 'num', lo: it.lo, hi: it.hi, next }); break;
      /* /**\/: one /, or / and any characters and / */
      case 'dirs': { const deeper = add({ t: 'globstar', next: add({ t: 'lit', c: '/', next }) }); next = add({ t: 'lit', c: '/', next: add({ t: 'split', alts: [next, deeper] }) }); break; }
      case 'alt': { const alts = it.alts.map(a => compile(a, nodes, next)); next = add({ t: 'split', alts }); break; }
    }
  }
  return next;
}

/* Whether GLOB, a section's name, matches REL, a path from the .editorconfig's directory: ok[node][pos] for
   every node and position, from the path's end back, so no state is visited twice and nothing recurses. */
const matches = (glob: string, rel: string) => matchChars(glob, Array.from(rel));
function matchChars(glob: string, rel: string[]): boolean {
  /* As the core library does, the glob is matched against the path with the directory's own / before it: a glob
     with a / from that / (a / put first when it has none there), one with no / after /**\/ (in any directory
     below). So **\/X and /**\/X match X in the directory itself, their /**\/ being that one /. */
  const p = Array.from(glob.includes('/') ? (glob.startsWith('/') ? glob : '/' + glob) : '/**/' + glob);
  const s = ['/', ...rel];
  const nodes: EcNode[] = [{ t: 'end' }];
  const start = compile(parseGlob(p, 0, p.length), nodes, 0);
  const n = s.length, w = n + 1, N = nodes.length;
  const ok = new Uint8Array(N * w);
  const at = (node: number, pos: number) => ok[node * w + pos] === 1;
  for (let pos = n; pos >= 0; pos--) {
    const ch = pos < n ? s[pos] : null;
    for (let id = 0; id < N; id++) {
      const nd = nodes[id];
      let r = false;
      switch (nd.t) {
        case 'end': r = pos === n; break;
        case 'lit': r = ch === nd.c && at(nd.next, pos + 1); break;
        case 'one': r = ch !== null && ch !== '/' && at(nd.next, pos + 1); break;
        case 'star': r = at(nd.next, pos) || (ch !== null && ch !== '/' && at(id, pos + 1)); break;
        case 'globstar': r = at(nd.next, pos) || (ch !== null && at(id, pos + 1)); break;
        case 'cls': r = ch !== null && ch !== '/' && nd.set.some(([a, z]) => ch >= a && ch <= z) !== nd.neg && at(nd.next, pos + 1); break;
        case 'split': r = nd.alts.some(a => at(a, pos)); break;
        case 'num': {
          let j = pos;
          if (s[j] === '+' || s[j] === '-') j++;
          const d0 = j;
          /* at most 15 digits: past that a number is not exact */
          for (; j < n && j - d0 < 15 && s[j] >= '0' && s[j] <= '9'; j++) {
            if (j > d0 && s[d0] === '0') break;
            const v = +s.slice(pos, j + 1).join('');
            if (v >= nd.lo && v <= nd.hi && at(nd.next, j + 1)) { r = true; break; }
          }
          break;
        }
      }
      if (r) ok[id * w + pos] = 1;
    }
  }
  return at(start, 0);
}

/* FILE's properties, in the order each was first set: READ gives a file's text or null, NAME is the file looked
   for in each directory (.editorconfig; the core library's tests name others). FILE must be an absolute path. */
function properties(file: string, read: (path: string) => string | null, name = '.editorconfig'): Map<string, string> {
  const props = new Map<string, string>();
  if (!file.startsWith('/')) return props;
  const parts = file.split('/'), found: { dir: string; ec: EcFile }[] = [];
  let globs = 0;
  for (let k = parts.length - 1; k >= 1; k--) {
    const dir = parts.slice(0, k).join('/');
    let text: string | null = null;
    try { text = read(dir + '/' + name); } catch (e) { text = null; }
    if (typeof text !== 'string' || text.length > MAX_FILE) continue;
    const ec = parse(text);
    for (const [glob] of ec.sections) globs += glob.length + SECTION_COST;
    if (globs > MAX_GLOBS) break;
    found.unshift({ dir, ec });
    if (ec.root) break;
  }
  for (const { dir, ec } of found) {
    const rel = Array.from(file.slice(dir.length + 1));
    for (const [glob, pairs] of ec.sections) if (pairs.length && matchChars(glob, rel)) for (const [k, v] of pairs) props.set(k, v);
  }
  if (props.get('indent_style') === 'tab' && !props.has('indent_size')) props.set('indent_size', 'tab');
  if (props.has('indent_size') && !props.has('tab_width') && props.get('indent_size') !== 'tab') props.set('tab_width', props.get('indent_size')!);
  if (props.get('indent_size') === 'tab' && props.has('tab_width')) props.set('indent_size', props.get('tab_width')!);
  return props;
}

/* ---------- in the editor ---------- */
const storeRead = (path: string) => Ed.Store.get(path, MAX_FILE);
/* A width: a whole number from 1 to 9999 (TAB inserts that many spaces at most). */
const width = (v: string | undefined) => (v !== undefined && /^[1-9]\d{0,3}$/.test(v) ? +v : null);

/* Read B's properties (when it visits a file of its own with an absolute path) and set its buffer-local values
   from them; B.editorconfig keeps them for the save. */
function apply(b: EdBuffer) {
  if (!b.file || b.shared || !b.file.startsWith('/')) return;
  const p = properties(b.file, storeRead);
  b.editorconfig = p;
  const local = (name: string, v: SchemeValue) => { Ed.makeLocal(b, name); b.locals!.set(name, v); };
  const style = p.get('indent_style');
  if (style === 'tab' || style === 'space') local('indent-tabs-mode', style === 'tab');
  const size = p.get('indent_size'), w = width(size === 'tab' ? p.get('tab_width') : size);
  if (w !== null) { local('tab-width', w); local('evil-shift-width', w); }
  const fill = width(p.get('max_line_length'));
  if (fill !== null) local('fill-column', fill);
  const nl = p.get('insert_final_newline');
  if (nl === 'true' || nl === 'false') local('require-final-newline', nl === 'true');
  if (p.get('trim_trailing_whitespace') === 'false') local('ws-butler-mode', false);
}

L.D('editorconfig-properties', 'FILENAME', 'The EditorConfig properties of FILENAME, an absolute path, from the .editorconfig files of its directory and those above it up to the one with root = true: a list of (NAME . VALUE) strings in the order each was first set.', ([f]: [SchemeValue]) => {
  if (typeof f !== 'string') signal('wrong-type-argument', 'editorconfig-properties: the file name is not a string:', f);
  return listOf([...properties(f as string, storeRead)].map(([k, v]) => L.cons(k, v)));
});
L.D('editorconfig--apply', '', 'find-file-hook: set the visited file\'s indent, fill column, final newline and trimming from its .editorconfig files.', () => { apply(E.current); return false; });
/* A major mode switch drops buffer-local values and sets the mode's own indent: a buffer the hook above has
   seen gets its file's values again (read again, as write-file may have given it another name). */
L.D('editorconfig--reapply', '', 'after-change-major-mode-hook: set the .editorconfig values again in a buffer that has them.', () => { if (E.current.editorconfig) apply(E.current); return false; });
L.D('editorconfig--before-save', '', 'before-save-hook: with trim_trailing_whitespace = true, delete the trailing blanks of every line of a modified, writable buffer.', () => {
  const b = E.current;
  if (b.editorconfig && b.editorconfig.get('trim_trailing_whitespace') === 'true' && b.modified && !b.readOnly)
    L.call('delete-trailing-blanks', [listOf([L.cons(1, b.rope.length + 1)])]);
  return false;
});
L.addHook('find-file-hook', intern('editorconfig--apply'));
L.addHook('after-change-major-mode-hook', intern('editorconfig--reapply'));
L.addHook('before-save-hook', intern('editorconfig--before-save'));

globalThis.EditorConfig = { parse, matches, properties, MAX_FILE, MAX_GLOBS, SECTION_COST };
})();
