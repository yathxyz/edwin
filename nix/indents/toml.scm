; TOML's indent rules (src/syntax.ts, "Indentation"): taplo's layout. A table's keys at the margin; an array's
; or an inline table's lines over lines a level in from the line it begins on, its closer at that line's level.
[
  (array)
  (inline_table)
] @indent

[
  "]"
  "}"
] @outdent

(string) @keep

(ERROR) @error
(_ (MISSING "]")) @open
(_ (MISSING "}")) @open
(ERROR ["[" "{"] @error.open)
(ERROR ["]" "}"] @error.close)
