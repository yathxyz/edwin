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
  `edwin-daemon` beside the program (DT4), which since 2026-11-15 returns once `$XDG_RUNTIME_DIR/edwin/edit.sock`
  answers ("edwin --daemon waits", below; edwinclient still allows 10 s after it), and attaches.
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

## `+LINE:COL` on the command line (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package cli-line-col): `edwin +L:C FILE` and `edwinclient +L:C FILE`
start with point on line L, column C, as `emacs +L:C` and `emacsclient +L:C` do; until then `+3:5` was a file name.

- **What it reads.** `+LINE:COL` beside `+LINE` and `+`, in `native/js/main.ts`'s parseArgs, for edwin and
  edwinclient alike (both start through it), in the terminal and the window. As before, the position applies to
  the first file. Any other argument starting with `+` (`+3:`, `+:5`, `+x`) is a file name, as Emacs takes it;
  `./+3:5` or `-- +3:5` names a file that looks like one.
- **COL is characters, from 1.** The point moves COL-1 characters (code points, so a character outside the BMP is
  one) from the start of the line, never past its end: a COL past the end stops there, and in Evil's normal state
  the cursor then sits on the line's last character, as Vim puts it. COL 0 is column 1, as LINE 0 is line 1, and a
  LINE past the last line is the last. Choice: characters, the plan's default. The alternative is display columns
  (a tab to the next multiple of 8, a wide character two cells), what Emacs's `move-to-column` does; changing it is
  the one loop in main.ts's start().
- **main.rs needed no change.** It acts on the command line before V8 only for the window, the edwind and usage
  errors, and an argument that does not start with `-` never sets any of them; so `+3:5` and a malformed `+...`
  are both left to main.ts, which takes the malformed one as a file name and refuses neither. The two readers
  agree without a second parser (062d316's rule: a line main.ts refuses must not attach or start a daemon first).
- **Not in it:** a position per file (`emacs +3 a +5 b`); `+LINE:COL` applies to the first file, as `+LINE` did.
  No new file, so no README layout row; and no check in nix/checks.nix: the tests are the pseudo-terminal suite's,
  which `nix build .#edwin` runs (the package's cargo test).
- **Checked by** the pseudo-terminal suite: `plus_line_col_puts_the_cursor_on_that_cell` (the cell the cursor is
  drawn on for `+3:5` is four right of the one for `+3`, and `x` deletes that character),
  `plus_line_col_counts_characters_and_stops_at_the_line_end` (a character of two UTF-16 units, a column past the
  end, column 0, a line past the last, and `+3:` as a file name) and `edwinclient_plus_line_col_places_the_cursor`
  (attached to a throwaway edwind). `nix build .#edwin` runs them; `edwin-typecheck` checks main.ts.

## edwin --daemon waits, and two starts give one edwind (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `cli-daemon-start`): `edwin --daemon` returned about 350 ms
before its edwind listened, so `edwin --daemon && edwinclient …` could find no edwind; and two starts at once
could both pass the check and both run edwind, the later one taking the socket from the earlier (edwind unlinks a
socket it finds and binds its own) while both use one state directory.

- **A start returns once the socket answers.** `edwin --daemon` (edwin-daemon in the background) starts edwind and
  then waits until something accepts on its socket, up to 30 s. When edwind dies first (or is slower than that) it
  says so with the log's path and exits with status 1. With `EDWIND_CONFIG` the socket is the one edwind reads
  from that config (edwind's own `loadConfig`, so the default and `~` are edwind's).
- **`edwin-daemon --wait`** starts nothing: it returns with status 0 once the user's socket (or `EDWIND_CONFIG`'s)
  accepts, and with status 1 after 30 s. It is for a caller that needs the socket, such as a service's
  `ExecStartPost` (`cli-unit-readiness`).
- **The lock.** Without `EDWIND_CONFIG` a start takes `~/.local/state/edwin/edwind.lock` (`$XDG_STATE_HOME`) with
  flock before its check and keeps it until the edwind it started answers, so a start never sees "nothing answers"
  while another start's edwind is coming up. edwind never gets the descriptor (`9>&-` on both launches): an edwind
  that crashes leaves no lock held, and a start killed mid-way releases it with its process. A start whose edwind
  never answers lets go after its 30 s; another start waits up to 40 s for the lock, then makes its own check.
- **Statuses.** A start that waited on the lock and then finds an edwind answering lost a race: status 3 ("another
  start started the edwind on …"). One that finds an edwind answering at once keeps status 1 ("an edwind already
  runs on …"). After status 0 or 3 the socket answers, so `edwinclient -a`, which attaches after any refusal,
  attaches to the winner.
- **The foreground start** (`edwin --fg-daemon`, what the user service runs) takes the lock for its check as well.
  It cannot keep it across `exec` without edwind inheriting it, so a detached helper (one node process, the same
  wait) holds it until that edwind answers, at most 30 s. A service start and a manual `edwin --daemon` at the same
  moment give one edwind too.
- **Choices.** Status 1 for "already runs" is kept, as the plan's default until the owner agrees otherwise; the
  alternative is status 3 for every refusal because an edwind answers, which `RestartPreventExitStatus=3` in a unit
  would then cover in full (today it covers only the lost race). The lock is held until the socket answers rather
  than only across the check and the `setsid`, as the plan worded it: the shorter hold leaves the 350 ms window in
  which a second start sees nothing answering. The timeouts are fixed (30 s, 40 s for the lock), as edwinclient's
  are, rather than options.
- **Not in it:** a lock under `EDWIND_CONFIG` (that path never checked for a running edwind, and still does not);
  argument checking and usage (`cli-daemon-args-and-edwind-usage`); the unit's readiness (`cli-unit-readiness`).
  edwind's own `stop()` unlinks the socket path last, after it stopped listening, so a new edwind that binds in that
  moment loses its socket. A start does not wait for a stopping edwind to exit; the check waits for each edwind
  it stops to be gone before the next start.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-daemon` (`test/daemon.test.mts`, real edwinds from the
  package under a throwaway `HOME` and `XDG_RUNTIME_DIR`): a start returns with the socket answering and a second
  is refused with status 1, while edwind holds no descriptor of the lock and the lock is free; `edwin --daemon &&
  edwinclient -e 1` prints 1 a hundred times in a row, each with a fresh edwind; two starts at once, five times,
  give statuses 0 and 3 and one edwind, and a second start 50, 150 and 300 ms after the first still gives one; the
  service start and `edwin --daemon` together give one edwind (the service's), and the helper lets the lock go;
  `--wait` returns only once the socket answers; a start and `--wait` whose edwind dies (a socket directory of mode
  755) fail after 30 s and leave the lock free; and `EDWIND_CONFIG` with a socket of its own (and a config edwind
  refuses, refused before anything starts).

## The window's tests in the package check (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package cli-gui-tests-in-check): `native/tests/gui.rs` runs inside
`nix build .#edwin` under Xvfb with xdotool, xprop and lavapipe, instead of skipping there; until then the
sandbox had no display and no GPU adapter, so DT2's window tests and its offscreen renders passed without running.

- **What the check has.** `nix/edwin.nix` gives the check phase Xvfb, xdotool and xprop (`nativeCheckInputs`),
  and Mesa's software Vulkan driver, lavapipe, as the only driver the Vulkan loader sees (`VK_DRIVER_FILES`, the
  `lvp_icd` file of `mesa`). The binary under test is `target/`'s, which gets its RPATH to the window's libraries
  only in `postFixup`, after the tests, so `preCheck` puts them on `LD_LIBRARY_PATH`. Mesa and the X tools are in
  the check's closure only, not the package's.
- **A skip fails there.** cargo test hides what a passing test prints, so a test that skipped and one that ran
  are both `... ok` in a build log. Every skip of the window's tests goes through one function, `skipped` (in
  `native/tests/gui.rs`, and in the render tests of `native/src/gui/mod.rs`), that fails the test when
  `EDWIN_TEST_REQUIRE_GUI` is set; the package's `preCheck` sets it. The skips it covers: no Xvfb or xdotool, an
  Xvfb that did not start, no window (`cannot open a window`: no adapter or no window libraries), no node for the
  edwinclient test, and no font or no adapter for the offscreen renders. Without the variable, as in a plain
  `cargo test` on a machine without Xvfb, they skip as before. Choice: fail on a variable. The alternative is
  `--nocapture` and a grep of the log for `skipped`, which floods the log with every test's output and proves only
  what the grep looks for.
- **Not in it:** the latency budget, `keystroke_to_screen_latency_budget`, stays `#[ignore]`d (timing on a shared
  builder is noise; it runs by hand, as DT2 says). Wayland is still not run (no compositor in the sandbox). xprop is
  there for `cli-window-identity`'s WM_CLASS and title test; no test here calls it yet. No new file, so no README
  layout row; and no check in nix/checks.nix: the tests are the package's own cargo tests, which `nix build
  .#edwin` runs (`nix flake check` does not build the package).
- **Checked by** `nix build .#edwin` on ex44: the log shows `tests/gui.rs` with 3 passed and 1 ignored
  (`keys_and_clicks_edit_and_wq_leaves_zero`, `the_close_button_asks_about_changes`,
  `edwinclient_c_is_a_frame_of_edwind_in_a_window`) and the unit tests `a_model_draws_its_faces_text_and_cursor`
  and `another_writer_is_a_bar_and_a_name_tag` passed, each of which would have failed had it skipped; three
  builds from scratch in a row passed (the window suite takes about 2.3 s). The same build without Xvfb and
  xdotool (the three window tests: `needs Xvfb and xdotool`), and again without the Vulkan driver (the two renders:
  `no graphics adapter`), failed in its check phase.

## edwin-daemon and edwind check their command lines (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `cli-daemon-args-and-edwind-usage`): edwin-daemon read only its
first argument and ignored the rest, so `edwin --daemon FILE` started a daemon and dropped FILE, and an unknown
option was not noticed; `edwind --help` and bare `edwind` answered with one raw usage line and status 2, and said
nothing of how a user starts one.

- **edwin-daemon reads the whole line first**, before `XDG_RUNTIME_DIR`, `EDWIND_CONFIG`, any directory, the lock
  or edwind. `-h`/`--help` prints its usage on stdout with status 0 (also with no `XDG_RUNTIME_DIR`). An unknown
  option (and `--`), or both `--fg` and `--wait`, prints what is wrong and the usage on stderr with status 2. Any
  other argument is a FILE: "the daemon opens no files (FILE); once it runs, edit them with edwinclient FILE",
  status 2. `edwin --daemon` and `edwin --fg-daemon` hand edwin-daemon every argument after themselves (as
  before), so `edwin --daemon --help`, `edwin --daemon --bogus` and `edwin --daemon FILE` get the same answers.
  Status 2 is apart from 1 (did not start, or one already runs) and 3 (another start started it), so a unit's
  `RestartPreventExitStatus=3` (`cli-unit-readiness`) does not cover a usage error. Bare `edwin-daemon`,
  `--fg` and `--wait` are unchanged, and `edwinclient -a` runs it with no arguments.
- **edwind.** `-h`/`--help` prints a usage that says what each option does and that your own edwind starts with
  `edwin --daemon`, on stdout with status 0, wherever it stands on the line (before the config is read). Every
  usage error says what is wrong in one line, then the usage, on stderr with status 2: bare `edwind` (or any line
  without `--config`) says "no --config PATH. To start your own edwind, run `edwin --daemon` ..."; an unknown
  option, `--config` or `--export` with nothing after it, and a file argument each say so. The lines that worked
  (services.edwind's `--config /etc/edwind/edit.json`, `--check`, `--export DIR`, `--write-roots`,
  `--primitives`) parse as before, after `lockdown()` and `guardProcesses()` as before.
- **Choices.** `edwin --daemon FILE` is refused in edwin-daemon, not in native/src/main.rs as the plan's "Where"
  had it: main.rs already hands edwin-daemon the rest of the line, so one reader checks it and the two cannot
  disagree (the alternative, a check in main.rs too, would also need its own copy of the message). The refusal is
  status 2, a usage error, rather than 1. In both programs the line is read in order and the first problem or
  `--help` answers: `--bogus --help` is refused, `--config NONE --help` prints the usage. A FILE is refused
  rather than visited by the new edwind; the alternative, the daemon visiting it at start, would make the start
  open a buffer no frame asked for.
- **Not in it:** `edwin FILE --daemon` (`--daemon` not first) is still main.ts's "unknown option --daemon", status
  2, as before. No new file; the README row of `test/daemon.test.mts` and the edwin-daemon check grew.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-daemon` (`test/daemon.test.mts`): `edwin-daemon --bogus`,
  `edwin --daemon --bogus`, `edwin --fg-daemon -x`, `--fg --wait`, `edwin --fg-daemon --wait` and `--wait --` give
  status 2 with the usage on stderr; `--help` and `-h`, through edwin-daemon and through `edwin --daemon` and
  `--fg-daemon`, give status 0 and the usage on stdout with no `XDG_RUNTIME_DIR` and an `EDWIND_CONFIG` that does
  not exist; `edwin --daemon a.txt`, `--fg-daemon a.txt`, `--daemon +3 a.txt`, `--daemon -` and `edwin-daemon
  --wait a.txt` give status 2 and the FILE message, and a.txt is not made; and in every one of those no edwind
  runs, the socket does not answer, and neither the run directory nor the state directory (with its lock) was
  made. Bare `edwind` gives status 2 and names `edwin --daemon`; `edwind --help`, `-h` and `--config NONE --help`
  give status 0 and the usage on stdout; `--bogus`, `--config X --bogus`, `--config`, `--config X --export` and
  `a.txt` give status 2 with their line and the usage. `edit-lockdown`, `edit-security`, `edit-conformance` (which
  runs `edwind --check`) and `edwin-typecheck` pass with server/main.mts changed.

## The window is edwin, and `--title` names it (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `cli-window-identity`): the window carries app_id and WM_CLASS
`edwin`, and `--title NAME` sets its title, so compositor rules can match the scratch and calculator frames (niri
matches app-id and title; KWin's rules match the window class and title).

- **The name.** `native/src/gui/mod.rs` opens the window with winit's `with_name("edwin", "edwin")`: on X11 that
  is `WM_CLASS(STRING) = "edwin", "edwin"`, on Wayland the xdg-toplevel app_id `edwin` (winit's Wayland side takes
  the same name). Until now X11 got winit's default, the program's name (`edwinclient`'s window was
  `"edwinclient", "edwinclient"`), and Wayland got no app_id at all. Choices: one name for both programs, the plan's
  default (decision 17); the alternative is `edwinclient` for a client's windows, which would let a rule tell a
  frame of edwind from a standalone edwin. Both halves lowercase, so an X11 rule and a Wayland one match the same string
  (an Xwayland window's app-id is usually its class); the alternative is ICCCM's capitalised class,
  `"edwin", "Edwin"`, as Emacs has.
- **`--title NAME`** (and `--title=NAME`), for edwin and edwinclient alike: the window opens with that title and
  keeps it whatever the frame shows; without it the title is `Edwin` until the frame draws, then `BUFFER - Edwin`,
  as before. NAME is the next argument whatever it looks like (as Emacs takes `-T`'s), so it is never a file to
  edit; a missing or empty one is a usage error, status 2 (`--title needs a name`). Both readers of the command line
  take it alike: `main.rs` hands it to the window, `main.ts` checks it and skips it. In a terminal frame, or when no
  window opens and the program falls back to the terminal, it is accepted and does nothing. Choice: ignored there;
  the alternative is the terminal's own title (OSC 2), which nothing asks for.
- **The window's tests** (`native/tests/gui.rs`) find a window by a title of their choosing, and wait for the
  frame's first draw (`startup first draw` in the frame's log, under `EDWIN_TRACE`) as well, since a window titled
  by `--title` is there before the frame draws in it. xprop is checked for with Xvfb and xdotool, so a machine
  without it skips (and the package's check fails) rather than panicking.
- **Not in it:** Wayland's app_id is set but not tested: there is no compositor in the sandbox. The owner checks it
  on niri and Plasma. No `.desktop` file (and so no `StartupWMClass`); the callers that pass `--title`
  (`fleet-org-scratch`, `fleet-calc-key`) are the fleet's; `-n` is `cli-no-wait`. No new file, so no README layout
  row; and no check in nix/checks.nix: the tests are the package's own cargo tests, which `nix build .#edwin` runs.
- **Checked by** `nix build .#edwin` on ex44: `tests/gui.rs` 4 passed, 1 ignored (the latency budget), with
  `the_window_is_edwin_and_title_names_it_for_good` (WM_CLASS `"edwin", "edwin"` and the title `a.txt - Edwin`
  without `--title`; with `--title org-scratch` and with `--title=org-scratch`, WM_CLASS the same and
  `_NET_WM_NAME` and `WM_NAME` still `org-scratch` after the frame drew and an edit) and
  `edwinclient_c_is_a_frame_of_edwind_in_a_window`, now opened with `-c --title org-scratch` as the scratch popup
  will be, asserting the client's WM_CLASS is `"edwin", "edwin"` (it was `"edwinclient", "edwinclient"`) and that
  the title stays. `tests/terminal.rs`: `--title` with no name and `--title=` are status 2 for both programs
  (`help_version_and_bad_options_need_no_terminal`), and `--gui --title b.txt a.txt` with no display edits
  `a.txt` in the terminal and never makes `b.txt` (`a_window_without_a_display_is_the_terminal`). Also
  `nix flake check` (with `edwin-typecheck` over `native/js`).

