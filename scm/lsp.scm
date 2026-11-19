;;; lsp.scm: the language servers, declared by define-language-server, and the table of the owner's languages'
;;; servers. The sessions that run them, the documents
;;; they are told of, eglot-mode, the commands eglot, eglot-shutdown, eglot-shutdown-all, eglot-reconnect and
;;; eglot-stderr-buffer, and the cross references (xref-find-definitions, xref-find-references, the eglot-find-*
;;; commands, *xref* and xref-go-back), eldoc (the hover at point), the signatures shown while typing and the
;;; diagnostics (counted in the mode line, the ones at point in the echo area, flymake-show-buffer-diagnostics and
;;; flymake-show-project-diagnostics), the workspace edits (eglot-rename), completion (the server's items in the
;;; completion popup), the code actions (eglot-code-actions, eglot-code-action-quickfix) and the symbols (the
;;; server's in consult-imenu, the workspace's in consult-eglot-symbols) are src/lsp.ts's; their keys are in
;;; scm/evil.scm, scm/emacs.scm and scm/init.scm.

(define (define-language-server name . options)
  "(define-language-server NAME :modes MODES :command ARGV [:settings SETTINGS]) declares the language server NAME
(a symbol) for the major modes MODES (a non-empty list of symbols), run as ARGV (a non-empty list of strings, the
program first, found on PATH: the project's direnv PATH where an allowed .envrc gives one). Visiting a file in one of MODES turns eglot-mode on there, which starts it for the
file's project (one process per project) and tells it of the buffer; M-x eglot does so in the current buffer.
SETTINGS are the server's settings, given to it when it asks (workspace/configuration) and once it is initialized
(workspace/didChangeConfiguration): JSON as Scheme (an alist with symbol keys an object, a vector or another list an
array, a string, a number, #t or #f), or a procedure of the project's root that gives them, called when the
server is started in a root (again by eglot-reconnect; not when it is started again after a crash). Declaring
NAME again replaces it; of two servers for one mode the one declared last is used. A missing or malformed option
signals lsp-error. Skipped, with a message, while the image replays."
  (let loop ((o options) (modes #f) (command #f) (settings '()))
    (cond ((null? o)
           (unless modes (signal 'lsp-error "define-language-server: no :modes for" name))
           (unless command (signal 'lsp-error "define-language-server: no :command for" name))
           (apply %lsp-declare name modes command settings))
          ((not (pair? (cdr o))) (signal 'lsp-error "define-language-server: a keyword without a value for" name (car o)))
          ((eq? (car o) :modes) (loop (cddr o) (cadr o) command settings))
          ((eq? (car o) :command) (loop (cddr o) modes (cadr o) settings))
          ((eq? (car o) :settings) (loop (cddr o) modes command (list (cadr o))))
          (else (signal 'lsp-error "define-language-server: unknown option for" name (car o))))))

;;; The servers of the owner's languages (his Emacs's init-prog.el, and eglot's own table for the rest), each
;;; found on PATH when it starts (the project's direnv PATH, where it has an .envrc): where one is missing, visiting a file of its mode says so. Standalone edwin's
;;; init.scm declares one again to change it, or another for the same modes. An edwinclient frame has no init.scm
;;; of its own (edwind's is evaluated as the image replays, where a declaration is skipped): there this table is
;;; the one used, and changing it means changing this file.

;; S as a Nix string literal: its \, ", $ and newlines escaped, so no directory's name is read as Nix code.
(define (lsp--nix-string s)
  (string-append "\""
                 (string-replace (string-replace (string-replace (string-replace s "\\" "\\\\") "\"" "\\\"") "$" "\\$")
                                 "\n" "\\n")
                 "\""))

;; nixd's settings in ROOT: the nixpkgs its completions come from, ROOT's flake's when ROOT is a git repository
;; (a .git: a directory, or a worktree's file) with a flake.nix, else <nixpkgs>, as the owner's Emacs gave it.
;; getFlake on a path copies it into the store, world-readable: of a git repository the tracked files, which are
;; the flake; of any other directory (a .jj-only repository, or a directory with no repository, the root of a file
;; outside one) everything in it, untracked files and all, so those get <nixpkgs>. A ROOT whose name holds a ? or a
;; # gets <nixpkgs> too: getFlake reads its argument as a flake reference, where those begin a query and a fragment.
(define (lsp--nixd-settings root)
  (list (list 'nixd
              (list 'nixpkgs
                    (cons 'expr
                          (if (and (file-exists? (string-append root "/.git"))
                                   (file-exists? (string-append root "/flake.nix"))
                                   (not (string-index root #\?))
                                   (not (string-index root #\#)))
                              (string-append "import (builtins.getFlake " (lsp--nix-string root) ").inputs.nixpkgs { }")
                              "import <nixpkgs> { }"))))))

(define-language-server 'nixd :modes '(nix-mode) :command '("nixd") :settings lsp--nixd-settings)
(define-language-server 'rust-analyzer :modes '(rust-mode) :command '("rust-analyzer"))
(define-language-server 'gopls :modes '(go-mode) :command '("gopls"))
(define-language-server 'pyright :modes '(python-mode) :command '("pyright-langserver" "--stdio"))
(define-language-server 'terraform-ls :modes '(terraform-mode) :command '("terraform-ls" "serve"))
(define-language-server 'clangd :modes '(c-mode c++-mode) :command '("clangd"))
(define-language-server 'typescript-language-server :modes '(typescript-mode tsx-mode js-mode)
  :command '("typescript-language-server" "--stdio"))
(define-language-server 'harper-ls :modes '(markdown-mode) :command '("harper-ls" "--stdio"))

(provide 'lsp)
