; JSON's indent rules (src/syntax.ts, "Indentation").
[
  (object)
  (array)
] @indent

[
  "}"
  "]"
] @outdent

(string) @keep

(ERROR) @error
(_ (MISSING "}")) @open
(_ (MISSING "]")) @open
(ERROR ["{" "["] @error.open)
(ERROR ["}" "]"] @error.close)
