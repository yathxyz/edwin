#lang racket
(define (f)
  (g))
(define (fact n)
  (if (zero? n)
      1
      (* n (fact (- n 1)))))
(let loop ((i 0))
  (when (< i 3)
    (loop (+ i 1))))
(define-syntax-rule (swap! a b)
  (let ([tmp a])
    (set! a b)
    (set! b tmp)))
(struct point (x y)
        #:transparent)
(for ([i (in-range 3)])
     (displayln i))
(match x
  [(list a b)
   (+ a b)]
  [_ 0])
(cond
 [(odd? x) 'odd]
 [else
  'even])
(lambda (x)
  x)
(f #\( a
   b)
(module+ test
         (check-equal? (f) 1))
