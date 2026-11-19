# Replica and daemon measurements

Linux x86-64, Node 24.21.0, default daemon worker configuration, ext4. Run `node tools/replica-bench.mts [source-tree]` after installing the server dependencies and stripping that tree (see [setup](performance.md)). Four independent baseline/patched pairs, with the same stripped sources except for the frame sync change. Order B/A/A/B/A/B/B/A, where B is the baseline. Two extra pairs each for the 64-file open and 32-subscriber diagnostics. A fresh private daemon per run.

Private child process and edit.sock, HOME/XDG/TMPDIR, real file-backed journals, real durable acknowledgments (journal append + fdatasync), outside notes/autosave index. Actual key/OT/sync stack and reverse receiver over Unix JSON-lines adapter; other peer and frame share driver event loop. Frame performs no paint. 4096 and 4194304 ASCII code units; serialized one-unit midpoint inserts. Both peers verify versions and final text. 8 warmups (first ack separately), 96 frame keys and 48 reverse peer edits per size/process; 4 reconnects after 12 missed edits per size. Idle sample 10.5s with 64 additional file buffers attached, spanning 10s file stat sweep. Read-only and idle frame replicas retain the original snapshot string; the benchmark idle file buffers themselves are attached to the wire peer, not rendered by a frame.

## Latency (milliseconds)

Columns give pooled **N: p50/p95/p99 [individual run p50s]** (nearest rank); runs shown by label suffix 4,5,6,7. Rows with four startup or first-key observations are descriptive; p95/p99 = max. Handlers include real JSON dispatch and mutation, not network; end-to-end includes I/O, event-loop queueing, scheduling, and peer callback order. Spawn-to-listen sampled by ~50ms launcher poll.

