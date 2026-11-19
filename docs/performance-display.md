# Browser redisplay (private headless Chromium, not a paint measurement)

The comparisons below use the same page workload and command driver from `tools/display-bench.mts`. Node 24.21.0, Chromium 156.0.8078.79, Linux 6.18.60, Core i5-13500 (6 performance + 8 efficiency cores), shared machine. Viewport 1280×800, device scale 1, 14px local font (fontconfig monospace fallback: DejaVu Sans). Each run starts a new headless Chromium process with a private profile, GPU disabled, private debugging pipe and ephemeral loopback HTTP server. The harness strips TS from the selected root on request and boots a console-kind page/frame. No existing browser, edwind, external service or packaged startup.

**What ships:** the row-cache fix below, without the plain-row shortcut. The older comparisons explain why the shortcut and the earlier cache guards were reverted.

## Measurement

- Synthetic textarea keydown, actual command execution and DOM render. DOM time ends at Ed.whenIdle(). Frame time ends at the first requestAnimationFrame callback after idle (before paint); this is vsync-quantized, not physical input-to-photon. Check drawn DOM cursor against actual point after every key; no deliberate 16ms correction. A task after the prior rAF separates keys. The stream case starts the clock **before** a remote-origin Ed.applyOps tail append (4 lines, 168 UTF-16 units) then dispatches a left/right key in the same task; insertion must not move point/viewport, the selected window must hold its start, DOM+point must advance precisely one unit with the key. No transport/backend simulation.
- Scenarios: many-type inserts/deletes in a 40k-line doc scrolled halfway down; many-motion sends 100 down keys while the viewport tracks; long-type edits at col 6000 of ~12.3k-character lines in a 3.15M-unit doc; split-markdown-type uses two windows onto different parts of the same Markdown buffer (lists, inline markup, links, tags); folded-org-motion moves within a headline in Org overview (160 folds × 128 body lines); small-type fits all 24 lines in the viewport; stream-reader-motion is mid-doc, with producer appending to EOF. All truncate-lines; no native grid/desktop, giant wrapped line, IME, or application networking claim. Fixtures measure changed text on every typing key (half inserts and half Backspaces).
- Renderer CPU is summed `SystemInfo.getProcessInfo` CPU time delta (ms/100 keys, includes renderer work around frame boundaries), not process wall clock. Layout time is the CDP `LayoutDuration` delta for the measured keys. RSS sums private Chromium renderer processes at scenario end (Linux `/proc`, not PSS, peak or tab-only memory). `lexSeg` counts units *offered*, not necessarily analyzed; Markdown also counts classified units. Each run/scenario has 20 warmup keys followed by 100 measured keys, with nearest-rank percentiles.

## Row-cache fix

Ten pairs of runs compared **B** (`d691a98889`, before the fix) with **C** (the cache fix in `bf980f5807`, before the byte-table and key-prefix changes). Order alternated BC, CB. Each browser ran all seven scenarios, with 20 warmup and 100 measured keys per scenario. The benchmark sends a synthetic key through the editor and checks the drawn cursor. DOM time ends when the edit and redisplay are idle; frame time ends at the next animation-frame callback, **before paint**. Neither measures physical keyboard-to-screen latency.

Frame time in milliseconds, **p50 / p95 / p99**. Before and after are medians of the ten runs' percentiles. The last column takes the difference *within each pair* first; positive means slower.

| Scenario | Before | After | Median paired change |
|---|---:|---:|---:|
| Large-document typing | 15.40 / 17.70 / 19.20 | 15.55 / 17.50 / 18.75 | +0.25 / −0.20 / −0.45 |
| Long-line typing | 22.45 / 34.00 / 40.85 | 22.75 / 34.15 / 38.25 | +0.55 / −0.45 / −4.10 |
| Split Markdown typing | 15.00 / 17.30 / 19.40 | 14.70 / 16.85 / 18.65 | −0.25 / −0.50 / −0.30 |
| Small-document typing | 15.35 / 17.75 / 19.50 | 15.50 / 17.30 / 19.10 | 0 / −0.75 / +0.10 |
| Large-document motion | 14.45 / 17.95 / 20.60 | 14.70 / 16.85 / 18.60 | +0.30 / −0.85 / −2.25 |
| Folded Org motion | 15.10 / 17.10 / 19.15 | 15.05 / 16.70 / 18.40 | +0.05 / −0.55 / −0.80 |
| Streaming-reader motion | 15.40 / 17.75 / 19.30 | 15.40 / 17.25 / 19.60 | 0 / −0.25 / +0.45 |