## The user unit is ready when its socket answers (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `cli-unit-readiness`): programs.edwin's user unit was
`Type=exec`, so systemd called edwind started as soon as `edwin --fg-daemon` was exec'd, about 350 ms before the
socket listened, and a unit ordered `After=edwind.service` could start, connect and find no edwind.

- **Ready means listening.** The unit (`systemd.user.services.edwind` in nix/edwin-module.nix) runs
  `ExecStartPost=edwin-daemon --wait` from the package: the unit stays `activating` until something accepts on
  `$XDG_RUNTIME_DIR/edwin/edit.sock`, and only then is `active`, so units ordered after it, and
  `systemctl --user start edwind` itself, return with the socket answering. The post command gets the unit's own
  environment, so it waits on the socket the foreground start uses.
- **A dead start fails at once.** systemd gives `ExecStartPost` the main process's pid in `MAINPID`, and `--wait`
  gives up as soon as that process is gone (it asks the socket first, so an edwind already answering still counts).
  `Restart=on-failure` starts edwind again a second later, and an edwind that keeps crashing reaches systemd's
  start limit (5 starts in 10 s) and the unit is `failed` (`start-limit-hit`). Without the `MAINPID` check each
  crashed start sat in `start-post` for the full 30 s, `systemctl --user start edwind` and the units after it
  blocked that long, and at one start per 31 s the limit was never reached: it retried forever (measured on ex44
  with transient user units shaped like this one, a real edwind refusing a mode-755 socket directory: with the
  check `failed`, `start-limit-hit` and 5 restarts within 10 s; without it still `activating` after 76 s).
