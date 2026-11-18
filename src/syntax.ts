/* A syntax tree per buffer, kept in step with its text (docs/steps.md, "Incremental reparse"). The desktop
   program's tree-sitter (host.syntax, over native/src/syntax.rs) parses a buffer's text once; after that it is
   given only what changed. The buffer's edit log says what: spanOf joins every edit since the tree's version into
   one span (the text before it and after it unchanged), and that span alone crosses to the native side, which
   tells the tree of the edit and parses again from it, reusing what the edit left alone.

   A whole parse instead when the log no longer reaches back to the tree's version (trimmed or forgotten), when
   the grammar asked for changes, or when an edit fails (a reparse past its bound frees the native tree). Trees of
   killed buffers are freed before the next whole parse, which is when the native side's bound on trees counts.

   Only the desktop program has host.syntax: in a web frame and in edwind (the Node host) Ed.syntax.tree gives
   null. Scheme reaches two things here: the extents of the nodes around a range (syntax-node-bounds, for expreg),
   which only reads the tree, and the indentation of lines (syntax-indent-line, syntax-indent-region), which
   changes only their leading blanks; nothing here starts a process or reads a file: the grammar is named, and the
   native side loads it from the program's own bundle. What uses the trees: highlighting (lexSeg), imenu
   (consult-imenu's definitions, from the grammar's tags query), expreg (the nodes a selection grows by) and
   indentation (TAB, =, RET, o and O, from the grammar's indents query). */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E;

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

/* ---------- expreg: the nodes a selection grows by ---------- */
/* The extents of the named nodes of B's tree that hold FROM..TO, innermost first, out to the root, each extent
   once: the steps expreg-expand grows a selection by. null where imenu gives null for want of a tree (no
   host.syntax, no grammar for the mode, a minibuffer, a buffer past MAX_CHARS) and when the parse fails: the
   caller's own steps then. A failure here leaves the buffer's highlighting alone. */
