// After stripping src to .js, run with CHROMIUM=/path/to/chromium node --test test/standalone.test.mts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inStandalonePage } from './standalone.mts';

test('the standalone page opens *scratch* and edits it with the keyboard', async t => {
  const firstLine = await inStandalonePage(t, `
    for (const key of ['i', 'X', 'Y', 'Z', 'Escape']) {
      const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      if (doc.activeElement.dispatchEvent(ev)) throw Error('Key not handled: ' + key);
    }
    await Ed.whenIdle();
    return doc.querySelector('#windows .ln').textContent;
  `);
  assert.match(firstLine, /XYZ;; Edwin/);
});

test('frame lifecycle: a new frame starts at its buffer’s point', async t => {
  const result = await inStandalonePage(t, `
    const root = doc.body.appendChild(doc.createElement('div')), b = Ed.getBufferCreate('point.txt');
    b.text = 'abcdef'; b.pt = 3;
    const f = Ed.makeFrame(root, { buffer: b, kind: 'card' });
    const beforeSelection = f.point();
    Ed.selectFrame(f); Ed.render();
    return JSON.stringify([beforeSelection, f.point(), root.querySelector('.cur').textContent]);
  `);
  assert.deepEqual(JSON.parse(result), [3, 3, 'd']);
});

// Capture the actual callback enqueued by scheduleRender so we can deliver it on either side of deletion.
const queueRedisplay = `
  const callbacks = [], host = bootOptions.host, nextFrame = host.nextFrame;
  host.nextFrame = cb => callbacks.push(cb);
  Ed.scheduleRender();
  host.nextFrame = nextFrame;
  if (callbacks.length !== 1) throw Error('Expected one queued redisplay, got ' + callbacks.length);
  const redraw = callbacks[0];
`;

test('frame lifecycle: focus, resize and queued redisplay before boot', async t => {
  const result = await inStandalonePage(t, `
    const f = bootOptions.frame, input = f.el('input'), windows = f.el('windows');
    f.focus();
    const sizeGen = Ed.E.sizeGen;
    win.dispatchEvent(new win.Event('resize'));
    ${queueRedisplay}
    redraw();
    const before = [doc.activeElement === input, Ed.E.sizeGen > sizeGen, Ed.E.frame === f,
                    f.buffer, windows.childElementCount];
    Ed.boot(bootOptions);
    return JSON.stringify({ before, after: [doc.activeElement === input, f.focused,
      windows.querySelector('.ml-name').textContent, !!windows.querySelector('.cur:not(.ghost)')] });
  `, true);
  assert.deepEqual(JSON.parse(result), {
    before: [true, true, true, null, 0],
    after: [true, true, '*scratch*', true],
  });
});

test('frame lifecycle: a second boot is rejected without replacing the live window', async t => {
  const result = await inStandalonePage(t, `
    const f = Ed.E.frame, w = f.sel;
    f.setPoint(7);
    let error = '';
    try { Ed.boot({ host: Ed.host, frame: f }); } catch (e) { error = e.message; }
    return JSON.stringify([error, Ed.E.frame === f, f.sel === w, f.point()]);
  `);
  const [error, ...live] = JSON.parse(result);
  assert.match(error, /already booted/);
  assert.deepEqual(live, [true, true, 7]);
});

test('frame lifecycle: removing the frame before boot leaves the host bootable', async t => {
  const result = await inStandalonePage(t, `
    const f = bootOptions.frame, windows = f.el('windows');
    ${queueRedisplay}
    f.destroy(); redraw();
    let error = '';
    try { Ed.boot(bootOptions); } catch (e) { error = e.message; }
    if (!/not a live frame/.test(error)) throw Error('Expected a dead-frame error, got: ' + error);
    Ed.boot({ host });
    return JSON.stringify([Ed.E.frames.length, Ed.E.frame, Ed.E.current.name, windows.childElementCount]);
  `, true);
  assert.deepEqual(JSON.parse(result), [0, null, '*scratch*', 0]);
});