- **A hung start is retried without end.** An edwind that runs but never listens is given up on by `--wait` after
  30 s (well inside systemd's start timeout); systemd stops it and starts it again a second later. One start per
  31 s never reaches the default start limit, so the unit keeps retrying, each start blocking for 30 s, until
  stopped (measured as above with a main process that never listens: a restart every 31 s). The alternative is
  `StartLimitIntervalSec` long enough to count 31 s starts (e.g. 300 s), which would also count the owner's own
  restarts against the limit; not done.
- **Status 3 is not retried.** `RestartPreventExitStatus=3`: the foreground start exits with 3 when it waited on
  the lock while another start (a manual `edwin --daemon`) brought up the edwind on the socket. Retrying would only
  meet that edwind again. The unit is then `failed`, with status 3, while the other edwind serves.
- **Choices.** `ExecStartPost` and the existing `Type=exec` rather than socket activation (systemd holding the
  socket and handing it to edwind, which today binds its own and would need to accept a passed one) or
  `Type=notify` (edwind calling sd_notify, a change to server/main.mts, which ex44's public edwind shares); both
  remain open. `RestartPreventExitStatus=3` rather than `SuccessExitStatus=3`: with the latter a lost race would
  leave the unit `inactive` instead of `failed`; one line to change if the owner prefers it.
- **Not in it:** status 1 from the foreground start ("an edwind already runs", found at once with no wait on the
  lock) is still retried by `Restart=on-failure` until the start limit, then the unit fails, as before
  (cli-daemon-start kept status 1 for that). No test boots a user manager: the check evaluates the unit, and the
  behaviour of `--wait` is the edwin-daemon check's. No new file, so no README layout row.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-module`: the evaluated system's rendered `edwind.service`
  has exactly the lines `ExecStart=…/bin/edwin --fg-daemon`, `ExecStartPost=…/bin/edwin-daemon --wait`,
  `Restart=on-failure`, `RestartPreventExitStatus=3` and `RestartSec=1` among those that start and restart it (the
  same check with the `RestartPreventExitStatus` line removed from the module fails with both sides printed); and
  `nix build .#checks.x86_64-linux.edwin-daemon`, whose `--wait` cases return only once the socket answers, fail
  after 30 s when edwind dies, and fail within 5 s when the edwind `MAINPID` names dies (with an edwind `MAINPID`
  names alive, `--wait` returns once it answers; a `MAINPID` that is not a pid is refused with status 2).

## `-f COMMAND`: a command run in the new frame (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `cli-funcall`): `edwinclient -f NAME` runs the command NAME in
the frame it opens, delivered as the key `<cmd:NAME>`, as `emacsclient`'s callers use `-e '(NAME)'` and `emacs -f
NAME` does. It is the one way the calculator key, the mail notification and the git alias will open Edwin on a
command (`fleet-calc-key`, `mail-fleet-notify-edwin`, `git-fleet-retire`). `-e FORM` stays what it was: forms
evaluated in edwind, with no frame.

- **Both programs.** `-f COMMAND`, `--funcall COMMAND` and `--funcall=COMMAND`, for edwin and edwinclient alike,
  in the terminal and the window. Choice (decision 17, which named no default): edwin too, because
  `git-fleet-retire` makes `mg` `edwin -f vc-status`, and one parser serves both programs; the alternative is
  edwinclient only, a `client &&` in main.ts and an `if client` in main.rs.
- **A name, never a form.** COMMAND is the next argument whatever it looks like (as `--title`'s NAME is), and must
  be made of printable ASCII letters, digits and `! $ % & * + - . / : = ? @ ^ _ ~`: nothing that could open a
  form, a string, a comment or a key name. Anything else (`(delete-file "a.txt")`, `quick calc`, `a;b`) is a
  usage error, status 2, and so is a missing or empty COMMAND. Both readers of the command line check it alike
  (main.rs's `command_name`, main.ts's `COMMAND_NAME`), so a refused `-f` never attaches to edwind, starts one
  with `-a` or opens a window first. The name is only interned, never read or evaluated. Choice: ASCII only,
  which every shipped command name is; the alternative is any character but those, which would need the two
  readers to agree on Unicode's whitespace.
- **When it runs.** After the init files (edwind's for edwinclient, `~/.config/edwin/init.scm` for edwin) and
  the files on the line, once the frame is made and `+LINE[:COL]` has placed point, so `+2 -f upcase-word f.txt`
  acts on line 2. The key is fed before any typed key can reach the frame. A command declared `(:where 'server)` runs in edwind, as from `M-x` (`-f image-log` shows
  edwind's `*image-log*`).
- **A name that is no command** (unbound, or a function that is not interactive, such as `car`) is checked once
  the init files have run and before any file is visited or a frame drawn: the program gives the terminal back,
  says `NAME is not a command` and exits with status 1. Choices: status 1, since the line was well formed and
  only the editor's commands could tell (status 2 stays for usage errors); and exiting rather than opening the
  frame with the error in the echo area (as Emacs does), which is what the package asks for, so a script can
  tell.
- **One `-f`.** A second is a usage error (`-f runs one command; give it once`). Fed together, a second command's
  key would be read by the first's prompt (`find-file`'s minibuffer, an operator) as its answer. Choice: once,
  which every caller in the plan needs; the alternative is Emacs's chain, each command fed only once the one before
  has returned to the top level (src/ai.ts's feedAtTopLevel waits that way).
- **`-f` with `-e`** is a usage error (`-f runs a command in a frame, and -e opens none`). After `-e` every
  argument is a form, so a `-f` there is one, as before.
- **Not in it:** passing arguments to the command (it is called interactively, and prompts in the frame as from
  `M-x`); `-n` is `cli-no-wait`. The `desktop-only` stubs in scm/init.scm are untouched: none of them is this.
  No new file, so no README layout row; and no check in nix/checks.nix: the tests are the pseudo-terminal
  suite's, which `nix build .#edwin` runs.
- **Checked by** `nix build .#edwin` on ex44 (`tests/terminal.rs` 30 passed), with
  `funcall_runs_a_command_in_the_frame` (`+2 -f upcase-word f.txt` makes line 2 `THREE four` with no key typed
  before `:wq`, and `+1 --funcall=funcall-test-mark f.txt` runs a command of the user's init.scm),
  `funcall_of_a_name_that_is_no_command_exits_1` (`no-such-command` and `car`: status 1, `edwin: NAME is not a
  command`, no frame drawn, the terminal left, the file unchanged) and
  `edwinclient_funcall_runs_a_command_in_the_frame` (against a throwaway edwind: `-f upcase-word` edits the file,
  `-f image-log` shows edwind's `*image-log*`, and `-f no-such-command` exits 1 before a frame is drawn).
  `help_version_and_bad_options_need_no_terminal`: a missing or empty name and a form are status 2 for both
  programs, and so is a second `-f`; so are `-f x -e 1` and a refused name after `-c` for edwinclient with no edwind to attach to,
  which shows main.rs refused them before looking for one. Also `nix flake check` (with `edwin-typecheck` over
  `native/js`).

## `edwinclient -n -c`: the window stays, the command returns (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `cli-no-wait`): `edwinclient -n -c` returns at once and leaves
the frame's window open, as `emacsclient -n -c` does, for the callers that must not wait for the frame (the
scratch popup, the calculator key, the mail notification and the shell aliases of phase 2 and 5).

- **What returns, and when.** `-n` and `--no-wait`, edwinclient only. native/src/main.rs first tries what can
  fail while the caller still sees what is said and the status: that a display is set and its libraries load
  (`gui::unavailable`, as the window's fallback asks) and that the display answers (`gui::probe`: winit's event
  loop is built as the window's would be, which connects to it, and dropped; a stale `DISPLAY` or
  `WAYLAND_DISPLAY`, as a tmux or ssh session or a key run after a compositor restart has, is `cannot open a
  window: cannot reach the display: ...`), then that an edwind answers (the same search as a frame's:
  `--socket`, `--remote`, `$EDWIN_SOCKET`, the user's socket, and `-a` starting the user's own), then that the
  frame's log opens. A failure is said on stderr with status 1, before anything is detached, and no frame is
  started. The probe's connection is closed (with a remote edwind's ssh). Then the same program is run again, by the name it was run by (so it is
  edwinclient), with the same command line less each `-n` (removed by its place, so a `--title -n` or a `-f -n`
  value is kept), the same environment and directory, and edwinclient returns 0 without waiting for it. The new
  process is an ordinary `edwinclient -c` from there: it attaches, boots edwind's image and opens the window.
- **Detached.** The frame's process calls `setsid` before its exec: a session of its own, so no controlling
  terminal (the terminal's hangup and keys are not its), and opening `/dev/tty` fails, so a window that cannot
  open is never drawn in the caller's terminal instead (the frame exits 1). Its standard input and output are
  `/dev/null`, and its standard error is appended to its log, the file its console writes to (`EDWIN_LOG`, else
  `edwin.log` in the state directory, `~/.local/state/edwin/edwin.log`; the directory made 0700 and the file 0600
  when missing; main.rs's `frame_log` and prelude.ts name it alike), so what the frame says once detached is kept
  there. Every other descriptor edwinclient inherited is marked close-on-exec (`close_range(3, ~0,
  CLOSE_RANGE_CLOEXEC)`, first of all, before anything is run), so no pipe of the caller's reaches the frame, nor
  edwin-daemon and its edwind with `-a`, nor a remote edwind's ssh: `$(edwinclient -n -c f)`, a `subprocess`
  reading the output, or a unit's journal pipe is not held open until the window closes (or the daemon ends). Not waited for, it is reparented
  when edwinclient exits, so the caller is left no zombie and nothing sits between it and the frame.
- **Refused with status 2**, by both readers of the command line alike, before an edwind is looked for: `-n`
  without a window (`-n leaves the frame in a window of its own: give -c`; `-c ... -t` counts as the terminal, the
  last one winning as before), `-n` with `-` (`-n reads no standard input (-): the frame outlives this command`),
  and `-n` with `-e` (`-n leaves a frame open, and -e opens none`). `--help` and `--version` answer as before.
  `edwin -n` is an unknown option that says edwinclient has it.
- **Choices**, each reversible:
  - `-n` without `-c` is refused. Emacs's `emacsclient -n FILE` visits FILE in a frame the daemon already has;
    an edwind has no frame of the desktop's to reuse, and a detached frame cannot draw in a terminal. The
    alternative is `-n` implying `-c`.
  - `-n -e` is refused; the alternative is to ignore `-n` there, as the forms are answered at once anyway.
  - The checks are made before detaching, and what fails in the frame after it is said only in the frame's log:
    a `-f NAME` that is no command (known only once edwind's init has run), or a window the display refuses after
    all (no GPU adapter, e.g. `VK_DRIVER_FILES` naming no driver), end the frame with status 1 while the caller
    has already seen 0. The display itself is connected to before detaching (milliseconds), so a stale one is
    said to the caller; the GPU adapter is not looked for there, as that is the frame's renderer's start. The
    alternative is a readiness pipe: the caller waits until the frame has drawn, which reports those too but makes
    the caller wait for the frame's cold boot (edwinclient does not start from the snapshot), which is what `-n`
    is for not doing.
  - The frame's standard error is its log, and a log that cannot be opened (an unwritable state directory) is
    status 1 before detaching, so a failure after is never without a trace. The alternative is `/dev/null` then,
    which detaches anyway and loses what the frame says.
  - Re-executed rather than forked: the frame is a fresh process image (the program is two threads by then, and
    a fork keeps only one), and nothing but the command line and the environment crosses over. The probe's connection is not handed over; the frame
    opens its own.
- **Not in it:** no timeout of edwinclient's own: the attach waits as long as a frame's does (30 s for an edwind
  to answer, through ssh too). No line of edwinclient's own in the log: what is there is the frame's (its
  console's lines are timed, its standard error's, such as `edwinclient: NAME is not a command`, are not), and the
  log is never rotated, as before. The fleet's callers (`fleet-org-scratch`, `fleet-calc-key`,
  `mail-fleet-notify-edwin`, `fleet-shell-aliases`) are the fleet's. No new file, so no README layout row; and no
  check in nix/checks.nix: the tests are the package's own cargo tests, which `nix build .#edwin` runs.
- **Checked by** `nix build .#edwin` on ex44: `tests/gui.rs` 5 passed, 1 ignored (the latency budget), with
  `edwinclient_n_returns_at_once_and_the_window_stays`, which runs under `EDWIN_TEST_REQUIRE_GUI` (a skip would
  fail): `-n -c --socket MISSING` says `cannot attach to edwind at MISSING` with status 1 within 1 s and leaves no
  process; `-n -c --socket EDWIND note` with `DISPLAY` naming a display nobody serves (the Xvfb's number with a 7
  after it) says `cannot open a window: cannot reach the display` with status 1 within 1 s and leaves no process;
  `-n -c -f no-such-command-xyz --socket EDWIND note` returns 0 within 1 s, the frame it leaves exits 1, and
  `edwinclient: no-such-command-xyz is not a command` is in `state/edwin/edwin.log`, made 0600 (the log is then
  removed, so the next frame's first draw is its own); `-n -c --title no-wait --socket EDWIND note`, given a pipe's write end that is not close-on-exec and
  with its stdout and stderr read to their ends, returns 0 within 1 s with nothing on stdout, and the pipe's read
  end is at its end at once (nothing holds the caller's descriptor); the test is a subreaper, and the one process
  left is the frame, its child directly (nothing between them), leading a session of its own with no controlling
  terminal (tty_nr 0), `/dev/null` on descriptors 0 and 1 and its log on 2; the window titled `no-wait` appears, draws, is the
  frame's (`_NET_WM_PID`), is WM_CLASS `edwin`, and stays; text typed in it and `:wq` reach edwind's note, the
  frame exits 0, is reaped, and no process is left. `tests/terminal.rs` 31 passed: in
  `help_version_and_bad_options_need_no_terminal`, `edwin -n` and `edwin --no-wait` are unknown options naming
  edwinclient, and edwinclient's `-n a.txt`, `-c --no-wait -t a.txt`, `-n -c -` and `-c -n -e 1` are status 2 with
  no edwind to attach to (refused before one is looked for); `no_wait_without_a_display_says_so_and_leaves_the_terminal_alone`
  (`-n -c a.txt` in a pseudo-terminal with no display: status 1 within 1 s, `cannot open a window: no display`,
  the terminal not taken). The gui test fails without each defence: with the `close_range` call removed the frame
  holds the caller's pipe (`poll 0`), and with the `setsid` line removed the frame shares the build's session (a
  first such run also showed that the test's read of the pipe blocked when poll timed out, hanging instead of
  failing; it now reads only once poll says it will not block). Also `nix flake check` (with `edwin-typecheck`
  over `native/js`). One run of it failed in `edit-agent` (a pi agent's call timed out) and `edit-crash` (R16.5),
  server tests this package does not touch; each then passed twice on its own and the rerun of `nix flake check`
  passed. One `nix build .#edwin` run beside two others failed in `wq_saves_and_exits_zero` alone (ESC and `:`
  read together as `M-:` under the load), a test this package does not touch; the build run alone passed.
- **After review** (the display probe and the frame's log): `nix build .#edwin` on ex44 passed (unit 4, gui.rs 5
  and 1 ignored, terminal.rs 31). The gui test fails without each fix: with `gui::probe` put back to
  `gui::unavailable`, the stale-display run gives status 0; with the frame's standard error put back on
  `/dev/null`, the `-f` frame's message is not in its log. Outside the sandbox, with the built package and a
  throwaway HOME: `DISPLAY=:77 edwinclient -a -n -c --title e1 f` with no server there says `cannot reach the
  display` with status 1 in 19 ms, and the frames that failed after detaching (no Vulkan driver outside the
  sandbox) each left `cannot open a window: cannot draw in the window: ...` in `edwin.log` (0600). One earlier
  build run failed in `keys_and_clicks_edit_and_wq_leaves_zero` alone (`Xvfb did not start` within 10 s, ex44's
  load near 10 from other builds); the next passed. `nix flake check --keep-going` ran 29 checks: all passed but
  `edit-agent` (a pi agent's call timed out, as before), which passed on the rerun. A first run, without
  `--keep-going`, stopped at `edwin-bench` (shadow stack 10.1% against its 10% limit, under the same load), which
  passed in the next.

## Child processes in the desktop program (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `proc-host-spawn`; owner decision 1: the native program may
start child processes, from the TypeScript core only). Until now the desktop program started only its own
helpers: a remote edwind's ssh, edwin-daemon (`--daemon`, `edwinclient -a`) and itself again (`edwinclient -n`). Compile, grep, shell commands, git, jj, formatters and language servers all need one, and
this package gives them one implementation: natives in `native/src/proc.rs`, which `Ed.proc` (proc-frame-api)
builds on. It replaces the plan's git-spawn-native.

- **The natives** (`__n`, typed in `src/core.d.ts`): `procSpawn(argv, {cwd, env, timeout, maxBytes, lossy,
  merge})` returns the child's id, or throws `cannot run PROGRAM: No such file or directory` (a missing program
  or directory is said at once: std's exec-error pipe); `procWrite(id, text)` queues text for its standard input
  and returns false once that is closed; `procCloseStdin(id)` closes it once the queue is written; `procKill(id,
  signal = 'TERM')` signals it and what it started, false when it is not running; `procList()` gives `{id, pid,
  argv}` of each child not yet reported ended. What a child writes reaches `__native.handlers.proc(id, 'out' |
  'err', text)` as it comes; its exit reaches `(id, 'exit', {code, signal, timedOut, truncated, error?})` once,
  after all of its output.
- **argv only.** The program is looked up on `PATH` (the one `env` gives, if it sets one) and run with its
  arguments as they are; no shell sees them. `env` changes the inherited environment, a `null` value removing a
  name; a name that is empty or holds `=` is refused.
- **Never blocking the loop.** The three pipes are non-blocking and polled by `sys::wait` with the terminal, the
  signal pipe and the sockets (and handed to the window's waker thread through `poll_fds`). Input is queued and
  written as the pipe takes it (8 MiB queued for a `cat` that has read nothing returns at once; past 64 MiB not
  yet taken a write throws). Output is read one 64 KiB chunk per pipe per turn, so a child that writes without
  pause (`yes`) never starves the keys.
- **Exits.** SIGCHLD joins the signals on the self-pipe (with `SA_NOCLDSTOP`), only to wake the loop: it is not
  passed to JS. Every turn each child is reaped by its own pid (`try_wait`), never `waitpid(-1)`, which would
  take the ssh child and edwin-daemon's `status()` from std. A reaped child's pipes are read to what it left in
  them (its own output is all there once it has exited), then its exit is reported and the pipes closed: what it
  started and left running, holding the pipe, does not delay the exit.
- **At most 64** children run at once, counted until reaped: the 65th spawn throws `too many processes: at most
  64 run at once`.
- **Ended with the program.** However `run` returns, `proc::kill_all` sends TERM to each child's process group,
  then KILL after 500 ms to what is left, reaping each; a child stuck in the kernel is left to init after another
  500 ms, so quitting never waits past 1 s. A child of a program that dies otherwise (a crash, `panic = abort`,
  SIGKILL) is killed by the kernel (`PR_SET_PDEATHSIG`).
- **The child's start** (`pre_exec`, async-signal-safe calls only): `setsid`, so a session and process group of
  its own and no controlling terminal; `PR_SET_PDEATHSIG(SIGKILL)` (and not run when the parent is already gone);
  SIGPIPE back to its default (Edwin ignores it, and an ignored signal stays ignored across exec; std resets it
  too, the line keeps it so whatever std does); `close_range(3, ~0, CLOSE_RANGE_CLOEXEC)`, so it inherits only its
  three descriptors (marked close-on-exec rather than closed, which keeps std's own exec-error pipe working).
- **Choices**, each reversible:
  - A session of its own rather than only a process group: a git or ssh that would ask on `/dev/tty` fails
    (`No such device or address`) instead of being stopped by SIGTTIN or reading keys from the raw terminal
    Edwin holds, and the signals of a terminal (C-c in a shell around edwin) do not reach it. A signal from
    `procKill`, a timeout or the end goes to the whole group, so what the child started (`sh -c 'a | b'`) ends
    with it. Signals go only to a child not yet reaped, whose pid therefore cannot belong to another process.
  - `timeout` (ms) sends TERM, then KILL 500 ms later to a child that ignores it, and the exit says `timedOut`.
    TERM first gives git the chance to remove its lock files. A timeout too long for the clock is no timeout.
  - `maxBytes` counts output and error together: what is past it is not delivered, the child is killed and the
    exit says `truncated` (a UTF-8 sequence cut at the limit is dropped).
  - Output is UTF-8. Without `lossy`, bytes that are not end the child with `error: 'its output is not UTF-8
    text'` (what came before them is delivered), as `readFile` refuses such a file: a filter or a formatter
    whose output replaces text never writes back changed bytes. With `lossy` (git's output: names and contents
    in any encoding) they become U+FFFD. A sequence split between two reads is one character either way.
  - `merge` sends standard error into the output pipe, interleaved as written (compile's buffer); without it
    the two are separate and their relative order is lost.
  - Standard input is always a pipe; a caller that gives none closes it at once (`procCloseStdin`), as
    proc-frame-api's `run` will.
- **Not in it:** no pseudo-terminal (a shell's or a REPL's own terminal), no `Ed.proc` and no refusal under image
  replay or in web frames (proc-frame-api), no Scheme `make-process` (declined), and nothing in edwind, which
  still never spawns (R4.45). Processes are the desktop program's only; a `--remote` frame's children run on its
  own machine. No detached spawn: every child is ended with the program, so an opener that waits for its viewer
  (bib-open-external) needs one of its own. No new check in nix/checks.nix: the tests are the package's cargo tests, which `nix build .#edwin`
  runs.
- **Checked by** `nix build .#edwin` on ex44: unit tests 17 passed (13 in `proc::tests`), `tests/gui.rs` 5 passed
  and 1 ignored (the latency budget), `tests/terminal.rs` 31 passed. The proc tests drive `sys::wait` as the loop
  does, with coreutils from `PATH`: `echo_gives_its_output_then_its_exit`, `argv_is_never_a_shell_line` (`$HOME;
  touch x` and `` `id` `` come back as written), `error_status_cwd_env_and_merge` (status 2 of `ls` on a missing
  directory, `cwd`, a variable set and one removed, merged error), `a_program_that_cannot_run_is_refused_at_once`,
  `stdin_is_written_as_the_child_takes_it_and_closed` (8 MiB through `cat`, queued in under 1 s, all of it back),
  `kill_ends_the_child_and_what_it_started` (TERM reaches a grandchild in the group; a reaped child takes no
  signal), `the_65th_spawn_is_refused` (64 `sleep`s, then room again after `kill_all`), `no_zombie_after_exit`
  (`/proc/PID` gone, `waitpid` finds nothing), `the_timeout_fires_and_kill_follows_a_child_that_ignores_term`
  (TERM at 200 ms; KILL after a `trap '' TERM`; the loop wakes for the deadline by itself),
  `max_bytes_cuts_the_output_and_ends_the_child` (`yes`, exactly 10,000 bytes),
  `output_that_is_not_utf8_is_an_error_unless_lossy`, `the_child_inherits_only_its_three_descriptors_and_no_terminal`
  (a descriptor of the test's that is not close-on-exec does not reach it; its own session, `tty_nr` 0, SIGPIPE
  not ignored) and `kill_all_ends_every_child_within_its_bound` (one child ignoring TERM; under 2 s). Each defence was also checked by
  taking it out, in a scratch crate that compiles only `sys.rs` and `proc.rs` (`cargo test`, not the package
  build): with the `close_range` call removed the descriptor test fails; with `setsid` removed 6 of the 14 tests
  fail (the group signals, the session check, `kill_all`); with the per-turn reaping removed the 11 tests that
  wait for an exit event fail (most after a 60 s hang); with the SIGPIPE line removed nothing fails, as std
  resets it as well. `nix build .#checks.x86_64-linux.edwin-typecheck` passed (the new
  types in `src/core.d.ts`, `native/js/prelude.ts`). And once through the built program's own JavaScript, with
  a throwaway patch of `native/js/main.ts` (not committed) run from the restored snapshot with a throwaway HOME:
  `sh -c 'cat; echo "$X" >&2; exit 3'` given `hi` and `env: {X: 'y', HOME: null}` gave `out hi`, `err y` and
  `{code: 3, signal: null, timedOut: false, ...}`; `sleep 10` with `timeout: 100` gave `{code: null, signal:
  'TERM', timedOut: true}`; `printf 'ab\377'` with `lossy` gave `ab` and U+FFFD; a missing program, an argv that
  is no array and an unknown signal threw; edwin then exited 0, idle, in 0.12 s.

## The line diff: a buffer replaced by its changed lines (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `lang-line-diff`): `Ed.diffLines` and `Ed.applyLineDiff`, which
replace a buffer's text by the changed line ranges only, keeping point and markers; auto-revert, formatting and
ws-butler (later packages) are to use them.

- **`Rope.diffLines(a, b)`** (src/text.ts, also `Ed.diffLines`): the ops `[pos, del, ins]` that turn A into B, in
  sequential coordinates (each op's position counts the ops before it), ready for `applyOps`. A Myers diff of the
  lines, each line with its newline and compared as a number (one per distinct line), after the common prefix and
  suffix lines are taken off; each hunk is then shrunk by its common characters at both ends, never between the
  halves of a surrogate pair. It is pure and lives in text.ts with the rope, so a worker (which gets `ropeSource`)
  has it too.
- **The limits.** Past 1,000 differing lines, or 5,000,000 units of work (diagonal steps and matched lines), it
  gives up and returns the one span between the common prefix and suffix of characters: the whole replace the
  package's risks ask for, the same span `b.text = ...` changes. The Myers trace keeps only the band of diagonals
  each step reads, so it holds at most about a million numbers. On ex44 a 200,000-line file with 10 to 450
  changed lines diffs in 130 to 200 ms, most of it in splitting and numbering the lines, not in Myers; one with
  2,000 changed lines (past the limit) falls back in 180 ms, a 20,000-line one in 17 ms.
- **`Ed.applyLineDiff(b, text, origin?)`** (src/editor-core.ts): the diff of B's text to TEXT applied as one
  `applyOps` batch by ORIGIN (the current one when absent), so the change hooks, the edit log and undo, `b.ver`,
  the protocol client and redisplay see an ordinary edit, and `shiftMarkers` moves point, the other windows'
  points and every marker: those on a line the diff leaves alone stay on it at their column. Returns the applied
  ops (none when the text is the same).
- **Choices**, each reversible:
  - Whole lines inserted at a line start would leave a before marker there (the mark, Evil's marks, a
    `copy-marker` of type before) on the first inserted line, as an insertion does in Emacs; `applyLineDiff` moves
    such markers past the inserted lines, to stay with the line they were on. Undo puts them back (the undone
    insertion is a deletion ending at them). Redo leaves them before the reinserted lines, as any redone insertion
    does.
  - Neither the read-only flag nor `b.modified` is touched: a revert wants the buffer unmodified and allowed in
    a read-only buffer, a formatter the opposite, so the caller says.
  - The algorithm is in text.ts beside the rope, not in editor-core.ts: text.ts loads first and has no `Ed`, so
    the plan's `Ed.diffLines` is `Rope.diffLines` re-exported; `applyLineDiff` needs `applyOps` and lives in
    editor-core.ts.
- **Differences from Emacs** (`replace-buffer-contents`): its diff is by characters, with a time limit after which
  it does a plain replacement; this one is by lines, then by characters within each changed run of lines, so a
  marker inside a changed line goes to the start of the change (before markers) or past it (after markers, point).
  A last line with no newline that lines are appended after is a changed line: point at its end ends up at the
  end of the appended text.
- **Not in it:** no caller; auto-revert (`proc-auto-revert`), formatting and ws-butler are their own packages.
  `b.text = ...` still changes the one differing span. edwind keeps its own copy of the same algorithm
  (`diffOps` in server/watch.mts, used by its revert and three-way merge); making it use this one touches
  ex44's public edwind and is later work.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-linediff` (new, test/linediff.test.mts, fast-check, 2,000
  runs a property; also passed with `LINEDIFF_RUNS=20000`): for random texts of repeated lines (empty lines, CR,
  astral characters, with and without a final newline) the ops applied to A give B, so does `applyLineDiff` on a
  buffer, both again with the work budget forced to 3 (the whole-replace fallback), and no op starts or ends
  inside a surrogate pair; for A of unique lines and B made from it by deleting, changing and inserting lines,
  point at a random column, the mark and a before marker at the start of a kept line and an after marker at a
  random column of one stay on the same line and column; the lifted marker goes back on undo; a 200,000-line file
  with two changed lines gives two ops, and one with every other line changed gives one span. Taking out the
  marker lift fails two of the cases; taking out the surrogate guard fails the surrogate case. Also
  `edwin-typecheck`, `edwin-headless` and `edwin-pool`, and `nix flake check --keep-going` on ex44: a first run
  failed in `edwin-bench` (shadow stack 12.2% against its 10% limit) and in the package's gui tests (`Xvfb did not
  start`, with `edwin-daemon` waiting on the package), under load from other builds; `nix build .#edwin` alone
  (unit 4, gui.rs 5 and 1 ignored, terminal.rs 31), `edwin-bench` alone (7.7%) and the rerun of `nix flake
  check` then passed. The core files reach edwind and the native program too, but no Scheme primitive is
  added, so nothing new is reachable through `edwinclient -e`.

## The desktop daemon's settings and credentials (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `ai-daemon-models`): the desktop edwind's edwind.json was made
by `edwin-daemon` at each start with five fixed fields, so a desktop could declare no models, brain or hub, and its
user unit loaded no credentials. This is the one way every area extends the desktop edwind.json.

- **Settings.** `programs.edwin.daemon.settings` (nix/edwin-module.nix) is free-form JSON, merged by the module
  system from every module that sets it (the models area and the brain area each add their part), written to the
  store and given to the unit as `EDWIND_CONFIG_EXTRA`. `edwin-daemon` merges that object into the edwind.json it
  writes: its `refusePaths` are added to the daemon's three (so no fragment drops `~/.ssh`), `socket`, `notesDir`,
  `stateDir` and `configDir` stay the daemon's (an assertion in the module, and a refusal with status 1 before
  anything is written in the script), and every other field is taken as given. edwind's `loadConfig` then checks
  the result as it checks any config, so a wrong field fails the start visibly. `EDWIND_CONFIG` and
  `EDWIND_CONFIG_EXTRA` together are refused: the fragment would otherwise be silently ignored. With no settings
  the unit has no `EDWIND_CONFIG_EXTRA` and renders as before.
- **Credentials.** `programs.edwin.daemon.credentials` (name to file) become the unit's `LoadCredential=NAME:FILE`
  lines; settings name them (`models.anthropic.credential`, `models.credentials.NAME`, `brain.readCredential`),
  and edwind reads `$CREDENTIALS_DIRECTORY/NAME` at use. The file is a string, never a Nix path (a path would be
  copied into the world-readable store); the module refuses one in the store, a relative one, one with a colon
  (it would end LoadCredential's path) and a name outside `^[a-z0-9-]{1,32}$`. A user manager runs
  LoadCredential: measured on ex44 (systemd 262) with a transient user unit, the file appears 0400 in
  `/run/user/UID/credentials/UNIT/`, owned by the user. So the file must be readable by the user: a sops secret
  edwind loads needs `owner = "yanni"` on the fleet side (the owner's step; otherwise the unit fails with status
  243/CREDENTIALS). A manual `edwin --daemon` has no `CREDENTIALS_DIRECTORY`: its backends are unusable.
- **The security boundary.** Every process of the user's uid that can open the socket can use what the
  credentials unlock, through `edwinclient -e` and the frame protocol (a request to a backend's origin, a brain
  read), and can read the files in `/run/user/UID/credentials/` directly anyway: same uid is the trust boundary on
  a desktop. What is guaranteed, and tested: no primitive a form or frame can reach returns a credential's bytes,
  from the copy in `$CREDENTIALS_DIRECTORY` or from the file it was loaded from, and none enters the journal of
  the unit (edwind's log), the image log, edwind's state or the store. The module adds every
  `daemon.credentials` file to the fragment's `refusePaths` (after the settings' own; a desktop with credentials
  and no settings gets a fragment of that refusal alone), since the file is readable by the user and a form could
  otherwise `load` it (found in review: `Unbound variable: sk-...`). A credential's path is in the store that way;
  its bytes are not. The authority (server/paths.mts) now resolves each refused path to its real path at every
  check rather than once at start: sops-nix re-points `/run/secrets` to a new `/run/secrets.d/N` at each
  activation and edwind's user unit is not restarted by a switch, so a real path taken at start would leave the
  new generation readable. This also reaches ex44's public edwind (more is refused, nothing less). A limit: with
  sops-nix's `keepGenerations` above its default 1, an older generation's file stays on disk under a real path
  no refusal names; the fleet keeps the default. Another, of the same shape: while an activation writes the new
  generation to `/run/secrets.d/N+1` and before it re-points `/run/secrets`, those files are under no refused
  real path, so a form run in that window and naming `/run/secrets.d/N+1/NAME` could read one. Both close on the
  fleet side by adding `/run/secrets.d` itself to `daemon.settings.refusePaths` on a host that keeps secrets
  there; Edwin names no host's layout.
- **A hole closed in edwind (server/main.mts, ex44's public edwind too).** `load`, `include`, `require` and the
  boot's init.scm read the disk through the host (host-node.cts `readFile`, `userConfig`) with no path check, so
  `(load "$CREDENTIALS_DIRECTORY/anthropic-api-key")` read the key as a symbol and answered `Unbound variable:
  sk-...` to any client, and an init.scm linked to a credential put it in the log. edwind now gives the core a
  host whose two readers go through the authority as a visit does (the real path, then `checkRead`): a refused
  file reads as absent (`Cannot open file`). d45b539 had refused visits only. edwind's other readers were
  checked too: the primitive registry (debug.mts) reads only the shipped tree, and the notes index (notes-parse.mts)
  skips a symlink that leads out of the notes directory. The browser host and the desktop
  program's are unchanged; they hold no credentials.
- **Choices.** `server/main.mts` FIELDS is unchanged: models, brain and hubSocket are already fields, and mail
  was declined (decision 5), so the fragment needs no new one. The merge is shallow apart from `refusePaths`: deep
  merging is the module system's, before the fragment is written. The credentials option has no origin: brain's
  tokens must not be under `models.credentials` (loadConfig refuses that), so origins stay in settings.
- **Not in it:** what a desktop declares (fleet packages); `proc-daemon-hub-option` and `proc-unit-path` add
  their options on top. No user manager is booted by the check: the unit is evaluated, and the daemon script runs
  as the unit runs it.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-daemon-models` (new, with `test/daemon-models.test.mts`):
  the evaluated unit has exactly the two `LoadCredential=` lines; settings from two modules merge into the
  fragment, which is in the store and equals them with the two credential files added to their `refusePaths`; a
  desktop with credentials and no settings has a fragment of the refusal alone; a store, colon or relative file, a
  bad name and `settings.socket` each fail with their assertion message; a desktop without them has neither
  line. Then the package's `edwin-daemon --fg`, with that fragment and a credentials directory as LoadCredential
  makes one, under a throwaway HOME and XDG_RUNTIME_DIR: the written edwind.json holds the fragment and the
  daemon's refusals plus the fragment's, edwind lists the backend as usable and reports the tiers; `load`,
  `include`, `require` (by file and through load-path), `find-file` of the file and of a notes symlink to it,
  `open` and `visit-id` by the protocol, `credential`, `gptel-backend-info`, `model-backends` and `status` give
  no key bytes (brain's token is no handle Scheme can name); `load`, `include`, `require`, `find-file`, `open`
  and `visit-id` of the source file (laid out as sops-nix lays out `/run/secrets`, refused as the module refuses
  it), by its symlink and its real path, give none either, and still none once the symlink is re-pointed to a
  new generation (against the daemon before the fix, `load` of the re-pointed file answers `Unbound variable:
  sk-test-...`); an init.scm that is a credential is not read, and no
  message sent, no line logged and no file under the state and runtime directories holds a key; fragments that set
  `socket` or `notesDir`, are no object or have a non-list `refusePaths`, and EDWIND_CONFIG with a fragment, are
  refused before edwind starts. With the main.mts change put back, the check fails: `(load ...)` answers
  `Unbound variable: sk-test-...`, and the key turns up in what edwind kept. On the first draft also
  passed: `edwin-module`, `edwind-module`, `edit-lockdown`, `edit-security`, `edwin-typecheck`, `edwin-daemon`,
  `nix build .#edwin`, and `nix flake check --keep-going` but for `edwin-bench` (shadow stack 12.5% against its
  10% limit under build load), which passed when run again alone. On the second draft (which changed
  server/paths.mts and nix/edwin-module.nix) `nix build .#edwin` and the whole `nix flake check --keep-going`
  passed, `edwin-bench` included. After the rebase onto lang-line-diff, `edwin-daemon-models`, `edit-lockdown`,
  `edit-security`, `edwin-typecheck`, `edwin-module` and `edwind-module` passed again.

## Ed.proc: child processes for the core's TypeScript (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `proc-frame-api`, on proc-host-spawn; owner decision 1: child
processes from the TypeScript core only, never from image-replayed Scheme, and a `--remote` frame's on its own
machine). `src/proc.ts` is the one way the core starts a program: compile, grep, shell commands, git, jj,
formatters and language servers will all call it, from TypeScript.

- **`Ed.proc.spawn(argv, {cwd, env, timeout, maxBytes, lossy, merge, onOut, onErr})`** starts a child and gives
  `{id, argv, write(text), closeStdin(), kill(signal = 'TERM'), exit}`: `onOut` and `onErr` get its output and
  error as they come (a function that throws is reported, the child goes on), `exit` is a promise of how it
  ended (`{code, signal, timedOut, truncated, error?}`, after all of its output). The options are the natives'
  (proc-host-spawn, above).
- **`Ed.proc.run(argv, {input, ...})`** gives the whole of it: `{out, err, code, signal, timedOut, truncated}`
  once the child has ended. `input` is written to its standard input, which is then closed; without it, closed at
  once, so a program that reads its input never waits for the user.
- **`Ed.proc.available()`** says whether a child can start here now; **`Ed.proc.envFor(dir)`** gives the
  environment changes for a child run in DIR, none yet: proc-direnv makes it ask direnv. Callers pass it as
  `env`.
- **Where.** The host gives the processes: `host.proc` (spawn, write, closeStdin, kill), which only the desktop
  program has (`native/js/host-native.ts` over the natives, in edwin and in edwinclient's frames). A web frame
  (`host.kind` browser) is refused by name; edwind's Node host has no `host.proc`, so edwind still never spawns
  (R4.45), and neither does anything else on Node but a suite that brings its own.
- **The image never reaches a process (R16.15).** sync.ts replays the image's forms inside `Ed.proc.replay`, and
  edwind's init.scm, which a served frame evaluates as it does the image, too. While it runs and until the loop's
  next turn every entry point (spawn, run, envFor) signals `process-error: No process starts while the image
  replays`. No Scheme primitive reaches Ed.proc (proc-frame-scheme is declined), so a replayed form could reach a
  process only by calling a TypeScript command that starts one: that command is refused whether it starts its
  child at once or after awaits that settle in the same turn.
- **Errors** are the Scheme condition `process-error` (new, under `error`), so Scheme around a command can catch
  it: every refusal, an argv that is not a non-empty list of strings with a program first, and what the natives
  throw (`cannot run PROGRAM: No such file or directory`, 64 already running).
- **`test/fake-proc.mts`** is `host.proc` for the suites: node:child_process with the natives' shape (argv only,
  a session per child, signals to its group, a missing program or directory refused at once, timeout, maxBytes,
  merge, lossy), recording every spawn's argv and options in `calls`. compile, grep and git's suites install it
  on their Node host as this one does.
- **Choices**, each reversible:
  - `run` keeps at most 16 MiB of output and error unless the caller says otherwise (`maxBytes`), so a runaway
    child cannot fill the frame's memory; past it the result says `truncated`.
  - The replay's window is closed by a timer, not at the end of the forms, so the microtasks the replay started
    run under it as well. Both loops order it so: Node's, and the desktop program's (native/src/main.rs), which
    checks for microtasks after every callback, before the timers' tick.
  - The window is the whole frame's, not the replayed forms' alone: a child the user starts in the same turn as
    an image edwind pushes is refused too, with the replay's message, and starts when asked again.
  - A replayed form's command that waits for something outside the turn (a key in the minibuffer, a timer, a
    reply) is no longer refused when it goes on; with a prompt, the user is the one who answers it.
- **Not in it:** no command uses Ed.proc yet (proc-compile and the rest do); no `list-processes` of the frame's
  children and no question on quitting with children running (proc-frame-scheme, declined; the program ends them,
  proc-host-spawn); no direnv (proc-direnv); no pseudo-terminal. **The limit of the refusal:** a procedure the
  image defines and that runs later, outside the replay (a key binding, a hook, a timer), is not told from the
  user's own. Once a command that starts a process exists (proc-compile on), such a procedure that calls it with
  arguments of its own starts that process. Closing it needs procedures to carry where they came from, which the
  evaluator does not; until then the image's forms are only those edwind's own clients wrote.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-proc`, 6 passed: run's output, error, status,
  timeout and options (`echo '$HOME; touch x' '`id`'` comes back as written); spawn's streamed output, input,
  kill and closed input; a missing program or directory and a bad argv as `process-error`; envFor; the refusals
  in a web frame and with no `host.proc`, with nothing spawned; and R16.15 through a real edwind: edwind's
  init.scm and three image forms sent by another client (`(on-frames (probe))`, the same after two awaits, and a
  `define` whose value calls it) all refused with nothing spawned, then the same procedures called by the user
  ran. The gate was checked by taking each defence out: without `Ed.proc.replay` in onImage the at-once probe
  ran; with the window closed at the end of the forms instead of by the timer the after-awaits probe ran.
  `edwin-typecheck`, `edwin-native` (boot.ts's FILES equal host-node.cts's), `edwin-headless`, `edit-frame`,
  `edit-lockdown`, `edit-security`, `edwin-display`, `edit-console` and `edit-image` passed. `nix build .#edwin`:
  unit tests 17 passed, `tests/gui.rs` 5 passed and 1 ignored, `tests/terminal.rs` 31 passed. And once in the
  built program, with a throwaway probe in `native/js/main.ts` (a copy, not committed) under a pty with a
  throwaway HOME and XDG_RUNTIME_DIR: `sh -c 'cat; echo "$X" >&2; exit 3'` with `hi` and `X=y` gave `out hi`,
  `err y`, code 3; a missing program gave `process-error: cannot run ...`; `cat` echoed `x`, then TERM ended it;
  `sleep 10` with `timeout: 100` gave `timedOut`; inside `Ed.proc.replay` a spawn was refused, and so was one
  after two awaits from a replay entered in a timer callback; after the turn `available()` was true again; no
  child was left once edwin exited.

## compile: a command's output in *compilation* (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-compile`). `src/compile.ts` with `Ed.compile.start`: a
command run in the project through Ed.proc (TypeScript only), its output streamed into `*compilation*`, with
recompile and kill. The `compile` desktop-only stub in scm/init.scm goes.

- **`src/compile.ts`** (new, through the seven places of the touch list, after `proc`). `Ed.compile.start(COMMAND,
  [DIR])` runs the shell line COMMAND as `sh -c COMMAND` (`sh` from PATH) in DIR, or in the project of the current
  buffer, and gives the run once its child has started: its command, directory, buffer, `exit` (a promise that
  settles after all of the output is in the buffer) and `kill` (INT unless told). `Ed.compile.recompile()` runs
  the command `*compilation*` shows (else the last one) again in its directory; `Ed.compile.running()` says
  whether one runs. A compilation still running when another starts is killed (KILL) and its late output and
  exit are dropped (each run is told from the one that replaced it).
- **The child.** Through `Ed.proc.spawn` only: argv `['sh', '-c', COMMAND]`, output and error merged so they keep
  their order, decoded lossily (a byte that is not UTF-8 shows as U+FFFD instead of killing the build), no byte
  bound (a long build is not killed for its output), standard input closed at once, `TERM=dumb`, and the changes
  `Ed.proc.envFor` gives for the directory (none yet; proc-direnv). The image never reaches it (R16.15): `start`
  asks `Ed.proc.envFor` before its first wait, which refuses while the image replays, and only after that wait
  kills the old child and spawns the new one, with nothing waiting in between; a refused start leaves a running
  compilation alone. In a web frame and on edwind's Node host there is no process, and `compile` and
  `recompile` say so before reading anything.
- **The directory.** The project: the nearest directory up from the buffer's with a `.git` or a `.jj`, else the
  buffer's own. The buffer's directory is its dired listing's or its file's parent (a relative name resolved by
  the host). A note edwind opens and a listing of edwind's are on edwind's machine, which may not be this one,
  so for those, and for a buffer with no file, it is the program's own directory (`host.files.cwd`). With no
  file system (a test host with no `host.files`) the child starts where the program runs.
- **`*compilation*`**, in `compilation-mode` (derived from `special-mode`, so `q` and the `SPC` leader keys work),
  read-only, in Motion state, shown in another window without selecting it. It starts with a header, `-*- mode:
  compilation; default-directory: "DIR/" -*-`, DIR quoted as a JSON string (a `"` or `\` escaped), `Compilation started at TIME`, a blank line and the command;
  then the output as it comes, taken in batches every 30 ms; then a blank line and the status line: `Compilation
  finished`, `Compilation exited abnormally with code N`, `Compilation interrupted` / `terminated` / `killed`
  (by the signal), each followed by `at TIME, duration S s`, also shown in the echo area. A child that cannot
  start leaves `Compilation failed to start at TIME: REASON` and signals `process-error`. Terminal escapes
  (colours, OSC titles) are dropped. A carriage return starts its line again, as on a terminal: of each line
  only the text after its last `\r` stays, also when the `\r` comes in a later batch than the line's start, so
  `10%\r50%\r100%\n` shows `100%`; `\r\n` is a newline, and a `\r` that ends the output is dropped. An escape
  or a `\r` cut by the end of a batch waits for the rest; a run of `\r` acts as one, and is read in linear time (no regex), so a binary file on stdout does not stall the frame. `b.compile` holds `{command, dir}` for recompile and the
  error parser to come.
- **Large output.** At most 20000 lines and 4 MiB of output are kept: past either the oldest go, below the
  header, and the first time they do the line `[Earlier output dropped: the last 20000 lines and 4 MiB are
  kept]` goes below the header (not a `file:line` shape, for the error parser to come). The cut is at the first
  line start past the bound when one is within 64 KiB of it, else mid-line (never inside a surrogate pair), so
  of a line longer than 4 MiB its last 4 MiB stay. Memory stays bounded under a flood (`yes`, `cat` of a big
  log): a batch is put in the buffer as soon as it reaches 4 MiB, not only every 30 ms, and after each cut, and each batch that starts the last line again, the
  buffer's edit log is dropped (`Ed.forgetLog`, new in src/editor-core.ts), since the log keeps every deleted
  and inserted text until it passes 512 entries, which under a flood was gigabytes (the editor ran out of heap
  on `timeout 6 yes`). What caches a version of the text (the lexer, the worker mirrors) finds the log no
  longer reaching back and starts again from the text, as after any cut at the top. The buffer keeps no undo
  history and is never marked modified.
- **Commands and keys.** `compile` (`SPC c c`, the desktop-only stub removed): reads `Compile command: ` with
  `compile-command` (default `make -k `, then the last command run) and its own history; with one running, asks
  `A compilation process is running; kill it? (y or n)` and stops on n. `recompile` (`g r` in `*compilation*`, as
  evil-collection binds it), asking the same. `kill-compilation` (`C-c C-k` in `*compilation*`): SIGINT to the
  child's process group. Killing the `*compilation*` buffer kills its child (KILL), so none is left behind.
- **Choices and differences from Emacs:** the shell is `sh`, not `$SHELL` or `shell-file-name`: the fleet's login
  shell is nushell, which reads `make && x` differently, and a compile command is a POSIX line. The directory is
  the project's (project-compile's), where Emacs's `compile` uses the buffer's `default-directory`. A compile
  started from code (not the command) with one running kills it without asking, as with
  `compilation-always-kill`. Killing the buffer does not ask. Colours are dropped, not shown
  (`ansi-color-compilation-filter`). The mode line shows no `:run`/`:exit` process state. Emacs keeps every line;
  here the oldest go past 20000 lines or 4 MiB. One `*compilation*` buffer, not one per project.
- **Not in it:** error parsing and next-error from the buffer (proc-compile-errors), grep (proc-grep),
  `compilation-scroll-output` (point at the end of the buffer follows the output; elsewhere it stays), colours,
  `compile` with a prefix argument (comint input), `project-compile` as a separate command.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-compile`, `test/compile.test.mts` (18): output
  streamed (the first line is in the buffer while the child still runs, the later one is not), the argv, cwd and
  options the host was given, the header, error merged in order and `Compilation finished`; `SPC c c` read the
  typed command, `exit 2` gives `Compilation exited abnormally with code 2` in the buffer and echo area and
  becomes `compile-command`, and `g r` in `*compilation*` runs the same argv in the same directory into a fresh
  buffer, `q` leaving it; the project found by `.git` and by `.jj` from a nested and a relative file name, and a
  directory with neither; `C-c C-k` gives `Compilation interrupted` with no child left; a compilation started
  over a running one kills it and the old output never shows; `seq 1 25000` keeps 5001..25000 below the header
  and the dropped-output line (once), with no undo kept; 6 MB with no newline kept within 4 MiB, the header and
  status line intact; a 5 MB line keeps its last 4 MiB (less at most 64 KiB) after the dropped-output line; 60 MB
  of `yes` output, with `*compilation*` selected and not, leaves the edit log never above 12 Mi characters
  (sampled through the run; the code before the fix held 142 and 262 million) and 20000 lines kept; colour and
  OSC escapes dropped, `\r\n` a newline, `10%\r50%\r100%\n` as `100%`, a `\r` in a later batch restarting the
  line shown, a `\r\n` split across batches, a final `\r` dropped, a 0xFF byte as U+FFFD, stdin closed; `kill-buffer`
  kills the child; a directory that is not there says `Compilation failed to start` and signals
  `process-error`; inside `Ed.proc.replay` start and recompile are refused, nothing spawned and the running
  compilation untouched, and the same for `(compile "...")` and `(recompile)` evaluated inside it; RET on an
  output line changes nothing; in a web frame and with no `host.proc` `SPC c c` refuses before the minibuffer and
  nothing spawns. The review fix (the flood, the long line, carriage returns; `Ed.forgetLog` in the core) was
  checked again on ex44 with `edwin-compile` (15), `edwin-typecheck`, `edwin-headless`, `edwin-scheme`,
  `edwin-proc`, `edwin-next-error`, `edwin-native`, `edit-security` and `edit-lockdown`; `nix build .#edwin` and
  `nix flake check` were not run again for it. The second review fix (a long run of `\r` took quadratic time in the two regexes, 30 s for 200000; a progress line that only replaces the last line never cut, so its edits stayed in the log while evil's floor pinned it; the header's directory unquoted) adds three tests (18): 400000 `\r` twice around a line in under 5 s with no stall over 1 s (the code before took 84 s), 100 `\r` progress updates with `*compilation*` selected leave at most 2 log entries (before: 33), and a directory `a b "c\d` in the header escaped; `\r\r\r\n` a newline. Re-run on ex44: `edwin-compile` (18), `edwin-typecheck`, `edwin-proc`, `edwin-headless`, `edwin-native`, `edwin-next-error`, `nix build .#edwin` (its GUI test failed once at Xvfb startup under load, then passed on rerun).
  Also passed: `edwin-typecheck`, `edwin-headless` (21; the page's script list), `edwin-proc` (6), `edwin-native`
  (31; boot.ts's file list), `edwin-scheme` (38), `edwin-next-error` (10), `edit-security` (21) and
  `edit-lockdown` (6), since scm/init.scm and scm/evil.scm also run on edwind and the core files load there;
  `nix build .#edwin` (unit 22, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 35), and `nix flake check`:
  every check passed but `edwin-bench`, which failed on the shadow stack (11.1% against its 10%) under the load of
  the full run and passed when built again alone (7.3%; this package does not touch the evaluator).

## Opening a file or URL in the desktop's application (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `bib-open-external`, on proc-host-spawn): one way to hand a
reference's file or URL to the desktop's own application, which Edwin had only as a web frame's new tab (`host.openUrl`, false everywhere else).

- **`Ed.openUrl(target, {confirmed})`** (src/proc.ts) gives null when TARGET is on its way, else why not, as a
  string the caller shows. TARGET is a URL or an absolute file name. It goes to the host's `openUrl(target,
  confirmed)`: the desktop program's is the native `openExternal` (native/src/open.rs), a web frame's opens a new
  tab for http, https and mailto only, and edwind's Node host opens nothing. Org's `org-open-at-point` on an https
  link now goes through it (in a terminal or window frame the link opens in the desktop's browser).
- **Never while the image replays (R16.15).** Under the same gate as `Ed.proc` (the replay and the rest of its
  turn): `Nothing opens while the image replays`. No Scheme primitive reaches it, so `edwinclient -e` cannot ask
  for it either (nor `__n.openExternal`: no Scheme primitive reaches the JavaScript globals). The limit is
  Ed.proc's: a procedure the image defines and that runs later, outside the replay (a key binding, a hook, a
  timer), is not told from the user's own. Today the one command that reaches Ed.openUrl is Org's https link, so
  the most it does is show a web page.
- **The opener** is `xdg-open` found on PATH, run with an argv of exactly `xdg-open TARGET`, never a shell. It
  outlives the call and the program, as the viewer it starts does, so it is not one of proc.rs's children (those
  are ended with the program): its own session (`setsid`, no controlling terminal), SIGPIPE back to its default,
  `close_range(3, ~0, CLOSE_RANGE_CLOEXEC)`, standard input, output and error on /dev/null (a terminal-only
  opener such as w3m fails rather than drawing over the terminal Edwin holds), and a thread that waits for it, so
  it is never a zombie and the loop never waits for it. A missing opener is said at once (`Cannot run xdg-open: No
  such file or directory`); what the opener itself does once started is not seen.
- **What it opens.** Refused at once, whatever the caller says: a target holding a control character, one that
  starts with `-` (it would read as an option), one that is neither a URL nor an absolute file name, a URL holding
  a space, a scheme other than http, https, mailto and file (`javascript:`, `data:`, `ftp:`, `smb:` ...), a mailto
  whose query names an attachment (`attach=`, `attachment=`, escaped or not: some mail programs attach the local
  file it names), a file: URL with a query, a fragment, another machine's host or a broken escape. A file (an
  absolute name, or a file: URL decoded) is opened by its real path, so a symlink named `x.pdf` that leads to a
  `.desktop` file is judged as that file, and the opener gets the path that was checked, which never starts with
  `-`. Never opened: what is not a regular file (a directory, a missing file), a `.desktop` file, a file with any
  execute bit, and a file that starts `#!` or is ELF whatever its name (the desktop's type detection can read the
  content). Opened only when the caller passes `confirmed: true` (the user said so): a file whose extension is not
  on the allow-list of documents (pdf, epub, djvu, ps, eps, odt, ods, odp, odg, doc, docx, xls, xlsx, ppt, pptx,
  rtf), plain text (txt, md, org, csv, tsv, tex, bib, log), images (png, jpg, jpeg, gif, webp, bmp, tif, tiff,
  avif, heic, heif), audio (mp3, ogg, oga, opus, flac, wav, m4a, aac) and video (mp4, m4v, mkv, webm, mov, avi,
  ogv), compared without case.
- **Choices**, each reversible:
  - The confirmation lifts only the type allow-list: `.desktop` files, executables and scripts are never opened
    (as mail-attachments-open has it: a type outside the allow-list can be saved, not opened).
  - HTML and SVG are off the allow-list (a browser runs their scripts); they open with a confirmation.
  - The checks are in the native program, beside the spawn, not in the TypeScript: the one place a file is
    stat'ed and handed on. A file changed between the check and the opener's start (same uid) is not caught.
  - http, https and mailto URLs are handed on as given; only the file: scheme is decoded and checked.
  - Directories are refused, not shown in a file manager: no caller needs one.
  - A web frame's tab is opened with `noopener`, so `window.open` gives null whether or not a popup blocker
    stopped it: it now says nothing went wrong, where it used to say `Could not open (popup blocked?)` every time.
- **Differences from Emacs** (`browse-url`, `browse-url-xdg-open`, citar's and mu4e's openers): no per-scheme
  handler table and no `browse-url-browser-function`; every URL goes to the desktop's default application, and
  Emacs never refused a type.
- **WSL** (an owner question, decision 19, with no default for it in the plan): Edwin finds `xdg-open` on PATH
  and names no other opener. On a WSL host the fleet can put an `xdg-open` on PATH that hands its argument to
  Windows (wslu's `wslview`), or xdg-utils' own `xdg-open`, which uses `wslview` when it finds one; the by-eye
  check on WSL is the owner's.
- **Not in it:** no caller but Org's https links: `SPC y o` and the `citar-open` stub are bib-open-reference's,
  mail parts (and their 0600 files in a private directory) were declined with mail (decision 5), act-at-point was
  declined (decision 18). No Scheme command (`browse-url`) and no confirmation prompt of its own: a caller that
  allows `confirmed` asks first.
- **Checked by**, on ex44: `nix build .#edwin`, whose cargo unit tests (22 passed) include open.rs's five, with a
  fake `xdg-open` (a script writing its argv to a file, handed by its absolute path rather than by changing PATH,
  which the proc tests running beside it read): `the_opener_gets_exactly_its_name_and_the_target` (argv exact for
  an https URL holding `$HOME;` and backquotes, and for a file by its real path through a symlink, a
  `file://localhost` URL with `%20` and a plain name with a space; the opener reaped, `/proc/PID` gone),
  `urls_outside_the_allow_list_and_options_are_refused` (`javascript:` in either case, `data:`, `ftp:`, `-x`,
  `--help`, spaces, newlines, relative names, mailto attachments, a file: URL with a query, a fragment, another
  host, a bad or NUL escape; the fake never runs),
  `programs_scripts_and_desktop_files_are_refused_even_when_confirmed` (a .desktop file, a .pdf with the exec bit,
  a `#!` script named .txt, a .sh, an ELF named .png, a .pdf symlink to the .desktop file, by name and by file:
  URL, confirmed or not; a directory; a missing file), `a_type_off_the_allow_list_opens_only_when_confirmed` (an
  `.HTML` page and an extensionless README refused, then the page allowed when confirmed; a `.PDF` allowed) and
  `an_opener_that_is_not_there_is_said`. Through the built program and its V8 binding,
  `tests/terminal.rs`'s `an_org_https_link_goes_to_xdg_open_on_path`: edwin on a pty with a throwaway HOME and a
  fake `xdg-open` first on PATH (that child's PATH only), whose init.scm makes an Org buffer with an https link
  holding `$HOME;` and backquotes and runs `org-open-at-point`: the fake gets exactly its own name and the URL
  (`tests/terminal.rs` 35 passed, `tests/gui.rs` 5 passed and 1 ignored).
  `nix build .#checks.x86_64-linux.edwin-open` (new, test/open.test.mts, 4 passed): the target and the
  confirmation reach the host as given (only `true` confirms) and its answer comes back; edwind's init.scm and an
  image form sent by another client get `Nothing opens while the image replays` and reach no host, then the same
  procedure typed by the user opens; edwind's Node host opens nothing; an Org https link reaches the host and its
  answer is shown. With the replay line taken out of `Ed.openUrl` the replay test fails. Also `edwin-typecheck`,
  `edwin-proc` (6 passed), `edwin-headless`, `edwin-native`, `edit-lockdown` and `edit-security`, and `nix flake
  check --keep-going` (all 37 checks passed; a first run under load had failed in the package build at gui.rs
  `the_close_button_asks_about_changes` with `Xvfb did not start`, and passed rerun at a quiet time, then again
  on 2026-11-16 on emacs-to-edwin 3a0ea7b).

## The commit message buffer (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-message-modes`, on lang-evil-minor-maps): the buffer a
commit message is written in, as magit's git-commit-mode gives it: the summary line's length shown, comment lines,
C-c C-c to finish and C-c C-k to abort. It starts `src/vc.ts`, where git and jj will run (git-runner on).

- **`Vc.message({name, text, comment})`** (src/vc.ts, the global `Vc`, which git-runner extends with `Vc.start`)
  opens a buffer named NAME holding TEXT, point at its start, in the selected window, in `vc-message-mode`, and
  gives a promise: the message once the user finishes, null when they abort or kill the buffer. COMMENT is the
  prefix of a comment line: `#` by default (git's), `JJ:` for jj. The opener runs whatever takes the message (git
  commit, jj describe) from TypeScript; Scheme can finish or abort a message, never open one or say what is done
  with it.
- **`vc-message-mode`** (scm/emacs.scm, so no new .scm), derived from text-mode, shown as `Message`, with
  `vc-message-mode-hook`. Its lexer (`H.lexSeg`) shows the summary line in `vc-message-summary`, the characters
  past `vc-message-summary-max-length` (68) and a second line that is not blank in `vc-message-warning`, and the
  comment lines in `cm`, the comment face every mode uses. The two new faces are in display.ts FACES and in
  vc.ts's sheet `vc-css`, which test/display.test.mts now checks against each other.
- **C-c C-c** (`vc-message-finish`) gives the message without its comment lines, cleaned as `git stripspace
  --strip-comments` cleans it (`Vc.cleanMessage`: trailing white space, git's space, tab and CR only, so a no-break
  space, \v and \f stay; runs of blank lines go, leading and trailing ones too; one final newline), and kills the buffer, so the window shows what it showed before.
  **C-c C-k** (`vc-message-abort`) gives null and kills it; killing it any other way (kill-buffer-hook) gives null
  too. Both keys are vc-message-mode-map's, so they work in Normal and in Insert state.
- **Choices**, each reversible:
  - The summary is the first line that is neither blank nor a comment (magit's `git-commit-summary-regexp`), so a
    template that starts with comment lines still has its summary found; the second line is the one after it.
  - The limit is magit's default, 68, in a variable the user can set; a segment drawn from inside the summary line
    counts its columns from the line's start.
  - An empty message (nothing left once cleaned) is refused with `The message is empty: write one, or abort with
    C-c C-k`, and the buffer stays: git would abort the commit, here the user chooses.
  - NAME must not name a live buffer: a second message under the same name, or one over a buffer of the user's, is
    refused and changes nothing. The commands git-commit and jj describe will name their buffers per repository.
  - The buffer opens in Normal state, as any text buffer; evil-collection starts an empty message in Insert
    state, which is left for git-commit to decide.
  - `vc-message-mode` turned on by hand has no commit waiting: C-c C-c and C-c C-k say so and change nothing.
  - A signal from the mode's hooks (a broken `vc-message-mode-hook` in init.scm) kills the new buffer before
    `Vc.message` rethrows it, so no buffer with no message waiting is left to refuse the name.
- **Not in it:** no ZZ and ZQ (with-editor's Evil keys); no scissors line (`commit -v`'s diff below `>8`); no
  trailers (Signed-off-by), message history (M-p, M-n) or fill settings; no comment-syntax entry, so gc does not
  write the opener's prefix. Nothing calls `Vc.message` yet: git-commit and jj describe will. No desktop-only stub
  goes (git-status-view removes vile-vcs-status and vile-magit-status). This package created `test/vc.test.mts`
  and the check `edwin-vc`; git-runner adds its cases there.
- **The limit of the replay refusal.** `vc-message-finish` and `vc-message-abort` are ordinary commands, so a form
  in edwind's image that a frame replays can finish or abort a message being written. What the opener does with
  the message then runs in the same turn, where `Ed.proc` refuses (R16.15), so the commit itself cannot start from
  a replayed form; this relies on that gate and has the limit the Ed.proc section records. The mode, its commands
  and the faces also load in edwind (host-node.cts), where nothing calls `Vc.message` and no process exists.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (new, test/vc.test.mts, 7 passed):
  stripspace's cleaning with `#` and `JJ:`; each face, on the whole buffer and on a segment from inside the
  summary, with the limit at 68 and at 72; a blank or comment second line and jj's prefix; C-c C-c from Insert and
  from Normal state giving the cleaned message, the buffer gone and the window back; C-c C-k and kill-buffer giving
  null; an empty message refused with the buffer kept and nothing given; a name in use (a pending message's, a
  user buffer's) refused with nothing changed; the mode turned on by hand refusing both keys; a signalling
  vc-message-mode-hook leaving no buffer behind; no-break space, \v and \f kept as git stripspace keeps them.
  `edwin-display` (20,
  FACES against `vc-css`), `edwin-typecheck`, `edwin-native` (31, boot.ts's FILES equal host-node.cts's) and
  `edwin-headless` (21) passed. `nix build .#edwin`: unit tests 22 passed, `tests/gui.rs` 5 passed and 1 ignored,
  `tests/terminal.rs` 35 passed. The lexer on a 10,000-line message (a `commit -v`-sized buffer), a keystroke
  then a 4,000-character segment: p50 0.06 ms, at most 1.9 ms over 50 keystrokes, inside the 2 ms budget.
  `nix flake check --keep-going`: all checks passed (`edit-lockdown` 6, `edit-security` 21, `edit-frame` 24,
  `edit-console` 4 and `edit-image` 15 among them: vc.ts and the mode load in edwind too, ex44's public one
  included, and add no server capability).

## Backends declared in init.scm reach edwind's models (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `ai-init-backends`): make sure a backend declared in the owner's
init.scm is what edwind's models and agent use, filling what is missing between scm/models.scm, scm/gptel.scm and
server/models.mts, with a backend naming a credential by its LoadCredential name.

- **What was missing.** edwind evaluated init.scm inside `Ed.boot`, before its modules were installed, so
  `gptel-make-openai`, `gptel-make-anthropic` and `credential` were unbound there: a backend in init.scm failed with
  `Unbound variable: credential`, the rest of the file was skipped, and the error went to edwind's `*Messages*`
  only. No backend declared in init.scm had ever reached the models.
- **The fix (server/main.mts, ex44's public edwind too).** edwind boots with `deferUserInit` and runs
  `Ed.loadUserInit()` after the modules are installed and before the image log is replayed: shipped Scheme, the
  modules' Scheme, init.scm, then the image log, whose entries were made after init.scm had run. The file is still
  read through the authority (`host.userConfig`), and safe mode still skips it (`host.userConfig` answers nothing).
  An error is reported in `*Messages*` as before and now in the log too (`start` `init_error`, the error's text,
  which is what the evaluator reports, never a credential's bytes: a handle prints as `#<credential NAME>`), and
  edwind starts all the same. Each form is evaluated with a fresh op budget, as at boot.
- **Credentials.** `(credential NAME)` is unchanged: NAME must be one edit.json binds to an origin
  (`models.credentials.NAME.origin`, or a backend's `credential`). No form binds a key to an origin, so a form
  run by any client sends a key nowhere the configuration did not name (R14.4); an init.scm naming an unbound
  credential is an error reported as above. On a desktop the fleet gives the file as
  `programs.edwin.daemon.credentials.NAME` and the origin as `daemon.settings.models.credentials.NAME.origin`
  (ai-daemon-models), then init.scm names it: `:key (credential "NAME")`.
- **The guard.** Served frames and the desktop program read the same init.scm without the models module (frames
  through `user-init`, before their server stubs exist, with one handler around the whole file), so an unguarded
  `(credential ...)` would end the rest of the owner's init.scm in every frame. Backend forms go under
  `(when (featurep 'models) ...)`: models.scm provides `models` in edwind only. Its header shows the idiom;
  ai-fleet-backends is to use it.
- **What else the new order changes.** The modules' own Scheme (threads.scm, debug.scm, process.scm,
  notes-syntax.scm, models.scm, pi-tools.scm) used to be evaluated after init.scm and overwrote what init.scm set
  with `define` (for example `notes-index-ignore`); now init.scm's settings win. The notes index's first scan
  starts during the notes module's install, so it still uses the shipped ignore list; later scans use
  init.scm's. The buffers restored from their journals, now before init.scm, run no Scheme (their mode is set by
  name, no hook runs), so nothing of init.scm is missed there. On ex44's public edwind init.scm can now call the
  modules' primitives at boot; the image log replayed at the same point already could, and configDir (where
  init.scm lives, writable by edwind) is unchanged, so no client gains a capability it did not have.
- **Not in it:** presets (there are none in edwind yet: `gptel-make-preset` is the frame's src/ai.ts, and
  ai-presets-menus comes later) and mail settings (mail in Edwin was declined, decision 5). gptel.scm and
  server/agent.mts needed no change: gptel's commands and new pi sessions already take the current
  `gptel-backend`. No new file, so no new check: the tests are in the suites `edit-security` and `edit-frame`
  already run.
- **Checked by** `nix build .#checks.x86_64-linux.edit-security`, whose test/models.test.mts now starts an edwind
  per case with an init.scm and a credentials directory: a guarded `gptel-make-openai` on the loopback fake
  endpoint with `:key (credential "local-key")` (bound in edit.json) is listed by `model-backends` and
  `gptel-backends`, usable and current; `gptel-request` reaches `/v1/chat/completions` with `Bearer <key>`; a new
  pi session starts on it; the usage line names it. An init.scm naming an unbound credential, and one that does
  not read, are reported in `*Messages*` and the log, the forms before the error hold, and edwind serves. With
  `EDWIND_SAFE=1` the file is not read. The key is in no message, log line or file edwind kept. With the
  main.mts change put back, the first two of these fail (`Unbound variable: credential`). test/frame.test.mts
  (`edit-frame`) boots a served frame on an edwind whose init.scm has a guarded form: in the frame
  `(featurep 'models)` is false, the guarded form is skipped and the rest runs with no error; in edwind all three
  hold.
  Also passed: `edit-lockdown`, `nix build .#edwin`, and `nix flake check --keep-going` but for `edwin-bench`
  (shadow stack 15.0% against its 10% limit) and `edit-crash` (R16.5's random SIGKILL run: "the history lost
  acked batches"), both under the load of the parallel build; each passed when run again alone (7.8%; 7 of 7).

## next-error: one error list, M-g n and :cn (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `proc-next-error`). A shared error list with M-g n / M-g p
and :cn, :cp, :cc, for the producers that come later (compilation errors, grep, LSP diagnostics).

- **`scm/next-error.scm`** (new; sources.rs SCM, console/manifest.json, both pages' SCM lists, CONFIG as a lazy
  file after `prog.scm` and before `init.scm`, so init.scm can rebind its keys). The frame holds one list;
  `(next-error-set-list! ENTRIES)` replaces it, each entry `(FILE LINE [COLUMN [MESSAGE]])` with LINE and COLUMN
  from 1 and COLUMN in characters, and gives the count. The whole list is checked before it is recorded (a FILE
  that is not a non-empty string, a LINE or COLUMN that is not a positive integer, a MESSAGE that is not a
  string, a wrong length), so a refused list leaves the old one. A new list starts again at its first entry. The
  producers are TypeScript and call it through `L.call`; they expand their relative file names first, since FILE
  is opened as `find-file` opens it.
- **Commands.** `next-error` (`M-g n`, `M-g M-n`) and `previous-error` (`M-g p`, `M-g M-p`) take a prefix count;
  `first-error` goes to the first, or the Nth with a prefix. Ex: `:cn[ext] [N]`, `:cp[revious] [N]` and `:cN[ext]
  [N]`, `:cc [N]` (`:cc` alone visits the current error again, or the first). Each step visits the error's file,
  puts point on its line and column, shows `(I of N) MESSAGE` (`FILE:LINE` when there is none) and records where
  point was in the jump list (`C-o` comes back within that buffer; the jump list is per buffer). A step by key
  pulses the line; an ex step does not, since the command the pulse hook sees is `evil-ex`. Past either end, with no list, with a count past the list or a count that is
  not a positive integer, it refuses and point stays. A file that no longer exists is refused by name, `(I of N)
  FILE: no such file`, with no buffer made and no jump recorded; that error still becomes the current one, so the
  next step goes past it. Whether it exists is asked by `location-missing?` (src/editor-prims.ts) where the frame
  opens the file itself: the desktop program asks its file system (`host.files.exists`, the file not read), a page
  with no edwind its browser store. A file edwind opens is not asked here, since it is on edwind's machine: in a
  served page every location, in the desktop program attached to edwind (local or remote) one under the notes
  directory (`hooks.servedPath`, as its visit hook decides). `:h` lists the ex commands.
- **`visit-location FILENAME LINE [COLUMN]`** (src/editor-prims.ts): visits and puts point on the line and column,
  each clamped (a line past the end goes to the last line, the empty line after a final newline being none; a
  column past the end of its line to its end, which Normal state shows on the last character; a bignum line or
  column is clamped the same way). COLUMN counts characters: a character outside the Basic Multilingual Plane (a
  surrogate pair) is one. In a served frame a note is opened by edwind and the visit answers with a promise, which
  frame Scheme cannot wait on: the primitive places point when the buffer arrives and returns the promise, which
  the command loop waits on; a visit edwind refuses shows edwind's reason and leaves point.
- **Choices and differences from Emacs and Vim:** an error is found by its line number when it is visited, not
  followed by a marker from when the list was made, so lines added above it since move it. Counts on the ex
  commands are an argument (`:cn 3`, `:cc 3`): Vim's leading count (`:3cn`) is parsed as a line range of the
  current buffer, as for every ex command here, and is not supported. Emacs asks for the directory of a file it
  cannot find; here it is refused. Steps do not wrap. The list is the frame's own, not shared with edwind or other
  frames. A note that is gone is not refused: the served visit opens a note as `find-file` does, creating it, so
  it opens as an empty edwind buffer (the file is written only when it is saved). The jump is recorded before a visit
  that waits for edwind, so one edwind refuses still leaves a jump at the unmoved point.
- **Not in it:** the producers (proc-compile-errors, proc-grep, lsp-diagnostics), a list buffer (`:clist`,
  `:copen`), `:cfirst`, `:clast`, `C-x \``, `next-error-follow-mode`, and RET on a row of a producer's buffer.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-next-error`, `test/next-error.test.mts` (10): a
  list seeded across three files, two of them not open, stepped through by `M-g n`, `M-g M-n`, `:cn`, `:cnext 3`,
  `:cp`, `:cp 2`, `:cN`, `M-g p`, `M-g M-p`, `C-u 2 M-g p`, `:cc 1`, `:cc4`, `:cc` and `first-error`, asserting the
  file, line, column and message each time, and that a visited file opens in its mode; the refusals at both ends,
  with an empty list, `:cc 5` of 4, `:cn x` and `:cn 0`, point not moving; a new list starting again; clamping of
  line and column; an edited open buffer counted afresh; a file that is gone; every malformed entry refused with
  the old list kept; `C-o` back after an `M-g n` and after a `:cn` (the `:cn` case fails on the first version,
  which marked the commands `evil-jump`: an ex command runs inside `evil-ex`, so nothing was recorded). Added
  after review, each failing on the version before it: a refused step leaves the jump list as it was; column 3 of
  `😀😀xy` is `x` and column 2 the second emoji, and a bignum line and column are clamped; a served page's note,
  absent from the store, goes to a visit hook that answers 20 ms later and gets point, and one the hook refuses
  leaves point with the hook's message (the version before refused both as `no such file` without calling the
  hook); in the desktop program attached to edwind, with `host.files` and `hooks.servedPath` set as
  native/js/main.ts sets them, a gone note goes to edwind unasked, a gone local file is refused with no file read
  and no buffer made, and a present one is visited.
  Also passed after the review fixes: `edwin-headless` (21; the page's SCM list), `edwin-prog` (17),
  `edwin-scheme` (38), `edwin-typecheck`, `edit-security` (21) and `edit-lockdown` (6), since CONFIG also runs on
  edwind; `nix build .#edwin` (unit 17, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 34; the first try
  failed with Xvfb not starting under load, the retry passed) and `nix flake check` (all checks passed; a run
  before that failed `edit-agent` on a 10 s timeout under load, which passed alone and in the full run after).

## prog-mode and define-language (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `lang-prog-mode`). A base programming mode, and one form that
declares a language: the files that open in it, its comment syntax, its indent width and its hooks. Before, every
file but Scheme, Org and Markdown opened in fundamental-mode.

- **`scm/prog.scm`** (new; sources.rs SCM, console/manifest.json, both pages' SCM lists, and CONFIG as a lazy file
  after `markdown.scm` and before `init.scm`, so the user's init.scm can declare a language again). `prog-mode` is a
  `define-derived-mode` with no parent; `prog-mode-hook` runs in every language's buffers.
- **`(define-language MODE NAME :files REGEXPS [:comment (LINE [BLOCK-START BLOCK-END])] [:indent N] BODY...)`**
  makes MODE, shown as NAME, a mode derived from prog-mode (so it has MODE-map and MODE-hook), puts `(REGEXP . MODE)`
  on `auto-mode-alist` after the entries already there (Markdown and Org stay first), declares the comment syntax
  through `set-comment-syntax!`, and sets `tab-width` (TAB's stops) and `evil-shift-width` (`>` and `<`) to N
  buffer-locally whenever the mode is turned on; BODY runs then too, after prog-mode's. Option values are
  evaluated. Declaring MODE again replaces its patterns, comment syntax, indent and body. It refuses: a MODE that
  is not a symbol, a NAME that is not a non-empty string, no or an empty `:files`, a pattern that is not a
  non-empty string or does not compile as a JavaScript regexp (with no flags, as `auto-mode-alist`'s lookup
  compiles it), an `:indent` that is not a positive integer, a `:comment` that is not a list (and what
  `set-comment-syntax!` refuses), an unknown keyword or one without a value. All of it is checked before anything
  is recorded, so a refused declaration leaves no entry in `languages`, `comment-syntaxes` or `auto-mode-alist`
  and makes no mode.
- **A visit turns the mode on.** `visit` (and the served frame's visit, `src/sync.ts`) set a buffer's mode from
  its name without running the mode; now a mode derived from prog-mode is turned on (`Ed.turnOnVisitedMode`, by
  `switchMajorMode`) before `find-file-hook`, as Emacs's set-auto-mode does, so the indent and hooks apply to a
  file opened by name. `write-file` to a language's name does the same. Other modes (Org, Markdown, Fundamental)
  are set as before, without running their hooks: changing that is not this package's.
- **The languages (decision 8: the plan's default, from init-prog.el and the languages later packages name):**
  Rust 4, Nix 2, Go 4, C (`.c`, `.h`) 4, C++ 4, Java 2 (the Google style init-prog.el formats with), C# 4, Python 4,
  JavaScript 2, TypeScript 2, TSX 2, JSON 2 (`.json`, `.jsonc`, `flake.lock`), YAML 2, TOML 2, Shell 2 (`.sh`,
  `.bash`, `.envrc`), Terraform 2 (`.tf`, `.tfvars`, `.tofu`), GDScript 4, Just 4 (`justfile` in any case,
  `.justfile`, `.just`), Meson 4, NASM 4 (`;`), Nginx 4 (`nginx.conf`, `.conf` under a `nginx/` directory), Typst 2.
  Comments: `//` with `/* */` for the C family, JavaScript, TypeScript and Typst; `#` for the rest, with `/* */` in
  Nix and Terraform; `;` in NASM. Patterns are JavaScript regexps anchored at the end, and at a `/` or the start for
  whole names, because a frame tries the name as given and edwind the base name.
- **Differences from Emacs:** JSON has no comments in Emacs's json-ts-mode; here it takes `//`, the JSONC comment
  (tsconfig.json), as js-json-mode does. C takes `//` rather than c-mode's `/* */`. Go and GDScript indent with
  spaces (gofmt and Godot use tabs; the formatter packages turn them back); there is no `indent-tabs-mode` per
  language, since `>` only ever inserts spaces. The Emacs ts-mode names (rust-ts-mode) are not used: one name per
  language. Matching a file name is case-sensitive: `X.RS`, `x.JSON` and `Main.C` open in fundamental-mode, where
  Emacs retries case-insensitively (`auto-mode-case-fold`) and opens `.C` in c++-mode. A pattern that wants both
  cases says so, as Just's does.
- **edwind loads it too** (CONFIG runs on the server), so a file edwind opens gets its language's mode, and every
  mode is a command in the primitive registry. `edit-security`'s R16.15 test refuses registry names that look like
  a JavaScript escape hatch, among them any starting with `js`; it now exempts exactly `js-mode` and `json-mode`
  (Emacs's names, mode switches only) and asserts each is exactly the mode command define-language makes (a
  command with rust-mode's arguments and source, the mode-switch documentation, a declared language derived from
  prog-mode), and still refuses every other such name.
- **Not in it:** highlighting, indentation rules, imenu (the tree-sitter packages of phase 4), formatting, LSP.
  Scheme, Emacs Lisp, Clojure and Common Lisp stay as they are (`.el` still opens in scheme-mode, `.clj` in
  fundamental-mode; scheme-mode does not derive from prog-mode): lang-lisp-modes does them. No nushell mode (not in
  init-prog.el). No `.editorconfig` (lang-editorconfig) and no `interpreter-mode-alist` (`#!` lines).
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-prog`, `test/prog.test.mts` (17, 7 new): every
  declared language has a sample file name and each opens in its mode by `:e`, and from paths, with names that must
  not be taken (`site.conf`, `x.json.bak`, `init.el`, `.md`, `.org`); a visit makes the indent buffer-local (`>>`
  shifts 4 in Rust, 2 in Nix, 2 in a text buffer), runs prog-mode-hook and the mode's hook once, and not again on a
  second visit; gcc writes `//`, `#` and `;`; BODY sees the indent; a second declaration replaces the first (one with no `:comment` falls back to `#`);
  write-file to `.go`; the refusals, among them a MODE that is not a symbol, a NAME that is not a string and a
  pattern that does not compile, each leaving nothing recorded (these fail on the first version, which recorded a
  string MODE's patterns before define-derived-mode refused it); `X.RS`, `x.JSON` and `Main.C` stay in
  fundamental-mode. After the review fixes, re-run on ex44: `edwin-prog` (17), `edit-security`, `edwin-headless`,
  `edwin-scheme`, `edwin-markdown`, `edwin-typecheck`, `edit-lockdown` and `edit-frame`, all exit 0; `nix build
  .#edwin` and `nix flake check` were not re-run after them. The visit test, BODY, redeclaration and write-file cases fail with
  `turnOnVisitedMode` disabled. The served frame's visit (`src/sync.ts`) has no test of its own: `edit-frame`
  passing shows only that it still opens files. Also passed: `edwin-headless` (21), `edwin-markdown` (20), `edwin-scheme` (38),
  `edwin-typecheck`, `edit-lockdown` (6), `edit-security` (21), `nix build .#edwin` (unit 17, `tests/gui.rs` 5 and 1
  ignored, `tests/terminal.rs` 32) and `nix flake check` (exit 0).

## Comment syntax per mode (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `lang-comment-syntax`). Modes declare their line and block
comment strings, and the comment commands use them: before, `gc` chose `;; ` or `# ` by a `case` on the mode
and `M-;` (`comment-line`) always wrote `;; `, so a Markdown line became a heading and `.nix` got `;;`.

- **`(set-comment-syntax! MODE LINE [BLOCK-START BLOCK-END])`** in `scm/emacs.scm` declares MODE's comments:
  LINE starts a line comment (`";;"`, `"#"`), the two block strings open and close a block comment, and LINE
  is `#f` for a mode with block comments only; it refuses a declaration with neither, and an empty or non-string
  delimiter. `(comment-syntax)` gives the current buffer's `(LINE BLOCK-START BLOCK-END)`: its major mode's
  entry, else the nearest entry of the modes it derives from, else fundamental-mode's. A later declaration for a mode replaces the earlier one.
- **`derived-mode-all-parents`** (`src/editor-prims.ts`, Emacs 30's name) gives a mode and its ancestors,
  nearest first, so the lookup goes by mode order: `derived-mode-p` answers in the order of its arguments.
- **The commands:** `gc`/`gcc` (`scm/evil.scm`) and `M-;` (`comment-line`, `scm/emacs.scm`) take
  `(comment-delimiters)`: the line comment, or a block comment's two strings in a mode with no line comment, and
  put them, with one space of padding, around each line from its indentation (`<!-- one -->`). Uncommenting
  removes both ends. Each command keeps its own uncomment rule: `gc` treats a range as commented when every
  non-blank line starts with the opener (and ends with the closer) and then strips the opener exactly;
  `M-;` treats a line as commented when it starts with the opener and ends with the closer, as `gc` does (so
  `<!-- a` is wrapped again, not stripped), and strips any run of an opener made of one repeated character
  (`;;; Header` and `; x` both uncomment).
- **Declared:** scheme-mode and scheme-interaction-mode `;;`; org-mode and fundamental-mode `#`; markdown-mode
  `<!--` `-->` (in `scm/markdown.scm`, beside the mode). text-mode, and every mode with no entry and no
  ancestor's, take fundamental-mode's `#`, as `gc` did before; Emacs instead refuses where a mode has no
  comment syntax. .nix, .js and the other languages open in fundamental-mode until lang-prog-mode declares
  their own through this table.
- **Not in it (left for se-comment, B6 of docs/emacs-to-edwin/structural-editing-audit.md):** `gc` and `M-;`
  still differ on runs (`gc` on `;;; Header` gives `; Header`); in Org, `gc` and `M-;` on `#+TITLE` strip the `#`, as `gc` did before
  (Emacs's `comment-start-skip` would not); nothing looks at strings or the lexer, and no `comment-dwim`,
  `comment-region` or end-of-line comments. No buffer-local override of a mode's syntax.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-prog`, the new `test/prog.test.mts` (10): the
  lookup through `derived-mode-all-parents` (a derived mode's own entry beats a newer entry of its parent, one with
  none takes its parent's), the refusals (no comment, an empty or non-string delimiter, a block with one string),
  and `gcc`, Visual `gc`, `gcip` and `M-;` driven by keys in Scheme, .nix, Org, Markdown and a block-only mode,
  with `M-;` still stripping `;;; Header` and `; x` and wrapping an unclosed `<!-- a` again. Also passed:
  `edwin-markdown` (20), `edwin-headless` (21), `edwin-scheme` (38), `edwin-typecheck`, `edit-lockdown` (6),
  `edit-security` (21), `nix build .#edwin` (unit 17, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 31) and
  `nix flake check` (exit 0).

## Evil keys per minor mode (done)

Asked 2026-11-15 (the Emacs-to-Edwin plan, package `lang-evil-minor-maps`; it takes in git-evil-minor-keys). lispy's
keys and git's conflict and time-machine modes need Evil keys that hold only while a minor mode is on, as
`evil-define-key` on a minor mode's keymap gives them in Emacs.

- **`evil-define-key`** takes a minor mode as its KEYMAP, by the mode's name (`'zap-mode`), its keymap's name
  (`'zap-mode-map`) or the keymap itself (`zap-mode-map`), as it took a major mode. The keys go to that mode's
  map for each state named, operator state included.
- **Lookup order** (`src/evil-core.ts`, `mapsFor`): for each state the current state searches (Normal: normal then
  motion; Visual: visual, normal, motion; operator-pending: operator then motion; and so on, unchanged), the maps
  of the minor modes on in the buffer come first, then the major mode's and its parents', then the state's global
  map. A minor mode that is off, or on in another buffer only, adds nothing. Operator-pending reads its motion
  through the same order, so a minor mode's operator and motion keys apply after `d`, `c` or `y`.
- **Choices:** among several minor modes that are on, the one defined first wins (Emacs: the one first in
  `minor-mode-map-alist`). As before, a state's global map still comes before the next state's per-mode maps
  (a global Normal key beats a minor mode's Motion key), which is Evil's order too. A keymap passed by value is
  found by its name, so a mode whose `:keymap` is a keymap made under another name gets the keys under that
  name, not the mode's. No `evil-define-minor-mode-key`: `evil-define-key` on the mode does the same.
- **Not in it:** no `evil-make-overriding-map` or intercept maps; no minor mode uses this yet (lang-lispy-operators,
  the git conflict and time-machine modes do). Every `evil-define-key` already shipped names a major mode, so no
  existing key changes precedence. `scm/evil.scm` and `src/stack.ts` needed no change: `evil-snipe-override-mode`
  is global and rebinds the global Motion map, and j and k under visual-line-mode test the mode in the motion
  itself; neither is a per-buffer key.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-scheme` with two new tests in
  `test/scheme-editor.test.mts`: a minor mode's Normal key (bound by name, by keymap name and by keymap value)
  wins over the major mode's and the global one while the mode is on, and the major mode's or the global one
  comes back when it is off or in another buffer; a minor mode's operator-state key gives `dQ` its motion while
  the mode is on, and the global operator key's motion when it is off. Both fail with the old lookup. The
  suite (38) passed, and so did `edwin-headless` (21), `edwin-typecheck`, `edwin-display` (18), `edit-frame` (23)
  and `nix build .#edwin` (unit 17, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 31). `nix flake check`:
  all checks passed (`edwin-dired` 22, `edwin-front` 9, `edwin-brain` 34, `edwin-lockdown` 6, `edwin-security` 18 among them).

## The desktop daemon can be given a hub (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-daemon-hub-option`; owner decision 3: no desktop hub for
now, the option is still built, off unless set, and no host sets it): let a desktop say which Workbench hub its
edwind uses for processes, as `services.edwind.hubSocket` does for ex44's.

- **`programs.edwin.daemon.hub`** (nix/edwin-module.nix), a socket path or null (the default). Set, the module
  adds `hubSocket` to `daemon.settings`, so it reaches the edwind.json `edwin-daemon` writes through the same
  fragment (`EDWIND_CONFIG_EXTRA`) as models and brain, merged with whatever else settings hold. Unset, nothing is
  added: a desktop without it renders the unit exactly as before, and edwind's hub stays `unconfigured`.
- **Choices.** The path is an absolute one or one under `~/`, the forms edwind's `loadConfig` takes (it expands
  `~/` from the unit's `$HOME`); anything else fails at evaluation with the module's assertion rather than at the
  unit's start. The 108-byte socket limit stays `loadConfig`'s: the module cannot measure a `~/` path before it
  is expanded. No `%t` or `$XDG_RUNTIME_DIR` expansion: the fragment is a JSON file in the store, which systemd
  does not expand, and making `edwin-daemon` expand it would be built for a hub nobody runs (proc-desktop-hub is
  declined); a fleet that ever runs one names its socket in full. Setting `daemon.settings.hubSocket` as well,
  to another path, is the module system's conflicting-definitions error, so the two never disagree silently. No
  `After=` on a hub unit: Edwin names no hub unit, and edwind's hub client retries until the socket answers.
- **Security.** The hub runs what edwind asks of it, and edwind's socket is the user's; the description says to
  name only a socket no other user can open. Nothing changes in edwind or in ex44's public edwind (no server file
  was touched).
- **Not in it:** the hub service on desktops (proc-desktop-hub, declined), any host setting the option, and the
  PATH the unit and hub see (proc-unit-path).
- **Checked by** `nix build .#checks.x86_64-linux.edwin-daemon-models`, extended: a desktop with `daemon.hub =
  "/run/hub/hub.sock"` has a fragment of exactly `{"hubSocket": "/run/hub/hub.sock"}`, one with `"~/hub.sock"`
  keeps it as written, one with a hub and a credential has both `hubSocket` and the credential's refusal; the
  desktop with settings and no hub still has a fragment equal to its settings (no `hubSocket`) and a desktop with
  neither has no `EDWIND_CONFIG_EXTRA`; `"run/hub.sock"` fails with the hub assertion and `"~/hub.sock"` with
  none. The daemon-models suite passed again (5 of 5). With the line that adds `hubSocket` taken out of the
  module, the check fails at evaluation. `nix build .#checks.x86_64-linux.edwin-module` passed too.

## Auto-revert, and a save over a changed file asks (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-auto-revert`, which takes in `ui-auto-revert`):
global-auto-revert-mode, so unmodified buffers follow the file on disk by inode and modification time through the
line diff; saving over a file changed since asks; buffers of a --private session and files under the system's
temporary directory are never polled.

- **The stamp.** The `stat` native (native/src/natives.rs) also gives `ino` and `nsec`, the modification time's
  nanoseconds; `host.files.stamp(name)` (native/js/host-native.ts) is `ino:mtime:nsec:size`, null when there is no
  file. A write in place changes the time (and mostly the size); a file renamed over the old one (git, most
  editors, Edwin's own atomic write) changes the inode too. A buffer keeps the stamp it last read or wrote in
  `b.disk` (src/editor-prims.ts): taken by `visit` and `revert-buffer` (src/evil-ex.ts) before they read the file,
  so a write between the read and the stat leaves an older stamp and the next look reads the file again, by
  `writeTo` after the write (save-buffer, write-file and the saves that go through them) and by each revert. Writing a region to
  another file (`:w FILE`) takes none.
- **global-auto-revert-mode** (src/editor-prims.ts, a global minor mode; scm/init.scm turns it on, as init.el
  did): every `auto-revert-interval` seconds (5, as Emacs) each buffer with a stamp is looked at; an unmodified
  one whose file has another stamp is read again and made the file's text by `Ed.applyLineDiff` with origin
  `disk`, so point, the other windows' points and the marks stay on their lines. The revert is one undo step (a
  snapshot pushed first): undoing it gives the old text back, marked modified. Read-only buffers follow too. The
  echo area says `Reverted FILE`. A modified buffer is never touched. `(auto-revert-buffers)` looks once, now.
- **Save supersession.** `writeTo`, the one place a buffer's text reaches its file, refuses when the visited file's
  stamp is not the buffer's (and the file is still there), and queues `ask-user-about-supersession-threat`, a
  command of its own: `FILE changed on disk; save anyway? (y or n)`. y saves the buffer over that version of the
  file (a further change asks again), n says `FILE not saved` and leaves the disk and the buffer as they are. So
  `:w`, `:wq`, `:x`, `:wa`, C-x C-s, SPC f s, C-x C-c's saves and Org's saves after its commands all ask.
  After an n, each later Org command that saves its buffer meets the refusal and asks again, until the buffer is
  saved (y) or read again (`revert-buffer`).
- **Polling cost.** One stat per buffer with a stamp each interval; a file is read only when its stamp changed,
  and the diff is bounded by the line diff's whole-replace fallback. A version that cannot be read (not UTF-8,
  unreadable) is tried once, not on every look, and a save over it still asks.
- **Never looked at** (no stat, no stamp, no question on save):
  - any buffer of a --private session: `host.private`, a host flag (not a Scheme variable, so neither init.scm
    nor image replay can clear it) that `ui-sensitive-session`'s `edwin --private` is to set; nothing sets it yet;
  - files whose true name is under the system's temporary directory, `$TMPDIR` or else `/tmp` as sops and mktemp
    take it, read when the program starts (`host.files.temp`), for sops's decrypted copies;
  - edwind's buffers (`b.shared`): in edwinclient the notes under edwind's notes directory are edwind's, which
    follows their files itself (server/watch.mts); edwinclient's other files are its own and are looked at;
  - the page and edwind: their hosts have no `stamp`, so the mode does nothing there.
- **Choices made where the package left one open:**
  - The poll is armed by the first buffer with a stamp, and disarmed when a look finds none or the mode is off,
    not at boot: the startup snapshot holds the boot, init.scm included. `auto-revert-interval` is read when the
    poll is armed.
  - The revert is an undo step of its own, so a look is skipped while another is still open: while a command
    runs (`E.running`: an operator waiting for its motion, a command waiting in the minibuffer), and, for a
    buffer, while its insert session is open (insert or replace state). Taken into that step, one u would undo
    the revert with the user's edit, leave the buffer with the new stamp and the old text, and a save would
    write over the other program's version without asking. The next look catches up; an insert session with
    typing in it has made the buffer modified, so it is left alone and a save asks. `(auto-revert-buffers)`
    from M-: returns 0 for the same reason.
  - A file gone from disk is no change: the buffer stays, and saving makes the file again without asking.
  - The question comes after the save is refused, as a command of its own, because Scheme in a frame cannot wait
    (`:w` is Scheme calling `save-buffer`); the refused save's caller stops (`:wq` does not quit). `:w!` asks
    too: Vim's `!` there overrides other refusals, and one y is not much.
  - dired's `yesOrNo` is now `Ed.yesOrNo`, shared with the question.
- **Differences from Emacs:** Emacs asks when a modified buffer's file changed on its first edit
  (`ask-user-about-supersession-threat` from the lock check) and again on save; Edwin asks on save only. Emacs
  compares the modification time alone; Edwin the inode, time and size. No `auto-revert-mode` per buffer, no
  `auto-revert-tail-mode`, no file notifications (a poll only), no `auto-revert-verbose` switch.
- **Not in it:** dired following its directory (since "Dired follows its directory"); `edwin --private` itself
  (`ui-sensitive-session`).
- **Checked by** `nix build .#checks.x86_64-linux.edwin-autorevert` (new, test/autorevert.test.mts: a real
  directory, the Node host with host.files as host-native.ts shapes it, its stamps and reads counted): a file
  renamed over with a line inserted above point updates the buffer with point on its line and column, unmodified,
  the revert undoable as one step; a same-size write in place is seen; a modified buffer is not touched, and `:w`
  then asks, n keeps the disk and the buffer modified, C-x C-s asks again and y writes; a save after the buffer's
  own write and after `revert-buffer` does not ask; a file gone stays in its buffer and saving makes it again;
  under `host.private` and for a file under the temporary directory no stamp is taken (zero stat calls) and nothing
  reverts or asks; a shared buffer takes no stamp; with the mode off nothing follows, and on again the timer
  reverts within its interval; a version that is not UTF-8 is read once over two looks and a save over it asks; a write while insert state is
  open and while `d` waits for its motion is not reverted, the edit after it then saves only after asking, and
  one u takes back the edit alone; a write between `visit`'s read and its stat is reverted by the next look.
  `nix build .#edwin`: the new terminal test `a_buffer_follows_its_file_and_a_save_over_a_change_asks` (the
  program with `auto-revert-interval` 1: a rename reverts the buffer with point kept, a save over a write in place
  asks, n and y; with `$TMPDIR` the file's directory the write is not looked at and `:wq` saves without asking);
  unit 17, gui.rs 5 and 1 ignored, terminal.rs 32 (a first run failed one gui test with `Xvfb did not start` at
  load 27 from other builds; the rerun passed). Also `edwin-typecheck`, `edwin-headless`, `edwin-native`,
  `edit-dired`, `edwin-scheme`, `edwin-linediff`, `edit-frame`, and, as init.scm reaches ex44's public edwind,
  `edit-conformance`, `edit-lockdown` and `edit-security`; and by hand a throwaway edwind (its own HOME,
  XDG_RUNTIME_DIR and TMPDIR) answering `global-auto-revert-enabled` with #t, `(procedure? vile-vcs-status)` with
  #t (init.scm ran past the new line) and `(auto-revert-buffers)` with 0, not in safe mode: the mode is bound
  there and inert (its host has no stamp). No primitive gives Scheme a file's text or stamp:
  `auto-revert-buffers` returns a count.

## The desktop daemon's PATH (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-unit-path`): give the edwind user unit a declared tool
set on its PATH (git, rg, direnv, formatters, language servers), as the Emacs unit set its own PATH.

- **`programs.edwin.daemon.path`** (nix/edwin-module.nix), a list of packages, empty by default. It is the unit's
  NixOS `path`, so the rendered unit's `Environment="PATH=..."` holds each package's bin directory (`lib.getBin`,
  so a package whose bin is an output of its own, as curl's, counts), in the order given.
- **Choices.** The plan said the unit inherits the user manager's PATH; it does not: NixOS gives every unit a
  minimal PATH of its own (coreutils, findutils, grep, sed, systemd; `enableDefaultPath`). That default stays,
  after the listed packages, so the daemon's own scripts keep their tools and a listed package wins a name both
  have. The unit still never sees the user's login PATH or profile: what it can run by name is what the option
  and the default list, nothing a user's shell set. `edwin-daemon` prepends coreutils and util-linux to the PATH
  it is given, so the option reaches edwind unchanged. Empty, the unit is exactly as before.
- **Who sees it.** edwind and the children it starts directly. A desktop edwind starts no processes of its own
  today (they go through a hub, and no desktop has one), and frames are processes of whatever started them, not
  of the unit: the tool list matters for what edwind is later made to run itself.
- **Not in it:** the tool list itself and any host setting it (fleet-edwin-unit-path); a hub unit's PATH
  (proc-desktop-hub, declined); the PATH of frames started by `edwinclient` or `systemd-run --user`
  (fleet-edwin-unit-path's helper).
- **Checked by** `nix build .#checks.x86_64-linux.edwin-daemon-models`, extended: a desktop with `daemon.path =
  [ hello curl ]` has a rendered unit whose PATH starts with hello's and curl's bin directories (curl's `bin`
  output, not its `out`), in that order, keeps every directory of the default PATH, with coreutils after them;
  the desktop without it has neither. The daemon-models suite passed again (5 of 5). With the `path` line taken
  out of the module, the check fails at evaluation. `nix build .#checks.x86_64-linux.edwin-module` passed too.

## Dired follows its directory (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-dired-auto-revert`): dired buffers refresh when the
directory changes.

- **The look** is global-auto-revert-mode's (src/editor-prims.ts), not a timer of its own: a buffer that is not a
  file's can carry `b.autoRevert`, a look of its own the mode runs with the visited files every
  `auto-revert-interval` seconds (and `(auto-revert-buffers)` at once), counted among the buffers read again. The
  mode's rules hold for it: no look while a command runs or the minibuffer is open (a `D` waiting for its y, an
  `R` for its destination), the poll armed by the first buffer that needs it and never at boot, off with the mode.
  `Ed.armPoll` is exported for dired; `Ed.looksAt(path)` is the one test of what the mode may look at, which
  `Ed.diskStamp` now uses too.
- **Reading the listing again** (src/dired.ts `follow`): when the directory's names differ from the listing's, it
  is read again as `g r` does: the marks and flags of the names still there stay on them, a name gone takes its
  mark with it, and point stays on its entry. A listing not shown in any window follows too. Nothing is said in
  the echo area.
- **Fixed on the way:** reading a listing again (`g r`, after D, R, C, +, and now the look) kept point on the
  line it was on rather than its entry, since the name was looked up after the new entries were in; it is now
  read first, so a name made above point no longer moves point onto the entry before it.
- **Polling cost.** A quiet directory costs one lstat a look. The names are read (one readdir, sorted) only when
  the directory's modification time moved since the last look, or while that time is within 2 s of the look that
  read them; a listing is read again only when the names differ. A look that reads 10000 names took 16 ms in the
  Node test; a listing cut at 10000 names is not followed at all.
- **Choices made where the package left one open:**
  - The names tell a change, not the directory's time alone: the kernel moves that time in coarse ticks, so a
    name made in the tick of a read would leave it as it was and the change unseen. The time only spares the
    readdir once it is 2 s older than the read. The listing keeps the names of the very readdir it was drawn
    from, so a name made between that read and a look is caught by the look.
  - Only the desktop program's own directories (the local backend over `host.files.tree`) follow. edwind's
    listings (served mode, and the notes directory when attached) do not: that would be an `fs-list` round trip
    every interval. A --private session's (`host.private`) and those under the temporary directory do not, as
    for files. A directory gone from disk leaves its listing as it was.
  - A listing cut at 10000 names (MAX_ENTRIES) does not follow: it already says it is partial, and its readdir
    is the cost that grows.
  - Silent: no `Reverting buffer` message.
- **Differences from Emacs:** Emacs (global-auto-revert-non-file-buffers with dired-buffer-stale-p) compares the
  directory's modification time; Edwin the names. So, as in Emacs, a listed file whose size or time changed while
  its name stayed is not redrawn until `g r` or a change of names.
- **Not in it:** following edwind's directories; file notifications (still a poll).
- **Checked by** `nix build .#checks.x86_64-linux.edit-dired` (test/dired-local.test.mts, four new tests: a file
  made and one removed by another program show at the next look with the `*` and `D` marks kept on their names
  and point on its entry, which moved down a line; no change counts 0, a write to a listed file's content is no
  change; a listing in no window follows; a directory gone leaves its listing; under the temporary directory and
  under `host.private` no listing is followed; with the mode off nothing follows, on again it does; a directory
  whose time is a minute old costs no readdir over two looks, a name made then is seen, and one made with the
  directory's time put back (the same tick) is still seen; a listing of 10000 names follows, the 10001st name is
  seen and cuts it, and the cut listing then follows no more), with `edwin-autorevert`, `edwin-typecheck`,
  `edwin-headless`, and, as editor-prims.ts reaches ex44's public edwind, `edit-conformance`, `edit-lockdown` and
  `edit-security`; and `nix build .#edwin`.

## One theme for every kind of frame (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `ui-theme-model-frames`): the light/dark choice lives in the
frame model, so every frame kind follows one setting.

- **What was wrong.** `load-theme`, `modus-themes-select`, `modus-themes-toggle` and `disable-theme` set the page's
  `data-theme`, which only the page's stylesheet read. A model frame (the terminal, the window) drew with the
  theme it found out at start (`EDWIN_THEME`, the terminal's background report, `COLORFGBG`, the window's), so
  the commands changed nothing there; and `theme-dark?` read the page alone, where the desktop host always says
  dark, so `modus-themes-toggle` and `custom-enabled-themes` were wrong in a light terminal.
- **The one resolver** is `Ed.display.themeOf(f)` (src/display.ts), used by `frameModel` for every face and
  cursor colour and by `theme-dark?` (src/extras.ts) for the selected frame. In order: the page's `data-theme`
  when it is `light` or `dark` (what the commands set and Meta keeps, or the host page's own in a browser); else,
  for a model frame, what it found out (`Ed.display.setTheme`) or its backend's `theme`; else the host's
  preference (`prefers-color-scheme` on a page). The setting stays where the page's stylesheet reads it, so a page
  frame needs nothing new; `applyTheme`'s `metricsGen` bump redraws the model frames.
- **Choices made where the package left one open:**
  - A chosen theme wins over what the terminal or the window reports, and over `EDWIN_THEME` (which only sets
    the frame's own; the fleet sets it nowhere); `auto` (`disable-theme`) gives each frame its own again.
    `ui-theme-terminal-follow` feeds the frame's own through `setTheme`, so a terminal's later report changes
    nothing while a theme is chosen. As the choice is kept (Meta), one `modus-themes-toggle` holds in later
    sessions too, until `disable-theme`.
  - A theme saved by an earlier session (Meta `theme`), which a terminal or window ignored until now, applies to
    them too from now on.
- **Differences from Emacs:** none in what reaches the frames (Emacs's `load-theme` reaches every frame too);
  Edwin has only the two Modus tinted palettes.
- **Not in it:** following the terminal's colour-scheme reports after start (`ui-theme-terminal-follow`); a theme
  per frame.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-display` (test/display.test.mts, a new test: a terminal
  frame that found out light and a window frame whose backend says light; `load-theme modus-vivendi-tinted` gives
  both dark, the terminal frame's faces equal those of a frame that found out dark itself, the window's default
  face is the dark one, `data-theme` is `dark` for the page and `theme-dark?` is #t, and native/js/term.ts draws
  the dark background and not the light one; `modus-themes-toggle` gives all of it light; `disable-theme` gives
  each frame its own again, and `theme-dark?` is the selected frame's. With `frameModel` as it was, the test
  fails), with `edwin-native`, `edwin-typecheck`, `edwin-headless`, and, as stack.ts and extras.ts load in
  ex44's public edwind, `edit-lockdown` and `edit-security`; and `nix build .#edwin`.

## A terminal frame follows the terminal's light/dark switch (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `ui-theme-terminal-follow`): terminal Edwin reads the
terminal's colour-scheme notification and switches theme.

- **The report** is the colour-scheme notification of Contour, kitty, ghostty, foot and others: native/js/term.ts's
  `enter()` sets mode 2031 (`CSI ? 2031 h`, reports sent unasked whenever the scheme changes) and asks once
  (`CSI ? 996 n`) after the background colour and before the DA1 fence; `leave()` resets it (`CSI ? 2031 l`), so a
  suspended edwin's shell gets no stray reports and the resume asks again. The decoder makes `CSI ? 997 ; 1 n` a
  `{type: 'reply', kind: 'scheme', value: 'dark'}` and `; 2 n` one with `light`; any other `?…n` is dropped.
- **native/js/main.ts** gives a scheme reply to the frame through `Ed.display.setTheme` as it does the background
  reply, so `themeOf` (src/display.ts, unchanged) and the repaint are those of `ui-theme-model-frames`.
- **Choices made where the package left one open:**
  - The later of the two reports wins; at start that is the scheme, which is asked last. After start only the
    scheme is sent unasked, so the background colour is not asked again.
  - `EDWIN_THEME` and a chosen theme (`load-theme`, `modus-themes-toggle`, kept in Meta) win over the reports, as
    they win over the background colour; `disable-theme` lets the frame follow the terminal again.
  - A terminal that does not report (or a tmux that does not pass the mode through) keeps what edwin found out at
    start: the background colour, else `COLORFGBG`, else dark.
- **Differences from Emacs:** Emacs's terminal frames do not read these reports, so here Edwin does more. Edwin's
  window frame is not in this package: it keeps the theme its
  window reported at start.
- **Not in it:** following the desktop's scheme in a window frame; asking the background colour again on a change.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-native` (test/term.test.mts: the decoder's `997;1`, `997;2`
  and dropped `?…n` replies; `enter()`/`leave()` set and reset `?2031`, and ask `?996n` after `OSC 11` and before
  DA1), and `nix build .#edwin`, whose native/tests/terminal.rs has two new tests: a frame started dark (the pty
  answers the background query dark and never the scheme query) repaints with the light palette's background after
  `CSI ? 997 ; 2 n` and with the dark one after `; 1 n`, and resets mode 2031 on leaving; with `EDWIN_THEME=dark` a
  light report draws nothing light. Also `edwin-typecheck` (core.d.ts's new reply kind) and `edwin-display`.
  Nothing here loads in edwind, so `edit-lockdown` and `edit-security` were not needed.

## The jump pulse in terminal and window frames (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `ui-pulse-model-frames`): the jump pulse works from the frame
model in terminal and window frames.

- **The face.** `FACES.pulse` is `{bg: 'pulse'}`, the `--pulse` token of `index.html` (light `#ffdfa0`, dark
  `#5f4f2f`), and `set-face-color! 'pulse` sets it as on the page. It is laid over the current-line face and under
  the text's own classes, the region and the matches (layer 0.5).
- **Where it goes.** `drawWindow` adds `pulse` to the row base of the line `renderBuffer` marks (`line.pulse`, the
  line of `E.pulse` in the selected window), so every row of a wrapped line and the cells after its text carry it,
  as the page's `.ln.pulse` covers the whole line element. The line number keeps its own face: on the page the
  gutter is the line's `::before`, which draws its own background over the line's.
- **Clearing** is extras.ts's, unchanged: its timer drops `E.pulse` after 350 ms and calls `Ed.render`, which
  draws the model frames again; the terminal and the window take the new model with no work of their own.
- **Choices made where the package left one open:**
  - The pulse face lies over the current-line face and under the text's own classes, the region and the matches
    (layer 0.5), as the page's line background lies under its spans.
  - The line number keeps the current-line face during a pulse, as on the page.
  - Pulse scope (decision 18, not answered): the plan's default, the selected window of the selected frame only,
    which is what the page does; the commands on `post-command-pulse` are unchanged.
  - No fade (below).
- **Differences from Emacs and the page:** Emacs's pulse fades over several steps, the page fades by a CSS
  animation of 0.45 s; a cell frame shows the face at full strength until it clears, which is what the page shows
  under `prefers-reduced-motion`. Redrawing a terminal frame for each fade step was not worth it.
- **Not in it:** a fade; a pulse in a window other than the selected one (the page does not pulse those either);
  snipe boxes, still a cell face.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-display`: a new test jumps with `3G` (evil-goto-line is on
  `post-command-pulse`) in a terminal frame and in a window (gui) frame, asserts the jumped-to line's text cells and
  the cells after the text have the pulse colour, the line number keeps the current-line face and the other lines
  do not pulse, then waits 450 ms and asserts the timer redrew the frame with the pulse gone; the face-table test
  now maps `index.html`'s `.ln.pulse` (its reduced-motion rule gives the background) to `FACES.pulse`. Also
  `edwin-typecheck`. display.ts does not load in edwind's server, so `edit-lockdown` and `edit-security` were not
  needed.

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
- **Keys there**, each on the task at point: `RET` opens its record; `t` sets the state (then `t n w h s d c`);
  `x` is done; `s` schedules and `d` sets when it is due (the date reader of `org-schedule`: nothing typed is
  today, a typed time is kept; `C-u s` and `C-u d` clear the date, so `C-u` is the prefix argument in this
  buffer and not a scroll); `p` sets the priority (`a b c`, space for none); `e` edits the title; `:` changes its
  tags (it reads `Tags (+a -b): `: `+a` or `a` adds the tag `a`, `-b` removes `b`, and the echo area says the
  tags the task has then; brain refuses a tag that hides and that the token is not cleared for); `a` adds a task; `r` and `g r` ask again; `q` leaves. Each has a command that takes
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
- **`brain-task-add` (`SPC o`, `a` in the agenda)** reads `Task: ` and adds the task with the tags
  of `brain-task-tags`, a string of tags with spaces between (`""` by default: no tags, a task every client of
  brain can read). The echo area says `task:N added` and the tags of the task. A Visual selection is its body.
  When the note at point has an Org id the body ends with `[[id:ORG-ID]]`: the id alone, since a tag may hide
  the note's title from those who can read the task. An agenda that a window shows is asked for again.
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
  the user's Scheme in `~/.config/edwin`, the log (background start) in `~/.local/state/edwin/edwind.log`. Since
  2026-11-15 a background start returns once the socket answers, and two starts give one edwind ("edwin --daemon
  waits", above).
- **The client.** `edwinclient` and `edwinclient -c` attach to the edwind `--socket` or `--remote` names, else
  the first that answers on `$EDWIN_SOCKET` or `$XDG_RUNTIME_DIR/edwin/edit.sock` (until 2026-10-19 also
  Workbench's `/run/workbench-edit/edit.sock`), so notes are shared between frames and with the browser. Files
  outside the notes directory stay the program's own (DT1). Until 2026-11-13 there was no separate client: every
  `edwin` attached by itself, and `--standalone` kept one apart ("edwin and edwinclient", above).
- **The build.** The prebuilt V8 (`librusty_v8` 130.0.1) is a fixed-output fetch handed to the `v8` crate as
  `RUSTY_V8_ARCHIVE`, so the build runs offline. The window's libraries (libxkbcommon, Wayland, Vulkan, libGL, X11)
  are added to the binary's RPATH, as winit and wgpu open them at run time. The check phase runs the
  pseudo-terminal suite and, since 2026-11-15, the window's tests on Xvfb and lavapipe (until then they skipped in
  the sandbox: "The window's tests in the package check", above). The flake check `edwin-module`
  evaluates a system with `programs.edwin` (the user unit, `EDITOR`); it does not boot one. Since 2026-11-15 the
  unit is active only once its socket answers ("The user unit is ready when its socket answers", above).
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
otherwise (with `EDWIN_TEST_REQUIRE_GUI` set, as the package's check sets it, a skip fails). The binary is 48.6 MB (37.6 without the window). The window opens in about 100 ms on the software
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
  last; `+LINE:COL` on a character of it, above); `-` edits standard input (`git diff | edwin -`), the terminal being `/dev/tty`. Files the editor is handed by git (`COMMIT_EDITMSG`, `git-rebase-todo`...) start at the top
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
