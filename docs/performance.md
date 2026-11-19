# Edwin performance measurements

## Reproduce

Run from the repository root with Node 24.21 (or compatible Node 24). The replica and standalone-front harnesses need `server`'s pinned dependencies (`npm ci --prefix server`); strip once as the package does: `node tools/strip.mts --in-place src native/js`. No new runtime or npm dependency. Display needs a Chromium executable. Front/replica resource counters use Linux `/proc`; replica also needs `getconf`.

```sh
node tools/text-bench.mts small
node tools/text-bench.mts large
node tools/front-start-bench.mts
CHROMIUM=chromium node tools/display-bench.mts
node tools/replica-bench.mts
node tools/replica-bench.mts . --small-typing
node tools/render-row-bench.mts . styled
```

Text: optional second argument `index`, `find`, `miss` or `replace`; e.g. `node --cpu-prof tools/text-bench.mts large replace`. Display: `SCENARIO`, `SAMPLES`, `WARMUP`; use `PROFILE=1` for a separate sampling run. Replica: put `TMPDIR` on the filesystem to measure; the temporary daemon and sockets are not the installed service. Each harness checks the result of the work, prints JSON, and has no timing pass/fail thresholds. Compare the **same harness** against different source trees (display: `EDWIN_ROOT`, replica: positional source directory, text: put the script in each tree's `tools/`).

Baseline `c1fe9eec`. The five-pair text, cold-front and large-replica tables measured `409a0fc8`; those paths have not changed since. The browser decision below compares `d8c8a65`, a pure redisplay revert, a long-only prototype and the final renderer (`270691ef`). Linux 6.18.60, x86-64, 20 logical CPUs, ext4, concurrent unrelated builds. No core reservation, OS cache flush or service tuning. Affinity is specified per experiment. No hardware instruction or lock-wait counters collected. A whole-rope join counts an actual document-sized string allocation, not every V8 allocation. RSS includes runtime and GC, not just retained buffers.

## Ranked findings

|Priority|Observed cost on the unchanged tree|Decision, expected gain and risk|
|---|---|---|
|1. Exact replace after edits|16 MiB, 16 sparse replacements: 16 full joins **per command**. CPU profile: 4,115 samples in `Rope.toString`, 680 in GC, 49 in `searchStr`.|Use the rope's existing exact-match search. Removes up to 256 MiB of joined text per command on this ASCII fixture. Low risk: preserve Scheme bounds/direction/match data; retain whole-string Unicode lowercasing and avoid many-chunk overlap for very long needles.|
|2. Ordinary redisplay vs the long-line opportunity|The initial long-line profile had 588 `eolS` and 453 `renderBuffer` samples. Skipping unstyled character keys helped long lines, but head vs pure revert cost a paired median **+50 ms renderer CPU/100 keys** on split Markdown; 9/10 blocks higher, one tie.|**Not shipped.** A length gate kept the long-line benefit, but did not meet the ordinary-use gate. Revert the shortcut, preserve cache correctness. Avoid generalizing the five-pair small-buffer degradation to all rows: even on unchanged source the machine produced large swings.|
|3. Replica edits on the frame|4 MiB acknowledged revision: ~2.2 ms median for either ack or remote handler in scouting. In two controlled 4 KiB comparisons, the rope cost 4–6 µs of median synchronous ack dispatch.|Keep the independent acknowledged rope. Large warm edits no longer copy a document-sized string. The first large mutation and a small ordinary handler cost are real; total small-file CPU did not move consistently.|
|4. Nearby incremental search after edits|A five-character smart-case search near point still joined all 16 MiB once per search. 80 searches: 484 ms CPU in the initial sample.|Probe 2,048 candidate starts around point with enough overlap for the literal; a far folded search resumes on a flat string. Low scope, but test both directions and Unicode.|
|5. Full misses, vertical scrolling, startup & durable I/O|Full miss on 16 MiB ~5–6 ms median. Browser scroll attribution includes DOM layout. Replay of 12 durable edits typically <1 ms after hello. Each durable batch already carries a journal append, not a file snapshot.|Not all linear work is avoidable: a miss must inspect the text. Investigate retained-row moves and repeated far/missing queries separately. Changing acknowledgement timing, removing a sync, or altering snapshot encoding is not an equivalent optimization.|

The underlying buffer already has ~2 Ki-character chunks and lazily maintained prefix/newline sums. On 16 MiB, an interior overwrite followed by point→line→start had a baseline p95 of 0.026 ms (median of runs) and no joins. A new tree/index would not address the measured pauses.

## Text workloads

Independent process per size/run; four warmups per row. Five interleaved pairs (`BA AB BA AB BA`, B = `c1fe9eec`, A = corrected code). Fixed 8 KiB or 16 MiB input, 16 occurrences at regular intervals. `index`: overwrite near midpoint, read line number and start. `find`: edit, then issue real isearch keys for `token` and RET, alternating directions near `Token`. `miss`: edit then search forward from the beginning for absent `z`. `replace`: invoke shipped Scheme `replace-string`, replacing all 16 `Token` with `Value` or vice versa. Wall time includes command dispatch where used; no DOM, daemon or file I/O.

Each cell is **before → after**, the median across five runs of the indicated statistic. CPU is user + system ms **for all N commands**; throughput is commands/s; Linux VmHWM is the cumulative high-water mark to the end of that row, MiB. ASCII fixture sizes are UTF-16 code units, not a general bound on V8 bytes.

|Size / workload|N/run|p50 ms|p95 ms|p99 ms|CPU ms|commands/s|joins/run|peak MiB|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|8 KiB index|240|.004 → .003|.012 → .009|.043 → .022|6.9 → 2.3|88178 → 231812|0 → 0|116 → 113|
|8 KiB find|80|.042 → .039|.105 → .067|.763 → .093|9.8 → 7.1|15908 → 23105|80 → 0|116 → 114|
|8 KiB miss|40|.016 → .015|.026 → .030|.034 → .053|1.8 → 2.9|55980 → 43887|40 → 40|116 → 114|
|8 KiB replace|24|.125 → .140|.314 → .203|.632 → .320|12.8 → 11.4|6736 → 6644|384 → 0|116 → 116|
|16 MiB index|240|.011 → .012|.021 → .020|.039 → .052|13.2 → 14.7|35405 → 35068|0 → 0|132 → 133|
|16 MiB find|80|4.821 → .047|6.980 → .074|23.167 → .103|516.4 → 9.1|178 → 19811|80 → 0|485 → 149|
|16 MiB miss|40|5.739 → 5.692|7.654 → 7.939|11.015 → 12.109|269.8 → 276.7|156 → 160|40 → 40|532 → 358|
|16 MiB replace|24|80.964 → 2.960|96.975 → 6.139|103.311 → 6.440|2177.6 → 94.1|11.9 → 291.7|384 → 0|597 → 455|

Run spread (min–max of p50s): 16 MiB find 4.37–7.95 → .042–.051 ms; replace 76.3–118.1 → 2.60–3.28; index .010–.025 → .010–.021; miss 5.24–6.96 → 5.09–6.83. A miss still needs one full join; its p95 and CPU were slightly worse. No demonstrated index or general small-buffer improvement. Small find p99 is the maximum of 80 and varied .102–2.691 → .089–3.050 ms. The search guard keeps invalid start offsets off the chunk path; the benchmark uses valid offsets, while `test/headless.test.mts` covers fractional, negative and oversized offsets.

## Standalone web front

`tools/front-start-bench.mts` starts a **fresh process per observation**, loads `server/front.mts`, has its production `start()` preload the pre-stripped JS/Scheme/console assets and listen on an ephemeral loopback port, completes an authorized GET of `/`, checks its byte count, and stops. This includes Node startup and the benchmark's TS entry point, not the reverse proxy, CLI config parsing, a WebSocket, or a browser. Filesystem cache warm, `NODE_COMPILE_CACHE` unset. Five interleaved pairs of 12 fresh processes per revision (`BA AB BA AB BA`); pooled nearest-rank percentiles over 60 observations per side:

|Spawn to|Baseline p50/p95/p99 ms|After p50/p95/p99 ms|
|---|---:|---:|
|Listening|86.3 / 216.0 / 274.2|86.6 / 179.4 / 187.6|
|Root page received|93.9 / 233.2 / 292.3|93.3 / 195.0 / 203.3|

At `409a0fc8`, process CPU through GET p50 was 137.1 → 135.7 ms; peak RSS p50 98,780 → 98,892 KiB; kernel read characters p50 1,703,331 → 1,707,132, block-device read bytes zero. Listening p50 across batches 79.1–210.0 → 79.9–131.9 ms. No startup code was changed or startup speedup established. The byte counts are for that revision's assets, not a remeasurement after the redisplay revert.

## Browser, replica and daemon

[Browser measurements](performance-display.md) cover all seven display cases, including the split syntax-highlighted buffer, folded Org, and the reader whose buffer receives remote appends. [Replica measurements](performance-replica.md) cover private daemon startup, file open/attach, outgoing key → durable ack + peer fanout, incoming edit → applied frame, reconnect/replay, many open buffers and multiple subscribers.

|Optimization commit|Affected path|Before → after|
|---|---|---|
|`996b068`|Exact Scheme search (`replace-string`)|16 MiB, 24 commands: 384 → 0 whole-buffer joins; p50 81.0 → 2.96 ms|
|`750fd80`, `2290335`|Incremental literal search near point|16 MiB, 80 edit-then-searches: 80 → 0 joins; p95 6.98 → .074 ms|
|`77b99ac`|Frame's independent acknowledged text|4 MiB, client CPU for 96 warm local keys 307 → 51 ms; remote handler p99 7.27 → .21 ms; first ack p50 .026 → 1.29 ms|
|`16fcd79`, `409a0fc` → **reverted** by `270691ef`|Ordinary and long-row redisplay|Reviewed head vs head minus redisplay: long-line DOM p50 −1.50 ms (9 lower, 1 tie); split Markdown renderer CPU +50 ms/100 keys (9 higher, 1 tie). Paired medians, not pooled keys.|

No change to the wire, journal or FS durability contract. Three production optimizations remain: exact Scheme search, nearby incremental search and the frame's independent acknowledged text. For ordinary replicated typing (4 KiB, 10 interleaved triples, 960 keys/tree), **baseline → head** durable ack p50/p95/p99 was **3.393/8.865/16.104 → 3.322/8.288/21.183 ms**. Mean driver CPU/96 keys was 48.26 → 45.78 ms. In two head/flat-shadow controls, typical ack dispatch really was slower (18/20 paired medians higher); total CPU changed direction. The multi-ms p99 waits were outside synchronous dispatch, not evidence that the rope costs milliseconds to splice. [Per-pair durable results and controls](performance-replica.md).

### Why revert redisplay?

The old five-pair pooled display regressions were real observations but not all causal. The [browser report](performance-display.md) gives the per-block measurements (including p50/p95/p99, rAF, CPU and layout), all seven workloads, and inputs for the discarded candidates. Each comparison below has ten interleaved blocks, 100 measured keys per browser and scenario, 20 warmup. `A` = baseline, `H` = `d8c8a65`, `R` = H minus both display commits. `G` = experimental long-only path. `F` and final `V` have **no** plain-row optimization at any length; unlike the literal revert R, they retain the previously settled cache-correctness fixes.

1. **There is an attributable ordinary cost.** Split Markdown: H−A DOM p99 +0.45 ms (higher/tied/lower 9/1/0), R−A 0 (4/2/4). H−R renderer CPU +50 ms/100 keys (9/1/0), layout +6.33 ms (9/0/1). Folded H−R p99 +0.50 ms (7/1/2). In contrast, H−R small-type CPU was tied at the paired median (5/0/5); many-motion CPU also split 5/0/5. Those comparisons do not reproduce the previously reported +260 and +350 ms/100 as causal effects.
2. **The other optimizations did not do the work.** Separate CDP block coverage during eight measured keys in each scenario: 112 `renderBuffer` calls, no `searchStr`, `foldedIsearch` or `applyToShadow` calls. The rope's `indexOf`/`lastIndexOf` were called 3,648/536 times, but both returned before the changed long-needle branch in every call. Test with `COVERAGE_DIR=./coverage WARMUP=4 SAMPLES=8 EDWIN_ROOT=... CHROMIUM=... node tools/display-bench.mts`; coverage starts before script compilation, resets after warmup. Do not time that run.
3. **The machine can move those metrics without a source change.** Same `A`, ten alternating P-first/E-first pairs, two physical CPUs of one kind for the entire private browser and driver (`taskset -c 8,10` or `16,18`). Per-run median renderer CPU: small-type 525 vs 590 ms/100 (E higher 10/10); many-motion 870 vs 1,065 (9/10). Many-motion DOM p99 10.95 vs 15.30 ms (8/10); small-type layout time moved the *other* way, 100.1 vs 79.4 ms (E higher 2/10). These two-core calibration runs are not directly comparable to unrestricted runs. They establish sensitivity to placement/contention, **not** where an earlier unpinned process ran or a complete explanation of its tails.
4. **Restricting the shortcut was not enough.** `G` skipped only unstyled rows whose text length was at least 8,192 UTF-16 units: the actual cache boundary, where the next row is no longer cached and the isolated saving is large (table below). The short-row/classified builder again filled the old per-character keys and scanned spans; cache identity still had to distinguish mode faces and arbitrary text. Long-type DOM p50 improved by a paired median 5.05 ms; all four ordinary DOM p99 ranges overlapped baseline. But many-motion rAF p95 was **higher in 8/10** (one tie, median +0.55 ms), and the fixed-core 512- and 8,191-unit rows below cost more in **10/10**. Do not trade these costs for uncommon long lines.
5. **Revert, not a tuned threshold.** `V` restores the pre-optimization flags, per-unit keys and complete span scan even on huge plain rows. A literal revert of the cache fix would reintroduce stale HTML for mutable external lexer names. `F` kept the guard as an encoded table, but even two short Markdown views built that string from 47 names each render. `V` compares names to a shallow snapshot (including sparse slots) and only copies on change. Cursor/fold text boundaries, wide cursor faces and minibuffer offsets remain unambiguous. All original cache regression tests remain. Search and sync were not reverted.

**Separating editor CPU from layout.** `taskset -c 19 node tools/render-row-bench.mts TREE plain` or `styled` on this host. Ten fresh A/candidate pairs per column, alternating order, Node 24, main-thread CPU via `process.threadCpuUsage()`, no browser. Plain: move point in a 40-row cached view, one cursor row changes per draw. Styled: edit and render two 15-row Markdown views, or move and render 33 folded Org rows. Median **µs per iteration**; `(n)` = candidate slower in n/10 pairs. Each cell has its **own contemporaneous baseline**. This is attribution, not a key-to-DOM measurement.

[Individual CPU attribution and same-binary placement control pairs (CSV)](performance-cpu-controls.csv). `P-E` columns compare the same source on P then E cores, not two revisions; `order` is the actual order of the two invocations.

|Fixture|A → H|A → G|A → V (shipped)|
|---|---:|---:|---:|
|54-unit rows|63.5 → 25.1 (0)|63.1 → 60.8 (1)|64.0 → 64.1 (5)|
|512-unit rows|296.5 → 50.8 (0)|292.5 → 318.0 (10)|296.4 → 301.9 (8)|
|8,191-unit rows|3855 → 622 (0)|3815 → 4060 (10)|3892 → 3876 (5)|
|8,192-unit rows|3844 → 42 (0)|3824 → 41 (0)|3824 → 3948 (10)|
|12,288-unit rows|5774 → 78 (0)|5715 → 62 (0)|5735 → 5881 (10)|
|Split Markdown|248.5 → 259.9 (9)|247.4 → 251.0 (8)|250.5 → 249.7 (4)|
|Folded Org|227.4 → 233.6 (6)|218.5 → 209.9 (2)|225.2 → 222.4 (4)|

Do not infer a universal zero cost for `V`: measured CPU at 512 units was +5.5 µs per **40-row draw**, and the uncached 8,192/12,288-unit rows were slower than pristine baseline in all ten pairs. The table measures the whole render call, not the isolated cost of a single instruction or guard. `F`'s split Markdown control was 251.0 → 260.0 µs (9/10 higher), vs 4/10 with `V`. Restoring the old renderer deliberately relinquishes the long-line benefit. Further work on long lines should be isolated from ordinary classified-row cache handling from the outset.

**What the final browser actually did.** Paired median `V−A`, positive = slower; counts in parentheses are higher/tied/lower in the ten blocks. All eight absolute metric ranges overlapped in every scenario. Small-type median and p95 showed little direction, but p99 and CPU were higher in seven blocks: overlapping ranges do **not** prove equivalence. Conversely the large historical ordinary slowdowns did not repeat. Long-line p50 is now essentially baseline, as expected from the revert.

|Scenario|Key → DOM p99 delta (ms)|Renderer CPU delta (ms/100 keys)|
|---|---:|---:|
|Small typing|+0.15 (7/0/3)|+25 (7/0/3)|
|Many-line motion|−0.30 (2/0/8)|−40 (1/1/8)|
|Split Markdown typing|+0.10 (6/1/3)|+20 (6/0/4)|
|Folded Org motion|−0.10 (4/0/6)|−20 (1/2/7)|
|Long-line typing|+0.15 (6/0/4)|−5 (4/1/5)|

Next investigations: measure scroll reconciliation independently of layout; test wrapped mega-lines on an actual display; profile repeated **far** case-insensitive misses with Unicode offsets before introducing another search algorithm. Measure concurrent durable writers and slow receivers separately before changing journal batching or transport. The serialized latency measurements include queueing but do not isolate lock wait; process RSS and sampled GC are not exact object-allocation counts.

On the daemon, profile worker-pool initialization and idle collection before rewriting buffer storage. In a separate baseline trace, the last two pool threads became active during the small-file typing sample, and the daemon had 14 major GC events in the 10.5-second idle window. Those costs are not attributable to 64 small buffers. Measuring lazy worker startup would need first-command latency as well as startup RSS.

## Verification

Review regressions were exercised against the pre-review renderer/search and against disposable mutants where the shadow already behaved correctly:

- The old row key returned the wrong HTML for the reported cursor-class/text collision and reused obsolete lexer class names. The old search returned fractional or otherwise wrong offsets for non-index points; the flat pre-optimization path passed those cases.
- The shadow tests compare against flat `OT.apply`, `transformOps` and `hash` while driving a private daemon and a frame. Hashing the optimistic replica instead of the acknowledged text failed on a remote edit **and**, independently, on an ack while another edit was pending. Removing inverse rollback or dropping validation of the deletion's ending surrogate boundary each failed its regression. None of these faults was present in production.

On the final renderer (`270691ef`), `node --test test/<name>.test.mts` ran the touched suites one at a time: `scheme-editor` **20/20**, `headless` **27/27**, `display` **22/22**, `frame` **26/26**. No performance threshold is part of a correctness gate.

Then `nix flake check -L --max-jobs 1 --keep-going` finished with **all checks passed**, including typechecking.
