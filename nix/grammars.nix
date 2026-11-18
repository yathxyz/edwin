# edwin-grammars: a tree-sitter grammar for each language scm/prog.scm declares, in one directory the edwin package
# links as share/edwin/grammars. For each language NAME: NAME/parser.so, the grammar's library (loaded with dlopen,
# its entry point the manifest's `symbol`), and NAME/queries/KIND.scm for the standard query kinds it has
# (highlights, injections, locals, tags). grammars.json maps each NAME to its mode, symbol, query kinds and source.
#
# The grammars are nixpkgs' (tree-sitter.builtGrammars) with their own queries, composed as each grammar's
# tree-sitter.json lists them, the highlights with the language they build on first (C++ is C's highlights then
# its own; TypeScript is JavaScript's then its own, TSX JavaScript's, JSX's and TypeScript's), since of two
# patterns capturing one node the later wins (src/syntax.ts) and a language's own patterns are its specific ones. HCL (the Terraform mode) and GDScript ship no queries: both come from Helix, the grammar at
# the revision Helix's queries are written for and the queries from Helix's runtime. The indents queries are
# Edwin's own (nix/indents, the capture names src/syntax.ts reads), for Rust, Go, C, JSON, JavaScript, TypeScript,
# TSX and Python: JavaScript's then JSX's for JavaScript, and TypeScript's after JavaScript's (and JSX's for TSX). The
# edwin-grammars check loads every library and compiles every query file against it.
{
  lib,
  runCommand,
  tree-sitter,
  helix,
  helix-unwrapped,
}:
let
  g = tree-sitter.builtGrammars;
  hx = helix.passthru.tree-sitter-grammars;
  hxQueries = "${helix-unwrapped.src}/runtime/queries";
  js = "${g.tree-sitter-javascript}/queries";
  ts = "${g.tree-sitter-typescript.src}/queries";
  # NAME is the directory and the C entry point's suffix (tree_sitter_NAME); MODE the scm/prog.scm mode; QUERIES
  # each kind's files, in order.
  lang = name: mode: grammar: source: queries: { inherit name mode grammar source queries; };
  fromNixpkgs = name: mode: grammar: lang name mode grammar "nixpkgs ${grammar.pname} ${grammar.version}";
  fromHelix =
    name: mode: grammar:
    lang name mode grammar "helix ${helix-unwrapped.version}: ${grammar.name} and runtime/queries";
  # A grammar's own query files: KIND from DIR/KIND.scm.
  own = dir: kinds: lib.genAttrs kinds (k: [ "${dir}/${k}.scm" ]);
  queriesOf = grammar: own "${grammar}/queries";
  # The indents query (src/syntax.ts), Edwin's own, from nix/indents: the files named, in order.
  indents = files: { indents = map (f: ./indents + "/${f}.scm") files; };
  languages = [
    (fromNixpkgs "rust" "rust-mode" g.tree-sitter-rust (queriesOf g.tree-sitter-rust [ "highlights" "injections" "tags" ] // indents [ "rust" ]))
    # Its locals.scm is comments only: upstream keeps no locals for Nix.
    (fromNixpkgs "nix" "nix-mode" g.tree-sitter-nix (queriesOf g.tree-sitter-nix [ "highlights" "injections" "tags" ]))
    (fromNixpkgs "go" "go-mode" g.tree-sitter-go (queriesOf g.tree-sitter-go [ "highlights" "tags" ] // indents [ "go" ]))
    (fromNixpkgs "c" "c-mode" g.tree-sitter-c (queriesOf g.tree-sitter-c [ "highlights" "tags" ] // indents [ "c" ]))
    (fromNixpkgs "cpp" "c++-mode" g.tree-sitter-cpp (queriesOf g.tree-sitter-cpp [ "injections" "tags" ] // {
      highlights = [ "${g.tree-sitter-c}/queries/highlights.scm" "${g.tree-sitter-cpp}/queries/highlights.scm" ];
    }))
    (fromNixpkgs "java" "java-mode" g.tree-sitter-java (queriesOf g.tree-sitter-java [ "highlights" "tags" ]))
    (fromNixpkgs "c_sharp" "csharp-mode" g.tree-sitter-c-sharp (queriesOf g.tree-sitter-c-sharp [ "highlights" "tags" ]))
    (fromNixpkgs "python" "python-mode" g.tree-sitter-python (queriesOf g.tree-sitter-python [ "highlights" "tags" ] // indents [ "python" ]))
    (fromNixpkgs "javascript" "js-mode" g.tree-sitter-javascript (own js [ "injections" "locals" "tags" ] // {
      highlights = [ "${js}/highlights.scm" "${js}/highlights-jsx.scm" "${js}/highlights-params.scm" ];
    } // indents [ "javascript" "jsx" ]))
    (fromNixpkgs "typescript" "typescript-mode" g.tree-sitter-typescript ({
      highlights = [ "${js}/highlights.scm" "${ts}/highlights.scm" ];
      injections = [ "${js}/injections.scm" ];
      locals = [ "${ts}/locals.scm" "${js}/locals.scm" ];
      tags = [ "${ts}/tags.scm" "${js}/tags.scm" ];
    } // indents [ "javascript" "typescript" ]))
    (fromNixpkgs "tsx" "tsx-mode" g.tree-sitter-tsx ({
      highlights = [ "${js}/highlights.scm" "${js}/highlights-jsx.scm" "${ts}/highlights.scm" ];
      injections = [ "${js}/injections.scm" ];
      locals = [ "${js}/locals.scm" ];
      tags = [ "${ts}/tags.scm" "${js}/tags.scm" ];
    } // indents [ "javascript" "jsx" "typescript" ]))
    (fromNixpkgs "json" "json-mode" g.tree-sitter-json (queriesOf g.tree-sitter-json [ "highlights" ] // indents [ "json" ]))
    (fromNixpkgs "yaml" "yaml-mode" g.tree-sitter-yaml (queriesOf g.tree-sitter-yaml [ "highlights" ]))
    (fromNixpkgs "toml" "toml-mode" g.tree-sitter-toml (queriesOf g.tree-sitter-toml [ "highlights" ]))
    (fromNixpkgs "bash" "sh-mode" g.tree-sitter-bash (queriesOf g.tree-sitter-bash [ "highlights" ]))
    (fromHelix "hcl" "terraform-mode" hx.tree-sitter-hcl (own "${hxQueries}/hcl" [ "highlights" "injections" ]))
    # Helix's gdscript tags.scm names nodes its grammar lacks (it compiles against neither revision): left out.
    (fromHelix "gdscript" "gdscript-mode" hx.tree-sitter-gdscript (own "${hxQueries}/gdscript" [ "highlights" "injections" ]))
    # just's tree-sitter.json names queries-src; queries/just is the copy for Neovim.
    (fromNixpkgs "just" "just-mode" g.tree-sitter-just (own "${g.tree-sitter-just.src}/queries-src" [ "highlights" "injections" "locals" ]))
    (fromNixpkgs "meson" "meson-mode" g.tree-sitter-meson (queriesOf g.tree-sitter-meson [ "highlights" ]))
    (fromNixpkgs "nasm" "nasm-mode" g.tree-sitter-nasm (queriesOf g.tree-sitter-nasm [ "highlights" "injections" ]))
    (fromNixpkgs "nginx" "nginx-mode" g.tree-sitter-nginx (queriesOf g.tree-sitter-nginx [ "highlights" "injections" ]))
    (fromNixpkgs "typst" "typst-mode" g.tree-sitter-typst (own "${g.tree-sitter-typst}/queries/typst" [ "highlights" "injections" ]))
  ];
  manifest = lib.listToAttrs (
    map (l: {
      inherit (l) name;
      value = {
        inherit (l) mode source;
        symbol = "tree_sitter_${l.name}";
        queries = lib.attrNames l.queries;
      };
    }) languages
  );
  # Each file of a kind in its order, a newline after each so the last line of one never joins the next.
  install =
    l:
    ''
      mkdir -p $out/${l.name}/queries
      ln -s ${l.grammar}/parser $out/${l.name}/parser.so
    ''
    + lib.concatStrings (
      lib.mapAttrsToList (kind: files: ''
        for f in ${lib.escapeShellArgs files}; do cat "$f"; echo; done > $out/${l.name}/queries/${kind}.scm
      '') l.queries
    );
in
runCommand "edwin-grammars"
  {
    passAsFile = [ "manifest" ];
    manifest = builtins.toJSON manifest;
  }
  ''
    mkdir $out
    ${lib.concatMapStrings install languages}
    cp "$manifestPath" $out/grammars.json
  ''