function nodes(b: EdBuffer, from: number, to: number): [number, number][] | null {
  const syn = Ed.host.syntax, grammar = syn && !b.minibuf ? grammarOf(b.mode) : null;
  if (!syn || !grammar || b.rope.length > MAX_CHARS) return null;
  const len = b.rope.length, s = Math.max(0, Math.min(from, len)), e = Math.max(s, Math.min(to, len));
  let flat: number[];
  try {
    const id = tree(b, grammar);
    if (id === null) return null;
    flat = syn.nodes(id, s, e);
  } catch (err) {
    return null;
  }
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/* ---------- indentation: the grammar's indents query ---------- */
/* The leading blanks of a line, from the captures of the grammar's `indents` query (nix/indents/, in the bundle)
   over B's tree. A node holds a line when it starts before the line's first non-blank character and ends after it
   (on a blank line: at it or after it); the innermost holder, the one starting last, decides the line:
     @indent  the line is one level deeper than the base of the node;
     @indent.inner  so is it, but at the margin it is at the base: a node whose own base is no blanks, with no
              line above in the re-indent's chain of bases indented either, gives no level (alejandra's body of a
              lambda: a file's `{ pkgs, ... }:` is followed by its body at the margin, a binding's `f = x:` by its
              body a level in);
     @align   the line goes under the first character after the node's opening bracket, when that is on the
              bracket's line (C's argument lists); for a node not begun by a bracket (C's for), after its first
              `(` while the line begins before the `)` closing it; else the node is an @indent;
     @align.start  the line goes under the node's first character (clang-format's operands);
     @keep    the line keeps its blanks (a string or comment begun on a line above); @keep.all whatever node
              inside it holds the line (a Nix string's interpolations);
     @flat    the line is at the node's base (prettier's operands where it does not indent them), unless the node
              is also @unflat;
     @chain   (with @indent) a line of a method chain is at the chain's base while the chain's root, the smallest
              @chain.root beginning where the chain does, spans lines; a root beginning its line is joined with the
              next while it is one line no wider than a level (rustfmt's chains);
     @none    the node is no holder, whatever else captures it (C's switch body: its case labels are at the
              switch's level);
   and by the token or node the line begins with:
     @outdent a token that ends where its holder ends (the holder's closing bracket, or the bracket and a comment
              after it on its line) leaves the line at the holder's base;
     @dedent  so does any token or node captured so (an `else`, a Go label);
     @flush   the line has no blanks (C's preprocessor directives);
     @brace   a block's `{` beginning the line is at the base of the node captured so (rustfmt's `{` under a
              multi-line header);
     @either  the line keeps its blanks when they are a level more than the rules give (gofmt's comments after a
              case's statements, at their level or the next case's);
     @continue a line beginning with the same token as the lines above it continues the first of them, a level in;
   a line no node holds has no blanks. A node's base is the blanks of the line it starts on, unless that line itself
   begins inside a node that closed before this one began (the line is the tail of a longer one, as C's `    b) {`
   after `if (a &&`), or inside a @stem node begun on a line above (C's `     i++) {` after `for (i = 0;`): then that
   node's base, and so on up. A @hang node begun after the first character of its line (prettier's ternary branch
   after `? `) gives what it holds that begins on that line a level more for their base, @hang.self only itself;
   @unhang takes that away from a node. A level is a tab under indent-tabs-mode, else evil-shift-width spaces (the
   language's width, or the .editorconfig's), and a line's base is what that line has (or is given in the same
   re-indent): indentation is relative, as in Emacs's tree-sitter modes.

   A @shift node (Nix's parenthesized application, operation, selection, with or assert) gives a level more to the
   lines it holds whose holder begins on the node's own line, when its content begins on that line and the node
   spans more than one line, and either the content is two lines or, laid out without the shift, one of its later
   lines would be at the node's line's level (a line beginning `}:` or `in` not counted): alejandra indents such a
   parenthesis's content when its lines from the second to the one before the last are not all indented already.
   That is decided by re-indenting the node's lines once (shifted in indents), each node once a re-indent.

   A node captured @open holds on to the next non-blank character after it: a case label's (`case 1:` and the
   blank line after it, typed before its statements), and while typing, when the tree is often wrong, a node
   whose closing bracket tree-sitter made up (MISSING), so the line typed after `fn f() {` is inside its block.
   Inside an ERROR (@error) the brackets the query names (@error.open, @error.close) are paired in order: a pair
   holds as an @indent from its opener to its closer, which is an @outdent, and each one left open from itself to
   the next non-blank character after the ERROR. A closing bracket pairs with the nearest opening bracket, closing
   any `=` or `let` left open after it; Nix's `;` pairs only with an `=` just before it, and `in` with the nearest
   `let` that no bracket after it is still open in. An ERROR's brackets are paired once a re-indent.

   A grammar whose query captures @offside (Python's, on its module) is indented by the offside rule: a line no node
   holds is a statement's, and since its blanks are what the tree is parsed from, it is placed by the statement
   before it, read from the text, not the tree (often wrong while typing): see offside in indents. */
type INode = { s: number; e: number; indent: boolean; keep: boolean; align: boolean; none: boolean; chain: boolean; brace: boolean; flat: boolean; unflat: boolean; start: boolean; stem: boolean; inner: boolean; shift: boolean; keepAll: boolean };
type INodes = { nodes: INode[]; outdent: Map<number, number>; dedent: Set<number>; flush: Set<number>; either: Set<number>; cont: Set<number>; roots: Map<number, number[]>; hangs: Map<string, Hang>; offside: boolean };
/* A @hang node's level: for what it holds and itself, for itself alone (@hang.self), or none (@unhang). */
type Hang = 'held' | 'self' | 'off';
const blank = (c: string) => c === ' ' || c === '\t';
function nonBlank(t: EdText, ls: number) { let i = ls; while (i < t.length && blank(t.charAt(i))) i++; return i; }
/* The first character at or after E that is no blank or line end; the text's end when there is none. */
function onward(t: EdText, e: number) { let i = e; while (i < t.length && /[ \t\r\n]/.test(t.charAt(i))) i++; return i; }

/* The brackets of each ERROR of tree ID, by the ERROR's extent (S,E): those left open (LEFT) and the pairs (an open
   bracket's start, its closer's start and end), from one query over the whole ERROR (one over the lines asked for
   has only the captures inside them), which also gives the ERRORs nested in it; each bracket is paired within the
   innermost ERROR holding it. ERRORS keeps the answers for one re-indent, so that an ERROR is queried once however
   many lines inside it are asked about: a query over each line's ERROR again made re-indenting a file with one
   unclosed bracket cost the square of its length. */
type ErrorBrackets = { left: number[]; pairs: [number, number, number][] };
type Errors = Map<string, ErrorBrackets>;
/* The tokens that open as Nix's `=` and `let` do, closed by `;` and `in` (Nix's query alone captures them). */
const KEYWORD_OPENS = new Set(['=', 'let']);
function errorOpens(syn: EdHostSyntax, id: number, t: EdText, s: number, e: number, errors: Errors): ErrorBrackets {
  const key = s + ',' + e, known = errors.get(key);
  if (known) return known;
  const r = syn.query(id, 'indents', s, e);
  const extents = new Map<string, [number, number]>([[key, [s, e]]]), brackets: [number, number, boolean][] = [];
  for (let i = 0; i < r.captures.length; i += 4) {
    const name = r.names[r.captures[i]], at = r.captures[i + 1], end = r.captures[i + 2];
    if (name === 'error') { if (at >= s && end <= e) extents.set(at + ',' + end, [at, end]); }
    else if ((name === 'error.open' || name === 'error.close') && at >= s && at < e) brackets.push([at, end, name === 'error.open']);
  }
  const errs = [...extents.values()].sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]));
  const owned = errs.map(() => [] as [number, number, boolean][]);
  for (const b of brackets) {
    const j = errs.findIndex(([es, ee]) => b[0] >= es && b[0] < ee);
    if (j >= 0) owned[j].push(b);
  }
  owned.forEach((list, j) => {
    const left: [number, string][] = [], pairs: [number, number, number][] = [];
    for (const [at, end, opens] of list.sort((x, y) => x[0] - y[0])) {
      const text = t.slice(at, end);
      if (opens) { left.push([at, text]); continue; }
      /* Nix's `=` and `let` are closed by `;` and `in` and left open by a bracket closing around them. */
      const k = text === ';' ? (left.length && left[left.length - 1][1] === '=' ? left.length - 1 : -1)
        : text === 'in' ? left.findLastIndex(([, o], i) => o === 'let' && left.slice(i + 1).every(([, u]) => KEYWORD_OPENS.has(u)))
        : left.findLastIndex(([, o]) => !KEYWORD_OPENS.has(o));
      if (k >= 0) { pairs.push([left[k][0], at, end]); left.length = k; }
    }
    errors.set(errs[j][0] + ',' + errs[j][1], { left: left.map(([at]) => at), pairs });
  });
  return errors.get(key)!;
}

