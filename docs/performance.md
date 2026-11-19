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

Baseline: `c1fe9eec`. Linux 6.18.60, x86-64, 20 logical CPUs available, ext4, concurrent unrelated builds. No CPU isolation, cold OS cache flush, or attempt to tune the machine. Before/after runs interleaved; profiles separate from timing. Counters are preferable to small changes in wall time. No hardware instruction or lock-wait counters collected. A whole-rope join counts an actual document-sized string allocation, not every allocation V8 makes. RSS includes runtime and GC; don't interpret process high-water marks as retained bytes per buffer.

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

Independent process per size/run; four warmups per row. Order B/A/B/A/B/A. Fixed 8 KiB or 16 MiB input, 16 occurrences at regular intervals. `index`: overwrite near midpoint, read line number and start. `find`: edit, then issue real isearch keys for `token` and RET, alternating directions near `Token`. `miss`: edit then search forward from the beginning for absent `z`. `replace`: invoke shipped Scheme `replace-string`, replacing all 16 `Token` with `Value` or vice versa. Wall time includes command dispatch where used; no DOM, daemon or file I/O.

Each cell is **before → after**, the median across three runs of the indicated statistic. CPU is user + system ms **for all N commands**; throughput is commands/s; Linux VmHWM is the cumulative high-water mark to the end of that row, MiB. ASCII fixture sizes are UTF-16 code units, not a general bound on V8 bytes.

|Size / workload|N/run|p50 ms|p95 ms|p99 ms|CPU ms|commands/s|joins/run|peak MiB|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|8 KiB index|240|.004 → .004|.009 → .013|.030 → .048|2.4 → 3.8|206717 → 80144|0 → 0|113 → 123|
|8 KiB find|80|.048 → .050|.089 → .084|.125 → 1.443|10.1 → 10.9|19033 → 14079|80 → 0|113 → 129|
|8 KiB miss|40|.017 → .014|.035 → .024|.344 → .033|4.0 → 1.5|36461 → 59209|40 → 40|113 → 129|
|8 KiB replace|24|.172 → .119|.325 → .180|.541 → .404|13.4 → 11.6|5028 → 7278|384 → 0|117 → 129|
|16 MiB index|240|.011 → .013|.026 → .023|.050 → .050|13.9 → 15.8|36422 → 34171|0 → 0|132 → 141|
|16 MiB find|80|4.656 → .044|10.584 → .074|23.926 → .101|494.6 → 8.4|183 → 20449|80 → 0|468 → 157|
|16 MiB miss|40|5.534 → 5.703|7.801 → 7.706|18.009 → 17.354|268.1 → 282.6|160 → 157|40 → 40|469 → 351|
|16 MiB replace|24|86.106 → 3.215|104.414 → 6.777|105.825 → 7.201|2328.7 → 104.9|11.2 → 261.8|384 → 0|609 → 448|

