import assert from 'node:assert/strict';
import type { Edwin } from './headless.mts';

/* ---------- a small DOM for the frame tests ----------
   Enough of Element and Document for Ed.makeFrame and a render with no browser (R9.2): a node tree, class,
   id and data attributes, inline style, listeners, innerHTML parsed for the simple markup the core writes,
   the selectors the core and the overlay hooks use (.c, #i, tag.c, .c[data-x="v"], lists), and a fixed
   geometry: a monospace grid of 8 x 21 px in a 600 x 400 view, each .ln at its index. */
export interface FakeEvent { type: string; target: FakeElement; defaultPrevented: boolean; preventDefault(): void; [k: string]: unknown }
type Handler = (e: FakeEvent) => void;
type FakeChild = FakeElement | FakeText;
interface Query { tag: string | null; classes: string[]; id: string | null; attrs: { name: string; value: string | null }[] }
interface Rect { left: number; top: number; width: number; height: number; right: number; bottom: number }
interface FakeDocument {
  nodeType: 9; listeners: [string, Handler][]; hit: FakeElement | null;
  createElement(tag: string): FakeElement; createTextNode(s: string): FakeText;
  documentElement: FakeElement; body: FakeElement; activeElement: FakeElement;
  getElementById(id: string): FakeElement | null;
  addEventListener(t: string, fn: Handler): void; removeEventListener(t: string, fn: Handler): void;
  elementFromPoint(): FakeElement | null;
  caretPositionFromPoint(): { offsetNode: FakeElement; offset: number } | null;
  defaultView: {
    document: FakeDocument;
    getComputedStyle(): { lineHeight: string; paddingTop: string; paddingLeft: string; paddingRight: string };
    addEventListener(t: string, fn: Handler): void; removeEventListener(t: string, fn: Handler): void; getSelection(): null;
  };
}
class FakeNode {
  declare ownerDocument: FakeDocument; declare nodeType: number; declare nodeName: string; declare parentNode: FakeElement | null; declare childNodes: FakeChild[];
  constructor(doc: FakeDocument, type: number, name: string) { this.ownerDocument = doc; this.nodeType = type; this.nodeName = name; this.parentNode = null; this.childNodes = []; } get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; } }
