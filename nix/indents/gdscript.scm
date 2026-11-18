; GDScript's indent rules (src/syntax.ts, "Indentation"): gdformat's layout, read as Python's is (python.scm). A
; line no bracket or string holds is a statement's, placed by the offside rule (@offside: from the statement
; before it, a level in after a `:`, a level out after return, pass, break and continue, an elif or else at the
; level of its if); inside a bracket, a level in from the line the bracket begins on, or under the first element
; when that is on the bracket's line; the closing bracket at that line's level.
(source) @offside

[
  (arguments)
  (parameters)
  (parenthesized_expression)
  (array)
  (dictionary)
  (enumerator_list)
] @align

[
  ")"
  "]"
  "}"
] @outdent

(string) @keep

(ERROR) @error
(_ (MISSING ")")) @open
(_ (MISSING "]")) @open
(_ (MISSING "}")) @open
(ERROR ["(" "[" "{"] @error.open)
(ERROR [")" "]" "}"] @error.close)