Run spread (min–max of p50s): 16 MiB find 4.40–5.31 → .044–.045 ms; replace 81–130 → 2.92–3.28; index .010–.020 → .011–.018; miss 5.29–6.10 → 5.41–6.09. Large miss CPU was slightly worse; still one full join per miss. No demonstrated index improvement. Small find p99 is also the maximum of 80, .102–.142 → .108–1.570 ms; reduced joins but **not** reduced small-buffer latency. Isolating replace in fresh processes (no earlier workload's GC/JIT state): alternating A/B/A on 16 MiB gave 154,760–154,944 KiB peak after vs 542,508 KiB before. Small-file RSS differences include pre-workload process footprint, not just this command's allocations.

## Standalone web front

`tools/front-start-bench.mts` starts a **fresh process per observation**, loads `server/front.mts`, has its production `start()` preload the pre-stripped JS/Scheme/console assets and listen on an ephemeral loopback port, completes an authorized GET of `/`, checks its byte count, and stops. This includes Node startup and the benchmark's TS entry point, not the reverse proxy, CLI config parsing, a WebSocket, or a browser. Filesystem cache warm, `NODE_COMPILE_CACHE` unset. Two batches of 12 fresh processes per revision, B/A/A/B:

|Spawn to|Baseline p50/p95/p99 ms|After p50/p95/p99 ms|
|---|---:|---:|
|Listening|85.1 / 98.9 / 137.8|84.1 / 94.3 / 97.5|
|Root page received|91.5 / 106.5 / 148.2|90.8 / 100.7 / 104.3|

Process CPU through GET p50 137.8 → 130.4 ms; peak RSS p50 98,848 → 99,144 KiB; kernel read characters p50 1,703,331 → 1,706,034, block-device read bytes zero. Listening p50 across batches 82.8–87.7 → 82.3–84.1 ms. No startup code was changed or startup speedup established. The small increase in read characters includes the larger shipped code.

## Browser, replica and daemon

[Browser measurements](performance-display.md) cover all seven display cases, including the split syntax-highlighted buffer, folded Org, and the reader whose buffer receives remote appends. [Replica measurements](performance-replica.md) cover private daemon startup, file open/attach, outgoing key → durable ack + peer fanout, incoming edit → applied frame, reconnect/replay, many open buffers and multiple subscribers.

|Optimization commit|Affected path|Before → after|
|---|---|---|
|`996b068`|Exact Scheme search (`replace-string`)|16 MiB, 24 commands: 384 → 0 whole-buffer joins; p50 86.1 → 3.22 ms|
|`750fd80`|Incremental literal search near point|16 MiB, 80 edit-then-searches: 80 → 0 joins; p95 10.58 → .074 ms|
|`77b99ac`|Frame's independent acknowledged text|4 MiB, client CPU for 96 warm local keys 202 → 39 ms; remote handler p99 6.26 → .097 ms|
|`16fcd79`|Unstyled redisplay|12 Ki-character lines, renderer CPU / 100 keys 1510 → 715 ms; key → DOM p50 4.8 → 2.4 ms, **p99 9.5 → 13.9 ms**|

No change to the wire, on-disk journal or FS durability contract. The first large ack now pays for chunking; after that, both a local ack and a remote edit cost much less. Small file/search latency, scroll-only frame tails, startup, syntax/folding, RSS and idle-daemon CPU do **not** show a general improvement. In particular, under the default scheduler many-line motion DOM p99 went from 3.6 to 14.8 ms; it went from 5.7 to 1.7 ms when the same runs were restricted to performance cores. The long-line CPU reduction held in both cohorts. Timing ends at the DOM or the next rAF, **not** the physical display.

Next investigations: measure scroll reconciliation independently of layout; test wrapped mega-lines on an actual display; profile repeated **far** case-insensitive misses with Unicode offsets before introducing another search algorithm. Measure concurrent durable writers and slow receivers separately before changing journal batching or transport. The serialized latency measurements include queueing but do not isolate lock wait; process RSS and sampled GC are not exact object-allocation counts.

On the daemon, profile worker-pool initialization and idle collection before rewriting buffer storage. At listen, median baseline CPU was 790 ms (730 user + 60 system) and RSS 215 MiB. In one traced run the last two pool threads became active during the small-file typing sample, and the daemon had 14 major GC events in the 10.5-second idle window. Those costs are not attributable to 64 small buffers. Measuring lazy worker startup would need first-command latency as well as startup RSS.

## Verification

Ran `node --test test/<name>.test.mts` sequentially for `scheme-editor` (20 passed), `headless` (22), `frame` (24) and `display` (19). Then `nix flake check -L --max-jobs 1 --keep-going` ran the repository gates. The only failing gate was `edwin-typecheck`: TS7022 inferred a cycle through the new display test's loop-carried cache. `a7d7082` adds explicit test result types, with no runtime change. Both affected gates passed on the corrected revision, in order:

```sh
nix build --no-link -L --max-jobs 1 .#checks.x86_64-linux.edwin-display
nix build --no-link -L --max-jobs 1 .#checks.x86_64-linux.edwin-typecheck
```
