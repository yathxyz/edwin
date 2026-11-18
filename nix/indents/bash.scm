; Shell's indent rules (src/syntax.ts, "Indentation"): shfmt's layout (shfmt -i N, its case patterns at the
; case's level). A block's lines a level in: a function's or a group's braces, a subshell, a command
; substitution, an array, an if's, a do ... done's and a case item's; then, elif, else, fi, done and esac at the
; statement's level. A command, a pipeline or a list continued over lines (after `\`, `|`, `&&` or `||`) a level
; in from its first line, however its parts nest; so are a for's words continued with `\`, its body at the for's
; level. A here-document's lines and a string's later lines keep their blanks.
[
  (compound_statement)
  (subshell)
  (command_substitution)
  (process_substitution)
  (array)
  (if_statement)
  (do_group)
  (case_item)
  (command)
  (declaration_command)
  (redirected_statement)
  (pipeline)
  (list)
  (test_command)
  (arithmetic_expansion)
] @indent

; A pipeline, a list or a redirected statement inside a pipeline or a list is no level of its own: tree-sitter-bash
; nests `a | b | c || d` as a | (b | c || d), and `a | b | c 2>f` as a | (b | c) 2>f; shfmt puts each continued
; line a level in from the first.
(pipeline [(pipeline) (list) (redirected_statement)] @none)
(list [(pipeline) (list) (redirected_statement)] @none)
(pipeline (redirected_statement body: [(pipeline) (list)] @none))
(list (redirected_statement body: [(pipeline) (list)] @none))

; A for's words continued with `\` a level in; its do ... done at the for's level, though `do` begins on the
; header's last line.
[
  (for_statement)
  (c_style_for_statement)
] @indent @stem

[
  "}"
  ")"
  "))"
  "]]"
  "fi"
  "done"
  "esac"
] @outdent

(if_statement "then" @dedent)
(elif_clause "elif" @dedent)
(elif_clause "then" @dedent)
(else_clause "else" @dedent)
(do_group "do" @dedent)
; The comments just before an elif, an else or a fi at the if's level, or a level in: shfmt keeps either.
(if_statement (comment)+ @dedent @either . [(elif_clause) (else_clause) "fi"])

[
  (string)
  (raw_string)
  (ansi_c_string)
] @keep

(heredoc_redirect) @keep.all
; tree-sitter-bash reads a here-document piped onward (`cat <<EOF |`, the command after its EOF) as piping into the
; body's first line, the command after EOF a statement of its own: that line is kept where it is a level in.
(
  (redirected_statement redirect: (heredoc_redirect (pipeline)) @_h)
  .
  (_) @either
  (#match? @_h "^<<[^\n]*\\|[ \t]*\n"))

(ERROR) @error
; A case item with no ;; yet holds the blank lines after it, so RET after `a)` goes a level in.
((case_item) @open (#not-match? @open ";[;&]&?$"))
(_ (MISSING "}")) @open
(_ (MISSING ")")) @open
(_ (MISSING "fi")) @open
(_ (MISSING "done")) @open
(_ (MISSING "esac")) @open
; A list or a pipeline whose command after `&&`, `||` or `|` is not typed yet holds the lines after it.
(
  [
    (list (command name: (command_name (word) @_missing)))
    (pipeline (command name: (command_name (word) @_missing)))
  ] @open
  (#eq? @_missing ""))
(ERROR ["{" "(" "$(" "then" "do"] @error.open)
(ERROR ["}" ")" "fi" "done"] @error.close)
