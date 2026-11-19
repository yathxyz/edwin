/* Transcript interaction is entirely structural. Markdown only supplies faces: headings, fences and paths
   inside an agent's text cannot manufacture command targets. Fold choices live in this runtime, not edwind. */
globalThis.Ed.installAgentTranscript = function (steer: boolean) {
'use strict';
const Ed = globalThis.Ed, L = globalThis.L, E = Ed.E, H = Ed.hooks;
const { CMD, signal, intern } = L;
const MODE = 'agent-transcript-mode';
type Wire = Record<string, unknown>;
interface Span extends Wire {
  id: string; seq: number; kind: string; start: number; end: number;
  foldStart?: number; foldEnd?: number; folded?: boolean;
  hasBlocks?: boolean; locations?: Wire[]; diffs?: Wire[];
}
interface Meta extends Wire { sid: string; epoch: number; head: number; spans: Span[] }
interface Presentation { meta: Meta; ver: number; choices: Map<string, boolean> }
const presentations = new WeakMap<EdBuffer, Presentation>();
const object = (x: unknown): x is Wire => !!x && typeof x === 'object' && !Array.isArray(x);
const isMeta = (x: unknown): x is Meta => object(x) && typeof x.sid === 'string' && typeof x.epoch === 'number' && Array.isArray(x.spans);
const oneLine = (x: unknown) => String(x ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
function metadata(b: EdBuffer = E.current): Meta | null {
  const p = presentations.get(b);
  if (p && (typeof b.sver !== 'number' || p.ver === b.sver)) return p.meta;
  const v = b.meta?.locals?.agentSession;
  return typeof b.sver !== 'number' && isMeta(v) ? v : null;
}
function needMeta(b: EdBuffer = E.current): Meta { return metadata(b) || signal('user-error', 'Not an agent transcript') as never; }
function spanAt(b: EdBuffer = E.current, position = b.pt): Span | null {
  const spans = metadata(b)?.spans;
  if (!spans) return null;
  let lo = 0, hi = spans.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (spans[m].start <= position) lo = m + 1; else hi = m; }
  const s = spans[lo - 1]; return s && position < s.end ? s : null;
}
function folds(b: EdBuffer, p: Presentation) {
  const list: EdFold[] = [];
  for (const s of p.meta.spans) {
    const from = s.foldStart, to = s.foldEnd;
    if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to <= from || to >= b.rope.length) continue;
    if (p.choices.get(s.id) ?? s.folded === true) list.push({ s: from, e: to });
  }
  Ed.setBufferFolds(b, list);
}
function install(b: EdBuffer, m: Meta, ver: number) {
  if (typeof b.sver === 'number' && ver !== b.sver) return;
  const old = presentations.get(b), p: Presentation = { meta: m, ver, choices: old?.meta.epoch === m.epoch ? old.choices : new Map() };
  presentations.set(b, p);
  b.readOnly = true; if (b.evilState === undefined) b.evilState = 'motion';
  folds(b, p);
}
function presentation(b: EdBuffer): Presentation {
  const m = needMeta(b); let p = presentations.get(b);
  if (!p || p.meta !== m) { install(b, m, b.sver ?? b.ver); p = presentations.get(b); }
  return p!;
}
const previousMeta = H.bufferMeta;
H.bufferMeta = (b, locals, ver) => {
  if (previousMeta) previousMeta(b, locals, ver);
  if (isMeta(locals.agentSession)) install(b, locals.agentSession, ver);
};

