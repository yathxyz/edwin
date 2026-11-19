# Replica and daemon measurements

## Small-file follow-up: does the acknowledged rope cost ordinary typing time?

**Yes, in the handler:** the chunked shadow added **4–6 µs** to the median synchronous ack dispatch on the 4 Ki-unit file in two separate controlled comparisons (18 of 20 paired medians higher). It did not show a repeatable increase in total driver CPU, durable median or p95. The pooled durable p99 was higher in both comparisons, by very different amounts; those long waits were outside ack dispatch. This is a small-file cost, not the large-file benefit measured below.

**Three trees, one workload.** A = `c1fe9eec`; H = reviewed head `d8c8a65`; C = H with **only** `src/sync.ts` restored from A (the flat acknowledged string). H vs A compares the full revisions; H vs C isolates the acknowledged-text change. The final redisplay revert `270691ef` does not change the replica path; there is no renderer in this workload. For each observation, `node tools/replica-bench.mts TREE --small-typing` starts a fresh real daemon, frame and protocol peer, opens 4,096 ASCII units, inserts eight warmup keys and measures the next 96 midpoint keys, serially. Each key must be durably acknowledged, applied by the frame and delivered with the correct version/text to the peer before the next key. The final frame and daemon text are checked. The selector skips only the subsequent phases; it uses the same timing loop as the full benchmark.

Linux x86-64, Node 24.21.0, default daemon workers, stripped private source trees, fresh socket and journals under a private worktree `TMPDIR` on ext4. `taskset -c 12,14,16,18` restricted each driver and its daemon/threads to the same four E-cores. These CPUs were **not reserved** and the default-scheduler display experiments could also use them. Disk, other host activity and caches are shared. No DOM or paint. Ten blocks of three fresh processes; every pair of trees appears in each relative order five times. Do not pool these runs with the older, unpinned, broader experiment below.

**Warm key → frame-applied durable ack (ms)**, nearest-rank p50/p95/p99, with driver user + system CPU (ms/96 keys). Statistics below are computed from the raw key timings; at 96 keys the per-run p99 **is the maximum**. No slow block was dropped.

| Block / run order | A | H | C | Driver CPU: A / H / C |
|---|---:|---:|---:|---:|
| 1 AHC | 3.330558/4.850416/6.595993 | 3.254926/5.062731/6.468170 | 3.276153/5.228313/6.371117 | 51.043 / 45.077 / 42.365 |
| 2 CHA | 3.490156/5.393216/7.271939 | 3.240753/4.089039/6.068093 | 3.261913/4.350312/5.059181 | 54.025 / 41.778 / 43.376 |
| 3 CAH | 3.283902/4.659499/5.220300 | 3.299016/4.905236/5.381446 | 3.294646/5.109397/5.700062 | 45.061 / 44.800 / 45.264 |
| 4 HAC | 3.292099/4.233543/5.881092 | 3.291813/4.944499/6.315770 | 3.225284/4.544798/5.650128 | 43.973 / 44.936 / 40.700 |
| 5 ACH | 6.034034/14.604088/18.859207 | 4.658863/25.519058/51.801970 | 3.868860/6.569880/10.451467 | 49.608 / 51.042 / 46.395 |
| 6 HCA | 3.392582/5.052985/9.007301 | 3.395280/4.976593/6.607974 | 3.276966/5.084809/5.283492 | 51.773 / 51.207 / 44.343 |
| 7 CAH | 3.285429/4.491215/6.340763 | 3.241228/4.592276/5.229032 | 3.316821/4.357397/5.193407 | 45.206 / 41.459 / 46.153 |
| 8 HAC | 3.284522/4.758599/6.139535 | 3.273192/4.119339/6.752631 | 3.355128/5.156094/6.019331 | 44.354 / 42.349 / 49.588 |
| 9 ACH | 7.209894/18.693842/36.552403 | 3.221353/3.944726/5.348938 | 3.229259/4.201522/5.549864 | 54.759 / 41.933 / 41.635 |
| 10 HCA | 3.293912/4.495543/5.472566 | 5.531303/21.183229/39.970165 | 3.260061/4.943609/5.000288 | 42.748 / 53.228 / 44.674 |

