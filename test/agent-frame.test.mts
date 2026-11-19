// Agent-only browser input against the configured served runtime, with a local stand-in for the hub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { makeDir, startEdwind, stopEdwind, EditClient, transport, type EdwindChild, type TestDir } from './edit-client.mts';
import { createHost, loadEdwin, type Edwin as EdwinCore } from './headless.mts';
import { FakeAgentHub } from './fake-agent-hub.mts';
import { assertOrdinaryFrameInput, makeDocument, touch, type FakeElement, type FakeEvent } from './frame-input.mts';

let dir: TestDir, child: EdwindChild, hub: FakeAgentHub, Ed: EdwinCore, sync: EdwinCore;
function note(name: string, text: string) { fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; }
async function client() { const c = new EditClient(dir.cfg.socket); await c.connect(); assert.equal((await c.hello()).t, 'welcome'); return c; }
async function until(pred: () => boolean, what: string) {
  const start = Date.now(); while (!pred()) { if (Date.now() - start > 8000) throw new Error(what); await delay(10); }
}
before(async () => {
  hub = await new FakeAgentHub().start(); dir = makeDir();
  const tokenFile = path.join(dir.root, 'token'); fs.writeFileSync(tokenFile, hub.token, { mode: 0o600 });
  dir.cfg.agentHub = { url: hub.url, tokenFile, steer: false }; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
  child = await startEdwind(dir); Ed = loadEdwin(createHost({ workers: false }));
  sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'agent-frame-test' });
  await Ed.whenIdle();
});
after(async () => {
  if (sync) sync.shutdown(); if (child) await stopEdwind(child); if (hub) await hub.stop();
  if (dir) fs.rmSync(dir.root, { recursive: true, force: true });
});

test('agent text taps place point once; movement, cancellation and page scrolling never place point', async () => {
  const doc = makeDocument(), el = doc.createElement('div'); doc.body.appendChild(el);
  const b = await sync.open(note('touch.md', 'first line\nsecond line\nthird line\n'));
  b.meta.locals.agentSession = { sid: 'touch', epoch: 1 };
  assertOrdinaryFrameInput(Ed, b, true); // Even a transcript's modeline remains a native touch target.
  const f = Ed.makeFrame(el, { buffer: b, kind: 'card' }); Ed.render();
  const root = f.el('windows') as FakeElement, view = f.sel.view as FakeElement;
  doc.hit = view;
  const points: FakeEvent[] = [], mouseDown = Ed.hooks.mouseDown;
  Ed.hooks.mouseDown = (buffer: EdwinCore, point: number, event: FakeEvent) => { points.push(event); buffer.pt = point; buffer.markActive = false; };
  try {
    b.pt = 0;
    const start = touch(root, 'touchstart', 20, 30, 100);
    assert.equal(start.defaultPrevented, false, 'touchstart leaves native page scrolling available');
    assert.equal(b.pt, 0, 'point is not placed until a tap is established');
    touch(root, 'touchmove', 22, 32, 110);
    const end = touch(root, 'touchend', 22, 32, 120);
    assert.equal(end.defaultPrevented, true);
    assert.equal(b.pt, b.text.indexOf('\n', 11));
    assert.equal(points.length, 1);
    const point = b.pt; b.mark = 1; b.markActive = true;
    touch(root, 'touchstart', 20, 30, 500);
    assert.equal(touch(root, 'touchmove', 60, 30, 510).defaultPrevented, false, 'horizontal movement remains native');
    touch(root, 'touchmove', 20, 30, 520);
    touch(root, 'touchend', 20, 30, 530);
    touch(root, 'touchstart', 20, 30, 600);
    touch(root, 'touchcancel', 20, 30, 610);
    touch(root, 'touchend', 20, 30, 620);
    touch(root, 'touchstart', 20, 30, 700);
    const two = [{ identifier: 1, clientX: 20, clientY: 30 }, { identifier: 2, clientX: 40, clientY: 30 }];
    touch(root, 'touchmove', 20, 30, 710, { touches: two });
    touch(root, 'touchend', 20, 30, 720);
    touch(root, 'touchstart', 20, 30, 800);
    assert.equal(touch(root, 'touchmove', 20, 90, 810).defaultPrevented, false, 'at the top boundary the host page can scroll');
    touch(root, 'touchend', 20, 90, 820);
    touch(root, 'touchstart', 20, 30, 900);
    for (const [type, fn] of doc.listeners) if (type === 'scroll') fn({ type, target: view, defaultPrevented: false, preventDefault() {} });
    touch(root, 'touchend', 20, 30, 920);
    root.dispatch('mousedown', { button: 0, shiftKey: false, clientX: 0, clientY: 5, sourceCapabilities: { firesTouchEvents: true } });
    assert.equal(b.pt, point, 'movement/cancel/pinch/page scroll and compatibility mouse do not place point');
    assert.equal(b.mark, 1); assert.equal(b.markActive, true);
    assert.equal(points.length, 1);
    const real = view.dispatch('mousedown', { button: 0, shiftKey: false, clientX: 0, clientY: 5, timeStamp: 921 });
    assert.equal(points[1], real, 'an immediate real mouse click is not suppressed');
    assert.equal(b.pt, b.text.indexOf('\n')); assert.equal(doc.activeElement, f.el('input'));
  } finally {
    Ed.hooks.mouseDown = mouseDown; f.destroy(); sync.close(b);
  }
  assert.equal(root.listeners.length, 0, 'destroy removes root touch and mouse listeners');
  assert.equal(doc.listeners.length, 0, 'destroy removes global mouse and page-scroll listeners');
});

