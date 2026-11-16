/* Unified diffs as files and hunks, and the partial patches staging applies (docs/steps.md, "Diffs as files and
   hunks"). VcDiff.parse reads the text `git diff` (or `jj diff --git`) prints; VcDiff.patch builds from the
   files, hunks and lines a user picks the patch `git apply` takes: `git apply --cached` stages it, `git apply
   --cached --reverse` unstages it and `git apply --reverse` discards it from the work tree. Pure text: nothing
   here runs a process.

   git is run for a diff with VcDiff.gitArgs as well as the runner's own switches (src/vc.ts), so the user's
   configuration cannot change its shape: no colour, the a/ and b/ prefixes (diff.noprefix and
   diff.mnemonicPrefix would change them), paths from the root (diff.relative), three lines of context
   (diff.context = 0 would leave patches git apply refuses) and hunks joined only where git joins them by
   default (diff.interHunkContext). An empty context line
   (diff.suppressBlankEmpty) is read as the context line it is, and a quoted path (core.quotePath) unquoted.

   A hunk is read by the line counts of its @@ header, never by what its lines look like: a removed line whose
   text is `-- x` prints as `--- x`, and a line of a file can read `diff --git` or `@@`.

   A partial patch carries only content. A file's rename, copy, mode change and deletion go with it only when
   everything of the file is picked, and then the file's part of the diff is given as git printed it. A partial
   pick of a new file, staged, still creates it (there is nothing to stage its lines into otherwise); unstaged, it
   stays in the index with the lines not picked. A deleted file the other way round. */
