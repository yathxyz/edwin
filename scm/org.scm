;;; org.scm: Org mode as the desktop init-org.el sets it up: keywords, the note and daily
;;; templates, and the evil-org keys; and the keys of brain's buffers.  The commands live in
;;; org.ts and brain.ts, which load after this file, so the variables are defined here and
;;; leader keys go in init.scm.

;; The task keywords come from the one table of notes-syntax.scm (R10.2), shared with markdown-mode and the
;; notes index: ((sequence "TODO(t)" "NEXT(n)" "WAITING(w@/!)" "HOLD(h@/!)" "SOMEDAY(s)" "|" "DONE(d!)"
;; "CANCELLED(c@/!)")) from the shipped table. notes-set-task-keywords! changes it for both modes.
(require 'notes-syntax)
(define org-todo-keywords (notes-org-todo-keywords))
(define org-ellipsis " [...]")
(define org-modern-star "◉○◈◇✳")
(define org-hide-emphasis-markers #t)
(define org-tags-column -77)

;; New notes (brain-node-find, brain-node-insert) go in the notes root, named by a timestamp and the
;; slug of the title; the dailies go under daily/.  Both directories are relative to the notes root.
;; In a template %? is where point ends up, %U the inactive timestamp, %<...> a strftime format.
(define note-directory "")
(define dailies-directory "daily/")
(define note-capture-templates
      '(("n" "note" plain "%?"
         :target (file+head "%<%Y%m%d%H%M%S>-${slug}.org"
                            "#+title: ${title}\n#+created: %U\n\n"))
        ("c" "concept" plain "* Claim\n%?\n\n* Context\n\n* Links\n"
         :target (file+head "%<%Y%m%d%H%M%S>-${slug}.org"
                            "#+title: ${title}\n#+created: %U\n#+filetags: :concept:\n\n"))
        ("p" "project" plain "* Outcome\n%?\n\n* Notes\n\n* Links\n"
         :target (file+head "%<%Y%m%d%H%M%S>-project-${slug}.org"
                            "#+title: ${title}\n#+created: %U\n#+filetags: :project:\n\n"))
        ("s" "source" plain "* Summary\n%?\n\n* Notes\n\n* Links\n"
         :target (file+head "references/%<%Y%m%d%H%M%S>-${slug}.org"
                            "#+title: ${title}\n#+created: %U\n#+filetags: :source:\n\n"))
        ("m" "markdown note" plain "%?"
         :target (file+head "%<%Y%m%d%H%M%S>-${slug}.md"
                            "---\nid: ${id}\ntitle: ${title}\ncreated: \"%<%Y-%m-%dT%H:%M:%S%z>\"\ntags: []\n---\n\n"))))
(define dailies-capture-templates
      '(("d" "daily" entry "* %<%H:%M> %?"
         :target (file+head "%<%Y-%m-%d>.org" "#+title: %<%Y-%m-%d>\n"))))

;; A task added with brain-task-add (SPC o) goes in this scope of brain.
(define brain-task-scope "work")

