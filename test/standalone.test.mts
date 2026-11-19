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
