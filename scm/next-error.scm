;;; next-error.scm: one error list for the frame, and the keys that step through it.
;;;
;;; Whatever finds places in files (compilation output, a search, a language server's diagnostics) hands the
;;; list over with next-error-set-list!, which replaces the one before it: as in Emacs, next-error goes through
;;; the errors of whatever produced them last. M-g n and M-g p (and :cn, :cp) step through it, visiting each
;;; error's file with point on its line and column; :cc N goes to the Nth. The list lives in this frame only.
;;; Loads after evil.scm (its ex commands) and before init.scm, so init.scm can rebind the keys.

(define next-error--errors (vector)
  "The error list: a vector of (FILE LINE COLUMN MESSAGE), COLUMN and MESSAGE #f where the producer gave none.")
(define next-error--index #f
  "The index in next-error--errors of the error last visited, #f before the first.")

(define (next-error--entry e)
  "E, one of next-error-set-list!'s entries, as (FILE LINE COLUMN MESSAGE); an error naming E when it is not one."
  (unless (and (list? e) (<= 2 (length e) 4))
    (error "next-error-set-list!: an entry is not (FILE LINE [COLUMN [MESSAGE]]):" e))
  (let ((file (car e)) (line (cadr e))
        (col (if (pair? (cddr e)) (caddr e) #f))
        (msg (if (and (pair? (cddr e)) (pair? (cdddr e))) (cadddr e) #f)))
    (unless (and (string? file) (> (string-length file) 0))
      (error "next-error-set-list!: the file is not a non-empty string in" e))
    (unless (and (exact-integer? line) (> line 0))
      (error "next-error-set-list!: the line is not a positive integer in" e))
    (unless (or (not col) (and (exact-integer? col) (> col 0)))
      (error "next-error-set-list!: the column is neither #f nor a positive integer in" e))
    (unless (or (not msg) (string? msg))
      (error "next-error-set-list!: the message is neither #f nor a string in" e))
    (list file line col msg)))

(define (next-error-set-list! entries)
  "Make ENTRIES the error list, each (FILE LINE [COLUMN [MESSAGE]]): LINE and COLUMN count from 1, COLUMN in
characters. FILE is opened as find-file opens it, so a relative name is taken from the current directory: a
producer whose names are relative to somewhere else expands them first. The next M-g n goes to the first entry.
All of ENTRIES is checked before the list is replaced, so a refused list leaves the old one."
  (unless (list? entries)
    (error "next-error-set-list!: not a list:" entries))
  (let ((v (list->vector (map next-error--entry entries))))
    (set! next-error--errors v)
    (set! next-error--index #f)
    (vector-length v)))

(define (next-error--go i)
  "Visit error I (from 0) of the list and show its message, leaving point's place in the jump list (C-o comes back
in that buffer). It becomes the current error even when its file is gone, so the next step goes past it."
  (let* ((e (vector-ref next-error--errors i))
         (file (car e)) (line (cadr e)) (col (caddr e)) (msg (cadddr e)))
    (set! next-error--index i)
    ;; A note edwind opens is not asked (location-missing? gives #f): a gone one opens empty, as find-file opens it.
    (when (location-missing? file)
      (user-error "(~a of ~a) ~a: no such file" (+ i 1) (vector-length next-error--errors) file))
    ;; Recorded here, not by the evil-jump property: an ex command runs inside evil-ex, which has none.
    (evil-set-jump)
    (message "(~a of ~a) ~a" (+ i 1) (vector-length next-error--errors)
             (or msg (string-append file ":" (number->string line))))
    ;; A promise when the visit waits for edwind; the command loop waits on it.
    (visit-location file line col)))

(define (next-error--move n)
  "Go N errors on from the current one (back when N is negative); refuse to go past either end of the list."
  (let ((len (vector-length next-error--errors))
        (i (+ (or next-error--index -1) n)))
    (cond ((= len 0) (user-error "No error list"))
          ((>= i len) (user-error "No more errors"))
          ((< i 0) (user-error "No previous error"))
          (else (next-error--go i)))))

(define (next-error--nth n)
  "Go to error N (from 1) of the list."
  (let ((len (vector-length next-error--errors)))
    (cond ((= len 0) (user-error "No error list"))
          ((or (< n 1) (> n len)) (user-error "No error ~a: the list has ~a" n len))
          (else (next-error--go (- n 1))))))

(define-command (next-error n)
  "Visit the next error of the error list, or the Nth next (M-g n); a negative N goes back."
  (interactive "p")
  (next-error--move (or n 1)))

(define-command (previous-error n)
  "Visit the previous error of the error list, or the Nth previous (M-g p)."
  (interactive "p")
  (next-error--move (- (or n 1))))

(define-command (first-error n)
  "Visit the first error of the error list, or error N with a prefix argument."
  (interactive "p")
  (next-error--nth (or n 1)))

;;;; Ex commands: :cn [N], :cp [N] and :cc [N] take the count as an argument

(define (next-error--ex-count arg)
  "The count an ex command was given, ARG (#f for none): #f, or a positive integer; anything else is refused."
  (and arg
       (let* ((s (string-trim arg)) (n (string->number s)))
         (cond ((string-null? s) #f)
               ((and (exact-integer? n) (> n 0)) n)
               (else (user-error "E488: Trailing characters: ~a" s))))))

(evil-define-command (evil-next-error arg)
  "Visit the next error, or the Nth next with :cn N."
  #:no-repeat
  (interactive "<a>")
  (next-error--move (or (next-error--ex-count arg) 1)))

(evil-define-command (evil-previous-error arg)
  "Visit the previous error, or the Nth previous with :cp N."
  #:no-repeat
  (interactive "<a>")
  (next-error--move (- (or (next-error--ex-count arg) 1))))

(evil-define-command (evil-goto-error arg)
  "Visit error N with :cc N; :cc alone visits the current error again, or the first."
  #:no-repeat
  (interactive "<a>")
  (let ((n (next-error--ex-count arg)))
    (next-error--nth (or n (+ (or next-error--index 0) 1)))))

(for-each (lambda (c) (evil-ex-define-cmd (car c) (cdr c)))
          '(("cn[ext]" . evil-next-error) ("cp[revious]" . evil-previous-error) ("cN[ext]" . evil-previous-error)
            ("cc" . evil-goto-error)))

;;;; Keys

(for-each (lambda (k) (global-set-key (car k) (cdr k)))
          '(("M-g n" . next-error) ("M-g M-n" . next-error)
            ("M-g p" . previous-error) ("M-g M-p" . previous-error)))

;; A step by key pulses the line it lands on (an ex command runs inside evil-ex, which does not pulse).
(for-each (lambda (c) (add-hook! 'post-command-pulse c)) '(next-error previous-error first-error))

(provide 'next-error)
