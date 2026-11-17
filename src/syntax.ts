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
   named, and the native side loads it from the program's own bundle. */
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

Ed.syntax = { tree };
})();