| Phase | Baseline | Changed |
|---|---|---|
| spawnToListening | 4: 456.43/658.31/658.31 [457.76, 456.43, 658.31, 405.22] | 4: 456.36/510.44/510.44 [510.44, 456.36, 407.50, 510.04] |
| peerConnectHello | 4: 3.19/3.74/3.74 [3.19, 1.94, 3.74, 3.40] | 4: 2.87/3.40/3.40 [2.87, 3.15, 3.40, 2.20] |
| headlessFrameBootHello | 4: 122.71/143.35/143.35 [122.71, 113.67, 143.35, 134.75] | 4: 115.52/139.12/139.12 [139.12, 123.86, 115.52, 113.30] |
| small.open | 4: 12.26/84.85/84.85 [9.14, 84.85, 49.31, 12.26] | 4: 8.68/63.06/63.06 [13.91, 63.06, 8.68, 7.22] |
| small.attach | 4: 0.89/1.04/1.04 [0.89, 1.04, 0.92, 0.86] | 4: 0.90/1.28/1.28 [0.98, 1.28, 0.78, 0.90] |
| small.firstKeyToAppliedAck | 4: 5.19/16.22/16.22 [5.09, 16.22, 11.65, 5.19] | 4: 4.94/5.64/5.64 [5.64, 5.23, 4.94, 4.61] |
| small.firstAckHandler | 4: 0.28/0.39/0.39 [0.39, 0.28, 0.25, 0.38] | 4: 0.25/0.42/0.42 [0.32, 0.24, 0.25, 0.42] |
| small.keyToAppliedAck | 384: 4.87/27.60/60.36 [3.33, 15.80, 8.11, 3.26] | 384: 3.34/4.60/5.66 [3.56, 3.32, 3.14, 3.35] |
| small.keyToPeerFanout | 384: 4.93/27.71/60.44 [3.40, 15.87, 8.16, 3.33] | 384: 3.40/4.67/5.76 [3.63, 3.37, 3.17, 3.42] |
| small.ackHandler | 384: 0.026/0.044/0.41 [0.025, 0.034, 0.026, 0.018] | 384: 0.028/0.050/0.25 [0.038, 0.028, 0.016, 0.031] |
| small.peerSendToAck | 192: 3.36/15.96/39.89 [3.26, 3.86, 9.73, 3.08] | 192: 3.16/3.77/4.84 [3.23, 3.06, 3.13, 3.24] |
| small.peerSendToFrameApplied | 192: 3.44/16.05/40.04 [3.34, 3.87, 9.83, 3.12] | 192: 3.22/4.12/4.91 [3.32, 3.10, 3.16, 3.36] |
| small.editsHandler | 192: 0.042/0.11/0.51 [0.044, 0.040, 0.059, 0.026] | 192: 0.043/0.12/0.64 [0.051, 0.029, 0.041, 0.055] |
| small.reconnectHello | 16: 0.29/2.86/2.86 [0.29, 0.23, 0.33, 0.26] | 16: 0.34/2.12/2.12 [0.25, 0.27, 0.27, 0.39] |
| small.catchup | 16: 0.19/0.55/0.55 [0.19, 0.12, 0.15, 0.25] | 16: 0.20/0.60/0.60 [0.19, 0.13, 0.13, 0.30] |
| large.open | 4: 72.12/108.56/108.56 [72.12, 58.24, 108.56, 87.41] | 4: 59.19/63.20/63.20 [59.19, 63.20, 53.09, 62.04] |
| large.attach | 4: 27.88/46.35/46.35 [46.35, 26.95, 27.88, 42.36] | 4: 28.40/35.74/35.74 [35.74, 28.40, 31.07, 27.27] |
| large.firstKeyToAppliedAck | 4: 6.03/7.24/7.24 [5.15, 6.03, 7.24, 6.23] | 4: 5.02/6.71/6.71 [5.45, 6.71, 3.92, 5.02] |
| large.firstAckHandler | 4: 0.026/0.034/0.034 [0.031, 0.026, 0.026, 0.034] | 4: 1.22/2.38/2.38 [1.32, 2.38, 1.22, 0.91] |
| large.keyToAppliedAck | 384: 5.97/14.77/20.30 [5.43, 4.91, 8.28, 9.00] | 384: 3.22/3.84/5.21 [3.33, 3.24, 3.13, 3.22] |
| large.keyToPeerFanout | 384: 6.07/14.83/20.34 [5.52, 4.94, 8.35, 9.08] | 384: 3.27/3.87/5.30 [3.39, 3.28, 3.16, 3.26] |
| large.ackHandler | 384: 1.33/3.42/5.65 [1.78, 1.19, 1.32, 1.24] | 384: 0.030/0.059/0.075 [0.036, 0.037, 0.021, 0.028] |
| large.peerSendToAck | 192: 4.18/12.83/16.80 [3.92, 3.48, 6.21, 7.37] | 192: 3.08/3.54/5.10 [3.20, 3.15, 3.00, 3.01] |
| large.peerSendToFrameApplied | 192: 6.03/14.50/21.75 [5.64, 4.80, 7.53, 8.64] | 192: 3.13/3.58/5.22 [3.27, 3.23, 3.03, 3.05] |
| large.editsHandler | 192: 1.31/3.50/6.26 [1.83, 1.23, 1.25, 1.28] | 192: 0.039/0.079/0.097 [0.061, 0.058, 0.019, 0.026] |
| large.reconnectHello | 16: 0.39/9.67/9.67 [0.45, 0.40, 0.32, 0.38] | 16: 0.29/2.01/2.01 [0.38, 0.44, 0.24, 0.28] |
| large.catchup | 16: 0.14/0.34/0.34 [0.13, 0.21, 0.13, 0.14] | 16: 0.11/0.26/0.26 [0.19, 0.20, 0.094, 0.096] |

## Resources

Per-phase totals, median [min–max] of the four independent process runs; medians use nearest rank (lower middle). CPU = milliseconds, RSS and lifetime HWM = KiB. Client CPU/RSS covers both peers and harness; daemon CPU from 10ms /proc ticks; peak RSS is process lifetime, not isolated per-phase. I/O bytes from /proc/PID/io: rchar/wchar count all calls including sockets; read_bytes/write_bytes are kernel storage attribution, not the sum of journal lines. syscr/syscw count calls, not fsyncs. Include small typing's concurrent daemon worker start in totals, do not attribute all its costs to typing.

