; JavaScript's indent rules (src/syntax.ts, "Indentation"): prettier's layout. TypeScript's and TSX's are these
; and their own (nix/grammars.nix).
[
  (statement_block)
  (class_body)
  (object)
  (object_pattern)
  (array)
  (array_pattern)
  (arguments)
  (formal_parameters)
  (named_imports)
  (export_clause)
  (switch_body)
  (switch_case)
  (switch_default)
  (parenthesized_expression)
  (template_substitution)
  (expression_statement)
  (lexical_declaration)
  (variable_declaration)
  (return_statement)
  (pair)
  (assignment_expression)
] @indent

[
  "}"
  ")"
  "]"
] @outdent

[
  (comment)
  (template_string)
  (string)
] @keep

(ERROR) @error
; A case holds the blank lines after it, up to the next case or the }, so RET after `case 1:` goes a level in.
[(switch_case) (switch_default)] @open
(_ (MISSING "}")) @open
(_ (MISSING ")")) @open
(_ (MISSING "]")) @open
(ERROR ["{" "(" "["] @error.open)
(ERROR ["}" ")" "]"] @error.close)
; A body with no braces is a level in from its statement, and an `else` that begins a line is at its `if`'s level,
; as is a comment between an if's body and its else; so is a multi-line for header's `)`.
[
  (if_statement)
  (else_clause)
  (for_statement)
  (for_in_statement)
  (while_statement)
  (do_statement)
  (arrow_function)
  (variable_declarator)
  (subscript_expression)
] @indent
(else_clause "else" @dedent)
(if_statement consequence: (_) . (comment)+ @dedent)
(for_statement ")" @dedent)

; A member chain: its lines after the first a level in. A call's member is no holder: a function among a call's
; arguments is on the call's line.
[
  (call_expression function: (member_expression))
  (member_expression)
] @indent
(call_expression function: (member_expression) @none)

; A ternary: its branches a level in. An operator in it is at its level (its condition's, at the ternary's; its
; branch's, at the branch's),
(ternary_expression) @indent
(ternary_expression condition: (binary_expression) @flat)
(ternary_expression consequence: (binary_expression) @flat)
(ternary_expression alternative: (binary_expression) @flat)
; but not one of a ternary in a return, a throw or a call's arguments (prettier's binary layout).
[
  (return_statement (ternary_expression [condition: (binary_expression) consequence: (binary_expression) alternative: (binary_expression)] @unflat))
  (return_statement (parenthesized_expression (ternary_expression [condition: (binary_expression) consequence: (binary_expression) alternative: (binary_expression)] @unflat)))
  (throw_statement (ternary_expression [condition: (binary_expression) consequence: (binary_expression) alternative: (binary_expression)] @unflat))
  (arguments (ternary_expression [condition: (binary_expression) consequence: (binary_expression) alternative: (binary_expression)] @unflat))
]

; An operator's operands after the first a level in (prettier's binary layout), an operator of the same
; precedence on its left one with it, but at the first's level where prettier does not indent them: the condition of
; an if, a while, a do or a switch, the body of an arrow function, the value of a declarator, an assignment or a
; property, a return's or a throw's parenthesized value, a template's substitution.
(binary_expression) @indent
(binary_expression left: (binary_expression operator: "&&") @none operator: "&&")
(binary_expression left: (binary_expression operator: "||") @none operator: "||")
(binary_expression left: (binary_expression operator: "??") @none operator: "??")
(binary_expression left: (binary_expression operator: ["+" "-"]) @none operator: ["+" "-"])
(binary_expression left: (binary_expression operator: ["*" "/"]) @none operator: ["*" "/"])
(binary_expression left: (binary_expression operator: "|") @none operator: "|")
(binary_expression left: (binary_expression operator: "&") @none operator: "&")
(binary_expression left: (binary_expression operator: "^") @none operator: "^")
(if_statement condition: (parenthesized_expression (binary_expression) @flat))
(while_statement condition: (parenthesized_expression (binary_expression) @flat))
(do_statement condition: (parenthesized_expression (binary_expression) @flat))
(switch_statement value: (parenthesized_expression (binary_expression) @flat))
(arrow_function body: (binary_expression) @flat)
(variable_declarator value: (binary_expression) @flat)
(assignment_expression right: (binary_expression) @flat)
(augmented_assignment_expression right: (binary_expression) @flat)
(pair value: (binary_expression) @flat)
(return_statement (parenthesized_expression (binary_expression) @flat))
(throw_statement (parenthesized_expression (binary_expression) @flat))
(template_substitution (binary_expression) @flat)
; An operator's operands inside a ( on the line of the operator's first operand, a level in from that line.
(parenthesized_expression (binary_expression) @flat @hang.self)

; prettier's indents begun inside a line: a ternary's branches (after `? ` and `: `), but one that is a ternary
; itself, and each declarator of a declaration of more than one, add a level to what they hold that begins on
; their line.
(ternary_expression consequence: (_) @hang)
(ternary_expression alternative: (_) @hang)
(ternary_expression consequence: (ternary_expression) @unhang)
(ternary_expression alternative: (ternary_expression) @unhang)
(lexical_declaration (variable_declarator) @hang . ",")
(lexical_declaration "," . (variable_declarator) @hang)
(variable_declaration (variable_declarator) @hang . ",")
(variable_declaration "," . (variable_declarator) @hang)
; A multi-line for header's condition is at the header's level.
(for_statement condition: (binary_expression) @flat)
; An arrow function returning one, the value of a declarator or an assignment, is at its level (prettier's chain).
(variable_declarator value: (arrow_function body: (arrow_function) @dedent))
(variable_declarator value: (arrow_function body: (arrow_function body: (arrow_function) @dedent)))
(assignment_expression right: (arrow_function body: (arrow_function) @dedent))
(assignment_expression right: (arrow_function body: (arrow_function body: (arrow_function) @dedent)))
; While typing, a statement with no body yet (`if (a)`, its `;` made up) holds the next line: the body goes there.
[
  (if_statement consequence: (empty_statement (MISSING ";")))
  (else_clause (empty_statement (MISSING ";")))
  (for_statement body: (empty_statement (MISSING ";")))
  (for_in_statement body: (empty_statement (MISSING ";")))
  (while_statement body: (empty_statement (MISSING ";")))
] @open
