# Edwin performance measurements

## Reproduce

Run from the repository root with Node 24.21 (or compatible Node 24). The replica and standalone-front harnesses need `server`'s pinned dependencies (`npm ci --prefix server`); strip once as the package does: `node tools/strip.mts --in-place src native/js`. No new runtime or npm dependency. Display needs a Chromium executable. Front/replica resource counters use Linux `/proc`; replica also needs `getconf`.

```sh
node tools/text-bench.mts small
node tools/text-bench.mts large
node tools/front-start-bench.mts
CHROMIUM=chromium node tools/display-bench.mts
node tools/replica-bench.mts
```

Text: optional second argument `index`, `find`, `miss` or `replace`; e.g. `node --cpu-prof tools/text-bench.mts large replace`. Display: `SCENARIO`, `SAMPLES`, `WARMUP`; use `PROFILE=1` for a separate sampling run. Replica: put `TMPDIR` on the filesystem to measure; the temporary daemon and sockets are not the installed service. Each harness checks the result of the work, prints JSON, and has no timing pass/fail thresholds. Compare the **same harness** against different source trees (display: `EDWIN_ROOT`, replica: positional source directory, text: put the script in each tree's `tools/`).

Baseline: `c1fe9eec`; final measured code: `409a0fc8`. Linux 6.18.60, x86-64, 20 logical CPUs available, ext4, concurrent unrelated builds. No CPU isolation, cold OS cache flush, or attempt to tune the machine. Before/after runs interleaved; profiles separate from timing. Counters are preferable to small changes in wall time. No hardware instruction or lock-wait counters collected. A whole-rope join counts an actual document-sized string allocation, not every allocation V8 makes. RSS includes runtime and GC; don't interpret process high-water marks as retained bytes per buffer.

## Ranked findings

|Priority|Observed cost on the unchanged tree|Decision, expected gain and risk|
|---|---|---|
|1. Exact replace after edits|16 MiB, 16 sparse replacements: 16 full joins **per command**. CPU profile: 4,115 samples in `Rope.toString`, 680 in GC, 49 in `searchStr`.|Use the rope's existing exact-match search. Removes up to 256 MiB of joined text per command on this ASCII fixture. Low risk: preserve Scheme bounds/direction/match data; retain whole-string Unicode lowercasing and avoid many-chunk overlap for very long needles.|
|2. Long-line browser redisplay|Typing on 12 Ki-character lines: key-to-DOM p50 9.5 ms; 83.59 M visible segment code units passed through 100 renders. Profiler: 588 `eolS` and 453 `renderBuffer` samples.|Avoid per-character work for unstyled rows; reserve time for layout/paint. Higher parity risk: selection, escapes, end-of-line faces, model output and cursor overlays.|
|3. Replica edits on the frame|4 MiB acknowledged revision: ~2.2 ms median for either ack or remote handler; small file <0.1 ms. Initial 96 large edits: 335 ms client CPU vs 80 ms daemon CPU.|Keep a separate chunked acknowledged text after its first mutation. Removes a document-size string copy from a common per-key path. Medium risk: pending local work, invalid batches, hash/reconnect/pending-state persistence.|
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

Process CPU through GET p50 137.1 → 135.7 ms; peak RSS p50 98,780 → 98,892 KiB; kernel read characters p50 1,703,331 → 1,707,132, block-device read bytes zero. Listening p50 across batches 79.1–210.0 → 79.9–131.9 ms. No startup code was changed or startup speedup established. The increase in read characters includes the larger shipped code.

## Browser, replica and daemon

[Browser measurements](performance-display.md) cover all seven display cases, including the split syntax-highlighted buffer, folded Org, and the reader whose buffer receives remote appends. [Replica measurements](performance-replica.md) cover private daemon startup, file open/attach, outgoing key → durable ack + peer fanout, incoming edit → applied frame, reconnect/replay, many open buffers and multiple subscribers.

|Optimization commit|Affected path|Before → after|
|---|---|---|
|`996b068`|Exact Scheme search (`replace-string`)|16 MiB, 24 commands: 384 → 0 whole-buffer joins; p50 81.0 → 2.96 ms|
|`750fd80`, `2290335`|Incremental literal search near point|16 MiB, 80 edit-then-searches: 80 → 0 joins; p95 6.98 → .074 ms|
|`77b99ac`|Frame's independent acknowledged text|4 MiB, client CPU for 96 warm local keys 307 → 51 ms; remote handler p99 7.27 → .21 ms; first ack p50 .026 → 1.29 ms|
|`16fcd79`, `409a0fc`|Unstyled redisplay and cache separation|12 Ki-character lines, renderer CPU / 100 keys 1210 → 980 ms; key → DOM p50 4.2 → 2.7 ms, p99 11.3 → 6.7 ms|

No change to the wire, on-disk journal or FS durability contract. The first large ack pays for chunking; warm ack and remote handlers benefit. Long-line DOM p50 decreased in all five pairs; renderer CPU decreased in three. Small-buffer and styled display tails did not share that improvement: DOM p99 rose from 3.1 to 6.4 ms for small-file typing, 3.8 to 7.0 ms for split Markdown, and 3.0 to 5.6 ms for folded Org. Many-line motion p99 rose from 4.6 to 6.0 ms. No general scroll, syntax/folding, startup, RSS or idle-daemon CPU speedup. Browser timing ends at the DOM or the next rAF, **not** the physical display.

Next investigations: measure scroll reconciliation independently of layout; test wrapped mega-lines on an actual display; profile repeated **far** case-insensitive misses with Unicode offsets before introducing another search algorithm. Measure concurrent durable writers and slow receivers separately before changing journal batching or transport. The serialized latency measurements include queueing but do not isolate lock wait; process RSS and sampled GC are not exact object-allocation counts.

On the daemon, profile worker-pool initialization and idle collection before rewriting buffer storage. In a separate baseline trace, the last two pool threads became active during the small-file typing sample, and the daemon had 14 major GC events in the 10.5-second idle window. Those costs are not attributable to 64 small buffers. Measuring lazy worker startup would need first-command latency as well as startup RSS.

## Verification

Review regressions were exercised against the pre-review renderer/search and against disposable mutants where the shadow already behaved correctly:

- The old row key returned the wrong HTML for the reported cursor-class/text collision and reused obsolete lexer class names. The old search returned fractional or otherwise wrong offsets for non-index points; the flat pre-optimization path passed those cases.
- The shadow tests compare against flat `OT.apply`, `transformOps` and `hash` while driving a private daemon and a frame. Hashing the optimistic replica instead of the acknowledged text failed on a remote edit **and**, independently, on an ack while another edit was pending. Removing inverse rollback or dropping validation of the deletion's ending surrogate boundary each failed its regression. None of these faults was present in production.

On the final source, `node --test test/<name>.test.mts` ran sequentially: `headless` 27/27, `display` 22/22, `frame` 26/26. Then `nix flake check -L --max-jobs 1 --keep-going` completed with **all checks passed**, including typechecking. No performance threshold is part of a correctness gate.
