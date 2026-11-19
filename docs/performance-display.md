# Browser redisplay (private headless Chromium, not a paint measurement)

Baseline = c1fe9ee. The patched candidates use the same baseline src, scm and console except for the current editor-core.ts (the independent search work elsewhere in that file is not invoked). Node 24.21.0, Chromium 156.0.8078.79, Linux 6.18.60, Core i5-13500 (6 performance + 8 efficiency cores), shared machine, 1280×800/deviceScaleFactor 1/14px local fonts (fontconfig monospace fallback: DejaVu Sans). No existing browser, edwind, user profile or network service. New temporary Chromium process/profile per repetition, GPU disabled; console-kind page/frame uses the actual DOM, EdHost, boot, keymap and sequential command loop. All scripts stripped from the selected root's TS on request. No packaged startup or platform keyboard/compositor timing claim.

## Measurement

- Synthetic textarea keydown, actual command execution and DOM render. DOM time ends at Ed.whenIdle(). Frame time ends at the first requestAnimationFrame callback after idle (before paint); this is vsync-quantized, not physical input-to-photon. Check drawn DOM cursor against actual point after every key; no deliberate 16ms correction. A task after the prior rAF separates keys. The stream case starts the clock **before** a remote-origin Ed.applyOps tail append (4 lines, 168 UTF-16 units) then dispatches a left/right key in the same task; insertion must not move point/viewport, the selected window must hold its start, DOM+point must advance precisely one unit with the key. No transport/backend simulation.
- Scenarios: many-type inserts/deletes in a 40k-line doc scrolled halfway down; many-motion sends 100 down keys while the viewport tracks; long-type edits at col 6000 of ~12.3k-character lines in a 3.15M-unit doc; split-markdown-type uses two windows onto different parts of the same Markdown buffer (lists, inline markup, links, tags); folded-org-motion moves within a headline in Org overview (160 folds × 128 body lines); small-type fits all 24 lines in the viewport; stream-reader-motion is mid-doc, with producer appending to EOF. All truncate-lines; no native grid/desktop, giant wrapped line, IME, or application networking claim. Fixtures measure changed text on every typing key (half inserts and half Backspaces).
- Renderer CPU is summed SystemInfo.getProcessInfo CPU time delta (ms/100 keys, includes browser renderer work around frame boundaries), not process wall clock. RSS sums all private Chromium renderer processes at scenario end (Linux /proc, not PSS, allocation, peak or tab-only memory; scenario order affects it). CDP counts layout; instrumented lexSeg counts total units *offered*, not necessarily analyzed or iterated by a lexer. Markdown also exposes actual classified units. No Rope flattens reported. 20 warmup keys/scenario/repetition; nearest-rank percentiles pooled over all individual measured keys, never percentiles-of-percentiles. CPU/RSS show per-repetition median [min–max].

## Initial ranking (before production edits)

Initial unprofiled baseline: key→DOM p50/p95/p99 in ms, long-type 9.5/10.1/10.4 (2020 renderer CPU ms/100, rAF 16.8/18.2/19.1), many-motion 3.3/5.8/6.8, split-Markdown 2.9/5.1/6.1, many-type 2.0/2.4/2.7, folded Org 1.8/3.5/4.8. This single scouting pass is NOT the comparison below. Independent PROFILE=1 pass (same workload, profiling enabled): long-type sampled eolS 588 + renderBuffer 453, getBoundingClientRect 255, syncLines 44; JIT-sampled function names are not per-line proof. 83,592,500 UTF-16 segment units/100 keys, 200 segments. #1 keep the same relative spans, cursor, runs, escaping, fold decorations, offsets and cache behavior, but avoid materializing class keys/flags or visiting each character to discover unchanged plain-text spans when neither style nor overlays can distinguish them. For this fixture the former flags allocation alone was 83,592,700 bytes/100 keys (sum(segment length + 1)); classification buffer is reused, not that many bytes allocated again. Segments and actual text slicing/escaping/DOM geometry still exist. Patched PROFILER diagnostic now attributes 168 samples to getBoundingClientRect, 36 to syncLines and 2 to renderBuffer; no eolS in the top 16. No CPU profiler in timing runs.

