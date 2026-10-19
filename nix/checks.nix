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
  '';
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
  suite =
    name: files:
    pkgs.runCommand "edwin-${name}" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
      export HOME=$TMPDIR
      node --test ${lib.concatMapStringsSep " " (f: "${edwin}/edwin/test/${f}") files}
      touch $out
    '';
in
{
  # Edwin's editing core in Node with no browser and no page stand-ins (step E0 of the edwind plan).
  edwin-headless = suite "headless" [ "headless.test.mts" ];

  # Edwin's Scheme: the language (R4.3-R4.10, R4.31-R4.34), the editor-level forms (hooks, advice,
  # minor modes, buffer-locals, markers) and the shadow-stack cost bound (R4.34, at most 10%).
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
  edit-image = suite "image" [ "image.test.mts" ];
  edit-notes = suite "notes" [ "notes.test.mts" ];

  # markdown-mode (E3, §10.1, R10.1-R10.5): the parity table's commands, faces, overlays, folding, the keyword
  # table shared with Org, journal-today, and the incremental font-lock budget (a keystroke in 10,000 lines
  # re-fontifies in 2 ms), in the headless runtime.
  edwin-markdown = suite "markdown" [ "markdown.test.mts" ];

  # The display seam (DT0 of desktop Edwin): model frames laid out on a cell grid for a backend that is not a page,
  # and the face and palette tables checked against index.html's, markdown-mode's and Org's stylesheets.
  edwin-display = suite "display" [ "display.test.mts" ];

  # The desktop program's JavaScript (DT1): the terminal encoder and decoder (native/js/term.ts), and the
  # core's seams it uses (files on a disk, leaving with an exit status, input events). The program itself is
  # tested in a pseudo-terminal by native/tests (cargo test).
  edwin-native = suite "native" [
    "term.test.mts"
    "native.test.mts"
  ];

  # The frame runtime (E3 H1, §6.3, §7, §9.5): Edwin's core as a protocol client against a real edwind:
  # open and snap, batches and acks, transform against pending edits, undo by group, reconnect and resend,
  # image replication, server commands and ask, anchors, server-only stubs.
  edit-frame = suite "frame" [ "frame.test.mts" ];

  # The Lisp machine (E2, §4.6–§4.9): threads, held buffers, ask and answer, interrupt, timers, server
  # commands; the debugger, the inspector, introspection and the primitive registry.
  edit-lisp = suite "lisp" [
    "threads.test.mts"
    "debug.test.mts"
  ];

  # Processes through the hub (R4.43-R4.45) and the section 5 session API, against the fake hub.
  edit-process = suite "process" [
    "process.test.mts"
    "wb.test.mts"
  ];

  # Source blocks in notes (hypernotes H1: scm/babel.scm, server/babel.mts): the reader and writer, then the
  # engine against a real edwind and the fake hub, for markdown and Org.
  edit-babel = suite "babel" [ "babel.test.mts" ];

  # The Scheme boundary (R16.15, R4.52) and the credential rules (R16.19, in models.test.mts).
  edit-security = suite "security" [
    "security.test.mts"
    "models.test.mts"
  ];

  # programs.edwin (nix/edwin-module.nix) evaluates into a system: the user unit runs `edwin --fg-daemon` from the
  # package, EDITOR is edwin. Evaluation only, so the edwin package itself is not built here.
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
      edwin = self.packages.${pkgs.stdenv.hostPlatform.system}.edwin;
      show = v: builtins.unsafeDiscardStringContext (builtins.toJSON v);
      got = show {
        exec = unit.serviceConfig.ExecStart;
        notes = unit.environment.EDWIN_NOTES_DIR;
        wanted = unit.wantedBy;
        editor = sys.config.environment.variables.EDITOR;
        system = builtins.seq sys.config.system.build.toplevel.drvPath true;
      };
      want = show {
        exec = "${edwin}/bin/edwin --fg-daemon";
        notes = "%h/notes";
        wanted = [ "default.target" ];
        editor = "edwin";
        system = true;
      };
    in
    assert lib.assertMsg (got == want) "programs.edwin evaluated to ${got}, expected ${want}";
    pkgs.runCommand "edwin-module" { } "touch $out";
}