| Phase | Metric | Baseline | Changed |
|---|---|---|---|
| small.typing | clientCpuMs | 45.78 [41.83–60.88] | 45.35 [32.66–54.06] |
| small.typing | clientRssKiB | 124020 [122944–124376] | 122748 [121260–123312] |
| small.typing | daemonCpuMs | 250 [210–340] | 310 [270–440] |
| small.typing | daemonRssKiB | 361788 [361704–362884] | 361412 [360172–362880] |
| small.typing | daemonPeakRssKiB | 361788 [361704–362884] | 361412 [360172–362880] |
| small.typing | journalBytes | 19784 [19784–19784] | 19784 [19784–19784] |
| small.typing | peerWireBytes | 15002 [15002–17858] | 15002 [14866–15002] |
| small.typing | daemonIo.rchar | 815734 [813250–1600841] | 1599226 [1197514–1620937] |
| small.typing | daemonIo.wchar | 43535 [43372–52193] | 43230 [41676–44575] |
| small.typing | daemonIo.syscr | 407 [178–430] | 372 [234–541] |
| small.typing | daemonIo.syscw | 509 [337–588] | 471 [332–639] |
| small.typing | daemonIo.read_bytes | 0 [0–0] | 0 [0–0] |
| small.typing | daemonIo.write_bytes | 442368 [438272–512000] | 442368 [438272–442368] |
| small.remote | clientCpuMs | 15.45 [12.95–20.54] | 12.08 [11.99–16.45] |
| small.remote | clientRssKiB | 124020 [122944–124376] | 122748 [121260–123312] |
| small.remote | daemonCpuMs | 20 [20–40] | 10 [10–20] |
| small.remote | daemonRssKiB | 362704 [362620–363808] | 362332 [361088–363796] |
| small.remote | daemonPeakRssKiB | 362704 [362620–363808] | 362332 [361088–363796] |
| small.remote | journalBytes | 10311 [10311–10311] | 10311 [10311–10311] |
| small.remote | daemonIo.rchar | 4846 [4846–4854] | 4846 [4846–4846] |
| small.remote | daemonIo.wchar | 20843 [20843–22143] | 20843 [20843–20843] |
| small.remote | daemonIo.syscr | 49 [49–50] | 49 [49–49] |
| small.remote | daemonIo.syscw | 148 [148–153] | 148 [148–148] |
| small.remote | daemonIo.read_bytes | 0 [0–0] | 0 [0–0] |
| small.remote | daemonIo.write_bytes | 217088 [217088–233472] | 217088 [217088–217088] |
| large.typing | clientCpuMs | 202.13 [198.77–259.64] | 39.17 [30.36–47.72] |
| large.typing | clientRssKiB | 233040 [231828–279172] | 196092 [194876–208672] |
| large.typing | daemonCpuMs | 40 [30–60] | 50 [40–60] |
| large.typing | daemonRssKiB | 388776 [388552–403600] | 387512 [386992–401300] |
| large.typing | daemonPeakRssKiB | 399864 [399604–403600] | 399812 [398460–401300] |
| large.typing | journalBytes | 20072 [20072–20072] | 20072 [20072–20072] |
| large.typing | peerWireBytes | 15728 [15728–16722] | 15160 [15160–15160] |
| large.typing | daemonIo.rchar | 9509 [9448–9883] | 9204 [9204–9204] |
| large.typing | daemonIo.wchar | 46860 [46719–50775] | 43706 [43706–43707] |
| large.typing | daemonIo.syscr | 105 [104–114] | 101 [100–102] |
| large.typing | daemonIo.syscw | 309 [308–321] | 300 [300–300] |
| large.typing | daemonIo.read_bytes | 0 [0–0] | 0 [0–0] |
| large.typing | daemonIo.write_bytes | 454656 [454656–475136] | 438272 [438272–438272] |
| large.remote | clientCpuMs | 82.32 [77.97–107.34] | 6.36 [4.85–9.94] |
| large.remote | clientRssKiB | 257684 [256584–303688] | 196092 [194876–208672] |
| large.remote | daemonCpuMs | 30 [20–30] | 10 [0–20] |
| large.remote | daemonRssKiB | 388840 [388624–403648] | 387580 [387056–401372] |
| large.remote | daemonPeakRssKiB | 399864 [399604–403648] | 399812 [398460–401372] |
| large.remote | journalBytes | 10455 [10455–10455] | 10455 [10455–10455] |
| large.remote | daemonIo.rchar | 4996 [4996–5004] | 4996 [4996–5004] |
| large.remote | daemonIo.wchar | 23812 [22588–24424] | 21976 [21364–21984] |
| large.remote | daemonIo.syscr | 49 [49–50] | 49 [49–50] |
| large.remote | daemonIo.syscw | 151 [149–152] | 148 [147–149] |
| large.remote | daemonIo.read_bytes | 0 [0–0] | 0 [0–0] |
| large.remote | daemonIo.write_bytes | 229376 [221184–233472] | 217088 [212992–217088] |
| idle | clientCpuMs | 62.10 [55.79–90.75] | 88.45 [51.19–111.73] |
| idle | clientRssKiB | 135428 [130560–135552] | 130360 [128476–130484] |
| idle | daemonCpuMs | 240 [220–290] | 250 [240–270] |
| idle | daemonRssKiB | 335460 [335296–335924] | 334712 [333744–335412] |
| idle | daemonPeakRssKiB | 400976 [400728–415836] | 399812 [398852–412788] |
| idle | daemonIo.rchar | 9520 [9160–16984] | 11800 [11448–16152] |
| idle | daemonIo.wchar | 9520 [9160–16984] | 11800 [11448–16152] |
| idle | daemonIo.syscr | 1190 [1145–2123] | 1475 [1431–2019] |
| idle | daemonIo.syscw | 1190 [1145–2123] | 1475 [1431–2019] |
| idle | daemonIo.read_bytes | 0 [0–0] | 0 [0–0] |
| idle | daemonIo.write_bytes | 0 [0–0] | 0 [0–0] |

