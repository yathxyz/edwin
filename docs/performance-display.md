# Browser redisplay (private headless Chromium, not a paint measurement)

Compare pristine `c1fe9eec` with the reviewed worktree using the same `tools/display-bench.mts` harness. Node 24.21.0, Chromium 156.0.8078.79, Linux 6.18.60, Core i5-13500 (6 performance + 8 efficiency cores), shared machine, default scheduler. Viewport 1280×800, device scale 1, 14px local font (fontconfig monospace fallback: DejaVu Sans). Each repetition starts a new headless Chromium process with a private profile, GPU disabled, private debugging pipe and ephemeral loopback HTTP server. The harness strips TS from the selected root on request and boots a console-kind page/frame. No existing browser, edwind, external service or packaged startup.

## Measurement

- Synthetic textarea keydown, actual command execution and DOM render. DOM time ends at Ed.whenIdle(). Frame time ends at the first requestAnimationFrame callback after idle (before paint); this is vsync-quantized, not physical input-to-photon. Check drawn DOM cursor against actual point after every key; no deliberate 16ms correction. A task after the prior rAF separates keys. The stream case starts the clock **before** a remote-origin Ed.applyOps tail append (4 lines, 168 UTF-16 units) then dispatches a left/right key in the same task; insertion must not move point/viewport, the selected window must hold its start, DOM+point must advance precisely one unit with the key. No transport/backend simulation.
- Scenarios: many-type inserts/deletes in a 40k-line doc scrolled halfway down; many-motion sends 100 down keys while the viewport tracks; long-type edits at col 6000 of ~12.3k-character lines in a 3.15M-unit doc; split-markdown-type uses two windows onto different parts of the same Markdown buffer (lists, inline markup, links, tags); folded-org-motion moves within a headline in Org overview (160 folds × 128 body lines); small-type fits all 24 lines in the viewport; stream-reader-motion is mid-doc, with producer appending to EOF. All truncate-lines; no native grid/desktop, giant wrapped line, IME, or application networking claim. Fixtures measure changed text on every typing key (half inserts and half Backspaces).
- Renderer CPU is summed SystemInfo.getProcessInfo CPU time delta (ms/100 keys, includes browser renderer work around frame boundaries), not process wall clock. RSS sums all private Chromium renderer processes at scenario end (Linux /proc, not PSS, allocation, peak or tab-only memory; scenario order affects it). CDP counts layout; instrumented lexSeg counts total units *offered*, not necessarily analyzed or iterated by a lexer. Markdown also exposes actual classified units. No Rope flattens reported. 20 warmup keys/scenario/repetition; nearest-rank percentiles pooled over all individual measured keys, never percentiles-of-percentiles. CPU/RSS show per-repetition median [min–max].

## Initial ranking (before production edits)

Historical baseline scouting pass (not pooled below): long-type had the largest key→DOM p50/p95/p99, 9.5/10.1/10.4 ms, at 2020 ms renderer CPU per 100 keys. A separate CPU profile sampled `eolS` 588 times and `renderBuffer` 453 times, compared with 255 for `getBoundingClientRect` and 44 for `syncLines`. A sample names a function, not a source-line cost. With no syntax, overlays or selection, a row changes span only at point and end-of-line. The plain path skips initializing and scanning character keys and flags; this fixture previously allocated 83,592,700 bytes of flags per 100 keys (sum of segment length + 1). Text slicing, escaping, cursor painting and DOM geometry remain. The benchmark timings do not enable the profiler.

Scrolling remained a separate candidate (283 samples in `getBoundingClientRect`, 41 in `insertBefore` on downward motion). There is no timed prototype showing that changing node reuse or layout decisions pays off. No reconciliation, Markdown lexing or fold semantics were changed.

## Cache correctness

A row can only reuse HTML/runs from the same render context: active state, representation, plain/classified path, cursor class, fold label and lexer class-name table. Field boundaries must survive arbitrary UTF-16, including `|` and NUL. The renderer compares the context once per map, not once per row. Row keys record relative point, newline/fold state, HTML offset, length-prefixed text and (for classified rows) length-prefixed packed character keys. An external lexer can supply a cursor class index wider than its packed byte, so cursor rows also record that full index. Repeated unchanged runs are still reused; the existing cache limit (8192 units, including end-of-line) is unchanged.

`test/display.test.mts` primes the cache with row `x` and cursor class `|p||0|0|`, then reuses it for row `|p||0|0|x` with no cursor class. This formerly painted `x` instead of the longer row. The tests compare cached and fresh output in HTML, runs and combined formats, including format-specific delimiter sequences, changes to the names behind the same numeric class bytes, sparse class-table slots, a wider cursor class index and a changed fold label. Plain vs never-matching highlight checks cover escaping, cursor positions, UTF-16, folds and long rows independently of cache hits.

## Current comparison: five interleaved pairs

