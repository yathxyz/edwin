; Nix's indent rules (src/syntax.ts, "Indentation"): alejandra's layout. A line inside an attribute set, a list,
; a parenthesis, formals, a let, a binding, an inherit, an interpolation, an if, a with or an assert is a level in
; from the line the node begins on; the closing bracket, `in`, `then` and `else` at that line's level. The later
; lines of a '' string, a "" string and a block comment are never re-indented, nor the interpolations in a string.
[
  (attrset_expression)
  (rec_attrset_expression)
  (let_attrset_expression)
  (list_expression)
  (parenthesized_expression)
  (formals)
  (formal)
  (let_expression)
  (binding)
  (inherit)
  (inherit_from)
  (interpolation)
  (if_expression)
  (with_expression)
  (assert_expression)
  (select_expression)
] @indent

; A lambda's body: a level in from the line the lambda begins on, but a file's `{ pkgs, ... }:` is followed by
; its body at the margin.
(function_expression) @indent.inner

; Comment lines between a lambda's `:` and its body are at the lambda's base, and so is a body after them that
; alejandra would have begun on the `:` line (`f = x:\n  # c\n  let`); any other body is a level in (`  y;`).
(function_expression (comment) @dedent body: (_))
(function_expression
  (comment)
  .
  body: [
    (attrset_expression)
    (rec_attrset_expression)
    (let_expression)
    (list_expression)
    (parenthesized_expression)
    (string_expression)
    (indented_string_expression)
    (function_expression)
  ] @dedent)

; An application's arguments over lines are at its line's level (`f\n  a\n  b` after `x =` is the binding's).
(apply_expression) @flat

; alejandra indents the content of a parenthesis holding these, begun on the parenthesis's line, when its lines
; from the second to the one before the last are not all indented already: `(lib.recursiveUpdate {\n    a = 1;\n
; }\n  b)`. A lambda in a parenthesis is not.
(parenthesized_expression
  expression: [
    (apply_expression)
    (assert_expression)
    (binary_expression)
    (select_expression)
    (with_expression)
  ]) @shift
; Nor is one, unless comments come before its body: those and the body are then a level in (`(x:\n  # c\n    y)`).
(parenthesized_expression expression: (function_expression (comment) body: (_))) @shift
(parenthesized_expression expression: (function_expression body: (function_expression (comment) body: (_)))) @shift

[
  "}"
  "]"
  ")"
] @outdent

(let_expression "in" @dedent)
(if_expression ["then" "else"] @dedent)
; `}.a` after a multi-line attribute set.
(select_expression "." @dedent)
; `with lib;` then `assert x;` then the body, each at the first one's level.
(with_expression body: [(with_expression) (assert_expression)] @dedent)
(assert_expression body: [(with_expression) (assert_expression)] @dedent)
(assert_expression condition: (_) @flat)
(with_expression environment: (_) @flat)

; A string's or a block comment's later lines keep their blanks, the lines an interpolation holds too.
[
  (string_expression)
  (indented_string_expression)
  (comment)
] @keep.all

; While typing. A bracket tree-sitter made up holds on to the next line; so does a binding or an inherit with
; its `;` made up, and a let with its body made up (`let` and `in` typed, the body not yet). In an ERROR, `let`
; pairs with `in` and `=` with `;` beside the brackets (src/syntax.ts, errorOpens).
(ERROR) @error
(_ (MISSING "}")) @open
(_ (MISSING ")")) @open
(_ (MISSING "]")) @open
(binding (MISSING ";") @indent @open)
(inherit (MISSING ";") @indent @open)
(inherit_from (MISSING ";") @indent @open)
(let_expression body: (variable_expression (MISSING identifier) @indent @open))
(ERROR ["{" "(" "[" "${" "let" "="] @error.open)
(ERROR ["}" ")" "]" "in" ";"] @error.close)