| Counter | Baseline | Changed |
|---|---|---|
| small.firstOpenPeerWireBytes | 4575 [4575–4575] | 4575 [4575–4575] |
| small.clientRssKiBAfterAttach | 123540 [122784–123824] | 122428 [120620–122832] |
| small.clientRssKiBAfterFirstKey | 123540 [122784–123984] | 122428 [120620–122992] |
| small.catchupWireBytes | 1835 [1835–1835] | 1835 [1835–1835] |
| large.firstOpenPeerWireBytes | 4325941 [4325941–4325941] | 4325941 [4325941–4325941] |
| large.clientRssKiBAfterAttach | 167716 [153544–170804] | 167192 [153240–169728] |
| large.clientRssKiBAfterFirstKey | 167716 [153544–170804] | 167192 [153240–169728] |
| large.catchupWireBytes | 1856 [1856–1856] | 1856 [1856–1856] |

| Listening-time daemon | Baseline | Changed |
|---|---|---|
| userMs | 730 [630–770] | 740 [630–820] |
| systemMs | 60 [60–70] | 70 [60–70] |
| rssKiB | 220232 [198180–229536] | 205168 [200412–228876] |
| peakRssKiB | 220232 [198180–230140] | 205168 [200412–228876] |

Catch-up wire count is the last replay in each run. Idle totals include worker housekeeping, timers etc. These should not be interpreted as an attribution of IO or CPU to file watch.

## Interpretation and cost

* Prior to changing production, an independent Node CPU profile of the same baseline workload found 157 self samples in splitsPair under onAck, plus 62 in its isLow child; 54 + 6 under onEdits (checkOp → applyOp → apply). This is the exact stack, not a microbenchmark. Fix the acknowledged TEXT replica, not surrogate validation. Keep a snapshot string until its first acknowledged/remote edit, then edit an independent rope. The display buffer can contain unsent work and cannot replace this shadow. Multi-op validation remains all-or-nothing; existing hash/rebase/snapshot/reconnect/export wire formats stay unchanged. Rebase/export may still flatten.
* Headline 4 MiB warm ack dispatch p50/p95/p99 1.33/3.42/5.65 → 0.030/0.059/0.075 ms (384 keys); reverse edit dispatch 1.31/3.50/6.26 → 0.039/0.079/0.097 ms (192 edits). Client CPU /96 keys 202.13 → 39.17 ms; /48 reverse 82.32 → 6.36 ms. Driver RSS after typing 233040 → 196092 KiB. Key→applied ack 5.97/14.77/20.30 → 3.22/3.84/5.21 ms, with durable write and fanout intact (20072 journal B in every run; total bytes read on the peer socket were 15728–16722 before, 15160 after, and include other protocol messages). Synchronous handler and CPU comparisons isolate client-side improvement much better than end-to-end on this device.
* Large first ack handler gets slower: 0.026 ms (0.026–0.034) → 1.22 ms (0.91–2.38). The first edit builds rope chunks/newline metadata; small or unedited buffers are not preemptively chunked on open. Large attach 27.88 (26.95–46.35) → 28.40 (27.27–35.74) ms; client RSS after attach 167716 → 167192 KiB and same nearest-rank medians after first key. RSS is process-wide, not an allocation measurement.
* Small warm ack dispatch p50 0.026 → 0.028 ms, p95 0.044 → 0.050; remote 0.042/0.11/0.51 → 0.043/0.12/0.64. No small-buffer win claimed. Small key→ack p50 4.87 → 3.34 but baseline individual run medians span 3.26–15.80, and in an earlier mixed-source set end-to-end went the other direction; this is not attributable to the microseconds of handler difference. Our four matched runs hold server code/settings fixed; e.g. large open (peer snapshots, not changed code) varies 53–109 ms, small open 7–85 ms. Device/scheduler variation was not independently isolated. No change to journal or durability, no assertion on edwind CPU/RSS or disk latency. A second candidate (reduce/time journal sync) was rejected: the durability window is a correctness contract, and median large baseline client CPU was ~5× daemon CPU. Small catchup/idle are already cheap relative to frame key repeats here; the idle process uses more than zero CPU but has no attributed disk writes in the timed idle section.

