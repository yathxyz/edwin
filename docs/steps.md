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
  environment changes for a child run in DIR, what direnv exports there (proc-direnv, "direnv for child processes"). Callers pass it as
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
  proc-host-spawn); no pseudo-terminal. **The limit of the refusal:** a procedure the
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
  `Ed.proc.envFor` gives for the directory (what direnv exports, proc-direnv). The image never reaches it (R16.15): `start`
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
- **Not in it:** error parsing and next-error from the buffer (proc-compile-errors, below), grep (proc-grep),
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

## compile errors: the places in *compilation* feed next-error (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-compile-errors`). Parse file:line:col for the owner's
toolchains (rustc, tsc, gcc, nix, python) and feed next-error; fixture logs from each tool yield exact
locations, and the parse stays within budget on 10,000 lines.

- **The error list follows the compilation** (src/compile.ts). Each complete line of output is read once, as it
  comes, and the places it names are added to the frame's error list (scm/next-error.scm), so `M-g n`, `M-g p`,
  `:cn`, `:cp` and `:cc` step through them while the command still runs, and a step taken mid-build keeps its
  place as more come. A compilation takes the list over when its child starts (empty until its output names a
  place); a list another producer sets later (a search, a seeded list) is left alone and gets none of the
  compilation's errors. Only output is read: not the header (whose command line or time could look like a
  place), the dropped-output line or the status line. A line cut between two batches is read once it is whole;
  a line a carriage return starts again is read as it ends; the last line is read at exit even with no newline.
- **The shapes** (all fixtures are real output, captured on ex44 from rustc 1.98 via cargo, tsc 7.0, gcc 16 under
  make 4.4, python 3 and nix 2.34, their paths rewritten to /work/fx): rustc's `--> FILE:L:C` under its
  `error[E…]: …` / `warning: …` header (the header is the message; a header holds for the line right below it
  only, so a `-->` or `at` line with none above it is still a place, its own line the message), and `thread '…' panicked at FILE:L:C:`;
  tsc's `FILE(L,C): error TS…` and, with `--pretty` (colours dropped), `FILE:L:C - error TS…`; gcc's and
  clang's `FILE:L:C: …` and `FILE:L: …` (also go, ghc, mypy, pytest's `FILE:L: Error`); nix's `at /FILE:L:C:`
  (ending in a colon, so a JavaScript stack frame `at /f.js:3:4` is none) under its `error: …` header; python's `File "FILE", line N` (no column). A relative name is taken from the
  directory make last said it entered (`make[1]: Entering directory '…'`, popped at `Leaving`; the innermost 64
  are kept, past that the outermost goes), else from the compilation's directory; `./` is dropped; with no directory it stays relative.
- **Not places:** gcc's `note:`, rustc's `note:`/`help:` headers and nix's trace frames (`… while evaluating …`)
  are info, and their places are skipped, as Emacs skips info (`compilation-skip-threshold` 1). A line number 0
  is no place (the line is skipped), a column 0 is none (the line start), and a number past 2^53 is no place.
  A gcc-shaped name must hold a `.` or a `/` (or be a Makefile) and not be only digits and dots, so
  `07:52:09`, `1.2.3:4:`, `localhost:8080:` and URLs are not places; `<stdin>`, `<string>` and nix's `«string»`
  are not files. Messages over 500 characters are cut.
- **Budget and bounds.** Every pattern is anchored at the line start, none nests a quantifier, and a file name
  never holds a colon, so each line costs time linear in what is read of it, and only its first 4096 characters
  are read. Measured on ex44 (best of five): 10,000 lines of mixed output (every fixture and build noise) in
  1.7 ms, the check's bound 20 ms, and read and handed to the error list (the rows into Scheme, checked by
  next-error--entry and appended) in 3.1 ms, bound 50 ms; 1,000 near-miss lines of 100,000 characters (colons,
  digits, parentheses all along) in 4.1 ms, bound 100 ms; 30000 error lines through a compilation stall the
  frame at most 9 ms, bound 250 ms. At most 20000 errors are kept, the first ones, so a flood of error lines
  does not grow the list without bound.
- **Columns in the tool's unit.** An entry is `(FILE LINE [COLUMN [MESSAGE [UNIT]]])`; UNIT `screen` is a
  display column (a tab to the next multiple of 8, a wide character 2, as gcc 11+ counts by default), `utf-16`
  a UTF-16 unit (as tsc counts), `byte` a UTF-8 byte (as nix counts: `u.nix:1:26` on `let a = "ééé"; in a + zz`
  is the `zz` at character 23), `#f` a character. `visit-location` takes the unit as a fourth argument and
  converts on the line it visits, so `a.c:3:17` on `\tint x = y;` lands on the `y` (character column 10), as
  Emacs's `compilation-error-screen-columns` does; a byte or UTF-16 column inside a character is that character.
  GNU-shaped places are `screen`, tsc's `utf-16`, nix's `byte`, the rest (rustc's `-->` and panics, python)
  characters.
- **scm/next-error.scm**: `(next-error-set-list! ENTRIES [OWNER])` records OWNER; new `(next-error-add-to-list!
  OWNER ENTRIES)` appends when the list is still OWNER's (`equal?`), keeping the error last visited, and gives
  the new length, else `#f` and adds nothing; all entries are checked before any is added. A compilation's owner
  is `"compile N"`, one per run. `Ed.compile.errors(TEXT, DIR)` gives the rows the parser finds in TEXT.
- **Choices and differences from Emacs:** a fixed set of shapes in TypeScript, not
  `compilation-error-regexp-alist` (no user-defined patterns). The GNU shape cannot tell gcc from the other
  tools that print it: clang and go count columns in bytes, a tab as one, so on a tab-indented line (all gofmt
  code) their column, read as gcc's display column, lands left of the place, on the tab itself for a place
  near the indent (Emacs does the same with screen columns on; gcc with `-fdiagnostics-column-unit=byte` would
  land right of it). Non-ASCII text before the column moves clang's and go's places the same way. rustc with
  `--message-format=short` prints the GNU shape too but counts characters, so a tab before its column lands left
  of the place as well; its default `-->` lines are read in characters and land exactly. Nix store
  paths stay as printed (they open read-only). Paths holding a colon are not recognised, and in the GNU and
  tsc --pretty shapes neither are paths holding a space (`my dir/a.c:3:4: …`), which keeps prose such as
  `In file included from` out; rustc's `-->`, nix's `at` and python's `File "…"` do take spaces. The message of a python frame is its `File` line, not the exception
  below it. No faces mark the places in `*compilation*`, and `RET` on an error line does not visit it
  (`compile-goto-error`); `M-g n` and `:cc N` do. Only nix's current error format (`at FILE:L:C:` on its own
  line) and rustc's current panic format (1.73+) are read.
- **Not in it:** faces in `*compilation*`, `compile-goto-error` and `compilation-next-error` (moving between
  errors inside the buffer), warnings-only filtering, the old nix and rustc panic formats, grep (proc-grep).
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-compile`, `test/compile.test.mts` (30): each of
  the nine fixtures (test/fixtures/compile: rustc, rustc run with a warning and a panic, tsc, tsc --pretty, gcc
  under make -C, python, nix, nix with a trace frame, nix past non-ASCII text) streamed through `cat` gives its exact rows (file, line,
  column, message), and the same through `Ed.compile.errors`; with no directory names stay relative; a command
  shaped like a place gives none (the header is not read); a place split across two batches, a line restarted
  by `\r` and a last line with no newline; fifteen near misses give only `b.c:2` (column 0 as none) and
  `Makefile:3`; `M-g n` mid-build visits the first error, the later errors are added and the index kept, and
  two more steps land on the tsc error; a list set while a compilation runs keeps none of its errors, and a new
  compilation empties the list; 30000 error lines keep the first 20000 with no stall; the budget above. Added
  after review: the units each fixture's rows carry; `M-g n` through the gcc fixture on a tab-indented `a.c`
  lands on `y` (column 10), the string and `x`; a header names only the place on the line below it (a stale
  header, a note's `info` and a JavaScript stack frame give no wrong place); make's stack keeps 64 levels; a
  refused hand-over to the error list loses no output and a refused new list is reported, not thrown: the
  caller gets the run, `*compilation*` is shown and the status line appears. After a second review: `M-g n`
  through the nix fixture with `ééé` before the error lands on the `zz` (character 23 for nix's byte 26).
  `nix build .#checks.x86_64-linux.edwin-next-error` (11) adds the owner case: added entries keep the place, a
  bad entry adds none, another owner, no owner and an ownerless list take nothing; and (12) columns in unit
  `screen` (tab, wide characters, past the end), `utf-16` (inside a surrogate pair) and `byte` (two-byte and
  four-byte characters, inside one, past the end), a bad unit refused.
  Also run on ex44 after the review fixes, all passing: `edwin-typecheck`, `edwin-headless`, `edwin-scheme`,
  `edit-security`, `edit-lockdown` and `nix build .#edwin` (its install checks included). Not run: the full
  `nix flake check` and the fleet gate.

## grep: rg into *grep*, its rows next-error's (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-grep`, absorbing ui-grep-buffer). `M-s g` runs rg into
`*grep*` with next-error rows; rg must be on PATH, with a clear message when it is not.

- **`grep`** (src/compile.ts, `M-s g` in scm/init.scm, as init.el binds it): reads `Run grep (like this): ` with
  `grep-command`, default `rg -nSH --no-heading --column `, and its own history (`grep-command`, not
  `project-find-regexp`'s), then runs the line as compile does, with `sh` from PATH, in the current buffer's
  directory (its file's or its listing's; in `*grep*` or `*compilation*` the directory its run started in, so
  `M-s g` from `*grep*` refines the last search where it ran, as Emacs's `default-directory` there; else the
  program's), not the project's. `Ed.compile.grep(COMMAND, [DIR])`,
  `Ed.compile.regrep()` and `Ed.compile.grepping()` are the same from code.
- **One machinery, two runs.** compile.ts now has two kinds of run, compilation and grep, each with its own
  buffer, mode, last command and running child: a grep started while a build runs leaves the build alone, and a
  new grep replaces only a running grep. Everything else is compile's: Ed.proc only (the image never reaches it,
  R16.15; no grep in a web frame or on edwind, said before the command is read), output streamed in batches,
  escapes dropped, the line and size bounds, the header (`-*- mode: grep; default-directory: "DIR/" -*-`, `Grep
  started at TIME`, the command), killing `*grep*` kills its child.
- **Standard input is /dev/null** for a grep: the child is `sh -c 'exec </dev/null` + newline + COMMAND`. compile
  closes a pipe, and rg given no path searches a pipe on its standard input instead of the directory, finding
  nothing; `/dev/null` is no pipe, so rg searches the directory.
- **`*grep*`** is in `grep-mode`, derived from `compilation-mode`, so `g r` (recompile: the grep again, in its
  directory), `C-c C-k` (kill-compilation: the grep), `q` and the `SPC` leader keys work there as in
  `*compilation*`. The status line: `Grep finished with matches found` (exit 0), `Grep finished with no matches
  found` (exit 1, no failure), `Grep exited abnormally with code N` (2: a bad pattern, a file it cannot read),
  `Grep interrupted` and the other signals; each with time and duration, in the echo area too.
- **rg not on PATH.** The shell says so (`sh: line 2: rg: command not found`, or dash's and busybox's `not found`)
  and exits 127; then the status line and the echo area say `Grep failed: rg is not on PATH (exit 127)`, naming
  the program the shell did not find (also another one in a pipeline).
- **The rows.** Each line `FILE:LINE:TEXT` is a row of the error list, owner `"grep N"`, so `M-g n`, `M-g p`,
  `:cn`, `:cp` and `:cc` step through them as they come; with `--column` (or `--vimgrep`) in the command,
  `FILE:LINE:COLUMN:TEXT`, the column in rg's unit, UTF-8 bytes (unit `byte`), so a row past a tab or past
  `ééé` lands on the match. Without it a row has no column (`12:30 needle` is text, not a column). The message is
  the matched text. Only grep's shape is read, not compile's: a matched line `x.c:3:4: error: …` is a row of its
  own file, not a place in x.c. FILE is the shortest prefix followed by `:LINE:`; a FILE of digits only is none
  (rg's `LINE:TEXT` for one file searched without `-H`). Relative names are taken from the directory, `./`
  dropped. At most 20000 rows, the first. A carriage return is not a terminal's here, as it is in
  `*compilation*`: rg prints file text raw, so `\r\n` is a newline and a bare `\r` inside a matched line is kept
  (shown `^M`, as Emacs shows it); the row keeps its `FILE:LINE:` prefix and its column.
- **Choices and differences from Emacs:** the default command adds `-H` (with one file named rg would print no
  file name; Emacs appends /dev/null for that) and `--column` (Emacs finds the match column from grep's colour
  escapes, which are dropped here) to the owner's `rg -nS --no-heading `. `grep-command` is not changed by a run;
  the minibuffer history keeps earlier lines. The directory is the buffer's, as Emacs's `grep`
  (`default-directory`); `SPC p g` (project-find-regexp) is the project search. No faces on matches, no
  `RET` on a row (`compile-goto-error`), no context lines read (`-C`), no `--null` parsing: a file name holding
  `:DIGITS:` is misread, and a pattern argument spelled `--column` turns columns on. Exit 127 is named only when
  the shell's own line says which program it did not find. In a file that is not UTF-8, rg's column counts the
  file's raw bytes while the visited buffer holds the lossily decoded text (each bad byte a U+FFFD, three UTF-8
  bytes), so a row past such bytes lands early on its line (two characters per bad byte before it): fixing it
  needs the file's raw bytes, which the buffer no longer has.
- **Not in it:** `rgrep`/`lgrep`/`zgrep` and the find-based commands, editing the results (since "Editing *grep* and writing it back"),
  `grep-find-ignored-directories` (rg follows .gitignore itself), match faces.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-compile` (39), with ripgrep in the check's
  sandbox (nix/checks.nix `suiteWith`) over a copy of `test/fixtures/grep`: `M-s g` offers `grep-command`, the
  typed line runs as `sh -c 'exec </dev/null⏎rg …'` in the buffer's directory with no path given and finds the
  six rows (exact file, line, byte column, message, unit `byte`), the header and `Grep finished with matches
  found`, a gcc-shaped matched line giving its own file's row; `M-g n` six times lands on `needle` each time
  (past two spaces, `12:30 `, a gcc-shaped prefix, `ééé ` and a tab); no match gives `Grep finished with no
  matches found` and an empty list, `'('` gives exit 2 with rg's error in the buffer, without `--column` no
  column, without `-H` no row, `./src` resolved; with only `sh` on PATH the buffer has the shell's line and the
  status and echo area `Grep failed: rg is not on PATH (exit 127)`; a grep run during a compilation leaves it
  running, `g r` in `*grep*` reruns the grep's argv in its directory, `C-c C-k` there gives `Grep interrupted`,
  killing `*grep*` kills only its child, recompile reruns the compilation's command; inside `Ed.proc.replay`
  `Ed.compile.grep`, `regrep` and `(grep …)` spawn nothing, and in a web frame `M-s g` refuses before the
  minibuffer; a matched line `abc\rneedle cr` in `cr file.txt` is a row with its column and `M-g n` lands on
  `needle`, a CRLF file's row has no `\r`, a `\r\n` split between two batches is one newline; `M-s g` from
  `*grep*` with the program's directory elsewhere runs in the last grep's directory; 30000 rows keep the first 20000 with the frame stalled at most 7 ms (bound 250 ms). The 30 earlier
  compile cases pass unchanged. Also passed: `edwin-typecheck`, `edwin-next-error` (12), `edwin-headless` (21),
  `edwin-scheme` (38), `edit-security` (21) and `edit-lockdown` (6), since scm/init.scm also runs on edwind;
  `nix build .#edwin` (unit 22, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 35). Not run: the full
  `nix flake check`.

## Editing *grep* and writing it back (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `ui-grep-edit`): a `*grep*` buffer can be made editable;
applying writes each changed line to its file, refusing files changed since the search. Risk named: data loss if
line numbers drift, so the original line text is checked before writing. The owner's Emacs had wgrep.

- **Where.** src/compile.ts, beside grep: there is no Scheme grep source, and Scheme has no primitive that writes
  a file, so the writing is TypeScript; the keys are in scm/evil.scm and scm/emacs.scm.
- **`grep-edit-mode`**, a buffer-local minor mode of `*grep*`, which stays in `grep-mode`, so `g r` and the other
  grep keys still act on the grep. `C-c C-p` in `*grep*` (wgrep's key; `grep-change-to-grep-edit-mode`) turns it on
  once the grep has ended (refused while it runs, and in any buffer that is not a finished grep's output). The
  buffer becomes writable, in Normal state, lighter ` Edit`. `C-c C-c`, `C-x C-s` and `ZZ` (`grep-edit-finish`)
  write. `C-c C-k` and `ZQ` (`grep-edit-abort`, also `M-x grep-edit-mode` off) give the edits up and put back the
  text as it was. Outside Evil and in Emacs state the keys are in scm/emacs.scm: `C-c C-p` in `grep-mode-map`
  (made in src/compile.ts), `C-c C-c`, `C-x C-s` and `C-c C-k` in the mode's own keymap. Emacs state stays Emacs
  state while editing; otherwise the buffer goes to Normal state and back to Motion state.
- **The rows.** A row is an output line `FILE:LINE:[COLUMN:]TEXT`, read as the error list reads it (the same
  shortest-prefix rule, the column only when the command asked rg for one, FILE from the grep's directory). It is
  read whole: the error list cuts lines at 4096 characters and trims them, the editor does neither. Only the lines
  the output filled are read, kept as line numbers (not offsets, which a written row's new length would move), so
  neither the command line nor the status line can be taken for a row. TEXT is the line of FILE as rg printed it.
- **What can change.** Only the text after a row's prefix is written. A changed line that is no row (the
  header, the command line, the status line) reaches no file, so `C-c C-c` puts it back and says how many. This is
  what lets `:%s/needle/pin/g` over the whole buffer work: the command line holds the pattern and changes too. A
  row whose prefix changed (a file named after the pattern, under that `:%s`) cannot be split into prefix and text
  again, so its file is refused (named, with the line of `*grep*`) and the other files are written. Lines added or
  taken away refuse the whole write, since the rows are found by line number; nothing is written and the echo
  area says so. Deleting a file line through `*grep*` is not possible.
- **When a file is written.** Each file with a changed row is checked on its own, and it is written in one
  `Store.set`. The native write is atomic (a file renamed over it, or written in place for a symbolic link or a
  hard-linked file, as saving does), so a file is either untouched or wholly new. It is written only when all of
  these hold:
  - **Stamp.** Its stamp (`host.files.stamp`: inode, modification time to the nanosecond, size) is the one taken
    during the search, both before and after it is read. The stamp is taken when the file's first row reaches the
    buffer. Files past the error list's 20000 rows are stamped when editing begins.
  - **Text.** Each of its rows' lines in the file read now is still the row's TEXT (a CRLF line's `\r` aside).
    This catches drift even where the host gives no stamp, and also between rg's read and the stamp.
  - **Buffers.** No buffer visiting it (by name or true name) has unsaved changes, and it is not edwind's (a
    shared buffer, or a path the served frame sends to edwind).
  - **Prefixes.** None of its rows had its `FILE:LINE:[COLUMN:]` changed.
  - **Agreement.** Rows of one line (`rg --vimgrep` gives one per match) were not changed to different texts. When
    only one of them changed, that text is written.
  - **Readable.** The file can be read as UTF-8 (a file that is not throws, and it is refused rather than written
    back from a lossy decoding) and it still exists.
  The buffers visiting files are looked up by true name once per `C-c C-c`, not once per file.
  The changed lines are replaced in the text just read. A line that ended in `\r` keeps it, and the native host
  keeps a CRLF file's line ends and byte order mark, as saving does.
- **After `C-c C-c`.** The echo area says `Wrote N lines in M files`, then `; not written: FILE: why` for each
  refused file (`it changed since the search`, `its line N is not what the search found`, `BUFFER has unsaved
  changes to it`, `it is gone`, `it cannot be read (…)`, `two rows of its line N were changed to different texts`,
  `its row on line N of *grep* had its PREFIX changed`, `it is edwind's: edit it there`). Changed lines that are
  no row add `; N changed lines that are no row put back` after the count. With nothing refused the buffer is
  read-only again. With a refusal the editing goes on: the written rows count as the search's from then on (a
  stamp refreshed to the write's), so fixing the cause and pressing `C-c C-c` again writes the rest. `C-c C-k`
  then puts back the refused rows' original text and keeps the written ones. A buffer visiting a written file,
  unmodified, takes the new text through the line diff (point and marks kept, one undo step, the stamp the
  write's, so its next save does not ask about a change on disk).
- **A new grep while editing.** `M-s g` or `g r` with unwritten edits asks `*grep* has edits not written to their
  files; discard them?`. n keeps them, y runs the grep and drops them. `Ed.compile.grep` from code drops them
  without asking.
- **Choices made where the package left one open:**
  - A minor mode, not a major one: `*grep*` stays in `grep-mode`, whose test `recompile` and `kill-compilation`
    use to tell a grep from a compilation.
  - The files are written, not their buffers: an unmodified visiting buffer follows, and a modified one refuses
    its file instead of being edited behind the user's back.
  - A file is stamped when its first row comes (during the run, once per file), so "changed since the search"
    starts as close to rg's read as the output lets; with 3000 files the frame stalls at most a few ms.
  - Both the stamp and every row's line text are checked: the stamp catches a change anywhere in the file, the text
    catches drift where there is no stamp and between rg's read and the stamp.
  - A partial write is no failure: the files that pass are written, the others named, and the editing goes on.
  - Keys: wgrep's (`C-c C-p`, `C-c C-c`, `C-x C-s`, `C-c C-k`) and evil-collection's `ZZ` and `ZQ`; the command
    names are Edwin's own (`grep-change-to-grep-edit-mode` as Emacs 31 names it).
- **Differences from wgrep and Emacs:** wgrep puts the edits into the files' buffers and leaves them unsaved
  (unless `wgrep-auto-save-buffer`). Edwin writes the files and refreshes unmodified visiting buffers, which is
  why it refuses a file whose buffer has unsaved changes. wgrep marks prefixes read-only; Edwin checks them on
  `C-c C-c`. Neither `C-c C-d` (delete the line), `C-c C-r` (undo one region's edit) nor wgrep's faces for changed
  rows are here. There is no `i` key from evil-collection to start the editing: `C-c C-p` (or `M-x
  grep-change-to-grep-edit-mode`) does.
- **Not in it:** editing `*compilation*` or other searches (consult's, project-find-regexp's); context lines
  (`-C`); files edwind owns; deleting lines. Known limits: a row whose file name holds `:DIGITS:` is misread, and
  is then refused by the text check unless the misread file and line happen to hold the same text. A stamp
  unchanged by a write within the same nanosecond with the same size and inode is not seen, but the text check
  still applies. rg prints file names raw (no `--null`), so a file whose name holds a newline can make an output
  line that reads as a row of another file. A name cannot hold `/`, so the forged FILE is the rest of one path
  component: it can only name a file directly in the grep's directory (`..` is a directory, refused as
  unreadable), never one deeper or outside. The text check refuses it unless that file's line holds exactly the
  row's text; a name with a second newline ends the forged row there, so its text can be exactly the victim
  line, and a wide replace over `*grep*` would then write it. Look at the rows before `C-c C-c` in a tree you do
  not trust.
- **Many files.** Each file is its own native atomic write with an fsync (about 1.5 ms each on ex44, so 3000 files
  take seconds), and `C-c C-c` writes them in slices of 5 ms (the background slice, architecture section 6), one
  per turn of the event loop, so the frame is never held past a slice. The first slice runs in the command; while
  the rest run, `*grep*` is read-only in Motion state, the echo area counts the files written, and a second
  `C-c C-c`, `C-c C-k` or a new grep (`g r`, `M-s g`) is refused with `The rows of *grep* are being written`. A
  slice that finds the editing gone (`*grep*` killed, or `Ed.compile.grep` from code) writes no more: the files
  already written stay written. Each buffer's true name is looked up once per `C-c C-c`, with the buffers listed
  again at each slice, so one opened or killed between slices is seen.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edit-grep` (new, test/grep-edit.test.mts, 14 tests: rg
  from the sandbox over a throwaway tree, the Node host with host.files over the real directory, its read and write
  keeping the byte order mark and an all-CRLF file's line ends as host-native.ts does, writes, stamps and true
  names counted):
  - `C-c C-p` makes `*grep*` writable in Normal state with the mode local to it. One row edited by `c w` and two by
    edits, then `C-c C-c` writes three files byte-exact (only the changed lines; a CRLF line keeps its `\r\n`), one
    write per changed file and none for the others, and the buffer is read-only again. `C-c C-p` again after those
    shorter texts finds the same four rows, none from the status line.
  - 3000 files are each stamped once as their rows come, the frame stalled at most 5 ms (33 ms in a rerun while
    a Rust build ran; bound 250 ms).
  - Edits in three files with one of them changed on disk after the search (on a line no row names): that file
    keeps the other program's bytes with no write reaching it, and the other two are written. The echo area names
    it, a second `C-c C-c` refuses it again, and `C-c C-k` gives its rows back while the written rows stay.
  - With the stamp made blind, a line inserted above the rows is refused by the text check (`its line 2 is not
    what the search found`).
  - A visiting buffer with unsaved changes refuses its file. An unmodified one takes the new text, stays
    unmodified, and saves later without asking.
  - An added line writes nothing. A changed prefix refuses its file alone, and a changed header line is put back,
    while another file is written.
  - `C-c C-p`, then `:%s/needle/pin/g` typed in, then `C-c C-c`, with a file named `needle.txt` among the rows:
    the three other files are written, `needle.txt` is refused alone (its prefix changed), and the command line
    and status line are as the grep left them.
  - Outside Evil, `C-c C-p`, typing into a row and `C-c C-c` write it; in Emacs state the buffer stays in Emacs
    state.
  - 200 files written with 50 visiting buffers open take at most 250 true-name lookups (10200 before).
  - A file of mixed line ends keeps the `\r` of its CRLF row's line, and a file with a byte order mark keeps it.
  - Editing is refused while the grep runs and in `*compilation*`, and `C-c C-c` with no change writes nothing.
  - `rg --vimgrep` rows of one line: two different texts are refused, and one changed is written with the other
    row showing it.
  - A latin-1 file is refused with its bytes unchanged. `g r` with edits asks: n keeps them and runs nothing, y
    reruns and drops them.
  - 600 files whose stand-in write holds the thread 3 ms each (2.2 s in all, past the 2 s frame deadline) are
    written in slices: the longest stall 9 ms (bound 250 ms), the command back before the last slice with
    `*grep*` read-only in Motion state and the echo area counting, `C-c C-c`, `C-c C-k` and `g r` refused
    meanwhile and no grep run, then every file written once and the buffer read-only with the editing over.
    Against the one-loop write this test fails (the command returns only after the last file, 1.8 s later).

  Also passed, before the sliced write: `edwin-compile` (39, unchanged), `edwin-typecheck`, `edwin-headless` (21),
  `edwin-scheme` (38), `edwin-autorevert` (11), and `edit-lockdown` (6) and `edit-security` (21), since
  scm/evil.scm and scm/emacs.scm also load on edwind (where the mode is inert: no grep runs there); after it,
  `edwin-typecheck` and `edwin-compile` (39). `nix build .#edwin` after it ran twice under a load of 8 and failed
  both times only at `tests/gui.rs:21` (Xvfb did not start), unit 22 and the gui tests before it passing; the
  change is TypeScript the typecheck covers. Not run: the full `nix flake check`.

## Shell commands: M-!, M-&, M-|, :! and the ! operator (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-shell-command`, on proc-compile): M-!, M-&, M-|, :!
and the ! operator, written in TypeScript over Ed.proc with the key bindings in Scheme. A filter replaces text
only on exit 0. Risk named: this is the one place a shell string the user typed is allowed, so it is refused
under the image's replay.

- **Where.** The last part of src/compile.ts, beside compile and grep, whose directory rule, run machinery
  (streaming, line and byte bounds, kill on buffer kill) and process gate it shares, so there is no new file
  and no touch-list change. The `!` operator is in src/evil-ex.ts, next to `evil-ex`. The keys are `M-!`, `M-&`
  and `M-|` in the global map (scm/emacs.scm), `!` in Normal state and the ex command `!` (scm/evil.scm).
- **The child.** Through `Ed.proc.spawn` only, argv `['sh', '-c', COMMAND]` (`sh` from PATH), in the buffer's
  directory (compile's rule without the project step: a dired listing's directory or the file's parent, else
  the program's own directory), with `TERM=dumb` and the changes `Ed.proc.envFor` gives. Each entry reaches
  `Ed.proc.envFor` before its first wait, so a replayed form is refused (R16.15). In a web frame, on edwind's
  Node host and with no `host.proc`, the commands say so before reading anything.
- **`shell-command` (`M-!`).** Reads `Shell command: ` (its own history, shared by all of these) and waits for
  the child. Standard input is /dev/null (the line starts `exec </dev/null`, so `rg` searches the directory and
  not a pipe), error merged with output, lossy decoding, at most 16 MiB. The output (terminal escapes dropped,
  `\r\n` a newline) is put in `*Shell Command Output*`: one line goes to the echo area, more shows that buffer
  in another window, unselected. No output says `(Shell command succeeded with no output)` or `(Shell command
  exited abnormally with code N, with no output)`, and a failure with output adds the exit status (in brackets
  after one line, in the echo area for more). **C-g** stops the wait and kills the child (KILL to its group,
  through `EdPool.interruptible`). While it waits, the frame draws but other keys wait for the command to end,
  as in Emacs; C-g is the one taken at once. The region's text is written through the host's queue (polled,
  native/src/proc.rs), so a large region does not block the loop. With a prefix argument
  (`C-u M-!`, `(shell-command CMD #t)`) the output is inserted at point, point before it and the mark after,
  under the filter's rules below. A command ending in `&` (not `&&`) runs as `async-shell-command`.
- **`async-shell-command` (`M-&`).** A third kind of compile's run: the output streamed into `*Async Shell
  Command*` (`async-shell-command-mode`, from `special-mode`: read-only, Motion state, `q`), with compile's
  carriage-return handling and bounds (20000 lines, 4 MiB), no header and no error list (the frame's
  next-error list and `compile-command` are left alone), then the line `Shell command finished` / `exited
  abnormally with code N` / `interrupted` with the time and duration. Standard input is /dev/null. `C-c C-k`
  there interrupts it (SIGINT to its group), killing the buffer kills it, and one still running when another
  starts is killed, after asking when the command is typed.
- **`shell-command-on-region` (`M-|`).** The region (Visual state's selection, which it leaves, else point and
  mark) goes to the child's standard input; the output is shown as `M-!` shows it. With a prefix argument
  (`C-u M-|`) the region is replaced.
- **Filters.** `C-u M-|`, `:{range}!CMD`, the `!` operator and `C-u M-!` change the text only when all of these
  hold: the command exited 0, it was not killed, its output was UTF-8 (decoded strictly) and within 16 MiB,
  and the buffer did not change while it ran (a timer's edit, a shared note's remote edit). Otherwise the
  text is left as it was, the output and error go to `*Shell Command Output*`, and the echo area says why,
  ending `; the text is left as it was`. Only the standard output replaces the text: the error never enters
  it, and when the command succeeded the error's first line is shown in the echo area. A read-only buffer is
  refused before anything runs. The replacement is one undo step. Whole-line filters put point on the first
  non-blank of the first line, and a last line with no newline stays without one.
- **`:!` and the `!` operator.** `:!CMD` runs CMD as `M-!` does; `:{range}!CMD` filters those lines
  (`evil-ex-shell-command`). Everything after the `!` is the shell line: the ex parser now takes a leading `!`
  as the command name by itself, so `:!~/bin/x`, `:!<f` or `:!=` are not read as other ex names. `!{motion}`
  (and `!!`, `3!!`) reads the motion, as `>` does, puts point on its first line and opens the ex line with
  `.,.+N!` (`.!` for one line); in Visual state `!` opens it with `'<,'>!`. The command typed after that runs
  as `:{range}!`, with the ex history.
- **Choices and differences from Emacs and Vim:**
  - The shell is `sh`, not `$SHELL` or `shell-file-name`. The plan's "the user's shell" is read as "a shell
    line the user typed": the owner's login shell is nushell, where `sort` is a builtin over structured data,
    so `nu -c sort` would not sort a region's lines. These are POSIX lines, as compile's are.
  - A filter replaces only on exit 0 and only with standard output; Emacs and Vim replace on any exit and
    merge the error in. `C-u M-!` inserts under the same rule; Emacs inserts whatever came.
  - The output is shown in the echo area only when it is one line, not when it fits a resized echo area.
    `*Shell Command Output*` is in fundamental mode, as in Emacs.
  - `M-&` with one running asks to kill it, as compile does; Emacs asks to use a new buffer
    (`async-shell-command-buffer`). There is one `*Async Shell Command*`, its output not an interactive shell
    (no comint input), and it ends with a status line Emacs puts in the echo area instead.
  - The `!` operator opens the ex line, as Vim does; evil reads `!` from its own prompt. Its `.` repeat is
    off.
- **Not in it:** `:!!` (repeat the last shell command) and `%`/`#` expansion to the file name in `:!`; `:r
  !CMD` and `:w !CMD`; `shell-command-on-region`'s error buffer argument and `shell-command-default-error-buffer`;
  `shell-mode`/comint input to `*Async Shell Command*`; `$SHELL`. The server's `shell-command-to-string` and
  `call-process` (scm/process.scm, on the hub) are untouched.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-shell-command`, `test/shell-command.test.mts`
  (8). `C-u M-|` with `sort` over a region in Emacs state replaces it: argv `['sh', '-c', 'sort']`, the
  program's directory, error not merged, strict decoding, `TERM=dumb`, point and mark around the output, one
  `C-/` bringing the text back. `M-|` without the prefix shows `apple` and leaves the text. `M-!` reached from
  Normal state. A failing filter (`exit 3`), a 0xFF byte, a child killed by TERM and 17 MB of output each leave
  the text and the modified flag as they were, with the reason in the echo area and the failing sort's output in
  `*Shell Command Output*`. `:%!` failing leaves it too. A sort writing to its error replaces the text with its
  output only, the error in the echo area. A timer's edit during `sleep 0.3; sort` stops the replacement. A
  read-only buffer is refused with nothing spawned, from Scheme and from `:%!`. A failing filter in `*Shell
  Command Output*` itself keeps its text. `:1,3!sort`, `!j` (the ex line `.,.+1!`, point on the first line),
  `2!!` with `tac`, `V j !` (`'<,'>!`), a last line without a newline kept so, and `:!~/no-such-program` taken
  whole (exit 127). `M-!` shows one line in the echo area with no window, stdin `/dev/null`, merged and lossy;
  three lines with exit 4 shown in another window, unselected, with the status in the echo area; no output, a
  failure with no output, colours dropped; `C-u M-!` inserting at point only on exit 0; `(shell-command ...)`
  and `:!echo` shown, not inserted. C-g during `M-! sleep 30` kills the child, says Quit, and the next `M-!`
  runs. `M-&` streams (the first line before the second), read-only, unselected, no header, the status line,
  `compile-command` and the error list untouched. `M-! echo bg &` runs async. `C-c C-k` gives `Shell command
  interrupted`, and killing the buffer kills its child. Every entry evaluated inside `Ed.proc.replay` is refused
  with process-error, and so is `(evil-ex-execute "%!sort")` (reported), with nothing spawned and the text
  unchanged. In a web frame and with no `host.proc`, `M-!`, `M-&`, `M-|`, `!` and `:%!` refuse before any
  minibuffer and nothing spawns.
  Also passed: `edwin-compile` (39), `edwin-typecheck`, `edwin-headless` (21), `edwin-native` (31),
  `edwin-scheme` (38), `edit-security` (21) and `edit-lockdown` (6) (scm/emacs.scm, scm/evil.scm and
  compile.ts also load on edwind, where every one of these commands refuses since it has no `host.proc`),
  `edit-grep` (14), `edwin-next-error` (12), `edwin-proc` (6), `nix build .#edwin` (unit 22, `tests/gui.rs` 5
  with 1 ignored, `tests/terminal.rs` 35; its first run failed only at Xvfb startup under a load of 9.6, and the
  rerun passed), and `nix flake check`. After the last fix (a failing filter in `*Shell Command Output*` keeps
  its text) `edwin-shell-command`, `edwin-typecheck` and `edwin-compile` were run again and passed. `nix build
  .#edwin` and `nix flake check` were not run again for it.

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

## direnv for child processes (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `proc-direnv`, on proc-shell-command): `Ed.proc.envFor(dir)`
asks direnv for the directory's environment, kept per .envrc modification time, for compile, grep, formatters and
language servers. Risk named: direnv runs project code only where the owner already allowed it; Edwin never calls
`direnv allow`.

- **`Ed.proc.envFor(dir)`** (src/proc.ts) finds the nearest `.envrc` from DIR up through the host's files
  (`host.files.stamp`) and runs `direnv export json` there, through `Ed.proc.spawn`, so the image's replay gate and
  the web frame's and edwind's refusals apply as to any child; it refuses at once, before any wait, as before.
  What direnv prints on exit 0 is the change set (a value of `null` unsets the variable), which callers pass as
  `env`. compile, grep and the shell commands already did (proc-compile, proc-shell-command), so they now run in
  the project's direnv environment with no change of their own.
- **The plain environment** (`{}`) when there is no `.envrc` from DIR up (direnv is not run at all), when direnv
  is not on PATH or DIR is gone (nothing said; the caller's own child says a missing directory), and when direnv
  fails: a blocked `.envrc` exits 1 and still prints its own `DIRENV_` variables, none of which is used, and the
  echo area gets direnv's error line without its colours, ``direnv: error /p/.envrc is blocked. Run `direnv
  allow` to approve its content; the plain environment is used``. Output that is not a JSON object of strings and
  nulls, and a direnv that takes over 120 s (killed), say so in the same way. Only direnv's own `direnv: error`
  line is ever shown: a failure without one says `direnv ended with code N`, never another line of the error
  output, which is the `.envrc`'s own and may print a token (the echo area is logged in *Messages*). After a
  second a load still going says `direnv: loading /p/.envrc`, and the note is cleared when the load ends unless
  something else was said since.
- **C-g stops it.** A command awaiting a promise holds every key (pool.ts), so compile, grep and the shell
  commands would otherwise freeze the frame for as long as direnv takes, up to the 120 s. The wait is
  `EdPool.interruptible`: C-g kills direnv and the command quits (`Quit`), its own child never started. Nothing
  is kept, and the stopped run is forgotten at once, so an ask made before the killed direnv has ended starts a
  direnv of its own. Every envFor wait is interruptible, so C-g quits every caller sharing a run; a stopped run
  never resolves to the plain environment (it is a process-error for any caller still waiting).
- **Kept** per directory with the `.envrc`'s stamp (inode, modification time, size), in this frame's memory only:
  never storage, the image, edwind or a log, since an `.envrc` often exports tokens, and each caller gets its own
  copy. Two asks for one directory and `.envrc` at once run direnv once. Only an allowed `.envrc`'s result is kept, so a
  blocked one is asked again each time and works as soon as the owner runs `direnv allow` in a shell, without
  touching the file.
- **Choices**, each reversible:
  - direnv's own `DIRENV_DIR`, `DIRENV_FILE`, `DIRENV_DIFF` and `DIRENV_WATCHES` are passed on, as a shell with
    the direnv hook would have them, so a child that runs direnv itself sees the environment as loaded.
  - The key is the `.envrc` alone, as the package says: a file it watches (`watch_file`, a flake.lock under
    nix-direnv) changing, or `direnv deny`, takes effect when the `.envrc` changes or in a new frame. A host
    whose files give no stamp asks direnv every time.
  - direnv from PATH (the frame's: the program's own, the unit's for frames edwind's unit starts); no pinned
    path. Timeout 120 s, long enough for nix-direnv building a shell the first time.
- **Not in it:** formatters and language servers (lang-format, lsp-*) do not exist yet; they get the
  environment by calling `Ed.proc.envFor` as compile does. No `.env` files (direnv's `load_dotenv`), no `direnv
  allow`, `deny` or `reload` command, no mode-line indicator. With no `.envrc` above DIR direnv is not asked, so
  a frame started from a shell that had direnv loaded for another project keeps that project's environment for
  its children there.
- **Checked by** `nix build .#checks.x86_64-linux.edwin-proc` (now with direnv on the suite's PATH), 13 passed,
  against a stand-in direnv first on PATH that keeps direnv 2.38's protocol (its blocked output measured on
  ex44 with a throwaway HOME): an allowed `.envrc` puts its bin first on PATH and a program only there runs, by
  `Ed.proc.run` with the environment and through `compile`, and not without it; no `.envrc` up from a directory
  runs no direnv; every call is exactly `direnv export json` in DIR; two asks at once run direnv once; a caller
  changing its copy changes nothing kept; a kept directory runs no direnv again until its `.envrc` is rewritten
  with a later time; a load past a second shows the loading note and clears it when done, a quick one says
  nothing; one past the timeout (the suite shortens the 120 s envFor asks to 300 ms in its stand-in host) is said,
  killed and not kept; C-g during a 60 s direnv rejects envFor with quit and kills it, an ask made at once after
  starts a direnv of its own, and through M-! in a
  buffer under the `.envrc` the command ends with `Quit`, its shell never started, and the next M-! loads the
  environment and runs a program only its PATH has (these three cases failed against the first version of this
  package, the C-g one by waiting the whole 60 s); a failing `.envrc` whose error output has no `direnv: error`
  line shows `direnv ended with code 1` and its output reaches neither the echo area nor *Messages*; a blocked
  `.envrc` gives `{}` (not its `DIRENV_` variables), says direnv's error, compile's
  program is not found, and it is asked again and loads once a marker says it is allowed; unreadable output is
  said; no direnv on PATH gives `{}`; an empty directory is refused, and so is envFor in `Ed.proc.replay`, with
  nothing spawned. And against the real direnv with a throwaway HOME and XDG directories: a blocked `.envrc`
  that would touch a file gives `{}` and the error line, and the file is not there. A `null` (unset) reaches the
  desktop program's spawn as a removal: natives.rs maps null to None and native/src/proc.rs calls `env_remove`
  (read, not run in the program). `edit-grep` failed at first, 13 of 14: its count of stamps per grep ("each
  file once", 3000) now also met the `.envrc` look from the search's directory up, one stamp per level; the count
  leaves out `.envrc` stamps and it passed, 14. Also passed: `edwin-typecheck`, `edwin-compile` (39),
  `edwin-shell-command` (8), `edwin-headless` (21), `edwin-native` (31), `edit-lockdown` (6), `edit-security`
  (21), `nix flake check --keep-going` and `nix build .#edwin` (unit 22, `tests/gui.rs` 5 with 1 ignored,
  `tests/terminal.rs` 35). All of these were run again after the C-g fix, with the same counts; in that
  `nix flake check --keep-going` only `edwin-bench` failed (the shadow stack's cost past its 10% limit, a timing
  under load on ex44, in the Scheme evaluator this package does not touch), and run again alone it passed (7.8%).

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

## Running git and jj (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-runner`, on proc-frame-api and git-message-modes; owner
decision 12): the one way Edwin runs git and jj. Every later git and jj package (status, stage, commit, log, the
jj views) starts its children here, never through `Ed.proc` directly.

- **`Vc.repo(dir)`** (src/vc.ts) gives the repository an absolute directory is in, `{vcs, root}`: the nearest
  directory up from it that holds `.jj` (a jj workspace, colocated or not) or `.git` (a directory, or a worktree's
  or submodule's file), `.jj` first, so a colocated workspace is jj's and a git repository inside a jj workspace is
  git's. It reads the file system through `host.files.tree` and runs nothing, so nothing a repository holds can run
  while it is found; null outside a repository and where the host has no file tree (a web frame, edwind). The
  package text's "host.vcs" is read as this: no new host surface, the processes stay `host.proc`'s through
  `Ed.proc`, so its refusals apply unchanged.
- **`Vc.start(repo, args, opts)`** gives the running child (as `Ed.proc.spawn` does) and **`Vc.run(repo, args,
  opts)`** its whole output, error and exit. Only `git` and `jj` run; ARGS starts with a subcommand name (so no
  global option of the caller's comes before or after Vc's); the child runs in the root, with an environment Vc
  fixes (OPTS can give timeout, maxBytes, lossy, merge, onOut, onErr and input, not cwd or env). The replay
  refusal is checked before anything that waits (`Ed.proc.refusal()`, new), so a call from the image's replay
  starts nothing, at once or after awaits in the same turn.
- **git's hardening.** Every subcommand gets `--no-pager -c core.fsmonitor=false -c core.pager=cat -c
  diff.external= -c alias.SUB=` (SUB the subcommand: git runs a builtin by its name, but looks any other name up
  as the repository's `alias.NAME`, a shell command when it starts with `!`; with the alias emptied git refuses
  the name, `expansion of alias failed`, so a name that is no builtin, a typo or a subcommand an older git
  lacks, runs nothing), and `-c core.hooksPath=/dev/null` unless it is commit, push or the sequencer (merge, rebase,
  cherry-pick, revert, am), which keep the repository's hooks; a subcommand named nowhere gets no hooks. Every
  subcommand is a read unless it is on the write list (commit, push, the sequencer and add, apply, bisect, branch,
  checkout, checkout-index, clean, clone, fetch, hash-object, init, ls-remote, merge-file, mv, notes, pull,
  read-tree, remote, reset, restore, rm, stash, submodule, switch, tag, update-index, worktree: they change the
  work tree, the index, the history or a remote, and keep the repository's drivers, signature programs and
  transport). A read, a name on no list included (reflog, annotate, format-patch, range-diff, grep, verify-commit),
  also gets:
  - `--no-lazy-fetch` (right after `--no-pager`): a partial clone fetches no object it lacks, so a read never runs
    the remote's transport, its core.sshCommand, `remote.*.uploadpack` or credential helper. git passes it on to the
    gits it runs (as GIT_NO_LAZY_FETCH). A git too old to know the switch refuses it and runs nothing. `-c
    protocol.allow=never` stays, but it does not stop such a fetch alone: git gives a repository's
    `protocol.NAME.allow=always` (ext, ssh) precedence over it from any scope.
  - `-c log.showSignature=false`, and each signature program the repository's own configuration names
    (`gpg.program`, `gpg.openpgp.program`, `gpg.ssh.program`, `gpg.x509.program`) set back to the user's (the last
    value from global, system or command scope; git's `gpg`, `ssh-keygen` or `gpgsm` when none). A format such as
    `%G?`, `%GS` or `%GK` verifies the commit's signature with the program of its format, which log.showSignature
    does not cover.
  - each filter driver the repository's own configuration declares (local and worktree scope, include.path files
    included) emptied: `-c filter.NAME.clean= -c filter.NAME.smudge= -c filter.NAME.process= -c
    filter.NAME.required=false`; and each merge driver it declares emptied, `-c merge.NAME.driver=`: `show
    --remerge-diff`, `log --remerge-diff` or `--diff-merges=remerge`, and `-m` or `--diff-merges=on` under a
    `log.diffMerges=remerge` (the repository's or the user's), merge a merge commit's parents again, with the
    driver the `merge` attribute names for each conflicting file. With the driver emptied git fails to run the
    empty command (`error: cannot run : No such file or directory` in *vc-process*), keeps the file as `remerge
    CONFLICT`, shows the diff and exits 0. Each diff driver it declares is emptied too, `-c diff.NAME.textconv=
    -c diff.NAME.command=`: `status -v` prints a diff with the textconv driver and takes no `--no-textconv`. git
    then fails to run the empty program, so `status -v` in such a repository exits 128 and runs nothing. Drivers
    and signature programs are read first, in one `git config --show-scope --null --get-regexp
    '^(filter|merge|diff|gpg|mailmap)\.'` (a driver's key has three parts; merge's and diff's own settings,
    merge.conflictStyle, diff.external, two).
  - the repository's own `mailmap.file` (added by git-blame) set back to the user's (`-c mailmap.file=`, empty
    when the user names none): blame and log read that file, and a FIFO there hangs them.
  - after the subcommand: diff, show, log, diff-tree, diff-files and diff-index get `--no-ext-diff --no-textconv
    --submodule=short`; status, diff, diff-files and diff-index `--ignore-submodules=dirty`; blame and annotate
    `--no-textconv --no-ignore-revs-file` (the second added by git-blame); grep `--no-textconv
    --no-recurse-submodules` (added by git-todos). A read with no such switch (`reflog -p`, `range-diff`) is held by the emptied diff drivers:
    git fails to run the empty textconv program (`reflog -p` exits 128) rather than run the repository's.
    The submodule switches keep a read out of a submodule's work tree: the git that would look there runs under
    the submodule's own configuration, and its filter drivers are not the superproject's to empty. On the command
    line they beat a repository's `submodule.NAME.ignore` and `diff.submodule=diff`. describe has no such switch
    and reads no diff.ignoreSubmodules, and its `--dirty` and `--broken` compare a submodule's work tree (through
    its clean filter) when the submodule's commit has not moved, so those two are refused (below); `describe`
    itself looks at no work tree.

  The environment:
  GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0, GIT_EDITOR=false and GIT_SEQUENCE_EDITOR=false (a repository's
  sequence.editor beats GIT_EDITOR; a rebase has the frame as both since the interactive rebase's section), GIT_PAGER=cat, no GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE from Edwin's own
  environment, and LC_MESSAGES=C with LC_ALL and LANGUAGE unset, so git's messages are English.
- **safe.directory.** Vc never sets it. A repository git refuses as owned by someone else (`detected dubious
  ownership`, exit 128) is shown as such: the exit rejects with a user-error `git refuses ROOT as unsafe: it
  belongs to another user (safe.directory)`, said in the echo area too, and nothing is retried.
- **jj's hardening.** Every subcommand gets `--no-pager --color=never --config ui.diff-formatter=:git` (no external
  diff tool) and, since git-jj-log, `--config ui.log-word-wrap=false` (a user's word wrap breaks a template's
  lines at their spaces even with no terminal), JJ_EDITOR=false and GIT_TERMINAL_PROMPT=0. The plan's "fixed templates" are the callers': Vc sets
  none, and every jj call whose output is parsed (git-status-view, git-jj-log and after) gives its own `-T`, so a
  user's `templates.*` settings never change what is parsed. A template runs no program. jj 0.45 keeps a
  repository's settings beside the user's config, out of the repository, but adopts for good a
  `.jj/repo/config.toml` or `.jj/workspace-config.toml` it finds in the repository with no config id beside it
  (checked on the pinned jujutsu: it moves the file beside the user's config and runs its diff tool). Vc looks for
  that first (through a secondary workspace's `.jj/repo` file too) and refuses, running nothing: `jj not run in
  ROOT: FILE is jj settings the repository brings, which jj would take as yours for good (they may run programs).
  Look at them, then run jj there once in a terminal to take them`.
- **Switches that would undo it** are refused before a `--`: `--ext-diff`, `--textconv`, `--paginate`,
  `--show-signature`, `--submodule`, `--ignore-submodules` and `--recurse-submodules` (git takes the last of a
  switch given twice, and `ls-files --recurse-submodules` reads inside submodules), and `--dirty` and `--broken`
  (describe's, which look into a submodule's work tree) for git, and for git any prefix
  of one of them too (`--textc`, `--ignore-sub=none`, `--dirt`): status, cat-file, ls-files and other subcommands take a
  long switch by a prefix, so `--text` is refused as well and a caller says `-a`; `--config`, `--config-file`, `--config-toml`, `--color`, `--tool`, and `-R` and
  `--repository` (another repository than the one looked at) for jj. A caller puts what the user typed (revisions,
  paths) after a `--`.
- **Refused subcommands:** `difftool`, `mergetool`, `help`, `instaweb` and `web--browse` start nothing: each runs a
  program the repository's configuration names (`difftool.NAME.cmd`, `mergetool.NAME.cmd`, `man.NAME.cmd`,
  `browser.NAME.cmd`) and no setting turns that off. `whatchanged` (deprecated) runs nothing either: git 2.55
  looks its name up as an alias first, which Vc empties.
- **`*vc-process*`** logs every child: `$ ` and its whole argv (quoted where a shell would need it), its id and
  root, then its error output (the first 8 KiB) and how it ended (`exit N`, `killed by SIG`, `timed out`, `stopped:
  ...`). Nothing from the environment. The buffer is read-only, never modified, keeps no undo and keeps its last
  256 KiB from a line's start.
- **`edwin-vc`** (nix/checks.nix) uses the existing `suiteWith` (programs on PATH) to bring nixpkgs' git and jujutsu, so the jj option names tested are those of that jujutsu (0.45.1).
- **Choices**, each reversible:
  - Filter drivers are emptied only for read subcommands and only when the repository's own configuration
    declares them: the user's global ones (git-lfs) stay, and add, commit, checkout and the rest keep the
    repository's filters, as the owner expects for writes. The cost: in a repository whose own config declares its
    filter (git-crypt), the read views show what is stored, not the decrypted text; one whose own config declares
    `filter.lfs.*` (`git lfs install --local`) loses LFS in them, so a pointer file whose time changed shows as
    modified.
  - Merge drivers the same way: a repository whose own config declares one gets a plain text merge where a remerge
    diff would have used it, with git's `cannot run` error line in *vc-process*. Refusing `--remerge-diff` and
    `--diff-merges` instead would still have left `-m` under a `log.diffMerges=remerge`, and a log view may well
    pass `-m` or `--diff-merges=first-parent`.
  - Each read subcommand runs one `git config` first to find those drivers and programs (about 2 ms); nothing is
    cached, so a config changed between two reads is never missed.
  - `describe --dirty` and `--broken` are refused rather than made safe: git has no switch that keeps describe out
    of a submodule's work tree, and `-c submodule.NAME.ignore=all` would need the submodules listed first. A
    package that wants a dirty mark reads status, which `--ignore-submodules=dirty` covers.
  - The subcommand is not checked against a list of git's builtins; its alias is emptied instead, so the rule is
    git's own (a builtin runs, anything else is refused) and holds for a subcommand this git lacks. A `git-NAME`
    program on PATH or in git's exec path still runs for a non-builtin NAME: those are the user's programs, not
    the repository's.
  - A repository's own signature program is replaced, not refused: the read views still show a signature's status,
    checked by the user's program.
  - Submodules show in the read views by their commit only, unlike magit: a submodule whose work tree has changes
    but whose commit has not moved shows as unchanged, and a moved one as `Subproject commit` lines, not as the
    diff inside it. Looking inside would run a git under the submodule's configuration.
  - In a partial clone a read of an object the clone lacks fails (git's `missing blob` error, in *vc-process*);
    a fetch (git-remote) or a write that fetches brings it.
  - A jj repository's own settings are refused, not overridden key by key: jj would keep them for good, and a
    setting such as a signing program would run on the next describe whatever Vc overrides. The plan allowed a
    prompt; a refusal is stricter and simpler, and a question asked from outside a running command (a refresh, a
    timer, two jj calls at once) would contend with the command loop for the next key. The user takes the settings
    by running jj there once in a terminal; Vc then runs, and its `ui.diff-formatter=:git` still holds.
  - Output is UTF-8 as Ed.proc gives it (a child whose output is not is stopped) unless the caller passes `lossy`:
    the views (git-status-view, git-log-show) choose for their own commands; a patch built from a diff must not be
    lossy.
- **Not in it:** no command uses the runner yet (git-status-view is the first); no status view, so no
  desktop-only stub goes. `git stash show -p` is a write here (stash is on the write list, by its other
  subcommands) and so runs the repository's textconv driver: a package that shows a stash runs `diff` or `show`
  on it instead. `range-diff` and `format-patch` get no `--no-ext-diff`/`--no-textconv`/submodule switches (a
  package that runs them adds them; the emptied drivers hold meanwhile). `--output=FILE` on diff, log and show is
  not refused: a caller's switch, not the repository's. jj's own git calls (`jj git fetch`, `push`) run git
  under the repository's git config: git-jj-remote decides their hardening. No version floor for git or jj but
  that git knows `--no-lazy-fetch` (one that does not refuses every read).
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (test/vc.test.mts, 20 passed: the 7 of the
  message buffer and 13 of the runner): Vc.repo from a subdirectory, a colocated jj workspace found as jj, a git
  repository inside a jj workspace, a worktree's .git file, none outside one or without a file tree; git status
  (porcelain v2) and jj status with the exact argv (`alias.status=` in it), root and environment, `--no-lazy-fetch`, the driver and signature query first, the diff
  and submodule switches after the subcommand, a jj fixed template, Vc.start's running child; hg, sh, a relative root, a global
  option as the subcommand, `--ext-diff`, `--textconv`, `--ignore-submodules(=none)`, `--submodule=diff`,
  `--recurse-submodules`, describe's `--dirty`, `--dirty=*` and `--broken`, the prefixes `--ignore-sub=none`, `--recurse`, `--textc`, `--text`, `--show-sig` and `--dirt`, jj's `--config=`, `--tool`, `-R`, `-RPATH` and
  `--repository=` refused with no child started, `--ext-diff` after `--` taken as a path; a hostile git fixture
  whose .git/config names marker scripts as core.fsmonitor, core.pager, diff.external, diff.evil.command and
  textconv, filter.evil.clean, smudge and process, gpg.program (log.showSignature on) and, through include.path,
  filter.inc.clean: plain git on it runs fsmonitor, the diff command, textconv, the process filter and the included
  clean filter (the control), and status, diff, log -p and show through Vc exit 0 and run none, the diff still
  shown; the pager on a terminal: plain git log and show under util-linux `script` run core.pager (the control),
  the argv and environment Vc gave log and show, run again under `script`, run nothing of the repository's
  (through Vc itself git writes to a pipe and starts no pager either way); post-checkout runs for plain checkout
  and not through Vc, pre-commit runs for commit through Vc; signature programs: three commits with an OpenPGP,
  an SSH and an x509 signature header and the repository's gpg.program, gpg.ssh.program and gpg.x509.program as
  marker scripts: plain `git log --format=%G?` runs each format's and plain `git log` (log.showSignature) the
  OpenPGP one (the control), and through Vc `%G?` for each, log and show run none; with a global gpg.program the
  read runs the user's program and the argv sets all four keys back; a `--filter=blob:none` clone whose origin is
  `ext::sh -c touch% MARKER` with `protocol.ext.allow=always`: plain git show HEAD~1 runs it (the control), and
  show, log -p, diff HEAD~1 HEAD and cat-file through Vc do not; a superproject whose submodule's own config sets
  a marker clean filter and textconv: with the submodule's file changed and its commit in place, plain `describe
  --dirty` and `--broken` run the clean filter (the control), through Vc both are refused with no child and
  `describe --tags` runs nothing and gives the tag; then the submodule moved on a commit and changed again,
  diff.submodule=diff: plain status runs the clean filter (the control), status, diff, diff-files -p, diff-index
  -p, log -p and show through Vc run nothing, status shows the submodule's new commit and diff its `Subproject
  commit` lines; a repository with a merge commit whose parents conflict on a file with `merge=evil`, and
  merge.evil.driver a marker script: plain `show --remerge-diff`, and plain `log -p -m -1` once
  log.diffMerges=remerge is set, run the driver (the control), and `show --remerge-diff`, `log -p --remerge-diff
  -1`, `log -p --diff-merges=remerge -1`, `log -p -m -1` and `show -m` through Vc exit 0, run nothing, show the
  `remerge CONFLICT` line and carry `merge.evil.driver=`; a repository whose config sets shell aliases `zz`, `st`
  and `status` to marker scripts: plain `git zz` and `git st` run them (the control), through Vc `zz` and `st`
  fail with git's `expansion of alias failed`, running nothing, and status is git's own. Run against the code
  before the review fixes, the signature, partial-clone, submodule, describe, merge-driver and alias cases fail
  (the pager case passes there too: the hardening it proves was already in place); a  hostile jj fixture with a planted .jj/repo/config.toml (pager and diff-formatter scripts): plain jj on a copy
  adopts it and runs the diff tool (the control), Vc refuses it from the workspace, from a secondary workspace and
  for a planted .jj/workspace-config.toml, starting nothing and leaving the file where it was; once plain jj has
  taken it, status, diff, log -p and show through Vc run no tool of it and diff is git's format; an unsafe
  repository (GIT_TEST_ASSUME_DIFFERENT_OWNER) refused as unsafe with one status, no retry, no safe.directory, the
  message in the echo area and git's in *vc-process* (the suite sets a German LC_ALL, but the sandbox likely has no
  German locale data, so this shows the environment Vc sets more than locale independence); under
  Ed.proc.replay, Vc.run of git and jj, Vc.start of commit and a run after two awaits all refused with no child,
  and without host.proc refused; *vc-process*'s argv, id, root, error output and exit, shell quoting, read-only
  with no undo, and kept to 256 KiB from a line's start after 30 runs of 10,000-character arguments.
  `edwin-typecheck`, `edwin-proc` (6), `edit-lockdown` (6) and `edit-security` (21) passed, re-run after the review fixes.
  After the third review's fix (diff drivers emptied; a `status -v` case in the hostile-repository test, whose
  control runs the textconv driver): `edwin-vc` (20) and `nix flake check` passed, every check (`nix build .#edwin`'s
  GUI test failed once at Xvfb startup, then passed on rerun).
  After the fourth review: the submodule test's controls now compare the file's content every time. They had
  failed about one run in eight: the changed file's size differed from its index entry's, so plain git called it
  changed unread and ran the clean filter only when the entry was racily clean. A new case covers reads on no list:
  plain `reflog -p` and `annotate` run the textconv driver, and through Vc they run nothing. A name on no list is a
  read and `add` is a write. Plain `difftool -y`, `difftool HEAD~1 -- a.txt`, `mergetool` (a conflicted merge)
  and `help log` run the repository's tool, man viewer and merge tool. Through Vc, those and `instaweb` and
  `web--browse` are refused with no child started. That case fails against the code before this fix.
  `node --test test/vc.test.mts` passed 60 of 60 runs (21 tests), and the superproject case alone 100 of 100,
  where it had failed 4 of 30 before the fix. `edwin-vc` passed on one build and five `--rebuild` runs, and
  `edwin-typecheck` passed. `nix flake check` failed once, only in `nix build .#edwin`'s gui test (Xvfb did not
  start, so edwin-daemon failed with it), and passed on its rerun.
  Before the review fixes: `nix build .#edwin`: unit tests 22 passed, `tests/gui.rs` 5 passed
  and 1 ignored, `tests/terminal.rs` 35 passed. `nix flake check --keep-going`: every check passed but
  `edwin-bench`, which failed on the shadow-stack budget (19.4% against 10%) while edwin-crash and `nix build
  .#edwin` ran beside it; run again alone it passed (8.6%, generator mode 1.17x). This package does not touch the
  evaluator. Among the passes: `edit-lockdown` 6, `edit-security` 21, `edit-frame` 24, `edit-image` 15,
  `edit-console` 4 (vc.ts loads in edwind, ex44's public one included, where there is no host.proc and no file
  tree: Vc.repo gives null and Vc.start refuses, so no server capability is added).

## Diffs as files and hunks, and partial patches (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-diff-model`, on git-runner): parse unified diffs into
files and hunks and build the partial patches staging applies. The status buffer (git-status-view) shows what
`VcDiff.parse` gives; `s`, `u` and `x` on a file, a hunk or a region (git-stage) apply what `VcDiff.patch` builds.

- **`VcDiff.parse(text)`** (src/vc-diff.ts, new, through the seven places of the touch list, after `vc`; the
  global `VcDiff`) reads what `git diff` prints, and `jj diff --git`, into files: `oldPath` and `newPath`
  (unprefixed and unquoted, null for /dev/null), `status` (modified, added, deleted, renamed, copied, unmerged),
  `oldMode` and `newMode`, `binary`, the `header` lines, the `hunks` and `text`, the file's part of the diff as
  given. A hunk has its @@ line, its starts and counts (an omitted count is 1), and its `lines`, each keeping its
  first character (` `, `-`, `+`, `\`). A hunk is read by the counts of its @@ line, never by what its lines look
  like: a removed `-- x` prints as `--- x`, and a file's line can read `diff --git` or `@@`. A text that is not a
  diff of this shape signals `error` with the line, rather than giving a part of it.
- **`VcDiff.gitArgs`** are the switches a git diff for parse is taken with, after the runner's own: `--no-color
  --src-prefix=a/ --dst-prefix=b/ --no-relative --unified=3 --inter-hunk-context=0`, so the user's or the
  repository's color.diff, diff.noprefix, diff.mnemonicPrefix, diff.relative, diff.context and diff.interHunkContext
  cannot change the shape (with diff.context = 0 every patch, even a whole file's, would fail `git apply`; a -U on
  the command line beats it). diff.algorithm and diff.indentHeuristic still choose which lines pair up, which
  every patch built here survives. A blank context line (diff.suppressBlankEmpty) is read as the context line
  it is, and a C-quoted name (core.quotePath, or a quote, backslash or control character in it) is unquoted, its
  escaped bytes read as UTF-8. A name whose bytes are not UTF-8 is shown one character per byte and the file marked
  `notUtf8`: written back that name would be another file's, so only the whole file, as git printed it, is picked.
- **`VcDiff.patch(files, picks, reverse)`** gives the patch for PICKS, each `{file}` (the whole file), `{file,
  hunk}` or `{file, hunk, lines}` (lines by their index in the hunk's lines), to be applied forwards or, REVERSE,
  with `--reverse`: `git apply --cached` stages a pick of `git diff`, `git apply --cached --reverse` unstages one of
  `git diff --cached`, and `git apply --reverse` discards one of `git diff` from the work tree. Null when nothing is
  picked (git apply refuses empty input). Forwards, a change not picked stays as it was before: a removed line
  becomes context and an added one goes; reversed, it stays as it is after: an added line becomes context and a
  removed one goes. The side the patch is applied to keeps every line, so its starts stand, and the other side's
  move by what the hunks kept before give or take; the counts are the lines written (no `--recount` needed).
- **Choices**, each reversible:
  - A pick that takes every change of a file (all its hunks, or all their lines) is the whole file, given as git
    printed it: its rename, copy, mode change, creation or deletion go with it.
  - A partial pick carries content only, on the path the patch is applied to (the old one forwards, the new one
    reversed): a rename, copy or mode change is not carried, so unstaging a hunk of a staged rename keeps the
    rename staged. A new file staged in part is still created with the lines picked (an intent-to-add entry takes
    it), and unstaged in part it stays with the lines not picked; a deleted file the other way round.
  - Refused with `user-error`: a copy staged in part (its lines belong to a file the patch would have to create
    whole); a pick that would leave a line with no newline before another (a `\ No newline at end of file` line
    whose change is not picked while a change after it is: the result cannot be a file, so the user picks both);
    a binary file whose diff has no data (take it with `--binary`); a conflicted file (`diff --cc`, `* Unmerged
    path`), which is parsed and shown but has no patch. A hunk of a binary file, a mode change or a pure rename
    cannot be picked: they have none, so only the whole file.
  - A `diff --git` line names the file only where no ---/+++ or rename line does (an empty file added or
    deleted, a mode change): unquoted names with spaces are split where the two agree.
  - Picks out of range signal `args-out-of-range`; context lines picked mean nothing, and a hunk with no change
    picked is left out.
- **Not in it:** no buffer, command or key (git-status-view and git-stage). `apply` is on the runner's write
  list, so the user's or the repository's apply.whitespace still applies to these patches: `fix` would change what
  is staged, so git-stage should pass `--whitespace=nowarn`; no word diff, `--color-moved` or
  combined-diff hunks (a conflicted file is whole-only and has no patch); copies need `-C` or diff.renames=copies.
  A text file that is not UTF-8: `Ed.proc` decodes strictly, so its diff fails as the runner reports, and a
  lossy decode would corrupt the patch, so callers keep the strict one. The hunk's function context after the @@
  is kept in `header` but not written into partial patches.
- **Image replay and edwind.** Pure text: nothing here runs a process, so it adds no capability. vc-diff.ts loads
  in edwind too (host-node.cts), ex44's public one included, where it is a parser nothing calls.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (37 passed: git-runner's 21 and
  test/vc-diff.test.mts's 16; edwin-vc is now its own derivation, so fast-check's NODE_PATH reaches this suite
  alone and not the edwind ones), under a throwaway HOME whose .gitconfig sets color.ui and color.diff always,
  diff.noprefix, diff.mnemonicPrefix, diff.suppressBlankEmpty, diff.relative, diff.context = 0 and
  diff.interHunkContext = 10:
  - A hand-written diff parsed: removed and added lines that read `--- x`, `+++ y`, `@@ -1 +1 @@`, `diff --git`
    and `\ ...`, a blank context line, an omitted count, a quoted UTF-8 name with a quote and a space, a rename with
    spaces and no hunk, a mode change, an empty file deleted, a binary file, `diff --cc` and `* Unmerged path`;
    each file's text is its part, and five malformed texts are refused.
  - The control: plain `git diff` under that configuration is coloured and has no prefixes. The same diff
    through Vc with gitArgs parses. Another control: plain `git diff` there gives zero-context hunks; through Vc
    with gitArgs the same change (lines 3-4 and 21 of 30) gives two hunks of three context lines each side, and a
    line, a hunk and the whole file of it each pass `git apply --cached --check`. `jj diff --git` parses: a hunk with no newline at the end, an added file.
  - Picks: null for no pick or for context lines only; refused for picks out of range, a copy staged in part, a
    binary file without data, and a name that is not UTF-8 picked in part (the whole file is given as printed); a
    copy unstaged in part is rewritten to its new path; the no-newline refusal, and the pick beside it that is
    allowed.
  - The property (fast-check, 100 runs each; `VCDIFF_RUNS` raises it, and `VCDIFF_SEED` with `VCDIFF_PATH`
    replays a failure). Up to four files, named with a space, a quote, a tab, a backslash, a UTF-8 letter and a
    directory. Each is changed, added (intent-to-add when staged or discarded), deleted, renamed (unstaging only: a
    work tree has no renames against the index), changed in mode with or without content, or binary. Lines read
    like diff syntax, with CR and blank lines, with and without a final newline. The diff runs through Vc.run
    with gitArgs and `--binary`, and its hunks take each file's old text to its new one. Picks are random: whole
    files, whole hunks, or random lines. Each pick is staged (`git diff`, `git apply --cached`), unstaged (`git
    diff --cached`, `git apply --cached --reverse`) and discarded (`git diff`, `git apply --reverse` onto the work
    tree). Each patch passes `git apply --check` with those switches. Applied, it leaves in the index (or the work
    tree) exactly the blobs and modes the pick means, worked out from the target's own text. A pick is refused
    exactly when that text cannot be a file.
  - Two fixed cases the random runs meet only a few times in a hundred: a line of a staged rename unstaged (the
    rename stays), and the refused pick. A last test checks that the random runs met every status, binary, mode,
    and a part of a changed, added and deleted file. In one measured run each was met 27 times or more (before
    discarding added runs),
    so a miss is not a flake to expect.
  - The parser's one finding from the property was a rename whose names have spaces. Its `diff --git` line is
    ambiguous, so the names now come from the rename lines. The other failures were in the test itself (a tab in a
    name, an empty restore).
- **Other checks:** 300 runs of each property also passed locally, before discarding was added.
  `edwin-typecheck` passed.
  `nix flake check` passed on the final tree, every check. Among them were `edwin-vc` 36, `edit-lockdown` 6,
  `edit-security` 21, `edit-console` 4 and `edit-image` 15. vc-diff.ts loads in edwind and adds no capability.
  `nix build .#edwin` ran too: 22 unit tests passed; `tests/gui.rs` had 5 passed and 1 ignored; `tests/terminal.rs`
  had 35 passed. An earlier `nix flake check`, before the review fixes, failed only in `tests/gui.rs`: two tests
  hit "Xvfb did not start", the known flake. Everything else in that run passed.

## The git status buffer (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-status-view`, on git-diff-model): magit's status buffer,
with sections, folding and refresh, on SPC g g and SPC g G, in place of the desktop-only stubs `vile-vcs-status`
and `vile-magit-status`. It is the first user of the runner (git-runner) and of `VcDiff.parse` (git-diff-model).

- **`vc-status`** (SPC g g) and **`git-status`** (SPC g G), in src/vc-git.ts (new, through the seven places of the
  touch list, after `vc-diff`). The commands take Edwin's own names (owner decision 12); the stubs and their names
  are gone. They look for the repository from the current buffer's directory (`Ed.compile.directory`, new: the
  directory a grep from the buffer runs in, its listing's or its file's, else the program's own; a status
  buffer's is its repository's root). `vc-status` takes the nearest repository, jj first, as `vile-vcs-status` did;
  `git-status` the nearest `.git` alone (`Vc.repo(dir, 'git')`, new), so in a colocated jj workspace it shows the
  git repository's status, as `vile-magit-status` did.
- **The buffer** `*git-status: NAME*` (NAME the root's last component; another repository of the same name gets
  `<2>`), one per repository, in `git-status-mode` (shown as `Git Status`), read-only, in Motion state, with the
  SPC leader. What it shows, magit's sections in magit's order, each only when it has something:
  - `Head:` the branch and its last commit's subject; `(no commit yet)` on an unborn branch; a detached HEAD
    shows its commit's short hash. `Merge:` the upstream and its subject, `(gone)` when it no longer exists.
  - `Untracked files` (git's normal mode: a new directory as `dir/`), `Unmerged paths` (git's words: both
    modified, added by us...), `Unstaged changes` and `Staged changes`, each file with its label (modified, new
    file, deleted, renamed `old -> new`, copied, new type) and, unfolded, its hunks; `Stashes`; `Unpulled from
    U` and `Unpushed to U` (at most 100 each, then `(N more)`), or `Recent commits` (10) when the branch has no
    upstream or it is gone.
  - A folded section with a body ends its heading in `…` (magit's indicator where there is no fringe). Files and
    the stashes start folded, the rest unfolded.
- **Reading.** Only read subcommands, each through `Vc.run` with its hardening: `status --porcelain=v2 --branch
  --show-stash -z --untracked-files=normal --find-renames`, `diff` and `diff --cached` with `VcDiff.gitArgs` and
  `--find-renames`, then `log --format=%h %s` for the head, the upstream, the unpulled and unpushed or recent
  commits, and `log --walk-reflogs` of `refs/stash` for the stashes. `git stash list` and `branch -vv` are not
  used: stash and branch are writes to the runner, which keep the repository's signature programs and drivers.
  The three of status and the diffs run at once, then the logs at once. Each read is bounded (16 MiB, 120 s).
- **Folding and redrawing.** There are no text properties, so the text is drawn from the model again (dired's
  way), each line with a row that says its section, faces and what RET visits. A fold is kept by its section's id
  (the section, the file's path, the hunk's index), so it survives `g r`, and a section folded keeps the folds
  of its parts for when it is unfolded again; the fold of a section gone from an unfolded parent is forgotten.
  Point stays on the line it was on, at the same column, or on the nearest section around it still shown, or on
  the same line number.
- **Keys** (scm/evil.scm, as evil-collection binds magit's): TAB `git-status-toggle` (the innermost section at
  point; a line with nothing under it says `Nothing to fold here`), `g r` `git-status-refresh`, C-j and C-k
  `git-status-next-section` and `-previous-section` (any depth), `g j` and `g k` the next and previous of the
  same depth, RET `git-status-visit` (a file at its first line; on a hunk or a hunk line, the file at that line
  on the new side, a removed line where it was; an untracked directory, its listing; a file not in the work tree,
  a deleted one, is refused with `PATH is not in the work tree`),
  `q` quit-window. SPC g g or SPC g G again, from the status buffer or from any file of the repository, reads it
  again into the same buffer.
- **Refresh.** A refresh started later wins: one that finishes after a newer one draws nothing, nor does one
  whose buffer was killed meanwhile.
- **Faces:** `git-section`, `git-dim` (labels, notes), `git-branch`, `git-remote`, `git-hash`, `git-hunk`,
  `git-added`, `git-removed`, in display.ts FACES and in the sheet `vc-git-css`, which test/display.test.mts checks
  against each other.
- **Choices**, each reversible:
  - SPC g g in a jj workspace (colocated or not) is refused: `ROOT is a jj workspace, and Edwin has no jj view
    yet: SPC g G shows its git repository's status when it is colocated`. Emacs opened majutsu's log there;
    git-jj-log gives `vc-status` its jj view. The `vile-majutsu-status` stub (SPC g J) stays for that package.
  - Outside a repository the command is refused (`Not in a repository: DIR`), where magit asks for one to
    initialise or pick.
  - Names from status, and the commit subjects, are decoded lossily (they are only shown); the diffs strictly:
    a patch must never be built from a lossy text, so a diff that is not UTF-8 shows its files without hunks and
    `(the diff is not shown: its text is not UTF-8)`. The same for a diff past 16 MiB, or one VcDiff.parse
    refuses. The note covers the whole section: one file that is not UTF-8 hides the hunks of all.
  - A control character in a name shows as `?`, so a name with a newline stays on one line.
  - Conflicted files are listed with git's words but show no diff: their combined diff is not parsed into hunks
    (git-diff-model), and conflicts are git-sequencer's and git-conflict's.
  - Headings show no hashes but a detached HEAD's (magit's default).
- **For git-stage**, which lives in the same file: the buffer keeps the parsed diffs (`model.diffs.unstaged` and
  `.staged`, what `VcDiff.patch` picks from) and each file's own part of them, and each line's row its section id
  (file path, hunk index, line index). A status name read lossily must not be passed back to git; the diff's
  names are strict.
- **Not in it:** no staging, discarding, committing or any other write (git-stage on); no commit view (RET on a
  commit does nothing: git-log-show); no in-progress merge or rebase header (git-sequencer); no TODO section
  (git-todos, "The TODO section", added it since); no numbered fold levels (1-4), no S-TAB cycling, no auto-refresh on save; no ignored files; no
  submodule's own changes (the runner shows a submodule by its commit only).
- **Image replay and edwind.** The commands check `Ed.proc.refusal()` first, and every child goes through
  `Vc.run`, which refuses under the image's replay, in a web frame and in edwind (no `host.proc`); `Vc.repo` reads
  the file tree only. vc-git.ts loads in edwind too (host-node.cts), ex44's public one included, where the
  commands refuse and no capability is added.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (46 passed: vc.test.mts's 21, vc-diff's 16
  and test/vc-git.test.mts's 9), with real git and jujutsu:
  - A fixture repository with an upstream (a bare repository, moved on from another clone and fetched), a local
    commit, a stash, a conflicting merge in progress, staged addition, deletion, rename and change, unstaged
    changes (one on a staged file, `sp ace.txt`), an untracked file and directory: SPC g g's text compared whole,
    line by line; only status, diff, log and the runner's config query run, each with the hooks off; the faces of
    a heading, the branch, the upstream, a label and a hash.
  - TAB on a file (its hunk shown, removed and added lines in their faces), on a hunk line (the hunk folds, point
    to its heading), on a section and on the stashes; a section folded, refreshed and unfolded again keeps a.txt
    unfolded; a line with nothing under it, the Head line and a blank line say so and change nothing.
  - `g r` after a new file and a changed one: the new untracked file, a.txt still unfolded with its new hunk,
    point on the same line and column, and on a blank line between sections the same line; SPC g g from the status buffer and from a file deeper in the repository
    reading it again into the one buffer.
  - C-j, C-k, `g j` and `g k`, and their ends; RET on an added and a removed line (the file at lines 4 and 2), on
    a deleted file (refused) and on an untracked directory (its listing); q.
  - A repository with no commit yet; a detached HEAD (and `Recent commits`); a branch with no upstream; an
    upstream that is gone.
  - Refused with no child started: outside a repository, SPC g g in a jj workspace; SPC g G there shows the
    colocated git repository; `vc-status` and `git-status` under `Ed.proc.replay`.
  - The stubs gone (`vile-majutsu-status` kept), SPC g g and SPC g G bound to the new commands.
  - A modified file that is not UTF-8: the note and the files without hunks; a name with a newline shown with
    `?`; a refresh whose buffer is killed while it reads.
  - A repository whose own config names core.fsmonitor, core.pager, diff.external, a diff driver's textconv and
    command, a filter's clean and smudge, gpg.program with log.showSignature, and alias.status, all marker scripts,
    with a stash: plain `git diff` runs them (the control); its status buffer, the stash and the unfolded diff
    (git's own text, not the textconv's) run none.
  - `edwin-display` (20, FACES against `vc-git-css`), `edwin-typecheck`.
- **Refresh cost**, measured on ex44 in the headless runtime (a scratch script, not a check): a repository of
  20,000 files of 50 lines, 500 of them changed and 50 new: a refresh (status, both diffs, log, drawing) took
  48-57 ms; with all 500 files unfolded (30,000 lines) 52 ms; a TAB there 8.6 ms; the lexer on a 4,000-character
  segment p50 0.05 ms.

## Staging and discarding in the git status buffer (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-stage`, on git-status-view): s, u and x in the status
buffer on files, hunks and selected lines, magit's stage, unstage and discard.

- **`git-status-stage`** (s), **`git-status-unstage`** (u) and **`git-status-discard`** (x), in src/vc-git.ts. Each
  acts on what the line at point shows: a part's heading (Untracked files, Unstaged changes, Staged changes,
  Unmerged paths: all its files), a file, or a hunk (its heading or any of its lines: the whole hunk, as in
  magit). In Visual state (v or V) they act on the changed lines selected, which must lie within one hunk
  (`The selection must lie within one hunk`); a selection of context lines only says `No change selected`. The
  selection is left first, back to Motion state. After each, done or failed, the repository is read again.
- **How each is done**, every child through `Vc.run` (the runner's hardening, its log in `*vc-process*`):
  - Whole files and parts by name: stage `git add -- PATHS` (untracked, unstaged and conflicted files; a
    deletion is staged too); unstage `git reset -q -- PATHS` (a rename's or copy's both names; with no commit yet
    reset empties the index entry); discard an unstaged file `git checkout -q -- PATHS` (back to the index), an
    untracked file or directory `git clean -f -d -q -- PATHS`.
  - Hunks and lines by a patch `VcDiff.patch` builds from the diff shown, on standard input of `git apply
    --whitespace=nowarn --no-ignore-whitespace` with `--cached` (stage), `--cached --reverse` (unstage),
    `--reverse` (discard unstaged) or `--reverse --index` (discard staged).
  - Discarding anything staged (a file, a hunk, lines, the whole part) is the reverse patch with `--index`: it
    leaves the index and the work tree as HEAD has them there. git refuses it (`does not match index`) when the
    work tree has further changes to that file, and the refusal is shown as git's (`git apply failed (exit 1):
    see *vc-process*`), nothing changed: the unstaged changes are never thrown away with the staged ones.
- **Discard asks first**, a y or n question naming what goes: `Delete untracked NAME?`, `Delete untracked N
  files?`, `Discard the unstaged changes to NAME?`, `Discard this hunk of NAME?`, `Discard the selected lines of
  NAME?`. n says `Nothing discarded` and runs nothing. The patch is built before the question, so a pick that
  cannot be applied is refused before anything is asked.
- **Names.** Every path goes after `--` as a literal pathspec (`:(literal)NAME`), so `star*.txt` names that file
  and not `starX.txt`; `Vc.start` takes no global `--literal-pathspecs`. The names come from status, read
  lossily (git-status-view): a name holding U+FFFD (one that is not UTF-8, or one that has that character) is
  refused (`NAME: its name is not UTF-8, so Edwin does not give it back to git; use a terminal`), never passed
  back. Hunks and lines come from the diff, read strictly; a part whose diff is not shown (its note) has no hunks
  to pick, and x on one of its staged files is refused for the same reason.
- **The repository's configuration.** `apply` runs with the hooks off. With `--cached` it touches only the index
  and runs no filter; without it, it writes the work tree through the repository's filters, as the runner lets
  every write.
  `--whitespace=nowarn` and `--no-ignore-whitespace` keep a repository's `apply.whitespace=fix` from changing
  the lines staged and `apply.whitespace=error` from refusing them, and `apply.ignoreWhitespace` from matching
  context loosely. add, reset, checkout and clean are the runner's writes: they keep the repository's filter
  drivers (a clean filter on add, a smudge filter on checkout), as git in a terminal does, with the hooks off.
- **Keys** (scm/evil.scm): s, u and x for git-status-mode in Motion and in Visual state (Visual state's own s, u
  and x would come first otherwise).
- **Choices**, each reversible:
  - A conflict: s stages it (`git add`, so it is marked resolved, as magit does); u says `Not staged`; x refuses
    (`A conflict is not discarded here: resolve it, then stage it with s`), where magit offers ours or theirs:
    conflicts are git-sequencer's and git-conflict's.
  - s on a staged line says `Already staged`, u on one that is not `Not staged`, where magit offers the reverse.
  - A selection must lie within one hunk; magit also stages a selection of several files' headings. Not built.
  - `git clean -f -d` leaves an untracked directory that is a repository of its own (it would take `-f -f`), and
    the ignored files under an untracked directory.
  - A staged binary file is unstaged by name, but cannot be discarded (`a binary file needs its diff taken with
    --binary`): the diff shown is read without --binary.
- **Not in it:** S and U (stage or unstage everything from anywhere), stage with intent to add (`git add -N`),
  the lines of an untracked file, discarding a conflict, magit's `k` alias, trash instead of delete, undo of a
  discard.
- **Image replay and edwind.** The commands check `Ed.proc.refusal()` before anything, so under the image's
  replay nothing is asked and no child starts; `Vc.run` refuses there too, in a web frame and in edwind.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (54 passed: vc.test.mts's 21, vc-diff's 16, vc-git's 9 and test/vc-stage.test.mts's 8), test/vc-stage.test.mts with
  real git, each result compared with `git show :PATH` and its blob id with `git hash-object` of the expected text:
  - s on a hunk stages it alone (the other hunk and the work tree left), u on the staged hunk unstages it; both
    by `git apply --cached` with the whitespace switches and the hooks off.
  - V j over two removed lines stages them alone; V on one staged line and u unstages it alone; u on a staged
    line with no selection unstages its hunk; V on an added line alone stages it after the line it replaces; a
    selection across two hunks refused, one of context only says so; the index unchanged by both.
  - s on a file, u on a staged rename (old name back, new name untracked), s on the untracked `star*.txt` (not
    `starX.txt`), s on the Untracked heading (a directory's files too), u on the Staged heading, s on the Unstaged
    heading (a deletion staged); `Already staged`, `Not staged`, `Nothing to stage here`.
  - x on an unstaged hunk: the question, n changes nothing and runs no write; y takes the hunk out of the work
    tree, the index untouched; V x on one added line; x on a modified file and on a deleted one; on `star*.txt`
    alone, on an untracked directory and on the Untracked heading.
  - x on a staged hunk: out of the index and the work tree; on a staged file whose work tree differs, refused
    with nothing changed; on a new file staged (gone from both); on a staged rename (both names back).
  - A conflict: x refused without a question, u `Not staged`, s resolves it. A branch with no commit yet: s and u
    on a file.
  - `apply.whitespace=fix` and `=error` with `apply.ignoreWhitespace=change`: added lines with trailing spaces
    staged as they are.
  - A name that is not UTF-8 refused with nothing added; the three commands under `Ed.proc.replay` refused with no
    child started.
  - `nix flake check -L --keep-going`: all checks passed, `nix build .#edwin` among them (gui tests run), with
    `edwin-typecheck`, `edit-lockdown` (6) and `edit-security` (21). A first `nix flake check` failed only on
    `edwin-bench`, a timing limit (shadow stack 13.1% against 10% under load; 8.2% on the rerun), which this
    package does not touch.

## Committing from the git status buffer (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-commit`, on git-stage): commit, amend, fixup and reword,
the message written in the commit message buffer (git-message-modes).

- **`git-commit`** (c c), **`git-commit-amend`** (c a), **`git-commit-reword`** (c w) and **`git-commit-fixup`**
  (c f), in src/vc-git.ts, bound in git-status-mode's Motion state (scm/evil.scm, evil-collection's magit keys).
  They also run from any buffer of a git repository by M-x (its repository found as SPC g g finds it); in a jj
  workspace they are refused (`ROOT is a jj workspace: describe its change with jj, or commit from SPC g G's
  status buffer`). From a status buffer they act on that buffer's repository, a colocated one's git included.
- **Before any message is written** the repository is read (as the status buffer reads it) and what git would
  refuse is refused: `N conflicted file(s): resolve and stage it/them first`; `Nothing staged: stage changes with
  s first` (c c, c f); `No commit yet: nothing to amend` / `reword` / `fix up`.
- **Save first: ask** (owner decision 12). The changed buffers visiting a file under the repository's root are
  offered in one y or n question (`Save a.txt before committing?`, `Save N changed buffers of ROOT before
  committing?`); y saves them all, n goes on with what the files hold. Buffers outside the repository are not
  asked about. Reword asks nothing: it takes no file. Saving does not stage: what is committed is the index.
- **The message buffer** `*git-commit: NAME*` (Vc.message, vc-message-mode; C-c C-c commits, C-c C-k aborts),
  holding for c c an empty first line, for c a and c w the last commit's message (`git log -1 --format=%B`), then
  `#` lines saying what is done, on which branch and in which repository, and the staged files (`Changes to be
  committed:`, for amend `Staged changes it takes as well:`). The command ends once the buffer is open (commands
  run one at a time, and C-c C-c is another); the commit runs when the message comes, and its failure is
  reported as a command's.
- **How each is done**, through `Vc.run` (commit keeps the repository's hooks, filters and signing, as the runner
  lets commit; GIT_EDITOR stays false, no editor is ever needed):
  - c c `git commit --cleanup=verbatim -F -`, c a with `--amend`, c w with `--amend --only --no-verify`: the
    message on standard input, never in the argv or `*vc-process*`. `--cleanup=verbatim`: Vc.message has
    cleaned it already (git stripspace's way, `#` comments), so the repository's commit.cleanup or
    core.commentChar cannot clean it again.
  - c w changes the message alone: `--only` with no paths leaves the staged changes staged and the tree as it
    was; `--no-verify` (owner decision 12): no pre-commit or commit-msg hook (prepare-commit-msg, post-commit and
    post-rewrite still run: `--no-verify` does not reach them).
  - c f `git commit --fixup=HASH`: the commit on the line at point (Recent commits, Unpushed: each commit line now
    carries its hash; a stash's and an unpulled one's, not in HEAD's history, do not), elsewhere asked for (`Fix up commit (HEAD): `, empty for HEAD).
    What is typed is resolved by `git rev-parse --verify --quiet --end-of-options REV^{commit}` (a read) into a
    full hash, so it never reaches `commit` as a switch (`Not a commit: REV`). The fixup also runs after the
    command ends, its hooks perhaps long.
  - A commit has no bound on its output, only a time (10 minutes): a hook may print as much as it likes (git
    sends it to the error output), and a bound would kill the commit partway. Kept are the first 64 KiB of the
    output (git's summary line first) and the last 64 KiB of the error output (git's or the hook's last words);
    `*vc-process*` keeps the first 8 KiB of the error output, as for every child.
- **A refused commit** (a pre-commit or commit-msg hook said no, or the commit could not start): git's last line
  of error output is said, `git commit failed (exit 1): WHY; the message is kept for the next commit (see
  *vc-process*)`, and the next command of the same kind in that repository opens with that message. It is
  taken when the buffer opens: C-c C-k on it lets it go.
- After a commit, done or not, every status buffer of the repository is read again, and git's line (`[main
  1234567] Subject`) is said.
- **Choices**, each reversible:
  - Reword is of HEAD only; rewording an older commit is a rebase (git-sequencer, git-rebase-todo). Magit's c w
    rewrites an older one through rebase.
  - Fixup only: no `--fixup=amend:` or `reword:` (they want an editor), no squash (c s), no instant fixup (c F)
    or autosquash: the rebase is git-sequencer's.
  - No extend (c e), no `--allow-empty`, no commit transient with switches (`--signoff`, `--no-verify` and the
    rest): the owner's repository settings or a terminal give those.
  - During a merge c c commits the staged resolution with the message written; git's MERGE_MSG is not put in the
    buffer (git-sequencer).
  - A shared buffer (one edwind holds) is saved by edwind; the commit does not wait for its answer, so y to the
    save question does not mean the file is written yet. What is committed is the index all the same; only a hook
    that reads the working tree (a formatter, a linter) may see the file as it was. Its `Wrote FILE` (or why
    not) is said when edwind answers.
- **Not in it:** commit from a jj workspace (git-jj-ops' describe), the diff of what is committed beside the
  message (magit's), commit message history (M-p/M-n), a GPG passphrase prompt (the child has no terminal: the
  user's agent and pinentry answer, or the commit fails and the message is kept).
- **Image replay and edwind.** The commands check `Ed.proc.refusal()` before anything, so under the image's
  replay nothing is read, asked or opened; `Vc.run` refuses in a web frame and in edwind as well.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (62 passed: vc.test.mts's 21, vc-diff's 16,
  vc-git's 9, vc-stage's 8 and test/vc-commit.test.mts's 8), with real git, the log and index read after each:
  - c c: the message buffer's whole text and point; the commit holds the staged file only, its message as written
    with the comment lines left out and white space inside a line kept; git's line said; the status read again;
    the argv `commit --cleanup=verbatim -F -`, the message not in it, the hooks on.
  - c a: the last message in the buffer with the staged file listed; the amended commit holds both files.
  - c w with a staged change and pre-commit and commit-msg hooks: the message changed, the tree unchanged, the change still
    staged, neither hook run; then c f on the first commit's line: `fixup! first`, both hooks run, `--fixup=` its
    full hash.
  - c f from a file buffer: the prompt; `--amend` typed is refused as no commit, with no commit run; RET fixes up
    HEAD.
  - A pre-commit hook that exits 1: its words said, HEAD unchanged, the change still staged; c c again opens with
    the kept message and commits it; the next c c starts empty; C-c C-k starts no commit.
  - A pre-commit hook that prints 3 MB: exiting 1, its last line said (not `exit null`), HEAD unchanged;
    exiting 0, the commit made and git's line said.
  - Save: one changed buffer of the repository asked about by name, y saves it, a buffer outside the repository
    is left; two asked about together, n saves neither and the commit takes the index alone.
  - Refused with no message buffer: nothing staged (c c, c f), no commit yet (c a, c w, c f), then the first
    commit of that repository; a conflict; a jj workspace; the four commands under `Ed.proc.replay` with no child
    started.
  - `nix flake check -L --keep-going`: all checks passed, `nix build .#edwin` among them (its cargo and gui tests
    run), with `edwin-typecheck`, `edwin-display` (20), `edit-lockdown` (6) and `edit-security` (21).

## The git log and commit view (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-log-show`, on git-commit): a log buffer with paging and a
commit view with its diff, magit's log and revision buffers.

- **`git-log`** (`l l` in the status buffer, evil-collection's key for magit's log of the current branch; M-x from
  any buffer of a git repository, found as SPC g g finds it, a jj workspace refused with `ROOT is a jj workspace:
  use jj log, or SPC g G and l l for its git repository's log`) opens `*git-log: NAME*` in `git-log-mode` (`Git
  Log`): a heading `Commits in ROOT`, then a line per commit, `HASH (REFS) SUBJECT  AUTHOR DATE`, newest first,
  the hash, the refs and the author and date in their faces (`git-hash`, `git-branch`, `git-dim`).
- **Paging.** The log is read 256 commits a page: HEAD is resolved once, when the log opens, to its full hash
  (`rev-parse --verify --quiet --end-of-options HEAD^{commit}`), and each page is `git log --no-color
  --encoding=UTF-8 --date=short --format=%H%x00%h%x00%D%x00%an%x00%ad%x00%s --skip=K --max-count=257 HASH --`,
  one commit more than the page to know whether more come. A commit made while paging does not shift the pages:
  no commit is shown twice or skipped. The last line says `(more: + or RET here reads the next 256)`; `+`
  (`git-log-more`) or RET on that line reads the next page. `g r` reads the log again from HEAD, as many commits as
  it shows (a page at least), in the background too.
- **In the background.** `l l`, `+` and `g r` end at once: the buffer says `(reading…)` or `(reading the next 256…)` and
  the page is drawn when git has printed it, so a long or slow history never holds the frame or the keys after it.
  A second `+` while a page is read says `Still reading the log`; `+` at the end says `No more commits`. A read
  started later (`g r`) wins over one still running, and a read whose buffer was killed draws nothing. A read that
  fails says so in the buffer, `(the log could not be read: see *vc-process*)` under the `Commits in ROOT`
  heading (never `No commit yet`, which only a read that found no HEAD says), and in the echo area. The two are told
  apart by `git rev-parse --verify --quiet`'s exit: 1 is no such commit (an unborn HEAD, an unknown name); any
  other failure (128: an unknown repository extension, dubious ownership, a corrupt HEAD) is raised, so the log
  keeps the page it shows under the note and RET on a commit says `git rev-parse failed (exit 128)` instead of
  `Not a commit`. A commit with an empty message has one blank line between its header and its diff.
- **`git-status-visit`** (RET) shows the commit at point in `*git-revision: NAME*` (`git-revision-mode`, `Git
  Revision`), one per repository, replaced by the next commit shown: a commit line of the log, of the status
  buffer (Recent commits, Unpushed, Unpulled, the Head and Merge lines) or a stash's line. The revision buffer
  shows `Commit:` (the full hash), `Parent:` or `Parents:` (RET on one shows it), `Refs:`, `Author:` with the date
  (ISO 8601) and `Committer:` when its name, address or date differs (an amended, rebased or cherry-picked
  commit), each value at column 11, one past the longest label, the message indented by four, then the diff a section per file
  (`modified`, `new file`, `deleted`, `renamed old -> new`, `copied`, a mode change or `(binary)` after the label)
  and its hunks. TAB folds a file or a hunk, C-j, C-k, `g j` and `g k` step through them, RET on a hunk or a line
  visits the work tree's file at that line (a path that is absolute or holds `..`, which a crafted commit's tree
  can name, is refused as `PATH is not in the work tree`), `g r` reads it again, `q` leaves. The status buffer's commands serve
  the three buffers: one drawing, one set of rows, folds and motions, each buffer with its own model.
- **Reading a commit**, two reads at once, like the status buffer's: the header and message by `git show
  --no-patch --no-color --encoding=UTF-8 --date=iso-strict --format=…` (lossy: only shown), the diff by `git show
  --format= --patch --root --diff-merges=first-parent` with `VcDiff.gitArgs` and `--find-renames` (16 MiB, the
  status buffer's notes when it is not shown). The diff is read lossily, where the status buffer's is strict: the
  revision buffer builds no patch, so a file that is not UTF-8 shows its hunks with U+FFFD for each such byte and
  hides none of the other files'. The revision comes from a buffer's line, and is still resolved
  to a full hash by `rev-parse --verify --end-of-options REV^{commit}` before `show` sees it (`Not a commit: REV`);
  c f's resolution is the same function.
- **The repository's configuration.** log, show and rev-parse are the runner's reads: the hooks off, no pager,
  no fsmonitor, no external diff or textconv, the repository's filter and merge drivers emptied, its signature
  programs the user's, `log.showSignature` off and no `%G` in the format (no signature verified), its aliases of
  those names emptied. The format, `--date`, `--no-color`, `--encoding` and `--diff-merges` fix the shape against
  the user's `format.pretty`, `log.date`, `color.ui`, `i18n.logOutputEncoding` and `log.diffMerges` (remerge
  would merge again with the merge drivers), `--root` against `log.showRoot=false`.
- **Choices**, each reversible:
  - No graph and no `--topo-order`: both make git walk the whole history before it prints the first line, which
    paging is for. Commits are in git log's default order.
  - A page is appended (`--skip`) where magit's `+` doubles the count and reads the whole log again.
  - `+` in `git-log-mode` takes the place of evil's `+` motion (next line's first non-blank), which `j` gives.
  - `l l` makes `l` a prefix in the status buffer, as `c` already is: `l` no longer moves right there (`l j` is
    undefined), as in evil-collection's magit, where `l` is the log transient.
  - A merge's diff is against its first parent, where magit shows git's combined diff: the combined diff is not
    read into hunks (git-diff-model), and the first parent's is what the merge brought to the branch. A stash is
    a merge too: its diff is the work tree's change against the commit it was made on.
  - RET on a hunk line of the revision buffer visits the file as the work tree has it, not as the commit had it
    (magit visits the commit's blob).
  - The opening of a revision waits for its two reads (as SPC g g waits for its status): it is one commit,
    bounded at 16 MiB of diff.
- **Not in it:** the log of another branch, of all refs or of a file (`l o`, `l a`, `l f`), log switches (the
  transient), the graph, the reflog, margin toggling, showing a commit typed at a prompt, the blob of a file at a
  commit, the history operations on a log line (git-history-ops), jj's log (git-jj-log).
- **Image replay and edwind.** `git-log`, `git-log-more` and RET check `Ed.proc.refusal()` before anything, and
  every child goes through `Vc.run`, which refuses under the image's replay, in a web frame and in edwind.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (72 passed: vc.test.mts's 21, vc-diff's 16,
  vc-git's 9, vc-stage's 8, vc-commit's 8 and test/vc-log.test.mts's 10), with real git and jujutsu:
  - A 1,000-commit fixture (one `git fast-import` stream), a tag and a branch: `l l` ends with `(reading…)`
    shown; then 256 commits, the first line compared whole, their hashes git log's first 256, the more line, the
    page read as `--skip=0 --max-count=257 FULLHASH --` with the hooks off, no --graph or --topo-order; the faces.
  - Paged to the end by `+` and by RET on the more line: each key ends with the reading line shown, each page's
    hashes git log's, all 1,000 once in order, no more line at the end, `No more commits`, the skips 0, 256, 512,
    768. A probe on a 2 ms timer measured the event loop held at most 4.1-5.1 ms a page, the keys returning in
    3.6-4.2 ms (the last edwin-vc run, alone on ex44); 20-75 ms a page in the flake check's run, under load. Asserted under the 2 s frame deadline, not near the
    measure: it is wall-clock time, which a loaded build host stretches; the background read itself is shown
    deterministically by the reading line after each key. The lexer on 60 lines of the 1,000-line buffer measured
    at 0.04 ms (printed, not asserted).
  - A commit made after the first page: the second page continues from the old tip; `g r` shows the new commit
    first and as many commits as were shown, `(reading…)` while it reads; `+` twice while reading says `Still reading the log` and reads once.
  - RET on a log line: the revision buffer's whole text (header, refs, author, message, a modified file's hunk, a
    rename, an added file); its faces; show with the hooks off, `--root` and `--diff-merges=first-parent`; TAB on
    a file, C-j to its hunk, RET on an added line visits the file at line 2; RET on `Parent:` shows the root
    commit, its files added, in the same buffer; RET on a row whose path is `../outside.txt`, `/etc/passwd` or
    `a/../../x` refused; q.
  - From the status buffer: RET on a recent commit, on the Head line, on a stash (a merge, its work tree change).
  - A merge: `Parents:` with both, its diff against the first parent only; a repository with no commit yet:
    `No commit yet`.
  - An amended commit whose committer and date differ from its author's: the whole revision text, `Committer:
    Other <…> DATE` aligned with the other lines; in it a file holding the bytes `caf\xe9`, shown as `+caf�`, and a
    UTF-8 file, both with their hunks.
  - git not on PATH: `M-x git-log` in a repository with a commit shows `Commits in ROOT` and the could-not-be-read
    line, the echo area `cannot run git`.
  - git starting and refusing the repository (`extensions.bogusext` under repositoryformatversion 1, exit 128)
    after the log was shown: RET on the commit fails `git rev-parse failed (exit 128): see *vc-process*`; `M-x
    git-log` keeps the commit line and adds the could-not-be-read line under it, the same message in the echo
    area, git's `unknown repository extension` in `*vc-process*`.
  - A commit with an empty message (`--allow-empty-message`): header, one blank line, the diff.
  - Refused: outside a repository and in a jj workspace with no child started; `git-log`, `git-log-more` and RET
    on a commit under `Ed.proc.replay`, no child started; a revision that is no commit (`--output=/tmp/x`):
    `Not a commit`.
  - A repository whose own configuration names core.fsmonitor, core.pager, diff.external, a diff driver's
    textconv and command, a filter's clean and smudge, a merge driver, gpg.program with log.showSignature,
    log.diffMerges=remerge and alias.log, alias.show and alias.rev-parse, all a marker script: plain `git show -p`
    of the side commit runs them (the control); its log, the merge's revision buffer (git's own diff against the
    first parent) and its parent's run none.
  - The existing suites unchanged (the status buffer's drawing now shared): vc-git's 9, vc-stage's 8,
    vc-commit's 8.
  - `nix flake check -L --keep-going`, before the review fixes: every check passed but `edwin-bench`, a timing
    limit (shadow stack 16.2% against 10% under load; 8.5% on its rerun, passed), which this package does not
    touch; `nix build .#edwin` among them (its cargo and gui tests run), with `edwin-typecheck`, `edwin-display`
    (20), `edit-lockdown` (6), `edit-security` (21) and `edwin-vc` (70; the paging held the loop 20-75 ms a page
    there, under load). A first run, before the last fixes, also failed once on `edit-crash` (R16.5, random
    SIGKILLs), which passed (7) on the second. After the review fixes (the Committer column, the lossy revision
    diff, the failed log's heading): `edwin-vc` (72), `edwin-typecheck` and `edwin-display`.

## The jj log and change view (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-jj-log`, on git-log-show): src/vc-jj.ts, the jj log as
the status view of a jj workspace, with a change view and its diff, in place of the `vile-majutsu-status`
desktop-only stub; the log parsed from a template, not from graph text.

- **`jj-log`** (SPC g J, where the desktop had majutsu's log; and `vc-status`, SPC g g, in a jj workspace, which
  said `Edwin has no jj view yet` before) opens `*jj-log: NAME*` in `jj-log-mode` (`jj Log`): a heading `Changes
  in ROOT`, then a line per change, `NODE CHANGE COMMIT BOOKMARKS TAGS (conflict) (empty) DESCRIPTION  AUTHOR
  DATE`, in jj log's order. NODE is the one jj's graph would draw: `@` the working copy's, `×` a conflict, `◆`
  immutable, `○` any other. CHANGE is the change id's first 8 letters, its shortest unique prefix in `git-remote`
  and the rest dim, `??` after a divergent one; COMMIT the commit id's first 8 (`git-hash`); bookmarks and tags
  as jj shows them (`main@origin`, `main??`) in `git-branch`; `(no description set)` for an empty description;
  the root is `◆ zzzzzzzz 00000000 root()`. SPC g G stays git's status of a colocated workspace's repository.
- **Parsed from a template.** The log is `jj log --no-graph --limit 257 -T TEMPLATE`, TEMPLATE Edwin's own: one
  JSON array a line, every field through `json()` (the ids, `change_id.shortest(8).prefix()` and `.rest()`, the
  bookmarks and tags joined, the flags `current_working_copy`, `root`, `empty`, `conflict`, `immutable`,
  `divergent`, the author's name, the date as `%Y-%m-%d` in the author's offset, `description.first_line()`). No
  line of graph text is read, so the user's `templates.log`, `ui.graph.style` and date settings change nothing
  read, and a description holding quotes, brackets, newlines or control characters cannot break a line (a
  control character is shown as `?`). Each line is checked whole: a JSON array of that length, each field of
  its type, the change id `[k-z]{32,64}` and the commit id hex; a line of another shape (a user template alias
  that shadows a keyword, say) refuses the read, `jj log printed what Edwin cannot read (see *vc-process*)`, and
  the buffer keeps what it showed.
- **No word wrap.** A user's `ui.log-word-wrap = true` breaks a template's output at its spaces even when jj
  writes to no terminal, which cut the JSON lines: the runner's fixed jj switches (src/vc.ts JJ_BASE) gain
  `--config ui.log-word-wrap=false`, for every jj child.
- **More.** jj log has no `--skip`, so `+` (`jj-log-more`), or RET on the last line `(more: + or RET here reads
  the next 256)`, reads the log again with a limit 256 larger; at the end it says `No more changes`. `g r`
  (`git-status-refresh`) reads it again with the limit it has (256 at least), keeping point on its change's line
  (a line's id is its commit id; a rewritten change's point falls back to the same line number). SPC g g or SPC
  g J with the log open reads it again in that buffer.
- **The change view.** RET (`git-status-visit`) on a change shows it in `*jj-change: NAME*` (`jj-change-mode`,
  `jj Change`), one per workspace, replaced by the next change shown: `Change:` (the full id, `(divergent)`
  after one), `Commit:`, `Parent:` or `Parents:` (the parent's change id's first 8 and its commit id; RET shows
  it), `Bookmarks:`, `Tags:`, `State:` (working copy, root, immutable, empty, conflict, those that hold),
  `Author:` and `Committer:` (when it differs) with ISO 8601 dates in their offsets, each value at column 11; the
  description indented by four; then the diff, a section per file and hunk, drawn, folded (TAB), stepped (C-j,
  C-k, `g j`, `g k`) and visited (RET on a hunk line: the work tree's file at that line, a path that is absolute
  or holds `..` refused) exactly as git's revision buffer is.
- **Reading a change**, one read after the other: the header by `jj log --no-graph --limit 2 -r REV -T
  TEMPLATE` (exactly one line, else `No such change` or `That change is divergent`), then the diff by `jj diff
  --ignore-working-copy --git -r commit_id(HEX)`, parsed by VcDiff.parse (lossy, shown only; 16 MiB, past it a
  note). Every jj command takes a snapshot of the working copy and writes an operation, so two at once would
  race: the header's read takes the snapshot, the diff's takes none. REV is the change's id, so when that
  snapshot rewrites the working copy's change (a file written since the log was drawn), the view shows the
  rewritten commit, not the one the line was drawn from, which the snapshot hides and `commit_id()` would still
  name.
- **What is given back to jj.** Only ids read from the template and checked, and only inside revset functions
  Edwin writes: `change_id(ID)` for a line's or a parent's change, the first read and `g r` of the view alike (so
  the view follows the change as it is rewritten, the working copy's as files change), or `commit_id(HEX)` when
  the change is divergent (the log line's and each parent's `divergent` flag say so). A divergent working copy's
  view, read by its commit id, can show the commit before a snapshot; `g r` on the log reads it again. A bare id would be a symbol, and jj takes a bookmark or tag of that name first:
  a bookmark named like a change id then stands for nothing here. Nothing typed reaches a revset.
- **One drawing.** vc-git.ts gives its drawing to other version control as `VcView` (`open`, `model`, `refresh`,
  `hunks`, `fileHeading`, `shown`, `faces`): jj's buffers are views of kind `ext` with their own model, drawn,
  read again and shown by their `VcViewKind`, folded, stepped and visited by the git buffers' commands and faces.
  vc-git.ts calls `VcJj.log` for SPC g g in a jj workspace; git's `git-log` and commit commands in a jj buffer
  look up the repository around it as before (a jj buffer's repository is never taken for git's), so they say
  `ROOT is a jj workspace: ...` and run nothing.
- **Choices**, each reversible:
  - No graph: the changes are in jj log's order, a line each, with jj's node glyph but no edges and no `~` for
    elided parts. A graph read from text is what the package rules out, and one drawn from the parents is not
    asked.
  - The changes are those of the user's `revsets.log` (jj's default when unset); no revset is asked for.
  - `+` reads the whole log again with a larger limit (jj has no skip; a read that fails keeps the limit it had); it waits for jj, as SPC g g does, where
    git's log reads its pages in the background: a jj log is short by its default revset.
  - Dates are the author's and committer's own offsets (`%Y-%m-%d` in the log, `%Y-%m-%dT%H:%M:%S%:z` in the
    view), as git's log shows them.
  - A merge's diff is jj's, against its parents merged, where git's revision buffer shows the first parent's.
  - The keys are git's buffers' commands (`git-status-visit`, `git-status-refresh`, the motions), bound in the
    jj modes as in git-revision-mode; `+` is `jj-log-more`. Motion state, SPC leader and q as in git's buffers.
- **Not in it:** jj's operations from the log (new, describe, edit, abandon, squash: git-jj-ops; rebase, split,
  undo: git-jj-rewrite; fetch, push, bookmarks: git-jj-remote), the working copy's changes as a separate section,
  a revset typed at a prompt, the operation log, the evolution log, other workspaces' working copies.
- **Image replay and edwind.** `jj-log`, `jj-log-more`, RET and `g r` check `Ed.proc.refusal()` before anything,
  and every child goes through `Vc.run`, which refuses under the image's replay, in a web frame and in edwind.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (84 passed, test/vc-jj.test.mts's 10 among
  them) with nixpkgs' jujutsu 0.45.1 and git, under a throwaway HOME whose jj config sets its own `templates.log`,
  `ui.graph.style = "ascii"` and `ui.log-word-wrap = true` (the control: plain `jj log` prints the user's
  template on an ASCII graph):
  - A fixture workspace: an immutable first change (bookmark `main`, tag `v1`, a body), two children, one
    described `side "quoted" ]["x"]` with a control character on its second line, their merge with a conflict
    in a.txt, and an empty working copy on it. SPC g g: the whole buffer compared with lines built from what jj
    itself prints of each change; one child, `jj log --no-graph --limit 257 -T` with the JSON template and no
    `-r`, after the runner's switches; the order jj's; the faces of the node, the id's prefix and rest, the
    commit id, the bookmark and tag, `(conflict)`, `@` and the heading.
  - RET on a change: the whole change view (header, description, a modified and an added file with their
    hunks), the header read by `change_id(ID)` and then the diff by `commit_id(HEX)` with `--ignore-working-copy`; faces; TAB folds
    a file, C-j steps to the next file and to its hunk, RET on an added line visits b.txt at line 2.
  - The merge: `Parents:` with both and `State: empty, conflict`; RET on the second parent shows it in the same
    buffer, point at its start, its control character as `?`; RET on its parent shows the first change's
    bookmarks, tags, `State: immutable` and body; then the root.
  - `g r` after a `jj new` made outside: the new change first, point kept on its change's line; SPC g g again
    reads it in the same buffer; the working copy's change view after a file is written: `g r` shows the new
    file and the commit id the snapshot made.
  - RET on the working copy's line after a file is written since the log was drawn: `Commit:` is @'s commit after
    the snapshot (not the one the line was drawn from), `State: working copy`, and the new file in the diff.
  - A 17 MiB file in a change: the view shows its header and `(the diff is not shown: it is larger than 16 MiB)`,
    no file.
  - A bookmark named as a change id, on another change: plain jj takes the bookmark (the control); Edwin's view
    shows the right change, and again after `g r`.
  - 300 commits imported from the colocated git repository (302 changes): 256 and the more line, `+` reads with
    `--limit 513` and shows all in jj's order, `+` again says `No more changes`; RET on the more line too. A `+` whose read fails
    (a line of another shape) keeps the limit: `g r` then reads with `--limit 257`.
  - Refused: SPC g J outside a repository and in a git-only one, nothing run; `git-log` and `git-commit` in the jj
    log buffer refused as a jj workspace, nothing run; SPC g G there gives git's status; `jj-log`,
    `jj-log-more`, RET and `g r` under `Ed.proc.replay`, no child started; `vile-majutsu-status` unbound, SPC g J
    `jj-log`.
  - A user template alias `empty` that shadows the keyword: `jj log printed what Edwin cannot read`, the buffer
    unchanged.
  - vc-git's refusal test now expects jj's log from SPC g g in a jj workspace; vc.test.mts's runner argv has the
    word-wrap switch.
  - The fix of RET on the working copy (read by `change_id()`) and of a failed `+`: `edwin-vc` (84) and
    `edwin-typecheck` passed; the flake check below was run on the commit before it.
  - `nix flake check -L --keep-going`: every check passed but `edwin-bench` (shadow stack over its 10% under
    load) and `edit-crash` (R16.5, random SIGKILLs, `the history lost acked batches`), neither touched here; each
    passed when run again alone (`edwin-bench` 9.0%, `edit-crash` 7). Among those that passed: `nix build .#edwin`
    (cargo and gui tests), `edwin-typecheck`, `edwin-vc` (82), `edwin-display` (20), `edwin-headless` (21),
    `edit-lockdown` (6), `edit-security` (21).

## jj new, describe, edit, abandon and squash (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-jj-ops`, on git-jj-log): jj's everyday operations from
the log, each proved by `edwin-vc`.

- **The keys** are majutsu's Evil ones, which the desktop had, bound in `jj-log-mode` and `jj-change-mode`: `o`
  `jj-new`, `c` `jj-describe`, `e` `jj-edit`, `x` `jj-abandon`, `s` `jj-squash`. In the log each acts on the change
  on the line at point; in the change view, on the change it shows. Elsewhere: `No change at point` (the heading,
  the more line), `Not a jj log or change buffer`.
- **What is given to jj** is the line's revset alone, `change_id(ID)` or, for a divergent change, `commit_id(HEX)`
  (git-jj-log's revOf), checked again against its shape, after `-r`: `jj new -r REV`, `jj edit -r REV`, `jj
  abandon -r REV`, `jj describe -r REV --stdin`, `jj squash -r REV [--message=TEXT]`. Nothing typed reaches a
  revset, and every child goes through `Vc.run` (no pager, no colour, git's diff format, `JJ_EDITOR=false`).
- **o** starts a new change on the change at point (majutsu's `O`, new on the revision at point; its `o` opens a
  transient). **e** makes the change the working copy. Both first offer to save the changed buffers visiting
  files of the workspace (`Save a.txt before jj edit?`, one question, n goes on): the new change takes what the
  files hold, and edit rewrites the work tree under them. The offer is git's commit's, moved from vc-git.ts to
  `Vc.offerSave(r, doing)`, its question naming what it is before (`committing` for git, as before).
- **c** reads the change's whole description (`jj log -r REV -T` a JSON template of the ids, the shortest id,
  `description`, `immutable` and the parents' descriptions) and opens `*jj-describe: NAME*` in vc-message-mode
  with it and the comment lines `JJ: Describing ID in ROOT.` and `JJ: C-c C-c describes, C-c C-k aborts. ...`.
  C-c C-c gives the message, without its `JJ:` lines and cleaned as git stripspace cleans it, to `jj describe
  --stdin`; C-c C-k leaves the change as it was. A description jj refuses is said and kept: the next `c` on that
  change starts from it.
- **x** asks `Abandon ID SUBJECT?` (n: `Nothing abandoned`), offers to save, then runs `jj abandon`; its
  descendants move onto its parent, as jj does it.
- **s** squashes the change into its parent. jj asks for the result's description in an editor only when both
  have one; with `JJ_EDITOR=false` that would fail, so then Edwin opens `*jj-squash: NAME*` with the parent's
  description above the change's and gives what is written as one `--message=TEXT` argument (never two
  arguments, which jj could read as a switch: a message that starts `-R` or `--config` stays a message). With one
  description or none, `jj squash -r REV` runs at once and jj keeps the one there is. "Has one" is jj's own rule,
  a description that is not the empty string: one of only whitespace (`jj describe -m ' '` stores " \n") counts,
  so it opens the buffer too rather than letting jj start its editor.
- **Refused before anything is written**: an immutable change for c, x and s (`ID SUBJECT is immutable: jj does
  not describe it`), from the template's `immutable`; for s, a change whose parent is immutable (`The parent of ID
  SUBJECT is immutable: jj does not squash into it`), from the parents' `immutable()`, and a merge (`... is a
  merge: squash it from a terminal, naming the parent with --into`). jj's own refusals (e on the root, a change that became immutable) are said as
  `jj edit failed (exit 1): The root commit ... is immutable (see *vc-process*)`, its `Error:` line.
- **After each**: the workspace's log, then its change view, read again one after the other (every jj command
  snapshots the working copy, so never two at once); a change view whose change is gone (abandoned, squashed
  away) is killed. Then the first line jj printed is said (`Working copy (@) now at: ...`, `Abandoned 1
  commits: ...`), or `jj OP: done`.
- **Choices**, each reversible:
  - Majutsu's Evil keys, not magit's; `o` is new on the change at point, with no transient (no insert-before or
    -after, no several parents, no message given with it).
  - An empty description cannot be given from the buffer: vc-message-mode refuses an empty message, as for git.
    Clearing one is left to a terminal.
  - The squash buffer starts from both descriptions, the parent's first, with Edwin's own `JJ:` lines in place of
    jj's editor text; squash is into the parent only, never with `--into`, and of the whole change.
  - Immutable changes, and for s an immutable parent, are refused from the template's flags rather than from
    jj's error, so no buffer is opened for a description jj would refuse; `--ignore-immutable` is never given.
    e is left to jj (it reads nothing first).
  - No save is offered before c: it changes no file.
  - The operations wait for jj, as the log does; a describe or squash runs once its message is finished, after
    the command that opened the buffer has ended.
- **Not in it:** several changes at once (a Visual selection), new with several parents or `--insert-before` /
  `--insert-after`, squash `--into` or of some files, restore, split, rebase and undo (git-jj-rewrite), bookmarks,
  fetch and push (git-jj-remote), the operation log.
- **Image replay and edwind.** Each command checks `Ed.proc.refusal()` before anything, and every child goes
  through `Vc.run`, which refuses under the image's replay, in a web frame and in edwind.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (94 passed, test/vc-jj-ops.test.mts's 10 among
  them) with nixpkgs' jujutsu 0.45.1 and git, and `edwin-typecheck`, both passed. The suite's workspace: an
  immutable first change (tag `v1`), two described children and an empty working copy:
  - `o` on the second change: `new -r change_id(B)` after the runner's switches; @'s parent is B, the log read
    again in its buffer with the new @, `Working copy (@) now at:` said, the work tree B's.
  - `e` on the third with a changed buffer visiting b.txt: `Save b.txt before jj edit? (y or n)`, n; `edit -r
    change_id(C)`; @ is C, its c.txt in the work tree, b.txt as it was.
  - `c`: the buffer's whole text (description and the two `JJ:` lines), C-c C-c on a message with trailing
    space, blank lines and a `JJ:` line gives `describe -r change_id(B) --stdin` and jj's description is the
    cleaned one; the log shows it. C-c C-k runs nothing. B tagged while its message is written: `jj describe
    failed (exit 1): Commit ... is immutable`, the description unchanged, the next `c` starts from the refused
    message, and after an abort from the description again.
  - `c` in the change view describes the change it shows; the view read again shows it.
  - The immutable first change: c, x and s refused with `ID first is immutable: jj does not ... it`, only reads
    run, no buffer; `e` on the root: jj's refusal said, the operation log unchanged; `o` on the heading `No change
    at point`; `jj-new` in a file's buffer `Not a jj log or change buffer`.
  - `s` on an undescribed change with a file: `squash -r change_id(D)` at once, D gone, its file in C, C's
    description kept. On a described child of C: the `*jj-squash: ws*` buffer with C's description above the
    child's; a message `-R /elsewhere --config ui.editor=evil` and a body given as one `--message=...` argument,
    jj's description exactly that. On a merge: refused, no squash run.
  - `x`: the question `Abandon ID doomed? (y or n)`, n `Nothing abandoned` and nothing run; y: `abandon -r
    change_id(X)`, X gone, its child on X's parent, `Abandoned 1 commits:` said, the open change view of X
    killed, X's line gone from the log.
  - A divergent change (described two ways from one operation): x on the `other side` line gives `abandon -r
    commit_id(HEX)` of that commit; the change id then names the other one alone.
  - Under `Ed.proc.replay`, jj-new, jj-describe, jj-edit, jj-abandon and jj-squash: `while the image replays`,
    no child started.
  - `nix flake check -L --keep-going` on that commit: every check passed but `edwin-bench` (shadow stack 12.7%
    over its 10% under the flake check's load), not touched here, which passed when run again alone (7.2%).
    Among those that passed: `nix build .#edwin` (cargo and gui tests), `edwin-typecheck`, `edwin-vc` (94),
    `edit-lockdown` (6), `edit-security` (21), `edwin-display` (20), `edwin-headless` (21), `edwin-scheme` (38).
    This entry's last bullet was written after it; docs/ is outside the checks' sources.

## jj rebase, split by file, undo and redo (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-jj-rewrite`, on git-jj-ops): history rewriting and the
operation log's undo from jj's log and change view, proved by `edwin-vc`.

- **The keys** are majutsu's Evil ones: `r` `jj-rebase`, `u` `jj-undo`, `C-r` `jj-redo` in `jj-log-mode` and
  `jj-change-mode`; `S` `jj-split` in `jj-change-mode`, in Motion and Visual state. What is given to jj is only
  revsets Edwin built (`change_id(ID)` or `commit_id(HEX)`, git-jj-log's revOf, from the line at point or the
  view's change) and file names read from jj, as `root-file:` filesets; nothing typed reaches a revset. Every
  child goes through `Vc.run` (no pager, no colour, `JJ_EDITOR=false`).
- **r** is a mark, not a transient. On a change with no source marked in the workspace it reads the change
  (immutable: `ID SUBJECT is immutable: jj does not rebase it`), marks it, draws `[rebase source]` at the end of
  its log line and says `Rebasing ID SUBJECT and its descendants: r on the change to put them on, r on it again to
  stop`. The mark is kept by workspace root, outside the log's model, so `g r` keeps it. r on the marked change
  again: `No rebase`. r on another change asks `Rebase ID SUBJECT and its descendants onto ID SUBJECT?`, offers to
  save the workspace's changed buffers, and runs `jj rebase --source SRC --onto DEST`; the log and the change view
  are read again and jj's first line said (`Rebased 2 commits to destination.`). The mark goes as soon as a
  destination is picked, whatever comes of it (n: `Nothing rebased`; a source gone meanwhile: `... is gone:
  nothing rebased`). An immutable destination is normal and allowed; `--ignore-immutable` is never given. jj's
  own refusals (onto a descendant) are said from its `Error:` line. The source can be marked from the change
  view (r there marks the change it shows) and put on from the log.
- **S** in the change view splits the file at point (its heading or any line of its hunks), or every file the
  lines of a Visual selection touch, off the change the view shows: `jj split -r REV --message=TEXT --
  root-file:"NAME"...`. Before anything: the change must be mutable; then the save offer, before the files are
  checked, since a saved file is snapshotted into @ and changes what the change shown has when it is @; then the
  files are read again from jj's own template (`diff.files()`, each name and the name it came from), and a picked
  file the change no longer changes is refused (`NAME is not changed in ID SUBJECT now: g r, then pick again`),
  since jj itself would make an empty change of a fileset matching nothing; picking every file is refused
  (`Every file of ID SUBJECT is picked: nothing would be left`). A rename takes the name it came from too, so it
  moves whole. Each name is quoted as a jj string (`\` and `"` escaped), and a name with a control character or
  U+FFFD (the diff is read lossily: not UTF-8) is never given back. Then `*jj-split: NAME*` in vc-message-mode
  with the change's description and the lines `JJ: Splitting NAMES off ID in ROOT: the description of the change
  that takes them; the rest keeps ID's.` and `JJ: C-c C-c splits, C-c C-k aborts. ...`; C-c C-c gives it as one
  `--message=` argument (jj would otherwise open its editor, which is false here). jj keeps the change id on the
  part split off, so the open change view, read again by it, shows that part; the rest is its child with the old
  description. A message jj refuses is kept for the next S on that change, as describe's is.
- **u** reads jj's last operation (`jj op log --limit 1` with a JSON template of its id and description; the
  read snapshots the working copy, as jj undo's own start would) and asks `Undo jj's last operation,
  DESCRIPTION?`. When the last operation is itself an undo (`undo: restore to operation ID`), jj undo (0.33 on)
  does not undo it but steps further back: it undoes operation ID, the one that undo restored to
  (cli/src/commands/undo.rs). So u then reads that operation (`jj op show ID --no-op-diff`, its id checked to be
  ID) and asks `Undo jj's operation before that too, DESCRIPTION?`. When the last operation is a redo (`redo:
  restore to operation ID`, jj's whole description of it) jj undo undoes the redo itself, so u reads operation
  ID the same way and asks `Undo jj's redo of DESCRIPTION?`. When the operation undo would undo is a snapshot of
  the working copy (files written since jj last looked), it asks `Undo jj's snapshot of the working copy (the
  files written since jj last looked go back as they were)?` instead, since undoing it takes those files' new
  text out of the work tree. On y the last operation is read again, and when it is another one (a file written
  while it asked) nothing is undone: `jj's operations changed while asking: nothing undone`. Else `jj undo`, the
  views read again, its first line said (`Undid operation: ...`). n: `Nothing undone`.
- **C-r** runs `jj redo` at once; with nothing to redo jj's refusal is said (`jj redo failed (exit 1): Nothing to
  redo`).
- **Choices**, each reversible:
  - One rebase shape: `--source` (the change and its descendants) onto one destination. No `-r` (the change
    alone), `-b`, `--insert-after`/`--insert-before`, several destinations, `--skip-emptied` or
    `--simplify-parents`.
  - The rebase source is a mark with a confirmation, not majutsu's transient of selections.
  - No save is offered before u and C-r: a save writes files jj then snapshots, and the undo would undo that
    snapshot instead of the operation the user meant. Unsaved buffers keep their text while the files under
    them change, as after any rewrite outside Edwin. Rebase and split offer the save, as new and edit do.
  - A snapshot is not refused by u, only named: undoing one is how written files are put back.
  - Split is by whole file, into a parent and a child (jj's default), never `--parallel`, `--onto` or
    interactive; picking every file is refused rather than leaving jj to make an empty change.
- **Not in it:** hunk-level split (the plan's risk: not ported), the operation log as a view, `jj op restore` or
  `op revert` of an older operation, restore, rebase of several changes at once, bookmarks, fetch and push
  (git-jj-remote).
- **Image replay and edwind.** Each command checks `Ed.proc.refusal()` before anything, and every child goes
  through `Vc.run`, which refuses under the image's replay, in a web frame and in edwind.
- **VcView** (src/vc-git.ts) gains `selected(b, kind)`, the rows of a Visual selection (leaving Visual state) or
  of the line at point, and `redraw(b)`, a view drawn again from its model without a read (the source mark).
- **Checked by**, on ex44, with nixpkgs' jujutsu 0.45.1 and git: `nix build .#checks.x86_64-linux.edwin-vc` (102
  passed, test/vc-jj-rewrite.test.mts's 8 among them) and `edwin-typecheck`, both passed. The suite's workspace:
  an immutable first change A (tag `v1`), B and C on it, D on A beside them, an empty working copy on C:
  - `r` on C: the message and `[rebase source]` on C's line alone, still there after `g r`; `r` on D: the question
    `Rebase ID third and its descendants onto ID side? (y or n)`, y; `rebase --source change_id(C) --onto
    change_id(D)` after the runner's switches; C's parent D, @ on C, B childless, the work tree with d.txt and
    c.txt, the mark gone. The whole graph (every commit with its parents, jj's own template) differs from before.
  - `u`: `Undo jj's last operation, rebase commit HEX and descendants? (y or n)`, y; `undo`; the graph equal to
    the one before the rebase, commit for commit, d.txt gone from the work tree, `Undid operation:` said. `C-r`:
    `redo`, the graph equal to the rebased one. `C-r` again: jj's `Nothing to redo` said, the operation log
    unchanged. `u` then: `Undo jj's redo of rebase commit HEX and descendants? (y or n)`, read by `op log` then
    `op show`; n: `Nothing undone`. `u` with a file written while it asks, then y: refused, no undo run, the
    file kept.
  - r twice on B: `No rebase`, the mark gone; r on B, r on D, n: `Nothing rebased`; r on A: refused as
    immutable, no mark; D onto its descendant C: jj's `Cannot rebase ... onto descendant ...` said, the
    operation log unchanged; r in B's change view, the mark then on B's log line.
  - `u` after a file is written outside jj: the snapshot question; n keeps the file; y: `undo`, the file gone,
    `Undid operation: ... snapshot working copy` said.
  - `u` three times in a workspace of its own (`new` empty, b.txt written, `new` again): `Undo jj's last
    operation, new empty commit?`, y, jj's `Undid operation:` line naming `new empty commit`, b.txt kept; then
    the snapshot question (the last operation is that undo; jj undo steps back over it to b.txt's snapshot), n:
    `Nothing undone`, u again, y: `snapshot working copy` undone, b.txt gone; then `Undo jj's operation before
    that too, new empty commit?`, y: undone, @ described `one`. Three `undo` calls; the op reads in order: `op
    log`; `op log`, `op show`; `op log`, `op show`; `op log`; `op log`, `op show`; `op log`.
  - `S` on k.txt in the change view of @ (changing m.txt and adding k.txt) with a changed buffer of m.txt that
    holds the committed text: `Save m.txt before jj split? (y or n)`, y; m.txt saved, so @ changes k.txt alone,
    and the pick is refused as every file, no split run, no child made.
  - `S` on the heading of `q"\x.txt` in the change view of a change of five files (`a b.txt`, `q"\x.txt`,
    `-lead.txt`, keep.txt and the rename c.txt -> moved.txt): `*jj-split: ws*` with the description and the two
    `JJ:` lines; C-c C-c gives `split -r change_id(E) --message=the odd one\n -- root-file:"q\"\\x.txt"`; the
    change keeps its id with that file and the new description, its child the other four with `fifth`.
  - Visual from `-lead.txt`'s heading down to `a b.txt`'s: both, `root-file:"-lead.txt" root-file:"a b.txt"`;
    the rename: `root-file:"moved.txt" root-file:"c.txt"`, and the part split off holds the rename whole;
    keep.txt alone: every file, refused; keep.txt after jj restored it in that change: refused as not changed
    now, no split run; S in the immutable first change: refused; `jj-split` in the log: `S splits from the
    change view: ...`.
  - Under `Ed.proc.replay`, jj-rebase, jj-split, jj-undo and jj-redo: `while the image replays`, no child
    started.
  - `nix flake check -L --keep-going`: run whole on d77bd9f, the package's first commit (the first run failed
    only in `nix build .#edwin`'s tests/gui.rs, `Xvfb did not start`, the known flake, and so in edwin-daemon;
    run again it passed whole, edwin-bench at 6.4% under its 10%). On b453f87 the reviewer ran it: every check
    passed but edwin-bench, 11.0% with the other checks building beside it, 8.1% run alone (a load-sensitive
    timing check; the package touches no interpreter code). On the commit after it (the save before split's
    file check, u after C-r) it was started and not run to completion: edwin-vc (102 passed) and
    edwin-typecheck were built alone and passed; the whole run is the reviewer's to report. docs/ is outside the
    checks' sources.

## Branches, checkout, reset, stash and tags (done)

Asked 2026-11-16 (the Emacs-to-Edwin plan, package `git-history-ops`, on git-log-show): history operations from
the status and log buffers, each state git leaves (local changes in the way, a detached HEAD, a stash conflict)
reported exactly, a hard reset asking first.

- **Keys**, in `git-status-mode` and `git-log-mode`, as evil-collection binds magit's transients and their
  suffixes: `b b` `git-checkout`, `b c` `git-branch-create`, `b n` `git-branch-new`, `b x` `git-branch-delete`,
  `b m` `git-branch-rename`; `O s`, `O m`, `O h` `git-reset-soft`, `-mixed`, `-hard` (evil-collection's keys,
  checked against nixpkgs' evil-collection-magit.el: `O` for magit's reset `X`, `x` for its delete `k`, `z` the
  stash prefix with `evil-collection-magit-use-z-for-folds` off, its default); `z z` `git-stash`, `z i` `git-stash-index`, `z a` `git-stash-apply`, `z p`
  `git-stash-pop`, `z k` `git-stash-drop`; `t t` `git-tag-create`, `t x` `git-tag-delete`. Each is also M-x from
  any buffer of a git repository, found as SPC g g finds it; a jj workspace is refused (`ROOT is a jj workspace: jj
  has its own commands for its changes and bookmarks; SPC g G's status buffer works on its git repository`).
- **What they act on.** The commit on point's line (a log line, the status buffer's Head, Merge and commit lines,
  a revision buffer's Parent), never a stash's line; the stash on a stash line. Elsewhere they ask, the default
  in the prompt: for `b b` and `b c`/`b n` a local branch at point's commit (one other than the current branch
  when there are several), else the commit (its hash shown by 7 digits), else for `b c`/`b n` the current
  branch; for `O` and `t t` the commit at point, else `HEAD`; for the stash commands `stash@{0}`. The prompts
  complete local branches, remote branches and tags (`for-each-ref`, a read), but RET takes what is typed (no
  candidate selected at first: a typed `stash@{1}` or `HEAD~1` is never swapped for a candidate it happens to
  match); an empty input takes the default.
- **`b b`**: a local branch becomes HEAD (`git switch --end-of-options NAME`); anything else, a remote branch, a
  tag or a commit, is checked out detached (`git switch --detach HASH`), as magit-checkout does. Said: git's
  `Switched to branch 'NAME'` or `Already on 'NAME'`, or `HEAD detached at HASH SUBJECT`; then `; local changes
  kept in N files` when the switch carried them, and `; N commit(s) left on no branch, the last HASH SUBJECT (b n
  there names it)` when it left a detached HEAD's commits behind. Local changes git would overwrite stop it:
  `Not checked out: your local changes to a.txt would be overwritten; commit or stash them (z z) first`, HEAD and
  the work tree as they were (the untracked files in the way are said the same way).
- **`b c` and `b n`** ask the start, then the name, and create the branch checked out (`git switch -c NAME
  --end-of-options START`) or not (`git branch --end-of-options NAME START`). A start that is a ref's name is
  given as it is, so a remote branch becomes the new branch's upstream (git's `branch.autoSetupMerge`); any other
  revision as its commit's full hash. `Switched to a new branch NAME at HASH SUBJECT`, `Branch NAME created at HASH
  SUBJECT`. **`b x`** deletes a local branch (`branch -d`); one git calls not fully merged only after `Branch NAME
  is not fully merged: delete it anyway?` (`branch -D`), as magit asks. **`b m`** renames one, the current by
  default (`branch -m`).
- **`O s`, `O m`, `O h`**: `git reset -q --soft|--mixed|--hard HASH --`, the branch HEAD is on moved (`main reset
  to HASH SUBJECT (hard)`). The hard reset first asks `Hard reset main to HASH SUBJECT, discarding every
  uncommitted change to tracked files?`, and names the untracked or ignored files it would overwrite, which git
  overwrites without a word: those at a path the commit tracks, those where it has a directory (a file `d` where
  it tracks `d/f`) and those in a directory standing where it has a file (`x/p` where it tracks `x`, whether or not
  the index tracks `x`; a wholly untracked `x/` is named as `the untracked directory x/`, an empty one not at all).
  All read with `ls-tree`, `ls-files --others --directory --no-empty-directory` and `diff --diff-filter=D`, then
  `ls-files --others` in the directories a target path is in: `…, and overwriting 2 untracked files d/y.txt,
  x.txt?` (three named at most); n says `Nothing reset` and starts no write. Two kinds of directory are named
  whole rather than by their files, so the question may name more than the reset overwrites: a nested repository
  (a worktree or clone under the tree, as `.claude/worktrees/*`), which `ls-files` lists as a directory and never
  looks into, and a directory whose name is not UTF-8 (read lossily as U+FFFD, it cannot be given back to git as a
  pathspec, so it is not read).
- **`z z` and `z i`** ask a message (empty: git's) and run `git stash push [--staged] [--message=MSG] --`; git's
  line is said (`Saved working directory and index state On main: MSG`, `No local changes to save`). **`z a` and
  `z p`** apply (and, `pop`, drop) with `--index`, so the staged changes come back staged; when git says the
  index part does not apply (`conflicts in index. Try without --index.`, exit 128, nothing changed) it is run
  once more without, and said: `; its staged changes are unstaged: they did not apply to the index`. A conflict
  is said with its files, from `diff --name-only --diff-filter=U`: `stash@{1} applied with conflicts in a.txt:
  resolve them and stage them (s); the stash is kept (z k drops it)`, the status buffer then showing them under
  Unmerged paths. Local changes in the way: `stash@{0} not popped: your local changes to a.txt would be
  overwritten; …`. While a conflict is left nothing is stashed, applied or popped, the files named
  (`stash@{0} not popped: a.txt is in conflict; resolve and stage it (s) first`), where git says only `could not
  write index`. Nor, when the stash carries staged changes (its index commit's tree differs from its base's:
  `rev-parse --verify STASH^1^{tree}` against `^2^{tree}`), while anything is staged: git 2.56's `--index` then
  fails for any staged file, one the stash does not touch too, and unstages them all (`Index was not unstashed.`,
  its file list indented by two spaces), so Edwin refuses first with the files named (`stash@{0} not popped:
  a.txt is staged, and git would unstage it; commit, unstage (u) or stash (z z) it first`); should git still say
  so (a file staged in between), the message names its files and says that git unstaged the staged changes. A
  stash without staged changes applies with `--index` over a staged file, which stays staged (the common case:
  unstaged work stashed, something staged, the work popped back), so it is not refused. Applying without
  `--index` instead would keep the staged files staged but leave the stash's own staged changes unstaged. **`z
  k`** asks `Drop stash@{0} SUBJECT?` first; git drops by name alone, so after y the name is resolved again and a
  stash pushed or dropped while the question was open refuses the drop with the message below.
  A stash line carries the stash's commit as well
  as its name: when `stash@{N}` names another commit by the time the key comes (a stash pushed or dropped since
  the buffer was drawn), `The stashes changed since stash@{N} was shown: g r reads them again`.
- **`t t`** asks a name, then the commit: `git tag --no-sign --end-of-options NAME HASH`, a lightweight tag even
  where `tag.gpgSign` asks for signed ones (a signed tag is annotated, its message needing an editor, and would
  run the signature program). **`t x`** asks `Delete tag NAME?` (a tag has no reflog to bring it back), then `tag
  -d`.
- **Nothing typed becomes a switch.** A revision is resolved to its commit's full hash by `rev-parse --verify
  --quiet --end-of-options REV^{commit}` before any write (`Not a commit: --merge`); a new branch's or tag's
  name must be one `check-ref-format` (`--branch` for a branch) takes, not start with `-`, and expand to itself
  (`@{-1}` is refused); a stash is one of `log --walk-reflogs refs/stash`'s `stash@{N}`; a ref name read from the
  repository that is not UTF-8, holds a control character or starts with `-` is not offered. Names go after
  `--end-of-options`. The runner refuses the switches that would undo its hardening, as for every command.
- **The repository's configuration.** for-each-ref, symbolic-ref, check-ref-format, rev-parse, log and diff are
  the runner's reads (nothing the repository names runs). switch, branch, reset, stash and tag are writes: they
  keep the repository's filter drivers and the like, as the owner expects of a write, and run with the hooks off
  (`core.hooksPath=/dev/null`: no post-checkout hook), which owner decision 12 keeps for commit, push and the
  sequencer only. After each operation, whether it worked or not, the repository's status buffers are read again
  and its log buffers read again from HEAD, in the background.
- **Choices**, each reversible:
  - `b b` on a remote branch detaches HEAD (magit-checkout's way) instead of git switch's guess of a local
    tracking branch; `b c` from the remote branch makes one.
  - No post-checkout hook on checkout (decision 12's list), where magit runs git's hooks.
  - `b x` asks only for a branch that is not fully merged (magit's way); the hard reset, `z k` and `t x` always.
  - Lightweight tags only.
  - Stash apply and pop try `--index` first (magit's way) and fall back once, saying so.
- **Not in it:** magit's transients and their switches; `b s` (spin-off), `b X` (reset a branch), `b l`; `O k`,
  `O i`, `O w`, `O f` (keep, index, worktree, file); stashing untracked files, `z w`, `z x`, `z b`, `z l`, `z v`;
  annotated or signed tags (they need the message buffer), `t r`, `t p`; acting on several branches or tags at
  once; jj's bookmarks (git-jj-ops, git-jj-remote).
- **Image replay and edwind.** Each command checks `Ed.proc.refusal()` before anything (no child starts under the
  image's replay), and every child goes through `Vc.run`, which refuses under the replay, in a web frame and in
  edwind.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (115 passed, test/vc-history.test.mts's 13 among them;
  the other suites unchanged, the stash line now carrying its stash) and `edwin-typecheck`, with real git and
  jujutsu, over one fixture repository (main, other, then feature, topic, tags and stashes):
  - `b b` to `other` with a.txt changed: the refusal above whole, HEAD `main`, a.txt as it was, one write
    (`switch --end-of-options other`), the status read again; with c.txt changed (the same on both): `Switched
    to branch 'other'; local changes kept in 1 file`, the Head line `other`, the hooks off on switch; back.
  - `b b` on the log line of a commit no branch is at: the prompt offers its hash, `HEAD detached at HASH first`,
    `switch --detach FULLHASH`, the log read again from the new HEAD; a commit made there, the Head line its hash,
    `b b main` names it as left behind.
  - `b c` from a log line: `feature` at that commit, checked out, the log showing `HEAD -> feature`; `b n` from
    `main` as typed: `branch --end-of-options topic main`, HEAD still `feature`; refused before any write: names
    `--force`, `@{-1}` and `a..b`, the start `--output=/tmp/x`; an existing name: git's `a branch named 'topic'
    already exists`.
  - `b x`: `topic` (merged) deleted at once, `other` (unmerged) asked: n keeps it, y deletes it with `-D`;
    `b m` renames `main` to `trunk` (the Head line too) and back.
  - `O s` to a typed `HEAD~1` (the index keeps the change), `O m` to HEAD (the index reset, the work tree kept),
    `O h` from a Recent commits line: the question names the branch, hash and subject, n writes nothing; y to a
    typed full hash leaves a clean tree there; `O h --merge`: `Not a commit`, no write.
  - `O h` to a commit that tracks x.txt and d/y.txt, both untracked in the work tree: the question ends `and
    overwriting 2 untracked files d/y.txt, x.txt?`, n writes nothing and keeps them, y overwrites them as asked.
  - `O h` where a file and a directory change places: an untracked file `d` where the target tracks `d/f` (named,
    whether the index tracks `d/f` or not), an untracked `x/p` where the target tracks `x` (`the untracked
    directory x/`; emptied, not named), and a directory `x/` with `x/p` and `x/q` where the index and the target
    track `x` (named `x/p, x/q`); n keeps each, y on the tracked ones loses what was named.
  - `O h` where the target tracks `sub/file` and `sub/` is now a repository of its own holding an untracked
    `sub/file`: `the untracked directory sub/`; where it tracks a file in a directory named by the byte 0xFF, that
    directory wholly untracked: `the untracked directory �/`; n keeps both.
  - `z z` with a staged and an unstaged change (`push --message=both --`), `No local changes to save`, `z a` on
    the unfolded stash line (both back, a.txt staged again), `z i` (the staged change alone), a stash line whose
    commit no longer matches refused, `z p stash@{1}` after a conflicting commit: `--index` refused by git, run
    again without, the conflict message, the stash kept, `UU a.txt` and `Unmerged paths (1)` shown; then `z p`
    and `z z` refused while the conflict is left, no write run.
  - `z p` with a.txt in the way: refused with the file named, the stash and a.txt as they were; then a.txt staged:
    refused before any write, still `M  a.txt` (the stash, `index`, carries a staged change); a stash of an
    unstaged c.txt alone popped over a staged a.txt: `stash@{0} popped` by one `pop --index`, `M  a.txt` and
    ` M c.txt` after; a stash of a staged c.txt popped with a.txt staged just before git runs: git's refusal said
    with a.txt named and its unstaging, the stash kept; `z k` n, a stash pushed from a shell while the question
    is open (y refused, all three kept), and y;
    a clean push and pop: `stash@{0} popped`.
  - `t t` on a Recent commits line under `tag.gpgSign=true` and a `gpg.program` marker script: a lightweight tag,
    no marker; `-d` refused as a name; `t x` n and y.
  - A jj workspace refused with no child started; the fifteen commands under `Ed.proc.replay` refused, no child
    started.
  - `nix flake check` on the final code (2026-11-17, after the review fixes): all checks passed, exit 0;
    `edwin-vc` 115 of 115.

## Fetch, pull and push (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `git-remote`, on git-history-ops): remote operations with
their progress in `*vc-process*`, credentials from the user's agent and never prompted in a way that blocks, a
force push that asks and uses `--force-with-lease`.

- **Keys**, in `git-status-mode` and `git-log-mode`, as evil-collection binds magit's transients (f fetch, F pull,
  and p for magit's push P) and their suffixes: `f u` `git-fetch`, `f a` `git-fetch-all`, `F u` `git-pull`, `p u`
  `git-push`, `p f` `git-push-force` (magit's `-f` switch, `--force-with-lease`, as a key of its own). Each is also
  M-x from any buffer of a git repository; a jj workspace is refused (`ROOT is a jj workspace: jj fetches and
  pushes with its own commands: f f, f a, p p, p c and p d in jj's log (SPC g J); SPC g G's status buffer works
  on its git repository`; the keys named since git-jj-remote).
- **In the background.** Each asks what it needs in the command, says `Fetching origin… (see *vc-process*)` and
  ends; git runs meanwhile (up to 30 minutes), so the frame takes keys. When it ends, the repository's status
  buffers are read again and its log buffers read again from HEAD, then what it did is said. One at a time in a
  repository: a second is refused while one runs (`Fetching origin still runs in ROOT: see *vc-process*`), and
  from the moment the first starts, before it has read the upstream (`A remote command still runs in ROOT: see
  *vc-process*`); a question of the first quit with C-g frees the repository again.
- **Progress in `*vc-process*`.** fetch, pull and push run with `--progress` (git has no terminal), and the
  runner's new `progress` option logs their error output as it comes, each line once it ends; a run of updates
  git writes over each other with a carriage return shows as its latest line, replaced in place while nothing else
  is logged after it, so the log holds `Writing objects: 100% (3/3), 250 bytes | …, done.` and no `\r`.
- **`f u`** fetches from the current branch's upstream's remote, or from a remote asked for (origin, else the
  first, by default) when there is none or HEAD is detached: `fetch --progress --porcelain --end-of-options
  REMOTE`. `Fetched origin: 1 ref updated` (the porcelain lines counted), `Fetched origin: nothing new`. **`f a`**:
  `fetch --progress --porcelain --all`, `Fetched all remotes: …`.
- **`F u`** pulls the current branch's upstream into it (`pull --progress`), merging or rebasing as the user's git
  configuration says (pull.rebase, pull.ff). A branch with no upstream is first given one, asked among the remote
  branches (`origin/NAME` by default): `branch --set-upstream-to=refs/remotes/R/B --end-of-options NAME`. Said:
  `Pulled origin/main into main: now at HASH SUBJECT (fast-forward)` (or a merge's subject), `main is up to date
  with origin/main`; diverged branches with nothing configured: `Not pulled: main and origin/main have diverged,
  and your git configuration does not say how to reconcile them (pull.rebase, pull.ff)`; a conflict: `Pulled
  origin/main with conflicts in a.txt: resolve them and stage them (s), then m m commits the merge, m a aborts it`
  (or `…, then r r goes on, r s skips the commit, r a aborts` for a rebase), the status showing them. Refused
  while a conflict is left, and on a detached HEAD. No editor runs: git's merge takes its own message when it has
  no terminal.
- **`p u`** pushes the current branch to its upstream: `push --progress --porcelain --end-of-options REMOTE
  refs/heads/B:refs/heads/UPSTREAM`, an explicit refspec, so a repository's `remote.R.push` or push.default is
  not what decides. With no upstream it asks the remote (`Set upstream of main and push to remote (origin): `) and
  pushes `--set-upstream` to a branch of the same name. Said from the porcelain line: `Pushed main to origin/main
  (abc1234..def5678)`, `…, a new branch there; origin/main is now its upstream`, `origin/main is already at main:
  nothing to push`; rejected: `Not pushed: origin/main has commits main does not: pull them (F u) first, or force
  push (p f)`; the pre-push hook refusing: `Not pushed: the pre-push hook refused it (see *vc-process*)`. Refused: a detached HEAD, an
  upstream that is a local branch.
- **`p f`** needs an upstream, fetched: the lease is the commit its remote-tracking branch is at when asked, and
  the question names what the push discards: `Force push main to origin/main, discarding 1 commit of origin/main
  not in main (the last HASH SUBJECT)?` (`Force push main to origin/main?` when it discards none). n: `Nothing
  pushed`. y: `--force-with-lease=refs/heads/UPSTREAM:OID`, an explicit lease, so a fetch made in between cannot
  widen it; a remote that has moved since: `Not force-pushed: origin/main is no longer where it was when asked
  (someone pushed): f u fetches it, …`; else `Force-pushed main to origin/main (OLD...NEW (forced update))`.
- **Credentials and the transport's programs (owner decision 12), in the runner.** fetch, pull, push, ls-remote
  and remote (GIT_TRANSPORT) get `-c protocol.ext.allow=never` (an `ext::` URL is a command line, and a
  repository's `protocol.allow=always` would allow it) and, read by one `config --show-scope --get-regexp`: the
  repository's credential helpers dropped (`credential.helper=` empties the list, then the user's own, by URL
  too, are named again in order); its core.sshCommand set back to the user's (`ssh` when the user names none); its
  core.askPass set back to the user's (none when the user names none). These settings go in the child's
  environment (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_N, GIT_CONFIG_VALUE_N, command scope as `-c` is), set only when
  the repository names its own: not on the command line, which `*vc-process*` logs and anyone on the host can
  read in /proc, so a helper's string is in neither; and a user's key `-c` could not name (a
  `credential.URL.helper` whose URL holds `=`) is named as it is. Refused, as no later setting undoes them (git
  takes the first one configured): a repository's `remote.R.uploadpack` or `receivepack` (run here, by the
  shell, for a remote that is a path), its core.gitProxy, its core.alternateRefsCommand (run by the shell, when
  the repository has alternates, to list their refs for a fetch's or push's negotiation: git documents no value
  that turns it off), a `remote.R.vcs` that is not a plain name (`ROOT's own configuration names a program as
  origin's uploadpack: not run here (see *vc-process*)`), a remote whose name starts with `-` (`… names a remote
  whose name starts with `-`, which git would take as a switch: …`) and a remote group (`remotes.G`) holding such
  a name (`… names a name starting with `-` in the remote group G, …`): `fetch --all` starts a fetch per remote,
  and a fetch or a push of a group (or of a remote a group of the same name shadows: git 2.56 expands `origin`
  to the group `remotes.origin`, for push too) one per name, each with no `--end-of-options` before the name, so
  that a name `--upload-pack=CMD` or `--receive-pack=CMD` runs CMD. Both are refused for every command
  of GIT_TRANSPORT, whichever remote it is for. A repository's group of plain names is left alone (one of the
  same name as a remote still redirects `f u` and `p u` to its members, as the repository's own `url` could, and
  one that names itself makes git 2.56's push start itself again until its argument list overflows, about 1800
  levels down: it ends with an error, nothing of the repository's run).
  fetch, pull and push also get
  `--no-recurse-submodules`: a submodule's fetch or push would run under the submodule's own configuration. No
  prompt can block: the child has no terminal (its own session), GIT_TERMINAL_PROMPT=0, and git's own askpass is
  the user's; a failure for want of credentials says where they come from: `…: could not read Username for
  'http://…': terminal prompts disabled; git asks no credentials here: they come from your credential helper or
  ssh agent (see *vc-process*)`. Hooks: push keeps them (decision 12); fetch and pull run none
  (`core.hooksPath=/dev/null`, as for every command but commit, push and the sequencer). A GIT_CONFIG_COUNT
  Edwin itself was started with is replaced, for a transport command in a repository that names its own helper,
  sshCommand or askPass.
- **Nothing read becomes a switch.** Remote names come from `config --get-regexp '^remote\..+\.url$'` (a read),
  those holding a control character, not UTF-8 or starting with `-` left out, and go after `--end-of-options`; the
  upstream's branch (branch.B.merge) must be a `refs/heads/` name with no `:` or other character a ref may not
  hold, else the branch counts as having none. The names git itself passes on to the fetches and pushes it
  starts (`f a`'s `--all`, a remote group) come from the repository's configuration, where one starting with `-`
  is refused (above). `fetch --all` reads remotes from the configuration alone: a `.git/remotes/NAME` or
  `.git/branches/NAME` file named `--upload-pack=CMD` is not fetched by it (checked with git 2.56).
- **Choices**, each reversible:
  - The upstream alone (magit's `u` suffixes) and every remote (`f a`); no push-remote (`p p`, `f p`, `F p`) and
    no elsewhere (`f e`, `F e`, `p e`).
  - pull merges or rebases as the user's git configuration says; Edwin adds no `--ff-only` or `--rebase`.
  - pull runs no hooks: decision 12 names commit, push and the sequencer.
  - A push's signature (push.gpgSign) is a write's, kept as the repository has it, as commit's is; push runs the
    repository's hooks anyway.
  - The repository's sshCommand is set back to the user's core.sshCommand, else `ssh`: a user who chooses ssh by
    the GIT_SSH variable alone gets `ssh` in a repository that names its own sshCommand (GIT_SSH_COMMAND still
    beats both).
  - A repository naming its own uploadpack, receivepack, gitProxy, alternateRefsCommand, a vcs helper path, or a
    remote or group name starting with `-` is refused rather than worked around.
- **Not in it:** magit's transients and their switches (`--prune`, `--tags`, `--rebase` and the rest), pushing
  tags (`p t`, `p T`), a refspec typed (`p r`), pushing another branch (`p o`), `f o`, `f r`, `f m`; continuing or
  aborting a pull's merge or rebase (git-sequencer); jj's git fetch and push (git-jj-remote).
- **Image replay and edwind.** Each command checks `Ed.proc.refusal()` before anything (no child starts under the
  image's replay), and every child goes through `Vc.run`, which refuses under the replay, in a web frame and in
  edwind.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-vc` (125 passed, test/vc-remote.test.mts's 10
  among them; the other suites unchanged) and `edwin-typecheck`, with real git and jujutsu, against local bare
  remotes and a loopback HTTP server, nothing reaching the network:
  - `p u` with no upstream: the prompt, the push with `--set-upstream`, the remote and branch.main.merge after;
    the argv whole, the hooks on, `protocol.ext.allow=never`; `*vc-process*` holding `Writing objects: 100%
    (3/3), … done.`, no `\r` and none of the updates before it; the status read again (`Merge:     origin/main
    first`).
  - `p u` to a bare remote whose pre-receive hook writes `the hook waits` and then waits for a file: while git
    still runs, `*vc-process*` holds `Writing objects: 100% (3/3), … done.` and `remote: the hook waits`, the
    remote's main not yet set; the file made, the push ends (`Pushed main to origin/main, a new branch there; …`).
  - `p u` of a new commit with a pre-push hook that exits 1: the hook run (given `origin`), `Not pushed: the pre-push
    hook refused it (see *vc-process*)`, the remote unchanged; with one that exits 0: run again, `Pushed main to
    origin/main (OLD..NEW)`; `F u` of another clone's commit (fast-forward,
    the hooks off, the argv whole), again (`up to date`).
  - `f u` (`1 ref updated`, the status's `Unpulled from origin/main (1)`), again (`nothing new`); `f a` with a
    second remote, `--all`.
  - A push the remote is ahead of: the rejection, the remote kept; `p f` n (no push run); y with the lease the
    tracking branch named and the remote moved past it: refused as stale, the other commit kept; after `f u`, the
    question naming the commit discarded, y: `Force-pushed …`, the argv whole with
    `--force-with-lease=refs/heads/main:OID`, the remote at main.
  - `F u` diverged: git's refusal said; under pull.rebase=false a merge commit, made with no editor; a conflict on
    a.txt said with its file, `Unmerged paths (1)`; `F u` again refused with no pull run.
  - A repository whose own configuration has `protocol.allow=always`, `protocol.ext.allow=always` and an `ext::`
    remote running a marker script: plain git runs it (the control); `f a` fails with git's `transport 'ext' not
    allowed`, no marker. Then each of remote.origin.uploadpack, receivepack (plain git runs both: the controls),
    core.gitProxy, core.alternateRefsCommand with .git/objects/info/alternates naming the bare remote's objects
    (plain git with the hooks off, `protocol.ext.allow=never`, `--no-recurse-submodules` and `--porcelain`,
    as Vc fetches, runs it: the control) and a remote.origin.vcs path: `f u`, `f a`, `F u` and `p u` each
    refused with the message above, no fetch, pull or push run, no marker. Then, written into .git/config, a
    remote named `--upload-pack=MARKER;:` (plain git with `f a`'s switches and `--all` runs the marker: the
    control), and a group `remotes.origin = "--upload-pack=MARKER;: --receive-pack=MARKER;:"` (plain git with
    `f u`'s switches and `--end-of-options origin` runs the first, with `p u`'s the second: the controls): `f u`,
    `f a`, `F u` and `p u` each refused, no fetch, pull or push run, no marker.
  - core.sshCommand of the repository and of the user, both marker scripts, against an `ssh://` remote: plain git
    runs the repository's (the control); `f u` runs the user's alone.
  - A loopback HTTP server answering 401 with `WWW-Authenticate: Basic`, the repository's credential.helper, a
    credential.URL.helper and core.askPass marker scripts (plain git runs all three: the control) and the user's
    global helper and a global `credential.https://example.invalid/a=b.helper` markers: `f u` ends at once with the
    message above, the server asked, the user's helper alone run, the child's environment naming
    `credential.helper` empty, the user's two helpers and `core.askPass` empty, in that order, no helper on its
    command line or in `*vc-process*`; then `f u` in a repository naming no helper fetches, nothing set in its
    environment. The core.sshCommand case checks the environment the same way.
  - Refused: `p u` and `F u` on a detached HEAD, `p f` with no upstream, `p u` with a local upstream, a second
    `git-fetch` started before the first has read its upstream (`A remote command still runs …`) and one while
    the first runs, `f u` asking again after its question was quit with C-g, `git-fetch` in a jj workspace with no child started, the five commands under
    `Ed.proc.replay` with no child started.

## jj git fetch and push, and bookmarks (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `git-jj-remote`, on git-jj-rewrite and git-remote): remote
operations and bookmark handling from jj's log and change view, tested against a bare remote, proved by `edwin-vc`.

- **Keys**, in `jj-log-mode` and `jj-change-mode`, with the prefixes Edwin's git buffers use (f fetch, p push, b
  branch) and majutsu's suffixes where it has them: `f f` `jj-git-fetch`, `f a` `jj-git-fetch-all`, `p p`
  `jj-git-push`, `p c` `jj-git-push-change`, `p d` `jj-git-push-deleted`; `b c` `jj-bookmark-create`, `b s`
  `jj-bookmark-set`, `b r` `jj-bookmark-rename`, `b d` `jj-bookmark-delete`, `b f` `jj-bookmark-forget`, `b t`
  `jj-bookmark-track`, `b u` `jj-bookmark-untrack`. majutsu's own `G` prefix for its git transient is not taken: in
  Evil's Motion state G goes to the last line, and majutsu's Evil keys never bind it either. The fetch commands also
  work from M-x in any buffer of a jj workspace.
- **Fetch and push in the background**, as git-remote's do: the command says `Fetching… (see *vc-process*)` and
  ends, jj runs (up to 30 minutes) with its error output logged as it comes, then the log and change view are read
  again and what jj reported is said. One at a time in a workspace: a second is refused while one runs (`Pushing
  main to origin still runs in ROOT: see *vc-process*`), and from the moment the first starts reading.
- **`f f`** runs `jj git fetch`, from the remotes jj's configuration names (git.fetch; else origin, or the one
  remote); **`f a`** `jj git fetch --all-remotes`. Said: `Fetched: bookmark: main@origin [updated] tracked` (jj's
  lines, `; ` between them), `Fetched: nothing new`.
- **`p p`** pushes the local bookmarks on the change at point, each as `--bookmark=exact:"NAME"`, so a new one is
  created and tracked on the remote (jj's `--revision` would refuse a new one, saying so with exit 0). None there:
  `No bookmark on ID SUBJECT: b c makes one, p c pushes it under a new one`. **`p c`** is `jj git push --change
  REV`, the bookmark named by jj (`push-` and the change id, or the user's templates.git_push_bookmark). **`p d`**
  is `jj git push --deleted`. The remote is jj's (git.push; else origin, or the one remote).
- **Every push is read first with `--dry-run`.** Nothing to push: `Nothing pushed: WARNING` (jj's warnings, as
  `Refusing to create new remote bookmark ...`) or `Nothing pushed: nothing changed`, and no push runs. When what
  it would do moves a bookmark sideways or backwards on the remote, or deletes one, it asks with jj's lines: `Push
  to origin, bookmark: feat [move sideways from A to B]?`; n: `Nothing pushed`. That is p f's question for git: a
  sideways move is a forced push. jj's own lease holds either way (the remote must be where the last fetch saw
  it). Then: `Pushed to origin: bookmark: feat [add to HEX]`. jj's refusals (no description, a conflict, a private
  commit) are said from its `Error:` line; no `--allow-*` switch is ever given.
- **Bookmarks** act on the change at point (in the log, its line; in the change view, the change shown), its
  revset Edwin's own (git-jj-log's revOf). `b c` asks a name (`Create bookmark at ID SUBJECT: `), `bookmark create
  -r REV -- "NAME"`. `b s` asks a name among the local bookmarks not already there (a new name creates one),
  `bookmark set -r REV -- "NAME"`; when jj refuses a backwards or sideways move it asks `Move bookmark NAME
  backwards or sideways to ID SUBJECT?` and on y runs it again with `--allow-backwards` (n: `Nothing moved`). `b r`
  asks the bookmark (the one at point by default) and the new name, `bookmark rename -- "OLD" "NEW"`. `b d` and `b
  f` ask the bookmark, then `Delete bookmark NAME (p d then deletes it on its remotes)?` or `Forget bookmark NAME
  (jj stops knowing it here; its remotes keep it)?`, `bookmark delete -- exact:"NAME"` (or forget; n: `Nothing
  deleted`, `Nothing forgotten`). `b t` and `b u` ask among the remote bookmarks not tracked, or tracked (the one at
  point by default), `bookmark track -- "NAME"@"REMOTE"` (or untrack). jj's first line is said (`Created 1
  bookmarks pointing to ...`).
- **Nothing typed becomes a switch, a glob or a revset.** Every name goes to jj as a jj string literal, `\` and `"`
  escaped, after `--`; where jj takes a pattern (glob by default) it is `exact:"NAME"`; a remote bookmark is the
  symbol `"NAME"@"REMOTE"`. A name with a control character or U+FFFD is never given to jj. The bookmarks offered
  are read by `jj bookmark list --all-remotes` with a JSON template, the `git` pseudo-remote left out.
- **The transport's programs (owner decision 12), in the runner.** jj 0.45 fetches and pushes by starting git, and
  that git reads the configuration of the git repository jj keeps its commits in: plain jj runs a repository's
  `remote.origin.receivepack` and `uploadpack`, its core.sshCommand and an `ext::` remote it allows (the tests'
  controls). jj takes no `-c` for it, so `Vc.start` gives `jj git fetch` and `jj git push` their settings in jj's
  environment, which jj passes on to that git (GIT_CONFIG_COUNT, KEY_N, VALUE_N, command scope): always
  `protocol.ext.allow=never`, `fetch.recurseSubmodules=false`, `push.recurseSubmodules=no`, and for a fetch
  `core.hooksPath=/dev/null` (fetch runs git's reference-transaction hook); then git-remote's transportOverrides,
  read with `git --git-dir=DIR config` from that repository: its credential helpers dropped for the user's, its
  sshCommand and askPass set back to the user's, and its uploadpack, receivepack, gitProxy, alternateRefsCommand,
  a vcs helper path, a remote or group name starting with `-` refused before jj starts (`ROOT's own configuration
  names a program as origin's receivepack: not run here (see *vc-process*)`). DIR is read from the file system, no
  process run: the store's `git_target` (`../../../.git` when colocated, `git` inside the store when not), the
  store found through `.jj/repo` as jjAdopts finds it (a secondary workspace's `.jj/repo` names it), resolved on
  disk as jj resolves it (onDisk: each `..` taken from its directory's true name, every symlink followed, since the
  native host's names drop `..` as text, so a `.jj` that is a link would otherwise lead to another store), and the
  `git_target` path given to `--git-dir=` as it is, so that git resolves its `..` on disk, as jj's git does. A workspace
  whose store names no git repository is refused. jj reads `git_target` and `.jj/repo` byte for byte, with no
  trimming (`printf 'git ' > store/git_target` sends plain jj's push through a directory `git ` beside `git`), so
  Edwin trims neither: one that is empty, has a control character, or a blank at either end is refused, never
  stripped (jjPathIn), and jjAdopts, which finds the store the same way, refuses it too. A failure for want of credentials says where they come from:
  `jj git fetch failed (exit 1): Git process failed: ...; jj asks no credentials here: they come from your
  credential helper or ssh agent (see *vc-process*)`. transportOverrides now gives its settings as a list
  (configEnv makes the environment), shared by both.
- **Choices**, each reversible:
  - A push runs the repository's hooks as jj's git runs them: not pre-push (jj 0.45 does not run it: a pre-push
    hook in a colocated .git/hooks did not run under plain `jj git push`), but the reference-transaction hook, which
    the git updating the remote-tracking refs runs (checked the same way). Edwin adds none and turns none off for a
    push (decision 12 keeps hooks for push). Since repository code runs on a push anyway, a push's signature
    (push.gpgSign, gpg.program) is left as the repository has it, as git-remote leaves it.
  - Every jj fetch and push replaces a GIT_CONFIG_COUNT Edwin was started with, for that child: the settings above
    are always set.
  - The remote is the one jj's configuration picks; no remote is asked for (`--remote`), and no several at once.
  - A push that only adds or moves forward is not asked; one that moves sideways or backwards, or deletes, is.
  - `b c` and `b s` are both kept, as majutsu has them: create refuses an existing name, set creates or moves.
- **Not in it:** pushing tags, `--all`, `--tracked`, `--named`, push options and the `--allow-*` switches; fetching
  a branch or a tag by pattern, or `--tracked`; `bookmark move --from`, `advance` and `list` as a buffer;
  `--overwrite-existing` on rename, `--include-remotes` on forget; `jj git remote`, clone, init, import and export;
  majutsu's transients.
- **Image replay and edwind.** Each command checks `Ed.proc.refusal()` before anything, and every child goes
  through `Vc.run`, which refuses under the replay, in a web frame and in edwind.
- **Checked by**, on ex44, with nixpkgs' jujutsu 0.45.1 and git: `nix build .#checks.x86_64-linux.edwin-vc` (136
  passed, test/vc-jj-remote.test.mts's 11 among them; the other suites unchanged) and `edwin-typecheck`, both passed, against
  local bare remotes in throwaway workspaces under a throwaway HOME, nothing reaching the network:
  - `f f` after another clone pushed to main: `jj git fetch`, `Fetched: bookmark: main@origin [updated] tracked`,
    main and main@origin at the pushed commit, the log read again; the environment exactly the four settings
    above; the configuration read with `--git-dir=WS/.jj/repo/store/../../../.git`. Again: `Fetched: nothing new`; `f a`:
    `--all-remotes`, `Fetched from every remote: nothing new`.
  - `b c` `feat` on @ (`local work`): the prompt, `bookmark create -r change_id(W) -- "feat"`; `-lead`: `--
    "-lead"`, a bookmark named `-lead` made; `main`: jj's `Bookmark already exists: main` said; `b f` on `-lead`:
    the question, `forget -- exact:"-lead"`. `p p`: the dry run, then `git push --bookmark=exact:"feat"`, `Pushed
    to origin: bookmark: feat [add to HEX]`, the remote's feat at the commit, feat@origin tracked, the push's
    environment without core.hooksPath. `p p` again: `Nothing pushed: nothing changed`, the dry run alone.
  - `b s` `feat` on a sibling: the backwards-or-sideways question, n: `Nothing moved`, feat kept; y:
    `--allow-backwards`, feat on the sibling. `p p`: `Push to origin, bookmark: feat [move sideways from A to B]?`,
    n: `Nothing pushed`, the dry run alone, the remote kept; y: pushed, the remote at B. `b s` `feat` on main's
    change (an ancestor): asked, y; `p p` there: `Push to origin, bookmark: feat [move backward from B to M]?`, y:
    `--bookmark=exact:"feat" --bookmark=exact:"main"`, `Pushed to origin: bookmark: feat [move backward ...]`, the
    remote at M.
  - `p p` with no bookmark at point: refused, no jj git run. `p c`: `--change change_id(W)` dry, then pushed,
    `push-ID` on the remote.
  - `b r` on `push-ID` to `q"x`: `rename -- "push-ID" "q\"x"`, the bookmark of that name there. `b d`: the
    question, n: nothing run; y: `delete -- exact:"push-ID"`, the remote still having it; `p d`: `Push to origin,
    bookmark: push-ID [delete from HEX]?`, y: `--deleted`, the remote branch gone. A branch another clone pushed:
    `f f` says `topic@origin [new] untracked`; `b t` `topic@origin`: `track -- "topic"@"origin"`, topic local and
    tracked; `b u`: untracked; a name not among them: the prompt stays, C-g, nothing run.
  - In the colocated workspace's .git/config, each with plain jj running it first (the control): a receivepack
    marker script: `p d` refused with no jj git push run, `f f` refused too, no marker; an uploadpack: `f a`
    refused, no marker; core.sshCommand of the repository and of the user (global), against an `ssh://` remote:
    `f a` fails with the credentials message, the user's script run, the repository's not, the last setting in the
    environment `core.sshCommand=USER'S`; `protocol.allow=always`, `protocol.ext.allow=always` and an `ext::`
    remote that touches a marker: `f a` fails, `transport 'ext' not allowed` in `*vc-process*`, no marker; a
    reference-transaction hook: `f f` fetches main's new commit, the hook not run.
  - A workspace made with `jj git init --no-colocate`, a receivepack in its store's git/config (plain jj runs it):
    `p p` refused, the configuration read with `--git-dir=WS/.jj/repo/store/git`, no jj git push, no marker, the
    bookmark not on the remote. A secondary workspace of it (`jj workspace add`, its `.jj/repo` a file naming the
    first's): `p p` refused the same way, the first workspace's store read.
  - A `.jj/repo` that is a symlink (`../a/b/c/repo`), so that the store's `../../../.git` is `a/b/.git` on disk
    while the text would say the workspace's own `.git` (a clean repository): a receivepack in `a/b/.git` (plain
    jj runs it): `p p` refused, no marker. The path is given to `git --git-dir=` as it is, `..` and all, for git
    to resolve on disk as jj's git does.
  - A workspace whose `.jj` is a symlink to a secondary workspace's `.jj` (real/w2, its `.jj/repo` the text
    `../../w/.jj/repo`), beside top/w, a copy of real/w whose store names a clean bare repository: plain jj in
    top/w2 runs the receivepack of real/w/.git (the control); `p p` refused, the configuration read from real/w/.git
    alone, no marker. The test's host names files as the native host does (`..` dropped as text, the true name the
    real path), so the suite covers the native host's names.
  - A store whose `git_target` is `git ` (with the space), beside a clean `store/git`, `store/git ` a copy naming a
    receivepack: plain jj pushes through `store/git ` and runs it (the control); `p p` refused (`names no git
    repository it keeps its commits in that Edwin reads as jj does`), no git config read, no jj git push, no
    marker; the same for `git\n`, a blank before an absolute path, a tab and a control character, each beside a
    planted copy. A secondary workspace whose `.jj/repo` has a blank appended, `repo ` beside the clean repo a copy
    naming a receivepack: plain jj runs it (the control); `SPC g J` refused before any jj (`.jj/repo names no jj
    repository Edwin reads as jj does`), the same with a newline appended or a blank before. With the trimming
    reads put back, the first case fails: the push goes through.
  - `p p` to a bare remote whose pre-receive hook waits for a file: while jj runs, `f f` refused (`Pushing main to
    origin still runs in ROOT: see *vc-process*`), no child started; the file made, `Pushed to origin: bookmark:
    main [add to HEX]`. Under `Ed.proc.replay`, the twelve commands: `while the image replays`, no child started.

## Merge, cherry-pick, revert and rebase (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `git-sequencer`, on git-remote): start, continue, skip and
abort for sequenced operations, with their state shown in the status buffer.

- **Keys**, in `git-status-mode` and `git-log-mode`, as evil-collection binds magit's transients (m merge, A
  cherry-pick, _ revert, r rebase): `m m` `git-merge`, `m a` `git-merge-abort`; `A A` `git-cherry-pick`, `A s`
  `git-cherry-pick-skip`, `A a` `git-cherry-pick-abort`; `_ _` `git-revert`, `_ s` `git-revert-skip`, `_ a`
  `git-revert-abort`; `r e` `git-rebase`, `r u` `git-rebase-upstream`, `r r` `git-rebase-continue`, `r s`
  `git-rebase-skip`, `r a` `git-rebase-abort`. `A A` and `_ _` are bound in Visual state too. Each is also M-x
  from any buffer of a git repository; a jj workspace is refused with git-history-ops' message.
- **Start.** `m m` asks `Merge into main: ` among the branches and tags (the current branch left out; the one at
  point by default) and runs `merge --no-edit --end-of-options NAME` (a ref's name as it is, so git's message
  names it; anything else as its commit's hash). `A A` and `_ _` take the commits selected in Visual state
  (cherry-picked oldest first, reverted newest first; in the status buffer only the lines of its commit lists,
  not the Head, Merge, operation or todo lines), else ask `Cherry-pick commit or range A..B (HASH): ` (the
  commit at point by default): a range `A..B` has both ends resolved and its commits counted (`main..main holds
  no commit` when none), and goes to git as `OID..OID`; then `cherry-pick|revert --no-edit --end-of-options …`.
  `r e` asks `Rebase topic onto: ` and runs `rebase --end-of-options ONTO`; `r u` rebases onto the current
  branch's upstream as last fetched (refused on a detached HEAD, with no upstream, or one not yet fetched).
  Said: `Merged other into main: now at HASH SUBJECT` (with ` (fast-forward)` when git says so), `main already
  has HASH SUBJECT: nothing merged`, `Cherry-picked 2 commits (main..other): main at HASH SUBJECT`, `Reverted
  HASH SUBJECT: …`, `Rebased topic onto main: now at …`, `topic is up to date with main: nothing rebased`.
  Refused while a conflict is left (`No merge started: …`, as git-history-ops' commands are).
- **Stopped.** When git stops, what it stopped on is said: `The merge of HASH SUBJECT stopped with conflicts in
  a.txt: resolve them and stage them (s), then m m commits the merge, m a aborts it`; `Cherry-picking stopped at
  HASH SUBJECT with conflicts in a.txt: …, then A A goes on, A s skips the commit, A a aborts`; `Rebasing stopped
  at HASH SUBJECT (1 of 2) with conflicts in a.txt: …, then r r goes on, r s skips the commit, r a aborts`; a pick
  whose changes HEAD already has: `…: its changes are in HEAD already, so it would commit nothing: KEYS`; any
  other stop with git's reason. F u's conflict message now names m m and m a (or r r, r s and r a).
- **Going on** (`m m`, `A A`, `_ _` while their own operation is in progress, and `r r`): refused while a file is
  still in conflict (`a.txt is still in conflict: resolve it and stage it (s) first`); offers to save the
  repository's changed buffers; asks when a staged file still holds a conflict marker (`diff --cached --check`:
  `a.txt still holds a conflict marker: go on with the rebase, committing it as staged?`, n changes nothing:
  `Nothing done: the rebase is where it was`); then `KIND --continue`. Said: `Merge done: main at HASH SUBJECT`,
  or where git stopped next.
- **Skip and abort ask first**, naming what they discard: `Skip HASH SUBJECT, leaving it out of the rebase (its
  changes here and your resolution of them discarded)?`; `Abort the merge of HASH SUBJECT, putting the index and
  the work tree back as HEAD has them (your resolutions discarded)?`; `Abort the rebase, putting topic back at
  HASH SUBJECT (the commits rebased so far and your resolutions discarded)?`; `Abort the cherry-pick|revert,
  putting HEAD back where it was before it (the commits it made and your resolutions discarded)?`. n: `Nothing
  done: …`. Said after: `Rebase aborted: topic at HASH SUBJECT`. A step for an operation not in progress is
  refused: `No rebase in progress`, `No cherry-pick in progress: a rebase is (r r goes on, r s skips the commit, r
  a aborts)`.
- **The state in the status buffer.** Under the head lines, a line for the operation in progress: `Merging HASH
  SUBJECT`, `Cherry-picking HASH SUBJECT`, `Reverting HASH SUBJECT` (or `…, stopped between two commits`),
  `Rebasing topic onto HASH SUBJECT, stopped at HASH SUBJECT (1 of 2)` (`a detached HEAD`; `…, stopped after N of
  M` with no commit stopped at), `Applying patches with git am (N of M)`; RET on it shows the commit. Then the
  steps left, a section `To cherry-pick (1)`, `To revert (N)` or `To rebase (N)` with lines `pick HASH SUBJECT`
  (RET shows the commit). Read on every refresh (`readSeq`) from where git keeps it, whichever backend and
  worktree: `rev-parse --git-path` for rebase-merge, rebase-apply, sequencer and MERGE_HEAD (a linked worktree's
  own), the files there read through the host. CHERRY_PICK_HEAD, REVERT_HEAD and REBASE_HEAD are read by
  their exact names, as git status reads them, never by git's rules for a name typed (refs/NAME, refs/tags/NAME,
  refs/heads/NAME, ...), under which a branch or a tag named CHERRY_PICK_HEAD would be taken for a pick in
  progress: in a files repository each is the file `rev-parse --git-path` names; in a reftable one
  (`rev-parse --show-ref-format` says `reftable`) each is a root ref, listed by `for-each-ref
  --include-root-refs` with the three names. A merge's MERGE_HEAD is read as the file it is. The sequencer's todo has the current commit as its first line, left out.
- **In the background**, as the remote commands: each asks what it needs in the command, says `Rebasing topic
  onto main… (see *vc-process*)` and ends; git runs meanwhile, with no bound on its output and up to 10 minutes
  (as commit: a bound would kill git partway through a rebase), then the status and log buffers are read again
  and what git did is said. One at a time in a repository, sharing the remote commands' lock: a second is refused
  (`A merge, cherry-pick, revert or rebase still runs in ROOT: see *vc-process*`, or the running one's own
  message); a question quit with C-g frees the repository again.
- **Choices**, each reversible:
  - Going on commits with the message git prepared: Vc's new `keepMessage` option sets GIT_EDITOR to `:` (git's
    no-op editor, for which it starts no program) for merge, cherry-pick, revert and rebase alone, and git cleans
    the message as an edited one, so no `# Conflicts:` lines are left in it. With GIT_EDITOR=false (decision 12's
    default) `rebase --continue` after a conflict fails (`problem with the editor 'false'`), checked with git
    2.56; GIT_SEQUENCE_EDITOR stays false. No message is edited in Edwin: c c commits a merge with one written.
    (Since the interactive rebase, below, a rebase's GIT_EDITOR and GIT_SEQUENCE_EDITOR are the frame's, which
    hands back a message after a pick or an edit as `:` did.)
  - The start key of an operation in progress goes on with it (`m m`, `A A`, `_ _`), as magit's transients
    offer; `r e` and `r u` are refused during a rebase (`r r` goes on).
  - Skip and abort ask first; going on asks only over a staged conflict marker.
  - Hooks run (merge, cherry-pick, revert and rebase are the sequencer of decision 12).
  - The pseudorefs are read as files in a files repository, which any git does, so a status refresh adds no
    version floor there. Only a reftable repository runs `for-each-ref --include-root-refs` (git 2.46 or later;
    with an older git the status buffer says git for-each-ref failed, never a wrong state). A git older than
    2.45 (which has no reftable) does not know `--show-ref-format`; rev-parse prints a switch it does not know
    back (checked with an unknown one on git 2.56), and that is read as a files repository.
  - git am in progress is shown, and every command here refuses with `finish it in a terminal: git am
    --continue, --skip or --abort`.
- **Not in it:** the interactive rebase and its todo (git-rebase-todo, since done: `r i`, below); magit's switches (`--ff-only`,
  `--no-ff`, `-x`, `--signoff`, `--autostash`, the strategies); `m e` (merge, editing its message), `m s`
  (squash), `m p` (preview), `A d`/`A n` (cherry-pick without committing), `r i`, `r f`, `r w`, `r m`; git am
  (`w`); a merge's or pick's message edited before going on; `V` (magit's revert key) is not bound.
- **Image replay and edwind.** Each command checks `Ed.proc.refusal()` before anything (no child starts under the
  image's replay), and every child goes through `Vc.run`/`Vc.start`, which refuse under the replay, in a web frame
  and in edwind.
- **Also changed:** the status buffer of vc-git.test.mts's fixture, which holds a merge conflict, now shows
  `Merging HASH side`, and its read-only check counts `rev-parse` among the reads (as does
  vc-stage.test.mts's `n` check).
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-vc` (147 passed, 0 failed,
  test/vc-sequencer.test.mts's 11 among them) and `nix build .#checks.x86_64-linux.edwin-typecheck` (passed);
  edwin-headless (21 passed) and edit-frame (24 passed), which load scm/evil.scm. With real git 2.55 and
  jujutsu in throwaway repositories under a throwaway HOME. At every step below the status
  header is compared whole (the lines above its first blank one: `Head:` with the branch, or the hash when a
  rebase has detached HEAD, an upstream's `Merge:` line, and the operation's line), against git's own reading:
  - `m m` of a branch with a conflict: the argv whole, hooks on, the header `Merging HASH d on other`, `Unmerged
    paths (1)`; `m m` refused with no write run; staged with `s` (still merging); `m m` commits: `merge
    --continue` with GIT_EDITOR `:`, the message `Merge branch 'other'` with no Conflicts lines, two parents, the
    header with no operation line; a status read meanwhile with GIT_EDITOR false.
  - `m a`: n leaves MERGE_HEAD; y: `merge --abort`, HEAD, the work tree and a clean status back; `m m` of an
    ancestor: `nothing merged`, the revision given as its hash.
  - `A A` of a range `main..other` stopping at its first commit: the header and `To cherry-pick (1)` / `pick HASH
    d on other` before and after staging; `A A` goes on (`cherry-pick --continue`, GIT_EDITOR `:`), both commits
    made, no Conflicts lines. `A s` after asking (`cherry-pick --skip`), the rest picked. A single pick: no todo
    section; `A a` after asking, HEAD back.
  - `_ _` through a conflict and `_ _` again (`Revert "second"`, its message whole); `_ a`; in the log, two
    commits selected with `V j` and reverted newest first.
  - `r e` of two commits, each conflicting: `(1 of 2)` with `To rebase (1)`, then `(2 of 2)` with no todo; while
    stopped, `A A`, `A s`, `m m`, `r u` and `r r` (a conflict left) refused with no write; a resolution staged with
    its markers: asked, n runs nothing; then `r r`: `Rebase done`, the branch on main, its two commits, no
    Conflicts lines.
  - `r u` onto a local upstream (`refs/heads/main`), `r s` after asking, `r a` after asking: the branch back at its
    commit, a clean status.
  - A linked worktree: its merge shown in its own status buffer (its own MERGE_HEAD), none in the main work
    tree's, `m a` there.
  - Refused before any write: `--upload-pack=touch x` as `m m`'s revision, `--x..main` as `A A`'s range; `r r`,
    `r s`, `A s`, `_ a`, `m a` with nothing in progress; `git-fetch` while `git-rebase-upstream` readies; `r e`
    asking again after its question was quit with C-g; `git-merge` in a jj workspace with no child started; the
    thirteen commands under `Ed.proc.replay` with no child started.
  - Nothing in progress, with a branch CHERRY_PICK_HEAD, a tag REVERT_HEAD and a branch REBASE_HEAD: the header
    has no operation line; `m m`, `A A`, `_ _` and `r e` ask for their revision (none refused, no `--continue`);
    `A s`, `_ a` and `r s` say nothing is in progress; no write run. A real pick beside the branch of its name
    is still shown. A rebase stopped by a `break` (no REBASE_HEAD) shows the same header with a branch
    REBASE_HEAD added, and `r s` asks to skip `the commit it stopped at`, naming none. In a reftable repository:
    the branch and tag are no pick; a real pick is shown, read with `for-each-ref --include-root-refs`.
  - In the status buffer, a Visual selection from the Head line over the Merge line to an unpulled commit: `A A`
    picks that commit alone.

## Conflict markers (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `git-conflict`, on git-sequencer): a minor mode on files with
conflict markers: jump, keep ours, theirs or both; each resolution exact for git's two-way, diff3 and zdiff3
markers and jj's; nested and malformed markers left untouched with a message.

- **`vc-conflict-mode`** (src/vc.ts, lighter ` Conflict`) turns on in a visited file whose text holds a
  conflict (find-file-hook `vc--conflict-check`), and again when a buffer already open is visited again with one
  (`H.visited`, chained after stack.ts's): a file auto-revert reloaded after a merge wrote its markers is caught
  at the next visit, by find-file or by visit-location (the status buffer's RET). Once a resolution leaves no
  conflict it says `No conflict left` and stays on, so `u` brings the markers back with their keys; Emacs's
  smerge-auto-leave turns smerge-mode off there and puts its re-enabling on the undo list, which Edwin's undo
  (snapshots of the text) has no place for. `M-x vc-conflict-mode` turns it off.
- **Keys**, smerge's: `C-c ^ n` `vc-conflict-next`, `C-c ^ p` `vc-conflict-previous`, `C-c ^ u`
  `vc-conflict-keep-ours`, `C-c ^ l` `vc-conflict-keep-theirs`, `C-c ^ a` `vc-conflict-keep-both` (scm/emacs.scm,
  in `vc-conflict-mode-map`; the same five in Normal and Insert state, scm/evil.scm), and in Normal state `] n`
  and `[ n` for next and previous, through lang-evil-minor-maps' per-minor-mode keys.
- **Going to a conflict** puts point on its opening marker's line start: the first one after point, the last one
  before it; `No later conflict` and `No earlier conflict` past the ends. A malformed one is gone to too, and said
  why (below).
- **Keeping** works on the conflict around point (from its opening marker's line to the end of its closing
  marker's line): ours, theirs, or ours then theirs, the base never kept. It is one `Ed.replaceText`, so one change
  for `u`, refused in a read-only buffer; point is left at the start of the kept text. Off a conflict: `No
  conflict at point`.
- **Parsing** (`Vc.conflicts(text)`, a list of `VcConflict`: start, end, style `git`, `jj` or null, ours, theirs,
  why). A marker is a line that starts with a run of 7 or more of one of `< | = > % + \ -`, then a space, a CR or
  the line's end. A conflict runs from a `<` marker to the first `>` marker of exactly its length after it, and
  its other markers are those of that length, so git's conflict-marker-size, and jj's markers made longer than any
  run in the text, are read, and a run of another length is text. A `<` marker that no `>` marker of its length
  follows is text and the reading goes on at the next line: a file jj gave 11-character markers because its text
  holds a `<<<<<<< ` line has that line read as text and jj's conflict after it read. Outside a conflict,
  `=======`, `>>>>>>>` and `|||||||` lines (a setext heading, quoted mail) are text. A git conflict cut short
  (no closing marker) is therefore text too, not refused: the mode does not find it.
  - git's: `<` [`|` base] `=` `>`; ours is between the opening marker and the first separator, theirs between
    `=======` and the closing marker, each byte for byte (CRLF lines kept). zdiff3 is read as diff3. git never
    lengthens its markers, so a side that holds a line of them cannot be told from a marker: a `<` marker inside
    is refused (below); a git conflict that another `>` marker of its length follows before the next `<` marker
    of its length is refused too, since the file reads the same whether that later marker closes it (theirs
    holding a `>>>>>>> ` line) or is text after it (quoted mail after a conflict), and resolving on either reading
    would be a guess that leaves a marker behind or drops a line. The one left: a two-way conflict whose ours
    holds a `||||||| ` line reads exactly as diff3's, and is read as it, that line and the rest of ours taken for
    the base; its sides are then wrong, and nothing in git's format can detect it.
  - jj's (its default style, `diff`, as jj 0.45 writes it): a conflict is jj's when the line after its opening
    marker is `%%%%%%%` or `+++++++` and its markers' labels are jj's, `conflict N of M` and `conflict N of M
    ends`; with any other labels it is git's, so a git conflict whose ours starts with a `+++++++ ` or `%%%%%%% `
    line is read as git's. Side #1 is ours and side #2 theirs, by order: a `+++++++` section is a side
    as it is; a `%%%%%%%` section, with the `\\\\\\\        to:` line after it, is a side as its ` ` and `+` lines
    without their first character. A section whose (to:) label ends `(no terminating newline)` gives its side
    without its last newline.
  - Malformed, found but never resolved, `This conflict WHY: resolve it by hand`: `holds another conflict` (a `<`
    marker of the same length before its closing marker: nested conflicts, or a git conflict whose ours holds a
    `<<<<<<< ` line, which git's markers cannot tell apart), `ends ambiguously, another closing marker of its
    length following it` (git's, above: theirs holding a `>>>>>>> ` line, or a quoted one after the conflict; the
    conflict found runs to the first closing marker), `has its markers out of order, or one missing`
    (git: no `=======`, two, or `|||||||` after it), `has a diff line that starts with neither a space, - nor +`,
    `has N sides, not two`, `is in jj's snapshot style, which is not read here` (`-------`), `has a marker out of
    place` (a `|`, `=` or stray `\` marker in jj's).
- **Choices** where the package left one open, each reversible:
  - jj's marker style: jj's default, `diff` (owner decision 12); jj's `snapshot` and `git` styles are not set
    anywhere here. jj's `git` style writes git's markers, which are read as git's.
  - For jj, ours is side #1 and theirs side #2, as `jj resolve --tool :ours` and `:theirs` name them.
  - Keep both is ours then theirs, the base left out (Emacs's `C-c ^ a`, smerge-keep-all, keeps the base too).
    With diff3 markers the lines both sides added are in each side, so both has them twice, where git merge-file's
    --union has them once; with two-way and zdiff3 markers it is --union's text. A side with no final newline
    (jj's, at the end of a file) gets one before the other side.
  - git ends each side with a newline before the next marker, so a file whose sides had no final newline ends
    with one after a resolution: the markers do not say that it had none.
  - Command names are Edwin's (`vc-conflict-…`), the C-c ^ keys smerge's; `] n` and `[ n` are Edwin's own.
- **Not in it:** no faces on the markers and sides (a minor mode cannot colour inside another mode's lexer), no
  keep-base, no keep for a conflict of three or more sides, no ediff, no `smerge-refine`; the mode does not turn on
  when auto-revert reloads an open buffer, only at its next visit. Nothing runs a process: the mode reads and edits
  the buffer's text alone, in frames and in edwind alike.
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-vc` (157 passed, 0 failed,
  test/vc-conflict.test.mts's 10 among them), `edwin-typecheck` (passed), `edwin-scheme` (38 passed),
  `edwin-headless` (21 passed) and `edit-frame` (24 passed), which load scm/evil.scm, and `nix build
  .#edwin` (unit 22, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 35). `nix flake check path:$PWD`: all checks
  passed on its first run, `edwin-lockdown` (6), `edwin-security` (21) and `edwin-display` (20) among them. With git 2.55 and jujutsu 0.45.1
  under a throwaway HOME, in test/vc-conflict.test.mts:
  - git merge-file's two-way, diff3 and zdiff3 markers (two conflicts each), a deletion against a change, sides
    with no final newline, CRLF lines, and `--marker-size=9` over 7-character `=======`, `>>>>>>>` and `|||||||`
    lines: each conflict resolved by its key with point on its last line, the text compared with merge-file's
    `--ours`, `--theirs` and `--union` output (both with diff3 markers compared with its own text, as above);
    and two-way markers whose ours starts with `+++++++ ` and `%%%%%%% ` lines, and with an 8-character
    `<<<<<<<< ` line before the conflict; the mode on at the visit, still on after the last resolution.
  - A real `git merge` with merge.conflictStyle=diff3: C-c ^ u gives merge-file --ours of the index's stages.
  - A jj workspace whose `jj new one two` conflicts (jj's style checked as `diff`): f with a snapshot side #1
    and a diff side #2, then a diff side #1, both with no terminating newline; g with runs of six marker
    characters, so its markers are ten long. C-c ^ u and C-c ^ l give what `jj resolve --tool :ours` and
    `:theirs` write (each undone with `jj undo`); C-c ^ a gives side #1 then side #2.
  - A jj workspace whose file holds a `<<<<<<< sample` line and a `=======` line in the context of its
    conflict, so jj's markers are 11 long: the 7-character line is text, `] n` goes to jj's conflict, and C-c ^ u
    and C-c ^ l give `jj resolve --tool :ours` and `:theirs`'s text, C-c ^ a side #1 then side #2.
  - The eleven malformed and nested texts above (two of them `holds another conflict`: a nested conflict, and a
    `<<<<<<< ` line inside a conflict closed once; two `ends ambiguously`: a `>>>>>>> ` line inside theirs, and
    one after the conflict): each key changes nothing, leaves the buffer unmodified and says why; `] n` goes to
    one and says why. A good conflict after a malformed one is resolved, the mode left on.
  - git merge-file's two-way markers over a theirs that holds a `>>>>>>> q` line (the output checked byte for
    byte): one conflict, refused as `ends ambiguously`, running to that line; each key with point inside it changes
    nothing and says so. Two conflicts with a `>>>>>>> quoted` line after the second: the first is read, the
    second refused. A `>>>>>>>> ` line of another length after a conflict leaves it read.
  - Lines of markers outside a conflict, an opening marker with no closing marker of its length among them: the
    visit leaves the mode off; `No conflict at point`. `Vc.conflicts` reads the git conflict after an
    8-character `<<<<<<<< ` line with no closing marker of its own, and after an unclosed `<<<<<<< ` line before a
    conflict of 9-character markers; a git conflict whose ours starts with `+++++++ x` is git's.
  - `] n`, `[ n`, `C-c ^ n`, `C-c ^ p` over two conflicts and past both ends; `u` brings the markers back; C-c ^ l
    in Insert state; after the last conflict is resolved (`No conflict left`) the mode is still on, `u` brings
    that conflict back and `] n` and C-c ^ l work on it; a buffer given markers while open turns the mode on at its next visit, by find-file and by
    visit-location; a read-only buffer is not changed.
  - In a markdown file with a conflict, the mode on: `] ]` (markdown-mode's) goes to the next heading, `C-c C-t`
    cycles a task, `] b` and `[ b` go to another buffer.

## The interactive rebase (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `git-rebase-todo`, on git-conflict): git-rebase-todo buffers
with keys to reorder commits and change their actions, the frame serving as GIT_SEQUENCE_EDITOR; proved by an
interactive rebase that reorders and squashes end to end, and by phase 3's exit gate, one scripted test that
stages a hunk, commits, rebases interactively, resolves a conflict, then runs jj describe and squash.

- **`r i` `git-rebase-interactive`**, in `git-status-mode` and `git-log-mode` with the other rebase keys (and
  M-x in any buffer of a git repository; a jj workspace refused as the others are): asks `Rebase interactively
  from commit`, the commit at point by default, and rebases it and those after it up to HEAD (`rebase -i
  --end-of-options PARENT`, or `rebase -i --root` for a root commit) in the background, as `r e` does: `Rebasing
  main interactively from HASH SUBJECT… (see *vc-process*)`, then `Rebased main interactively: now at HASH
  SUBJECT`, `Nothing rebased: main at HASH SUBJECT` when HEAD did not move, or the git-sequencer's `Rebasing
  stopped at …` with its conflict and its next keys. Refused before any write: a commit not in HEAD's history
  (`HASH SUBJECT is not in main's history: r i rebases a commit of it and those after it`), a revision that is no
  commit (`--exec=touch x` among them), an operation in progress, no commit yet, a second remote or sequencer
  command (the todo open counts as the rebase running), a jj workspace, the image's replay.
- **The todo** is git's own file in a buffer `*git-rebase-todo: NAME*` in `git-rebase-todo-mode` (scm/emacs.scm,
  derived from text-mode, lighter `Rebase`), its text exactly as git wrote it (git 2.55 and 2.56 write `pick HASH #
  SUBJECT`), point on the first step, and is plain text: anything can be typed in Insert state. Its keys, as
  evil-collection binds magit's git-rebase-mode, in Normal state (scm/evil.scm): `p`, `r`, `e`, `s`, `f` and `d`
  (`git-rebase-todo-pick`, `-reword`, `-edit`, `-squash`, `-fixup`, `-drop`) set the action of the commit line
  at point, as one change for `u`, point then to the next line; a `fixup -C` or `-c` flag goes with its old
  action; off a pick, reword, edit, squash, fixup or drop line, `Not a commit's line: only pick, reword, edit,
  squash, fixup and drop lines change`. `M-k` and `M-j` (`git-rebase-todo-move-up`, `-move-down`; `M-p` and `M-n`
  in Emacs's keys, scm/emacs.scm) swap the step at point with the step before or after it, comment and blank
  lines between them staying where they are, the column kept, one change; `Not a step of the todo`, `The first
  step already`, `The last step already`. `Z Z` or `C-c C-c` (`git-rebase-todo-finish`) writes the buffer's text
  back to git's file and lets git go on; `Z Q` or `C-c C-k` (`git-rebase-todo-abort`), or killing the buffer
  (kill-buffer-hook `git--rebase-todo-killed`), aborts: git ends with nothing changed and leaves no rebase behind,
  said `Rebase aborted (C-c C-k): nothing changed`. An empty todo is git's `nothing to do`, said as a git failure
  is: `process-error: Not rebased: nothing to do (see *vc-process*)`. In any other buffer the todo commands say `No rebase waits
  for this todo`.
- **A message git asks for** during the rebase: for a reword, a squash or a fixup step (the last line of
  rebase-merge/done), `COMMIT_EDITMSG` in vc-message-mode (`*git-rebase-message: NAME*`), git's text and comments
  as it wrote them, C-c C-c giving it back as written (git cleans it, with its own comment character), C-c C-k
  aborting it: git then stops at that
  commit with its old message, said `Rebasing stopped at HASH SUBJECT (N of M): its message was aborted (C-c
  C-k), so it keeps the one it had: r r goes on, r s skips the commit, r a aborts`. After any other step (`r r`
  after a conflict on a pick or an edit) git's prepared message is handed back as it is, as the git-sequencer's
  `:` editor did, so no `# Conflicts:` lines are left. The todo and message buffers still open when git ends go
  with it.
- **The hand-back** (src/vc.ts, `VcRunOptions.edit`, for git rebase alone; any other use is refused): git runs
  with GIT_SEQUENCE_EDITOR and GIT_EDITOR both a shell function that prints NUL `edwin-edit` NUL ID NUL FILE NUL
  on its standard output, git's, ID its own shell's process id (`$$`), and reads lines on descriptor 3 until one
  starts with its ID: `ID done` ends it with 0, so git takes the file as it is now; `ID abort`, or the end of its
  input (Edwin gone), with 1. The descriptor is one pipe for every child of git, so the id keeps an answer meant
  for one frame from being read by the editor that runs next: Edwin's answer names the frame's id, an editor skips
  the lines that are not its own, and an answer nobody waits for (to a frame an exec line printed and walked away
  from) stays in the pipe harmlessly. An exec line cannot know the id of an editor that has not started yet. A
  frame whose id is no number is left unanswered. git is started by `sh -c 'exec 3<&0 </dev/null
  && exec "$@"'`: the pipe Edwin writes is git's descriptor 3, which git's children (its editors, hooks and exec
  lines) inherit, and git's standard input is /dev/null, as every other git child's input is closed at once, so
  an exec line's command that reads its input (`exec cat`) gets its end at once and can take no answer.
  `*vc-process*` shows git's argv without the `sh` before it. Edwin reads the frames out of git's output (the
  rest goes to `*vc-process*` as before, a frame split across reads put together) and answers them one at a
  time; a frame's start with no two NULs after it within 4096 characters is no frame, and goes on as output (an
  exec line printing it is held back no longer than that). Only the todo and COMMIT_EDITMSG of the repository's
  own git directory (`rev-parse --git-path`, so a linked worktree's own), compared by their true names, are taken;
  a frame naming any other file is left unanswered, so no other file is opened or written. The todo is taken
  once, and only in `r i`'s `rebase -i`, the one rebase git asks it of: a second frame naming it, or one in `r e`,
  `r u`, `r r` or `r s`, is left unanswered too, so no second todo buffer opens and the todo git works from is
  not written over. A frame naming COMMIT_EDITMSG that no editor printed (an exec line's) cannot be told from a
  real one: it is answered as the step git is at asks (handed back unedited after an exec line, which writes
  nothing), to its own id, which no editor reads. A hook's output goes to git's error output, where no frame is
  read; an exec line's reaches git's output. The run's 10-minute bound counts only while no file is being edited (an exec line's
  command counts toward it, as any of git's own work does), and git is never
  killed while one is: a git killed while its todo waits leaves rebase-merge behind with the todo unedited.
- **Choices** where the package left one open, each reversible:
  - Every rebase Edwin runs but its abort (`r e`, `r u`, `r i`, `r r`, `r s`) has the frame as both editors,
    since rebase-merge/interactive is written by a plain `git rebase` too and cannot tell `r r` of an
    interactive rebase from another; a message after a step that is not a reword, squash or fixup is handed back
    unedited, which is the `:` editor's behaviour. Merge, cherry-pick and revert keep `:`. Every other git child
    keeps GIT_EDITOR and GIT_SEQUENCE_EDITOR false (decision 12).
  - The message buffer's text is handed back uncleaned (`Vc.message`'s `raw`), and git cleans it with its own
    comment character (core.commentChar or core.commentString, `auto` included) and the repository's
    commit.cleanup, as it would after any editor: with core.commentChar `;` a `#123 …` line stays in the message
    and a `;` line goes. C-c C-c still refuses a message with nothing but blank and `#` lines; one with only
    another character's comment lines is git's to refuse (`Aborting commit due to empty commit message`, the
    rebase stopping there for `r r`). Unlike `c c`, which cleans with `#` and commits `--cleanup=verbatim`.
  - A todo or message buffer of another rebase under the same name (a repository of the same base name) is left
    alone: the new one is named `…<2>` (generate-new-buffer-name).
  - The frame going away (edwind or the window closed) while git waits ends git's editor with 1: the todo is
    aborted cleanly; a message stops the rebase there, which `r a` aborts. A git killed while the todo waits
    leaves its rebase-merge behind, which `r a` aborts too.
  - The todo is written back as its text is, with no cleaning: git reads its comments and blank lines itself.
  - Command names are Edwin's (`git-rebase-todo-…`, `git-rebase-interactive`), the keys evil-collection's and
    magit's.
- **Not in it:** keys for exec (`x`), break, label, reset, merge and update-ref lines, which are typed as text;
  `u` stays evil's undo, not magit's `git-rebase-undo`; no commit shown from a todo line (magit's RET and SPC);
  no faces on the todo; `git rebase --edit-todo`; magit's `r f` (autosquash), `r w`, `r m`, `r k` and the
  rebase switches (`--autostash`, `--autosquash`, `--rebase-merges`, `--keep-base`); the todo's `# Commands:`
  help is git's, as git wrote it. No editor for any other git command.
- **Image replay and edwind.** `r i` checks `Ed.proc.refusal()` before anything, as the git-sequencer's commands
  do, and git runs through `Vc.start`, which refuses under the replay, in a web frame and in edwind.
- **Also changed:** test/vc-sequencer.test.mts's `r r` check: GIT_EDITOR is now the frame's editor, the same as
  GIT_SEQUENCE_EDITOR, where it was `:`; the git-sequencer's section below says so.
- **Checked by**, on ex44 (the build host), after the reviews' fixes (git's own comment character, a second
  todo of the same name, git's input /dev/null and the answers on descriptor 3, the bounded frame; then the
  frame's id, so that an answer to a stray frame is never read by the next editor, and the todo taken once):
  `nix build .#checks.x86_64-linux.edwin-vc` (168 passed, 0 failed, test/vc-rebase.test.mts's 10 and
  test/vc-flow.test.mts's 1 among them, test/vc-sequencer.test.mts's 11 still passing), `edwin-typecheck`
  (passed), `edwin-scheme` (38 passed), `edwin-headless` (21 passed) and `edit-frame` (24 passed), which load
  scm/evil.scm, and `nix build .#edwin` (unit 22, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 35).
  `nix flake check path:$PWD`: all checks passed. With nixpkgs' git 2.55 and jujutsu 0.45.1 in the check (git
  2.56 when run by hand), under a throwaway HOME, in throwaway repositories:
  - test/vc-rebase.test.mts (10): `r i` from c1 of base, c1, c2, c3: the argv whole, the buffer git's own file, point
    on its first step; `M-k` on c3 with the column kept, `u` and `C-r` over it, `s` on c2, `Z Z`: git's
    combined message in its buffer, the todo buffer gone, the message written; the log, the files of each commit
    and the branch after, both editors the frame's, no host timeout. `r`, `e` and `d`; `f`, a `fixup -C` line
    typed and set back by `p`; a reword's message written, the stop at the edit (the status header and its `To
    rebase` section), `r r` to the end with the drop left out. C-c C-k, Z Q and killing the todo, each with
    HEAD unchanged and no rebase-merge left; an empty todo; a reword's message aborted, then `r a`. A
    pre-rebase hook (which ran) and an exec line each printing a frame for a file outside the repository: the file
    untouched, no buffer opened, the rebase done. With core.commentChar `;`, a reword's message buffer showing
    git's `;` comments, a `#123 keep me` line kept in the commit and a `;` line left out. A second repository
    named `work` (under another directory): its todo `*git-rebase-todo: work*<2>`, the first todo still open and
    its rebase waiting, each aborted alone. A todo of `pick c2`, then exec lines each printing a frame with the
    exec shell's own id, for the todo, for COMMIT_EDITMSG, and for COMMIT_EDITMSG with `x` for an id, each
    lingering two seconds so that Edwin looks at it while git is still at that exec, then `reword c3`: no second
    todo buffer, the reword's message buffer opens (its editor skipped the answer to the exec's COMMIT_EDITMSG
    frame) and its message lands, the three frames with a number for an id looked at (a `rev-parse` each), the
    `x` one not. A todo of `exec cat`, an exec printing a frame's start and 100 kB with
    no NUL, then a reword: cat ends at once, the reword's message buffer still opens, the rebase done. (Each of
    these four failed on the code before its fix.) `r i` on the root commit from the log buffer: `--root`. Refused
    with no rebase run: a commit of another branch, `--exec=touch x`, a rebase in progress (`git rebase -i`
    stopped at an edit), the todo keys in another buffer and off a step, moving past the ends, `git-fetch` while
    the todo is open, a jj workspace, the image's replay.
  - test/vc-flow.test.mts (1), phase 3's exit gate: in a repository of twenty lines, a hunk of two staged with
    `s` and committed with `c c` (the other left in the work tree), then two more commits; `r i` from the first
    with the third moved above the second (`M-k`), the first dropped (`d`) and the second squashed into the
    third (`s`), `Z Z`: git stops at the third with a conflict; RET on its file in the status buffer visits it in
    vc-conflict-mode, `] n` and `C-c ^ l` resolve it, `C-x C-s`, `s` stages it, `r r`: the squash's message
    written, `Rebase done`, the log, the file and a clean status; `jj git init --colocate`, SPC g g shows jj's
    log, `c` describes the working-copy change and `s` squashes it into its parent with the two descriptions
    written as one, read back with jj's own template.

## Blame (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `git-blame`, on git-rebase-todo): a blame view beside the
file with a jump to the commit, shown as a side buffer (no overlays); proved by edwin-vc on a fixture history.

- **`git-blame`** (`SPC g b` in Normal and Visual state; M-x)
  blames the file the current buffer visits. Its repository is git's around the file (`Vc.repo(dir, 'git')`,
  so a colocated jj workspace is blamed through git and a jj workspace with no git work tree is not in one).
  The blame goes to `*git-blame: PATH*` (`git-blame-mode`, `Git Blame`; PATH the file's from the repository's
  root, `<2>` when another repository's file of that path has one), read-only and in Motion state, one buffer
  a file (by its true name). It takes the window the file was in and the file moves to a new window on its right, so the blame
  reads as the file's left margin; a blame already shown is selected where it is, with no other window.
- **In the background.** The command ends at once with `(blaming PATH…)` as the buffer's text; the blame is
  drawn when git has printed it, point then on the line point was on in the file. A read started later (`g r`,
  `SPC g b` again) wins over one still running, and a read whose buffer was killed draws nothing; while `g r`
  reads, the lines shown stay and `(blaming PATH…)` is a last line under them.
- **The lines.** Line N is the file's line N: its commit's hash (8 characters, `git-hash`), its author (a column
  as wide as the longest author, at most 20, a longer name cut with `…`) and its author date's day in the
  author's own zone (`YYYY-MM-DD`), both `git-dim`, then the line's text as it is, a TAB kept and any other
  control character shown as `?` (a CRLF line's `\r` left out). A line changed and not committed (git's zero
  hash) shows `00000000 Not committed yet`, the hash dim and no day. An empty file says `(the file is empty)`.
- **What is blamed** is the text of the buffer that visits the file when it has changes not saved (`git blame
  --porcelain --contents - -- PATH`, the text on git's standard input), so those lines are the buffer's; else
  the file on disk (`git blame --porcelain -- PATH`), its bytes as committed: a buffer's text decoded from a
  file that is not UTF-8 holds U+FFFD where the file has another byte, and would no longer match the commit.
  Two cases are left: a changed buffer of a file that is not UTF-8 has its lines with such a byte blamed `Not
  committed yet`, and an unchanged buffer whose file changed on disk since it was read is blamed as the disk
  has it. The file is taken by its true name (every symbolic link followed): its repository, PATH, the blame
  buffer it has and the buffer whose text is blamed are the true file's, so a name through a link selects the
  blame the file already has (a link to a file outside the repository blames it in its own repository, or is
  refused outside one). PATH comes after `--`, as one argument. The output is read whole (lossily: it is only shown), each line's group
  `OID ORIG FINAL [COUNT]`, a commit's author, author-time and author-tz from the first group that names it, the
  text after its TAB; lines must come in order, one each, or the blame is refused as `git blame printed a line
  Edwin cannot read`.
- **Keys** in `git-blame-mode` (scm/evil.scm): RET (`git-status-visit`) on a committed line shows its commit in
  the revision buffer (`*git-revision: NAME*`, the git-log-show one, its header, message and diff, `q` back to
  the blame), on a line not committed visits the file at that line; `g r` (`git-status-refresh`) blames again,
  point kept on its line number; `q` leaves; SPC is the leader, as in the other git buffers.
- **Failures** say git's reason: `Not blamed: no such path 'u.txt' in HEAD (see *vc-process*)` for a file git
  does not track, `Not blamed: ` and git's reason with no commit yet; the buffer then says `(the blame could not
  be read: see *vc-process*)` after the lines it had. Refused before any child: a buffer that visits no file
  (`NAME visits no file: git-blame blames a file's lines`; a git view buffer, the blame's own, counts as one),
  a file not in a git repository (`Not in a git repository: DIR`), the image's replay.
- **The repository's configuration.** blame is one of the runner's reads: the hooks off, no pager, no
  fsmonitor, `--no-textconv`, the repository's filter drivers emptied (git runs the clean filter on the
  `--contents` text and on a work-tree file it blames; plain `git blame --contents -` was checked to run it), its alias of
  the name emptied. `--porcelain` fixes the shape against the user's blame.date, blame.showEmail and colouring.
  Two settings that name a file git reads are not followed, as plain `git blame` follows them: a repository
  could point them at any file the user can read (or a FIFO, which hangs git until the 2 minutes are up).
  `blame.ignoreRevsFile`: git dies naming that file's first line that is no commit, which Edwin would show in
  *Messages* and *vc-process*; every value is dropped, the user's too, with `--no-ignore-revs-file` after
  `blame` (and `annotate`), since an empty `-c blame.ignoreRevsFile=` drops none of those before it (checked
  with git 2.56). `mailmap.file`: a repository's is set back to the user's (none when they name none) for every
  read, as its signature programs are; the in-tree `.mailmap`, which git reads without following a link, stays.
- **Choices**, each reversible:
  - `SPC g b`: Edwin's own key, free in the `SPC g` group; the Emacs config binds no blame key.
  - A side buffer with the line's text after the annotation (as vc-annotate draws it) rather than a margin kept
    in step with the file's window: the two windows scroll on their own. Every line names its commit, where
    magit shows a heading for each run of lines of one commit.
  - A buffer with unsaved changes is blamed as shown, those lines not committed yet; nothing is saved or asked.
  - The day is the author's (author-time in author-tz), as `git blame` prints it, not the committer's.
  - No `blame.ignoreRevsFile`, the user's own included (a relative name there is a file the repository holds,
    which may be a link to any file): every line is blamed on the commit that last changed it. Emacs's
    vc-annotate and magit-blame honour it through plain git.
  - The whole blame is read once, bounded by the runner's 16 MiB and 2 minutes; no incremental drawing. The
    porcelain output repeats a header of about 55 bytes for every line, so a file of about 270,000 short lines
    (under 2 MB: 300,000 lines of 7 bytes gave 18.9 MB with git 2.56) already passes 16 MiB: it is not blamed, the buffer saying `(the blame could
    not be read: see *vc-process*)` and the message `git blame failed (its output was too long): see *vc-process*`.
- **Not in it:** overlays, a margin or a gutter in the file's own window (the plan's Risks; owner decision 11
  keeps gutter marks cut); scrolling the two windows together; blaming at another revision or from a line's
  commit's parent (magit's `b` and `B` in its blame); `-w`, `-M` and `-C`; chunk motions (magit's `n` and `p`);
  jj's `jj file annotate` (a jj workspace with no git work tree is refused, a colocated one blamed through git);
  the Emacs keymap (`C-x v g` is unbound).
- **Image replay and edwind.** `git-blame` checks `Ed.proc.refusal()` before anything, and git runs through
  `Vc.run`, which refuses under the replay, in a web frame and in edwind.
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-vc` (179 passed, 0 failed,
  test/vc-blame.test.mts's 11 among them), `edwin-typecheck` (passed), `edwin-scheme` (38 passed),
  `edwin-headless` (21 passed) and `edit-frame` (24 passed), which load scm/evil.scm and scm/init.scm. The four
  new or changed blame cases were also run against the code before the fix: each failed. With nixpkgs' git in
  the check (git 2.56 when run by hand), under a throwaway HOME, in throwaway repositories,
  test/vc-blame.test.mts (11):
  - A file of five lines in three commits by Alice (2026-01-01 +0000), Bartholomew Longname-Smythe (23:30 on
    2026-02-03 at -0500, the 4th in UTC) and Carol (00:30 on 2026-03-01 at +0200, February in UTC), its last
    line a TAB, `five` and a BEL: `SPC g b` from line 3 ends with `(blaming f.txt…)` as the text, the blame in
    the left window and selected, the file in a new right one; then the five lines whole (`Bartholomew
    Longnam…`, the days 2026-02-03 and 2026-03-01, `\tfive?`), each line's commit compared with `git blame -l
    --root`'s, point on line 3, the argv after `blame` exactly `--no-textconv --no-ignore-revs-file --porcelain
    -- f.txt` (the buffer unchanged: the file on disk) with the hooks off, the faces of the hash, author and day
    and the plain text.
  - RET on line 2 shows its commit in `*git-revision: hist*` (`Commit:` its full hash, its message), `q` back.
  - A line inserted in the file's buffer and not saved, then `g r`: `(blaming f.txt…)` under the old lines,
    then `00000000 Not committed yet` with a dim hash and no day on line 1, the others shifted, as `git blame
    --contents -` of the buffer's text says, the argv ending `--contents - -- f.txt`; the file on disk
    unchanged; point kept on line 2; RET on line 1 visits the file there.
  - `SPC g b` from the file's window at line 5 with the blame shown: still two windows, one blame buffer, the
    blame selected, read again, point on line 5.
  - `sub/-x y.txt`: `*git-blame: sub/-x y.txt*`, `--` then the path as one argument, point on line 2; then its
    buffer killed and `g r`: the file on disk, no `--contents`.
  - An untracked file: the message and the buffer's could-not-be-read line; a repository with no commit:
    `Not blamed: ` and git's reason; an empty file: `(the file is empty)`; a buffer with no file, the blame buffer itself, a file outside any
    repository and the image's replay each refused with no child started and no window added.
  - A repository whose own configuration names core.fsmonitor, core.pager, diff.external, a textconv, a
    filter's clean, smudge and process, and alias.blame, all a marker script, with `* diff=evil filter=evil`:
    plain `git blame --contents -` runs the clean filter (the control); `SPC g b` and `g r` run none of them.
    Then its blame.ignoreRevsFile names a file outside it holding `SECRET-TOKEN-123` and its mailmap.file a
    FIFO: plain `git blame` dies with `invalid object name: SECRET-TOKEN-123`, still does with `-c
    blame.ignoreRevsFile=`, and hangs on the FIFO alone (the controls); `g r` draws both lines, the token in
    neither *Messages* nor *vc-process*, `mailmap.file=` on the argv, and runs none of the programs.
  - A file of the bytes `63 61 66 e9 0a 78 0a` (not UTF-8), committed, its buffer unchanged: `SPC g b` gives
    both lines its commit (`caf` then U+FFFD shown), as `git blame -l` says; RET on line 1 shows the commit.
  - With the host's true names those of the file system: the file's buffer killed, then visited through a
    symbolic link to the repository's directory, `SPC g b` selects `*git-blame: f.txt*`, with no `<2>`, the
    path `f.txt` after `--`, point on line 2; a line inserted in the linked buffer and `g r` blames its text
    (`--contents`), line 1 `Not committed yet`.

## The time machine (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `git-timemachine`, on git-blame): a minor mode that shows
earlier versions of the file with n/p, the git-timemachine desktop-only stub removed; proved by edwin-vc, three
revisions stepped, point kept by line.

- **`git-timemachine`** (`SPC g t` in Normal and Visual state, as the Emacs config binds it; M-x) shows the
  committed revisions of the file the current buffer visits. The file is taken by its true name, its repository
  is git's around it (`Vc.repo(dir, 'git')`, so a colocated jj workspace goes through git). The revisions go to
  `*git-timemachine: PATH*` (PATH from the repository's root, `<2>` when another repository's file of that path
  has one) in the window the file was in, one buffer a file: run again from the file, it starts over at the
  newest. The buffer is read-only, in Normal state, in the file's major mode (set from the name, as a visited
  file's is, so its faces are the file's, with no mode hook run) and with `git-timemachine-mode` on (lighter
  ` Timemachine`). It visits no file: nothing saves a revision over the file, and auto-revert, the conflict
  check and the LSP leave it alone.
- **In the background.** The command ends at once with `(reading the revisions of PATH…)` as the text; then
  `git log --no-color --encoding=UTF-8 --format=%x01%H%x00%an%x00%as%x00%s -z --name-only --follow
  --diff-filter=d --diff-merges=first-parent -- :(literal)PATH` lists the revisions, newest first, and the newest
  is read with `git cat-file blob OID:NAME` (NAME the file's name in that commit) and shown, point on the line
  and column point was on in the file. Each step reads its revision the same way; a read asked for later wins
  over one still running, and a read whose buffer was killed or started over shows nothing.
- **The revisions.** Every commit of HEAD's history that changed the file: across renames (`--follow`; each
  revision read by the name it had then), a merge that changed it against its first parent included (the file as
  the merge left it), a commit that deleted it left out (a file deleted and added again steps from the one to the
  other). PATH is a literal pathspec after `--`, so a name with `*`, `[` or `?` names only itself, and a name
  with a leading `-` is no option (in `cat-file` the hash comes first). The output is read whole (lossily: it is
  only shown); an entry not of the shape above is refused as `git log printed a line Edwin cannot read`.
- **Keys** in `git-timemachine-mode` (scm/evil.scm, Normal state, over Normal state's `p` paste and `n`
  search-next): `p` and `C-k` (`git-timemachine-show-previous-revision`) show the older revision, `n` and `C-j`
  (`git-timemachine-show-next-revision`) the newer one, `q` (`git-timemachine-quit`) kills the buffer and shows
  the file's buffer it was started from in its windows. scm/emacs.scm binds `p`, `n` and `q` in the mode's own
  map. Each press goes on from the revision asked for last, so `p p` reads the one two back. At either end the
  key says `This is the oldest revision` or `This is the newest revision` and starts nothing.
- **Point kept by line.** After each step point is on the line number, and column, it was on in the revision
  shown before (the selected window's point when the buffer is in it), the last line when the revision has
  fewer, the line's end when it is shorter, then on the last character as Normal state keeps it; the
  buffer's other windows go to the same place.
- **Which revision.** Each step says it in the echo area, Edwin having no header line: `NAME at HASH (K of N),
  DAY, AUTHOR: SUBJECT`, K counted from the oldest, DAY the author date's day in the author's zone (`%as`).
- **Failures.** A file with no commit that changed it (untracked, or never committed) shows `(PATH has no
  committed revision)` and says so; a repository with no commit, `(the revisions could not be read: see
  *vc-process*)` and `No revisions of PATH: ` with git's reason; a revision git cannot read, `NAME at HASH not
  read: ` with git's reason, the revision shown before kept. Refused before any child: a buffer that visits no
  file (`NAME visits no file: git-timemachine shows a file's revisions`; the time machine's own buffer and the
  git view buffers count as one), a file not in a git repository (`Not in a git repository: DIR`), the image's
  replay; the three step and quit commands run (M-x) elsewhere say `Not a git time machine buffer`.
- **The repository's configuration.** log and cat-file are the runner's reads: the hooks off, no pager, no
  fsmonitor, no external diff, `--no-textconv` after `log`, the repository's filter and diff drivers emptied,
  its signature programs and mailmap.file set back to the user's. `cat-file blob` runs no filter or textconv
  (no `--filters`, no `--textconv`), so a revision is shown as committed. The format, `--follow`, `-z` and
  `--diff-merges` fix the shape against the user's log.follow, log.date, format.pretty, core.quotePath and
  log.diffMerges.
- **Choices**, each reversible:
  - The revision in its own buffer in the file's window, as git-timemachine does, rather than in the file's
    buffer: the file's text, undo and unsaved changes are never touched.
  - `p`/`n` as git-timemachine's own map, `C-k`/`C-j` as evil-collection's (the Emacs config runs
    `evil-collection-init`); evil-collection's `gtg`, `gtt`, `gtc`, `gy`, `gY` and `gb` are not bound.
  - The newest revision is the newest commit that changed the file, not the work tree's text: changes not
    committed are not a revision.
  - Revisions numbered from the oldest (`4 of 4` is the newest).
  - A file not UTF-8 is shown decoded lossily (U+FFFD for a byte that is not), as it is only read.
  - The revision list is read once, whole, bounded by the runner's 16 MiB and 2 minutes, as is each revision; a
    larger one fails with `git log failed (its output was too long)` or `git cat-file failed (…)`.
- **Not in it:** a header line (Edwin has none: the echo area says the revision); going to the nth revision or
  picking one by its subject (`gtg`, `gtt`); copying the hash (`gy`, `gY`); blaming or showing the shown
  revision's commit (`gb`, `c`); jj's file history (a jj workspace with no git work tree is refused, a colocated
  one goes through git); a merge's other parents' sides (the first parent's diff decides); the Emacs keymap
  (`C-x v` has no time machine key).
- **Image replay and edwind.** `git-timemachine` checks `Ed.proc.refusal()` before anything, and git runs through
  `Vc.run`, which refuses under the replay, in a web frame and in edwind.
- **Removed:** the `git-timemachine` desktop-only stub in scm/init.scm; `SPC g t` names the command.
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-vc` (189 passed, 0 failed,
  test/vc-timemachine.test.mts's 10 among them), `edwin-typecheck` (passed), `edwin-scheme` (38 passed),
  `edwin-headless` (21 passed) and `edit-frame` (24 passed), which load scm/evil.scm, scm/emacs.scm and
  scm/init.scm; `nix build .#edwin` (passed). With nixpkgs' git in the check (git 2.56 when run by hand), under a throwaway HOME,
  in throwaway repositories, test/vc-timemachine.test.mts (10):
  - A file of five lines (Alice, 2026-01-01), cut to three (Bob, 23:30 on 2026-02-03 at -0500), renamed
    `f.scm` to `g.scm` (Carol) past an unrelated commit, then six lines (Dave): `SPC g t` from line 2, column 3
    looks up `git-timemachine`, ends with `(reading the revisions of g.scm…)` in the one window, then shows
    Dave's revision as `git show` has it, in the file's mode (scheme-mode, so the display lexes it as the file), no file, read-only, Normal state, the mode
    on, point on line 2 column 3, `g.scm at HASH (4 of 4), 2026-04-01, Dave: fourth`; exactly two children, the
    log's argv after `log` and `cat-file blob OID:g.scm`, the hooks off.
  - From line 5: `p` shows Carol's revision, point on its last line at the end; `p` Bob's, read as `f.scm`;
    `C-k` Alice's, point kept on line 1 column 3; `p` at the oldest says so and starts nothing; `n`, `C-j`
    and `n` back to Dave's, a column clamped to a shorter line; `n` at the newest says so and starts nothing;
    the buffer never changed.
  - `p p` reads the revision two back; with the buffer in two windows, the selected window's point is kept and
    the other window goes to it.
  - `q` shows the file's buffer, the time machine's killed; `SPC g t` twice from the file (the second after a
    `p`): one buffer, the newest, point on the file's line.
  - `sub/-x [y]*.txt` beside `sub/-x y-and-more.txt`, both changed twice: only its own two revisions, `--
    :(literal)sub/-x [y]*.txt` on the argv.
  - A file added, deleted and added again: two revisions, the deletion none.
  - A merge of two branches that each changed a line of `m.txt`, then a merge that changed another file only:
    the first merge is the newest revision, the merged text, then main's and side's; the second is none.
  - A revision of the bytes `63 61 66 e9 0a` is shown as `caf` and U+FFFD; with the host's true names those of
    the file system, a file visited through a symbolic link to the repository's directory is `g.scm` after
    `--`, point on its line, and `q` goes back to the linked buffer.
  - Untracked: `(u.txt has no committed revision)`, `p` then says `No revision is shown` with no child; a
    repository with no commit: the could-not-be-read note and `No revisions of e.txt: `; a buffer with no file,
    the time machine's own buffer, a file outside any repository and the image's replay each refused with no
    child started; `git-timemachine-show-previous-revision` elsewhere says `Not a git time machine buffer`.
  - A repository whose configuration names core.fsmonitor, core.pager, diff.external, a textconv and a filter's
    clean, smudge and process, all a marker script, with `* diff=evil filter=evil`: plain `git show --textconv`
    runs the textconv (the control; the others are only present); `SPC g t` and `p` show both revisions as
    committed and run none of them.

## The TODO section (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `git-todos`, on git-timemachine): the TODO and FIXME lines of
the tracked files listed in the status buffer, as magit-todos does in the Emacs config; proved by edwin-vc on a
fixture; `git grep` run once per refresh, for the cost on a large repository.

- **The section.** The status buffer's last section, after the commits, is `TODOs (N)`: a line for each TODO or
  FIXME line of the tracked files as the work tree has them (a change not staged counts, an untracked or ignored
  file does not), `KEYWORD PATH:LINE TEXT`, the keyword padded to six columns, TEXT the rest of the line after the
  keyword's colon, trimmed. They are in git grep's order: by path, then line. RET on one visits the file at that
  line (`git-status-visit`, as on a hunk's line); s, u and x there say `Nothing to stage here`, `Nothing to
  unstage here` and `Nothing to discard here` and run nothing; TAB folds the section, kept folded through `g r`;
  its heading is a section heading as the others are, which `g j`, `g k`, C-j and C-k go to (its lines are no
  sections: C-j and C-k step over them).
  No line found: no section. Faces: the heading `git-section`, the keyword `git-hash`, `PATH:LINE` `git-dim`.
- **What counts.** `TODO` or `FIXME` in capitals, not inside a word (`XTODO:`, `TODOS:` are not), then an
  optional `(...)`, then a colon: `TODO: x`, `FIXME(ann): x`. A keyword with no colon (`TODO later`) is not
  listed, nor `todo:`. Binary files are left out (`-I`).
- **One git grep per read.** Each time the status buffer is read (SPC g g, `g r`, the refresh after a stage,
  commit or any other write), `git grep --no-color --no-column --full-name -n -z -I -E -e '(^|[^[:alnum:]_])(TODO|FIXME)(\([^)]*\))?:'
  --` runs beside status and the two diffs, so on a large repository its time overlaps theirs. The commit
  commands' own read of what is staged (c c, c a, c w, c f) runs none. The runner adds
  `--no-textconv --no-recurse-submodules` after `grep` (src/vc.ts, GIT_AFTER), and, grep being a read, its usual
  hardening: hooks off, no pager, no fsmonitor, no lazy fetch, the repository's filter and diff drivers emptied.
  The switches fix the output's shape against the repository's or the user's grep.patternType (`-E` beats it),
  grep.column, grep.lineNumber, grep.fullName and color.grep; `-z` keeps a name unquoted, so a name with a space,
  a leading `-`, brackets or a newline is read whole (the output is read as `PATH NUL LINE NUL TEXT LF` in turn)
  and visited by its true name, a control character in it shown as `?`.
- **Bounds.** At most 200 lines listed, the rest counted as `(K more)` under them and in the heading's N; a
  line's text cut at 200 characters with `…`. git grep is given 10 s and 16 MiB. When it takes longer, prints
  more, fails, or prints a line Edwin cannot read, the section is one line, `TODOs (the TODOs are not listed:
  REASON)`, `git grep failed (exit 128): see *vc-process*` and the like; the rest of the status is shown as
  ever. Exit 1 (no line found) is no failure.
- **Choices**, each reversible:
  - TODO and FIXME alone, as the plan asks, not magit-todos' whole hl-todo list (HACK, XXX, NOTE, ...); the colon
    as magit-todos' default keyword suffix has it, so prose that names a keyword is not listed.
  - One flat list in git grep's order, unfolded: magit-todos can group by keyword and file, and folds the
    section past 10 items.
  - Tracked files only, the work tree's text (git grep's default), so an untracked or ignored file (a build's
    output) never fills the section.
  - The section at the bottom (magit-todos' default place).
  - Read with the rest of the status, every time: no cache, no asynchronous second pass; the 10 s bound keeps a
    huge repository's status from waiting longer on it.
- **Not in it:** other keywords; a TODO section in jj's log; a jump to the next TODO from a file; org's
  `* TODO` headings without a colon; the submodules' own TODOs; magit-todos' branch-diff mode (TODOs added on the
  branch alone).
- **Image replay and edwind.** git grep runs through `Vc.run`, which refuses under the image's replay, in a web
  frame and in edwind; the status commands check `Ed.proc.refusal()` first.
- **Changed elsewhere:** test/vc-git.test.mts, test/vc-history.test.mts, test/vc-sequencer.test.mts and
  test/vc-stage.test.mts count `grep` among the reads a status refresh runs.
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-vc` (196 passed, 0 failed,
  test/vc-todos.test.mts's 7 among them), `edwin-typecheck` (passed), `nix build .#edwin` (passed). With
  nixpkgs' git in the check, under a throwaway HOME, in throwaway repositories, test/vc-todos.test.mts (7):
  - A fixture whose tracked `a.c` holds `// TODO: tidy this`, `// FIXME(me): broken`, `/* FIXME: */`, a TODO of
    250 characters and the lines `// TODO without a colon`, `// TODOS: not the keyword`, `// XTODO: not a word`
    and `// todo: lower case`; `crlf.txt` with CRLF endings; `new\nline.txt`; `sp ace/-lead [x].txt`; a binary
    file, an untracked and an ignored file and a submodule each with a TODO; the repository's grep.patternType
    perl, grep.column, grep.lineNumber false, grep.fullName false, color.grep and color.ui always,
    submodule.recurse, and core.fsmonitor, a textconv and a filter that would leave a marker file. `SPC g g`:
    `TODOs (7)` last, its seven lines exactly (the long one cut at 200 with `…`, the newline shown as `?`), one
    git grep with the argv above after `grep` and the runner's hardening before it, run in the root, no marker.
  - RET visits `sp ace/-lead [x].txt` at line 2 and `new\nline.txt` by its true name; `s` on a TODO line says
    `Nothing to stage here`, `u` and `x` the same, the index's bytes and the buffer unchanged; `g j` from
    `Recent commits` and C-k from the first TODO line go to `TODOs (7)`; TAB folds, `g r` keeps it folded, TAB
    unfolds.
  - A TODO added to a file not staged and a file deleted from the work tree: `g r` runs one git grep and lists
    the new line, not the deleted file's.
  - A repository whose only file says `TODO without a colon`: the status with no section and no note. 205 TODOs:
    `TODOs (205)`, the first 200, `(5 more)`.
  - grep.threads set to a value git refuses: the status shown, its last section `TODOs (the TODOs are not
    listed: git grep failed (exit 128): see *vc-process*)`.
  - A TODO staged: the status lists it; `c c` reads the status for the commit, opens the message buffer and
    starts no git grep.
  - `vc-status` under the image's replay refused, no git grep started.

## JSON-RPC for language servers (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lsp-rpc`, on proc-frame-api; owner decision 2: the LSP client
lives in the frame over real pipes, no hub): Content-Length framing, request ids, cancellation and timeouts, as
frame TypeScript; proved by a property test that any chunking of a message stream decodes identically, and an
oversize header refused.

- **`src/lsp-rpc.ts`** (the global `LspRpc`) is the wire alone: nothing in it starts a process or reaches the
  network, so the image's replay stays refused where a server would start, in `Ed.proc` (R16.15). The language
  client (lsp-sessions) will spawn a server through `Ed.proc.spawn`, hand its output to `receive` and give
  `write` the child's `write`.
- **`LspRpc.encode(msg)`** frames a message: `Content-Length: N\r\n\r\n` and the JSON, N its UTF-8 bytes.
- **`LspRpc.decoder(on)`** gives `{push(chunk)}`: each whole body, in order, to `on`. The hosts hand a child's
  output over as strings while Content-Length counts bytes, so the bytes are counted from the UTF-16 code units
  (one below U+0080, two below U+0800, two for each half of a surrogate pair, else three): the count, and so what
  is decoded, does not depend on where a chunk ends, inside a header, its blank line or a pair included. A body
  that comes in many chunks is kept as the chunks and joined once.
- **The framing's refusals.** Header names in any case; `Content-Type` and other headers are read and ignored.
  `push` signals `lsp-error` (new, under `error`), after giving `on` every body before it, at: a header block
  past 4096 bytes (refused as soon as that many have come with no blank line, not waiting for it), a header that
  is not ASCII or a line that is not `NAME: VALUE`, no `Content-Length`, two, one that is not 1 to 10 digits, a
  body past 64 MiB (refused at its header, before any of it is kept), and a length that ends inside a character.
  A stream that broke cannot be found again: the decoder refuses every push after it.
- **`LspRpc.connect({write, requests, onNotification, onClose})`** gives a connection: `receive(chunk)`,
  `request(method, params?, {timeout})`, `notify(method, params?)`, `close(why?)`, `closed()` (why, or null)
  and `pending()`.
  - **Requests** get ids 1, 2, ... per connection; params absent or null are sent as none (JSON-RPC has
    them an array or an object). `request` gives a promise of the result (null when the server
    gives none) with its `id` and `cancel()`. An error answer rejects with `lsp-error` `METHOD: MESSAGE (CODE)`,
    the code its irritant (lsp-sessions will want -32801, content modified); `"error": null` beside a result,
    which some servers send though JSON-RPC forbids both, is no error. An answer to an id not waiting
    (never asked, cancelled, timed out, or a string id, which Edwin never sends) is dropped.
  - **Cancellation**: `cancel()` rejects with `lsp-error` `METHOD: cancelled` and sends `$/cancelRequest
    {id}`; the server's late answer, a result or its -32800, is dropped. A second cancel sends nothing. The
    promise is `EdPool.interruptible`'s shape, so a command awaiting `EdPool.interruptible(request)` is
    cancelled by C-g.
  - **Timeouts**: 10 s unless the caller names one (`timeout` in ms; 0, Infinity, or past 2^31 - 1 ms, about
    24.8 days, the longest setTimeout takes, is none). Past it the request rejects with `timeout` and `$/cancelRequest` goes to the server, as on cancel. Every way a request
    ends clears its timer.
  - **The server's requests** are answered by `requests[method](params)` (a value or a promise of one; JSON null
    for undefined); a method with no handler (looked up as the object's own key, so `constructor` and
    `__proto__` are no handlers) is answered -32601 method not found, a handler that throws -32603 with its
    error's text. **Notifications** go to `onNotification(method, params)`; one that throws is reported and the
    connection goes on.
  - **A message that is not JSON** (params or a handler's result holding a BigInt, which Edwin's exact integers
    past 2^53 are, a cycle, or a toJSON that throws) fails alone and the connection goes on: its `request`
    rejects with `lsp-error` `METHOD: params that are not JSON` before anything is sent, its `notify` throws
    that, and the server's request it answers gets -32603 `Edwin answered with a result that is not JSON`.
  - **Closing.** `close(why)`, a broken stream (its `lsp-error` text the why) and a write that returns false or
    throws (the child's input closed, or 64 MiB not yet taken; a message that is not JSON is not a write that
    failed, the bullet above) close the connection: every waiting request rejects
    with `lsp-error` `METHOD: WHY`, `onClose(why)` is called once, nothing more is sent or received (the rest
    of the chunk it closed in included: no notification after onClose, no handler run), a later `request`
    rejects and `notify` throws.
  - A body that is not JSON, or is JSON but not an object, is framed correctly and is dropped; the connection
    goes on. A message is told by its fields (`method` with or without `id`, else a response), not by `jsonrpc`;
    one with a `method` that is not a string is dropped, never taken for a response, though its id is waiting.
- **Choices**, each reversible:
  - Strict `\r\n` framing, as the specification has it: a server that ends its header lines with `\n` alone is
    refused, not guessed at.
  - The bounds: 4096 bytes of header (a server's is two short lines) and 64 MiB of body (semantic tokens of a
    large file and a workspace's symbols stay well under it).
  - 10 s for a request when the caller names none, as eglot's jsonrpc-request; initialize and the slow ones
    will name their own in lsp-sessions.
  - No message's body is put into an error or a log: a server's payload holds file text. An error answer's own
    message is shown, cut at 500 characters.
  - The Content-Type's charset is not checked: LSP has only UTF-8, and the hosts decode the child's output as
    UTF-8 already (a child whose output is not is stopped by `Ed.proc`).
- **Not in it:** no server process, session, restart or capability (lsp-sessions); no batches (LSP sends
  none); the server's own `$/cancelRequest` for a request it asked is not acted on (its answer is sent anyway,
  which JSON-RPC allows); no flow control past `Ed.proc`'s 64 MiB of unsent input.
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-lsp` (new; 10 passed, 0
  failed, test/lsp-rpc.test.mts, fast-check from the dev dependencies, 1000 runs each, the broken streams 250,
  LSPRPC_RUNS raises them), `edwin-typecheck` (passed), `edwin-headless` (passed), `edit-lockdown`, `edit-security`,
  `edit-console` and `edit-front` (passed), `nix build .#edwin` (passed). test/lsp-rpc.test.mts (10):
  - Random streams of up to 8 requests, notifications and responses (strings of `é`, `€`, an astral character,
    CRLFs, blank lines, `Content-Length: 3` and quotes inside them), each with a header in one of three shapes
    (`content-length:N` in lower case, a Content-Type first): decoded whole they give the bodies and the
    messages sent; cut at up to 30 random places, and at every code unit, they decode the same.
  - The same with each of 11 broken tails after them (a header past the bound, with and without its end; no,
    doubled, negative and 11-digit lengths; a body past 64 MiB; lengths ending inside `é` and between a pair's
    halves; a bare LF in a header; a non-ASCII header): the same bodies before it and the same fault, however
    cut, and nothing after.
  - `encode`'s length equals Node's `Buffer.byteLength`; a lone surrogate is escaped by JSON.stringify.
  - A header of 4096 bytes is read, one of 4097 refused; 4207 bytes with no blank line yet refused before it comes,
    and every push after refused.
  - A notify with null params sent without them. Two requests answered in reverse order, an unknown id, a string
    id, a result with an astral character, an
    error answer (`a: bad params (-32602)`, code -32602), a late answer, an answer with no result (null), a
    result beside `"error": null`, a message with a waiting id and `method` 5 or null (dropped), a body
    that is not JSON and one that is an array, the connection still open.
  - Cancel: rejected, one `$/cancelRequest`, the late -32800 dropped; a timeout of 20 ms: `timeout`, a
    `$/cancelRequest`, the late answer dropped; one answered in time sends none after its time; timeouts of 0
    and 3e9 ms wait; C-g through `EdPool.interruptible` rejects with quit and cancels.
  - The server's `workspace/configuration` answered by its handler, one answered after an await (a string id),
    `window/showDocument`, `constructor` and `__proto__` answered -32601, a throwing handler -32603;
    notifications delivered in order.
  - Params of a BigInt and of a cycle: that request rejects alone, before anything is sent, and the other
    still waiting is answered; a notify of a BigInt throws; handlers returning a cycle and a BigInt answered
    -32603; the connection open and onClose not called.
  - `close`: both waiting requests rejected, the timer of one cleared (no cancel sent after), onClose once, a
    request after it rejected and a notify thrown; a bad Content-Length closing the connection; a write
    returning false and one throwing closing it; a notification that closes the connection, and a -32601 reply
    whose write fails, with more messages in the same chunk: nothing of the rest delivered or handled.
  - A stand-in server as a real child through `Ed.proc.spawn` (test/fake-proc.mts), its own framing over bytes,
    writing three bytes at a time so characters are cut across the client's chunks: three requests at once
    (one a 50-times-repeated text of astral and two- and three-byte characters with CRLFs and
    `Content-Length: 1` in it), the server asking `workspace/configuration` and reporting the answer in a
    notification, `exit` ending it with 0 and no child left.

## Language server sessions (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lsp-sessions`, on lsp-rpc; owner decision 2: the client in the
frame over real pipes, no hub, the other LSP details the plan's defaults): one server process per project root and
server kind over Ed.proc pipes, initialize, shutdown, restart on crash with backoff, idle stop; in standalone edwin
and edwinclient, none in web frames; proved by edwin-lsp with a scripted stand-in server: start, crash-restart
capped, clean shutdown on exit, no child left.

- **`src/lsp.ts`** (new, `Ed.lsp`, through the seven places of the touch list, after `lsp-rpc`) runs the sessions;
  **`scm/lsp.scm`** (new; sources.rs SCM, console/manifest.json, both pages' SCM lists, and CONFIG as a lazy file
  after `next-error.scm` and before `init.scm`, so a user's init.scm can declare a server) holds the declaration
  form. The server table itself is lsp-servers'.
- **`(define-language-server NAME :modes MODES :command ARGV)`** declares server NAME (a symbol: letters, digits and
  `+._-`) for the major modes MODES (a non-empty list) run as ARGV (a non-empty list of strings, the program first,
  looked up on PATH by the host). Declaring NAME again replaces it; of two servers for one mode the one declared
  last serves it. Refused, with `lsp-error`: no `:modes` or `:command`, an unknown option and a keyword with no
  value (signalled by the form in scm/lsp.scm), an empty or non-string one and a name that is not a plain symbol
  (by `%lsp-declare`, src/lsp.ts). **A declaration while the image replays** (`Ed.proc.replaying()`, which
  format-buffer added to src/proc.ts) is skipped: an argv the image declared would otherwise run the next time the user starts a server,
  which is the image reaching a process (R16.15). It is skipped with a message (`define-language-server: NAME is not
  declared while the image replays`), not an error, because a served frame evaluates edwind's init.scm the same way
  inside one handler (src/sync.ts): an error would stop every later form of that file. The limit is Ed.proc's
  (above): a procedure the image defines that runs later, outside the replay (a hook, a timer), and declares a
  server is not told from the user's own. A session copies its argv when it is made, so a later declaration (from
  anywhere) never changes what a running session starts again; `eglot-reconnect` takes the declaration as it is then.
- **Where a server runs.** The root of a buffer is the nearest directory up from its file's with a `.git` or a
  `.jj` (compile's project), else the file's directory. A buffer with no file, a shared buffer, a file edwind
  serves (a note: not on this machine) and a host with no file system get no server (`lsp-error`). One session per
  server and root: a second buffer of the root uses the running process. Every session is made by one function that
  first looks for the root's, so `eglot-reconnect` uses a session `eglot` (or a second reconnect) made for the root
  while the old server was shutting down, rather than making a second process. The old session's buffers go on
  the new one only if they are still live: a buffer killed while the old server shut down was detached by then,
  so its `kill-buffer-hook` found no session, and the reconnect skips it; when none is left the new session gets
  its idle stop like any other, instead of running until quit. `eglot-shutdown-all` or quitting while a reconnect
  waits for its old server ends that reconnect: nothing is started, the echo area says `NAME in ROOT: not started
  again: every language server was shut down`, and `Ed.lsp.reconnect` gives null. Each shutdown of every server
  counts one more, and a reconnect that sees the count changed across its wait starts nothing; a later `eglot`
  starts a server as ever.
- **The child** is `Ed.proc.spawn(ARGV, {cwd: ROOT})`: no output bound and no timeout (a server lives long and a
  workspace's answers are large; lsp-rpc bounds a message at 64 MiB), output and error apart. Its output goes to
  an `LspRpc` connection, which writes to its input. Its error output is the server's own log: the last 64 KiB are
  kept on the session and shown by `eglot-stderr-buffer`, never in the echo area or `*Messages*` (it may hold file
  text). The image never reaches it: every start goes through `Ed.proc`, refused while the image replays, in a web
  frame and on edwind's Node host (`process-error`, before anything is spawned).
- **Initialize.** `initialize` with `processId` null, `clientInfo` Edwin, `rootPath`, `rootUri` and one workspace
  folder (a `file://` URI, each path segment percent-encoded as UTF-8: a root `one two #3 %20 é` is
  `.../one%20two%20%233%20%2520%20%C3%A9`), the client capabilities `general.positionEncodings: ["utf-16"]`,
  `workspace.configuration` and `workspaceFolders`; 30 s for its answer (eglot's `eglot-connect-timeout`). Then
  `initialized`; the server's capabilities are kept on the session (`capabilities`), and the echo area says
  `NAME in ROOT: ready`. The command that starts a server returns once the child runs: no key waits on
  initialize. `Ed.lsp.ready(session)` settles when it has been initialized and rejects when it is shut down or
  given up.
- **The server's requests** answered: `workspace/configuration` with null for each item (the server's defaults;
  settings are lsp-servers'), `workspace/workspaceFolders` with the root, `client/registerCapability`,
  `client/unregisterCapability`, `window/workDoneProgress/create` and `window/showMessageRequest` with null; any
  other `-32601` (lsp-rpc). `window/showMessage` of an error or a warning goes to the echo area as `NAME: error:
  TEXT` (cut at 500 characters); info and log messages, `window/logMessage` and every other notification are
  dropped until a package needs them.
- **A crash** is the child ending, its stream breaking its framing, its input closing, or initialize failing (an
  error answer or no answer in 30 s), when nobody asked it to stop: the child is KILLed if it still runs, every
  request waiting on it rejects, and it is started again after 1 s, then 2, 4, 8 and 16 s. After 5 starts again in
  a row it is given up: the session is `failed`, the echo area says `NAME in ROOT: WHY; it ended 6 times in a row,
  so it is not started again (M-x eglot-reconnect starts it)`, and nothing is scheduled. A server that ran 60 s
  before it ended starts the count again. A start again that is refused (the program gone from PATH, or the image's
  replay window open in that turn) counts as one more end, and as no run, so a program gone from PATH is given up even
  after a healthy run. `eglot` on a failed session starts it again with the
  count at 0.
- **Shutdown** (`eglot-shutdown`, `eglot-shutdown-all`, the idle stop, quitting): the session is forgotten at once
  (a start after it makes a new one); a running server gets `shutdown` (1 s for its answer, then `$/cancelRequest`
  as for any request past its time), then `exit` and its input closed; a child not ended 400 ms later is KILLed
  and given 200 ms more. A server still initializing gets `exit` alone. **On quitting** (native/js/main.ts's
  `quit`, after edwind has confirmed the edits) every session is shut down this way in parallel before the
  program exits, so within about 1.6 s; main.rs's `proc::kill_all` still ends any child left.
- **Idle stop.** `eglot` attaches the buffer to its session; `kill-buffer-hook` detaches it. A session no buffer
  uses is shut down after 5 minutes; a buffer attached in that time keeps it.
- **Commands** (eglot's names, decision 2's default; no keys yet): `eglot` (start this buffer's server, or say
  `already running` or how it is), `eglot-shutdown` (this buffer's server), `eglot-shutdown-all`, `eglot-reconnect`
  (shut down and start afresh, its buffers kept), `eglot-stderr-buffer` (`*EGLOT NAME stderr*`, read-only). They
  are frame commands (TypeScript `CMD`), so in edwinclient they run in the frame, on its machine.
- **Choices**, each reversible:
  - Auto-start trust per project (decision 2): servers start only by `eglot` in this package; starting them on
    visiting a file is lsp-frame-docs's eglot-mode.
  - Idle stop after 5 minutes with no buffer (decision 2's "idle shutdown"); eglot's `eglot-autoshutdown` stops at
    once when the last buffer goes, and is off by default.
  - Starts again with a doubling delay from 1 s, at most 5 in a row, a 60 s run counting as healthy: eglot's
    `eglot-autoreconnect` reconnects only a server that ran 3 s, once per end, with no bound.
  - The bounds on quitting (1 s, 400 ms, 200 ms) keep a quit under the 2 s a frame may block.
  - Only UTF-16 positions are offered (lsp-frame-docs converts).
- **Differences from eglot:** no events buffer (`eglot-events-buffer`): the error output only. The root is the
  `.git`/`.jj` directory, not project.el's (no `.project` markers, no per-server root files). A server is an argv
  (no TCP contact, no function). `processId` is null: the desktop program does not give its pid, and a server whose
  parent dies sees its input close. `window/showMessageRequest` is answered null, not offered as a choice.
  `eglot-shutdown` acts on the current buffer's server and does not ask which. In edwinclient, a server declared in
  edwind's init.scm is skipped (that file is evaluated as the image is) and the rest of the file runs; the standalone
  program's init.scm declares them. Until lsp-servers ships the table in scm/lsp.scm, an edwinclient frame has no
  way to declare a server (its init.scm is replayed, its M-: evaluates on edwind), so there `eglot` answers that no
  server is declared: the edwinclient half is not exercised by any test in this package.
- **Not in it:** documents (didOpen, didChange, didSave, didClose: lsp-frame-docs) and eglot-mode; the server
  table and settings (lsp-servers); direnv's environment (lsp-direnv); watched files; any request past initialize
  and shutdown; a mode-line indicator; a list of the running servers. src/proc.ts is not changed.
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-lsp` (27 passed, 0 failed:
  test/lsp-rpc.test.mts's 10 and test/lsp.test.mts's 17, nil from nixpkgs run in the sandbox, not skipped),
  `edwin-typecheck`, `edwin-headless` (21; the pages' and the manifest's file and Scheme lists), `edwin-native`
  (31; boot.ts's FILES equal host-node.cts's), `edwin-proc` (13), `edwin-compile` (39), `edwin-prog` (41),
  `edit-console` (4), `edit-front` (9), `edit-lockdown` (6) and `edit-security` (21), since scm/lsp.scm and
  src/lsp.ts also load in edwind; `nix build .#edwin` (unit 32 and 2 ignored, `tests/gui.rs` 5 and 1
  ignored, `tests/terminal.rs` 37); `nix flake check path:$PWD`: all checks passed, after edwin-bench, a timing
  bound, failed once on a loaded host (the shadow stack 10.5% over its 10% limit) and passed built again alone
  (6.9%). test/lsp.test.mts (17), each against the stand-in server
  (node, its behaviour chosen by its argv) unless named, every test starting with no child left:
  - `eglot` returns with the session `starting`; the argv, the root as cwd, no output bound or timeout; then
    `running` with the server's capabilities, `ready` in the echo area; initialize's `rootUri`, `rootPath`,
    workspace folder, null `processId` and UTF-16 for a root `one two #3 %20 é`; `workspace/configuration`
    answered `[null,null]`; the error output kept; a second buffer of the root on the same process (`already
    running`), another root and another server one process each (3); `eglot-stderr-buffer`.
  - `eglot-shutdown`: shutdown, then exit, the child's code 0, the buffer without a server at once, a second
    `eglot-shutdown` a user-error; `shutdown-all` of two servers within 1.5 s, no child left.
  - A server that ignores exit, and one that answers nothing after initialize: KILLed within the bounds, shutdown
    waited for only when not answered.
  - Ending after each initialize with 3 starts again allowed: 4 processes, `failed`, the message, nothing started
    in the time after; `eglot` starts it again with the count at 0.
  - The delays at 100 ms: gaps of at least 100, 200 and 400 ms between the 4 starts; a wait on it rejected when
    it gives up.
  - A crash once: started again, initialized again by a new process; KILLed after a healthy run, the count starts
    again.
  - A broken Content-Length: the child killed, started again, given up with the framing's reason; an unanswered
    initialize (1.5 s): given up, the child killed.
  - Idle stop at 150 ms: the last buffer killed, another attached in time keeps the session; killed again, it is
    shut down (shutdown, exit) only after its time.
  - `eglot-reconnect`: refused while the image replays with the server left running; then a new process, both
    buffers on it.
  - `eglot-reconnect` racing `eglot` in the root's other buffer, and two reconnects at once: one session, both
    buffers on it, one process, none left after `shutdown-all` (fails with reconnect making its session
    unconditionally: two processes, one in no session, still running after `shutdown-all`).
  - A buffer killed while `eglot-reconnect` waits for the old server, idle at 150 ms: the new session holds only
    the root's other buffer, and stops (shutdown, exit) after that one is killed too; then the root's only buffer
    killed while a reconnect waits: the new session has no buffer and stops after its time, none left (fails with
    the buffers attached unchecked: the dead buffer stays on the session and it runs on).
  - `Ed.lsp.shutdownAll` (as quitting calls it), and in a second test `eglot-shutdown-all`, run while
    `eglot-reconnect` waits for the old server: no spawn after it, no child, no session, the buffer on none, the
    old server's log `initialize, initialized, answer, shutdown, exit`, the message; then `eglot` starts a server
    (both fail without the count: the reconnect starts a server after the shutdown-all, the buffer attached to it,
    still running).
  - The refusals, nothing spawned: `eglot` while the image replays; two declarations there, evaluated as a served
    frame evaluates edwind's init.scm, skipped with the message (the declaration before kept) and the form after
    them run, a web frame, no `host.proc`, a buffer with no file, a shared buffer, a mode with no server; a missing
    program a `process-error` with no session kept; the declaration's own refusals, each an `lsp-error` (fails with
    scm/lsp.scm's `error`: a plain `error` condition).
  - A session started again keeps its argv after the server is declared again.
  - nil: initialize gives `definitionProvider`, a KILL started again with a new process, shutdown and exit end it
    with code 0.
  - A program gone from PATH after a healthy run: each start again refused, given up after the bound (fails with
    the `started` reset before a start again taken out: it retried forever).
  - In the built program (`tests/terminal.rs`, `quitting_shuts_the_language_servers_down`): `edwin -f eglot
    proj/x.nix` with the server declared in init.scm, `:q`, the server's log `initialize, initialized, shutdown,
    exit` and its process ended.

## Document sync and eglot-mode (done)

Asked 2026-11-18 (the Emacs-to-Edwin plan, package `lsp-frame-docs`, on lsp-sessions; owner decision 2: the client
in the frame, the other LSP details the plan's defaults): didOpen, didChange (incremental), didSave and didClose;
eglot-mode turns on per language when a server is configured; proved by edwin-lsp: the server's text equals the
buffer's after random edits. Risk named: UTF-16 positions.

- **`src/lsp.ts`** holds it, beside the sessions (no new file); scm/lsp.scm's comments and
  `define-language-server`'s docstring say what a declaration now does. `Ed.lsp` gains `flush(b)` and
  `languageId(mode)`, and `timing.change`.
- **eglot-mode** (`eglot-enabled`, a buffer's minor mode) is the buffer's attachment to a session: on, the
  buffer is a document its server is told of; off (`M-x eglot-mode` again, or the session shut down), it is not.
  `M-x eglot` turns it on in the current buffer, as before starting the server when none runs there.
  **Per language, by itself:** `find-file-hook` and `after-change-major-mode-hook` run `lsp--ensure`, which
  turns eglot-mode on in a buffer whose major mode has a declared server, starting the server for the file's
  project, and off when its new mode has none (or another server, which it then goes to). It does nothing,
  and says nothing, where no server can start: no server for the mode, no file, a shared buffer or a file of
  edwind's, a web frame, edwind's Node host, and the image's replay (`Ed.proc.refusal()`); a start that fails
  (the program missing from PATH) says `eglot: WHY` and the visit goes on. Turning eglot-mode on by hand
  where no server can start signals as `eglot` does (`lsp-error`, `process-error`) and leaves it off.
- **What is told follows the server's `textDocumentSync`.** A number is the change kind, with opening,
  closing and saving told (saves without the text), as VS Code's client takes it; an object says each
  (`openClose`, `change`, `save` true or `{includeText}`); none, or `openClose` not true, tells nothing about
  documents. The client says `textDocument.synchronization.didSave` in initialize.
- **didOpen** is sent once the server is initialized: for every buffer of the session when it becomes ready
  (so again for each start again after a crash, and after `eglot-reconnect`, the new process knowing nothing),
  and at once for a buffer attached while it runs. It carries the file's URI (`Ed.lsp.uri`), the languageId (the
  mode's name less `-mode`, but `cpp`, `javascript`, `typescriptreact` and `shellscript` for c++-, js-, tsx- and
  sh-mode), the buffer's version (`b.ver`) and its text. Edits made before the server is ready, or while it is
  down, are in that text: nothing is sent to a server that is not running.
- **didChange** goes `timing.change` (500 ms, eglot's `eglot-send-changes-idle-time`) after the first edit
  since the last one sent (`hooks.edited` only starts a timer: no work per key), or at once by
  `Ed.lsp.flush(b)`, which a save, a close and the requests of later packages call first. Each document keeps
  the text its server holds; the change is the one range of that text between the common prefix and suffix of
  it and the buffer's, with the buffer's text there (incremental), or the whole text. So every edit since the
  last one sent (undo, a whole-text replacement, a reverted file, an edit log trimmed or forgotten) is one
  change, and it is right by construction rather than by replaying the edit log. The version is `b.ver`, which
  only grows; edits that come back to the text the server holds send nothing.
- **Positions** are LSP's default and the only encoding the client offers (lsp-sessions): a line is counted at
  each `\n`, `\r\n` and lone `\r`, the character in UTF-16 units from the line's start, which is what a
  JavaScript string counts. A range's end is never put between the halves of a surrogate pair nor between a
  `\r` and its `\n`: such a point moves out (the start back, the end on), the range growing by that unit.
- **didSave** after a save (`hooks.wrote`), the pending change sent first, with the text when the server asks
  for it. **write-file to another name** closes the old URI's document and opens the new one, in the session of
  the new file's project when that is another (started if none runs there). A file or mode found changed at a
  flush (set with no hook run) does the same but starts no server, since a flush also runs from a timer after
  edits that may be the image's: it uses the session kept for the new server and root, else turns eglot-mode off.
  While no process may start (the image's replay, a web frame, edwind) the hooks change nothing.
- **didClose** when eglot-mode is turned off, when the buffer is killed (`kill-buffer-hook`), and when its mode
  changes to one another server serves or none does. A session shut down sends none: the server is told
  `shutdown` and `exit`, and its buffers' eglot-mode is off.
- **Choices**, each reversible:
  - Auto-start (decision 2's "auto-start trust per project", the plan's default, which is the owner's Emacs
    `eglot-ensure` on his languages): a server starts in any project whose file is visited once a server is
    declared for the file's mode, with no per-project trust question, as eglot-ensure starts it. A server may run
    the project's code (rust-analyzer's build scripts and proc macros, nixd's flake evaluation, gopls's `go list`):
    visiting a file in an untrusted checkout runs it, as it does in Emacs. Not declaring a server for a mode
    keeps it off there; there is no per-project switch.
  - One change per didChange computed from the server's copy, not one per logged edit: simpler, and right
    when the log is trimmed; it costs a copy of the text per document and a linear scan per change sent, off
    the key path.
  - Version is the buffer's `ver`, not a counter per document.
- **Differences from eglot:** `M-x eglot` turns eglot-mode on in the current buffer only, not in every buffer
  of the project and mode; another buffer turns on when it is visited, or by `M-x eglot` there. eglot-mode's
  hook is not run when it turns on by itself. There is no `eglot-managed-mode` lighter or mode-line indicator.
  `willSave` and `willSaveWaitUntil` are not sent. A buffer whose server needs `openClose` false (rare) gets no
  documents at all, where eglot sends them anyway.
- **Not in it:** any request about a document (definition, hover, completion: the later packages, which call
  `Ed.lsp.flush` first); diagnostics; settings; direnv's environment; watched files.
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-lsp` (37 passed, 0 failed:
  test/lsp-rpc.test.mts's 10, test/lsp.test.mts's 17 and test/lsp-docs.test.mts's 10, nil from nixpkgs run in the
  sandbox, not skipped), `edwin-typecheck`, `edwin-headless` (21), `edwin-native` (31), `edwin-prog` (65),
  `edwin-compile` (39), `edwin-proc` (13), `edit-lockdown` (6) and `edit-security` (21), since src/lsp.ts also
  loads in edwind, where every hook here does nothing (no process may start there); `nix build .#edwin` (unit 32
  and 2 ignored, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 37); `nix flake check path:$PWD` on the final
  code: every check passed but edwin-proc (envFor's timeout case) and edit-crash (a SIGKILL round), timing
  checks on a loaded host, each built again alone and passed (13 of 13, 7 of 7). A run before it (on a load of 15
  to 30) failed edwin-typecheck, on the suite's own types (fixed), and the timing checks edwin-bench (the shadow
  stack 14.1% over its 10% limit) and edwin-prog (the bracket guard's 2 ms keystroke budget, a median of 5.2 ms):
  on the final code both were built alone and passed (4.5%; 65 of 65, that median 0.7 ms), and the flake check
  took them from the store. test/lsp.test.mts's method logs now hold the didOpen its
  stand-in (sync 1) is sent. test/lsp-docs.test.mts (10), against a stand-in server (node) that keeps its own copy of each
  document: it applies the changes with its own code (lines split at `\n`, `\r\n` and a lone `\r`, UTF-16
  characters, a position past its line's end, a document opened twice, a change or close of one not open and a
  version not above the last each logged as an error, and none may be), and answers `fake/text` with what it holds:
  - Visiting `a.fake` in a project `open é #1`: eglot-mode on at once, the server started by the visit; an edit
    before it is ready is in the didOpen; uri (`/open%20%C3%A9%20%231/a.fake`), languageId `fake`, version,
    text; no didChange after it; the initialize's `synchronization`; languageIds of c++-, tsx- and nix-mode.
  - Known answers (incremental): after `a😀` (3 units), the emoji deleted (2 units), `😀` to `😁` (the same high
    surrogate: the range takes the pair), the lines after a `\r\n` and after a lone `\r`, after a combining mark,
    a character typed between `\r` and `\n` (the range `\rW\n` from before the `\r` to the next line), the three
    deleted (the lone `\r` and the `\n` two line ends); two edits within `timing.change` one didChange, sent only
    once the time has passed. (Each of these mutations of src/lsp.ts fails it, and fails the incremental run
    below: counting `\n` alone as a line end, no move of a range's start out of a pair or a `\r\n`, no move of
    its end.)
  - fast-check, incremental (`{openClose, change: 2, save: {includeText}}`) and whole-text (`1`) sync, 60 runs
    each (LSP_DOC_RUNS; passed at 400 too, outside the sandbox) of up to 25 operations from a random text: inserts, deletes
    and replacements at random places of pieces with `é`, a combining mark, `😀`, `𝄞`, CJK, `\n`, `\r\n`, a
    lone `\r` and a tab, the whole text set, undo and redo (each edit an undo step, as a command makes one; about
    15 to 25 of them in 60 runs, at least one asserted), the edit log forgotten,
    flushes and saves, the changes sent by the idle timer in some runs and by a flush in the rest: the
    server's text is the buffer's after each run; one range (or the whole text) per didChange; saves told, with
    the text or without as asked; no error from the server.
  - save-buffer: the pending didChange then didSave (no text for `save: true`); write-file into a subdirectory:
    didClose of the old URI, didOpen of the new, one session; to another project: its own session, the text
    held there.
  - eglot-mode off: didClose, no session; on again: didOpen of the text edited meanwhile, on the same session;
    a mode another server serves: closed on the first, opened on the second with its languageId; fundamental-mode:
    closed, off, and `eglot-mode` there an `lsp-error` that leaves it off; the mode set with no hook (as a form
    of the image's might) to one whose server has no session: the next flush closes it, eglot-mode off, nothing
    started; a kill: didClose, the session without buffers.
  - A crash after the first didOpen (started again after 100 ms): an edit while it is down, a flush that sends
    nothing; the new process's didOpen holds the edit, no didChange to the dead one, later edits held.
  - No textDocumentSync: nothing about documents (initialize, initialized, shutdown, exit); `{openClose: true}`
    alone: the didOpen, no change, no save; `eglot-shutdown`: eglot-mode off, no didClose.
  - Not turned on by itself: a file whose mode has no server, a buffer with no file, a visit while the image
    replays (no spawn, no error), a web frame, no `host.proc`; a missing program said as `eglot: ...`, the visit
    done.
  - nil from nixpkgs: a file visited (eglot-mode on by itself), a comment of astral characters put first, `x`
    renamed `yy` at both places, its use put behind `/* 😀😀 */`; nil's definition of the use, asked at UTF-16
    units, is the binding at line 2, character 2.
  - The built program's `quitting_shuts_the_language_servers_down` (tests/terminal.rs) is unchanged: its
    stand-in answers no `textDocumentSync`, so its log is still `initialize, initialized, shutdown, exit`.

## Definition, references and implementation (done)

Asked 2026-11-18 (the Emacs-to-Edwin plan, package `lsp-xref`, on lsp-frame-docs; owner decision 2: the client in
the frame, the other LSP details the plan's defaults): gd, gr and friends through the server, with a results
buffer and jump back; proved by edwin-lsp.

- **`src/lsp.ts`** holds it, beside the sessions and documents (no new file); the keys are in `scm/evil.scm` and
  `scm/emacs.scm`; `Ed.lsp.timing` gains `request` (10 s).
- **The commands**, each asking the current buffer's server about point: `xref-find-definitions`
  (`textDocument/definition`), `xref-find-references` (`textDocument/references`, with `includeDeclaration`),
  `eglot-find-implementation`, `eglot-find-typeDefinition` and `eglot-find-declaration`. The buffer's pending
  change is sent first (`flush`), and the position is UTF-16 units of the text the server holds. initialize now
  says `definition`, `declaration`, `typeDefinition` and `implementation` with `linkSupport`, and `references`.
- **Keys.** Normal state, while eglot-mode is on (its Evil minor map, so `g r` of dired, git's buffers and
  `*compilation*` is untouched and a buffer with no server has neither): `g d` definitions, `g r` references.
  `C-t` in Normal state (Evil's `pop-tag-mark`) and `M-,` go back; `M-.` and `M-?` are global, as in Emacs.
  `eglot-find-implementation`, `-typeDefinition` and `-declaration` have no key, as in the Emacs config: `M-x`.
- **The answer** may be null, a Location, or a list of Locations or LocationLinks; a link goes to its
  `targetSelectionRange`, else its `targetRange`. Only `file:` URIs with no host (or `localhost`) are places; a
  place of another scheme (`jdt:`, `untitled:`) or a malformed escape is left out, and an answer of only such
  places says `No definitions in a file: the server names N elsewhere`. An item of another shape, a negative or
  fractional position and a place given twice are left out; at most 5000 places are kept. None left: `No
  definitions found` (or references, implementations...). A server whose capabilities lack the method is not
  asked: `NAME gives no implementations`. No server for the buffer: `No language server for this buffer (M-x
  eglot starts one)`. An error answer is signalled as lsp-rpc gives it (`lsp-error`).
- **One place, of a definition's kind** (definition, implementation, type definition, declaration), is visited in
  the selected window: its file (`find-file`), point at its position, counted as the server counts (lines at `\n`,
  `\r\n` and a lone `\r`, UTF-16 units, a character past the line's end its end, one between the halves of a pair
  the pair's start). A file that is not there says `PATH: no such file` and records nothing.
- **References, and several places of any kind**, go to `*xref*` (`xref-mode`, under special-mode: Motion state,
  read-only, q and SPC as there), shown and selected in another window: for each file, in the order the server
  first names it, a heading (its path from the project root, else with `~`), then a row per place by line,
  `LINE: TEXT`, the text of that line trimmed and cut at 200 characters. The text is a visiting buffer's, else
  the file's read with a bound (`host.files.read(path, 4 MiB)`: the desktop program reads only a regular file up to
  it), else none: a FIFO, a device or a large file a server names is never read, and once the files read for one
  list come to 16 MiB the rest are not read. Each file's rows are found in one pass over its text. The echo area says `N references`.
  `RET` (`xref-goto-xref`) visits the row's place in another window (one not showing `*xref*`, a split when there
  is none) and selects it; `o` (`xref-show-location-at-point`) shows it there and stays in `*xref*`; both also in
  Emacs state (`xref-mode-map`). On a heading: `No reference here`. The rows are the error list too
  (`next-error-set-list!` with UTF-16 columns), so `M-g n`, `M-g p` and `:cn` step through them.
- **Jump back.** Each find that found something first records point (a marker, so later edits move it) in one
  history (src/lsp.ts's, for every window it serves), the newest last, at most 50; `xref-go-back` returns to the newest, in its buffer, and
  forgets it; a place in a killed buffer is skipped; with none left, `At the start of the xref history`. A visit
  from `*xref*` records nothing more: back goes to where the list was asked for. The find also records point in
  the buffer's jump list, so `C-o` comes back within one file as before.
- **Waiting.** The command loop holds every key while a find waits, so each wait is quittable (`EdPool.interruptible`:
  C-g quits, cancelling the request, which sends `$/cancelRequest`) and bounded by `timing.request`: a server not
  yet initialized is waited for that long (then `NAME in ROOT: not ready after 10 s`), and its answer that long
  (the request's own timeout, which also cancels it). After the wait, nothing moves if the buffer was killed or
  is no longer current.
- **Choices**, each reversible:
  - `g d` and `g r` only where eglot-mode is on, not globally: Vim's own `gd` (the first match in the buffer) is
    not built, and a buffer with no server has no `g d` (as the owner's Emacs, where it fell to xref's other
    backends, which Edwin has not). The bindings follow evil (`gd`, `C-t`) and evil-collection's find-usages
    binding (`gr`) as remembered; evil-collection's source is not on this host to check.
  - A single reference is listed rather than visited (Emacs's references show the buffer too).
  - A visit converts the position itself rather than through `visit-location`, which counts lines at `\n` only;
    `M-g n` from `*xref*` goes through `visit-location`, so in a file with a lone `\r` its line can differ.
- **Differences from Emacs's xref and eglot:** no identifier prompt (`C-u M-.`), no `xref-go-forward`
  (`C-M-,`), no `xref-find-apropos`; `*xref*` has no `n`/`p` show-and-move, `C-j`/`C-k`, group motions, `g r`
  revert or faces, and is not editable (no `xref-query-replace-in-results`). The history is one for all windows, not a
  window's. `g d` is not bound in Visual state.
- **Not in it:** hover, signature help (lsp-eldoc); symbols (lsp-symbols); a `jdt:`-style URI's contents.
- **Checked by**, on ex44 (the build host): `nix build .#checks.x86_64-linux.edwin-lsp` (47 passed, 0 failed:
  test/lsp-rpc.test.mts 10, test/lsp.test.mts 17, test/lsp-docs.test.mts 10, test/lsp-xref.test.mts 10, nil from
  nixpkgs run in the sandbox, not skipped), `edwin-typecheck`, `edwin-headless` (21), `edwin-scheme` (38) and `nix build .#edwin` (unit 33 passed and 2 ignored, gui 5 and 1, terminal 37), on the final tree; `edit-lockdown` (6), `edit-security` (21), `edwin-compile` (39), `edwin-prog` (65) and `nix flake check path:$PWD` (all passed) on the tree before the one-pass rows, the 16 MiB total and the added assertions. Two waits added to the
  earlier suites, which read a stand-in's log right after the session's state changed and failed now and then
  once four suites ran at once (`a crash once` in test/lsp.test.mts and `a crash:` in test/lsp-docs.test.mts
  now wait for the line), and test/lsp-docs.test.mts's initialize assertion checks `synchronization` alone.
  test/lsp-xref.test.mts (10), against a stand-in (node) that answers each request with what the test wrote for
  its method (a result, an error, or nothing), logs each message and keeps each document's text, so a request's
  position is checked against the text the server holds:
  - initialize's capabilities for the five methods.
  - `g g` and `g U U` still work in a buffer with eglot-mode on; `g d` after an edit not yet sent: the didChange first, the position after `😀` in UTF-16 units, the place in
    another file on line 3 past `\n` and a lone `\r`, after two astral characters; `C-t` back; again and back by
    `M-,`; `C-t` once more: the history is empty.
  - In one buffer: `C-o` comes back; a LocationLink's `targetSelectionRange`, and its `targetRange` without one.
  - `g r`: `includeDeclaration`; `*xref*`'s text exactly (files in the server's order, rows by line, a place given
    twice once, a CRLF file's line, a file out of the project with `~`, a `jdt:` place, a malformed item, a
    negative line and a null left out), `6 references`, the files not open read once each with the bound; `RET`
    on the third row visits it in the other window, `*xref*` still shown; `o` shows a row, `*xref*` still
    selected; `RET` on a heading; `M-g n` the first row, `M-g n M-g p` back to it; `RET` in Emacs state visits a row; `C-t` to where
    `g r` was typed.
  - A single reference listed; two definitions listed, one in a file over 4 MiB and one in a directory, both rows
    with no text; `RET` visits the first.
  - null, `[]`, an `untitled:` place, a malformed escape, an error answer, a file not there and a capability
    missing (not asked) each say so; nothing moved, nothing recorded; a buffer with no server: `M-.` says so.
  - implementation, type definition and declaration by `M-x`; a character between the halves of `𝄞` goes to its
    start; `C-t` twice.
  - C-g while the server does not answer: `Quit`, `$/cancelRequest` sent, the loop free; `timing.request` at
    200 ms: the request times out and is cancelled; keys work after; a server that never answers initialize:
    `slow in ...: not ready after 0.2 s`.
  - `xref-go-back` skips the place of a killed buffer.
  - nil from nixpkgs: `g d` on a use behind a comment of `𝄞` goes to the binding (line 2, character 2), `C-t`
    back, `g r` lists both uses (nil leaves the binding out though asked to include it).
  - These mutations of src/lsp.ts each fail the suite: `\r\n` counted as two line ends, no move out of a
    surrogate pair, no `includeDeclaration`, a link's `targetRange` taken over its `targetSelectionRange`.

## Hover and signature help (done)

Asked 2026-11-18 (the Emacs-to-Edwin plan, package `lsp-eldoc`, on lsp-xref; owner decision 2: the client in the
frame, the other LSP details the plan's defaults): signature while typing, hover on K; proved by edwin-lsp and
requests cancelled on movement.

- **`src/lsp.ts`** holds it, beside the cross references (no new file); the key is in `scm/evil.scm`;
  `Ed.lsp.timing` gains `eldoc` (300 ms). The cross references' wait (ready, flush, capability, answer) is one
  helper now, `askAt`, which `eldoc` uses too. initialize now also says `hover` (`contentFormat` plaintext, then
  markdown) and `signatureHelp` (the same formats for documentation, `labelOffsets`, `activeParameterSupport`).
- **Hover.** `eldoc` (`K` in Normal state while eglot-mode is on, its Evil minor map, so `K` stays `evil-lookup`
  in Scheme and in every buffer with no server; `M-x eldoc` elsewhere and in Emacs state) asks
  `textDocument/hover` at point and shows the answer in the echo area, not in `*Messages*`. It waits as the
  finds do: the pending change sent first, the position in UTF-16 units, C-g quits (sending `$/cancelRequest`),
  `timing.request` (10 s) bounds the wait for a starting server and for the answer. The contents may be a
  MarkupContent, a MarkedString (a string or `{language, value}`) or a list of them (joined by a blank line). The
  text is cut at 4096 characters (`…`), line ends made `\n`, every other control character (ESC above all: a
  terminal frame draws the echo area) a blank, Markdown's fence lines (```` ``` ````, `~~~`) left out, a run of
  blank lines one, then trimmed. None left, or a null answer: `No documentation here`. A server whose
  capabilities lack `hoverProvider` is not asked: `NAME gives no hover documentation`. The next key clears it,
  as any message. Nothing is shown if the buffer was killed, is no longer current, or point or the text changed
  while it waited.
- **Signatures while typing.** After each command (H.postCommand; it compares only the buffer, point and the
  buffer's version, never the text), in a buffer that is being typed in (Insert, Replace or Emacs state; any
  without Evil) whose server runs and gives `signatureHelpProvider`: once point or the text changed since the
  last request, a timer of `timing.eldoc` starts; a command before it runs out that moves point or edits starts
  it again, so a run of keys gives one request. When it runs out with point where it was, the pending change is
  sent (flush) and `textDocument/signatureHelp` asked at point, bounded by `timing.request`. There is at most one
  such request: a command that moves point, edits, changes buffer or leaves those states cancels it (the
  timer, or the request, which sends `$/cancelRequest`); its answer, should it still come, is dropped.
- **What it shows**: the active signature (`activeSignature`, else the first) as one line, whitespace runs one
  blank, control characters blanked, cut at 500 characters, its active parameter (the signature's own
  `activeParameter`, else the answer's) between `‹` and `›`: a parameter label of `[start, end]` is that span of
  the signature's label in UTF-16 units (ignored when it lies outside), a string label its first occurrence
  after the label's first `(`. No signatures, or a malformed answer: nothing, and the signature shown before is
  cleared. It is written only while the echo area holds nothing of anyone else's: empty, an Evil state's
  `-- INSERT --`, or the signature shown before; never over the minibuffer, a prompt, an isearch or a message.
  As each key clears the echo area, a command that leaves it empty shows the last signature again (in the same
  buffer, still typing) until the next answer replaces or clears it.
- **Choices**, each reversible:
  - Hover only on K, not on idle as Emacs's eldoc does: the package asks hover on K, and asking the server for
    both on every pause doubles the traffic. K waits as the finds do (the loop holds keys; C-g quits), so it is
    "cancelled on movement" by C-g alone; the signature request is the one that runs in the background and is
    cancelled when point moves.
  - Signatures only while typing (Insert, Replace, Emacs state), not in Normal state as Emacs shows them on
    any idle.
  - 300 ms, not eldoc's 0.5 s idle delay, so a signature comes while typing; trigger characters are not used
    (no immediate request after `(`) and no `SignatureHelpContext` is sent (none is offered in initialize).
  - The active parameter marked by `‹ ›` in plain text: the echo area draws one face.
  - `K` where eglot-mode is on replaces `evil-lookup` (which only knows Scheme names) there, as
    evil-collection's eglot keys bind `K` to the documentation (remembered; its source is not on this host).
- **Differences from Emacs's eldoc and eglot:** no `*eldoc*` buffer (`eldoc-doc-buffer`), so a hover longer than
  the echo area (half the frame) is clipped there; no hover or signature on idle in Normal state; no faces in the
  echo area (Emacs highlights the parameter and the signature's name); no parameter documentation or signature
  count shown; Markdown is shown as its text less the fences (no rendering); `eldoc-echo-area-use-multiline-p`
  has no counterpart (a hover may use several lines, a signature one).
- **Not in it:** diagnostics in the echo area (lsp-diagnostics); `eldoc-box` (declined in the plan); a hover in
  a web frame or edwind (no processes there, so no server).
- **Checked by**, on ex44 (the build host), on the final tree: `nix build .#checks.x86_64-linux.edwin-lsp` (57 passed,
  0 failed: test/lsp-rpc.test.mts 10, test/lsp.test.mts 17, test/lsp-docs.test.mts 10, test/lsp-xref.test.mts 10,
  test/lsp-eldoc.test.mts 10, nil from nixpkgs run in the sandbox, not skipped), `edwin-typecheck`, `nix build
  .#edwin` (unit 35 passed and 2 ignored, gui 5 and 1, terminal 37) and `nix flake check --keep-going path:$PWD`
  (all passed, among them `edwin-headless` 21, `edwin-scheme` 38, `edit-lockdown` 6, `edit-security` 21 and
  `edwin-prog` 65). Twice a flake check failed only `edwin-prog`'s timing tests (the 2 ms bracket-guard budget at
  2.5 and 2.6 ms, and the glob cost bound) at a load average of 17 to 21; rebuilt alone at a load under 4 it passed
  (65), and the flake check after it passed. The suite's waits are wide (a 1 s debounce for the run of keys, a 2 s
  delayed answer for the cancel): six runs of the five suites, three at once at a load of 13, passed it each time.
  test/lsp-eldoc.test.mts (10), against a stand-in (node) that answers each request with what the test wrote for
  its method (a result, a result after a delay, an error, or nothing), logs each message and each request's id,
  and keeps each document's text, so a request's position is checked against the text the server holds:
  - initialize's `hover` and `signatureHelp` capabilities.
  - `K` after an edit not yet sent: one didChange first, the position after `😀` in UTF-16 units, the Markdown
    hover's fences left out and its blank lines one, nothing in `*Messages*`, the next key clears it; a string, a
    `{language, value}`, a list, plaintext with `\r\n` and a lone `\r`, ESC, BEL and a tab blanked, 5000
    characters cut at 4096; null, `''`, `[]`, only fences and a number say `No documentation here`; an error
    answer is shown.
  - A server with no `hoverProvider`: not asked, said; in a buffer with no server `K` is `evil-lookup`.
  - `K` on a server that does not answer: C-g `Quit`, that request's id cancelled; `timing.request` at 200 ms:
    timed out and cancelled; keys work after.
  - Typing: entering Insert state asks; eight keys 20 ms apart under a 1 s debounce give one request, after
    one didChange, at point; the signature `add(a: int, ‹b: int›) -> int` from a `[12, 18]` label, not in
    `*Messages*`; after the next key it is still shown while the next request waits; a null answer clears it;
    in Normal state `h h l` asks nothing.
  - Labels: a string parameter found after `(` (`a(‹a›)`, not the name), `activeSignature` choosing the second
    and its own `activeParameter` over the answer's, an `activeSignature` and `activeParameter` out of range,
    a multi-line label with ESC, an offset past the label's end, a 600-character label cut at 500; no
    signatures, a label not a string and a string answer show nothing.
  - Cancelled on movement: `<left>` while an answer is on its way sends `$/cancelRequest` with its id, the
    answer arriving later is not shown, the new place is asked; an edit and ESC cancel the next ones; every
    request cancelled, by id.
  - The minibuffer opened while a request waits, and a message shown, are left as they are when its answer
    comes.
  - A server with no `signatureHelpProvider` is never asked while typing; a session shut down while a request
    waits leaves nothing shown, its child gone.
  - nil from nixpkgs: `K` on `builtins.toString` shows its documentation, no fences.
  - These mutations of src/lsp.ts each fail the suite: no cancel when point moves (only on leaving the
    state), no debounce (the timer at 0 ms), the signature not shown again after a key.

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

## Tree-sitter grammars from Nix (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lang-grammar-bundle`). The tree-sitter grammars and query files
of the languages Edwin declares, built by Nix into one directory the edwin package points at, for the tree-sitter
packages after it (lang-syntax-native loads them; highlighting, imenu and indentation use the queries). Nothing in
Edwin reads the directory yet.

- **`nix/grammars.nix`** (new; the flake's `packages.edwin-grammars`): for each of the 22 modes `scm/prog.scm`
  declares, one directory NAME holding `parser.so` (a link to the grammar's library) and `queries/KIND.scm` for the
  standard tree-sitter query kinds the grammar has (highlights, injections, locals, tags), and `grammars.json`,
  mapping each NAME to its `mode`, `symbol` (`tree_sitter_NAME`, the library's entry point), `queries` (the kinds
  there) and `source`. The names: rust, nix, go, c, cpp, java, c_sharp, python, javascript, typescript, tsx, json,
  yaml, toml, bash (sh-mode), hcl (terraform-mode), gdscript, just, meson, nasm, nginx, typst. Every one has
  highlights; the queries add up to 893 patterns. The bundle references the 22 grammar outputs (18 MB) and through
  them only the C libraries they link (glibc, libgcc); the query files are copies, so no source tree stays referenced.
- **Where the grammars and queries come from (decision 8; the plan states no default, so the simplest):**
  nixpkgs' `tree-sitter.builtGrammars`, with each grammar's own queries, composed in the order its
  `tree-sitter.json` lists them, each file followed by a newline: C++'s highlights are C's then its own;
  JavaScript's are its highlights, highlights-jsx and highlights-params; TypeScript's and TSX's were their own then
  JavaScript's (TSX with highlights-jsx between), as tree-sitter-typescript's `tree-sitter.json` names them from
  its node_modules, and since lang-syntax-highlight are JavaScript's first (TSX's then highlights-jsx), their own
  last, as the later pattern wins; their injections are JavaScript's. Just's queries are `queries-src`, which its
  `tree-sitter.json` names (`queries/just` is the copy for Neovim); Typst's are `queries/typst`. HCL and GDScript ship
  no queries: both are Helix's (nixpkgs' `helix`), the grammar at the revision Helix pins
  (`helix.passthru.tree-sitter-grammars`) and the queries from its `runtime/queries`, since Helix's GDScript
  highlights do not compile against nixpkgs' GDScript grammar (6.1.0). Helix's queries use only tree-sitter's own
  predicates (`#match?`, `#set!`), unlike Neovim's (`#lua-match?`). Terraform files use the HCL grammar.
- **Loaded with dlopen from the store, not linked in (decision 8):** each library stays its own file, so a grammar
  can change without rebuilding the program, and the program's build stays as it is. Handed to lang-syntax-native as a
  requirement: load grammars only from this directory, never from a path a buffer or the user's Scheme gives.
- **The package points at it:** `nix/edwin.nix` takes `grammars` and links it as `share/edwin/grammars`, a path the
  program can find from its own executable; the install check tests that `grammars.json` is there. edwind and
  `edwin-web` do not get it: the server never parses, and web frames keep the TypeScript lexers.
- **Differences from Emacs:** the capture names are the grammars' own (and Helix's for HCL and GDScript), not the
  treesit font-lock features of the Emacs modes; lang-syntax-highlight maps them to faces. Query kinds that are an
  editor's own dialect (folds, indents, textobjects) are left out: the indent packages add Edwin's indent queries.
  Left out too: Nix's `locals.scm`, which upstream keeps as comments only (no patterns), and Helix's GDScript
  `tags.scm`, which compiles against neither GDScript revision (`Impossible pattern`).
- **Not in it:** loading or parsing (lang-syntax-native), faces, indentation, the Lisp languages (Scheme, Emacs
  Lisp, Clojure: lang-lisp-modes), nushell (not declared), tree-sitter in web frames.
- **Checked by**, on ex44: `nix build .#edwin-grammars` (22 directories, each a `parser.so` and its `queries/`, and
  `grammars.json`); `nix build .#checks.x86_64-linux.edwin-grammars` (new; `test/grammars.py` with nixpkgs'
  py-tree-sitter 0.25.2, warnings as errors): every mode `scm/prog.scm` declares has exactly one grammar and the
  bundle holds nothing else; each `parser.so` loads, exports its symbol and gives a language of an ABI version
  py-tree-sitter 0.25.2 accepts (13 to 15, the same range as nixpkgs' tree-sitter 0.26.11, whose
  `TREE_SITTER_MIN_COMPATIBLE_LANGUAGE_VERSION` is 13; the Nix grammar is ABI 13, the rest 14 or 15); each query file `grammars.json` lists is there, alone in `queries/`, has patterns
  and compiles against its grammar. It failed on the first bundle, on Nix's empty `locals.scm` and Helix's GDScript
  `tags.scm`, both since left out; Helix's GDScript highlights fail against nixpkgs' GDScript grammar, which is why
  the bundle takes Helix's. Also passed: `nix build .#edwin` (its install
  check finds `share/edwin/grammars/grammars.json`; unit 22, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 35)
  and `nix flake check` (exit 0, all checks passed).

## ws-butler: trailing blanks trimmed on save from the changed lines only (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lang-ws-butler`): on save, trailing whitespace is removed only
from the lines the session changed. Before, `ws-butler-mode` (src/extras.ts) stripped the trailing blanks of every
line of a Scheme buffer on each save, by replacing the whole text, and did nothing in other programming buffers.

- **`ws-butler-mode`** (now in `scm/prog.scm`, still `#t` by default): with it on, saving a modified, writable buffer
  whose mode derives from prog-mode, or a Scheme buffer (scheme-mode, scheme-interaction-mode), deletes the trailing
  spaces and tabs of the lines that differ from its file, from `before-save-hook`, and leaves every other line as
  it is. This is the scope the owner's Emacs had (`ws-butler-mode` on `prog-mode-hook`, init-ui.el), where Emacs
  Lisp is a prog-mode. `(set! ws-butler-mode #f)` turns it off.
- **Which lines changed: a line diff against the file at save time.** `(buffer-changed-lines)` (src/editor-prims.ts)
  reads the visited file from the store and returns the lines of the buffer that differ from it, as `(FIRST . LAST)`
  line numbers; every line when the file does not exist yet; `#f` for a buffer with no file, a buffer edwind saves
  (`b.shared`: its file is on edwind's side), or a file the store cannot read (the desktop program reads `null` for
  a file that exists but is not UTF-8 or not readable, as for an absent one; `host.files.exists` tells them apart).
  The lines come from `Rope.changedLines` (src/text.ts), the hunks of the same line diff `Rope.diffLines` takes,
  before those are shrunk to characters: an edit at a line's start, a line added and two lines joined are changed
  lines; a hunk that only deletes lines changes none, so the lines around a deleted line are left alone.
- **The trim** (`(delete-trailing-blanks RANGES)`, src/editor-prims.ts): each line's trailing spaces and tabs
  deleted, all of them as one `applyOps` batch, so point, the other windows' points and the markers move as for
  any deletion: point and the mark keep their line and column, and point among the deleted blanks ends up at the
  line's end. The deletions are part of the change that is saved; an unmodified buffer is not touched (before, a
  Scheme buffer was modified by the trim before `save-buffer` said there was nothing to save).
- **Cost**, timed on ex44 in the headless runtime, `(save-buffer)` of a `.ts` file whose every line ends in two
  blanks: one line edited in 100,000 lines 25 ms, in 200,000 lines 72 ms (the line diff); a new file of 100,000
  lines, all trimmed, 0.6 s, of 200,000 lines 1.6 s; 1,500 lines edited across 200,000 (past the diff's limit, so
  every line between the first and last edit is trimmed) 2.0 s. The large cases are the rope's cost per deletion
  (each splice brings its chunk offsets up to date), not the diff.
- **Choices**, each reversible:
  - The baseline is the file as it is now, read at save time, not a record of the session's edits: no state per
    buffer and no hook on every edit, and every way a buffer comes to match its file (a visit, a save, a revert,
    `:e!`) is covered. A line changed and changed back counts as untouched. When another program changed the file
    since the visit, its changed lines count as changed too: the trim runs first, then the save asks about the
    supersession as before.
  - Past the line diff's limits (1,000 differing lines, 5,000,000 units of work) `changedLines` gives the lines from
    the common prefix of characters to the common suffix as one range, so those are trimmed.
  - The decision (the variable, the modes, the hook) is in `scm/prog.scm`, where the plan puts the package; the
    diff and the deletions are two TypeScript primitives, for speed (a first version deleting line by line in
    Scheme took 1.0 s for 100,000 lines). prog.scm runs in edwind too (CONFIG), so a `save-buffer` evaluated in
    edwind's image trims there, reading only the file being saved.
- **Differences from Emacs** (ws-butler.el): Emacs marks the changed lines with text properties as they are edited
  and trims those; here the diff against the file decides. Emacs keeps the blanks before point in the buffer after
  the save (written without them, restored after); here they are deleted from the buffer too, point going to the
  line's end. No `ws-butler-keep-whitespace-before-point`, no trimming of trailing blank lines at the end of the
  file, no `ws-butler-global-exempt-modes`.
- **Not in it:** Org, Markdown and text buffers (not prog-mode, as in the owner's Emacs). Buffers edwind serves
  (a served page's, and the desktop program's under the notes directory): their save is a message to edwind,
  which writes the text without running `save-buffer`, so nothing trims them; before, the frame trimmed a served
  Scheme buffer's every line before sending the save. The first save of a buffer with no file (the name asked
  for by `save-buffer`) trims nothing, as the file is not yet known when `before-save-hook` runs; a buffer opened
  by `:e NEW-FILE` has its file and is trimmed throughout. No per-buffer switch (`ws-butler-mode` is one global
  variable). `write-file` runs no `before-save-hook`, as before. `.editorconfig`'s `trim_trailing_whitespace` is
  lang-editorconfig's.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-prog`, `test/prog.test.mts` (25, 8 new): a
  visited `.nix` file with dirty lines, one line edited and saved, keeps the other lines byte for byte and loses the
  edited line's blanks; an edit at a line's start, an added line and a joined line are trimmed, the lines around a
  deleted line are not; a new `.scm` and a new `.py` file are trimmed throughout (as the headless case still checks); saving an
  unmodified buffer, and one changed and changed back, leaves the file as it was; `ws-butler-mode` `#f`, and `.txt`,
  `.org` and `.md` buffers, trim nothing; point and the mark keep their line and column, point among the trimmed
  blanks goes to the line's end; `buffer-changed-lines` on a visited, a new and a fileless buffer, and
  `Rope.changedLines` with the limit forced to 0 (the one-range fallback); `delete-trailing-blanks` on given lines, a
  last line with no newline, a range past the end, and refused in a read-only buffer. With every line trimmed instead (what a
  Scheme buffer had before) 4 of the 8 fail. Also passed: `edwin-headless` (21, its ws-butler case unchanged),
  `edwin-linediff` (6), `edwin-scheme` (38), `edwin-typecheck`, `edit-security` (21), `edit-lockdown` (6) and
  `nix build .#edwin` (unit 22, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 35), each exit 0; `nix flake check` exit 0 (its first run stopped at `edwin-bench`, whose
  shadow-stack timing was 26.8% against a 10% limit while ex44's load average was 22; built alone it passed at
  7.5%, and the whole check then passed with `--keep-going`).

## Tree-sitter in the native program (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lang-syntax-native`): tree-sitter 0.26 in the desktop
program, with natives to load a grammar, parse and query, for the tree-sitter packages after it (incremental
reparse, highlighting, imenu, expand-region, indentation). Nothing in the core calls them yet.

- **`native/src/syntax.rs`** (new), on the `tree-sitter` crate 0.26.13 (the runtime linked in, its `std` feature
  for the `#match?` regexes) and `tree-sitter-language`: a grammar of the bundle (`nix/grammars.nix`) loaded by
  its name, a text parsed into a tree, a query of the bundle's run over it. `build.rs` compiles it too, since it
  compiles `natives.rs` for the snapshot; nothing of it runs at startup or in the snapshot.
- **The natives** (`__n`, typed in `src/core.d.ts`): `synLoad(name)` loads NAME's grammar on first use and gives
  its query kinds (`['highlights', 'injections', 'tags']` for Rust); `synParse(name, text)` parses TEXT and gives
  the tree's number; `synQuery(tree, kind, start?, end?)` runs the grammar's KIND query over the tree between
  two string indices and gives `{names, captures}`, `captures` holding four numbers a capture (its index in
  `names`, its start and end, the pattern that matched), in the order of the text; `synFree(tree)` forgets a tree
  (false when there was none). Each throws why it cannot: `no grammar NAME`, `NAME's grammar does not load:
  DLERROR`, `NAME's grammar has no tree_sitter_NAME`, `NAME's grammar has ABI version V; this tree-sitter reads
  13 to 15`, `NAME has no "KIND" query`, `NAME's KIND.scm, line L column C: ...`, `no syntax tree N`.
- **Grammars by name only** (lang-grammar-bundle's requirement): a name is lowercase letters, digits and `_`
  (at most 64), so neither a path nor `..` reaches `dlopen`; the directory is `share/edwin/grammars` beside the
  program's `bin/`, found from the executable the kernel names (`edwinclient`, a link to `edwin`, finds the
  same), never from the environment, a buffer or the user's Scheme. Query kinds are names in the same way, files
  of the grammar's `queries/`. A library is opened with `RTLD_NOW | RTLD_LOCAL` and stays loaded (the language is
  its static data); one that fails (no entry point, a null language, an ABI version outside tree-sitter's 13 to
  15) is closed before anything of it is used.
- **Offsets are JS's string indices:** texts are parsed as UTF-16, as V8 holds them, so a node's extent is half
  its byte offset; the text predicates (`#eq?`, `#match?`, `#any-of?`) are given each node's text as UTF-8.
  lang-syntax-incremental's byte-versus-UTF-16 risk is settled this way.
- **Bounds** (constants in syntax.rs): a parse stops after 1 s (`PARSE_LIMIT`) and a query after 1 s
  (`QUERY_LIMIT`), each with an error rather than holding the frame (tree-sitter's progress callbacks); a query
  keeps at most 256 matches in progress (`MATCH_LIMIT`); at most 256 trees are kept (`MAX_TREES`), a parse past
  that refused until one is freed.
- **Choices where the plan left one open:** the grammars are loaded with `dlopen` from the bundle and the
  runtime is linked in, as lang-grammar-bundle settled (decision 8); queries come from the bundle only, compiled
  once per grammar and kind, so no query text crosses the natives; trees keep the text they were parsed from
  (the predicates read it); a parse is whole (incremental reparse is lang-syntax-incremental's). Directives
  (`#set!` and the rest) are not applied: they are the caller's. Nothing in the frame frees a tree for it yet:
  the first package that keeps trees per buffer frees them.
- **Not in it:** node navigation, incremental edits, highlighting and faces, the host or `Ed` interface over the
  natives (the packages after it add what they use), tree-sitter in web frames or edwind. No new check in
  nix/checks.nix: the tests are the package's cargo tests, which `nix build .#edwin` runs.
- **Checked by** `nix build .#edwin` on ex44 (the build's check sets `EDWIN_TEST_GRAMMARS` to the bundle): unit
  tests 29 passed (7 new), `tests/gui.rs` 5 passed and 1 ignored, `tests/terminal.rs` 35 passed. The new ones:
  `syntax::tests::every_grammar_parses_and_queries_its_fixture` (each of the bundle's 22 grammars has a fixture,
  which parses to its root kind with no error, every query kind compiles, and the highlights give one named
  capture, e.g. Rust's `keyword` on `let`, Typst's `markup.heading.1` on `= Title`),
  `offsets_are_utf16_and_predicates_see_the_text` (with `𝔸` and `é` before it, `Foo` is at index 18;
  `#match? "^[A-Z]"` takes `Foo` and not `é`; `#eq? "é"` and `#match? "^𝔸$"` match, which they do not when the
  predicates see the UTF-16 bytes; a range keeps to its captures), `bad_grammars_and_queries_fail_cleanly`
  (names with a path, `..`, capitals or a space; a missing grammar; a file that is no library; another grammar's
  library under the name; libraries the test compiles whose language says ABI 99 and 12; a query naming a node
  the grammar lacks; a kind the bundle lacks), `the_bundle_is_found_beside_the_program`,
  `trees_are_kept_by_number_until_freed` (the 257th tree refused, room again after a free),
  `a_parse_past_its_bound_stops` (64 MiB of JSON: the error after 1 s) and
  `natives::tests::the_syntax_natives_from_javascript` (the natives on an isolate: indices of the JS string,
  errors as JS errors). First draw, measured (not a test) with `EDWIN_TRACE=1` in a 200×50 pseudo-terminal,
  10 starts each, twice, on a quiet ex44 (load 2): medians 22.6 and 24.3 ms before, 23.9 and 22.9 ms after (a
  build before a refactor of how the bundle is found, which runs only at a first synLoad). The committed build,
  20 starts each alternating with the one before, measured while other builds loaded ex44 (load 8 to 37): medians
  54.7 ms before and 57.9 after, fastest 23.2 and 21.8. Nothing of tree-sitter runs before the first draw. The
  program grows by 2.4 MB (66.2 to 68.6). Also passed: `nix flake check` (exit 0).

## EditorConfig: a visited file's .editorconfig sets its indent, fill column, final newline and trimming (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lang-editorconfig`): src/editorconfig.ts reads `.editorconfig`
up the tree and sets indent, width, final newline and trimming. Before, Edwin read no `.editorconfig`: a file's
indent was its mode's (`define-language :indent`) and the user's.

- **The search** (`EditorConfig.properties`, src/editorconfig.ts, a new core file through the seven-place touch
  list): from the visited file's directory upward, each directory's `.editorconfig` read through the store
  (`Ed.Store.get(path, MAX_FILE)`), stopping after the one whose preamble says `root = true` (any case). Their sections apply from
  the outermost file to the nearest, each file's in order, a later pair replacing an earlier one; a section applies
  when its glob matches the file's path from that `.editorconfig`'s directory. Then the core library's defaults:
  `indent_style = tab` with no `indent_size` gives `indent_size = tab`, a numeric `indent_size` with no
  `tab_width` gives `tab_width`, and `indent_size = tab` takes `tab_width` when there is one.
- **The parser**: blank lines and lines starting with `#` or `;` are skipped; `[NAME]` opens a section (NAME as
  written between the first `[` and the last `]`, spaces kept); `KEY = VALUE` splits at the first `=`, both trimmed,
  the key lowercased, and the value too for the standard properties (`indent_style`, `indent_size`, `tab_width`,
  `end_of_line`, `charset`, `insert_final_newline`, `trim_trailing_whitespace`, `max_line_length`). A `#` or `;`
  inside a value is part of it (the current spec); a byte-order mark and CR LF line ends are read.
- **The globs**: `*` (not `/`), `**`, `?`, `[abc]`, `[a-z]`, `[!abc]`, `{a,b}` (nested, empty parts), `{N1..N2}`
  (signed integers, no leading zero), `\` escapes; a `[` with no `]`, or a `/` before it, and a `{` with one part
  or no closing `}` are themselves; `/**/` matches one `/` or any directories between two. As in the core
  library, a glob is matched against the path with the `.editorconfig` directory's own `/` before it: a glob with
  a `/` from that `/` (with or without a leading `/`), one with none after `/**/`, in any directory below. So a
  leading `**/` or `/**/` (`[**/*.js]`, `[/**/*.md]`) also matches a file in the `.editorconfig`'s own directory.
- **What it sets**, buffer-local, from `find-file-hook` (after the file's mode set its own indent, which it
  overrides), and again from `after-change-major-mode-hook` in a buffer it has already set (a mode switch drops the
  buffer-local values; the files are read again, as `write-file` may have changed the name):
  - `indent_style`: `indent-tabs-mode` (`tab` `#t`, `space` `#f`);
  - `indent_size` (or `tab_width` where it is `tab`): `tab-width`, TAB's stops, and `evil-shift-width`, `>` and `<`;
  - `max_line_length`: `fill-column` (`off` sets nothing);
  - `insert_final_newline`: `require-final-newline`, `#t` or `#f`;
  - `trim_trailing_whitespace = true`: a save of the modified, writable buffer deletes the trailing spaces and tabs
    of every line (`editorconfig--before-save` on `before-save-hook`, through `delete-trailing-blanks`), in any
    mode; `false`: `ws-butler-mode` `#f` in that buffer, so ws-butler leaves even its changed lines.
  - A width is a whole number from 1 to 9999; anything else, `unset` and a property no section gave set nothing,
    so the mode's or the user's value stays.
- **`(editorconfig-properties FILENAME)`**: the properties of an absolute path as a list of `(NAME . VALUE)`
  strings, in the order each was first set; the buffer keeps its own in `b.editorconfig`.
- **Choices**, each reversible:
  - Globs are matched by a table of (pattern node, path position), filled from the path's end, not by a regular
    expression: a `.editorconfig` comes from whatever repository is cloned, and a regexp of nested `*` and braces
    backtracks without bound. The cost is the pattern's length times the path's. On top of it the search stops
    before a file that would bring the sections read in one search past 8,192 (`MAX_GLOBS`), each counted as its
    name's length and 16 more (`SECTION_COST`, the nodes every match adds whatever the name, so a file of empty or
    one-character sections is bounded too; a real file's come to a few hundred). Timed on ex44 in the headless
    runtime (load average 7), against a 4,000-character file name: one 4,001-character pattern of `*a` 0.10 s;
    sections up to the bound of `{a,*a}` patterns 0.15 to 0.20 s, of `[a]` 0.07 s, of `[]` 0.06 s, of `[*]` 0.07 s
    (while a cargo build ran the first two took 0.27 and up to 0.41 s). A file name of a usual length (200
    characters) takes about a twentieth of that. (Timed before the leading-`**/` fix, which adds one `/` to the
    path and at most four nodes to a pattern.)
  - What is read is bounded too, since the search runs on every visit in every directory up to `/` and a cloned
    repository can ship `.editorconfig` as a link to `/dev/stdin` or `/dev/zero`, or as a FIFO: `Ed.Store.get`
    takes a bound, which the desktop program passes to `readFile(path, max)` in native/src/natives.rs. With a
    bound it reads only a regular file (links followed) of at most `MAX_FILE` (1 MiB) bytes: the name is stat'ed
    before the open, so a device, a FIFO or a larger file is never opened; the open does not block and is checked
    again on its descriptor; the read stops at the bound and one byte. A refusal throws, and the search takes the
    file as absent and goes on upward. Without a bound `readFile` is as before. The headless and browser stores
    hold their files in memory, where a text past `MAX_FILE` characters is skipped the same way.
  - Files are read through the store, not the file system: the desktop program reads its disk, edwind its own
    within its path rules, the headless suites their memory store. A buffer with no file, one whose file is
    edwind's (`b.shared`: a served page's, the desktop program's notes), and one whose file is not an absolute path
    (the browser page's stored files) get nothing.
  - `tab_width` sets no display width: Edwin draws a tab 8 columns wide in every buffer (src/display.ts), and its
    `tab-width` is TAB's stop, which is what the indent is. So `tab_width` counts only where `indent_size` is `tab`
    (or absent with `indent_style = tab`), as the indent.
  - `trim_trailing_whitespace = true` trims every line, as Emacs's editorconfig does (`delete-trailing-whitespace`
    on save) and as the property says, not only the changed ones.
- **Differences from Emacs** (editorconfig.el): no per-mode indent variables (`python-indent-offset` and the
  like): Edwin's modes indent by `tab-width` and `evil-shift-width`; `insert_final_newline = false` does not
  delete a final newline that is there, as in Emacs; no `end_of_line` or `charset` (the buffer's text is saved as
  UTF-8 with its own line ends); no `editorconfig-mode` switch and no `editorconfig-exclude-modes`.
- **Not in it:** `end_of_line`, `charset`, `spelling_language` and other properties than those above (they are
  read and kept in `b.editorconfig`, and set nothing); a buffer visited before its `.editorconfig` changed keeps
  the values it got (visit it again, or switch its mode); `write-file` to a new name reads the files only when it
  changes the mode; served buffers (above).
- **Checked by**, on ex44, on this branch rebased onto lang-syntax-incremental (0c405f9):
  `nix build .#checks.x86_64-linux.edwin-prog` (41: `test/prog.test.mts` 25 as before,
  `test/editorconfig.test.mts` 16 new). Four of the 16 run the core library's own test cases from
  editorconfig-core-c's source (`pkgs.editorconfig-core-c.src`, `tests/`, read by the check as
  `EDITORCONFIG_CORE_TESTS`): every `new_ec_test`, `new_ec_test_multiline` and `new_ec_test_full_ec_file_path` of
  its glob (130), parser (33), properties (9) and filetree (24) directories, their `-f` file names and expected
  output regexps taken from its CMakeLists.txt (the cli and meta directories and the version-0.8 case left out).
  The others: globs the core cases leave out (a negated class and `/`, signed and reversed ranges, anchoring;
  a leading `**/` and `/**/` matching in the `.editorconfig`'s own directory and below, `x/**/y` matching `x/y`);
  a hostile pattern, 20 nested files of hostile sections, of empty sections and of one-character sections, and
  one-character sections up to the bound, each under 2 s, the search stopping at the bound, a file past
  `MAX_FILE` skipped; in the editor the nearest file beating the outer one and both beating the mode's indent,
  `indent_style = tab` making TAB insert a tab, `root = true` stopping the search, `unset`, a mode switch keeping
  the values, no values in a buffer with no file or a relative name, `insert_final_newline` both ways (and the
  global value where no section matches), `trim_trailing_whitespace = true` in Markdown and Nix buffers and an
  unmodified buffer untouched, `= false` keeping ws-butler off in that buffer only, and widths out of range
  ignored. `nix build .#edwin` (unit 30 and 1 ignored, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 36), exit 0: its
  new `a_hostile_editorconfig_is_not_read` visits a file under a `.editorconfig` that links to `/dev/stdin`, one
  that is a FIFO and one past 1 MiB, each beside a regular one in the directory above whose `indent_style = tab`
  must still apply (TAB inserts a tab). The build before the bound (store path `iqhl8h7r…-edwin-0.1.0`) never
  draws a file under the FIFO (8 s, under `script`, a throwaway HOME and XDG_RUNTIME_DIR) and draws the same file
  without it. A link to `/dev/zero` is not in the test: before the bound it filled memory. Also passed:
  `edwin-typecheck`, `edwin-headless` (21), `edwin-scheme` (38), `edit-security` (21), `edit-lockdown` (6), each exit 0, and
  `nix flake check --keep-going` (all checks passed but `edwin-bench`, 10.2% against its 10% limit, and
  `edit-anchors`, one assertion of R8.12, at a load average near 19; both passed when built again, 7.6% and 10 of
  10). The globs were also compared with editorconfig-core-c 0.12.11's `editorconfig` program over 72,000
  glob and path pairs drawn from a small set of pieces (`**/`, `/**/`, `/`, `*`, `**`, `?`, `{a,b}`, `[ab]`,
  names and directories; no escapes, ranges or malformed brackets): no difference. Nothing here runs in edwind's editing of a served buffer: edwind loads the file, and its hooks run only on a
  frame's visit and `save-buffer`.

## format-buffer: the buffer through its mode's formatter (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lang-format-buffer`, on lang-editorconfig and proc-direnv):
src/format.ts runs the language's formatter by argv through Ed.proc and applies the result as a line diff; nothing
changes on a non-zero exit. The `apheleia-format-buffer` desktop-only stub goes. Risk named: the Nix formatter is
the owner's choice (answer 8: alejandra).

- **`format-buffer`** (`SPC b f`, src/format.ts, a new core file through the seven places of the touch list, after
  `editorconfig`): the buffer's text on the standard input of its major mode's formatter, run through
  `Ed.proc.spawn` in the file's directory (so the formatter finds its own settings there: `.editorconfig`,
  `rustfmt.toml`, `pyproject.toml`, `.clang-format`) with the changes `Ed.proc.envFor` gives for that directory (what
  direnv exports). What it prints on its standard output takes the buffer's place through `Ed.applyLineDiff`, so
  point, the mark and every marker on a line the formatter leaves alone stay on that line at their column, and
  the change is one undo step. Past the line diff's budget (more than 1000 differing lines, or its work limit:
  `Rope.diffLines`, src/text.ts) the diff is one replacement of everything between the common prefix and suffix;
  then point, the other windows' points and the markers inside it keep their line number and column, clamped to
  the line (in Normal state to its last character) and to the replacement. That is their own line only where the
  formatter changed no line count above them: a first black run over a 1000-line file that adds blank lines
  leaves point that many lines off. The same rule serves a change that is one hunk. The buffer is then modified; the echo area says `Formatted NAME with PROGRAM`, or
  `NAME is formatted already (PROGRAM)` when the output is the text (nothing is touched then).
- **Nothing changes** (text, point, the mark, undo, the modified flag) when the formatter exits non-zero, is killed
  by a signal, runs past 30 s (killed), prints more than 16 MiB or anything that is not UTF-8, prints nothing for a
  buffer that holds something, or is not on PATH (`process-error: cannot run ...`); nor when the file's directory does not exist yet (a new file
  under a new directory: `user-error` `PROGRAM runs in DIR, which does not exist yet; create it first`, nothing
  started); nor when the buffer was changed
  or killed while it ran. The echo area says why with the first non-blank line of the formatter's error output,
  ending `; the buffer is left as it was`; the whole error output, without colours, is in `*Format Output*`.
  alejandra is such a case: on a parse error it prints its input back and exits 1.
- **`(define-formatter MODES COMMAND)`** (scm/prog.scm, through `%format-declare` in src/format.ts): MODES is a
  mode or a list of modes, COMMAND an argv, a list of strings with the program first; the symbol `file` anywhere
  in it stands for the buffer's file name, absolute. `#f` takes the formatter away; declaring a mode again
  replaces it. A malformed declaration signals `error`. The shipped ones:

  | modes | argv |
  |---|---|
  | `nix-mode` | `alejandra --quiet -` |
  | `rust-mode` | `rustfmt --edition=2021 --emit=stdout --quiet` |
  | `go-mode` | `gofmt` |
  | `python-mode` | `black --quiet -` |
  | `c-mode`, `c++-mode` | `clang-format --assume-filename FILE` |
  | `sh-mode` | `shfmt --filename FILE` |

  Each argv was run on ex44 against the nixpkgs build as written here (alejandra 4.0.0, shfmt 3.14.1, black
  26.5.1, rustfmt, clang-format, gofmt): each reads its standard input and writes its standard output. Their
  settings files are data only. prettier is not shipped: it loads a repository's `prettier.config.js`,
  `.prettierrc.cjs` and the plugins its configuration names, so running it in a cloned repository runs that
  repository's code (and format on save would do so unasked); a user who wants it declares it.
- **The image never reaches a formatter (R16.15).** The argv is kept in src/format.ts, not in a Scheme variable,
  and a declaration made while the image replays (`Ed.proc.replaying()`, added to `Ed.proc` here as lsp-sessions
  adds it, the same line) is skipped with `define-formatter: MODES is not declared while the image replays`: an
  argv a replayed form set would otherwise run on the user's next `SPC b f`. Clearing one (`#f`) is never refused,
  as it starts nothing. format-buffer itself asks `Ed.proc.envFor` before its first wait, which refuses while the
  image replays; in a web frame and on edwind's Node host it says `format-buffer: No processes ...` before reading
  anything.
- **Choices**, each reversible:
  - The command is `format-buffer`, with no `apheleia-format-buffer` alias (Emacs names are dropped, as elsewhere).
  - The formatter is looked up by the buffer's major mode alone, not the modes it derives from.
  - Spawned, not `Ed.proc.run`: the wait holds every key (pool.ts), so it is `EdPool.interruptible` and C-g kills
    the formatter (KILL) and quits, the text untouched; `run` gives no handle to kill.
  - The file name is passed as its own argument (`--filename FILE`), always absolute, so a file named `-x` is
    `/dir/-x` and never reads as an option. A buffer with no file, or whose file is edwind's (a shared buffer, a
    served note: not on this machine), refuses a formatter that needs the name, and runs one that does not in the
    program's own directory.
  - Empty output for a buffer that holds something is a failure, not an empty buffer: a formatter that exits 0
    having printed nothing (a wrapper that formats in place, a misconfigured one) would otherwise wipe the buffer.
  - rustfmt is given the 2021 edition: on its standard input it cannot read Cargo.toml's and would take 2015's,
    which does not parse `async fn`. The flag beats a `rustfmt.toml`'s `edition` (checked: with `edition =
    "2015"` there, `async fn` still formats), so a 2024-edition crate is formatted as 2021; redeclare rust-mode's
    formatter for that.
  - Nothing from `.editorconfig` is passed on the command line: the formatters that honour it (shfmt)
    read it from the directory they run in, and Edwin's own reading (src/editorconfig.ts) sets only the buffer's
    indent.
- **Differences from Emacs** (apheleia): no `apheleia-mode` yet (format on save is lang-format-on-save); a
  formatter is one argv on standard input and output, with no in-place formatters writing a temporary file, no
  `npx` or project-local `node_modules/.bin` lookup, and no formatter chains; the result is applied by line diff,
  not apheleia's RCS-patch walk, with the same effect on point within the diff's budget.
- **In an edwinclient frame** the shipped declarations stand: `Ed.bootServed` evaluates scm/prog.scm in
  `Ed.boot`, before it connects and outside any replay; only edwind's init.scm, evaluated after, is replayed.
  Seen in src/sync.ts, not tested through a real edwind.
- **Not in it:** format on save (lang-format-on-save); a region formatter; JavaScript, TypeScript, JSON and YAML
  (prettier, above); terraform (`terraform fmt -`, unfree in
  nixpkgs, so not checked here), Java, C#, TOML, Typst, Just and the other declared languages have no formatter
  until one is declared; a formatter declared in the user's init.scm in an edwinclient frame, where edwind's
  init.scm is evaluated as the image, is skipped as lsp-sessions' declarations are. **For the owner (fleet):**
  alejandra, shfmt and gofmt must be on the frames' PATH; home/edwin-tools.nix has rustfmt, black, clang-tools
  and go, but not alejandra or shfmt.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-format` (new, test/format.test.mts, 11 passed),
  with real alejandra, black and shfmt in the sandbox: alejandra's output in a Nix buffer equal to what it prints
  run directly, its argv and directory, point on a kept line at its column and the mark with its line, one undo
  and redo, a second run changing nothing; past the diff's budget (2000 lines, every other one changed by `sed`) point, the
  mark, an after marker and another window's point on their line and column, one undo, and a column past a line
  made shorter clamped (the case fails on the code before the rule); black on Python; shfmt given `/…/sh/-odd name.sh` as one argument and
  taking its directory's `.editorconfig` (`indent_size = 3`); alejandra on broken Nix, and sh formatters exiting
  2, printing nothing, printing a byte that is not UTF-8, killed by TERM and past 16 MiB, and a program not on
  PATH, each leaving text, point, the mark, undo and the modified flag; a buffer edited and one killed while the
  formatter ran; C-g killing a hung one; a formatter found only on the PATH a stand-in direnv exports for an
  `.envrc` directory, and not found outside it; no formatter for the mode, a read-only buffer and a buffer with no
  file and one whose directory does not exist refused with nothing spawned; malformed declarations; a declaration inside `Ed.proc.replay` skipped (taking
  the check out fails the case) and `(format-buffer)` inside it, in a web frame and with no `host.proc` starting
  nothing; `SPC b f` bound to `format-buffer` and the stub gone.
  Also passed, each exit 0, on the final tree: `edwin-typecheck`, `edwin-native` (31), `edwin-prog` (41). Passed
  before the line-number rule and the directory check, not run again since: `edwin-headless` (21), `edwin-proc` (13), `edwin-shell-command` (8), `edwin-scheme` (38), `edit-security` (21), `edit-lockdown` (6),
  `edit-frame` (24), `edwin-display` (20); `nix build .#edwin` (unit 30 and 1 ignored, `tests/gui.rs` 5 and 1
  ignored, `tests/terminal.rs` 36). Not run: the whole `nix flake check`.

## format-on-save-mode: the formatter before a save (done)

Asked 2026-11-18 (the Emacs-to-Edwin plan, package `lang-format-on-save`, on lang-format-buffer): a minor mode
that formats before saving, off unless enabled per language. Risk named: the default is the owner's choice; the
plan's default (answer 8) is taken: off in every language.

- **`format-on-save-mode`** (src/format.ts, buffer-local, `format-on-save-enabled`, no lighter): with it on, a
  save the user types runs the buffer's formatter first (`format-buffer`'s own run: the mode's `define-formatter`
  argv in the file's directory and direnv environment, the output applied as a line diff), and the formatted
  text is what is written, in one write. `M-x format-on-save-mode` turns it on or off in one buffer.
- **Per language: `format-on-save-modes`** (scm/prog.scm), a list of major modes, empty by default; on
  `prog-mode-hook` a buffer whose major mode is listed turns the mode on, as in `(set! format-on-save-modes
  '(nix-mode rust-mode))` in init.scm. Buffers already open keep their state.
- **Which saves.** Saving is synchronous (`save-buffer`, and its callers that save and go straight on: vc's offer
  to save, org's autosave, `C-x C-c`'s `!`), and a formatter is a child to wait for, which frame Scheme cannot
  do. So the formatting happens before the saving command runs, when the command loop calls it:
  `Ed.callInteractively` (src/editor-core.ts) asks `Ed.hooks.formatOnSave(NAME, ARGS)` after reading the
  arguments, waits for what it gives, runs the command, then says what the formatting came to. Formatted: the
  current buffer for `SPC f s`, `C-x C-s` and `M-x save-buffer`, `:w` without a file name, `:wq`, `:x` and `ZZ`;
  each buffer they save for `:wa`, `:wqa` and `:xa`, one formatter at a time. A buffer is formatted when the mode
  is on in it, it is modified, writable and visits a file on this machine, its major mode has a formatter and
  processes can start here; else it is saved as it is and nothing is said. Every other command costs one table
  lookup and no wait.
- **A failure never holds the save.** A formatter that fails (each case of format-buffer: non-zero exit, signal,
  timeout, too much output, not UTF-8, empty output, not on PATH, the directory missing, the buffer changed
  meanwhile) leaves the text as it was, the save goes on with the text as typed, and after it the echo area says
  `REASON; NAME is saved as it was` in place of `Wrote ...`; the error output is in `*Format Output*`.
- **The wait.** As for `SPC b f`, the save waits for the formatter with every key held, up to its 30 s timeout
  (then it is killed and the save goes on unformatted). `C-g` while a formatter runs kills it and quits the
  command: nothing is saved, the buffer stays modified. After `C-g` in `:wa`, the buffers formatted before it
  keep their formatted text, unsaved and modified.
- **The image (R16.15).** The argv is still define-formatter's alone, never set while the image replays; turning
  the mode on starts nothing. No formatter starts on a save while the image replays (`Ed.proc.available()`), in
  a web frame or on edwind's Node host; the save goes on unformatted. `format-on-save-modes` is a plain Scheme
  variable, and a replayed form may set it: that only chooses which of the declared formatters run on the
  user's own saves, as binding a key to `format-buffer` would.
- **In an edwinclient frame nothing formats on save**: a file visited there is edwind's shared buffer, not a
  file on this machine (`localFile` in src/format.ts, as for `format-buffer`'s file name), so its formatter's
  directory, settings and direnv environment are not known here; the save goes to edwind as typed. Only a
  frame that visits files itself (the desktop program started without edwind) formats on save. `SPC b f`
  still runs a formatter that needs no file name in such a buffer, in the program's own directory.
- **Choices**, each reversible:
  - Off in every language by default; the owner lists the ones wanted.
  - Before the save, not apheleia's after-save format and second write: `:wq`, `:x` and `ZZ` close the buffer or
    end the program right after saving, which would drop an after-save result, and one write is what file
    watchers and auto-revert see.
  - A save from code (`(save-buffer)` in Scheme or `L.call('save-buffer')`: vc's offer to save before a commit,
    org's autosave, `C-x C-c`'s `!`, `:wa`'s loop when called from code) formats nothing: those callers go on
    straight after the save returns. `:w FILE` writes a copy and formats nothing.
  - The commands that format are a table in src/format.ts by name (`save-buffer`, `evil-write`,
    `evil-save-and-quit`, `evil-save-modified-and-close`, `evil-write-all`, `evil-save-and-quit-all`).
- **Differences from Emacs** (apheleia-mode): apheleia formats after the save and writes again, on every save
  however started; here before the save and only for a save the user typed. No global mode; per language by
  `format-on-save-modes`.
- **Not in it:** formatting on save in a shared buffer or a served note (edwind's files, above); the fleet's choice of
  languages (an owner step: `format-on-save-modes` in the fleet's init.scm, with the formatters on the frames'
  PATH, as format-buffer's entry says).
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-format` (test/format.test.mts, 16 passed: the
  11 of format-buffer and 5 new), with real alejandra in the sandbox: off by default (saved as typed, nothing
  spawned); with nix-mode listed, `SPC f s`, `C-x C-s`, `:w`, `:wq` and `ZZ` each one alejandra run and the
  formatted text on disk, the buffer unmodified, point on its line where the buffer stays, `:wq` and `ZZ` closing it; a sh buffer not
  listed, the mode turned off by `M-x format-on-save-mode`, and `:w FILE`, nothing spawned; broken Nix saved as
  typed with alejandra's error and `is saved as it was`, a formatter not on PATH the same; no file, read-only,
  unmodified and a command that does not save given nothing to wait for; `:wa` one run per listed buffer and the
  others as typed; a save from code unformatted; `C-g` on a hung formatter quitting the save, nothing written;
  inside `Ed.proc.replay`, in a web frame and with no `host.proc` saved as typed with nothing spawned, then
  formatted with processes back. Taking the `formatOnSave` call out of `Ed.callInteractively` fails the 5 new
  cases. Also passed, each exit 0, on the final tree: `edwin-typecheck`, `edwin-headless` (21), `edit-frame`
  (24), `edwin-scheme` (38), `edwin-prog` (41), `edit-security` (21), `edit-lockdown` (6), and `nix build .#edwin`
  (unit 30 and 1 ignored, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 36). Not run: the whole `nix flake
  check`, and the other suites.

## The Lisp lexer: character literals, [ ] and #; (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `se-lexer`): B1, B4 and B5 of the structural-editing audit
(`docs/emacs-to-edwin/structural-editing-audit.md` in the fleet repository). Before, after `#\` the lexer took
nothing when the character was a delimiter, so `#\(` opened a list and `#\"` a string that ran on through the
file; `[ ]` were not brackets; and `#;` was a one-character token followed by a line comment. Every reader of the
lexer's classes was off: `%`, `C-M-f/b/u/k`, `=` and newline indentation, highlighting and the rainbow depths,
`eval-last-sexp`.

- **Character literals** (`lex`, `src/editor-core.ts`): the character after `#\` belongs to the literal whatever
  it is (`#\(` `#\)` `#\[` `#\]` `#\"` `#\;` `#\'` `` #\` `` `#\,` `#\ ` `#\\`); a name (`#\space`, `#\x41`) runs on
  to the next delimiter only when that first character is not one, so `#\(x` is `#\(` and then `x`. Emacs Lisp's
  `?\(` was already read whole, by the token's backslash escape.
- **`[ ]` are brackets** (class PAR) in Scheme and Emacs Lisp buffers: `forwardSexp`, `backwardSexp`, `upList`,
  `matchParen`, the rainbow depths (`parenDepths`, and its copy in `src/pool.ts` for the main-thread lex job),
  `%` (`evil--jump-item`, `matchBracket` in `src/evil-core.ts`) and show-paren. Both kinds share one depth, as
  Emacs's `scan-lists` counts them, so `C-M-f` crosses `(a ]`; show-paren marks such a pair as a mismatch
  (`parenFlags`), as `show-paren-mode` does. `{ }` stay outside the Lisp lexer.
- **`#;` comments out the next datum**: an atom, a string, a character literal, a quoted datum, a whole list or
  a vector (`#(`, and likewise `#u8(` and `#s(`: a `#` prefix right before a bracket belongs to the list, as
  Edwin's reader takes `#(` whole), over any number of lines and with comments between; the `#;` and its datum
  are class CMT, so they are drawn as a comment and the motions skip them. `#;#;a b` comments out both `a` and
  `b`, as R7RS and Racket read it; a run of `#;` lexes in linear time (each character is classed CMT once).
  A close bracket before any datum (`(a #;)`) ends the list and comments nothing more. A `#;` whose datum the
  text ends inside (`#;(` unclosed) comments out the rest of the buffer, as an unterminated string or `#|` does.
- **`%` in Lisp** looks for the next bracket on the line among the real ones: a `( ) [ ]` in a string, a comment
  or a character literal is passed over, so `%` on `(list #\( x)` goes to the closing `)`.
- **`C-M-f` over comments** skips a run of comment characters, not to the end of the line: `#| ) |#` and
  `#;(b)` in the middle of a line are crossed and the motion goes on to the next datum on it.
- **Choices:**
  - The incremental lex (`lexOf`) still restarts at a column-0 paren the old lex classed as a paren. A datum
    comment keeps that sound: a `#;` still waiting at the end of the re-lexed slice marks the slice dirty and the
    lex runs on to the end, as for an unterminated string, and an unclosed datum is a comment to the end of the
    text, so the classes before an edit never depend on a bracket after it. The random-edit test found the second
    rule: without it, closing a list far below a `#;(` changed the classes above the edit.
  - Exact parity: Emacs's scheme-mode gives `{ }` paren syntax as well; Edwin leaves them as plain characters
    (no audit case uses them, and Emacs Lisp does not).
- **gg=G on `scm/evil.scm`** (1,750 lines at 561495a, the base of this package): with the old lexer it changed
  1,009 lines; with every delimiter character literal made `#\a` (which both lexers read the same) 303. With
  this lexer it changes the same 303 lines as the neutral copy, line for line, so none of the 716 lines the
  literals moved is touched: the 303 are the indenter's own differences from the file's style (the Scheme `if`
  rule and forms with a body on the head line, B3, se-indent's), 10 of which the cascade had hidden. (The audit
  counted 606 cascade lines at 73d9f03; the file has grown since.) In `scm/babel.scm` the changed lines go from
  211 to 25; the other `scm/*.scm` files are unchanged.
- **Not in it:** the text objects, `ds` and `cs` and expreg still scan raw characters (B2, B9, B10:
  `di(-charlit`, `di(-charlit-close`, `di(-elisp-charlit`, `ds(-charlit`, se-pair-objects); the indenter's rules
  (B3, se-indent), though `=G-elisp-vector` now passes, since a line inside a vector lines up under its first
  element once `[` opens a list; `%` in non-Lisp buffers (B11, `pct-nix-string-brace`, se-match-nonlisp). The
  other failing audit cases on these keys are not lexer defects and stay open: `CMb` (`C-M-b` from a Normal-state
  cursor on a `)`), `d-CMf` (`C-M-f` as an operator's motion), `[(` and `pct-clj-string` (`.clj` is not a Lisp
  buffer yet, lang-lisp-modes). A docstring is found from the nearest column-0 paren before an edit, so one whose
  form starts above a column-0 paren inside it can come back as a plain string after an edit; that predates this
  package (it showed on the old lexer under the same random edits) and only changes its colour.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-structural`, the new check and
  `test/structural.test.mts` (36): the audit's 12 cases that failed at 73d9f03 (`pct-charlit-open`, `-close`,
  `-dquote`, `-semicolon`, `pct-datum-comment`, `CMf-charlit`, `CMf-list-with-charlit`, `CMf-elisp-vector`,
  `CMf-scheme-brackets`, `=G-charlit`, `=G-elisp-vector`, `=G-idem-evil-surround-pairs`) and 15 that passed and
  still must, driven by keys; the classes and motions for every delimiter literal, `[ ]`, the `#;` forms (vectors, a run of 200,000 in linear time, an unclosed one
  too) and `#| |#`; `%` passing over a bracket in a literal, a string and a comment; show-paren on matched and mismatched pairs in a model frame; the incremental lex against a whole lex
  after 750 seeded random edits of `#;`, `#\(`, `#\;`, `#(`, brackets, strings and comments (with the depths); the worker
  pool's lex (`Ed.LEX_SOURCE` in a thread) and the main thread's against `Ed.lexOf` on `scm/evil.scm`; gg=G on
  `scm/evil.scm` against its neutral copy; and a keystroke in a 10,000-line Scheme buffer re-lexed in 2 ms
  (median of 50; about 0.15 ms in the check). On the old lexer (561495a) 18 or 19 of the 36 fail: the 2 ms keystroke test is timing-dependent there, passing at a median of 1.6 ms in a full-suite run and failing at about 4.4 ms in two runs of it alone. Also passed: `edwin-typecheck`,
  `edwin-headless` (21), `edwin-display` (20), `edwin-scheme` (38), `edwin-pool` (21), `edwin-prog` (41), `edwin-proc` (13), `edit-lockdown` (6), `edit-security` (21) and `nix build .#edwin` (unit 30 and 1 ignored, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 36). `edwin-markdown` (20), `edit-frame` (24), `edwin-syntax` (6), and `nix flake check` (exit 0; two earlier runs each failed one timing test only, `edwin-proc`'s direnv timeout and `edwin-markdown`'s 2 ms font-lock budget at 2.5 ms; `edwin-proc` passed in the second run and `edwin-markdown` alone after it). The whole audit corpus (219 cases) run headless on the old lexer and on this lexer as it was before the `#(` fix (b388475): exactly the 12 cases above go from failing to passing, and no other case changes its result or its output; not rerun since.

## Delimiter text objects through the lexer (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `se-pair-objects`): B2, B9 and B10 of the structural-editing
audit (`docs/emacs-to-edwin/structural-editing-audit.md` in the fleet repository). Before, `i(` `a(` and the other
pair objects counted raw characters, so a `)` in a string, a comment or a character literal closed the list
(`da(` on `(x (foo "a)b" bar) y)` left ` y)`); `ds` and `cs`, and expreg, which call the same scan, went wrong the
same way; `i"` took a quote after an escaped backslash (`"a\\"`) for an escaped quote; and `a(` again in Visual
state selected the same list.

- **Pair objects in Lisp buffers** (`pairObject`, `src/evil-core.ts`): a `( ) [ ]` is a delimiter only when the
  lexer classes it PAR, as `%` already reads it, so brackets in strings, comments, `#;` data, `#\(` and Emacs
  Lisp's `?\(` are passed over; a `{ } < >`, which the Lisp lexer leaves as plain characters, counts outside
  strings, comments and character literals (`#\{`). With point in a string or a comment, the pairs inside that
  string or comment count first, so `di(` still works in a commented-out form (`;; (foo bar)`) and in
  `"a (b) c"`; a count beyond them, or none there, goes on among the lists around the string or comment, so
  `2di(` on the `h` of `(display "(hi)" x)` empties the list. Other buffers keep the raw scan. `ds` and `cs`
  (`evil--surround-bounds`) and expreg call `evil--pair-object` and get the same pairs; `ds` and `cs` needed no
  change in `scm/evil.scm`.
- **Quote objects** (`quoteObject`): a quote is escaped only after an odd run of backslashes, in every buffer, so
  `di"` on `(f "a\\" "b")` empties `"b"` (B9). In a Lisp buffer `i"` and `a"` take the lexer's strings: the one
  point is in, over several lines if it runs over them (a docstring), or else the first that starts after point
  on its line, so `#\"` is never a quote. With point in a comment the comment's line is scanned as in other
  buffers. `'` and `` ` `` stay line-local raw scans: in Lisp they are prefixes, not strings.
- **Visual growth** (`evil--pair-text-object`, B10): the eight pair text objects (`i( a( i[ a[ i{ a{ i< a<`) go
  through it. In Visual state with more than one character selected it takes the COUNTth pair that strictly
  contains the selection, so `va(a(` selects the list around the list, `vi(i(` the inside of the next list out,
  and `vl` then `a(` the list around the selection; from a pair in a string or a comment it grows out to the
  lists around it. With no such pair the text object fails and the selection stays. A linewise selection counts
  as its whole lines, and a pair object (any text object that is not linewise) turns linewise Visual charwise
  (`evil--apply-text-object`), as Vim does, so `V` then `a(`, or `vi(i(` from an inner object that came out
  linewise, selects the pair's text and `d` deletes nothing outside it; before, Visual stayed linewise and `d`
  took the pair's whole lines. `evil--pair-object` itself does not grow: expreg calls it in Visual state for each level.
- **expreg** (`expreg--candidates`, `scm/evil.scm`): in a Lisp buffer the string point is in gives two steps, its
  text and the string with its quotes, between the symbol and the list; a string elsewhere on the line is no step.
- **Choices:**
  - A one-character selection does not grow: it cannot be told from a fresh `v`, and `v` on a one-character
    list's element then `i(` must select that element. So `vi(i(` on `(b)` selects `b` again, where Evil may
    go out to the next list (not checked against Evil).
  - Inside a string or a comment the pairs inside it come first, and a count or Visual growth goes on to the
    lists around it; the audit has no case for it, and Evil's behaviour there was not checked.
  - `ds"` on a string holding a bracket makes that bracket code, as evil-surround does; the balance property test
    leaves `ds"` out for that reason, and every other operator in it keeps the buffer balanced.
- **Not in it:** non-Lisp buffers still scan raw characters for `i(` and the like (`di{` in Nix counts a `}` in a
  string; tree-sitter for brackets is se-match-nonlisp's, B11); expreg in non-Lisp buffers (`expreg-nix-list`,
  audit gap 11); `ds)-keeps-space` and `cs)]-multiline` (B7, se-surround); `dio-symbol` (the symbol object,
  a gap); `i'` and `` i` `` in Lisp.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-structural`, `test/structural.test.mts` now 99
  tests (63 new): the audit's 15 cases that failed at 58df99f (`di(-string-close-paren`, `di(-string-open-paren`,
  `da(-string-paren`, `di(-comment-paren`, `di(-charlit`, `di(-charlit-close`, `di(-elisp-charlit`,
  `di"-escaped-backslash`, `di"-multiline`, `va(a(-expands`, `ds(-string-paren`, `ds(-charlit`, `expreg-string`,
  `expreg-string-paren`, `msg-di(-string`) and 40 that passed there and still must (the other `i( a( i[ i{ i"`,
  `ds`, `cs`, `ys` and expreg cases, with counts, `.`, undo and an unbalanced buffer), driven by keys; every Lisp
  case of the suite that starts balanced ends balanced; 200 seeded random operations (`di( da( di[ da[ ds( ds[
  cs([ cs[( di" da" ci(`) at random points of random balanced Lisp text with strings, literals, `#;` and comments
  leave it balanced; Visual growth (`vi(i(`, `va(a(a(`, `2a(`, `a[` after `a(`, `vl a(`); counts and growth from a
  pair in a string or a comment out to the lists around it (`2di(`, `3di(`, `4di(`, `va(a(`, `va(2a(`); `V a(`,
  `Vj i(`, and `vi(i(` and `vi(a(` from a linewise inner object, which keep to the outer pair; pairs inside a string or
  comment, `{ }` with `#\{`, adjacent strings, `#\"`, `i"` in a comment, and B9 in a Python buffer; expreg's string
  steps; and the Visual-block case operators (`C-v j ~`, `C-v jl U`, `u`, `g?`), which call
  `evil--block-ranges`, a definition in `src/evil-core.ts` this package had dropped by mistake and restored. On
  58df99f 22 of the 99 fail (the 15 cases and the 7 new property and behaviour tests; the block case operators
  pass there, and fail on this package without the restored definition). Also passed in
  the same build: `edwin-typecheck`, `edwin-headless` (21), `edwin-prog` (41), `edwin-scheme` (38),
  `edwin-display` (20), `edwin-pool` (21), `edit-conformance` (29), `edit-lockdown` (6), `edit-security` (21);
  `nix build .#edwin` passed on its second run (unit 30 and 1 ignored, `tests/gui.rs` 5 and 1 ignored,
  `tests/terminal.rs` 36); its first run failed one unit test only, `open.rs`'s
  `the_opener_gets_exactly_its_name_and_the_target` at its `remove_dir_all` cleanup (directory not empty, at a load
  average of 20), in native code this package does not change. At landing, `nix flake check` passed (exit 0) on
  its second run (`--keep-going`); the first stopped at `edit-crash`'s R16.5 (random SIGKILL under a three-client load, "the history
  lost acked batches"), server code this package does not change, which then passed alone.

## Lisp indentation as scheme-mode and emacs-lisp-mode (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `se-indent`): B3 of the structural-editing audit
(`docs/emacs-to-edwin/structural-editing-audit.md` in the fleet repository). Before, `=`, `TAB` and the newline
indentation used a small body table and one rule: a known form's body at +2, anything else under its first
argument. So Scheme `if` put its else branch at +2, a body form on the head line (`(begin (foo)`) did not set the
column for the rest, Emacs Lisp's `use-package` and `with-eval-after-load` lined up under their first argument,
and gg=G on `scm/evil.scm` changed 303 lines once its literals were made neutral.

- **The algorithm** (`lispIndentFor`, `src/editor-core.ts`) is Emacs 31's `calculate-lisp-indent` with
  `scheme-indent-function` or `lisp-indent-function`:
  - With nothing before the line in its list, the line goes one past the open paren.
  - The column a line takes by default is that of the list's second element when it is on the head's line (the
    head is not alone there and no blank follows the paren), else the head's. On a later line it is the first
    sexp of the line holding the last complete sexp.
  - A head that is a list, a vector or a string is data: under the first element, or under that line's first
    sexp. Prefix characters (`'` `` ` `` `,` `#`) are read past, as Emacs reads them, so `('a 'b` is a call.
  - A method of N puts the first N arguments at +4 on lines of their own (only the first and second; a later
    one takes the default column) and the body at +2; `defun` puts the body at +2 when the last sexp is on the
    head's line; Scheme's `let` method treats a named let as two arguments.
  - A line that starts with `:` goes under an earlier `:keyword` that starts a line in the same list, as Emacs does
    for `use-package` and `:hook`.
- **The tables**:
  - `SCHEME_INDENT` is scheme.el's table, including its MIT Scheme forms. To it are added the forms Edwin's own
    Scheme defines (`save-excursion`, `with-current-buffer`, `dolist`, `dotimes`, `while`, `with-mutex`,
    `on-server`, `evil-define-key`, the `evil-define-command`/`motion`/`operator`/`text-object` forms,
    `evil--bind`, `gptel-make-preset` …), each given its Emacs Lisp namesake's method. In Scheme a head of more
    than three characters that starts with `def` and has no method is a defun, as scheme-mode has it.
  - `ELISP_INDENT` holds the `lisp-indent-function` values Emacs 31.1 reports, with `use-package`, gptel,
    transient, evil, general and lispy loaded: the core special forms and macros (`if` 2, `defun` 2,
    `with-eval-after-load` 1, `use-package` defun, `cl-*`, `pcase*`, `when-let*` …) and the macros of those
    packages that the owner's configuration uses. Emacs Lisp no longer has the `def` rule.
- **Dialect**: a buffer whose file (or name) ends in `.el` is indented as Emacs Lisp, the rest as Scheme. A `.el`
  file still opens in Edwin's scheme-mode, and lang-lisp-modes gives it a mode of its own.
- **Lines left alone**: a line that starts inside a string, a `#| |#` comment or a `#;` datum, and a `;;;` line,
  as `lisp-indent-line` leaves them. An empty line stays empty under `=` (`indent-region`,
  `src/editor-prims.ts`), as in Emacs.
- **Edwin's own Scheme files** are not reformatted here. gg=G on the 18 `scm/*.scm` changes 22 lines, each the
  way scheme-mode indents it (checked form by form with Emacs 31.1); the test names each form:
  - `org.scm`, 17 lines: `(define note-capture-templates` and `(define dailies-capture-templates`, whose value
    on the next line goes to +2 (a `define` is a defun), not the file's +6.
  - `evil.scm`, `init.scm` and `markdown.scm`, 1 line each: the second line of a quoted list of symbols
    (`'(dired-mode …`, the modes for `evil-define-key`, `evil-repeat`) goes under the list's second element, as
    for a call, where the file put it under the first.
  - `pi.scm`, 2 lines: `dynamic-wind`'s second and third thunks at +4 (method 3).
  - Every other file is unchanged.
- **Choices** (where Edwin differs from Emacs 31.1, written down in the test):
  - Edwin's own forms have methods that scheme-mode lacks, so `(with-current-buffer b` puts its body at +2 where
    scheme-mode puts it under `b`.
  - A line after a string's last line goes under that line's first sexp. Emacs scans the string's tail as code:
    in `(foo "a⏎b" c⏎d)` it puts `d` at column 0, Edwin puts it under `c`.
  - A vector after a list that closed on its line takes the column `lisp-indent-line` (Emacs's `TAB`) gives.
    Emacs's `indent-region` gives another column there, because it carries a parse state across the closed list.
  - A line inside `#| |#` or a `#;` datum keeps its indentation; Emacs indents it as code.
  - `cl-flet`'s and `cl-labels`' local definitions are indented as calls, not as defuns (Emacs's
    `lisp--local-defform-body-p`); the owner's configuration does not use them.
  - Emacs indents with tabs where `indent-tabs-mode` is on (Customize's `custom.el`); Edwin indents with spaces.
  - No `lisp-indent-local-overrides` and no `(declare (indent …))` read from the buffer: the tables are fixed.
- **Not in it**:
  - `=G-idem-evil-jump-item` stays failing. It is lines 379-387 of `evil.scm` without the form's head, so its first
    line is at top level, and Emacs 31.1 indents it to the same text as Edwin, byte for byte; the test asserts
    that text. The whole form (`=G-idem-jump-item`) keeps its lines.
  - `=G-nix`, `RET-nix` and `RET-py` belong to lang-syntax-indent-*, `=G-rkt` to lang-lisp-modes (`.rkt` is not
    a Lisp buffer), `ysiwf-function` to se-surround, and the org `M-RET` cases to se-org-meta-return.
  - `RET-indent` and `RET-indent-2` fail at 77557e9 and here alike. Insert-state `RET` (`evil-newline-and-indent`)
    indents the new line right but leaves the blank before point at the end of the line it splits
    (`(define (f x) ⏎  (g x))`), which Emacs's `newline-and-indent` drops. That is not an indenter rule.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-structural`; `test/structural.test.mts` now has
  124 tests (25 new):
  - The audit's 10 cases on `=` that failed at 77557e9, driven by keys: `=G-if-scm`, `=G-use-package`,
    `=G-with-eval-after-load`, `=G-idem-evil-comment-op`, `=G-idem-init-prog`, `=G-idem-jump-item`,
    `=G-whole-evil.scm`, `=G-whole-emacs.scm`, `=G-whole-init-prog.el`, `=G-whole-evil.scm-neutralised`. The four
    whole-file cases read the audit's snapshots from `test/fixtures/indent`, with one host and one user name in
    `init-prog.el` replaced.
  - 9 audit cases that passed there and still must: `=G-basic`, `=G-let`, `=G-if-el`, `=G-string`, `=G-comment`,
    `=G-undo`, `=G-unbalanced`, `o-indent`, `TAB-indent`.
  - `=G-idem-evil-jump-item` against Emacs's output.
  - 23 forms whose expectations were checked against Emacs 31.1: Scheme and Emacs Lisp `if`, a body on the head
    line, vectors and brackets, named let, `do`, `dynamic-wind`, the `def` rule in each dialect, `defun`,
    `defcustom`, `gptel-make-openai`, `transient-define-prefix`, `condition-case`, Edwin's own forms, prefixed
    and data heads.
  - Empty lines, `;;;` lines, strings, `#| |#` and `#;` left alone.
  - gg=G on a 184-line Scheme and a 238-line Emacs Lisp corpus compared line by line with Emacs 31.1's
    `indent-region` (`corpus.emacs.scm` and `corpus.emacs.el`), equal everywhere but the 12 lines written down
    as choices.
  - gg=G on every `scm/*.scm`, which changes only the forms listed above.

  On 77557e9, 16 of the 124 fail: the 10 cases and 6 of the new tests. Also by hand, with Emacs 31.1 in batch:
  the owner's 15 `.el` files, indented by Edwin and by Emacs (with those packages loaded), come out the same,
  except `custom.el`, where Emacs's tabs are the only difference. The audit's 216 cases with an expected text,
  run headless with one runner before and after: 148 pass before and 158 after, exactly the 10 above gained and
  none lost. With the runner then fixed to send `Tab` and `Enter` as keys, the final code passes 160 (the 2 more,
  `TAB-indent` and `md-M-x-demote`, had not been driven before; `TAB-indent` passes at 77557e9 in the suite).
  Also passed: `edwin-typecheck`, `edwin-headless` (21), `edwin-prog` (41), `edwin-scheme` (38), `edwin-markdown`
  (20), `edit-babel` (14), `edit-notes` (18), `edit-lockdown` (6), `edit-security` (21) and `nix build .#edwin`
  (unit 30 and 1 ignored, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 36), each exit 0;
  and `nix flake check --keep-going --max-jobs 2` on this commit's code, tests and fixtures before these notes were finished (exit 0, "all checks passed!").

## One comment rule for gc and M-; (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `se-comment`): B6 of the structural-editing audit
(`docs/emacs-to-edwin/structural-editing-audit.md` in the fleet repository). lang-comment-syntax and lang-prog-mode
had already given each mode its comment syntax, so `gcc` wrote `//` in `.js` and `<!-- -->` in Markdown, and
`comment-line` no longer hard-coded `;; `. What was left: `gc` took only its own opener as a comment, so `;;; Header`
became `; Header` and `; foo` became `;; ; foo`, while `M-;` stripped any run of `;`.

- **`comment-toggle-lines`** (`scm/emacs.scm`) is the one rule, and `gc`/`gcc` (`evil-comment-operator`,
  `scm/evil.scm`) and `M-;` (`comment-line`) both call it. Over a range of lines: when every non-blank line is a
  comment it strips each, else it comments each non-blank line at its indentation; blank lines are left alone.
- **What counts as a comment** (`comment--opener-re`): an opener of one character repeated counts with any more of
  that character, and is stripped whole with one space after it: `//` and `///`, `#` and `##`. Scheme's `;;`
  counts as any run of `;`, one included, since one `;` starts a Lisp comment and the second is a convention (Emacs's
  `comment-add`). So `;;; Header` gives `Header` and `; foo` gives `foo` under both commands, while `/ x` in `.js`
  is not a comment and is commented to `// / x`. A block opener (`<!--`) counts only as itself and with its closer
  at the end of the line.
- **`M-;` follows `gc` on a region**: `comment-line` takes the region's lines (the last one left out when the region
  ends at its start, as Emacs's) and decides for all of them at once, as Emacs's `comment-or-uncomment-region`
  does; before, it toggled each line on its own. On a blank line it does nothing, as Emacs's `comment-line` with
  `comment-empty-lines` nil. With no region it takes the line and the N-1 after it, no further than the last line;
  a negative N takes the -N lines above, no further than the first (Emacs's meaning), and 0 takes none.
- **`M-;` in Visual state** is `gc` (`evil-visual-state-map`): Evil in Emacs gives `comment-line` a region over the
  selected lines, whereas Edwin's region is the raw point and mark, which in linewise Visual stops at the start
  of the last line and would leave it out.
- **The audit's four `M-;` failures**: `M-;-nix-hex` (`ESC ;` sent as bytes) gave `;; ` in .nix, which
  lang-comment-syntax had already fixed. The other three (`M-;-scm`, `M-;-nix`, `M-;-insert-nix`) came from the
  audit's key delivery, not Edwin: `M` and `-` arrived instead of `M-;`, which fits tmux taking the `;` as its
  command separator. In Normal state they gave "Beginning of buffer" and in Insert state typed `M-`, as the audit
  recorded. The terminal decoder reads `ESC ;` and the kitty key `CSI 59;3u` as `M-;`, `M-;` is `comment-line` in
  `global-map`, and Insert state reaches it; the tests drive them by key, the hex cases through the decoder, and
  check that `M` then `-` on line 1 gives that echo and Insert state types `M-`.
- **Choices** (where Edwin differs from Emacs): `M-;` with a count leaves point where it was; Emacs's
  `comment-line` moves it past the lines. `gca(` on lines of a list comments those whole lines (gc is linewise);
  the audit gave `gca(-multiline` no expected text, and it is not in the suite.
- **Not in it**: in Org, `gc` and `M-;` on `#+TITLE` still strip the `#` (Emacs's `comment-start-skip` needs a
  blank after it), as before. Nothing reads strings or the lexer, so a `#` inside a string at the start of a line
  counts; no `comment-dwim`, `comment-region` or end-of-line comments.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-structural`; `test/structural.test.mts` now has
  150 tests (26 new):
  - The audit's 8 comment cases that failed at 73d9f03, driven by keys: `gcc-js`, `gcc-md`, `gcc-uncomment-;;;`,
    `gcc-uncomment-;`, `M-;-nix`, `M-;-scm`, `M-;-insert-nix`, and `M-;-nix-hex` (its bytes `1b 3b` through the
    terminal decoder).
  - 14 audit cases that passed there and still must: `gcc`, `gcc-toggle`, `gcc-indented`, `3gcc`, `gcj`, `Vjgc`,
    `gcc-dot`, `gcc-undo`, `gcc-nix`, `gcc-py`, `gcc-el`, `gcip`, `M-;-scm-hex`, `M-;-toggle-hex`.
  - `gc` and `M-;` giving the same text on 8 inputs in Scheme, `.js`, `.nix` and Markdown (runs, a mixed range,
    a one-character `/` or `;` that is no comment, closed and unclosed block comments); `M-;` on a Visual
    selection, on an Emacs region of mixed lines, with a count past the last line and on a blank line; the
    decoder's `M-;`, its binding, and what the audit's `M` `-` did; `C-u - M-;` in Emacs state on a commented
    last line, `(comment-line -1)` and `comment-toggle-lines` with -1 lines returning at once and changing nothing
    (a review found the first two running into the 8 s limit), and `-2` and `-5` from the third line.

  On 842e243 (se-indent), 5 of the 150 fail: `gcc-uncomment-;;;`, `gcc-uncomment-;`, the test of `gc` and `M-;`
  giving the same text, the one of `M-;` on a region and the one of a negative count. The other 6 audit cases pass
  there: `gcc-js`, `gcc-md` and `M-;-nix-hex` through lang-comment-syntax and lang-prog-mode, the other `M-;` ones
  once the key is delivered. With the review's fix (the negative count) these 150 pass, and so do `edwin-prog` (41)
  and `edwin-typecheck`. The rest were run on the commit before the fix, whose code differs only in
  `comment-line`'s negative count and the `>=` in `comment-toggle-lines`'s loop (scm/emacs.scm) and whose
  structural suite lacks the 4 tests above; there passed `edwin-headless` (21), `edwin-scheme` (38),
  `edwin-markdown` (20), `edit-lockdown` (6), `edit-security` (21) and `nix build .#edwin` (unit 30 and 1 ignored,
  `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 36), each exit 0, and `nix flake check --keep-going
  --max-jobs 2` on that commit's code and tests before these notes were finished (exit 0, "all checks passed!").

## Surround fixes (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `se-surround`): B7 of the structural-editing audit
(`docs/emacs-to-edwin/structural-editing-audit.md` in the fleet repository). Before, `ys` could not be repeated
with `.` (it ran under `evil-yank`, which is not repeated); `yss)` on an indented line put the indentation inside
the pair; `cs)]` over several lines joined them (`string-trim`); `ds)` took the blanks inside `( foo )`; `ys2e)`
read the `2` as a key and failed; `ysiwf` wrapped in `f`; and `V S)` put the pair on the line itself.
Expected behaviour was checked against evil-surround's own source (evil-surround 20240325.852 from nixpkgs).

- **`.` repeats `ys`** (`surroundEdit`, `src/evil-core.ts`): once a surround has been made, the change being
  recorded for `.` is marked as `evil-surround-region`'s, which is repeated, instead of `evil-yank`'s, which is not.
  `.` replays the keys, so `ysiw)` then `fb.` wraps `bar` too, and a yank alone is still not repeated.
- **A count before the motion** (`ys2e)`, `ys2s)`): read as the operator reader does and multiplied by a count
  before `ys` (`2ys2w)` is `ys4w)`). `.` with a count replaces the count before `ys`.
- **`ysw` wraps as `cw` changes**: the word without the blanks after it, as evil-surround puts itself on
  `evil-change-commands`. `cw` (`motionRange`) is `ce`, except that, as in Vim, point on a word's last character
  counts that word as the first of the count: `cw` there changes that one character and `c2w` goes on to the next
  word's end. So `ysw)` on `ab cd` with point on `b` gives `a(b) cd`, on `a b` gives `(a) b`, and `ys2w)` on
  `a b c` gives `(a b) c`. Before, `e` from a word's end went on to the end of the next word and took it too.
  A count that runs past the buffer's last word stops at that word's end (`evil--forward-word-end-1`,
  `scm/evil.scm`): `e` with no word after point stays, so `ys2w)` on `ab` with point on `b` gives `a(b)` and
  `c2wX` on `x ab` from `$` gives `x aX`, both keeping the final newline. Before, `e` went on to the end of the
  buffer, past the final newline, so the pair or the change took it (`cw` did so on a69f078 too).
- **Lines** (`evil--surround-insert`, `scm/evil.scm`): `yss` and any linewise range of one line are wrapped from
  the first non-blank to the last non-blank, so `yss)` on `  foo bar` gives `  (foo bar)`. More than one line
  (`ysj`, `2yss`, `ysip`), and Visual `S` on lines even on one (`V S)`), put the opening and closing strings on lines
  of their own, at the first line's indentation and without their pad blank: `foo` with `V S)` gives `(`, `foo`, `)`.
- **`ds` and `cs`** (`evil--surround-take`): an opening bracket (`ds(`, `cs([`) also takes the blanks just inside
  the pair; any other character (`ds)`, `cs)]`, `ds"`) leaves them, as evil-surround does, so `ds)` on `( foo )`
  gives ` foo `. Only spaces and tabs are taken, never newlines, and `cs` no longer trims the text it keeps, so
  `cs)]` on `(`, `  foo`, `)` keeps the three lines. A new pair's pad blank (`[ ` ` ]`) is left out next to a
  newline, so `cs([` there gives `[`, `  foo`, `]` and no line ends in a blank.
- **`f`** (the `<surround>` interactive code, `surroundChar`): after `ys{motion}`, `cs{old}` and Visual `S`, `f`
  reads a function name in the minibuffer and wraps the text in a call of it, `name(` and `)`, as evil-surround's
  `evil-surround-function`: `ysiwf g RET` on `foo` gives `g(foo)`, in every mode. `.` replays the name typed;
  `C-g` at the prompt changes nothing. `cs` reads both characters, so the new one never runs as a command, but
  finds the old pair before `f` asks for a name: `cs(f` with no `(` around point fails with `No surrounding (`.
- **Choices** (where Edwin differs from evil-surround):
  - The lines inside a pair put on lines of its own are left as they were; evil-surround runs `indent-region` over
    them (in a Lisp buffer, `foo` would move under the `(`). `=` reindents them. The audit's `VS)-linewise`
    expects them unindented, and the test asserts that.
  - `ds(` and `cs(` take spaces and tabs inside the pair, not newlines; evil-surround takes any whitespace, so its
    `cs([` over several lines joins them, which is what the package asked to stop.
  - The function name is prompted for with `Function: `; evil-surround's prompt is empty.
  - `ds` of a character that is no opening bracket used to take the blanks inside too (`ds"` on `" b "` gave
    `b`); it now keeps them, as evil-surround.
- **Not in it**: `C-f` (`(name ` and `)`, evil-surround's prefix call), `t` and `<` as tags (Edwin's `<` stays
  the pair `< >`), `#` as `#{ }`, and surround over a Visual block, which wraps the block's first to last character
  as before.
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-structural`; `test/structural.test.mts` now has
  172 tests (22 new):
  - The audit's 8 surround cases that failed at a69f078, driven by keys: `ys2e)`, `yss)-indented`,
    `ysiwf-function`, `ds)-keeps-space`, `cs)]-multiline`, `VS)-linewise`, `ysiw)-dot` and `yss)-dot`.
  - 8 audit cases that passed there and still must: `ysiw)`, `ysiw(`, `ysiw"`, `ysiwb`, `ysiw*-unknown`,
    `vS)-charwise`, `ysiw)-undo`, `ysiw)-in-el`. The other `ds`, `cs` and `ys` cases of the audit were already
    in the suite from se-pair-objects.
  - Lines (`yss(` with trailing blanks, a tab, no final newline; `2yss)`, `ys2s)`, `ysj{` in Nix, `ysip)`, `ysj)`
    with no final newline), counts (`2ys2w)`, `ys3e)`, `ysw)`), `ysw)` `ys2w)` `ys2W)` `cw` and `c2w` from a
    word's last character, and `ys2w)` and `c2w` there with no word after it, keeping the final newline; Visual `S` on two lines, on one line and charwise;
    `ds(` `ds)` `ds"` `cs)]` `cs(]` `cs([` `cs)[` on one line and over several; `f` with `ys`, `cs` and Visual `S`
    in Scheme, `.js` and Python, `.` and undo after it, `C-g` at its prompt, `cs(f` with no pair asking for no
    name; `.` after `ys` across a yank, a yank alone not repeated, a count inside `ys`'s keys and one given to `.`; every surround case of the audit that
    starts from a balanced Lisp buffer ends balanced.
  - Each case starts with nothing to repeat (`buffer` clears `dotLast`): on a69f078 `yss)-dot` passed by chance, with
    a `.` left over from an earlier case.

  On a69f078 (se-comment), 13 of the 172 fail: the 8 audit cases and 5 of the new behaviour tests. The `cw` and
  `cs(f` cases were added later, inside two of those 5 tests, and fail on 134af95 too. Also passed on the final
  code, each exit 0: `edwin-typecheck`, `edwin-headless` (21), `edwin-scheme` (38), `edwin-prog` (41),
  `edit-conformance` (29), `edit-lockdown` (6), `edit-security` (21) and `nix build .#edwin` (unit 30 and 1 ignored, `tests/gui.rs` 5 and 1 ignored, `tests/terminal.rs` 36). `nix flake check` was
  not run.

## Org M-RET and the subtree docstrings (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `se-org-meta-return`): B8 and B12 of the structural-editing
audit (`docs/emacs-to-edwin/structural-editing-audit.md` in the fleet repository). Before, `M-RET` on a list item
(`- foo`, `1. foo`, `- [ ] foo`) or a plain line made the new item but left point at the start of the line after
it, so `M-RET bar` gave `- foo`, an empty `- ` and `bar`; and on the last headline of a buffer ending in a newline
it put a blank line before the new headline. The docstrings of `org-promote-subtree` and `org-demote-subtree`
named `<<` and `>>`, which act on the headline alone.

- **Point on the new item** (`org-meta-return`, `src/org.ts`): `Ed.replaceText` moves point past text inserted at
  point, and the item and plain-line branches then added the inserted length a second time. They now place point
  from where it was before the edit, so the text typed goes on the new item, from Normal state (`M-RET`, `M-x
  org-meta-return`), from Insert state at the end of the line, and when splitting a line in the middle.
- **No blank line after the last headline**: the new headline goes before the newline that ends the entry, as it
  already did before the next headline; `* A` then `M-RET B` gives `* A`, `* B`. The same in Markdown (`# A`) and
  for `org-insert-todo-heading`, which goes through `org-meta-return`.
- **Docstrings (B12)**: `org-promote-subtree` names `M-h` and `M-<left>`, `org-demote-subtree` `M-l` and
  `M-<right>`, the keys bound to them, and each says that `<<` or `>>` changes the headline alone. The docstrings
  are those of the commands in `src/org.ts`, where both are defined; no scm file holds them.
- **Choices**: blank lines already at the end of the entry stay above the new headline, and none is added
  (`* A`, blank, then `M-RET B` gives `* A`, blank, `* B`); Org's `org-blank-before-new-entry` is not modelled.
- **Not in it**: the audit's other failing Org and Markdown cases, which are list-structure and Markdown features,
  not B8: `M-l` and `M-j` on a list item (`org-M-l-item`, `org-M-j-item`), `o` continuing a list item
  (`org-o-item`) and `M-l` demoting a Markdown heading (`md-M-l`).
- **Checked by**, on ex44: `nix build .#checks.x86_64-linux.edwin-structural`; `test/structural.test.mts` now has
  188 tests (16 new):
  - The audit's 8 `M-RET` cases that failed at 73d9f03 and still at 6608209 (se-surround), driven by keys:
    `org-M-RET-heading`, `org-M-RET-item`, `org-M-RET-numbered`, `org-M-RET-checkbox`, `org-M-x-meta-return-last`,
    `org-M-RET-item-middle`, `org-M-x-meta-return-item-last`, `org-M-RET-item-insert-eol`.
  - 5 audit cases that passed there and still must: `org-M-RET-middle`, `org-M-l`, `org-M-h`, `org->>`, `org-<<`.
  - The last headline with a body, at level 2, with no final newline, with a trailing blank line, before a next
    headline after a blank line, and in Markdown; items indented, with `+`, `1)` and a checked box (the new one is
    `[ ]`); a plain line under a headline from Normal state and from the end of the line in Insert state; splitting
    an item and a headline mid-line; `org-insert-todo-heading` on the last headline; the two docstrings, the
    `M-<left>` and `M-<right>` bindings, and `M-l` `M-h` against `>>` on a subtree.

  On 6608209 (se-surround), 11 of the 16 new tests fail: the 8 audit cases and the 3 behaviour tests. Also passed
  on the final code, each exit 0: `edwin-typecheck`, `edwin-headless` (21), `edwin-markdown` (20), `edit-notes` (18)
  and `edwin-scheme` (38), and `nix build .#edwin` (unit 30 and 1 ignored, `tests/gui.rs` 5 and 1 ignored,
  `tests/terminal.rs` 36). `nix flake check` was not run.

## Balanced brackets in Lisp buffers (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lang-lisp-brackets`): balanced insertion and deletion, the
matching bracket face and the sexp motion primitives for Lisp. Before, typing in a Scheme or Emacs Lisp buffer
was electric-pair-mode's: `(` paired except before a word, `)` was inserted unless the next character was one, `"`
in a string ended it, `;` could comment out the closing brackets of its line, and DEL took a bracket alone unless
the pair was empty, so a few keys left the buffer unbalanced. The audit (`structural-editing-audit.md` in the fleet
repository, "Missing" items 1, 6 and 7) lists the cases; lispy and paredit, which the owner's Emacs uses, were the
model. A Lisp buffer here is `scheme-mode` or `scheme-interaction-mode` (`.scm` and `.el` files), not a minibuffer,
with `electric-pair-mode` on.

- **One guard** (`balanceSpan` and `keepsBalance`, `src/editor-core.ts`): every edit the keys below make is judged
  on a span: the text from the top-level form at or before it (a bracket in column 0) to the one after, when that is
  balanced (no bracket closes more than opened, all closed, no string, `#|` or `#;` left open). When it is not (a
  list in column 0 inside a form, or a buffer being repaired) and the whole buffer is, the span is the innermost
  list around the edit, or at top level the whole text; when neither is, the keys work as they did before
  (electric-pair-mode's), so an unbalanced buffer can be repaired by typing. `balanceSpan` reads all this off the
  classes the buffer's lexer already holds, with no lexing. An edit that would leave its span unbalanced is refused
  with `That would unbalance the brackets` and changes nothing. `keepsBalance` lexes only the piece of text around
  the edit, from the bracket before it to the bracket after it (where the lexer is in its first state), with the
  edit made: when that piece leaves nothing open, still ends with its bracket, changes the depth by as much as
  before and goes no lower than before, the text outside it lexes as before at the same depths, and the edit is
  allowed. Anything else (a `#;` that takes the next datum, an edit that is refused) is judged by lexing the whole
  span with the edit made (`balancedLisp`). So a key costs the piece between two brackets, plus a scan of the
  form's classes; the first version lexed the whole form twice per key, which inside one large indented form (an
  R7RS `define-library`, a long quoted table) grew with the form.
- **Typing** (`self-insert-command`, `src/extras.ts`), in code:
  - `(` and `[` insert the pair, point inside, with a blank between it and an atom before or after it, as lispy's
    `lispy-pair` does (lispy 20230314.1738, the nixpkgs one): `foo` then `(` gives `foo ()`, `(` before `foo` gives `() foo`. No blank after a quote or a `#` prefix
    (`'()`, `#()`, `#u8()`).
  - `)` and `]` move out of the list around point, past its closing bracket, whatever lies between; at top level
    they are refused with `No list to close here`.
  - `"` inserts `""`, point inside. In a string `"` inserts `\"`, and before the string's closing quote steps over
    it, so `"foo"` typed whole comes out as typed.
  - `;` with more code after point on the line puts that code on a line of its own, indented, as paredit's
    semicolon does: `(a b c)` with `;` before `b` gives `(a ;` and ` b c)`. After `#` it is a datum comment.
  - `|` after `#` opens and closes a block comment, `#||#`, point inside.
  - A backslash, in code or a string, reads the next character and inserts the two together (the interactive spec
    reads it), so `#\(`, `?\(` and `\"` never escape the text after point. In a comment it is a plain character.
    A key after it that is no character (`ESC`, `C-g`, `<left>`) inserts nothing and runs as typed, so `\` then
    `ESC` leaves Insert state with the text unchanged; there is no lone backslash to insert.
  - Anything else, and every character in a string or a `;` or `#|` comment, goes in as typed, through the guard.
  - Point between a backslash and the character it escapes is taken past that character first.
- **Replace state** (`R`, the same `self-insert-command`): each character overwrites the one at point, or at a
  line's end is inserted, as evil-core's Replace state does, and that edit goes through the guard first. A bracket,
  a string quote, a `;` or a backslash that would leave a bracket unmatched, and any character over a bracket or a
  string's quote, is refused with `That would unbalance the brackets`; plain characters over plain characters, a
  bracket over the same bracket and brackets or quotes in a string or a comment replace as before. Replace state
  pairs nothing and reads no character after a backslash: the rules above are Insert and Emacs state's. `DEL` there
  (`evil-replace-backspace`) puts the replaced character back before point, wherever point now is; that edit is
  judged too and refused, the character kept for a later `DEL`, when it would unbalance: in `(a ‸bc)`, `R x` then
  `<left>` three times and `DEL` would put the `b` in place of the `(`. Before, Replace state was not guarded:
  `R)` on the `b` of `(a b)`, then `ESC`, gave `(a ))`.
- **Deleting** (`electric-pair-delete`, called by `delete-backward-char` and `delete-forward-char`, so `DEL`,
  `<deletechar>` and Emacs state's `C-d`): a bracket takes its whole list (with the quote before it, for DEL), a
  string's quote its whole string, a backslash or the character it escapes both, and a character literal's `#` or `?`
  the whole literal, and a character of a `#|` or `|#` its whole block comment, so `#|` typed and DEL straight after
  give back the text, as `(` and `"` do. `(foo)` with DEL after the `)` or after the `(` gives nothing; `"a\"b"` with
  DEL after the `\"` gives `"ab"`. `<deletechar>` and `C-d` on a list's closing bracket or a string's closing quote
  from inside delete nothing and move point to the list's opening bracket or the string's opening quote, as lispy's
  `C-d` does by default (`lispy-delete-sexp-from-within` nil): `(a (b c‸) d)` gives `(a ‸(b c) d)`, `'(b‸)` gives
  `'‸(b)`, `(f "abc‸")` gives `(f ‸"abc")`. Everything else is the one character, through the guard: DEL of the
  only `;` of a comment over a `)`, or of the newline before a bracket the comment above would take, is refused. A
  count deletes one at a time and ends at a move to the start, so `C-u 3 C-d` in `(f "ab‸c")` deletes the `c` and
  stops at `(f ‸"ab")`. A negative count deletes the other way by the same rules (`C-u -2 DEL` is `C-u 2 C-d`).
  Outside Lisp buffers DEL still deletes an empty pair whole, as before.
- **RET** (`newline`, `evil-newline-and-indent`, through `lisp-newline-prefix`): inside a `;` comment with more of
  it after point, the new line goes on with the comment, its run of `;` and a blank, so the rest stays a comment.
  A new line the guard refuses (between the `#` and `;` of a datum comment) is refused.
- **The list motions** (`src/editor-prims.ts`, on the lexer's classes, so brackets in strings, comments and character
  literals are not lists): `down-list` (`C-M-d`, negative backward down), `up-list` (forward out, no key, as in Emacs;
  negative is `backward-up-list`), `forward-list` and `backward-list` (`C-M-n`, `C-M-p`, over lists past the atoms
  between), `beginning-of-defun` and `end-of-defun` (`C-M-a`, `C-M-e`, a top-level form being one that starts with a
  bracket in column 0) and `transpose-sexps` (`C-M-t`). A step with nowhere to go signals `scan-error`. A negative
  count goes the other way in each: `(beginning-of-defun -1)` to the start of the next form, or the buffer's end;
  `(end-of-defun -1)` back to the line after the end of the last form that ends before point, or the buffer's start.
  Emacs 31 (`emacs -Q --batch`) agrees on forms with blank lines between them; with none, from inside a form Emacs's
  `end-of-defun -1` skips one more form (`(a)\n(b c)` from inside `(b c)` goes to the buffer's start), and Edwin stops
  at the line after `(a)`. `Ed.upListForward`, `downList`, `backwardDownList`, `nextListStart`, `prevListEnd`,
  `defunBefore`, `defunAfter`, `stringAt`, `inStringAt`, `inCommentAt` and `escapingAt` are the helpers, for the lispy
  packages to build on.
- **The matching bracket face** was already there: se-lexer's show-paren (`parenFlags`, the `paren` and
  `mismatch` faces) reads the lexer, and its test is in `edwin-structural`. It is unchanged.
- **Choices** (where Edwin differs from lispy, paredit or the audit):
  - `ep-(-before-word` expected electric-pair's `(foo`, which is unbalanced; Edwin gives `() foo`.
  - `ep-DEL-open-with-content` expected the list deleted, but its keys (`la`) put point after the `f`, not the
    `(`: DEL deletes the `f`, as lispy's `lispy-delete-backward` does. `ep-DEL-after-open` covers DEL after the `(`.
  - `CMb` (`$` then `C-M-b` on `(a) (b c)`) expected the list. Point is before the character the Normal-state
    cursor covers, the closing `)`, so `C-M-b` crosses `c`, as Emacs's backward-sexp from there does.
  - `)` and `]` close the list around point whatever its kind, as Emacs's scan-lists counts both kinds as one.
  - Inside a `#;` datum comment the characters are the comment's, so `(` there goes in alone and is refused, as the
    datum would no longer end; editing inside a datum comment needs electric-pair-mode off.
  - Joining a line into the `;` comment above it with DEL is allowed when the brackets stay balanced (the comment
    takes a whole list). That is Edwin's own choice; lispy was not checked for it.
  - `{` and `}` are plain characters in Lisp (no bracket to the lexer); electric-pair-mode paired them before, so
    audit case `ep-{` (`i{` on an empty line), which expected and got `{}`, now gives `{`.
  - `C-M-t` is bound globally, as in Emacs, and like `C-M-f` and `C-M-b` reads every buffer with the Lisp lexer, so
    in prose it swaps by that lexer's atoms: `it's ‸a (b) c` in a `.txt` buffer gives `ita 's (b) c`. Other modes'
    sexps wait for their syntax tables or tree-sitter.
  - `C-d` on a closing bracket or quote from inside moves to the start, lispy's default; the package's earlier
    versions deleted the whole list or string, as `lispy-delete-sexp-from-within` t does, so `C-u 3 C-d` in `(f "ab‸c")` could
    delete a whole form. Ending a count at that move is Edwin's own (lispy's count there was not checked). The `|#`
    of a block comment, from inside, still takes the whole comment: lispy has no rule for `#| |#`.
  - A negative count of `DEL` or `C-d` (`C-u -2 DEL` in Emacs state) deletes the other way through the guard; the
    earlier versions passed it to `delete-char`, past the guard.
  - Not guarded:
    - `x`, `d`, `c`, `C-w`, `C-u`, `C-k`, `M-d` and paste: they are lang-lispy-operators'.
    - `DEL` and `C-d` with an active region delete the region as it is (`delete-region`): `(a ‸(b) c)` with
      `C-SPC C-f DEL` in Emacs state gives `(a b) c)`.
    - `C-q` is undefined in Edwin (there is no `quoted-insert`), so `C-q )` says `C-q is undefined` and the `)`
      is typed as any `)` is, through the guard, leaving the list. A literal bracket needs electric-pair-mode off
      (`SPC t e`).
    - A backslash then `DEL`: `DEL` is no character, so the backslash inserts nothing and `DEL` runs as typed,
      deleting the character before point (`(a ‸b)` with `\` then `DEL` gives `(a‸b)`), through the guard as any
      `DEL` does.
- **Not in it**: the Normal-state motions `[(` `])` and atom motions on `W B E` (lang-lispy-motions), `d` with
  any command as a motion (`d-CMf`) and `ep-x-on-paren` (lang-lispy-operators), slurp, barf and the rest
  (lang-lispy-structural), `backward-kill-sexp`, and Clojure's `{ }` (lang-lisp-modes).
- **Checked by**, on ex44, on the one commit rebased onto emacs-to-edwin (39891f7):
  `nix build .#checks.x86_64-linux.edwin-prog` (65 tests, 65 passed: `test/prog.test.mts` now has 49, 24 new, and
  `test/editorconfig.test.mts` 16):
  - 11 audit cases, by id: `ep-DEL-after-close`, `ep-DEL-after-open`, `ep-DEL-open-with-content`,
    `ep-(-before-word`, `ep-"-inside-string`, `CMd-down-list`, `CMn-forward-list`, `CMt-transpose-sexps`,
    `CMa-beginning-of-defun`, `CMb` and `ep-{`; `ep-(-before-word`, `ep-DEL-open-with-content`, `CMb` and `ep-{`
    differ from the audit as written above.
  - Typing: the pairs and their blanks, `)` `]` out of a list over lines, `"` in code and in a string and at its
    end, brackets in strings and comments, `#|`, `{}`; backslashes in code, a string and a comment, point between a
    backslash and what it escapes, `;` before code, at a line's end and after `#`, `)` at top level; a backslash
    then `ESC` (Normal state, text unchanged), `<left>` (point moved, still Insert) and `C-g`; a refused edit and an
    unbalanced buffer typed into as before; on an inner-list span (a list in column 0 inside a form), `)` and `]`
    between the `#` and `;` of a datum comment refused, in a quoted table too, while a letter after the datum and
    DEL turning `#x;` into `#;` go through.
  - Deleting: lists by either bracket, with a quote, empty; strings by either quote and empty; escapes in strings
    and character literals (`#\(`, `#\)`, `#\space`, `?\(`) with DEL and `<deletechar>`; block comments, empty and
    not, by each character of `#|` and `|#`, and `#|` then DEL giving the text back; brackets in comments and strings
    as one character; the refusals, among them the `;` of a comment over `))((`, refused at top level and allowed two
    lists down (where only the whole form, lexed again, decides); an unbalanced buffer; `C-d` and `C-u 2 C-d` in
    Emacs state; `<deletechar>` on a closing `)`, `]` (with a quote before the list) and `"` (of an empty string
    too) from inside moving to the start; `C-u 2 C-d` and `C-u 3 C-d` ending at that move; `C-u -2 DEL` and
    `C-u -1 C-d` in Emacs state, and `C-u -1 DEL` of a comment's `;` over a `)` refused.
  - Replace state: `R` with `)`, `(`, `]`, `"` and `;` over a plain character, a backslash before a `)`, and a
    plain character over a bracket and over a string's quote, refused with the message; plain over plain (a count of
    two), `)` over `)`, `(` in a string, `)` in a comment and a character at a line's end replacing or inserting;
    the reviewer's `R)` then `ESC` on `(a b)`; `DEL` putting back a character away from the replacement refused,
    and right after it allowed.
  - RET in a comment, at a comment's end and in Emacs state; a minibuffer, a Nix buffer, electric-pair-mode off
    and an `.el` buffer.
  - The list motions with counts and their refusals, negative counts of `beginning-of-defun` and `end-of-defun`
    against Emacs 31's answers, and `transpose-sexps`.
  - The property test: 200 random balanced texts of lists, vectors, strings with escapes, character literals,
    `;`, `#|` and `#;` comments, and lists in column 0 (one with a `#;` datum and code after it on its line), in
    `.scm` and `.el`, in Insert, Emacs and Replace state in turn, each given 12 random keys at a random point
    (letters, blanks, brackets, `"`, `;`, `#`, `\`, `|`, `'`, DEL, `<deletechar>`, RET, `C-d` in Emacs state, and
    `<left>` and `<right>` in Replace state), checked balanced after every key; of the 2,400 keys, 1,655 changed the
    text and 335 were refused. With the guard taken out (`keepsBalance` always true) it fails on seed 21's second
    text; with Replace state's guard taken out, for a typed character or for `DEL` putting one back, it fails, as
    does the Replace-state test; with either of `keepsBalance`'s depth conditions on the piece taken out, the
    property test or the `))((` cases fail.
  - The guard's soundness, apart from the keys: 200 more such texts, and at every position of each, 14 edits (a
    letter, each bracket, `"`, `;`, `#`, `|`, `\`, a newline, `#;`, `||#`, `()`, inserted and replacing the
    character there, and that character deleted), judged by `keepsBalance` on `balanceSpan`'s span; every edit it
    accepts must leave the whole text balanced, lexed again. 567,556 edits judged, 2,669 refused that would have
    kept the text balanced (the guard being careful, logged, not a failure). A review found the hole this catches:
    on an inner-list span (a list in column 0 inside a form, where the span is the innermost list around the edit),
    `)` typed between the `#` and `;` of a `#;` datum made `#);`, a `;` comment running past the list's `)` and
    commenting out the line's rest outside the span; the span's own text lexed as balanced. Now a span that ends at
    a list's closing bracket must still end with that bracket after the edit (`balancedLisp`'s `closed`). Before
    the fix 114 of 358,933 edits of a direct fuzz were such unsound accepts, all of this kind; after it none, and
    8 more refusals.
  - The keystroke budget: in a 10,000-line buffer, 50 keys typed and then 50 DEL, each at a median of 2 ms or less
    for the guard. Before each key the buffer's lex is brought up to date untimed, as redisplay does after every
    command, and its time logged apart: that incremental lex restarts at a bracket in column 0, so inside one large
    form it costs in proportion to the form, with or without the guard (about 3 to 4 ms per key inside a 10,000-line
    form on ex44), and is not this package's. The shapes: top-level forms, entries of a list in column 0, column-0
    lists inside those entries, a form left open, and inside one indented form: in an entry of a quoted list, between
    its entries, and in an indented `define` of an R7RS `define-library`. In `edwin-prog` the key medians were
    0.045, 0.036, 0.351, 0.510, 0.902, 0.870 and 1.013 ms, and DEL's 0.038, 0.035, 0.275, 0.479, 0.915, 0.878 and
    0.984 ms (ex44 under a load average near 30). The first version, which lexed
    the whole form twice per key, took 5.055 ms per key in an entry of the indented quoted list (a local `node
    --test` run of this suite on it), so that case fails the budget there.

  Of the second version's tests (5028688), 4 failed on the first version (0858893; both are squashed into this
  commit): the backslash test, the deletion test, the list motions and the budget. Also passed on the final code, in the same `nix build` (exit 0): `edwin-typecheck` and
  `edwin-structural` (188 passed, its 2 ms keystroke budget at a median of 0.102 ms). Then `nix flake check`, on the
  same code with this paragraph's last sentence not yet written: every check passed but `edwin-bench`, whose shadow
  stack overhead came out at 11.8% and then 14.5% (limit 10%) while another worktree's flake check loaded ex44; it
  times `src/scheme.ts` alone, which this package does not change, and passed at 7.9% built again at a lower load,
  after which `nix flake check --keep-going` exited 0.

## Incremental reparse (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lang-syntax-incremental`): edits fed to the tree, so that a
reparse costs what the edit touched, for the tree-sitter packages after it (highlighting, imenu, expand-region,
indentation). Nothing draws from the trees yet: lang-syntax-highlight is the first to ask for one.

- **`syntax::edit` and the native `synEdit(tree, pos, del, ins)`** (native/src/syntax.rs, natives.rs, typed in
  `src/core.d.ts`): the tree's kept text has DEL code units at POS replaced by INS; the tree is told of the edit
  (`Tree::edit` with its start, old end and new end in bytes and in points) and parsed again from itself, so
  tree-sitter reuses what the edit left alone. The tree keeps its number. It throws `synEdit: DEL deleted at POS
  goes past syntax tree N's text of LEN`, `synEdit: the position and the length deleted are string indices`
  (negative, a fraction, not a number), `synEdit: the text inserted is not a string` and `no syntax tree N`.
- **Points** are counted as tree-sitter counts a UTF-16 text: a row per line feed, a column in bytes (two a code
  unit). The start point is counted from the kept text (a scan to the edit), the ends from the start and the
  deleted or inserted text. The property test checks them against every node's own points in a whole parse.
- **Byte versus UTF-16 offsets** (the plan's risk) were settled by lang-syntax-native: offsets are JS string
  indices, bytes are twice them. What was left: a JS index can fall between the halves of a surrogate pair, and
  tree-sitter, decoding a lead half, reads the unit after it without counting it as looked at, so a token ending
  at such an edit was reused though its character changed (found by the property test, a YAML retyping of `𝔸`).
  An edit is widened to whole characters first, by the lead half before it and the trail half after it.
- **A reparse past its bound** (`PARSE_LIMIT`, 1 s) frees the tree and throws `parsing NAME took over 1000 ms;
  syntax tree N is freed`: a tree is never left out of step with its text. (Not exercised by a test: no text
  parses whole within the bound and reparses past it reliably.)
- **`src/syntax.ts`, `Ed.syntax.tree(b, grammar)`** (new, through the seven places of the touch list), the edit
  hook on the frame's side: B's tree with GRAMMAR, brought to B's version when asked. It reads the buffer's edit
  log, as the other caches do: `Ed.spanOf` joins every edit since the tree's version into one span, and only that
  span's text crosses (`host.syntax.edit`), not the buffer's. A whole parse instead when the log no longer reaches
  the tree's version (trimmed past it, or forgotten), when the grammar asked for differs, or when the edit throws.
  The trees of killed buffers are freed before the next whole parse (which is when the native side's limit of
  256 trees counts). `host.syntax` (parse, edit, free over the natives) is the desktop program's only
  (native/js/host-native.ts); in a web frame and in edwind `tree` gives null. Nothing of it is reachable from
  Scheme, and it starts no process and reads no file: a grammar is named, and the native side loads it from the
  program's own bundle.
- **Choices:** the edits are read from the log when a tree is asked for, not pushed on each change (the core's
  one `edited` hook belongs to org.ts and markdown.ts), so a run of keystrokes costs one reparse when the tree is
  next wanted; a run of edits crosses as one span, so a reparse is one `Tree::edit` and one parse; the edit and
  its reparse are one native call (no tree is kept edited but not reparsed); the changed ranges of a reparse are
  not returned (lang-syntax-highlight adds them if it needs them).
- **The keystroke budget, measured.** On 10,000 lines (ten-line functions repeated), the median of 50 keystrokes,
  best of three runs, on ex44 under load: Rust about 1.7 to 1.9 ms, C 0.6 ms, JavaScript 1.0 to 1.4 ms, Nix 0.1 to
  1.7 ms, against a whole parse of 20 to 77 ms; on 2026-11-17 at a load average near 3: Rust 0.52 to 0.56 ms, C
  0.24 to 0.26 ms, JavaScript 0.38 to 0.50 ms, Nix 0.03 to 0.44 ms, Python 1.0 to 1.9 ms, against a whole parse of
  19 to 31 ms. Tree-sitter reuses the top-level items but rebuilds the
  repetition holding them (its nodes are fragile: the repetition's reduction is ambiguous in the parse table), so
  a reparse's cost grows with the number of top-level items as well as with the edit. **Python does not keep the
  2 ms budget under load:** 2.4 to 9 ms against a 25 to 50 ms whole parse (its `def` cannot be reused where the indentation
  scanner's state counts, so a reparse re-reads most statements of the file). lang-syntax-highlight and the
  indent packages cannot put a Python reparse on the 2 ms path: they should draw from the last tree and reparse
  after the key.
- **Not in it:** highlighting, faces, queries from `Ed` (lang-syntax-highlight), the changed ranges, a tree for
  the region of an Org source block (lang-src-block-highlight), tree-sitter in web frames or edwind.
- **Checked by** `nix build .#edwin` on ex44 (the build's check sets `EDWIN_TEST_GRAMMARS` to the bundle: unit
  tests 30 passed and 1 ignored (the keystroke budget), 2 of them new, `tests/gui.rs` 5 passed and 1 ignored, `tests/terminal.rs` 35 passed), check
  `edwin-syntax` (new, 6 tests), `nix flake check` (exit 0; it builds `edwin-typecheck`, `edwin-headless`,
  `edit-lockdown` and `edit-security` among the rest, which pass with edwind's Node host loading src/syntax.ts,
  where it does nothing; run before the budget test was ignored, not run again after). The timings quoted above come from runs of the same cargo tests outside the package
  build (opt-level 3, `--nocapture`), since cargo hides a passing test's output in the build log. The new cargo
  tests:
  `syntax::tests::incremental_trees_equal_whole_parses_after_random_edits`, the plan's property: for Rust,
  Python, Bash, YAML, Nix, JSON, JavaScript and C, eight seeds of 60 random edits each (insertions, deletions and
  replacements of tokens, brackets, quotes, line breaks, `é`, `𝔸` and a lone surrogate half; a line deleted and
  retyped a code unit at a time), every edit through `syntax::edit` and compared node by node (kind, field,
  extent in bytes and points, named, error and missing) with a whole parse of the same text, then every edit
  undone the same way, back to the very tree of the source. The trees are equal whenever the whole parse has no
  error (35,600 comparisons gave the whole parse's tree). Where both hold an error the two may recover differently (tree-sitter's own corpus
  tests allow it); that happened only in Bash, 2 times in 4,300 there (120 in 35,000 with 64 seeds, run once), and
  the test bounds it to a tenth. `a_keystroke_in_10000_lines_reparses_within_its_budget`: the numbers above,
  2 ms and a tenth of a whole parse asserted for Rust, C, JavaScript and Nix at the first, middle and last ten
  lines, half a whole parse for Python; the tests that time a parse run one at a time. It is `#[ignore]`d, as
  `tests/gui.rs`'s latency budget is: a wall-clock bound in the package build would fail it on a loaded or slower
  builder. It runs on request and alone, as the package build with only that test (the command is in its doc
  comment: `cargoTestFlags = [ "--bins" ]`, `checkFlags = [ "--ignored" "--nocapture" "keystroke_in_10000_lines" ]`
  over `.#edwin`); its 2026-11-17 run passed with the numbers above. And
  `natives::tests::the_syntax_natives_from_javascript` gained `synEdit`: the edit at JS indices after `𝔸` moves
  the capture along, and its refusals.

## Highlighting from queries (done)

Asked 2026-11-17 (the Emacs-to-Edwin plan, package `lang-syntax-highlight`): the faces of a programming
language's buffer from its tree-sitter grammar's highlights query, through the H.lexSeg chain, with faces for
types, builtins and properties added.

- **`src/syntax.ts` adds a lexSeg** in front of the ones before it: a buffer whose major mode has a grammar of
  the bundle, in a frame whose host has tree-sitter, gets the classes of its shown lines from the grammar's
  `highlights` query run over its tree (`Ed.syntax.tree`, kept in step by the edit log) between the first and
  the last shown character. Only those lines are queried; a capture that overlaps them counts, so a window whose
  first line is inside a block comment or a string begun above it colours it. The classes are kept on the buffer
  (`b._sxl`) until its version or the shown lines change, as dired's are. Every other buffer, mode and frame goes
  to the lexSeg before it.
- **`host.syntax.query(tree, kind, start, end)`** (`src/core.d.ts`, `native/js/host-native.ts` over the
  `synQuery` native lang-syntax-native made). `Ed.syntax.grammarOf(mode)` names a mode's grammar.
- **The mode table** is in `src/syntax.ts` (`GRAMMARS`, the 22 modes scm/prog.scm declares), equal to the
  bundle's `grammars.json` (a test). A mode is looked up by its own name only: a mode derived from rust-mode is
  not highlighted unless it is added there.
- **Capture names to classes** by the longest dotted prefix named in `CLASS` (`function.method.call` is a
  function): keyword, conditional, repeat, markup.heading and punctuation.special (`${` `}`) `kw`; function and
  method `fn`; function.builtin, function.macro, function.special, variable.builtin and attribute `bi` (new);
  string, character and markup.raw `st`; escapes `co`; comment `cm`, comment.documentation `dc`; constant and
  boolean `co`; number `nu`; type, constructor, module, namespace and tag `ty` (new); property, field, label,
  variable.other.member and string.special.key `pr` (new); markup.heading.marker `pa`. variable, operator and
  embedded give no face but take their node (below); punctuation and delimiter (bracket, delimiter) give no face
  and take their node only when no other capture of it does, so Nix's interpolation `}`, captured
  `@punctuation.bracket` before `@punctuation.special`, is `kw` as its `${` is, while a brace captured only as
  punctuation (C#'s interpolation braces, YAML's `|`) still paints no face over the string around it; a name not
  in the table (spell, markup.bold) and one beginning with `_` (a predicate's) take nothing.
- **One capture a node.** Captures are sorted outer node first (by start, then the longer), so a node inside
  another paints over it (an escape in a string, an interpolation's text back to no face); of one node's
  captures (same extent) one wins, punctuation without a face last. Which one is the queries' own convention,
  settled by test: tree-sitter
  0.26's highlighter (`tree-sitter test` on tree-sitter-javascript and on probes for Go, Nix and Rust) lets the
  later pattern win, and scoring both rules against each grammar's own highlight tests with py-tree-sitter gave
  the later all of C (23), C++ (23), C# (892), Java (17) and Python (34) and 46 of 55 for JavaScript, against
  20, 16, 809, 8, 33 and 23 for the earlier, but Nix's own tests pass with the earlier (59 of 63 against 31): its
  generic `(identifier) @variable` comes last. Go's, JSON's, NASM's and Typst's are written the same way (a
  generic pattern after the specific ones: Go's every name, JSON's every key and NASM's every word would be a
  variable or a string), so those five grammars let the earlier pattern win (`EARLIER_WINS`), the rest the
  later. Two nodes of one extent (a node and its only child) count as one node.
- **TypeScript's and TSX's highlights** are composed JavaScript's first (TSX's then JSX's), their own last
  (`nix/grammars.nix`): in their `tree-sitter.json` order JavaScript's generic `(identifier) @variable` came after
  their own patterns and took JSX's tags.
- **Faces `ty`, `bi` and `pr`** (`src/display.ts` FACES and PALETTE, index.html's palettes and rules,
  test/display.test.mts's table): modus-themes' type (cyan-cooler, `#005f5f` and `#6ae4b9` dark), builtin
  (magenta-warmer, `#8f0075` and `#f78fe7`) and property (cyan, `#005e8b` and `#00d3d0`) colours, plain weight.
- **Bounds:** a buffer over 4 Mi characters is not highlighted (`MAX_CHARS`: a whole parse of it may reach
  tree-sitter's 1 s bound, and a redraw must not wait for it); nor are shown lines over 64 Ki characters
  (`MAX_SHOWN`, the text from the window's first shown character to its last, so in practice a minified file's
  one long line): the query, the sort of its captures and the fill cost a keystroke time in proportion to the
  shown text (review measured a 1 Mi-character line in js-mode at 121 ms a keystroke and redraw with a stand-in
  query against 26 ms without, 4 Mi at 554 against 140). A window whose shown text passes the bound (every
  window that shows such a line, as frames ask for the window's rows only) draws all its lines with the lexers
  before this one, its ordinary lines too, much as Emacs's so-long plains the buffer; a window of the same buffer
  that does not show the long line stays highlighted; a buffer whose tree or query fails (no grammar,
  256 trees, a parse past its bound) is not highlighted with that grammar again (switching its mode to another
  grammar's tries again).
- **The 2 ms budget, measured** (`natives::tests::a_key_in_10000_lines_redraws_its_faces_within_its_budget`):
  a keystroke in the first, middle or last ten lines of 10,000 and a redraw of the 60 lines around it with their
  faces, the median of 50, best of three, on ex44 at a load average of 10 to 21 (other builds), three runs: Rust
  0.77 to 0.91 ms, C 0.45 to 0.50, JavaScript 0.66 to 0.81, Nix 0.30 to 1.13, against a fresh buffer's first draw
  (its whole parse) of 20 to 36 ms. **Python does not keep it:** 1.2 to 1.4 ms in the first ten lines, 2.0 to
  2.5 ms in the middle and the last (its reparse, as lang-syntax-incremental found); the test holds Python to half a fresh
  buffer's first draw. A run at a load near 22 measured everything about twice as slow (Rust 2.5 ms), which is
  why the test is ignored in the package build. Opening a file draws after its whole parse: a 10,000-line file
  adds those 20 to 36 ms to the draw that shows it. The program's first draw (no file, or a Scheme or Org one,
  none of which is highlighted from a tree) was not measured again.
- **Choices where the plan left one open:**
  - the golden face runs are a cargo test in the package build (`nix build .#edwin`), not in check
    `edwin-syntax` as the plan says: only the desktop program has tree-sitter, and a check that built the program
    again for them would be a second V8 crate build on every flake check; `edwin-syntax` has the rules with a
    stand-in query and the frame's side of the budget;
  - the real budget test is `#[ignore]`d, as syntax.rs's and tests/gui.rs's wall-clock tests are;
  - the unit tests that run V8 (`natives::tests`) make every isolate on one thread of the test process, which
    sets V8 up first (`on_v8`), as main.rs sets it up and runs it on one thread: V8's platform takes a memory
    protection key (PKU) on the thread that sets it up, and only that thread and the threads it starts may read
    the memory the key guards, so an isolate made on another test thread died with SIGSEGV (`SEGV_PKUERR`, in
    `WasmCodePointerTable::AllocateUninitializedEntry` as the isolate was made) on processors with PKU, as ex44's
    are; `natives::tests::isolates_from_any_test_thread` asks for isolates from threads of its own, one after
    another and two at once;
  - the reparse stays on the keystroke's path (the tree is brought up to date when a window draws): drawing from
    the last tree and reparsing after the key was not built, Python's 2.0 to 2.5 ms in the middle and the last being the cost;
  - modes are looked up by their own name, not their parents';
  - of one node's captures the later pattern wins, the earlier for Go, Nix, JSON, NASM and Typst (above), and
    TypeScript's and TSX's composition changed in nix/grammars.nix, lang-grammar-bundle's file, to suit it;
  - a failure turns the highlighting off for the buffer without a message (a message from a redraw would draw
    again); a buffer over 4 Mi characters is not highlighted (`MAX_CHARS`).
- **Not in it:** web frames and edwind (no tree-sitter: their lexers as before; a Lisp buffer keeps the Scheme
  lexer, which comes before any lexSeg); the injections queries (a language inside another, e.g. a Just recipe's
  shell); the locals queries (a parameter coloured where it is used); `#set!` priorities; markup.bold and
  markup.italic (no face for them); Org source blocks (lang-src-block-highlight). Where a query's own patterns
  disagree with Emacs (TSX's `function Hi` is a constructor, `ty`, as any capitalised name; Go's `len` is a
  function, not a builtin; TOML's pair capture tints the blanks around `=`), the query is kept.
- **Checked by** check `edwin-syntax` (13 passed, 7 new: capture names to faces, which capture wins and
  nesting (with punctuation last), a segment inside a node begun above it, the cache, the fallbacks and the size
  bounds (the buffer's and the shown lines'), the mode table against the bundle's grammars.json, which the check
  now passes as `EDWIN_GRAMMARS`, and the frame's side of the 2 ms budget with a stand-in query, its median 0.19
  to 0.71 ms over the runs made, the most with a package build running beside it), check `edwin-display` (20
  passed: the faces mirror the stylesheet), check `edwin-grammars` (the reordered TypeScript and TSX queries
  compile; not rebuilt after review, as nothing it builds changed), check `edwin-typecheck`, and
  `nix build .#edwin` on ex44 of the final tree (3a01a14, run by the reviewer): passed whole, unit tests 32
  passed and 2 ignored (the two budget tests), `tests/gui.rs` 5 passed and 1 ignored, `tests/terminal.rs` 36
  passed. The unit test
  `natives::tests::the_core_highlights_each_language_as_its_golden_runs` boots the core as the startup snapshot
  holds it, on the real natives and the bundle, and draws each of `test/syntax-faces.txt`'s 22 fixtures with
  `Ed.renderBuffer`: its runs' classes equal the golden ones, each line drawn alone as in the whole, and after
  typed, deleted and restored lines the classes are a fresh buffer's of the same text. In a local
  `cargo test --release` build of the same sources, the unit binary's V8 tests (`natives::`) ran 5 times one test
  at a time and the whole binary 5 times in parallel without a fault (before the fix, 6 of 6 runs one test at a
  time died with SIGSEGV). The budget test
  `natives::tests::a_key_in_10000_lines_redraws_its_faces_within_its_budget` gave the numbers above, run by
  `cargo test --release -- --ignored` outside the package build (as syntax.rs's numbers were), not as the
  package build. The golden runs are a cargo test, not `edwin-syntax`'s: only the desktop program has
  tree-sitter. `nix flake check` on the final tree, rebased on emacs-to-edwin (2026-11-18): exit 0.

## Imenu from the tree (done)

Asked 2026-11-18 (the Emacs-to-Edwin plan, package `lang-syntax-imenu`): the definitions of a programming
language's buffer, for jumping to, from its tree-sitter tree.

- **`Ed.syntax.imenu(b)`** (`src/syntax.ts`) runs the grammar's `tags` query (tree-sitter's code-navigation
  captures, from the bundle) over the buffer's whole tree, kept in step by the edit log as highlighting's is. Each
  match's `@definition.KIND` is paired with that match's `@name`; an item is the name's text (blanks and newlines
  as one space), KIND (function, method, class, interface, module, macro, type, constant) and the earlier start
  of the two, in the order of the text. `@reference.*` and `@doc` captures are left out; so are the query's
  `#strip!` and `#select-adjacent!` directives (only the doc captures use them).
- **A name two patterns capture is listed once**, as the earlier pattern's: Rust's tags take a method by its
  `declaration_list` pattern and again as a function, and TypeScript's and TSX's tags are their own, then
  JavaScript's (`nix/grammars.nix`).
- **`consult-imenu`** (`M-g i`, `M-s i`, `SPC i`) lists these with their kind when the buffer has them
  (`imenuItems` in `src/editor-prims.ts` asks `Ed.syntax.imenu` first): the same prompt, live preview and jump
  as before. It lists its own patterns as before (Lisp definitions, Org headings, paragraphs) when there is no tree
  (a web frame, edwind), the mode has no grammar, the buffer is over highlighting's 4 Mi-character bound
  (`MAX_CHARS`), the grammar has no tags query, or the query fails (its 1 s bound). A grammar with a tags query
  and a buffer with no definitions gives no items ("No definitions found"), not the paragraph patterns. A failed
  tags query leaves the buffer's highlighting on. Markdown's `consult-imenu` (its headings) is unchanged.
- **Match ids from the native side.** The pairing needs to know which captures belong to one match: Nix's tags
  capture the binding's attrpath as `@name` beside, not inside, the function captured as the definition, and
  nested definitions of one pattern (a Python function in a function) make pairing by pattern and position
  ambiguous. So `synQuery` (`native/src/natives.rs`) takes a fifth argument, MATCHES: when true, the result
  also has `matches`, one number per capture (tree-sitter's match id, `Capture::id` in `native/src/syntax.rs`),
  the same for one match's captures. Highlighting does not ask, so its result and cost are unchanged.
  `host.syntax.query` (`native/js/host-native.ts`) and the types (`src/core.d.ts`) pass it through. This is why
  the package touches natives.rs, syntax.rs and host-native.ts, which the plan's Where did not list.
- **Languages:** the eleven grammars of the bundle with a tags query: Rust, Nix, Go, C, C++, Java, C#,
  Python, JavaScript, TypeScript and TSX. JSON, YAML, TOML, Bash, HCL, GDScript, Just, Meson, NASM, nginx and
  Typst have none, so their buffers keep the paragraph patterns. No tags queries were written for them.
- **Differences from Emacs** (its ts-modes' `treesit-simple-imenu`):
  - a flat list with kinds as annotations: no Class.method nesting and no submenus by category. A name defined
    twice is told apart by consult-imenu's `<N>` suffix, as before;
  - what is listed is what the upstream tags queries name. Nix lists only bindings of functions, so a module
    file shows little. C and C++ list a prototype as well as the definition. Java and TypeScript list interface
    method signatures, but Rust does not list a trait's. TypeScript lists neither type aliases nor namespaces,
    and Python's methods are functions;
  - the jump goes to the definition's start, or to the name's when the name comes first (Nix).
- **Choices where the plan left one open:**
  - the golden lists with the real grammars are a cargo test in the package build, as the golden faces are
    (only the desktop program has tree-sitter); check `edwin-syntax` has the rules with a stand-in tags query;
  - pairing by tree-sitter's match id, not by containment;
  - the whole buffer is queried each time consult-imenu runs, with no cache: it runs on a command, not a redraw.
- **Not in it:** imenu in web frames and edwind (no tree-sitter there); `which-func` and breadcrumbs; LSP
  document symbols (lsp-symbols); tags queries written for the grammars without one.
- **Checked by** check `edwin-syntax` (16 passed, 3 new): the stand-in's tags query paired by match (with its
  captures reversed too), a name two patterns take listed once, references and doc captures left out, a name over
  lines listed on one, an edit followed, a buffer with no definitions giving none; null with no host.syntax, a
  mode with no grammar, a grammar with no tags query or a failing one (highlighting still on after either), a
  buffer past 4 Mi characters and a host that gives no matches; and, booted, `M-g i` in a python-mode buffer
  jumping to the definition chosen, and in a scheme-mode buffer (no grammar) to a `define` by editor-prims'
  patterns. `nix build .#edwin` of the final tree: passed, unit tests 33 passed and 2 ignored, `tests/gui.rs` 5
  passed and 1 ignored, `tests/terminal.rs` 37 passed; the unit tests include
  `natives::tests::the_core_lists_each_languages_definitions_as_its_golden_imenu`. That test boots the core
  as the startup snapshot holds it, on the real natives and the bundle, and lists each of
  `test/syntax-imenu.txt`'s 11 fixtures (one per mode whose grammar has a tags query, every such mode and no
  other) as its golden KIND, NAME and line. `natives::tests::the_syntax_natives_from_javascript` checks
  synQuery's matches: one per capture, shared by a match's @name and @definition, and absent unless asked for.
  `nix flake check --keep-going` of the final tree (2026-11-18, load average up to 70 from other builds): every
  check passed except the timing tests of `edwin-prog` (the bracket guard's 2 ms budget, the glob property's
  time) and `edwin-bench`; each passed when rebuilt alone at a load near 4. Check `edwin-typecheck` passed.

## Expand region by the tree (done)

Asked 2026-11-18 (the Emacs-to-Edwin plan, package `lang-syntax-expreg`): the selection grows and shrinks along
the nodes of a programming buffer's tree-sitter tree.

- **`expreg-expand`** (`SPC v`, `scm/evil.scm`) in a buffer with a tree steps through the named nodes holding
  the selection, innermost first, out to the root, then the whole buffer: from `1` in `{ a = [ 1 2 ]; }` it
  selects `1`, then `[ 1 2 ]`, then `a = [ 1 2 ];`, then the attribute set. In Normal state the nodes are those
  holding the character at point; in Visual state, those holding the selection. The small-word step comes
  first only where the innermost node holds it (see the choices). In such a buffer the nodes take the place of the WORD, line and paragraph steps (see the choices). `expreg-contract`
  (`SPC V`) is unchanged: it gives back the selections before each expansion in turn, then leaves Visual state.
  The keys were already bound (`scm/init.scm`); none is added.
- **Where there is no tree** the steps are the ones expreg had: a web frame and edwind (no tree-sitter), a mode with
  no grammar in the bundle, a buffer past highlighting's 4 Mi-character bound (`MAX_CHARS`), a failed parse. The
  Lisp buffers keep their symbol, string and list steps (se-pair-objects); the bundle has no Lisp grammar.
- **`Ed.syntax.nodes(b, from, to)`** (`src/syntax.ts`) gives the extents of the nodes holding FROM..TO as
  `[start, end]` pairs, or null when there is no tree, from the same tree highlighting and imenu use, kept in step
  by the edit log. A failure gives null and leaves the buffer's highlighting alone. The Scheme primitive
  `syntax-node-bounds BEG END` (`src/evil-core.ts`) gives them to `expreg--candidates` as 1-based `(BEG END)` lists,
  or `#f`. It only reads the tree; nothing new reaches a process, a file or the network.
- **A native, `synNodes(tree, start, end)`** (`native/src/natives.rs`, over `syntax::nodes` and `syntax::holders`
  in `native/src/syntax.rs`): the bundle's queries cannot ask for every node around a point, so the tree is walked
  on the native side. It goes from the root down one child at a time, because tree-sitter finds a node's parent by
  starting again from the root. Anonymous nodes (brackets, keywords, operators) are passed through but not listed,
  and an extent is listed once (Python's `expression_statement` and the assignment inside it are one step). An empty
  range is held by the node it is inside, not by one that ends there. `host.syntax.nodes` (`native/js/host-native.ts`)
  and the types (`src/core.d.ts`) pass it through. This is why the package touches natives.rs, syntax.rs,
  host-native.ts and evil-core.ts, which the plan's Where did not list. `synQuery`'s argument check now names the
  native it is in, for synNodes's sake.
- **Choices where the plan left one open:**
  - With a tree, the line and paragraph steps are left out. A line cuts across nodes (`  a)` inside
    `foo(\n  a)`), and a step must hold the one before it, so a line step would hide the nodes larger than it that
    it is not inside: from `a`, `SPC v SPC v` selects `(\n  a)`, where before it took the line. Emacs's expreg mixes
    paragraphs and sentences in; Edwin's steps here are the word, the nodes and the buffer.
  - The WORD step is left out too where there are nodes: the leaf node (an identifier, a number, a string's text)
    is that step, and a WORD such as `a)` is not a node.
  - The small word is kept only where the innermost node holds it. A run of punctuation is one word, so from a
    closing bracket the word is `];` or `]);`, which cuts across nodes; taken first, it would hide every node not
    holding it: from `]` in `{ a = [ 1 2 ]; }` the list would be skipped for the binding. From a bracket the first
    step is the bracket's node.
  - Only named nodes. Emacs's expreg also gives a list's inside without its brackets; here a string's text is a
    step only where the grammar names it (Python's `string_content`), and a list's or an
    argument list's inside is not one.
- **Not in it:** expreg in Lisp buffers by tree (no grammar; their steps are se-pair-objects'), in web frames and
  edwind; subword and sentence steps; a node step through `i(`-style text objects (se-match-nonlisp's). The
  headless suites (`edwin-structural`) have no tree-sitter, so a case there such as `expreg-nix-list` sees the
  old steps (the line); the tree's steps are checked by `edwin-syntax`'s stand-in and the cargo test. No
  `desktop-only` stub in `scm/init.scm` covered expreg, so none is removed.
- **Checked by** check `edwin-syntax` (18 passed, 2 new): `Ed.syntax.nodes` with the stand-in's nodes (innermost
  first, a range over two nodes, a range past the text clamped, an edit crossing as an edit with one parse, null
  with no host.syntax, with no grammar, past 4 Mi characters with no parse, and from a host that throws, the
  buffer still highlighted); and, booted, `SPC v`, `SPC V` and `d` driven by keys: the audit's `expreg-nix-list`
  (`f1 SPC v SPC v d` on `{ a = [ 1 2 ]; }` gives `{ a = ; }`, where the audit's run had taken the line), a third
  step and a contract, growth from a Visual selection (`f[ v f2` and `f[ v f]`), growth from a closing bracket
  (`f] SPC v d` gives `{ a = ; }`, the list, not the word `];`; a second step the binding), a call over two lines grown to
  its arguments and then the call (no line step), and the steps expreg had with no tree (a host that throws, no
  host.syntax). Check `edwin-structural` (188 passed): the Lisp expreg cases unchanged. `nix build .#edwin`:
  unit tests 35 passed and 2 ignored, `tests/gui.rs` 5 passed and 1 ignored, `tests/terminal.rs` 37 passed. The
  unit tests include `syntax::tests::the_nodes_holding_a_range_innermost_first` (Nix's nodes from `1`, a range
  over two nodes, an empty range, past the end, the empty text, a freed tree), the synNodes lines of
  `natives::tests::the_syntax_natives_from_javascript` (indices of the JS string past a surrogate pair, an empty
  range, a negative start, a freed tree), and `natives::tests::expreg_grows_by_the_trees_nodes`, which boots the
  core and steps `(expreg-expand)` out from a point in Nix, Python (into a string: its text, then the string) and
  Rust with the real grammars, and from a closing bracket in Nix (`]`: the list) and Rust (`]` in `g(a[i]);`:
  the index expression, the arguments, the call, the statement), each step's selection compared, then `(expreg-contract)` back to the first and out
  of Visual state. Checks `edwin-typecheck`, `edwin-headless` (21) and `edwin-scheme` (38) passed. Rebased on `lsp-frame-docs`,
  `nix flake check` passed except the timing tests of `edwin-prog` (the bracket guard's 2 ms budget), `edwin-bench`
  and `edit-crash`; each passed when rebuilt alone at a load of 3 to 7.

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
  differed on runs (`gc` on `;;; Header` gave `; Header`) until se-comment ("One comment rule for gc and M-;")
  gave them one rule; in Org, `gc` and `M-;` on `#+TITLE` strip the `#`, as `gc` did before
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