Large-document typing reached the next frame later at p50 in **7/10 pairs** (median **+0.25 ms**), despite better p95 and p99. Split Markdown took longer to finish DOM redisplay at p99 in **6/10 pairs** (median **+1.40 ms**), even though its frame p99 did not rise overall. We accepted that tradeoff to fix five wrong-row cases, not as a typing speedup. See `row-cache` in the [per-run measurements](performance-display-pairs.csv) and [paired differences](performance-display-contrasts.csv).

## Isolating the redisplay change

| Arm | Source served to the browser |
|---|---|
| A | Pristine baseline `c1fe9eec` |
| H | Reviewed branch head `d8c8a65f` |
| R | H minus the production changes in `409a0fc` and `16fcd79`, in that order: the renderer used before the row-cache fix, with H's exact search, incremental search and sync changes. |
| G | Candidate based on H: ordinary rows use per-character classification; only visible text rows ≥8,192 UTF-16 units qualify for plain-row shortcut. No shortcut for styled rows. The reviewed cache separation remains, with a shorter key encoding. |
| F | Baseline row builder on **all** rows, including long unstyled ones. R plus a render-context guard and HTML-offset distinction to retain row-cache correctness. |
| V | Rejected guard-only version `270691ef`: R's row builder with altered cache keys and a snapshot check for mutable external lexer class names. No plain-row shortcut. |

**Three-arm design.** One block runs A, H and R serially; one fresh browser per arm runs the seven scenarios in harness order. Blocks 1–10: `AHR RHA HRA ARH RAH HAR AHR HRA RAH RHA`. All six permutations occur; each arm occupies each position three or four times. H runs before A and before R in five blocks each. Same page commands, 20 warmups + 100 measured keys, no sampling profiler or coverage. The unit of comparison is the block, not a pool of 1,000 independent keys. H−A measures the whole branch; **H−R isolates the two redisplay changes together**. R−A is the control for the rest of the branch plus run-to-run variation. These contrasts cannot assign a cost independently to row classification and cache-key construction.

The browser series use the default scheduler on a **shared**, non-isolated host. A separate small replicated-buffer benchmark used an E-core mask, and the A/G period included separate core-type calibration runs. Those results are not browser samples in these tables. We did not trace individual keys' CPU placement or attribute individual stalls to co-running jobs.

### Default scheduler: did reverting redisplay restore the baseline?

[Per-block measurements](performance-display-pairs.csv) give scenario, order, position and all eight metrics for each arm. [Paired contrasts](performance-display-contrasts.csv) give the min/median/max for each arm and its **matched difference**, and all sign counts, including ties. DOM and next-rAF are ms/key; CPU and layout are ms/100 keys. No keys, scenarios, blocks or outliers discarded.

The table focuses on DOM p99. Absolute values are the median of each arm's ten p99s. Each contrast is the **median within-block delta**, followed by **higher/equal/lower** counts for its left arm (higher = slower); brackets give the range of the H−R delta. The difference of two arm medians is not the median paired difference. In this cohort those can be very different.

| Scenario | Absolute A / H / R | H−A; signs | H−R [min, max]; signs | R−A; signs |
|---|---:|---:|---:|---:|
| many-type | 1.80 / 3.85 / 1.95 | +0.80; 6/1/3 | −0.05 [−1.2, +3.6]; 4/1/5 | +0.40; 7/0/3 |
| many-motion | 3.10 / 4.95 / 3.25 | +0.20; 5/1/4 | +0.20 [−1.4, +2.5]; 5/0/5 | +0.20; 7/1/2 |
| long-type | 4.55 / 4.35 / 6.90 | −0.20; 4/0/6 | −2.35 [−5.4, +2.1]; 3/0/7 | +1.35; 8/2/0 |
| split-markdown-type | 1.90 / 3.70 / 2.05 | +0.45; 9/1/0 | +0.15 [−0.6, +2.7]; 7/1/2 | 0; 4/2/4 |
| folded-org-motion | 1.35 / 2.70 / 1.35 | +0.45; 7/1/2 | +0.50 [−0.5, +2.2]; 7/1/2 | 0; 5/0/5 |
| small-type | 1.35 / 2.80 / 2.00 | +0.20; 5/2/3 | −0.05 [−1.3, +1.8]; 3/2/5 | +0.10; 5/2/3 |
| stream-reader-motion | 1.00 / 1.95 / 1.40 | −0.05; 4/1/5 | −0.10 [−0.6, +1.4]; 3/1/6 | 0; 3/3/4 |