(function () {
'use strict';
const L = globalThis.L;
const { signal } = L;

/* After `git diff` and its runner's switches, before any revision or path. */
const gitArgs = ['--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--unified=3', '--inter-hunk-context=0'];

/* ---------- paths ---------- */
const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/* The name C-quoted (git's quote_c_style) at S[I], the opening quote, its escaped bytes read as UTF-8, and
   the index just past the closing quote; null when S has no well-formed quoted name there. */
function unquoteAt(s: string, i: number): [string, number] | null {
  let out = '', bytes: number[] = [];
  for (i++; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      /* the escaped bytes before C are read together: one character can be several */
      if (bytes.length) { out += utf8(bytes); bytes = []; }
      if (c === '"') return [out, i + 1];
      out += c;
      continue;
    }
    const n = s[++i];
    if (n in ESC) bytes.push(ESC[n]);
    else if (/^[0-3][0-7][0-7]$/.test(s.substr(i, 3))) { bytes.push(parseInt(s.substr(i, 3), 8)); i += 2; }
    else return null;
  }
  return null;
}
/* Set when a name of the file being read is not UTF-8: it is shown one character per byte, which written back
   would name another file. */
let notUtf8 = false;
function utf8(bytes: number[]): string {
  try { return decodeURIComponent(bytes.map(b => '%' + b.toString(16).padStart(2, '0')).join('')); }
  catch (e) { notUtf8 = true; return String.fromCharCode(...bytes); }
}
/* A name as git apply reads it: C-quoted when it has a quote, a backslash, a control character or a space (git
   apply would read a name with a space on a ---/+++ line as a name and a date). */
function quote(name: string): string {
  if (!/["\\\x00-\x20\x7f]/.test(name)) return name;
  return '"' + name.replace(/["\\\x00-\x1f\x7f]/g, c => {
    const k = Object.keys(ESC).find(x => ESC[x] === c.charCodeAt(0));
    return '\\' + (k || c.charCodeAt(0).toString(8).padStart(3, '0'));
  }) + '"';
}
/* A path without its prefix (a/, b/, or any other one component): git's names carry one. */
const unprefix = (p: string) => p.slice(p.indexOf('/') + 1);

/* The name a header line gives after its keyword: quoted or the rest of the line. */
function nameOf(rest: string, lineNo: number): string {
  if (!rest.startsWith('"')) return rest;
  const q = unquoteAt(rest, 0);
  if (!q || q[1] !== rest.length) malformed(lineNo, 'a quoted name');
  return q![0];
}
/* The name on a ---/+++ line: null for /dev/null; a name with a space is followed by a tab, which goes. */
function sideName(rest: string, lineNo: number): string | null {
  if (rest === '/dev/null') return null;
  if (rest.startsWith('"')) {
    const q = unquoteAt(rest, 0);
    if (!q || rest.slice(q[1]).replace(/^\t.*/, '') !== '') malformed(lineNo, 'a quoted name');
    return unprefix(q![0]);
  }
  return unprefix(rest.replace(/\t$/, ''));
}
/* The two names on a `diff --git A B` line, unprefixed. Unquoted names with spaces are ambiguous: the split is
   where the two agree, as they do but for a rename or copy (whose own lines name the files). */
function gitLineNames(rest: string, lineNo: number): [string, string] {
  if (rest.startsWith('"')) {
    const q = unquoteAt(rest, 0);
    if (!q || rest[q[1]] !== ' ') malformed(lineNo, 'two names');
    return [unprefix(q![0]), unprefix(nameOf(rest.slice(q![1] + 1), lineNo))];
  }
  const qi = rest.indexOf(' "');
  if (qi >= 0) return [unprefix(rest.slice(0, qi)), unprefix(nameOf(rest.slice(qi + 1), lineNo))];
  const spaces: number[] = [];
  for (let i = rest.indexOf(' '); i >= 0; i = rest.indexOf(' ', i + 1)) {
    const a = unprefix(rest.slice(0, i)), b = unprefix(rest.slice(i + 1));
    if (a === b) return [a, b];
    spaces.push(i);
  }
  /* different names with no space in them: a rename, whose names its own lines give as well */
  if (spaces.length !== 1) malformed(lineNo, 'two names');
  return [unprefix(rest.slice(0, spaces[0])), unprefix(rest.slice(spaces[0] + 1))];
}

function malformed(lineNo: number, what: string): never {
  return signal('error', `Not a diff git gives: line ${lineNo + 1} should have ${what}`) as never;
}

/* ---------- parsing ---------- */
const FILE_START = /^(diff --git |diff --cc |diff --combined |\* Unmerged path )/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/* TEXT, a unified diff as git prints it, as its files in order. Signals error when it is not one. */
function parse(text: string): VcDiffFile[] {
  if (typeof text !== 'string') signal('wrong-type-argument', 'VcDiff.parse needs the diff\'s text');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const files: VcDiffFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i, first = lines[i];
    notUtf8 = false;
    if (!FILE_START.test(first)) malformed(i, 'a file\'s `diff --git` line');
    const f: VcDiffFile = { oldPath: null, newPath: null, status: 'modified', oldMode: null, newMode: null, binary: false, notUtf8: false, header: [first], hunks: [], text: '' };
    if (first.startsWith('* Unmerged path ')) {
      f.status = 'unmerged'; f.oldPath = f.newPath = nameOf(first.slice(16), i);
      i++;
    } else if (!first.startsWith('diff --git ')) {
      /* a combined diff of a conflicted path: shown, never applied, so its hunks are not read */
      f.status = 'unmerged'; f.oldPath = f.newPath = nameOf(first.replace(/^diff --(cc|combined) /, ''), i);
      for (i++; i < lines.length && !FILE_START.test(lines[i]); i++) f.header.push(lines[i]);
    } else {
      i = parseGitFile(lines, i, f);
    }
    f.text = lines.slice(start, i).join('\n') + '\n';
    f.notUtf8 = notUtf8;
    files.push(f);
  }
  return files;
}

function parseGitFile(lines: string[], i: number, f: VcDiffFile): number {
  const at = i;
  let minus: string | null | undefined, plus: string | null | undefined, renameFrom = '', renameTo = '', copy = false, added = false, deleted = false;
  for (i++; i < lines.length && !FILE_START.test(lines[i]) && !lines[i].startsWith('@@ '); i++) {
    const l = lines[i];
    f.header.push(l);
    let m: RegExpExecArray | null;
    if (l.startsWith('--- ')) minus = sideName(l.slice(4), i);
    else if (l.startsWith('+++ ')) plus = sideName(l.slice(4), i);
    else if ((m = /^(rename|copy) from (.*)$/.exec(l))) { renameFrom = nameOf(m[2], i); copy = m[1] === 'copy'; }
    else if ((m = /^(?:rename|copy) to (.*)$/.exec(l))) renameTo = nameOf(m[1], i);
    else if ((m = /^new file mode (\d+)$/.exec(l))) { added = true; f.newMode = m[1]; }
    else if ((m = /^deleted file mode (\d+)$/.exec(l))) { deleted = true; f.oldMode = m[1]; }
    else if ((m = /^old mode (\d+)$/.exec(l))) f.oldMode = m[1];
    else if ((m = /^new mode (\d+)$/.exec(l))) f.newMode = m[1];
    else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d+)$/.exec(l))) f.oldMode = f.newMode = m[1];
    else if (l.startsWith('Binary files ') || l === 'GIT binary patch') {
      f.binary = true;
      /* the binary patch's data: base85 lines and blank ones, none of which can read `diff ` */
      for (i++; i < lines.length && !FILE_START.test(lines[i]); i++) f.header.push(lines[i]);
      break;
    }
  }
  if (minus === undefined && plus === undefined) {
    /* no ---/+++: no hunk (a mode change, a pure rename, an empty file added or deleted, a binary file). The
       `diff --git` line names the file only where nothing else does: with spaces, a rename's is ambiguous */
    const [a, b] = renameFrom && renameTo ? [renameFrom, renameTo] : gitLineNames(lines[at].slice(11), at);
    f.oldPath = added ? null : a;
    f.newPath = deleted ? null : b;
  } else {
    if (minus === undefined || plus === undefined) malformed(i, 'both a --- and a +++ line');
    f.oldPath = minus!; f.newPath = plus!;
  }
  f.status = f.oldPath === null ? 'added' : f.newPath === null ? 'deleted' : renameFrom ? (copy ? 'copied' : 'renamed') : 'modified';
  while (i < lines.length && lines[i].startsWith('@@ ')) {
    const m = HUNK.exec(lines[i]);
    if (!m) malformed(i, 'a hunk header @@ -l,s +l,s @@');
    const at = i, h: VcDiffHunk = { header: lines[i], oldStart: +m![1], oldLines: m![2] === undefined ? 1 : +m![2], newStart: +m![3], newLines: m![4] === undefined ? 1 : +m![4], lines: [] };
    let o = 0, n = 0;
    for (i++; o < h.oldLines || n < h.newLines; i++) {
      if (i >= lines.length) malformed(i, `the rest of the hunk at line ${at + 1}`);
      const l = lines[i], c = l[0];
      if (l === '' || c === ' ') { o++; n++; h.lines.push(l || ' '); }
      else if (c === '-') { o++; h.lines.push(l); }
      else if (c === '+') { n++; h.lines.push(l); }
      else if (c === '\\') h.lines.push(l);
      else malformed(i, 'a line of the hunk');
      if (o > h.oldLines || n > h.newLines) malformed(i, 'no more lines than its hunk header counts');
    }
    if (i < lines.length && lines[i][0] === '\\') h.lines.push(lines[i++]);
    f.hunks.push(h);
  }
  if (f.hunks.length && minus === undefined) malformed(i, 'a --- and a +++ line before its hunks');
  if (i < lines.length && !FILE_START.test(lines[i])) malformed(i, 'a hunk or the next file');
  return i;
}

