;;; pi.scm --- Edwin's AI: pi agents in chat notes  -*- scheme -*-
;;
;; Loaded by server/agent.mts into the server image, and by frames, which learn the commands (all (:where 'server))
;; and the keys from it. The agent loop is pi-agent-core's, on edwind's model layer (server/models.mts): any
;; backend gptel-backends lists, Claude by default.
;;
;; A chat is a markdown note. `M-x pi` visits pi/NAME.md (NAME is pi-default-session); any markdown buffer is a
;; chat too, its session named after the buffer. The note reads as a conversation:
;;
;;   ## You
;;
;;   Rename the heading in todo.md to "Later".
;;
;;   ## pi
;;
;;   > tool `edit_buffer` {"name": "todo.md", ...}
;;   Done.
;;
;; C-c RET (pi-send) sends the text after the last "## You" heading. While the agent runs, pi-steer gives it
;; more to consider before its next model call. When a tool needs a yes (edit_buffer, eval_scheme), the question
;; is written into the note: C-c RET allows, C-c C-k (pi-abort) denies; C-c C-k otherwise stops the run.
;; pi-model switches the session's backend and tier; the conversation carries over (pi-ai converts it).
;;
;; Tools are Scheme procedures (define-pi-tool); the built-in ones are in pi-tools.scm. A session's messages
;; live in edwind's stateDir, so a restart resumes the conversation; pi-forget drops it.

(define pi-default-session "chat")
(define pi-system-prompt
  "You are pi, an assistant inside Edwin, an Emacs-like editor scripted in Scheme. The user writes in a markdown note. Use the tools to read and change the user's buffers and notes when that helps; prefer small, exact edits. Answer in markdown, briefly.")

;; Tools defined before edwind's agent module is installed (init.scm runs first) wait here; agent.mts defines
;; them once its primitives exist and sets pi--ready. In a frame they only wait: tools run in edwind.
(define pi--ready #f)
(define pi--pending-tools '())

(define (define-pi-tool name description params proc . keys)
  "Define the agent tool NAME (a symbol or string). PARAMS is a list of (name type \"description\"), type one of
string number integer boolean, all required. PROC gets the arguments as an alist and returns a string for the
model. :confirm #t asks in the chat before each call."
  (let ((tool (list name description params proc
                    (let loop ((k keys)) (cond ((or (null? k) (null? (cdr k))) #f) ((eq? (car k) ':confirm) (cadr k)) (else (loop (cddr k))))))))
    (if pi--ready
        (apply %pi-define-tool tool)
        (begin (set! pi--pending-tools (cons tool pi--pending-tools)) name))))

(define (pi--define-pending-tools!)
  (set! pi--ready #t)
  (for-each (lambda (tool) (apply %pi-define-tool tool)) (reverse pi--pending-tools))
  (set! pi--pending-tools '()))

;; ---------- the chat note ----------

(define (pi--session-name buf)
  (let* ((name (buffer-name buf))
         (base (if (string-suffix? ".md" name) (substring name 0 (- (string-length name) 3)) name))
         (clean (list->string (map (lambda (c) (if (or (char-alphabetic? c) (char-numeric? c) (memv c '(#\. #\_ #\-))) c #\-))
                                   (string->list base)))))
    (if (string-null? clean) "chat" (if (> (string-length clean) 64) (substring clean 0 64) clean))))

(define (pi--session buf) (%pi-session (pi--session-name buf) #f #f #f pi-system-prompt))

;; The prompt: the text after the last "## You" line, or the whole note when it has none.
(define (pi--prompt-start)
  (save-excursion
    (goto-char (point-max))
    (if (re-search-backward "^## You[ \t]*$" #f #t)
        (begin (forward-line 1) (point))
        (point-min))))

;; Per buffer: the pending confirmation's mailbox, while a tool waits for a yes.
(define pi--confirming '())
(define (pi--confirm-box buf) (let ((p (assq buf pi--confirming))) (and p (cdr p))))

(define (pi--append buf text)
  (with-current-buffer buf
    (save-excursion (goto-char (point-max)) (insert text))))

(define (pi--json x)
  (cond ((string? x) (call-with-output-string (lambda (p) (write x p))))
        ((and (pair? x) (pair? (car x)) (symbol? (caar x)))
         (string-append "{" (string-join (map (lambda (kv) (string-append (pi--json (symbol->string (car kv))) ": " (pi--json (cdr kv)))) x) ", ") "}"))
        ((null? x) "{}")
        ((eq? x #t) "true") ((eq? x #f) "false")
        (else (call-with-output-string (lambda (p) (display x p))))))

(define (pi--clip s n) (if (> (string-length s) n) (string-append (substring s 0 n) "…") s))

;; The handler of one run: what the agent does shows up at the end of the note, written by the run's thread
;; (the agent pi:<session>), so every frame sees it and undo-writer undoes it.
(define (pi--handler buf)
  (lambda (kind data)
    (case kind
      ((text) (pi--append buf (assq-ref data 'delta "")))
      ((tool-start)
       (pi--append buf (string-append "\n\n> tool `" (assq-ref data 'name "?") "` " (pi--clip (pi--json (assq-ref data 'args '())) 300) "\n\n")))
      ((tool-end)
       (when (assq-ref data 'error #f)
         (pi--append buf (string-append "> → " (pi--clip (assq-ref data 'result "") 300) "\n\n"))))
      ((confirm)
       (let ((box (make-mailbox "pi confirm")))
         (pi--append buf (string-append "\n\n> **Allow** `" (assq-ref data 'name "?") "` " (pi--clip (pi--json (assq-ref data 'args '())) 600)
                                        "? C-c RET allows, C-c C-k denies.\n"))
         (set! pi--confirming (cons (cons buf box) pi--confirming))
         (let ((ok (dynamic-wind (lambda () #f)
                                 (lambda () (mailbox-receive! box))
                                 (lambda () (set! pi--confirming (filter (lambda (p) (not (eq? (car p) buf))) pi--confirming))))))
           (pi--append buf (if ok "> allowed\n\n" "> denied\n\n"))
           ok)))
      ((done)
       (pi--append buf "\n\n## You\n\n")
       (message "pi: ~a answered (~a tokens)" (assq-ref data 'model "?")
                (+ (assq-ref data 'input-tokens 0) (assq-ref data 'output-tokens 0))))
      ((error)
       (pi--append buf (string-append "\n\n> error: " (condition/report-string data) "\n\n## You\n\n"))
       (message "pi: ~a" (condition/report-string data)))
      (else #f))))

;; ---------- commands ----------

(define-command (pi)
  "Visit the chat note pi/NAME.md of the default session (pi-default-session) and go to its end."
  (interactive)
  (find-file (string-append "pi/" pi-default-session ".md"))
  (when (= (point-min) (point-max)) (insert "## You\n\n"))
  (goto-char (point-max)))

(define-command (pi-send)
  "Send the text after the last \"## You\" heading to this note's pi session; the answer streams in below it.
While a tool waits for a yes, allow it. While the agent runs, steer it with the new text."
  (interactive) (:where 'server)
  (let* ((buf (current-buffer)) (box (pi--confirm-box buf)) (s (pi--session buf)))
    (cond (box (mailbox-send! box #t))
          ((%pi-running? s) (user-error "pi: the agent is running (pi-steer adds to it, C-c C-k stops it)"))
          (else
           (let ((prompt (string-trim (buffer-substring (pi--prompt-start) (point-max)))))
             (when (string-null? prompt) (user-error "pi: nothing to send after the last \"## You\""))
             (pi--append buf "\n\n## pi\n\n")
             (%pi-run s prompt (pi--handler buf))
             (message "pi: asking ~a" (assq-ref (%pi-session-info s) 'backend "?")))))))

(define-command (pi-steer text)
  "Give the running agent of this note TEXT to consider before its next model call."
  (interactive "sSteer pi: ") (:where 'server)
  (let ((s (pi--session (current-buffer))))
    (unless (%pi-running? s) (user-error "pi: the agent is not running (C-c RET sends)"))
    (%pi-steer s text)
    (pi--append (current-buffer) (string-append "\n\n> steer: " text "\n\n"))))

(define-command (pi-abort)
  "Deny the tool waiting for a yes, or stop the agent of this note."
  (interactive) (:where 'server)
  (let* ((buf (current-buffer)) (box (pi--confirm-box buf)))
    (cond (box (mailbox-send! box #f))
          ((%pi-abort (pi--session buf)) (message "pi: stopping"))
          (else (message "pi: nothing is running here")))))

(define-command (pi-model backend tier)
  "Switch this note's session to BACKEND and TIER (default, quick, …) for its next run; the conversation carries over."
  (interactive "sBackend (gptel-backends lists them): \nsTier (default): ") (:where 'server)
  (%pi-set-model (pi--session (current-buffer)) backend (if (string-null? tier) "default" tier))
  (message "pi: ~a now uses ~a ~a" (pi--session-name (current-buffer)) backend (if (string-null? tier) "default" tier)))

(define-command (pi-forget)
  "Drop this note's pi session and its saved conversation (the note stays)."
  (interactive) (:where 'server)
  (%pi-forget (pi--session (current-buffer)))
  (message "pi: forgot ~a" (pi--session-name (current-buffer))))

(define-key markdown-mode-map "C-c RET" 'pi-send)
(define-key markdown-mode-map "C-c C-k" 'pi-abort)

(provide 'pi)
;;; pi.scm ends here
