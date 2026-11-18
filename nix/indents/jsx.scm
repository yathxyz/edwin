; JSX's indent rules, after JavaScript's (nix/grammars.nix).
[
  (jsx_element)
  (jsx_self_closing_element)
  (jsx_expression)
  (jsx_opening_element)
] @indent

(jsx_element (jsx_closing_element) @outdent)
(jsx_self_closing_element "/>" @outdent)
(jsx_opening_element ">" @outdent)

(ERROR (jsx_opening_element) @error.open)
(ERROR (jsx_closing_element) @error.close)