/* ---------- partial patches ---------- */
/* What is picked of one file: the whole of it, or hunks by index, each whole or by its line indices. */
type FilePick = true | Map<number, true | Set<number>>;

function picksByFile(files: VcDiffFile[], picks: VcDiffPick[]): Map<number, FilePick> {
  const out = new Map<number, FilePick>();
  const isIndex = (x: unknown, n: number) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n;
  for (const p of picks) {
    if (!p || !isIndex(p.file, files.length)) signal('args-out-of-range', 'VcDiff.patch: no such file', [p && p.file]);
    const f = files[p.file];
    if (p.hunk === undefined) { out.set(p.file, true); continue; }
    if (!isIndex(p.hunk, f.hunks.length)) signal('args-out-of-range', 'VcDiff.patch: no such hunk', [p.hunk]);
    let fp = out.get(p.file);
    if (fp === true) continue;
    if (!fp) out.set(p.file, fp = new Map());
    if (p.lines === undefined) { fp.set(p.hunk!, true); continue; }
    const n = f.hunks[p.hunk!].lines.length;
    if (!Array.isArray(p.lines) || !p.lines.every(x => isIndex(x, n))) signal('args-out-of-range', 'VcDiff.patch: no such line', [p.lines]);
    let hp = fp.get(p.hunk!);
    if (hp === true) continue;
    if (!hp) fp.set(p.hunk!, hp = new Set());
    for (const x of p.lines!) hp.add(x);
  }
  return out;
}

/* Whether a file pick takes every change of the file: then it is the whole file. */
function complete(f: VcDiffFile, fp: FilePick): boolean {
  if (fp === true) return true;
  return f.hunks.every((h, k) => {
    const hp = fp.get(k);
    return hp === true || !!hp && h.lines.every((l, x) => (l[0] !== '-' && l[0] !== '+') || hp.has(x));
  });
}