/* The nodes the indents query captures in tree ID between FROM and TO (each with what captures it), by start,
   the outer of two with one start first; the end of each token captured @outdent by its start; the starts of those
   captured @dedent, @flush, @either and @continue; the ends of the @chain.root nodes at each start; and the @hang
   nodes, by extent. ERRORS: the ERRORs' open brackets found so far in this re-indent (errorOpens). */
function indentNodes(syn: EdHostSyntax, id: number, t: EdText, from: number, to: number, errors: Errors): INodes {
  const { names, captures: caps } = syn.query(id, 'indents', from, to);
  const byExtent = new Map<string, INode>(), outdent = new Map<number, number>();
  const dedent = new Set<number>(), flush = new Set<number>(), either = new Set<number>(), cont = new Set<number>(), roots = new Map<number, number[]>();
  const hangs = new Map<string, Hang>();
  const open: string[] = [], errs: [number, number][] = [];
  let offside = false;
  const node = (s: number, e: number) => {
    const k = s + ',' + e;
    let n = byExtent.get(k);
    if (!n) byExtent.set(k, n = { s, e, indent: false, keep: false, align: false, none: false, chain: false, brace: false, flat: false, unflat: false, start: false, stem: false, inner: false, shift: false, keepAll: false });
    return n;
  };
  for (let i = 0; i < caps.length; i += 4) {
    const s = caps[i + 1], e = caps[i + 2];
    switch (names[caps[i]]) {
      case 'indent': node(s, e).indent = true; break;
      case 'indent.inner': { const n = node(s, e); n.indent = n.inner = true; break; }
      case 'shift': node(s, e).shift = true; break;
      case 'keep': node(s, e).keep = true; break;
      case 'keep.all': { const n = node(s, e); n.keep = n.keepAll = true; break; }
      case 'align': node(s, e).align = true; break;
      case 'align.start': { const n = node(s, e); n.align = n.start = true; break; }
      case 'stem': node(s, e).stem = true; break;
      case 'flush': if (e > s) flush.add(s); break;
      case 'none': node(s, e).none = true; break;
      case 'chain': node(s, e).chain = true; break;
      case 'brace': node(s, e).brace = true; break;
      case 'flat': node(s, e).flat = true; break;
      case 'unflat': node(s, e).unflat = true; break;
      case 'hang': if (!hangs.has(s + ',' + e)) hangs.set(s + ',' + e, 'held'); break;
      case 'hang.self': if (hangs.get(s + ',' + e) !== 'off') hangs.set(s + ',' + e, 'self'); break;
      case 'unhang': hangs.set(s + ',' + e, 'off'); break;
      case 'chain.root': roots.set(s, [...(roots.get(s) ?? []), e]); break;
      case 'dedent': if (e > s) dedent.add(s); break;
      case 'either': either.add(s); break;
      case 'continue': cont.add(s); break;
      /* A MISSING bracket has no width: it begins no line. */
      case 'outdent': if (e > s) outdent.set(s, e); break;
      case 'open': open.push(s + ',' + e); break;
      case 'error': errs.push([s, e]); break;
      case 'offside': offside = true; break;
    }
  }
  for (const k of open) { const n = byExtent.get(k); if (n) n.e = onward(t, n.e); }
  /* An ERROR's brackets: one left open holds on to the next non-blank character after the ERROR, a pair from its
     opener to its closer, which is an @outdent. */
  for (const [s, e] of errs) {
    const { left, pairs } = errorOpens(syn, id, t, s, e, errors);
    for (const at of left) node(at, onward(t, e)).indent = true;
    for (const [at, cs, ce] of pairs) { node(at, ce).indent = true; if (ce > cs) outdent.set(cs, ce); }
  }
  const nodes = [...byExtent.values()].filter(n => !n.none && (holder(n) || n.brace || n.shift))
    .sort((x, y) => x.s - y.s || y.e - x.e);
  return { nodes, outdent, dedent, flush, either, cont, roots, hangs, offside };
}
/* Whether a token ending at E is node N's closing bracket: N ends with it, or with a comment after it on its line
   (JavaScript's block holds the `// c` of `} // c`). */
