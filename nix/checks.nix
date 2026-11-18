# `nix flake check`: Edwin's headless core and Scheme, the evaluator budgets, the OT properties, the type check, the
# edwind gate suites against a real edwind, and the programs.edwin module.
{
  pkgs,
  self,
}:
let
  inherit (pkgs) lib;
  # The repository as it holds it: no in-tree build of the desktop program (native/target), and no .js stripped
  # beside the core's .ts in a checkout (tools/strip.mts --in-place; gitignored).
  sources = lib.fileset.difference (lib.fileset.unions [
    ../src
    ../scm
    ../server
    ../test
    ../native
    ../index.html
    ../console
    ../tsconfig.json
  ]) (
    lib.fileset.unions [
      (lib.fileset.maybeMissing ../native/target)
      (lib.fileset.maybeMissing ../server/node_modules)
      (lib.fileset.fileFilter (f: f.hasExt "js") ../src)
      (lib.fileset.fileFilter (f: f.hasExt "js") ../native/js)
    ]
  );
  # The core and native/js run as classic scripts, which vm cannot strip: the suites get each .ts with its
  # .js beside it, as edwind's package has them (host-node.cts would otherwise strip them in every process).
  # The tree sits in a directory named edwin, as in the package's share/edwin: the debugger names a source
  # file by its path from there (debug.mts defSource).
  edwin = pkgs.runCommand "edwin-tree" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    mkdir $out
    cp -r ${
      lib.fileset.toSource {
        root = ../.;
        fileset = sources;
      }
    } $out/edwin && chmod -R u+w $out
    node ${../tools/strip.mts} --in-place $out/edwin/src $out/edwin/native/js
    ln -s ${edwindDeps}/node_modules $out/edwin/server/node_modules
  '';
  # pi-ai for the model layer, as edwind's package links it (nix/edwind-deps.nix).
  edwindDeps = pkgs.callPackage ./edwind-deps.nix { };
  # fast-check for the OT properties and the TypeScript tools: dev dependencies pinned in
  # tools/package-lock.json (R15.1), installed from the lock with no scripts.
  devDeps = pkgs.stdenv.mkDerivation {
    pname = "edwin-dev-deps";
    version = (lib.importJSON ../tools/package.json).version;
    src = lib.fileset.toSource {
      root = ../tools;
      fileset = lib.fileset.unions [
        ../tools/package.json
        ../tools/package-lock.json
      ];
    };
    npmDeps = pkgs.importNpmLock {
      package = lib.importJSON ../tools/package.json;
      packageLock = lib.importJSON ../tools/package-lock.json;
    };
    npmFlags = [ "--ignore-scripts" ];
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.importNpmLock.npmConfigHook
    ];
    dontBuild = true;
    installPhase = ''
      mkdir -p $out
      cp -r node_modules $out/
    '';
  };
  # A suite run in the stripped tree: `node --test` over FILES, with a writable HOME for the edwind ones.
  suite = suiteWith [ ];
  # The same, with TOOLS on PATH as well.
  suiteWith =
    tools: name: files:
    pkgs.runCommand "edwin-${name}" { nativeBuildInputs = [ pkgs.nodejs ] ++ tools; } ''
      export HOME=$TMPDIR
      node --test ${lib.concatMapStringsSep " " (f: "${edwin}/edwin/test/${f}") files}
      touch $out
    '';
