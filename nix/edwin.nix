# edwin, Edwin on the desktop (native/, DT1 and DT2): the terminal program (`edwin`, `edwin -nw`), the
# window (`edwin -g`), the user's own daemon (`edwin --daemon`, which runs edwind through edwin-daemon), and its
# client (`edwinclient`, a link to edwin, which is the client by that name), as Emacs ships emacs,
# emacs --daemon and emacsclient. edwin never attaches to an edwind; edwinclient always does.
{
  lib,
  rustPlatform,
  fetchurl,
  writeShellScript,
  nodejs,
  makeFontsConf,
  dejavu_fonts,
  edwind,
  coreutils,
  util-linux,
  # The window's tests: a virtual X display, keys and the mouse sent to it, its properties read, and Mesa's
  # software Vulkan driver (lavapipe) as the GPU.
  xvfb,
  xdotool,
  xprop,
  mesa,
  # What the window loads at run time (winit and wgpu open them with dlopen).
  libxkbcommon,
  wayland,
  vulkan-loader,
  libGL,
  libx11,
  libxcursor,
  libxrandr,
  libxi,
}:
let
  # The prebuilt V8 the v8 crate links (its build script would download it): a fixed-output fetch, so the
  # build itself stays offline. The version follows Cargo.toml's `v8 = "=130.0.1"`.
  rustyV8 = fetchurl {
    url = "https://github.com/denoland/rusty_v8/releases/download/v130.0.1/librusty_v8_release_x86_64-unknown-linux-gnu.a.gz";
    sha256 = "1f9pzbpc2bg1a0i0sknz43wypk761wx7p3mn4byvhcvph5l6m9rh";
  };
  windowLibs = [
    libxkbcommon
    wayland
    vulkan-loader
    libGL
    libx11
    libxcursor
    libxrandr
    libxi
  ];
  # edwin --daemon: edwind for this user on $XDG_RUNTIME_DIR/edwin/edit.sock, where edwinclient looks after
  # $EDWIN_SOCKET. The config is EDWIND_CONFIG when set, else one made at each start from
  # EDWIN_NOTES_DIR (~/notes): state in ~/.local/state/edwin/edwind, the user's Scheme in ~/.config/edwin.
  # In the background unless --fg (what a systemd user service runs); a background start returns once the socket
  # answers, and --wait starts nothing and returns once it answers. Without EDWIND_CONFIG a start holds
  # ~/.local/state/edwin/edwind.lock from its check until the edwind it started answers (edwind itself never
  # holds it), so of two starts one runs edwind and the other, which waited on the lock, exits with status 3; a
  # start that finds an edwind answering at once exits with status 1. The edwin-daemon check tests it.
  daemon = writeShellScript "edwin-daemon" ''
    set -eu
    PATH=${
      lib.makeBinPath [
        coreutils
        util-linux
      ]
    }:$PATH
    mode=bg
    case ''${1:-} in
      --fg) mode=fg; shift ;;
      --wait) mode=wait; shift ;;
    esac
    # How long a start and --wait wait for edwind to answer, and a start for another start's lock.
    wait_s=30 lock_s=40
    # answers SECONDS: whether something accepts on $sock within SECONDS (0: asked once).
    answers() {
      ${nodejs}/bin/node -e 'const [sock, s] = process.argv.slice(1), end = Date.now() + 1000 * s;
        const go = () => require("net").connect(sock).on("connect", () => process.exit(0))
          .on("error", () => (Date.now() < end ? setTimeout(go, 20) : process.exit(1)));
        go();' "$sock" "$1"
    }
    cfg=''${EDWIND_CONFIG:-}
    if [ -z "$cfg" ]; then
      run=''${XDG_RUNTIME_DIR:?edwin --daemon needs XDG_RUNTIME_DIR (or EDWIND_CONFIG)}/edwin
      sock=$run/edit.sock
    elif [ "$mode" != fg ]; then
      # The socket edwind listens on, as edwind reads the config.
      # (main.mts runs edwind when process.argv[1] names it, so the config is the only argument.)
      sock=$(${nodejs}/bin/node --no-warnings=ExperimentalWarning --input-type=module -e '
        const { loadConfig } = await import("${edwind}/share/edwin/server/main.mts");
        try { process.stdout.write(loadConfig(process.argv[1]).socket); } catch (e) { console.error(`edwin: ''${e.message}`); process.exit(1); }' \
        "$cfg")
    fi
    if [ "$mode" = wait ]; then
      answers "$wait_s" && exit 0
      echo "edwin: no edwind answered on $sock within $wait_s s" >&2; exit 1
    fi
    locked=
    if [ -z "$cfg" ]; then
      home=''${HOME:?}
      notes=''${EDWIN_NOTES_DIR:-$home/notes}
      state=''${XDG_STATE_HOME:-$home/.local/state}/edwin
      mkdir -p -m 700 "$run" "$state/edwind"
      mkdir -p "$notes"
      exec 9>>"$state/edwind.lock"
      raced=
      if ! flock -n 9; then
        raced=1
        flock -w "$lock_s" 9 || { echo "edwin: another start held $state/edwind.lock for $lock_s s" >&2; exit 1; }
      fi
      locked=1
      if [ -S "$sock" ] && answers 0; then
        if [ -n "$raced" ]; then echo "edwin: another start started the edwind on $sock" >&2; exit 3; fi
        echo "edwin: an edwind already runs on $sock" >&2; exit 1
      fi
      cfg=$run/edwind.json
      ${nodejs}/bin/node -e 'const [f, sock, notes, state, conf] = process.argv.slice(1);
        require("fs").writeFileSync(f, JSON.stringify({ socket: sock, notesDir: notes, stateDir: state, configDir: conf,
          refusePaths: ["~/.ssh", "~/.config/systemd", "~/.local/share/systemd"] }), { mode: 0o600 });' \
        "$cfg" "$sock" "$(realpath "$notes")" "$state/edwind" "''${XDG_CONFIG_HOME:-$home/.config}/edwin"
    fi
    # edwind never gets the lock's descriptor (9>&-), so an edwind that dies leaves no lock held.
    if [ "$mode" = fg ]; then
      # A detached helper keeps the lock until this edwind answers, as a background start keeps it.
      if [ -n "$locked" ]; then (answers "$wait_s" </dev/null >/dev/null 2>&1 &); fi
      exec ${edwind}/bin/edwind --config "$cfg" 9>&-
    fi
    log=''${XDG_STATE_HOME:-''${HOME:?}/.local/state}/edwin/edwind.log
    mkdir -p "''${log%/*}"
    setsid -f ${edwind}/bin/edwind --config "$cfg" </dev/null >>"$log" 2>&1 9>&-
    if ! answers "$wait_s"; then
      echo "edwin: the edwind started did not answer on $sock within $wait_s s (log: $log)" >&2; exit 1
    fi
    echo "edwin: edwind started (log: $log)" >&2
  '';
in
rustPlatform.buildRustPackage {
  pname = "edwin";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    # An in-tree build leaves its target/ beside the sources.
    fileset = lib.fileset.difference (lib.fileset.unions [
      ../src
      ../scm
      ../server
      ../test
      ../native
    ]) (lib.fileset.unions [ (lib.fileset.maybeMissing ../native/target) (lib.fileset.maybeMissing ../server/node_modules) ]);
  };
  buildAndTestSubdir = "native";
  cargoRoot = "native";
  cargoLock.lockFile = ../native/Cargo.lock;

  env.RUSTY_V8_ARCHIVE = rustyV8;
  # build.rs embeds the ICU data the v8 crate carries; here the crate is in the vendored sources.
  # sources.rs embeds the core and native/js as JavaScript: each .ts stripped to the .js beside it.
  nativeBuildInputs = [ nodejs ];
  preBuild = ''
    node ${../tools/strip.mts} --in-place src native/js
    export EDWIN_ICU_DATA=$(find -L "$NIX_BUILD_TOP/cargo-vendor-dir" -path '*/v8-130.0.1/third_party/icu/flutter_desktop/icudtl.dat' | head -n1)
    test -f "$EDWIN_ICU_DATA"
  '';

  # The pseudo-terminal suite (edwinclient's tests run node on test/), the window's unit tests (offscreen
  # renders) and tests/gui.rs (the window on its own Xvfb, driven by xdotool). The window's tests skip without a
  # display or a GPU adapter; EDWIN_TEST_REQUIRE_GUI makes them fail instead, so here they run or the build fails.
  nativeCheckInputs = [
    nodejs
    xvfb
    xdotool
    xprop
  ];
  # The renders need a font and a GPU adapter: lavapipe, the one Vulkan driver the loader is given. The binary
  # under test is target/'s, which has no RPATH to the window's libraries yet (postFixup adds it).
  preCheck = ''
    export HOME=$TMPDIR FONTCONFIG_FILE=${makeFontsConf { fontDirectories = [ dejavu_fonts ]; }}
    export VK_DRIVER_FILES=${mesa}/share/vulkan/icd.d/lvp_icd.x86_64.json
    export LD_LIBRARY_PATH=${lib.makeLibraryPath windowLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
    export EDWIN_TEST_REQUIRE_GUI=1
  '';

  postInstall = ''
    ln -s edwin $out/bin/edwinclient
    ln -s ${daemon} $out/bin/edwin-daemon
    ln -s ${edwind}/bin/edwind $out/bin/edwind
  '';
  # After the fixup's RPATH shrinking, which would drop libraries no DT_NEEDED names.
  postFixup = ''
    patchelf --add-rpath ${lib.makeLibraryPath windowLibs} $out/bin/edwin
  '';
  # The installed link is edwinclient by its name: its own version, and with no edwind one line and status 1.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/edwin --version | grep -q '^edwin '
    $out/bin/edwinclient --version | grep -q '^edwinclient '
    status=0
    env -u EDWIN_SOCKET -u XDG_RUNTIME_DIR $out/bin/edwinclient a.txt 2>"$TMPDIR/err" || status=$?
    test "$status" = 1
    grep -q '^edwinclient: no edwind to attach to' "$TMPDIR/err"
    runHook postInstallCheck
  '';

  meta = {
    description = "Edwin on the desktop: a terminal editor and $EDITOR, a window, and a daemon whose frames edwinclient opens";
    mainProgram = "edwin";
    platforms = [ "x86_64-linux" ];
  };
}
