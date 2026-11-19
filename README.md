# Edwin

Edwin is an Emacs-like editor with Evil keys and Org, scripted in its own Scheme. It runs in a terminal, in a
window and in a web page. **edwind**, its text daemon, is one Node service that owns every text buffer on the
host; `edwinclient` and the frames of a web page attach to it, as `emacsclient` frames attach to
`emacs --daemon`, while `edwin` is the editor on its own, as `emacs` is. Workbench is one such page: its page
cards are Edwin frames.

The design and the decisions are in the doc "Edwin as Workbench's text daemon" (decided 2026-10-12): edwind
replaces the notes index and `sample` of M5 (M5-W1, M5-W2), pages are files in `notesDir`, markdown-mode comes
first, undo undoes your own edits, and the runtime is Node.

Until 2026-10-19 this repository was the `edwin/` directory of [Workbench](https://github.com/yathxyz/workbench),
which now takes it as its flake input `edwin` (its history came along). Two suites compare Edwin with Workbench and
live there: the board's block addresses against `scm/address.scm` (`edit-address`, Workbench's
`tests/address.test.mts`) and `MAX_LINE` against wb-proto's (wb-cli's tests). Workbench's flake check runs this
repository's checks too.

```sh
nix build .#edwin           # bin/edwin (terminal, -g window), bin/edwinclient, bin/edwin-daemon, bin/edwind
nix build .#edwin-web       # the frame runtime a page serves: index.html, manifest.json, src/*.js, scm/*.scm
nix flake check -L          # the suites below, the type check (edwin-typecheck) and programs.edwin
(cd tools && npm ci)        # without nix: typescript, @types/node and fast-check for tsc and the OT suite
```

See [performance measurements](docs/performance.md) for the private text, redisplay, startup and replication benchmarks, baseline distributions and trade-offs.

## TypeScript

edwind (`server/*.mts`) and the suites (`test/*.mts`) are TypeScript that Node 24 runs as it is: Node strips
the types at load, and `tsc -p .` (flake check `edwin-typecheck`, `--strict`) checks them. The rules that keep
that working:
- **Erasable syntax only** (`erasableSyntaxOnly`): no `enum`, `namespace`, parameter properties or `import =`.
  Stripping then leaves every line and column where it was, so stack traces and `defAt` locations match the source.
- **Class fields are `declare`d** (`declare x: T;`). A plain `x: T;` defines the field at construction and changes
  behaviour.
- **Relative imports name the `.mts` file** (`allowImportingTsExtensions`); type-only imports use `import type`.
- **`any` is marked**: every one carries `// any: <reason>`. Most are the aliases in `main.mts` (`Ed`, `Lisp`,
  `EdBuffer`, `SchemeValue`) for the core in `src`, which the server loads through `vm` and so sees untyped.
- The unit sets `NODE_COMPILE_CACHE` (`CacheDirectory=edwind`), so only the first start after a deploy
  pays for stripping (about 240 ms).

The core (`src/*.ts`) and desktop Edwin's JavaScript (`native/js/*.ts`) are TypeScript too, checked by
`tsc -p src` and `tsc -p native/js`. They are classic scripts (no `import` or `export`) that share
globals; the types they hand each other are in `src/core.d.ts`. The browser, Node's `vm` and V8 run the `NAME.js`
that `tools/strip.mts` makes beside each `NAME.ts`, so a page, desktop Edwin's build (`build.rs` refuses a missing or
stale `.js`) and the nix packages all strip first. In a checkout:

    node tools/strip.mts --in-place src native/js

`host-node.cts` loads a `.js` only when it is at least as new as its `.ts`, and strips the `.ts` itself otherwise,
so edwind and the suites need no step. `src/host-node.cts` is checked with the server (`tsc -p .`).

## Host-supplied folds

`Ed.setBufferFolds(buffer, ranges)` replaces the closed folds in every window on that buffer, including
read-only buffers. For example, on `"Tool\noutput\nNext\n"`, `[{s: 4, e: 11}]` leaves `Tool` and `Next`
visible. Both offsets count UTF-16 code units from zero and must point to actual newline characters.
Pass a plain array of plain `{s, e}` objects, ordered and disjoint (`s < e`, then `e < next.s`).
Invalid ranges throw without replacing the previous folds. Getters or proxies that edit the buffer or
call the setter during a read are unsupported: the setter never publishes a malformed list, but it
cannot undo those side effects. `[]` clears the folds. If there are neither closed folds nor owner
targets, `[]` does nothing: it preserves the outline cycle and does not queue a draw. The setter neither
selects the buffer nor edits it. Point, mark and selection stay at their text offsets, even if hidden;
subsequent navigation uses the usual fold rules.

