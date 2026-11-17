;; Lisp forms written flush left, for the indenter (test/structural.test.mts); corpus.emacs.el is GNU Emacs 31.1's indent-region of it.
(if a
    b
  c)
(if (a)
    (b) (c)
    (d))
(begin (foo)
       (bar)
       (baz))
(begin
 (foo)
 (bar))
(when a (foo)
      (bar))
(when a
  (foo))
(let loop ((i 0))
     (foo i))
(let loop
  ((i 0))
  (foo i))
(let ((a 1)
      (b 2))
  (+ a b))
(let
    ((a 1))
  a)
(define (f x)
        x)
(define x
        1)
(define-record-type point
                    (make-point x y)
                    point?
                    (x point-x))
(do ((i 0 (+ i 1)))
    ((= i 3))
    (display i))
(dynamic-wind
 (lambda () 1)
 (lambda () 2)
 (lambda () 3))
(dynamic-wind (lambda () 1)
              (lambda () 2)
              (lambda () 3))
(foo 'a 'b
     'c)
('a 'b
    'c)
(foo t nil
     t)
(t nil
   t)
(foo :type x
     :jump y)
(f a b
   c
   d)
(f
 a
 b)
( f a
  b)
(f a b :k 1
   :j 2)
(f a
   :k 1
   :j 2)
(list (vector 1 2
              3) [a b
              vector-tail])
'(a b
    c)
`(a ,b
    ,@c)
(f `(,a :x 1
        :y 2))
(cond ((a) b
       c)
      (else
       d))
(case x
      ((1) 'a)
      (else 'b))
(lambda (x)
  x)
(lambda (x) x
  y)
(syntax-rules ()
              ((_ a) a))
(guard (e (t 1))
       (raise 'x))
(define-syntax foo
               (syntax-rules ()
                             ((_ x) x)))
(parameterize ((a 1))
              (b))
(receive (a b)
         (values 1 2)
         (list a b))
(call-with-values (lambda () 1)
                  (lambda (x) x))
(foo (bar
      baz) qux
      quux)
(foo "a
b" c
after-string)
(foo ; c
 a
 b)
(foo a ; c
     b)
(foo
 ;; c
 a)
(save-excursion
  (save-excursion-body))
(with-current-buffer b
  (with-current-buffer-body))
(dotimes (i 3)
  (dotimes-body))
(evil-define-key 'normal 'global
  "evil-key-a" 'b
  "evil-key-c" 'd)
(define-key map "a"
            'b)
(defvar-shared x 1
               "doc")
((lambda (x) x)
 1)
((foo) a
 b)
(foo [a b
        c])
(f
 (g a
    b)
 (h))
(use-package foo
  :hook (a . b)
  :config
  (bar))
(with-eval-after-load 'x
  (foo))
(defun f (x)
  "doc"
  x)
(defun f
    (x)
  x)
(defmacro m (x)
  x)
(defcustom c 1
  "doc"
  :type 'integer)
(setq a 1
      b 2)
(condition-case err
    (foo)
  (error (bar)))
(unwind-protect
    (foo)
  (bar))
(cl-flet ((f (x)
            local-defun-body))
  (f 1))
(pcase x
  ('a 1)
  (_ 2))
(when-let* ((a 1))
  a)
(if-let* ((a 1))
    a
  b)
(add-hook 'foo-hook
          (lambda ()
            (bar)))
(dolist (x xs)
  (foo x))
(lambda (x)
  x)
(progn (a)
       (b))
(prog1 (a)
  (b))
(gptel-make-openai "x"
  :host "y"
  :stream t)
(transient-define-prefix p ()
  "doc"
  ["a" ("x" "y" z)])
(evil-define-key 'normal 'global
  "a" 'b)
(general-define-key
 :states 'normal
 "a" 'b)
(let-alist x
  .a)
(#'foo a
       b)
(?a b
    c)
(:a 1
    :b 2)
(foo :a 1
     :b 2)
(defun f ()
;;; three
  ;; two
  (g))
(defun g ()

  (h))
(let ((a (foo
          bar))
      (b 2))
  (list a
        b))
(cond
 ((a) b)
 (t c))
(if (a)
    (progn
      (b))
  (c))
(and a
     b)
(interactive
 (list 1
       2))
(setq-local a 1
            b 2)
(define-minor-mode m
  "doc"
  :global t
  (foo))
