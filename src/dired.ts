/* Dired for Edwin: a directory as a buffer, and find-file reading a path. A listing is a read-only buffer in
   Motion state, one line per name with its mode, size and time; RET visits a file or enters a directory, - goes
   up, and the marks (m, d) choose what D, R and C act on. Deletes are permanent and nothing is ever overwritten.
   The files are those of a backend: edwind's commands fs-list, fs-stat, fs-delete, fs-copy, fs-mkdir and
   rename-file in served mode (server/fs.mts, with its refusals). A browser that keeps its files in its own
   storage has no directories: there find-file offers the recent files as before. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks;
const { intern, signal, CMD } = L;
const cur = () => E.current;
const { lineNoB, lineStartB } = Ed;

/* One name of a directory, as fs-list gives it: dir is set on a link that leads to a directory. */
interface DiredEntry { name: string; kind: 'dir' | 'file' | 'link' | 'other'; size: number; mtime: number; mode: number; target?: string; dir?: boolean }
interface DiredListing { dir: string; home: string; entries: DiredEntry[]; truncated?: boolean }
/* Where the files are. A path is absolute or starts with ~/. resolve says whether PATH is a directory and the
   name Ed.visit takes for it (edwind's buffer id). remove answers false for a directory that is not empty and
   was left alone; rename and copy put the source inside DST when DST is a directory. */
interface DiredFs {
  list(dir: string | null): Promise<DiredListing>;
  resolve(path: string): Promise<{ dir: boolean; name: string }>;
  remove(path: string, recursive: boolean): Promise<boolean>;
  rename(src: string, dst: string): Promise<unknown>;
  copy(src: string, dst: string): Promise<unknown>;
  mkdir(path: string): Promise<unknown>;
}
/* b.dired: the directory a listing shows (its real path), its entries in the order of the lines, and the marks
   by name ('*' marked, 'D' flagged for deletion). */
interface Dired { fs: DiredFs; dir: string; home: string; entries: DiredEntry[]; marks: Map<string, string>; truncated: boolean }

const isDirEntry = (e: DiredEntry) => e.kind === 'dir' || !!e.dir;
const join = (dir: string, name: string) => (dir.endsWith('/') ? dir : dir + '/') + name;
const parentOf = (p: string) => { const i = p.lastIndexOf('/'); return i <= 0 ? (p.startsWith('/') ? '/' : p) : p.slice(0, i); };
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stripSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);
const abbr = (p: string, home: string) => (home && p === home ? '~' : home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);
const expand = (p: string, home: string) => (home && (p === '~' || p.startsWith('~/')) ? home + p.slice(1) : p);
/* A name as a line shows it: control characters would break the line. */
const shown = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '?');

/* ---------- the backends ---------- */
async function rpc(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  const r = await Ed.sync.call({ cmd, args: [a] });
  if (r.error) signal('user-error', r.error.condition === 'offline' ? 'Not connected to edwind' : r.error.report || r.error.condition);
  return r.value;
}
const SERVED: DiredFs = {
  list: dir => rpc('fs-list', dir === null ? {} : { dir }) as Promise<DiredListing>,
  resolve: p => (rpc('fs-stat', { path: p }) as Promise<{ id: string | null; entry: DiredEntry | null }>).then(r => ({ dir: !!r.entry && isDirEntry(r.entry), name: r.id || p })),
  remove: (p, recursive) => (rpc('fs-delete', { path: p, recursive }) as Promise<{ deleted: boolean }>).then(r => r.deleted),
  rename: (src, dst) => rpc('rename-file', { src, dst }),
  copy: (src, dst) => rpc('fs-copy', { src, dst }),
  mkdir: p => rpc('fs-mkdir', { path: p }),
};
/* The backend that holds PATH, or null where there are no directories: a page that keeps its files in the
   browser, and for now the desktop program, whose own files edwind does not hold. */
function fsFor(path: string | null): DiredFs | null { void path; return Ed.host.kind !== 'native' && Ed.sync && Ed.sync.started ? SERVED : null; }
const needFs = (path: string | null) => fsFor(path) || signal('user-error', Ed.host.kind === 'native' ? 'Dired does not list the desktop program\'s files yet' : 'No directories here: this Edwin keeps its files in the browser') as never;

