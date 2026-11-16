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

## Layout

| Path | What |
| --- | --- |
| `src/*.js` | the editor, in the order `index.html` loads it: `scheme` `runtime` `text` `editor-core` `editor-prims` `evil-core` `pool` `complete` `extras` `stack` `ai` `evil-ex` `org` `markdown` `dired` `brain` `proc` `vc` `vc-diff` `vc-git` `compile` `ot` `sync` `display` |
| `scm/*.scm` | the shipped Scheme configuration (`emacs`, `evil`, `org`, `ai`, `init`, `prog` (prog-mode and `define-language`: each language's files, comments and indent), `next-error` (the error list: `M-g n`, `M-g p`, `:cn`, `:cp`, `:cc`; a producer such as compile adds to the list it owns), and `notes-syntax`, `address`, `markdown`, `babel` through `require`), fetched by `index.html` and the console from `scm/` |
| `index.html` | the page: styles and the script tags. It loads `src/*.js` and fetches `scm/*.scm` relative to itself, so serving this directory runs it, and a published copy keeps the `src/` and `scm/` paths |
| `src/host-browser.ts`, `src/host-node.cts` | the host layer (R4.1): storage, the shipped Scheme, page attributes, suspend, clipboard, scheduling. The core reaches the page only through it and through frame objects |
| `test/headless.mts` | loads and boots the editor in Node on `host-node.cts` (no page objects exist in the process) and drives it with keys |
| `test/headless.test.mts` | the headless suite: `node --test test/headless.test.mts`, or `nix build .#checks.x86_64-linux.edwin-headless` |
| `test/scheme.test.mts`, `test/scheme-editor.test.mts` | the Scheme suite: the language, and the editor-level forms (minor modes with their keymaps and their Evil state maps among them). `nix build .#checks.x86_64-linux.edwin-scheme` runs both and the benchmark |
| `test/prog.test.mts` | programming modes: `define-language` (`scm/prog.scm`), each declared file name opening in its mode with its indent and hooks, and each mode's comment syntax (`set-comment-syntax!` in `scm/emacs.scm`) with `gc`, `gcc` and `M-;` using it (`edwin-prog`) |
| `test/next-error.test.mts` | the error list (`scm/next-error.scm`): a list seeded across files stepped through by `M-g n`, `M-g p`, `:cn`, `:cp` and `:cc`, its ends and refusals, clamping, and a visit that waits for edwind (`edwin-next-error`) |
| `test/scheme-bench.mts` | evaluator benchmarks; fails when the shadow stack costs more than 10% (R4.34) |
| `src/ot.ts` | the OT library (ops, transform, rebase, undo, markers, hash) shared by edwind and its clients (E1) |
| `server/*.mts` | edwind, the text daemon (E1; see "Step E1" below) |
| `test/ot.test.mts`, `test/ot-sim.mts` | the OT properties with fast-check (`edwin-ot`; needs `NODE_PATH` at `tools/node_modules`) |
| `test/linediff.test.mts` | the line diff (`Rope.diffLines` in `src/text.ts`) and `Ed.applyLineDiff` with fast-check: the diff of A gives B, markers on unchanged lines stay (`edwin-linediff`; needs `NODE_PATH` as `edwin-ot`) |
| `test/autorevert.test.mts` | auto-revert and save supersession on the desktop program's files: another program's write reaches an unmodified buffer with point kept, a modified one's save asks, a --private session and the temporary directory are never looked at (`edwin-autorevert`) |
| `test/fs.test.mts`, `test/dired.test.mts`, `test/dired-local.test.mts` | directories: edwind's fs-* commands and their refusals, dired and find-file over edwind and over the desktop program's own files, whose listings follow their directories (`edit-dired`) |
| `test/conformance.test.mts`, `test/crash.test.mts`, `test/disk.test.mts`, `test/edit-client.mts` | the edwind gate suites (`edit-conformance`, `edit-crash`, `edit-disk`) and their client |
| `src/display.ts`, `test/display.test.mts` | the display seam (DT0, see below): frames with no page, drawn on a cell grid for a terminal or native backend, the one theme setting every frame shows, and the jump pulse as a line face (`edwin-display`) |
| `native/` | `edwin`, the desktop program (DT1 to DT4, see below): a Rust crate with its own Cargo workspace that embeds V8 and these files; `native/js/` is its JavaScript (prelude, host, terminal, window, startup), `native/src/gui/` the window, `native/src/proc.rs` its child processes (argv only, for the core's TypeScript), `native/src/open.rs` its opener (`xdg-open`, after the checks of what it is handed), `native/tests/` its pseudo-terminal and virtual-display suites (`cargo test`) |
| `test/daemon.test.mts` | `edwin --daemon` from the package: it returns once the socket answers, two starts give one edwind, `--wait` (`edwin-daemon`); the command lines of `edwin-daemon` and `edwind` (refusals with status 2, `--help`, bare `edwind`) |
| `test/daemon-models.test.mts` | programs.edwin.daemon's settings, credentials, hub and path (`edwin-daemon-models`, whose module part also checks daemon.hub's hubSocket and daemon.path's PATH in the unit file): the module's fragment merged into the edwind.json `edwin-daemon` writes, and no form or frame request (load, include, require, a visit, a symlink, init.scm, the models' introspection) reaching a credential's bytes |
| `src/proc.ts`, `test/proc.test.mts`, `test/fake-proc.mts` | `Ed.proc`, child processes for the core's TypeScript (argv only; the desktop program's, never a web frame's or edwind's, and none while the image replays) and `Ed.proc.envFor`, the environment direnv exports for an allowed `.envrc` (asked as `direnv export json`, kept until the `.envrc` changes), its suite (with a stand-in direnv and the real one) and the stand-in `host.proc` other suites use (`edwin-proc`) |
| `test/open.test.mts` | `Ed.openUrl` (in `src/proc.ts`): a URL or a file in the desktop's application through the host, nothing while the image replays (`edwin-open`; the opener's own checks are `native/src/open.rs`'s cargo tests) |
| `src/vc.ts`, `test/vc.test.mts` | version control for git and jj: the commit message buffer (`Vc.message`, `vc-message-mode` in `scm/emacs.scm`: summary, overlong and second-line faces, comment lines, C-c C-c gives the message, C-c C-k aborts) and the runner every git and jj child goes through (`Vc.repo` finds the repository, jj first; `Vc.start` and `Vc.run` run only git and jj, hardened against the repository's own configuration, logged to `*vc-process*`); its suite with nixpkgs' git and jujutsu (`edwin-vc`) |
| `src/vc-diff.ts`, `test/vc-diff.test.mts` | diffs as files and hunks (`VcDiff.parse` over `git diff` and `jj diff --git`, with `VcDiff.gitArgs` against the user's diff configuration) and the partial patches staging applies (`VcDiff.patch`: files, hunks or lines picked, forwards to stage, reversed to unstage or discard); fast-check over real git in `edwin-vc` |
| `src/vc-git.ts`, `test/vc-git.test.mts` | git's status buffer (`vc-status`, SPC g g; `git-status`, SPC g G, git's even in a colocated jj workspace): the head and its upstream, the untracked files, the conflicts, the unstaged and staged changes with their hunks, the stashes, the commits to pull and to push (or the recent ones), read with status, diff and log through the runner; TAB folds a section, a file's hunks or a hunk, `g r` reads it again keeping folds and point, C-j, C-k, `g j` and `g k` move between sections, RET visits the file at a hunk's line; its suite over a fixture repository with every section (`edwin-vc`) |
| `src/compile.ts`, `test/compile.test.mts` | `compile`: a shell command run in the project through `Ed.proc`, its output streamed into `*compilation*` with a status line on exit, `recompile` (`g r`) and `kill-compilation` (`C-c C-k`), and the places errors name in its output (rustc, tsc, gcc, nix, python) fed to next-error as they come; `grep` (`M-s g`): rg in the buffer's directory into `*grep*`, its rows the error list, and `*grep*` edited and written back (`grep-edit-mode`, `C-c C-p`, `C-c C-c` writes each changed row to its file unless the file changed since the search); the shell commands (`M-!`, `M-&`, `M-\|`, `:!`; `test/shell-command.test.mts`); its suite on `test/fake-proc.mts`, the tool logs in `test/fixtures/compile` and the tree in `test/fixtures/grep` (`edwin-compile`, with ripgrep) |
| `test/grep-edit.test.mts` | editing `*grep*` with a real rg over a throwaway tree: rows of three files written back, and the refusals (a file changed since the search, a drifted line, a visiting buffer with unsaved changes, a changed prefix or added lines) with nothing of a refused file written (`edit-grep`) |
| `test/shell-command.test.mts` | the shell commands in `src/compile.ts` (`M-!`, `M-&`, `M-\|`, `:!`, `:{range}!`) and the `!` operator in `src/evil-ex.ts`: output in the echo area or `*Shell Command Output*`, `*Async Shell Command*`, `sort` over a region, a failing filter leaving the text as it was, C-g killing the child, and the refusals (the image's replay, a web frame, no `host.proc`) (`edwin-shell-command`) |
| `test/models.test.mts` | the model layer against a real edwind and a loopback backend (`edit-security`): credentials, http-request, backends, sample, gptel, usage, and the backends an init.scm declares, which edwind loads after its modules |
| `test/term.test.mts`, `test/native.test.mts` | the terminal encoder and decoder (with the colour-scheme reports a terminal frame follows), and the core's seams for the program: files on a disk, exit statuses, input events (`edwin-native`) |
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
