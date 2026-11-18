; Go's indent rules (src/syntax.ts, "Indentation"): gofmt's layout, a tab a level. A switch's or a select's
; cases are at its own level, their statements one deeper.
[
  (block)
  (literal_value)
  (field_declaration_list)
  (interface_type)
  (import_spec_list)
  (const_declaration)
  (var_declaration)
  (type_declaration)
  (argument_list)
  (parameter_list)
  (expression_case)
  (default_case)
  (type_case)
  (communication_case)
  (binary_expression)
  (expression_list)
] @indent

(block "}" @outdent)
(literal_value "}" @outdent)
(field_declaration_list "}" @outdent)
(interface_type "}" @outdent)
[
  ")"
  "]"
] @outdent

[
  (comment)
  (raw_string_literal)
  (interpreted_string_literal)
] @keep

(ERROR) @error
; A case holds the blank lines after it, up to the next case or the }, so RET after `case 1:` goes a level in.
[(expression_case) (default_case) (type_case) (communication_case)] @open
(_ (MISSING "}")) @open
(_ (MISSING ")")) @open
(_ (MISSING "]")) @open
(ERROR ["{" "(" "["] @error.open)
(ERROR ["}" ")" "]"] @error.close)

; A label is a level out from the statements around it.
(labeled_statement (label_name) @dedent)
; gofmt keeps a comment after a case's statements (or after its label) at the case's level or a level in.
(_ [(expression_case) (default_case) (type_case) (communication_case)] . (comment)+ @either)