- **Styled rows:** H's split Markdown p99 exceeded A's in nine blocks. R was faster than H in six of those nine, at or below A in five. H−R split Markdown CPU was +50 ms/100 (9/1/0); layout +6.3 ms/100 (9/0/1). Folded Org: R improved on H in six of seven blocks with a p99 penalty, reaching A in three. R−A median p99 was zero in both scenarios. The reversal is selective, not universal.
- **Small typing and motion:** R improved small-type p99 in only two of the five penalized blocks; R improved many-motion p99 in all five, but reached A in only one. Both H−R CPU medians were zero (5/0/5 each). Small-type H−R rAF p99 was **+0.1 ms** (7/2/1); many-motion H−A rAF p99 was **−0.1 ms** (0/3/7). Do not assign the historical multi-ms p99 increases or hundreds of ms of renderer CPU solely to redisplay. Even unchanged A ranged from **240–1,020** ms CPU/100 on small typing and **500–1,310** on many-motion.
- **Long lines:** removing the shortcut lost a real median-latency benefit: H−R DOM p50 **−1.5 ms** (0/1/9); next-rAF p99 **−1.4 ms** (0/0/10). But H−R CPU was only −115 ms/100 (4/0/6) and layout was **+68.1 ms/100** (7/0/3). R itself was never faster than A on DOM p99 despite using the same renderer: these default-scheduler runs have substantial variation. No general frame-time or renderer CPU improvement follows.

### Does an 8,192-unit gate protect ordinary use?

A new default-scheduler cohort alternated AG, GA for ten blocks. G used the existing cacheability limit: ordinary cacheable rows took the per-character path; shortcut work was confined to long unstyled rows that could not be cached. The [exact G diff against H](performance-display-g.patch) is included for reproduction.

Each cell is **G−A, median within-block delta; higher/equal/lower** (DOM p99 also gives the delta range). All absolute min–max ranges overlapped, including long-type's. The earlier H−R and R−A deltas must not be paired with these G runs.

| Scenario | DOM p50 | DOM p95 | DOM p99 [range] | rAF p99 | Renderer CPU | Layout |
|---|---:|---:|---:|---:|---:|---:|
| many-type | −0.2; 4/1/5 | −1; 4/0/6 | −0.65 [−4, +5.1]; 4/0/6 | +0.15; 5/0/5 | −20; 3/1/6 | −1.44; 4/0/6 |
| many-motion | −0.4; 3/1/6 | −0.25; 4/1/5 | +0.05 [−6.5, +10.7]; 5/1/4 | +0.75; 7/0/3 | −15; 4/1/5 | −13.78; 3/0/7 |
| long-type | −5.05; 0/1/9 | −4.6; 2/0/8 | −3.5 [−18.7, +0.2]; 2/0/8 | −4.7; 0/1/9 | −1075; 2/0/8 | +37.31; 9/0/1 |
| split-markdown-type | 0; 4/3/3 | +0.1; 6/1/3 | +0.05 [−4.9, +4.9]; 5/1/4 | −0.2; 3/1/6 | +10; 5/1/4 | +1.47; 7/0/3 |
| folded-org-motion | −0.9; 1/1/8 | −1.7; 1/0/9 | −2.25 [−7.2, +0.3]; 2/0/8 | −0.45; 3/0/7 | −20; 3/0/7 | −30.26; 2/0/8 |
| small-type | +0.1; 6/1/3 | −0.2; 4/1/5 | −0.05 [−6.1, +1.6]; 4/1/5 | −0.4; 2/2/6 | +15; 6/0/4 | +6.63; 7/0/3 |
| stream-reader-motion | −0.05; 4/1/5 | 0; 4/3/3 | −0.05 [−11.2, +2.9]; 4/1/5 | −0.25; 4/0/6 | +15; 6/0/4 | −0.54; 5/0/5 |