**All ten blocks**, 960 warm keys per tree. Throughput = 960 / total timed loop seconds, including both ack and peer delivery. CPU is summed across the ten typing windows, not a percentile of key latencies. Driver CPU includes the headless frame, peer, socket activity and harness; daemon CPU includes all threads. Neither includes time blocked waiting for I/O.

| Metric | A | H | C |
|---|---:|---:|---:|
| Durable ack p50/p95/p99 (ms) | 3.392582/8.865146/16.104215 | 3.322171/8.288260/21.183229 | 3.290528/4.959256/5.738261 |
| Key → peer fanout p50/p95/p99 (ms) | 3.471/8.985/16.214 | 3.385/8.365/21.276 | 3.356/5.037/5.904 |
| Synchronous ack handler p50/p95/p99 (µs) | 24.060/42.392/368.375 | 26.780/52.707/377.001 | 21.071/40.373/360.445 |
| Driver CPU (ms/960 keys) | 482.550 | 457.809 | 444.493 |
| Daemon user + system CPU (ms/960 keys, 10 ms ticks) | 1000 + 170 | 960 + 130 | 1070 + 160 |
| Serialized keys/s | 227.8 | 225.3 | 280.6 |
| Journal bytes/96 keys, every run | 19,784 | 19,784 | 19,784 |

H vs A: pooled durable p50 and p95 decreased by 0.070 and 0.577 ms; **p99 increased by 5.079 ms**, with five of ten block maxima higher. H used 24.741 ms less total driver CPU, lower in seven of ten blocks. H vs C: the synchronous handler was **5.709/12.334/16.556 µs slower** at p50/p95/p99 (p50/p95 higher in nine blocks, p99 higher in eight). Driver CPU averaged 1.332 ms more per 96 keys, higher in six blocks. A flat 4 Ki-unit string is cheap to edit; the rope splice also locates and rechunks the edited piece and updates newline metadata. The handler measures wall time in dispatch, **not handler-only CPU**.

H's durable p99 was 15.445 ms higher than C's. All ten H observations at or above its p99 came from blocks 5 and 10; the handler during those keys took only 0.040–0.442 ms, not the 21–52 ms seen end-to-end. All ten A observations at or above its p99 came from blocks 5 and 9. Durable round trips include file synchronization, event-loop/worker scheduling and the client path; this does not identify which wait was responsible.

### Independent direct comparison: H vs C only

Ten **additional** fresh pairs, five H-first and five flat-shadow-first, same affinity, driver, durability, sample size and definitions. End-to-end timings are ms; per-run handler timings are µs and include the slowest dispatch at p99.

| Pair / order | H durable p50/p95/p99 | C durable p50/p95/p99 | Driver CPU ms: H / C | H handler p50/p95/p99 | C handler p50/p95/p99 |
|---|---:|---:|---:|---:|---:|
| 1 HC | 3.255469/4.244929/8.165190 | 3.260293/4.678479/5.701797 | 44.673 / 44.723 | 26.3/47.3/398.7 | 22.1/40.5/434.2 |
| 2 CH | 3.230873/4.091526/5.209754 | 3.292997/4.514245/5.318652 | 42.243 / 46.253 | 24.5/48.5/388.1 | 23.1/52.5/432.5 |
| 3 HC | 3.299376/4.800511/5.440396 | 3.265004/4.986413/6.119509 | 46.808 / 46.343 | 29.2/45.8/387.2 | 22.1/46.8/440.7 |
| 4 CH | 3.235928/4.155618/6.896331 | 3.297134/4.938804/6.865328 | 43.480 / 44.330 | 23.9/46.0/376.7 | 20.6/42.9/416.6 |
| 5 HC | 3.278227/4.071778/5.815505 | 3.219709/4.014219/5.596166 | 44.075 / 39.881 | 25.8/50.3/379.7 | 17.6/32.4/396.7 |
| 6 CH | 3.268753/4.811565/5.411769 | 3.246589/4.193701/5.192612 | 40.914 / 43.137 | 23.2/37.5/370.4 | 19.7/42.1/385.3 |
| 7 HC | 3.246785/4.150178/4.963263 | 5.642760/17.951529/25.627726 | 42.248 / 50.162 | 24.0/43.6/388.6 | 26.1/42.9/403.9 |
| 8 CH | 3.229784/4.934760/7.006968 | 3.243405/4.202181/5.341532 | 41.501 / 41.219 | 23.1/46.4/367.9 | 18.9/35.3/389.3 |
| 9 HC | 3.252747/4.368023/5.187227 | 3.341284/4.157376/5.708425 | 43.302 / 45.043 | 24.5/44.8/452.5 | 21.3/41.3/409.7 |
| 10 CH | 8.283911/22.944570/29.471190 | 8.708493/20.048385/26.353904 | 56.203 / 54.387 | 34.9/61.1/376.7 | 30.7/50.2/532.1 |

