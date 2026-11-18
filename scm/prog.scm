;;; prog.scm: prog-mode, the mode every programming language's mode derives from, and define-language,
;;; which declares one language: the files that open in it, its comment syntax and its indent width; and
;;; define-formatter, which names the program format-buffer runs on a mode's buffers, and
;;; format-on-save-modes, the languages formatted before each save.
;;;
;;; A language's mode is a define-derived-mode of prog-mode, so it has the usual NAME-map and NAME-hook, and
;;; prog-mode-hook runs in every one of them. Visiting a file turns its mode on (Ed.visit), so the indent width
;;; and the hooks apply to files opened by name as well as to M-x NAME. The file patterns go on
;;; auto-mode-alist (markdown.scm), after the entries already there. Loads after markdown.scm and before
;;; init.scm, so the user's init.scm can declare a language again to change it.

(require 'markdown)

(define-derived-mode prog-mode #f "Prog"
  "Major mode for program text: the parent of every mode define-language makes."
  #f)

(define languages '()
  "Each declared language, newest first: (MODE FILES INDENT), INDENT #f where the language sets none.")

(define (language--check mode name files comment indent)
  "Refuse a declaration whose MODE is not a symbol, whose NAME is not a non-empty string, whose FILES are not a
non-empty list of non-empty strings each a JavaScript regexp (compiled with no flags, as auto-mode-alist's lookup
compiles it), or whose INDENT is neither #f nor a positive integer. set-comment-syntax! checks COMMENT."
  (unless (symbol? mode)
    (error "define-language: the mode is not a symbol:" mode))
  (unless (and (string? name) (> (string-length name) 0))
    (error "define-language: the name is not a non-empty string for" mode name))
  (unless (and (pair? files) (list? files)
               (let all ((f files)) (or (null? f) (and (string? (car f)) (> (string-length (car f)) 0) (all (cdr f))))))
    (error "define-language: :files needs a non-empty list of regexp strings for" mode files))
  (for-each (lambda (re)
              (unless (ignore-errors (regexp re ""))
                (error "define-language: :files has a pattern that is not a JavaScript regexp for" mode re)))
            files)
  (unless (or (not indent) (and (exact-integer? indent) (> indent 0)))
    (error "define-language: :indent is neither #f nor a positive integer for" mode indent))
  (unless (or (not comment) (pair? comment))
    (error "define-language: :comment needs a list (LINE [BLOCK-START BLOCK-END]) for" mode comment)))

(define (language--declare! mode name options)
  "Record MODE's language, shown as NAME, from OPTIONS, a list of :files, :comment and :indent each followed by its value:
its entry in languages and its comment syntax replace any earlier ones, and its file patterns replace its
earlier entries on auto-mode-alist, after the other entries."
  (let loop ((o options) (files #f) (comment #f) (indent #f))
    (cond ((null? o)
           (language--check mode name files comment indent)
           ;; With no :comment the mode takes prog-mode's lookup, not an earlier declaration's.
           (if comment
               (apply set-comment-syntax! mode comment)
               (set! comment-syntaxes (filter (lambda (e) (not (eq? (car e) mode))) comment-syntaxes)))
           (set! languages (cons (list mode files indent)
                                 (filter (lambda (l) (not (eq? (car l) mode))) languages)))
           (set! auto-mode-alist
                 (append (filter (lambda (e) (not (eq? (cdr e) mode))) auto-mode-alist)
                         (map (lambda (re) (cons re mode)) files))))
          ((not (pair? (cdr o))) (error "define-language: a keyword without a value for" mode (car o)))
          ((eq? (car o) :files) (loop (cddr o) (cadr o) comment indent))
          ((eq? (car o) :comment) (loop (cddr o) files (cadr o) indent))
          ((eq? (car o) :indent) (loop (cddr o) files comment (cadr o)))
          (else (error "define-language: unknown option for" mode (car o))))))

(define (language--set-up mode)
  "Give the current buffer MODE's indent width: TAB's tab stops (tab-width) and > and < (evil-shift-width)."
  (let* ((l (assq mode languages))
         (w (and l (caddr l))))
    (when w
      (setq-local tab-width w)
      (setq-local evil-shift-width w))))

(define-macro (define-language mode name . rest)
  "(define-language MODE NAME :files REGEXPS [:comment (LINE [BLOCK-START BLOCK-END])] [:indent N] BODY...)
declares a language: MODE, shown as NAME, derives from prog-mode; a file whose name matches one of REGEXPS
(JavaScript regexps, tried on the name as given) opens in it; :comment is its set-comment-syntax!; :indent N
sets TAB's stops and > and < to N columns in its buffers. BODY runs each time the mode is turned on, after
prog-mode's. The option values are evaluated. Declaring MODE again replaces all of it."
  (let loop ((r rest) (kw '()))
    (if (and (pair? r) (keyword? (car r)))
        (if (pair? (cdr r))
            (loop (cddr r) (cons (cadr r) (cons (car r) kw)))
            (error "define-language: a keyword without a value for" mode (car r)))
        (let ((nm (gensym "name")))
          `(let ((,nm ,name))
             (language--declare! ',mode ,nm (list ,@(reverse kw)))
             (define-derived-mode ,mode prog-mode ,nm (language--set-up ',mode) ,@r)
             ',mode)))))

;;;; The languages (from the desktop's init-prog.el, and those the plan's later packages name)

;; Indent widths follow each language's usual formatter (rustfmt, alejandra, black, prettier, terraform fmt,
;; just --fmt, the Google Java style init-prog.el formats with). Go and GDScript indent with tabs in their
;; formatters; here they take spaces, which gofmt turns back into tabs.
(define-language rust-mode "Rust" :files '("\\.rs$") :comment '("//" "/*" "*/") :indent 4)
(define-language nix-mode "Nix" :files '("\\.nix$") :comment '("#" "/*" "*/") :indent 2)
(define-language go-mode "Go" :files '("\\.go$") :comment '("//" "/*" "*/") :indent 4)
(define-language c-mode "C" :files '("\\.[ch]$") :comment '("//" "/*" "*/") :indent 4)
(define-language c++-mode "C++" :files '("\\.(cc|cpp|cxx|hh|hpp|hxx)$") :comment '("//" "/*" "*/") :indent 4)
(define-language java-mode "Java" :files '("\\.java$") :comment '("//" "/*" "*/") :indent 2)
(define-language csharp-mode "C#" :files '("\\.cs$") :comment '("//" "/*" "*/") :indent 4)
(define-language python-mode "Python" :files '("\\.pyi?$") :comment '("#") :indent 4)
(define-language js-mode "JavaScript" :files '("\\.(js|mjs|cjs|jsx)$") :comment '("//" "/*" "*/") :indent 2)
(define-language typescript-mode "TypeScript" :files '("\\.(ts|mts|cts)$") :comment '("//" "/*" "*/") :indent 2)
(define-language tsx-mode "TSX" :files '("\\.tsx$") :comment '("//" "/*" "*/") :indent 2)
;; JSON has no comments; // is the one JSONC files (tsconfig.json, editor settings) take, as Emacs's
;; js-json-mode has it.
(define-language json-mode "JSON" :files '("\\.jsonc?$" "(^|/)flake\\.lock$") :comment '("//") :indent 2)
(define-language yaml-mode "YAML" :files '("\\.ya?ml$") :comment '("#") :indent 2)
(define-language toml-mode "TOML" :files '("\\.toml$") :comment '("#") :indent 2)
(define-language sh-mode "Shell" :files '("\\.(sh|bash)$" "(^|/)\\.envrc$") :comment '("#") :indent 2)
(define-language terraform-mode "Terraform" :files '("\\.(tf|tfvars|tofu)$") :comment '("#" "/*" "*/") :indent 2)
(define-language gdscript-mode "GDScript" :files '("\\.gd$") :comment '("#") :indent 4)
(define-language just-mode "Just" :files '("(^|/)\\.?[jJ][uU][sS][tT][fF][iI][lL][eE]$" "\\.just$") :comment '("#") :indent 4)
(define-language meson-mode "Meson" :files '("(^|/)meson\\.build$" "(^|/)meson(_options\\.txt|\\.options)$") :comment '("#") :indent 4)
(define-language nasm-mode "NASM" :files '("\\.nasm$") :comment '(";") :indent 4)
(define-language nginx-mode "Nginx" :files '("(^|/)nginx\\.conf$" "/nginx/.+\\.conf$") :comment '("#") :indent 4)
(define-language typst-mode "Typst" :files '("\\.typ$") :comment '("//" "/*" "*/") :indent 2)

;;;; Formatters: format-buffer (SPC b f, src/format.ts) runs the buffer's mode's formatter

(define (define-formatter modes command)
  "(define-formatter MODES COMMAND) makes COMMAND the formatter format-buffer runs in buffers of MODES (a mode, or
a list of modes). COMMAND is an argv: a list of strings, the program first (found on PATH, and on the PATH the
directory's direnv gives), and the symbol file anywhere for the buffer's file name, absolute. The formatter gets
the buffer's text on its standard input and prints it formatted on its standard output; it runs in the file's
directory. #f for COMMAND takes MODES' formatter away. Declaring a mode again replaces its formatter. Skipped,
with a message, while the image replays."
  (%format-declare modes command))

;; Each reads its standard input and writes its standard output, and finds its own settings from the file's
;; directory, settings that are data only (.editorconfig, rustfmt.toml, pyproject.toml, .clang-format): no
;; prettier, which loads a repository's prettier.config.js and plugins and so runs its code. Nix's is alejandra
;; (the owner's choice). rustfmt is told the 2021 edition, since on its standard input it cannot read Cargo.toml's
;; and would take 2015's, which does not parse async fn; the flag beats a rustfmt.toml's edition.
(define-formatter 'nix-mode '("alejandra" "--quiet" "-"))
(define-formatter 'rust-mode '("rustfmt" "--edition=2021" "--emit=stdout" "--quiet"))
(define-formatter 'go-mode '("gofmt"))
(define-formatter 'python-mode '("black" "--quiet" "-"))
(define-formatter '(c-mode c++-mode) '("clang-format" "--assume-filename" file))
(define-formatter 'sh-mode '("shfmt" "--filename" file))

;; Format on save (format-on-save-mode, src/format.ts): off in every language unless its mode is listed here.
(define format-on-save-modes '()
  "The major modes whose buffers turn format-on-save-mode on as the mode starts, so that a save typed by the user
(SPC f s, C-x C-s, :w, :wq, :x, ZZ, :wa) runs format-buffer first. Empty: no language formats on save unless
listed, as in (set! format-on-save-modes '(nix-mode rust-mode)) in init.scm. Buffers already open keep their
state; M-x format-on-save-mode turns it on or off in one buffer.")

(define (format-on-save--turn-on)
  "On prog-mode-hook: turn format-on-save-mode on when the buffer's major mode is in format-on-save-modes."
  (when (memq (major-mode) format-on-save-modes) (format-on-save-mode 1)))

(add-hook! 'prog-mode-hook format-on-save--turn-on)

;;;; ws-butler: trailing blanks removed on save from the lines that changed, and from no others

(define ws-butler-mode #t
  "Non-#f: saving a programming buffer (a mode derived from prog-mode) or a Scheme buffer removes the trailing
spaces and tabs of the lines that differ from its file (buffer-changed-lines) and leaves the other lines as they are.")

(define (ws-butler--before-save)
  "On before-save-hook: with ws-butler-mode on, trim the changed lines of a modified, writable programming or
Scheme buffer."
  (when (and ws-butler-mode
             (buffer-modified-p)
             (not (buffer-read-only?))
             (or (derived-mode-p 'prog-mode) (lisp-buffer?)))
    (let ((ranges (buffer-changed-lines)))
      (when (pair? ranges) (delete-trailing-blanks ranges)))))

(add-hook! 'before-save-hook ws-butler--before-save)