function target(value?: SchemeValue): EdBuffer {
  if (value === undefined) return E.current;
  const b = E.buffers.find(b => b.id === value);
  return b || signal('user-error', 'Open the transcript buffer before calling its presentation commands') as never;
}
function position(b: EdBuffer, value?: SchemeValue): number {
  const pos = value === undefined ? b.pt : value;
  if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 0 || pos > b.rope.length) return signal('user-error', 'Transcript position must be a zero-based buffer offset') as never;
  return pos;
}
function result(b: EdBuffer) { return { bufferId: b.id, point: b.pt, folds: (b.folds || []).map(f => ({ s: f.s, e: f.e })) }; }
function toggleFold(b: EdBuffer, pos = b.pt) {
  const p = presentation(b), s = spanAt(b, position(b, pos));
  if (!s || s.foldStart === undefined || s.foldEnd === undefined) return signal('user-error', 'No foldable transcript block here');
  const closed = !(p.choices.get(s.id) ?? s.folded === true);
  p.choices.set(s.id, closed); folds(b, p);
  if (closed && b.pt > s.foldStart && b.pt <= s.foldEnd) b.pt = s.start;
  Ed.scheduleRender(); return result(b);
}
CMD('agent-session-toggle-fold', '', '&optional BUFFER POSITION', 'Toggle the structural transcript block at point or POSITION in BUFFER (TAB).', ([id, pos]: SchemeValue[]) => {
  const b = target(id); return toggleFold(b, position(b, pos));
});
function setFolds(b: EdBuffer, closed: boolean) {
  const p = presentation(b);
  for (const s of p.meta.spans) if (s.foldStart !== undefined && s.foldEnd !== undefined) p.choices.set(s.id, closed);
  folds(b, p);
  if (closed) { const s = spanAt(b); if (s?.foldStart !== undefined && s.foldEnd !== undefined && b.pt > s.foldStart && b.pt <= s.foldEnd) b.pt = s.start; }
  Ed.scheduleRender(); return result(b);
}
CMD('agent-session-open-folds', '', '&optional BUFFER', 'Open all structural transcript folds in BUFFER or the current transcript.', ([id]: SchemeValue[]) => setFolds(target(id), false));
CMD('agent-session-close-folds', '', '&optional BUFFER', 'Close all structural transcript folds in BUFFER or the current transcript.', ([id]: SchemeValue[]) => setFolds(target(id), true));
function navigate(b: EdBuffer, direction: number, pos = b.pt) {
  const m = needMeta(b), prompts = m.spans.filter(s => s.kind === 'prompt');
  const s = direction > 0 ? prompts.find(s => s.start > pos) : prompts.findLast(s => s.start < pos);
  if (!s) return signal('user-error', direction > 0 ? 'No next prompt' : 'No previous prompt');
  b.pt = s.start; Ed.scheduleRender(); return result(b);
}
CMD('agent-session-next-prompt', '', '&optional BUFFER POSITION', 'Go to the next structural prompt from POSITION in BUFFER (] ]).', ([id, pos]: SchemeValue[]) => { const b = target(id); return navigate(b, 1, position(b, pos)); });
CMD('agent-session-previous-prompt', '', '&optional BUFFER POSITION', 'Go to the previous structural prompt from POSITION in BUFFER ([ [).', ([id, pos]: SchemeValue[]) => { const b = target(id); return navigate(b, -1, position(b, pos)); });
CMD('agent-session-visit-location', '', '', 'Visit a tool’s structural file location through edwind’s filesystem authority (RET). Remote-agent paths are not local files.', async () => {
  const b = E.current, m = needMeta(b), s = spanAt(b);
  const locations = s?.kind === 'tool' && Array.isArray(s.locations) ? s.locations.filter(l => object(l) && typeof l.path === 'string') : [];
  if (!locations.length) return signal('user-error', 'No tool file location here');
  let location = locations[0];
  if (locations.length > 1) {
    const labels = locations.map((l, i) => `${i + 1}: ${oneLine(l.path)}${typeof l.line === 'number' ? ':' + l.line : ''}`);
    const picked = await Ed.readMini('Tool location: ', labels[0], () => labels, { require: true });
    location = locations[labels.indexOf(picked)];
  }
  const value = await Ed.agentSessions.rpc('agent-session-location', [{ sid: m.sid, epoch: m.epoch, seq: s!.seq, location }]);
  const id = typeof value === 'string' ? value : object(value) && typeof value.id === 'string' ? value.id : null;
  if (!id) return signal('user-error', 'edwind returned no file for this tool location');
  const target = await Ed.agentSessions.show(id);
  const n = typeof location.line === 'number' ? Math.max(1, Math.trunc(location.line)) : 1;
  target.pt = Ed.lineStartB(target, n);
  if (typeof location.column === 'number') target.pt = Ed.posAtColumn(target.rope, target.pt, Math.max(0, Math.trunc(location.column) - 1));
  Ed.scheduleRender(); return false;
});
CMD('agent-session-diff', '', '', 'Show every supplied structural diff for the tool at point, including earlier versions (d).', () => {
  const source = E.current, m = needMeta(source), s = spanAt(source);
  if (!s || !Array.isArray(s.diffs) || !s.diffs.length) return signal('user-error', 'No tool diff here');
  const out = [`# Tool diffs: ${oneLine(m.sid)} #${s.seq}\n\n`];
  for (const d of s.diffs) {
    const old = typeof d.oldStart === 'number' && typeof d.oldEnd === 'number' ? source.rope.slice(d.oldStart, d.oldEnd) : '(no old text)';
    const current = typeof d.newStart === 'number' && typeof d.newEnd === 'number' ? source.rope.slice(d.newStart, d.newEnd) : '(no new text)';
    out.push(`## ${oneLine(d.path)}\n\n### Old text\n`, old, '\n\n### New text\n', current, '\n\n');
  }
  const b = Ed.getBufferCreate(`*Agent Diff: ${m.sid}: ${s.seq}*`);
  b.mode = 'markdown-mode'; b.text = out.join(''); b.readOnly = true; b.modified = false; b.undo = []; b.redo = []; b.pt = 0; b.evilState = 'motion';
  Ed.popToBuffer(b, true); Ed.scheduleRender(); return false;
});
CMD('agent-session-recall', '', '', 'Recall the immutable journal prompt at or before point into a new durable draft (R), preserving its content blocks.', async () => {
  const b = E.current, m = needMeta(b), s = m.spans.findLast(s => s.kind === 'prompt' && s.start <= b.pt);
  if (!s || !s.hasBlocks) return signal('user-error', 'No earlier prompt to recall');
  const id = await Ed.agentSessions.rpc('agent-session-recall', [m.sid, s.seq, m.epoch]);
  if (typeof id !== 'string') return signal('user-error', 'edwind returned no recalled prompt draft');
  await Ed.agentSessions.show(id); return false;
});

