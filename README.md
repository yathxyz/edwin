# Edwin

Edwin is an Emacs-like editor with Evil keys and Org, scripted in its own Scheme. It runs in a terminal, in a
window and in a web page. **edwind**, its text daemon, is one Node service that owns every text buffer on the
host; `edwin` and the frames of a web page attach to it, as `emacsclient` frames attach to `emacs --daemon`.
Workbench is one such page: its page cards are Edwin frames.

The design and the decisions are in the doc "Edwin as Workbench's text daemon" (decided 2026-10-12): edwind
replaces the notes index and `sample` of M5 (M5-W1, M5-W2), pages are files in `notesDir`, markdown-mode comes
first, undo undoes your own edits, and the runtime is Node.

Until 2026-10-19 this repository was the `edwin/` directory of [Workbench](https://github.com/yathxyz/workbench),
which now takes it as its flake input `edwin` (its history came along). Two suites compare Edwin with Workbench and
live there: the board's block addresses against `scm/address.scm` (`edit-address`, Workbench's
`tests/address.test.mts`) and `MAX_LINE` against wb-proto's (wb-cli's tests). Workbench's flake check runs this
repository's checks too.

```sh
nix build .#edwin           # bin/edwin (terminal, -g window), bin/edwin-daemon, bin/edwind
nix build .#edwin-web       # the frame runtime a page serves: index.html, manifest.json, src/*.js, scm/*.scm
nix flake check -L          # the suites below, the type check (edwin-typecheck) and programs.edwin
(cd tools && npm ci)        # without nix: typescript, @types/node and fast-check for tsc and the OT suite
```

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
- The unit sets `NODE_COMPILE_CACHE` (`CacheDirectory=workbench-edit`), so only the first start after a deploy
  pays for stripping (about 240 ms).

The core (`src/*.ts`) and desktop Edwin's JavaScript (`native/js/*.ts`) are TypeScript too, checked by
`tsc -p src` and `tsc -p native/js`. They are classic scripts (no `import` or `export`) that share
globals; the types they hand each other are in `src/core.d.ts`. The browser, Node's `vm` and V8 run the `NAME.js`
that `tools/strip.mts` makes beside each `NAME.ts`, so a page, desktop Edwin's build (`build.rs` refuses a missing or
stale `.js`) and the nix packages all strip first. In a checkout:

    node tools/strip.mts --in-place src native/js

`host-node.cts` loads a `.js` only when it is at least as new as its `.ts`, and strips the `.ts` itself otherwise,
so edwind and the suites need no step. `src/host-node.cts` is checked with the server (`tsc -p .`).

## Layout

| Path | What |
| --- | --- |
| `src/*.js` | the editor, in the order `index.html` loads it: `scheme` `runtime` `text` `editor-core` `editor-prims` `evil-core` `pool` `complete` `extras` `stack` `ai` `evil-ex` `org` `markdown` `ot` `sync` `display` |
| `scm/*.scm` | the shipped Scheme configuration (`emacs`, `evil`, `org`, `ai`, `init`, and `notes-syntax`, `address`, `markdown`, `babel` through `require`), fetched by `index.html` and the console from `scm/` |
| `index.html` | the page: styles and the script tags. It loads `src/*.js` and fetches `scm/*.scm` relative to itself, so serving this directory runs it, and a published copy keeps the `src/` and `scm/` paths |
| `src/host-browser.ts`, `src/host-node.cts` | the host layer (R4.1): storage, the shipped Scheme, page attributes, suspend, clipboard, scheduling. The core reaches the page only through it and through frame objects |
| `test/headless.mts` | loads and boots the editor in Node on `host-node.cts` (no page objects exist in the process) and drives it with keys |
| `test/headless.test.mts` | the headless suite: `node --test test/headless.test.mts`, or `nix build .#checks.x86_64-linux.edwin-headless` |
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

These files came from the published Edwin artifact (version 1791768765, 2026-10-12). From now on this directory is
the source.

## Edwin without Workbench

Since 2026-10-19 Edwin is its own repository, and Workbench depends on it, never the reverse. Edwin is the Emacs
replacement: it grows the features an Emacs user expects and loads no extensions. Workbench uses it as an
edit.sock client.
- **No default hub.** edwind connects to a hub only when edit.json names `hubSocket`. With none, as under
  `edwin --daemon`, it dials nothing, and process primitives raise `hub-error` (code `unconfigured`) at once.
- **The §5 session API is gone**: `wb.mts`, `scm/wb.scm` (sessions, cards, `acp-prompt`, `shell-run`, the `wb-*`
  hooks, feature `wb-hub`), board watching, and `:card` on processes. Nothing in Workbench or here called it.
  `boardsDir` was ignored with a warning for one release; since Workbench's module stopped writing it, edwind
  refuses it like any unknown field.
- **The hub protocol is Edwin's**: `docs/hub-protocol.md` specifies what edwind speaks to a hub (version 1, the
  messages edwind already used). Workbench's wb-hub serves it unchanged; `test/fake-hub.mts` is a reference
  server, without the ACP messages it served for the session API.
- **Task rows carry `fields`**: every `key::` field (and Org property) of a task, by its lowercased key, in
  `notes-tasks`, `notes-task` and the reply of `notes-task-set`. The rows no longer single out `session`,
  `dispatched` and `target`, which only Workbench's dispatch gives a meaning.
- **`sample` takes `caller`**: the label of the request in the usage log (`[a-z0-9-]`, 1 to 32), `web` when the
  message names none. It was always `board`.
- **Edwin's own defaults**: `socket` defaults to `$XDG_RUNTIME_DIR/edwin/edit.sock` (where `edwin --daemon`
  listens; required when that is unset) and `stateDir` to `~/.local/state/edwin/edwind`, no longer Workbench's
  paths. The default backend is named `anthropic`, like the `models.anthropic` it comes from (it was
  `workbench`). The build id comes from `EDWIND_BUILD`. A CLI writer is labelled by its session alone. `edwin`
  no longer falls back to Workbench's socket, and `--remote` must name the socket (`HOST:/PATH`).
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
  `stateDir/pi/NAME.json` (0600). gptel's commands stay as they were, one-shot, on the same model layer.

## Build steps

What each step built (E0-E4, DT0-DT4, Hypernotes H1) and the choices it made where the spec left one open or
had to deviate are in [docs/steps.md](docs/steps.md).