;; Agenda and brain buffers are read only and start in Motion state.
(set! evil-motion-state-modes (append evil-motion-state-modes '(brain-agenda-mode brain-mode)))
(define brain-agenda-mode-map (make-sparse-keymap "brain-agenda-mode-map"))
(define brain-mode-map (make-sparse-keymap "brain-mode-map"))
(define markdown-mode-map (make-sparse-keymap "markdown-mode-map"))

;; TAB cycles the subtree at point, S-TAB the whole buffer, as outline folding in Emacs.
;; t stays evil-find-char-to: evil-org's default key themes leave out `todo'; C-c C-t sets the state.
(evil-define-key '(normal motion) 'org-mode
  "TAB" 'org-cycle
  "S-TAB" 'org-global-cycle
  "g j" 'org-forward-heading-same-level
  "g k" 'org-backward-heading-same-level
  "g h" 'outline-up-heading
  "g l" 'org-next-visible-heading
  "M-RET" 'org-meta-return
  "M-h" 'org-promote-subtree
  "M-l" 'org-demote-subtree
  "M-k" 'org-move-subtree-up
  "M-j" 'org-move-subtree-down)
(evil-define-key '(normal visual) 'org-mode
  ">" 'evil-org->
  "<" 'evil-org-<)
(evil-define-key 'insert 'org-mode
  "M-RET" 'org-meta-return
  "M-h" 'org-promote-subtree
  "M-l" 'org-demote-subtree)

(define-key org-mode-map "C-c C-t" 'org-todo-select)
(define-key org-mode-map "C-c C-c" 'org-ctrl-c-ctrl-c)
(define-key org-mode-map "C-c C-l" 'org-insert-link)
(define-key org-mode-map "C-c C-o" 'org-open-at-point)
(define-key org-mode-map "C-c C-s" 'org-schedule)
(define-key org-mode-map "C-c C-d" 'org-deadline)
(define-key org-mode-map "C-c ." 'org-time-stamp)
(define-key org-mode-map "C-c !" 'org-time-stamp-inactive)
(define-key org-mode-map "C-c C-q" 'org-set-tags-command)
(define-key org-mode-map "C-c C-x C-b" 'org-toggle-checkbox)
(define-key org-mode-map "C-c n l" 'brain-backlinks)
(define-key org-mode-map "C-c n i" 'brain-node-insert)
(define-key org-mode-map "C-c C-n" 'org-next-visible-heading)
(define-key org-mode-map "C-c C-p" 'org-previous-visible-heading)
(define-key org-mode-map "C-c C-u" 'outline-up-heading)
(define-key org-mode-map "M-RET" 'org-meta-return)
(define-key org-mode-map "C-RET" 'org-insert-heading)
(define-key org-mode-map "C-S-RET" 'org-insert-todo-heading)
(define-key org-mode-map "M-<left>" 'org-promote-subtree)
(define-key org-mode-map "M-<right>" 'org-demote-subtree)
(define-key org-mode-map "M-<up>" 'org-move-subtree-up)
(define-key org-mode-map "M-<down>" 'org-move-subtree-down)

;; Markdown shares the outline commands: # headings fold and move like stars.
(evil-define-key '(normal motion) 'markdown-mode
  "TAB" 'org-cycle
  "S-TAB" 'org-global-cycle
  "g j" 'org-forward-heading-same-level
  "g k" 'org-backward-heading-same-level
  "g h" 'outline-up-heading
  "g l" 'org-next-visible-heading
  "M-RET" 'org-meta-return)

;; Vim's fold keys fold outlines too, as evil-fold-list makes them do in Org and Markdown buffers.
(for-each (lambda (mode)
            (evil-define-key 'normal mode
              "z a" 'evil-toggle-fold
              "z c" 'evil-close-fold
              "z o" 'evil-open-fold
              "z O" 'evil-open-fold-rec
              "z m" 'evil-close-folds
              "z M" 'evil-close-folds
              "z r" 'evil-open-folds
              "z R" 'evil-open-folds))
          '(org-mode markdown-mode))
(define-key markdown-mode-map "C-c C-o" 'org-open-at-point)
(define-key markdown-mode-map "C-c C-l" 'org-insert-link)
(define-key markdown-mode-map "C-c C-x C-b" 'org-toggle-checkbox)
(define-key markdown-mode-map "C-c n l" 'brain-backlinks)
(define-key markdown-mode-map "C-c n i" 'brain-node-insert)

;; The agenda of brain's tasks: each key changes the task at point, in brain.
;; C-u is the prefix argument here, not a scroll: C-u s and C-u d clear a date.
(evil-define-key 'motion 'brain-agenda-mode
  "C-u" 'universal-argument
  "RET" 'brain-agenda-open
  "t" 'brain-task-state
  "x" 'brain-task-done
  "s" 'brain-task-schedule
  "d" 'brain-task-due
  "p" 'brain-task-priority
  "e" 'brain-task-title
  "m" 'brain-task-move
  "a" 'brain-task-add
  "r" 'brain-agenda-redo
  "g r" 'brain-agenda-redo
  "q" 'brain-agenda-quit)
(evil-define-key 'motion 'brain-mode
  "RET" 'brain-follow
  "q" 'quit-window)

;; markdown-mode (markdown.scm, R10.1-R10.5) builds on these outline keys: it loads here, after Org and
;; before init.scm, so the user's init can change both.
(require 'markdown)

;;; org.scm ends here