Ed.modeParents.set(MODE, 'markdown-mode'); Ed.MODE_NAMES[MODE] = 'Agent Transcript';
CMD(MODE, '', '', 'Use structural read-only agent transcript commands and Markdown fontification.', () => {
  const b = E.current; Ed.switchMajorMode(b, MODE); b.readOnly = true; b.evilState = 'motion'; return false;
});
{
  const map = new Ed.Keymap(MODE + '-map'); L.set(MODE + '-map', map);
  E.aux.set(MODE + ':motion', map); E.aux.set(MODE + ':normal', map);
  for (const [key, cmd] of [
    ['TAB', 'agent-session-toggle-fold'], ['] ]', 'agent-session-next-prompt'], ['[ [', 'agent-session-previous-prompt'],
    ['RET', 'agent-session-visit-location'], ['d', 'agent-session-diff'], ['R', 'agent-session-recall'],
    ['p', 'agent-prompt-compose'], ['g r', 'agent-sessions-refresh'], ['q', 'quit-window'],
    ...(steer ? [['P', 'agent-session-quick-prompt'], ['c', 'agent-session-cancel'], ['!', 'agent-session-answer'],
      ['m', 'agent-session-mode'], ['o', 'agent-session-config'], ['v', 'agent-session-revive']] : []),
  ]) {
    Ed.defineKey(map, key, intern(cmd));
  }
}
for (const name of ['agent-session-toggle-fold', 'agent-session-open-folds', 'agent-session-close-folds', 'agent-session-next-prompt', 'agent-session-previous-prompt', 'agent-session-visit-location', 'agent-session-diff', 'agent-session-recall']) L.put(intern(name), 'evil-repeat', intern('abort'));
/* Touch only takes over the text surface of an agent view. Modelines, other buffers and physical
   mouse input stay with the editor's ordinary DOM handlers, including on hybrid devices. */
