/* A syntax tree per buffer, kept in step with its text (docs/steps.md, "Incremental reparse"). The desktop
   program's tree-sitter (host.syntax, over native/src/syntax.rs) parses a buffer's text once; after that it is
   given only what changed. The buffer's edit log says what: spanOf joins every edit since the tree's version into
   one span (the text before it and after it unchanged), and that span alone crosses to the native side, which
   tells the tree of the edit and parses again from it, reusing what the edit left alone.

   A whole parse instead when the log no longer reaches back to the tree's version (trimmed or forgotten), when
   the grammar asked for changes, or when an edit fails (a reparse past its bound frees the native tree). Trees of
   killed buffers are freed before the next whole parse, which is when the native side's bound on trees counts.

   Only the desktop program has host.syntax: in a web frame and in edwind (the Node host) Ed.syntax.tree gives
   null. Nothing here is reachable from Scheme, and nothing here starts a process or reads a file: the grammar is
   named, and the native side loads it from the program's own bundle. What uses the trees: highlighting (lexSeg)
   and imenu (consult-imenu's definitions, from the grammar's tags query). */
(function () {
'use strict';
const Ed = globalThis.Ed, E = Ed.E;

type Kept = { grammar: string; tree: number; ver: number; len: number };
const kept = new Map<EdBuffer, Kept>();

function forget(syn: EdHostSyntax, b: EdBuffer, k: Kept) {
  kept.delete(b);
  syn.free(k.tree);
}

/* B's tree with GRAMMAR, brought up to B's version: its number for the host's queries, null when the host
   parses nothing. Throws what the host throws (no such grammar, a parse past its bound, too many trees). */
function tree(b: EdBuffer, grammar: string): number | null {
  const syn = Ed.host.syntax;
  if (!syn) return null;
  const k = kept.get(b);
  if (k && k.grammar === grammar) {
    if (k.ver === b.ver) return k.tree;
    const span = Ed.spanOf(b, k.ver), len = b.rope.length;
    const del = span ? k.len - span.pre - span.suf : -1;
    if (span && del >= 0 && span.pre + span.suf <= len) {
      try {
        syn.edit(k.tree, span.pre, del, b.rope.slice(span.pre, len - span.suf));
        k.ver = b.ver; k.len = len;
        return k.tree;
      } catch (e) { /* refused, or the reparse failed and freed the tree: a whole parse below */ }
    }
  }
  if (k) forget(syn, b, k);
  for (const [o, ok] of kept) if (!E.buffers.includes(o)) forget(syn, o, ok);
  const text = b.rope.toString();
  const id = syn.parse(grammar, text);
  kept.set(b, { grammar, tree: id, ver: b.ver, len: text.length });
  return id;
}

/* ---------- highlighting: the grammar's highlights query, its captures as faces ---------- */
/* The bundle's grammar of each mode scm/prog.scm declares (nix/grammars.nix; the edwin-syntax check compares the
   two), and how its highlights query was written: most of the bundle's are written for tree-sitter's own
   highlighter, where of two patterns capturing one node the later wins; Go's, Nix's, JSON's, NASM's and Typst's are
   written the other way, the earlier winning (their generic patterns come last). A mode derived from one of these is
   not highlighted unless it is named here. */
const GRAMMARS: Record<string, string> = {
  'rust-mode': 'rust', 'nix-mode': 'nix', 'go-mode': 'go', 'c-mode': 'c', 'c++-mode': 'cpp', 'java-mode': 'java',
  'csharp-mode': 'c_sharp', 'python-mode': 'python', 'js-mode': 'javascript', 'typescript-mode': 'typescript',
  'tsx-mode': 'tsx', 'json-mode': 'json', 'yaml-mode': 'yaml', 'toml-mode': 'toml', 'sh-mode': 'bash',
  'terraform-mode': 'hcl', 'gdscript-mode': 'gdscript', 'just-mode': 'just', 'meson-mode': 'meson',
  'nasm-mode': 'nasm', 'nginx-mode': 'nginx', 'typst-mode': 'typst',
};
const EARLIER_WINS = new Set(['go', 'nix', 'json', 'nasm', 'typst']);
const grammarOf = (mode: string) => Object.prototype.hasOwnProperty.call(GRAMMARS, mode) ? GRAMMARS[mode] : null;

/* The classes a capture can give (index.html's and display.ts's faces); 0 is none. */
const NAMES = ['', 'kw', 'fn', 'st', 'dc', 'cm', 'co', 'nu', 'ty', 'bi', 'pr', 'pa'];
const C = Object.fromEntries(NAMES.map((n, i) => [n || 'none', i])) as Record<string, number>;
/* A capture's class by its name, or by the longest dotted prefix of it named here (function.method.call is a
   function). A name here with C.none still takes its node (a variable is not a property in a later pattern);
   a name not here takes nothing (spell, nested helpers), nor does one beginning with _ (a predicate's).
   Punctuation and delimiters give no face either, and take a node only when no other pattern captures it: Nix's
   `"}" @punctuation.bracket` comes before its interpolation's `"}" @punctuation.special`. */
const CLASS: Record<string, number> = {
  keyword: C.kw, conditional: C.kw, repeat: C.kw, include: C.kw, exception: C.kw, 'markup.heading': C.kw,
  'markup.list': C.kw, 'punctuation.special': C.kw,
  function: C.fn, method: C.fn, 'function.builtin': C.bi, 'function.macro': C.bi, 'function.special': C.bi,
  string: C.st, character: C.st, 'constant.character': C.st, 'markup.raw': C.st, 'string.special.key': C.pr,
  'string.escape': C.co, escape: C.co, 'constant.character.escape': C.co,
  comment: C.cm, 'comment.documentation': C.dc,
  constant: C.co, boolean: C.co, number: C.nu, float: C.nu, 'constant.numeric': C.nu,
  type: C.ty, constructor: C.ty, module: C.ty, namespace: C.ty, tag: C.ty,
  'variable.builtin': C.bi, attribute: C.bi,
  property: C.pr, field: C.pr, label: C.pr, 'variable.other.member': C.pr,
  'markup.heading.marker': C.pa,
  variable: C.none, operator: C.none, punctuation: C.none, delimiter: C.none, embedded: C.none, none: C.none,
};
function classOf(name: string) {
  if (name[0] === '_') return -1;
  for (let n = name; ; n = n.slice(0, n.lastIndexOf('.'))) {
    if (Object.prototype.hasOwnProperty.call(CLASS, n)) return CLASS[n];
    if (n.indexOf('.') < 0) return -1;
  }
}
/* Punctuation with no face of its own (punctuation.special has one). */
const weakOf = (name: string) => classOf(name) === C.none && /^(punctuation|delimiter)(\.|$)/.test(name) ? 1 : 0;
/* Each grammar's capture names as classes, and which are punctuation, made again only when the names differ. */
type Classes = { names: string[]; cc: Int8Array; weak: Uint8Array };
const classesOf = new Map<string, Classes>();
function classes(grammar: string, names: string[]) {
  const k = classesOf.get(grammar);
  if (k && k.names.length === names.length && k.names.every((n, i) => n === names[i])) return k;
  const c = { names, cc: Int8Array.from(names, classOf), weak: Uint8Array.from(names, weakOf) };
  classesOf.set(grammar, c);
  return c;
}

/* Buffers past this many characters are not highlighted (tree-sitter's whole parse of one is bounded at 1 s, and
   a redraw must not wait for it); nor are shown lines past MAX_SHOWN characters (a minified file's one line: its
   query, sort and fill would cost each keystroke time in proportion to the line); nor is a buffer whose tree or
   query failed, for that grammar. */
const MAX_CHARS = 4 * 1024 * 1024, MAX_SHOWN = 64 * 1024;
const failed = new WeakMap<EdBuffer, string>();

type Lex = { ver: number; from: number; to: number; grammar: string; cls: Uint8Array; names: string[] };
/* The classes of B's shown segment FROM..TO from its grammar's highlights query: the captures overlapping it
   (so a comment begun above the window is still a comment), each node given one capture, the earlier or the
   later pattern's as the grammar's queries are written, and a node inside another painted over it. */
function highlight(b: EdBuffer, grammar: string, from: number, to: number): Lex | null {
  const syn = Ed.host.syntax!;
  let r: { names: string[]; captures: number[] };
  try {
    const id = tree(b, grammar);
    if (id === null) return null;
    r = syn.query(id, 'highlights', from, to);
  } catch (e) {
    failed.set(b, grammar);
    return null;
  }
  const { cc, weak } = classes(grammar, r.names);
  const caps = r.captures, later = !EARLIER_WINS.has(grammar);
  const at: number[] = [];
  for (let i = 0; i < caps.length; i += 4) if (cc[caps[i]] >= 0 && caps[i + 2] > caps[i + 1]) at.push(i);
  /* Outer nodes first, so the nodes inside them paint over them; one node's captures punctuation last, then by
     their patterns, the winning one first. */
  at.sort((x, y) => caps[x + 1] - caps[y + 1] || caps[y + 2] - caps[x + 2] || weak[caps[x]] - weak[caps[y]]
    || (later ? caps[y + 3] - caps[x + 3] : caps[x + 3] - caps[y + 3]) || x - y);
  const cls = new Uint8Array(to - from);
  let ps = -1, pe = -1;
  for (const i of at) {
    const s = caps[i + 1], e = caps[i + 2];
    if (s === ps && e === pe) continue;
    ps = s; pe = e;
    cls.fill(cc[caps[i]], Math.max(s, from) - from, Math.min(e, to) - from);
  }
  return { ver: b.ver, from, to, grammar, cls, names: NAMES };
}

/* ---------- imenu: the definitions the grammar's tags query names ---------- */
/* B's definitions from its grammar's tags query (tree-sitter's code-navigation captures): each match's
   @definition.KIND with its @name, as the name's text, KIND and the earlier start of the two (Nix captures the
   binding's attrpath as the name, beside the function it binds), in the order of the text. A name two patterns
   capture is listed once, as the earlier pattern's (Rust's method is a function too; TypeScript's tags are its
   own, then JavaScript's). References and @doc are not definitions. null when the host parses nothing, the mode
   has no grammar, the buffer is past the bound highlighting keeps to, or the grammar has no tags query or it
   fails: the caller lists its own then. A failure here leaves the buffer's highlighting alone. */
type ImenuItem = { name: string; kind: string; pos: number };
function imenu(b: EdBuffer): ImenuItem[] | null {
  const syn = Ed.host.syntax, grammar = syn && !b.minibuf ? grammarOf(b.mode) : null;
  if (!syn || !grammar || b.rope.length > MAX_CHARS) return null;
  let r: { names: string[]; captures: number[]; matches?: number[] };
  try {
    const id = tree(b, grammar);
    if (id === null) return null;
    r = syn.query(id, 'tags', 0, b.rope.length, true);
  } catch (e) {
    return null;
  }
  const { names, captures: caps, matches } = r;
  if (!matches) return null;
  type Match = { pattern: number; kind?: string; def?: number; ns?: number; ne?: number };
  const byMatch = new Map<number, Match>();
  for (let i = 0, j = 0; i < caps.length; i += 4, j++) {
    let m = byMatch.get(matches[j]);
    if (!m) byMatch.set(matches[j], m = { pattern: caps[i + 3] });
    const n = names[caps[i]];
    if (n === 'name') { m.ns = caps[i + 1]; m.ne = caps[i + 2]; }
    else if (n.startsWith('definition.')) { m.kind = n.slice(11); m.def = caps[i + 1]; }
  }
  const byName = new Map<number, Match>();
  for (const m of byMatch.values()) {
    if (m.kind === undefined || m.ns === undefined || m.ne! <= m.ns) continue;
    const o = byName.get(m.ns);
    if (!o || m.pattern < o.pattern) byName.set(m.ns, m);
  }
  return [...byName.values()]
    .map(m => ({ name: b.rope.slice(m.ns!, m.ne!).replace(/\s+/g, ' '), kind: m.kind!, pos: Math.min(m.def!, m.ns!) }))
    .sort((x, y) => x.pos - y.pos);
}

const H = Ed.hooks, prevLexSeg = H.lexSeg;
H.lexSeg = (b, from, to, seg) => {
  const grammar = Ed.host.syntax && !b.minibuf ? grammarOf(b.mode) : null;
  if (grammar && failed.get(b) !== grammar && b.rope.length <= MAX_CHARS && to - from <= MAX_SHOWN) {
    const c = b._sxl as Lex | undefined;
    if (c && c.ver === b.ver && c.from === from && c.to === to && c.grammar === grammar) return c;
    const lx = highlight(b, grammar, from, to);
    if (lx) return b._sxl = lx;
  }
  return prevLexSeg ? prevLexSeg(b, from, to, seg) : null;
};

Ed.syntax = { tree, grammarOf, imenu };
})();
