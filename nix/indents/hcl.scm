; HCL's indent rules (src/syntax.ts, "Indentation"): terraform fmt's (and tofu fmt's) layout. A block's, an
; object's, a tuple's, a for expression's and a call's lines a level in from the line it begins on, the closer
; at that line's level; an attribute's value continued over lines a level in. A heredoc's lines (its end marker
; too) and a string's later lines keep their blanks.
[
  (block)
  (object)
  (tuple)
  (for_object_expr)
  (for_tuple_expr)
  (function_call)
  (attribute)
] @indent

[
  (block_end)
  (object_end)
  (tuple_end)
  ")"
] @outdent

[
  (comment)
  (quoted_template)
] @keep

(heredoc_template) @keep.all

(ERROR) @error
(_ (MISSING block_end)) @open
(_ (MISSING object_end)) @open
(_ (MISSING tuple_end)) @open
(_ (MISSING ")")) @open
(ERROR [(block_start) (object_start) (tuple_start) "("] @error.open)
(ERROR [(block_end) (object_end) (tuple_end) ")"] @error.close)