#2 deferred: downward scrolling samples getBoundingClientRect 283, insertBefore 41. syncLines moves retained nodes past outgoing top rows. A rotation/reuse optimization may help; unlike #1 this sample was dominated by geometry and there is no A/B evidence for a material win. No change to reconciliation, layout decisions, Markdown or Org syntax, fold behavior or draw frequency. Folded Org offers ~22M units to lexSeg per 100 even with 160 folds; investigate only with separate correctness and timing evidence.

## Shared host, default scheduler (four repetitions each, 400 keys/case/version)

Chronological order A1 B1 B2 A2 A3 B3 B4 A4, A=baseline, B=patched. No exclusions. Unprofiled, builds/tests not part of this benchmark. Navigation-ready times (median, then individual runs; navigation through on-demand TS strip/boot/idle/first rAF): baseline → patched: 339.9 ms; runs 462.1, 169.6, 217.7, 1632.1 ms → 632.7 ms; runs 162.6, 174.4, 1091, 1093.6 ms. Four noisy launches per root; no packaging or startup improvement claim.

| Scenario | Key/batch → DOM p50/95/99 (ms), baseline → patched | Next rAF p50/95/99 (ms), baseline → patched | Renderer CPU ms per 100 (median [range]) | End RSS MiB (median [range]) |
|---|---|---|---|---|
| many-type | 0.9/2/2.3 → 1.6/8.8/10.9 | 16.2/16.4/16.6 → 16.1/17/19.7 | 350 [260–430] → 455 [270–650] | 641 [639–643] → 641 [639–645] |
| many-motion | 1.7/3.4/3.6 → 2.5/12.3/14.8 | 15.8/16.1/16.2 → 15.8/16.3/18.3 | 610 [580–710] → 760 [490–1090] | 686 [683–688] → 683 [678–696] |
| long-type | 4.8/8.7/9.5 → 2.4/10.7/13.9 | 15.9/17.7/18.6 → 15.8/16.5/19.8 | 1510 [1180–1810] → 715 [560–1100] | 727 [722–760] → 746 [742–748] |
| split-markdown-type | 1.3/2.7/3.1 → 1.1/2.2/5.7 | 15.7/16.1/16.3 → 15.8/16.1/16.2 | 550 [400–680] → 405 [370–570] | 723 [717–757] → 750 [746–753] |
| folded-org-motion | 0.9/1.7/3.1 → 0.8/1.9/4.1 | 15.9/16.2/17.7 → 16/16.2/16.4 | 390 [300–520] → 365 [300–500] | 729 [721–752] → 738 [735–739] |
| small-type | 0.9/1.8/2.1 → 0.9/1.8/2.9 | 16/16.5/16.8 → 16.1/16.5/16.8 | 390 [340–540] → 390 [290–550] | 760 [754–782] → 766 [764–769] |
| stream-reader-motion | 0.9/2.6/4.4 → 0.6/1.1/1.3 | 16/16.4/16.6 → 16.1/16.4/16.6 | 435 [300–580] → 300 [230–420] | 754 [656–761] → 714 [648–768] |

| Scenario | DOM p50 baseline, patched (4 run range ms) | DOM p95 baseline, patched (4 run range ms) | DOM p99 baseline, patched (4 run range ms) | rAF min–max ms (all individual keys) |
|---|---|---|---|---|
| many-type | 0.8–1.5 → 0.8–5.8 | 1–2.2 → 1–10.3 | 1.2–2.5 → 1.2–12.2 | 13.9–16.7 → 3.6–24.5 |
| many-motion | 1.6–2.1 → 1.4–9.1 | 3.1–3.6 → 1.9–14.8 | 3.3–3.8 → 2.1–15.6 | 14.2–16.4 → 4.9–22 |
| long-type | 4.1–6.4 → 1.5–8 | 4.3–9.3 → 2.6–13.8 | 4.4–10.6 → 2.7–16.5 | 11–21 → 6.7–24.8 |
| split-markdown-type | 1–2.3 → 1–2 | 1.2–2.9 → 1.6–5.6 | 1.3–3.4 → 1.9–7.5 | 14.1–16.4 → 6.4–16.4 |
| folded-org-motion | 0.6–1.5 → 0.7–1.3 | 0.8–3 → 1–2.9 | 0.9–4.9 → 1.1–5.1 | 11.6–18.3 → 9.5–17 |
| small-type | 0.7–1.5 → 0.6–1.5 | 1.4–2 → 0.9–2.3 | 1.5–2.6 → 1.1–4.1 | 7.9–17.2 → 12.9–18.3 |
| stream-reader-motion | 0.5–1.9 → 0.5–0.9 | 0.6–4.4 → 0.5–1.2 | 0.8–7 → 0.6–1.3 | 9.6–19.1 → 14.5–16.7 |

