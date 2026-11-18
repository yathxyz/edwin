/* Lmacs editor core: buffers, keymaps, the command loop, the minibuffer, undo and redisplay.
   Keys go into a queue; one sequential loop reads them, as in Emacs. Commands that need
   more input (operators, the minibuffer, isearch) read the next key from the same queue,
   so keyboard macros and repeat can push keys back in front of it. */
(function () {
'use strict';
/* editor-core's own types: window configurations, the moved markers of an edit, redisplay's lines, options and
   caches, and the fields the core keeps on page elements. */
type EcWinLeaf = { dir?: undefined; buffer: EdBuffer; pt: number; start: number; sel: boolean; popup: boolean };
type EcWinSplit = { dir: 'h' | 'v'; children: EcWinConfig[] };
type EcWinConfig = EcWinLeaf | EcWinSplit;
type EcMoved = [m: EdMarker | EdTempMarker, pos: number, dead: boolean, to: number][];
type EcLexInfo = { dirty?: boolean };
type EcIsearchFrame = { pt: number; str: string; failing: boolean; match: [number, number] | null; dir: number; wrapped: boolean };
type EcFoldPre = { ver: number | undefined; n: number; pre: Int32Array };
type EcFoldBuffer = { _foldPre?: EcFoldPre | null };
type EcLineBoth = { html: string; runs: EdRun[] };
type EcLineVal = string | EdRun[] | EcLineBoth;
type EcLine = { o: number; n: number | null; cl: boolean; html: string | undefined; pulse: boolean; runs?: EdRun[]; text?: string };
type EcRendered = EcLine[] & { seg?: string; cache?: Map<string, EcLineVal> | null };
type EcLexSeg = { cls: ArrayLike<number>; names: string[] };
type EcPulse = { b: EdBuffer; ls: number };
interface EcRenderOpts extends EdRenderOpts {
  active?: boolean; numbers?: 'relative' | 'absolute' | null; cursorClass?: string; onChar?: boolean; hl?: RegExp | null;
  current?: [number, number] | null; isearch?: EdIsearch | null; avy?: Map<number, string> | null; pulse?: number; cache?: Map<string, EcLineVal> | null;
}
interface EcWindowState extends EdWindowState { opts: EcRenderOpts }
interface EcMetrics extends EdMetrics { sgen: number; ch: number; mono: boolean; padT: number; padX: number; nowrap: boolean; cw0: number; oh0: number; ow0: number; cw: number; top: number; oh: number }
type EcView = HTMLElement & { _win?: EdWindow; _buf?: EdBuffer; _lines?: EcRendered };
type EcLineEl = HTMLElement & { _o?: number; _h?: string; _cn?: string; _n?: number | null };
type EcTextEl = HTMLElement & { _t?: string; _st?: string; _hid?: boolean };
type EcEcho = HTMLElement & { _e?: string; _eh?: boolean; _dirty?: boolean; _h?: number };
const L: LispApi = globalThis.L;
const { intern, NIL, signal, pr, arr, listOf, truthy, SchemeError, Sym } = L;
/* The host (host-browser.ts or host-node.cts) is everything the core needs from where it runs. */
const host: EdHost = globalThis.EdHost;
if (!host) throw new Error('Edwin needs a host: load host-browser.js or host-node.js first');
const hooks: EdHooks = {};

/* ---------- file store: the host's storage, under its own prefix ---------- */
/* A host with a file system (host.files: the desktop shell, DT1) keeps files there instead: NAME is a path,
   read gives the text or null, write throws when the file cannot be written, list names the files that
   completion offers. */
const PFX = 'lmacs:file:';
const Store = {
  get(n: string, max?: number) { return host.files ? host.files.read(n, max) : host.storage.get(PFX + n); },
  set(n: string, v: string) { if (host.files) { host.files.write(n, v); return true; } return host.storage.set(PFX + n, v) !== false; },
  del(n: string) { if (host.files) host.files.remove(n); else host.storage.remove(PFX + n); },
  list() { return host.files ? host.files.list() : host.storage.keys().filter(k => k.startsWith(PFX)).map(k => k.slice(PFX.length)).sort(); },
};

/* ---------- buffers ---------- */
interface Buffer extends EdBuffer { _mark: EdMarker; _marks: Map<string, EdMarker>; _jumps: EdMarker[]; _lv: number }
class Buffer {
  declare static count: number | undefined;
  constructor(name: string) {
    this.id = Buffer.count = (Buffer.count || 0) + 1;
    /* The text lives in a rope; every change is logged as a delta (VER, POS, DEL, INS) so caches,
       undo and the worker mirrors can follow it without keeping copies of the whole text. */
    this.rope = new globalThis.Rope(''); this.ver = 0; this.log = []; this.pin = Infinity;
    /* Markers (R6.11): every position that must follow edits, in one set that shiftMarkers moves.
       Plain { pos } objects in it (temps) are before markers. Point is an after marker, kept as a number. */
    this.markers = new Set(); this.temps = this.markers;
    this._mark = this.marker(null); this._marks = new Map(); this._jumps = []; this.locals = null;
    this.name = name; this.pt = 0; this.markActive = false;
    this.mode = modeFor(name); this.file = null; this.modified = false; this.readOnly = false;
    this.undo = []; this.redo = []; this.pendingUndo = null; this.typeRun = 0; this.scroll = 0;
    this.jumpIdx = 0;
    this.visual = null; this.evilState = undefined; this._lv = -1; this._lc = null;
  }
  marker(pos: number | null, type?: 'before' | 'after') { const m = new Marker(this, pos, type); this.markers.add(m); return m; }
  /* The mark is a before marker; b.mark reads and sets its position (null when unset). */
  get mark() { return this._mark.pos; }
  set mark(v: number | null) { this._mark.pos = v === null || v === undefined ? null : v; }
  /* Evil's marks: a table of before markers, read and written as positions (b.marks[k] = pos). */
  get marks() { return this._marksView || (this._marksView = marksView(this)); }
  set marks(o: Record<string, number | undefined>) { for (const m of this._marks.values()) this.markers.delete(m); this._marks.clear(); for (const k in o) this.marks[k] = o[k]; }
  /* The jump list: an array of before markers. Assigning it drops the markers left out. */
  get jumps() { return this._jumps; }
  set jumps(a: EdMarker[]) {
    const keep = new Set<EdMarker>();
    this._jumps = a.map((x: EdMarker | number) => { const m = x instanceof Marker ? x : this.marker(x as number); keep.add(m); return m; });
    for (const m of this.markers) if ((m as EdMarker).jump && !keep.has(m as EdMarker)) this.markers.delete(m);
    for (const m of keep) { m.jump = true; this.markers.add(m); }
  }
  /* The whole text as one string (built once per change, then cached). Hot paths read the rope. */
  get text() { return this.rope.toString(); }
  set text(v: string) { setText(this, String(v)); }
  __print() { return '#<buffer ' + this.name + '>'; }
  get __type() { return 'buffer'; }
}
/* A marker: a position in a buffer that follows its edits, with an insertion type (R6.11). A before
   marker stays before text inserted at it; an after marker advances past it. A released marker
   (set-marker m #f) points nowhere and is no longer moved. */
interface Marker extends EdMarker {}
class Marker {
  constructor(buffer: EdBuffer | null, pos: number | null, type?: 'before' | 'after') { this.buffer = buffer; this.pos = pos; this.type = type === 'after' ? 'after' : 'before'; }
  set(buffer: EdBuffer | null, pos: number | null) {
    if (this.buffer && this.buffer !== buffer) this.buffer.markers.delete(this);
    this.buffer = pos === null ? null : buffer; this.pos = pos;
    if (this.buffer) this.buffer.markers.add(this);
    return this;
  }
  release() { if (this.buffer) this.buffer.markers.delete(this); this.buffer = null; this.pos = null; }
  __print() { return this.buffer && this.pos !== null ? `#<marker at ${this.pos + 1} in ${this.buffer.name}>` : '#<marker in no buffer>'; }
  get __type() { return 'marker'; }
}
function marksView(b: Buffer): Record<string, number | undefined> {
  const t = b._marks;
  return new Proxy(Object.create(null), {
    get: (_, k: string) => { const m = typeof k === 'string' ? t.get(k) : undefined; return m ? m.pos : undefined; },
    set: (_, k: string, v) => { let m = t.get(k); if (!m) { m = b.marker(v); t.set(k, m); } else m.pos = v; return true; },
    deleteProperty: (_, k: string) => { const m = t.get(k); if (m) { b.markers.delete(m); t.delete(k); } return true; },
    has: (_, k: string) => t.has(k),
    ownKeys: () => [...t.keys()],
    getOwnPropertyDescriptor: (_, k: string) => (t.has(k) ? { value: t.get(k)!.pos, writable: true, enumerable: true, configurable: true } : undefined),
  });
}
function modeFor(name: string): string {
  if (hooks.modeFor) { const m = hooks.modeFor(name); if (m) return m; }
  if (name === '*scratch*') return 'scheme-interaction-mode';
  if (/\.(scm|ss|sld)$/.test(name)) return 'scheme-mode';
  if (/^\*(Help|Buffer List|Messages|Registers|Marks)\*$/.test(name)) return 'special-mode';
  return 'fundamental-mode';
}
const MODE_NAMES: Record<string, string> = { 'scheme-interaction-mode': 'Scheme Interaction', 'scheme-mode': 'Scheme', 'fundamental-mode': 'Fundamental', 'special-mode': 'Special', 'minibuffer-mode': 'Minibuffer', 'org-mode': 'Org', 'text-mode': 'Text' };
/* The Lisp dialect of a buffer, by its major mode or the nearest mode it derives from: the lexer, the bracket
   guard, the list motions and the indenter read Lisp code in these and in no other buffer. Racket is read as Scheme.
   The modes besides Scheme's are scm/prog.scm's. */
type LispDialect = 'scheme' | 'elisp' | 'cl' | 'clojure';
const LISP_DIALECTS: Record<string, LispDialect> = {
  'scheme-mode': 'scheme', 'scheme-interaction-mode': 'scheme', 'minibuffer-mode': 'scheme', 'racket-mode': 'scheme',
  'emacs-lisp-mode': 'elisp', 'lisp-mode': 'cl', 'clojure-mode': 'clojure' };
function lispDialect(b: EdBuffer): LispDialect | null {
  for (let m: string | undefined = b.mode, n = 0; m && n < 33; m = modeParents.get(m), n++)
    if (Object.prototype.hasOwnProperty.call(LISP_DIALECTS, m)) return LISP_DIALECTS[m];
  return null;
}
const isLisp = (b: EdBuffer) => lispDialect(b) !== null;

/* E.headless: no page to draw on (edwind, tests), as the host says. Redisplay and the browser wiring are
   then skipped, and everything else runs as in the page. */
const E = {
  headless: !!host.headless, host, frames: [], frame: null,
  buffers: [], win: null, current: null as unknown as EdBuffer,
  history: [], pendingKeys: '',
  prefixArg: null, keepPrefix: false, uArg: false, uDigits: null, depth: 0,
  lastCommand: false, thisCommand: false, thisKeys: '', killRing: [], killIdx: 0,
  isearch: null, lastSearch: '', goalCol: null, cmdSeq: 0,
  inhibitRO: false, pasteText: '', timers: new Map(), suppressUndo: false, noUndo: false, running: 0,
} as Partial<EdState> as EdState;
/* The minibuffer, the echo area and the window tree are per frame (R9.2): E.minibuf, E.mini, E.echo,
   E.root, E.sel and the rest are accessors onto the selected frame (below, after Window). */

function getBuffer(name: string) { return E.buffers.find(b => b.name === name) || null; }
function getBufferCreate(name: string) {
  let b = getBuffer(name);
  if (!b) { b = new Buffer(name); E.buffers.push(b); if (E.booted) runHookSafely('buffer-list-update-hook', []); }
  return b;
}
/* signal does not return */
function toBuffer(x: SchemeValue): EdBuffer;
function toBuffer(x: SchemeValue) {
  if (x instanceof Buffer) return x;
  if (typeof x === 'string') { const b = getBuffer(x); if (!b) signal('error', 'No such buffer ' + x); return b!; }
  if (x === false || x === undefined) return E.current;
  signal('wrong-type-argument', intern('bufferp'), x);
}
/* ---------- windows: a tree of splits whose leaves show buffers ---------- */
interface Window extends EdWindow {}
class Window {
  declare static count: number | undefined;
  constructor(buffer: EdBuffer) {
    this.id = Window.count = (Window.count || 0) + 1;
    this.buffer = buffer; this.pt = buffer ? buffer.pt : 0; this.start = 0; this.lastLine = 0; this.rows = 20; this.prev = []; this.popup = false;
    this.el = null; this.view = null; this.ml = null; this.parent = null; this.dedicated = false;
  }
  __print() { return '#<window ' + this.id + ' on ' + (this.buffer ? this.buffer.name : 'nothing') + '>'; }
  get __type() { return 'window'; }
}
interface Split extends EdSplit {}
class Split { constructor(dir: 'h' | 'v', children: EdWindowNode[]) { this.dir = dir; this.children = children; this.parent = null; this.el = null; for (const c of children) c.parent = this; } }
/* The per-frame state (R9.2): a window tree (wroot, sel, the winner history), a minibuffer with its
   echo area, prompt and flash, and whether the frame has the keyboard. A Frame (below) adds the page
   parts. With no frame (headless: edwind, the tests, a served runtime before its first card) the
   implicit state E.implicit holds one window tree, so the core works unchanged. */
interface FrameState extends EdFrameState {}
class FrameState {
  constructor() {
    this.wroot = null; this.sel = null; this.winHistory = []; this.winFuture = [];
    this.minibuf = new Buffer(' *Minibuf-1*'); this.minibuf.mode = 'minibuffer-mode'; this.minibuf.minibuf = true;
    this.mini = null; this.miniFlash = ''; this.echo = ''; this.prompt = null; this.focused = false;
    this.restoreScroll = false; this.recenter = null;
  }
}
E.implicit = new FrameState();
/* The frame the core is working on: the one being drawn (render swaps it in), else the selected one,
   else the implicit state. E.root, E.sel, E.mini, E.minibuf, E.echo and the rest read and write it. */
let rendering: EdFrameState | null = null;
const FS = () => rendering || E.frame || E.implicit;
for (const [k, f] of [['root', 'wroot'], ['sel', 'sel'], ['winHistory', 'winHistory'], ['winFuture', 'winFuture'], ['mini', 'mini'], ['minibuf', 'minibuf'],
  ['miniFlash', 'miniFlash'], ['echo', 'echo'], ['prompt', 'prompt'], ['focused', 'focused'], ['restoreScroll', 'restoreScroll'], ['recenter', 'recenter']] as [string, keyof EdFrameState][])
  Object.defineProperty(E, k, { get() { return FS()[f]; }, set(v) { (FS() as Record<keyof EdFrameState, unknown>)[f] = v; }, enumerable: true, configurable: true });
Object.defineProperty(E, 'win', { get() { return E.sel ? E.sel.buffer : null; }, set(b) { if (E.sel) E.sel.buffer = b; } });
function leaves(node: EdWindowNode | null, out?: EdWindow[]): EdWindow[] { out = out || []; if (!node) return out; if (node instanceof Window) out.push(node); else for (const c of (node as EdSplit).children) leaves(c, out); return out; }
function windowList() { return leaves(E.root); }
/* Every window of every frame, the implicit tree included. */
function allWindows() { const out = leaves(E.implicit.wroot); for (const f of E.frames) leaves(f.wroot, out); return out; }
/* The selected window of the selected frame, whatever frame is being drawn. */
const selWin = () => (E.frame || E.implicit).sel;
/* Every minibuffer (one per frame, plus the implicit one). */
function allMinibufs() { return [E.implicit.minibuf, ...E.frames.map(f => f.minibuf)]; }
/* Run FN with frame F as the one the accessors read (redisplay of a frame that is not selected). */
function withFrame<T>(f: EdFrameState | null, fn: () => T): T { const save = rendering; rendering = f; try { return fn(); } finally { rendering = save; } }
function selectWindow(w: EdWindow | null | undefined, keepPoint?: boolean) {
  if (!w || w === E.sel) { if (w) E.current = E.mini ? E.minibuf : w.buffer; return; }
  if (E.sel && E.sel.buffer) { E.sel.pt = E.sel.buffer.pt; }
  E.sel = w;
  if (!keepPoint && w.buffer) w.buffer.pt = Math.min(w.pt, w.buffer.rope.length);
  E.current = E.mini ? E.minibuf : w.buffer; E.restoreScroll = true;
}
function setWindowBuffer(b: EdBuffer, w?: EdWindow | null) {
  w = w || E.sel!;
  if (w.buffer && w.buffer !== b) {
    w.prev = [w.buffer, ...w.prev.filter(x => x !== w.buffer)].slice(0, 20);
    w.buffer.lastStart = w.start; w.start = b.lastStart || 0;
  }
  const i = E.buffers.indexOf(b);
  if (i > 0) { E.buffers.splice(i, 1); E.buffers.unshift(b); }
  w.buffer = b; w.pt = b.pt;
  if (w === E.sel) { E.current = E.mini ? E.minibuf : b; E.restoreScroll = true; }
}
function otherBuffer() { return E.buffers.find(b => b !== E.win && !b.name.startsWith(' ') && !windowList().some(w => w.buffer === b)) || E.buffers.find(b => b !== E.win && !b.name.startsWith(' ')) || E.win!; }
function replaceNode(oldNode: EdWindowNode, newNode: EdWindowNode) {
  const p = oldNode.parent;
  newNode.parent = p;
  if (!p) E.root = newNode; else p.children[p.children.indexOf(oldNode)] = newNode;
}
function splitWindow(w: EdWindow | null, dir: string, size?: number) {
  // dir: 'below' or 'right'. The new window shows the same buffer and goes after W.
  w = w || E.sel!;
  saveWinConfig();
  const nw = new Window(w.buffer); nw.pt = w.buffer.pt; nw.start = w.start;
  const axis = dir === 'right' ? 'h' : 'v';
  const p = w.parent;
  if (p && p.dir === axis) { p.children.splice(p.children.indexOf(w) + 1, 0, nw); nw.parent = p; }
  else { const parent = w.parent; const sp = new Split(axis, [w, nw]); sp.parent = parent; if (!parent) E.root = sp; else parent.children[parent.children.indexOf(w)] = sp; }
  return nw;
}
function deleteWindow(w: EdWindow | null) {
  w = w || E.sel!;
  if (windowList().length === 1) signal('user-error', 'Attempt to delete the sole window');
  saveWinConfig();
  const p = w.parent!;
  p.children.splice(p.children.indexOf(w), 1);
  if (p.children.length === 1) replaceNode(p, p.children[0]);
  if (w.el && w.el.parentNode) w.el.parentNode.removeChild(w.el);
  if (E.sel === w) { const ws = windowList(); E.sel = null; selectWindow(ws[0]); }
  return true;
}
function deleteOtherWindows(w: EdWindow | null) {
  w = w || E.sel!;
  if (windowList().length === 1) return;
  saveWinConfig();
  for (const x of windowList()) if (x !== w && x.el && x.el.parentNode) x.el.parentNode.removeChild(x.el);
  w.parent = null; E.root = w; selectWindow(w);
}
function winConfig() {
  const snap = (n: EdWindowNode): EcWinConfig => n instanceof Window ? { buffer: n.buffer, pt: n === E.sel ? n.buffer.pt : n.pt, start: n.start, sel: n === E.sel, popup: n.popup }
    : { dir: (n as EdSplit).dir, children: (n as EdSplit).children.map(snap) };
  return snap(E.root!);
}
function restoreWinConfig(cfg: EcWinConfig) {
  for (const x of windowList()) if (x.el && x.el.parentNode) x.el.parentNode.removeChild(x.el);
  let sel: EdWindow | null = null;
  const build = (c: EcWinConfig): EdWindowNode => {
    if (c.dir) return new Split(c.dir, c.children.map(build));
    const b = E.buffers.includes(c.buffer) ? c.buffer : (E.buffers.find(x => !x.name.startsWith(' ')) || E.buffers[0]);
    const w = new Window(b); w.pt = Math.min(c.pt, b.rope.length); w.start = Math.min(c.start || 0, b.rope.length); w.popup = c.popup; if (c.sel) sel = w; return w;
  };
  E.root = build(cfg); E.root.parent = null;
  E.sel = null; selectWindow(sel || windowList()[0]);
}
function saveWinConfig() { E.winHistory.push(winConfig()); if (E.winHistory.length > 50) E.winHistory.shift(); E.winFuture = []; }
function windowFor(b: EdBuffer) { return windowList().find(w => w.buffer === b) || null; }
/* Show B in a window other than the selected one: reuse one, or split. */
function popToBuffer(b: EdBuffer, select?: boolean) {
  const existing = windowFor(b);
  let w: EdWindow;
  if (existing) w = existing;
  else {
    const others = windowList().filter(x => x !== E.sel);
    if (others.length) w = others.find(x => x.popup) || others[others.length - 1];
    else { const sel = E.sel; w = splitWindow(sel, 'below'); w.popup = true; }
    setWindowBuffer(b, w);
  }
  if (select) selectWindow(w);
  return w;
}

/* ---------- frames: the page areas Edwin draws into ----------
   A frame is one view of the editor on a page (R9.2): a root element holding the window tree, the echo
   area and the input, with the menubar, the completion popup and the snipe boxes. The core never looks
   up page elements itself: it asks the selected frame for a part by name (frame.el), so a page can hold
   several frames. With no frame (headless) nothing is drawn. */
interface Frame extends EdFrame {}
class Frame extends FrameState {
  declare static count: number | undefined;
  constructor(root: HTMLElement | null, parts: Record<string, HTMLElement>) {
    super();
    this.id = Frame.count = (Frame.count || 0) + 1;
    this.root = root; this.parts = Object.assign(Object.create(null), parts);
    this.kind = 'console'; this.fontSize = null; this.legacy = true; this.listeners = [];
  }
  /* The part NAME (frame, menubar, windows, echo, input, corfu, snipe, presence): given at creation, or the
     element with that id inside the root, or the root itself. Parts made later (the popups) are found once made.
     A model frame (no root, DT0) has no parts: null. */
  el(name: string) {
    const p = this.parts[name];
    if (p) return p;
    const r = this.root; if (!r) return null;
    const el = r.id === name ? r : r.querySelector<HTMLElement>('#' + name);
    if (el) this.parts[name] = el;
    return el;
  }
  /* The buffer of the frame's selected window. */
  get buffer() { return this.sel ? this.sel.buffer : null; }
  focus() { const ta = this.el('input'); if (ta && ta.focus) ta.focus({ preventScroll: true }); else { selectFrame(this); this.focused = true; } }
  blur() { const ta = this.el('input'); if (ta && ta.blur && ta.ownerDocument.activeElement === ta) ta.blur(); else { this.focused = false; frameEvent('blur', this); } }
  /* Show B in the frame's selected window. */
  showBuffer<T extends EdBuffer | string>(b: T): T { withFrame(this, () => setWindowBuffer(toBuffer(b)!, this.sel)); if (E.frame === this) E.current = this.mini ? this.minibuf : this.sel!.buffer; scheduleRender(); return b; }
  point(): number { return E.frame === this ? this.sel!.buffer.pt : this.sel!.pt; }
  setPoint(p: number) { const b = this.sel!.buffer; p = Math.max(0, Math.min(b.rope.length, p)); if (E.frame === this) b.pt = p; this.sel!.pt = p; scheduleRender(); return p; }
  /* Pixels from the top of the frame's element to the top of the drawn line holding POS, or null (R9.12). */
  lineTop(pos: number) {
    const w = this.sel; if (!w || !w.view) return null;
    const ls = bol(w.buffer.rope, Math.max(0, Math.min(w.buffer.rope.length, pos)));
    const ln = w.view.querySelector(`.ln[data-o="${ls}"]`); if (!ln) return null;
    const sc = frameScale(this), rr = this.root!.getBoundingClientRect(), lr = ln.getBoundingClientRect();
    return (lr.top - rr.top) / sc;
  }
  /* The buffer position under the client point, in this frame (works under a CSS transform, R9.9). */
  posFromPoint(x: number, y: number) { return withFrame(this, () => { const w = windowAt(x, y); return w ? posFromPoint(x, y, w) : null; }); }
  /* True while the frame's buffer has edits the server has not acknowledged (R9.15). */
  unacked() { const b = this.buffer; return !!(b && (b.inflight || (b.queue && b.queue.length))); }
  setFontSize(px: number) { this.fontSize = px; if (this.root) this.root.style.setProperty('--text-size', px + 'px'); E.metricsGen++; scheduleRender(); }
  destroy() { deleteFrame(this); }
  __print() { return '#<frame ' + this.id + '>'; }
  get __type() { return 'frame'; }
}
/* Ed.makeFrame(el, {buffer, kind: 'card' | 'console', fontSize}) builds a frame's parts inside EL: the
   windows, the echo area, the hidden input textarea and the presence layer, with a menubar for a console
   (R9.2, R9.3). The older form makeFrame(root, parts) takes a page that already holds the parts
   (index.html). The window tree starts with one window on BUFFER (else the current buffer).
   Ed.makeFrame(null, {backend, buffer, kind, theme}) makes a model frame (DT0): no page, no DOM; each redisplay
   lays the frame out on backend.size()'s cell grid and hands the result to backend.draw (display.ts). */
function makeFrame(root: HTMLElement | null, opts?: EdMakeFrameOpts) {
  opts = opts || {};
  if (!root) return makeModelFrame(opts);
  const built = 'kind' in opts || 'buffer' in opts || 'fontSize' in opts;
  const f = new Frame(root, built ? {} : opts as Record<string, HTMLElement>);
  if (built) buildFrame(f, root, opts);
  const b = (opts.buffer && toBuffer(opts.buffer)) || E.current || E.buffers[0];
  f.wroot = f.sel = new Window(b); f.sel.pt = b.pt;
  E.frames.push(f);
  E.headless = false;
  if (!E.frame) selectFrame(f);
  if (built && hooks.wireFrame) hooks.wireFrame(f);
  if (built) { watchTheme(root); scheduleRender(); }
  return f;
}
function makeModelFrame(opts: EdMakeFrameOpts) {
  const be = opts.backend;
  if (!be || typeof be.size !== 'function' || typeof be.draw !== 'function') signal('error', 'Ed.makeFrame: a frame needs an element, or a backend with size() and draw()');
  const f = new Frame(null, {});
  f.backend = be; f.legacy = false; f.kind = opts.kind === 'card' ? 'card' : 'console'; f.theme = opts.theme || null;
  const b = (opts.buffer && toBuffer(opts.buffer)) || E.current || E.buffers[0];
  f.wroot = f.sel = new Window(b); f.sel.pt = b.pt;
  E.frames.push(f);
  E.headless = false;
  if (!E.frame) selectFrame(f);
  scheduleRender();
  return f;
}
function buildFrame(f: Frame, root: HTMLElement, opts: EdMakeFrameOpts) {
  const doc = root.ownerDocument;
  host.page.addStyle('edwin-frame-style', FRAME_CSS);
  root.classList.add('edwin-frame', 'unfocused');
  f.kind = opts.kind === 'card' ? 'card' : 'console'; f.legacy = false;
  root.dataset.kind = f.kind;
  const mk = (tag: string, cls: string) => { const el = doc.createElement(tag); el.className = cls; root.appendChild(el); return el; };
  if (f.kind === 'console') {
    const nav = mk('nav', 'ed-menubar'); nav.setAttribute('aria-label', 'Commands');
    nav.innerHTML = '<span class="name">Edwin</span><button type="button" data-key="ESC">Esc</button><button type="button" data-cmd="evil-ex">Ex <kbd>:</kbd></button>' +
      '<button type="button" data-cmd="list-buffers">Buffers <kbd>:ls</kbd></button><button type="button" data-cmd="save-buffer">Save <kbd>:w</kbd></button>' +
      '<button type="button" data-cmd="evil-undo">Undo <kbd>u</kbd></button><button type="button" data-cmd="evil-help">Keys <kbd>:h</kbd></button>' +
      '<button type="button" data-cmd="evil-toggle-emacs-state">Vim ⇄ Emacs <kbd>C-z</kbd></button><span class="spacer"></span>';
    f.parts.menubar = nav;
  }
  f.parts.windows = mk('div', 'ed-windows');
  const echo = mk('div', 'ed-echo'); echo.setAttribute('aria-live', 'polite'); f.parts.echo = echo;
  const pres = mk('div', 'ed-presence'); f.parts.presence = pres;
  const ta = mk('textarea', 'ed-input');
  for (const [k, v] of [['autocapitalize', 'off'], ['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['aria-label', 'Keyboard input']]) ta.setAttribute(k, v);
  f.parts.input = ta;
  f.parts.frame = root;
  if (opts.fontSize) { f.fontSize = opts.fontSize; root.style.setProperty('--text-size', opts.fontSize + 'px'); }
}
/* A change of data-theme on <html> redraws every frame (R9.10); the colours themselves are CSS variables. */
let themeWatched = false;
function watchTheme(root: HTMLElement) {
  if (themeWatched) return;
  const doc = root.ownerDocument, win = doc.defaultView;
  if (!win || typeof win.MutationObserver !== 'function') return;
  themeWatched = true;
  new win.MutationObserver(() => { E.metricsGen++; frameRender(); }).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
/* The CSS scale an ancestor's transform applies to frame F (1 without one): layout pixels are divided by it
   to place overlays, and measured rectangles are divided by it to get layout pixels (R9.9). */
function frameScale(f: EdFrame) { const r = f.root; if (!r || !r.offsetWidth) return 1; const w = r.getBoundingClientRect().width; return w > 0 ? w / r.offsetWidth : 1; }
function selectFrame(f: EdFrame) {
  if (!(f instanceof Frame) || !E.frames.includes(f)) signal('wrong-type-argument', 'not a live frame', f);
  if (E.frame === f) return f;
  const old = E.frame || E.implicit;
  if (old.sel && old.sel.buffer) old.sel.pt = old.sel.buffer.pt;
  E.frame = f;
  if (f.sel && f.sel.buffer) { const b = f.sel.buffer; b.pt = Math.min(f.sel.pt, b.rope.length); E.current = f.mini ? f.minibuf : b; }
  return f;
}
function deleteFrame(f: EdFrame) {
  const i = E.frames.indexOf(f); if (i < 0) return false;
  E.frames.splice(i, 1);
  for (const w of leaves(f.wroot)) if (w.view && sizeWatch) sizeWatch.unobserve(w.view);
  for (const [el, type, fn, o] of f.listeners) el.removeEventListener(type, fn, o);
  f.listeners = [];
  if (!f.legacy && f.root) { for (const p of Object.values(f.parts)) if (p !== f.root && p.parentNode) p.parentNode.removeChild(p); f.root.classList.remove('edwin-frame', 'unfocused'); delete f.root.dataset.kind; }
  if (E.frame === f) {
    E.frame = null;
    const next = E.frames[0] || null;
    if (next) selectFrame(next);
    else { const s = E.implicit.sel; if (s && s.buffer) E.current = E.implicit.mini ? E.implicit.minibuf : s.buffer; }
  }
  if (!E.frames.length) E.headless = true;
  frameEvent('blur', f);
  return true;
}
/* Ed.onFrameEvent(fn): fn({type, frame, buffer}) for edited, point, focus, blur and status (the page's title,
   snapshot and status refresh). */
const frameListeners: ((ev: EdFrameEvent) => void)[] = [];
function onFrameEvent(fn: (ev: EdFrameEvent) => void) { frameListeners.push(fn); return () => { const i = frameListeners.indexOf(fn); if (i >= 0) frameListeners.splice(i, 1); }; }
function frameEvent(type: string, frame: EdFrame | null, buffer?: EdBuffer | null) {
  if (!frameListeners.length) return;
  const ev = { type, frame, buffer: buffer || (frame && frame.sel ? frame.sel.buffer : null) };
  for (const fn of frameListeners.slice()) { try { fn(ev); } catch (e) { console.error(e); } }
}
/* A part of the frame being drawn or selected, or null with no frame. */
const $ = (name: string) => { const f = FS(); return f instanceof Frame ? f.el(name) : null; };

/* The stylesheet a built frame needs, injected once per page. Faces are the board's tokens with Edwin's
   modus values as fallbacks (R9.10); fonts are the page's (R9.11). */
const FRAME_CSS = `
.edwin-frame { --ed-bg: var(--panel, #fbf7f0); --ed-fg: var(--fg, #000000); --ed-dim: var(--muted, #595959); --ed-rule: var(--dot, #c4b8ab);
  --ed-menu-bg: var(--panel-2, #efe9dd); --ed-ml-bg: var(--panel-2, #cab9b2); --ed-ml-inactive: var(--bg, #dfd9cf);
  --ed-cursor: var(--fg, #000000); --ed-cursor-fg: var(--panel, #fbf7f0); --ed-region: var(--accent-soft, #c2bcb5); --ed-match: var(--accent, #79a8ff); --ed-lazy: var(--accent-soft, #c0efff);
  --ed-paren: var(--accent-soft, #7fdfcf); --ed-mismatch: #ffa0a0; --ed-hl: color-mix(in srgb, var(--fg, #000) 7%, transparent); --ed-pulse: var(--accent-soft, #ffdfa0);
  --ed-kw: var(--syn-keyword, #531ab6); --ed-fn: var(--syn-fnname, #721045); --ed-st: var(--syn-string, #3548cf); --ed-dc: var(--syn-docstring, #2a5045); --ed-cm: var(--syn-comment, #7f0000); --ed-co: var(--syn-constant, #0000b0); --ed-pa: var(--muted, #7f7f7f);
  --ed-rb0: var(--syn-keyword, #0000b0); --ed-rb1: var(--syn-comment, #a60000); --ed-rb2: var(--syn-type, #006800); --ed-rb3: var(--syn-variable, #884900); --ed-rb4: var(--syn-builtin, #721045); --ed-rb5: var(--syn-string, #005e8b);
  --ed-font: var(--mono, var(--font-mono, "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace)); --ed-font-ui: var(--sans, var(--font-ui, system-ui, sans-serif));
  display: flex; flex-direction: column; min-width: 0; min-height: 0; position: relative; background: var(--ed-bg); color: var(--ed-fg); font-family: var(--ed-font); box-sizing: border-box; }
.edwin-frame[data-kind="console"] { height: 100%; border: 1px solid var(--ed-rule); border-radius: 6px; overflow: hidden; }
.edwin-frame[data-kind="card"] { background: transparent; }
.edwin-frame { --md-heading: var(--syn-keyword, var(--ed-kw)); --md-code: var(--syn-string, var(--ed-st)); --md-link: var(--syn-fnname, var(--ed-fn)); --md-ref: var(--syn-constant, var(--ed-co)); --md-field: var(--syn-variable, var(--ed-rb3)); --md-table: var(--syn-type, var(--ed-rb2));
  --md-task-todo: var(--syn-keyword, var(--ed-kw)); --md-task-next: var(--syn-fnname, var(--ed-fn)); --md-task-waiting: var(--syn-type, var(--ed-rb2)); --md-task-done: var(--muted, var(--ed-dim)); --md-priority: var(--syn-constant, var(--ed-co));
  --md-markup: var(--muted, var(--ed-dim)); --md-quote: var(--muted, var(--ed-dim)); --md-list: var(--syn-keyword, var(--ed-kw)); --md-tag: var(--syn-constant, var(--ed-co)); --md-date: var(--syn-constant, var(--ed-co)); --md-checkbox: var(--syn-constant, var(--ed-co)); --md-image: var(--syn-docstring, var(--ed-dc)); --md-anchor: var(--muted, var(--ed-dim)); }
.edwin-frame .ed-menubar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; padding: 4px 8px; background: var(--ed-menu-bg); border-bottom: 1px solid var(--ed-rule); font-family: var(--ed-font-ui); font-size: 13px; color: var(--ed-dim); }
.edwin-frame .ed-menubar .name { font-weight: 600; letter-spacing: 0.04em; color: var(--ed-fg); margin-right: 6px; }
.edwin-frame .ed-menubar button { font: inherit; color: inherit; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 2px 8px; cursor: pointer; display: inline-flex; gap: 6px; align-items: baseline; }
.edwin-frame .ed-menubar button:hover { background: var(--ed-bg); border-color: var(--ed-rule); }
.edwin-frame .ed-menubar kbd { font-family: var(--ed-font); font-size: 11px; color: var(--ed-dim); }
.edwin-frame .ed-menubar .spacer { flex: 1; }
.edwin-frame .ed-windows { flex: 1; min-height: 0; display: flex; flex-direction: column; min-width: 0; }
.edwin-frame .ed-windows > * { flex: 1; min-height: 0; min-width: 0; }
.edwin-frame .split { display: flex; min-height: 0; min-width: 0; }
.edwin-frame .split.v { flex-direction: column; }
.edwin-frame .split.h { flex-direction: row; }
.edwin-frame .split > * { flex: 1; min-height: 0; min-width: 0; }
.edwin-frame .split.h > * + * { border-left: 1px solid var(--ed-rule); }
.edwin-frame .win { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.edwin-frame .text { flex: 1; min-height: 0; overflow: hidden; position: relative; margin: 0; padding: 6px 10px 6px 12px; font-size: var(--text-size, 14px); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 8; cursor: text; user-select: none; -webkit-user-select: none; }
.edwin-frame .text.nowrap { white-space: pre; overflow-x: auto; overflow-wrap: normal; }
.edwin-frame .text.nowrap .ln { width: max-content; min-width: 100%; }
.edwin-frame .ln { min-height: 1.5em; }
.edwin-frame .win.selected .ln.cl { background: var(--ed-hl); }
.edwin-frame .text.numbers .ln { position: relative; padding-left: calc(var(--gw, 2) * 1ch + 2ch); }
.edwin-frame .text.numbers .ln::before { content: attr(data-n); position: absolute; left: 0; width: calc(var(--gw, 2) * 1ch); text-align: right; color: var(--ed-dim); font-variant-numeric: tabular-nums; }
.edwin-frame .text.numbers .ln.cl::before { color: var(--ed-fg); font-weight: 500; }
.edwin-frame .rg { background: var(--ed-region); }
.edwin-frame .lz { background: var(--ed-lazy); }
.edwin-frame .im { background: var(--ed-match); }
.edwin-frame .pm { background: var(--ed-paren); }
.edwin-frame .px { background: var(--ed-mismatch); }
.edwin-frame .cur { background: var(--ed-cursor); color: var(--ed-cursor-fg) !important; border-radius: 1px; }
.edwin-frame .cur.bar { background: transparent; color: inherit !important; box-shadow: inset 2px 0 0 var(--ed-cursor); border-radius: 0; }
.edwin-frame .cur.hbar { background: transparent; color: inherit !important; box-shadow: inset 0 -3px 0 var(--ed-cursor); border-radius: 0; }
.edwin-frame .cur.half { background: linear-gradient(transparent 55%, var(--ed-cursor) 55%); color: inherit !important; }
.edwin-frame .cur.ghost, .edwin-frame.unfocused .text .cur { background: transparent; color: inherit !important; box-shadow: inset 0 0 0 1.5px var(--ed-cursor); }
:root[data-evil-state="insert"] .edwin-frame:not(.unfocused) .win.selected .cur { --ed-cursor: var(--syn-type, #006800); }
:root[data-evil-state="emacs"] .edwin-frame:not(.unfocused) .win.selected .cur { --ed-cursor: var(--accent, #005e8b); --ed-cursor-fg: #ffffff; }
:root[data-evil-state="visual"] .edwin-frame:not(.unfocused) .win.selected .cur { --ed-cursor: var(--syn-variable, #884900); background: transparent; color: inherit !important; box-shadow: inset 0 0 0 1.5px var(--ed-cursor); }
:root[data-evil-state="replace"] .edwin-frame:not(.unfocused) .win.selected .cur { --ed-cursor: var(--syn-comment, #a60000); }
.edwin-frame .kw { color: var(--ed-kw); font-weight: 500; }
.edwin-frame .fn { color: var(--ed-fn); font-weight: 500; }
.edwin-frame .st { color: var(--ed-st); }
.edwin-frame .dc { color: var(--ed-dc); font-style: italic; }
.edwin-frame .cm { color: var(--ed-cm); font-style: italic; }
.edwin-frame .co, .edwin-frame .nu, .edwin-frame .qu { color: var(--ed-co); }
.edwin-frame .pa { color: var(--ed-pa); }
.edwin-frame .pa.d0 { color: var(--ed-rb0); } .edwin-frame .pa.d1 { color: var(--ed-rb1); } .edwin-frame .pa.d2 { color: var(--ed-rb2); } .edwin-frame .pa.d3 { color: var(--ed-rb3); } .edwin-frame .pa.d4 { color: var(--ed-rb4); } .edwin-frame .pa.d5 { color: var(--ed-rb5); }
.edwin-frame .avy { background: var(--syn-variable, #ffc000); color: var(--panel, #000000); font-weight: 700; border-radius: 2px; }
.edwin-frame .ln.pulse { animation: edwin-pulse 0.45s ease-out; }
@keyframes edwin-pulse { from { background: var(--ed-pulse); } to { background: transparent; } }
.edwin-frame .text.centered .ln { max-width: calc(var(--center-cols, 100) * 1ch); margin-inline: auto; }
.edwin-frame .modeline { display: flex; gap: 0 2ch; flex-wrap: wrap; align-items: center; padding: 2px 10px 2px 2px; background: var(--ed-ml-bg); color: var(--ed-fg); font-size: 13px; line-height: 1.5; white-space: pre; font-variant-numeric: tabular-nums; border-top: 1px solid var(--ed-rule); }
.edwin-frame .ml-tag { font-family: var(--ed-font-ui); font-weight: 600; font-size: 12px; letter-spacing: 0.08em; padding: 0 8px; border-radius: 3px; background: var(--accent, #3548cf); color: var(--panel, #ffffff); margin-left: 2px; }
.edwin-frame .ml-tag[data-state="insert"] { background: var(--syn-type, #006800); }
.edwin-frame .ml-tag[data-state="visual"] { background: var(--syn-variable, #884900); }
.edwin-frame .ml-tag[data-state="replace"] { background: var(--syn-comment, #a60000); }
.edwin-frame .ml-tag[data-state="operator"] { background: var(--muted, #595959); }
.edwin-frame .ml-tag[data-state="motion"] { background: var(--syn-string, #005e8b); }
.edwin-frame .ml-tag[data-state="emacs"] { background: var(--syn-constant, #531ab6); }
.edwin-frame .ml-state { color: var(--ed-dim); margin-left: 8px; }
.edwin-frame .ml-name { font-weight: 600; }
.edwin-frame .ml-pos, .edwin-frame .ml-mode { color: var(--ed-dim); }
.edwin-frame .ml-extra { color: var(--syn-comment, #a60000); font-weight: 500; }
.edwin-frame .ml-sync { color: var(--syn-comment, #a60000); font-weight: 600; }
.edwin-frame .ml-cmd { margin-left: auto; color: var(--ed-fg); font-weight: 500; min-width: 6ch; text-align: right; }
.edwin-frame .win:not(.selected) .modeline { background: var(--ed-ml-inactive); color: var(--ed-dim); }
.edwin-frame .win:not(.selected) .ml-tag { opacity: 0.55; }
.edwin-frame.unfocused .modeline { opacity: 0.85; }
.edwin-frame.bell .win.selected .modeline { animation: edwin-bell 0.18s ease-out; }
@keyframes edwin-bell { from { background: var(--syn-comment, #a60000); color: #fff; } }
.edwin-frame .ed-echo { min-height: 1.5em; padding: 3px 10px 5px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ed-fg); max-height: 50%; overflow-y: auto; flex-shrink: 0; }
.edwin-frame .ed-echo .prompt { color: var(--ed-fn); font-weight: 500; }
.edwin-frame .ed-echo .miniline { display: flex; align-items: baseline; gap: 0; }
.edwin-frame .ed-echo .mb { flex: 1; min-width: 0; }
.edwin-frame .ed-echo .cc { color: var(--ed-dim); min-width: 7ch; font-variant-numeric: tabular-nums; }
.edwin-frame .ed-echo .flash { color: var(--ed-co); margin-left: 1ch; }
.edwin-frame .ed-echo .cands { display: flex; flex-direction: column; margin-top: 3px; border-top: 1px solid var(--ed-rule); padding-top: 3px; }
.edwin-frame .ed-echo .cand, .edwin-frame .corfu .cand { display: flex; gap: 2ch; padding: 0 6px; border-radius: 3px; white-space: pre; overflow: hidden; }
.edwin-frame .ed-echo .cand .cl { flex: 0 0 auto; min-width: 24ch; }
.edwin-frame .ed-echo .cand .cl b, .edwin-frame .corfu .cand .cl b { color: var(--ed-co); font-weight: 600; }
.edwin-frame .ed-echo .cand .ca, .edwin-frame .corfu .cand .ca { color: var(--ed-dim); overflow: hidden; text-overflow: ellipsis; }
.edwin-frame .corfu .cand .ca { margin-left: auto; }
.edwin-frame .ed-echo .cand.sel, .edwin-frame .corfu .cand.sel { background: var(--ed-region); }
.edwin-frame .ed-echo .wkp { color: var(--ed-dim); margin-right: 2ch; }
.edwin-frame .ed-echo .wk { display: inline-flex; gap: 0.75ch; margin-right: 2.5ch; white-space: nowrap; }
.edwin-frame .ed-echo .wk kbd { font-family: var(--ed-font); color: var(--ed-kw); font-weight: 600; }
.edwin-frame .corfu { position: absolute; z-index: 5; background: var(--ed-bg); border: 1px solid var(--ed-rule); border-radius: 4px; box-shadow: 0 8px 24px -12px rgb(20 24 36 / 0.5); font-size: 13px; line-height: 1.5; padding: 3px; max-width: min(60ch, 90%); min-width: 20ch; }
.edwin-frame .snipe { position: absolute; inset: 0; pointer-events: none; z-index: 4; }
.edwin-frame .snipe div { position: absolute; background: var(--syn-variable, #ffc000); opacity: 0.45; border-radius: 2px; }
.edwin-frame .ed-presence { position: absolute; inset: 0; pointer-events: none; z-index: 3; overflow: hidden; }
.edwin-frame .ed-presence .pc { position: absolute; width: 2px; border-radius: 1px; }
.edwin-frame .ed-presence .pc span { position: absolute; left: 0; bottom: 100%; font: 10px var(--ed-font-ui); line-height: 1.3; padding: 0 4px; border-radius: 3px 3px 3px 0; color: #fff; white-space: nowrap; }
.edwin-frame .ed-presence .pr { position: absolute; opacity: 0.3; border-radius: 2px; }
.edwin-frame .ed-presence .faded { transition: opacity 0.6s; opacity: 0; }
.edwin-frame .ed-input { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; font-size: 16px; resize: none; pointer-events: none; }
`;

/* ---------- text primitives (0-based internally; Lisp sees 1-based) ---------- */
function checkRO(b: EdBuffer) { if (b.readOnly && !E.inhibitRO && !(L.get('inhibit-read-only') && (L.get('inhibit-read-only') as SchemeParam).value)) signal('buffer-read-only', b); }
/* ---------- the edit log ----------
   Each change appends { v, pos, del, ins, len, o }: at POS, DEL was replaced by INS, leaving a text of
   LEN characters at version V; O is the edit's origin (E.editOrigin: local, remote, server, agent, disk). Caches remember the version they were built from and ask spanOf for
   the part that changed since; undo goes back by applying the deltas in reverse. Entries older than
   every snapshot that may still be restored are dropped. */
function logEdit(b: EdBuffer, pos: number, del: string, ins: string) {
  const log = b.log;
  log.push({ v: ++b.ver, pos, del, ins, len: b.rope.length, o: E.editOrigin });
  if (log.length > 512 && (log.length & 127) === 0) trimLog(b);
  if (hooks.edited) hooks.edited(b);
}
function trimLog(b: EdBuffer) {
  let min = b.ver;
  for (const s of b.undo) if (s.ver < min) min = s.ver;
  for (const s of b.redo) if (s.ver < min) min = s.ver;
  if (b.pendingUndo && b.pendingUndo.ver < min) min = b.pendingUndo.ver;
  if (b.pin < min) min = b.pin;
  if (b._lv! >= 0 && b._lv! < min && b.ver - b._lv! < 4096) min = b._lv!;
  if (hooks.logFloor) min = Math.min(min, hooks.logFloor(b));
  const log = b.log;
  let k = 0; while (k < log.length && log[k].v <= min) k++;
  if (k) log.splice(0, k);
}
/* Drop all of B's edit log, past every floor: for a buffer whose history is worth nothing and costs memory
   (*compilation*, its output cut from the top as it streams). What cached an older version of the text
   finds that the log no longer reaches back and starts again from the text; undo there is gone. */
function forgetLog(b: EdBuffer) { b.log.length = 0; }
/* Low-level change: no read-only check, no marker adjustment and no change hooks. Returns the removed text. */
function ropeEdit(b: EdBuffer, pos: number, n: number, ins: string) {
  const removed = b.rope.splice(pos, n, ins);
  if (removed || ins) logEdit(b, pos, removed, ins);
  return removed;
}
/* The one marker-shift routine (R6.11, R6.12), for a change at POS of DEL characters into INS:
   - markers after the changed text, and at its end when text was deleted, move by INS - DEL;
   - a marker at POS, or inside the deleted text, goes to POS (before) or POS + INS (after);
   - point and the points of the other windows on the buffer are after markers.
   A marker whose character was deleted is flagged dead (the :g and :normal line markers skip it).
   Markers a deletion moved are remembered by ENTRY, the log entry, so undo puts them back. */
function shiftMarkers(b: EdBuffer, pos: number, del: number, ins: number, entry?: EdLogEntry | null) {
  const e = pos + del, d = ins - del;
  const after = (p: number) => (p < pos ? p : p > e || (del && p === e) ? p + d : pos + ins);
  b.pt = after(b.pt);
  const sw = selWin();
  for (const w of allWindows()) if (w.buffer === b && w !== sw) w.pt = after(w.pt);
  if (!b.markers.size) return;
  let moved: EcMoved | null = null;
  for (const m of b.markers) {
    const p = m.pos;
    if (p === null || p < pos) continue;
    if (p > e || (del && p === e)) {
      if (p === e && del) (moved || (moved = [])).push([m, p, !!m.dead, p + d]);
      m.pos = p + d; continue;
    }
    const q = (m as EdMarker).type === 'after' ? pos + ins : pos;
    if (del) { if (p > pos) (moved || (moved = [])).push([m, p, !!m.dead, q]); m.dead = true; }
    m.pos = q;
  }
  if (moved && entry) markersMoved.set(entry, moved);
}
/* Markers a deletion moved, by log entry: [marker, old position, old dead flag, new position]. */
const markersMoved = new WeakMap<EdLogEntry, EcMoved>();
/* Undoing ENTRY: markers follow the inverse change, and those the deletion moved go back where they
   were, when nothing has moved them since. */
function unshiftMarkers(b: EdBuffer, entry: EdLogEntry) {
  const moved = markersMoved.get(entry);
  const back = moved ? moved.filter(([m, , , q]) => b.markers.has(m) && m.pos === q) : null;
  shiftMarkers(b, entry.pos, entry.ins.length, entry.del.length, null);
  if (back) for (const [m, p, dead] of back) { m.pos = p; m.dead = dead; }
}

/* ---------- change hooks (R4.22, R4.23) ----------
   before-change-functions get (beg end) of the text about to change, after-change-functions get
   (beg end old-len) of the new text, 1-based, with the changed buffer current. They do not run for
   the changes they make themselves (inhibit-modification-hooks is #t inside them). A function that
   signals is reported and removed from the hook, as Emacs does. (edit-origin) says who made the change. */
E.editOrigin = 'local';
let inChangeHook = false;
function changeHooks() {
  if (inChangeHook || E.inhibitModHooks) return false;
  const bf = L.get('before-change-functions'), af = L.get('after-change-functions');
  return (bf && bf !== NIL) || (af && af !== NIL) ? true : false;
}
function runChangeHook(b: EdBuffer, name: string, args: SchemeValue[]) {
  const save = E.current;
  inChangeHook = true; E.current = b;
  try { runHookSafely(name, args); }
  finally { inChangeHook = false; E.current = save; }
}
/* Run the hook NAME with ARGS; a function that signals is reported and taken off the hook, both its
   buffer-local and its default value, so one broken function cannot break every later edit. */
function runHookSafely(name: string, args?: SchemeValue[]) {
  for (const f of L.hookFns(name)) {
    try { L.apply(f, args); }
    catch (e) {
      if (L.isQuit(e)) throw e;
      removeHookEverywhere(name, f);
      message(`Error in ${name} (${(f as SchemeProcedure).procName || pr(f, true)}): ${errorText(e)}; removed it from the hook`);
    }
  }
}
function removeHookEverywhere(name: string, f: SchemeValue) {
  const drop = (v: SchemeValue) => (v && v !== NIL && typeof v !== 'function' ? listOf(arr(v).filter(x => x !== f)) : v === f ? NIL : v);
  const ent = localized.get(name);
  if (ent) { ent.def = drop(ent.def); for (const b of E.buffers) if (b.locals && b.locals.has(name)) b.locals.set(name, drop(b.locals.get(name))); }
  else L.set(name, drop(L.get(name)));
}

/* ---------- buffer-local variables (R4.26) ----------
   A variable made local in some buffer gets an accessor on its global box: reads and writes go to the
   current buffer's own value when it has one, else to the default value. An automatically local
   variable (defvar-local, make-variable-buffer-local) gets a local value whenever it is set.
   Buffer-locals live with the buffer in each runtime; (put 'var 'shared-local #t) marks the ones that
   travel with the buffer's meta once frames share buffers (E3). */
const localized = new Map<string, EdLocalized>();
function localize(name: string) {
  let ent = localized.get(name);
  if (ent) return ent;
  const box = L.S.gbox(name), d = Object.getOwnPropertyDescriptor(box, 'value');
  if (d && d.get) signal('error', `${name} is computed from editor state and cannot be buffer-local`);
  ent = { def: box.value, auto: false };
  Object.defineProperty(box, 'value', {
    get() { const l = E.current && E.current.locals; return l && l.has(name) ? l.get(name) : ent.def; },
    set(v) {
      const b = E.current;
      if (b && ((b.locals && b.locals.has(name)) || (ent.auto && v !== undefined))) (b.locals || (b.locals = new Map())).set(name, v);
      else ent.def = v;
    },
    configurable: true, enumerable: true,
  });
  localized.set(name, ent);
  return ent;
}
function makeLocal(b: EdBuffer, name: string) {
  const ent = localize(name);
  if (!b.locals) b.locals = new Map();
  if (!b.locals.has(name)) b.locals.set(name, ent.def);
}
function localValue(b: EdBuffer, name: string) {
  const ent = localized.get(name);
  if (!ent) return L.get(name);
  return b && b.locals && b.locals.has(name) ? b.locals.get(name) : ent.def;
}
const defaultValue = (name: string) => { const ent = localized.get(name); return ent ? ent.def : L.get(name); };
function setDefault<T extends SchemeValue>(name: string, v: T): T { const ent = localized.get(name); if (ent) ent.def = v; else L.set(name, v); return v; }
L.hooking.defaultValue = defaultValue;
/* Run F with (edit-origin) answering ORIGIN: remote, server, disk or agent (E1 applies edits with it). */
function withOrigin<T>(origin: string, f: () => T): T { const save = E.editOrigin; E.editOrigin = origin; try { return f(); } finally { E.editOrigin = save; } }
/* One change: hooks, the rope, the log, the markers. WHOLE is the whole new text when the caller has it
   (assigning b.text), so a large replacement resets the rope instead of splicing it. */
function editOne(b: EdBuffer, pos: number, n: number, ins: string, whole?: string) {
  const hk = changeHooks();
  if (hk) runChangeHook(b, 'before-change-functions', [pos + 1, pos + n + 1]);
  let removed: string;
  if (whole !== undefined && n + ins.length > (whole.length >> 1)) { removed = b.rope.slice(pos, pos + n); b.rope.reset(whole); if (removed || ins) logEdit(b, pos, removed, ins); }
  else removed = ropeEdit(b, pos, n, ins);
  if (removed || ins) shiftMarkers(b, pos, removed.length, ins.length, b.log[b.log.length - 1]);
  if (hk) runChangeHook(b, 'after-change-functions', [pos + 1, pos + ins.length + 1, removed.length]);
  return removed;
}
/* The one way text changes (R6.8): OPS, an array of [pos, del, ins] applied in order, change the rope,
   shift every marker, append to the log, run the change hooks with (edit-origin) = ORIGIN (local when
   absent: a command), bump b.ver (logEdit) and schedule redisplay. Local commands, remote batches,
   reverts and undo all come through here; hooks.applied tells the protocol client (sync.ts). Returns
   the ops as applied, with the removed text read from the buffer. */
function applyOps(b: EdBuffer, ops: EdEditOp[], origin?: string, whole?: string) {
  const out: EdAppliedOp[] = [], eff = origin || E.editOrigin;
  withOrigin(eff, () => {
    for (const op of ops) {
      const pos = op[0], n = typeof op[1] === 'string' ? op[1].length : op[1], ins = op[2];
      const removed = editOne(b, pos, n, ins, whole);
      if (removed || ins) out.push([pos, removed, ins]);
    }
  });
  if (whole !== undefined && b.rope.length === whole.length) b.rope.flat = whole;
  if (out.length) {
    if (hooks.applied) hooks.applied(b, out, eff);
    for (const f of E.frames) if (f.sel && leaves(f.wroot).some(w => w.buffer === b)) frameEvent('edited', f, b);
    scheduleRender();
  }
  return out;
}
/* The per-op entry the server and the editing primitives use: one change at POS of N characters into INS;
   the origin is the current one (Ed.withOrigin). Returns the removed text. */
function editText(b: EdBuffer, pos: number, n: number, ins: string) {
  const r = applyOps(b, [[pos, n, ins]]);
  return r.length ? r[0][1] : '';
}
/* Assigning b.text: change the differing middle only, as one edit. */
function setText(b: EdBuffer, v: string) {
  const r = b.rope;
  if (r.flat === v) return;
  const old = r.toString();
  if (old === v) return;
  const { pre, suf } = diffSpan(old, v);
  applyOps(b, [[pre, old.length - suf - pre, v.slice(pre, v.length - suf)]], undefined, v);
}
/* Make B's text TEXT by changing only the lines that differ (Rope.diffLines), as one batch by ORIGIN, so
   point, the other windows' points and the markers on an unchanged line stay on it. Whole lines inserted at
   a line start would leave a before marker there (the mark, Evil's marks) on the first inserted line; it is
   moved past them to stay with the line it was on. Neither the read-only flag nor b.modified is touched:
   the caller (revert, a formatter) knows which it wants. LIMIT is the diff's work budget (tests only). */
function applyLineDiff(b: EdBuffer, text: string, origin?: string, limit?: number) {
  const old = b.rope.toString();
  const ops = globalThis.Rope.diffLines(old, text, limit);
  if (!ops.length) return [];
  const lift: [EdMarker | EdTempMarker, number][] = [];
  let shift = 0;
  for (const [pos, del, ins] of ops) {
    const p = pos - shift;
    if (!del && ins.charCodeAt(ins.length - 1) === 10 && (p === 0 || old.charCodeAt(p - 1) === 10))
      for (const m of b.markers) if (m.pos === p && (m as EdMarker).type !== 'after') lift.push([m, ins.length]);
    shift += ins.length - del;
  }
  const out = applyOps(b, ops, origin, ops.length === 1 ? text : undefined);
  for (const [m, n] of lift) if (m.pos !== null) m.pos += n;
  return out;
}
/* Redisplay in the next frame, once for any number of changes. */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued || !E.frames.length) return;
  renderQueued = true;
  host.nextFrame(() => { renderQueued = false; frameRender(); });
}
/* The span changed since version OLD: { pre, suf } lengths of the untouched prefix and suffix, or null
   when the log no longer reaches back that far. */
function spanOf(b: EdBuffer, old: number) {
  const log = b.log;
  let pre = Infinity, suf = Infinity, k = log.length - 1;
  for (; k >= 0 && log[k].v > old; k--) {
    const e = log[k];
    if (e.pos < pre) pre = e.pos;
    const s = e.len - e.pos - e.ins.length; if (s < suf) suf = s;
  }
  if (k < 0 && (!log.length || log[0].v !== old + 1)) return old === b.ver ? { pre: b.rope.length, suf: 0 } : null;
  if (pre === Infinity) return { pre: b.rope.length, suf: 0 };
  return { pre, suf };
}
/* Whether the text differs from what it was at version VER (an edit undone by another is no change). */
function changedSince(b: EdBuffer, ver: number) {
  if (ver === b.ver) return false;
  const log = b.log;
  let k = log.length - 1, pre = Infinity, suf = Infinity, n = 0;
  for (; k >= 0 && log[k].v > ver; k--, n++) { const e = log[k]; if (e.pos < pre) pre = e.pos; const s = e.len - e.pos - e.ins.length; if (s < suf) suf = s; }
  if (k < 0 && (!log.length || log[0].v !== ver + 1)) return true;
  const len = b.rope.length;
  if (n > 64 || len - suf - pre > 1 << 20) return true;
  const now = b.rope.slice(pre, len - suf);
  let then = now;
  for (let j = log.length - 1; j > k; j--) { const e = log[j], a = e.pos - pre; then = then.slice(0, a) + e.del + then.slice(a + e.ins.length); }
  return then !== now;
}
function insertText(b: EdBuffer, s: string) {
  if (!s) return;
  checkRO(b);
  editText(b, b.pt, 0, s);
  b.modified = true;
}
function deleteText(b: EdBuffer, s: number, e: number) {
  if (s > e) [s, e] = [e, s];
  s = Math.max(0, s); e = Math.min(b.rope.length, e);
  if (s === e) return '';
  checkRO(b);
  const gone = editText(b, s, e - s, '');
  b.modified = true;
  return gone;
}
/* Replace [s, e) with str as one edit, keeping point relative to the end of the text when it was after e. */
function replaceText(b: EdBuffer, s: number, e: number, str: string) {
  const pt = b.pt;
  b.pt = s; deleteText(b, s, e); b.pt = s; insertText(b, str);
  b.pt = pt >= e ? pt - (e - s) + str.length : Math.min(pt, s + str.length);
}
/* Line and column helpers take a string or a rope (the rope has the String read methods). */
const bol = (t: EdText, p: number) => p <= 0 ? 0 : t.lastIndexOf('\n', p - 1) + 1;
const eol = (t: EdText, p: number) => { const k = t.indexOf('\n', p); return k < 0 ? t.length : k; };
/* The rope behind T: T itself, or the buffer whose cached whole text is T. */
function ropeOf(t: EdText) {
  if (typeof t !== 'string') return t;
  const c = E.current;
  if (c && c.rope.flat === t) return c.rope;
  if (E.sel && E.sel.buffer && E.sel.buffer.rope.flat === t) return E.sel.buffer.rope;
  for (const b of E.buffers) if (b.rope.flat === t) return b.rope;
  return null;
}
const lineNo = (t: EdText, p: number) => { const r = ropeOf(t); if (r) return r.lineOf(p); let n = 1; for (let k = t.indexOf('\n'); k >= 0 && k < p; k = t.indexOf('\n', k + 1)) n++; return n; };
function column(t: EdText, p: number) { let c = 0; for (let k = bol(t, p); k < p; k++) c = t.charCodeAt(k) === 9 ? (c + 8) & ~7 : c + 1; return c; }
/* Position of COL on the line starting at LS (clamped to the line end). */
function posAtColumn(t: EdText, ls: number, col: number) { const le = eol(t, ls); let c = 0, k = ls; while (k < le) { const w = t.charCodeAt(k) === 9 ? ((c + 8) & ~7) - c : 1; if (c + w > col) break; c += w; k++; } return k; }
/* Number of the last line that holds text: a final newline ends the last line rather than starting a new one. */
function lastLineStart(t: EdText) { return t.length && t.charCodeAt(t.length - 1) === 10 ? bol(t, t.length - 1) : bol(t, t.length); }
function lineStartOf(t: EdText, n: number) { const r = ropeOf(t); if (r) return r.lineStart(n); let p = 0; for (let k = 1; k < n; k++) { const q = t.indexOf('\n', p); if (q < 0) return p; p = q + 1; } return p; }
/* Line numbers and line starts come from the rope's newline counts, O(log n). */
function lineNoB(b: EdBuffer, p: number) { return b.rope.lineOf(p); }
function lineStartB(b: EdBuffer, n: number) { return b.rope.lineStart(Math.max(1, n)); }
function lineCountB(b: EdBuffer) { const r = b.rope, nl = r.newlines(); return r.length && r.charCodeAt(r.length - 1) === 10 ? nl : nl + 1; }
function lineIndex(b: EdBuffer) { const r = b.rope, out = [0]; for (let k = r.indexOf('\n'); k >= 0; k = r.indexOf('\n', k + 1)) out.push(k + 1); return out; }
/* Syntax classes and paren depths, cached per text version and updated incrementally: an edit
   re-lexes only from the top-level form (a paren in column 0, as Emacs assumes) before the change
   to the one after it, and the untouched classes on both sides are kept. The class and depth arrays
   are updated in place (with spare capacity), so an edit moves the tail instead of copying both. The lex
   is of the buffer's Lisp dialect (Scheme's in a buffer of none); a change of dialect lexes it all again. */
function lexOf(b: EdBuffer, soft?: boolean) {
  const dia = lispDialect(b) || 'scheme';
  if (b._ldia !== dia) { b._lc = null; b._ldia = dia; }
  if (b._lv === b.ver && b._lc) return b._lc;
  /* Redisplay (SOFT) does not wait for the lex of a big buffer when most of it must be lexed (the
     first time, or after a change of more than 1MB): the worker pool makes it and the text shows
     plain until then. A command that needs the classes lexes at once. */
  if (soft && b.rope.length > (1 << 19) && globalThis.EdPool && EdPool.ok) {
    if (b._lexBusy) return null;
    const sp = b._lc ? spanOf(b, b._lv!) : null;
    if ((!sp || b.rope.length - sp.suf - sp.pre > (1 << 20)) && EdPool.lexAsync(b)) return null;
  }
  const r = b.rope, n = r.length;
  const span = b._lc ? spanOf(b, b._lv!) : null;
  if (!span || Math.abs(n - b._llen!) > 100000) {
    const t = r.toString();
    b._lcb = b._lc = markDocstrings(t, lex(t, undefined, dia), 0, undefined, 0, dia); b._ldb = b._ld = parenDepths(t, b._lc, 0, n, 0); b._lv = b.ver; b._llen = n;
    return b._lc;
  }
  /* _lc and _ld are views of length n on buffers with spare capacity (_lcb, _ldb), so reads past
     the end give undefined as they do on an exact-size array. */
  const oc = b._lcb as Uint8Array, od = b._ldb as Uint8Array, oldN = b._llen!, shift = n - oldN;
  /* Clean restart points: a column-0 paren the old lex saw as a real paren. */
  let s = span.pre;
  for (;;) { s = s === 0 ? 0 : r.lastIndexOf('\n(', s - 1) + 1; if (s <= 0) { s = 0; break; } if (oc[s] === C.PAR && oc[s - 1] !== C.STR && oc[s - 1] !== C.DOC) break; s--; }
  let e = n - span.suf;
  for (;;) { e = r.indexOf('\n(', e); if (e < 0) { e = n; break; } e++; if (oc[e - shift] === C.PAR) break; }
  const info: EcLexInfo = {};
  let mid = lex(r.slice(s, e), info, dia);
  if (info.dirty && e < n) { e = n; mid = lex(r.slice(s), info, dia); }
  const startDepth = s < n && r.charCodeAt(s) === 40 ? od[s] : 0;
  let cls = oc, d = od;
  if (cls.length < n) {
    const cap = n + (n >> 2) + 4096;
    cls = new Uint8Array(cap); cls.set(oc.subarray(0, s)); if (e < n) cls.set(oc.subarray(e - shift, oldN), e);
    d = new Uint8Array(cap); d.set(od.subarray(0, s)); if (e < n) d.set(od.subarray(e - shift, oldN), e);
  } else if (e < n && shift) { cls.copyWithin(e, e - shift, oldN); d.copyWithin(e, e - shift, oldN); }
  cls.set(mid, s);
  const base = Math.max(0, s - 1);
  markDocstrings(r.slice(base, Math.min(n, e + 65536)), cls, Math.max(0, s - 1), e, base, dia);
  d.fill(0, s, e);
  const end = parenDepths(r, cls, s, e, startDepth, d) as number;
  if (e < n && ((end % 6) + 6) % 6 !== d[e]) parenDepths(r, cls, e, n, end, d);
  b._lcb = cls; b._ldb = d; b._lc = cls.subarray(0, n); b._ld = d.subarray(0, n); b._lv = b.ver; b._llen = n;
  return b._lc;
}
/* A lex made elsewhere (the worker pool) for version VER of B in dialect DIA: kept only while B is still read in it. */
function installLex(b: EdBuffer, ver: number, cls: Uint8Array | number[], d: unknown, dia: string) {
  if ((lispDialect(b) || 'scheme') !== dia) return;
  b._lcb = b._lc = cls; b._ldb = b._ld = d; b._lv = ver; b._llen = cls.length; b._ldia = dia;
}
/* Lengths of the common prefix and suffix of two texts (the suffix never overlaps the prefix). */
function diffSpan(a: string, b: string) {
  const n = Math.min(a.length, b.length);
  let pre = 0; while (pre < n && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  let suf = 0; while (suf < n - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  return { pre, suf };
}
function parenDepths(t: EdText, cls: ArrayLike<number>, from: number, to: number, depth: number, d?: Uint8Array): number | Uint8Array {
  const ret = arguments.length > 5;
  d = d || new Uint8Array(t.length);
  for (let k = from; k < to; k++) if (cls[k] === C.PAR) { if (openAt(t, k)) { d[k] = ((depth % 6) + 6) % 6; depth++; } else { depth--; d[k] = ((depth % 6) + 6) % 6; } }
  return ret ? depth : d;
}

/* ---------- strings and comments outside Lisp: what % passes over (se-match-nonlisp) ---------- */
/* How a language writes its strings: each quote's opener and closer, whether a backslash escapes the next
   character (BS; NIX: Nix's '' string, where ''$ ''' and ''\ are its escapes), whether it ends at the end of its
   line (LINE: an unterminated one stops there instead of swallowing the file), and the opener of the code
   interpolated into it (INTERP, closed by the } matching it), which is code again, and the characters it does not
   open after (AFTER: Nix's '' after a name, which may end in ' as a' and a'' do). Longer openers first. A
   language's mode, or the nearest mode it derives from, picks its entry; other programming modes take "…" on
   one line. A quote goes over lines only where nothing else in the language holds it unpaired: Rust's char
   literals ('"') and raw strings (r#"…"#) and shell's here-documents and $'…' are not read, so their quotes are
   one-line ones, and a wrong guess there costs the rest of its line, not of the file. Not here either: Python's
   f-string {…} and shell's $(…) (string, not code), JavaScript's regexp literals, C++'s raw strings, C#'s
   verbatim strings. */
type Quote = { open: string; close: string; esc: 'bs' | 'nix' | null; line: boolean; interp?: string; after?: RegExp };
const Q = (open: string, close: string, esc: Quote['esc'], line: boolean, interp?: string, after?: RegExp): Quote => ({ open, close, esc, line, interp, after });
const DQ_LINE = Q('"', '"', 'bs', true), SQ_LINE = Q("'", "'", 'bs', true);
const C_LIKE = [DQ_LINE, SQ_LINE];
const QUOTES: Record<string, Quote[]> = {
  'python-mode': [Q('"""', '"""', 'bs', false), Q("'''", "'''", 'bs', false), DQ_LINE, SQ_LINE],
  'js-mode': [DQ_LINE, SQ_LINE, Q('`', '`', 'bs', false, '${')],
  'typescript-mode': [DQ_LINE, SQ_LINE, Q('`', '`', 'bs', false, '${')],
  'tsx-mode': [DQ_LINE, SQ_LINE, Q('`', '`', 'bs', false, '${')],
  'nix-mode': [Q("''", "''", 'nix', false, '${', /[A-Za-z0-9_'-]/),Q('"', '"', 'bs', false, '${')],
  'c-mode': C_LIKE, 'c++-mode': C_LIKE, 'java-mode': C_LIKE, 'csharp-mode': C_LIKE,
  'go-mode': [DQ_LINE, SQ_LINE, Q('`', '`', null, false)],
  'sh-mode': [Q("'", "'", null, true), DQ_LINE],
};
/* The classes of text T for a language with QUOTES and comments LINE (a line comment's opener) and OPEN..CLOSE
   (a block comment's), each null where it has none: C.STR in a string (its quotes, and an interpolation's ${ and
   }), C.CMT in a comment, C.PLAIN in code, an interpolation's code too. In SHELL a # opens a comment only where it
   does not follow $, { or a word character ($#, ${#a} and a#b are code); elsewhere every # in code does. */
function codeLex(t: string, quotes: Quote[], line: string | null, open: string | null, close: string | null, shell = false) {
  const n = t.length, cls = new Uint8Array(n);
  /* The code units that can begin something in code (a comment, a string, an interpolation's { or }), and in each
     quote's string (its escape, its closer, its interpolation, its line's end): the text between is skipped. */
  const table = (ss: (string | null | undefined)[]) => { const u = new Uint8Array(65536); for (const x of ss) if (x) u[x.charCodeAt(0)] = 1; return u; };
  const inCode = table([line, open, '{', '}', ...quotes.map(o => o.open)]);
  const inString = new Map(quotes.map(o => [o, table([o.close, o.interp, o.esc === 'bs' ? '\\' : o.esc === 'nix' ? "''" : null, o.line ? '\n' : null])]));
  /* The strings an interpolation is in, innermost last, each with the depth of { inside its code. */
  const frames: { q: Quote; depth: number }[] = [];
  let q: Quote | null = null, i = 0;
  const lineAt = (k: number) => {
    if (!line || !t.startsWith(line, k)) return false;
    if (!shell || line !== '#' || k === 0) return true;
    return !/[$\{\p{L}\p{N}_]/u.test(t[k - 1]);
  };
  while (i < n) {
    if (q) {
      const s: Quote = q, stop = inString.get(s)!;
      let j = i; while (j < n && !stop[t.charCodeAt(j)]) j++;
      cls.fill(C.STR, i, j); i = j;
      if (i >= n) break;
      if (s.esc === 'bs' && t.charCodeAt(i) === 92) { cls.fill(C.STR, i, Math.min(n, i + 2)); i += 2; continue; }
      if (s.esc === 'nix' && t.startsWith("''", i) && (t[i + 2] === '$' || t[i + 2] === "'" || t[i + 2] === '\\')) { cls.fill(C.STR, i, Math.min(n, i + 3)); i += 3; continue; }
      if (s.interp && t.startsWith(s.interp, i)) { cls.fill(C.STR, i, i + s.interp.length); i += s.interp.length; frames.push({ q: s, depth: 0 }); q = null; continue; }
      if (t.startsWith(s.close, i)) { cls.fill(C.STR, i, i + s.close.length); i += s.close.length; q = null; continue; }
      if (s.line && t.charCodeAt(i) === 10) { q = null; continue; }
      cls[i++] = C.STR;
      continue;
    }
    while (i < n && !inCode[t.charCodeAt(i)]) i++;
    if (i >= n) break;
    const ch = t[i];
    if (lineAt(i)) { const e = t.indexOf('\n', i); const end = e < 0 ? n : e; cls.fill(C.CMT, i, end); i = end; continue; }
    if (open && close && t.startsWith(open, i)) { const e = t.indexOf(close, i + open.length); const end = e < 0 ? n : e + close.length; cls.fill(C.CMT, i, end); i = end; continue; }
    const f = frames.length ? frames[frames.length - 1] : null;
    if (f && ch === '{') f.depth++;
    else if (f && ch === '}') {
      if (f.depth === 0) { cls[i++] = C.STR; q = f.q; frames.pop(); continue; }
      f.depth--;
    } else {
      const s = quotes.find(o => t.startsWith(o.open, i) && !(o.after && i > 0 && o.after.test(t[i - 1])));
      if (s) { cls.fill(C.STR, i, i + s.open.length); i += s.open.length; q = s; continue; }
    }
    i++;
  }
  return cls;
}
/* The classes codeLex gives buffer B, a programming language's (MODE's QUOTES or the plain "…"), with its comment
   syntax LINE OPEN CLOSE: kept for B's version, so % again or after moving lexes nothing. */
function codeLexOf(b: EdBuffer, line: string | null, open: string | null, close: string | null) {
  const mode = modeChain(b.mode).find(m => Object.prototype.hasOwnProperty.call(QUOTES, m));
  const key = `${mode}\u0000${line}\u0000${open}\u0000${close}`;
  if (b._cxv === b.ver && b._cxk === key) return b._cxc as Uint8Array;
  const cls = codeLex(b.rope.toString(), mode ? QUOTES[mode] : [DQ_LINE], line, open, close, mode === 'sh-mode');
  b._cxv = b.ver; b._cxk = key; b._cxc = cls;
  return cls;
}

/* ---------- Lisp lexer: syntax classes for highlighting and sexp motion ---------- */
const C = { PLAIN: 0, CMT: 1, STR: 2, PAR: 3, NUM: 4, KW: 5, FN: 6, CONST: 7, QUO: 8, DOC: 9 };
/* The words highlighted as keywords after an open paren, and those that define a name (the next token is
   highlighted as one, and a column-0 form that starts with one is a definition for consult-imenu), per dialect. */
const words = (s: string) => s.trim().split(/\s+/);
const LISP_DEFINERS: Record<string, string[]> = {
  scheme: words('define define-syntax define-macro define-record-type define-command evil-define-motion evil-define-operator evil-define-text-object evil-define-command'),
  elisp: words(`defun defmacro defsubst defvar defvar-local defconst defcustom defface defgroup defalias define-minor-mode
    define-derived-mode define-globalized-minor-mode cl-defun cl-defmacro cl-defsubst cl-defmethod cl-defgeneric cl-defstruct ert-deftest
    transient-define-prefix transient-define-suffix transient-define-infix transient-define-argument`),
  cl: words(`defun defmacro defvar defparameter defconstant defgeneric defmethod defclass defstruct deftype define-condition
    defpackage defsetf define-compiler-macro define-modify-macro define-setf-expander`),
  clojure: words('def defn defn- defmacro defmulti defmethod defonce defprotocol defrecord deftype definterface defstruct ns deftest'),
};
const LISP_KEYWORDS: Record<string, string[]> = {
  scheme: words(`define define-syntax define-macro define-record-type define-command define-values lambda let let* letrec letrec*
    named-lambda if when unless cond case and or not do while until dolist dotimes begin set! quote quasiquote syntax-rules
    parameterize guard dynamic-wind call/ec catch throw unwind-protect ignore-errors save-excursion with-current-buffer interactive
    let-values receive assert delay push! pop! inc! dec! when-let if-let and-let* -> ->> evil-define-motion evil-define-operator
    evil-define-text-object evil-define-key evil-ex-define-cmd define-key global-set-key`),
  elisp: words(`lambda let let* letrec if when unless cond and or not progn prog1 prog2 while dolist dotimes catch throw
    unwind-protect condition-case ignore-errors save-excursion save-restriction save-match-data with-current-buffer
    with-temp-buffer with-eval-after-load interactive pcase pcase-let pcase-dolist when-let when-let* if-let if-let* and-let*
    setq setq-local setq-default quote function require provide use-package cl-loop cl-case cl-flet cl-labels cl-letf
    declare`),
  cl: words(`lambda let let* flet labels macrolet symbol-macrolet if when unless cond case ecase ccase typecase etypecase and
    or not progn prog1 prog2 loop do do* dolist dotimes block return return-from catch throw unwind-protect handler-case
    handler-bind restart-case ignore-errors multiple-value-bind destructuring-bind setf setq declare declaim eval-when
    tagbody go in-package quote function the locally`),
  clojure: words(`fn fn* let letfn loop recur if if-not if-let if-some when when-not when-let when-some when-first cond condp case
    do doto doseq dotimes for while try catch finally throw quote var new set! binding -> ->> as-> some-> some->> cond->
    cond->> and or not comment reify proxy extend-type extend-protocol`),
};
for (const d in LISP_DEFINERS) LISP_KEYWORDS[d].push(...LISP_DEFINERS[d]);
/* With no prototype, so a dialect that is none of these (constructor, __proto__) finds nothing and lex reads Scheme. */
const KEYWORDS_OF: Record<string, Set<string>> = Object.create(null), DEFINERS_OF: Record<string, Set<string>> = Object.create(null);
for (const d in LISP_KEYWORDS) { KEYWORDS_OF[d] = new Set(LISP_KEYWORDS[d]); DEFINERS_OF[d] = new Set(LISP_DEFINERS[d]); }
const isWS = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isDelim = (c: string | undefined) => c === undefined || isWS(c) || '()";\'`,[]'.includes(c);
/* Brackets are ( ) and [ ] (Emacs Lisp vectors, R7RS's other parentheses), and in Clojure { } too, one depth for
   every kind as in Emacs's scan-lists. A datum comment #; (#_ in Clojure) comments out the next datum: PEND holds the
   start and the depth of each one still waiting, and the first datum that ends at that depth (an atom, a string, a
   character literal, a list once closed) is classed CMT back to its #;, so #;#;a b comments out both, as R7RS reads
   it. A close bracket before any datum drops the #; waiting inside the list it closes. A #; whose datum the text ends
   inside (an open list) comments out the rest, as an unterminated string or #| does: the classes before an
   edit then never depend on a bracket after it, so lexOf can restart at a column-0 paren. A slice that ends
   with a #; still waiting is dirty, and lexOf lexes on to the end. A # prefix right before a bracket (#( #u8(
   #s(, Clojure's #{, #?( and #?@( ) belongs to the list's datum, as the reader takes #( whole, and is no datum of its
   own. Where Emacs reads it as a prefix too (a # alone, # being an expression prefix in its syntax tables, Clojure's
   #? and #?@, Emacs Lisp's #s) it is classed a quote prefix, so the sexp motions and the indenter take it with its
   list; #u8 and Common Lisp's #2A stay a sexp of their own to them, as to Emacs.
   The CMT fills are made at the end, latest first, each up to the lowest start filled so far, so a run of #; fills
   each character once. DIALECT (lispDialect's) changes what the reader takes: a character literal is #\c in Scheme
   and Common Lisp, ?c or ?\c in Emacs Lisp and \c in Clojure, the character after it whatever it is; in Clojure a
   comma is a blank, ~ unquotes and #"..." is a regexp, read as a string. */
function lex(t: string, info?: EcLexInfo, dialect = 'scheme') {
  const n = t.length, cls = new Uint8Array(n), pend: number[] = [], fills: number[] = [];
  const clj = dialect === 'clojure', el = dialect === 'elisp';
  const kws = KEYWORDS_OF[dialect] || KEYWORDS_OF.scheme, defs = DEFINERS_OF[dialect] || DEFINERS_OF.scheme;
  const delim = clj ? (c: string | undefined) => isDelim(c) || c === '{' || c === '}' : isDelim;
  if (info) info.dirty = false;
  let i = 0, quoted = false, afterParen = false, defName = false, depth = 0;
  const datum = () => {
    if (pend.length && pend[pend.length - 1] === depth) { pend.pop(); fills.push(pend.pop()!, i); quoted = false; defName = false; }
  };
  /* A character literal from I, its character starting at J: that character whatever it is, then a name (#\space,
     ?\C-a, \newline) on to the next delimiter when the character is not one. */
  const charLit = (j: number) => {
    if (j < n) { if (el && t[j] === '\\' && j + 1 < n) j++; if (!delim(t[j++])) while (j < n && !delim(t[j])) { if (el && t[j] === '\\') j++; j++; } }
    j = Math.min(j, n); cls.fill(C.NUM, i, j); i = j; quoted = false; afterParen = false; datum();
  };
  while (i < n) {
    const ch = t[i];
    if (ch === ';') { while (i < n && t[i] !== '\n') cls[i++] = C.CMT; continue; }
    if (ch === '"') {
      cls[i++] = C.STR;
      while (i < n && t[i] !== '"') { if (t[i] === '\\' && i + 1 < n) cls[i++] = C.STR; cls[i++] = C.STR; }
      if (i < n) cls[i++] = C.STR; else if (info) info.dirty = true;
      quoted = false; afterParen = false; datum(); continue;
    }
    if (ch === '(' || ch === '[' || (clj && ch === '{')) { if (ch === '(' && i > 0 && t[i - 1] === '\n') { quoted = false; defName = false; } cls[i++] = C.PAR; afterParen = ch === '('; depth++; continue; }
    if (ch === ')' || ch === ']' || (clj && ch === '}')) {
      cls[i++] = C.PAR; afterParen = false; depth--;
      while (pend.length && pend[pend.length - 1] > depth) pend.length -= 2;
      datum(); continue;
    }
    if (isWS(ch) || (clj && ch === ',')) { i++; continue; }
    if (ch === "'" || ch === '`' || ch === ',' || ch === '@' || (clj && ch === '~') || (ch === '#' && t[i + 1] === "'")) {
      cls[i++] = C.QUO; if (ch === '#') cls[i++] = C.QUO; quoted = ch !== ',' && ch !== '@' && ch !== '~'; afterParen = false; continue;
    }
    if (clj ? ch === '\\' : el ? ch === '?' : ch === '#' && t[i + 1] === '\\') { charLit(i + (clj || el ? 1 : 2)); continue; }
    if (clj && ch === '#' && t[i + 1] === '"') { cls[i++] = C.QUO; afterParen = false; continue; }
    if (ch === '#' && t[i + 1] === (clj ? '_' : ';')) { cls[i] = cls[i + 1] = C.CMT; pend.push(i, depth); i += 2; continue; }
    if (ch === '#' && (t[i + 1] === 't' || t[i + 1] === 'f') && delim(t[i + 2])) { cls[i++] = C.CONST; cls[i++] = C.CONST; afterParen = false; datum(); continue; }
    if (ch === '#' && t[i + 1] === ':') { let j = i + 2; while (j < n && !delim(t[j])) j++; for (let m = i; m < j; m++) cls[m] = C.CONST; i = j; afterParen = false; datum(); continue; }
    if (ch === '#' && t[i + 1] === '|') { let j = t.indexOf('|#', i + 2); if (j < 0 && info) info.dirty = true; j = j < 0 ? n : j + 2; for (let m = i; m < j; m++) cls[m] = C.CMT; i = j; continue; }
    let j = i; while (j < n && !delim(t[j])) { if (t[j] === '\\') j++; j++; }
    if (j === i) { i++; continue; }
    const tok = t.slice(i, j);
    let k = C.PLAIN;
    if (defName && clj && tok[0] === '^') k = C.CONST;
    else if (defName) { k = C.FN; defName = false; }
    else if (quoted || tok[0] === ':' || tok[tok.length - 1] === ':' || tok === '#t' || tok === '#f') k = C.CONST;
    else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) k = C.NUM;
    else if (afterParen && kws.has(tok)) { k = C.KW; defName = defs.has(tok); }
    const end = Math.min(j, n), list = tok[0] === '#' && (t[end] === '(' || t[end] === '[' || (clj && t[end] === '{'));
    cls.fill(list && (tok === '#' || (clj && (tok === '#?' || tok === '#?@')) || (el && tok === '#s')) ? C.QUO : k, i, end);
    i = end; afterParen = false;
    if (list) continue;
    quoted = false; datum();
  }
  if (pend.length) { fills.push(pend[0], n); if (info) info.dirty = true; }
  for (let f = fills.length - 2, low = n; f >= 0; f -= 2) if (fills[f] < low) { cls.fill(C.CMT, fills[f], Math.min(fills[f + 1], low)); low = fills[f]; }
  return cls;
}
/* Docstrings: a string that directly follows the argument list of a defun/defmacro, (define (f x) "doc" ...) in
   Scheme, (defun f (x) "doc" ...) in Emacs and Common Lisp, and in Clojure the one after the name, (defn f "doc" [x]).
   T may be a piece of the text that starts at BASE; FROM and TO are positions in the whole text. */
function markDocstrings(t: string, cls: Uint8Array, from?: number, to?: number, base?: number, dialect = 'scheme') {
  base = base || 0;
  const view = base ? cls.subarray(base) : cls;
  const res: Record<string, RegExp> = {
    scheme: /\((?:define|define-command|evil-define-(?:motion|operator|text-object|command))\s+\(/g,
    elisp: /\((?:defun|defmacro|defsubst|cl-defun|cl-defmacro|cl-defsubst|cl-defgeneric)\s+[^\s()";']+\s+\(/g,
    cl: /\((?:defun|defmacro|defgeneric|deftype|define-compiler-macro)\s+[^\s()";']+\s+\(/g,
    clojure: /\((?:defn-?|defmacro|defmulti|defprotocol)\s+(?:\^[^\s()[\]{}"]+\s+)*[^\s()[\]{}";^]+\s+(?=")/g,
  };
  const re = Object.prototype.hasOwnProperty.call(res, dialect) ? res[dialect] : res.scheme, after = dialect === 'clojure';
  let m: RegExpExecArray | null;
  re.lastIndex = from ? from - base : 0;
  while ((m = re.exec(t))) {
    if (to !== undefined && m.index + base >= to) break;
    let k = m.index + m[0].length;
    if (!after) {
      const open = k - 1;
      if (view[open] !== C.PAR) continue;
      const close = forwardSexp(t, view, open); if (close === null) continue;
      k = close; while (k < t.length && isWS(t[k])) k++;
    }
    if (t[k] === '"' && view[k] === C.STR) { const e = forwardSexp(t, view, k)!; for (let q = k; q < e; q++) view[q] = C.DOC; }
  }
  return cls;
}
/* The sexp scanners read characters with charAt, so they work on a string or on the buffer's rope. They read the
   kinds of bracket off the classes, ( [ { and ) ] } each classed as a bracket only in the dialects that have them,
   and a comma classed plain (Clojure's) as a blank. */
const inStr = (c: number) => c === C.STR || c === C.DOC;
const openAt = (t: EdText, k: number) => { const c = t.charCodeAt(k); return c === 40 || c === 91 || c === 123; };
const blankAt = (t: EdText, cls: ArrayLike<number>, k: number) => { const c = t.charAt(k); return isWS(c) || (c === ',' && cls[k] === C.PLAIN); };
function forwardSexp(t: EdText, cls: ArrayLike<number>, p: number) {
  const n = t.length;
  for (;;) { while (p < n && blankAt(t, cls, p)) p++; if (p < n && cls[p] === C.CMT) { while (p < n && cls[p] === C.CMT) p++; continue; } break; }
  while (p < n && cls[p] === C.QUO) p++;
  if (p >= n) return null;
  const c = t.charAt(p);
  if (c === '"' && inStr(cls[p])) { let k = p + 1; while (k < n && t.charCodeAt(k) !== 34) { if (t.charCodeAt(k) === 92) k++; k++; } return Math.min(n, k + 1); }
  if (cls[p] === C.PAR) {
    if (!openAt(t, p)) return null;
    let d = 0;
    for (; p < n; p++) if (cls[p] === C.PAR) { if (openAt(t, p)) d++; else if (--d === 0) return p + 1; }
    return null;
  }
  while (p < n && (cls[p] === C.NUM || (!isDelim(t.charAt(p)) && cls[p] !== C.PAR))) p++;
  return p;
}
function backwardSexp(t: EdText, cls: ArrayLike<number>, p: number) {
  for (;;) { while (p > 0 && blankAt(t, cls, p - 1)) p--; if (p > 0 && cls[p - 1] === C.CMT) { while (p > 0 && cls[p - 1] === C.CMT) p--; continue; } break; }
  if (p <= 0) return null;
  if (inStr(cls[p - 1])) { p--; while (p > 0 && inStr(cls[p - 1])) p--; }
  else if (cls[p - 1] === C.PAR && openAt(t, p - 1)) return null;
  else if (cls[p - 1] === C.PAR) {
    let d = 0;
    for (p = p - 1; p >= 0; p--) if (cls[p] === C.PAR) { if (!openAt(t, p)) d++; else if (--d === 0) break; }
    if (p < 0) return null;
  } else {
    while (p > 0 && (cls[p - 1] === C.NUM || (!isDelim(t.charAt(p - 1)) && cls[p - 1] !== C.PAR))) p--;
  }
  while (p > 0 && cls[p - 1] === C.QUO) p--;
  return p;
}
function upList(t: EdText, cls: ArrayLike<number>, p: number) { let d = 0; for (let k = p - 1; k >= 0; k--) if (cls[k] === C.PAR) { if (!openAt(t, k)) d++; else if (d-- === 0) return k; } return null; }
function matchParen(t: EdText, cls: ArrayLike<number>, k: number) {
  if (openAt(t, k)) { const e = forwardSexp(t, cls, k); return e === null ? null : e - 1; }
  return backwardSexp(t, cls, k + 1);
}

/* ---------- Lisp brackets: where a position stands, and whether an edit keeps the brackets balanced ---------- */
const isOpen = (c: string) => c === '(' || c === '[' || c === '{';
/* The string that holds the character at K, as [START, END, CLOSED]: START its opening quote, END past its closing
   one (the text's end when it has none, CLOSED #f). A run of string classes can hold more than one string ("a""b"),
   so the run is read from its start, string by string, as the lexer reads it. */
function stringAt(t: EdText, cls: ArrayLike<number>, k: number): [number, number, boolean] | null {
  const n = t.length;
  if (k < 0 || k >= n || !inStr(cls[k])) return null;
  let s = k; while (s > 0 && inStr(cls[s - 1])) s--;
  while (s <= k) {
    let j = s + 1, closed = false;
    while (j < n) { const c = t.charCodeAt(j); if (c === 92) { j += 2; continue; } j++; if (c === 34) { closed = true; break; } }
    j = Math.min(j, n);
    if (k < j) return [s, j, closed];
    s = j;
  }
  return null;
}
/* Whether position P (between characters) is inside a string: after its opening quote, up to its closing one. */
function inStringAt(t: EdText, cls: ArrayLike<number>, p: number) { const r = stringAt(t, cls, p - 1); return !!r && (p < r[1] || !r[2]); }
/* Whether position P is inside a comment: a ; comment up to its line's end, a #| |# or a #; datum. */
function inCommentAt(t: EdText, cls: ArrayLike<number>, p: number) {
  const n = t.length;
  if (p <= 0 || cls[p - 1] !== C.CMT) return false;
  if (p < n && cls[p] === C.CMT) return true;
  if (p < n && t.charAt(p) !== '\n') return false;
  let s = p - 1; while (s > 0 && cls[s - 1] === C.CMT) s--;
  return t.charAt(s) === ';';
}
/* Whether the character at K is a backslash that escapes the one after it, in code or in a string: the run of
   backslashes it ends is odd, as the lexer pairs them (#\\( is the character \ before a real bracket). */
function escapingAt(t: EdText, cls: ArrayLike<number>, k: number) {
  if (k < 0 || k + 1 >= t.length || t.charCodeAt(k) !== 92 || cls[k] === C.CMT) return false;
  let j = k; while (j > 0 && t.charCodeAt(j - 1) === 92 && cls[j - 1] !== C.CMT) j--;
  return (k - j) % 2 === 0;
}
/* Forward out of the list around P: the position after its closing bracket, or null at top level. */
function upListForward(t: EdText, cls: ArrayLike<number>, p: number) {
  let d = 0;
  for (let k = p, n = t.length; k < n; k++) if (cls[k] === C.PAR) { if (isOpen(t.charAt(k))) d++; else if (d-- === 0) return k + 1; }
  return null;
}
/* Forward into the next list after P: the position after its opening bracket, or null when a closing bracket or
   the text's end comes first. */
function downList(t: EdText, cls: ArrayLike<number>, p: number) {
  for (let k = p, n = t.length; k < n; k++) if (cls[k] === C.PAR) return isOpen(t.charAt(k)) ? k + 1 : null;
  return null;
}
/* Backward into the list before P: the position before its closing bracket, or null when an opening bracket or the
   text's start comes first. */
function backwardDownList(t: EdText, cls: ArrayLike<number>, p: number) {
  for (let k = p - 1; k >= 0; k--) if (cls[k] === C.PAR) return isOpen(t.charAt(k)) ? null : k;
  return null;
}
/* The start of the next list after P, at P's depth, or null when the list around P closes first. */
function nextListStart(t: EdText, cls: ArrayLike<number>, p: number) {
  for (let k = p, n = t.length; k < n; k++) if (cls[k] === C.PAR) return isOpen(t.charAt(k)) ? k : null;
  return null;
}
/* The end of the last list before P, at P's depth, or null when the list around P opens first. */
function prevListEnd(t: EdText, cls: ArrayLike<number>, p: number) {
  for (let k = p - 1; k >= 0; k--) if (cls[k] === C.PAR) return isOpen(t.charAt(k)) ? null : k + 1;
  return null;
}
/* A top-level form starts with a bracket in column 0, as Emacs's open-paren-in-column-0 convention has it. */
const defunAt = (t: EdText, cls: ArrayLike<number>, ls: number) => ls < t.length && isOpen(t.charAt(ls)) && cls[ls] === C.PAR;
/* The line start of the last top-level form starting at or before P, or -1. */
function defunBefore(t: EdText, cls: ArrayLike<number>, p: number) {
  for (let ls = bol(t, Math.min(p, t.length)); ; ls = bol(t, ls - 1)) { if (defunAt(t, cls, ls)) return ls; if (ls === 0) return -1; }
}
/* The line start of the first top-level form starting after P, or -1. */
function defunAfter(t: EdText, cls: ArrayLike<number>, p: number) {
  const n = t.length;
  for (let ls = eol(t, p) + 1; ls < n; ls = eol(t, ls) + 1) if (defunAt(t, cls, ls)) return ls;
  return -1;
}
/* Whether the Lisp text S is balanced: its brackets never close more than they opened and end closed, and no
   string, #| comment or #; datum runs on to its end. With CLOSED, S is a piece of a larger text that ends at a
   list's closing bracket, so that bracket must still be read as one: a ; comment open at the piece's end would run
   on past it, through the line's rest outside the piece. */
function balancedLisp(s: string, closed = false, dialect = 'scheme') {
  const info = { dirty: false }, cls = lex(s, info, dialect);
  let d = 0;
  for (let k = 0; k < s.length; k++) if (cls[k] === C.PAR) { if (isOpen(s[k])) d++; else if (--d < 0) return false; }
  return d === 0 && !info.dirty && (!closed || cls[s.length - 1] === C.PAR);
}
/* Whether S..E of the text T, whose classes are CLS (the buffer's own lex), is balanced, read off CLS with no lexing.
   S is where the lexer is in its first state (the text's start or a bracket classed as one); E is a bracket classed
   as one, the position after one, or the text's end. Before a bracket or after one nothing is left open; at the
   text's end only a string, a #| comment or a #; still waiting can be, so the last of those is lexed again. */
function balancedRange(t: EdText, cls: ArrayLike<number>, s: number, e: number, dialect = 'scheme') {
  let d = 0;
  for (let k = s; k < e; k++) if (cls[k] === C.PAR) { if (openAt(t, k)) d++; else if (--d < 0) return false; }
  if (d !== 0 || e < t.length) return d === 0;
  let k = e - 1; while (k >= s && isWS(t.charAt(k))) k--;
  if (k < s || (!inStr(cls[k]) && cls[k] !== C.CMT)) return true;
  if (inStr(cls[k])) { const r = stringAt(t, cls, k); return !!r && r[2] && k === r[1] - 1; }
  let c = k; while (c > s && cls[c - 1] === C.CMT) c--;
  return balancedLisp(t.slice(c, e), false, dialect);
}
/* The span of text an edit of FROM..TO is judged on, as [START, END], or null when that text was not balanced to
   begin with (a buffer being repaired, which is edited as typed). The span is first the text from the last line
   that starts with a bracket at or before FROM to the next one after TO, which is one top-level form or one entry of
   a list written in column 0. When that is not balanced, and the whole text is, the span is the innermost list
   around FROM that holds TO before its closing bracket, or at top level the whole text. Each is judged on the
   buffer's classes, with no lexing. */
function balanceSpan(t: EdText, cls: ArrayLike<number>, from: number, to: number, dialect = 'scheme'): [number, number] | null {
  const n = t.length, s = Math.max(0, defunBefore(t, cls, from)), a = defunAfter(t, cls, to), e = a < 0 ? n : a;
  if (balancedRange(t, cls, s, e, dialect)) return [s, e];
  if (!balancedRange(t, cls, 0, n, dialect)) return null;
  for (let o = upList(t, cls, from); o !== null; o = upList(t, cls, o)) {
    const z = forwardSexp(t, cls, o);
    if (z !== null && to < z) return [o, z];
  }
  return [0, n];
}
/* Whether replacing FROM..TO of the text T (classes CLS) with TEXT leaves the span SPAN (from balanceSpan)
   balanced. Only the text around the edit is lexed: from the bracket before FROM to the one after TO (or the span's
   ends), where the lexer is in its first state. The edit keeps the span balanced when that piece, lexed with TEXT
   in place, leaves nothing open, ends with the same bracket, changes the depth by as much as before and never goes
   lower than before: the text outside it then lexes as before, at the same depths. Anything else (a #; that takes
   the next datum, an edit refused) is judged on the whole span, lexed again; a span that ends at a list's closing
   bracket (the innermost list around the edit) must still end with that bracket, else a ; comment opened in the
   span runs on past it (typing ) between the # and ; of a #; datum: #); comments out the line's rest). */
function keepsBalance(t: EdText, cls: ArrayLike<number>, span: [number, number], from: number, to: number, text: string, dialect = 'scheme') {
  const [s, e] = span;
  let a = from; while (a > s && cls[a - 1] !== C.PAR) a--;
  let z = to; while (z < e && cls[z] !== C.PAR) z++;
  const bracket = z < e; if (bracket) z++;
  let d = 0, low = 0;
  for (let k = a; k < z; k++) if (cls[k] === C.PAR) { d += isOpen(t.charAt(k)) ? 1 : -1; low = Math.min(low, d); }
  const piece = t.slice(a, from) + text + t.slice(to, z), info = { dirty: false }, pc = lex(piece, info, dialect);
  let nd = 0, nlow = 0;
  for (let k = 0; k < piece.length; k++) if (pc[k] === C.PAR) { nd += isOpen(piece[k]) ? 1 : -1; nlow = Math.min(nlow, nd); }
  if (!info.dirty && nd === d && nlow >= low && (!bracket || pc[piece.length - 1] === C.PAR)) return true;
  return balancedLisp(t.slice(s, from) + text + t.slice(to, e), e < t.length && cls[e - 1] === C.PAR, dialect);
}

/* ---------- Lisp indentation ---------- */
/* Emacs's calculate-lisp-indent with scheme-mode's scheme-indent-function or emacs-lisp-mode's lisp-indent-function
   (Emacs 31). A form's method is how many of its arguments are distinguished (indented by 4 on lines of their own;
   the body after them by 2), or defun (the body by 2), or let (Scheme's: a named let has two). A head with no method
   lines its arguments up under the first one, or under the first sexp of the line before. SCHEME is scheme.el's table
   (with its MIT Scheme forms, on by default, but not the -components ones) and the forms Edwin's own Scheme defines,
   given the method of their Emacs Lisp namesakes; ELISP is the declare forms of the macros Emacs and the owner's
   configuration use. In Scheme a head of more than three characters that starts with def and has no method is a
   defun, as scheme-mode has it; Emacs Lisp no longer has that rule. */
type IndentMethod = number | 'defun' | 'let';
const SCHEME_INDENT: Record<string, IndentMethod> = {
  begin: 0, case: 1, delay: 0, do: 2, lambda: 1, let: 'let', 'let*': 1, letrec: 1, 'let-values': 1, 'let*-values': 1, 'and-let*': 1,
  sequence: 0, 'let-syntax': 1, 'letrec-syntax': 1, 'syntax-rules': 'defun', 'syntax-case': 2, 'with-syntax': 1, library: 1, 'eval-when': 1,
  'call-with-input-file': 1, 'call-with-port': 1, 'with-input-from-file': 1, 'with-input-from-port': 1, 'call-with-output-file': 1,
  'with-output-to-file': 1, 'with-output-to-port': 1, 'call-with-values': 1, 'dynamic-wind': 3, when: 1, unless: 1, 'letrec*': 1,
  parameterize: 1, 'define-values': 1, 'define-record-type': 1, 'define-library': 1, guard: 1, receive: 2, 'test-group': 1,
  'test-group-with-cleanup': 1, match: 1, 'match-lambda': 0, 'match-lambda*': 0, 'match-let': 'let', 'match-let*': 1, 'match-letrec': 1,
  'opt-lambda': 1, 'opt*-lambda': 1, 'let-optionals': 2, 'let-optionals*': 2, 'check-case': 1, 'fluid-let': 1, 'in-package': 1,
  'local-declare': 1, macro: 1, 'make-environment': 0, 'named-lambda': 1, 'using-syntax': 1, 'with-input-from-string': 1,
  'with-output-to-string': 0, 'with-values': 1, 'syntax-table-define': 2, 'list-transform-positive': 1, 'list-transform-negative': 1,
  'list-search-positive': 1, 'list-search-negative': 1,
  while: 1, dolist: 1, dotimes: 1, 'save-excursion': 0, 'with-current-buffer': 1, 'with-inhibit-read-only': 0, 'ignore-errors': 0,
  'with-mutex': 1, 'with-timeout': 1, 'on-server': 0, 'on-frames': 0, 'gptel-make-preset': 1, 'evil--bind': 1, 'evil-define-key': 'defun', 'evil-define-command': 'defun',
  'evil-define-motion': 'defun', 'evil-define-operator': 'defun', 'evil-define-text-object': 'defun' };
const ELISP_INDENT: Record<string, IndentMethod> = {
  autoload: 'defun', progn: 0, defvar: 'defun', defalias: 'defun', defvaralias: 'defun', defconst: 'defun', prog1: 1, prog2: 2,
  'save-excursion': 0, 'save-restriction': 0, 'save-current-buffer': 0, 'save-match-data': 0, 'save-window-excursion': 0,
  let: 1, 'let*': 1, while: 1, if: 2, catch: 1, 'condition-case': 2, 'unwind-protect': 1, lambda: 'defun', defun: 2, defmacro: 2,
  defsubst: 2, defcustom: 'defun', defface: 'defun', defgroup: 'defun', 'defvar-local': 'defun', 'defvar-keymap': 1,
  'define-minor-mode': 'defun', 'define-derived-mode': 'defun', 'define-globalized-minor-mode': 'defun', 'define-advice': 2,
  'define-inline': 'defun', defclass: 'defun', when: 1, unless: 1, dolist: 1, dotimes: 1, 'dolist-with-progress-reporter': 2,
  'with-current-buffer': 1, 'with-temp-buffer': 0, 'with-temp-file': 1, 'with-output-to-string': 0, 'with-output-to-temp-buffer': 1,
  'with-eval-after-load': 1, 'eval-after-load': 1, 'eval-and-compile': 0, 'with-selected-window': 1, 'with-selected-frame': 1,
  'with-demoted-errors': 1, 'with-no-warnings': 0, 'with-suppressed-warnings': 1, 'with-silent-modifications': 0, 'with-syntax-table': 1,
  'with-temp-message': 1, 'with-timeout': 1, 'with-local-quit': 0, 'with-help-window': 1, 'with-memoization': 1, 'with-mutex': 1,
  'ignore-errors': 0, 'ignore-error': 1, 'handler-bind': 1, 'when-let': 1, 'when-let*': 1, 'if-let': 2, 'if-let*': 2, 'and-let*': 1,
  'while-let': 1, 'named-let': 2, letrec: 1, dlet: 1, 'let-alist': 1, pcase: 1, 'pcase-exhaustive': 1, 'pcase-let': 1, 'pcase-let*': 1,
  'pcase-dolist': 1, 'seq-doseq': 1, 'seq-let': 2, 'thread-first': 0, 'thread-last': 0, 'cl-defun': 2, 'cl-defmacro': 2, 'cl-defsubst': 2,
  'cl-defmethod': 'defun', 'cl-defgeneric': 2, 'cl-defstruct': 1, 'cl-flet': 1, 'cl-labels': 1, 'cl-macrolet': 1, 'cl-letf': 1,
  'cl-letf*': 1, 'cl-case': 1, 'cl-ecase': 1, 'cl-block': 1, 'cl-dolist': 1, 'cl-dotimes': 1, 'cl-destructuring-bind': 2,
  'cl-multiple-value-bind': 2, 'ert-deftest': 2, 'use-package': 'defun', 'evil-define-key': 'defun', 'evil-define-key*': 'defun',
  'evil-define-command': 'defun', 'evil-define-motion': 'defun', 'evil-define-operator': 'defun', 'evil-define-text-object': 'defun',
  'transient-define-prefix': 'defun', 'transient-define-suffix': 'defun', 'transient-define-infix': 'defun',
  'transient-define-argument': 'defun', 'general-def': 'defun', 'evil-with-state': 'defun', 'gptel-make-openai': 1,
  'gptel-make-preset': 1, 'org-with-remote-undo': 1 };
/* Common Lisp's forms as Emacs 31's lisp-mode indents them (common-lisp-indent-function, cl-indent.el), each spec
   reduced to its number of distinguished arguments: cl-indent puts each of those at +4 and the first body form at +2,
   and the rest under the line before. cond's spec, (&rest (&whole 2 &rest 1)), is 0 here: its first clause at +2 and
   the rest under the line before. ignore-errors has no spec of cl-indent's own: Emacs takes its Emacs Lisp indent
   property, 0. if's spec, (&rest nil), puts every argument under the line before, as no entry does. A head with no
   entry that starts with def is a defun (two: the name and the lambda list), one that starts with with-, without- or
   do- has one. CL_INNER names the forms whose subforms are defun-like in their turn: a local function of flet, labels
   and macrolet (in its first argument's list) and a clause of handler-case and restart-case (each argument after the
   first), each with one distinguished argument (its lambda list). CL_LAMBDA names the forms whose spec has &lambda,
   by the argument that is a lambda list (defmethod's comes after its qualifiers). CL_FIRST names the forms whose
   spec gives their first argument an offset of its own, not 4: unwind-protect's (5 &body), and (&whole 6 ...) or 6
   for multiple-value-bind's and defclass's first argument and the forms whose spec is theirs. CL_TAGS names the forms
   whose later arguments are a tagbody (lisp-indent-tagbody), by the index of the first and the offset of a statement:
   tagbody's from the first argument, prog's and prog*'s after the lambda list, each statement at +3; do's and do*'s
   after the end test (lisp-indent-do), each statement at +2; a tag, a line that starts with a symbol or word
   character, at +1 in all of them. */
const CL_INDENT: Record<string, number> = {
  block: 1, case: 1, ccase: 1, ecase: 1, typecase: 1, etypecase: 1, ctypecase: 1, catch: 1, cond: 0, defvar: 1,
  defconstant: 1, defparameter: 1, defclass: 2, 'define-condition': 2, 'define-modify-macro': 2, defsetf: 3, defun: 2,
  defgeneric: 2, defmethod: 2, 'define-setf-method': 2, 'define-setf-expander': 2, defmacro: 2, defsubst: 2, deftype: 2,
  defpackage: 1, defstruct: 1, 'destructuring-bind': 2, do: 2, 'do*': 2, dolist: 1, dotimes: 1, 'eval-when': 1, flet: 1,
  labels: 1, macrolet: 1, 'handler-case': 1, 'restart-case': 1, 'ignore-errors': 0, lambda: 1, let: 1, 'let*': 1,
  'handler-bind': 1, 'restart-bind': 1, 'symbol-macrolet': 1, locally: 1, ':method': 1, 'multiple-value-bind': 2,
  'multiple-value-call': 1, 'multiple-value-prog1': 1, 'multiple-value-setq': 1, 'pprint-logical-block': 1,
  'print-unreadable-object': 1, prog: 1, 'prog*': 1, prog1: 1, prog2: 2, progn: 0, progv: 2, return: 0, 'return-from': 1,
  throw: 1, unless: 1, 'unwind-protect': 1, when: 1, 'with-accessors': 2, 'with-condition-restarts': 2,
  'with-compilation-unit': 1, 'with-output-to-string': 1, 'with-slots': 2, 'with-standard-io-syntax': 0 };
const CL_INNER: Record<string, [depth: number, from: number, to: number]> = {
  flet: [2, 1, 1], labels: [2, 1, 1], macrolet: [2, 1, 1], 'handler-case': [1, 2, Infinity], 'restart-case': [1, 2, Infinity] };
const CL_LAMBDA: Record<string, number> = {
  defun: 2, defmacro: 2, defgeneric: 2, defsubst: 2, deftype: 2, 'define-setf-method': 2, 'define-setf-expander': 2,
  'define-modify-macro': 2, defsetf: 2, lambda: 1, ':method': 1, prog: 1, 'prog*': 1, 'with-compilation-unit': 1 };
const CL_FIRST: Record<string, number> = {
  'unwind-protect': 5, 'multiple-value-bind': 6, 'destructuring-bind': 6, 'with-slots': 6, 'with-accessors': 6,
  'with-condition-restarts': 6, defclass: 6, 'define-condition': 6 };
const CL_TAGS: Record<string, [from: number, statement: number]> = { tagbody: [1, 3], prog: [2, 3], 'prog*': [2, 3], do: [3, 2], 'do*': [3, 2] };
/* A tagbody tag: a line that starts with a symbol or word character, as lisp-mode's syntax table has them. */
const CL_TAG = /^[\p{L}\p{N}_\-+*/<>=!?$%&~^:@.]/u;
/* A lambda-list keyword, as cl-indent's lisp-indent-lambda-list-keywords-regexp (case folded, as Emacs searches):
   anywhere in a text, and at the start of one. */
const LAMBDA_WORD = '&(?:optional|rest|key|allow-other-keys|aux|whole|body|environment)(?:[ \\t]|$)';
const LAMBDA_KEY = new RegExp(LAMBDA_WORD, 'gim'), LAMBDA_LEAD = new RegExp('^' + LAMBDA_WORD, 'i');
/* Clojure's forms as clojure-mode 5.23 indents them (clojure-indent-function, its define-clojure-indent table in the
   legacy form its backtracking engine reads): N, N special arguments at +4 and the body at +2; defn, the body at +2;
   a list, a spec for each argument (the last for the rest), a nested list a spec for the forms inside that argument. */
type CljSpec = number | 'defn' | null | CljSpec[];
const CLJ_INDENT: Record<string, CljSpec> = {
  ns: 1, fn: 'defn', def: 'defn', defn: 'defn', 'bound-fn': 'defn', if: 1, 'if-not': 1, case: 1, cond: 0, condp: 2,
  'cond->': 1, 'cond->>': 1, when: 1, while: 1, 'when-not': 1, 'when-first': 1, do: 0, delay: 0, future: 0, comment: 0,
  doto: 1, locking: 1, proxy: [2, ['defn']], 'as->': 2, fdef: 1, reify: ['defn', ['defn']], deftype: [2, ['defn']],
  defrecord: [2, ['defn']], defprotocol: [1, ['defn']], definterface: [1, ['defn']], extend: 1, 'extend-protocol': [1, 'defn'],
  'extend-type': [1, 'defn'], specify: [1, 'defn'], 'specify!': [1, 'defn'], try: 0, catch: 2, finally: 0, let: 1,
  letfn: [1, [['defn']], null], binding: 1, loop: 1, for: 1, doseq: 1, dotimes: 1, 'when-let': 1, 'if-let': 1, 'when-some': 1,
  'if-some': 1, 'this-as': 1, defmethod: 'defn', testing: 1, deftest: 'defn', are: 2, 'use-fixtures': 'defn', async: 1,
  run: 'defn', 'run*': 'defn', fresh: 'defn', 'alt!': 0, 'alt!!': 0, go: 0, 'go-loop': 1, thread: 0 };
const own = <T,>(o: Record<string, T>, k: string) => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
/* clojure--get-indent-method: NAME's spec, or that of its part after a / (str/join), or that of if, when, let or
   while for a name that goes on from one of them with a symbol character (if-let*, when-foo). */
function cljMethod(name: string): CljSpec | undefined {
  let m = own(CLJ_INDENT, name);
  if (m === undefined && name.includes('/')) m = own(CLJ_INDENT, name.slice(name.lastIndexOf('/') + 1));
  if (m === undefined) { const w = /^(if|when|let|while)[^\p{L}\p{N}]/u.exec(name); if (w) m = own(CLJ_INDENT, w[1]); }
  return m;
}
/* Whether the text from FROM to P on P's line is blanks only. */
function blankTo(t: EdText, from: number, p: number) { for (let k = from; k < p; k++) { const c = t.charAt(k); if (c !== ' ' && c !== '\t') return false; } return true; }
/* The first sexp that starts on P's line, before P: Emacs parses the line from its start, so it may be inside a
   list that line closes. A string the line starts inside is passed over. */
function firstSexpOnLine(t: EdText, cls: ArrayLike<number>, p: number) {
  let k = bol(t, p);
  if (k > 0 && inStr(cls[k - 1]) && inStr(cls[k])) while (k < p && inStr(cls[k])) k++;
  for (; k < p; k++) {
    const c = t.charAt(k);
    if (c === ' ' || c === '\t' || cls[k] === C.CMT || (cls[k] === C.PAR && !openAt(t, k))) continue;
    break;
  }
  return k;
}
/* The number of sexps from P that end before the line that starts at LS, counted up to MAX. */
function sexpsBefore(t: EdText, cls: ArrayLike<number>, p: number, ls: number, max: number) {
  let n = 0;
  while (n < max) { const e = forwardSexp(t, cls, p); if (e === null || e > ls || e <= p) break; n++; p = e; }
  return n;
}
/* The head of the list that opens at OPEN, as [START, END, NAME], NAME past its prefix characters (' ` , @ #),
   which Emacs passes over to read it, or null for an empty list. */
function listHead(t: EdText, cls: ArrayLike<number>, open: number): [number, number, string] | null {
  const fe = forwardSexp(t, cls, open + 1); if (fe === null) return null;
  const f = backwardSexp(t, cls, fe)!;
  let h = f; while (h < fe && (cls[h] === C.QUO || t.charAt(h) === '#')) h++;
  return [f, fe, t.slice(h, fe)];
}
/* The column for the line that starts at LS in a Lisp text, or null to leave it: it starts in a string or a
   comment over lines (#| |#, a #; datum), or with ;;; (Emacs leaves those). DIALECT is the text's (lispDialect's):
   Scheme and Emacs Lisp as Emacs's calculate-lisp-indent with scheme-mode's scheme-indent-function or
   emacs-lisp-mode's lisp-indent-function, Common Lisp with lisp-mode's common-lisp-indent-function, Clojure with
   clojure-mode's clojure-indent-function. */
function lispIndentFor(t: EdText, cls: ArrayLike<number>, ls: number, dialect = 'scheme') {
  if (ls > 0 && (inStr(cls[ls - 1]) || cls[ls - 1] === C.CMT) && (inStr(cls[ls]) || cls[ls] === C.CMT)) return null;
  let ie = ls; while (ie < t.length && (t.charAt(ie) === ' ' || t.charAt(ie) === '\t')) ie++;
  if (t.charAt(ie) === ';' && t.charAt(ie + 1) === ';' && t.charAt(ie + 2) === ';') return null;
  const open = upList(t, cls, ls);
  if (open === null) return 0;
  const oc = column(t, open);
  /* The last whole sexp before the line; none: under the open paren's next character. */
  const last = backwardSexp(t, cls, ls);
  if (last === null || last <= open) return oc + 1;
  const fe = forwardSexp(t, cls, open + 1)!, f = backwardSexp(t, cls, fe)!;
  const fLine = last < eol(t, f) + 1;
  /* The head past its prefix characters (' ` , @ #), which Emacs passes over to read it. */
  let h = f; while (h < fe && (cls[h] === C.QUO || t.charAt(h) === '#')) h++;
  const fc = t.charAt(h);
  /* normal-indent: on the head's line under the first argument, but under the head when it is alone there or the
     open paren is followed by a blank; on later lines under the line before's first sexp. */
  let normal: number;
  if (!fLine) normal = column(t, firstSexpOnLine(t, cls, last));
  else if (f === last || /\s/.test(t.charAt(open + 1))) normal = column(t, f);
  else normal = column(t, backwardSexp(t, cls, forwardSexp(t, cls, fe)!)!);
  if (dialect === 'clojure') return cljIndentFor(t, cls, ls, open, oc, f, fe, normal);
  /* The head is no symbol (a list, a vector, a string): under it, or under the line before's first sexp; in Common
     Lisp under it past its prefix (cl-indent puts the line after (#(a) at 2, after (#'(a) at 3), and the lists around
     may still decide (a lambda list that starts with a specialized parameter). */
  if (fc === '(' || fc === '[' || fc === '"') {
    const under = column(t, fLine ? (dialect === 'cl' ? h : f) : firstSexpOnLine(t, cls, last));
    return dialect === 'cl' ? clIndentFor(t, cls, ls, open, oc, under) : under;
  }
  if (dialect === 'cl') return clIndentFor(t, cls, ls, open, oc, normal);
  const head = t.slice(h, fe), elisp = dialect === 'elisp', table = elisp ? ELISP_INDENT : SCHEME_INDENT;
  let method: IndentMethod | undefined = own(table, head);
  if (method === undefined && !elisp && head.length > 3 && head.startsWith('def')) method = 'defun';
  if (method === 'let') {
    let a = fe; while (t.charAt(a) === ' ' || t.charAt(a) === '\t') a++;
    method = /[-a-zA-Z0-9+*/?!@$%^&_:~]/.test(t.charAt(a)) ? 2 : 1;
  }
  let want: number | null = null;
  if (method === 'defun') { if (last < eol(t, open) + 1) want = oc + 2; }
  else if (typeof method === 'number') {
    /* The arguments that start before the line, counted up to one past the distinguished ones. */
    const n = sexpsBefore(t, cls, fe, ls, method + 1), count = method - n;
    if (count > 0) want = n <= 1 ? oc + 4 : normal;
    else if (count === 0 && (method === 0 || oc + 2 <= normal)) want = oc + 2;
    else want = normal;
  }
  if (want !== null) return want;
  /* A line that starts with a keyword goes under the keyword that starts the line before, as Emacs does. */
  if (t.charAt(ie) === ':') {
    let p = last;
    while (!blankTo(t, bol(t, p), p) && !blankTo(t, open + 1, p)) { const q = backwardSexp(t, cls, p); if (q === null || q <= open) break; p = q; }
    if (p > f && t.charAt(p) === ':') return column(t, p);
  }
  return normal;
}
/* common-lisp-indent-function, its specs reduced to CL_INDENT, CL_INNER, CL_LAMBDA, CL_FIRST and CL_TAGS. A line
   directly in a loop goes at +6 in an extended loop (one whose first argument starts with a keyword or a word
   character, or that has none) and at +1 in a simple one. Else, walking out from the list around the line (OPEN, at
   column OC) through up to three lists, the first that decides gives the column. A list quoted with ' or written #(
   holds data: its elements go under the first. A head of its own (its package prefix dropped, cl:when as when) with
   N distinguished arguments puts an argument at +4 (the first at CL_FIRST's offset where it has one) while there are
   no more than N before the line (the head counted), the first body form at +2 and the rest at NORMAL, or a line in
   the tagbody of a CL_TAGS head at its tag or statement offset; around an inner list it gives NORMAL, but for the subforms
   CL_INNER names, which are defun-like, and for a lambda list: the argument CL_LAMBDA names, or the first argument
   of a CL_INNER subform. A def head of no entry counts only if nothing around it decides. A method's qualifiers
   (defmethod foo :around ...), the atoms after its name, are distinguished arguments of their own. */
function clIndentFor(t: EdText, cls: ArrayLike<number>, ls: number, open: number, oc: number, normal: number) {
  const rule = (o: number, fe: number, method: number, first = 4) => {
    const n = 1 + sexpsBefore(t, cls, fe, ls, method + 1);
    return n <= method ? column(t, o) + (n === 1 ? first : 4) : n === method + 1 ? column(t, o) + 2 : normal;
  };
  /* lisp-indent-tagbody, for the line that is the Nth element of the list at O: a tag at +1, a statement at +STATEMENT. */
  const tagbody = (o: number, statement: number) => {
    let ie = ls; while (t.charAt(ie) === ' ' || t.charAt(ie) === '\t') ie++;
    return column(t, o) + (CL_TAG.test(t.slice(ie, ie + 1)) ? 1 : statement);
  };
  /* The index of the element of the list at O that starts at X, the head 0. */
  const index = (o: number, x: number) => {
    let k = 0; for (let p = o + 1, e = forwardSexp(t, cls, p); e !== null && e <= x; p = e, e = forwardSexp(t, cls, p)) k++;
    return k;
  };
  /* The number of qualifiers of the defmethod whose head ends at FE: the sexps after its name up to a list. */
  const qualifiers = (fe: number) => {
    let p = forwardSexp(t, cls, fe) ?? fe, k = 0;
    for (let e = forwardSexp(t, cls, p); e !== null && e > p && t.charAt(backwardSexp(t, cls, e)!) !== '('; e = forwardSexp(t, cls, p)) { k++; p = e; }
    return k;
  };
  /* lisp-indent-lambda-list, for the line in the lambda list at OPEN: one that starts with a lambda-list keyword
     goes under the first parameter, any other at the last keyword before it + 2, or under the first parameter. */
  const lambdaList = () => {
    let ie = ls; while (t.charAt(ie) === ' ' || t.charAt(ie) === '\t') ie++;
    if (LAMBDA_LEAD.test(t.slice(ie, eol(t, ie)))) return oc + 1;
    let col = oc + 1;
    for (const m of t.slice(open, ls - 1).matchAll(LAMBDA_KEY)) col = column(t, open + m.index) + 2;
    return col;
  };
  let tentative: number | null = null, grand = open, child = open, o: number | null = open;
  for (let depth = 0; o !== null && depth < 3; depth++, grand = child, child = o, o = upList(t, cls, o)) {
    const q = o > 0 ? t.charAt(o - 1) : '';
    if ((q === "'" && (o < 2 || t.charAt(o - 2) !== '#')) || q === '#') return oc + 1;
    const hd = listHead(t, cls, o);
    if (!hd || /^[(["]/.test(t.charAt(hd[0]))) continue;
    if (depth === 0 && hd[0] === o + 1 && t.slice(hd[0], hd[1]).toLowerCase() === 'loop') {
      const e2 = forwardSexp(t, cls, hd[1]);
      const extended = e2 === null || e2 <= hd[1] || /[:\p{L}\p{N}]/u.test(t.charAt(backwardSexp(t, cls, e2)!));
      return oc + (extended ? 6 : 1);
    }
    let name = hd[2].toLowerCase(); const colon = name.lastIndexOf(':');
    if (colon > 0) name = name.slice(colon + 1);
    let method = own(CL_INDENT, name);
    if (depth === 0) {
      if (method === undefined) {
        if (name.startsWith('def')) { tentative = rule(o, hd[1], 2); continue; }
        if (/^(with|without|do)-/.test(name)) method = 1;
      } else if (name === 'defmethod') method = 2 + qualifiers(hd[1]);
      const tags = own(CL_TAGS, name);
      if (tags && 1 + sexpsBefore(t, cls, hd[1], ls, tags[0]) >= tags[0]) return tagbody(o, tags[1]);
      if (method !== undefined) return rule(o, hd[1], method, own(CL_FIRST, name));
      continue;
    }
    if (method === undefined) continue;
    const k = index(o, child);
    if (depth === 1 && k === (name === 'defmethod' ? 2 + qualifiers(hd[1]) : own(CL_LAMBDA, name))) return lambdaList();
    const inner = own(CL_INNER, name);
    if (inner && k >= inner[1] && k <= inner[2]) {
      if (inner[0] === depth) { const ih = listHead(t, cls, open); return ih ? rule(open, ih[1], 1) : normal; }
      if (inner[0] + 1 === depth && index(child, grand) === 1) return lambdaList();
    }
    return tentative ?? normal;
  }
  return tentative ?? normal;
}
/* clojure-indent-function: a vector, a map, a set, a reader conditional (#?( #?@( ) or a list whose head is no
   symbol holds data, its elements under the first; else the head's spec, found by walking out through up to three
   lists around it (clojure--find-indent-spec-backtracking), decides: N puts the arguments up to the Nth at +4, the
   next at +2 and the rest at NORMAL; defn puts the body at +2. With no spec a head that starts with def (not
   default) or with-, after any namespace, takes the body at +2, and any other NORMAL. */
function cljIndentFor(t: EdText, cls: ArrayLike<number>, ls: number, open: number, oc: number, f: number, fe: number, normal: number) {
  const bracket = t.charAt(open);
  let q = open; while (q > 0 && t.charAt(q - 1) === '@') q--;
  const reader = q > 1 && t.charAt(q - 1) === '?' && t.charAt(q - 2) === '#';
  if (bracket === '[' || bracket === '{' || reader || f !== open + 1 || /[(["`~^@;\\,{]/.test(t.charAt(f))) return oc + 1;
  const name = t.slice(f, fe);
  let method = cljSpecAt(t, cls, open, name, 0);
  if (Array.isArray(method)) method = method.length === 1 && typeof method[0] === 'number' ? method[0] : null;
  if (typeof method === 'number') {
    const pos = 1 + sexpsBefore(t, cls, fe, ls, method + 2);
    return pos <= method ? oc + 4 : pos === method + 1 ? oc + 2 : normal;
  }
  if (method === 'defn') return oc + 2;
  if (name[0] !== ':') { const m = /^(?:\S+\/)?(def[a-z]*|with-)/.exec(name); if (m && !m[1].startsWith('default')) return oc + 2; }
  return normal;
}
/* The spec that applies at the list opening at OPEN, its head NAME (null when its first element is no symbol), which
   is the POSth element of its parent's list when DEPTH > 0: the head's own, or else what the lists around it give
   for this element, read as clojure-mode does (a spec of one element applies to the list itself, or to every element
   when it is a list; a longer one to the element at its position, the last element to the rest). */
function cljSpecAt(t: EdText, cls: ArrayLike<number>, open: number, name: string | null, depth: number, pos = 0): CljSpec | undefined {
  let method = name ? cljMethod(name) : undefined;
  if (method === undefined && depth < 3) {
    const up = upList(t, cls, open);
    if (up !== null && column(t, open) > 0) {
      let k = 0, p = up + 1;
      for (let e = forwardSexp(t, cls, p); e !== null && e <= open; p = e, e = forwardSexp(t, cls, p)) k++;
      const hd = listHead(t, cls, up);
      method = cljSpecAt(t, cls, up, hd && !/^[(["{`~^@\\]/.test(t.charAt(hd[0])) ? t.slice(hd[0], hd[1]) : null, depth + 1, k);
    }
  }
  if (typeof method === 'number') method = [method];
  if (method === 'defn') return pos === 0 ? 'defn' : undefined;
  if (!Array.isArray(method) || !method.length) return undefined;
  if (method.length === 1) return pos === 0 || Array.isArray(method[0]) ? method[0] : undefined;
  return method[Math.min(pos, method.length - 1)];
}
function indentLine(b: EdBuffer) {
  const t = b.rope, ls = bol(t, b.pt);
  const cls = lexOf(b)!;
  const want = lispIndentFor(t, cls, ls, lispDialect(b) || 'scheme');
  if (want === null) return;
  let ie = ls; while (ie < t.length && (t.charAt(ie) === ' ' || t.charAt(ie) === '\t')) ie++;
  const have = column(t, ie);
  const offset = b.pt - ie;
  if (have !== want) {
    const save = b.pt; b.pt = ls; deleteText(b, ls, ie); b.pt = ls; insertText(b, ' '.repeat(want));
    b.pt = offset > 0 ? ls + want + offset : ls + want; void save;
  } else if (offset < 0) b.pt = ie;
}

/* ---------- keymaps ---------- */
interface Keymap extends EdKeymap {}
class Keymap {
  constructor(name?: string | null) { this.name = (name || null) as string; this.map = new Map(); this.parent = null; }
  __print() { return '#<keymap' + (this.name ? ' ' + this.name : '') + '>'; }
  get __type() { return 'keymap'; }
}
const PREFIX = Symbol('prefix');
const ALIAS: Record<string, string> = { '<return>': 'RET', '<tab>': 'TAB', '<backtab>': 'S-TAB', '<backspace>': 'DEL', '<escape>': 'ESC', '<space>': 'SPC', ' ': 'SPC', '<delete>': '<deletechar>', 'C-[': 'ESC', 'C-i': 'TAB', 'C-m': 'RET' };
function normKey(k: string) {
  if (ALIAS[k]) return ALIAS[k];
  const mods = new Set();
  let rest = k;
  while (/^[ACHMSs]-./.test(rest)) { mods.add(rest[0]); rest = rest.slice(2); }
  rest = ALIAS[rest] || rest;
  const out = (mods.has('C') ? 'C-' : '') + (mods.has('M') ? 'M-' : '') + (mods.has('S') ? 'S-' : '') + rest;
  return ALIAS[out] || out;
}
function kbd(s: string) { return String(s).trim().split(/\s+/).filter(Boolean).map(normKey).join(' '); }
function defineKey(km: EdKeymap, keys: string, def: EdBinding) {
  const parts = kbd(keys).split(' ');
  let m = km;
  for (let k = 0; k < parts.length - 1; k++) {
    let sub = m.map.get(parts[k]);
    if (!(sub instanceof Keymap)) { sub = new Keymap(); m.map.set(parts[k], sub); }
    m = sub as EdKeymap;
  }
  const last = parts[parts.length - 1];
  if (def === false) m.map.delete(last); else m.map.set(last, def);
  return def;
}
function lookupIn(km: EdKeymap, parts: string[]) {
  let m: EdBinding | undefined = km;
  for (const p of parts) {
    if (!(m instanceof Keymap)) return undefined;
    let d = m.map.get(p);
    for (let par = m.parent; d === undefined && par; par = par.parent) d = par.map.get(p);
    if (d instanceof Sym) { const v = L.get(d.name); if (v instanceof Keymap) d = v; }
    m = d;
  }
  return m;
}
const KM = (name: string) => { const v = L.get(name); return v instanceof Keymap ? v : null; };
/* ---------- minor and derived modes (R4.25) ----------
   A minor mode is a command and a variable that holds its state, buffer-local unless the mode is
   global. Edwin Scheme has one binding per name, so the variable cannot share the command's name as in
   Emacs: it is NAME without -mode plus -enabled (electric-pair-mode sets electric-pair-enabled),
   unless define-minor-mode names one with :variable. Its keymap, the
   variable NAME-map, is searched after the Evil state maps and before the major mode's map. Its own
   Evil state maps (evil-define-key on the mode) are among the state maps, before the major mode's. A derived
   major mode records its parent: its keymap inherits the parent's, and Evil's per-mode maps of the
   parent apply to it too. */
const minorModes = new Map<string, EdMinorMode>();
const minorOn = (b: EdBuffer, m: EdMinorMode) => { const v = m.global ? L.get(m.variable) : localValue(b, m.variable); return v !== undefined && v !== false && v !== NIL; };
function minorMaps(b: EdBuffer) {
  const out: EdKeymap[] = [];
  for (const m of minorModes.values()) if (minorOn(b, m)) { const km = KM(m.name + '-map'); if (km) out.push(km); }
  return out;
}
function lighters(b: EdBuffer) { let s = ''; for (const m of minorModes.values()) if (m.lighter && minorOn(b, m)) s += m.lighter; return s; }
const modeParents = new Map<string, string>();
/* MODE and the modes it derives from, nearest first. */
function modeChain(mode: string) { const out = [mode]; for (let m = modeParents.get(mode), n = 0; m && n < 32; m = modeParents.get(m), n++) out.push(m); return out; }
function activeMaps(b?: EdBuffer | null) {
  b = b || E.current;
  const out: EdKeymap[] = [];
  if (b.minibuf && E.mini) { const m = KM('minibuffer-local-map'); if (m) out.push(m); }
  if (hooks.stateMaps) out.push(...hooks.stateMaps(b));
  if (minorModes.size) out.push(...minorMaps(b));
  const mm = KM(b.mode + '-map'); if (mm) out.push(mm);
  const g = KM('global-map'); if (g) out.push(g);
  return out;
}
function lookupWith(maps: EdKeymap[], seq: string) {
  const parts = seq.split(' ');
  let prefix = false;
  for (const m of maps) {
    const d = lookupIn(m, parts);
    if (d instanceof Keymap) { prefix = true; continue; }
    if (d !== undefined && d !== false && !prefix) return d;
  }
  return prefix ? PREFIX : undefined;
}
const lookupKey = (seq: string, b?: EdBuffer | null) => lookupWith(activeMaps(b), seq);
function whereIs(cmd: SchemeValue, maps?: EdKeymap[]) {
  const out: string[] = [];
  const walk = (m: EdKeymap, pre: string, seen: Set<EdKeymap>) => {
    if (seen.has(m)) return; seen.add(m);
    for (const [k, d] of m.map) {
      const seq = pre ? pre + ' ' + k : k;
      if (d instanceof Keymap) walk(d, seq, seen); else if (sameCmd(d, cmd)) out.push(seq);
    }
    if (m.parent) walk(m.parent, pre, seen);
  };
  for (const m of maps || activeMaps(E.win)) walk(m, '', new Set());
  return [...new Set(out)].filter(s => maps || sameCmd(lookupKey(s, E.win), cmd)).sort((a, b) => a.length - b.length);
}
/* Two command designators name the same command: the same symbol, the same procedure, or a symbol and the procedure it holds. */
function sameCmd(a: EdBinding | undefined, b: EdBinding | undefined) {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === PREFIX || b === PREFIX) return false;
  const fa = L.fnOrNull(a as SchemeValue), fb = L.fnOrNull(b as SchemeValue);
  return !!fa && fa === fb;
}

/* ---------- decoding browser key events into Emacs key descriptions ---------- */
const SPECIAL: Record<string, string> = { Enter: 'RET', Backspace: 'DEL', Tab: 'TAB', Escape: 'ESC', ArrowUp: '<up>', ArrowDown: '<down>', ArrowLeft: '<left>', ArrowRight: '<right>',
  Delete: '<deletechar>', Home: '<home>', End: '<end>', PageUp: '<prior>', PageDown: '<next>', Insert: '<insert>' };
const CODEMAP: Record<string, string[]> = { Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Semicolon: [';', ':'], Quote: ["'", '"'], BracketLeft: ['[', '{'],
  BracketRight: [']', '}'], Backslash: ['\\', '|'], Minus: ['-', '_'], Equal: ['=', '+'], Backquote: ['`', '~'], Space: ['SPC', 'SPC'] };
const SHIFT_DIGIT = ')!@#$%^&*(';
function keyName(e: EdKeyEvent) {
  if (/^(Shift|Control|Alt|Meta|CapsLock|AltGraph|OS|Hyper|Super|Fn|Dead|Unidentified|Process)$/.test(e.key) || e.isComposing) return null;
  if (e.metaKey) return null;                        // leave Cmd/Super shortcuts to the browser
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') return null; // let the browser paste
  if (e.getModifierState && e.getModifierState('AltGraph') && e.key.length === 1) return e.key;
  const ctrl = e.ctrlKey, meta = e.altKey;
  let base;
  if (SPECIAL[e.key]) base = SPECIAL[e.key];
  else if (/^F\d{1,2}$/.test(e.key)) base = '<f' + e.key.slice(1) + '>';
  else if (ctrl || meta) {
    const c = e.code!;
    if (/^Key[A-Z]$/.test(c)) base = e.shiftKey && !ctrl ? c[3] : c[3].toLowerCase();
    else if (/^Digit\d$/.test(c)) base = e.shiftKey ? SHIFT_DIGIT[+c[5]] : c[5];
    else if (CODEMAP[c]) base = CODEMAP[c][e.shiftKey ? 1 : 0];
    else if (e.key.length === 1) base = e.key;
    else return null;
  } else if ([...e.key].length === 1) base = e.key === ' ' ? 'SPC' : e.key;
  else return null;
  return normKey((ctrl ? 'C-' : '') + (meta ? 'M-' : '') + (e.shiftKey && base.length > 1 && (base[0] === '<' || base === 'TAB') ? 'S-' : '') + base);
}
const selfInsertable = (k: string) => k === 'SPC' || [...k].length === 1;
const keyChar = (k: string) => k === 'SPC' ? ' ' : k === 'RET' ? '\n' : k === 'TAB' ? '\t' : selfInsertable(k) ? k : null;

/* ---------- echo area and messages ---------- */
function message(s: string) {
  E.echo = s;
  if (s) {
    const m = getBufferCreate('*Messages*');
    const was = E.inhibitRO; E.inhibitRO = true;
    const atEnd = m.pt === m.rope.length;
    const save = m.pt; m.pt = m.rope.length; insertText(m, s + '\n'); m.pt = atEnd ? m.rope.length : save; m.modified = false;
    E.inhibitRO = was;
  }
}
function ding() { if (E.frame && E.frame.backend) { if (E.frame.backend.bell) E.frame.backend.bell(); return; } const f = E.frame && E.frame.root; if (!f) return; f.classList.remove('bell'); void f.offsetWidth; f.classList.add('bell'); }
function errorText(e: unknown) {
  if (e instanceof SchemeError) return L.errorMessage(e);
  if (e instanceof L.S.Raise) return L.errorMessage(e);
  if (e instanceof L.Escape) return 'Escape procedure called outside its extent';
  if (e instanceof RangeError) return 'Recursion too deep (stack overflow)';
  console.error(e);
  return 'Internal error: ' + (e && (e as Error).message);
}
const QUIET = L.QUIET;
function quietQuit(): never { L.quit(true); }
function reportError(e: unknown) {
  if (L.isQuit(e)) { if (!L.isQuietQuit(e)) { E.echo = 'Quit'; ding(); } return; }
  message(errorText(e)); ding();
}

/* ---------- the input queue ---------- */
const SENTINEL = '\u0000end-of-keys';
const queue: EdQueuedKey[] = [];
let wake: (() => void) | null = null;
function wakeUp() { if (wake) { const w = wake; wake = null; w(); } }
function feedKey(k: string) { queue.push({ k, real: true }); wakeUp(); }
/* Push keys in front of the queue. Replayed keys are not recorded into keyboard macros. */
function unreadKeys(keys: string[], real = false) { queue.unshift(...keys.map(k => ({ k, real, noRecord: real }))); wakeUp(); }
function pushSentinel(keys: string[]) { queue.unshift(...keys.map(k => ({ k, real: false })), { k: SENTINEL, real: false }); wakeUp(); }
function flushReplay() { for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].real && queue[i].k !== SENTINEL) queue.splice(i, 1); }
async function nextKey(opts?: { sentinel?: boolean }) {
  for (;;) {
    if (queue.length) {
      const it = queue.shift()!;
      if (it.k === SENTINEL && !(opts && opts.sentinel)) { queue.unshift(it); quietQuit(); }
      E.lastKeyReal = it.real;
      if (it.k !== SENTINEL && !it.noRecord && hooks.recordKey) hooks.recordKey(it);
      return it.k;
    }
    render();
    E.idle = true;
    for (const r of idleWaiters.splice(0)) r();
    await new Promise<void>(r => { wake = r; });
    E.idle = false;
  }
}
const idleWaiters: (() => void)[] = [];
function whenIdle() { return new Promise<void>(r => { if (E.idle && !queue.length) r(); else idleWaiters.push(r); }); }

/* ---------- minibuffer: a recursive edit that runs commands until exit or abort ---------- */
/* With opts.boundary (a path: dired.ts) the candidates complete the input from the boundary on; what is before
   it stays as typed. No candidate is highlighted while that field is empty, so RET takes the input (a directory). */
const miniPrefix = (m: EdMini, text: string) => (m.opts.boundary ? text.slice(0, m.opts.boundary(text)) : '');
const miniIndex0 = (opts: EdMiniOpts, text: string) => (opts.noIndex || (opts.boundary && opts.boundary(text) >= text.length) ? -1 : 0);
async function readMini(prompt: string, initial?: string, completer?: EdCompleter | null, opts?: EdMiniOpts) {
  opts = opts || {};
  if (E.mini) signal('error', 'Command attempted to use minibuffer while in minibuffer');
  const mb = E.minibuf;
  mb.text = initial || ''; mb.pt = mb.rope.length; mb.mark = null; mb.markActive = false; mb.undo = []; mb.redo = []; mb.pendingUndo = null;
  const saved = { cur: E.current, prefix: E.prefixArg, cmd: E.thisCommand, keys: E.thisKeys, last: E.lastCommand };
  const m: EdMini = E.mini = { prompt, completer: completer || null, opts, histIdx: -1, history: opts.history || historyFor(opts.kind), done: null, index: miniIndex0(opts, mb.text), cache: null, cacheKey: null, scroll: 0 };
  E.current = mb; E.echo = ''; E.miniFlash = '';
  E.depth++;
  try {
    if (opts.onChange) opts.onChange(mb.text);
    while (!m.done) {
      const k = await nextKey();
      const before = mb.text;
      await dispatch(k);
      if (E.mini === m && mb.text !== before) { m.index = miniIndex0(opts, mb.text); m.scroll = 0; if (opts.onChange) opts.onChange(mb.text); }
      if (E.mini === m && opts.onSelect) { const c = miniCandidates(); opts.onSelect(m.index >= 0 && m.index < c.length ? c[m.index] : null, mb.text); }
    }
  } finally {
    E.depth--;
    if (E.mini === m) E.mini = null;
    E.current = E.buffers.includes(saved.cur) ? saved.cur : E.win!;
    E.prefixArg = saved.prefix; E.thisCommand = saved.cmd; E.thisKeys = saved.keys; E.lastCommand = saved.last; E.miniFlash = '';
    if (opts.onExit) opts.onExit();
    if (hooks.miniExit) hooks.miniExit(m);
  }
  if (m.done.quit) L.quit(false);
  return m.done.value;
}
/* Orderless matching: the input is split into terms; each term must match somewhere, in any order.
   A term is a regexp when it looks like one, else a literal. Matches are case-insensitive unless the term has capitals.
   Candidates that match at the start sort first, then by recent use, then alphabetically. */
function termRegex(term: string) {
  const ci = term === term.toLowerCase() ? 'i' : '';
  if (/[\\^$.*+?()[\]{}|]/.test(term)) { try { return new RegExp(term, ci); } catch (e) { /* literal */ } }
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci);
}
const recentUse = new Map<string, Map<string, number>>(); // completer kind -> Map(candidate -> tick)
let useTick = 0;
/* Minibuffer histories, one per completer kind as in Emacs (M-x, buffers, files...); the others share
   E.history. savehist (stack.ts) persists them. */
const histories = new Map<string, string[]>();
function historyFor(kind?: string) { if (!kind) return E.history; let h = histories.get(kind); if (!h) { h = []; histories.set(kind, h); } return h; }
/* Prescient: for these kinds a candidate chosen before sorts first, the most recently chosen first
   (the last prescient-history-length choices), then by how often it was chosen, then shorter
   candidates first, as prescient.el does. The table persists (prescient-persist-mode) through
   stack.ts. The tables have no prototype, so a candidate named __proto__ or constructor is
   just a key. */
const PRESCIENT_KINDS = new Set<string | undefined>(['command', 'buffer', 'consult-buffer', 'file']);
const prescient: EdApi['prescient'] = { tick: 0, kinds: Object.create(null), save: null, limit: 300 };
L.defvar('prescient-history-length', 100, 'How many of the last chosen candidates of each kind sort by recency, before the frequency order.');
const histLen = () => Math.max(0, Number(L.get('prescient-history-length')) || 0);
function prescientFor(kind?: string) { return PRESCIENT_KINDS.has(kind) && Object.hasOwn(prescient.kinds, kind!) ? prescient.kinds[kind!] : null; }
/* Candidate -> rank among the last prescient-history-length choices of table K (0 is the newest). */
function prescientRecency(k: Record<string, [number, number]>) {
  const keys = Object.keys(k).sort((a, b) => k[b][1] - k[a][1]), out = new Map(), n = Math.min(keys.length, histLen());
  for (let i = 0; i < n; i++) out.set(keys[i], i);
  return out;
}
function prescientBump(kind: string | undefined, v: string) {
  if (!PRESCIENT_KINDS.has(kind)) return;
  const k = Object.hasOwn(prescient.kinds, kind!) ? prescient.kinds[kind!] : (prescient.kinds[kind!] = Object.create(null));
  const e = Object.hasOwn(k, v) ? k[v] : (k[v] = [0, 0]);
  e[0]++; e[1] = ++prescient.tick;
  const keys = Object.keys(k);
  if (keys.length > prescient.limit) {
    /* Past the limit, drop a quarter: never one of the recent choices (the one just made among
       them), the least used and oldest of the rest first. */
    const recent = prescientRecency(k), old = keys.filter(x => !recent.has(x) && x !== v);
    old.sort((a, b) => k[a][0] - k[b][0] || k[a][1] - k[b][1]);
    for (const x of old.slice(0, keys.length >> 2)) delete k[x];
  }
  if (prescient.save) prescient.save();
}
L.defvar('vertico-cycle', true, 'Non-#f lets the minibuffer highlight wrap from the last candidate to the first and back.');
L.defvar('vertico-resize', true, 'Non-#f shrinks the candidate list to the candidates; #f keeps it vertico-count rows tall.');
/* Whether every candidate that matches query Q2 also matches Q1, so Q2 can filter Q1's results:
   each term of Q1 is a literal inside some literal term of Q2 (typing extends the input). */
const RE_META = /[\\^$.*+?()[\]{}|]/;
function narrows(q1: string, q2: string) {
  const t1 = q1.trim().split(/\s+/).filter(Boolean), t2 = q2.trim().split(/\s+/).filter(Boolean);
  if (!t1.length) return true;
  return t1.every(a => !RE_META.test(a) && t2.some(c => !RE_META.test(c) && c.includes(a)));
}
const ASYNC_MIN = 20000;
/* Candidates for the current input. A longer input filters the previous results instead of the
   whole list; a big list (consult-line on a big buffer) is filtered by the worker pool, and the
   previous results stay on screen until the answer comes. SYNC forces an answer now (RET, TAB). */
function miniCandidates(sync?: boolean) {
  const m = E.mini; if (!m || !m.completer) return [];
  const q = E.minibuf.text;
  if (m.cache && m.cacheKey === q) return m.cache;
  const all = m.completer(q);
  const pre = miniPrefix(m, q), field = q.slice(pre.length);
  const terms = field.trim().split(/\s+/).filter(Boolean).map(termRegex);
  const recent = recentUse.get(m.opts.kind || m.prompt) || new Map<string, number>();
  const pres = prescientFor(m.opts.kind);
  const finish = (out: string[]) => {
    if (!m.opts.keepOrder) {
      const first = terms.length ? terms[0] : null, def = m.opts.def;
      const score = (c: string) => (c === def && !terms.length ? -1 : first && first.test(c) && c.search(first) === 0 ? 0 : 1);
      /* listOrder keeps the completer's order (recentf) among equals instead of the alphabet. */
      const tie = m.opts.listOrder ? () => 0 : (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      if (pres) {
        /* Recency, then frequency, then (among the never chosen) the match score and length; the
           completer's order (recentf) stands in for length with listOrder. */
        const isDef = (c: string) => (c === def && !terms.length ? -1 : 0), z = [0, 0], rec = prescientRecency(pres);
        const get = (c: string) => (Object.hasOwn(pres, c) ? pres[c] : z), rank = (c: string) => { const r = rec.get(c); return r === undefined ? Infinity : r; };
        const len = m.opts.listOrder ? () => 0 : (a: string, b: string) => a.length - b.length;
        out.sort((a, b) => isDef(a) - isDef(b) || rank(a) - rank(b) || get(b)[0] - get(a)[0] || score(a) - score(b) || len(a, b) || tie(a, b));
      } else out.sort((a, b) => score(a) - score(b) || (recent.get(b) || 0) - (recent.get(a) || 0) || tie(a, b));
    }
    m.cache = out; m.cacheKey = q; m.cacheAll = all;
    return out;
  };
  /* A completer that matched the input itself is taken at its word: its candidates are shown as they are. */
  if (m.opts.filtered && m.opts.filtered(q)) { m.matched = all; m.matchedKey = q; return finish(all.slice()); }
  if (!terms.length) return finish(all.slice());
  /* The base: the previous matches when this input narrows them (kept in list order), else all. */
  const base = m.matched && m.cacheAll === all && miniPrefix(m, m.matchedKey!) === pre && narrows(m.matchedKey!.slice(pre.length), field) ? m.matched : all;
  const filter = (list: string[]) => { const out = []; for (const c of list) { let ok = true; for (const t of terms) if (!t.test(c)) { ok = false; break; } if (ok) out.push(c); } return out; };
  if (!sync && base.length >= ASYNC_MIN && globalThis.EdPool && EdPool.ok) {
    if (m.asyncKey !== q) {
      m.asyncKey = q;
      const p = EdPool.filterAsync(base, terms);
      if (p) p.then(idx => {
        if (E.mini !== m || E.minibuf.text !== q || (m.cache && m.cacheKey === q)) return;
        const matched = Array.from(idx, i => base[i]);
        m.matched = matched; m.matchedKey = q;
        finish(matched.slice());
        if (m.opts.onSelect) { const c = m.cache!; m.opts.onSelect(m.index >= 0 && m.index < c.length ? c[m.index] : null, q); }
        render();
      }, () => { m.asyncKey = null; });
    }
    if (m.cache) return m.cache;
  }
  const matched = filter(base);
  m.matched = matched; m.matchedKey = q;
  return finish(matched.slice());
}
function markUsed(m: EdMini, v: string) { const key = m.opts.kind || m.prompt; let r = recentUse.get(key); if (!r) { r = new Map(); recentUse.set(key, r); } r.set(v, ++useTick); prescientBump(m.opts.kind, v); }
/* RET: take the highlighted candidate; with none highlighted, the input itself. */
function exitMini(inputOnly?: boolean) {
  const m = E.mini; if (!m) return;
  let v = E.minibuf.text;
  const has = (x: string) => m.completer!(x).includes(x.slice(miniPrefix(m, x).length));
  if (m.completer && !inputOnly) {
    const c = miniCandidates(true);
    if (m.index >= 0 && m.index < c.length) v = miniPrefix(m, v) + c[m.index];
    else if (m.opts.require && !has(v)) {
      if (v === '' && m.opts.def !== undefined) v = m.opts.def;
      else { E.miniFlash = c.length ? ' [Incomplete]' : ' [No match]'; return; }
    }
  }
  if (v === '' && m.opts.def !== undefined) v = m.opts.def;
  if (m.opts.require && m.completer && !has(v) && !(v === '' && m.opts.def !== undefined)) { E.miniFlash = ' [No match]'; return; }
  if (m.completer && v) markUsed(m, v);
  if (v && m.history[0] !== v) { m.history.unshift(v); if (m.history.length > 100) m.history.length = 100; }
  m.done = { value: v };
}
function miniMove(d: number, cycle = true) {
  const m = E.mini; if (!m || !m.completer) { historyMove(-d); return; }
  const c = miniCandidates(), min = m.opts.require ? 0 : -1, max = c.length - 1;
  let i = m.index + d;
  /* vertico-cycle: past either end, come round to the other. Page moves (CYCLE #f) stop at the
     end, as vertico-scroll-down/up do. */
  if (cycle && truthy(L.get('vertico-cycle')) && max >= min && (i > max || i < min)) { const span = max - min + 1; i = ((i - min) % span + span) % span + min; }
  m.index = Math.max(min, Math.min(max, i));
}
function miniInsert() {
  const m = E.mini; if (!m || !m.completer) return;
  const c = miniCandidates(true);
  if (m.index >= 0 && m.index < c.length) { const t = miniPrefix(m, E.minibuf.text) + c[m.index]; E.minibuf.text = t; E.minibuf.pt = t.length; m.cache = null; }
  else completeMini();
}
function abortMini() { if (E.mini) E.mini.done = { quit: true }; }
function completeMini() {
  const m = E.mini!, c = miniCandidates(true), mb = E.minibuf, pre = miniPrefix(m, mb.text), field = mb.text.slice(pre.length);
  if (m.completer && m.index >= 0 && m.index < c.length && c.length > 1 && !c.every(x => x.startsWith(field))) { miniInsert(); return; }
  if (!c.length) { E.miniFlash = ' [No match]'; return; }
  if (c.length === 1) { mb.text = pre + c[0]; mb.pt = mb.rope.length; E.miniFlash = ' [Sole completion]'; return; }
  let p = c[0];
  for (const s of c) while (!s.startsWith(p)) p = p.slice(0, -1);
  if (p.length > field.length) { mb.text = pre + p; mb.pt = mb.rope.length; }
  /* In a path the next TAB takes the highlighted name, so a tree is walked with TAB alone. */
  else if (m.opts.boundary && m.index >= 0) miniInsert();
  else E.miniFlash = c.includes(field) ? ' [Complete, but not unique]' : '';
}
function historyMove(d: number) {
  const m = E.mini; if (!m) return;
  const k = m.histIdx + d;
  if (k < -1 || k >= m.history.length) { E.miniFlash = d > 0 ? ' [Beginning of history]' : ' [End of history]'; return; }
  m.histIdx = k; const v = k < 0 ? '' : m.history[k]; E.minibuf.text = v; E.minibuf.pt = v.length;
}
async function readKeySeq(prompt: string) {
  E.prompt = prompt;
  try {
    let seq = '';
    for (;;) {
      const k = await nextKey();
      seq = seq ? seq + ' ' + k : k;
      E.prompt = prompt + seq;
      if (lookupKey(seq, E.win) !== PREFIX) return seq;
    }
  } finally { E.prompt = null; }
}
async function readChar(prompt?: string) {
  E.prompt = prompt || '';
  try {
    const k = await nextKey();
    if (k === 'C-g' || k === 'ESC') quietQuit();
    const ch = keyChar(k);
    if (ch === null) signal('error', 'Non-character input event: ' + k);
    return L.mkchar(ch!);
  } finally { E.prompt = null; }
}

/* ---------- annotations shown beside candidates, as marginalia does ---------- */
function firstLine(s?: string | null) { return (s || '').split('\n')[0]; }
function annotateCommand(name: string) {
  const f = L.fnOrNull(intern(name)); if (!f) return '';
  const keys = whereIs(intern(name));
  return (keys.length ? keys.slice(0, 2).join(', ') + '  ' : '') + firstLine(f.doc);
}
function annotateFunction(name: string) { const f = L.fnOrNull(intern(name)); if (!f) return L.S.macros.has(name) ? 'macro' : ''; return firstLine(f.doc); }
function annotateVariable(name: string) { let v: SchemeValue; try { v = L.get(name); } catch (e) { return ''; } const s = v === undefined ? '' : pr(v, true); return (s.length > 40 ? s.slice(0, 40) + '…' : s) + (L.S.gdoc.get(name) ? '  ' + firstLine(L.S.gdoc.get(name)) : ''); }
function annotateBuffer(name: string) { const b = getBuffer(name); if (!b) return ''; return `${b.modified ? '*' : ' '}${b.readOnly ? '%' : ' '} ${String(b.rope.length).padStart(7)}  ${MODE_NAMES[b.mode] || b.mode}${b.file ? '  ' + b.file : ''}`; }
function annotateFile(name: string) { const v = Store.get(name), f = host.files && host.files.resolve ? host.files.resolve(name) : name; const b = E.buffers.find(x => x.file === f); return (v === null ? 'new' : String(v.length).padStart(7) + ' chars') + (b ? '  (visiting)' : ''); }

/* ---------- interactive specs ---------- */
const { commandNames, functionNames, variableNames, isCommand } = L;
const bufferNames = () => E.buffers.map(b => b.name).filter(n => !n.startsWith(' '));
function prefixNumeric(p: SchemeValue) {
  if (p === null || p === undefined || p === false) return 1;
  if (typeof p === 'number') return p;
  if (p === intern('-')) return -1;
  if (Array.isArray(p)) return p[0] as number;
  return 1;
}
function withDefault(prompt: string, def?: string) { return def ? prompt.replace(/:\s*$/, '') + ` (default ${def}): ` : prompt; }
const specCodes: Record<string, () => Promise<SchemeValue[]>> = {};
async function specArgs(spec: string) {
  const out: SchemeValue[] = [];
  let s = spec;
  while (s && '*^@'.includes(s[0])) { if (s[0] === '*') checkRO(E.current); s = s.slice(1); }
  for (const item of (s || '').split('\n')) {
    if (!item) continue;
    if (item[0] === '<') {
      for (const m of item.matchAll(/<([^>]+)>/g)) {
        const h = specCodes[m[1]];
        if (!h) signal('error', 'Unsupported interactive code: <' + m[1] + '>');
        out.push(...await h());
      }
      continue;
    }
    const code = item[0], prompt = item.slice(1);
    switch (code) {
      case 'p': out.push(prefixNumeric(E.prefixArg)); break;
      case 'P': out.push(E.prefixArg === null ? false : E.prefixArg); break;
      case 'r': { const b = E.current; if (b.mark === null) signal('error', 'The mark is not set now, so there is no region'); out.push(Math.min(b.pt, b.mark!) + 1, Math.max(b.pt, b.mark!) + 1); break; }
      case 'd': out.push(E.current.pt + 1); break;
      case 'm': if (E.current.mark === null) signal('error', 'The mark is not set now'); out.push(E.current.mark! + 1); break;
      case 'i': out.push(false); break;
      case 's': case 'M': out.push(await readMini(prompt, '')); break;
      case 'n': { const v = await readMini(prompt, ''); const n = Number(v); if (v.trim() === '' || isNaN(n)) signal('error', 'Please enter a number.'); out.push(n); break; }
      case 'N': if (E.prefixArg !== null) out.push(prefixNumeric(E.prefixArg)); else { const v = await readMini(prompt, ''); out.push(Number(v) || 0); } break;
      case 'x': out.push(L.read(await readMini(prompt, ''))); break;
      case 'X': out.push(L.ev(L.read(await readMini(prompt, '')))); break;
      case 'C': out.push(intern(await readMini(prompt, '', commandNames, { require: true, kind: 'command', annotate: annotateCommand }))); break;
      case 'a': out.push(intern(await readMini(prompt, '', functionNames, { require: true, kind: 'function', annotate: annotateFunction }))); break;
      case 'v': out.push(intern(await readMini(prompt, '', variableNames, { require: true, kind: 'variable', annotate: annotateVariable }))); break;
      case 'b': { const d = E.current.name; out.push(await readMini(withDefault(prompt, d), '', bufferNames, { require: true, def: d, kind: 'buffer', annotate: annotateBuffer })); break; }
      case 'B': { const d = otherBuffer().name; out.push(await readMini(withDefault(prompt, d), '', bufferNames, { def: d, kind: 'buffer', annotate: annotateBuffer })); break; }
      case 'f': case 'F': out.push(await readMini(prompt, '', () => (hooks.recentFiles ? hooks.recentFiles() : Store.list()), { require: code === 'f', kind: 'file', annotate: annotateFile, listOrder: true })); break;
      case 'k': case 'K': out.push(await readKeySeq(prompt)); break;
      case 'c': out.push(await readChar(prompt)); break;
      default: signal('error', 'Unsupported interactive code: ' + code);
    }
  }
  return out;
}
async function callInteractively(cmd: SchemeValue) {
  const f = L.toFn(cmd);
  let spec = f.interactive as SchemeValue;
  if (spec === undefined) signal('wrong-type-argument', `${L.cmdName(cmd)} is not a command`);
  /* A command declared (:where 'server) runs in edwind (R4.27): the protocol client sends call{cmd, ctx}
     and the command loop goes on without waiting. */
  if (f.where === 'server' && hooks.serverCommand) return hooks.serverCommand(L.cmdName(cmd), f) as SchemeValue;
  let args: SchemeValue[];
  if (typeof spec === 'function' && (spec as SchemeProcedure).jsSpec) args = await (spec as () => Promise<SchemeValue[]>)();
  else {
    if (typeof spec === 'function') { spec = L.callProc(spec, []); if (spec && typeof (spec as Promise<SchemeValue>).then === 'function') spec = await spec; }
    if (typeof spec === 'string') args = await specArgs(spec);
    else if (spec === false || spec === undefined || spec === L.UNSPEC) args = [];
    else args = arr(spec);
  }
  /* A command that saves first waits for the formatters of format-on-save-mode (src/format.ts); what they
     came to is said after it. Null, at once, for every other command. */
  const fos = hooks.formatOnSave ? hooks.formatOnSave(L.cmdName(cmd), args) : null;
  const said = fos ? await fos : null;
  L.resetOps();
  const r = L.callProc(f, args);
  const v = r && typeof (r as Promise<SchemeValue>).then === 'function' ? await r : r;
  if (said) said();
  return v;
}
/* An operator whose work was done while reading its motion (surround) throws OpDone: not an error. */
const callInteractively0 = callInteractively;
async function callInteractivelySafe(cmd: SchemeValue) { try { return await callInteractively0(cmd); } catch (e) { if (E.OpDone && e instanceof E.OpDone) return false; throw e; } }

/* ---------- undo: a linear history with redo; an insert session counts as one change ---------- */
/* Snapshots hold a version, not a copy of the text: restoring one replays the edit log backwards. */
const snap = (b: EdBuffer): EdSnap => ({ ver: b.ver, pt: b.pt, mark: b.mark, modified: b.modified });
function recordUndo(b: EdBuffer, before: EdSnap) {
  const self = intern('self-insert-command');
  if (E.thisCommand === self && E.lastCommand === self && b.typeRun < 20 && b.undo.length) { b.typeRun++; b.redo = []; return; }
  b.typeRun = 0; b.undo.push(before); b.redo = [];
  if (b.undo.length > 500) b.undo.shift();
}
/* Bring the text back to its content at snapshot S, then put point at the first changed position. */
function restoreSnap(b: EdBuffer, s: EdSnap) {
  const log = b.log, ops: EdLogEntry[] = [];
  let k = log.length - 1;
  while (k >= 0 && log[k].v > s.ver) ops.push(log[k--]);
  if (k < 0 && ops.length && log[0].v !== s.ver + 1) signal('user-error', 'Undo history is no longer available');
  const r = b.rope, oldLen = r.length;
  let pre = Infinity, suf = Infinity;
  for (const e of ops) { if (e.pos < pre) pre = e.pos; const x = e.len - e.pos - e.ins.length; if (x < suf) suf = x; }
  const oldMid = ops.length ? r.slice(pre, oldLen - suf) : '';
  /* Undo the ops on the changed span as a string, newest first, and apply the result as one edit.
     Replaying them one by one would log every inverse, and the next undo would replay those too,
     doubling the work at each step. */
  let mid = oldMid;
  for (const e of ops) {
    const q = e.pos - pre; mid = mid.slice(0, q) + e.del + mid.slice(q + e.ins.length);
    /* Markers follow each inverse edit, and those a deletion moved go back to where they were. */
    unshiftMarkers(b, e);
  }
  if (mid !== oldMid) {
    const hk = changeHooks();
    if (hk) runChangeHook(b, 'before-change-functions', [pre + 1, pre + oldMid.length + 1]);
    ropeEdit(b, pre, oldMid.length, mid);
    if (hk) runChangeHook(b, 'after-change-functions', [pre + 1, pre + mid.length + 1, oldMid.length]);
  }
  const newLen = r.length, m = Math.min(oldLen, newLen);
  let i = m;
  if (ops.length) {
    const oe = oldLen - suf;
    i = pre;
    while (i < m) { const c = i < oe ? oldMid.charCodeAt(i - pre) : r.charCodeAt(i - oldLen + newLen); if (c !== r.charCodeAt(i)) break; i++; }
  }
  b.modified = s.modified; b.pt = Math.min(i, newLen);
  b.mark = s.mark === null ? null : Math.min(s.mark, newLen);
  for (const m of b.markers) if (m.pos !== null && m.pos > newLen) m.pos = newLen;
}
/* The buffer now matches its file. Every snapshot in its history differs from the file, so undoing or redoing
   to one leaves the buffer modified, and undoing back to this state leaves it unmodified again. */
function markSaved(b: EdBuffer) {
  b.modified = false;
  if (b.pendingUndo) b.pendingUndo.modified = true;
  for (const s of b.undo) s.modified = true;
  for (const s of b.redo) s.modified = true;
}
function flushPendingUndo(b: EdBuffer) {
  if (b.pendingUndo) { if (changedSince(b, b.pendingUndo.ver)) { b.undo.push(b.pendingUndo); b.redo = []; } b.pendingUndo = null; }
}
function undoStep(b: EdBuffer) {
  /* A replica undoes by groups through everyone else's edits (R6.15–R6.19, sync.ts). */
  if (b.shared && hooks.undoShared) { E.noUndo = true; return hooks.undoShared(b); }
  flushPendingUndo(b);
  if (!b.undo.length) signal('user-error', 'Already at oldest change');
  const cur = snap(b), s = b.undo.pop()!;
  b.redo.push(cur); restoreSnap(b, s); E.noUndo = true;
}
function redoStep(b: EdBuffer) {
  if (b.shared && hooks.redoShared) { E.noUndo = true; return hooks.redoShared(b); }
  if (!b.redo.length) signal('user-error', 'Already at newest change');
  const cur = snap(b), s = b.redo.pop()!;
  b.undo.push(cur); restoreSnap(b, s); E.noUndo = true;
}
function finishUndo(b: EdBuffer, before: EdSnap) {
  if (E.suppressUndo) return;
  if (E.noUndo) { b.pendingUndo = null; return; }
  if (hooks.inSession && hooks.inSession(b)) { if (!b.pendingUndo) b.pendingUndo = before; return; }
  const base = b.pendingUndo || before;
  b.pendingUndo = null;
  if (changedSince(b, base.ver)) recordUndo(b, base);
}

/* ---------- the command loop ---------- */
async function runCommand(def: SchemeValue, keys?: string) {
  const ch = keys ? keyChar(keys) : null;
  L.set('last-command-event', ch ? L.mkchar(ch) : (keys ? intern(keys) : false));
  E.thisCommand = L.cmdSym(def);
  E.thisKeys = keys || '';
  E.cmdSeq++;
  if (!E.mini && E.depth === 0) E.echo = '';
  E.miniFlash = '';
  const b = E.current, before = snap(b), wasActive = b.markActive, pin = b.pin;
  if (before.ver < b.pin) b.pin = before.ver;
  E.keepPrefix = false; E.keepMark = false; E.noUndo = false;
  if (E.depth === 0) L.S.resetStack();
  if (hooks.preCommand) hooks.preCommand(def, b);
  try { L.resetOps(); L.runHook('pre-command-hook'); } catch (e) { reportError(e); }
  const layout = windowLayout();
  let failed = false;
  E.running++;
  try { await callInteractivelySafe(def); }
  catch (e) { failed = true; reportError(e); flushReplay(); }
  finally {
    E.running--;
    finishUndo(b, before);
    b.pin = pin;
    if (!E.keepMark && wasActive && !b.visual && changedSince(b, before.ver)) b.markActive = false;
    E.lastCommand = E.thisCommand;
    if (!E.keepPrefix) { E.prefixArg = null; E.uArg = false; E.uDigits = null; }
    try { if (hooks.postCommand) hooks.postCommand(def, b, failed); } catch (e) { reportError(e); }
    try { L.resetOps(); L.runHook('post-command-hook'); } catch (e) { reportError(e); }
    if (windowLayout() !== layout) try { L.resetOps(); L.runHook('window-configuration-change-hook'); } catch (e) { reportError(e); }
  }
}
/* The window tree and what each window shows, as a string: a command that changes it runs
   window-configuration-change-hook. */
function windowLayout() {
  if (!E.root) return '';
  const walk = (n: EdWindow | Split): string => (n instanceof Split ? n.dir + '(' + n.children.map(walk).join(',') + ')' : n.id + ':' + (n.buffer ? n.buffer.id : 0));
  return walk(E.root);
}
/* Run FN as a callback outside any command (a thread result): its edits become one undo step,
   the log is pinned while it runs, errors go to the echo area, and the screen is redrawn. */
function runCallback<T>(fn: () => T) {
  const b = E.current, before = snap(b), pin = b.pin;
  if (before.ver < b.pin) b.pin = before.ver;
  E.noUndo = false;
  try { L.resetOps(); return fn(); }
  catch (e) { reportError(e); return undefined; }
  finally { finishUndo(b, before); b.pin = pin; render(); }
}
async function dispatch(k: string) {
  if (k.startsWith('<cmd:')) { await runCommand(intern(k.slice(5, -1)), ''); return; }
  if (hooks.beforeKey && await hooks.beforeKey(k)) return;
  if (E.uArg && /^(-|[0-9])$/.test(k)) {
    E.uDigits = (E.uDigits || '') + k;
    E.prefixArg = k === '-' && E.uDigits === '-' ? intern('-') : Number(E.uDigits);
    E.echo = 'C-u ' + E.uDigits + '-'; return;
  }
  let seq = k;
  try {
    for (;;) {
      const def = lookupKey(seq);
      if (def === undefined && seq === 'ESC') {
        E.pendingKeys = 'ESC'; if (!E.mini) E.echo = 'ESC-';
        const k2 = await nextKey();
        seq = normKey(k2.startsWith('M-') ? k2 : 'M-' + k2);
        continue;
      }
      if (def === PREFIX) {
        E.pendingKeys = seq;
        if (!E.mini && /^[CM]-|^ESC/.test(seq)) E.echo = seq + '-';
        const k2 = await nextKey();
        if (k2 === 'ESC' || k2 === 'C-g') {
          E.pendingKeys = ''; E.echo = k2 === 'C-g' ? 'Quit' : '';
          E.prefixArg = null; if (hooks.undefinedKey) hooks.undefinedKey(seq);
          return;
        }
        seq = seq + ' ' + k2;
        continue;
      }
      E.pendingKeys = '';
      if (def === undefined) {
        if (seq === k && selfInsertable(k) && (!hooks.canSelfInsert || hooks.canSelfInsert(E.current))) { await runCommand(intern('self-insert-command'), k); return; }
        message(seq + ' is undefined'); ding();
        E.prefixArg = null; if (hooks.undefinedKey) hooks.undefinedKey(seq);
        return;
      }
      await runCommand(def, seq);
      return;
    }
  } finally { E.pendingKeys = ''; }
}
async function commandLoop() {
  for (;;) {
    try { const k = await nextKey({ sentinel: true }); if (k !== SENTINEL) await dispatch(k); }
    catch (e) { reportError(e); flushReplay(); }
  }
}
/* Run KEYS as if typed, in a nested loop, and return when they are used up (for :normal). */
async function executeKeys(keys: string[]) {
  pushSentinel(keys);
  E.depth++;
  try {
    for (;;) {
      const k = await nextKey({ sentinel: true });
      if (k === SENTINEL) break;
      try { await dispatch(k); }
      catch (e) {
        reportError(e);
        while (queue.length && queue[0].k !== SENTINEL) queue.shift();
      }
    }
  } finally { E.depth--; }
}

/* ---------- incremental search (Emacs style) ---------- */
function isearchStart(dir: number) {
  E.isearch = { dir, str: '', origin: E.current.pt, stack: [], failing: false, wrapped: false, match: null };
}
/* Start of the last match of the global regexp RE (matches at most LEN long) at or before FROM,
   scanning back in windows (slices of a flat string are O(1)), so the cost follows the distance
   to the match, not the size of the text. */
function lastMatch(str: string, re: RegExp, from: number, len: number, win?: number) {
  win = win || 65536;
  for (let hi = from; hi >= 0; hi -= win) {
    const ws = Math.max(0, hi - win + 1), sub = str.slice(ws, Math.min(str.length, hi + len));
    let last = -1, m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(sub)) && ws + m.index <= hi) { last = m.index; re.lastIndex = m.index + 1; }
    if (last >= 0) return ws + last;
  }
  return -1;
}
function isearchFind(next: boolean) {
  const s = E.isearch!, b = E.current;
  if (!s.str) { s.match = null; s.failing = false; return; }
  /* Case folding with a regular expression, not by lowercasing a copy of the whole buffer. */
  const fold = s.str === s.str.toLowerCase();
  const hay = b.text, needle = s.str;
  const re = fold ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  let i: number;
  if (s.dir > 0) {
    const from = s.failing && next ? 0 : next ? b.pt : (s.match ? s.match[0] : s.origin);
    if (s.failing && next) s.wrapped = true;
    if (re) { re.lastIndex = Math.max(0, from); const m = re.exec(hay); i = m ? m.index : -1; } else i = hay.indexOf(needle, from);
    if (i >= 0) { s.match = [i, i + needle.length]; b.pt = s.match[1]; s.failing = false; } else s.failing = true;
  } else {
    const from = s.failing && next ? hay.length : next ? (s.match ? s.match[0] - 1 : b.pt - 1) : (s.match ? s.match[0] : s.origin);
    if (s.failing && next) s.wrapped = true;
    i = from < 0 ? -1 : re ? lastMatch(hay, re, from, needle.length) : hay.lastIndexOf(needle, from);
    if (i >= 0) { s.match = [i, i + needle.length]; b.pt = i; s.failing = false; } else s.failing = true;
  }
}
function isearchExit() {
  const s = E.isearch!, b = E.current;
  if (s.str) E.lastSearch = s.str;
  if (b.pt !== s.origin) { b.mark = s.origin; b.markActive = false; E.echo = 'Mark saved where search started'; }
  E.isearch = null;
}
function isearchKey(k: string) {
  const s = E.isearch!, b = E.current;
  const def = lookupKey(k);
  const name = def instanceof L.Sym ? def.name : '';
  const save = () => s.stack.push({ pt: b.pt, str: s.str, failing: s.failing, match: s.match, dir: s.dir, wrapped: s.wrapped });
  if (k === 'C-g') {
    if (s.failing && s.stack.length) { while (s.failing && s.stack.length) Object.assign(s, s.stack.pop()), b.pt = s.match ? (s.dir > 0 ? s.match[1] : s.match[0]) : s.origin; return true; }
    b.pt = s.origin; E.isearch = null; E.echo = 'Quit'; return true;
  }
  if (name === 'isearch-forward' || name === 'isearch-backward') {
    save();
    const dir = name === 'isearch-forward' ? 1 : -1;
    if (!s.str) { s.str = E.lastSearch; s.dir = dir; isearchFind(false); return true; }
    if (dir !== s.dir) { s.dir = dir; s.failing = false; }
    isearchFind(true); return true;
  }
  if (k === 'DEL') { const p = s.stack.pop() as EcIsearchFrame | undefined; if (p) { Object.assign(s, p); b.pt = p.pt; } else ding(); return true; }
  if (k === 'RET') { isearchExit(); return true; }
  if (k === 'C-w') {
    const end = s.match ? s.match[1] : b.pt; let e = end; while (e < b.rope.length && /\w/.test(b.rope.at(e)!)) e++;
    if (e === end && e < b.rope.length) e++;
    save(); s.str += b.rope.slice(end, e); isearchFind(false); return true;
  }
  const ch = keyChar(k);
  if (ch !== null && ch !== '\n' && ch !== '\t') { save(); s.str += ch; isearchFind(false); return true; }
  isearchExit();
  return false;
}
async function isearch(dir: number) {
  isearchStart(dir);
  while (E.isearch) {
    const k = await nextKey();
    if (!isearchKey(k)) { unreadKeys([k], E.lastKeyReal); break; }
  }
}

/* ---------- redisplay ---------- */
const esc = (s: string) => s.replace(/[&<>"]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
const CLS_NAMES = ['', 'cm', 'st', 'pa', 'nu', 'kw', 'fn', 'co', 'qu', 'dc'];
const FLAG = { REGION: 1, MATCH: 2, LAZY: 4, PAREN: 8, MISMATCH: 16 };
E.avy = null; E.pulse = null;
function markMatches(t: string, flags: Uint8Array, re: RegExp, limit: number) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null, count = 0;
  while ((m = r.exec(t)) && count++ < limit) {
    if (m[0] === '') { r.lastIndex++; continue; }
    for (let j = m.index; j < m.index + m[0].length; j++) flags[j] |= FLAG.LAZY;
  }
}
/* Display flags for the text from FROM to TO only; the array is indexed from FROM. */
function computeFlags(b: EdBuffer, opts: EcRenderOpts, from: number, to: number, slice?: string) {
  const t = b.rope, n = t.length, flags = new Uint8Array(to - from + 1);
  const mark = (a: number, z: number, f: number) => { a = Math.max(a, from); z = Math.min(z, to); for (let k = a; k < z; k++) flags[k - from] |= f; };
  if (b.visual && b.mark !== null) {
    const s = Math.min(b.pt, b.mark), e = Math.max(b.pt, b.mark);
    if (b.visual === 'char') mark(s, Math.min(e + 1, n), FLAG.REGION);
    else if (b.visual === 'line') mark(bol(t, s), Math.min(n, eol(t, e) + 1), FLAG.REGION);
    else if (b.visual === 'block') {
      const c1 = Math.min(column(t, b.pt), column(t, b.mark)), c2 = Math.max(column(t, b.pt), column(t, b.mark));
      for (let ls = bol(t, Math.max(s, from)); ls <= e && ls < to; ) {
        const le = eol(t, ls); let c = 0;
        for (let k = ls; k < le; k++) { const w = t.charCodeAt(k) === 9 ? ((c + 8) & ~7) - c : 1; if (c + w - 1 >= c1 && c <= c2) mark(k, k + 1, FLAG.REGION); c += w; }
        if (le >= n) break; ls = le + 1;
      }
    }
  } else if (b.markActive && b.mark !== null) mark(Math.min(b.pt, b.mark), Math.max(b.pt, b.mark), FLAG.REGION);
  if (slice === undefined) slice = t.slice(from, to);
  if (opts.hl) { const r = new RegExp(opts.hl.source, opts.hl.flags.includes('g') ? opts.hl.flags : opts.hl.flags + 'g'); let m: RegExpExecArray | null, count = 0; while ((m = r.exec(slice)) && count++ < 3000) { if (m[0] === '') { r.lastIndex++; continue; } mark(from + m.index, from + m.index + m[0].length, FLAG.LAZY); } }
  if (opts.isearch && opts.isearch.str) {
    const s = opts.isearch, fold = s.str === s.str.toLowerCase();
    const hay = fold ? slice.toLowerCase() : slice, needle = fold ? s.str.toLowerCase() : s.str;
    for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) mark(from + k, from + k + needle.length, FLAG.LAZY);
    if (s.match && !s.failing) mark(s.match[0], s.match[1], FLAG.MATCH);
  }
  if (opts.current) mark(opts.current[0], opts.current[1], FLAG.MATCH);
  return flags;
}
const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
function parenFlags(b: EdBuffer, cls: ArrayLike<number>, flags: Uint8Array, onChar: boolean | undefined, from: number, to: number) {
  const t = b.rope, p = b.pt, c0 = t.charAt(p);
  let k = -1;
  /* ( ), [ ] and { } are counted as one kind (matchParen), so a pair that does not match, ( with ], shows as a
     mismatch, as show-paren-mode does. */
  const close = (c: string) => c === ')' || c === ']' || c === '}';
  if (onChar && cls[p] === C.PAR) k = p;
  else if (p > 0 && close(t.charAt(p - 1)) && cls[p - 1] === C.PAR) k = p - 1;
  else if (!close(c0) && cls[p] === C.PAR) k = p;
  const set = (i: number, f: number) => { if (i >= from && i < to) flags[i - from] |= f; };
  if (k >= 0) {
    const o = matchParen(t, cls, k);
    if (o === null || o === undefined || CLOSER[t.charAt(Math.min(k, o))] !== t.charAt(Math.max(k, o))) set(k, FLAG.MISMATCH);
    else { set(k, FLAG.PAREN); set(o, FLAG.PAREN); }
  }
}
function spanClass(cls: string, f: number) {
  let cn = cls;
  if (f & FLAG.REGION) cn += ' rg'; if (f & FLAG.LAZY) cn += ' lz'; if (f & FLAG.MATCH) cn += ' im';
  if (f & FLAG.PAREN) cn += ' pm'; if (f & FLAG.MISMATCH) cn += ' px';
  const d = (f >> 5) & 7; if (d) cn += ' d' + (d - 1);
  return cn.trim();
}
/* Folds: B.folds is a sorted list of {s, e} ranges that org.ts keeps, S the end of the line that stays
   shown and E the end of the last hidden line. The lines that start after S and at or before E are
   not shown; the line that ends at S shows an ellipsis in their place. */
function foldAt(folds: EdFold[], ls: number) {
  let lo = 0, hi = folds.length - 1, f: EdFold | null = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (folds[m].s < ls) { f = folds[m]; lo = m + 1; } else hi = m - 1; }
  return f && ls <= f.e ? f : null;
}
function foldEndingAt(folds: EdFold[], le: number) {
  let lo = 0, hi = folds.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1, s = folds[m].s; if (s === le) return folds[m]; if (s < le) lo = m + 1; else hi = m - 1; }
  return null;
}
const foldsOf = (b: EdBuffer) => b.folds && b.folds.length ? b.folds : null;
/* Lines hidden by F, counted once: an edit inside a fold removes it and one before it shifts it. */
function foldLines(b: EdBuffer, f: EdFold) { if (f.n === undefined) f.n = lineNoB(b, f.e) - lineNoB(b, f.s); return f.n; }
/* Hidden lines before each fold, cumulative, so a shown line number is a binary search away. org.ts keeps
   the folds sorted and bumps b._foldVer when the list changes; an edit before a fold only shifts it. */
function foldPrefix(b: EdBuffer, F: EdFold[]) {
  let c = (b as EcFoldBuffer)._foldPre;
  if (!c || c.ver !== b._foldVer || c.n !== F.length) {
    const pre = new Int32Array(F.length + 1);
    for (let i = 0; i < F.length; i++) pre[i + 1] = pre[i] + foldLines(b, F[i]);
    c = (b as EcFoldBuffer)._foldPre = { ver: b._foldVer, n: F.length, pre };
  }
  return c.pre;
}
/* Line numbers that count shown lines only: the line of P, or of the headline that hides it. */
function vLineNo(b: EdBuffer, p: number) {
  const F = foldsOf(b); if (!F) return lineNoB(b, p);
  const pre = foldPrefix(b, F);
  let lo = 0, hi = F.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (F[mid].s < p) lo = mid + 1; else hi = mid; }
  if (lo > 0 && p <= F[lo - 1].e) return lineNoB(b, F[lo - 1].s) - pre[lo - 1];
  return lineNoB(b, p) - pre[lo];
}
/* Start of the Nth shown line. */
function vLineStart(b: EdBuffer, n: number) {
  const F = foldsOf(b); if (!F) return lineStartB(b, n);
  const pre = foldPrefix(b, F);
  let lo = 0, hi = F.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lineNoB(b, F[mid].s) - pre[mid] < n) lo = mid + 1; else hi = mid; }
  return lineStartB(b, n + pre[lo]);
}
function vLineCount(b: EdBuffer) { const F = foldsOf(b); if (!F) return lineCountB(b); return lineCountB(b) - foldPrefix(b, F)[F.length]; }
/* Render the lines of B from the line at O.from, at most O.count lines (every line when o.lines is
   false: the minibuffer). Span offsets are relative to the line start, so an edit changes only the
   lines it touches. Returns [{o, n, cl, html}], or one HTML string without lines.
   With o.cache (a Map from the previous render of the same window), the html of a line whose
   inputs (text, classes, flags, depths, the cursor) did not change is reused instead of being
   built again from spans; the Map of the lines just rendered is returned as .cache.
   With o.runs (DT0, the display seam), each line instead carries .text (its text, no newline) and .runs,
   the same spans as data for a backend that is not a page (display.ts): {s, e, cls} with offsets from the
   line start and the class string of the span, plus k: 'cur' (the cursor; e === s at the end of a line),
   'avy' and 'ell' (t: the label or the fold ellipsis shown instead), 'eol' (the region past the end).
   The two never share a cache; o.html === false skips the html. */
let KBUF = new Uint16Array(1024);
function renderBuffer(b: EdBuffer, o: EcRenderOpts & { runs: true }): EcRendered;
function renderBuffer(b: EdBuffer, o: EcRenderOpts): EcRendered | string;
function renderBuffer(b: EdBuffer, o: EcRenderOpts) {
  const r = b.rope, n = r.length;
  const lines = o.lines !== false;
  const pt = o.pt === undefined ? b.pt : o.pt;
  const curLine = lines ? lineNoB(b, pt) : 1;
  const folds = lines ? foldsOf(b) : null;
  let ls = lines ? bol(r, Math.max(0, Math.min(o.from || 0, n))) : 0;
  if (folds) { const f = foldAt(folds, ls); if (f) ls = Math.min(n, f.e + 1); }
  const count = lines ? (o.count || 1e9) : 1e9;
  let endPos = ls, cnt = 0;
  for (let p = ls; cnt < count; cnt++) {
    const le = eol(r, p); endPos = Math.min(n, le + 1); if (le >= n) { endPos = n; break; }
    p = le + 1;
    if (folds) { const f = foldAt(folds, p); if (f) { p = f.e + 1; if (p > n) { endPos = n; break; } } }
  }
  const from = ls, to = endPos;
  /* Work on the shown lines only: SEG is the text from FROM to TO, and t reads it with buffer positions. */
  const seg = r.slice(from, to);
  const t = { charAt: (k: number) => seg.charAt(k - from), slice: (a: number, z: number) => seg.slice(a - from, z - from) };
  const eolS = (p: number) => { const q = seg.indexOf('\n', p - from); return q < 0 ? to : q + from; };
  const cls = isLisp(b) && !b.minibuf ? lexOf(b, true) : null;
  /* A mode's own lexer (hooks.lexSeg, org.ts) classifies the shown segment: ECLS is indexed from FROM
     and named by its own table. */
  const ext = !cls && lines && hooks.lexSeg ? hooks.lexSeg(b, from, to, seg) as EcLexSeg : null;
  const ecls = ext ? ext.cls : null, names = ext ? ext.names : CLS_NAMES;
  const ellT = folds ? String(hooks.ellipsis ? hooks.ellipsis(b) : '...') : '';
  const ell = folds ? `<span class="oe">${esc(ellT)}</span>` : '';
  const flags = computeFlags(b, o, from, to, seg);
  if (cls && o.active) parenFlags(b, cls, flags, o.onChar, from, to);
  const depths = cls && b._ld && truthy(L.get('rainbow-delimiters-enabled')) ? b._ld as Uint8Array : null;
  const key = (k: number) => ((cls && k < n ? cls[k] : ecls ? ecls[k - from] || 0 : 0) << 8) | flags[k - from] | (depths && cls![k] === C.PAR ? (depths[k] + 1) << 5 : 0);
  const last = lastLineStart(r);
  const showPhantom = pt === n || n === 0;
  const out: EcRendered = [];
  const wantRuns = !!o.runs, wantHtml = o.html !== false || !wantRuns;
  let R: EdRun[] | null = null;
  const cache = (lines || wantRuns) && !o.avy ? o.cache || null : null, next = (lines || wantRuns) && !o.avy ? new Map<string, EcLineVal>() : null;
  /* The cache key also names the class table (a mode's own lexer numbers its classes differently) and
     the fold ellipsis, which change a line's html without changing its text or keys. */
  const ckPre = (o.active ? 1 : 0) + '|' + (o.cursorClass || '') + '|' + (ext ? 'x' : '') + '|' + ell + '|' + (wantRuns ? 'R' + (wantHtml ? 'H' : '') + '|' : '');
  let ln = lines ? lineNoB(b, ls) : 1, made = 0, vis = '';
  for (; ls <= n && made < count; ln++, made++) {
    const le = eolS(ls);
    if (lines && ls === n && ls > 0 && !showPhantom && ls > last) break;
    /* VIS is what fitsRows measures: a folded line also shows the ellipsis after its text. */
    if (folds) vis += seg.slice(ls - from, le - from) + (foldEndingAt(folds, le) ? ellT : '') + seg.slice(le - from, le - from + 1);
    let html = '', start = ls;
    const rel = lines ? ls : 0;
    /* The keys (class, flags, depth) of the line's characters and of its end, read once. */
    const len = le - ls + 1;
    if (KBUF.length < len) KBUF = new Uint16Array(len + (len >> 1) + 1024);
    const kb = KBUF;
    for (let k = ls; k <= le; k++) kb[k - ls] = key(k);
    let ck: string | null = null;
    if (next && len <= 8192) {
      ck = ckPre + (pt >= ls && pt <= le ? pt - ls : -1) + '|' + (le < n ? 1 : 0) + (folds && foldEndingAt(folds, le) ? 'E' : '') + '|' + seg.slice(ls - from, le - from) + '\u0000' + String.fromCharCode.apply(null, kb.subarray(0, len) as unknown as number[]);
      const hit = cache ? cache.get(ck) : undefined;
      if (hit !== undefined) { next.set(ck, hit); pushLine(hit, le); continue; }
    }
    if (wantRuns) R = [];
    const flush = (end: number) => {
      if (end <= start) return;
      const kk = kb[start - ls];
      if (R) R.push({ s: start - ls, e: end - ls, cls: spanClass(names[kk >> 8], kk & 255) });
      if (wantHtml) html += `<span class="${spanClass(names[kk >> 8], kk & 255)}" data-o="${start - rel}">${esc(t.slice(start, end))}</span>`;
    };
    for (let k = ls; k <= le; k++) {
      if (o.avy && o.avy.has(k)) {
        flush(k);
        const lab = o.avy.get(k)!, w = Math.min(lab.length, Math.max(1, le - k));
        if (R) R.push({ s: k - ls, e: k - ls + w, cls: 'avy', k: 'avy', t: lab.slice(0, w) });
        if (wantHtml) html += `<span class="avy" data-o="${k - rel}">${esc(lab.slice(0, w))}</span>`;
        start = k + w; k += w - 1; continue;
      }
      if (k === pt) {
        flush(k);
        const ch = t.charAt(k), atEnd = k === le;
        const kc = atEnd ? '' : cls ? CLS_NAMES[cls[k]] : ecls ? names[ecls[k - from]] || '' : '';
        const fk = flags[k - from] || 0;
        const ccls = `cur ${o.cursorClass || ''}${o.active ? '' : ' ghost'}${kc ? ' ' + kc : ''}${fk & FLAG.REGION ? ' rg' : ''}${fk & FLAG.PAREN ? ' pm' : ''}`;
        if (R) R.push({ s: k - ls, e: atEnd ? k - ls : k - ls + 1, cls: ccls, k: 'cur' });
        if (wantHtml) html += `<span class="${ccls}" data-o="${k - rel}" data-len="${atEnd ? 0 : 1}">${atEnd ? ' ' : esc(ch)}</span>`;
        start = atEnd ? k : k + 1;
        continue;
      }
      if (k === le) {
        flush(k);
        if (le < n && (flags[le - from] & FLAG.REGION)) { if (R) R.push({ s: le - ls, e: le - ls, cls: 'rg eolsel', k: 'eol', t: ' ' }); if (wantHtml) html += `<span class="rg eolsel" data-o="${le - rel}"> </span>`; }
        if (folds && foldEndingAt(folds, le)) { if (R) R.push({ s: le - ls, e: le - ls, cls: 'oe', k: 'ell', t: ellT }); if (wantHtml) html += ell; }
        break;
      }
      if (k > start && kb[k - ls] !== kb[start - ls]) { flush(k); start = k; }
    }
    const val: EcLineVal = !R ? html : wantHtml ? { html, runs: R } : R;
    if (ck !== null) next!.set(ck, val);
    pushLine(val, le);
  }
  function pushLine(val: EcLineVal, le: number) {
    const num = o.numbers ? (o.numbers === 'relative' && ln !== curLine ? Math.abs(ln - curLine) : ln) : null;
    if (wantRuns) {
      const x = { o: ls, n: num, cl: ln === curLine, html: wantHtml ? (val as EcLineBoth).html : undefined, pulse: o.pulse === ls, runs: wantHtml ? (val as EcLineBoth).runs : val as EdRun[], text: seg.slice(ls - from, le - from) };
      out.push(x);
    } else out.push({ o: ls, n: num, cl: ln === curLine, html: val as string, pulse: o.pulse === ls });
    ls = le >= n ? n + 1 : le + 1;
    if (folds && ls <= n) { const f = foldAt(folds, ls); if (f) { ls = f.e + 1; if (ls > n) ls = n + 1; else ln = lineNoB(b, ls) - 1; } }
  }
  if (lines || wantRuns) { out.seg = folds ? vis : seg; out.cache = next; return out; }
  return out.map(x => x.html).join('\n');
}
function syncLines(view: EcView, lines: EcLine[]) {
  const kids = view.children as HTMLCollectionOf<EcLineEl>;
  /* When the window scrolls, the line at index i is the one that was at i+1 (or i-1): its element
     is moved into place rather than refilled, since parsing innerHTML costs more than the rest. */
  let byO: Map<number | undefined, EcLineEl> | null = null;
  for (let i = 0; i < lines.length; i++) {
    const L0 = lines[i];
    let el = kids[i];
    if (!el || el._o !== L0.o) {
      /* Only the elements from this index on are candidates: the earlier ones hold their lines. */
      if (byO === null) { byO = new Map(); for (let j = i; j < kids.length; j++) byO.set(kids[j]._o, kids[j]); }
      const m = byO.get(L0.o);
      if (m && m !== el && m._h === L0.html) { view.insertBefore(m, el || null); el = m; }
      else if (!el) { el = view.ownerDocument.createElement('div'); view.appendChild(el); }
    }
    if (byO !== null) byO.delete(el._o);
    if (el._h !== L0.html) { el.innerHTML = L0.html!; el._h = L0.html; }
    /* Compare against values kept on the element: reading className and dataset costs more. */
    const cn = (L0.cl ? 'ln cl' : 'ln') + (L0.pulse ? ' pulse' : '');
    if (el._cn !== cn) { el.className = cn; el._cn = cn; }
    if (el._o !== L0.o) { el.dataset.o = String(L0.o); el._o = L0.o; }
    if (el._n !== L0.n) { if (L0.n === null) el.removeAttribute('data-n'); else el.dataset.n = String(L0.n); el._n = L0.n; }
  }
  while (kids.length > lines.length) view.removeChild(view.lastChild!);
}
/* Scrolling moves the window start by whole lines, as in Emacs; the view itself never scrolls. */
function scrollWindow(w: EdWindow, lines: number) {
  const b = w.buffer, cur = vLineNo(b, w.start), total = vLineCount(b);
  const target = Math.max(1, Math.min(total, cur + lines));
  w.start = vLineStart(b, target);
}
function onScroll(w: EdWindow) { void w; }
function percent(w: EdWindow) {
  const b = w.buffer, total = lineCountB(b), first = lineNoB(b, w.start), lastShown = w.lastLine || first;
  if (first <= 1 && lastShown >= total) return 'All';
  if (first <= 1) return 'Top';
  if (lastShown >= total) return 'Bot';
  return Math.round((first - 1) / Math.max(1, total - 1) * 100) + '%';
}
function lineHeight() { return metrics(E.sel!).lh; }
/* Geometry of a window's text view. The style-derived parts (line height, character width,
   padding) are cached until the view's classes or the font (E.metricsGen, bumped by the face
   commands and on web-font loads) change, since getComputedStyle and the probe force style work.
   The size is cached too, against E.sizeGen: the view's box only changes with the frame (a window
   resize, a split), the echo area above it or the view's own classes, and each of those bumps the
   generation; a ResizeObserver catches what they miss (a wrapping modeline, an echo area that
   changed after the windows were drawn) and redraws. Reading
   the size on every render forced a layout of the lines the previous render had changed, which
   cost more than the rest of redisplay together. With long lines truncated the view can grow a
   scrollbar as its content changes, so the size is read every time then. */
E.metricsGen = 0; E.sizeGen = 0;
host.page.onFontsLoaded(() => { E.metricsGen++; render(); });
function sizeChanged() { E.sizeGen!++; }
/* A render from inside a frame callback (an animation frame, a resize observer, a media query
   change): the layout is computed in this frame anyway, so overlays place themselves at once
   instead of a frame late (E.inFrame). */
function frameRender() { E.inFrame = true; try { render(); } finally { E.inFrame = false; } }
host.page.onResize(sizeChanged);
/* index.html's narrow-screen rule changes the text's font size and padding, which the style cache holds:
   read it again when the rule starts or stops applying. */
host.page.onMedia('(max-width: 560px)', () => { E.metricsGen++; frameRender(); });
/* The observer watches each view's border box and compares it with the one the last render read,
   whatever the generation: the echo area changes after the windows are drawn, and that resize
   would otherwise wait for the next key. A scrollbar coming or going (long lines truncated) changes
   the client size but not the box; redrawing for it changed the row count, which flipped the
   scrollbar again, every frame. */
const sizeWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
  let stale = false;
  for (const en of entries) {
    const v = en.target as EcView, m = v._win && v._win._m;
    if (!m || !v.isConnected) continue;
    if (v.offsetHeight !== m.oh0 || v.offsetWidth !== m.ow0) stale = true;
  }
  if (stale) { sizeChanged(); frameRender(); }
}) : null;
function metrics(w: EdWindow) {
  const v = w.view!, key = v.className + '|' + E.metricsGen;
  let m = w._m as EcMetrics | undefined;
  if (!m || m.key !== key) {
    const cs = v.ownerDocument.defaultView!.getComputedStyle(v);
    const probe = v.ownerDocument.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:0;top:0';
    probe.textContent = '0'.repeat(64);
    v.appendChild(probe);
    /* Measured rectangles are scaled by an ancestor's transform (a card at zoom z, R9.9); the layout
       sizes (clientWidth) are not, so the measurements are divided by the scale. */
    const sc = viewScale(v);
    const ch = probe.getBoundingClientRect().width / 64 / sc;
    probe.textContent = 'iW'.repeat(32);
    const mono = Math.abs(probe.getBoundingClientRect().width / 64 / sc - ch) < 0.01;
    v.removeChild(probe);
    m = w._m = { key, sgen: -1, lh: parseFloat(cs.lineHeight) || 21, ch, mono, padT: parseFloat(cs.paddingTop) || 0, padX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0), nowrap: v.classList.contains('nowrap') } as EcMetrics;
  }
  if (m.sgen !== E.sizeGen || m.nowrap) {
    m.ch0 = v.clientHeight; m.cw0 = v.clientWidth; m.oh0 = v.offsetHeight; m.ow0 = v.offsetWidth; m.cw = m.cw0 - m.padX; m.top = v.clientTop + m.padT; m.oh = v.getBoundingClientRect().height / viewScale(v); m.sgen = E.sizeGen!;
  }
  return m;
}
/* The scale an ancestor's CSS transform applies to element V (1 without one). */
function viewScale(v: HTMLElement) { const ow = v.offsetWidth; if (!ow) return 1; const w = v.getBoundingClientRect().width; return w > 0 ? w / ow : 1; }
/* Whether every shown line fits on one row, judged without layout: printable ASCII and tabs only
   in a monospace font, with three columns to spare (the cursor at the line end, the end-of-line
   region mark, rounding). Anything else is measured in the DOM. */
function fitsRows(seg: string, m: EcMetrics, cols: number, nowrap: boolean) {
  if (!m.mono || !(m.ch > 0) || /[^\t\n\x20-\x7e]/.test(seg)) return false;
  if (nowrap) return true;
  const lim = cols - 3;
  if (lim <= 0) return false;
  let c = 0;
  for (let k = 0; k < seg.length; k++) {
    const x = seg.charCodeAt(k);
    if (x === 10) { c = 0; continue; }
    c = x === 9 ? (c + 8) & ~7 : c + 1;
    if (c > lim) return false;
  }
  return true;
}
/* Build or update the DOM for the window tree, then draw each window. */
function ensureWindowDom() {
  const root = $('windows')!, doc = root.ownerDocument;
  const build = (node: EdWindowNode): HTMLElement => {
    if (node instanceof Window) {
      if (!node.el) {
        node.el = doc.createElement('div'); node.el.className = 'win'; node.el.dataset.wid = node.id as unknown as string;
        node.view = doc.createElement('div'); node.view.className = 'text'; node.view.setAttribute('role', 'textbox'); node.view.setAttribute('aria-multiline', 'true');
        node.ml = doc.createElement('div'); node.ml.className = 'modeline';
        node.ml.innerHTML = '<span class="ml-tag" hidden></span><span class="ml-state"></span><span class="ml-name"></span><span class="ml-pos"></span><span class="ml-mode"></span><span class="ml-extra"></span><span class="ml-sync"></span><span class="ml-cmd"></span>';
        node.el.appendChild(node.view); node.el.appendChild(node.ml);
        (node.view as EcView)._win = node; if (sizeWatch) sizeWatch.observe(node.view, { box: 'border-box' });
        if (hooks.wireWindow) hooks.wireWindow(node);
      }
      return node.el;
    }
    if (!node.el) { node.el = doc.createElement('div'); }
    node.el.className = 'split ' + (node as EdSplit).dir;
    const kids = (node as EdSplit).children.map(build);
    // Keep children in order; move or append as needed without rebuilding their contents.
    for (let i = 0; i < kids.length; i++) if (node.el.children[i] !== kids[i]) { node.el.insertBefore(kids[i], node.el.children[i] || null); sizeChanged(); }
    while (node.el.children.length > kids.length) { node.el.removeChild(node.el.lastChild!); sizeChanged(); }
    return node.el;
  };
  const top = build(E.root!);
  if (root.firstChild !== top) { root.textContent = ''; root.appendChild(top); sizeChanged(); }
  while (root.children.length > 1) { root.removeChild(root.lastChild!); sizeChanged(); }
}
function windowRows(w: EdWindow) { if (!w.view) return w.rows || 24; const m = metrics(w); return Math.max(1, Math.floor(m.ch0 / m.lh)); }
/* What window W shows this redisplay, for the page and for display.ts alike: whether it is the selected window
   of the frame being drawn, its point, Evil's look, and the options its text is rendered with. */
function windowState(w: EdWindow): EcWindowState {
  /* The selected window of a frame that is not the selected frame shows its own point (w.pt) with a ghost cursor. */
  const b = w.buffer, selected = w === E.sel && FS() === (E.frame || E.implicit);
  const look: EdLook = hooks.look ? hooks.look(b, w) : {};
  const nums = L.get('display-line-numbers');
  const numbers = nums === intern('relative') ? 'relative' : truthy(nums) && nums !== NIL ? 'absolute' : null;
  const centered = truthy(localValue(b, 'centered-view-enabled'));
  const nowrap = truthy(L.get('truncate-lines')) && !truthy(localValue(b, 'visual-line-enabled'));
  const active = selected && !E.mini && E.focused;
  const pt = selected ? b.pt : Math.min(w.pt, b.rope.length);
  const opts: EcRenderOpts = { active, numbers, cursorClass: look.cursor || '', onChar: look.onChar, hl: look.hl as RegExp | null | undefined, current: selected ? look.current as [number, number] | null : null, isearch: selected ? E.isearch : null, pt, avy: E.avy && E.avy.win === w ? E.avy.labels as Map<number, string> : null, pulse: selected && E.pulse && (E.pulse as EcPulse).b === b ? (E.pulse as EcPulse).ls : -1 };
  return { b, selected, look, numbers, centered, nowrap, active, pt, opts };
}
/* The first shown line (shown-line numbers: folds hide some) of a window ROWS rows tall with point on shown
   line PTLINE: the window's start, unless point left the window or a recenter (C-l, zz) is pending. */
function scrollStart(w: EdWindow, b: EdBuffer, ptLine: number, rows: number, selected: boolean) {
  if (w.start > b.rope.length) w.start = 0;
  w.start = bol(b.rope, w.start);
  let startLine = vLineNo(b, w.start);
  const rc = selected ? E.recenter : null;
  if (rc === 'top') startLine = ptLine;
  else if (rc === 'bottom') startLine = Math.max(1, ptLine - rows + 1);
  else if (rc) startLine = Math.max(1, ptLine - Math.floor(rows / 2));
  else if (ptLine < startLine) startLine = startLine - ptLine <= 2 ? ptLine : Math.max(1, ptLine - Math.floor(rows / 2));
  else if (ptLine >= startLine + rows) startLine = ptLine - (startLine + rows) <= 1 ? ptLine - rows + 1 : Math.max(1, ptLine - Math.floor(rows / 2));
  if (selected) E.recenter = null;
  return startLine;
}
/* The modeline's fields for window W (ST from windowState), read after the window is drawn (percent needs
   w.lastLine): the Evil tag and its state, the modified mark, the buffer name, the position, the modes, the
   macro note, the sync status and the pending command. */
function modelineFields(w: EdWindow, st: EdWindowState, ptLine: number): EdModelineFields {
  const { b, look, pt, selected } = st;
  return {
    tag: look.tag || '', state: look.state || '', mark: b.readOnly ? '%%' : b.modified ? '**' : '--', name: b.name,
    pos: `L${foldsOf(b) ? lineNoB(b, pt) : ptLine} C${column(b.rope, pt)}  ${percent(w)}`,
    mode: `(${MODE_NAMES[b.mode] || b.mode}${lighters(b)}${selected && E.isearch ? ' Isearch' : ''})`,
    extra: look.extra || '', sync: hooks.modeStatus ? hooks.modeStatus(b, FS()) : '', cmd: selected ? look.showcmd || '' : '',
  };
}
function renderWindow(w: EdWindow) {
  const st = windowState(w), { b, selected, look, numbers, centered, nowrap, pt, opts } = st, view = w.view as EcView;
  const total = lineCountB(b);
  /* Style and class writes only when they change: each one dirties style and layout. */
  const gw = String(Math.max(2, String(total).length));
  if ((w as { _gw?: string })._gw !== gw) { view.style.setProperty('--gw', gw); (w as { _gw?: string })._gw = gw; }
  const vc = (numbers ? 'n' : '') + (nowrap ? 'w' : '') + (centered ? 'c' : '');
  if (w._vc !== vc) { view.classList.toggle('numbers', !!numbers); view.classList.toggle('nowrap', nowrap); view.classList.toggle('centered', centered); w._vc = vc; }
  if (w._selected !== selected) { w.el!.classList.toggle('selected', selected); w._selected = selected; }
  if (view._buf !== b) { view.textContent = ''; view._buf = b; }
  const m = metrics(w), rows = Math.max(1, Math.floor(m.ch0 / m.lh));
  /* Line numbers here count shown lines (folds hide some); w.lastLine stays a real line number. */
  const ptLine = vLineNo(b, pt);
  let startLine = scrollStart(w, b, ptLine, rows, selected);
  let lines!: EcRendered, fits = false;
  let cols = Math.floor((m.cw - (numbers ? (Math.max(2, String(total).length) + 2) * m.ch : 0)) / m.ch);
  /* centered-view-mode caps each line's text at --center-cols (index.html, set by extras.ts). */
  if (centered) cols = Math.min(cols, Number(host.page.getVar('center-cols')) || 100);
  // Wrapped lines take more than one row: render, measure, and move the start down until point fits.
  // When no shown line can wrap, every line is one row of m.lh and the geometry is known without layout.
  for (let tries = 0; tries < 4; tries++) {
    w.start = vLineStart(b, startLine);
    lines = renderBuffer(b, { ...opts, from: w.start, count: rows + 1, cache: w._lcache as Map<string, EcLineVal> | undefined }) as EcRendered;
    w._lcache = lines.cache;
    syncLines(view, lines);
    fits = fitsRows(lines.seg!, m, cols, nowrap);
    if (fits) {
      if (ptLine <= startLine || ptLine >= startLine + lines.length) break;
      const over = m.top + (ptLine - startLine + 1) * m.lh - (m.oh + 1);
      if (over <= 0) break;
      startLine += Math.max(1, Math.ceil(over / m.lh));
      continue;
    }
    const cur = view.querySelector('.cur');
    if (!cur) break;
    const vr = view.getBoundingClientRect(), cr = cur.getBoundingClientRect();
    if (cr.bottom <= vr.bottom + 1 || ptLine <= startLine) break;
    startLine += Math.max(1, Math.ceil((cr.bottom - vr.bottom) / (cr.height || 21)));
  }
  let lastLine = startLine - 1;
  if (fits) {
    let k = 0; while (k < lines.length && m.top + k * m.lh < m.oh) k++;
    while (view.children.length > k) view.removeChild(view.lastChild!);
    lastLine += k;
  } else {
    /* Read every position first, then remove: a removal between reads would force a new layout. */
    const vb = view.getBoundingClientRect().bottom, kids = [...view.children], tops = kids.map(el => el.getBoundingClientRect().top);
    for (let i = 0; i < kids.length; i++) { if (tops[i] >= vb) view.removeChild(kids[i]); else lastLine++; }
  }
  const shown = Math.min(lastLine - startLine + 1, lines.length);
  w.lastLine = foldsOf(b) && shown > 0 ? lineNoB(b, lines[shown - 1].o) : lastLine; w.rows = rows;
  view._lines = lines;
  /* The modeline fields are set only when they change: a DOM write dirties the layout even when
     the text is the same. */
  const ml = modelineFields(w, st, ptLine), mq = (w._mq || (w._mq = {})) as Record<string, EcTextEl>, q = (c: string) => mq[c] || (mq[c] = w.ml!.querySelector<EcTextEl>('.' + c)!);
  const tag = q('ml-tag');
  if (ml.tag) { putText(tag, ml.tag); if (tag._st !== ml.state) { tag.dataset.state = ml.state; tag._st = ml.state; } }
  if (tag._hid !== !ml.tag) { tag.hidden = !ml.tag; tag._hid = !ml.tag; }
  putText(q('ml-state'), ml.mark);
  putText(q('ml-name'), ml.name);
  putText(q('ml-pos'), ml.pos);
  putText(q('ml-mode'), ml.mode);
  putText(q('ml-extra'), ml.extra);
  putText(q('ml-sync'), ml.sync);
  putText(q('ml-cmd'), ml.cmd);
  return look;
}
function putText(el: EcTextEl, s: string) { if (el._t !== s) { el.textContent = s; el._t = s; } }
/* The echo area is written only when its content changes, and a change can change its height,
   and with it the windows above. Its height is read at the start of the next render, before that
   render writes anything, and the windows' sizes are read again only when it moved: most changes
   (isearch, ex and minibuffer typing) keep it. The resize observer redraws in between. */
function setEcho(echo: EcEcho, s: string, html: boolean) {
  if (echo._e === s && echo._eh === html) return;
  if (html) echo.innerHTML = s; else echo.textContent = s;
  echo._e = s; echo._eh = html; echo._dirty = true;
}
function echoMoved(echo: EcEcho) {
  if (!echo._dirty) return;
  echo._dirty = false;
  const h = echo.offsetHeight;
  if (h !== echo._h) { echo._h = h; sizeChanged(); }
}
/* The minibuffer as data, for the page and display.ts: the candidate count ("3/41", "0", null without completion),
   the prompt, the flash, and the shown candidates (vertico-count of them around the selected one), each with its
   label, annotation, whether it is selected, and MARKS, the [from, to) spans of the label that the input's
   terms match. PAD is how many empty rows keep the list vertico-count tall when vertico-resize is #f. */
function miniView(): EdMiniView {
  const m = E.mini!, cands = m.completer ? miniCandidates() : [];
  const label = m.opts.label || (s => s);
  const annotate = m.opts.annotate || null;
  const N = Math.max(3, Math.min(20, Number(L.get('vertico-count')) || 12));
  if (m.index < m.scroll) m.scroll = Math.max(0, m.index);
  if (m.index >= m.scroll + N) m.scroll = m.index - N + 1;
  const terms = E.minibuf.text.slice(miniPrefix(m, E.minibuf.text).length).trim().split(/\s+/).filter(Boolean).map(termRegex);
  const items = cands.slice(m.scroll, m.scroll + N).map((c, i) => {
    const lab = String(label(c));
    return { label: lab, ann: annotate ? String(annotate(c) || '') : '', sel: i + m.scroll === m.index, marks: matchSpans(lab, terms) };
  });
  const pad = items.length && !truthy(L.get('vertico-resize')) ? Math.max(0, N - items.length) : 0;
  return { count: m.completer ? (cands.length ? (m.index + 1) + '/' + cands.length : '0') : null, prompt: m.prompt, flash: E.miniFlash || '', items, pad };
}
/* The echo area outside the minibuffer, for the page and display.ts: TEXT (a message, the isearch line, a key
   prompt, else Evil's state line), or WHICH when a prefix key is pending and its bindings are shown instead. */
function echoView(look: EdLook) {
  let text = E.echo || (E.depth === 0 ? look.stateEcho || '' : '');
  const prompting = E.prompt !== null && E.prompt !== undefined;
  if (E.isearch) { const s = E.isearch; text = `${s.failing ? 'Failing ' : ''}${s.wrapped ? 'Wrapped ' : ''}I-search${s.dir < 0 ? ' backward' : ''}: ${s.str}`; }
  else if (prompting) text = E.prompt!;
  return { text: String(text), which: !!look.prefixHelp && !E.isearch && !prompting };
}
/* The spans of S that any of the regexps TERMS match, sorted and merged: [[from, to), ...]. */
function matchSpans(s: string, terms: RegExp[]) {
  const spans: [number, number][] = [];
  for (const t of terms) {
    let re: RegExp; try { re = new RegExp(t.source, t.flags.includes('g') ? t.flags : t.flags + 'g'); } catch (e) { continue; }
    for (const x of s.matchAll(re)) if (x[0]) spans.push([x.index, x.index + x[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const sp of spans) { const last = out[out.length - 1]; if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else out.push(sp); }
  return out;
}
/* Redisplay: every frame with page parts is drawn; a frame that is not selected is drawn only when
   what it shows changed since its last drawing. The selected frame is drawn last: the overlay hooks run
   for every frame drawn (with that frame current), and the ones that place the popups (corfu, snipe) on
   E.frame then leave them placed for the selected frame. */
function render() {
  const sel = E.frame, drawable = (f: EdFrame) => (f.root || f.backend) && f.wroot && f.sel;
  for (const f of E.frames) if (f !== sel && drawable(f)) renderFrame(f);
  if (sel && drawable(sel)) renderFrame(sel);
}
function frameKey(f: EdFrame) {
  let k = (f.mini ? 'm' : '') + f.echo + '|' + f.miniFlash + '|' + E.metricsGen + '|' + E.sizeGen + '|' + (hooks.statusKey ? hooks.statusKey() : '') + (f.backend ? '|' + f.focused + ':' + f.theme + ':' + JSON.stringify(f.backend.size()) : '');
  for (const w of leaves(f.wroot)) { const b = w.buffer; k += `|${w.id}:${b.id}:${b.ver}:${w.pt}:${w.start}:${b.presence ? b.presence.length + ':' + (b._presTick || 0) : ''}`; }
  return k;
}
function renderFrame(f: EdFrame) {
  if (f !== E.frame) { const k = frameKey(f); if (k === f._rkey) return; f._rkey = k; }
  /* A model frame (no page) is laid out and drawn by display.ts, which sets hooks.renderModel. */
  if (f.backend) { if (hooks.renderModel) withFrame(f, () => hooks.renderModel!(f)); return; }
  withFrame(f, () => renderOne(f));
}
function renderOne(f: EdFrame) {
  ensureWindowDom();
  const echo = $('echo') as EcEcho;
  echoMoved(echo);
  let look: EdLook = {};
  for (const w of windowList()) { const l = renderWindow(w); if (w === E.sel) look = l; }
  if (E.mini) {
    const v = miniView();
    const hl = (it: EdMiniView['items'][number]) => { let out = '', k = 0; for (const [a, z] of it.marks) { out += esc(it.label.slice(k, a)) + '<b>' + esc(it.label.slice(a, z)) + '</b>'; k = z; } return out + esc(it.label.slice(k)); };
    let rows = v.items.map(it => `<div class="cand${it.sel ? ' sel' : ''}"><span class="cl">${hl(it)}</span>${it.ann ? `<span class="ca">${esc(it.ann)}</span>` : ''}</div>`).join('');
    rows += '<div class="cand"> </div>'.repeat(v.pad);
    const count = v.count !== null ? `<span class="cc">${v.count}</span>` : '';
    setEcho(echo, `<div class="miniline">${count}<span class="prompt">${esc(v.prompt)}</span><span class="mb">${renderBuffer(E.minibuf, { active: E.focused, lines: false, cursorClass: 'bar' })}</span>` +
      (v.flash ? `<span class="flash">${esc(v.flash)}</span>` : '') + `</div>` + (rows ? `<div class="cands">${rows}</div>` : ''), true);
    echo.classList.add('active');
  } else {
    echo.classList.remove('active');
    const v = echoView(look);
    if (v.which) setEcho(echo, `<span class="wkp">${esc(look.showcmd || '')}-</span>${look.prefixHelp}`, true);
    else setEcho(echo, v.text, false);
  }
  f.root!.classList.toggle('unfocused', !f.focused);
  /* Display overlays (block-ref text, the popups) for this frame: F is current (withFrame) for the duration. */
  if (hooks.renderOverlay) hooks.renderOverlay(f);
  if (hooks.renderPresence) hooks.renderPresence(f);
}
/* The client rect of LEN characters at buffer position P in window W, from the drawn lines (null when
   the line is not drawn). Overlays (snipe, presence) place themselves with it. */
function rectAt(w: EdWindow, p: number, len: number) {
  const view = w.view!, t = w.buffer.rope, ls = bol(t, p);
  const ln = view.querySelector(`.ln[data-o="${ls}"]`);
  if (!ln) return null;
  let off = p - ls, startNode: Node | null = null, startOff = 0;
  const doc = ln.ownerDocument, walker = doc.createTreeWalker(ln, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const n = node.nodeValue!.length;
    if (!startNode) { if (off < n || (off === n && len === 0)) { startNode = node; startOff = off; off += len; } else { off -= n; continue; } }
    if (startNode && off <= n) { const r = doc.createRange(); r.setStart(startNode, startOff); r.setEnd(node, off); const rs = r.getClientRects(); return rs.length ? rs[0] : r.getBoundingClientRect(); }
    if (startNode) off -= n;
  }
  return null;
}

/* ---------- pointer: map a screen point to a buffer position ---------- */
function windowAt(x: number, y: number) {
  const f = FS() as Partial<EdFrame>; if (!f.root) return null;
  const el = f.root.ownerDocument.elementFromPoint(x, y);
  const we = el && el.closest ? el.closest('.win') : null;
  return we ? windowList().find(w => w.el === we) || null : null;
}
function posFromPoint(x: number, y: number, w?: EdWindow | null) {
  w = w || windowAt(x, y) || E.sel;
  if (!w || !w.view) return null;
  let node: Node, off: number;
  const doc = (FS() as EdFrame).root!.ownerDocument;
  if (doc.caretPositionFromPoint) { const r = doc.caretPositionFromPoint(x, y); if (!r) return null; node = r.offsetNode; off = r.offset; }
  else if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; off = r.startOffset; }
  else return null;
  const view = w.view, t = w.buffer.text;
  if (node === view) {
    for (const ln of view.querySelectorAll<HTMLElement>('.ln')) { const r = ln.getBoundingClientRect(); if (y >= r.top && y < r.bottom) return eol(t, +ln.dataset.o!); }
    return t.length;
  }
  const el = (node.nodeType === 3 ? node.parentElement : node) as HTMLElement;
  if (!view.contains(el)) return null;
  if (el.classList.contains('ln')) {
    const ls = +el.dataset.o!;
    if (off >= el.childNodes.length) return eol(t, ls);
    return posOfEl(el.childNodes[off] as HTMLElement, 0, t) ?? ls;
  }
  return posOfEl(el.closest<HTMLElement>('[data-o]'), node.nodeType === 3 ? off : 0, t);
}
function posOfEl(el: HTMLElement | null, off: number, t: string) {
  if (!el || !el.dataset) return null;
  if (el.classList.contains('ln')) return off ? eol(t, +el.dataset.o!) : +el.dataset.o!;
  const line = el.closest<HTMLElement>('.ln'), base = (line ? +line.dataset.o! : 0) + (+el.dataset.o!);
  if (el.classList.contains('cur')) return base + Math.min(off, +el.dataset.len!);
  if (el.classList.contains('eolsel')) return base;
  return Math.min(base + off, t.length);
}

/* The lexer's source, for the worker pool (pool.ts) to lex big buffers off the main thread. */
const LEX_SOURCE = `const C = ${JSON.stringify(C)};
const KEYWORDS_OF = Object.create(null), DEFINERS_OF = Object.create(null), KW = ${JSON.stringify(LISP_KEYWORDS)}, DEF = ${JSON.stringify(LISP_DEFINERS)};
for (const d in KW) { KEYWORDS_OF[d] = new Set(KW[d]); DEFINERS_OF[d] = new Set(DEF[d]); }
const isWS = ${isWS}; const isDelim = ${isDelim}; const inStr = ${inStr}; const openAt = ${openAt}; const blankAt = ${blankAt};
${lex}
${markDocstrings}
${forwardSexp}
${parenDepths}`;
globalThis.Ed = {
  E, hooks, host, Frame, FrameState, makeFrame, selectFrame, deleteFrame, onFrameEvent, frameEvent, frameScale, withFrame, allWindows, allMinibufs, renderFrame, rectAt, scheduleRender, FRAME_CSS,
  Marker, shiftMarkers, editText, applyOps, applyLineDiff, diffLines: globalThis.Rope.diffLines, withOrigin, runHookSafely, removeHookEverywhere,
  localized, localize, makeLocal, localValue, defaultValue, setDefault, minorModes, minorOn, modeParents, modeChain, lighters, LEX_SOURCE, Store, Buffer, Keymap, PREFIX, C, SENTINEL, getBuffer, getBufferCreate, toBuffer, setWindowBuffer, otherBuffer, checkRO,
  insertText, deleteText, replaceText, spanOf, changedSince, forgetLog, installLex, metrics, lastMatch, bol, eol, lineNo, column, posAtColumn, lastLineStart, lineStartOf, lex, lexOf, codeLexOf, markDocstrings,
  forwardSexp, backwardSexp, upList, matchParen, stringAt, inStringAt, inCommentAt, escapingAt, upListForward, downList, backwardDownList,
  nextListStart, prevListEnd, defunBefore, defunAfter, balancedLisp, balanceSpan, keepsBalance, indentLine, lispIndentFor, isLisp, lispDialect, lispDefiners: LISP_DEFINERS, modeFor, MODE_NAMES,
  normKey, kbd, defineKey, lookupIn, lookupKey, lookupWith, activeMaps, whereIs, keyName, keyChar, selfInsertable, message, ding,
  reportError, errorText, quietQuit, QUIET, feedKey, unreadKeys, flushReplay, nextKey, readMini, exitMini, abortMini, completeMini, historyMove,
  miniCandidates, miniMove, miniInsert, markUsed, termRegex, histories, historyFor, prescient, annotateCommand, annotateFunction, annotateVariable, annotateBuffer, annotateFile, readKeySeq, readChar, commandNames, functionNames, variableNames, bufferNames, isCommand, prefixNumeric, specArgs,
  specCodes, callInteractively, undoStep, redoStep, snap, markSaved, runCommand, dispatch, commandLoop, executeKeys, isearch, render, renderBuffer,
  posFromPoint, windowAt, lineHeight, whenIdle, frameRender, windowState, scrollStart, modelineFields, miniView, echoView, matchSpans, percent, foldsOf, onScroll, scrollWindow, lineIndex, lineNoB, lineStartB, lineCountB, foldAt, vLineNo, vLineStart, vLineCount, windowRows, ensureWindowDom, Window, Split, windowList, selectWindow, splitWindow, deleteWindow, deleteOtherWindows, winConfig, restoreWinConfig, saveWinConfig, windowFor, popToBuffer, leaves, get queueLength() { return queue.length; },
  runCallback,
} satisfies Partial<EdApi> as unknown as EdApi;
})();
