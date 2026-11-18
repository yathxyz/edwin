; Meson's indent rules (src/syntax.ts, "Indentation"): meson format's layout. An if's, an elif's, an else's and
; a foreach's body a level in, endif and endforeach at the statement's level; a call's arguments, a list's and a
; dictionary's elements over lines a level in from the line it begins on, the closer at that line's level. A
; string's later lines keep their blanks.
[
  (if_command)
  (elseif_command)
  (else_command)
  (foreach_command)
  (normal_command)
  (list)
  (dictionaries)
] @indent

[
  "endforeach"
  ")"
  "]"
  "}"
] @outdent

(string) @keep

(ERROR) @error
; An if's, an elif's and an else's body holds the blank lines after it, up to the elif, else or endif, so RET
; after its last line stays in it; so does a foreach whose endforeach is not typed yet.
[
  (if_command)
  (elseif_command)
  (else_command)
] @open
((foreach_command) @open (#not-match? @open "endforeach$"))
(_ (MISSING ")")) @open
(_ (MISSING "]")) @open
(_ (MISSING "}")) @open
(ERROR ["(" "[" "{"] @error.open)
(ERROR [")" "]" "}"] @error.close)
