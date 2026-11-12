;;; models.scm --- gptel in the server image: backends, requests and streaming (spec §12.3)  -*- scheme -*-
;;
;; Loaded by server/models.mts into the server image only. The primitives it wraps are server-only
;; (R4.49): credential, http-request, %make-backend, %model-request, %model-stream, %model-usage.
;;
;; Backends are objects (R12.1). The module defines `anthropic` from edit.json `models` (R12.3); init.scm may
;; add more and change gptel-backend, after this file has loaded (it provides the feature `models`):
;;
;;   (gptel-make-openai "local" :host "localhost:11434" :protocol "http"
;;     :models '("qwen3:8b") :tiers '((default . "qwen3:8b")))
;;   (gptel-make-anthropic "mine" :key (credential "anthropic-api-key") :models '("claude-opus-5-5"))
;;   (set! gptel-backend "local")
;;
;; Keys are never typed here (R12.2): :key takes only a (credential NAME) handle, which prints as
;; #<credential NAME> and which only http-request can turn into a header, on the backend's own origin.
;;
;; gptel-request sends a prompt and streams the answer into a buffer or to a callback on a background thread
;; attributed to the agent gptel:<backend> (R12.9), so every frame sees it stream and undo-writer undoes it.
;; The commands on top of it (gptel-send, gptel-abort, model-usage) are in gptel.scm, which frames load too.

(define (gptel-make-anthropic name . keys)
  "Define a Messages API backend NAME (the kind the spec names anthropic): :key (a credential handle) :host :protocol :endpoint :models :tiers :headers :stream."
  (apply %make-backend name 'anthropic keys))

(define (gptel-make-openai name . keys)
  "Define an OpenAI-compatible backend NAME: :key (a credential handle or #f) :host :protocol :endpoint :url :models :tiers :headers :stream."
  (apply %make-backend name 'openai keys))

(define (gptel-backends)
  "Names of the defined backends."
  (%backends))

(define (gptel-backend-info . backend)
  "An alist describing BACKEND (default the current one): name kind url origin credential models tiers usable."
  (%backend-info (if (pair? backend) (car backend) (%current-backend))))

(define (gptel--plist-get keys key . default)
  (let loop ((k keys))
    (cond ((or (null? k) (null? (cdr k))) (if (pair? default) (car default) #f))
          ((eq? (car k) key) (cadr k))
          (else (loop (cddr k))))))

(define (gptel--request-alist prompt keys)
  (let ((alist '()))
    (define (put! name value) (if value (set! alist (cons (cons name value) alist))))
    (if (string? prompt) (put! 'prompt prompt) (put! 'messages prompt))
    (put! 'system (gptel--plist-get keys ':system))
    (put! 'model (gptel--plist-get keys ':model))
    (put! 'tier (gptel--plist-get keys ':tier))
    (put! 'max-tokens (gptel--plist-get keys ':max-tokens))
    (put! 'effort (gptel--plist-get keys ':effort))
    (put! 'temperature (gptel--plist-get keys ':temperature))
    (put! 'caller (gptel--plist-get keys ':caller "gptel"))
    alist))

;; The conditions of this layer: credential-origin (R14.4) and cancelled (a request stopped by cancel or
;; gptel-abort), both errors, with the predicates credential-origin? and cancelled?.
(define-condition-type credential-origin error)
(define-condition-type cancelled error)

;; The requests running now, as an alist of buffer -> thread, for gptel-abort.
(define gptel--running '())

(define (gptel--forget! thread)
  (set! gptel--running (filter (lambda (p) (not (eq? (cdr p) thread))) gptel--running)))

(define (gptel-request prompt . keys)
  "Send PROMPT (a string, or a list of ((role . \"user\") (content . \"...\")) alists) to the current backend.
Keys: :backend NAME, :model, :tier, :system, :max-tokens, :effort, :temperature, :caller,
:buffer B and :position P (a marker or position: the answer streams in there), :stream (lambda (text) ...)
(the cumulative text as it arrives), :callback (lambda (result) ...) (the result alist when done, or #f on
error, with the condition as the second argument). Without :buffer, :stream or :callback it waits for the
answer and returns the result alist. Otherwise it returns the background thread."
  (let* ((backend (or (gptel--plist-get keys ':backend) (%current-backend)))
         (request (gptel--request-alist prompt keys))
         (buffer (gptel--plist-get keys ':buffer))
         (position (gptel--plist-get keys ':position))
         (on-stream (gptel--plist-get keys ':stream))
         (callback (gptel--plist-get keys ':callback)))
    (if (and (not buffer) (not on-stream) (not callback))
        (%model-request backend request #f)
        (let* ((buf (and buffer (if (bufferp buffer) buffer (get-buffer-create buffer))))
               (marker (and buf (with-current-buffer buf
                                  (copy-marker (if position (if (number? position) position (marker-position position)) (point)) #t))))
               (inserted 0)
               (thread #f))
          (define (on-text text)
            (when on-stream (on-stream text))
            (when marker
              (with-current-buffer buf
                (save-excursion
                  (goto-char (marker-position marker))
                  (insert (substring text inserted (string-length text)))
                  (set! inserted (string-length text))))))
          (define (finish result condition)
            (gptel--forget! thread)
            (when marker (set-marker marker #f))
            (when callback (callback result condition)))
          (set! thread (%model-stream backend request on-text
                                      (lambda (result) (finish result #f))
                                      (lambda (condition) (finish #f condition))))
          (when buf (set! gptel--running (cons (cons buf thread) gptel--running)))
          thread))))

(define (model-usage-summary . days)
  "The usage of the last DAYS days (default 30) as an alist (R12.14)."
  (%model-usage (if (pair? days) (car days) 30)))

(provide 'models)
;;; models.scm ends here
