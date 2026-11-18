# The grammar bundle (nix/grammars.nix, `edwin-grammars`): python3 test/grammars.py BUNDLE PROG_SCM.
# Every mode scm/prog.scm declares has exactly one grammar, the Lisp modes aside (LISP_MODES: Edwin's own Lisp lexer
# reads them, src/editor-core.ts lispDialect); each grammar's parser.so loads, exports the manifest's
# symbol and gives a language tree-sitter accepts (its ABI version in range); each query file the manifest lists
# is there, nothing else is, and each compiles against its grammar. Prints one line per language.
import ctypes
import json
import os
import re
import sys
from pathlib import Path

import tree_sitter as ts

bundle, prog = sys.argv[1], sys.argv[2]
failures = []


def fail(msg):
    failures.append(msg)
    print("FAIL", msg)


manifest = json.loads(Path(bundle, "grammars.json").read_text())
LISP_MODES = {"emacs-lisp-mode", "lisp-mode", "clojure-mode", "racket-mode"}
declared = re.findall(r"^\(define-language (\S+) ", Path(prog).read_text(), re.M)
modes = [m for m in declared if m not in LISP_MODES]
if not modes:
    fail(f"no define-language in {prog}")
by_mode = {}
for name, m in manifest.items():
    by_mode.setdefault(m["mode"], []).append(name)
for mode in modes:
    if len(by_mode.get(mode, [])) != 1:
        fail(f"{mode}: {len(by_mode.get(mode, []))} grammars, not 1")
for mode in by_mode:
    if mode not in modes:
        fail(f"{mode}: in the bundle but not declared in {prog}")
entries = sorted(os.listdir(bundle))
if entries != sorted([*manifest, "grammars.json"]):
    fail(f"the bundle holds {entries}, the manifest names {sorted(manifest)}")

capsule_new = ctypes.pythonapi.PyCapsule_New
capsule_new.restype = ctypes.py_object
capsule_new.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p]

patterns = 0
for name, m in sorted(manifest.items()):
    if m["symbol"] != f"tree_sitter_{name}":
        fail(f"{name}: symbol {m['symbol']}")
        continue
    if "highlights" not in m["queries"]:
        fail(f"{name}: no highlights query")
    try:
        entry = getattr(ctypes.CDLL(os.path.join(bundle, name, "parser.so")), m["symbol"])
        entry.restype = ctypes.c_void_p
        lang = ts.Language(capsule_new(entry(), b"tree_sitter.Language", None))
    except Exception as e:
        fail(f"{name}: the grammar does not load: {e}")
        continue
    qdir = os.path.join(bundle, name, "queries")
    files = sorted(os.listdir(qdir))
    if files != sorted(f"{k}.scm" for k in m["queries"]):
        fail(f"{name}: queries/ holds {files}, the manifest names {m['queries']}")
    counts = []
    for kind in m["queries"]:
        try:
            q = ts.Query(lang, Path(qdir, f"{kind}.scm").read_text())
        except Exception as e:
            fail(f"{name}: {kind}.scm does not compile: {e}")
            continue
        if q.pattern_count == 0:
            fail(f"{name}: {kind}.scm has no patterns")
        patterns += q.pattern_count
        counts.append(f"{kind} {q.pattern_count}")
    print(f"{name:11} {m['mode']:16} abi {lang.abi_version}  {', '.join(counts)}")

print(f"{len(manifest)} grammars for {len(modes)} declared modes, {patterns} query patterns")
if failures:
    sys.exit(f"{len(failures)} failures")