`Ed.getBufferFolds(buffer)` returns a detached list of the currently closed `{s, e}` ranges, including
folds made by the mode (which can also end at EOF). Immediately after a successful setter, that list is
exactly the supplied offsets in order. In Org and Markdown, fold-all closes the owner ranges and adds
disjoint outline folds; an overlapping outline fold does not replace an owner range. Normal-state `za`
toggles a supplied fold without requiring a heading; an explicit mode binding still takes precedence.
`zo` and `zO` open a closed owner fold directly. With the owner target open, they use the outline
command at point, even if a native fold has exactly the owner's offsets. Direct owner toggles and
undo redraw on the next frame without waiting for a pending keyboard command to finish.
With owner ranges, a keyboard fold command may draw the same state twice: once from the input loop
and once from the queued draw. Buffers without owner ranges draw as before.

An edit, including undo or a remote edit, forgets the supplied ranges, open or closed. After appending
text, reinstall the full list inside the same `Ed.runCallback` as the append. It renders in `finally`:
wrapping only the append can show one unfolded frame. Without `Ed.runCallback`, keep both calls in
the same task with no synchronous render between them. Mode-created folds follow the mode's usual edit rules.

Org highlighting looks back at most 65,536 UTF-16 code units from the start of a window. If an owner
fold hides a block opener and more than that much text after it, a window starting beyond the fold
can highlight the following lines differently from one starting at the heading. Folding does not
build a block index.

## Layout

| Path | What |
| --- | --- |
| `src/*.js` | the editor, in the order `index.html` loads it: `scheme` `runtime` `text` `editor-core` `editor-prims` `evil-core` `pool` `complete` `extras` `stack` `ai` `evil-ex` `org` `markdown` `dired` `brain` `agent-sessions` `agent-transcript` `agent-prompts` `ot` `sync` `display` |
| `scm/*.scm` | the shipped Scheme configuration (`emacs`, `evil`, `org`, `ai`, `init`, and `notes-syntax`, `address`, `markdown`, `babel` through `require`), fetched by `index.html` and the console from `scm/` |
| `index.html` | the page: styles and the script tags. It loads `src/*.js` and fetches `scm/*.scm` relative to itself, so serving this directory runs it, and a published copy keeps the `src/` and `scm/` paths |
| `src/host-browser.ts`, `src/host-node.cts` | the host layer (R4.1): storage, the shipped Scheme, page attributes, suspend, clipboard, scheduling. The core reaches the page only through it and through frame objects |
| `test/headless.mts` | loads and boots the editor in Node on `host-node.cts` (no page objects exist in the process) and drives it with keys |
| `test/headless.test.mts` | the headless suite: `node --test test/headless.test.mts`, or `nix build .#checks.x86_64-linux.edwin-headless` |
| `test/standalone.test.mts`, `test/row-offsets.test.mts` | boot the standalone page, edit `*scratch*`, and hit-test rendered text in private headless Chromium. `nix build .#checks.x86_64-linux.edwin-standalone` supplies DejaVu locally; external fonts are blocked. |
| `test/scheme.test.mts`, `test/scheme-editor.test.mts` | the Scheme suite: the language, and the editor-level forms. `nix build .#checks.x86_64-linux.edwin-scheme` runs both and the benchmark |
| `test/scheme-bench.mts` | evaluator benchmarks; fails when the shadow stack costs more than 10% (R4.34) |
| `src/ot.ts` | the OT library (ops, transform, rebase, undo, markers, hash) shared by edwind and its clients (E1) |
| `server/*.mts` | edwind, the text daemon (E1; see "Step E1" below) |
| `test/ot.test.mts`, `test/ot-sim.mts` | the OT properties with fast-check (`edwin-ot`; needs `NODE_PATH` at `tools/node_modules`) |
| `test/conformance.test.mts`, `test/crash.test.mts`, `test/disk.test.mts`, `test/edit-client.mts` | the edwind gate suites (`edit-conformance`, `edit-crash`, `edit-disk`) and their client |
| `src/display.ts`, `test/display.test.mts` | the display seam (DT0, see below): frames with no page, drawn on a cell grid for a terminal or native backend (`edwin-display`) |
| `native/` | `edwin`, the desktop program (DT1 to DT4, see below): a Rust crate with its own Cargo workspace that embeds V8 and these files; `native/js/` is its JavaScript (prelude, host, terminal, window, startup), `native/src/gui/` the window, `native/tests/` its pseudo-terminal and virtual-display suites (`cargo test`) |
| `test/term.test.mts`, `test/native.test.mts` | the terminal encoder and decoder, and the core's seams for the program: files on a disk, exit statuses, input events (`edwin-native`) |
| `docs/hub-protocol.md` | the protocol edwind speaks to a hub, the process server that runs its PTYs (R4.45) |
| `console/manifest.json` | what a page that hosts frames loads, in order: `files` (the scripts) and `scm` (the Scheme sources), with `api` 1; `edwin-web` ships it as `manifest.json` |
| `server/agent-sessions.mts`, `src/agent-sessions.ts` | daemon-owned mesh agent sessions (`agentHub: {url, tokenFile}`); `M-x agent-sessions`, Step AS1 |

