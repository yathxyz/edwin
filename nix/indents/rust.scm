; Rust's indent rules (src/syntax.ts, "Indentation"): rustfmt's layout.
[
  (block)
  (match_block)
  (declaration_list)
  (field_declaration_list)
  (ordered_field_declaration_list)
  (macro_definition)
  (enum_variant_list)
  (field_initializer_list)
  (use_list)
  (arguments)
  (parameters)
  (type_parameters)
  (type_arguments)
  (tuple_expression)
  (tuple_pattern)
  (tuple_type)
  (array_expression)
  (struct_pattern)
  (token_tree)
  (where_clause)
  (let_declaration)
  (binary_expression)
  (match_arm)
  (const_item)
  (static_item)
  (assignment_expression)
  (compound_assignment_expr)
] @indent

[
  "}"
  "]"
  ")"
  ">"
] @outdent

[
  (block_comment)
  (string_literal)
  (raw_string_literal)
] @keep

(ERROR) @error
(_ (MISSING "}")) @open
(_ (MISSING ")")) @open
(_ (MISSING "]")) @open
(ERROR ["{" "(" "["] @error.open)
(ERROR ["}" ")" "]"] @error.close)

; A method chain: its lines after the first a level in, but at the chain's own level when its root (the value the
; first `.` follows) spans lines, as rustfmt lays out `foo(\n    a,\n)\n.unwrap()`. A call's field is no holder: a
; closure among a call's arguments is on the call's line.
[
  (call_expression function: (field_expression))
  (field_expression)
  (await_expression)
] @indent @chain
(call_expression function: (field_expression) @none)
(field_expression value: (_) @chain.root)
(await_expression (_) @chain.root)
; A macro's arguments are tokens: a line there beginning with `.` continues the line above it as a chain does.
(token_tree "." @continue)

; A block's `{` beginning a line (after a condition, a scrutinee, a guard or a where clause that took lines) is at
; the level of the line its expression or item begins on; let-else's `else` at its let's.
[
  (if_expression)
  (while_expression)
  (for_expression)
  (loop_expression)
  (match_expression)
  (match_arm)
  (function_item)
  (impl_item)
  (trait_item)
  (struct_item)
  (enum_item)
  (union_item)
] @brace
(let_declaration "else" @dedent)
; An arm with an attribute begins on the attribute's line: its pattern is no continuation.
(match_arm (attribute_item)) @none
