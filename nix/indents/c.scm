; C's indent rules (src/syntax.ts, "Indentation"): clang-format's layout (LLVM's, of any IndentWidth): a case
; label at its switch's level, the statements under it one deeper, a call's or a declaration's arguments
; continued under the first.
[
  (compound_statement)
  (field_declaration_list)
  (enumerator_list)
  (initializer_list)
  (case_statement)
  (declaration)
  (expression_statement)
  (return_statement)
  (if_statement)
  (else_clause)
  (while_statement)
  (for_statement)
  (do_statement)
] @indent

; A switch's body is not a level: its case labels are at the switch's.
(switch_statement body: (compound_statement) @none)

[
  "}"
  ")"
  "]"
] @outdent

[
  (argument_list)
  (parameter_list)
  (parenthesized_expression)
  (initializer_list)
] @align

[
  (comment)
  (string_literal)
  (preproc_def)
  (preproc_function_def)
] @keep

(ERROR) @error
; A case holds the blank lines after it, up to the next case or the }, so RET after `case 1:` goes a level in.
(case_statement) @open
(_ (MISSING "}")) @open
(_ (MISSING ")")) @open
(_ (MISSING "]")) @open
(ERROR ["{" "(" "["] @error.open)
(ERROR ["}" ")" "]"] @error.close)

; clang-format's continuations: an operator's operands under its first (AlignOperands), a `(` holding the line
; aligned after it (above), as is a line of a for's header; a for's body at the for's level, though it begins on
; the header's last line.
(binary_expression) @align.start
(for_statement) @stem @align
; A member taken on a later line, a level in; so is a designated initializer's value.
(field_expression) @indent
(initializer_pair) @indent
; A preprocessor directive is at the margin, inside a function too; a directive's continued condition keeps its
; blanks.
[
  "#if"
  "#ifdef"
  "#ifndef"
  "#elif"
  "#elifdef"
  "#elifndef"
  "#else"
  "#endif"
  "#include"
  "#define"
  (preproc_directive)
] @flush
(preproc_if condition: (_) @keep)
(preproc_elif condition: (_) @keep)
; An `else` beginning a line is at its if's level, as is a comment between the if's body and its else.
(else_clause "else" @dedent)
(if_statement consequence: (_) . (comment)+ @dedent)