These files came from the published Edwin artifact (version 1791768765, 2026-10-12). From now on this directory is
the source.

## Edwin without Workbench

Since 2026-10-19 Edwin is its own repository, and Workbench depends on it, never the reverse. Edwin is the Emacs
replacement: it grows the features an Emacs user expects and loads no extensions. Workbench uses it as an
edit.sock client.
- **No default hub.** edwind connects to a process hub only when edit.json names `hubSocket`. With none, as under
  `edwin --daemon`, it dials no process hub, and process primitives raise `hub-error` (code `unconfigured`) at once.
- **The §5 session API is gone**: `wb.mts`, `scm/wb.scm` (sessions, cards, `acp-prompt`, `shell-run`, the `wb-*`
  hooks, feature `wb-hub`), board watching, and `:card` on processes. Nothing in Workbench or here called it.
  `boardsDir` was ignored with a warning for one release; since Workbench's module stopped writing it, edwind
  refuses it like any unknown field.
- **The hub protocol is Edwin's**: `docs/hub-protocol.md` specifies what edwind speaks to a hub (version 1, the
  messages edwind already used). Workbench's wb-hub serves it unchanged; `test/fake-hub.mts` is a reference
  server, without the ACP messages it served for the session API.
- **Agent sessions** (Step AS1): `agentHub: {"url":"https://host-a:PORT","tokenFile":"/private/api-token"}`
  in edit.json configures the session API. Never put token contents in init. `M-x agent-sessions` opens the
  live shared list; RET opens a read-only, structurally folded journal. `p` composes an ordinary durable
  Markdown draft (`C-c C-p` preview, `C-c C-k` leave retaining it). By default clients can read sessions
  and write and keep drafts, but cannot send them. With `agentHub.steer: true`, **every client admitted to
  the daemon can steer**. Admission already permits editing the user's files through the daemon.
  **Keep steering off until the hub atomically checks both the request version and the session incarnation
  when accepting an answer.** Edwin checks what the user saw before sending; the hub does not verify that
  the question is still the same when it accepts the answer.
  `C-c C-c` then sends a draft and `C-c a !` answers permissions/elicitations. Resource attachments,
  named reuse and several destinations are `agent-prompt-*` commands. Drafts live under stateDir/agent-prompts.
  Only configured prompt-store writers take the exclusive lock. Without `agentHub`, startup, recovery
  and live export use the ordinary editor paths; nothing reserves `stateDir/agent-prompts/`.
  With `agentHub`, startup refuses `storage.json` if it aliases the credential or config file. If an ordinary
  backing directory loses search permission, recovery uses the checked local journal and snapshot, not the backing file.
  The stock NixOS units do not configure `agentHub`. If you supply an agent-enabled `edit.json` to a
  systemd service, set `RestartPreventExitStatus=73` on that service to stop retrying when another writer owns the store.
  `agent-session-open SID` returns `name:*Agent: SID*`, which any attached frame/card can show through
  `Ed.sync.open(id)` and `Ed.setWindowBuffer(buffer)`. The HTTP API does not restore the removed §5 socket API.
  For HTTP outside loopback, explicitly set `allowCleartext: true` **only on an encrypted private network**.
  For a read-only live check, run `node tools/agent-live.mts [--allow-cleartext] URL TOKEN_FILE [SID]` from this checkout
  (Node 24). Without SID it prints the session list; with SID it prints replay metrics, first/last
  60 frame-visible lines with default/all-open folds, host control state and truncation notices.
  It uses temporary state, loads no user init, installs no agent mutation commands and permits GET only.
  All-open lines are cut to 200 Unicode characters; errors exit nonzero without dumping headers.
- **Task rows carry `fields`**: every `key::` field (and Org property) of a task, by its lowercased key, in
  `notes-tasks`, `notes-task` and the reply of `notes-task-set`. The rows no longer single out `session`,
  `dispatched` and `target`, which only Workbench's dispatch gives a meaning.
- **`sample` takes `caller`**: the label of the request in the usage log (`[a-z0-9-]`, 1 to 32), `web` when the
  message names none. It was always `board`.
