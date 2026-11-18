; TypeScript's indent rules, after JavaScript's (nix/grammars.nix).
[
  (interface_body)
  (object_type)
  (enum_body)
  (type_arguments)
  (type_parameters)
  (type_alias_declaration)
  (public_field_definition)
  (property_signature)
  (tuple_type)
] @indent
; A union's members after `| ` add a level to what they hold that begins on their line.
(union_type "|" . (_) @hang)
">" @outdent
; TypeScript reads `a && b!` as `(a && b)!`: the operator under the `!` is no holder.
(non_null_expression (binary_expression) @none)
; TypeScript reads `a && b!.c()` as `(a && b)!.c()`: the chain over that `!` is no holder either.
(call_expression function: (member_expression object: (non_null_expression (binary_expression)))) @none
(member_expression object: (non_null_expression (binary_expression))) @none
; and reads `a && b! in c` as `(a && b)! in c`: an operator over that `!` is no holder.
(binary_expression left: (non_null_expression (binary_expression))) @none
