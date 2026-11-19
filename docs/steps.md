# Edwin build steps

The step logs, moved from the README. They were written while Edwin was the `edwin/` directory of Workbench, so
the `crates/`, `web/`, `tests/`, `docs/DESIGN.md`, `nix/module.nix` and `nix/vm.nix` they name are Workbench's.

## Step E0: the core without a browser (done)

The E0 gate of the edwind spec (§17) passes: `edwin-scheme`, `edwin-headless` with no stubs, and the other checks.

- **Host layer and boot (R4.1, R4.11, R9.1).** `index.html` loads `host-browser.js` (stripped from `host-browser.ts`) first and calls
  `Ed.boot({host, frame})` after all 13 files. Under Node, `require('./src/host-node.cts')` gives `createHost` and
  `loadEdwin`; then `Ed.boot({host})`. Boot loads `emacs`, `evil`, `org`, `ai`, `init`, then the user's
  `~/.config/edwin/init.scm` when the host has one. Each shipped file is a feature, so `(require 'org)` does not load it again.
- **Frames (R9.2, headless part).** Page elements are parts of a frame made by `Ed.makeFrame(root, parts)` and read
  with `frame.el(name)`. `selected-frame` is `#f` with no page. Per-frame window trees and minibuffers come with E3.
- **Language (R4.3–R4.10, R4.31–R4.34).** BigInt exact integers, R7RS ports and buffer ports
  (`open-buffer-output-port`), first-class environments, source locations, weak tables, record printers,
  `provide`/`require` over `load-path`, handlers before unwinding, a condition hierarchy, restarts, and a shadow
  stack capped at 10,000 frames.
- **Markers (R6.11, R6.12).** One routine, `shiftMarkers`, moves point and the other windows' points (after
  markers), the mark, Evil's marks and jumps and the temps (before markers) through every change, and undo
  puts back markers a deletion moved. `copy-marker`, `set-marker`, `marker-insertion-type` and the rest work as in Emacs.
- **Hooks (R4.22, R4.23).** `before-change-functions` and `after-change-functions` run for every change, undo
  included; `(edit-origin)` says `local`, `remote`, `server`, `disk` or `agent` (`Ed.withOrigin` sets it). A
  function that signals is reported and removed. Pre-command, find-file, save, kill-buffer, buffer-list-update,
  window-configuration-change and focus hooks are Scheme hook variables.
- **Advice, modes, buffer-locals (R4.24–R4.26).** `advice-add` with all six kinds; `define-minor-mode`,
  `define-derived-mode`; `make-local-variable`, `setq-local`, `defvar-local`, `buffer-local-value`,
  `kill-local-variable`, `default-value`, `put` and `get`.

Choices E0 made where the spec left one open:
- A minor mode's state is in `NAME-enabled` (without `-mode`), not in `NAME`: Edwin Scheme is a Lisp-1, so the
  variable cannot share the command's name. `define-minor-mode` takes `:variable` to name another.
- Called from Lisp with no argument, a mode command turns the mode on; as a command it toggles (as in Emacs).
- Shadow-stack entries are pushed when a compound procedure is entered, not at each call site, to stay under 10%.
- No rationals: `(exact 2.5)` is 2.5. `guard` tests its clauses before unwinding. The watchdog and `quit` are not
  under `error`, so `error?` is false for them and `guard` with `error?` does not catch them.
- `(newline)` stays the editor command from `emacs.scm`, as in Emacs; write a line break to a port with `write-string`.
- Retiring the localStorage stores and the importer (R4.12) wait for served mode (E3); the core already reaches
  storage only through the host.

## Step E1: edwind, the text daemon (done)

`server/` is edwind: a Node process that loads the core headless, keeps every shared buffer as an Edwin
buffer, sequences edits from any number of clients over `edit.sock`, journals them, saves atomically and watches
the files on disk. `crates/wb-cli` is `wb buf`, `wb eval`, `wb edit` and `wb repl` over the same socket.
`nix/edwind.nix` installs `share/edwin/{src,scm,server}` and `bin/edwind` (the workbench package links them); `nix/module.nix` has
`services.workbench.edit.*` and `workbench-edit.service`; `nix/checks.nix` has `edwin-ot`, `edit-conformance`,
`edit-crash` (about thirteen minutes: 1,000 kills) and `edit-disk`; `nix/vm.nix` step 10 covers R16.18's E1 part.

Layout of `server/`: `main.mts` (config, start, listen, `--check`, `--export`, evaluation, the E1 server
commands), `session.mts` (one client: §7 messages), `sequencer.mts` (rebase, apply, journal, ack, replay, undo),
`buffers.mts` (open, save, revert, disk changes, compaction, index), `journal.mts` (group commit, snapshots, the
image log), `files.mts` (text files, CRLF, atomic save), `paths.mts` (ids and the file authority of R14.8),
`watch.mts` (inotify, the line-then-character diff, the three-way merge), `proto.mts` (constants and field
checks). `src/ot.ts` is the OT library both ends share; `test/edit-client.mts` is the test client.

Running edwind by hand: `edwind --config edit.json` where `edit.json` has at least `notesDir` (see
`loadConfig` in `main.mts` for the fields of R15.4); the socket's directory must be yours and 0700.

Choices E1 made where the spec left one open, and where it had to deviate:
- **No `--permission` (R14.12).** Node 22 and 24 disable `fsync` and `fdatasync` under the permission model, and the
  journal and atomic save need both (R8.3, R8.7). `bin/edwind` runs with `--disallow-code-generation-from-strings`
  and `--max-old-space-size` (the intrinsics lockdown is in-process, next item); `main.mts` replaces every function of
  `child_process` before anything else runs (`guardProcesses`, R4.45), and the Authority in `paths.mts` is the
  one check on file writes, with the unit's `ProtectSystem=strict` and `ReadWritePaths` behind it. The
  conformance suite checks the flags in effect and the guard (R16.16).
- **No `--frozen-intrinsics` (R14.11), since 2026-10-16.** The flag made the Scheme evaluator 2.3 times slower
  (gen mode, geometric mean of the server bench: 131 ms against 59): V8 leaves its fast paths for every
  object once any property of `Array.prototype` or `Object.prototype` is read-only. `server/lockdown.mts`
  does the flag's work with Node's own lists, in every thread of edwind (`main()`, `worker.mts`, the notes
  thread), except that those two prototypes are sealed, not frozen: they take no new keys and lose none (the
  prototype-pollution case), but an assignment over one of their existing methods is no longer refused. The
  functions they hold are frozen. Iterator and generator prototypes keep read-only data properties instead
  of the flag's override accessors, which cost every for-of loop and generator step. The server thread logs
  `"lockdown":"locked"` on its `listen` line; `test/lockdown.test.mts` is the suite.