Long-type clearly benefited in these pairs, except for layout. Small-type, split Markdown and many-motion DOM p99 had mixed signs, **not** proof of equivalence: many-motion rAF p95 increased in eight pairs (+0.55 ms median) and p99 in seven; small-type layout increased in seven. Identical A small-type p99 spanned 0.7–11.1 ms in this cohort. The [fixed-core row-builder measurements and same-code scheduling control](performance.md) distinguish smaller repeatable costs from this much larger end-to-end variability.

### Rejected cache guards after reverting the shortcut

F was a rejected intermediate: the old row builder plus a guard that serialized the external class-name table on every draw ([R→F patch](performance-display-f.patch)). A separate ten-block default-scheduler AF/FA cohort found mixed ordinary tails. F−A DOM p99 was **0** for small typing (4/2/4), **+1.0 ms** for many-motion (7/1/2), **−0.2 ms** for split Markdown (3/1/6), and **+0.25 ms** for folded Org (6/0/4). Small-type and many-motion CPU rose +35 and +50 ms/100 respectively (both 7/0/3). Split Markdown DOM p50 was +0.1 ms (7/2/1), layout +2.54 ms/100 (8/0/2). Long-type p50 had no median gain (2/4/4). All arm ranges overlapped. A separate controlled row-builder measurement still found a styled cost for F, motivating the cheaper snapshot guard in V; see [the controlled comparison](performance.md).

### Last guard-only candidate versus pristine baseline

Ten fresh AV/VA pairs; each cell is **V−A, median within-block delta; higher/equal/lower**. Every scenario's A/V ranges overlapped for all eight metrics. This is not an equivalence test: a noisy p99 or CPU estimate can still favor one arm in most blocks.

| Scenario | DOM p50 | DOM p95 | DOM p99 [range] | rAF p99 | Renderer CPU | Layout |
|---|---:|---:|---:|---:|---:|---:|
| many-type | +0.05; 5/2/3 | 0; 5/0/5 | 0 [−2, +0.3]; 5/0/5 | −0.1; 1/3/6 | −20; 4/0/6 | −0.89; 4/0/6 |
| many-motion | −0.1; 1/2/7 | −0.15; 4/0/6 | −0.3 [−2.6, +0.3]; 2/0/8 | −0.05; 3/2/5 | −40; 1/1/8 | −7.51; 2/0/8 |
| long-type | −0.05; 2/3/5 | 0; 4/3/3 | +0.15 [−1.3, +4.9]; 6/0/4 | −0.25; 4/0/6 | −5; 4/1/5 | −1.26; 4/0/6 |
| split-markdown-type | 0; 1/7/2 | 0; 3/3/4 | +0.1 [−3.2, +0.4]; 6/1/3 | −0.1; 1/1/8 | +20; 6/0/4 | −0.2; 4/0/6 |
| folded-org-motion | 0; 1/5/4 | −0.05; 3/2/5 | −0.1 [−2.9, +0.4]; 4/0/6 | +0.05; 5/4/1 | −20; 1/2/7 | −0.98; 4/0/6 |
| small-type | 0; 3/6/1 | +0.05; 5/3/2 | +0.15 [−1.7, +0.6]; 7/0/3 | −0.05; 3/2/5 | +25; 7/0/3 | +0.81; 6/0/4 |
| stream-reader-motion | −0.05; 2/3/5 | −0.1; 2/3/5 | −0.05 [−1.9, +0.8]; 1/4/5 | −0.1; 3/1/6 | −45; 3/0/7 | −3.65; 3/0/7 |

**Ordinary use:** small-type's absolute DOM p99 median was **1.3 ms in both arms**, with ranges 1.0–3.3 (A) and 1.2–3.5 (V). Nevertheless V's paired p99 and CPU were higher in **seven of ten**. Split Markdown also had a small positive matched p99 and CPU difference. Neither result establishes zero cost. Many-motion p99 and CPU were lower in eight pairs; folded Org p99 was lower in six. This is not the broad multi-ms slowdown in the earlier five-pair comparison, nor evidence of a new general speedup. **Long lines:** the absolute DOM p50 was 4.1 ms in both arms; the rejected shortcut's win is no longer present.

