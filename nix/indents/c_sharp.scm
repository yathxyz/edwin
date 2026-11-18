; C#'s indent rules (src/syntax.ts, "Indentation"): CSharpier's layout, a level of 4, braces on lines of their
; own. A body's lines a level in from the line it begins on; a `{` beginning a line at the level of the
; declaration, statement or expression it belongs to (@brace), whose header continued over lines (a `where`
; clause, a braceless body) is a level in; a switch's sections a level in and their statements a level under the
; label; arguments, parameters and a declarator's value over lines a level in, the closing `)` at the line's level.
[
  (declaration_list)
  (enum_member_declaration_list)
  (accessor_list)
  (block)
  (switch_body)
  (switch_section)
  (switch_expression)
  (initializer_expression)
  (anonymous_object_creation_expression)
  (argument_list)
  (parameter_list)
  (bracketed_argument_list)
  (variable_declarator)
  (assignment_expression)
  (invocation_expression)
  (binary_expression)
  (conditional_expression)
  (class_declaration)
  (struct_declaration)
  (record_declaration)
  (interface_declaration)
  (enum_declaration)
  (namespace_declaration)
  (method_declaration)
  (constructor_declaration)
  (property_declaration)
  (if_statement)
  (for_statement)
  (foreach_statement)
  (while_statement)
  (do_statement)
  (using_statement)
  (lock_statement)
  (fixed_statement)
  (switch_statement)
  (try_statement)
  (catch_clause)
  (finally_clause)
  (lambda_expression)
  (object_creation_expression)
  (implicit_object_creation_expression)
  (array_creation_expression)
  (implicit_array_creation_expression)
] @indent

[
  (class_declaration)
  (struct_declaration)
  (record_declaration)
  (interface_declaration)
  (enum_declaration)
  (namespace_declaration)
  (method_declaration)
  (constructor_declaration)
  (property_declaration)
  (accessor_declaration)
  (if_statement)
  (for_statement)
  (foreach_statement)
  (while_statement)
  (do_statement)
  (using_statement)
  (lock_statement)
  (fixed_statement)
  (switch_statement)
  (switch_expression)
  (try_statement)
  (catch_clause)
  (finally_clause)
  (lambda_expression)
  (object_creation_expression)
  (implicit_object_creation_expression)
  (anonymous_object_creation_expression)
  (array_creation_expression)
  (implicit_array_creation_expression)
] @brace

[
  "}"
  ")"
  "]"
] @outdent

; An `else`, a `catch` and a `finally` beginning a line are at the level of what they go with.
(if_statement "else" @dedent)
(catch_clause) @dedent
(finally_clause) @dedent

[
  (comment)
  (string_literal)
  (verbatim_string_literal)
  (raw_string_literal)
  (interpolated_string_expression)
] @keep

(ERROR) @error
; A case holds the blank lines after it, up to the next case or the }, so RET after `case 1:` goes a level in.
(switch_section) @open
(_ (MISSING "}")) @open
(_ (MISSING ")")) @open
(_ (MISSING "]")) @open
; A braceless body not typed yet (an empty statement whose `;` tree-sitter made up) holds the line after it.
(_ (empty_statement (MISSING ";"))) @open
(ERROR ["{" "(" "["] @error.open)
(ERROR ["}" ")" "]"] @error.close)
