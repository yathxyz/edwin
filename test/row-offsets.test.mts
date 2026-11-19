// A host displaying HTML and runs together can ask for absolute span offsets (no .ln wrappers).
// Click the start of its second row and check the cursor that Edwin draws at that buffer position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inStandalonePage } from './standalone.mts';

for (const edit of [true, false]) {
  test(`cached absolute spans after ${edit ? 'an edit above the row' : 'a line-relative draw'}`, async t => {
    const cursor = await inStandalonePage(t, `
      const b = Ed.getBufferCreate('offsets.txt'), frame = Ed.E.frame;
      b.text = 'x\\nsame'; frame.showBuffer(b);
      const before = Ed.renderBuffer(b, { pt: 0, runs: true, lines: ${!edit} });
      ${edit ? "Ed.applyOps(b, [[0, '', 'x']]);" : ''}
      const rows = Ed.renderBuffer(b, { pt: 0, runs: true, lines: false, cache: before.cache });
      const view = doc.createElement('div');
      view.style.cssText = 'position:fixed;top:0;left:0;z-index:100;background:white;white-space:pre';
      view.innerHTML = rows.map(r => r.html).join('\\n'); doc.body.append(view);
      const rect = view.lastElementChild.getBoundingClientRect();
      const pos = Ed.posFromPoint(rect.left + 1, rect.top + rect.height / 2, { view, buffer: b });
      if (pos === null) throw Error('no hit on second row');
      view.remove(); frame.setPoint(pos); Ed.render();
      return doc.querySelector('#windows .ln .cur').textContent;
    `);
    assert.equal(cursor, 's');
  });
}