- **Edwin's own defaults**: `socket` defaults to `$XDG_RUNTIME_DIR/edwin/edit.sock` (where `edwin --daemon`
  listens; required when that is unset) and `stateDir` to `~/.local/state/edwin/edwind`, no longer Workbench's
  paths. The default backend is named `anthropic`, like the `models.anthropic` it comes from (it was
  `workbench`). The build id comes from `EDWIND_BUILD`. A CLI writer is labelled by its session alone. The
  desktop client (`edwinclient` since 2026-11-13) no longer falls back to Workbench's socket, and `--remote` must
  name the socket (`HOST:/PATH`).
- **`edwin-web` ships `manifest.json`**: the runtime's scripts and Scheme sources in load order, with `api` 1,
  so a page that hosts frames reads the list from the runtime it serves instead of keeping its own copy.
  `api` changes only when a page has to load the runtime differently.
- **The model layer speaks through pi-ai** (`@earendil-works/pi-ai`, pinned in `server/package.json`, packaged as
  `nix/edwind-deps.nix`): the `anthropic` kind is its `anthropic-messages` API and `openai` its
  `openai-completions`. Edwin keeps backends, tiers, the gate, the deadline, the retry, the tool loop, usage and
  the credential rules (R14.4–R14.7): pi-ai gets a placeholder for the key and Edwin's own `fetch`, which posts
  to the backend's URL only and puts the key in on the credential's origin. Requests now carry pi-ai's shape
  (prompt-cache marks, adaptive thinking when an effort is given). `:stream nil` no longer changes anything:
  pi-ai always streams. Iterator and generator prototypes keep only `next` read-only under the lockdown, since
  the openai SDK assigns `return` on an async generator.
- **pi agents in chat notes** (`server/agent.mts`, `scm/pi.scm`, `scm/pi-tools.scm`): `M-x pi` visits
  `pi/chat.md`; any markdown note is a chat, its session named after the buffer. C-c RET (`pi-send`) sends the text
  after the last `## You`; a pi-agent-core agent runs the loop on edwind's model layer and its text, tool calls and
  questions stream into the note as the writer `pi:<session>`. Tools are Scheme (`define-pi-tool`): `list_buffers`,
  `read_buffer`, `edit_buffer` and `eval_scheme` (both ask first: C-c RET allows, C-c C-k denies), `grep_notes`.
  `pi-steer` adds to a running agent, `pi-abort` stops it, `pi-model` changes backend and tier mid-session (pi-ai
  converts the conversation, tool calls included), `pi-forget` drops it. Sessions are saved in
  `stateDir/pi/NAME.json` (0600). gptel's commands stay as they were, one-shot, on the same model layer; they are
  in `scm/gptel.scm`, which a served frame loads, so `SPC g j`, `C-c i` and Org's C-c RET run them in edwind.
- **Image generations and safe mode** (`server/image.mts`): Edwin's image is the shipped Scheme (read-only, in the
  package) plus `init.scm` plus the image log replayed on top, so a snapshot is a copy of `image.jsonl`, not a heap
  dump. `stateDir/generations/` holds the copies (`<id>.jsonl`, `index.jsonl`); one is made at every start that
  replayed cleanly, before compaction, revert, reset and rollback, and by `M-x image-checkpoint`. Equal logs share
  a copy; the newest 32 are kept (`EDWIND_IMAGE_GENERATIONS`). `M-x image-generations` lists them, `image-rollback`
  puts one back (the log before it becomes a generation too) and restarts edwind, `image-restart` restarts it alone:
  edwind exits with 75 and the service manager (`Restart=on-failure`) starts it again; the journals keep unsaved
  text. Two starts in a row that end before settling (30 s up, or a clean stop) make the next start safe mode: no
  `init.scm`, no replay, frames get a `safe-` epoch and a message; `EDWIND_SAFE=1` forces it. The epoch line keeps a
  generation floor, so entry numbers never repeat after a rollback. Entries record the build they were made in.
- **pi agents on the image** (`scm/pi-tools.scm`): `apropos`, `describe` (documentation, location, image entries,
  shipped source), `read_source` (the shipped tree only, `%edwin-source`), `image_log`, `image_define` (asks; evaluates
  definitional forms and logs them as `pi:<session>` through `%image-record`, so they persist and reach frames),
  `image_checkpoint`, `image_generations` and `image_rollback` (asks; no restart, which stays the user's).
  `eval_scheme` stays the exploratory tool: what it defines is the server's only and gone at the next start.

## Build steps

What each step built (E0-E4, DT0-DT4, edwin and edwinclient, Hypernotes H1) and the choices it made where the
spec left one open or had to deviate are in [docs/steps.md](docs/steps.md).
