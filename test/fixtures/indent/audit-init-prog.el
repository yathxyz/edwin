;;; init-prog.el --- Programming language setup -*- coding: utf-8; lexical-binding: t; -*-
;;
;;; Commentary:
;; Programming language tooling extracted from the main init file.
;;
;;; Code:

(require 'subr-x)
(require 'use-package)

;; Lisp
(use-package lispy
  :hook ((lisp-mode . lispy-mode)
         (emacs-lisp-mode . lispy-mode)
         (ielm-mode . lispy-mode)
         (scheme-mode . lispy-mode)
         (racket-mode . lispy-mode)
         (clojure-mode . lispy-mode)
         (clojurescript-mode . lispy-mode)
         (clojurec-mode . lispy-mode))
  :config
  (setq lispy-close-quotes-at-end-p t))

(with-eval-after-load 'elisp-mode
  (define-key emacs-lisp-mode-map (kbd "C-c i") #'consult-outline))

(use-package lispyville
  :hook (lispy-mode . lispyville-mode)
  :init
  (setq lispyville-key-theme
        '((operators normal) c-w (prettify insert) (atom-movement t)
          slurp/barf-lispy additional additional-insert))
  :config
  (lispyville-set-key-theme)
  (add-hook 'evil-escape-inhibit-functions
            (defun +lispy-inhibit-evil-escape-fn ()
              (and lispy-mode (evil-insert-state-p)))))

;; Rust
(use-package rust-ts-mode
  :mode ("\\.rs\\'" . rust-ts-mode))

(use-package clojure-mode
  :mode (("\\.clj\\'" . clojure-mode)
         ("\\.cljs\\'" . clojurescript-mode)
         ("\\.cljc\\'" . clojurec-mode)
         ("\\.edn\\'" . edn-mode)))

(use-package flycheck-rust
  :defer t
  :commands (flycheck-rust-setup)
  :hook (flycheck-mode . flycheck-rust-setup))

;; Nix
(use-package nix-mode
  :defer t
  :mode "\\.nix\\'")

(defun vile/nixpkgs-build-outpath (nixpkgs-attr)
  "Build nixpkgs attribute and return store path."
  (interactive "fNix file: ")
  (message (format "Fetching %s from <nixpkgs>..." nixpkgs-attr))
  (let* ((cmd (format "nix-build -E 'with import <nixpkgs> {}; %s' --no-out-link"
                      (shell-quote-argument nixpkgs-attr)))
         (output (string-trim (shell-command-to-string cmd))))
    (if (string-match-p "^/nix/store/[a-z0-9]\\{32\\}-" output)
        output
      (error "Build failed: %s" output))))

;; Java
(use-package java-ts-mode
  :mode ("\\.java\\'" . java-ts-mode))

(use-package eglot-java
  :defer t
  :commands (eglot-java-mode
             eglot-java-project-new
             eglot-java-upgrade-lsp-server
             eglot-java-upgrade-junit-jar)
  :config
  (setq eglot-java-eclipse-jdt-cache-directory "~/.cache/eglot-java-eclipse-jdt-cache")
  (setq eglot-java-user-init-opts-fn 'custom-eglot-java-init-opts)
  (defun custom-eglot-java-init-opts (_server _eglot-java-eclipse-jdt)
    '(:settings
      (:java
       (:format
        (:settings
         (:url "https://raw.githubusercontent.com/google/styleguide/gh-pages/eclipse-java-google-style.xml")
         :enabled t))))))

;; GDScript
(use-package gdscript-mode
  :mode ("\\.gd\\'" . gdscript-mode)
  :hook (gdscript-mode . eglot-ensure)
  :custom (gdscript-eglot-version 3))

;; Other languages
(use-package just-mode
  :mode (("/\\(?:\\.\\)?[jJ][uU][sS][tT][fF][iI][lL][eE]\\'" . just-mode)))

(use-package meson-mode
  :mode (("/meson\\(\\.build\\|_options\\.txt\\|\\.options\\)\\'" . meson-mode)))

(use-package nasm-mode
  :mode ("\\.nasm" . nasm-mode))

(use-package nginx-mode
  :mode (("nginx\\.conf\\'" . nginx-mode)
         ("/nginx/.+\\.conf\\'" . nginx-mode)))

(use-package terraform-mode
  :defer t
  :mode ("\\.t\\(f\\(vars\\)?\\|ofu\\)\\'" . terraform-mode))

(use-package typst-ts-mode
  :mode ("\\.typ\\'" . typst-ts-mode))

;; Eglot (built-in LSP)
(use-package eglot
  :preface
  (defvar yath/nixd-known-flake-option-sources
    `((,(directory-file-name
         (file-truename (expand-file-name "~/proj/nix/computer")))
       . ((nixos . "nixosConfigurations.host.options")
          (home-manager . "homeConfigurations.owner.options"))))
    "Known flake roots with extra option sources for `nixd'.")

  (defvar-local yath/eglot--flycheck-was-enabled nil
    "Remember whether `flycheck-mode' was active before Eglot took over.")

  (defun yath/eglot-ensure ()
    "Start Eglot in the current buffer."
    (unless (or (minibufferp)
                (file-remote-p default-directory))
      (eglot-ensure)))

  (defun yath/nixd-flake-root (&optional directory)
    "Return the nearest flake root for DIRECTORY or `default-directory'."
    (let* ((start (file-truename (expand-file-name (or directory default-directory))))
           (root (locate-dominating-file start "flake.nix")))
      (when root
        (directory-file-name (file-truename root)))))

  (defun yath/nixd-nixpkgs-expr (&optional flake-root)
    "Return the nixpkgs expression for FLAKE-ROOT."
    (if flake-root
        (format "import (builtins.getFlake %S).inputs.nixpkgs { }" flake-root)
      "import <nixpkgs> { }"))

  (defun yath/nixd-formatter-command ()
    "Return the preferred formatter command for `nixd'."
    (catch 'formatter
      (dolist (command '(("nixfmt-rfc-style")
                         ("nixfmt")
                         ("alejandra")))
        (when (executable-find (car command))
          (throw 'formatter (vconcat command))))))

  (defun yath/nixd-option-sources (&optional flake-root)
    "Return extra `nixd' option sources for FLAKE-ROOT."
    (let* ((root (or flake-root (yath/nixd-flake-root)))
           (known (and root
                       (alist-get root
                                  yath/nixd-known-flake-option-sources
                                  nil nil #'string=)))
           options)
      (dolist (source known options)
        (setq options
              (append options
                      (list (intern (format ":%s" (car source)))
                            (list :expr
                                  (format "(builtins.getFlake %S).%s"
                                          root
                                          (cdr source)))))))))

  (defun yath/nixd-workspace-configuration ()
    "Build a buffer-local `eglot-workspace-configuration' for `nixd'."
    (let* ((flake-root (yath/nixd-flake-root))
           (formatter (yath/nixd-formatter-command))
           (options (yath/nixd-option-sources flake-root))
           (nixd `(:nixpkgs (:expr ,(yath/nixd-nixpkgs-expr flake-root)))))
      (when formatter
        (setq nixd (append nixd (list :formatting (list :command formatter)))))
      (when options
        (setq nixd (append nixd (list :options options))))
      (list :nixd nixd)))

  (defun yath/nix-mode-eglot-setup ()
    "Configure and start `nixd' for the current Nix buffer."
    (unless (local-variable-p 'eglot-workspace-configuration)
      (setq-local eglot-workspace-configuration
                  (yath/nixd-workspace-configuration)))
    (yath/eglot-ensure))

  (defun yath/eglot-managed-diagnostics ()
    "Use Flymake inside Eglot buffers and restore Flycheck afterwards."
    (if (eglot-managed-p)
        (progn
          (setq yath/eglot--flycheck-was-enabled (bound-and-true-p flycheck-mode))
          (when yath/eglot--flycheck-was-enabled
            (flycheck-mode -1)))
      (when yath/eglot--flycheck-was-enabled
        (setq yath/eglot--flycheck-was-enabled nil)
        (flycheck-mode 1))))
  :hook ((nix-mode . yath/nix-mode-eglot-setup)
         (terraform-mode . yath/eglot-ensure)
         (markdown-mode . yath/eglot-ensure)
         (markdown-ts-mode . yath/eglot-ensure)
         (csharp-mode . yath/eglot-ensure)
         (csharp-ts-mode . yath/eglot-ensure)
         (go-mode . yath/eglot-ensure)
         (go-ts-mode . yath/eglot-ensure)
         (rust-mode . yath/eglot-ensure)
         (rust-ts-mode . yath/eglot-ensure)
         (eglot--managed-mode . yath/eglot-managed-diagnostics))
  :config
  (add-to-list 'eglot-server-programs '(markdown-mode . ("harper-ls" "--stdio")))
  (add-to-list 'eglot-server-programs '(markdown-ts-mode . ("harper-ls" "--stdio")))
  (add-to-list 'eglot-server-programs '(nix-mode . ("nixd"))))

;; Home Manager puts `emacs-lsp-booster' on PATH for the daemon; manual
;; starts should degrade cleanly if that runtime path is absent.
(use-package eglot-booster
  :after eglot
  :config
  (if (executable-find "emacs-lsp-booster")
      (eglot-booster-mode 1)
    (message "emacs-lsp-booster not found; leaving eglot-booster disabled")))

(use-package treesit-auto
  :custom (treesit-auto-install nil)
  :config
  (defun yath/treesit-auto--eligible-buffer-p (&optional buffer)
    "Return non-nil when BUFFER should participate in `treesit-auto'."
    (with-current-buffer (or buffer (current-buffer))
      (let ((name (buffer-name)))
        (and name
             (not (minibufferp))
             (or buffer-file-name
                 (and (not (string-prefix-p " " name))
                      (not (string-prefix-p "*" name))))))))
  (defun yath/treesit-auto--enable-in-buffer-advice (orig-fn &rest args)
    "Skip `treesit-auto' activation in transient internal buffers."
    (when (yath/treesit-auto--eligible-buffer-p)
      (apply orig-fn args)))
  (unless (advice-member-p #'yath/treesit-auto--enable-in-buffer-advice
                           'global-treesit-auto-mode-enable-in-buffer)
    (advice-add 'global-treesit-auto-mode-enable-in-buffer :around
                #'yath/treesit-auto--enable-in-buffer-advice))
  (treesit-auto-add-to-auto-mode-alist 'all)
  (global-treesit-auto-mode 1))

(use-package apheleia
  :defer t
  :commands (apheleia-format-buffer)
  :hook (prog-mode . apheleia-mode))

(provide 'init-prog)

;;; init-prog.el ends here