A = baseline; B = fixed. Order: **A1 B1 B2 A2 A3 B3 B4 A4 A5 B5**. No exclusions; 20 warmups then 100 keys per scenario per process (500 measured keys/scenario/version). Every arrow is baseline → fixed. Navigation through on-demand strip, boot, idle and first rAF took 178.4 [148.9–536.5] → 173.1 [153.1–384.3] ms, median [range] of five independent navigations per root. This does not establish a packaged startup improvement.

| Scenario | Key/batch → DOM p50/95/99 (ms) | Next rAF p50/95/99 (ms) | Renderer CPU ms/100 keys (median [range]) | End renderer RSS MiB (median [range]) |
|---|---|---|---|---|
| many-type | 1/3.5/4.5 → 0.9/3.5/3.8 | 16.1/16.4/16.6 → 16.1/16.4/16.6 | 320 [310–850] → 350 [310–880] | 641.3 [639.8–643.8] → 640.6 [639.2–642.4] |
| many-motion | 1.6/4.2/4.6 → 2.4/4.9/6 | 15.9/16.2/16.3 → 15.7/16.2/16.5 | 510 [500–920] → 860 [570–870] | 687.7 [682.2–692.1] → 691.5 [681.8–694.4] |
| long-type | 4.2/10.1/11.3 → 2.7/5/6.7 | 16/18.3/19.6 → 15.6/16.3/17 | 1210 [1120–2100] → 980 [600–1250] | 729.9 [726.6–742.2] → 733.1 [729.9–744.2] |
| split-markdown-type | 1.3/3.3/3.8 → 1.4/4/7 | 15.7/16.2/16.4 → 15.7/16.3/16.8 | 570 [370–980] → 620 [400–690] | 725.6 [721.2–739.7] → 732.3 [720.9–750.1] |
| folded-org-motion | 1.1/2.7/3 → 1.6/4.1/5.6 | 15.7/16.2/16.4 → 15.6/16.2/16.4 | 400 [310–990] → 630 [300–1000] | 731.1 [727.3–739.7] → 730.3 [728.1–736.9] |
| small-type | 0.8/2.8/3.1 → 1.3/4.2/6.4 | 16/16.5/16.8 → 15.9/16.7/18.3 | 380 [310–850] → 640 [310–920] | 758.5 [753.8–772.2] → 760.5 [757.4–768.3] |
| stream-reader-motion | 0.7/2.1/2.3 → 0.5/1.8/2.1 | 16/16.4/16.8 → 16.1/16.5/16.7 | 350 [290–830] → 300 [250–540] | 756.5 [663.8–761.2] → 760.3 [757.1–768.2] |

Spreads across the five independent browser runs (min–max for each percentile).

| Scenario | DOM per-run p50 / p95 / p99 ranges (ms) | rAF per-run p50 / p95 / p99 ranges (ms) | rAF all-key min–max (ms) |
|---|---|---|---|
| many-type | 0.9–2.8 / 1.1–4 / 1.3–4.9 → 0.8–3.4 / 1.6–3.7 / 1.9–5.7 | 15.2–16.2 / 16.3–16.6 / 16.5–16.8 → 15–16.2 / 16.3–16.5 / 16.4–16.6 | 10.7–17.2 → 8.9–17.1 |
| many-motion | 1.4–3.3 / 1.7–4.6 / 2.2–5.2 → 1.5–3.2 / 3.1–5.4 / 3.4–6.1 | 15.4–16 / 16–16.2 / 16.2–16.3 → 15.1–15.9 / 16.1–16.3 / 16.2–18.3 | 13.2–16.4 → 9.8–19.5 |
| long-type | 4.1–9.8 / 4.5–11.3 / 4.5–12.2 → 1.5–3.5 / 1.8–5.8 / 2.1–9.5 | 16–17.3 / 16.3–19.6 / 17–22.3 → 15–16 / 16.1–16.8 / 16.3–17.2 | 10.6–22.7 → 8.8–17.7 |
| split-markdown-type | 1–3 / 1.3–3.8 / 1.4–5.4 → 1–2.5 / 1.5–7 / 1.6–8.2 | 14–15.9 / 16–16.4 / 16.1–17.5 → 15.1–15.9 / 16.1–16.3 / 16.4–17.6 | 10–18.6 → 9.1–20.1 |
| folded-org-motion | 0.7–2.5 / 0.9–2.9 / 1.1–3.3 → 0.7–2.9 / 1.1–5.6 / 1.2–7.1 | 14.4–16.1 / 15.4–16.3 / 16.1–16.5 → 14.4–16.1 / 15.9–16.3 / 16.1–16.7 | 9.1–17 → 8.4–19.6 |
| small-type | 0.7–2 / 1.1–3.1 / 1.2–3.6 → 0.6–2.5 / 0.8–6.4 / 0.9–8.9 | 15.4–16.2 / 16.4–16.6 / 16.5–17.2 → 15.3–16.2 / 16.4–17.7 / 16.5–20.3 | 8.9–18.7 → 5.3–21.1 |
| stream-reader-motion | 0.5–2 / 0.8–2.2 / 0.8–2.3 → 0.5–1.4 / 0.7–2 / 0.8–2.4 | 15–16.2 / 16.2–16.7 / 16.5–16.8 → 15.4–16.2 / 16.3–16.5 / 16.5–16.7 | 9.2–17.2 → 8.6–18.1 |