- **Stack size.** The Scheme cap of 10,000 frames (R4.34) needs about 7 MiB of JS stack in direct mode (about
  8.4 MiB in E2's generator mode); Node's default reaches about 1,500. E1 sized `--stack-size` from `ulimit -s`;
  since E2 `main.mts` runs the server on a worker thread whose stack it sizes itself (`runInThread`, 32 MiB,
  `EDWIND_STACK_MIB`), so neither `bin/edwind` nor the unit depends on the soft limit. `guard` catches the JS
  stack running out as the `recursion-depth` condition when the stack is smaller than the cap. Browser frames
  keep the browser's depth.
- **Resend acks wait for the disk.** A batch's `(cid, seq)` is recorded when it is applied, but a resend arriving
  before its `fdatasync` returns gets the ack only after it (R7.15 with R8.3). Edits for a batch go to the clients
  attached when it was applied; a client that opens in between gets it from the `open{since}` replay, never twice.
- **Journal `ENOSPC`.** An append that fails rolls the batch back (text, history, version) and refuses the edit
  with `read_only` naming the error; the buffer stays read-only until a save or a restart. A save needs no
  append and clears it. Nothing acked is lost (R16.7). `EDWIND_FAULT=enospc-save|enospc-journal` injects the
  failure for the crash suite; the container has no quota filesystem.
- **A whole last journal line without its newline counts;** a torn one is dropped and logged (R16.6).
- **The watchdog interrupt reports as the `timeout` condition** (R14.13), with the deadline 2 s for frames and
  web, 30 s for `wb`; `server-edit` calls have none.
- **`server-edit-done` and `server-edit-abort`** are E1 server commands that finish a `wb edit --wait` (exit 0,
  saving if modified; exit 1) until frames exist (E3); a kill of the buffer also ends it with 1.
- **`name:` ids** attach to Edwin's own buffers; the server's special ones (`*Messages*`, `*scratch*` and the
  like) open read-only with the reason `server special buffer`. Files outside the writable paths open
  read-only with the reason `outside the writable paths` (R14.9); files over 32 MiB open read-only and
  unjournaled; non-UTF-8 files are `not_text`.
- **Undo.** Undoing one's own batch after a later batch of someone else is done by `OT.undoOps`: the inverse,
  transformed through everything after it, with complete undo pairs cancelled (`undo.of`, `undo.ofCid`), so
  a redo after an undo returns the text. A partial undo says so in `msg` (R6.17). Server undo batches are
  `undo: {g: "undo-…", of, ofCid}`.
- **Markers under concurrency (R16.3).** Markers that no deletion reached agree between every replica and the
  server. A marker at the boundary of a deleted range can legitimately differ by the length of a concurrent
  insert landing at that point: both sides apply Edwin's `shiftMarkers` rule, but see the operations in a
  different order. `ot.test.mts` states the property that holds; the frames' point stays where the user expects.
- **Edwin's key-value store** (`storage`) lives in `stateDir/storage.json`; compaction snapshots the text at the
  start of the retained history; journals compact at 4 MiB or 20,000 lines and after a save. The new snapshot
  is written as `<jid>.snap.new` and renamed over `<jid>.snap` once the compacted journal is in place, so a kill
  at any step leaves a journal whose base one of them matches (reload and `--check` try both).
- **`web.json`** is untouched in E1 (`editSocket`, `refusePaths` and the notes forwarding came with E2, R15.5; the
  `/edit` relay is E3); the module writes `refusePaths` into `edit.json` only. `/api/status`'s `edit` block
  (R15.11) came with E2 as well.
- **VM steps left for later phases:** `wb edit --wait` finished from a frame (E3) and the A7 migration dry run
  (E4). The other R16.18 steps run in `nix/vm.nix` step 10. The security suite's socket cases of R16.12 are in
  `edit-conformance` (start refusal) and the VM (another uid).
- **`CRASH_ROUNDS`** sets the kill count of the crash suite (default 1,000); `OT_RUNS` the fast-check runs
  (default 10,000); `EDWIND_LOG=1` streams edwind's log in the test harness.

## Step E2: the Lisp machine (done)

E2 makes the server image a Lisp machine (spec §4 after E0, §5 sessions, §11, §12, R15.6): the evaluator runs
in generator mode so threads can block, be preempted, time out and stop in a debugger; every `call{form}` and
every `(:where 'server)` command is a thread; the image log replicates definitions to frames; the notes index,
the model layer and processes through the hub are server modules with Scheme primitives. `nix/checks.nix` has
the gates `edit-image`, `edit-notes`, `edit-address`, `edwin-bench` (the evaluator budgets), `edit-lisp`,
`edit-process`, `edwin-pool` and `edit-security`; wb-web forwards the notes endpoints and `sample` over `edit.sock`.

Layout added in E2 (`server/` unless said): `threads.mts` (the scheduler, held buffers, ask, timers,
blocking primitives; `scm/threads.scm`), `debug.mts` (the debugger, the inspector, apropos, find-definition,
room, list-threads, list-clients, the primitive registry; `scm/debug.scm`), `image.mts` (the image log and its
replication, `*image-log*`), `notes.mts` and `notes-parse.mts` (the notes index on a worker thread;
`scm/notes-syntax.scm` is the grammar), `worker.mts` and `jobs.mts` (the worker pool's Node host, with
`src/pool.ts`), `scm/address.scm` (block addresses, R6.14), `process.mts` and `hub.mts` (processes through the
hub; `scm/process.scm`), `models.mts` (backends,
`http-request`, credentials, `sample`, usage; `scm/models.scm`). Modules install through the extension points
of `main.mts` (`MODULES`, `defineCommand`, `onMessage`, `statusProviders`, `buffers.on`).

The evaluator in generator mode (R4.38, `src/scheme.ts`): the same compiler produces generator closures, run
with `yield*`, except for nodes that can call no compound procedure (constants, variable references, lambda,
calls to primitives with such arguments), which stay plain closures marked `.d`; a compound procedure keeps a
`gbody` for the generator path and a plain entry that drives it (`driveSync`), so JS callers (hooks, sort
predicates) still call procedures as functions. A thread yields `Block(promise)` (sleep, ask, join, I/O),
`PREEMPT` (its slice is over) or `Suspend(condition)` (the debugger); `ThreadState` and `switchTo` swap the
shadow stack, the handlers, the restarts and the parameter bindings. `loadEdwin(host, {mode: 'gen'})` selects
it; frames and workers stay in direct mode. Budget: the gen/direct geomean of `scheme-bench.mts` is 1.2x
(limit 3x); the shadow stack costs 8.4% (limit 10%). Both suites of `scheme.test.mts` run in both modes.

Choices E2 made where the spec left one open, and where it had to deviate:
- **Command threads are not preempted but do break.** A command thread (one `call{form}`, one server command)
  runs until it finishes, blocks or passes its deadline (R4.39), letting the event loop run every 20 ms so
  messages are read (interrupt, answer, edits to buffers it does not hold); nothing else runs in those breaks,
  since the thread is queued first again. Background threads get 5 ms slices round robin (R4.40). Deadlines
  count runnable time only: a blocked thread does not spend its 2 s (frames) or 30 s (cli).
- **Held buffers (R4.41).** A thread holds a shared buffer from the moment it edits it or makes it current
  (`set-buffer`, `with-current-buffer`, the call's `buf`) until its next blocking point or its end. Its edits
  (Edwin's edit log entries with origin `local`) are then sequenced as one batch in normal form, attributed to
  the caller (`by` with `via: "server"`, the frame's `cid`, R4.28); client edits to a held buffer wait in the
  sequencer and are rebased after it. A hold longer than 250 ms of runnable time ends the thread with the
  `timeout` condition; what it edited is still sequenced. A server batch (`replaceText`, undo, a second
  thread) on a held buffer first flushes the holder's pending edits, so history stays in rope order; the
  holder may then find its positions moved (recorded choice: holds do not block the server itself).
- **Handlers in direct nodes run in place and cannot block.** A primitive error raised from a `.d` node with
  handlers installed runs the handlers synchronously (R4.31 holds), but a handler that blocks there gets
  `cannot-block`; the generator path has no such limit.
- **The server runs on a worker thread** (`runInThread` in `main.mts`) with `resourceLimits.stackSizeMb` 32, so
  the 10,000-frame cap holds whatever `ulimit -s` is; the main thread relays SIGTERM and SIGINT. Logs are
  written synchronously (`fs.writeSync(2, …)`) because a worker's `process.stderr` is an asynchronous relay.
  `--stack-size` left `bin/edwind` and the test flags; `EDWIND_NO_THREAD=1` runs on the main thread.
- **`timeout` and `thread-cancelled` never enter the debugger**; `quit` and `scheme-interrupt` are passive
  as before. `debug-on-error` defaults to true but applies to commands run for frames only: cli calls
  (R13.10) and background threads report. A thread suspended in the debugger is resumed by `interrupt`
  (`quit`) or `thread-kill` as any other; the debugger drops its session.
- **The abort restart ends a thread with the `aborted` condition** in the call's result (R4.37); `thread-join`
  sees `thread-cancelled`. A mutex a finished thread still holds is released.
- **Tail calls shape the backtrace.** `(define (f x) (car x))` shows only `car` at the signal: `f`'s frame is
  gone, as proper tail calls require. Locals by parameter name are those of live frames.
- **`define-command` accepts `(:where w)` after the interactive clause** (`set-command-where!`, both runtimes).
  `Server.command()` tries the JS server commands, then Scheme commands declared `server` or `both`; an
  interactive spec reads its arguments through `ask` when the call carries none. The image's six `image-*`
  commands are declared `server`. Frames send `call{cmd}` for them in E3 (R4.27); until then a frame that
  invokes one locally gets the E1 behaviour.
- **`ask` kinds** are `string`, `completing` (with `table`), `y-or-n`, `yes-or-no`, `number`, `char`; a cli
  caller gets `user-error` from `read-string` and friends (no minibuffer to ask).
- **Timers (R4.46)** accept seconds, `"N sec|min|hour"` and `"HH:MM"`; idle means no input from any client
  (`server.onInput`); each firing is a background thread named after the function.
- **`make-thread` from a thread run for a frame keeps that frame's `by`,** so a background thread's edits count
  as the frame's; timers' threads are the server's.
- **The primitive registry (R4.48)** is built at runtime: `def` captures each primitive's definer in the server
  image (frames skip it), and the registry reports name, arity, documentation, `where` (`server` for module
  primitives and marked ones, else `both`; no primitive is marked `frame` yet, a deviation to fill as frames
  grow), whether it blocks and its source line. `edwind --config … --primitives` prints it; `describe-function`
  says where a procedure runs. Named server commands and the Scheme commands of `debug.scm` are kept apart
  (`thread-list`/`list-threads`, `apropos-list`/`apropos`, `definition-of`/`find-definition`, `room-info`/`room`).
- **The debugger's keys are server commands** (`debug.scm`: `backtrace-mode`, `inspector-mode`); a frame that
  shows `*Backtrace*` runs them through `call{cmd}` with its point (E3 loads `debug.scm` in frames for the
  modes). `wb` reaches the same through `debugger-state`, `debugger-frames`, `debugger-eval`, `debugger-restart`,
  `debugger-continue`, `debugger-abort`, `inspect`.
- **R4.15 amendment (decided 2026-10-14 in the hypernotes thread, for E3 and later):** forms evaluated in a
  note's environment are not definitional for the image log (not appended, not broadcast). `image.record`
  inspects only the heads of top-level `call{form}` forms, so nothing in E2 conflicts; H1 implements it (see
  "Hypernotes H1" below).
- **The notes index parser runs on a dedicated `worker_threads` worker** (not the pool): `notes-grep` and
  `unlinked-mentions` block the calling thread while it searches (the sync channel remains for callers outside
  a thread). The pool's Node host compiles the lexer from a source string inside the worker and duplicates the
  built-in jobs (deviations recorded in `jobs.mts`).
- **The hub client (`hub.mts`, `server.hub`)** connects to `hubSocket` when edit.json names one (with none,
  edwind dials nothing and process primitives raise `hub-error` at once), answers the hello as
  `edwind/<build>`, sends one `watch` (R5.7) and keeps the session summaries current; it reconnects with a
  backoff (250 ms to 5 s, jitter) and re-attaches live processes with `pty.open {resume}` (no
  spawn). An unreachable hub is logged at debug level only. Conditions `hub-error`, `process-error`,
  `stale-object`, `no-leader` sit under `error`; status gains `hub`, `hubVersion`, `hubSessions`.
- **Processes (R4.43–R4.45, `process.mts`, `scm/process.scm`)** are hub PTY sessions with ids `ed-` + 16 base32
  chars; `make-process` takes `:name :command :shell :cwd :env :size :buffer :filter :sentinel :noquery`
  (default shell bash if the hub offers it, size 120x40). Output and exit run filters and sentinels on background
  threads, queued per process so chunks stay ordered; insertion at the process mark ignores read-only (as Emacs
  binds `inhibit-read-only`), with `by {kind: "server", thread: "process NAME"}`. `call-process` and
  `shell-command-to-string` use a PTY with `TERM=dumb NO_COLOR=1` (bash, sh, zsh only), strip ANSI and
  CR, and forget the corpse (`pty.kill forget:true`); `:timeout` signals `timeout`. `accept-process-output`
  returns at once when output arrived since the last call (Emacs). `M-x list-processes` is a server command
  rendering `name:*Process List*`. `kill-process`, like `delete-process`, makes the hub forget the session.
  `pty.resize` is not sent.
- **The §5 session API** (`wb.mts`, `scm/wb.scm`, `wb-*` hooks, `:card`) was removed on 2026-10-19: nothing
  called it (see "Edwin without Workbench").
- **The model layer (§12, R14.4–R14.7)** is `models.mts` with `scm/models.scm`. Backends are objects of two
  kinds, the ones the spec names (`anthropic`: Messages API, `x-api-key`; `openai`: chat completions, bearer);
  the default backend `anthropic` (until 2026-10-19 named `workbench`) is `models.anthropic` of `edit.json`, its models the tier values; a backend
  without a credential is usable only on a loopback origin (a local model server). The key is read from
  `$CREDENTIALS_DIRECTORY/NAME` at request time and never stored on the handle, and that directory is on the
  refusal list, so no client opens a credential file as a buffer; `http-request` takes `:method
  :headers :body :credential :credential-header :timeout :on-chunk`, retries 429/503/529 three times
  (`retry-after`, else 1 s doubling) under a 10 min deadline covering the tool rounds (at most 8). `sample`
  runs on a background thread per stream (`by {kind: "web", cid, device, tab}`), `cancel` interrupts it with
  the `cancelled` condition; four requests run at once and the rest queue (R12.13). One usage line per request,
  success or failure, goes to the log and `stateDir/usage.jsonl`; `model-usage` sums them. The server rebinds
  `gptel-make-anthropic`, `gptel-make-openai`, `gptel-backends` and `gptel-send` that `ai.ts` defines for
  frames, since those use `fetch` and browser-stored keys (R14.4). The commands (`gptel-send`, `gptel-abort`,
  `model-usage`) are in `scm/gptel.scm`, which a served frame loads after its own files, so its keys for
  `gptel-send` (`SPC g j`, `C-c i`, Org's `C-c RET`) run edwind's and not `ai.ts`'s; the rest of `ai.ts`
  (`gptel`, the menus, presets, rewrite) is still the page's own and works in the artifact only. Not in E2: Edwin's built-in tools for gptel
  and the confirmation flow (R12.10–R12.12), `gptel`, `gptel-rewrite` and presets (R12.9) on the server; a
  backend defined in `init.scm` runs before the module loads (define it after, or on feature `models`).
  Thread batches carry an undo group (`undo: {g: "thread-…"}`) so gptel output undoes like any writer's.
  Since 2026-11-09 the two kinds' wire formats are pi-ai's (README, deviations); `http-request` keeps Edwin's own
  HTTP engine, and the model calls keep its rules through the `fetch` pi-ai is given (`fetchFor`).

## Step E3: frames in the browser (done)

E3 puts Edwin into the page cards (spec §9, §10, R8.16–R8.20, R13.7): with `edit.frames` on, every page card
is an Edwin frame on a shared buffer served by edwind, the buffer the agent tools, the notes index and the
`wb` CLI already share. Nothing moves until the flag is on; with it off the CodeMirror page is as before and
the whole browser suite passes in both modes (`node tests/ui.mts <root>` and `WB_FRAMES=1 node tests/ui.mts
<root>`). `nix/checks.nix` gains `edit-anchors`, `edwin-markdown` and `edit-frame`; `ui` and `ui-frames` run the
browser suite in each mode, and the VM test turns `edit.frames` on.

Layout added in E3: `src/sync.ts` (the replica client: `Ed.sync`, `Ed.bootServed`), frames in
`src/editor-core.ts` (`Frame`, `Ed.makeFrame`, one text-change path `applyOps`) and `src/editor-prims.ts`
(frame commands, `Ed.setLeaderKey`, served boot), `src/markdown.ts` and `scm/markdown.scm` (markdown-mode),
`server/anchors.mts` (shared anchors and the frame commands), `console/index.html` (the `/edwin/` console),
`web/app.ts`'s frames block (lazy frames, keys, migration, R13.7 tools), and in wb-web `relay_edit.rs` (the
`/edit` relay), the `frames` key, `/api/info` `edit`/`editUp`, `/edwin/` static files and the board guard.

The wire (§7, R9.16–R9.17): each tab opens one WebSocket to `/edit`; wb-web opens one Unix connection to
`edit.sock` per tab and copies text frames to lines and lines to frames, parsing nothing. Close codes: 1003 for
a binary frame or a frame holding a newline, 1009 over 16 MiB either way, 1011 when edwind closes, 1012 when
wb-web stops, 1013 with no edwind. The browser sends its own `hello` with `kind: "frame"`.

Frames (R9.1–R9.15): a `Frame` owns its window tree, minibuffer, echo area, input textarea and popups; `E.root`,
`E.sel`, `E.mini`, `E.echo` are accessors onto the selected frame, so a frame-less runtime (edwind, the tests)
keeps one implicit tree. `Ed.makeFrame(el, {buffer, kind: "card"|"console", fontSize})` builds the DOM
(`.edwin-frame > .ed-windows + .ed-echo + .ed-presence + textarea.ed-input`, a menubar for the console) and
injects one stylesheet mapping Edwin's faces and markdown-mode's `--md-*` variables onto the board's tokens,
re-rendering on `data-theme` changes; geometry is read through `getBoundingClientRect` so a frame under the
canvas transform places point and popups correctly. The page keeps a frame only for cards in or within one
viewport of the view at zoom ≥ 0.45, at most 24 (LRU), and shows the first 12 raw lines otherwise; a replica
off-screen for 5 min is closed. Enter on a selected card focuses its frame; inside it every key is Edwin's
except the board leader; leader then Esc leaves (`Ed.hooks.leaveFrame`); Esc alone is Evil's. The mode line
shows `•` (unacked), `⚠ offline`, `⚠ disk` and `⟳` (a pending server call); presence from other writers'
`sel` is drawn with a colour per writer, an agent's cursor fading 5 s after its last edit.

The replica (R6.3–R6.23, §7): every text change goes through `applyOps(b, ops, origin)` (rope, markers, log,
change hooks with `(edit-origin)`, redisplay); local edits are grouped per command (an Evil insert session or a
run of self-inserts shares a group) and sent as one unacked batch with a queue behind it, composed while
waiting; incoming batches are transformed against inflight and queue with `ot.ts`, as the `ot-sim` model;
undo on a shared buffer is by group, inverse-transformed through history (`undo: {g, of}`), with the server's
`undo` command as the fallback for groups before the kept history, while local buffers keep snapshot undo.
Hash checks every 50 versions, `bad_edit`, `stale_base`, `read_only`, `slow_client`, `shutting_down` and a
reconnect follow §7; a divergence or a stale base puts the local text in `<name>~offline-<time>`; an image
epoch change hands the unsent batches to the page, which reloads the runtime with them.

Served boot (R4.11–R4.12): `Ed.bootServed({sources, transport, device, cid, pending})` boots from the eight
Scheme files edwind ships (`/edwin/scm/`), never from browser storage (an in-memory store replaces it),
connects, evaluates the user's `init.scm` from the `user-init` command, replays the image (`image?{from: 0}`;
`on-server` forms skipped), defines the server-only primitives as stubs that signal `server-only`, and binds
`wiki-candidates` (`capf-candidates`), `notes-directory`, `wiki-follow-function` and `resolve-ref-function`.
A `(:where 'server)` command runs on the server without blocking the command loop; `M-:` and friends evaluate
on the server in served mode, `M-x eval-in-frame` locally.

Anchors (R9.12): edwind holds a page's anchors as shared `after` markers (an insert at the anchor advances it,
as CodeMirror's `mapPos` did), moved by every sequenced edit, journaled as one `{"t":"a"}` line per change and
after disk batches, relocated after a disk revert by the prefix+quote rule the page used, sent in `meta` with
`ver`. Commands `anchor-add` (returns the id, which may differ from the requested one), `anchor-remove`,
`anchors`; primitives `anchor-add!`, `anchor-remove!`, `buffer-anchors`. Ink strokes are anchored as
`ink-<stroke>`; the page draws chips and ink at `frame.lineTop(pos)`.

markdown-mode (§10): faces `markdown-*` for the parity table, wiki links and block refs (the resolved text
shown except on the point's line), anchors, `key:: value` fields, priorities; task keywords come from ONE
table in `scm/notes-syntax.scm` shared with Org (`notes-set-task-keywords!` changes both); commands
`markdown-outline-enter` (the first RET on an empty item outdents; at level 0 it ends the list),
`markdown-demote`/`promote`, `markdown-todo-cycle` (`C-c C-t`, `S-<right>`/`S-<left>`), folding, `]] [[ gj gk`,
`wiki-follow`, `wiki-copy-ref`, `wiki-capf`, `journal-today`, imenu, `markdown-unlinked-mentions` (server,
`C-c C-u`; `C-c C-m` is `C-c RET`, which sends a chat).
Font-lock is incremental: 0.6 ms median per keystroke on a 10,000-line page (budget 2 ms).

Migration (R8.16–R8.20, Q3): with the flag on, a page node without `buf` is migrated once on load to
`notes/<slug>.md` under notesDir (`-2`, `-3`… on a clash), an empty file filled by `notes-fill`, which gives a
note the text only while it is empty, in one step (two tabs migrating at once fill it once; a note with other text
is a clash), its anchors re-created at their relocated positions, then `buf` is set and `text`/`anchors` dropped; wb-web's PUT guard keeps `buf` and strips `text`
when an older tab writes the board, and copies the board to `<host>.pre-edwind.json` once before the first
`buf` arrives. The page is held (no frame, no edit) until the board PUT carrying its `buf` is
answered 204, so the file never differs from the text of a board that lost that save; a 412 shows the conflict
bar rather than restarting the migration as R8.17 says.

Choices E3 made where the spec left one open, and where it had to deviate:
- **The focus tab is the enlarged card with its live frame**, not a second frame; the Editor view (Alt-4) is
  the second frame on the same buffer. Font size in cards is fixed at 13 px (no per-card size setting exists).
- **OT undo applies to shared buffers only**; `*scratch*`, `*Messages*` and config buffers keep the snapshot
  undo, so the standalone page and the headless suites are unchanged. Redo is a new plain group with the
  inverse ops transformed through later batches. A thread's edits made for a frame come back as a synthetic
  group `server-<ver>`.
- **A snapshot that arrives while batches are pending is not a loss when its text equals the acknowledged
  text** (edwind restarted without history): the pending batches are resent.
- **The `/edit` relay does not gate on wb-web's control connection**: it connects to `editSocket` and closes
  1013 on failure, so frames are not refused while the control connection backs off.
- **Anchors are `after` markers** (the contract text said `before`; CodeMirror's `mapPos(pos, 1)` behaves as
  `after`). An id already in use yields a server-chosen id; the caller reads it from the result.
- **The board guard treats `buf: null` as absent** and protects only nodes the PUT carries (a deletion stays a
  deletion); the pre-edwind copy is also made when a new node first carries `buf`.
- **`meta` carries `ver`** (not in the §7.3 table) so a frame can map anchor positions through its unacked
  edits. `sel` is sent from the post-command hook, throttled to 50 ms.
- **markdown.scm loads through org.scm's trailing `(require 'markdown)`**, after Org and before `init.scm`;
  Setext headings fold as paragraphs; emphasis markers stay visible as `markdown-markup`.
- **The `(image-server?)` predicate is `#f` in a frame**; `edwin-import-local-config` (importing the old
  browser-stored configuration into `~/.config/edwin/`) is not written: served mode simply never reads it.
- **Notes and files open as pages (decided 2026-10-15, reversing the spec's NG5/D6 as the default opener).** With
  frames on, `noteOpen` (the navigator, tasks, the journal, note ghosts) and `ghostOpen` (file ghosts of this host)
  open an Edwin page card on the file. edwind decides through the server command `visit-id`: the id it would visit
  the file under, or a refusal (the refusal list, not UTF-8, missing), or read-only (outside the writable paths,
  over 32 MiB). A refusal, a read-only answer, a ghost of another host and an edwind that is down keep the Emacs
  card; `open_in_emacs` and the Emacs button still make Emacs cards. A page with a file has an `fsIdent`, so the
  fs perspective shows it under its directory and a drag moves its file.
- **`rename-file` (R4.49, R6.1, R8.1, §7 moved)** is a server command, `[{src, dst}]` as POST /api/mv sends it;
  wb-web's `/api/mv` forwards to it whenever `editSocket` is set (refusals 400, 503 while edwind is down: nothing
  moves behind its back). Both ends pass `checkWrite`, so `/api/mv` is narrower than wb-web's own rule: the source
  may not be in or above the refusal list either, both ends must be in the writable paths, and edwind's own
  directories stay put. Node has no `renameat2`, so the destination is claimed first (an exclusive create, or
  `mkdir` for a directory) and the rename replaces only the claim. Buffers under the source keep their SBuf, jid
  and history and are updated before the first await, so the watcher never sees their files missing (R8.15 for
  renames). The moved records (old id, new id, time, `dir`) live in `index.json`, not only in the `mv` journal
  lines, so they outlive a kill, a compaction and a restart for their 24 h; a directory's record covers the ids
  under it, and an old id is sent on only while nothing is at the old path again. The answer adds `from` and `to`
  (the ids of both ends) for pages whose replicas are closed. No Scheme primitive yet: `rename-file` in a frame is
  still the browser store's.
- **Not in E3**: K4 (Edwin keymaps in the board's conflict checker) waits for the keymaps PR; a display-text
  mechanism in the renderer (block-ref text is a DOM post-pass) and an `imenuItems` hook are left for later.

## Step E4: Edwin is the only editor (done)

E4 retires CodeMirror (spec R9.21; Workbench DESIGN F-A39). With edwind served every page card is a frame, with no
flag: `edit.frames` and wb-web's `frames` key are ignored (the Nix option warns), and `ui-frames` and the
harness's `--frames` are gone, since `ui` runs frames. Without edwind (the demo, `edit.enable` off) pages are
read-only: no text authority runs there, so no editor is offered, and the board's own edits go through
`web/app.ts`'s page API (`pageEdit`, `pageSetText`, ...) to the node's text. The vendor bundle and
`tools/package-lock.json` no longer carry CodeMirror, `@replit/codemirror-vim` or lezer. Edwin's markdown `[[`
completion gains the hook `linkNames`, through which the board adds its card and folder names, so wiki links to
cards that are not files still complete. The address suite (now Workbench's `tests/address.test.mts`) runs the board's buffer addresses over
`TextDoc` (app.ts's line index) instead of `@codemirror/state`.

## Step DT3: attach anywhere (done)

A desktop frame attaches to an edwind on another machine, ex44's in particular, so its notes (and what ex44's
edwind does with them) are edited from the laptop with the laptop's own editor; and `-a` starts the user's own
edwind when none answers, as `emacsclient -a ''` starts an Emacs daemon. Both are edwinclient's since 2026-11-13
("edwin and edwinclient", below).

- **`--remote HOST:SOCKET`** attaches through ssh:
  `edwinclient -c --remote ex44:/run/workbench-edit/edit.sock journal.md`. The program runs
  `ssh -o BatchMode=yes -W SOCKET ssh://HOST` with ssh's standard input and output on one end of a socket pair, so
  the rest of the program sees one more Unix socket and the protocol is unchanged. HOST is anything ssh takes (`user@host`, `host:port`, a `Host` of
  `~/.ssh/config`). BatchMode: ssh never asks on the terminal the frame holds, so keys come from the agent (or a
  ControlMaster connection, which also makes each connection cheap). edwind's socket directory is mode 0700, so the
  ssh user is the one `services.workbench.user` names; OpenSSH forwards Unix sockets by default
  (`AllowStreamLocalForwarding`). `EDWIN_SOCKET=ssh://ex44/run/workbench-edit/edit.sock` makes the remote
  edwind the default (since 2026-10-19 the address names the socket); `EDWIN_SSH` names the ssh program.
- **Names.** A FILE argument that is not a path on this machine (not `/…`, `~…`, `./…` or `../…`) is a note on
  the remote host, named as under its notes directory (`journal.md`, `projects/edwin.md`); `./draft.txt` is a file
  here, and so is a full path, even when this machine has a notes directory at the same path. Inside, a full path under the remote notes directory is a note there; other names are files on this
  machine (DT1).
- **The connection.** The start waits up to 30 s for the remote edwind to answer (a ping before hello, which
  draws an error reply and proves the whole path; since 2026-11-13 a local edwind is asked the same way) and otherwise exits with status 1 and ssh's reason ("Could not
  resolve hostname", "open failed: connect failed"), before the terminal or a window is taken. After that, a dropped connection is retried while the
  editor runs, as the browser's frames retry: the frame keeps its replica, edits wait in its queue, and ssh's
  reason goes in the log (`~/.local/state/edwin/edwin.log`). Remote latency touches only acknowledgements.
- **`-a`, `--start-daemon`.** When no edwind answers on `$EDWIN_SOCKET` or the user's socket, edwinclient runs
  `edwin-daemon` beside the program (DT4), waits up to 10 s for `$XDG_RUNTIME_DIR/edwin/edit.sock`, and attaches.
  The daemon outlives the frame. Without `edwin-daemon` (a cargo build), or if it fails and no edwind answers by
  then, edwinclient says why and exits with status 1 (until 2026-11-13 it edited on its own); a remote
  `$EDWIN_SOCKET` that does not answer ends the search before `-a` is asked. `EDITOR="edwinclient -a"` gives
  every commit message the same buffers as the window.
- **Checked by** `remote_notes_go_through_ssh` (through `tests/fake-ssh`, which joins ssh's standard streams to
  the socket here; also the failure message) and `dash_a_starts_the_daemon_and_attaches` (a stand-in
  `edwin-daemon` beside a copy of the binary; the frame shows in edwind's log); by hand through a real OpenSSH
  10.5 sshd on localhost: the window edited a remote note, saved, survived the remote edwind restarting (it
  reconnected and saved again), and reported a missing socket and an unknown host.
- **Not in DT3:** wb-web's `/edit` over HTTPS. wb-web accepts a frame only from its trusted front proxy (the
  `x-workbench-proxy-secret` header and `publicOrigin`), so a desktop client would need the proxy's own login;
  ssh reaches the same edwind with the user's keys and no new credential. Starting an edwind on the remote host
  (`-a` is local only), and one frame attached to two edwinds at once (`sync.ts` holds one connection per runtime).

## edwin and edwinclient (done)

Asked 2026-11-13: "edwin should be like emacs, edwinclient should be like emacsclient." Until then every `edwin`
attached by itself to the first edwind that answered, and `--standalone` or `EDWIN_NO_ATTACH` kept it apart. The
split is in Edwin itself, on every host, and the terminal stays the default of both programs.

- **One program, two names.** `edwinclient` is `edwin` run under that name (the last part of `argv[0]`). The
  package installs `bin/edwinclient` as a link to `edwin`; a cargo build gets it with
  `ln -s edwin target/release/edwinclient`. `edwin-daemon` is looked for beside the real file, so a link finds it.
- **edwin is emacs.** It never attaches: `$EDWIN_SOCKET` and the user's socket are not asked, its init file is
  `~/.config/edwin/init.scm`, every file is its own (DT1), and its start restores the snapshot. It keeps `-nw`
  (`-t`, `--no-window`), `-g`, `--geometry`, `-R`, `+LINE`, `-`, `--daemon` and `--fg-daemon`. `--standalone`,
  `--socket`, `--remote`, `-a` and `EDWIN_NO_ATTACH` are gone; given one of edwinclient's options, edwin says it is
  edwinclient's. `programs.edwin.defaultEditor` still sets `EDITOR=edwin`, the editor that never waits on a daemon.
- **edwinclient is emacsclient.** It always attaches: to the edwind `--socket PATH` or `--remote HOST:SOCKET`
  names, else to the first of `$EDWIN_SOCKET` and `$XDG_RUNTIME_DIR/edwin/edit.sock` that answers; a remote
  `$EDWIN_SOCKET` (`ssh://…`) that does not answer ends the search with ssh's reason, as `--remote` would. Its frame
  is the one DT1, DT3 and DT4 describe (notes are edwind's, every other file its own, a cold start). The edwind is
  found before anything is drawn: it answers DT3's ping within 30 s, local or remote, so a socket that accepts and
  says nothing, or closes, is no edwind. When none answers, edwinclient says so in one line and exits
  with status 1 without taking the terminal or opening a window: an edwind `--socket` or `--remote` names, with
  why; else the sockets it tried and `edwin --daemon` or `-a` (with neither variable set, `--socket` or
  `XDG_RUNTIME_DIR` and `edwin --daemon`). It never edits on its own. `-a` (`--start-daemon`) starts the user's
  edwind when none answers (DT3), and when that fails says why and exits with status 1; when `edwin-daemon`
  refuses because an edwind answers by then (another `edwinclient -a` started it), edwinclient attaches to that
  one. `-a` has nothing to start for an edwind that `--socket`, `--remote` or a remote `$EDWIN_SOCKET` names.
  `-t` (`-nw`, `--tty`) asks for a terminal frame, the default, and `-c` (`--create-frame`) for a window, which
  `--geometry` sizes; `-g` is edwin's.
- **`-e`, `--eval`.** The arguments after it are Scheme forms, not files (a FILE before it is one too, as
  emacsclient takes it), and at least one must follow it. edwinclient says hello as a client of kind `cli` (device
  `edwinclient`) and sends the forms as `call`s, one after another; a cli client's failing form answers with its
  error at once instead of waiting in the debugger. Each value goes to standard output as `write` prints it,
  followed by a newline: one line a form, unless the printed value holds a newline itself (a symbol's name can).
  The first error goes to standard error and ends the run with status 1; the forms after it are not sent. No frame
  is made and the terminal is not touched. It works with `--socket`, `--remote` and `-a`. A definitional form sent
  this way (`define`, `set!`, `define-key`, `add-hook!`, ...) enters edwind's image log, as `cli@edwinclient`, and
  reaches every frame, as one typed in a frame does.
- **Not taken from emacsclient:** reusing a frame that exists, and `-n` (`--no-wait`). Every edwinclient is a frame
  of its own and blocks until it ends, as `$EDITOR` wants. What an `-e` form writes to its output port is not
  printed, only its value.
- **Checked by** the pseudo-terminal suite: `edwin_never_attaches` (an edwind answers on both sockets; the user's
  init binds a key, the note is written to the disk, and edwind opens nothing for edwin),
  `edwinclient_without_an_edwind_says_so_and_leaves_the_terminal_alone` (also a socket that closes unanswered,
  neither variable set, and `-a` without `edwin-daemon`), `dash_a_starts_the_daemon_and_attaches` (also an
  `edwin-daemon` that refuses because an edwind started meanwhile), `eval_prints_values_and_stops_at_an_error` (a
  definition read back by a second edwinclient), `help_version_and_bad_options_need_no_terminal` (also the
  command lines main.rs and main.ts must read alike), and DT1's and DT3's attached tests, which run edwinclient
  now. The package's install check runs `bin/edwinclient` through its link.
  The window suite's `edwinclient_c_is_a_frame_of_edwind_in_a_window` needs Xvfb, as DT2's tests do. By hand on
  ex44 with the package and a throwaway home: `edwin --daemon`, `edwinclient -e` (the definition was in the image
  log as `cli`), `edwinclient` with no daemon, and `edwin` beside the running daemon (edwind saw no connection).

## Notes into brain: the projector (done)

Asked 2026-11-10: the roam part of Edwin (nodes, links, backlinks) moves to brain, which already holds tasks,
memories and references. This step is the feed: edwind tells brain what each note file holds. Edwin's own
commands ask brain since the next step, "Nodes from brain".

- **One record per note file (`server/projector.mts`).** `POST <brain>/v1/projection` with `{path, tags, notes}`.
  A note is an entry with an Org id, the file or a heading: `{id, title, aliases, tags, parent, links}`. `parent` is
  the nearest id above it; `links` are the link names written under it (`id:…`, and scheme names such as `task:12`),
  as written, and brain resolves them. No text is sent. A file without ids sends an empty record, and so does a
  file that is gone; brain drops what the path listed before (a note goes when no path lists its id any more), and
  a rename keeps a note's identity because its id moves with it.
- **Gone means gone from disk.** A file is reported gone only when it is in neither the index nor the directory,
  and never while the index is empty. A file the index leaves out (over 4 MiB, unreadable) keeps what brain was
  told of it, and a notes directory that failed to mount deletes nothing. The cost: emptying the directory on
  purpose leaves the last notes in brain, and a file the index left out that is then deleted is reported at the
  next pass, not at once.
- **Only saved text.** A file open in a buffer with unsaved changes waits for its save (autosave is two seconds).
- **A ledger, `stateDir/projector.json`.** Path to the hash of the record brain last took. A restart sends only
  what changed while edwind was down; deleting the file resends every file that exists, which brain takes as no
  change and which also repairs brain after anything else wrote to the notes there. It does not remove the notes
  of a file that went while the ledger was lost.
- **Failures.** One request at a time. A failed one (no answer, 401, 403, 5xx) is retried after one second, then
  doubling up to five minutes, and the file it failed on goes after the others, so one file brain cannot take
  does not hold them up. A record brain refuses (400, 409, 413 with brain's own JSON error: a title that looks
  like a secret) is logged with its path and waits until the file changes; the same status from anything else
  (an error page) is a failure and is retried.
- **Tags** (brain 0.9, 2026-11-11: brain has no scopes). `brain.tags` is a list of tags brain puts on every
  note projected, beside the note's own Org tags; none by default. A record is open to every client of brain
  unless one of its tags hides it, so the notes are kept to the tokens cleared for a tag by naming that tag
  here (`["roam"]`). The list is the same for every file: no line in a file changes it.
- **Config.** `edit.json` `brain: {url, credential, tags}`; in NixOS `services.edwind.brain.{url, tokenFile,
  tags}`. A tag that is not one brain takes (a space, one of `" ( ) , :`, a first `+ - .`, over 64
  characters) is refused at start. The token is a LoadCredential file read for each request. It is not among the credentials Scheme can
  name, and the config refuses a name that is. Plain http is sent only to loopback or to an address of this
  host: the request is bound to leave from the address it goes to, which the kernel allows only for an address
  the host holds, so `http://10.100.0.2:7676` works on the host that holds that address and nowhere else. (The
  first version listed the interfaces instead, which the unit's RestrictAddressFamilies forbids.)
- **The index tells its listeners.** `Notes.onChange` is called after every change of the index. The projector
  compares the whole index with the ledger then (hashes are cached per parse), so it needs no per-file event and
  cannot miss one.

Not in it: files without an id (they are not in brain; give a file an `:ID:` and it is), file and URL links,
Syncthing's conflict copies (skipped: they carry the ids of the file they copy), and a status line for what is
owed (the log has `projector` lines: sent, refused, errors).

## Nodes from brain (done)

Asked 2026-11-10: the commands that found, linked and listed notes read an index the frame built from its own
file store, which is empty in the served browser. They ask brain now, through edwind, and what they find is
every node brain holds, not only notes. The `org-roam-*` commands and variables are gone, with no aliases:
Emacs's names for this are not kept.

- **edwind reads for the frame (`server/brain.mts`).** `brain-titles {q, kind?, limit?}` is brain's
  `GET /v1/titles` and `brain-node REF` its `GET /v1/nodes/REF` (a node id, or `scheme:value` such as
  `org-id:<id>`). The token is `brain.readCredential` (`services.edwind.brain.readTokenFile`), one brain takes
  on its reading routes only and not the projector's; no frame holds it. Without it, or with brain out of
  reach, the answer is the condition `brain-unavailable`; what brain itself refuses is `brain-refused` in
  brain's words. The log has the route and the status, never the query.
- **`brain-node-find` (`SPC n r f`, `src/brain.ts`).** The minibuffer's candidates are brain's names for the
  input: the 50 best, asked for again 120 ms after the typing rests (with nothing typed, the nodes changed
  last). An answer replaces the candidates when it is for the input still shown; a later one for older input is
  dropped. brain's answer for the input shown is listed as brain gave it (the minibuffer's own filter, which
  reads capitals and regexp characters its own way, only narrows an older answer meanwhile), and a highlight
  moved off the first candidate stays on its candidate. `RET` typed ahead of the answer takes nothing from the
  names of an earlier input: brain is asked for what was typed, and the node is the one titled exactly so,
  else brain's first. A candidate is the alias that matched, else the title, annotated with the kind and then the file of
  a note (and `→ Title` after an alias) or the tags of anything else, as Org writes them (`:a:b:`). Two nodes with one name take their kind,
  and the end of their id when the kind is shared too.
- **Opening a node.** A note is its file (`props.sources[0]`), visited through edwind and waited for, with
  point on the entry that holds the note's `:ID:`, unfolded. Anything else is a record: `*brain: Title*` in
  `brain-mode`, read only and in Motion state, written as Org (title, kind · `:tags:` · trust, the plain props,
  the body, the links under a heading per relation), so `RET` (`brain-follow`) opens a link and `q` leaves.
- **`brain-node-insert` (`SPC n r i`, `C-c n i`).** `[[id:ORG-ID][Title]]` to a note, `[[brain:UUID][Title]]` to
  anything else; `[Title](id:ORG-ID)` and `[Title](brain:UUID)` in Markdown. A Visual selection is what is
  looked for and stays as the description. The description is on one line with `(` `)` for `[` `]`, which
  would end the link or start another: titles are anyone's who writes to brain.
- **A name brain has no node for makes a note.** Find and insert make it from `note-capture-templates` under
  `note-directory` (the notes root by default), with a new `:ID:`. Where the notes are edwind's the file is
  made through edwind (opened with create, filled, saved), so it is on disk and the projector sends it; the
  file store of a served browser is memory edwind never sees. `dailies-goto-today` and `dailies-goto-date`
  (`SPC n r d t`, `SPC n r d d`; `dailies-directory`, `dailies-capture-templates`) make a daily the same way.
- **`brain-backlinks` (`SPC n r b`, `C-c n l`).** A window on the right with what `brain-node org-id:<id>` says
  of the note at point (the nearest heading at or above point with an `:ID:` in its property drawer, else the
  file's, or the `id:` of a Markdown file's front matter): its title, `* Backlinks (n)` with a line per `linked from` link, then a
  heading per other relation. It follows point into another note 200 ms after point rests. A note brain does
  not know, and a brain that does not answer, are said in that window and not signalled, or every cursor move
  through such a note would be an error.
- **Links (`openLink` in `src/org.ts`).** `brain:UUID` opens that node. `id:ID`: `org.ts` keeps id to file
  for the buffers and the local store. Where there is no edwind, a file there with the id is followed. Where
  the notes are edwind's, an id in one of edwind's buffers that is open is followed at once, and any other is
  asked of brain as `org-id:ID`, also when a file of the frame's own machine holds it (changed 2026-11-11):
  the desktop program attached to an edwind indexes its own files too, and one of them may be a copy of a
  note, or edwind's path of a note, which is no file there. Only when brain has no such note, or cannot be
  asked, is the file there followed, and the echo area says why. `roam:Title` and a bare `[[Title]]` are the
  note whose title or alias is that text, whatever the case, as brain has it: with no brain they find nothing.
- **A note whose file is gone** (added 2026-11-11). brain has a note until the projector has read that its
  file is gone. Opening one asked edwind for the file, which made it again as an empty buffer. Edwin now asks
  edwind first whether the file is there (`fs-stat`) and says that it is not, naming the note and the file.
- **Where there is no brain** (a plain browser, an edwind with no `readCredential`, offline) the three commands
  say so in a sentence and do nothing else; `id:` links to files the frame holds and the dailies work. The directories moved with the names: new notes go to the notes root where they went to `roam/`, and
  dailies to `daily/` where they went to `roam/daily/`, as the notes are laid out on disk; a file store from
  before keeps its old files where they are.
- **What went.** `org-roam-node-find`, `-insert` and `-random`, `org-roam-buffer-toggle`, the `org-roam-backlinks`
  primitive, `org-roam-mode`, the `org-roam-dailies-*` names, and the frame's index of nodes, titles and links;
  it keeps tags and ids, which tag completion and `id:` links need. `org-roam-directory` is
  `note-directory` and `org-roam-capture-templates` is `note-capture-templates`; an init file that names the
  old ones has to be changed.

Not in it: a Markdown `[[wiki link]]` still goes to `wiki-follow-function` (the page's opener), not to brain;
a random node; completing a link's title while typing it; and a record is read only (a task is changed from
the agenda, see "Tasks from brain"; a memory where it is made). A new note is in brain once the projector has sent its file, a
moment after the save, so it is not a candidate before that.

## Tasks from brain (done)

Asked 2026-11-10: the tasks are brain's, so that the phone, the agents and Edwin work on one list. Edwin's
agenda was built from the TODO headlines of Org files and its capture wrote new ones into them; both are gone,
and the agenda and a new task are brain's (`brain/docs/API.md` §5), through edwind. Emacs's names are not kept.

- **edwind asks for the frame (`server/brain.mts`).** Two commands read, with the read token
  (`brain.readCredential`): `brain-agenda {from, days?}` is brain's `GET /v1/agenda` (`from` a day, `days` 1 to
  366, 7 by default) and `brain-tasks {state?, q?, tag?, limit?, offset?}` its `GET /v1/tasks`. Two write, with
  a token of their own, `brain.taskCredential` (`services.edwind.brain.taskTokenFile`, the credential
  `brain-task-token`), which brain takes on its task routes only: `brain-task-add FIELDS` is `POST /v1/tasks`
  and `brain-task-set REF FIELDS` is `PATCH /v1/tasks/REF` (`REF` a node id or `task:N`). Only a task's fields
  are passed on (`title`, `body`, `state`, `priority`, `due`, `scheduled`, `recur`, `tags`,
  `waiting_on`, and on a change `add_tags`, `remove_tags` and `base_revision`); brain checks their values, and a task is not
  deleted through edwind. A write says
  `X-Brain-Session: edwind` and is sent once. With no task token the two say `brain-unavailable` in a sentence
  and send nothing. The log has `brain-read` or `brain-write` with the route's name, the status and the time,
  never a title, a query or a token.
- **Who can write.** Every process that can open edwind's socket can call these, as it can read every note
  file: with a task token it adds, changes and closes tasks as that token's actor, under the
  tags the token is cleared for. The token is not the projector's (edwind refuses that configuration) and no
  frame holds it.
- **`brain-agenda` (`SPC m a`, `src/brain.ts`)** asks for one key. `a` is the week: the 7 days from today
  (the frame's local day), a section `Overdue` when something is, a header for each day with what is due or
  scheduled on it (`Due:`, `Scheduled:`, and the time when the value has one), then `Next`, the next actions
  with no date. `t` is every open task, under `Next`, `To do`, `Waiting`, `Hold`, `Someday`, in brain's order
  inside each, asked for 200 at a time up to 2,000 (the first line says when more follow). The buffer is
  `*Agenda*` in `brain-agenda-mode`: read only, in Motion state, in a window of its own below, or in a window
  that is there (the popup it is asked for from, else another). `q` closes a window that was made for the
  agenda and gives any other back what it showed. A task's line has `task:N`, the label, the state,
  `[#P]`, the title on one line, `:tags:` when it has any, and in the list its dates; a task whose trust is not the
  owner's (an agent made it) says `by` and who, after the tags. It is a task like any other: edwind sets no
  trust. The faces come from what the line was built from, not from reading the text
  back, so a title cannot colour itself as something else.
- **Keys there**, each on the task at point: `RET` changes it in a buffer (below) and `o` opens its record,
  read only, with its links and who wrote it; `t` sets the state (then `t n w h s d c`);
  `x` is done; `s` schedules and `d` sets when it is due (the date reader of `org-schedule`: nothing typed is
  today, a typed time is kept; `C-u s` and `C-u d` clear the date, so `C-u` is the prefix argument in this
  buffer and not a scroll); `p` sets the priority (`a b c`, space for none); `e` edits the title; `:` changes its
  tags (it reads `Tags (+a -b): `: `+a` or `a` adds the tag `a`, `-b` removes `b`, and the echo area says the
  tags the task has then; brain refuses a tag that hides and that the token is not cleared for); `a` writes a new task (below); `r` and `g r` ask again; `q` leaves. Each has a command that takes
  the value as an argument (`brain-task-state`, `-done`, `-schedule`, `-due`, `-priority`, `-title`, `-tag`), and after it, optionally, the id of a task the agenda shows: a key that reads in the minibuffer
  names the task it was pressed on, so the change is made to that one wherever point is when the answer comes.
  For a date or a priority `#f` is none; a value that is neither that nor text is an error and nothing is
  sent.
- **A change is made against the revision the line shows** (`base_revision`): brain keeps what changed in the
  task since and writes only the field that was changed here; where both changed that field brain takes this
  one and the echo area says what it replaced (`clashes`). The view is then asked for again, with point on the
  same task in every window that shows it. What brain refuses is a user error in brain's words, and nothing
  changes. A repeating task that is done moves to its next date, as brain does it, and the echo area says so.
  When the change was made and the view could not be asked for again, the echo area says both, and the agenda
  takes no further change until `r` has asked again: its lines are of revisions brain has moved on from, and
  closing a repeating task from one would move it on a second time.
- **`brain-task-capture` (`SPC o`, `a` in the agenda)** writes a task in a buffer of its own (asked
  2026-11-16: the minibuffer took a title and nothing else). The buffer is `*Task*` in `markdown-mode`, in a
  window below, in Insert state on the title:

      ---
      title: 
      state: todo
      ---

  The front matter has a field a line, named as brain names them, and the text under it is the task's body.
  It starts with the two a task always has; `priority`, `scheduled`, `due` and `tags` have a line when they
  have a value, as an Org entry has a `SCHEDULED:` line when it is scheduled (asked 2026-11-16: the empty
  lines of fields that are not needed were in the way). A key that sets one writes its line, in the order
  above, and clearing one takes the line away.
  `tags` starts with those of `brain-task-tags`, when there are any, a string of tags with spaces between (`""` by default: no
  tags, a task every client of brain can read). A Visual selection is the body, and when the note at point has
  an Org id the body ends with `[[id:ORG-ID]]`: the id alone, since a tag may hide the note's title from those
  who can read the task. The minor mode `brain-capture-mode` is on there (`brain-capture-mode-map`, ahead of
  markdown-mode's keys): `C-c C-c` adds the task (`brain-capture-finalize`) and `C-c C-k` drops it
  (`brain-capture-kill`); either kills the buffer and puts the windows back as they were. `C-c C-t` sets the
  state, `C-c ,` the priority, `C-c C-s` and `C-c C-d` when it is scheduled and due, `C-c C-q` the tags, with
  the agenda's prompts, and each writes its line (`brain-capture-state`, `-priority`, `-schedule`, `-due`,
  `-tags`, which take the value as an argument; `#f` is no date or no priority, and its line goes).
- **What is typed there is read as the keys write it.** A state in any case, a priority `a` to `c`, tags with
  spaces or commas between or as a list (`[a, b]`), and a date as brain takes one (`2026-11-20`,
  `2026-11-20T17:00`) or as `org-read-date` reads one (`fri 17:00`, `+2d`), sent as the day it names. `recur`
  and `waiting_on` are taken when a line names them. A field left empty is not sent, so brain's default
  stands. Nothing is dropped without a word: a line that is no field of a task, a field twice, a value brain
  could not take (`Line 3: Later is not a state (…)`), no title, or no front matter is a user error, and so is
  what brain refuses, in brain's words; the buffer stays as it is. The echo area says `task:N added`, the
  task's tags and its dates, and an agenda that a window shows is asked for again. One task is written at a
  time: `SPC o` while one is goes back to its buffer. `C-u` is Evil's in this buffer, so a date is cleared by
  deleting or emptying its line.
- **`brain-task-edit` (`RET` in the agenda)** changes the task at point in the same buffer (asked 2026-11-16:
  a task's text could not be changed from Edwin at all). `*Task*` starts as the task is, in Normal state on
  the title: its title, its state and the other fields it has, a line each, and
  its text below, from the row the agenda shows (brain sends a task's whole text with it). The keys and the
  reading of what is typed are those above. `C-c C-c` sends what differs from what the buffer started with
  and nothing else, against the revision the agenda showed (`base_revision`), so what changed in the task
  meanwhile is kept, and what this change replaced is said, as for the agenda's keys. A field whose line is emptied or deleted is
  cleared, and so is the text; a task keeps a title and a state (`No title`, `No state`). Tags go as those
  added and those removed, so a tag the task was given meanwhile stays. Nothing changed asks brain nothing
  (`task:N: nothing changed`), and `C-c C-k` leaves the task as it was. It is the one buffer: `RET` or `SPC o`
  while a task is written or changed goes back to it. An agenda that does not show the last change opens no
  task until `r` has asked again.
- **`brain-task-add TITLE [BODY]`** adds a task in one call, for Scheme, with the tags of `brain-task-tags`;
  as a command it reads `Task: ` in the minibuffer and takes the body from the selection and the note at
  point, as it did on `SPC o` before the buffer.
- **The agenda follows brain** (added 2026-11-11). A task changed anywhere (the CLI, a phone, an agent,
  another frame) is in an agenda that a window shows, without `r`. The frame calls `brain-tasks-follow ON`
  with true while `*Agenda*` is in a window and with false when it no longer is (looked at after each
  command), and again on every new connection. edwind follows brain's feed of changes for the clients that
  asked (`TaskFeed`, `server/brain.mts`), with the read token: one follower for all of them, started by the
  first and ended when the last one stops or disconnects, which drops the request brain holds. It takes its
  place with `GET /v1/changes?after=now` and then asks `after=CURSOR&kind=task&limit=200&wait=50`, a request
  brain answers when a task changed or after 50 s; edwind gives it 65 s. Requests start at least 1 s apart.
  When brain does not answer, the wait doubles from 1 s to 60 s; the cursor is kept through an outage or a
  5xx, so what changed meanwhile is in the first answer after it, and a refusal or an answer that is not
  brain's makes edwind take a new place. A watcher is sent `{t: 'tasks'}` when the answer has a change, and
  once after every outage: that a task changed, with no id, title or body, and not what brain said of it. The
  log has `brain-read` with `changes`, the status and the time; a failure is logged once until brain answers
  again. The command's value is whether edwind has its place in the feed; with no read token it is
  `brain-unavailable` and nothing is followed. The frame asks edwind to follow before it asks for the agenda,
  so no change falls between the two. On `tasks` it asks for the agenda again once 300 ms have passed without
  another, as `r` does: point stays on its task in every window, and the selected window and the minibuffer are
  not touched. An answer to an earlier question than the one the buffer shows is dropped. When the agenda
  cannot be asked for, the view is left as it is, the echo area says so once, and the agenda takes no change
  until it has been asked for again (by `r`, or by the next change). A change made here comes back through
  the feed too, so the agenda is asked for a second time after it. A frame that is not attached, and one whose
  edwind has no read token, follow nothing: `r` asks again.
- **What went.** The agenda built from files (`org-agenda`, `org-agenda-list`, `org-todo-list`, the
  `org-agenda-*` commands and `org-agenda-mode`, `org-agenda-files`, `org-agenda-start-on-weekday`,
  `org-deadline-warning-days`, `org-super-agenda-groups`), capture into files (`org-capture`,
  `org-capture-finalize`, `org-capture-kill`, `org-capture-templates`, `org-capture-after-finalize-hook`,
  `org-directory`), and what the frame's index kept for them: the headlines of every file with their TODO
  states and dates. The index keeps ids and tags. A headline's TODO keyword, `SCHEDULED:` and `DEADLINE:` are
  still edited in a file (`org-todo`, `org-schedule`, `org-deadline`); they are text there, not tasks.

Not in it: an agenda in no window does not follow brain: it is as brain was when it was last shown or asked
for. No task under a tag the task token is not cleared for.
Editing a task's body, repeat or `waiting_on`, deleting one, and showing closed tasks. A write
is not retried and carries no `client_id`, so a task added while the answer was lost may be added twice by
adding it again.

## Dired: directories as buffers (done)

Asked 2026-11-10: Emacs's dired, so directories and paths are navigated in Edwin as in Emacs, with the file
operations.

- **edwind lists and changes directories (`server/fs.mts`).** Five server commands, each taking one object:
  `fs-list {dir}` (entries with kind, size, mtime, mode and a link's target; at most 10,000), `fs-stat {path}`
  (the entry, and for a file the canonical id a frame opens it under), `fs-delete {path, recursive}`,
  `fs-copy {src, dst}` and `fs-mkdir {path}`. Renaming stays `rename-file`. They answer to the path authority
  (`server/paths.mts`): nothing in or on the refusal list is listed or touched, a change must lie inside the
  writable paths, edwind's own directories and anything that holds them are never an operand, and a link is
  removed or copied as a link, never its target. Delete is permanent; copy and rename never overwrite.
- **`src/dired.ts`** draws a listing (mode, size, date, name; directories first, dot files shown) in a read-only
  `dired-mode` buffer named after the directory, one per directory. Motion-state keys: `RET`
  open or enter, `-` up, `g r` refresh, `q` quit, `m` `u` `U` `t` marks, `d` then `x` flag and delete, `D`
  delete, `R` rename or move, `C` copy, `+` new directory, `Y` copy the path. `SPC f d` and `C-x d` ask for a
  directory, `dired-jump` (`C-x C-j`) lists the current buffer's with point on its file. A file needs one `y`
  to delete, a directory with contents a typed `yes`.
- **`find-file` reads a path.** `SPC f f` starts from the current buffer's directory and completes that
  directory's contents; `TAB` walks into the highlighted name, `//` and `/~` restart the path as in Emacs.
  A directory opens as a listing. The minibuffer gained `boundary` (`EdMiniOpts`): where the completed field of
  the input starts, here after the last `/`. Recent files stay on `SPC f r`.
- **The desktop program lists its own directories.** `host.files.tree` (`EdHostTree`) is the second backend:
  four natives (`lstat`, `rename`, `copyTree`, `removeDir`; `mkdirs` takes a mode) under a local `DiredFs` in
  `src/dired.ts` that keeps the same rules (a copy makes every name new, a rename looks first, a link stays a
  link). It has no refusal list: these are the user's files, as in Emacs. A renamed file's buffer follows it and
  keeps its line ends. Attached to edwind, the notes directory and what is under it are edwind's
  (`hooks.servedPath`, `native/js/main.ts`) and every other directory is the program's own; a rename or copy
  stays within the backend of the listing it starts from, so it does not cross to a remote edwind's machine.
  A local `find-file` still answers its buffer at once: only a directory is intercepted.
- **Not in this step:** wdired, chmod, compression, shell commands, previews, a trash, a rename across file
  systems (the system's error is shown), and `edwin DIR` on the command line.

Suites: `test/fs.test.mts`, `test/dired.test.mts`, `test/dired-local.test.mts` (check `edit-dired`), and two
terminal tests in `native/tests/terminal.rs`.

## pi agents: Edwin's AI on pi (done)

Asked 2026-11-09: pi in place of gptel, using an existing agent framework instead of Edwin's own. The model layer's
wire formats became pi-ai's (README, deviations); on top of it `server/agent.mts` runs a pi-agent-core `Agent` per
session, and `scm/pi.scm` makes any markdown note a chat with it.

- **One Scheme thread per run.** pi-agent-core runs its loop on promises, outside the Scheme threads. Each run gets a
  background thread attributed to the agent `pi:<session>` that drains the run's queue in order: text deltas, tool
  starts and ends, tool calls (the Scheme procedure runs on that thread, its result goes back to the agent) and
  confirmations. So the agent's edits, in the chat and in any buffer a tool changes, are one writer's, and every frame
  sees them stream.
- **Model calls** take a slot of the gate, run under the deadline through `fetchFor`, and log one usage line with
  caller `pi` (`Models.agentStream`).
- **Confirmation** (R12.10–R12.12, which the server lacked) is in the note, not the minibuffer: a background thread
  has no call to ask through. The question is written at the end of the chat; C-c RET allows, C-c C-k denies; a no
  becomes the tool's result ("The user declined this tool call.") and the model goes on.
- **Steering** goes through `pi-steer` (a prompt), since C-c RET while a tool waits is the yes.
- **Sessions** are the agent's messages in `stateDir/pi/NAME.json`, written after each run (tmp + rename, 0600); the
  session of a note is found again by name after a restart. `pi-model` keeps the messages and changes backend and
  tier; pi-ai turns Messages API tool blocks into chat-completions tool messages.
- **Tools from init.scm** are kept by `define-pi-tool` until the agent module is installed, then defined after the
  built-in ones, so a tool of the same name replaces a built-in.

Not done: a pi tool to open a note that no buffer shows yet (the agent greps, then reads open buffers), images in
chats, compaction of long sessions (pi-agent-core's transformContext is the hook), and the frame-side `src/ai.ts`
backends, which a later step makes a client of edwind.

## Hypernotes H1: source blocks in notes (done)

Step H1 of `docs/HYPERNOTES.md`: one block engine in edwind for Org and markdown notes (R10.8 widened to
markdown). `server/babel.mts` reads and writes block text; `scm/babel.scm` is the engine, loaded in every runtime
(markdown.scm requires it) so frames know its commands run in edwind. Suite: `test/babel.test.mts` (flake check
`edit-babel`), plus a frame case in `frame.test.mts` and the frame-less case in `markdown.test.mts`.

| Key (markdown-mode, org-mode) | Command | Does |
|---|---|---|
| `C-c C-c` (Org: through `org-ctrl-c-ctrl-c`), `C-c C-v e` | `babel-execute-src-block` | run the block at point (its lines, its `#+name:` line or its result) and store the result |
| `C-c C-v b` | `babel-execute-buffer` | run every block in order from fresh note environments; stop at the first failure |
| `C-c C-v t` | `babel-tangle` | write `tangle=` blocks to their files, relative to the note |
| `C-c C-v k`, `C-c C-v r` | `babel-remove-result`, `babel-reset-environment` | drop the result at point; empty the note's environment |

- **Syntax.** Markdown: ```` ```lang {#id k=v flag} ```` (backticks or tildes; `{.lang #id}` also names the
  language), results ```` ```result {of=id} ```` (`error` marks a failure); a result without `of=` belongs to the
  block right above it. Org: `#+name:`, `#+header:`, `#+begin_src lang :k v`, `#+RESULTS: id` followed by `:`
  lines, a `#+begin_…` block (`#+begin_error` for a failure) or a table; `#+PROPERTY: header-args[:lang]` sets
  defaults, `:session` is `env`. Both read `in=a,x=b` / `:var x=b`, `results=value|output|silent` (Org `table`
  too), `env=`, `noweb`, `noweb-ref`, `tangle`, `eval=no`, `dir`. A markdown front matter `env:` names the
  note's environment.
- **Values.** A value result is the value as `write` prints it, so it reads back exactly; a list of lists is an
  Org table. `in=` gives a block a data fence's value (json as `jsonToScheme` makes it: objects as alists with
  symbol keys, arrays as lists, null as `#f`; csv and tsv as rows with numbers converted; sexp as its datum), a
  named Org table's rows, another block's stored result (never a rerun: "run it first"), or a literal (`n=3`,
  `s="x"`). An unspecified value removes the stale result; `silent` writes nothing.
- **Note environments (the R4.15 amendment).** A scheme block's forms run with `eval` in its note environment,
  a child of the global one, named by `env=`/`:session`, else the note's file. They are not top-level forms of a
  call, so they never enter the image log or reach frames, and their definitions never reach the global
  environment. An environment lasts until edwind restarts; `babel-execute-buffer` forgets the note's
  environments first. The block runs with the note as its current buffer, as Org babel runs Emacs Lisp: Edwin's
  `newline` inserts there, `display` goes to the result.
- **Running.** Commands are server commands; a frame's `call-interactively` now sends any server command to
  edwind (R4.27; the fast path for simple specs used to call it locally). Before the code runs, the command
  passes a blocking point (`thread-yield`), so a long block does not hold the note (R4.41); a marker and the id
  find the block again to store the result. A condition (or a raised object) becomes a failed result with its
  report; quit and the frame deadline are not results. `sh`, `bash`, `zsh` blocks run through `call-process`
  in a hub PTY (R4.44) in the note's directory (`dir=` relative to it), with `in=` bindings as shell
  variables; a non-zero status is a failed result ending in `[exit N]`. `babel-define-executor` adds languages
  (the slot H1k's kernels would use).
- **Tangle** writes through the shared buffer of each file (`%babel-write-file`): the text is replaced as one
  batch and saved, so the authority's write rules apply and open frames see the new text; `tangle=yes` names the
  file after the note (`.scm`, `.sh`, …). Noweb `<<name>>` repeats the reference's line prefix and joins every
  block whose id or `noweb-ref` is `name`; a cycle or a missing name is an error.
- **Agents** run notes with `wb eval '(babel-run "notes/x.md")'` (or `(babel-run FILE ID)` for one block);
  results land in the note as C-c C-c leaves them, and autosave writes the file.
- **Not in H1:** stale marks (a `src` hash), rich results and the display layer (H1d), kernels for other
  languages (H1k), `define-handler` and cards that call the image (H2).

## Step DT4: Edwin from the flake (done)

The flake builds Edwin on its own, as Emacs ships `emacs`, `emacs --daemon` and `emacsclient`:

| Output | What |
|---|---|
| `packages.edwin` (`nix run .#edwin -- FILE`) | `bin/edwin` (terminal, `-g` window), `bin/edwinclient`, `bin/edwin-daemon`, `bin/edwind` (`nix/edwin.nix`) |
| `packages.edwind` (`nix run .#edwind -- --config F`) | edwind alone (`nix/edwind.nix`); the workbench package links it for `services.workbench.edit` |
| `nixosModules.edwin` | `programs.edwin.enable`, `.daemon.enable` (edwind as a systemd user service), `.daemon.notesDir`, `.defaultEditor` |

- **The daemon.** `edwin --daemon` starts the user's edwind in the background (`--fg-daemon` in the foreground,
  which the user service runs) on `$XDG_RUNTIME_DIR/edwin/edit.sock`. Its config is `EDWIND_CONFIG` when set,
  else one written at each start: notes in `EDWIN_NOTES_DIR` (`~/notes`), state in `~/.local/state/edwin/edwind`,
  the user's Scheme in `~/.config/edwin`, the log (background start) in `~/.local/state/edwin/edwind.log`.
- **The client.** `edwinclient` and `edwinclient -c` attach to the edwind `--socket` or `--remote` names, else
  the first that answers on `$EDWIN_SOCKET` or `$XDG_RUNTIME_DIR/edwin/edit.sock` (until 2026-10-19 also
  Workbench's `/run/workbench-edit/edit.sock`), so notes are shared between frames and with the browser. Files
  outside the notes directory stay the program's own (DT1). Until 2026-11-13 there was no separate client: every
  `edwin` attached by itself, and `--standalone` kept one apart ("edwin and edwinclient", above).
- **The build.** The prebuilt V8 (`librusty_v8` 130.0.1) is a fixed-output fetch handed to the `v8` crate as
  `RUSTY_V8_ARCHIVE`, so the build runs offline. The window's libraries (libxkbcommon, Wayland, Vulkan, libGL, X11)
  are added to the binary's RPATH, as winit and wgpu open them at run time. The check phase runs the
  pseudo-terminal suite; the window's tests skip in the sandbox (no display). The flake check `edwin-module`
  evaluates a system with `programs.edwin` (the user unit, `EDITOR`); it does not boot one.
- **The window from Nix** needs the system's GPU drivers where wgpu looks for them: `hardware.graphics.enable` on
  NixOS (`/run/opengl-driver`); elsewhere, Nix's Mesa through `VK_ICD_FILENAMES` or nixGL.

## Step DT2: `edwin --gui`, a window (done)

`edwin -g FILE` (or `--gui`) opens Edwin in a window of its own on the Linux desktop. It is the same program, the
same core and the same model frame as `edwin -nw`; only the backend differs. The terminal stays the default, so
`$EDITOR=edwin` in a terminal is unchanged; `EDITOR="edwin -g"` gives a window that blocks until it closes, as
`gvim -f` does. Without a display, or without the system libraries the window needs, `edwin -g` says why and runs
in the terminal; with no terminal either it exits with status 1.

- **The window.** Rust opens it (winit 0.30, X11 and Wayland) before V8 starts. Each redisplay `native/js/gui.ts`
  hands the model (DT0's format) to Rust as JSON; `src/gui/` draws it with wgpu (Vulkan, else GL) as one instanced
  pass of rectangles and glyphs from an atlas, the glyphs shaped and rasterized by cosmic-text. Text sits on the
  model's cell grid: the cell is the font's advance wide and 1.5 times its size high (the page's line height,
  `EDWIN_LINE_HEIGHT`). The font is `EDWIN_FONT` ("Iosevka 12", "Iosevka" or "12"), else the first of JetBrains Mono
  (the page's), its Nerd Font build, DejaVu Sans Mono and Liberation Mono, at 10.5 points; characters the font lacks
  fall back to the system's fonts (CJK, emoji in colour). `--geometry=COLSxROWS` sets the first size (100x36).
- **Events.** Keys arrive as the page's keydown does (key, code, modifiers) and are named by the core's own
  `Ed.keyName`, so a key means in the window what it means on the page. An input method's preedit is drawn at the
  cursor and its commit inserted as typed text. Mouse, wheel, focus and resize are `Ed.display.input` events, as in
  the terminal. Kills and yanks go to the system clipboard; `C-S-v` pastes from it. The close button runs
  `save-buffers-kill-terminal` (it asks about changed files); a file dropped on the window is visited. The title is
  the buffer's name; the bell asks for attention when the window is not focused; `C-z` iconifies.
- **One loop.** The window's events, edwind's socket and signals share one thread: winit's loop is pumped with the
  next timer as its timeout, and a helper thread wakes it when a descriptor becomes readable.

The parity checklist against the browser frame (DT2's gate), each item with how it was checked:

| Browser frame | Window | Checked by |
|---|---|---|
| Faces: fg, bg, bold, italic, underline, strike, box | yes | `a_model_draws_its_faces_text_and_cursor` (offscreen render of a model dumped from the core) |
| Wide characters, combining marks, emoji | yes | `wide_characters_and_combining_marks_take_their_cells`; screenshot |
| Splits, dividers, a modeline per window, active and inactive | yes | the dumped model (a vertical split); screenshot of `C-x 2` |
| Minibuffer, echo area, multi-line prompts | yes | screenshot of the close button's save prompt |
| Vertico (`M-x`), Corfu (completion at point) | yes | screenshots |
| Cursor per Evil state (box, bar, hbar, half); hollow when unfocused and in other windows | yes | offscreen render (bar); screenshots |
| Region and Visual selection | yes | screenshot of a mouse drag |
| Presence cursors with the writer's name (edwind) | yes | `another_writer_is_a_bar_and_a_name_tag` |
| Keys named as on the page, `C-`, `M-`, Shift | yes | `native.test.mts` (gui.ts); `keys_and_clicks_edit_and_wq_leaves_zero` (xdotool on Xvfb) |
| Mouse: click, drag, wheel | yes | the same test (click); by hand (drag, wheel) |
| Clipboard both ways | yes | by hand, with xclip |
| Resize; HiDPI | yes | by hand (`xdotool windowsize`; `WINIT_X11_SCALE_FACTOR=2`) |
| Leaving: `:wq`, `:q!`, the close button asks about changes | yes | `keys_and_clicks_edit_and_wq_leaves_zero`, `the_close_button_asks_about_changes` |
| Input methods | drawn and inserted | not checked against a real input method (none in the test machine) |
| Wayland | built | only X11 was run (Xvfb) |

The latency budget, fixed for DT2: from a key's arrival in the window to the frame's present, on a 200x50 window of
source text, **p50 at most 10 ms and p99 at most 25 ms** on Mesa's software renderer (lavapipe), the slowest GPU
the window will meet. `cargo test --release -- --ignored latency` measures it (`EDWIN_GUI_LATENCY_LOG=FILE` logs
each key in microseconds). Measured on 2026-10-17 (121 keys: moving, typing, `C-d`): p50 8.3 ms, p99 17.4 ms. Of
one key: the command, redisplay and the model as JSON 2 to 4 ms; parsing 0.1 ms; building the scene 1 to 2 ms; the
software renderer's present 3 to 4 ms (a hardware GPU removes most of that). The compositor's frame comes after.

Build and test: `cargo build --release` builds the window in (the `gui` feature; `--no-default-features` builds the
terminal program alone). It needs, at run time, libxkbcommon, and on X11 libX11, libX11-xcb and libxkbcommon-x11
(winit loads them; `edwin -g` checks for them first), a Vulkan or GL driver, and fontconfig's fonts. `cargo test
--release` runs the window's tests on their own Xvfb when `Xvfb` and `xdotool` are installed, and skips them
otherwise. The binary is 48.6 MB (37.6 without the window). The window opens in about 100 ms on the software
renderer before the snapshot restores, so the first frame is drawn at about 146 ms (40 ms in a terminal).

Not in DT2: ligatures (each cell is shaped alone, as the grid needs), proportional fonts, the pulse animation,
images, a menubar, smooth scrolling, opening the window while the snapshot restores, and Nix packaging (DT4, above).

## Step DT1: `edwin` in a terminal (done)

`edwin [-nw] [-R] [+LINE] [FILE]...` is Edwin as a terminal program, meant to stand
in for Vim or Neovim, `$EDITOR` included. `native` is a Rust crate (its own Cargo workspace, so V8 stays out
of the Workbench crates and their Nix build) that embeds V8 (the `v8` crate, 130.0.1, prebuilt) and carries every
source it runs: the unchanged core in `src/`, the shipped Scheme in `scm/`, and `native/js/`. Rust is only the
floor: files, `/dev/tty` in raw mode, signals through a self-pipe, edwind's socket and one `poll(2)` loop. Edwin is
a model frame (DT0) drawn by `native/js/term.ts`.

Build and run (the prebuilt V8 is downloaded by the `v8` crate's build script, or named by `RUSTY_V8_ARCHIVE`; `nix build .#edwin` does it all, see DT4):

    cd native && cargo build --release && ./target/release/edwin FILE
    cargo test --release        # the pseudo-terminal suite (the edwind case needs node)

- **Vim's contract.** `:q` on the last window ends the program, refusing with E37 or E162 while a file has unsaved
  changes; `:q!`, `ZQ` and `:qa!` drop them. `:wq`, `:x`, `ZZ`, `:wqa` save first. `:cq` exits with status 1 (or
  its argument) and saves nothing, so `git commit` aborts. `C-x C-c` asks about each changed file (y, n, !, q),
  then confirms leaving with changes. In a split, `:q` closes the window, as before. The program blocks until it
  ends, so `git`, `sudoedit` and anything else that runs `$EDITOR` work. `+LINE` starts on a line (`+` alone: the
  last); `-` edits standard input (`git diff | edwin -`), the terminal being `/dev/tty`. Files the editor is handed by git (`COMMIT_EDITMSG`, `git-rebase-todo`...) start at the top
  (`save-place-ignore-files-regexp`).
- **Files are the disk's.** The host has a file system (`host.files`): the core's `Store` reads and writes paths,
  relative to the directory `edwin` started in, `~` expanded. A buffer's file is the absolute path; it is shown and
  completed by its label (relative under the working directory, `~/...` under home). Saves are atomic (a temporary
  file beside it, the old mode, fsync, rename), except a symlink, a file with other hard links, or one in a
  directory we cannot create files in, which are written in place. CRLF line ends and a byte order mark are kept.
  A saved file ends in a newline (`require-final-newline`, which the program sets and `init.scm` may unset). A file
  that is not UTF-8 is refused. recentf, savehist, save-place and prescient are one JSON file in
  `~/.local/state/edwin/`; the user's Scheme is `~/.config/edwin/init.scm` and `~/.config/edwin/lisp/`.
- **The terminal.** The alternate screen, no autowrap, synchronized output, rows redrawn only when they changed.
  Truecolor when `COLORTERM` or `TERM` says so, else the nearest of the 256 colours, else of the 16
  (`EDWIN_COLOR=truecolor|256|16` overrides). The cursor is the terminal's own, its shape per Evil state (DECSCUSR:
  block, bar, underline) and its colour by OSC 12. The theme follows the background colour the terminal reports
  (OSC 11), else `COLORFGBG`, else dark (`EDWIN_THEME=dark|light` overrides); `EDWIN_DEFAULT_COLORS=1` draws the
  default face in the terminal's own colours. Kills and yanks go to the system clipboard by OSC 52, which reaches it
  over SSH too (`EDWIN_OSC52=0` stops it). Mouse (SGR 1006): a click sets point and selects a window, a drag marks
  a region, the wheel scrolls three lines. Bracketed paste arrives as one insertion; focus events change the cursor.
  The kitty keyboard protocol's first level is asked for, so ESC, `C-i` and `M-` keys are unambiguous where the
  terminal has it; elsewhere a lone ESC waits 25 ms for the rest of a sequence (`EDWIN_ESC_MS`).
- **Signals.** `C-z` suspends in Vim's states (Normal, Motion, Visual, Insert) and `C-x C-z` in every state; `fg`
  resumes and redraws. A resize redraws. On `SIGHUP` (the SSH connection dropped) or `SIGTERM`, changed files are
  copied into `~/.local/state/edwin/rescue/` before the program exits.
- **Startup.** `build.rs` runs `native/js/boot.ts` (the host, the core, `Ed.boot` with the shipped Scheme, the
  terminal key settings) in a V8 snapshot creator and the binary carries the heap; a start restores it and runs
  `main.ts` for the process (arguments, terminal, directories, storage, then the user's `init.scm`). First draw of a
  200×50 terminal: 155 ms without the snapshot (75 compiling the core, 77 evaluating the Scheme), 40 ms with it
  (`EDWIN_TRACE=1` logs the steps, `EDWIN_NO_SNAPSHOT=1` starts cold). The binary is 37.6 MB: V8, the 5.2 MB
  snapshot and ICU's data (for `\p{...}` in regular expressions).
- **edwind.** A frame attached to an edwind (`edwinclient` since 2026-11-13; until then any `edwin` that found one
  answering) boots served (`Ed.bootServed`), so its image, commands and user init are edwind's. Notes under
  edwind's notes directory are opened through edwind, shared with the browser's frames; every other file stays the
  program's own, so a commit message never needs edwind's write permission. Quitting waits (up to 5 s) until edwind has acknowledged every
  edit. An attached start is cold (the snapshot holds a standalone boot).

Core changes for DT1: `host.files` behind `Store` (and shipped config never read from the working directory);
`kill-emacs`, `suspend-frame`, `can-kill-emacs?`, `display-graphic-p`, `modified-file-buffers` and a JS
`save-buffers-kill-terminal` (the page's still say how to leave); `Ed.display.input(f, ev)`, the input half of the
display seam (keys, paste, focus, mouse, resize in cell terms, as the page's frame wiring does it); `Ed.boot({
deferUserInit})` with `Ed.loadUserInit()` and `hooks.beforeUserInit`; `Ed.reloadPersistent()` (stack.ts's tables,
read again once the program's storage is open); `require-final-newline`; and in `evil.scm` `:cq`, `:wqa`/`:xa`
saving before they quit, and `:q`/`:qa` ending the program where the host can.

Not in DT1: worker threads (jobs run on the main thread, as on a page without workers), the AI commands (no
`fetch` in the program yet), editing files that are not UTF-8, Vim's swap files, the
GUI (DT2), and Nix packaging of the binary (DT4: the prebuilt V8 must come from a fixed-output fetch).

## Step DT0: the display seam (done)

DT0 is the first step of desktop Edwin (the doc "Edwin on the Linux desktop", decided 2026-10-16: build through the
GUI, DT0 then DT1 `edwin -nw` then DT2). A Rust shell will embed V8, run these same files and draw a terminal or a
native window. For that the core must be able to draw a frame that is not a page. DT0 adds that and changes nothing
on the page.

- **Model frames.** `Ed.makeFrame(null, {backend, buffer, kind, theme})` makes a frame with no root element. The
  backend has `size()` → `{cols, rows}`, `draw(model)` and optionally `bell()`. Each redisplay `src/display.ts`
  lays the frame out on that cell grid and calls `draw` with plain data (rows of styled segments, a face table, the
  cursor and its shape, the window rectangles; the header of `display.ts` has the format). `Ed.display.posAt(f, x, y)`
  maps a cell back to a buffer position, the modeline or the echo area, for mouse input. `Ed.display.setTheme` and
  `Ed.display.redraw` are for the backend's theme and size changes.
- **Styled runs.** `renderBuffer(b, {runs: true, html: false})` gives each line its text and its spans as data
  (`{s, e, cls}`, plus the cursor, avy labels, fold ellipsis and end-of-line region). The html of the page is byte
  for byte what it was (a golden corpus of 54 renders was compared before and after, and the suite checks runs against html).
- **Shared logic.** The page and the model now share `windowState`, `scrollStart`, `modelineFields`, `miniView`
  and `echoView` in `editor-core.ts`, so scrolling, the modeline, the minibuffer and the echo area cannot drift
  apart. `evil-ex.ts` gives the which-key bindings as data (`prefixItems`) besides the html, and `stack.ts` says
  when they wait (`prefixWait`).
- **Faces as data.** `FACES` maps every class the renderer, Org and markdown-mode emit, and the modeline and echo
  parts, to a spec in palette tokens with the page's fallback chains. `PALETTE` holds `index.html`'s light and dark
  values. A token set with `set-face-color!` wins, as on the page. `display.test.mts` parses `index.html`, the
  markdown-mode and the Org stylesheets and fails when a face and its rule disagree, or when a class has no face.

Choices made in DT0:

- The cursor is not painted into the cells. The model reports it with its shape (box, bar, hbar, half, hollow) and
  the Evil state's colour, so a terminal can use its own cursor.
- Lines wrap as the page wraps them (after the last space that fits, else anywhere), tabs stop every 8 columns,
  control characters show as `^X`, and East Asian wide characters and emoji take two cells. Truncated lines scroll
  the whole window sideways, as the page's view does.
- Windows share the room equally, as the page's flex layout does. Side-by-side windows get a one-cell divider. The
  echo area takes at most half the rows. The line-number gutter is the widest number plus one cell.
- The completion popup has a border on the page; in cells it has the menu background instead.
- Fixed on the page too: with two or more terms in the minibuffer, only the last term was marked in the candidates
  and the label was escaped twice. Every term is marked now.

Not in DT0 (each is a later step or a known gap): the menubar of a console frame, the pulse animation, markdown block
references drawn as their resolved text (a DOM pass in `markdown.ts`), screen-line motion (`gj`/`gk` in
visual-line-mode falls back to buffer lines in a model frame), and per-character pixel metrics for proportional
fonts (DT2 decides).

## Step AS1: agent sessions in Edwin (done)

Issue #7: Edwin is the complete text interface to the hub's agents and to the sessions harnesses report.
Workbench keeps no second transcript or composer. The HTTP API of Workbench DESIGN §3.8 is the authority;
Edwin never starts or speaks ACP to an agent itself.

**State of the work.** All four original stages, the phone addition and review hardening (AS1.15–20)
are complete. All twelve findings have fixes and regression coverage: incarnation-bound actions/drafts;
bounded incremental replay; serialized/coalesced publication; GET retry/reset/pending reconciliation;
and view/stream teardown. Acknowledged prompt destinations never return to this daemon's retry set.
Feature gate at `73cef87`: agent 67/67, all three TypeScript projects, native 31 passed with one existing ignored test.
A standalone served frame exercised folds, an external prompt, global permission, off-tail/undo preservation,
cross-publication token redaction and replacement rejection. Measurements and API limitations are below.
No real credential, external network or existing service was used. Earlier baseline records remain;
this review does not claim another full Node run or physical native GUI exercise.
`tools/agent-live.mts` now provides standalone GET-only live-hub inspection, checked against the stub;
it is statically typechecked but never run by a suite.
The owner’s real-hub inspection opened 28,683 events in 493 ms and exposed presentation defects.
The AS1.21–25 rendering follow-up is complete: messages stay open, bookkeeping lives in control state,
current plans/tools keep their visible start order, and the list is bounded/aligned with an exited toggle.
AS-C19/C20 fixtures and a served-frame/CLI smoke cover the real shapes; the directed list suite passes
24/24 and all three TypeScript projects pass. Evidence and API limitations are recorded below.

### Requirements

| Requirement | Contract |
|---|---|
| AS1.1 | edwind owns the HTTP connection and all shared session text. `agentHub: {url, tokenFile}` in edit.json configures it. Require HTTPS except on loopback, or when the operator explicitly sets `allowCleartext: true` **only for an encrypted private network**. Never follow redirects. Reject URL credentials, invalid session IDs, non-integer/unsafe/negative cursors and any destination outside the configured origin and `/v1/` prefix before sending credentials. |
| AS1.2 | Read the bearer token only from its configured file, protect that file through the path authority, and never expose it in buffers, diagnostics, errors, logs or argv. Redact remote responses as well as transport errors. Mutations are not retried: a lost reply may already have acted. |
| AS1.3 | `*Agent Sessions*` lists hub and observed sessions, including state, harness, model, host, project/directory, activity and waiting status. Waiting rows sort first. SSE snapshots replace stale registries; reconnect takes a fresh snapshot, and an outage is visible. Open, start (agent/host/directory), cancel and remove are commands. Only explicit start or revive may run anything. |
| AS1.4 | `*Agent: SID*` is a read-only Markdown-style transcript, shared as `name:*Agent: SID*`. Observed-only records use `*Agent Observed: ID*` and explicitly cannot be steered. All record fields and available tail are inspectable. Closing a frame/buffer never cancels or removes a session. |
| AS1.5 | Journal replay uses epoch plus seq, skips duplicates, handles reset and pinned pending requests, and follows changed headSeq through `events?since=N`. Structure is editor metadata, not Markdown parsing. Prompts and user/assistant messages start open regardless of length; thoughts, tools, their output and diffs start folded to one line. Only current plans are presented, open. Prompt navigation is unaffected by headings or fences inside a prompt. |
| AS1.6 | Streaming uses sequenced edits without undo groups; point and window positions away from the changed end stay put. Every available event is retained, not summarized or dropped; oversized input/rendering follows the explicit AS1.16 limits. Reopening reconstructs from the hub journal. Measure a long replay and record event count, bytes, open time and folded visible lines. |
| AS1.7 | Transcript commands unfold, visit a tool's file and line, show its diffs, recall an immutable earlier prompt into a new draft, prompt quickly, cancel, revive, set mode and set a config option (`POST /config {id,value}`). Report 404/405/501 from config as unsupported by this hub. |
| AS1.8 | Pending permissions and elicitations are announced to frames and reachable globally, not just at point. The picker, authoritative detail request and answer retain the same sid/createdAt/req. Permission details show session, incarnation, request, tool and input before offered outcomes. Form elicitation supports string, number, boolean and string-array values; URLs are shown in full and never auto-opened. Stale/replaced/resolved replies fail, not retarget. |
| AS1.9 | Compose in an ordinary shared Markdown buffer with a prompt minor mode: `C-c C-c` sends, `C-c C-k` abandons the view, retaining the draft. Drafts survive buffer kills and daemon restart; their destinations persist as `{sid,epoch:createdAt}`. Persist a new draft's editor-journal index before exposing it, so acknowledged edits remain discoverable after a crash even if its Markdown write fails. Earlier prompts stay read-only. Keep failed/ambiguous destinations, never an acknowledged one, in a multi-send retry set. |
| AS1.10 | Attach files as ACP resource links or embedded resources; attach regions and buffers as embedded resources, not pasted text. Preview is the exact JSON blocks and destinations that send uses. Persist attachments with the draft; named prompts can be saved, listed and reused, and one draft can target several sessions. |
| AS1.11 | Any attached terminal/browser/card may open `name:*Agent: SID*` after `agent-session-open SID`; that command returns its canonical buffer id. Browser `Ed.sync.open(id)` and `Ed.setWindowBuffer(buffer)` show it; terminal `edwinclient -e '(agent-session-open "SID")'` materialises it and a frame visits its returned name (or runs `M-x agent-session-open`). No second page-side API token. |
| AS1.12 | A host page needs no Ctrl/Meta keys or Edwin minibuffer. Every transcript presentation action and every session mutation is a named command with explicit buffer/session arguments, through `Ed.agentSessions.rpc`. Presentation stays local; journal reads and mutations stay daemon-owned. Host text-field prompts use the direct text endpoint without creating a draft buffer. |
| AS1.13 | A host can read a session buffer's pending requests, offered outcomes/forms/URLs, incarnation, state, mode and config options, and subscribe to changes. Reply with the req and epoch actually shown, never a newly fetched replacement. A stale incarnation or no-longer-pending request fails; a page must refresh its controls rather than silently answering a different question. |
| AS1.14 | Browser taps use the existing frame input route: a tap places point, tapping the rendered fold marker or double-tapping a foldable transcript line toggles its structural fold. Touch scrolling never places/clamps point or becomes a tap, and retains tail-follow eligibility. No agent-only gesture listeners or second renderer. |
| AS1.15 | Every action based on displayed hub-session data carries sid and the shown `createdAt` (called `epoch` on Edwin's wire). Detail/answer, tool location/seq, recall, quick text, mode/config/cancel/remove/revive and durable targets reject a mismatch with “session was replaced”. A legacy SID-only draft is unbound and requires explicit retargeting; it never silently binds after restart. |
| AS1.16 | A response body is at most **32 MiB** and an SSE event, including an unfinished line, at most **1 MiB**, counted as UTF-8 bytes. Abort and visibly report overflow. One rendered journal event contributes at most **1,048,576 UTF-16 code units**, shared by heading, summary, text, JSON and diff; clipping is visibly marked and an incomplete diff is not offered as complete. Preserve surrogate pairs and every ordinary event. No disk-backed history store. At most four journal GETs run concurrently across list facts and transcripts. |
| AS1.17 | Redact assembled text before offsets are materialized, preserving UTF-16 length. Cache immutable event/block presentation; active message updates publish only the new suffix (plus any changed redaction overlap), not their growing old body. Per-buffer text-plus-metadata publications are serialized and list redraws coalesce. |
| AS1.18 | Once a prompt POST is positively acknowledged, remove that `{sid,epoch}` from this draft's in-memory destinations before receipt persistence. A write failure explicitly reports acknowledgement and forbids offering that destination for retry for this daemon's lifetime, including explicit retarget attempts. No automatic mutation retry or reconciliation protocol. |
| AS1.19 | Retain a failed open transcript's desired journal head and retry GETs at 250 ms exponential backoff, capped at 5 s. A head decrease also reconciles journal and model facts. Only a same-incarnation, same-head authoritative pending snapshot can retire a request missing a resolution: show “no longer pending; resolution unavailable”, with no invented outcome or actionable stale request. A late matching summary must reconcile too. |
| AS1.20 | Killing a list/transcript/reported buffer disables view-specific following, releases its replay/presentation state and prevents in-flight publications from recreating it. A view generation invalidates queued work; departed-session facts and announcement identities are pruned. Closing a view never steers its agent. Destroy rejected SSE responses/requests immediately; track and destroy every stream attempt at shutdown. |
| AS1.21 | Bookkeeping is state, not conversation: initialization/session, usage, session-info, mode/config and available-command updates produce no transcript block. Latest main-session usage/session info are exposed beside mode/config through the buffer and host state. Invisible bookkeeping does not split matching message chunks. A turn ends with one quiet line naming its stop reason; turn errors name their code and message. Unknown event/update kinds get one folded line naming the kind, with their JSON inside. |
| AS1.22 | Generated headings are human Markdown: tool title first, a short status marker and optional location, no journal sequence numbers. Sequence/request/tool identities remain structural metadata. A tool update whose start was not replayed uses its kind or “tool” and says its start was not replayed, never its opaque call ID as a title. |
| AS1.23 | Tool commands occupy their own fenced line with output below; distinct tool content blocks cannot join a command to its output. Current tool status and all supplied outputs/diffs remain inspectable. Tools keep their original start position across updates; the current plan occupies its latest update’s position, not a superseded plan’s position. |
| AS1.24 | A hub-truncated replay starts with one plain line saying earlier history is unavailable from the hub and that the transcript starts at event N. Detailed gap/from/head data stays in metadata. No backward-pagination workaround is invented. |
| AS1.25 | The sessions list collapses whitespace to one line per cell, caps long cells with an ellipsis, and pads each column to its widest capped value/header. Empty WAIT/model cells retain their columns; absent or literal `unknown` models are blank. Waiting sessions sort first, then other live sessions, then exited sessions; show five exited sessions before a named, keyboard/host-callable expansion toggle. Full identities and values remain metadata, and non-session lines cannot target a session action. |

### Data flow and buffer model

`edit.json / init.scm -> edwind agent client -> authenticated HTTP /v1`.
`/stream -> one current registry -> coalesced shared sessions list`; a changed headSeq (up or down),
incarnation or pending identity schedules a single-flight journal read for that open transcript.
Failed GET catch-up remains dirty and retries; mutations never do. Reconnection replaces registry snapshots
and catches up open transcripts. The stream contains summaries, not journal events.
`journal -> typed event fold -> text + spans -> sequencer -> edit.sock -> every frame`.

The hub's journal remains the only session record. Derived transcripts are special buffers, not files and
not another authoritative journal. Spans carry seq, kind, start/end, fold bounds, tool identity, locations,
diff ranges and prompt identities; frames receive the structure beside the text with its buffer version.
Original prompt blocks stay in the daemon's replay object and recall fetches them by seq, avoiding unbounded
metadata copies. Fold choices are buffer-local within each frame runtime, as Edwin's existing folding is;
separate attached clients choose independently. Markdown is fontification only, never the
source of command targets. An event containing fences or headings cannot manufacture a prompt/tool span.
Whole transcript buffers are read-only, so partial read-only spans are unnecessary. Existing sequenced edits,
markers, metadata, folds and Markdown fontification are reused; missing seams are added, not a second renderer.
Every supplied event remains in the in-memory journal. The text is its human presentation, not a JSON
dump: bookkeeping is projected into controls; superseded plans remain journal events but do not render.
Tool/message/request spans carry their identities even though headings omit sequence numbers.
The current plan is anchored at its latest update, while a tool keeps its original start across updates.
List metadata maps explicit physical line numbers to full session identities rather than parsing padded
or clipped text; its exited-session group line is not an actionable session.
Column caps in frame cells are SESSION 18, WAIT 4, STATE 10, HARNESS 12, MODEL 20,
HOST 16, PROJECT 24 and ACTIVITY 48. Truncation and padding reuse Edwin's display character widths,
including wide/combining Unicode; display clipping never changes the full structural identity.
History-only reconnects now include current structural metadata. Large live changes publish bounded
sequenced chunks, yielding between them rather than overflowing a frame's outbound queue. A pre-kill
buffer hook can veto teardown when draft persistence fails, preserving the acknowledged journal.
The client bounds ingress before concatenating/parsing a complete body or SSE event (AS1.16).
Per-event text is capped visibly during rendering, not silently omitted; the hub journal remains untouched.
Immutable rendered blocks/fragments are reused. Growing assistant/thought/user messages render only new
fragments and recheck at most token-length-minus-one old characters for cross-chunk redaction, before
computing the suffix patch. Whole-buffer publication is serialized, including explicit list opens; at most
one superseding list redraw waits behind an active redraw. View generations reject post-kill work.

Measured before this rendering follow-up (with the old long-message folding policy), in the final full run:
8,192 events / 25,141,248 content bytes replayed and
rendered in 18.36 ms in the pure journal fold (5 visible folded lines). A real daemon + frame opened
1,201 events with 1,200 tool folds in 165.3 ms; after live updates including 3 MiB of raw tool output it held
1,205 events / 9,998,712 rendered bytes without reconnect. Off-tail point stayed put and no undo group
was added. These are observed runs, not latency guarantees.

Drafts are ordinary editable daemon buffers backed by private state files, with an adjacent durable record of
`{sid,epoch}` destinations and content blocks. Preview shows those exact pairs. Sending flushes pending
edits, takes the preview snapshot and checks each incarnation again immediately before its POST.
Named prompts are private state records, not edits to old journal events. Resource paths pass the existing file
authority; a remote-host file is not silently read from edwind's host. Resource links identify the agent-side
file; embedding reads an explicitly chosen Edwin-side file/buffer/region.

### Commands and keys

`M-x agent-sessions`, `agent-session-open`, `agent-session-start`, `agent-session-cancel`,
`agent-session-remove`, `agent-session-revive`, `agent-session-mode`, `agent-session-config`,
`agent-session-prompt`, `agent-session-quick-prompt`, `agent-session-answer` (global),
`agent-prompt-preview`, `agent-prompt-send`, `agent-prompt-abandon`, `agent-prompt-targets`,
`agent-prompt-attach-file`, `agent-prompt-attach-buffer`, `agent-prompt-attach-region`,
`agent-prompt-save`, `agent-prompt-load`, `agent-session-recall`.

Sessions list, Motion state: `RET` open, `g r`/`r` refresh, `a` start, `c` cancel, `D` remove (confirm),
`p` compose, `!` answer pending, `e` toggle extra exited sessions (`TAB` on its group line), `q` quit.
Host pages call `await Ed.agentSessions.rpc('agent-sessions-toggle-exited')` and receive the canonical
list buffer id; this changes presentation only, never a hub session. Transcript, Motion state: `TAB` fold, `] ]`/`[ [` next/previous
prompt, `RET` visit tool location, `d` diff, `p` compose, `P` quick prompt, `R` recall, `c` cancel,
`!` answer, `m` mode, `o` config option, `v` revive, `g r` refresh, `q` quit. Prompt minor mode takes
precedence over Markdown: `C-c C-c` send, `C-c C-k` abandon, `C-c C-p` preview. Other prompt-engineering
commands are available through M-x, with ordinary editing and completion throughout.
Global `C-c a !` answers pending work and `C-c a p` composes from any buffer (with session completion).

For an already attached page/card, materialise via the shared command, then address a particular frame:

```js
const id = await Ed.agentSessions.rpc('agent-session-open', ['SID']);
const buffer = await Ed.sync.open(id); // name:*Agent: SID*
frame.showBuffer(buffer);             // existing card/frame
// Or create a new browser frame:
const newFrame = Ed.makeFrame(rootElement, { buffer });
```

`Ed.agentSessions.open('SID')` is the selected-frame shortcut. In a terminal, start an ordinary
`edwinclient -t --socket /path/to/edit.sock` frame and run `M-x agent-session-open RET SID RET`.
`edwinclient --socket /path/to/edit.sock -e '(agent-session-open "SID")'` materialises and prints the
canonical name without creating a frame; it does not pretend to be a file argument.

### Host-page commands and touch

Use `await Ed.agentSessions.rpc(command, args)`. Open the canonical transcript as above first for
presentation commands. `id` is `buffer.id`; `sid` is the hub session id; **`epoch` is the session
`createdAt` actually shown**, not a fresh lookup after a choice. Positions are zero-based UTF-16 buffer
offsets. Explicit-buffer presentation commands do not select another frame/window or change an unrelated point.
For a particular unselected card, pass `frame.point()` as the position and apply the returned point with
`frame.setPoint(result.point)`; these existing frame methods do not take keyboard focus.

| Command | Arguments | Result |
|---|---|---|
| `agent-session-toggle-fold` | `[id, position]` | `{bufferId, point, folds:[{s,e}]}` after toggling the containing structural block. |
| `agent-session-open-folds` / `agent-session-close-folds` | `[id]` | The same presentation result after opening/closing every current structural fold. Closing a fold containing point puts point on its summary, not in hidden text. |
| `agent-session-previous-prompt` / `agent-session-next-prompt` | `[id, position]` (position defaults to that buffer's point) | The same result with point at the previous/next structural prompt. No such prompt is a rejected `user-error`. |
| `agent-session-recall` | `[sid, promptSeq, epoch]` | Canonical id of a new durable prompt draft. Get seq and epoch from the displayed `buffer.meta.locals.agentSession`; no Markdown parsing. |
| `agent-session-state` | `[sid]` | The state snapshot described below, refreshed from the daemon/hub. |
| `agent-session-request` | `[sid, req, epoch]` | Authoritative pending request details, including tool/input or elicitation form/URL and offered choices. Reject a replaced incarnation before fetching/using another request. |
| `agent-session-location` | `[{sid, epoch, seq, location}]` | Canonical file buffer id after validating the structural tool event/location and local host; rejects replacement before filesystem access. |
| `agent-session-permission` | `[sid, {req, epoch, outcome}]` | Hub JSON acknowledgement. `outcome` is `{outcome:'selected', optionId}` from the shown options, or `{outcome:'cancelled'}`. |
| `agent-session-elicitation` | `[sid, {req, epoch, response}]` | Hub JSON acknowledgement. `response` is `{action:'accept', content:{...}}`, `{action:'decline'}` or `{action:'cancel'}`; use the shown form schema. URL requests remain explicit and are never automatically opened. |
| `agent-session-cancel` / `agent-session-remove` / `agent-session-revive` | `[sid, {epoch}]` | Hub JSON acknowledgement (remove ends the session; cancel only cancels its turn). |
| `agent-session-mode` | `[sid, {epoch, modeId}]` | Hub JSON acknowledgement; choose from the shown `modes.availableModes`. |
| `agent-session-config` | `[sid, {epoch, id:optionId, value}]` | Hub JSON acknowledgement; choose from the shown `configOptions`. An old hub's 404/405/501 rejects with an explicit unsupported-config explanation. |
| `agent-session-prompt` | `[sid, {epoch, text}]` | Hub JSON acknowledgement; direct text without a draft. The host retains its text until success and must not automatically retry an ambiguous/lost reply. |

RPC failure rejects with Edwin's `user-error` condition and its redacted report. Permission/elicitation
answers require the exact shown req, kind and epoch; an already resolved/replaced request or stale
incarnation is an error, never success or retargeting. The hub still arbitrates an answer racing another
client after Edwin's check. Observed records cannot be steered. Mutation acknowledgements are the hub's
JSON, `{}` in the stub; they do not fabricate a new local mode/state before the journal/summary confirms it.
The local replacement report is `Agent session was replaced (stale incarnation); refresh and explicitly select it again`;
resolved requests report `Request is already resolved or no longer pending; refresh the session`.
Other hub refusals retain their HTTP status/code in the redacted report.

`Ed.agentSessions.state(buffer)` synchronously reads the latest daemon metadata snapshot:
`{sid, bufferId, epoch, state, steerable, connection, modeId, modes, configOptions, usage, sessionInfo, pending}`.
`usage` and `sessionInfo` are the latest main-session update payloads without `sessionUpdate`,
or `null` when unavailable; they are also under `buffer.meta.locals.agentSession`.
`pending` contains full permission options or elicitation request/schema/URL plus `req`, `kind` and
`epoch`, not just the registry's short title. Treat snapshots as read-only. Incarnation changes clear
obsolete choices; disconnected/removed/observed sessions are not steerable. `connection` is the daemon's
hub status string, not an invented agent state. A page can additionally listen to `Ed.sync.on('state', ...)`
for its own connection to edwind.

```js
const dispose = Ed.agentSessions.onChange(buffer, snapshot => {
  drawSessionButtons(snapshot); // called once immediately, then when state metadata changes
});
// A permission button retains the request it was drawn for:
const shown = Ed.agentSessions.state(buffer).pending.find(p => p.kind === 'permission');
await Ed.agentSessions.rpc('agent-session-permission', [
  shown.sid, { req: shown.req, epoch: shown.epoch,
    outcome: { outcome: 'selected', optionId: shown.options[0].optionId } }
]);
dispose(); // when the card is unmounted
```

Notifications use the existing versioned buffer-metadata path, including state-only SSE changes with no
text edit. Repeated equivalent metadata is not a change; unsubscribe stops callbacks. Fold choices stay
local to the existing frame runtime. Browser gestures extend the existing generic frame input wiring,
not these agent modules: a movement/cancel/multi-touch is not a tap, and touch scroll keeps point while
the next journal append resumes tail following if point was at the tail.

### Checks

| Check | Observable result |
|---|---|
| AS-C1 | Loopback fake API exercises info, hub and observed snapshots, fragmented SSE, duplicate summaries, removals, disconnect/reconnect, unconfigured/refused commands, remote start and all mutation routes. |
| AS-C2 | Two edit clients/served frames see the same daemon-owned list and transcript; explicit open never spawns; a tool update changes its current state and fold metadata. |
| AS-C3 | Long replay retains supplied ordinary events/content, opens with bounded visible rows, reports measured replay time, and labels hub-truncated history and oversized rendered events explicitly. |
| AS-C4 | Events arriving while point/window start are elsewhere do not steal point; tail point follows; stream edits add no undo group. A prompt containing headings and fences does not change structural navigation or command targets. |
| AS-C5 | A permission announced while another buffer is current can be answered there; req/epoch and offered outcome reach the stub. Elicitation values, cancellation, stale and already-resolved replies remain distinguishable. |
| AS-C6 | C-c C-c sends exactly previewed blocks; C-c C-k and killing/reopening/restarting retain text/resources. Named reuse, recalled prompts and multiple destinations preserve the immutable journal and avoid resending successful destinations after a partial failure. |
| AS-C7 | Config route works on a supporting stub and says unsupported on an older hub. Read-only observed records reject steering. File/line and diff actions use structural data. |
| AS-C8 | A distinctive stub token, including one echoed maliciously in an error/record, appears in no buffer, wire result or daemon log; opening its file (including a symlink) is refused. |
| AS-C9 | Run affected Node suites/type checks at stage boundaries; exercise an actual model frame's displayed folded surface and keys. At the end run the repository's full available suite once and quote its final lines. No external network or real credentials. |
| AS-C10 | A host RPC targets an explicit transcript while another buffer is current: toggle/open/close folds, navigate structural prompts despite injected headings/fences, recall exact immutable blocks, send text without a draft, cancel and set mode/config. Invalid offsets and prompt boundaries fail plainly. |
| AS-C11 | Read/subscription exposes complete offered permission/elicitation and mode/config data; state-only summaries notify without text edits. Replies use the captured req/epoch, stale/resolved/replaced requests fail, incarnation reset clears choices, and unsubscribe stops notifications. |
| AS-C12 | Browser-frame tests dispatch actual DOM touch events for tap point, marker/double-tap folds, scroll without point movement (then live tail append), cancelled/multi-touch gestures, and listener teardown. Ordinary buffers use the same input route. |
| AS-C13 | Reuse the same SID/req under a new createdAt while frame pickers are open and across a retained-draft restart. Details, answers, quick sends, mode/config, recall, file jumps and draft sends reject replacement before action. Permission UI shows authoritative tool/input. Explicit retarget alone binds a new incarnation. |
| AS-C14 | Both Content-Length and chunked responses exceed 32 MiB; an unfinished SSE event exceeds 1 MiB: connections close, refusal is visible and edwind remains usable. Render huge prompts/outputs/plans/diffs/Unicode with the shared per-event budget; incomplete diffs are not complete views. Saturated list facts and transcript opens never exceed four journal GETs. |
| AS-C15 | Split a token across message chunks and recalled prompt text blocks: no buffer/log contains it, and later prompt, fold, location and diff offsets still target displayed text. Growing messages emit suffix-only patches. |
| AS-C16 | Force receipt persistence to fail after an acknowledged early multi-send destination. It is reported as sent, removed immediately in memory and never reposted or offered by explicit retarget during this daemon's lifetime. Other destinations remain available. |
| AS-C17 | Concurrent attached-list replacements keep displayed rows identical to structural command targets. Fail the final journal GET once without another summary: automatic GET retry catches up. A same-incarnation lower head resets transcript/facts. Truncated/later pending snapshots mark lost resolutions unavailable rather than actionable. |
| AS-C18 | Kill list, observed and transcript views during in-flight reads: later completions/summaries do not recreate them, and reopening explicitly works. Repeated 503 SSE responses with ongoing bytes close immediately; shutdown closes all outstanding attempts. |
| AS-C19 | A truncated real-shaped fixture begins mid-tool, includes bookkeeping between messages, interleaves tool/plan updates and ends with a long assistant answer. Assert open prompts/messages/current plans; folded thoughts/tools/unknown JSON; no superseded plan/bookkeeping/sequence headings; safe orphan title; separated command/output; start ordering; quiet end/reasons and one-line truncation. Verify usage/session-info controls and structural offsets/patches. |
| AS-C20 | A real-shaped list fixture has a multi-paragraph activity, unknown/missing models, waiting/live/exited sessions and more than five exited rows. Assert whitespace/ellipsis/column boundaries/empty WAIT, wide/combining Unicode alignment, sort order, default collapse and named/key expansion, and row actions using the correct full identity after redraws. A finished turn, including a reported `done` record without an end marker, is not an exited session. |

### Read-only live-hub inspection

From the checkout, with Node 24 and the checkout's normal dependencies:

```sh
node tools/agent-live.mts URL TOKEN_FILE
node tools/agent-live.mts URL TOKEN_FILE SID
```

The same HTTPS rule applies to this tool. For HTTP across an encrypted private network only, pass
`--allow-cleartext` before the URL. Plain HTTP loopback stubs need no override.

This is a manual tool, not a suite. It constructs `AgentSessions` and real daemon buffers in-process,
under a private temporary state directory removed on success or failure. No user init/image, listening
socket, agent RPC installer or prompt store is loaded. The core modules registering agent start/send/
answer/cancel/remove/mode/config/revive commands are omitted too; a GET-only override additionally
refuses every write before HTTP. Only the feature's token reader opens the credential file.

With no SID, print the live list buffer after model-fact reads/publication finish. With SID, wait for
the initial stream snapshot and replay to the latest announced epoch/head, freeze that snapshot,
then print open milliseconds (excluding boot/connection), retained journal event count, spans and
default folds. Print first/last 60 **logical display lines**, without viewport wrapping, cursor or faces,
through the actual frame fold/line/glyph code. Repeat with every fold open, cutting each line to 200
Unicode characters. Short excerpts intentionally overlap. Print the host-page pending/control snapshot,
authoritative replay truncation/from/gaps, and displayed per-event bound-marker occurrences (literal
agent quotations can contain that marker too). Reported/PTY records say journal event count is unavailable.

HTTP/auth failures, including background fact/journal reads or a refused stream, exit nonzero without
partial normal output or dumped headers/response bodies. Hub I/O has a 120-second deadline. Normal
inspection performs only GETs; pending permissions and elicitations are printed, never answered.

### Verification record

**Real-shaped rendering follow-up (AS-C19/C20):** the directed list suite
(`node --test --test-concurrency=1 test/agent-sessions.test.mts`) passes 24/24.
`tsc -p .`, `tsc -p src` and `tsc -p native/js` each exit 0.
A disposable driver opened the shared fixtures through a real daemon and served model frame,
captured the first 40 default-folded transcript lines and the aligned/default-collapsed list,
expanded exited rows through the host RPC and opened the correct hidden row with RET.
Both actual `tools/agent-live.mts` paths succeeded against the stub without changes to the tool.
The driver and its private state were removed. Final output:

```text
render smoke: 40 default transcript lines; exited toggle + RET opened finished-8; 38 HTTP requests, all GET; both live CLI paths succeeded; no token in output/logs
```

**Read-only live tool (manual stub check):** `tsc -p .` exits 0, including `tools/*.mts`.
A disposable driver ran the actual CLI against `test/fake-agent-hub.mts`, outside the suite runner:
list/model/observed records; replay advancing during its first read; exactly 60 first/last frame lines;
all-open Unicode clipping/control glyphs; pending permission/elicitation and mode/config state;
hub/render truncation; reported-only records; 401, 503, partial-list/journal 502, stream refusal and missing SID.
The transcript retained 148 events / 147 spans / 144 default folds, opening in 31.82 ms in this run.
The driver and its private credential/state directory were removed afterward. Final output:

```text
agent-live stub smoke: 9 checks passed; 25 HTTP calls, all GET; token/header output absent
```

**Reviewer-hardening gate (after the last runtime/test edit):**

- All twelve static claims held. Eight directed regressions (findings 4, 5 and 7–12) were also run
  against the unchanged pre-review `0cff9a6` tree: all eight failed. The attached-list race produced
  `the text at 180225 is not the one the op deletes`. The final gate below passes those checks.
- Node v24.21.0, Nix-store dependencies, no external network:
  `NO_COLOR=1 NODE_PATH=tools/node_modules node --test --test-reporter=spec --test-concurrency=1 --test-timeout=30000 test/agent*.test.mts`.
  Final lines, verbatim:

  ```text
  ℹ tests 67
  ℹ suites 0
  ℹ pass 67
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 37032.907439
  ```

- `tsc -p .`, `tsc -p src`, `tsc -p native/js`: all exit 0 without diagnostics after the last
  runtime/test edit.
- `cargo test --offline --locked --jobs 1 -- --test-threads=1`: 31 passed across three suites,
  one existing ignored test. Private CARGO_HOME/target, exact Cargo.lock vendor catalogue and local
  V8 archive/ICU from the Nix store; shell utilities on PATH. Initial environment attempts exposed
  missing utilities and a read-only copied ICU file, corrected only in the private build environment.
  The final suite's last lines, verbatim:

  ```text
  test wq_saves_and_exits_zero ... ok
  test zz_and_c_x_c_c_save_then_leave ... ok

  test result: ok. 24 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 29.33s
  ```

- Latest long replay: **8,192 events / 25,141,248 content bytes / 49.24 ms / 5 folded visible lines**.
  A real daemon and served frame opened **1,201 events in 189.1 ms**; its final **1,205 events /
  4,755,515 rendered bytes / 1,200 folds** included a visibly bounded 3 MiB live event without reconnect.
  These shared-machine measurements are observations, not latency guarantees.
- A disposable standalone program ran an actual edwind, loopback stub, served model frame and host RPCs
  outside the test runner. It displayed tool folds, answered the shown permission while another buffer
  was current, sent an external-field prompt, streamed off-point with no undo, split a token across
  separate publications, and rejected a retained action after replacement. Output, verbatim:

  ```text
  Agent review live smoke: {"openMs":13.7,"surfaceDraws":11,"folds":6,"pointPreserved":true,"undoGroups":0,"stateNotifications":2,"pending":0,"tokenAbsent":true,"replacementRejected":true}
  ```

- That live scenario exposed a zero-width redaction overlap caused by using a method's arity instead
  of the validated 64-character token width; a separate-publication regression now covers it.
  The affected agent gate also exposed the deferred editor-index window on new durable drafts:
  creation now writes the existing index synchronously before edits can be acknowledged.
  No browser-touch implementation changed in this review; its earlier DOM/Chromium record remains below.

**Original four-stage feature gate (before the phone addition):**

- Node v24.21.0; all three `tsc -p` projects (`.`, `src`, `native/js`) passed without diagnostics.
- `NODE_PATH=tools/node_modules node --test --test-concurrency=2 test/*.test.mts` ran all 36 files with
  default OT_RUNS=10000 and CRASH_ROUNDS=1000. Final lines:

  ```text
  ℹ tests 460
  ℹ suites 1
  ℹ pass 458
  ℹ fail 2
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 1128004.130386
  ```

  The failures are `debug.test.mts` R4.50/R4.48: `server/debug.mts:343` requires `/edwin/` in a captured
  absolute source path, but this worktree is `/home/yanni/proj/edwin-wt/agent-sessions`.
  `nix/checks.nix:30` documents its check tree's required `edwin` name. Copying the same sources and running
  only `node --test test/debug.test.mts` in `/tmp/edwin-agent-gate.*/edwin` gave 7 passed, 0 failed.
  No debugger code/test was changed. An earlier full-run attempt was cancelled before completion when
  the console/native embedding omissions were found; the numbers above are the completed run after fixes.
- Offline `cargo test --offline --locked --jobs 1 -- --test-threads=1` on the same sources in a private
  `/tmp` tree used the exact Cargo.lock vendor catalogue and V8 archive already in the Nix store.
  Results: 4 unit + 3 GUI-harness + 24 terminal tests passed; the existing GUI latency test is ignored.
  The GUI harness retains its prerequisite-dependent early returns; no physical native GUI window was
  exercised. A separate actual `edwinclient -t` smoke displayed/unfolded a journal and edited, previewed
  and sent a draft into a new immutable prompt heading.
- `node --stack-size=6900 test/scheme-bench.mts`: shadow overhead 6.3% (limit 10%),
  generator/direct 1.19x (limit 3x), `ok`.
- Real Chromium loaded the shipped console scripts, displayed the list and folded transcript, and used
  RET, TAB, typing, C-c C-p and C-c C-c. The new heading appeared after the send. Model-frame checks also
  cover file/line, diffs, recall, off-point/tail streaming, reconnect metadata and bounded live publication.
- All HTTP traffic was loopback stubs; no real credentials or external network. Throwaway scripts and
  private build/fixture directories were removed. Nix system/module evaluation and deployment were not run.

**Phone addition (AS-C10–12):**

- Final pre-commit daemon/prompt gate: `node --test --test-concurrency=2 test/agent-sessions.test.mts test/agent-prompts.test.mts`,
  25 passed, 0 failed, duration_ms 8499.879536.
- `node --test --test-concurrency=2 test/frame.test.mts test/display.test.mts test/console.test.mts`:
  48 passed, 0 failed, duration_ms 4749.63043. The initial combined run exposed a new test's reliance on
  the renderer's incidental fold-line-count cache; the corrected assertion checks the visible folded body
  instead. The browser smoke also caught marker taps not placing point; both point and fold now use the
  common input path, and the regression checks the summary's point placement.
- Actual Chromium, 390×844 with touch enabled, loaded the shipped console runtime against a private
  edwind/fake hub. Trusted touch marker tap opened retained output; double tap closed it. A trusted swipe
  changed viewport start 2802 → 2721 while point stayed 3389 (tail); the next append moved point to 3439
  (new tail) and made it visible. External text-field typing and Send/Allow buttons used no Ctrl/Meta
  events. The captured req/epoch reached the stub unchanged; repeating it rejected with the documented
  no-longer-pending report. Chromium reported no page runtime errors. No physical phone was exercised.
- Throwaway browser fixture, daemon state, Chromium profile and listeners were removed/stopped.
- After implementation commit `c3dacb0`, all three TypeScript projects (`tsc -p .`, `tsc -p src`,
  `tsc -p native/js`) passed without diagnostics.
- The first post-commit all-agent run at concurrency 2 finished 40/41: the unchanged legacy
  `test/agent.test.mts:164` image-agent case hit a 10-second protocol timeout. That case passed in the
  pre-commit combined run, then the unchanged legacy suite passed 3/3 in isolation (duration_ms
  1063.37864). The timeout's cause is unproven; no unrelated code or timeout threshold was changed.
- Final post-commit command: `node --test --test-concurrency=1 test/agent*.test.mts` (all five suites,
  including the legacy pi agent). Final lines:

  ```text
  ℹ tests 41
  ℹ suites 0
  ℹ pass 41
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 16701.429738
  ```

  This run also opened the 1,201-event daemon transcript in 152.2 ms and delivered its 3 MiB live output
  without reconnect; the 8,192-event / 25,141,248-byte pure replay took 17.91 ms with 5 visible folded lines.

### Open decisions and API constraints

- **Connection:** HTTP in edwind, not `server/hub.mts`. The socket protocol is host-local and deliberately
  process-only; the mesh API provides remote-host reach, observed records and the shared journal authority.
- **Replay ceiling (DESIGN §3.4.4):** `/events` replays at most 4 MiB and has no backward cursor or
  before/limit parameter. Edwin retains supplied events in memory and labels `truncated/from`; a first
  open cannot recover withheld bytes. [Workbench #55](https://github.com/yathxyz/workbench/issues/55)
  tracks backward paging. When the hub supports it, the plain history-unavailable line is the place to
  load earlier history; no loader is built before that API exists. Edwin’s 32 MiB HTTP ceiling can also
  refuse an oversized response; per-event rendered clipping is visible. No disk-backed store is added.
  Reported sessions expose only their bounded tail, not transcriptPath contents over this API.
  No filesystem or direct-agent workaround invents a second record.
  These are per-unit bounds, not a total-memory cap: retained history for an open journal still grows
  in memory. Killing its daemon buffer releases that replay/presentation state.
- **Incarnation precondition:** every mutation of an existing session carries the selected `createdAt`
  as `epoch` in its JSON body, including draft prompt POSTs and DELETE. Edwin rechecks the session
  before sending. The hub enforces epoch for permission/elicitation answers; other routes may ignore it.
  On those routes a replacement between the check and the write can still act on the wrong incarnation.
  Only an atomic check at the hub can close that window.
- **Receipt durability:** after a positive acknowledgement, this daemon never offers the same draft target
  for retry even if receipt persistence fails, and tells the user so. If the daemon then crashes before a
  receipt becomes durable, restart may recover the older target record. No crash reconciliation/idempotency
  protocol is invented; a lost network reply is likewise ambiguous, not an automatic retry.
- **Config in flight:** the supplied `sessions.rs` has no config route. Send the specified new endpoint and
  explain unsupported responses; never pretend that changing a local model label steered the agent.
- **Transport:** explicit HTTP URL means the operator chose the private encrypted mesh the API specifies;
  unlike brain's localhost-only API this cannot be restricted to local addresses. Redirects are refused so
  a token cannot move to another origin. No automatic authentication/terminal attach beyond the named API.
- **Configuration authority:** `agent-hub-configure` runs only during trusted init. An attached Scheme client
  must not rebind an existing credential file to an arbitrary HTTP origin. Changing configuration thereafter
  requires the owner's normal daemon restart; the client never restarts it.
- **Model availability:** summaries do not contain the model. A lightweight journal facts cursor follows
  advertised model config options for list rows; observed model data wins when supplied. An absent or
  literal `unknown` model renders as an empty cell, not a guessed agent default.
- **Folds:** existing buffer-local folds are reused, including sharing between cards/windows inside one
  runtime. Separate terminal/browser runtimes have independent choices. No second daemon transcript.

- **Tool file authority:** file/line jumps work when the agent's host is this edwind host and its path
  passes Edwin's read authority. The supplied HTTP API has no remote-file endpoint; a remote-host
  location says to open it on that host rather than treating the same path on this machine as its file.
  No implicit SSH connection, mount, credential or host-name mapping is invented.