| Scenario | UTF-16 units/lines | Windows (rows) | Rendered segment hook calls × aggregate units per 100 | Motion Δstart units | Edits, tail units; Markdown units lexed | Layout count, duration ms (median) baseline → patched |
|---|---|---|---|---|---|---|
| many-type | 2348890/40000 | 33 | 200 calls / 401300 | 0 | 100, 0; 0 | 200, 31 → 200, 54.5 |
| many-motion | 2348890/40000 | 33 | 100 calls / 200600 | 5900 | 0, 0; 0 | 200, 84.5 → 200, 123.3 |
| long-type | 3146898/256 | 33 | 200 calls / 83592500 | 0 | 100, 0; 0 | 200, 99.2 → 200, 107.2 |
| split-markdown-type | 836890/16000 | 15+15 | 400 calls / 332900 | 0 | 100, 0; 332900 | 200, 34.6 → 200, 26.2 |
| folded-org-motion | 1087570/20640 | 33 | 100 calls / 22432800 | 0 | 0, 0; 0 | 200, 41.9 → 200, 35.1 |
| small-type | 1334/24 | 33 | 200 calls / 266900 | 0 | 100, 0; 0 | 200, 37.7 → 200, 39.2 |
| stream-reader-motion | 578890/10000 | 33 | 200 calls / 394400 | 0 | 100, 16800; 0 | 200, 44.9 → 200, 32.8 |

Default scheduler: long-type renderer CPU 1510→715 ms/100, all four patched values (560–1100) lower than all four baseline values (1180–1810), p50 4.8→2.4ms. **Tails were worse:** long-type DOM p95/p99 8.7/9.5→10.7/13.9, rAF p99 18.6→19.8. Worst DOM p99 absolute regression many-motion 3.6→14.8 (+11.2 ms), many-type 2.3→10.9 (+8.6 ms). Small-type median/95 unchanged, p99 2.1→2.9; split-Markdown p99 3.1→5.7. B3 and B4 were variable even on startup (1091/1094 ms vs 163/174 ms B1/B2), and B4 long-type layout 337 ms vs 82/96 ms B1/B2; same layout count. A4 navigation-ready also reached 1632 ms. Raw tails are retained, not attributed wholesale to the patch or discarded as noise. Reader retains exactly its anchor during each remote append and key; 16,800 appended units per measured 100.

## Affinity sensitivity (separate cohort; three repetitions each, 300 keys/case/version)

Given the raw default-scheduler tails and this machine's two core classes, repeated all seven cases without privileged tuning. Linux taskset restricted each private benchmark and its child processes to the same six P-core logical CPUs (0,2,4,6,8,10); no cores reserved and no governor change. Order B1 A1 A2 B2 B3 A3. Do not merge cohorts or treat it as a clean room. Navigation-ready baseline → patched: 276.6 ms; runs 168.9, 276.6, 508.3 ms → 262 ms; runs 176.9, 262, 389.4 ms.

| Scenario | Key/batch → DOM p50/95/99 (ms), baseline → patched | Next rAF p50/95/99 (ms), baseline → patched | Renderer CPU ms per 100 (median [range]) | End RSS MiB (median [range]) |
|---|---|---|---|---|
| many-type | 1.1/1.8/2.1 → 0.8/1.4/2.2 | 16/16.7/17.3 → 16.2/16.5/16.6 | 340 [220–450] → 280 [260–310] | 634 [634–637] → 636 [636–636] |
| many-motion | 2.4/4.6/5.7 → 1.3/1.6/1.7 | 15.5/16.2/16.3 → 16/16.2/16.3 | 640 [430–640] → 430 [420–450] | 677 [676–681] → 671 [670–686] |
| long-type | 7.8/8.9/11.5 → 1.5/3.9/5.1 | 15.6/18.6/20.7 → 16/16.4/17.9 | 1500 [1160–1870] → 520 [430–600] | 730 [714–772] → 724 [714–735] |
| split-markdown-type | 1.7/3.4/5.2 → 1.1/3/3.3 | 15.4/16.3/18.5 → 15.9/16.1/17.1 | 440 [380–600] → 390 [340–550] | 736 [725–783] → 716 [707–719] |
| folded-org-motion | 1.1/1.9/3.6 → 0.8/1.2/1.9 | 15.6/16.2/18.8 → 16/16.3/16.4 | 390 [380–400] → 300 [250–350] | 737 [724–761] → 722 [714–723] |
| small-type | 1.1/1.5/2.4 → 0.7/1.2/2.5 | 15.9/16.5/17.6 → 16.1/16.5/16.6 | 360 [360–410] → 280 [270–400] | 767 [756–796] → 750 [743–752] |
| stream-reader-motion | 0.7/1.2/1.6 → 0.6/0.9/1 | 16/16.4/17.5 → 16/16.4/16.8 | 370 [240–450] → 270 [220–330] | 751 [738–770] → 750 [744–752] |