## Many idle files: supplementary sampling

Two additional matched pairs ran a8,b8,b9,a9 with counters around creation+open of 64 five-byte files. Labels 8,9 in the next table: wall ms and RSS deltas are per-sequence (sum of 64 sequential opens + file creation by driver) — not an isolated per-buffer object or retained size. One socket peer opens them; these are not 64 rendered/headless-frame displays. The timed idle observations above follow these same operations.

| Metric | Baseline (8,9) | Changed (8,9) |
|---|---|---|
| elapsedMs | 3985.97, 2976.11 | 2018.33, 341.21 |
| clientRssDeltaKiB | -4644, -52004 | -9328, 0 |
| daemonRssDeltaKiB | -2424, 2812 | 236, 220 |

| Phase | Metric | Baseline | Changed |
|---|---|---|---|
| idleOpen | clientCpuMs | 110.13 [110.13–159.15] | 16.81 [16.81–57.68] |
| idleOpen | clientRssKiB | 231028 [231028–231432] | 221320 [221320–231180] |
| idleOpen | daemonCpuMs | 140 [140–220] | 60 [60–110] |
| idleOpen | daemonRssKiB | 341272 [341272–348760] | 399836 [399836–401892] |
| idleOpen | daemonPeakRssKiB | 360424 [360424–362320] | 399836 [399836–401892] |
| idleOpen | daemonIo.rchar | 7459 [7459–8751] | 7468 [7468–7468] |
| idleOpen | daemonIo.wchar | 274916 [274916–318526] | 105601 [105601–238441] |
| idleOpen | daemonIo.syscr | 317 [317–458] | 313 [313–320] |
| idleOpen | daemonIo.syscw | 409 [409–577] | 390 [390–401] |
| idleOpen | daemonIo.read_bytes | 0 [0–0] | 0 [0–0] |
| idleOpen | daemonIo.write_bytes | 1060864 [1060864–1105920] | 856064 [856064–1015808] |

These supplementary runs exhibited substantial storage/scheduling variation (unchanged-server small key→ack median ran as high as 108.54 ms). No idle-open improvement is claimed: this path does not use the changed frame shadow at all. The additional large ack-handler checks remain directional: 192: 2.00/3.93/5.95 [1.85, 2.11] → 192: 0.026/0.046/0.054 [0.030, 0.023].

## Worker initialization and garbage collection (separate instrumented baseline run)

In an additional private diagnostic, both the benchmark driver and the edwind child ran Node with --trace-event-categories=v8,node.worker, with monotonic timestamps aligned to the /proc meter reads. Exclude these timings from all comparison samples. Daemon trace has 8 Node WorkerThreads (including edwin-thread-0..5), besides V8 platform threads. The driver shows only JavaScriptMainThread and V8 platform/task threads: the headless frame explicitly disables app workers. The first nonmetadata events on edwin-thread-0..5 were approximately -32,+35,+120,+188,+255,+340ms relative to listening; in this run small typing started at +252ms. The server image and notes parser are also separate worker isolates. Daemon CPU counts all threads.

| Traced phase | Driver minor/major GC events | Daemon minor/major GC events |
|---|---|---|
| whole program | 30/5 | 53/27 |
| small typing | 0/0 | 10/3 |
| large typing | 8/1 | 0/0 |
| large remote | 3/0 | 0/0 |
| 64 files | 0/0 | 0/0 |
| idle | 1/2 | 0/14 |

