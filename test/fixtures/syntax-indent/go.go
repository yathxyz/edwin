// A fixture for the indent engine: gofmt's layout.
package main

import (
	"fmt"
	"strings"
)

const (
	small = 1
	large = 100
)

type Shape interface {
	Area() float64
}

type Rect struct {
	W, H float64
	Tags []string
}

func (r Rect) Area() float64 {
	return r.W * r.H
}

/*
A block comment

	over lines,
	  kept as written.
*/
func classify(n int) string {
	switch {
	case n < small:
		return "none"
	case n > large:
		return "many"
	default:
		if n%2 == 0 {
			return "even"
		} else if n%3 == 0 {
			return "three"
		} else {
			return "odd"
		}
	}
}

func describe(v interface{}) string {
	switch x := v.(type) {
	case int:
		return classify(x)
	case string:
		return strings.ToUpper(x)
	}
	return ""
}

func main() {
	rects := []Rect{
		{W: 1, H: 2},
		{
			W:    3,
			H:    4,
			Tags: []string{"a", "b"},
		},
	}
	total := 0.0
	for _, r := range rects {
		total += r.Area()
	}
	counts := map[string]int{
		"one": 1,
		"two": 2,
	}
	text := `a raw string
	over lines,
  kept as written`
	done := make(chan bool)
	go func() {
		defer close(done)
		fmt.Println(
			total,
			counts,
			text,
		)
	}()
	select {
	case <-done:
		fmt.Println("done")
	}
	if total > 1 &&
		len(counts) > 1 {
		fmt.Println(describe(len(rects)), describe("x"))
	}
}

func labels(xs []int) int {
outer:
	for _, x := range xs {
		switch {
		case x > 10:
			break outer
		// the small ones
		case x > 0:
			continue
		default:
			return x
		}
	}
	return 0
}