Across the four follow-up series, all **90 browsers × 7 scenarios = 630 measured runs** (63,000 measured keys) completed. Every run reported 200 layouts and zero Rope flattens; every stream run appended 16,800 units with the reader anchor and cursor checks enabled. These counters establish comparable work, not equivalent layout duration.

Protocol notes: the primary driver gained an optional coverage switch while the series was running; it was unset, so the page workload and timed CDP calls did not change. The primary shell reported a trailing parse error **after** all 210 expected scenario records had been written. No run was replaced. Subsequent series used the frozen H driver.

The historical cohort name `default-shipped` in the data and commands denotes **V**. That version was subsequently rejected; do not use those timings as a result for **R**.

### Reproducing the cohorts

From the repo root in Bash, on Linux with git, patch, Node 24 and Chromium. This creates isolated source trees; it does not revert the current checkout. Use a fresh output directory, not measurements from a previous run:

```bash
set -euo pipefail
root=$PWD/.display-study
mkdir "$root"; mkdir -p "$root"/{A,H,R,G,F,V,home,tmp}
for spec in A:c1fe9eec H:d8c8a65f R:d8c8a65f G:d8c8a65f F:d8c8a65f V:270691ef; do
  git archive "${spec#*:}" | tar -x -C "$root/${spec%:*}"
done
for rev in 409a0fc 16fcd79; do
  git show --format= "$rev" -- src/editor-core.ts | patch --reverse -p1 -d "$root/R"
done
patch -p1 -d "$root/G" < docs/performance-display-g.patch
cp "$root/R/src/editor-core.ts" "$root/F/src/editor-core.ts"
patch -p1 -d "$root/F" < docs/performance-display-f.patch
export HOME="$root/home" TMPDIR="$root/tmp" CHROMIUM=/path/to/chromium
unset SCENARIO PROFILE COVERAGE_DIR
for cohort in default default-gate default-guard default-shipped; do
  case $cohort in
    default) orders="AHR RHA HRA ARH RAH HAR AHR HRA RAH RHA" ;;
    default-gate) orders="AG GA AG GA AG GA AG GA AG GA" ;;
    default-guard) orders="AF FA AF FA AF FA AF FA AF FA" ;;
    default-shipped) orders="AV VA AV VA AV VA AV VA AV VA" ;;
  esac
  mkdir "$root/$cohort"; block=0
  for order in $orders; do
    block=$((block+1))
    for ((i=0; i<${#order}; i++)); do
      arm=${order:i:1}
      EDWIN_ROOT="$root/$arm" WARMUP=20 SAMPLES=100 \
        node "$root/H/tools/display-bench.mts" \
        > "$root/$cohort/$block-$((i+1))-$arm.jsonl"
    done
  done
done
```

Each JSON line contains the raw 100 `keyDomMs` and `keyFrameMs`, their nearest-rank summaries (`dom`, `frame`), `rendererCpuMs`, `layoutMs`, layout count and work counters. Match files by cohort and block and the rows by scenario. Subtract within the block **before** taking the median or counting signs. Use the arithmetic mean of the two middle values for an even number of runs. The separate CPU-type calibration uses identical code and is not pooled with these default-scheduler series.

## Initial ranking (before production edits)

Historical baseline scouting pass (not pooled below): long-type had the largest key→DOM p50/p95/p99, 9.5/10.1/10.4 ms, at 2020 ms renderer CPU per 100 keys. A separate CPU profile sampled `eolS` 588 times and `renderBuffer` 453 times, compared with 255 for `getBoundingClientRect` and 44 for `syncLines`. A sample names a function, not a source-line cost. The baseline fixture allocated 83,592,700 bytes of flags per 100 keys (sum of segment length + 1). That motivated the rejected shortcut. The benchmark timings do not enable the profiler.

Scrolling remained a separate candidate (283 samples in `getBoundingClientRect`, 41 in `insertBefore` on downward motion). There is no timed prototype showing that changing node reuse or layout decisions pays off. No reconciliation, Markdown lexing or fold semantics were changed.

## Five cache failures on the baseline

These are correctness reproductions, not timing runs. Each compares `Ed.renderBuffer` with and without the previous draw's cache. All five assertions failed on pristine `c1fe9eec` and passed with the removed guards (`270691ef`). The first three use `hooks.lexSeg`; the last two request HTML and runs together. They demonstrate behavior of that renderer API, not the frequency of these inputs in stock frames.

