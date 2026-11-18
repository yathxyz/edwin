; Python's indent rules (src/syntax.ts, "Indentation"): black's layout. A line no bracket or string holds is a
; statement's, placed by Python's line rules (@offside: from the statement before it, a level in after a `:`, a
; level out after return, pass, raise, break and continue, and an else, elif, except, finally or case at the
; level of the statement it goes with), since its blanks are what the tree is parsed from. Inside a bracket, a
; level in from the line the bracket begins on, or under the first element when that is on the bracket's line;
; the closing bracket at that line's level.
(module) @offside

[
  (argument_list)
  (parameters)
  (parenthesized_expression)
  (tuple)
  (list)
  (dictionary)
  (set)
  (list_comprehension)
  (dictionary_comprehension)
  (set_comprehension)
  (generator_expression)
  (tuple_pattern)
  (list_pattern)
  (dict_pattern)
  (type_parameter)
] @align

; Brackets that are not a node of their own: the node begins before its bracket. An import or a with clause
; holds only when it has brackets: without them its lines are a statement's (a backslash's line is offside's).
[
  (subscript)
  (import_from_statement "(")
  (future_import_statement "(")
  (with_clause "(")
  (class_pattern)
] @indent

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