const closes = (t: EdText, n: INode, e: number | undefined) =>
  e !== undefined && (e === n.e || (n.e > e && /^[ \t]*(\/\/|\/\*)[^\n]*$/.test(t.slice(e, n.e))));
/* Whether node N decides the lines it holds (a @brace alone does not). */
const holder = (n: INode) => n.indent || n.keep || n.align || n.flat;
/* Whether node N holds the line whose first non-blank character is at P (BLANK: the line has none). */
const holds = (n: INode, p: number, isBlank: boolean) => n.s < p && (p < n.e || (isBlank && p <= n.e));
/* Where an @align node's lines go: the first non-blank character after its opening bracket, on its line, when that
   is no `#` comment (Python's `f(  # c`, which black follows with a level in). */
function alignAt(t: EdText, s: number) {
  const i = nonBlank(t, s + 1);
  return i < t.length && !'\n\r#'.includes(t.charAt(i)) ? i : null;
}

type Indents = { starts: number[]; want: (string | null)[] };
/* What a re-indent knows of its @shift nodes (shifted in indents): whether each gives a level, by extent; and whether a
   lambda's body at the margin stays there (@indent.inner), false while deciding for a node not at the margin; and
   the ERRORs' brackets (errorOpens), which the re-indents deciding share, so that an ERROR is queried once. */
type Shifts = { known: Map<string, boolean>; margin: boolean; errors: Errors };
/* Python's (offside): the statements an else, elif, except, finally or case can go with, by their first word, and
   the statements after which the next line is likeliest a level out. */
const PY_PAIRS = new Map([
  ['else', ['if', 'elif', 'for', 'while', 'try', 'except']], ['elif', ['if', 'elif']], ['except', ['try', 'except']],
  ['finally', ['try', 'except', 'else']], ['case', ['case']],
]);
const PY_ENDERS = new Set(['return', 'pass', 'raise', 'break', 'continue']);
/* The leading blanks each line from the one holding FROM to the one holding TO should have by B's grammar's
   indents query: STARTS the lines' starts, WANT a string each, null for a line the rules leave alone (@keep). null
   for all when B has no rules: no host.syntax (a web frame, edwind), a mode with no grammar, a minibuffer, a
   buffer past MAX_CHARS, a grammar with no indents query, a failed parse or query. One query over the lines and
   the one before the first that is not blank (where an ERROR's last tokens are while typing); one more a line
   above them that a base is looked up on, and one each ERROR, once a re-indent (errorOpens). A failure here leaves
   the highlighting alone. HOW is for Python's statement lines (offside): 'new' for a line just opened (the
   likeliest level, not its own), 'cycle' for a TAB after a TAB (the next level down). */