const anchors = new WeakMap<EdWindow, { buffer: EdBuffer; point: number; ver: number; start: number }>();
const windowPoint = (w: EdWindow) => w === (E.frame || E.implicit).sel ? w.buffer.pt : w.pt;
H.keepWindowStart = (w, selected) => {
  const a = anchors.get(w);
  if (!a) return false;
  if (!(selected && E.recenter) && w.buffer === a.buffer && w.buffer.ver === a.ver && windowPoint(w) === a.point && w.start === a.start) return true;
  anchors.delete(w); return false;
};
function wireTouch(f: EdFrame) {
  const root = f.el('windows'), win = root?.ownerDocument.defaultView;
  if (!root || !win) return;
  const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts: AddEventListenerOptions) => {
    el.addEventListener(type, fn as EventListener, opts); f.listeners.push([el, type, fn, opts]);
  };
  const hit = (x: number, y: number) => Ed.withFrame(f, () => {
    const w = Ed.windowAt(x, y), el = root.ownerDocument.elementFromPoint(x, y);
    if (!w?.view || !el || !w.view.contains(el)) return null;
    const locals = w.buffer.meta?.locals;
    if (!locals?.agentSession && !locals?.agentList && !locals?.agentPrompt && !presentations.has(w.buffer)) return null;
    const line = el.closest('.oe')?.closest<HTMLElement>('.ln');
    const pos = line ? Ed.eol(w.buffer.rope, +line.dataset.o!) : Ed.posFromPoint(x, y, w);
    return pos === null ? null : { w, pos, marker: !!line };
  });
  type Contact = { id: number; x: number; y: number; lastY: number; acc: number; w: EdWindow; moved: boolean; page: boolean };
  let contact: Contact | null = null;
  let lastTap: { time: number; x: number; y: number; w: EdWindow; line: number } | null = null;
  on(root, 'touchstart', e => {
    contact = null;
    if (e.touches.length !== 1) { lastTap = null; return; }
    const t = e.touches[0], at = hit(t.clientX, t.clientY);
    if (!at) { lastTap = null; return; }
    contact = { id: t.identifier, x: t.clientX, y: t.clientY, lastY: t.clientY, acc: 0, w: at.w, moved: false, page: false };
  }, { passive: true });
  on(root, 'touchmove', e => {
    const c = contact;
    if (!c) return;
    if (e.touches.length !== 1 || e.touches[0].identifier !== c.id) { contact = lastTap = null; return; }
    const t = e.touches[0], dx = t.clientX - c.x, dy = t.clientY - c.y, delta = c.lastY - t.clientY;
    c.lastY = t.clientY;
    if (!c.moved && Math.hypot(dx, dy) <= 8) return;
    if (!c.moved) { c.moved = true; lastTap = null; c.acc = -dy; c.page = Math.abs(dx) > Math.abs(dy); }
    else c.acc += delta;
    const w = c.w;
    if (c.page || !delta) return;
    if (!e.cancelable || (delta < 0 && w.start === 0) || (delta > 0 && (w.lastLine || 0) >= Ed.lineCountB(w.buffer))) { c.page = true; return; }
    e.preventDefault();
    const height = Ed.metrics(w).lh * Ed.frameScale(f), lines = Math.trunc(c.acc / height);
    if (lines) {
      c.acc -= lines * height; Ed.scrollWindow(w, lines);
      anchors.set(w, { buffer: w.buffer, point: windowPoint(w), ver: w.buffer.ver, start: w.start });
      Ed.frameRender();
    }
  }, { passive: false });
  on(root, 'touchend', e => {
    const c = contact; contact = null;
    if (!c || c.moved || e.touches.length) { lastTap = null; return; }
    const t = Array.from(e.changedTouches).find(t => t.identifier === c.id);
    if (!t || Math.hypot(t.clientX - c.x, t.clientY - c.y) > 8) { lastTap = null; return; }
    const at = hit(t.clientX, t.clientY);
    if (!at || at.w !== c.w) { lastTap = null; return; }
    e.preventDefault(); f.focus(); if (E.frame !== f) Ed.selectFrame(f);
    if (E.mini) { lastTap = null; return; }
    const { w, pos, marker } = at, b = w.buffer;
    if (w !== E.sel) Ed.selectWindow(w);
    if (E.isearch) E.isearch = null;
    if (H.mouseDown) H.mouseDown(b, pos, { button: 0, shiftKey: false, ctrlKey: false, altKey: false });
    else { b.pt = pos; b.markActive = false; }
    const line = Ed.bol(b.rope, pos), time = e.timeStamp;
    const twice = lastTap && time >= lastTap.time && time - lastTap.time <= 350 && w === lastTap.w && line === lastTap.line && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) <= 24;
    lastTap = twice || marker ? null : { time, x: t.clientX, y: t.clientY, w, line };
    if (twice || marker) {
      const s = spanAt(b, pos);
      if (typeof s?.foldStart === 'number' && typeof s.foldEnd === 'number' && s.foldEnd > s.foldStart) toggleFold(b, pos);
    }
    Ed.frameEvent('point', f, b); Ed.render();
  }, { passive: false });
  on(root, 'touchcancel', () => { contact = lastTap = null; }, { passive: true });
  on(win, 'scroll', () => { if (contact) { contact.moved = true; contact.page = true; } lastTap = null; }, { passive: true, capture: true });
  /* Cancelling touchend prevents the corresponding compatibility click. If the browser still sends
     one, ignore only events it identifies as touch-derived on our own text surface, never by time. */
  on(root, 'mousedown', e => {
    if ((e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents && hit(e.clientX, e.clientY)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, { capture: true });
}
const wire = H.wireFrame;
H.wireFrame = f => { wire?.(f); wireTouch(f); };
for (const f of E.frames) wireTouch(f);
(Ed as typeof Ed & { agentTranscript: { metadata: typeof metadata; spanAt: typeof spanAt; install: typeof install; toggleFold: typeof toggleFold } }).agentTranscript = { metadata, spanAt, install, toggleFold };
};
