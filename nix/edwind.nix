# edwind, the text daemon: Edwin's core, Scheme files and the server (R15.3), and the wrapper with the Node
# flags of R14.11. R14.12's permission model is not among them: Node disables fsync under it, which the journal
# and atomic save need (R8.3, R8.7); edwind guards child_process in-process instead (docs/steps.md, E1).
# No --stack-size: main.mts runs the server on a worker thread whose stack it sizes for the Scheme cap.
# No --frozen-intrinsics: it slowed the Scheme evaluator 2.3 times; each thread runs lockdown.mts instead.
# The edwin package installs it (edwin --daemon), and so may any package that runs edwind as a service.
# server/node_modules is edwind-deps (pi-ai for the model layer), linked in, never the checkout's own.
{
  lib,
  stdenv,
  nodejs,
  callPackage,
}:
let
  deps = callPackage ./edwind-deps.nix { };
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      (lib.fileset.difference ../src (lib.fileset.fileFilter (f: f.hasExt "js") ../src))
      ../scm
      (lib.fileset.difference ../server (lib.fileset.maybeMissing ../server/node_modules))
    ];
  };
in
stdenv.mkDerivation {
  pname = "edwind";
  version = "0.1.0";
  inherit src;
  # edwind's identity for welcome.build (R15.14): the hash part of the store path of what bin/edwind runs.
  passthru.build = builtins.substring 11 32 (toString src);
  passthru.deps = deps;
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    mkdir -p $out/share/edwin $out/bin
    cp -r src scm server $out/share/edwin/
    ln -s ${deps}/node_modules $out/share/edwin/server/node_modules
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
    # edwin-front (server/front.mts): edwin-web and /edit on an origin of its own, for services.edwind.front.
    cat > $out/bin/edwin-front <<EOF
    #!${stdenv.shell}
    exec ${nodejs}/bin/node --disallow-code-generation-from-strings \
      --no-warnings=ExperimentalWarning $out/share/edwin/server/front.mts "\$@"
    EOF
    chmod 555 $out/bin/edwin-front
  '';
  meta = {
    description = "edwind, Edwin's text daemon: shared buffers and the Lisp machine for every Edwin frame";
    mainProgram = "edwind";
    platforms = lib.platforms.linux;
  };
}