/* The hunks of F that PICK takes, for a patch applied forwards or, REVERSE, with --reverse. Forwards (staging) a
   change not picked stays as it is before: a removed line becomes context, an added one goes. Reversed
   (unstaging, discarding) it stays as it is after: an added line becomes context, a removed one goes. The side
   the patch is applied to keeps every line, so its starts stand; the other side's starts move by what the hunks
   before give or take. Signals user-error when the pick leaves a line with no newline before another one. */
function hunks(f: VcDiffFile, pick: Map<number, true | Set<number>>, reverse: boolean): string[] {
  const out: string[] = [];
  let delta = 0;
  f.hunks.forEach((h, k) => {
    const hp = pick.get(k);
    if (!hp) return;
    const body: string[] = [];
    let o = 0, n = 0, any = false, kept = false;
    h.lines.forEach((l, x) => {
      const c = l[0];
      if (c === '\\') { if (kept) body.push(l); return; }
      kept = true;
      if (c === ' ') { o++; n++; body.push(l); }
      else if (hp === true || hp.has(x)) { any = true; if (c === '-') o++; else n++; body.push(l); }
      else if (c === (reverse ? '+' : '-')) { o++; n++; body.push(' ' + l.slice(1)); }
      else kept = false;
    });
    if (!any) return;
    /* A line marked with no newline must be the last of its side. */
    body.forEach((l, x) => {
      if (body[x + 1] === undefined || body[x + 1][0] !== '\\') return;
      const sides = l[0] === ' ' ? ' -+' : l[0] === '-' ? ' -' : ' +';
      if (body.slice(x + 2).some(m => sides.includes(m[0])))
        signal('user-error', `${f.newPath ?? f.oldPath}: this pick leaves a line with no newline before another; pick the change to the last line as well`);
    });
    let oldStart = h.oldStart, newStart = h.newStart;
    if (reverse) {
      const before = (h.newLines ? h.newStart - 1 : h.newStart) - delta;
      oldStart = o ? before + 1 : before;
    } else {
      const before = (h.oldLines ? h.oldStart - 1 : h.oldStart) + delta;
      newStart = n ? before + 1 : before;
    }
    delta += n - o;
    out.push(`@@ -${oldStart},${o} +${newStart},${n} @@`, ...body);
  });
  return out;
}

/* The header of a partial patch of F: content only, on the path the patch is applied to. A new file staged in
   part is still created, a deleted one unstaged in part still restored; a rename, copy or mode change is not
   carried. */
function partialHeader(f: VcDiffFile, reverse: boolean): string[] {
  if (f.notUtf8) signal('user-error', `${f.newPath ?? f.oldPath}: a name that is not UTF-8 can be picked only with the whole file`);
  if (f.status === 'copied' && !reverse)
    signal('user-error', `${f.newPath}: a copy's changes can be staged only with the whole file`);
  const p = (reverse ? f.newPath ?? f.oldPath : f.oldPath ?? f.newPath)!, a = quote('a/' + p), b = quote('b/' + p);
  const creates = !reverse && f.status === 'added', restores = reverse && f.status === 'deleted';
  return [`diff --git ${a} ${b}`,
    ...creates ? [`new file mode ${f.newMode}`] : restores ? [`deleted file mode ${f.oldMode}`] : [],
    `--- ${creates ? '/dev/null' : a}`, `+++ ${restores ? '/dev/null' : b}`];
}

/* The patch for PICKS of FILES (each {file} for a whole file, {file, hunk} for a hunk, {file, hunk, lines} for
   lines of it by their index in hunk.lines; context lines picked mean nothing), to be applied forwards or,
   REVERSE, with --reverse. Null when nothing is picked. */
function patch(files: VcDiffFile[], picks: VcDiffPick[], reverse = false): string | null {
  if (!Array.isArray(files) || !Array.isArray(picks)) signal('wrong-type-argument', 'VcDiff.patch needs the files and the picks');
  const out: string[] = [];
  for (const [k, fp] of [...picksByFile(files, picks)].sort((x, y) => x[0] - y[0])) {
    const f = files[k];
    if (complete(f, fp)) {
      if (f.status === 'unmerged') signal('user-error', `${f.newPath}: a conflicted file has no patch to apply`);
      if (f.binary && !f.header.includes('GIT binary patch')) signal('user-error', `${f.newPath ?? f.oldPath}: a binary file needs its diff taken with --binary`);
      out.push(f.text);
      continue;
    }
    const body = hunks(f, fp as Map<number, true | Set<number>>, reverse);
    if (body.length) out.push([...partialHeader(f, reverse), ...body].join('\n') + '\n');
  }
  return out.length ? out.join('') : null;
}

globalThis.VcDiff = { gitArgs, parse, patch };
})();
