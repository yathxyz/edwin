;; Lisp forms written flush left, for the indenter (test/structural.test.mts); corpus.emacs.scm is GNU Emacs 31.1's indent-region of it.
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
(foo #t #f
     #t)
(#t #f
    #t)
(foo #:type x
     #:jump y)
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
(list #(1 2
          3) [a b
                c])
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
(guard (e (#t 1))
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
(define (f)
;;; three
  ;; two
  (g))
(define (g)

  (h))
(foo `(a ,b
         c))
(foo '(a b
         c))
(let* ((a (foo
           bar))
       (b 2))
  (list a
        b))
(cond
 ((a) b)
 (else c))
(if (a)
    (begin
      (b))
    (c))
(and a
     b
     c)
(or (a)
    (b))
(set! x
      1)
(apply f
       a)
(define-command (foo x)
  "doc"
  (interactive "p")
  x)
(evil-define-motion (m count)
                    "motion-doc"
                    #:type motion-type
                    (motion-body))
(lambda args
  args)
(let-values (((a b) (values 1 2)))
  a)
