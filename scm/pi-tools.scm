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

(define-pi-tool 'eval_scheme "Evaluate one Edwin Scheme expression in the server image and return what it printed and its value."
  '((code string "One Scheme expression"))
  (lambda (args)
    (let* ((form (read (open-input-string (pi--arg args 'code))))
           (value #f)
           (out (with-output-to-string (lambda () (set! value (eval form (interaction-environment)))))))
      (string-append out (call-with-output-string (lambda (p) (write value p))))))
  ':confirm #t)

(provide 'pi-tools)
;;; pi-tools.scm ends here
