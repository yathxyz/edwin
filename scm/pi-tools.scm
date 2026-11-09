;;; pi-tools.scm --- the built-in tools of pi agents  -*- scheme -*-
;;
;; Loaded by server/agent.mts into the server image only, after the %pi primitives. Each tool runs on the run's
;; thread (the agent pi:<session>), so an edit is that agent's, undoable with undo-writer. A tool returns a string
;; for the model; a Scheme error becomes "Error: …" for the model, not a failed run. init.scm can add tools with
;; define-pi-tool, or replace these by defining the same name again.

(define pi-read-limit 100000)

(define (pi--arg args key) (or (assq-ref args key #f) (user-error (format "pi: the tool needs ~a" key))))

(define (pi--buffer name)
  (or (get-buffer name) (user-error (format "No buffer named ~a (list_buffers lists them)" name))))

(define-pi-tool 'list_buffers "List the open buffers: one name per line, with the file it visits."
  '()
  (lambda (args)
    (string-join (map (lambda (b) (let ((f (buffer-file-name b))) (if f (string-append (buffer-name b) "  " f) (buffer-name b))))
                      (buffer-list))
                 "\n")))

(define-pi-tool 'read_buffer "Read the whole text of an open buffer (cut at 100,000 characters)."
  '((name string "The buffer name, as list_buffers gives it"))
  (lambda (args)
    (with-current-buffer (pi--buffer (pi--arg args 'name))
      (let ((text (buffer-string)))
        (if (> (string-length text) pi-read-limit) (string-append (substring text 0 pi-read-limit) "\n[cut]") text)))))

(define-pi-tool 'edit_buffer "Replace the one occurrence of OLD in a buffer by NEW. OLD must occur exactly once; give enough context to make it unique."
  '((name string "The buffer name")
    (old string "The exact text to replace, occurring once")
    (new string "The replacement text"))
  (lambda (args)
    (let ((old (pi--arg args 'old)) (new (assq-ref args 'new "")))
      (with-current-buffer (pi--buffer (pi--arg args 'name))
        (let ((hits (length (string-search-all old (buffer-string)))))
          (cond ((= hits 0) (user-error "OLD does not occur in the buffer"))
                ((> hits 1) (user-error (format "OLD occurs ~a times; give more context" hits)))
                (else
                 (save-excursion
                   (goto-char (point-min))
                   (let ((end (search-forward old)))
                     (delete-region (- end (string-length old)) end)
                     (insert new)))
                 (format "Replaced ~a characters with ~a." (string-length old) (string-length new))))))))
  ':confirm #t)

(define-pi-tool 'grep_notes "Search every note for a JavaScript regular expression: one match per line as path:line: text (at most 200)."
  '((regexp string "The regular expression"))
  (lambda (args)
    (let* ((hits (notes-grep (pi--arg args 'regexp)))
           (lines (map (lambda (v) (format "~a:~a: ~a" (vector-ref v 0) (vector-ref v 1) (vector-ref v 3))) hits)))
      (cond ((null? lines) "No match.")
            ((> (length lines) 200) (string-append (string-join (list-head lines 200) "\n") (format "\n[~a more]" (- (length lines) 200))))
            (else (string-join lines "\n"))))))

(define-pi-tool 'eval_scheme "Evaluate one Edwin Scheme expression in the server image and return what it printed and its value. Exploratory: a definition made here lives in the server image only, is not sent to frames and is gone at the next restart; image_define keeps one."
  '((code string "One Scheme expression"))
  (lambda (args)
    (let* ((form (read (open-input-string (pi--arg args 'code))))
           (value #f)
           (out (with-output-to-string (lambda () (set! value (eval form (interaction-environment)))))))
      (string-append out (call-with-output-string (lambda (p) (write value p))))))
  ':confirm #t)

;; Working on the Lisp image itself (server/image.mts): look before changing, keep changes in the image log, and
;; checkpoint so a bad change can be rolled back.  image_define and image_rollback ask first.

(define (pi--cut text n) (if (> (string-length text) n) (string-append (substring text 0 n) "...") text))
(define (pi--field r key) (let ((p (and (pair? r) (assq key r)))) (and p (cdr p))))

(define-pi-tool 'apropos "List the commands, procedures, variables and macros of the image whose names match a regular expression."
  '((pattern string "A JavaScript regular expression"))
  (lambda (args) (pi--cut (%apropos-text (pi--arg args 'pattern)) pi-read-limit)))

(define-pi-tool 'describe "Describe a definition: its documentation, where it is defined (a shipped file and line, or the image log), the image entries that define it, and the shipped source around it."
  '((name string "The name, as apropos gives it"))
  (lambda (args)
    (let* ((name (pi--arg args 'name)) (sym (string->symbol name))
           (found (find-definition-location sym))
           (loc (if (and found (car found)) found (or (%edwin-find-source sym) found)))
           (val (and (bound? sym) (eval sym (interaction-environment))))
           (doc (and (procedure? val) (procedure-documentation val)))
           (entries (filter (lambda (e) (string-search-forward (string-append " " name) (pi--field e 'form) 0))
                            (%image-command "image-entries"))))
      (string-append
       name (cond ((not (bound? sym)) " is not bound") ((procedure? val) " is a procedure") (else " is a variable")) "\n"
       (if (string? doc) (string-append doc "\n") "")
       (if (and loc (car loc)) (format "Defined at ~a:~a\n" (car loc) (cadr loc)) "")
       (if (null? entries) ""
           (string-append "Image entries naming it:\n"
                          (string-join (map (lambda (e) (format "#~a ~a: ~a" (pi--field e 'gen) (pi--field e 'origin) (pi--cut (pi--field e 'form) 2000))) entries) "\n")
                          "\n"))
       (if (and loc (car loc) (cadr loc) (string-search-forward "/scm/" (car loc) 0))
           (string-append "Source:\n" (%edwin-source (car loc) (cadr loc) 60))
           "")))))

(define-pi-tool 'read_source "Read lines of Edwin's shipped source (scm/*.scm, src/*.ts, server/*.mts), as describe or find-definition names the file."
  '((file string "The file, as edwin/scm/emacs.scm")
    (line integer "The first line")
    (count integer "How many lines (at most 400)"))
  (lambda (args) (%edwin-source (pi--arg args 'file) (pi--arg args 'line) (assq-ref args 'count 80))))

(define-pi-tool 'image_log "List the image log: the definitions made at run time (by frames, wb, agents) that are replayed at every start, newest last, with their generation and origin."
  '()
  (lambda (args)
    (let ((entries (%image-command "image-entries")))
      (if (null? entries) "The image log is empty."
          (string-join (map (lambda (e) (format "#~a ~a~a: ~a" (pi--field e 'gen) (pi--field e 'origin)
                                                (let ((f (pi--field e 'failed))) (if (string? f) (string-append " FAILED AT REPLAY " f) ""))
                                                (pi--cut (pi--field e 'form) 1000)))
                            entries)
                       "\n")))))

(define-pi-tool 'image_define "Evaluate definitional forms (define, define-command, set!, define-key, add-hook!, ...) in the server image and keep them in the image log: they are replayed at every start and sent to every frame. Checkpoint first for anything risky."
  '((code string "One or more definitional forms"))
  (lambda (args)
    (let* ((code (pi--arg args 'code))
           (checked (%image-record code #t))
           (port (open-input-string code))
           (value #f)
           (out (with-output-to-string
                  (lambda () (let loop ((f (read port)))
                               (unless (eof-object? f) (set! value (eval f (interaction-environment))) (loop (read port)))))))
           (gens (%image-record code)))
      (format "~aLogged as image generation~a ~a. Value: ~s" out (if (= (length gens) 1) "" "s") (string-join (map number->string gens) ", ") value)))
  ':confirm #t)

(define-pi-tool 'image_checkpoint "Copy the image log into a new generation, to roll back to later."
  '((label string "A short label: what is about to change"))
  (lambda (args)
    (let ((r (%image-command "image-checkpoint" (pi--arg args 'label))))
      (format "Generation ~a: ~a entries." (pi--field r 'id) (pi--field r 'entries)))))

(define-pi-tool 'image_generations "List the image generations (copies of the image log), newest first."
  '()
  (lambda (args) (image-generations-text)))

(define-pi-tool 'image_rollback "Replace the image log by a generation (the current log is kept as a new generation first). Frames rebuild at once; the server image keeps its definitions until edwind restarts (M-x image-restart, which the user runs)."
  '((id integer "The generation, as image_generations lists it"))
  (lambda (args)
    (let ((r (%image-command "image-rollback" (pi--arg args 'id) #t #f)))
      (format "Rolled back to generation ~a (~a entries). The log before it is generation ~a. The server keeps its definitions until M-x image-restart."
              (pi--field r 'id) (pi--field r 'entries) (pi--field r 'before))))
  ':confirm #t)

(provide 'pi-tools)
;;; pi-tools.scm ends here
