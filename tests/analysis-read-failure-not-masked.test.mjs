/**
 * A gene read that fails reaches the caller as itself. `readGeneColumns`
 * stops the other reads when one fails; that stop is the failure's own
 * cleanup, and once it was reported as "invalidated by an analysis request
 * ownership change" -- every failed signature read said so, whatever the
 * cause (analysis overhaul §0.1).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';

function createLayer(readGeneColumn) {
  const layer = Object.create(DataLayer.prototype);
  layer._datasetGeneration = 1;
  layer._destroyed = false;
  layer.readGeneColumn = readGeneColumn;
  return layer;
}

test('a failed gene read rejects with its own error, not an ownership change', async () => {
  const stopped = [];
  const layer = createLayer(async (gene, { signal }) => {
    if (gene === 'Missing') throw new Error('[DataLayer] Gene not found: Missing');
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        stopped.push(gene);
        reject(signal.reason);
      }, { once: true });
    });
  });
  await assert.rejects(
    layer.readGeneColumns(['Slow', 'Missing'], { isCurrent: () => true }),
    /Gene not found: Missing/
  );
  assert.deepEqual(stopped, ['Slow'], 'the other reads are stopped');
});

test('a read failure after the request stopped being current reports the ownership change', async () => {
  let current = true;
  const layer = createLayer(async gene => {
    current = false;
    throw new Error(`[DataLayer] Gene not found: ${gene}`);
  });
  await assert.rejects(
    layer.readGeneColumns(['Missing'], { isCurrent: () => current }),
    error => error.code === 'ANALYSIS_DATA_REQUEST_INVALIDATED' &&
      /ownership change/.test(error.message)
  );
});

test('a cancelled read rejects with the cancellation', async () => {
  const controller = new AbortController();
  const layer = createLayer(async (_gene, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const run = layer.readGeneColumns(['A'], { signal: controller.signal });
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(run, error => error.name === 'AbortError');
});