Counts are start events on all threads in a single baseline trace; not attribution for a particular timing outlier nor a claim about changed GC. In particular, idle CPU includes collection activity in **both** processes in this run.

## 32 additional protocol-frame subscribers on the same buffer (two pairs)

After the idle window: 32 fresh kind=frame clients each connect, negotiate hello, and open the same already-loaded five-byte file. The pre-existing writer remains attached (33 readers/writers of this buffer). This measures connection, session and subscription overhead, not 32 separate editor heaps. A single one-character edit by that writer must get a durable ack and be decoded by all 32 subscribers with exactly the expected version and ops. The edit is outside the earlier 96-key samples. All cohort sockets close in finally. Same private matched snapshots; extra observation order b10,a10,a11,b11. Two totals per cell in label order (10,11); CPU milliseconds, RSS KiB, counts and bytes as labeled. Recorded CPU uses 10ms daemon ticks; one edit can fall between ticks.

| Phase | Metric | Baseline | Changed |
|---|---|---|---|
| sharedAttach | count | 32, 32 | 32, 32 |
| sharedAttach | daemonUserMs | 0, 10 | 0, 10 |
| sharedAttach | daemonSystemMs | 0, 0 | 0, 0 |
| sharedAttach | daemonRssKiB | 337072, 336208 | 335340, 337056 |
| sharedAttach | daemonPeakRssKiB | 414360, 400740 | 399872, 400876 |
| sharedAttach | daemonIo.rchar | 4832, 4832 | 4832, 4832 |
| sharedAttach | daemonIo.wchar | 18560, 18560 | 18560, 18560 |
| sharedAttach | daemonIo.syscr | 64, 64 | 64, 64 |
| sharedAttach | daemonIo.syscw | 128, 128 | 128, 128 |
| sharedAttach | daemonIo.read_bytes | 0, 0 | 0, 0 |
| sharedAttach | daemonIo.write_bytes | 0, 0 | 0, 0 |
| sharedAttach | daemonIo.cancelled_write_bytes | 0, 0 | 0, 0 |
| sharedAttach | clientCpuMs | 4.49, 8.56 | 4.15, 11.78 |
| sharedAttach | clientRssKiB | 135408, 135420 | 132816, 131064 |
| sharedAttach | elapsedMs | 5.49, 9.17 | 3.47, 12.44 |
| sharedAttach | daemonRssDeltaKiB | 376, 24 | 380, 376 |
| sharedAttach | clientRssDeltaKiB | 480, 480 | 480, 480 |
| sharedAttach | peerBytesRead | 15232, 15232 | 15232, 15232 |
| sharedAttach | daemonCpuMs | 0, 10 | 0, 10 |
| sharedEdit | daemonUserMs | 0, 0 | 0, 0 |
| sharedEdit | daemonSystemMs | 0, 0 | 0, 0 |
| sharedEdit | daemonRssKiB | 337120, 336208 | 335384, 337140 |
| sharedEdit | daemonPeakRssKiB | 414360, 400740 | 399872, 400876 |
| sharedEdit | daemonIo.rchar | 70, 70 | 70, 70 |
| sharedEdit | daemonIo.wchar | 4745, 4745 | 4745, 24142 |
| sharedEdit | daemonIo.syscr | 1, 1 | 1, 1 |
| sharedEdit | daemonIo.syscw | 34, 34 | 34, 35 |
| sharedEdit | daemonIo.read_bytes | 0, 0 | 0, 0 |
| sharedEdit | daemonIo.write_bytes | 4096, 4096 | 4096, 24576 |
| sharedEdit | daemonIo.cancelled_write_bytes | 0, 0 | 0, 0 |
| sharedEdit | clientCpuMs | 3.21, 3.81 | 4.04, 6.70 |
| sharedEdit | clientRssKiB | 135728, 135932 | 133136, 131544 |
| sharedEdit | durableAckMs | 9.06, 8.64 | 10.56, 37.76 |
| sharedEdit | allFanoutMs | 9.85, 9.44 | 11.32, 39.45 |
| sharedEdit | journalBytes | 184, 184 | 184, 184 |
| sharedEdit | peerBytesRead | 4512, 4512 | 4512, 4512 |
| sharedEdit | daemonCpuMs | 0, 0 | 0, 0 |

No per-subscriber object sizes or change in daemon scalability inferred. No daemon code changed, and only the wire clients exercised this diagnostic.

