;;; emacs.scm --- the editor prelude, plus plain Emacs commands and keys

;; Edwin is scripted in Scheme: a Lisp-1 with lexical scope, closures and
;; proper tail calls.  Commands are procedures with an interactive spec.
;;
;;   (define-command (name arg ...)
;;     "Docstring."
;;     (interactive "spec")     ; optional; omit it for a command with no arguments
;;     body ...)
;;
;; The spec reads the arguments the way Emacs does: "p" the prefix count,
;; "r" the region, "sPrompt: " a string, "bBuffer: " a buffer name,
;; "fFile: " a file, "kKey: " a key, "C" a command, "a" a procedure,
;; "v" a variable, "x" a Scheme datum.  evil.scm adds <c> <x> <R> <C>
;; and the ex codes.  Several codes are joined with newlines.  A leading
;; * signals an error in a read-only buffer.  The spec may also be an
;; expression that returns the list of arguments.
;;
;; Positions are 1-based like Emacs: (point) (point-min) (point-max).
;; Characters are Scheme chars: (char-after) returns #\a, insert accepts
;; strings and chars.  Keymap entries are symbols, looked up when the key
;; is pressed, so redefining a command takes effect at once.

;;;; The prelude

(define-syntax define-command
  (syntax-rules (interactive :where)
    ((_ (name . args) (interactive spec) (:where w) body ...)
     (begin (define (name . args) body ...) (set-interactive! 'name (lambda () spec)) (set-command-where! 'name w) 'name))
    ((_ (name . args) (interactive) (:where w) body ...)
     (begin (define (name . args) body ...) (set-interactive! 'name "") (set-command-where! 'name w) 'name))
    ((_ (name . args) doc (interactive spec) (:where w) body ...)
     (begin (define (name . args) doc body ...) (set-interactive! 'name (lambda () spec)) (set-command-where! 'name w) 'name))
    ((_ (name . args) doc (interactive) (:where w) body ...)
     (begin (define (name . args) doc body ...) (set-interactive! 'name "") (set-command-where! 'name w) 'name))
    ((_ (name . args) (:where w) body ...)
     (begin (define (name . args) body ...) (set-interactive! 'name "") (set-command-where! 'name w) 'name))
    ((_ (name . args) doc (:where w) body ...)
     (begin (define (name . args) doc body ...) (set-interactive! 'name "") (set-command-where! 'name w) 'name))
    ((_ (name . args) (interactive spec) body ...)
     (begin (define (name . args) body ...) (set-interactive! 'name (lambda () spec)) 'name))
    ((_ (name . args) (interactive) body ...)
     (begin (define (name . args) body ...) (set-interactive! 'name "") 'name))
    ((_ (name . args) doc (interactive spec) body ...)
     (begin (define (name . args) doc body ...) (set-interactive! 'name (lambda () spec)) 'name))
    ((_ (name . args) doc (interactive) body ...)
     (begin (define (name . args) doc body ...) (set-interactive! 'name "") 'name))
    ((_ (name . args) body ...)
     (begin (define (name . args) body ...) (set-interactive! 'name "") 'name))))

(define-syntax save-excursion
  (syntax-rules () ((_ body ...) (%save-excursion (lambda () body ...)))))

(define-syntax with-current-buffer
  (syntax-rules () ((_ buffer body ...) (%with-current-buffer buffer (lambda () body ...)))))

(define-syntax with-inhibit-read-only
  (syntax-rules () ((_ body ...) (parameterize ((inhibit-read-only #t)) body ...))))

(define (add-hook! hook f . append?)
  "Add procedure F to the list held by the variable named HOOK."
  (%add-hook hook f (and (pair? append?) (car append?))))

(define (remove-hook! hook f)
  "Remove F from the hook named HOOK."
  (%remove-hook hook f))

(define (run-hooks . hooks)
  "Call every procedure in each HOOK."
  (for-each %run-hook hooks))

(define (region-beginning-or-point) (if (region-active?) (region-beginning) (point)))

;;;; Small helpers

(define (word-char? c)
  "#t if the character C is part of a word."
  (and (char? c) (or (char-alphabetic? c) (char-numeric? c) (char=? c #\_))))

(define (lisp-buffer?)
  "#t if the current buffer holds Scheme code."
  (memq (major-mode) '(scheme-mode scheme-interaction-mode)))

(define (region-or-line)
  "The active region, or the current line, as two values."
  (if (region-active?)
      (values (region-beginning) (region-end))
      (values (line-beginning-position) (min (point-max) (+ 1 (line-end-position))))))

;;;; Words

(define-command (forward-word #!optional n)
  "Move point forward N words, or backward if N is negative."
  (interactive "^p")
  (let ((n (or n 1)))
    (if (< n 0)
        (backward-word (- n))
        (dotimes (_ n)
          (while (and (not (eobp)) (not (word-char? (char-after)))) (forward-char 1))
          (while (and (not (eobp)) (word-char? (char-after))) (forward-char 1))))))

(define-command (backward-word #!optional n)
  "Move point backward N words."
  (interactive "^p")
  (let ((n (or n 1)))
    (if (< n 0)
        (forward-word (- n))
        (dotimes (_ n)
          (while (and (not (bobp)) (not (word-char? (char-before)))) (backward-char 1))
          (while (and (not (bobp)) (word-char? (char-before))) (backward-char 1))))))

(define-command (kill-word n)
  "Kill text from point to the end of the Nth word."
  (interactive "*p")
  (kill-region (point) (begin (forward-word n) (point))))

(define-command (backward-kill-word n)
  "Kill text from point back to the start of the Nth word."
  (interactive "*p")
  (kill-word (- n)))

(define-command (upcase-word n)
  "Convert the next N words to upper case."
  (interactive "*p")
  (upcase-region (point) (begin (forward-word n) (point))))

(define-command (downcase-word n)
  "Convert the next N words to lower case."
  (interactive "*p")
  (downcase-region (point) (begin (forward-word n) (point))))

(define-command (capitalize-word n)
  "Capitalize the next N words."
  (interactive "*p")
  (capitalize-region (point) (begin (forward-word n) (point))))

;;;; Lines and editing

(define-command (kill-line #!optional arg)
  "Kill the rest of the line.  If only blanks remain, kill the newline too.
With a numeric prefix ARG, kill that many whole lines."
  (interactive "*P")
  (kill-region (point)
               (begin
                 (cond (arg (forward-line (prefix-numeric-value arg)))
                       ((eobp) (signal 'end-of-buffer))
                       ((looking-at "[ \t]*$") (forward-line 1))
                       (else (end-of-line)))
                 (point))))

(define-command (newline #!optional n)
  "Insert N newlines.  In Scheme buffers, indent the new line."
  (interactive "*p")
  (dotimes (_ (or n 1)) (insert "\n"))
  (when (lisp-buffer?) (lisp-indent-line)))

(define-command (open-line n)
  "Insert N newlines after point without moving point."
  (interactive "*p")
  (dotimes (_ n) (insert "\n"))
  (backward-char n))

(define-command (delete-backward-char n)
  "Delete the active region, or the N characters before point.
Between an empty pair of brackets or quotes, delete both."
  (interactive "*p")
  (cond ((region-active?) (delete-region (region-beginning) (region-end)))
        ((and (= n 1) (electric-pair-delete)) #t)
        (else (delete-char (- n)))))

(define-command (delete-forward-char n)
  "Delete the active region, or the N characters after point."
  (interactive "*p")
  (if (region-active?)
      (delete-region (region-beginning) (region-end))
      (delete-char n)))

(define-command (transpose-chars n)
  "Swap the characters around point, then move forward.  At the end
of a line, swap the two characters before point."
  (interactive "*p")
  (when (eolp) (backward-char 1))
  (let ((c (char-before)))
    (delete-char -1)
    (forward-char 1)
    (insert c)))

(define-command (back-to-indentation)
  "Move point to the first non-blank character on this line."
  (interactive "^")
  (beginning-of-line)
  (skip-chars-forward " \t"))

(define-command (delete-horizontal-space)
  "Delete all spaces and tabs around point."
  (interactive "*")
  (skip-chars-backward " \t")
  (delete-region (point) (begin (skip-chars-forward " \t") (point))))

(define-command (just-one-space)
  "Replace the spaces and tabs around point with a single space."
  (interactive "*")
  (delete-horizontal-space)
  (insert " "))

(define-command (zap-to-char n char)
  "Kill up to and including the Nth next occurrence of CHAR."
  (interactive "*p\ncZap to char: ")
  (kill-region (point)
               (begin (search-forward (char->string char) #f #f n)
                      (point))))

;;;; Comment syntax per mode

(define comment-syntaxes '()
  "Each mode's comment syntax, newest first: (MODE LINE BLOCK-START BLOCK-END), #f where the mode has none.")

(define (set-comment-syntax! mode line . block)
  "Declare MODE's comments: LINE starts a line comment (\";;\", \"#\"), and BLOCK, when given, is the two
strings that open and close a block comment (\"/*\" \"*/\"). LINE is #f for a mode with block comments only.
Every string must be non-empty. A mode with no declaration of its own takes the nearest one of the modes it
derives from."
  (unless (or line (pair? block))
    (error "set-comment-syntax!: neither a line comment nor both block delimiters for" mode))
  (unless (or (not line) (comment--delimiter? line))
    (error "set-comment-syntax!: the line comment is neither #f nor a non-empty string for" mode line))
  (unless (or (null? block)
              (and (= (length block) 2) (comment--delimiter? (car block)) (comment--delimiter? (cadr block))))
    (error "set-comment-syntax!: a block comment needs two non-empty strings for" mode block))
  (let ((open (and (pair? block) (car block)))
        (close (and (pair? block) (cadr block))))
    (set! comment-syntaxes (cons (list mode line open close) comment-syntaxes))))

(define (comment--delimiter? s)
  "Whether S can delimit a comment: a non-empty string."
  (and (string? s) (> (string-length s) 0)))

(define (comment-syntax)
  "The current buffer's comment syntax, (LINE BLOCK-START BLOCK-END): its major mode's, else the nearest
mode's it derives from, else fundamental-mode's."
  (let loop ((modes (derived-mode-all-parents (major-mode))))
    (cond ((null? modes) (cdr (assq 'fundamental-mode comment-syntaxes)))
          ((assq (car modes) comment-syntaxes) => cdr)
          (else (loop (cdr modes))))))

(define (comment-delimiters)
  "The strings the comment commands put around a line, (OPEN . CLOSE): the line comment's start and \"\",
or a block comment's two delimiters in a mode with no line comment."
  (let ((s (comment-syntax)))
    (if (car s) (cons (car s) "") (cons (cadr s) (caddr s)))))

(define (comment--strip-close close)
  "Delete CLOSE, and one space before it, from the end of the current line when the line ends with it."
  (let* ((eol (line-end-position))
         (text (buffer-substring (line-beginning-position) eol))
         (n (string-length close)))
    (when (and (> n 0) (string-suffix? close text))
      (delete-region (- eol n (if (string-suffix? (string-append " " close) text) 1 0)) eol))))

(define (comment--opener-re open)
  "A regexp for OPEN: any run of its character when OPEN is one character repeated, else OPEN itself."
  (let ((c (char->string (string-ref open 0))))
    (if (string=? open (make-string (string-length open) (string-ref open 0)))
        (string-append (regexp-quote c) "+")
        (regexp-quote open))))

(set-comment-syntax! 'fundamental-mode "#")
(set-comment-syntax! 'scheme-mode ";;")
(set-comment-syntax! 'scheme-interaction-mode ";;")
(set-comment-syntax! 'org-mode "#")

(define-command (comment-line n)
  "Toggle a comment, in the mode's comment syntax, on the current line or on each line of the region."
  (interactive "*p")
  (let* ((count (if (region-active?) (count-lines (region-beginning) (region-end)) n))
         (start (if (region-active?) (region-beginning) (point)))
         (delims (comment-delimiters))
         (open (car delims))
         (close (cdr delims))
         ;; An opener of one repeated character (;; # //) matches any run of it: ;;; Header and ; x uncomment.
         (open-re (string-append "\\([ \t]*\\)" (comment--opener-re open) " ?")))
    (save-excursion
      (goto-char start)
      (dotimes (_ count)
        (beginning-of-line)
        ;; As gc: a line that opens a block comment but does not close it is not commented.
        (if (and (string-suffix? close (buffer-substring (point) (line-end-position)))
                 (looking-at open-re))
            (begin (replace-match "\\1") (comment--strip-close close))
            (begin (back-to-indentation)
                   (insert open " ")
                   (unless (string=? close "") (end-of-line) (insert " " close))))
        (forward-line 1)))))

(define-command (delete-trailing-whitespace)
  "Delete spaces and tabs at the end of every line."
  (interactive "*")
  (save-excursion
    (goto-char (point-min))
    (while (re-search-forward "[ \t]+$" #f #t)
      (replace-match ""))))

(define-command (replace-string from to)
  "Replace every FROM after point with TO."
  (interactive "*sReplace string: \nsReplace with: ")
  (let ((n 0))
    (save-excursion
      (while (search-forward from #f #t)
        (replace-match to)
        (inc! n)))
    (message "Replaced ~a occurrence~a" n (if (= n 1) "" "s"))))

;;;; Moving around

(define-command (beginning-of-buffer)
  "Move point to the start of the buffer; leave the mark where it was."
  (interactive "^")
  (push-mark)
  (goto-char (point-min)))

(define-command (end-of-buffer)
  "Move point to the end of the buffer; leave the mark where it was."
  (interactive "^")
  (push-mark)
  (goto-char (point-max)))

(define-command (mark-whole-buffer)
  "Put point at the start and the mark at the end of the buffer."
  (interactive)
  (push-mark (point-max) #t #t)
  (goto-char (point-min)))

(define-command (goto-line line)
  "Move point to the start of LINE."
  (interactive "nGoto line: ")
  (goto-char (point-min))
  (forward-line (- line 1)))

(define-command (kill-sexp n)
  "Kill the N balanced expressions after point."
  (interactive "*p")
  (kill-region (point) (begin (forward-sexp n) (point))))

;;;; The minibuffer

(define-command (kill-whole-input)
  "Delete everything typed in the minibuffer (C-u)."
  (interactive "*")
  (delete-region (point-min) (point-max)))

;;;; Information

(define-command (what-cursor-position)
  "Describe the character after point and where point is."
  (interactive)
  (let ((c (char-after)))
    (message "Char: ~a point=~a of ~a (~a%) column=~a"
             (if c (format "~s (~a, #x~a)" c (char->integer c) (number->string (char->integer c) 16)) "end of buffer")
             (point) (- (point-max) 1)
             (if (= (point-max) 1) 0 (quotient (* 100 (- (point) 1)) (- (point-max) 1)))
             (current-column))))

(define-command (count-words-region start end)
  "Count lines, words and characters in the region."
  (interactive "r")
  (let ((words 0))
    (save-excursion
      (goto-char start)
      (while (< (point) end)
        (forward-word 1)
        (when (<= (point) end) (inc! words))))
    (let ((lines (count-lines start end)) (chars (- end start)))
      (message "Region has ~a line~a, ~a word~a, and ~a character~a"
               lines (if (= lines 1) "" "s") words (if (= words 1) "" "s") chars (if (= chars 1) "" "s")))))

(define-command (insert-date)
  "Insert today's date as YYYY-MM-DD."
  (interactive "*")
  (insert (format-time-string "%F")))

;;;; Key bindings

(for-each
 (lambda (binding) (global-set-key (car binding) (cdr binding)))
 '(("C-f" . forward-char)            ("C-b" . backward-char)
   ("<right>" . forward-char)        ("<left>" . backward-char)
   ("C-n" . next-line)               ("C-p" . previous-line)
   ("<down>" . next-line)            ("<up>" . previous-line)
   ("C-a" . beginning-of-line)       ("C-e" . end-of-line)
   ("<home>" . beginning-of-line)    ("<end>" . end-of-line)
   ("M-f" . forward-word)            ("M-b" . backward-word)
   ("M-m" . back-to-indentation)
   ("M-<" . beginning-of-buffer)     ("M->" . end-of-buffer)
   ("C-v" . scroll-up-command)       ("M-v" . scroll-down-command)
   ("<next>" . scroll-up-command)    ("<prior>" . scroll-down-command)
   ("C-l" . recenter-top-bottom)
   ("M-g g" . goto-line)             ("M-g M-g" . goto-line)
   ("RET" . newline)                 ("C-j" . newline)
   ("TAB" . indent-for-tab-command)  ("C-o" . open-line)
   ("DEL" . delete-backward-char)    ("C-d" . delete-forward-char)
   ("<deletechar>" . delete-forward-char)
   ("C-k" . kill-line)               ("M-d" . kill-word)
   ("M-DEL" . backward-kill-word)    ("C-DEL" . backward-kill-word)
   ("C-w" . kill-region)             ("C-x C-k" . kill-region)
   ("M-w" . kill-ring-save)
   ("C-y" . yank)                    ("M-y" . yank-pop)
   ("C-SPC" . set-mark-command)      ("C-@" . set-mark-command)
   ("C-x C-x" . exchange-point-and-mark)
   ("C-x h" . mark-whole-buffer)
   ("C-t" . transpose-chars)         ("M-z" . zap-to-char)
   ("M-u" . upcase-word)             ("M-l" . downcase-word)
   ("M-c" . capitalize-word)
   ("M-\\" . delete-horizontal-space) ("M-SPC" . just-one-space)
   ("M-;" . comment-line)            ("C-x C-;" . comment-line)
   ("C-/" . undo)                    ("C-_" . undo)
   ("C-x u" . undo)                  ("C-?" . undo-redo)
   ("C-g" . keyboard-quit)           ("C-u" . universal-argument)
   ("C-s" . isearch-forward)         ("C-r" . isearch-backward)
   ("M-%" . replace-string)
   ("M-!" . shell-command)           ("M-&" . async-shell-command)
   ("M-|" . shell-command-on-region)
   ("M-x" . execute-extended-command)
   ("M-:" . eval-expression)         ("C-x C-e" . eval-last-sexp)
   ("C-M-f" . forward-sexp)          ("C-M-b" . backward-sexp)
   ("C-M-u" . backward-up-list)      ("C-M-k" . kill-sexp)
   ("C-M-\\" . indent-region)
   ("C-x b" . consult-buffer)        ("C-x k" . kill-buffer)
   ("M-s l" . consult-line)          ("M-s i" . consult-imenu)
   ("M-g i" . consult-imenu)         ("M-g r" . consult-recent-file)
   ("C-x C-b" . list-buffers)
   ("C-x C-f" . find-file)           ("C-x C-s" . save-buffer)
   ("C-x d" . dired)                 ("C-x C-j" . dired-jump)
   ("C-x C-w" . write-file)          ("C-x C-q" . read-only-mode)
   ("C-x =" . what-cursor-position)  ("M-=" . count-words-region)
   ("C-h k" . describe-key)          ("C-h c" . describe-key-briefly)
   ("C-h f" . describe-function)     ("C-h v" . describe-variable)
   ("C-h b" . describe-bindings)     ("C-h w" . where-is)
   ("C-h e" . view-messages)
   ("C-x C-c" . save-buffers-kill-terminal)
   ("C-x 2" . split-window-below)     ("C-x 3" . split-window-right)
   ("C-x 0" . delete-window)          ("C-x 1" . delete-other-windows)
   ("C-x o" . other-window)           ("M-o" . other-window)
   ("C-c <left>" . winner-undo)       ("C-c <right>" . winner-redo)
   ("C-c d" . insert-date)))

;; Scheme buffers
(define-key scheme-mode-map "C-M-x" 'eval-defun)
(define-key scheme-mode-map "C-c C-b" 'eval-buffer)
(define-key scheme-interaction-mode-map "C-j" 'eval-print-last-sexp)

;; Help, buffer list and other read-only buffers
(define-key special-mode-map "q" 'quit-window)
(define-key special-mode-map "n" 'next-line)
(define-key special-mode-map "p" 'previous-line)
(define-key special-mode-map "SPC" 'scroll-up-command)

;; Commit messages (src/vc.ts opens the buffer): C-c C-c gives the message, C-c C-k aborts
(define-derived-mode vc-message-mode text-mode "Message"
  "Major mode for writing a commit message: the summary line, the part of it past
vc-message-summary-max-length and a second line that is not blank are shown, and comment lines are left out."
  #f)
(define-key vc-message-mode-map "C-c C-c" 'vc-message-finish)
(define-key vc-message-mode-map "C-c C-k" 'vc-message-abort)

;; A rebase's todo (src/vc-git.ts opens it for r i): a plain text buffer; C-c C-c hands it back to git, C-c C-k
;; aborts the rebase, M-p and M-n move the step at point (magit's keys)
(define-derived-mode git-rebase-todo-mode text-mode "Rebase"
  "Major mode for a rebase's todo, which git waits for: each line a step, in order.  C-c C-c rebases as it says,
C-c C-k aborts the rebase."
  #f)
(define-key git-rebase-todo-mode-map "C-c C-c" 'git-rebase-todo-finish)
(define-key git-rebase-todo-mode-map "C-c C-k" 'git-rebase-todo-abort)
(define-key git-rebase-todo-mode-map "M-p" 'git-rebase-todo-move-up)
(define-key git-rebase-todo-mode-map "M-n" 'git-rebase-todo-move-down)

;; Conflict markers (src/vc.ts turns vc-conflict-mode on in a visited file that holds one), smerge's keys:
;; C-c ^ n and C-c ^ p go to the next and the previous conflict, C-c ^ u, C-c ^ l and C-c ^ a keep ours, theirs, both
(define-key vc-conflict-mode-map "C-c ^ n" 'vc-conflict-next)
(define-key vc-conflict-mode-map "C-c ^ p" 'vc-conflict-previous)
(define-key vc-conflict-mode-map "C-c ^ u" 'vc-conflict-keep-ours)
(define-key vc-conflict-mode-map "C-c ^ l" 'vc-conflict-keep-theirs)
(define-key vc-conflict-mode-map "C-c ^ a" 'vc-conflict-keep-both)

;; *grep* (src/compile.ts), out of Evil and in Emacs state: C-c C-p makes it editable once its grep has ended;
;; then C-c C-c or C-x C-s write its rows, C-c C-k gives them up
(define-key grep-mode-map "C-c C-p" 'grep-change-to-grep-edit-mode)
(define-key grep-edit-mode-map "C-c C-c" 'grep-edit-finish)
(define-key grep-edit-mode-map "C-x C-s" 'grep-edit-finish)
(define-key grep-edit-mode-map "C-c C-k" 'grep-edit-abort)

;; The minibuffer
(define-key minibuffer-local-map "RET" 'exit-minibuffer)
(define-key minibuffer-local-map "C-j" 'exit-minibuffer)
(define-key minibuffer-local-map "TAB" 'minibuffer-complete)
(define-key minibuffer-local-map "C-g" 'abort-minibuffers)
(define-key minibuffer-local-map "ESC" 'abort-minibuffers)
(define-key minibuffer-local-map "M-RET" 'exit-minibuffer-input)
(define-key minibuffer-local-map "M-p" 'previous-history-element)
(define-key minibuffer-local-map "M-n" 'next-history-element)
(define-key minibuffer-local-map "C-n" 'minibuffer-next)
(define-key minibuffer-local-map "C-p" 'minibuffer-previous)
(define-key minibuffer-local-map "C-j" 'minibuffer-next)
(define-key minibuffer-local-map "C-k" 'minibuffer-previous)
(define-key minibuffer-local-map "<down>" 'minibuffer-next)
(define-key minibuffer-local-map "<up>" 'minibuffer-previous)
(define-key minibuffer-local-map "M-<" 'minibuffer-first)
(define-key minibuffer-local-map "M->" 'minibuffer-last)
(define-key minibuffer-local-map "C-v" 'minibuffer-scroll-down)
(define-key minibuffer-local-map "M-v" 'minibuffer-scroll-up)
(define-key minibuffer-local-map "<next>" 'minibuffer-scroll-down)
(define-key minibuffer-local-map "<prior>" 'minibuffer-scroll-up)
(define-key minibuffer-local-map "C-w" 'backward-kill-word)
(define-key minibuffer-local-map "C-u" 'kill-whole-input)


;;; --- image log (E2) ---

;; The image log (spec 4.4): a definitional form evaluated in the server image is logged with a
;; generation and evaluated by every frame runtime in order, so one image spans many runtimes and
;; survives restarts.  The primitives %image-server?, %declare-definitional, %share-variable and
;; %image-command exist in the server image only (server/image.mts); a frame has none of them, which
;; is how a form learns where it runs.  The commands below run in the server image.

(define (image-server?)
  "#t in the server image (edwind), #f in a frame runtime."
  (if (bound? '%image-server?) (%image-server?) (not (selected-frame))))

(define (declare-definitional head)
  "Make forms whose head is the symbol HEAD definitional (R4.14): logged and replicated like define."
  (when (image-server?) (%declare-definitional head))
  head)

(define-syntax on-server
  (syntax-rules ()
    ((_ body ...) (if (image-server?) (begin body ...) #f))))

(define-syntax on-frames
  (syntax-rules ()
    ((_ body ...) (if (image-server?) #f (begin body ...)))))

(define-syntax defvar-shared
  (syntax-rules ()
    ((_ name init) (defvar-shared name init #f))
    ((_ name init doc)
     (begin (define name init)
            (when (image-server?) (%share-variable 'name doc))
            'name))))

(define (image-result-field r key)
  "The value under the symbol KEY in the alist R an image command returned, or #f."
  (let ((p (and (pair? r) (assq key r)))) (and p (cdr p))))

(define-command (image-log)
  "Show the image log in the read-only buffer *image-log*: every entry with its
generation, time and origin, newest last."
  (interactive) (:where 'server)
  (%image-command "image-log")
  (message "Image log: see the buffer *image-log*"))

(define-command (image-compact)
  "Drop image-log entries superseded by a later definition of the same name.
The image epoch changes, so every frame restarts its runtime."
  (interactive) (:where 'server)
  (let ((r (%image-command "image-compact")))
    (message "Image compacted: ~a dropped, ~a kept" (image-result-field r 'dropped) (image-result-field r 'kept))))

(define-command (image-reset confirm)
  "Move the image log aside as image.<time>.jsonl and start fresh at generation 0.
Every frame restarts its runtime.  CONFIRM must be the string yes."
  (interactive "sReset the image log (the old log is kept aside)? Type yes: ") (:where 'server)
  (if (equal? confirm "yes")
      (let ((r (%image-command "image-reset" #t)))
        (message "Image reset; the old log is ~a" (image-result-field r 'archived)))
      (message "Image reset cancelled")))

(define-command (image-save-to-init confirm)
  "Append the live image-log entries to init.scm in the config directory, then
reset the log.  CONFIRM must be the string yes."
  (interactive "sSave the image log to init.scm and reset it? Type yes: ") (:where 'server)
  (if (equal? confirm "yes")
      (let ((r (%image-command "image-save-to-init" #t)))
        (message "~a entries saved to ~a; image reset" (image-result-field r 'saved) (image-result-field r 'file)))
      (message "Image save cancelled")))

(define-command (image-problems)
  "List the image-log entries that failed at replay (R4.19) with their errors."
  (interactive) (:where 'server)
  (let ((problems (%image-command "image-problems")))
    (if (null? problems)
        (message "Every image entry replayed")
        (begin
          (for-each (lambda (p)
                      (message "#~a ~a: ~a" (image-result-field p 'gen) (image-result-field p 'origin) (image-result-field p 'error)))
                    problems)
          (message "~a image entries failed at replay; see *Messages*" (length problems))))))

(define-command (image-revert-entry gen)
  "Remove the image-log entry with generation GEN; every frame rebuilds its runtime
without it.  The server image keeps the definition until its next start."
  (interactive "nRevert image entry (generation): ") (:where 'server)
  (let ((r (%image-command "image-revert-entry" gen)))
    (message "Image entry ~a reverted: ~a" gen (image-result-field r 'form))))

;; Generations: copies of the image log to step back through (server/image.mts).  One is made at every
;; start that replayed cleanly, before compaction, revert, reset and rollback, and by image-checkpoint.

(define-command (image-checkpoint label)
  "Copy the image log as it is now into a new generation, named LABEL (may be
empty).  image-rollback returns to it later."
  (interactive "sCheckpoint label (empty for none): ") (:where 'server)
  (let ((r (%image-command "image-checkpoint" (if (and (string? label) (> (string-length label) 0)) label #f))))
    (message "Image generation ~a: ~a entries" (image-result-field r 'id) (image-result-field r 'entries))))

(define (image-generations-text)
  "The generations as image-generations lists them, newest first."
  (let ((gens (reverse (%image-command "image-generations"))))
    (if (null? gens)
        "No image generation yet.  M-x image-checkpoint makes one.\n"
        (string-append
         "Image generations, newest first (M-x image-rollback ID returns to one):\n\n"
         (string-join
          (map (lambda (g)
                 (format "~a  ~a entries, up to gen ~a  ~a  ~a~a"
                         (image-result-field g 'id) (image-result-field g 'entries) (image-result-field g 'gen)
                         (image-result-field g 'reason) (image-result-field g 'origin)
                         (let ((l (image-result-field g 'label))) (if (string? l) (string-append "  \"" l "\"") ""))))
               gens)
          "\n")
         "\n"))))

(define-command (image-generations)
  "List the image generations in the buffer *image-generations*."
  (interactive) (:where 'server)
  (%show-special "*image-generations*" (image-generations-text)))

(define-command (image-rollback id confirm)
  "Replace the image log by generation ID (the current log is kept as a new
generation first) and restart edwind, so the server image and every frame
rebuild from it.  CONFIRM must be the string yes."
  (interactive "nRoll the image back to generation: \nsRoll back and restart edwind? Type yes: ") (:where 'server)
  (if (equal? confirm "yes")
      (let ((r (%image-command "image-rollback" id #t #t)))
        (message "Image rolled back to generation ~a; edwind restarts" (image-result-field r 'id)))
      (message "Image rollback cancelled")))

(define-command (image-restart confirm)
  "Restart edwind: the server image is rebuilt from the shipped Scheme, init.scm
and the image log; unsaved buffers survive in the journals.  Leaves safe mode.
CONFIRM must be the string yes."
  (interactive "sRestart edwind? Type yes: ") (:where 'server)
  (if (equal? confirm "yes")
      (begin (%image-command "image-restart" #t) (message "edwind restarts"))
      (message "Restart cancelled")))

;;; emacs.scm ends here
