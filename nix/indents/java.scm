; Java's indent rules (src/syntax.ts, "Indentation"): google-java-format's layout, a level of 2. A block's, a
; class's and a switch's lines a level in, a switch's statements a level under their label; a statement or an
; expression continued over lines two levels in (+4) from the line it begins on (@indent.twice): a declarator's
; value, a call's arguments, a parameter list, an operator's operands, a method chain's `.` lines, a ternary.
[
  (block)
  (constructor_body)
  (class_body)
  (interface_body)
  (enum_body)
  (annotation_type_body)
  (switch_block)
  (switch_block_statement_group)
  (array_initializer)
  (element_value_array_initializer)
  (if_statement)
  (while_statement)
  (for_statement)
  (enhanced_for_statement)
] @indent

[
  (variable_declarator)
  (assignment_expression)
  (argument_list)
  (formal_parameters)
  (annotation_argument_list)
  (binary_expression)
  (method_invocation)
  (field_access)
  (ternary_expression)
  (return_statement)
  (expression_statement)
  (local_variable_declaration)
  (field_declaration)
] @indent.twice

[
  "}"
  ")"
] @outdent

[
  (block_comment)
  (string_literal)
] @keep

(ERROR) @error
; A case holds the blank lines after it, up to the next case or the }, so RET after `case 1:` goes a level in.
(switch_block_statement_group) @open
(_ (MISSING "}")) @open
(_ (MISSING ")")) @open
; A braceless if, while or for whose body is not typed yet (its `;` made up) holds the line after it.
[
  (if_statement (MISSING ";"))
  (while_statement (MISSING ";"))
  (for_statement (MISSING ";"))
  (enhanced_for_statement (MISSING ";"))
] @open
(ERROR ["{" "("] @error.open)
(ERROR ["}" ")"] @error.close)

; An `else` beginning a line is at its if's level.
(if_statement "else" @dedent)

; A `throws` beginning a line two levels in (+4) from its method's or constructor's first line, the body at the
; declaration's level though it begins on the `throws` line.
[
  (method_declaration (throws))
  (constructor_declaration (throws))
] @indent.twice @stem
; The annotations on lines of their own after a declaration's first, and the type or name after them, at the
; declaration's level, where the declaration holds its lines (a field, a local variable, a method or a constructor
; with a `throws`); elsewhere the declaration's holder already puts them there.
(field_declaration (modifiers _ _ @dedent))
(field_declaration (modifiers) . (_) @dedent)
(local_variable_declaration (modifiers _ _ @dedent))
(local_variable_declaration (modifiers) . (_) @dedent)
(method_declaration (modifiers _ _ @dedent) (throws))
(method_declaration (modifiers) . (_) @dedent (throws))
(constructor_declaration (modifiers _ _ @dedent) (throws))
(constructor_declaration (modifiers) . (_) @dedent (throws))
