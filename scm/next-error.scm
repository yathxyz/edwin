;;; next-error.scm: one error list for the frame, and the keys that step through it.
;;;
;;; Whatever finds places in files (compilation output, a search, a language server's diagnostics) hands the
;;; list over with next-error-set-list!, which replaces the one before it: as in Emacs, next-error goes through
;;; the errors of whatever produced them last. A producer that finds them as it goes (a compilation) names
;;; itself as the list's owner and adds to it with next-error-add-to-list!, which keeps the place stepped to and
;;; adds nothing once another producer's list has replaced its own; one whose errors change (a language server's
;;; diagnostics) replaces its own list with next-error-replace-list!, which keeps the place. M-g n and M-g p (and
;;; :cn, :cp) step through it, visiting each
;;; error's file with point on its line and column; :cc N goes to the Nth. The list lives in this frame only.
;;; Loads after evil.scm (its ex commands) and before init.scm, so init.scm can rebind the keys.

(define next-error--errors (vector)
  "The error list: a vector of (FILE LINE COLUMN MESSAGE UNIT), COLUMN and MESSAGE #f where the producer gave none,
UNIT the unit COLUMN counts in (visit-location's), #f for characters.")
(define next-error--index #f
  "The index in next-error--errors of the error last visited, #f before the first.")
(define next-error--owner #f
  "The OWNER next-error-set-list! was given with the list, #f for none.")

(define (next-error--entry e)
  "E, one of next-error-set-list!'s entries, as (FILE LINE COLUMN MESSAGE UNIT); an error naming E when it is not one."
  (unless (and (list? e) (<= 2 (length e) 5))
    (error "next-error-set-list!: an entry is not (FILE LINE [COLUMN [MESSAGE [UNIT]]]):" e))
  (let* ((file (car e)) (line (cadr e))
         (rest (cddr e))
         (col (if (pair? rest) (car rest) #f))
         (msg (if (and (pair? rest) (pair? (cdr rest))) (cadr rest) #f))
         (unit (if (and (pair? rest) (pair? (cdr rest)) (pair? (cddr rest))) (caddr rest) #f)))
    (unless (and (string? file) (> (string-length file) 0))
      (error "next-error-set-list!: the file is not a non-empty string in" e))
    (unless (and (exact-integer? line) (> line 0))
      (error "next-error-set-list!: the line is not a positive integer in" e))
    (unless (or (not col) (and (exact-integer? col) (> col 0)))
      (error "next-error-set-list!: the column is neither #f nor a positive integer in" e))
    (unless (or (not msg) (string? msg))
      (error "next-error-set-list!: the message is neither #f nor a string in" e))
    (unless (memq unit '(#f screen utf-16 byte))
      (error "next-error-set-list!: the unit is not #f, screen, utf-16 or byte in" e))
    (list file line col msg unit)))

(define (next-error-set-list! entries . owner)
  "Make ENTRIES the error list, each (FILE LINE [COLUMN [MESSAGE [UNIT]]]): LINE and COLUMN count from 1, COLUMN in
characters, or in UNIT: screen (display columns, as gcc counts), utf-16 (as tsc counts) or byte (UTF-8 bytes, as
nix counts). FILE is opened as find-file opens it, so a relative name is taken from the current directory: a
producer whose names are relative to somewhere else expands them first. The next M-g n goes to the first entry.
OWNER, when given and not #f, lets that producer add to the list later (next-error-add-to-list!). All of ENTRIES
is checked before the list is replaced, so a refused list leaves the old one."
  (unless (list? entries)
    (error "next-error-set-list!: not a list:" entries))
  (let ((v (list->vector (map next-error--entry entries))))
    (set! next-error--errors v)
    (set! next-error--index #f)
    (set! next-error--owner (and (pair? owner) (car owner)))
    (vector-length v)))

(define (next-error-add-to-list! owner entries)
  "Add ENTRIES (as next-error-set-list! takes them) to the end of the error list when it is still the one OWNER
set (equal?), keeping the error last visited; gives the list's new length, or #f, adding nothing, when the list
is another's. All of ENTRIES is checked before any is added."
  (unless (list? entries)
    (error "next-error-add-to-list!: not a list:" entries))
  (let ((new (list->vector (map next-error--entry entries))))
    (cond ((not (and owner (equal? owner next-error--owner))) #f)
          (else (unless (= (vector-length new) 0)
                  (set! next-error--errors (vector-append next-error--errors new)))
                (vector-length next-error--errors)))))

(define (next-error--place-in v e)
  "The index in V, a vector of entries grouped by file and ordered by line and column in each, of the last entry of
E's file at or before E's line and column; when that file has entries only after it, the index before its first;
#f when V has none of E's file."
  (let ((at-or-before? (lambda (x)
                         (or (< (cadr x) (cadr e))
                             (and (= (cadr x) (cadr e)) (<= (or (caddr x) 0) (or (caddr e) 0)))))))
    (let loop ((i 0) (first #f) (last #f))
      (cond ((= i (vector-length v)) (if last last (and first (- first 1))))
            ((not (string=? (car (vector-ref v i)) (car e))) (loop (+ i 1) first last))
            ((at-or-before? (vector-ref v i)) (loop (+ i 1) (or first i) i))
            (else (loop (+ i 1) (or first i) last))))))

(define (next-error-replace-list! owner entries)
  "Replace the error list with ENTRIES (as next-error-set-list! takes them, grouped by file and ordered by line and
column in each) when it is still the one OWNER set (equal?): a producer whose errors change (a language server's
diagnostics) keeps its list up to date this way. The place is kept: the next M-g n goes to the first entry of the
error last visited's file past its line and column (an entry at the same place counts as visited), or from the
first entry when that file has none. Gives the list's new length, or #f, replacing nothing, when the list is
another's. All of ENTRIES is checked first."
  (unless (list? entries)
    (error "next-error-replace-list!: not a list:" entries))
  (let ((new (list->vector (map next-error--entry entries))))
    (cond ((not (and owner (equal? owner next-error--owner))) #f)
          (else (let ((i next-error--index) (old next-error--errors))
                  (set! next-error--errors new)
                  (set! next-error--index
                        (and i (< i (vector-length old))
                             (let ((k (next-error--place-in new (vector-ref old i))))
                               (and k (>= k 0) k)))))
                (vector-length new)))))

(define (next-error--go i)
  "Visit error I (from 0) of the list and show its message, leaving point's place in the jump list (C-o comes back
in that buffer). It becomes the current error even when its file is gone, so the next step goes past it."
  (let* ((e (vector-ref next-error--errors i))
         (file (car e)) (line (cadr e)) (col (caddr e)) (msg (cadddr e)) (unit (list-ref e 4)))
    (set! next-error--index i)
    ;; A note edwind opens is not asked (location-missing? gives #f): a gone one opens empty, as find-file opens it.
    (when (location-missing? file)
      (user-error "(~a of ~a) ~a: no such file" (+ i 1) (vector-length next-error--errors) file))
    ;; Recorded here, not by the evil-jump property: an ex command runs inside evil-ex, which has none.
    (evil-set-jump)
    (message "(~a of ~a) ~a" (+ i 1) (vector-length next-error--errors)
             (or msg (string-append file ":" (number->string line))))
    ;; A promise when the visit waits for edwind; the command loop waits on it.
    (visit-location file line col unit)))

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