| Scenario | DOM p50 baseline, patched (3 run range ms) | DOM p95 baseline, patched (3 run range ms) | DOM p99 baseline, patched (3 run range ms) | rAF min–max ms (all individual keys) |
|---|---|---|---|---|
| many-type | 0.7–1.6 → 0.8–0.9 | 0.9–1.9 → 0.9–2.1 | 0.9–2.1 → 1–4.9 | 8.2–19.7 → 9.3–16.9 |
| many-motion | 1.3–2.8 → 1.3–1.4 | 1.6–5.5 → 1.5–1.6 | 1.6–5.8 → 1.5–2 | 9.9–17.8 → 14.5–16.4 |
| long-type | 4.3–8.3 → 1.4–2.4 | 7.3–11.1 → 1.5–4.7 | 7.4–12 → 1.6–16.9 | 8.7–24.1 → 1.8–29.1 |
| split-markdown-type | 1.3–1.8 → 0.9–1.9 | 2.4–3.7 → 1.1–3.2 | 3–6.4 → 1.1–4.6 | 11.3–18.9 → 9–21.4 |
| folded-org-motion | 1–1.2 → 0.7–1 | 1.3–2.5 → 0.8–1.5 | 2.3–3.7 → 1.1–2.6 | 5.9–40.9 → 13.9–16.5 |
| small-type | 1–1.2 → 0.6–1.1 | 1.2–1.9 → 0.7–1.7 | 2.3–2.9 → 0.8–3.1 | 11.9–18 → 5.3–18.4 |
| stream-reader-motion | 0.5–0.9 → 0.4–0.8 | 0.6–1.3 → 0.6–1 | 0.8–1.9 → 0.6–2.9 | 9.3–19.2 → 12.5–19.3 |

Long-type DOM p50/95/99 7.8/8.9/11.5→1.5/3.9/5.1 ms, renderer CPU 1500→520 ms/100 keys; p99 rAF 20.7→17.9 but p50 rAF 15.6→16.0. One patched repetition still had an individual-run DOM p99 of 16.9 ms. Here the worst pooled DOM p99 regressions were +0.1 ms for many-type and small-type. The many-motion p99 regression of the default-scheduler cohort did **not** repeat; large differences in split Markdown and folded Org on both cohorts are not attributable to this plain-text path. No wall-time improvement claim for small documents, scrolling, syntax/folding, startup, physical paint or aggregate RSS.

**Decision:** keep #1 on consistent long-line renderer CPU and improved long-line DOM p50 in both cohorts. Do not claim a universal frame/tail latency win; CSS layout, scheduling and vsync remain visible after eliminating the redundant per-character work. No #2 production patch. No performance assertion. Regression tests in test/display.test.mts exercise plain vs never-matching highlight (classified path) in HTML, run or combined formats incl. ghost cursor, UTF-16, control characters, 12k-unit line, folds, caching, highlight/region, and the single string result. 

Reproduce one cycle using a baseline source archive extracted into `.perf-base`:

```sh
export CHROMIUM=/path/to/chromium
for root in .perf-base . . .perf-base; do EDWIN_ROOT=$root node tools/display-bench.mts; done
# On the measured i5 host only: prefix node with taskset -c 0,2,4,6,8,10 to repeat the affinity cohort.
# On any host: PROFILE=1 SCENARIO=long-type EDWIN_ROOT=.perf-base node tools/display-bench.mts
```