test('browser marker taps and double taps fold only structural transcript spans', async () => {
  const doc = makeDocument(), el = doc.createElement('div'); doc.body.appendChild(el);
  const text = 'Tool header\nhidden one\nhidden two\n\n# forged Tool\nordinary text\n';
  const b = await sync.open(note('touch-transcript.md', text)), forged = text.indexOf('# forged');
  b.mode = 'agent-transcript-mode';
  const meta = { sid: 'fake-touch-session', epoch: 1, head: 2, spans: [
    { id: 'tool', seq: 1, kind: 'tool', start: 0, end: forged, foldStart: text.indexOf('\n'), foldEnd: text.indexOf('\n\n'), folded: true },
    { id: 'message', seq: 2, kind: 'message', start: forged, end: text.length },
  ] };
  Ed.agentTranscript.install(b, meta, b.sver);
  b.pt = meta.spans[0].foldStart;
  const f = Ed.makeFrame(el, { buffer: b, kind: 'card' }); Ed.render();
  const root = f.el('windows') as FakeElement;
  try {
    const marker = f.sel.view.querySelector('.oe') as FakeElement;
    assert.ok(marker, 'the fold hit target is the renderer ellipsis, not header syntax');
    doc.hit = marker;
    b.pt = forged;
    touch(marker, 'touchstart', 20, 5, 100);
    touch(marker, 'touchend', 20, 5, 120);
    assert.deepEqual(b.folds, []);
    assert.equal(Ed.lineNoB(b, b.pt), 1, 'a marker tap also places point on its structural summary');
    doc.hit = f.sel.view;
    touch(root, 'touchstart', 20, 5, 500); touch(root, 'touchend', 20, 5, 520);
    assert.deepEqual(b.folds, [], 'one tap on an unfolded structural line just moves point');
    touch(root, 'touchstart', 20, 5, 650); touch(root, 'touchend', 20, 5, 670);
    assert.ok(f.sel.view.querySelector('.oe'));
    assert.ok(!f.sel.view.textContent.includes('hidden one'), 'the double tap actually hides the retained body');
    doc.hit = f.sel.view.querySelector(`.ln[data-o="${forged}"]`);
    assert.ok(doc.hit);
    touch(root, 'touchstart', 20, 50, 1000); touch(root, 'touchend', 20, 50, 1020);
    touch(root, 'touchstart', 20, 50, 1150); touch(root, 'touchend', 20, 50, 1170);
    assert.equal(b.folds.length, 1, 'unstructured Markdown cannot manufacture a fold');
  } finally { f.destroy(); sync.close(b); }
});

