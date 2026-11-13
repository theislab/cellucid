/**
 * Chunked gene tables stop when their expanded view or UI goes away.
 *
 * DE and Marker Genes render "all genes" tables in 250-row chunks across
 * tasks. A loop guarded only by a render revision that nothing advances on
 * close would, when the modal is closed or the UI destroyed, go on appending
 * rows to a detached table until it finished.
 */
import assert from 'node:assert/strict';
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