class FakeText extends FakeNode { declare nodeType: 3; declare nodeValue: string; constructor(doc: FakeDocument, s: string) { super(doc, 3, '#text'); this.nodeValue = s; } get textContent() { return this.nodeValue; } }
const kebab = (k: string) => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] !== undefined ? ENT[e] : m));
function parseSelector(sel: unknown): Query[] {
  return String(sel).split(',').map(part => {
    const m = /^\s*([a-zA-Z0-9-]+)?((?:[.#][-\w]+|\[[-\w]+(?:="[^"]*")?\])*)\s*$/.exec(part);
    if (!m) throw new Error('fake DOM: unsupported selector ' + sel);
    const q: Query = { tag: m[1] ? m[1].toLowerCase() : null, classes: [], id: null, attrs: [] };
    for (const t of m[2].match(/[.#][-\w]+|\[[^\]]*\]/g) || []) {
      if (t[0] === '.') q.classes.push(t.slice(1));
      else if (t[0] === '#') q.id = t.slice(1);
      else { const a = /^\[([-\w]+)(?:="([^"]*)")?\]$/.exec(t)!; q.attrs.push({ name: a[1], value: a[2] === undefined ? null : a[2] }); }
    }
    return q;
  });
}
function matches(el: FakeElement, q: Query) {
  if (q.tag && el.localName !== q.tag) return false;
  if (q.id !== null && el.id !== q.id) return false;
  for (const c of q.classes) if (!el.classList.contains(c)) return false;
  for (const a of q.attrs) { if (!el.attrs.has(a.name)) return false; if (a.value !== null && el.attrs.get(a.name) !== a.value) return false; }
  return true;
}
function walk(n: FakeChild, fn: (n: FakeChild) => void) { fn(n); for (const c of n.childNodes) walk(c, fn); }
export class FakeElement extends FakeNode {
  declare nodeType: 1; declare tagName: string; declare localName: string; declare attrs: Map<string, string>; declare listeners: [string, Handler, unknown][]; declare value: string; declare _html: string;
  declare style: { cssText: string; setProperty(k: string, v: unknown): void; getPropertyValue(k: string): string };
  declare classList: { contains(c: string): boolean; add(...cs: string[]): void; remove(...cs: string[]): void; toggle(c: string, force?: unknown): boolean };
  declare dataset: Record<string, string | undefined>;
  constructor(doc: FakeDocument, tag: string) {
    super(doc, 1, tag.toUpperCase());
    this.tagName = tag.toUpperCase(); this.localName = tag.toLowerCase(); this.attrs = new Map(); this.listeners = []; this.value = ''; this._html = '';
    const props = new Map();
    this.style = { cssText: '', setProperty: (k, v) => { props.set(k, String(v)); }, getPropertyValue: k => props.get(k) || '' };
    const el = this, classes = () => (el.attrs.get('class') || '').split(/\s+/).filter(Boolean), setClasses = (cs: string[]) => { el.attrs.set('class', cs.join(' ')); };
    this.classList = {
      contains: c => classes().includes(c),
      add: (...cs) => { const l = classes(); for (const c of cs) if (!l.includes(c)) l.push(c); setClasses(l); },
      remove: (...cs) => setClasses(classes().filter(c => !cs.includes(c))),
      toggle: (c, force) => { const on = force === undefined ? !classes().includes(c) : !!force; if (on) el.classList.add(c); else el.classList.remove(c); return on; },
    };
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (t, k) => (typeof k === 'string' ? el.attrs.get('data-' + kebab(k)) : undefined),
      set: (t, k, v) => { el.attrs.set('data-' + kebab(k as string), String(v)); return true; },
      deleteProperty: (t, k) => { el.attrs.delete('data-' + kebab(k as string)); return true; },
      has: (t, k) => el.attrs.has('data-' + kebab(k as string)),
    });
  }
  get id() { return this.attrs.get('id') || ''; } set id(v) { this.attrs.set('id', String(v)); }
  get className() { return this.attrs.get('class') || ''; } set className(v) { this.attrs.set('class', String(v)); }
  get hidden() { return this.attrs.has('hidden'); } set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get title() { return this.attrs.get('title') || ''; } set title(v) { this.attrs.set('title', String(v)); }
  getAttribute(n: string) { return this.attrs.has(n) ? this.attrs.get(n) : null; } setAttribute(n: string, v: unknown) { this.attrs.set(n, String(v)); } removeAttribute(n: string) { this.attrs.delete(n); } hasAttribute(n: string) { return this.attrs.has(n); }
  /* Live, as HTMLCollection is: the core reads length and indexes while it adds and removes. */
  get children() { const el = this, now = () => el.childNodes.filter((c): c is FakeElement => c.nodeType === 1); return new Proxy([] as FakeElement[], { get(t, k) { const c = now(); const v = (c as unknown as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? v.bind(c) : v; }, has(t, k) { return k in now(); } }); }
  get firstChild() { return this.childNodes[0] || null; } get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get isConnected() { let n: FakeElement = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  appendChild(c: FakeChild) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c: FakeChild, ref: FakeChild | null) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); const i = this.childNodes.indexOf(ref); if (i < 0) throw new Error('fake DOM: insertBefore of a non-child'); c.parentNode = this; this.childNodes.splice(i, 0, c); return c; }
  removeChild(c: FakeChild) { const i = this.childNodes.indexOf(c); if (i < 0) throw new Error('fake DOM: removeChild of a non-child'); this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  contains(n: FakeChild | null) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent(): string { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(s: string | null | undefined) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this._html = ''; if (s !== '' && s !== null && s !== undefined) this.appendChild(new FakeText(this.ownerDocument, String(s))); }
  get innerHTML() { return this._html; }
  set innerHTML(s) {
    this.textContent = ''; this._html = String(s);
    const re = /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[a-zA-Z_:][-\w:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
    const voids = new Set(['br', 'hr', 'img', 'input', 'wbr']);
    let cur: FakeElement = this, m: RegExpExecArray | null;
    while ((m = re.exec(this._html))) {
      if (m[1]) { if (cur !== this) cur = cur.parentNode!; }
      else if (m[2]) {
        const el = this.ownerDocument.createElement(m[2]);
        for (const a of m[3].matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) el.attrs.set(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
        cur.appendChild(el);
        if (!m[4] && !voids.has(el.localName)) cur = el;
      } else cur.appendChild(new FakeText(this.ownerDocument, m[5] !== undefined ? decode(m[5]) : '<'));
    }
  }
  querySelectorAll(sel: string) { const qs = parseSelector(sel), out: FakeElement[] = []; walk(this, n => { if (n !== this && n.nodeType === 1 && qs.some(q => matches(n, q))) out.push(n); }); return out; }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel: string) { const qs = parseSelector(sel); for (let n: FakeElement | null = this; n && n.nodeType === 1; n = n.parentNode) if (qs.some(q => matches(n, q))) return n; return null; }
  addEventListener(t: string, fn: Handler, o?: unknown) { this.listeners.push([t, fn, o]); } removeEventListener(t: string, fn: Handler) { this.listeners = this.listeners.filter(l => !(l[0] === t && l[1] === fn)); }
  /* Capture listeners run down to the target before the ordinary listeners bubble back up. */
  dispatch(type: string, init?: Record<string, unknown>): FakeEvent {
    let stopped = false;
    const e: FakeEvent = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { stopped = true; }, ...init };
    const path: FakeElement[] = [];
    for (let n: FakeElement | null = this; n; n = n.parentNode) path.push(n);
    const fire = (el: FakeElement, capture: boolean) => {
      for (const [name, fn, opts] of el.listeners) if (!stopped && name === type && !!(opts as { capture?: boolean } | undefined)?.capture === capture) fn(e);
    };
    for (let i = path.length - 1; i >= 0; i--) fire(path[i], true);
    for (const el of path) fire(el, false);
    return e;
  }
  focus() { this.ownerDocument.activeElement = this; } blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getBoundingClientRect() {
    const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height, right: left + width, bottom: top + height });
    const p = this.parentNode;
    if (this.localName === 'span' && p && p.nodeType === 1 && p.classList.contains('text')) return rect(0, 0, this.textContent.length * 8, 21);   // the metrics probe
    if (this.classList.contains('ln')) return rect(0, p!.children.indexOf(this) * 21, 600, 21);
    return rect(0, 0, 600, 400);
  }
  get clientWidth() { return 600; } get clientHeight() { return 400; } get offsetWidth() { return 600; } get offsetHeight() { return this.classList.contains('ln') ? 21 : 400; } get clientTop() { return 0; }
}
export function makeDocument() {
  const doc = { nodeType: 9, listeners: [], hit: null } as unknown as FakeDocument;
  doc.createElement = tag => new FakeElement(doc, tag);
  doc.createTextNode = s => new FakeText(doc, s);
  doc.documentElement = doc.createElement('html'); doc.body = doc.createElement('body'); doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc.getElementById = id => { let r: FakeElement | null = null; walk(doc.documentElement, n => { if (!r && n.nodeType === 1 && n.id === id) r = n; }); return r; };
  doc.addEventListener = (t, fn) => { doc.listeners.push([t, fn]); };
  doc.removeEventListener = (t, fn) => { doc.listeners = doc.listeners.filter(l => !(l[0] === t && l[1] === fn)); };
  /* The element and caret under a point: whatever the test put in doc.hit (the view), so posFromPoint
     falls back to the line rectangles. */
  doc.elementFromPoint = () => doc.hit;
  doc.caretPositionFromPoint = () => (doc.hit ? { offsetNode: doc.hit, offset: 0 } : null);
  doc.defaultView = { document: doc, getComputedStyle: () => ({ lineHeight: '21px', paddingTop: '0px', paddingLeft: '0px', paddingRight: '0px' }), addEventListener: (t, fn) => { doc.listeners.push([t, fn]); }, removeEventListener: (t, fn) => doc.removeEventListener(t, fn), getSelection: () => null };
  return doc;
}

/* Touch timestamps and coordinates are explicit: no clock delays or browser gesture heuristics. */
export function touch(target: FakeElement, type: string, x: number, y: number, timeStamp: number, extra: Record<string, unknown> = {}) {
  const point = { identifier: 1, clientX: x, clientY: y };
  return target.dispatch(type, { touches: type === 'touchend' || type === 'touchcancel' ? [] : [point], changedTouches: [point], cancelable: true, timeStamp, ...extra });
}

/* A native modeline tap selects via the browser's compatibility mousedown. It must not suppress a
   subsequent physical mouse press. Shared by the frame suite and the no-agent compatibility proof. */
export function assertOrdinaryFrameInput(Ed: Edwin, b: Edwin, agentConfigured = false) {
  const doc = makeDocument(), el = doc.createElement('div'); doc.body.appendChild(el);
  const f = Ed.makeFrame(el, { buffer: b, kind: 'card' }), prev = Ed.hooks.mouseDown;
  try {
    Ed.selectFrame(f);
    const other = Ed.splitWindow(f.sel, 'below'); Ed.render();
    const root = f.el('windows') as FakeElement, ml = other.ml as FakeElement, view = other.view as FakeElement;
    assert.equal(root.listeners.some(([name]) => name.startsWith('touch')), agentConfigured, 'gesture handlers are installed only for agent connections');
    assert.notEqual(other, f.sel);
    doc.hit = ml; b.mark = 1; b.markActive = true;
    const before = b.pt;
    assert.equal(touch(ml, 'touchstart', 20, 30, 100).defaultPrevented, false);
    assert.equal(touch(ml, 'touchend', 20, 30, 120).defaultPrevented, false);
    assert.notEqual(other, f.sel, 'native touch leaves the compatibility press to the browser');
    ml.dispatch('mousedown', { button: 0, clientX: 20, clientY: 30, timeStamp: 121, sourceCapabilities: { firesTouchEvents: true } });
    assert.equal(f.sel, other, 'a tap on another window’s modeline selects that window');
    assert.equal(b.pt, before); assert.equal(b.mark, 1); assert.equal(b.markActive, true);
    assert.equal(doc.activeElement, f.el('input'));
    let seen: FakeEvent | undefined;
    Ed.hooks.mouseDown = (buffer: Edwin, p: number, e: FakeEvent) => { seen = e; assert.equal(buffer, b); buffer.pt = p; };
    doc.hit = view;
    const mouse = view.dispatch('mousedown', { button: 0, clientX: 20, clientY: 30, timeStamp: 122 });
    assert.equal(seen, mouse, 'the immediate physical click reaches the usual handler with its original event');
    assert.equal(b.pt, b.text.indexOf('\n', b.text.indexOf('\n') + 1), 'the second line is hit');
  } finally { Ed.hooks.mouseDown = prev; f.destroy(); }
}
