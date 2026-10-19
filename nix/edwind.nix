# edwind, the text daemon: Edwin's core, Scheme files and the server (R15.3), and the wrapper with the Node
# flags of R14.11. R14.12's permission model is not among them: Node disables fsync under it, which the journal
# and atomic save need (R8.3, R8.7); edwind guards child_process in-process instead (README.md, E1).
# No --stack-size: main.mts runs the server on a worker thread whose stack it sizes for the Scheme cap.
# No --frozen-intrinsics: it slowed the Scheme evaluator 2.3 times; each thread runs lockdown.mts instead.
# The edwin package installs it (edwin --daemon), and so may any package that runs edwind as a service.
{
  lib,
  stdenv,
  nodejs,
}:
let
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      (lib.fileset.difference ../src (lib.fileset.fileFilter (f: f.hasExt "js") ../src))
      ../scm
      ../server
    ];
  };
in
stdenv.mkDerivation {
  pname = "edwind";
  version = "0.1.0";
  inherit src;
  # edwind's identity for welcome.build (R15.14): the hash part of the store path of what bin/edwind runs.
  passthru.build = builtins.substring 11 32 (toString src);
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    mkdir -p $out/share/edwin $out/bin
    cp -r src scm server $out/share/edwin/
    # The core runs as classic scripts through vm, which cannot strip types: each .ts gets its .js beside it.
    chmod -R u+w $out/share/edwin/src
    ${nodejs}/bin/node ${../tools/strip.mts} --in-place $out/share/edwin/src
    cat > $out/bin/edwind <<EOF
    #!${stdenv.shell}
    : "\''${EDWIND_MEMORY_MIB:=1024}"
    export EDWIND_BUILD=${builtins.substring 11 32 (toString src)}
    exec ${nodejs}/bin/node --disallow-code-generation-from-strings \
      --no-warnings=ExperimentalWarning --max-old-space-size="\$EDWIND_MEMORY_MIB" \
      $out/share/edwin/server/main.mts "\$@"
    EOF
    chmod 555 $out/bin/edwind
  '';
  meta = {
    description = "edwind, Edwin's text daemon: shared buffers and the Lisp machine for every edwin";
    mainProgram = "edwind";
    platforms = lib.platforms.linux;
  };
}
