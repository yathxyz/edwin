# edwind's runtime dependencies: pi-ai, the wire layer of server/models.mts, pinned in server/package-lock.json
# and installed from the lock with no scripts. edwind's package and the check tree link it as server/node_modules.
{
  lib,
  stdenv,
  nodejs,
  importNpmLock,
}:
stdenv.mkDerivation {
  pname = "edwind-deps";
  version = (lib.importJSON ../server/package.json).version;
  src = lib.fileset.toSource {
    root = ../server;
    fileset = lib.fileset.unions [
      ../server/package.json
      ../server/package-lock.json
    ];
  };
  npmDeps = importNpmLock {
    package = lib.importJSON ../server/package.json;
    packageLock = lib.importJSON ../server/package-lock.json;
  };
  npmFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
  ];
  dontBuild = true;
  installPhase = ''
    mkdir -p $out
    cp -r node_modules $out/
  '';
}
