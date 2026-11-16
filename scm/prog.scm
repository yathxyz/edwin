;;; prog.scm: prog-mode, the mode every programming language's mode derives from, and define-language,
;;; which declares one language: the files that open in it, its comment syntax and its indent width.
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