| Metric, direct pairs only (960 keys/side) | H | C | H − C |
|---|---:|---:|---:|
| Durable ack p50/p95/p99 (ms) | 3.279266/8.283911/18.501052 | 3.327972/9.988040/18.018646 | −0.049/−1.704/+0.482 |
| Key → peer fanout p50/p95/p99 (ms) | 3.341/8.380/18.583 | 3.393/10.071/18.277 | −0.051/−1.690/+0.306 |
| Synchronous ack handler p50/p95/p99 (µs) | 25.691/47.335/367.915 | 21.677/41.625/385.274 | +4.014/+5.710/−17.359 |
| Driver CPU (ms/960 keys) | 445.447 | 455.478 | −10.031 |
| Daemon user + system CPU (ms/960 keys) | 960 + 160 | 990 + 130 | 0 total |
| Serialized keys/s | 244.2 | 223.1 | +21.1 |
| Daemon storage read/write bytes (sum, `/proc/PID/io`) | 0/4,440,064 | 0/4,460,544 | 0/−20,480 |
| Journal bytes/96 keys, every run | 19,784 | 19,784 | 0 |

The direct comparison reproduced the **median and p95 handler cost**, not the handler p99 increase. Mean dispatch cost was also higher: +8.38 µs/key in the triples, +5.57 µs/key in the direct pairs. Driver CPU changed sign (+1.332 then −1.003 ms per 96 keys), as did throughput, durable p50 and p95. The direct durable p99 excess was +0.482 ms, versus +15.445 ms in the triples. All ten direct H samples at or above H's pooled p99 occurred in pair 10; the handler took at most 0.127 ms on those keys. This supports attributing microseconds of typical dispatch time to the shadow change, **not** attributing the millisecond-scale durable tails or the aggregate CPU difference to it. No sync, durability or transport change was made for this measurement.

## Earlier five-pair experiment: small and large buffers, startup, idle and fanout

**Result.** On the 4 Mi-unit file, warm local ack dispatch p50/p95/p99 was **1.93/4.56/7.77 → 0.039/0.10/0.12 ms**, and remote edit dispatch **1.96/4.23/7.27 → 0.051/0.11/0.21 ms**. Driver CPU for 96 keys was 307.37 → 51.01 ms; for 48 reverse edits 133.57 → 9.25 ms. End-to-end key → applied durable ack was 5.41/8.53/12.35 → 3.36/4.81/5.79 ms. Those end-to-end timings include the disk and scheduler; the synchronous handler and driver CPU are the cleaner evidence for the changed client path.

**Cost.** The first large ack pays to turn the immutable snapshot into chunks: its median handler was 0.026 → 1.29 ms, before the warm savings. A read-only frame does not pay this at open. Large attach median was 30.09 → 32.49 ms; driver RSS (KiB, medians) after attach was 167024 → 163524, after first key 167024 → 163524, after 96 keys 274244 → 203876. On the 4 Ki-unit file, warm ack p50/p95/p99 was 0.019/0.066/0.26 → 0.028/0.071/0.30 ms; remote dispatch 0.092/0.23/1.28 → 0.051/0.17/0.54 ms. No general small-file, startup, idle, or fanout speedup is claimed. Journal and transport behavior are unchanged.

