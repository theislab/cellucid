import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deliverSelectionToViewerHost } from '../assets/js/app/ui/modules/highlight/selection-notification.js';

const UI_MODULE_ROOT = new URL('../assets/js/app/ui/modules/', import.meta.url);

test('Viewer host highlight delivery reports asynchronous failure exactly once', async () => {
  const failure = new Error('synthetic viewer host delivery failure');
  const observed = [];

  await deliverSelectionToViewerHost({
    viewerHostSource: {
      async notifySelection() {
        throw failure;
      }
    },
    cellIndices: Uint32Array.of(1, 4, 9),
    source: 'lasso',
    onFailure(error) {
      observed.push(error);
    }
  });

  assert.deepEqual(observed, [failure]);
});

test('Viewer host highlight delivery rejects a non-Promise transport contract', () => {
  assert.throws(
    () => deliverSelectionToViewerHost({
      viewerHostSource: {
        notifySelection() {
          return undefined;
        }
      },
      cellIndices: Uint32Array.of(2),
      source: 'knn',
      onFailure() {}
    }),
    /notifySelection.*Promise/i
  );
});

test('assigned UI modules contain no swallowed catch or alternate drag payload', async () => {
  const filenames = [
    'field-selector.js',
    'legend/categorical-legend.js',
    'highlight/annotation-selection.js',
    'highlight/lasso-selection.js',
    'highlight/knn-selection.js',
    'highlight/proximity-selection.js',
    'highlight/selection-notification.js'
  ];
  const sources = await Promise.all(
    filenames.map(filename => readFile(new URL(filename, UI_MODULE_ROOT), 'utf8'))
  );
  const source = sources.join('\n');

  assert.doesNotMatch(source, /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*)?\}/);
  assert.doesNotMatch(source, /dataTransfer.*text\/plain|text\/plain.*dataTransfer/);
});