Per 100 keys: fixture and work counters are identical across both versions unless shown with an arrow. Durations are per-run medians [min–max]. Lexer hook time includes all instrumented hooks, including calls that return no classifications.

| Scenario | UTF-16 units / lines | Window rows | Segment calls / units | Scroll Δ / edits / appended units / Markdown units lexed | Layouts, duration ms | Lexer hook ms |
|---|---|---|---|---|---|---|
| many-type | 2348890 / 40000 | 33 | 200 / 401300 | 0 / 100 / 0 / 0 | 200, 30 [26.1–73.7] → 200, 32.2 [27.2–84.4] | 1.5 [0.6–2.6] → 0.6 [0.3–2.3] |
| many-motion | 2348890 / 40000 | 33 | 100 / 200600 | 5900 / 0 / 0 / 0 | 200, 65.9 [62.3–125.2] → 200, 112 [80.8–148.1] | 0.7 [0.3–1] → 0.5 [0.4–0.6] |
| long-type | 3146898 / 256 | 33 | 200 / 83592500 | 0 / 100 / 0 / 0 | 200, 72.5 [67.6–149.7] → 200, 137.3 [72.1–183.9] | 0.9 [0.7–2] → 1.7 [0.6–2.5] |
| split-markdown-type | 836890 / 16000 | 15+15 | 400 / 332900 | 0 / 100 / 0 / 332900 | 200, 32.3 [21.5–51.9] → 200, 39.8 [23–57.2] | 35.2 [21–73.6] → 45.4 [20.9–55.5] |
| folded-org-motion | 1087570 / 20640 | 33 | 100 / 22432800 | 0 / 0 / 0 / 0 | 200, 41.4 [26.2–95.8] → 200, 71.7 [27.9–114.2] | 1 [0.3–1.8] → 1.3 [0.4–7.6] |
| small-type | 1334 / 24 | 33 | 200 / 266900 | 0 / 100 / 0 / 0 | 200, 34.7 [26.6–71] → 200, 78.5 [25.6–98.2] | 1.2 [0.8–1.5] → 1.4 [0.5–2.8] |
| stream-reader-motion | 578890 / 10000 | 33 | 200 / 394400 | 0 / 100 / 16800 / 0 | 200, 34.3 [25.3–85.2] → 200, 30.2 [24.7–59.8] | 1.1 [0.5–1.6] → 1 [0.4–1.6] |

**Decision:** keep the plain-row fast path for long unstyled lines. Long-type DOM p50 fell in all five pairs (4.1→1.5, 9.8→3.1, 4.1→3.2, 4.1→2.6, 4.2→3.5 ms); the pooled DOM p95 and p99 also fell. Renderer CPU was lower in three of five pairs (1120→600, 2100→880, 1140→1250, 1270→980, 1210→1230 ms/100). Pairs 3 and 4 had **higher** long-type DOM p99 despite the pooled result. Across all seven scenarios there were zero Rope flattens. Every stream append preserved the reader anchor and drawn cursor; 16,800 units were appended per measured run.

**Regressions:** the largest pooled DOM p99 increase was small-type (+3.3 ms), followed by split Markdown (+3.2), folded Org (+2.6) and many-motion (+1.4). Small-type rAF p99 rose 16.8→18.3 ms; many-motion renderer CPU rose 510→860 ms/100. Layouts numbered 200 per case for both versions, but e.g. small-type median layout duration rose 34.7→78.5 ms. These are shared-host end-to-end measurements with overlapping per-run ranges, not a causal isolation of the cache key, syntax, layout or scheduler. No general frame latency, scrolling, small-buffer, RSS or startup improvement claim.

## Reproduction

With the baseline sources under `.review/base` and a Node 24+ binary on `PATH`:

```sh
set -e
export CHROMIUM=/path/to/chromium TMPDIR="$PWD/.review/tmp"
mkdir -p "$TMPDIR"
for run in A1 B1 B2 A2 A3 B3 B4 A4 A5 B5; do
  case $run in A*) root=.review/base ;; B*) root=. ;; esac
  EDWIN_ROOT=$root node tools/display-bench.mts > ".review/display-$run.jsonl"
done
```

The defaults measure all seven scenarios, 20 warmups + 100 measured keys each. Each JSON line carries raw `keyDomMs`, `keyFrameMs`, fixture and counters; group by scenario and root to pool timings. `PROFILE=1 SCENARIO=long-type` enables a separate diagnostic profile; do not include that run in the timing comparison.