/* ---------- the listing ---------- */
const NAME_COL = 38;
function modeString(e: DiredEntry) {
  let s = e.kind === 'dir' ? 'd' : e.kind === 'link' ? 'l' : e.kind === 'file' ? '-' : '?';
  for (let i = 8; i >= 0; i--) s += (e.mode >> i) & 1 ? 'rwx'[(8 - i) % 3] : '-';
  return s;
}
function human(n: number) {
  if (n < 1024) return String(n);
  const units = 'kMGTP'; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + units[i];
}
function stamp(ms: number) {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const lineOf = (d: Dired, e: DiredEntry) =>
  `${d.marks.get(e.name) || ' '} ${modeString(e)} ${human(e.size).padStart(7)} ${stamp(e.mtime)} ${shown(e.name)}${e.kind === 'link' && e.target !== undefined ? ' -> ' + shown(e.target) : ''}`;
/* Directories first, then by name without regard to case. */
function byName(a: DiredEntry, b: DiredEntry) {
  const da = isDirEntry(a) ? 0 : 1, db = isDirEntry(b) ? 0 : 1;
  if (da !== db) return da - db;
  const x = a.name.toLowerCase(), y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
const diredOf = (b: EdBuffer) => (b.dired as Dired | undefined) || signal('user-error', 'Not a Dired buffer') as never;
const entryAt = (b: EdBuffer): DiredEntry | undefined => (b.dired as Dired).entries[lineNoB(b, b.pt) - 2];
const needEntry = (b: EdBuffer) => entryAt(b) || signal('user-error', 'No file on this line') as never;
/* Point on the name of entry line LINE (2 is the first), kept among the entries. */
function goLine(b: EdBuffer, line: number) { const n = (b.dired as Dired).entries.length; b.pt = n ? lineStartB(b, Math.max(2, Math.min(line, n + 1))) + NAME_COL : 0; }
/* Write the lines again. Point goes to the entry named AT, else stays on its line. */
function draw(b: EdBuffer, at?: string | null) {
  const d = b.dired as Dired, line = lineNoB(b, b.pt);
  if (at === undefined) { const e = entryAt(b); at = e ? e.name : null; }
  const lines = ['  ' + abbr(d.dir, d.home) + ':'];
  for (const e of d.entries) lines.push(lineOf(d, e));
  if (d.truncated) lines.push(`  (the first ${d.entries.length} names; the directory has more)`);
  b.text = lines.join('\n') + '\n';
  b.modified = false; b.undo = []; b.redo = [];
  const i = at === null ? -1 : d.entries.findIndex(e => e.name === at);
  goLine(b, i >= 0 ? i + 2 : line);
}
function fill(b: EdBuffer, l: DiredListing) {
  const d = b.dired as Dired;
  d.dir = l.dir; d.home = l.home; d.entries = l.entries.slice().sort(byName); d.truncated = !!l.truncated;
  const names = new Set(d.entries.map(e => e.name));
  for (const n of [...d.marks.keys()]) if (!names.has(n)) d.marks.delete(n);
}
/* Show the directory PATH (null: the backend's own, the notes) in the selected window, point on AT. One buffer
   per directory, named by its path. */
async function show(path: string | null, at?: string | null): Promise<EdBuffer> {
  const fs = needFs(path), l = await fs.list(path);
  let b = E.buffers.find(x => x.dired && (x.dired as Dired).fs === fs && (x.dired as Dired).dir === l.dir);
  if (!b) {
    const name = abbr(l.dir, l.home) + (l.dir === '/' ? '' : '/');
    b = Ed.getBufferCreate(Ed.getBuffer(name) ? L.call('generate-new-buffer-name', [name]) as string : name);
    b.mode = 'dired-mode'; b.readOnly = true; b.evilState = 'motion';
    b.dired = { fs, dir: l.dir, home: l.home, entries: [], marks: new Map(), truncated: false } as Dired;
  }
  fill(b, l); draw(b, at);
  Ed.setWindowBuffer(b); Ed.scheduleRender();
  return b;
}
async function refresh(b: EdBuffer, at?: string | null) { const d = diredOf(b); fill(b, await d.fs.list(d.dir)); draw(b, at); }
/* From listing B to the directory PATH: B goes away unless another window shows it, so walking a tree leaves
   one buffer behind, not one per step. */
async function enter(b: EdBuffer, path: string, at?: string | null) {
  const nb = await show(path, at);
  if (nb !== b && E.buffers.includes(b) && !Ed.windowFor(b)) L.call('kill-buffer', [b]);
}
/* The directory of buffer B: of its listing or its file; null for the backend's own. */
function directoryOf(b: EdBuffer): string | null {
  if (b.dired) return (b.dired as Dired).dir;
  return b.file && (b.file.startsWith('/') || b.file.startsWith('~/')) ? parentOf(b.file) : null;
}

/* ---------- reading a path ---------- */
/* What the input names, as Emacs reads it: after // the path starts again at /, after /~ at ~. */
function effective(input: string) {
  let s = input;
  const i = s.lastIndexOf('//'); if (i >= 0) s = s.slice(i + 1);
  for (let j = s.lastIndexOf('/~'); j >= 0; j = s.lastIndexOf('/~', j - 1)) if (j + 2 === s.length || s[j + 2] === '/') { s = s.slice(j + 1); break; }
  return s;
}
/* Read a path in the minibuffer, starting in the directory BASE (null: the backend's own). The candidates are
   the names of the directory typed so far (directories end in /); TAB takes one, so a tree is walked a name at
   a time, and RET on a directory answers the directory. The answer is absolute; a directory may end in /. */
async function readPath(prompt: string, base: string | null, fs: DiredFs): Promise<string> {
  let first: DiredListing;
  try { first = await fs.list(base); } catch (e) { if (base === null) throw e; first = await fs.list(null); }
  const home = first.home, root = first.dir;
  const absolute = (s: string) => (s.startsWith('/') ? s : s === '~' || s.startsWith('~/') ? expand(s, home) : join(root, s));
  const dirOfInput = (input: string) => { const full = absolute(effective(input)); return full.slice(0, full.lastIndexOf('/') + 1); };
  type Names = { names: string[]; by: Map<string, DiredEntry> };
  const cache = new Map<string, Names | null>();
  const store = (dir: string, l: DiredListing | null) => {
    const es = l ? l.entries.slice().sort((a, b) => (a.name.startsWith('.') ? 1 : 0) - (b.name.startsWith('.') ? 1 : 0) || byName(a, b)) : [];
    const by = new Map<string, DiredEntry>();
    for (const e of es) by.set(isDirEntry(e) ? e.name + '/' : e.name, e);
    cache.set(dir, { names: [...by.keys()], by });
  };
  store(join(root, ''), first);
  let shownDir: Names | null = null;
  const NONE: string[] = [];
  const completer = (input: string) => {
    const dir = dirOfInput(input), m = E.mini;
    if (!cache.has(dir)) {
      cache.set(dir, null);
      fs.list(stripSlash(dir)).then(l => store(dir, l), () => store(dir, null)).then(() => { if (E.mini === m && m) { m.cache = null; Ed.scheduleRender(); } });
    }
    shownDir = cache.get(dir) || null;
    return shownDir ? shownDir.names : NONE;
  };
  const annotate = (c: string) => { const e = shownDir && shownDir.by.get(c); return e && !isDirEntry(e) ? human(e.size).padStart(7) + '  ' + stamp(e.mtime) : ''; };
  const text = await Ed.readMini(prompt, join(abbr(root, home), ''), completer, { kind: 'path', boundary: s => s.lastIndexOf('/') + 1, listOrder: true, annotate });
  return absolute(effective(text.trim()));
}
H.readFileName = prompt => { const base = directoryOf(cur()), fs = fsFor(base); return fs ? readPath(prompt, base, fs) : null; };
/* find-file on a directory shows it. A name that ends in / is one; any other is asked about unless a buffer
   already visits it, and a file is visited under the name its backend gives it. */
const failed = (e: unknown) => { Ed.reportError(e); Ed.scheduleRender(); return false; };
H.findDirectory = name => {
  const fs = fsFor(name);
  if (!fs) return null;
  if (name.length > 1 && name.endsWith('/')) return show(stripSlash(name)).catch(failed);
  if (E.buffers.some(b => b.file === name || b.id === name)) return null;
  return fs.resolve(name).then(r => (r.dir ? show(name) : Ed.visit(r.name)), () => Ed.visit(name)).catch(failed);
};

/* ---------- commands ---------- */
CMD('dired', async () => { const base = directoryOf(cur()); return [await readPath('Dired (directory): ', base, needFs(base))]; }, 'DIRNAME',
  'List the directory DIRNAME: RET opens the file at point or enters a directory, - goes up, m and d mark, D R C act on the marked files or the one at point.',
  async ([n]: SchemeValue[]) => { if (typeof n !== 'string' || !n.trim()) signal('user-error', 'No directory given'); await show(stripSlash((n as string).trim())); return false; });
CMD('dired-jump', '', '', 'List the directory of the current buffer, with point on its file.', async () => {
  const b = cur();
  if (b.dired) { await up(b); return false; }
  await show(directoryOf(b), b.file ? baseOf(b.file) : null); return false;
});
CMD('dired-find-file', '', '', 'Visit the file at point, or enter the directory (RET).', async () => {
  const b = cur(), d = diredOf(b), e = needEntry(b), p = join(d.dir, e.name);
  if (!isDirEntry(e)) return Ed.visit((await d.fs.resolve(p)).name);
  await enter(b, p); return false;
});
async function up(b: EdBuffer) { const d = diredOf(b); if (d.dir === '/') signal('user-error', 'Already at /'); await enter(b, parentOf(d.dir), baseOf(d.dir)); }
CMD('dired-up-directory', '', '', 'List the parent directory, with point on the directory left (-).', async () => { await up(cur()); return false; });
CMD('dired-revert', '', '', 'Read the directory again (g r).', async () => { await refresh(cur()); return false; });

function mark(b: EdBuffer, m: string | null) {
  const d = diredOf(b), e = needEntry(b), line = lineNoB(b, b.pt);
  if (m) d.marks.set(e.name, m); else d.marks.delete(e.name);
  draw(b); goLine(b, line + 1);
  return false;
}
CMD('dired-mark', '', '', 'Mark the file at point and move down (m).', () => mark(cur(), '*'));
CMD('dired-flag-file-deletion', '', '', 'Flag the file at point for deletion and move down (d); x deletes the flagged files.', () => mark(cur(), 'D'));
CMD('dired-unmark', '', '', 'Take the mark or flag off the file at point and move down (u).', () => mark(cur(), null));
CMD('dired-unmark-all-marks', '', '', 'Take every mark and flag off (U).', () => { const b = cur(); diredOf(b).marks.clear(); draw(b); return false; });
CMD('dired-toggle-marks', '', '', 'Mark the unmarked files and unmark the marked ones; flags stay (t).', () => {
  const b = cur(), d = diredOf(b);
  for (const e of d.entries) { const m = d.marks.get(e.name); if (m === '*') d.marks.delete(e.name); else if (!m) d.marks.set(e.name, '*'); }
  draw(b); return false;
});
/* What a command acts on: the marked files, else the one at point. */
function targets(b: EdBuffer) { const d = diredOf(b), marked = d.entries.filter(e => d.marks.get(e.name) === '*'); return marked.length ? marked : [needEntry(b)]; }
async function yesOrNo(prompt: string) {
  for (;;) {
    const ch = L.chr(await Ed.readChar(prompt + ' (y or n) '));
    if (ch === 'y' || ch === 'Y') return true;
    if (ch === 'n' || ch === 'N') return false;
    Ed.ding();
  }
}
/* Delete ES for good, after one question; a directory that is not empty takes a typed yes of its own. */
async function deleteEntries(b: EdBuffer, es: DiredEntry[]) {
  const d = diredOf(b);
  if (!await yesOrNo(es.length === 1 ? `Delete ${shown(es[0].name)}?` : `Delete ${es.length} files?`)) { Ed.message('Nothing deleted'); return false; }
  let done = 0;
  try {
    for (const e of es) {
      const p = join(d.dir, e.name);
      let gone = await d.fs.remove(p, false);
      if (!gone && (await Ed.readMini(`${shown(e.name)} is not empty. Delete it and everything in it? (yes or no) `, '')).trim() === 'yes') gone = await d.fs.remove(p, true);
      if (gone) done++;
    }
  } finally { await refresh(b); }
  Ed.message(`Deleted ${done} of ${es.length}`);
  return false;
}
CMD('dired-do-delete', '', '', 'Delete the marked files, or the file at point, for good (D).', () => deleteEntries(cur(), targets(cur())));
CMD('dired-do-flagged-delete', '', '', 'Delete the files flagged with d, for good (x).', () => {
  const b = cur(), d = diredOf(b), es = d.entries.filter(e => d.marks.get(e.name) === 'D');
  if (!es.length) signal('user-error', 'No files flagged for deletion');
  return deleteEntries(b, es);
});
/* Rename or copy the targets to a path read in the minibuffer. Several go into a directory; one takes the
   new name, or goes into the directory named. Nothing is overwritten. */
async function transfer(b: EdBuffer, verb: string, op: (fs: DiredFs, src: string, dst: string) => Promise<unknown>) {
  const d = diredOf(b), es = targets(b);
  const dst = stripSlash(await readPath(es.length === 1 ? `${verb} ${shown(es[0].name)} to: ` : `${verb} ${es.length} files to directory: `, d.dir, d.fs));
  if (es.length > 1 && !(await d.fs.resolve(dst)).dir) signal('user-error', `${abbr(dst, d.home)} is not a directory`);
  try { for (const e of es) await op(d.fs, join(d.dir, e.name), dst); }
  finally { await refresh(b, parentOf(dst) === d.dir ? baseOf(dst) : undefined); }
  Ed.message(`${verb === 'Copy' ? 'Copied' : 'Renamed'} ${es.length === 1 ? shown(es[0].name) : es.length + ' files'} to ${abbr(dst, d.home)}`);
  return false;
}
CMD('dired-do-rename', '', '', 'Rename the file at point, or move the marked files into a directory (R). Buffers visiting them follow.', () => transfer(cur(), 'Rename', (fs, s, t) => fs.rename(s, t)));
CMD('dired-do-copy', '', '', 'Copy the file at point, or the marked files into a directory (C). A directory is copied whole.', () => transfer(cur(), 'Copy', (fs, s, t) => fs.copy(s, t)));
CMD('dired-create-directory', '', '', 'Make a directory, with the parents it lacks (+).', async () => {
  const b = cur(), d = diredOf(b), p = stripSlash(await readPath('Create directory: ', d.dir, d.fs));
  await d.fs.mkdir(p);
  const under = p.startsWith(join(d.dir, '')) ? p.slice(join(d.dir, '').length).split('/')[0] : undefined;
  await refresh(b, under);
  return false;
});
CMD('dired-copy-filename-as-kill', '', '', 'Copy the paths of the marked files, or of the file at point (Y).', () => {
  const b = cur(), d = diredOf(b), ps = targets(b).map(e => join(d.dir, e.name));
  L.call('kill-new', [ps.join('\n')]);
  Ed.message(ps.length === 1 ? ps[0] : `Copied ${ps.length} paths`);
  return false;
});
for (const n of ['dired', 'dired-jump', 'dired-find-file', 'dired-up-directory', 'dired-revert', 'dired-mark', 'dired-flag-file-deletion', 'dired-unmark', 'dired-unmark-all-marks',
  'dired-toggle-marks', 'dired-do-delete', 'dired-do-flagged-delete', 'dired-do-rename', 'dired-do-copy', 'dired-create-directory', 'dired-copy-filename-as-kill']) L.put(intern(n), 'evil-repeat', intern('abort'));
Ed.MODE_NAMES['dired-mode'] = 'Dired';

/* ---------- faces ---------- */
const FACES = ['', 'dired-header', 'dired-dim', 'dired-dir', 'dired-link', 'dired-mark', 'dired-marked', 'dired-flag', 'dired-flagged'];
const F = { HEADER: 1, DIM: 2, DIR: 3, LINK: 4, MARK: 5, MARKED: 6, FLAG: 7, FLAGGED: 8 };
interface DiredLex { ver: number; from: number; to: number; cls: Uint8Array; names: string[] }
const prevLexSeg = H.lexSeg;
H.lexSeg = (b, from, to, seg) => {
  if (b.mode !== 'dired-mode' || !b.dired) return prevLexSeg ? prevLexSeg(b, from, to, seg) : null;
  const c = b._dlx as DiredLex | undefined;
  if (c && c.ver === b.ver && c.from === from && c.to === to) return c;
  const d = b.dired as Dired, text = seg as string, cls = new Uint8Array(text.length);
  let line = lineNoB(b, from);
  for (let ls = 0; ls < text.length; line++) {
    let le = text.indexOf('\n', ls); if (le < 0) le = text.length;
    const e = d.entries[line - 2];
    if (!e) cls.fill(line === 1 ? F.HEADER : F.DIM, ls, le);
    else {
      const m = d.marks.get(e.name), name = Math.min(le, ls + NAME_COL), end = Math.min(le, name + e.name.length);
      if (m) cls.fill(m === 'D' ? F.FLAG : F.MARK, ls, Math.min(le, ls + 1));
      cls.fill(F.DIM, Math.min(le, ls + 1), name);
      const face = m === 'D' ? F.FLAGGED : m ? F.MARKED : isDirEntry(e) ? F.DIR : e.kind === 'link' ? F.LINK : 0;
      if (face) cls.fill(face, name, end);
      cls.fill(F.DIM, end, le);
    }
    ls = le + 1;
  }
  return b._dlx = { ver: b.ver, from, to, cls, names: FACES };
};
const CSS = `
.text .dired-header { font-weight: 700; color: var(--fg); }
.text .dired-dim { color: var(--dim); }
.text .dired-dir { color: var(--fn); font-weight: 600; }
.text .dired-link { color: var(--st); }
.text .dired-mark { color: var(--co); font-weight: 700; }
.text .dired-marked { color: var(--co); font-weight: 600; }
.text .dired-flag { color: var(--rb1); font-weight: 700; }
.text .dired-flagged { color: var(--rb1); font-weight: 600; }
`;
Ed.host.page.addStyle('dired-css', CSS);
})();