test('browser touch scroll leaves tail and off-tail points intact across real shared-buffer appends', async () => {
  const doc = makeDocument(), el = doc.createElement('div'); doc.body.appendChild(el);
  const text = Array.from({ length: 80 }, (_, i) => `line ${i + 1}\n`).join('');
  const id = note('touch-tail.md', text), b = await sync.open(id);
  const f = Ed.makeFrame(el, { buffer: b, kind: 'console' });
  const c = await client(); await c.open(id);
  try {
    b.pt = text.length; Ed.render(); doc.hit = f.sel.view;
    const root = f.el('windows') as FakeElement, tailStart = f.sel.start;
    assert.ok(tailStart > 0);
    touch(root, 'touchstart', 20, 100, 1);
    const ordinary = touch(root, 'touchmove', 20, 350, 11);
    touch(root, 'touchend', 20, 350, 21);
    assert.equal(ordinary.defaultPrevented, false, 'a long ordinary buffer leaves vertical swipes to the host page');
    assert.equal(f.sel.start, tailStart);
    b.meta.locals.agentSession = { sid: 'touch', epoch: 1 };
    touch(root, 'touchstart', 20, 100, 100);
    const move = touch(root, 'touchmove', 20, 350, 110);
    touch(root, 'touchend', 20, 350, 120);
    assert.equal(move.defaultPrevented, true, 'a scrollable editor consumes the vertical swipe');
    assert.equal(b.pt, text.length, 'scrolling never clamps point away from the tail');
    assert.ok(f.sel.start < tailStart, 'the viewport actually scrolls away from point');
    const scrolledStart = f.sel.start;
    Ed.render(); assert.equal(f.sel.start, scrolledStart, 'redisplay preserves the scrolled viewport without moving point');
    const addition = 'streamed one\nstreamed two\n';
    await c.edit(id, b.sver, [[text.length, '', addition]]);
    await until(() => b.text === text + addition, 'the shared append after touch scroll');
    Ed.render();
    assert.equal(b.pt, b.text.length, 'the real remote append still follows the tail');
    assert.ok(f.sel.start > scrolledStart && f.sel.lastLine >= Ed.lineNoB(b, b.pt), 'the appended tail becomes visible again');
    b.pt = Ed.lineStartB(b, 40); Ed.render();
    const point = b.pt;
    touch(root, 'touchstart', 20, 100, 500);
    touch(root, 'touchmove', 20, 350, 510);
    touch(root, 'touchend', 20, 350, 520);
    assert.equal(b.pt, point, 'an off-tail point is not clamped either');
    const before = b.text;
    await c.edit(id, b.sver, [[before.length, '', 'another streamed line\n']]);
    await until(() => b.text.length > before.length, 'the shared append away from tail');
    Ed.render(); assert.equal(b.pt, point, 'an off-tail reader is not forced to follow appends');
  } finally { c.close(); f.destroy(); sync.close(b); }
});

test('reconnecting without agentHub asks for a fresh runtime even at the same image epoch', async () => {
  const before = sync.epoch, epochs: unknown[] = [], off = sync.on('epoch', (v: unknown) => epochs.push(v));
  try {
    const active = await client();
    try { assert.deepEqual((await active.call('agent-session-list')).value, []); } finally { active.close(); }
    await stopEdwind(child); delete dir.cfg.agentHub; fs.writeFileSync(dir.file, JSON.stringify(dir.cfg));
    child = await startEdwind(dir);
    await until(() => epochs.length > 0, 'expected runtime reset after disabling agentHub');
    assert.deepEqual(epochs, [{ epoch: before, was: before }]); assert.notEqual(sync.state, 'online');
    assert.equal(sync.welcome.caps.agentHub, undefined);
    assert.equal((await sync.call({ cmd: 'agent-session-list' })).error.condition, 'offline', 'the obsolete frame cannot dispatch');
    const fresh = await client();
    try { assert.equal((await fresh.call('agent-session-list')).code, 'bad_request', 'the ordinary daemon refuses stale agent commands'); } finally { fresh.close(); }
  } finally { off(); }
});