### Method

Five independent process pairs on Linux x86-64, Node 24.21.0, ext4, default daemon worker configuration. Baseline = `c1fe9eec`; fixed = the previously measured code at `409a0fc8` (lazy acknowledged rope and search/render review fixes). Order alternates **baseline/fixed, fixed/baseline, baseline/fixed, fixed/baseline, baseline/fixed**. The same `node tools/replica-bench.mts [source-tree]` drives every run; install each tree's server dependencies and strip its core first (see [setup](performance.md)). Each invocation starts a fresh private daemon and Unix socket, HOME/XDG/TMPDIR and file-backed journals. No live desktop, paint, mocked sync or relaxed durability. No CPU pinning or OS-cache flush; this is not a storage latency or idle-worker scalability experiment.

The driver runs the real headless frame/key/OT stack and an independent protocol peer on one event loop. For each of 4,096 and 4,194,304 ASCII units: open file outside the notes index, attach frame, record first key separately within eight warmups, then 96 serialized midpoint keys, 48 edits in the reverse direction, four reconnects with 12 missed edits each. Wait for durable acknowledgments (journal append and fdatasync); check versions, peer delivery and final text. Then open 64 additional five-byte files on a protocol peer and idle 10.5 seconds (crosses the ten-second file-stat sweep). Finally connect 32 additional protocol peers to one of those files and require the durable ack and correct edit on all 32. These are subscriptions, not 32 rendered heaps.

### What the timings mean

Pooled nearest-rank **p50/p95/p99 [min–max of the five run p50s]**, milliseconds, N **per side**. With five observations the two tails are the maximum. The ~50 ms launcher poll limits startup resolution. Handler times include actual JSON dispatch, not network; end-to-end also includes journaling, queueing, scheduling and ordering of the observer callbacks.

