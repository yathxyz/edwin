(deftype Foo [a b]
  P
  (bar [this]
    body))
(defn f [x]
  "doc"
  (let [a 1
        b 2]
    (+ a
       b)))
{:a 1
 :b 2}
(foo
 bar
 baz)
(foo bar
     baz)
(if a
  b
  c)
(letfn [(g [x]
          x)]
  (g 1))
(ns foo.bar
  (:require [a.b :as c]
            [d.e]))
(when-foo x
  y)
(defrecord R [a]
  P
  (m [_]
    1))
(cond
  a b
  c d)
#{a
  b}
[a b
 c]
(-> x
    (f)
    (g))
(:k m
    n)
(defn- private-fn
  "Docstring with (parens) and \"quotes\"."
  [x]
  (str/join ", "
            [x x]))
(defmacro unless [test & body]
  `(when-not ~test
     ~@body))
(defprotocol Shape
  (area [this])
  (perimeter [this]
    "doc"))
(extend-protocol Shape
  Circle
  (area [c]
    (* 3.14 (:r c))))
(reify Object
  (toString [_]
    "x"))
(try
  (foo)
  (catch Exception e
    (log e))
  (finally
    (done)))
(case x
  1 :one
  2 :two
  :other)
(condp = x
  1 :one
  :other)
(doseq [x xs
        :when (odd? x)]
  (println x))
(loop [i 0]
  (when (< i 3)
    (recur (inc i))))
(fn [x]
  (* x x))
(with-open [r (reader f)]
  (slurp r))
(def config
  {:host "localhost"
   :port 8080
   :opts {:a 1
          :b [1 2
              3]}})
(let [m {:a 1}
      {:keys [a b]} m]
  (+ a b))
(cond-> x
  true inc
  false dec)
(->> xs
     (map inc)
     (filter odd?))
(comment
  (foo)
  (bar))
(str/starts-with? s
                  "x")
(if-let [x (f)]
  x
  y)
(when-let* [a 1]
  a)
#?(:clj (foo)
   :cljs (bar))
(a ")" b)
(f \( x
   \) y)
(f #"re(x" a
   b)
(f #_(ignored
      x) a
   after-datum)
(deftest t
  (is (= 1
         1)))
(testing "x"
  (is true))
(defn multi
  ([x] x)
  ([x y]
   (+ x y)))
(f, a,
    b)
(go
  (<! c))
