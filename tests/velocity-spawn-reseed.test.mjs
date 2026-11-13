// The velocity spawn table is refilled each respawn epoch from where the
// last one stopped, so every visible cell becomes a spawn source, not a
// fixed 65,536 of them.

import assert from 'node:assert/strict';
import test from 'node:test';

import { VelocityOverlay } from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';

function overlayWith(spawnTableSize) {
  return Object.assign(Object.create(VelocityOverlay.prototype), { config: { spawnTableSize } });
}

function runBuild(overlay, transparency, start, reseed, lodMembership = null) {
  const build = overlay._createSpawnTableBuild(transparency, transparency.length, lodMembership, null, start, reseed);
  while (!overlay._advanceSpawnTableBuild(build, null));
  return { table: Array.from(overlay._finishSpawnTableBuild(build)), next: build.position, coversAll: build.coversAll };
}

test('successive epochs cover every visible cell, each once a cycle, and a table of every visible cell is final', () => {
  const cells = 10_007;
  const transparency = new Uint8Array(cells);
  let visible = 0;
  for (let cell = 0; cell < cells; cell++) {
    transparency[cell] = cell % 3 === 0 ? 0 : 1;
    visible += transparency[cell];
  }
  const size = 512;
  const overlay = overlayWith(size);
  const seen = new Map();
  let start = 0;
  let epochs = 0;
  let first = null;
  while (seen.size < visible) {
    const epoch = runBuild(overlay, transparency, start, epochs > 0);
    first ??= epoch.table;
    assert.equal(epoch.table.length, size, 'each epoch fills the table');
    assert.equal(epoch.coversAll, false);
    for (const cell of epoch.table) {
      assert.equal(transparency[cell], 1, 'only visible cells spawn');
      seen.set(cell, (seen.get(cell) ?? 0) + 1);
    }
    start = epoch.next;
    epochs++;
    assert.ok(epochs <= Math.ceil(visible / size) + 1, 'covered within one cycle');
  }
  assert.equal(seen.size, visible, 'every visible cell was a spawn source');
  // Within the first cycle no cell repeats but at its wrap.
  assert.ok([...seen.values()].filter(count => count > 1).length < size);
  // A table's cells spread over the cell range (the visiting order's step).
  assert.ok(first[0] < cells / 8 && first.at(-1) > (cells * 7) / 8);
  // Every visible cell fitting in one table with room to spare: it holds
  // them all, and is final.
  const all = runBuild(overlayWith(visible + 1), transparency, 0, false);
  assert.equal(all.coversAll, true);
  assert.equal(all.table.length, visible);
});

test('a refill reads only as many cells as it takes, a first build checks every value', () => {
  const transparency = new Uint8Array(100_000).fill(1);
  const overlay = overlayWith(1_000);
  const build = overlay._createSpawnTableBuild(transparency, transparency.length, null, null, 0, true);
  while (!overlay._advanceSpawnTableBuild(build, null));
  assert.equal(build.visited, 1_000, 'a refill visits as many cells as the table holds when all are visible');
  transparency[99_999] = 7;
  assert.throws(() => overlay._buildSpawnTable(transparency, transparency.length, null), /must be finite and between 0 and 1/);
});
