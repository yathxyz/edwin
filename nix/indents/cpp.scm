; C++'s indent rules (src/syntax.ts, "Indentation"), after C's (c.scm): clang-format's LLVM layout at the mode's
; width. A namespace's body and an extern "C" block are no level (a declaration list is no @indent:
; NamespaceIndentation None, IndentExternBlock AfterExternBlock). An access label goes at its class's level: LLVM's
; AccessModifierOffset is -2 whatever the width, which this engine's levels cannot give, so the fixture is formatted
; with -4 (a level out at the mode's 4).
(access_specifier) @dedent

(raw_string_literal) @keep

; A constructor's initializer list (BreakConstructorInitializers BeforeColon): its `:` line a level in from the
; function's first line, the initializers continued on later lines under the first, the body at the function's
; level though it begins on the list's last line.
(function_definition (field_initializer_list)) @indent @stem
(field_initializer_list) @align