1. Render `xy`, point 0, lexer IDs `[1,1]`, names `['a','b']`; rename `names[1]` to `renamed` and redraw with the cache.\
   **Wrong:** cursor and text spans/runs still use `b`; a fresh draw uses `renamed`.
2. Same first draw; prepend `''` to the names and delete slot 0, leaving a hole before `'a','b'`. Redraw with unchanged IDs.\
   **Wrong:** ID 1 still paints as `b`; the new table maps it to `a`.
3. Give IDs 1 and 257 the names `b` and `cursor-face`. Prime at point 0 with IDs `[1,1]`, then change just the first ID to 257.\
   **Wrong:** the cached cursor still uses `b`; the fresh cursor uses `cursor-face`.
4. Render `x\nsame` at point 0 with `{lines:false, runs:true}`. Insert `x` at offset 0 and redraw with the previous cache.\
   **Wrong:** the `same` span keeps absolute `data-o="2"`; its new start is 3.
5. Render `x\nsame` at point 0 with `{runs:true}`. Reuse its cache with `{lines:false, runs:true}`, without editing.\
   **Wrong:** the `same` span keeps line-relative `data-o="0"` where absolute offset 2 is required.

The `x` / `|p||0|0|x` collision was **not** a baseline failure. Its test, the warm-cache span/run comparisons and the changed fold-ellipsis test all pass with the baseline keys and remain in `test/display.test.mts`.

## Historical comparison: five interleaved pairs

Earlier comparison, default scheduler: A = baseline `c1fe9eec`; B = reviewed code `409a0fc8` (production code unchanged at `d8c8a65f`). Order: **A1 B1 B2 A2 A3 B3 B4 A4 A5 B5**. No exclusions. In **this table only**, percentiles pool all 500 individual measured keys/scenario/version; CPU/RSS are the median [range] of five runs. Every arrow is baseline → reviewed code. Navigation through on-demand strip, boot, idle and first rAF took 178.4 [148.9–536.5] → 173.1 [153.1–384.3] ms. This does not establish a packaged startup improvement.

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

**What prompted the follow-up:** long-type DOM p50 fell in all five pairs (4.1→1.5, 9.8→3.1, 4.1→3.2, 4.1→2.6, 4.2→3.5 ms); pooled DOM p95 and p99 also fell. Renderer CPU was lower in three of five pairs (1120→600, 2100→880, 1140→1250, 1270→980, 1210→1230 ms/100). Pairs 3 and 4 had **higher** long-type DOM p99 despite the pooled result. Across all seven scenarios there were zero Rope flattens. Every stream append preserved the reader anchor and drawn cursor; 16,800 units were appended per measured run.

**Historical negative results:** the largest pooled DOM p99 increase was small-type (+3.3 ms), followed by split Markdown (+3.2), folded Org (+2.6) and many-motion (+1.4). Small-type rAF p99 rose 16.8→18.3 ms; many-motion renderer CPU rose 510→860 ms/100. Layouts numbered 200 per case for both versions, but e.g. small-type median layout duration rose 34.7→78.5 ms. These uncontrolled end-to-end pairs cannot isolate the effects of the two redisplay commits, other commits or host variability. They are not pooled into the three-arm follow-up.

### Reproducing the historical comparison

With baseline `c1fe9eec` under `.review/base`, reviewed `409a0fc8` under `.review/reviewed`, and a Node 24+ binary on `PATH`:

```sh
set -e
export CHROMIUM=/path/to/chromium TMPDIR="$PWD/.review/tmp"
mkdir -p "$TMPDIR"
for run in A1 B1 B2 A2 A3 B3 B4 A4 A5 B5; do
  case $run in A*) root=.review/base ;; B*) root=.review/reviewed ;; esac
  EDWIN_ROOT=$root node tools/display-bench.mts > ".review/display-$run.jsonl"
done
```

The defaults measure all seven scenarios, 20 warmups + 100 measured keys each. Each JSON line carries raw `keyDomMs`, `keyFrameMs`, fixture and counters; group by scenario and root to pool timings. `PROFILE=1 SCENARIO=long-type` enables a separate diagnostic profile; do not include that run in the timing comparison.