function indents(b: EdBuffer, from: number, to: number, how?: IndentHow, shifts: Shifts = { known: new Map(), margin: true, errors: new Map() }): Indents | null {
  const syn = Ed.host.syntax, grammar = syn && !b.minibuf ? grammarOf(b.mode) : null;
  if (!syn || !grammar || b.rope.length > MAX_CHARS) return null;
  const t = b.rope, len = t.length, clamp = (p: number) => Math.max(0, Math.min(len, p));
  const first = Ed.bol(t, clamp(from)), last = Ed.bol(t, clamp(Math.max(from, to)));
  let lo = first;
  for (let k = first; k > 0;) {
    const ls = Ed.bol(t, k - 1);
    if (nonBlank(t, ls) < Ed.eol(t, ls)) { lo = ls; break; }
    k = ls;
  }
  const width = Math.max(1, Math.floor(Number(Ed.localValue(b, 'evil-shift-width'))) || 1);
  const unit = L.truthy(Ed.localValue(b, 'indent-tabs-mode')) ? '\t' : ' '.repeat(width);
  const errors = shifts.errors;
  try {
    const id = tree(b, grammar);
    if (id === null) return null;
    const hi = Math.min(len, Ed.eol(t, last) + 1), all = indentNodes(syn, id, t, lo, hi, errors);
    const { nodes, outdent, dedent, flush, either, cont } = all;
    /* What each line asked for is given, or keeps, and the innermost holder of each one's first character. */
    const made = new Map<number, string>(), inner = new Map<number, INode | null>(), onLine = new Map<number, INodes>();
    /* The captures over the line beginning at LS, queried once: those of the one query over the lines asked for
       when LS is one of them (a query over one line inside an ERROR walks the whole ERROR, so one a line made
       `gg=G` in a file with an unclosed bracket cost many times what it costs in a closed one), else a query over
       the line. */
    const inRange = (p: number) => p >= lo && p < hi;
    const lineNodes = (ls: number) => {
      let r = onLine.get(ls);
      if (!r) onLine.set(ls, r = inRange(ls) ? all : indentNodes(syn, id, t, ls, Math.min(len, Ed.eol(t, ls) + 1), errors));
      return r;
    };
    /* The @hang nodes beginning on the line at LS, from the query covering it: indexed once for the lines asked
       for. */
    const hangsOn = new Map<number, [number, number, Hang][]>();
    const hangsOf = (r: INodes, on: (s: number) => boolean) => {
      for (const [k, level] of r.hangs) {
        const [s, e] = k.split(',').map(Number), at = Ed.bol(t, s);
        if (on(at)) hangsOn.set(at, [...(hangsOn.get(at) ?? []), [s, e, level]]);
      }
    };
    hangsOf(all, inRange);
    const hangsOnLine = (ls: number) => {
      if (!inRange(ls) && !hangsOn.has(ls)) { hangsOn.set(ls, []); hangsOf(lineNodes(ls), at => at === ls); }
      return hangsOn.get(ls) ?? [];
    };
    const lead = (ls: number) => made.has(ls) ? made.get(ls)! : t.slice(ls, nonBlank(t, ls));
    const holderOf = (ls: number) => {
      if (inner.has(ls)) return inner.get(ls)!;
      const q = nonBlank(t, ls);
      let h: INode | null = null;
      for (const n of lineNodes(ls).nodes) {
        if (n.s >= q) break;
        if (holder(n) && holds(n, q, false)) h = n;
      }
      inner.set(ls, h);
      return h;
    };
    /* The line the base of a node beginning at S is that of: up through the lines whose holder closed before S. */
    const baseLine = (s: number, at: number): number => {
      const ls = Ed.bol(t, s), h = holderOf(ls);
      return h && (h.e <= at || (h.stem && h.s < ls)) ? baseLine(h.s, at) : ls;
    };
    const baseAt = (s: number, at: number) => lead(baseLine(s, at));
    /* A level more when a @hang node (not also @unhang) begun after the first character of N's line holds N or is
       N (is N, for @hang.self): one level for the line however many begin on it, as prettier's indents begun on one
       line close together. */
    const base = (n: INode) => {
      const ls = Ed.bol(t, n.s), q = nonBlank(t, ls);
      for (const [s, e, on] of hangsOnLine(ls))
        if (on !== 'off' && s > q && (on === 'self' ? s === n.s && e === n.e : s <= n.s && e >= n.e))
          return baseAt(n.s, n.s) + unit;
      return baseAt(n.s, n.s);
    };
    /* Whether the root of the @chain node N, for its line beginning at P, spans lines: the smallest @chain.root
       beginning where N does; when that begins its line, joined with the next while it is one line no wider than a
       level (rustfmt's `x.f(|| {` at a line's start is one root). */
    const rootSpans = (n: INode, p: number) => {
      const ends = (lineNodes(Ed.bol(t, n.s)).roots.get(n.s) ?? []).filter(e => e <= p).sort((x, y) => x - y);
      let i = 0;
      const joins = nonBlank(t, Ed.bol(t, n.s)) === n.s;
      while (joins && i + 1 < ends.length && ends[i] - n.s <= width && !t.slice(n.s, ends[i]).includes('\n')) i++;
      return i < ends.length && t.slice(n.s, ends[i]).includes('\n');
    };
    /* Where the line beginning at P goes under the @align node N: after N's opening bracket; N's first character
       (@align.start); for a statement (C's for), after its `(` while P is before the `)` closing it. */
    const alignOf = (n: INode, p: number) => {
      if (n.start) return n.s;
      if ('([{'.includes(t.charAt(n.s))) return alignAt(t, n.s);
      const o = t.indexOf('(', n.s);
      if (o < 0 || o > Ed.eol(t, n.s)) return null;
      for (let i = o, d = 0; i < p; i++) {
        const c = t.charAt(i);
        if (c === '(') d++;
        else if (c === ')' && --d === 0) return null;
      }
      return alignAt(t, o);
    };
    /* Python's line rules (@offside), for a line no bracket or string holds: a statement's line, whose blanks are
       what the tree is parsed from, so they come from the statement before it, as in Emacs's python-mode. The last
       character of the line at LS outside strings and comments ('' for none; a string begun above is skipped). */
    const lastOf = (ls: number) => {
      const le = Ed.eol(t, ls), h = holderOf(ls);
      let i = nonBlank(t, ls), last = '';
      if (h && h.keep) { if (h.e >= le) return ''; i = h.e; }
      while (i < le) {
        const c = t.charAt(i);
        if (c === '#') break;
        if (c === '"' || c === "'") {
          const q = t.slice(i, i + 3) === c.repeat(3) ? c.repeat(3) : c;
          let j = i + q.length;
          while (j < le && t.slice(j, j + q.length) !== q) j += t.charAt(j) === '\\' ? 2 : 1;
          if (j >= le) return '';
          i = j + q.length; last = c;
          continue;
        }
        if (!/[ \t\r]/.test(c)) last = c;
        i++;
      }
      return last;
    };
    /* Whether the line at LS continues the one above it by a backslash. */
    const continued = (ls: number) => ls > 0 && lastOf(Ed.bol(t, ls - 1)) === '\\';
    /* The first line of the statement the line at LS is in: up from a line a holder holds to the line the holder
       begins on, and from a line after a backslash to the one with it. */
    const stmtOf = (ls: number) => {
      for (;;) {
        const h = holderOf(ls), up = h ? Ed.bol(t, h.s) : continued(ls) ? Ed.bol(t, ls - 1) : ls;
        if (up === ls) return ls;
        ls = up;
      }
    };
    /* The first word of the line at LS (after `async`). */
    const wordOf = (ls: number) => {
      const q = nonBlank(t, ls), m = /^(?:async[ \t]+)?([A-Za-z_]\w*)/.exec(t.slice(q, Math.min(Ed.eol(t, ls), q + 40)));
      return m ? m[1] : '';
    };
    /* The blanks of the statement line at S and of the blocks it is in, nearest first: up through the statement
       lines less deep than every one after them, to the margin, or to one no deeper than STOP blanks. They are
       the text's own blanks, whatever their width and whether spaces or tabs, as in Emacs's python-mode. */
    const around = (s: number, stop = 0) => {
      const out = [lead(s)];
      let k = s, limit = out[0].length;
      while (limit > stop && k > 0) {
        k = Ed.bol(t, k - 1);
        const q = nonBlank(t, k), w = lead(k);
        if (q >= Ed.eol(t, k) || w.length >= limit || t.charAt(q) === '#' || holderOf(k) || continued(k)) continue;
        out.push(w); limit = w.length;
      }
      if (limit > stop) out.push('');
      return out;
    };
    /* The blanks of the statement line at LS: the line's own (CUR) when they are a level Python takes there and
       HOW is not 'new' (so a re-indent never moves a statement into or out of a block), else the likeliest level;
       with HOW 'cycle', the next level down from CUR, after the lowest the highest. The levels: under a line ending
       with `:`, any deeper than its statement's while that statement keeps its own blanks, the likeliest a level
       in (evil-shift-width); after an else, elif, except, finally or case, the levels of the statements above it
       that it can go with, the nearest the likeliest; else the statement before's or that of a block it is in
       (around), the likeliest its own, or one block out after return, pass, raise, break and continue. A line
       after a backslash goes a level in from its statement's line, or with the line above when that one continues
       too, and keeps its blanks when they are deeper than its statement's. */
    const offside = (ls: number, p: number, isBlank: boolean) => {
      const cur = t.slice(ls, p), keeps = !isBlank && how !== 'new';
      if (continued(ls)) {
        const up = Ed.bol(t, ls - 1), s = stmtOf(up);
        return keeps && cur.length > lead(s).length ? cur : s === up ? lead(s) + unit : lead(up);
      }
      let prev = -1;
      for (let k = ls; k > 0 && prev < 0;) {
        k = Ed.bol(t, k - 1);
        const q = nonBlank(t, k);
        if (q < Ed.eol(t, k) && (t.charAt(q) !== '#' || holderOf(k))) prev = k;
      }
      let most = '', valid = [''], levels = [''];
      if (prev >= 0) {
        const s = stmtOf(prev), base = lead(s), kw = wordOf(ls);
        const pairs = kw !== 'case' || lastOf(ls) === ':' ? PY_PAIRS.get(kw) : undefined;
        const mates: string[] = [];
        /* Up through the statements less deep than every one after them, to one at the margin. */
        for (let k = ls, limit = Infinity; pairs && limit > 0 && k > 0;) {
          k = Ed.bol(t, k - 1);
          const q = nonBlank(t, k), w = lead(k);
          if (q >= Ed.eol(t, k) || w.length >= limit || t.charAt(q) === '#' || holderOf(k) || continued(k)) continue;
          if (pairs.includes(wordOf(k))) mates.push(w);
          limit = w.length;
        }
        if (mates.length) { most = mates[0]; valid = levels = mates; }
        else if (lastOf(prev) === ':') {
          most = base + unit;
          valid = [cur.length > base.length && base === t.slice(s, nonBlank(t, s)) ? cur : most];
          levels = how === 'cycle' ? [most, ...around(s)] : valid;
        } else {
          valid = levels = around(s, how === 'cycle' ? 0 : cur.length);
          most = PY_ENDERS.has(wordOf(s)) ? around(s, Math.max(0, base.length - 1))[1] ?? base : base;
        }
      }
      if (how === 'cycle') {
        const down = levels.filter(w => w.length < cur.length);
        return (down.length ? down : levels).reduce((a, w) => w.length > a.length ? w : a);
      }
      return keeps && valid.includes(cur) ? cur : most;
    };
    /* Whether the @shift node P (alejandra's parenthesis around an application, an operator, a with or an
       assert) gives the lines after its first a level: when its expression begins on its line (else the
       parenthesis holds it a level in itself) and has two lines, or more with one between the first and the last
       at the level of P's line without that level (one beginning with `}:` or `in` aside), as alejandra indents a
       parenthesis whose expression's second through penultimate lines are not all indented. Those lines are
       indented by these rules once a re-indent, P's level left out (held false meanwhile), against the blanks P's
       line has in the text; a lambda there is at the margin only when P's line is (alejandra decides at the
       parenthesis's own depth, whatever blanks the text has). */
    const shifted = (P: INode) => {
      const key = P.s + ',' + P.e, known = shifts.known.get(key);
      if (known !== undefined) return known;
      const ls = Ed.bol(t, P.s), c = nonBlank(t, P.s + 1), z = Ed.bol(t, Math.max(c, P.e - 1));
      let r = false;
      shifts.known.set(key, false);
      if (c >= Ed.eol(t, ls) || t.charAt(c) === '#' || t.slice(c, c + 2) === '/*' || z === ls) r = false;
      else if (z === Ed.eol(t, ls) + 1) r = true;
      else {
        const top = t.slice(ls, nonBlank(t, ls));
        const sub = indents(b, Ed.eol(t, ls) + 1, z - 1, undefined, { ...shifts, margin: shifts.margin && lead(ls) === '' });
        r = !!sub && sub.starts.some((s, i) => {
          const q = nonBlank(t, s);
          return q < Ed.eol(t, s) && sub.want[i] === top && !/^(\}:|in(?![\w'-]))/.test(t.slice(q, q + 3));
        });
      }
      shifts.known.set(key, r);
      return r;
    };
    const starts: number[] = [], want: (string | null)[] = [], stack: INode[] = [];
    let k = 0;
    for (let ls = first; ;) {
      const le = Ed.eol(t, ls), p = nonBlank(t, ls), isBlank = p >= le;
      while (k < nodes.length && nodes[k].s < p) stack.push(nodes[k++]);
      while (stack.length && !holds(stack[stack.length - 1], p, isBlank)) stack.pop();
      let n: INode | null = null, br: INode | null = null;
      for (let j = stack.length - 1; j >= 0 && !n; j--) {
        if (!br && stack[j].brace) br = stack[j];
        if (holder(stack[j])) n = stack[j];
      }
      if (!isBlank) inner.set(ls, n);
      let w: string | null, a: number | null;
      if (!n) w = all.offside ? offside(ls, p, isBlank) : '';
      else if (n.keep || stack.some(s => s.keepAll && holds(s, p, isBlank))) w = null;
      else if (flush.has(p)) w = '';
      else if (n.align && (a = alignOf(n, p)) !== null) {
        const sl = Ed.bol(t, n.s);
        w = lead(sl) + t.slice(nonBlank(t, sl), a).replace(/[^\t]/g, ' ');
      } else if (br && t.charAt(p) === '{') w = base(br);
      else if (cont.has(p)) {
        /* Up past the lines that begin with the same token, to the one they continue. */
        let up = ls;
        while (up > n.s) {
          up = Ed.bol(t, up - 1);
          const q = nonBlank(t, up);
          if (q < Ed.eol(t, up) && t.charAt(q) !== t.charAt(p)) break;
        }
        w = lead(up) + unit;
      } else if ((n.flat && !n.unflat) || closes(t, n, outdent.get(p)) || dedent.has(p) || (n.chain && rootSpans(n, p))) w = base(n);
      else if (n.inner && shifts.margin && base(n) === '') w = '';
      else {
        w = base(n) + unit;
        if (either.has(p) && t.slice(ls, p) === w + unit) w += unit;
      }
      /* A level for each @shift node holding the line that gives one, when the line's base is its line's. */
      if (w !== null && n) for (const P of stack)
        if (P.shift && P !== n && holds(P, p, isBlank) && Ed.bol(t, P.s) < ls && baseLine(n.s, n.s) <= Ed.bol(t, P.s) && shifted(P)) w += unit;
      starts.push(ls); want.push(w);
      made.set(ls, w ?? t.slice(ls, p));
      if (ls >= last || le >= len) break;
      ls = le + 1;
    }
    return { starts, want };
  } catch (e) {
    return null;
  }
}

/* Re-indent the lines from the one holding FROM to the one holding TO by B's indents query, the blank ones too
   when BLANKS, each changed only where its blanks differ: the number of lines the rules gave blanks to, or null
   when B has none (indents; HOW as there). Point in a line's blanks goes to its first non-blank character. */
function indent(b: EdBuffer, from: number, to: number, blanks: boolean, how?: IndentHow): number | null {
  const r = indents(b, from, to, how);
  if (!r) return null;
  let n = 0;
  for (let i = r.starts.length - 1; i >= 0; i--) {
    const w = r.want[i], ls = r.starts[i], t = b.rope, p = nonBlank(t, ls);
    if (w === null || (!blanks && p >= Ed.eol(t, ls))) continue;
    n++;
    const inBlanks = b.pt >= ls && b.pt <= p;
    if (t.slice(ls, p) !== w) Ed.replaceText(b, ls, p, w);
    if (inBlanks) b.pt = ls + w.length;
  }
  return n;
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

Ed.syntax = { tree, grammarOf, imenu, nodes, indents, indent };
})();
