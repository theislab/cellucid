/**
 * R9V-8 (bug hunt round 9): a vector field whose row held an infinity said
 * "(NaN in the file)". A row is left out when any value of it is NaN or
 * infinite (`data/embedding-payload.js`), for positions and vectors alike.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { unplacedCellsText } from '../assets/js/app/unplaced-cells-notice.js';
import { vectorPayloadOf } from '../assets/js/data/embedding-payload.js';

test('the notice names every value a row is left out for: NaN or infinite', () => {
  // The rows the payload leaves out: one infinite, one with a NaN component.
  const values = Float32Array.of(0.1, 0.2, Infinity, 0.1, Number.NaN, 0.1, 0.3, 0.3);
  const payload = vectorPayloadOf(values, 2, { vectorScale: 1, roundFirst: false });
  assert.equal(payload.unplacedCount, 2);
  assert.equal(
    unplacedCellsText({ kind: 'vectors', label: 'velocity', count: 2, names: ['cell1', 'cell2'] }),
    '2 cells have no vector in velocity (NaN or infinite in the file) and are drawn without an arrow: cell1, cell2.',
  );
  assert.match(
    unplacedCellsText({ kind: 'layout', label: 'UMAP', count: 1, names: ['cell1'] }),
    /^1 cell has no position in UMAP \(NaN or infinite in the file\) and is not drawn in views showing it: cell1\./,
  );
});