| Phase | N | Baseline | Fixed |
| --- | --- | --- | --- |
| spawnToListening | 5 | 455.52/1122.52/1122.52 [405.09–1122.52] | 406.37/458.64/458.64 [404.45–458.64] |
| peerConnectHello | 5 | 2.10/7.43/7.43 [1.88–7.43] | 3.22/3.43/3.43 [1.89–3.43] |
| headlessFrameBootHello | 5 | 111.21/445.77/445.77 [104.06–445.77] | 109.91/154.23/154.23 [102.95–154.23] |
| small.open | 5 | 9.97/25.45/25.45 [8.97–25.45] | 9.67/10.69/10.69 [7.86–10.69] |
| small.attach | 5 | 0.77/2.42/2.42 [0.71–2.42] | 0.81/1.42/1.42 [0.77–1.42] |
| small.firstKeyToAppliedAck | 5 | 5.01/16.59/16.59 [3.89–16.59] | 5.03/7.67/7.67 [4.90–7.67] |
| small.firstAckHandler | 5 | 0.24/0.59/0.59 [0.21–0.59] | 0.27/0.46/0.46 [0.23–0.46] |
| small.keyToAppliedAck | 480 | 3.29/6.81/11.97 [3.07–5.13] | 3.32/4.76/5.43 [3.15–3.50] |
| small.keyToPeerFanout | 480 | 3.34/7.25/12.10 [3.11–5.29] | 3.39/4.85/5.51 [3.19–3.58] |
| small.ackHandler | 480 | 0.019/0.066/0.26 [0.012–0.048] | 0.028/0.071/0.30 [0.018–0.041] |
| small.peerSendToAck | 240 | 3.65/6.94/13.68 [3.16–5.74] | 3.22/3.93/5.39 [3.09–3.70] |
| small.peerSendToFrameApplied | 240 | 3.78/7.17/13.82 [3.21–5.91] | 3.30/4.19/5.54 [3.14–3.89] |
| small.editsHandler | 240 | 0.092/0.23/1.28 [0.041–0.13] | 0.051/0.17/0.54 [0.034–0.14] |
| small.reconnectHello | 20 | 0.68/1.44/2.77 [0.42–1.24] | 0.40/1.17/4.02 [0.31–0.51] |
| small.catchup | 20 | 0.50/1.41/9.12 [0.34–1.07] | 0.26/0.86/1.13 [0.18–0.47] |
| large.open | 5 | 60.29/143.28/143.28 [53.87–143.28] | 62.72/70.84/70.84 [59.90–70.84] |
| large.attach | 5 | 30.09/74.64/74.64 [29.39–74.64] | 32.49/39.27/39.27 [31.07–39.27] |
| large.firstKeyToAppliedAck | 5 | 4.00/8.50/8.50 [3.89–8.50] | 5.30/6.36/6.36 [4.92–6.36] |
| large.firstAckHandler | 5 | 0.026/0.082/0.082 [0.023–0.082] | 1.29/2.13/2.13 [0.91–2.13] |
| large.keyToAppliedAck | 480 | 5.41/8.53/12.35 [4.56–6.03] | 3.36/4.81/5.79 [3.21–3.80] |
| large.keyToPeerFanout | 480 | 5.49/8.65/12.54 [4.59–6.17] | 3.41/4.93/5.85 [3.25–3.89] |
| large.ackHandler | 480 | 1.93/4.56/7.77 [1.23–2.29] | 0.039/0.10/0.12 [0.020–0.073] |
| large.peerSendToAck | 240 | 3.31/4.58/6.65 [3.12–3.72] | 3.20/4.62/5.22 [3.10–3.54] |
| large.peerSendToFrameApplied | 240 | 5.35/9.17/10.99 [4.44–6.31] | 3.26/4.79/5.33 [3.16–3.63] |
| large.editsHandler | 240 | 1.96/4.23/7.27 [1.26–2.46] | 0.051/0.11/0.21 [0.034–0.090] |
| large.reconnectHello | 20 | 0.50/1.16/1.19 [0.36–0.72] | 0.44/1.52/2.20 [0.25–0.72] |
| large.catchup | 20 | 0.25/0.54/0.72 [0.12–0.32] | 0.21/0.69/0.82 [0.090–0.42] |
| idleOpen.elapsedMs | 5 | 462.22/1913.75/1913.75 [351.22–1913.75] | 369.57/481.29/481.29 [334.41–481.29] |
| idle.elapsedMs | 5 | 10501.83/10502.67/10502.67 [10500.50–10502.67] | 10501.48/10502.28/10502.28 [10501.42–10502.28] |
| sharedAttach.elapsedMs | 5 | 10.14/30.38/30.38 [3.70–30.38] | 13.79/22.10/22.10 [4.81–22.10] |
| sharedEdit.durableAckMs | 5 | 6.15/10.64/10.64 [3.83–10.64] | 7.43/12.38/12.38 [5.57–12.38] |
| sharedEdit.allFanoutMs | 5 | 9.00/11.49/11.49 [4.59–11.49] | 8.92/15.36/15.36 [6.70–15.36] |

### CPU, RSS, I/O and traffic

Median [min–max] of five per-process observations; a single value means identical on all five. B = baseline, F = fixed. CPU is driver (both peers plus harness) or daemon (all threads, 10 ms ticks). Startup reads are totals up to listening; other CPU and I/O values are deltas across the named phase. RSS is at phase end, HWM process lifetime. Neither RSS measure isolates objects or GC.

