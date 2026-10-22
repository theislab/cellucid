/**
 * A kept view's recolour rewrites its colour store in place -- one gather,
 * as an adoption rewrites it -- when the view alone owns the store and the
 * store already holds the order the view draws with. A shared store, or one
 * in another order, is replaced (the general publication transaction). It
 * used to allocate a new RGB store and a new vertex array on every recolour,
 * about 70 MB transient a view at 10M cells.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../assets/js/rendering/high-perf-renderer.js', import.meta.url), 'utf8');

test('a sole-owner recolour in the drawn order is gathered in place, anything else is replaced', () => {
  const start = source.indexOf('\n  updateSnapshotColors(id, colors) {');
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(body, /owner\.refCount === 1 &&\n\s*\(owner\.order \?\? null\) === \(orderRecord\?\.drawOrder \?\? null\)/);
  assert.match(body, /this\._writeOrderedColors\(owner\.buffer, colors, orderRecord, label\);\n\s*snapshot\.colors = colors;\n(\s*\/\/.*\n)*\s*this\._clearKeptColorStores\(snapshot\.colorCache\);\n\s*return true;/);
  assert.match(body, /return this\._replaceSnapshotResources\(/);
});
