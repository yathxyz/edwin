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

  # Programming modes in the headless runtime: each mode's comment syntax (set-comment-syntax!, found through the
  # modes it derives from, nearest first) and gc, gcc and M-; using it.
  edwin-prog = suite "prog" [ "prog.test.mts" ];

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
  # and status, spawn, and the refusals in a web frame, with no host.proc and while the image replays (R16.15).
  edwin-proc = suite "proc" [ "proc.test.mts" ];

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