| Phase | Side | Client CPU ms | Client RSS KiB | Daemon user ms | Daemon sys ms | Daemon RSS KiB | Daemon HWM KiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| startup | B | 113.92 [107.52–217.95] | 90944 [90680–92012] | 690 [640–1380] | 70 [50–110] | 207912 [199176–234272] | 207912 [199176–234272] |
| startup | F | 117.56 [110.80–145.82] | 90728 [90564–90856] | 630 [600–740] | 50 [40–80] | 203248 [191480–215660] | 203248 [191480–215660] |
| small.typing | B | 46.30 [38.49–87.25] | 123216 [122940–124268] | 300 [280–550] | 50 [40–80] | 366476 [361956–367192] | 366476 [361956–367192] |
| small.typing | F | 48.53 [36.91–56.66] | 122964 [121872–123916] | 350 [320–420] | 50 [40–50] | 362380 [361192–367668] | 362380 [361192–367668] |
| small.remote | B | 36.30 [15.70–45.35] | 123216 [123100–123824] | 30 [10–30] | 10 [0–20] | 367404 [362880–368128] | 367404 [362880–368128] |
| small.remote | F | 13.91 [11.84–36.19] | 122964 [121872–124236] | 20 [10–20] | 10 [0–10] | 363304 [362108–368596] | 363304 [362108–368596] |
| large.typing | B | 307.37 [184.59–341.53] | 274244 [231716–281152] | 40 [30–70] | 10 [10–20] | 388484 [387436–392124] | 399536 [398944–400528] |
| large.typing | F | 51.01 [35.53–109.37] | 203876 [201212–209652] | 50 [30–90] | 10 [0–20] | 388640 [388004–403388] | 400816 [399128–403388] |
| large.remote | B | 133.57 [81.40–163.08] | 256344 [230688–305104] | 20 [10–40] | 0 [0–10] | 388556 [387508–392188] | 399536 [398944–400528] |
| large.remote | F | 9.25 [7.32–19.02] | 203876 [201212–209652] | 20 [10–40] | 0 [0–10] | 388708 [388076–403456] | 400816 [399128–403456] |
| idleOpen | B | 29.35 [12.81–98.91] | 260892 [240676–328904] | 80 [40–120] | 40 [20–60] | 401408 [400372–405096] | 401408 [400372–405096] |
| idleOpen | F | 32.34 [11.82–48.05] | 236388 [197360–246624] | 50 [40–120] | 30 [10–50] | 401572 [401028–416316] | 401572 [401028–416316] |
| idle | B | 100.66 [79.27–140.88] | 134944 [130588–317732] | 230 [220–500] | 30 [20–50] | 336436 [335324–341176] | 400476 [399184–404184] |
| idle | F | 151.07 [84.13–154.59] | 130632 [128952–131372] | 420 [230–570] | 30 [30–50] | 336068 [334824–336820] | 400816 [399756–414616] |
| sharedAttach | B | 9.30 [4.39–25.98] | 135424 [130908–317732] | 10 [0–10] | 0 [0–10] | 336676 [335716–341216] | 400476 [399184–404184] |
| sharedAttach | F | 12.00 [4.22–19.73] | 131124 [129432–132012] | 10 [0–20] | 0 [0–10] | 336264 [335208–337208] | 400816 [399756–414616] |
| sharedEdit | B | 5.26 [4.43–15.31] | 135904 [131580–317732] | 0 | 0 | 336676 [335756–341216] | 400476 [399184–404184] |
| sharedEdit | F | 7.45 [3.65–12.54] | 131604 [130132–132492] | 0 | 0 | 336308 [335248–337248] | 400816 [399756–414616] |

`/proc/PID/io` for the daemon: rchar/wchar = bytes reported by reads/writes including sockets, syscr/syscw = call counts, read_bytes/write_bytes = kernel-attributed storage bytes, **not** journal size or fsync count. All cancelled_write_bytes were zero.

