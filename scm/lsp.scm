;;; lsp.scm: the language servers, declared by define-language-server. The sessions that run them, and the
;;; commands eglot, eglot-shutdown, eglot-shutdown-all, eglot-reconnect and eglot-stderr-buffer, are src/lsp.ts's.

(define (define-language-server name . options)
  "(define-language-server NAME :modes MODES :command ARGV) declares the language server NAME (a symbol) for the
major modes MODES (a non-empty list of symbols), run as ARGV (a non-empty list of strings, the program first,
found on PATH). M-x eglot starts it for a buffer in one of MODES, one process per project. Declaring NAME again
replaces it; of two servers for one mode the one declared last is used. A missing or malformed option signals
lsp-error. Skipped, with a message, while the image replays."
  (let loop ((o options) (modes #f) (command #f))
    (cond ((null? o)
           (unless modes (signal 'lsp-error "define-language-server: no :modes for" name))
           (unless command (signal 'lsp-error "define-language-server: no :command for" name))
           (%lsp-declare name modes command))
          ((not (pair? (cdr o))) (signal 'lsp-error "define-language-server: a keyword without a value for" name (car o)))
          ((eq? (car o) :modes) (loop (cddr o) (cadr o) command))
          ((eq? (car o) :command) (loop (cddr o) modes (cadr o)))
          (else (signal 'lsp-error "define-language-server: unknown option for" name (car o))))))

(provide 'lsp)
