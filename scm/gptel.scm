;;; gptel.scm --- gptel's commands, run in edwind  -*- scheme -*-
;;
;; Loaded by server/models.mts into the server image after models.scm, and by a served frame after its own
;; files (src/sync.ts), which learns the commands from it: all are (:where 'server), so a key bound to
;; gptel-send in a frame runs it in edwind, on edwind's backends and credentials. A frame's own gptel-send
;; (src/ai.ts) needs the artifact runtime or a key kept in the browser, and a served frame has neither (R12.2).
;;
;; gptel-send: the region, or the text before point, is the prompt and the answer streams in after it.
;; gptel-abort stops the request running in the buffer. model-usage sums the last 30 days of usage.jsonl
;; (R12.14).

(define-command (gptel-send)
  "Send the region, or the text before point, to the current backend; the answer streams in after it."
  (interactive) (:where 'server)
  (let* ((buf (current-buffer))
         (start (if (region-active-p) (region-beginning) (point-min)))
         (end (if (region-active-p) (region-end) (point)))
         (prompt (buffer-substring start end)))
    (when (string-null? (string-trim prompt)) (signal 'user-error "gptel: nothing to send"))
    (when (assq buf gptel--running) (signal 'user-error "gptel: a request is already running in this buffer (gptel-abort stops it)"))
    (goto-char end)
    (insert "\n\n")
    (let ((backend (%current-backend)))
      (gptel-request prompt :buffer buf :position (point)
                     :callback (lambda (result condition)
                                 (if condition
                                     (message "gptel: ~a" (condition/report-string condition))
                                     (message "gptel: ~a answered (~a tokens)" (assq-ref result 'model)
                                              (+ (assq-ref result 'input-tokens 0) (assq-ref result 'output-tokens 0))))))
      (message "gptel: asking ~a" (assq-ref (%backend-info backend) 'name)))))

(define-command (gptel-abort)
  "Stop the gptel request running in this buffer."
  (interactive) (:where 'server)
  (let ((p (assq (current-buffer) gptel--running)))
    (if (not p)
        (message "gptel: no request is running here")
        (begin (thread-kill (cdr p)) (gptel--forget! (cdr p)) (message "gptel: aborted")))))

(define-command (model-usage)
  "Show the model usage of the last 30 days (requests, tokens, by model and caller)."
  (interactive) (:where 'server)
  (let* ((u (%model-usage 30))
         (by (lambda (key) (let ((rows (assq-ref u key '())))
                             (string-join (map (lambda (p) (format "~a: ~a requests, ~a in, ~a out"
                                                                   (car p) (assq-ref (cdr p) 'requests 0)
                                                                   (assq-ref (cdr p) 'input-tokens 0) (assq-ref (cdr p) 'output-tokens 0)))
                                               rows)
                                          "; ")))))
    (message "Model usage, ~a days: ~a requests (~a failed), ~a input tokens, ~a output tokens. By model: ~a. By caller: ~a"
             (assq-ref u 'days 30) (assq-ref u 'requests 0) (assq-ref u 'errors 0)
             (assq-ref u 'input-tokens 0) (assq-ref u 'output-tokens 0)
             (by 'by-model) (by 'by-caller))
    u))

(provide 'gptel)
;;; gptel.scm ends here