| Phase | Side | rchar | wchar | syscr | syscw | read_bytes | write_bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| startup | B | 2880409 [2844843–2911824] | 7480 [1688–9953] | 1159 [437–1463] | 870 [150–1174] | 0 | 8192 |
| startup | F | 2855189 [2846420–2886389] | 7008 [2864–9232] | 1103 [580–1383] | 815 [297–1093] | 0 | 8192 |
| small.typing | B | 1600810 [1216550–1617863] | 43352 [41648–43677] | 433 [207–434] | 530 [333–532] | 0 | 438272 [438272–454656] |
| small.typing | F | 1620631 [1602393–1626906] | 44424 [42973–47824] | 567 [345–1009] | 664 [444–1105] | 0 | 442368 [438272–442368] |
| small.remote | B | 4846 | 21142 [20825–21459] | 49 | 149 [148–150] | 0 | 221184 [217088–225280] |
| small.remote | F | 4846 | 20825 [20825–21142] | 49 | 148 [148–149] | 0 | 217088 [217088–221184] |
| large.typing | B | 9509 [9387–9570] | 47340 [45858–48081] | 105 [103–108] | 310 [306–312] | 0 | 458752 [450560–462848] |
| large.typing | F | 9204 [9204–9265] | 43634 [43634–44375] | 101 [101–102] | 300 [300–302] | 0 | 438272 [438272–442368] |
| large.remote | B | 5004 [4996–5004] | 23148 [22548–23740] | 50 [49–50] | 151 [150–151] | 0 | 225280 [221184–229376] |
| large.remote | F | 4996 | 21940 [21940–22540] | 49 | 148 [148–149] | 0 | 217088 [217088–221184] |
| idleOpen | B | 7407 [7407–7502] | 120325 [99886–238948] | 318 [310–321] | 391 [389–404] | 0 | 876544 [847872–1019904] |
| idleOpen | F | 7441 [7407–7502] | 117469 [111412–123490] | 321 [319–323] | 391 [390–391] | 0 | 872448 [864256–876544] |
| idle | B | 8568 [5232–24248] | 8568 [5232–24248] | 1071 [654–3031] | 1071 [654–3031] | 0 | 0 |
| idle | F | 15712 [7640–18168] | 15712 [7640–18168] | 1964 [955–2271] | 1964 [955–2271] | 0 | 0 |
| sharedAttach | B | 4832 | 18368 | 64 | 128 | 0 | 0 |
| sharedAttach | F | 4832 | 18368 | 64 | 128 | 0 | 0 |
| sharedEdit | B | 70 | 4745 | 1 | 34 | 0 | 4096 |
| sharedEdit | F | 70 | 4745 | 1 | 34 | 0 | 4096 |

Wire counters include framing and incidental messages. Catch-up wire bytes are for the last of four replays per run. The 64-file open includes driver file creation. The 32 subscribers measure connection and daemon subscription overhead, not per-editor heap size; the edit's single durable ack and all fanouts are timed separately.

| Counter | Baseline | Fixed |
| --- | --- | --- |
| small.firstOpenPeerWireBytes | 4569 | 4569 |
| small.clientRssKiBAfterAttach | 122736 [122460–123948] | 122644 [121392–123596] |
| small.clientRssKiBAfterFirstKey | 122736 [122460–123948] | 122804 [121392–123756] |
| small.catchupWireBytes | 1835 | 1835 |
| large.firstOpenPeerWireBytes | 4325935 | 4325935 |
| large.clientRssKiBAfterAttach | 167024 [159964–178104] | 163524 [152076–167696] |
| large.clientRssKiBAfterFirstKey | 167024 [159964–178104] | 163524 [152236–167696] |
| large.catchupWireBytes | 1856 | 1856 |
| small.typing.journalBytes | 19784 | 19784 |
| small.typing.peerWireBytes | 14866 [14866–15546] | 15002 [14866–15002] |
| small.remote.journalBytes | 10311 | 10311 |
| large.typing.journalBytes | 20072 | 20072 |
| large.typing.peerWireBytes | 15870 [15586–16012] | 15160 [15160–15302] |
| large.remote.journalBytes | 10455 | 10455 |
| idleOpen.clientRssDeltaKiB | 0 [-8228–160] | 0 [-38324–0] |
| idleOpen.daemonRssDeltaKiB | 184 [176–216] | 176 [164–236] |
| sharedAttach.peerBytesRead | 15040 | 15040 |
| sharedAttach.clientRssDeltaKiB | 320 [0–480] | 640 [320–640] |
| sharedAttach.daemonRssDeltaKiB | 40 [20–392] | 384 [20–388] |
| sharedEdit.journalBytes | 184 | 184 |
| sharedEdit.peerBytesRead | 4512 | 4512 |

## Why change the frame, not the journal?

