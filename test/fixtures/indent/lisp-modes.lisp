(defun f (x)
  "doc"
  (let ((a 1)
        (b 2))
    (+ a
       b)))
(if a
    b
    c)
(foo
 bar
 baz)
(foo bar
     baz)
(when a
  b)
(defmacro m (&body body)
  `(progn
     ,@body))
(flet ((g (x)
         x))
  (g 1))
(handler-case (foo)
  (error (e)
    e))
(loop for x in y
      do (print x)
      collect x)
(defclass c ()
  ((a :initarg :a
      :reader a)))
(defpackage :foo
  (:use :cl)
  (:export #:a
           #:b))
(destructuring-bind (a b) x
  (list a b))
(multiple-value-bind (a b)
    (f)
  (list a b))
(defgeneric g (x)
  (:method ((x integer))
    x))
(lambda (x)
  x)
(unwind-protect (foo)
  (bar))
(cond ((a)
       b)
      (t c))
(case x
  (1 a)
  (t b))
(progn
  a)
(do ((i 0 (1+ i)))
    ((= i 3))
  (print i))
(define-foo a
    b)
(with-open-file (s "f")
  (read s))
(with-foo (s)
  b)
(defstruct point
  x
  y)
(labels ((g ()
           1))
  (g))
(dolist (x l)
  (print x))
(block nil
  (return 1))
(:key a
      b)
#(a
  b)
(defun g (&key (a 1)
            (key-b 2))
  (list a b))
(defmethod area ((s square))
  (* (side s) (side s)))
(defvar *x*
  1
  "doc")
(defparameter *y* 2)
(let* ((a 1)
       (b a))
  b)
(if (foo)
    (bar)
    (baz))
(when (foo)
  (bar)
  (baz))
(unless x
  y)
(eval-when (:compile-toplevel :load-toplevel)
  (foo))
(cl:defun h ()
  1)
(restart-case (foo)
  (retry ()
    (bar)))
(handler-bind ((error #'foo))
  (bar))
(macrolet ((m (x)
             `(list ,x)))
  (m 1))
(prog1 a
  b)
'(a
  b)
(format t "~a~%"
        x)
(f #\( a
   #\) b)
#|
block (comment
|#
(f "str(" a
   b)
(multiple-value-call #'list
  (f))
(typecase x
  (integer 1)
  (t 2))
(with-slots (a b) obj
  (list a b))
(defmethod area :around ((s square))
  s)
(defmethod show :before :extra ((x thing) &optional stream
                                            verbose)
  x)
(defmethod pick ((x a) &optional (y b)
                         (z c))
  x)
(loop
      for x in y
      do (print x))
(loop (foo)
 (bar))
(cond
  (a b))
(ignore-errors
  (f))
(defun f2 (a b
           c d)
  a)
(defun k (a
          &rest r)
  r)
(handler-case (foo)
  (error (c &optional d
              e)
    c))
(defmacro m2 (&whole w
                a &body b)
  a)
(defsetf foo set-foo)
(unwind-protect
     (foo)
  (bar))
(defun f3 ()
  (unwind-protect
       (foo)
    (bar)))
(unwind-protect (foo)
  (bar)
  (baz))
(prog (a)
   (foo)
 tag
   (bar))
(prog ()
   #'foo
 :kw
   'x
 1
   (go :kw))
(tagbody
   (foo)
 tag
   (bar))
(tagbody (foo)
   (bar))
(do ((i 0 (1+ i)))
    ((= i 3))
  (foo)
 tag
  (bar))
(multiple-value-bind
      (a b)
    (f)
  x)
(destructuring-bind
      (a b)
    l
  x)
(with-slots
      (a b)
    o
  x)
(defclass
      foo
    (bar)
  ((x))
  (:documentation "d"))
(define-condition
      foo
    (error)
  ())
