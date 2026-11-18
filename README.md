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
| `src/*.js` | the editor, in the order `index.html` loads it: `scheme` `runtime` `text` `editor-core` `editor-prims` `evil-core` `pool` `complete` `extras` `stack` `ai` `evil-ex` `org` `markdown` `dired` `brain` `proc` `vc` `vc-diff` `vc-git` `vc-jj` `compile` `ot` `sync` `display` |
| `scm/*.scm` | the shipped Scheme configuration (`emacs`, `evil`, `org`, `ai`, `init`, `prog` (prog-mode and `define-language`: each language's files, comments and indent), `next-error` (the error list: `M-g n`, `M-g p`, `:cn`, `:cp`, `:cc`; a producer such as compile adds to the list it owns), and `notes-syntax`, `address`, `markdown`, `babel` through `require`), fetched by `index.html` and the console from `scm/` |
| `index.html` | the page: styles and the script tags. It loads `src/*.js` and fetches `scm/*.scm` relative to itself, so serving this directory runs it, and a published copy keeps the `src/` and `scm/` paths |
| `src/host-browser.ts`, `src/host-node.cts` | the host layer (R4.1): storage, the shipped Scheme, page attributes, suspend, clipboard, scheduling. The core reaches the page only through it and through frame objects |
| `test/headless.mts` | loads and boots the editor in Node on `host-node.cts` (no page objects exist in the process) and drives it with keys |
| `test/headless.test.mts` | the headless suite: `node --test test/headless.test.mts`, or `nix build .#checks.x86_64-linux.edwin-headless` |
| `test/scheme.test.mts`, `test/scheme-editor.test.mts` | the Scheme suite: the language, and the editor-level forms (minor modes with their keymaps and their Evil state maps among them). `nix build .#checks.x86_64-linux.edwin-scheme` runs both and the benchmark |
| `test/prog.test.mts` | programming modes: `define-language` (`scm/prog.scm`), each declared file name opening in its mode with its indent and hooks, each mode's comment syntax (`set-comment-syntax!` in `scm/emacs.scm`) with `gc`, `gcc` and `M-;` using it, and ws-butler trimming on save only the lines that differ from the file (`buffer-changed-lines`, `delete-trailing-blanks`, `Rope.changedLines`) (`edwin-prog`) |
| `test/structural.test.mts` | structural editing in Lisp buffers, the fix track of the Emacs-to-Edwin plan: the audit's cases by id, the Lisp lexer (character literals, `[ ]`, `#;`) through `%`, the sexp motions, `=` and show-paren, the pair and quote text objects, `ds`, `cs` and expreg through the lexer with Visual `a(` growing and the buffer kept balanced, the Lisp indenter against Emacs 31's scheme-mode and emacs-lisp-mode (`test/fixtures/indent`, gg=G on every `scm/*.scm`), `gc`, `gcc` and `M-;` sharing one comment rule (`comment-toggle-lines`), `ys`, `ds`, `cs` and Visual `S` (counts, `.`, lines, inner blanks, `f`), Org `M-RET` on items and the last headline and the subtree commands' docstrings, the incremental lex against a whole one, the worker pool's lexer and the 2 ms keystroke budget (`edwin-structural`) |
| `nix/grammars.nix`, `test/grammars.py` | `edwin-grammars`: the tree-sitter grammar of each language `scm/prog.scm` declares (nixpkgs', Helix's for HCL and GDScript), a `parser.so` and its query files per language and `grammars.json` naming each one's mode, entry point and query kinds; the edwin package links it as `share/edwin/grammars`. Its check loads every grammar and compiles every query against it (`edwin-grammars`) |
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
| `native/` | `edwin`, the desktop program (DT1 to DT4, see below): a Rust crate with its own Cargo workspace that embeds V8 and these files; `native/js/` is its JavaScript (prelude, host, terminal, window, startup), `native/src/gui/` the window, `native/src/proc.rs` its child processes (argv only, for the core's TypeScript), `native/src/syntax.rs` tree-sitter (the bundle's grammars loaded by name, texts parsed as UTF-16, queries run, a tree edited and parsed again from itself; its cargo tests parse and query a fixture per grammar), `native/src/open.rs` its opener (`xdg-open`, after the checks of what it is handed), `native/tests/` its pseudo-terminal and virtual-display suites (`cargo test`) |
| `test/daemon.test.mts` | `edwin --daemon` from the package: it returns once the socket answers, two starts give one edwind, `--wait` (`edwin-daemon`); the command lines of `edwin-daemon` and `edwind` (refusals with status 2, `--help`, bare `edwind`) |
| `test/daemon-models.test.mts` | programs.edwin.daemon's settings, credentials, hub and path (`edwin-daemon-models`, whose module part also checks daemon.hub's hubSocket and daemon.path's PATH in the unit file): the module's fragment merged into the edwind.json `edwin-daemon` writes, and no form or frame request (load, include, require, a visit, a symlink, init.scm, the models' introspection) reaching a credential's bytes |
| `src/proc.ts`, `test/proc.test.mts`, `test/fake-proc.mts` | `Ed.proc`, child processes for the core's TypeScript (argv only; the desktop program's, never a web frame's or edwind's, and none while the image replays) and `Ed.proc.envFor`, the environment direnv exports for an allowed `.envrc` (asked as `direnv export json`, kept until the `.envrc` changes), its suite (with a stand-in direnv and the real one) and the stand-in `host.proc` other suites use (`edwin-proc`) |
| `test/open.test.mts` | `Ed.openUrl` (in `src/proc.ts`): a URL or a file in the desktop's application through the host, nothing while the image replays (`edwin-open`; the opener's own checks are `native/src/open.rs`'s cargo tests) |
| `src/vc.ts`, `test/vc.test.mts`, `test/vc-conflict.test.mts` | version control for git and jj: the commit message buffer (`Vc.message`, `vc-message-mode` in `scm/emacs.scm`: summary, overlong and second-line faces, comment lines, C-c C-c gives the message, C-c C-k aborts) and the runner every git and jj child goes through (`Vc.repo` finds the repository, jj first; `Vc.start` and `Vc.run` run only git and jj, hardened against the repository's own configuration, logged to `*vc-process*`); its suite with nixpkgs' git and jujutsu (`edwin-vc`); `vc-conflict-mode`, on in a visited file that holds git's or jj's conflict markers: `] n` and `[ n` (C-c ^ n, C-c ^ p) go to a conflict, C-c ^ u, C-c ^ l and C-c ^ a keep ours, theirs or both, nested and malformed markers refused; `test/vc-conflict.test.mts` comparing each resolution with git merge-file's and jj resolve's (`edwin-vc`) |
| `src/vc-diff.ts`, `test/vc-diff.test.mts` | diffs as files and hunks (`VcDiff.parse` over `git diff` and `jj diff --git`, with `VcDiff.gitArgs` against the user's diff configuration) and the partial patches staging applies (`VcDiff.patch`: files, hunks or lines picked, forwards to stage, reversed to unstage or discard); fast-check over real git in `edwin-vc` |
| `src/vc-git.ts`, `test/vc-git.test.mts`, `test/vc-commit.test.mts`, `test/vc-log.test.mts`, `test/vc-history.test.mts`, `test/vc-remote.test.mts`, `test/vc-sequencer.test.mts`, `test/vc-rebase.test.mts`, `test/vc-flow.test.mts`, `test/vc-blame.test.mts`, `test/vc-timemachine.test.mts`, `test/vc-todos.test.mts` | git's status buffer (`vc-status`, SPC g g, a jj workspace's log there; `git-status`, SPC g G, git's even in a colocated jj workspace): the head and its upstream, the untracked files, the conflicts, the unstaged and staged changes with their hunks, the stashes, the commits to pull and to push (or the recent ones), read with status, diff and log through the runner; TAB folds a section, a file's hunks or a hunk, `g r` reads it again keeping folds and point, C-j, C-k, `g j` and `g k` move between sections, RET visits the file at a hunk's line; s, u and x stage, unstage and discard (after asking) a file, a hunk, a whole part or the lines selected in Visual state, by name (add, reset, checkout, clean) or by a patch through `git apply`; c c, c a, c w and c f commit, amend, reword and fix up, the message written in vc-message-mode and given to `git commit -F -`; its suite over a fixture repository with every section, and `test/vc-stage.test.mts` comparing the index with the blob each action must leave, `test/vc-commit.test.mts` comparing the log after each commit; `l l` HEAD's log (`git-log`), read 256 commits a page in the background from the tip it opened on, `+` or RET on its last line the next page, and RET on a commit the revision buffer, its header, message and diff against the first parent by file and hunk, folded and stepped as the status buffer's; `test/vc-log.test.mts` paging a 1,000-commit fixture with the event loop measured; in the status and log buffers b b, b c, b n, b x and b m check out (a local branch, else detached), create, delete and rename branches, O s, O m and O h reset (hard after asking), z z, z i, z a, z p and z k stash, apply, pop and drop (a conflict or local changes in the way said with their files), t t and t x tag and delete a tag, on the commit or stash at point or one asked for; `test/vc-history.test.mts` comparing the refs, index and work tree after each; f u, f a, F u, p u and p f fetch (the upstream's remote, every remote), pull and push the current branch with its upstream (p u setting one), in the background with git's progress in `*vc-process*`, the force push asking first with an explicit lease, the transport's programs and credentials the user's alone; `test/vc-remote.test.mts` against local bare remotes and a loopback HTTP server; m m, A A, _ _, r e and r u merge, cherry-pick (the commits selected, one or a range asked for), revert and rebase (onto a revision or the upstream), the same key going on with its own operation in progress, A s, _ s and r s skipping its commit and m a, A a, _ a and r a aborting it (after asking), the operation in progress the status header's line and its steps left a `To rebase` section; `test/vc-sequencer.test.mts` taking each through a conflict to its end and to its abort; r i rebases interactively from the commit at point, the frame git's sequence editor and editor (`Vc.start`'s `edit`: git's frames on its output, the answers on its descriptor 3), the todo a text buffer in `git-rebase-todo-mode` (p, r, e, s, f and d set a commit line's action, M-k and M-j (M-p, M-n) move a step, Z Z or C-c C-c hands it to git, Z Q or C-c C-k aborts), a reword's or squash's message written in vc-message-mode; `test/vc-rebase.test.mts` reordering, squashing, rewording, stopping at an edit, dropping and aborting, and `test/vc-flow.test.mts`, phase 3's exit gate: a hunk staged and committed, an interactive rebase through a conflict resolved by vc-conflict-mode, then jj describe and squash in the same repository colocated; SPC g b (`git-blame`) blames the file the buffer visits beside it, `git blame --porcelain` of the file (of the buffer's text when it has changes not saved) read in the background into `*git-blame: PATH*` (`git-blame-mode`), a line for each of the file's with its commit's short hash, author and day, RET showing the commit in the revision buffer, `g r` blaming again; `test/vc-blame.test.mts` on a fixture history of three authors in three time zones (`edwin-vc`); SPC g t (`git-timemachine`) shows the file's committed revisions (`git log --follow`, each read with `git cat-file blob`) one at a time in `*git-timemachine: PATH*`, in the file's mode with `git-timemachine-mode` on, `p` and `n` (C-k and C-j) stepping to the older and newer one in the background with point kept on its line and column, `q` leaving; `test/vc-timemachine.test.mts` on a fixture file of four revisions renamed in the third (`edwin-vc`); the status buffer's last section, `TODOs (N)`, the `TODO:` and `FIXME:` lines of the tracked files read by one `git grep` each time the status is read, RET visiting one; `test/vc-todos.test.mts` on a fixture under a repository configuration that would change git grep's output or run a program (`edwin-vc`) |
| `src/vc-jj.ts`, `test/vc-jj.test.mts`, `test/vc-jj-ops.test.mts`, `test/vc-jj-rewrite.test.mts`, `test/vc-jj-remote.test.mts` | jj's log (`jj-log`, SPC g J, and SPC g g in a jj workspace): a change per line, node, change id, commit id, bookmarks, tags, states, description, author and date, read by `jj log --no-graph` with Edwin's template, every field a JSON value, never from the graph text; `+` or RET on the last line reads 256 more, `g r` reads it again; RET on a change shows it in `*jj-change: NAME*`, its header, description and diff (`jj diff --git`) by file and hunk, folded, stepped and visited as git's revision buffer is (VcView, shared with src/vc-git.ts), followed by its change id on `g r`; ids given back to jj only inside `commit_id()` and `change_id()`; o, c, e, x and s on the change at point (or the one the change view shows) run jj new, describe, edit, abandon (after asking) and squash into the parent, a description written in vc-message-mode and given on standard input, a squash of two descriptions as one `--message=`, the log and view read again after each; r on a change marks it as a rebase's source and r on another rebases it with its descendants there (`jj rebase --source --onto`), S in the change view splits the file at point or the files selected off the change (`jj split` with `root-file:` filesets, the description written first), u undoes jj's last operation after naming it (after an undo, the earlier one jj undo goes back over; a snapshot of the working copy said as such), C-r redoes; f f and f a fetch (`jj git fetch`), p p pushes the bookmarks on the change at point, p c the change under a bookmark jj names, p d the deletions, in the background, a backwards or sideways move or a deletion on the remote asked first; b c, b s, b r, b d, b f, b t and b u create, set, rename, delete, forget, track and untrack a bookmark, every name given to jj quoted (`exact:` where it takes a pattern), the git jj starts for the transport given the runner's settings in its environment (`test/vc-jj-remote.test.mts`, against local bare remotes); its suites on fixture workspaces under a user jj config that reshapes jj's own log, and the operations' and rewrites' results read back with jj's own template, the graph after a rebase, its undo and its redo among them (`edwin-vc`) |
| `src/compile.ts`, `test/compile.test.mts` | `compile`: a shell command run in the project through `Ed.proc`, its output streamed into `*compilation*` with a status line on exit, `recompile` (`g r`) and `kill-compilation` (`C-c C-k`), and the places errors name in its output (rustc, tsc, gcc, nix, python) fed to next-error as they come; `grep` (`M-s g`): rg in the buffer's directory into `*grep*`, its rows the error list, and `*grep*` edited and written back (`grep-edit-mode`, `C-c C-p`, `C-c C-c` writes each changed row to its file unless the file changed since the search); the shell commands (`M-!`, `M-&`, `M-\|`, `:!`; `test/shell-command.test.mts`); its suite on `test/fake-proc.mts`, the tool logs in `test/fixtures/compile` and the tree in `test/fixtures/grep` (`edwin-compile`, with ripgrep) |
| `test/grep-edit.test.mts` | editing `*grep*` with a real rg over a throwaway tree: rows of three files written back, and the refusals (a file changed since the search, a drifted line, a visiting buffer with unsaved changes, a changed prefix or added lines) with nothing of a refused file written (`edit-grep`) |
| `test/shell-command.test.mts` | the shell commands in `src/compile.ts` (`M-!`, `M-&`, `M-\|`, `:!`, `:{range}!`) and the `!` operator in `src/evil-ex.ts`: output in the echo area or `*Shell Command Output*`, `*Async Shell Command*`, `sort` over a region, a failing filter leaving the text as it was, C-g killing the child, and the refusals (the image's replay, a web frame, no `host.proc`) (`edwin-shell-command`) |
| `src/lsp-rpc.ts`, `test/lsp-rpc.test.mts` | `LspRpc`, JSON-RPC as language servers speak it: Content-Length framing counted in UTF-8 bytes over the string chunks a child's output comes in (a header past 4096 bytes, a body past 64 MiB and a broken length refused, the connection closed), requests by id, error answers, cancellation and timeouts sending `$/cancelRequest`, the server's requests and notifications; no process of its own (the language client runs the server through `Ed.proc`); fast-check over random chunkings and a stand-in server as a real child (`edwin-lsp`) |
| `src/syntax.ts`, `test/syntax.test.mts` | `Ed.syntax`, a buffer's syntax tree kept in step with its text: the edits since the tree's version, joined by the edit log into one span, cross to the desktop program's tree-sitter (`host.syntax`), which parses again from the old tree; a whole parse only when the log cannot say what changed; null with no `host.syntax` (a web frame, edwind); fast-check over edits, undo and forgotten logs with a stand-in `host.syntax` (`edwin-syntax`) |
| `src/editorconfig.ts`, `test/editorconfig.test.mts` | EditorConfig: a visited file's `.editorconfig` files, read through the store from its directory up to the one with `root = true`, setting its buffer's `indent-tabs-mode`, `tab-width` and `evil-shift-width`, `fill-column`, `require-final-newline` and its trimming on save (`trim_trailing_whitespace`), again after a major mode switch; `editorconfig-properties`; globs matched by a table, not a regexp, so a hostile pattern costs its length times the path's; its suite runs the glob, parser, properties and filetree cases of editorconfig-core-c's own tests (`edwin-prog`) |
| `src/format.ts`, `test/format.test.mts` | `format-buffer` (`SPC b f`): the buffer's text through its mode's formatter (`define-formatter` in `scm/prog.scm`: alejandra, rustfmt, gofmt, black, clang-format, shfmt) run through `Ed.proc` in the file's directory with its direnv environment, the output applied as a line diff (`Ed.applyLineDiff`; past its budget of 1000 changed lines, point and the markers keep their line number and column instead of their line); nothing changes when the formatter fails, and a declaration while the image replays is skipped; `format-on-save-mode`, on for the languages in `format-on-save-modes` (none by default), formats before a save typed by the user (`SPC f s`, `C-x C-s`, `:w`, `:wq`, `:x`, `ZZ`, `:wa`), through `Ed.hooks.formatOnSave` in `Ed.callInteractively` (`edwin-format`, with alejandra, black and shfmt) |
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