An earlier *separate baseline* CPU profile of this workload found 157 self samples in `splitsPair` under `onAck`, 62 more in its `isLow` child, and 54 + 6 under `onEdits` (`checkOp → applyOp → apply`). On the old flat-string path, the next boundary check on a concatenated result could flatten the whole document for a one-character edit; surrogate validation itself is still required. The frame now keeps its acknowledged snapshot string until the first edit, then edits an independent rope. The display can contain unacknowledged work and cannot substitute for the shadow. Multi-op validation is still all-or-nothing; rebase/export may still flatten. The durability window is a correctness contract, not a tuning knob.

A historical baseline trace (`--trace-event-categories=v8,node.worker`) counted 8 daemon workers including six edwin threads. In that run their first events spanned −32 to +340 ms relative to listening; small-file typing started at +252 ms. The driver disables app workers. GC start events (driver minor/major; daemon minor/major): small typing 0/0; 10/3, large typing 8/1; 0/0, large remote 3/0; 0/0, idle 1/2; 0/14. These are not samples in the five pairs and do not estimate a GC improvement. They explain why small-typing and idle process CPU cannot all be attributed to the edits or the stat sweep.

## What bounds a shadow splice?

The cap on an incoming edit is not the cap on a frame's acknowledgment:

* **Remote and replayed edits.** Both live fanout and history replay in [sequencer.mts](../server/sequencer.mts) call [Session.sendBulkish](../server/session.mts) for an edits message. It closes the session instead of sending if the *whole encoded line* plus queued/held output exceeds 4 Mi units. The serialized line is counted with JS `.length` (UTF-16 units); socket backlog may lower the allowance. This bounds both the inserted and the deleted string in any one op, even for server-generated edits. Chunked snapshots can be much larger but install a string; they do not pass a snapshot-sized op to `applyToShadow`.
* **Local acknowledged edit.** An ack contains no ops. [onAck](../src/sync.ts) uses the matching in-flight batch. A successful live ack, resend deduplication or own-history replay presupposes daemon acceptance of that batch. The [line reader](../server/proto.mts) rejects input over 16 MiB of UTF-8 **bytes**, and the [WebSocket front](../server/front.mts) uses the same maxPayload. The native client’s local write queue may reject a send earlier; a failed send cannot produce an ack. A unit of decoded insert/delete text costs at least one wire byte; even the sum across the original accepted batch is below 16 Mi units. A queued or too-large local send is not an ack. While the batch is in flight, [OT.transform](../src/ot.ts) retains the other writer's inserts, removes overlapping deletes and only carries through the local insert strings; composition can coalesce adjacent components but cannot add inserted or deleted units to the local totals. Conversion back to positional ops slices exactly those delete lengths. This remains true across repeated rebases. Rollback swaps each earlier op's insert and delete, so exactly the same bounds cover inverse splices.
* **Arguments, not document size.** On an empty [rope](../src/text.ts) there is no spread. Otherwise the splice rechunks only its insert and the retained portions of up to two 4,096-unit chunks. The optional neighbor merge stays within 4,096 units. Above that length, every nonfinal chunk consumes at least 2,048 units (the surrogate adjustment only increases it). Upper bound for each of the two `Array.splice` calls: `2 + ceil((16*2^20 + 2*4096)/2048) = 8,198` arguments; the 4 Mi remote path needs at most 2,054. Deleting a huge interval does not pass all the removed chunks as arguments.

ECMAScript gives no portable argument ceiling. We measured *actual* `dst.splice(1, 1, ...pieces)` on a nonempty array under 32 non-tail JS calls (allocate N pieces, recurse, splice at the leaf, verify the resulting length on return), deeper than the synchronous network-receive path. Both reachable counts succeeded on Node 24.21 (984 KiB default V8 stack), Chromium 156 and Firefox 159 in private headless profiles, and JavaScriptCore from WebKitGTK 2.52.6. All four also accepted 65,538 arguments. With Node deliberately reduced to `--stack-size=256` KiB, 16,386 still succeeded, 32,770 failed. The native host explicitly [configures V8](../native/src/snapshot.rs) with 65,536 KiB on a [96 MiB thread](../native/src/main.rs). These are observed lower bounds at receive depth, not claims about arbitrarily deep code or every custom embedder. No extra loop, spread threshold or production path is needed for replica updates under these limits.