in
{
  # Edwin's editing core in Node with no browser and no page stand-ins (step E0 of the edwind plan).
  edwin-headless = suite "headless" [ "headless.test.mts" ];

  # Edwin's Scheme: the language (R4.3-R4.10, R4.31-R4.34), the editor-level forms (hooks, advice,
  # minor modes and their Evil keys, buffer-locals, markers) and the shadow-stack cost bound (R4.34, at most 10%).
  edwin-scheme = suite "scheme" [ "scheme*.test.mts" ];

  # The evaluator budgets (E2 gate): the shadow stack at most 10% (R4.34) and generator mode at most 3x direct
  # (R4.38, measured 1.2x). The bench recurses 1,000 deep in both modes, so it needs more stack than Node's default.
  edwin-bench = pkgs.runCommand "edwin-bench" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --stack-size=6900 ${edwin}/edwin/test/scheme-bench.mts
    touch $out
  '';

  # The worker pool's Node host (E2): jobs on worker_threads, the main-thread fallback, cancellation.
  edwin-pool = suite "pool" [ "pool.test.mts" ];

  # The OT properties (R16.1–R16.4): fast-check over random sessions, plus the undo properties and the
  # wire checks (R7.7, R7.8, R7.14, R6.16, R6.17). OT_RUNS raises the run count; the check uses the default.
  edwin-ot = pkgs.runCommand "edwin-ot" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export NODE_PATH=${devDeps}/node_modules
    node --test ${edwin}/edwin/test/ot.test.mts
    touch $out
  '';

  # The line diff (Rope.diffLines) and Ed.applyLineDiff: fast-check over random texts, applying the diff of A
  # gives B and the markers on unchanged lines stay on them. LINEDIFF_RUNS raises the run count.
  edwin-linediff = pkgs.runCommand "edwin-linediff" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR NODE_PATH=${devDeps}/node_modules
    node --test ${edwin}/edwin/test/linediff.test.mts
    touch $out
  '';

  # Auto-revert and save supersession (src/editor-prims.ts) on the desktop program's own files: another
  # program's write reaches an unmodified buffer with point kept, a modified one is left and its save asks, and a
  # --private session, the temporary directory and edwind's buffers are never looked at. The stamp's native is
  # tested by the package's cargo tests.
  edwin-autorevert = suite "autorevert" [ "autorevert.test.mts" ];

  # tsc --strict over the TypeScript: edwind and its suites (tsconfig.json), the core (src) and desktop Edwin's
  # JavaScript (native/js). Node and tools/strip.mts only strip the types; this checks them.
  edwin-typecheck = pkgs.runCommand "edwin-typecheck" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    cp -r ${
      lib.fileset.toSource {
        root = ../.;
        fileset = sources;
      }
    } src && chmod -R u+w src && cd src
    mkdir tools && ln -s ${devDeps}/node_modules tools/node_modules
    ln -s ${edwindDeps}/node_modules server/node_modules
    for p in . src native/js; do node tools/node_modules/typescript/bin/tsc -p $p; done
    touch $out
  '';

  # The intrinsics lockdown every thread of edwind runs in place of --frozen-intrinsics (R14.11, R16.16).
  edit-lockdown = suite "lockdown" [ "lockdown.test.mts" ];

  # A real edwind in a temp directory, under bin/edwind's Node flags, over every §7 message and error code,
  # the limits, chunking, resend, replay, the E1 server commands and the socket checks (R14.3, R16.12, R16.16, R16.17).
  edit-conformance = suite "conformance" [ "conformance.test.mts" ];

  # SIGKILL at 1,000 random points under a three-client load, a journal torn at every byte offset, and a
  # full disk during save and journal append (R16.5–R16.7). About thirteen minutes.
  edit-crash = suite "crash" [ "crash.test.mts" ];

  # External writes, the three-way merge, the conflict and deleted marks, CRLF, atomic save (R8.12–R8.15).
  edit-disk = suite "disk" [ "disk.test.mts" ];

  # Shared anchors (R9.12) and the frame's small server commands (E3): the after-marker rule through every writer,
  # relocation after a disk revert, survival across restart and compaction, user-init, capf-candidates, sel.
  edit-anchors = suite "anchors" [ "anchors.test.mts" ];

  # The E2 gates of the edwind spec (§17.1): the image log and its replication (edit-image), the notes index,
  # its grammar and the /api shapes (edit-notes).
  edit-image = suite "image" [
    "image.test.mts"
    "generations.test.mts"
  ];
  edit-notes = suite "notes" [ "notes.test.mts" ];

  # markdown-mode (E3, §10.1, R10.1-R10.5): the parity table's commands, faces, overlays, folding, the keyword
  # table shared with Org, journal-today, and the incremental font-lock budget (a keystroke in 10,000 lines
  # re-fontifies in 2 ms), in the headless runtime.
  edwin-markdown = suite "markdown" [ "markdown.test.mts" ];

  # Programming modes in the headless runtime: define-language (scm/prog.scm), each declared file name selecting its
  # mode, with its indent and hooks on a visit; each mode's comment syntax (set-comment-syntax!, found through the
  # modes it derives from, nearest first) and gc, gcc and M-; using it; ws-butler: a save trims the trailing blanks of
  # the lines that differ from the file only, so untouched dirty lines survive it. EditorConfig (src/editorconfig.ts):
  # the glob, parser, properties and filetree cases of the core library's own test suite, from editorconfig-core-c's
  # source, and a visited file's .editorconfig setting its buffer's indent, fill column, final newline and trimming.
  # Balanced brackets in Lisp buffers (src/extras.ts): typing, Replace state, DEL, C-d and RET keep them balanced, a
  # bracket deleting its list, a quote its string, C-d on a closing one from inside moving to the start; an edit that
  # would unbalance them refused; a property test of random keys at random points of random balanced text in Insert,
  # Emacs and Replace state, and one of the guard's soundness, every edit it accepts at every point of such text
  # leaving the whole text balanced; the list motions (C-M-d C-M-n C-M-p C-M-a C-M-e C-M-t, up-list), the audit's
  # cases for all of them, and the 2 ms keystroke budget in a 10,000-line buffer.
  edwin-prog = pkgs.runCommand "edwin-prog" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR EDITORCONFIG_CORE_TESTS=${pkgs.editorconfig-core-c.src}/tests
    node --test ${edwin}/edwin/test/prog.test.mts ${edwin}/edwin/test/editorconfig.test.mts
    touch $out
  '';

  # format-buffer (src/format.ts) and define-formatter (scm/prog.scm) in the headless runtime, host.proc stood in by
  # test/fake-proc.mts: real alejandra, black and shfmt format their buffers in place as a line diff, point and the mark
  # staying on their lines, one undo step; shfmt given the file's absolute name and reading its directory's
  # .editorconfig; a failing formatter (alejandra on broken Nix, a non-zero exit, no output, non-UTF-8, a signal, past
  # 16 MiB, not on PATH), a buffer changed or killed meanwhile, and C-g on a hung one leave text, point and the
  # modified flag as they were; a formatter only on the direnv PATH found; nothing starts while the image replays
  # (where a declaration is skipped), in a web frame or with no host.proc. format-on-save-mode, off unless a language is in
  # format-on-save-modes: SPC f s, C-x C-s, :w, :wq, ZZ and :wa save alejandra's output, one run per buffer; a failing
  # formatter leaves the text and the save goes on; C-g quits the save; a save from code, :w FILE, a replay, a web frame
  # and no host.proc format nothing.
  edwin-format = suiteWith [ pkgs.alejandra pkgs.python3Packages.black pkgs.shfmt ] "format" [ "format.test.mts" ];

  # Structural editing in Lisp buffers, the fix track of the Emacs-to-Edwin plan, each case of the audit by its id:
  # the lexer's character literals (#\( #\" #\;), [ ] as brackets and #; over the next datum, through %, C-M-f/b/u,
  # = and show-paren; the pair and quote text objects (i( a( i" ...), ds, cs and expreg reading the lexer, Visual a(
  # growing, no operator leaving a balanced buffer unbalanced; the Visual-block case operators; the incremental lex
  # against a whole one after random edits, the worker pool's lexer against the main thread's, gg=G on scm/evil.scm
  # moving no line for its character literals, and the 2 ms keystroke budget; the Lisp indenter as Emacs 31's
  # scheme-mode and emacs-lisp-mode indent (Scheme if, a body on the head line, vectors, use-package and the def*
  # forms), against Emacs's output in test/fixtures/indent, and gg=G on every scm/*.scm changing only the forms listed;
  # gc, gcc and M-; sharing one comment rule in each mode's syntax, any run of a repeated opener a comment; ys, ds,
  # cs and Visual S: counts, . repeating ys, lines wrapped on lines of their own, the blanks inside, and f; Org M-RET
  # leaving point on the new item and no blank line after the last headline, and the subtree commands' docstrings.
  edwin-structural = suite "structural" [ "structural.test.mts" ];

  # The tree-sitter grammar bundle (nix/grammars.nix, test/grammars.py): one grammar for each mode scm/prog.scm
  # declares; each library loads with py-tree-sitter, exports its symbol and has an ABI version tree-sitter
  # accepts, and each query file the manifest lists is there, has patterns and compiles against its grammar.
  edwin-grammars =
    pkgs.runCommand "edwin-grammars-check"
      { nativeBuildInputs = [ (pkgs.python3.withPackages (ps: [ ps.tree-sitter ])) ]; }
      ''
        python3 -W error ${../test/grammars.py} ${
          self.packages.${pkgs.stdenv.hostPlatform.system}.edwin-grammars
        } ${../scm/prog.scm}
        touch $out
      '';

  # The error list (scm/next-error.scm) in the headless runtime: a list seeded across files stepped through with
  # M-g n, M-g p, :cn, :cp and :cc; its ends and refusals, clamping, columns in the unit the producer counts in (characters, display cells, UTF-16), and a visit that waits for edwind.
  edwin-next-error = suite "next-error" [ "next-error.test.mts" ];

  # The display seam (DT0 of desktop Edwin): model frames laid out on a cell grid for a backend that is not a page,
  # and the face and palette tables checked against index.html's, markdown-mode's and Org's stylesheets; one theme
  # setting (load-theme) reaching the terminal's, the window's and the page's frames; the jump pulse drawn as a
  # face in both kinds of model frame and cleared again.
  edwin-display = suite "display" [ "display.test.mts" ];

  # The desktop program's JavaScript (DT1): the terminal encoder and decoder (native/js/term.ts, with the
  # colour-scheme reports, mode 2031, that a terminal frame follows), and the core's seams it uses (files on a disk, leaving with an exit status, input events). The program itself is
  # tested in a pseudo-terminal by native/tests (cargo test).
  edwin-native = suite "native" [
    "term.test.mts"
    "native.test.mts"
  ];

  # Ed.proc (src/proc.ts): child processes for the core's TypeScript in a served frame against a real edwind, with
  # the desktop program's host.proc stood in by test/fake-proc.mts (coreutils from the build's PATH): run's output
  # and status, spawn, and the refusals in a web frame, with no host.proc and while the image replays (R16.15);
  # envFor with a stand-in direnv (an allowed .envrc's PATH reaching a child and compile, kept until the .envrc
  # changes, a blocked one said and the plain environment used, no direnv on PATH, the loading note, the timeout,
  # C-g killing a slow direnv through M-!, a failing .envrc's own output never shown) and with the real one, whose
  # blocked .envrc does not run.
  edwin-proc = suiteWith [ pkgs.direnv ] "proc" [ "proc.test.mts" ];

  # compile (src/compile.ts) in the headless runtime, with host.proc stood in by test/fake-proc.mts: output
  # streamed into *compilation*, the status line on exit, recompile with the same command and directory,
  # kill-compilation, the line cap, and no compilation in a web frame, with no host.proc or while the image replays;
  # the error places in each tool's log (test/fixtures/compile) fed to next-error as they come, and the parse budget;
  # grep (M-s g) with a real rg over test/fixtures/grep into *grep*, its rows the error list, and rg missing from PATH.
  edwin-compile = suiteWith [ pkgs.ripgrep ] "compile" [ "compile.test.mts" ];

  # Editing *grep* (src/compile.ts, grep-edit-mode) with a real rg over a throwaway tree: changed rows of three
  # files written back, a file changed since the search refused with nothing of it written, a drifted line, a
  # visiting buffer with unsaved changes, added lines refused, a changed prefix refusing its file, a :%s over the
  # whole buffer (the command line put back), Emacs keys, one true-name map per write, mixed line ends and a byte
  # order mark, --vimgrep rows of one line.
  edit-grep = suiteWith [ pkgs.ripgrep ] "grep-edit" [ "grep-edit.test.mts" ];

  # The shell commands (src/compile.ts; the ! operator in src/evil-ex.ts) with host.proc stood in by
  # test/fake-proc.mts: M-! in the echo area or *Shell Command Output*, C-u M-! at point, M-& into *Async Shell
  # Command*, sort over a region with C-u M-|, :{range}! and the ! operator; a failing, cut or non-UTF-8 filter and
  # a buffer changed meanwhile leave the text as it was; C-g kills the child; nothing starts while the image
  # replays, in a web frame or with no host.proc.
  edwin-shell-command = suite "shell-command" [ "shell-command.test.mts" ];

  # The language client: src/lsp-rpc.ts, JSON-RPC's Content-Length framing under fast-check, any chunking of a
  # random message stream decoding as the whole does and a broken one failing at the same place; the framing's
  # refusals (a header past 4096 bytes, a body past 64 MiB, a bad, missing or doubled length, one ending inside a
  # character); requests by id, error answers, cancellation and timeouts sending $/cancelRequest, the server's
  # requests answered; and a stand-in server as a real child through Ed.proc (test/fake-proc.mts). LSPRPC_RUNS
  # raises the run count. src/lsp.ts and scm/lsp.scm, the sessions: start and initialize, one process per root
  # and server, a crash started again with a doubling delay and given up past its bound, the KILL past the
  # shutdown bounds, the idle stop, the refusals (the image's replay, a web frame, a file not on this machine),
  # no child left; against a scripted stand-in server and nil, a real Nix language server (EDWIN_LSP_REAL).
  # test/lsp-docs.test.mts, the documents: fast-check's random edits under incremental and whole-text sync, the
  # stand-in server's own copy (UTF-16 positions, \n, \r\n and a lone \r) equal to the buffer after each run; known
  # ranges; didOpen, didChange, didSave and didClose through eglot-mode, visiting, write-file, a major mode, a kill
  # and a crash; the sync kinds; nil finding a definition after edits. LSP_DOC_RUNS raises the run count.
  # test/lsp-xref.test.mts, cross references: g d, g r and the other finds against a stand-in answering each shape
  # (a Location, LocationLinks, lists across files, null, an error, a URI of another scheme or a malformed one),
  # UTF-16 positions, *xref* (RET, o, M-g n), C-t and M-, back, C-g and the time bound on a server that does not
  # answer; nil going to a binding and listing its references. test/lsp-eldoc.test.mts, hover and signature help:
  # K against a stand-in answering each shape of hover (UTF-16 positions, the pending edit first, control characters
  # blanked, the cut), C-g and the time bound; signatures while typing, one request once the keys stop, the active
  # signature and parameter, cancelled when point moves, an edit or Normal state, a late answer not shown, the
  # minibuffer and a message left alone; nil showing a builtin's documentation on K. test/lsp-diagnostics.test.mts,
  # diagnostics: a stand-in publishing each shape (UTF-16 positions, malformed items, another URI scheme, control
  # characters), placed positions following edits and an edit not yet sent, a stale version dropped, the mode line's
  # counts, the message at point (never over a message or the minibuffer), the buffer and project lists (RET, M-g n,
  # redrawn on a publish with the place kept, another producer's error list left alone), cleared on a shutdown, a
  # crash and eglot-mode off, the bounds; nil marking an undefined name.
  edwin-lsp = pkgs.runCommand "edwin-lsp" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR NODE_PATH=${devDeps}/node_modules EDWIN_LSP_REAL=${lib.getExe pkgs.nil}
    node --test ${edwin}/edwin/test/lsp-rpc.test.mts ${edwin}/edwin/test/lsp.test.mts ${edwin}/edwin/test/lsp-docs.test.mts ${edwin}/edwin/test/lsp-xref.test.mts ${edwin}/edwin/test/lsp-eldoc.test.mts ${edwin}/edwin/test/lsp-diagnostics.test.mts
    touch $out
  '';

  # Syntax trees per buffer (src/syntax.ts, Ed.syntax), with the desktop program's host.syntax stood in: fast-check
  # over edits, undo, whole-text replacement and forgotten or trimmed logs, the stand-in's text always the
  # buffer's; a run of edits crossing as one span, a whole parse only when the log cannot say what changed, a new
  # grammar, a refused edit, a killed buffer's tree freed, no tree without host.syntax. Highlighting from the
  # stand-in's captures: capture names to faces, which of one node's captures wins, nested nodes, a segment inside
  # a node begun above it, the cache, a failure and the size bounds, the mode table against the bundle's
  # grammars.json, the frame's side of the 2 ms budget. Imenu from the stand-in's tags query: definitions paired
  # with their names by match, a name two patterns take listed once, no references, null for each fallback, and
  # consult-imenu using it. Expreg from the stand-in's nodes: Ed.syntax.nodes innermost first, clamped, after an
  # edit, null for each fallback; SPC v and SPC V by keys, growing by nodes and not lines, from a Visual selection,
  # and the old steps with no tree. Indentation from the stand-in's indents query (a grammar of brackets): each
  # line by its innermost holder and the base of the line that holder starts on, an aligned list, a @none, a
  # string kept, a re-indent of indented text making no edit, a base two closed conditions up, the level from
  # evil-shift-width or a tab, a { left open (an ERROR) queried once a re-indent, null for each fallback with
  # highlighting left alone; Python's statement lines (@offside) by the statement before them, a line's blanks
  # kept where Python takes that level, else, except, finally and case back to what they go with, a line just
  # opened at the likeliest level and TAB after TAB a level down; Nix's captures from stand-in ones, a lambda's
  # body (@indent.inner) at the margin and a level in, a parenthesis's @shift, a @keep.all over an @indent inside it,
  # an ERROR's pairs of brackets and of let/in and =/;; @indent.twice two levels in (Java's continuation
  # lines); @either keeping a @dedent line a level in and @align after a `:` (shell's comments before an elif, C++'s
  # constructor initializers); booted, RET (between { and its }), o (leaving its
  # line alone), O, = and TAB by keys, and in python-mode RET, TAB TAB, o and =. Tree-sitter's side, the
  # golden face runs and imenu lists of each language, expreg's steps and each language's formatted fixture
  # re-indented with the real grammars (Nix's alejandra-formatted, its '' strings kept; C++, Java, C#, shell,
  # TOML, HCL, Meson and GDScript each as its formatter leaves it; the modes without rules keeping the line above's
  # blanks) are the package's cargo
  # tests (nix build .#edwin), which boot the core.
  # SYNTAX_RUNS raises the run count.
  edwin-syntax = pkgs.runCommand "edwin-syntax" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR NODE_PATH=${devDeps}/node_modules
    export EDWIN_GRAMMARS=${self.packages.${pkgs.stdenv.hostPlatform.system}.edwin-grammars}
    node --test ${edwin}/edwin/test/syntax.test.mts
    touch $out
  '';

  # Ed.openUrl (src/proc.ts): a URL or a file in the desktop's application, through the host, in a served frame
  # against a real edwind: what reaches the host, nothing while the image replays (R16.15), nothing from edwind's
  # Node host, an Org https link. The opener's own checks and argv (native/src/open.rs) are cargo tests, which
  # `nix build .#edwin` runs.
  edwin-open = suite "open" [ "open.test.mts" ];

  # Version control (src/vc.ts) in the headless runtime. So far the commit message buffer (vc-message-mode): the
  # faces of the summary, its overlong part, a second line that is not blank and the comment lines (git's # and
  # jj's JJ:); C-c C-c giving the message cleaned as git stripspace --strip-comments cleans it; C-c C-k and killing
  # the buffer aborting; an empty message and a name already in use refused. The runner (Vc.repo, Vc.start,
  # Vc.run) with nixpkgs' git and jujutsu (the jj option names are those of this jujutsu): status of a git and a
  # jj repository, jj found first; only git and jj run; a repository whose own configuration names a marker
  # script as fsmonitor, pager (also on a terminal, util-linux script), external diff, diff and filter driver
  # and gpg program runs none of it through status, diff, log and show, nor do its signature programs for each
  # format, its merge driver (a remerge diff), its shell alias under a name that is no builtin, a partial clone's
  # transport or a submodule's filter (describe --dirty and --broken refused); jj settings a repository brings refused; git's
  # unsafe-repository refusal shown, not retried; nothing while the image replays; the *vc-process* log. Diffs
  # (src/vc-diff.ts): git's and jj's parsed, under a user configuration that would change their shape; fast-check
  # over random files and picks of files, hunks and lines, each patch passing git apply --cached --check and,
  # applied forwards (staging), reversed on the index (unstaging) or on the work tree (discarding), leaving there
  # what the pick means; names that are not UTF-8 picked whole only. VCDIFF_RUNS
  # raises the run count. git's status buffer (src/vc-git.ts): a fixture repository with every section shown by
  # SPC g g, folded, refreshed, stepped through and visited; s, u and x staging, unstaging and discarding
  # files, hunks and selected lines (test/vc-stage.test.mts), the index compared with the blob each must leave.
  # Committing (test/vc-commit.test.mts): c c, c a, c w and c f from the status buffer, the log and the index
  # compared after each; hooks on commit and fixup, off on reword; a message a hook refused kept; save offered.
  # The log and revision buffers (test/vc-log.test.mts): a 1,000-commit fixture paged to its end with l l, + and
  # RET, each page read in the background from the tip the log opened on, the event loop held a few ms at most
  # (asserted under the 2 s frame deadline), the hashes compared with git log's; g r from HEAD;
  # a commit's header, message and diff by file and hunk, a root commit, a merge against its first parent, a
  # stash; a repository's own programs (textconv, filters, merge driver, pager, fsmonitor, gpg, aliases, with
  # log.diffMerges=remerge) run by none of it; nothing under the image's replay. jj's log and change view
  # (test/vc-jj.test.mts): SPC g g in a fixture workspace (a merge with a conflict, an immutable tagged change with
  # a bookmark, a description with quotes, brackets and a control character) read by Edwin's JSON template under a
  # user jj config whose own log template, ASCII graph and word wrap would reshape jj's output, the lines compared
  # with what jj says of each change; RET on a change, a merge's parents and the root, with the header, the diff by
  # file and hunk, folding and visiting; g r following a change as it is rewritten; RET on the working copy after
  # a file is written showing the snapshot's commit; a diff past 16 MiB noted, not shown; a bookmark named like
  # a change id standing for nothing; + over 302 changes, a failed + keeping its limit; a line of another shape
  # refused; nothing under the replay. jj's operations (test/vc-jj-ops.test.mts): o, c, e, x and s on a change of the
  # log (c in the change view too), each argv checked after the runner's switches and its result read back with
  # jj's own template: the new change's parent, the working copy edit makes, a description given on standard input
  # and one jj refused kept, the abandon question and n, a change view of an abandoned change killed, a squash
  # with one description at once and with both through the buffer as one --message= (a message that starts like
  # -R and --config) and with a parent described by only a space through the buffer too, a merge, immutable
  # changes and a change on an immutable parent refused before anything is written, jj's refusal of the root
  # said, a divergent change acted on by commit_id(); nothing under the replay. jj's rewrites
  # (test/vc-jj-rewrite.test.mts): r on a change and r on another rebasing it with its descendants (rebase --source
  # --onto), the whole graph read back, u restoring it commit for commit and C-r the rebased one, the source mark
  # kept across g r and cleared, n, an immutable source and a cycle jj refuses; u naming a snapshot of the working
  # copy, and refusing when an operation came while it asked; u after u naming the operation jj undo goes back
  # over each time, a snapshot among them, as jj then says it undid; S splitting a file at point and the files of a
  # Visual selection off a change (names with a quote, a backslash, a space and a leading -, as root-file:
  # filesets after --), a rename with both its names, every file, a stale file and an immutable change refused;
  # nothing under the replay.
  # Branches, checkout, reset, stash and tags (test/vc-history.test.mts): b b refused with the files named when local
  # changes are in the way and carrying them when not, detaching HEAD from a log line and naming the commit left
  # behind; b c, b n, b x (an unmerged branch after asking) and b m; O s, O m and O h (asking: n writes nothing);
  # z z, z i, z a with the index, z p with a conflict (the stash kept) and with local changes in the way, z k
  # asking, a stale stash line refused; t t lightweight under tag.gpgSign, t x asking; names and revisions that
  # would be switches refused before any write; a jj workspace and the image's replay refused.
  # Fetch, pull and push (test/vc-remote.test.mts), against local bare remotes and a loopback HTTP server: p u
  # setting the upstream, its progress in *vc-process*; F u fast-forward, merged and with a conflict, git's
  # divergence refusal; f u and f a; a rejected push, p f asking (n pushes nothing), a stale lease refused, the
  # forced push; the repository's own uploadpack, receivepack, gitProxy, alternateRefsCommand, vcs helper, ext::
  # remote, sshCommand, askPass and credential helpers running nothing, the user's sshCommand and helper running
  # instead, no prompt waited for; a detached HEAD, a local upstream, a second operation (also while the first
  # readies), a jj workspace and the replay refused.
  # jj's remotes and bookmarks (test/vc-jj-remote.test.mts), against local bare remotes: f f and f a (jj git fetch),
  # b c with names that would be switches, b s asking before a backwards or sideways move, p p pushing the
  # bookmarks at point (a new one tracked) and asking before a sideways or backward move on the remote (n pushes
  # nothing), p c, b r, b d asking and p d pushing the deletion after naming it, b t and b u; the repository's own
  # receivepack and
  # uploadpack refused (receivepack also in a non-colocated workspace, a secondary one and one whose .jj/repo is a
  # symlink), its sshCommand and ext:: remote running
  # nothing, the user's sshCommand instead, fetch's reference-transaction hook off, each with plain jj as the
  # control; a second remote command while a push runs, and the replay, refused.
  # Merge, cherry-pick, revert and rebase (test/vc-sequencer.test.mts), in throwaway repositories: m m, A A (a
  # range and a single commit), _ _ (one asked, two selected in the log), r e and r u each through a conflict to
  # its end and to its abort, the status header and its todo compared at every step; going on refused while a
  # conflict is left and asking over a staged conflict marker; A s and r s skipping after asking, the aborts
  # asking (n changes nothing); the message git prepared kept (GIT_EDITOR=:, a rebase's the frame's editor handing
  # it back), with no Conflicts lines; a merge in
  # a linked worktree; a branch or a tag named CHERRY_PICK_HEAD, REVERT_HEAD or REBASE_HEAD taken for no
  # operation (in a files and a reftable repository), a real one beside it still read; a Visual selection in the
  # status buffer picking its commit lists' commits alone; a revision that would be a switch, a step with nothing
  # in progress, a second operation, a jj workspace and the replay refused.
  # Conflict markers (test/vc-conflict.test.mts, vc-conflict-mode): git merge-file's two-way, diff3 and zdiff3
  # markers (CRLF, a longer marker size, sides with no final newline among them) and a real diff3 merge, resolved
  # by C-c ^ u, C-c ^ l and C-c ^ a to merge-file's --ours, --theirs and --union text; jj's default markers from a
  # throwaway workspace (a snapshot and a diff side either way round, no terminating newline, longer markers, a
  # 7-character <<<<<<< line in the context read as text) resolved to jj resolve's :ours and :theirs; nested and
  # malformed markers left as they are with a message, an opening marker with no closing one of its length text; the
  # mode on at a visit and still on after the last resolution, so undo brings it back with its keys, ] n and [ n,
  # Insert state and read-only; ] b, [ b and markdown-mode's ] ] and C-c C-t still theirs while the mode is on.
  # The interactive rebase (test/vc-rebase.test.mts): r i's todo in git-rebase-todo-mode, M-k reordering and s
  # squashing to the end with the squash's message written, r, e, d, f and p, a reword's message, a stop at an
  # edit gone on with by r r; C-c C-k, Z Q and a kill aborting with nothing left; a reword's message aborted; a
  # hook's and an exec line's frame for another file left unanswered; a `#` line kept under core.commentChar `;`;
  # a second repository of the same name's todo beside the first; `exec cat` ending at once and a frame never
  # ended by a NUL taken as output; --root; refusals before any write.
  # Phase 3's exit gate (test/vc-flow.test.mts): a hunk staged, commits, r i through a conflict resolved by
  # vc-conflict-mode and a squash, then jj describe and squash in the same repository colocated.
  # Blame (test/vc-blame.test.mts): SPC g b on a fixture history of three authors in three time zones, the blame
  # beside the file read in the background, each line its commit as git blame says, the day in the author's zone;
  # RET showing a commit; a change not saved blamed as not committed yet; g r; a name with a space and a leading -
  # after --; the file on disk with no buffer; refusals with no child started; the repository's own programs not run,
  # nor its blame.ignoreRevsFile and mailmap.file read; an empty file; a file not UTF-8 blamed from its bytes; a
  # file through a symbolic link blamed by its true name.
  # The time machine (test/vc-timemachine.test.mts): SPC g t on a fixture file of four revisions renamed in the
  # third, each compared with git show REV:PATH, p and n stepping, point kept on its line and column, both ends
  # refused with no child; p p; q; a name with a space, a leading - and glob characters as a literal pathspec; a
  # deletion left out; a merge that changed the file; a revision not UTF-8; a symbolic link; refusals with no child
  # started; the repository's own programs not run.
  # The TODO section (test/vc-todos.test.mts): the TODO: and FIXME: lines of a fixture's tracked files listed last
  # in the status buffer by one git grep, lines that only look like them, untracked, ignored and binary files and a
  # submodule left out, under a repository configuration that would change git grep's output or run a program;
  # RET visiting, s, u and x refused, g j, C-k, TAB and g r; none; more than 200; git grep failing; c c with no
  # git grep; the image's replay.
  # fast-check from the dev dependencies, for this suite alone: the edwind suites keep edwind's own module
  # resolution.
  edwin-vc =
    pkgs.runCommand "edwin-vc"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.git
          pkgs.jujutsu
          pkgs.util-linux
        ];
      }
      ''
        export HOME=$TMPDIR NODE_PATH=${devDeps}/node_modules
        node --test ${edwin}/edwin/test/vc.test.mts ${edwin}/edwin/test/vc-diff.test.mts ${edwin}/edwin/test/vc-git.test.mts ${edwin}/edwin/test/vc-stage.test.mts ${edwin}/edwin/test/vc-commit.test.mts ${edwin}/edwin/test/vc-log.test.mts ${edwin}/edwin/test/vc-jj.test.mts ${edwin}/edwin/test/vc-jj-ops.test.mts ${edwin}/edwin/test/vc-jj-rewrite.test.mts ${edwin}/edwin/test/vc-history.test.mts ${edwin}/edwin/test/vc-remote.test.mts ${edwin}/edwin/test/vc-jj-remote.test.mts ${edwin}/edwin/test/vc-sequencer.test.mts ${edwin}/edwin/test/vc-conflict.test.mts ${edwin}/edwin/test/vc-rebase.test.mts ${edwin}/edwin/test/vc-flow.test.mts ${edwin}/edwin/test/vc-blame.test.mts ${edwin}/edwin/test/vc-timemachine.test.mts ${edwin}/edwin/test/vc-todos.test.mts
        touch $out
      '';

  # The frame runtime (E3 H1, §6.3, §7, §9.5): Edwin's core as a protocol client against a real edwind:
  # open and snap, batches and acks, transform against pending edits, undo by group, reconnect and resend,
  # image replication, server commands and ask, anchors, server-only stubs.
  edit-frame = suite "frame" [ "frame.test.mts" ];

  # The console page's frame (console/index.html): booted with the Scheme the page fetches and driven by keys,
  # against a real edwind and a loopback provider: the pi and gptel keys run in edwind.
  edit-console = suite "console" [ "console.test.mts" ];

  # The Lisp machine (E2, §4.6–§4.9): threads, held buffers, ask and answer, interrupt, timers, server
  # commands; the debugger, the inspector, introspection and the primitive registry.
  edit-lisp = suite "lisp" [
    "threads.test.mts"
    "debug.test.mts"
  ];

  # Processes through the hub (R4.43-R4.45), against the fake hub.
  edit-process = suite "process" [ "process.test.mts" ];
  # edwin-front (server/front.mts): the floor, edwin-web from memory, and /edit's line relay and close codes.
  edit-front = suite "front" [ "front.test.mts" ];

  # Source blocks in notes (hypernotes H1: scm/babel.scm, server/babel.mts): the reader and writer, then the
  # engine against a real edwind and the fake hub, for markdown and Org.
  edit-babel = suite "babel" [ "babel.test.mts" ];

  # The Scheme boundary (R16.15, R4.52) and the credential rules (R16.19, in models.test.mts).
  edit-security = suite "security" [
    "security.test.mts"
    "models.test.mts"
  ];

  # Directories (server/fs.mts, src/dired.ts): the fs-* commands and their refusals, dired and find-file's path
  # reading in a served Edwin against a real edwind, and dired on the desktop program's own files, its listings
  # following their directories through global-auto-revert-mode (the natives behind them are tested by the
  # package's cargo tests).
  edit-dired = suite "dired" [
    "fs.test.mts"
    "dired.test.mts"
    "dired-local.test.mts"
  ];

  # The note projector (server/projector.mts): the record of each note file as brain is sent it, saved text only,
  # retries, refusals, the ledger across a restart, and where the token may go.
  edit-projector = suite "projector" [ "projector.test.mts" ];

  # Nodes and tasks from brain (server/brain.mts, src/brain.ts): a served Edwin against a real edwind and a
  # stand-in for brain. The read token is sent and never logged, nor is what was asked; finding, linking and
  # opening a node; the backlinks window; id: and title links; a new note and a daily made on disk through
  # edwind. Tasks are read with the read token and written with the task token, a task's fields only; the
  # agenda's two views, its keys, what brain replaced and what it refused; a new task from a selection.
  edit-brain = suite "brain" [ "brain.test.mts" ];

  # pi agents in chat notes (server/agent.mts, scm/pi.scm): the agent loop, a tool after a yes, a no, the saved
  # session, and a switch of provider mid-session.
  edit-agent = suite "agent" [ "agent.test.mts" ];

  # edwin --daemon from the package (test/daemon.test.mts): a start returns once the socket answers, two starts at
  # once give one edwind and one exit with status 3, `edwin --daemon && edwinclient -e 1` 100 times, --wait, and
  # the timeout when edwind dies (at once, as the user service's ExecStartPost, when MAINPID has exited); and the
  # command lines of edwin-daemon and edwind: an unknown option and `edwin --daemon FILE` refused with status 2,
  # --help, bare edwind. Real edwinds under a throwaway HOME and XDG_RUNTIME_DIR. About two minutes.
  edwin-daemon =
    pkgs.runCommand "edwin-daemon"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.util-linux
        ];
      }
      ''
        export HOME=$TMPDIR EDWIN_BIN=${self.packages.${pkgs.stdenv.hostPlatform.system}.edwin}/bin
        node --test ${edwin}/edwin/test/daemon.test.mts
        touch $out
      '';

  # programs.edwin (nix/edwin-module.nix) evaluates into a system: the user unit runs `edwin --fg-daemon` from the
  # package, is ready once `edwin-daemon --wait` returns and is not restarted after status 3, as the unit file
  # systemd reads says; EDITOR is edwin. Evaluation only, so the edwin package itself is not built here.
  edwin-module =
    let
      sys = pkgs.nixos {
        imports = [ self.nixosModules.edwin ];
        system.stateVersion = lib.trivial.release;
        boot.isContainer = true; # no root file system or boot loader to declare
        programs.edwin = {
          enable = true;
          daemon.enable = true;
          defaultEditor = true;
        };
      };
      unit = sys.config.systemd.user.services.edwind;
      # The unit file's lines that start and restart edwind, as rendered for systemd.
      unitLines = lib.filter (l: lib.hasPrefix "ExecStart" l || lib.hasPrefix "Restart" l) (
        lib.splitString "\n" sys.config.systemd.user.units."edwind.service".text
      );
      edwin = self.packages.${pkgs.stdenv.hostPlatform.system}.edwin;
      show = v: builtins.unsafeDiscardStringContext (builtins.toJSON v);
      got = show {
        lines = unitLines;
        notes = unit.environment.EDWIN_NOTES_DIR;
        wanted = unit.wantedBy;
        editor = sys.config.environment.variables.EDITOR;
        system = builtins.seq sys.config.system.build.toplevel.drvPath true;
      };
      want = show {
        lines = [
          "ExecStart=${edwin}/bin/edwin --fg-daemon"
          "ExecStartPost=${edwin}/bin/edwin-daemon --wait"
          "Restart=on-failure"
          "RestartPreventExitStatus=3"
          "RestartSec=1"
        ];
        notes = "%h/notes";
        wanted = [ "default.target" ];
        editor = "edwin";
        system = true;
      };
    in
    assert lib.assertMsg (got == want) "programs.edwin evaluated to ${got}, expected ${want}";
    pkgs.runCommand "edwin-module" { } "touch $out";

  # programs.edwin.daemon.settings and .credentials (nix/edwin-module.nix): settings from two modules merge into
  # one fragment, the unit's EDWIND_CONFIG_EXTRA, that names credentials and refuses every credential's file (a
  # desktop with credentials and no settings gets that refusal too); the credentials become the unit's
  # LoadCredential lines; a credential file in the store, a colon in one, a bad name and a
  # fragment that sets the daemon's own fields are refused; a desktop without them renders the unit as before.
  # daemon.hub is hubSocket in that fragment (merged with the rest), absent unless set, and a relative one is refused.
  # Then test/daemon-models.test.mts runs the package's edwin-daemon with that fragment under a throwaway HOME and
  # XDG_RUNTIME_DIR: the fragment reaches the edwind.json it writes and edwind, and no form or frame request
  # reaches a credential's bytes. The daemon script and edwind only: the program itself is not built here.
  edwin-daemon-models =
    let
      desktop =
        extra:
        pkgs.nixos {
          imports = [
            self.nixosModules.edwin
            extra
          ];
          system.stateVersion = lib.trivial.release;
          boot.isContainer = true;
          programs.edwin = {
            enable = true;
            daemon.enable = true;
          };
        };
      sys = desktop {
        # Two modules set settings, as the models and the brain areas will; the module system merges them.
        imports = [
          { programs.edwin.daemon.settings.models = settings.models; }
          {
            programs.edwin.daemon.settings = { inherit (settings) brain refusePaths; };
          }
        ];
        programs.edwin.daemon.credentials = {
          anthropic-api-key = "/run/secrets/anthropic";
          brain-read-token = "/run/secrets/brain-read";
        };
      };
      unit = sys.config.systemd.user.services.edwind;
      unitText = sys.config.systemd.user.units."edwind.service".text;
      plain = (desktop { }).config.systemd.user.services.edwind;
      # The messages of the assertions a desktop with EXTRA fails.
      refused =
        extra: map (a: a.message) (lib.filter (a: !a.assertion) (desktop extra).config.assertions);
      show = v: builtins.unsafeDiscardStringContext (builtins.toJSON v);
      fragment = unit.environment.EDWIND_CONFIG_EXTRA;
      credsOnly = (desktop { programs.edwin.daemon.credentials.k = "/run/k"; }).config.systemd.user.services.edwind;
      hubOnly = (desktop { programs.edwin.daemon.hub = "/run/hub/hub.sock"; }).config.systemd.user.services.edwind;
      hubHome = (desktop { programs.edwin.daemon.hub = "~/hub.sock"; }).config.systemd.user.services.edwind;
      hubCreds =
        (desktop {
          programs.edwin.daemon = {
            hub = "/run/hub/hub.sock";
            credentials.k = "/run/k";
          };
        }).config.systemd.user.services.edwind;
      # daemon.path: a package with one output and one whose bin is an output of its own (curl's).
      listed = [
        pkgs.hello
        pkgs.curl
      ];
      listedBins = map (p: "${lib.getBin p}/bin") listed;
      # The PATH of the rendered unit file, which is what systemd reads, as its directories.
      unitPath =
        sys':
        let
          line = lib.findFirst (lib.hasPrefix "Environment=\"PATH=") null (
            lib.splitString "\n" sys'.config.systemd.user.units."edwind.service".text
          );
        in
        lib.splitString ":" (lib.removeSuffix "\"" (lib.removePrefix "Environment=\"PATH=" line));
      pathed = unitPath (desktop { programs.edwin.daemon.path = listed; });
      plainPath = unitPath (desktop { });
      # The fragment: the settings, their refusals followed by the credentials' files.
      merged = settings // {
        refusePaths = settings.refusePaths ++ [
          "/run/secrets/anthropic"
          "/run/secrets/brain-read"
        ];
      };
      settings = {
        models = {
          anthropic = {
            baseUrl = "https://api.anthropic.com";
            credential = "anthropic-api-key";
          };
          tiers = {
            default = "model-default";
            quick = "model-quick";
          };
        };
        brain = {
          url = "http://127.0.0.1:9";
          readCredential = "brain-read-token";
          tags = [ "roam" ];
        };
        refusePaths = [ "~/private" ];
      };
      got = show {
        creds = unit.serviceConfig.LoadCredential;
        inherit (sys.config.programs.edwin.daemon) settings;
        fragmentInStore = lib.hasPrefix "${builtins.storeDir}/" fragment;
        credLines = lib.filter (lib.hasPrefix "LoadCredential=") (lib.splitString "\n" unitText);
        plain = {
          extra = plain.environment ? EDWIND_CONFIG_EXTRA;
          creds = plain.serviceConfig ? LoadCredential;
        };
        credsOnly = credsOnly.environment ? EDWIND_CONFIG_EXTRA;
        hubOnly = hubOnly.environment ? EDWIND_CONFIG_EXTRA;
        path = {
          # Each listed package's bin, first and in order, then NixOS's default directories, all of them kept.
          first = lib.take (lib.length listed) pathed;
          defaultsKept = lib.all (d: lib.elem d pathed) plainPath;
          coreutilsAfter = lib.elem "${pkgs.coreutils}/bin" (lib.drop (lib.length listed) pathed);
          # A desktop without daemon.path has none of them.
          plain = lib.any (b: lib.elem b plainPath) listedBins;
        };
        refused = {
          store = refused { programs.edwin.daemon.credentials.k = "${builtins.storeDir}/0000-k"; };
          colon = refused { programs.edwin.daemon.credentials.k = "/run/a:b"; };
          relative = refused { programs.edwin.daemon.credentials.k = "run/k"; };
          name = refused { programs.edwin.daemon.credentials.Bad_Name = "/run/k"; };
          own = refused { programs.edwin.daemon.settings.socket = "/run/elsewhere.sock"; };
          hub = refused { programs.edwin.daemon.hub = "run/hub.sock"; };
          hubHome = refused { programs.edwin.daemon.hub = "~/hub.sock"; };
          none = refused { };
        };
        system = builtins.seq sys.config.system.build.toplevel.drvPath true;
      };
      fileMsg = "programs.edwin.daemon.credentials: each file must be an absolute path outside ${builtins.storeDir}, with no colon.";
      want = show {
        creds = [
          "anthropic-api-key:/run/secrets/anthropic"
          "brain-read-token:/run/secrets/brain-read"
        ];
        inherit settings;
        fragmentInStore = true;
        credLines = [
          "LoadCredential=anthropic-api-key:/run/secrets/anthropic"
          "LoadCredential=brain-read-token:/run/secrets/brain-read"
        ];
        plain = {
          extra = false;
          creds = false;
        };
        credsOnly = true;
        hubOnly = true;
        path = {
          first = listedBins;
          defaultsKept = true;
          coreutilsAfter = true;
          plain = false;
        };
        refused = {
          store = [ fileMsg ];
          colon = [ fileMsg ];
          relative = [ fileMsg ];
          name = [ "programs.edwin.daemon.credentials: names must match ^[a-z0-9-]{1,32}$." ];
          own = [ "programs.edwin.daemon.settings: socket, notesDir, stateDir, configDir are edwin-daemon's own." ];
          hub = [ "programs.edwin.daemon.hub: the socket must be an absolute path or one under ~/." ];
          hubHome = [ ];
          none = [ ];
        };
        system = true;
      };
      daemon = self.packages.${pkgs.stdenv.hostPlatform.system}.edwin.daemon;
    in
    assert lib.assertMsg (got == want) "programs.edwin.daemon evaluated to ${got}, expected ${want}";
    pkgs.runCommand "edwin-daemon-models" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      # A fragment FILE holds the JSON WANT.
      same() { node -e 'const [f, want] = process.argv.slice(1); require("assert").deepStrictEqual(JSON.parse(require("fs").readFileSync(f, "utf8")), JSON.parse(want));' \
          "$1" "$2"; }
      # The fragment in the store is the merged settings, the credentials' files among its refusals.
      same ${fragment} ${lib.escapeShellArg (builtins.toJSON merged)}
      same ${credsOnly.environment.EDWIND_CONFIG_EXTRA} '{"refusePaths":["/run/k"]}'
      # daemon.hub is the fragment's hubSocket, alone or beside the other fields.
      same ${hubOnly.environment.EDWIND_CONFIG_EXTRA} '{"hubSocket":"/run/hub/hub.sock"}'
      same ${hubHome.environment.EDWIND_CONFIG_EXTRA} '{"hubSocket":"~/hub.sock"}'
      same ${hubCreds.environment.EDWIND_CONFIG_EXTRA} '{"hubSocket":"/run/hub/hub.sock","refusePaths":["/run/k"]}'
      export HOME=$TMPDIR EDWIN_DAEMON=${daemon} EDWIND_CONFIG_EXTRA=${fragment}
      node --test ${edwin}/edwin/test/daemon-models.test.mts
      touch $out
    '';

  # services.edwind (nix/edwind-module.nix) evaluates into a system, and edwind itself accepts the edit.json it
  # writes: loadConfig refuses unknown fields, so a module that drifts from the server fails here.
  edwind-module =
    let
      sys = pkgs.nixos {
        imports = [ self.nixosModules.edwind ];
        system.stateVersion = lib.trivial.release;
        boot.isContainer = true;
        users.users.alice = {
          isNormalUser = true;
          home = "/home/alice";
        };
        services.edwind = {
          enable = true;
          user = "alice";
          notesDir = "/home/alice/notes";
          hubSocket = "/run/hub/hub.sock";
          models.anthropic.apiKeyFile = "/run/secrets/anthropic";
          brain = {
            url = "http://127.0.0.1:7676";
            readTokenFile = "/run/secrets/brain-read";
            taskTokenFile = "/run/secrets/brain-task";
          };
          credentials.search = {
            file = "/run/secrets/search";
            origin = "https://search.example";
          };
          front = {
            enable = true;
            address = "10.0.0.2";
            publicOrigin = "https://edwin.example";
            trustedProxy = "10.0.0.1";
            proxySecretFile = "/run/secrets/front";
            firewall.interface = "wg0";
          };
        };
      };
      frontUnit = sys.config.systemd.services.edwin-front;
      frontJson = lib.head frontUnit.restartTriggers;
      unit = sys.config.systemd.services.edwind;
      edwind = self.packages.${pkgs.stdenv.hostPlatform.system}.edwind;
      show = v: builtins.unsafeDiscardStringContext (builtins.toJSON v);
      got = show {
        exec = unit.serviceConfig.ExecStart;
        user = unit.serviceConfig.User;
        creds = unit.serviceConfig.LoadCredential;
        readOnly = unit.serviceConfig.ReadOnlyPaths;
        frontCreds = frontUnit.serviceConfig.LoadCredential;
        frontAllow = frontUnit.serviceConfig.IPAddressAllow;
        system = builtins.seq sys.config.system.build.toplevel.drvPath true;
      };
      want = show {
        exec = "${edwind}/bin/edwind --config /etc/edwind/edit.json";
        user = "alice";
        creds = [
          "anthropic-api-key:/run/secrets/anthropic"
          "brain-read-token:/run/secrets/brain-read"
          "brain-task-token:/run/secrets/brain-task"
          "search:/run/secrets/search"
        ];
        readOnly = [
          "/home/alice/.ssh"
          "/home/alice/.config/systemd"
          "/home/alice/.local/share/systemd"
        ];
        frontCreds = [ "proxy-secret:/run/secrets/front" ];
        frontAllow = [ "10.0.0.1" ];
        system = true;
      };
    in
    assert lib.assertMsg (got == want) "services.edwind evaluated to ${got}, expected ${want}";
    pkgs.runCommand "edwind-module" { } ''
      export HOME=$TMPDIR
      ${edwind}/bin/edwind --config ${
        sys.config.environment.etc."edwind/edit.json".source
      } --write-roots > roots
      grep -qx /home/alice/notes roots
      grep -qx /run/edwind roots
      # edwin-front accepts the front.json the module writes, with the credential where systemd would put it.
      printf '%048d' 0 > secret
      sed "s|/run/credentials/edwin-front.service/proxy-secret|$PWD/secret|" ${frontJson} > front.json
      ${pkgs.nodejs}/bin/node --no-warnings=ExperimentalWarning --input-type=module -e "
        const { loadConfig } = await import('${edwind}/share/edwin/server/front.mts');
        const c = loadConfig('front.json');
        if (c.listen.port !== 8091 || c.editSocket !== '/run/edwind/edit.sock') throw new Error(JSON.stringify(c));
      "
      touch $out
    '';
}
