/**
 * Chunked gene tables stop when their expanded view or UI goes away.
 *
 * DE and Marker Genes render "all genes" tables in 250-row chunks across
 * tasks. Each copied its own loop, guarded only by a render revision that
 * nothing advanced on close, so closing the modal or destroying the UI left
 * the loop appending rows to a detached table until it finished.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';

function withFragmentDocument(t) {
  const previous = globalThis.document;
  globalThis.document = {
    createDocumentFragment() {
      return { rows: [], appendChild(row) { this.rows.push(row); } };
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
}

function table() {
  return {
    isConnected: true,
    rows: 0,
    appendChild(fragment) {
      this.rows += fragment.rows.length;
    },
  };
}

const rows = Array.from({ length: 1000 }, (_, index) => index);

test('a chunked table renders every row across tasks', t => {
  withFragmentDocument(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  const tbody = table();
  ui._renderTableRows(tbody, rows, row => row, { chunked: true });
  assert.equal(tbody.rows, 250, 'the first chunk is synchronous');
  t.mock.timers.tick(0);
  t.mock.timers.tick(0);
  t.mock.timers.tick(0);
  assert.equal(tbody.rows, 1000);
});

for (const [label, retire] of [
  ['the expanded view closes', ui => ui._cancelChunkedTableRender()],
  ['the UI is destroyed', ui => { ui._isDestroyed = true; }],
  ['the table leaves the document', (_ui, tbody) => { tbody.isConnected = false; }],
  ['a newer table render starts', ui => {
    ui._renderTableRows(table(), [], row => row, { chunked: false });
  }],
]) {
  test(`pending chunks stop when ${label}`, t => {
    withFragmentDocument(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ui = Object.create(FormBasedAnalysisUI.prototype);
    const tbody = table();
    ui._renderTableRows(tbody, rows, row => row, { chunked: true });
    retire(ui, tbody);
    t.mock.timers.tick(0);
    t.mock.timers.tick(0);
    assert.equal(tbody.rows, 250);
  });
}

test('closing the expanded view and destroying the UI cancel the chunks', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js',
      import.meta.url
    ),
    'utf8'
  );
  assert.match(
    source,
    /onClose: \(\) => \{\s*if \(this\._modal === modal\) \{\s*this\._modal = null;\s*this\._cancelChunkedTableRender\(\);/
  );
  assert.match(
    source,
    /destroy\(\) \{[\s\S]*?this\._isDestroyed = true;[\s\S]*?this\._cancelChunkedTableRender\(\);/
  );
  for (const file of ['de-analysis-ui.js', 'genes-panel-ui.js']) {
    const mode = await readFile(
      new URL(`../assets/js/app/analysis/ui/analysis-types/${file}`, import.meta.url),
      'utf8'
    );
    assert.match(mode, /this\._renderTableRows\(tbody, \w+, /, `${file} draws its gene table through the cancellable chunked renderer`);
    assert.doesNotMatch(mode, /setTimeout\(renderChunk/);
  }
});
