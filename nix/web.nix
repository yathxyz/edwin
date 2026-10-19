# The frame runtime a web page serves (edwind spec R9.19): the console page as index.html, the core's .ts stripped to
# src/*.js (tools/strip.mts), and the Scheme sources under scm/, which the runtime fetches as text/plain. Workbench
# serves this tree at /edwin/.
{
  lib,
  runCommand,
  nodejs,
}:
let
  src = lib.fileset.toSource {
    root = ../src;
    fileset = lib.fileset.fileFilter (f: f.hasExt "ts" && !lib.hasSuffix ".d.ts" f.name) ../src;
  };
  scm = lib.fileset.toSource {
    root = ../scm;
    fileset = lib.fileset.fileFilter (f: f.hasExt "scm") ../scm;
  };
in
runCommand "edwin-web" { nativeBuildInputs = [ nodejs ]; } ''
  install -Dm444 ${../console/index.html} $out/index.html
  node ${../tools/strip.mts} $out/src ${src}/*.ts
  install -Dm444 -t $out/scm ${scm}/*.scm
''
