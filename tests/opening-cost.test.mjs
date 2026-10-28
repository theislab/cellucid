/**
 * What showing a cell costs this page (`data/opening-cost.js`): an
 * opening's cells from their being in the page to their first frame,
 * recorded only when that frame drew them and while the opening is still
 * the one shown; the measure is the time a cell adds (the slope of the
 * records, apart from what any opening costs), older records fading; kept
 * under a key of its own meaning (`v2`), an earlier meaning's never read.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENING_COST_STORAGE_KEY,
  progressiveRequest,
  recordFirstFrame,
  recordShownCells,
  resetShownCells,
  shownMsPerCell,
} from '../assets/js/data/opening-cost.js';

/** Frames run by hand: `afterNextFrame` queues, `drawFrame` runs the queue. */
function frames() {
  let queue = [];
  return {
    afterNextFrame(run) {
      const entry = { run, cancelled: false };
      queue.push(entry);
      return () => { entry.cancelled = true; };
    },
    drawFrame() {
      const due = queue;
      queue = [];
      for (const entry of due) if (!entry.cancelled) entry.run();
    },
    get queued() {
      return queue.filter(entry => !entry.cancelled).length;
    },
  };
}

test('an opening is recorded from its cells in the page to their first frame', async () => {
  resetShownCells();
  const frame = frames();
  const startedAt = performance.now() - 200;
  const recorded = recordFirstFrame({ cells: 100_000, startedAt, afterNextFrame: frame.afterNextFrame, drawn: () => true });
  assert.equal(shownMsPerCell(), null, 'nothing before the frame');
  frame.drawFrame();
  const ms = await recorded;
  assert.ok(ms >= 200, `the time since the cells were in the page (${ms} ms)`);
  assert.equal(shownMsPerCell(), ms / 100_000);
  assert.deepEqual(progressiveRequest(), { targetMs: 1000, msPerCell: ms / 100_000 });
  resetShownCells();
});

test('a first frame that drew none of the cells records nothing', async () => {
  resetShownCells();
  const frame = frames();
  const recorded = recordFirstFrame({ cells: 1000, startedAt: performance.now(), afterNextFrame: frame.afterNextFrame, drawn: () => false });
  frame.drawFrame();
  assert.equal(await recorded, null);
  assert.equal(shownMsPerCell(), null);
  assert.equal(frame.queued, 0, 'it waits for no later frame');
});

test('cells replaced before their first frame record nothing', async () => {
  resetShownCells();
  const frame = frames();
  const publication = new AbortController();
  const recorded = recordFirstFrame({ cells: 1000, startedAt: performance.now(), afterNextFrame: frame.afterNextFrame, drawn: () => true, signal: publication.signal });
  publication.abort();
  assert.equal(await recorded, null);
  assert.equal(frame.queued, 0, 'the frame callback is cancelled');
  frame.drawFrame();
  assert.equal(shownMsPerCell(), null);
  // Already replaced: nothing is queued at all.
  assert.equal(await recordFirstFrame({ cells: 1000, startedAt: performance.now(), afterNextFrame: frame.afterNextFrame, drawn: () => true, signal: publication.signal }), null);
  assert.equal(frame.queued, 0);
});

test('no cells, or no start, record nothing', async () => {
  resetShownCells();
  const frame = frames();
  assert.equal(await recordFirstFrame({ cells: 0, startedAt: performance.now(), afterNextFrame: frame.afterNextFrame, drawn: () => true }), null);
  assert.equal(await recordFirstFrame({ cells: 10, startedAt: Number.NaN, afterNextFrame: frame.afterNextFrame, drawn: () => true }), null);
  assert.equal(frame.queued, 0);
  assert.equal(shownMsPerCell(), null);
});

test('the measure is what a cell adds, apart from what any opening costs', () => {
  resetShownCells();
  // Measured in Chromium: about 25 ms whatever the cells, and 9 ns a cell.
  for (const [cells, ms] of [[10_000, 27.4], [100_000, 23.1], [1_000_000, 30.9], [5_000_000, 69.8]]) recordShownCells(cells, ms);
  const slope = shownMsPerCell();
  assert.ok(slope > 7e-6 && slope < 1e-5, `about 9 ns a cell (${slope * 1e6} ns)`);
  // Not their ratio, which the small openings make hundreds of times larger.
  assert.ok(slope < (27.4 + 23.1 + 30.9 + 69.8) / (10_000 + 100_000 + 1_000_000 + 5_000_000));
  // A small opening first, then a large one: the second sizes the measure.
  resetShownCells();
  recordShownCells(10_000, 27.4);
  assert.equal(shownMsPerCell(), 27.4 / 10_000, 'one size: through the origin');
  recordShownCells(5_000_000, 69.8);
  assert.ok(shownMsPerCell() < 1e-5);
  resetShownCells();
});

test('records too close in size to tell the slope from noise go through the origin', () => {
  resetShownCells();
  // Their line costs an opening less than nothing (-70 ms): through the origin.
  recordShownCells(1_000_000, 30);
  recordShownCells(1_100_000, 40);
  const throughOrigin = (1_000_000 * 30 / 2 + 1_100_000 * 40) / (1_000_000 ** 2 / 2 + 1_100_000 ** 2);
  assert.ok(Math.abs(shownMsPerCell() - throughOrigin) < 1e-15);
  // Their line falls with more cells: a cell adds nothing measurable.
  resetShownCells();
  recordShownCells(1_000_000, 40);
  recordShownCells(1_100_000, 30);
  assert.equal(shownMsPerCell(), 0);
  resetShownCells();
});

test('the measure of a shown cell fades an odd record', () => {
  resetShownCells();
  recordShownCells(100_000, 100);
  assert.equal(shownMsPerCell(), 0.001);
  // A slow moment: ten times the cost once.
  recordShownCells(100_000, 1000);
  assert.ok(shownMsPerCell() > 0.005);
  for (let i = 0; i < 12; i++) recordShownCells(100_000, 100);
  assert.ok(Math.abs(shownMsPerCell() - 0.001) < 0.001 * 0.01, 'back within 1 % of the usual cost');
  // An opening of few cells (what any opening costs) counts for little.
  recordShownCells(10, 5);
  assert.ok(shownMsPerCell() < 0.0011);
  resetShownCells();
});

test('the measure is kept under the key of its meaning; an earlier meaning is not read', async () => {
  assert.equal(OPENING_COST_STORAGE_KEY, 'cellucid:opening-cost:v2');
  const stored = new Map([['cellucid:opening-cost:v1', JSON.stringify({ ms: 5000, cells: 1 })]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
    },
  });
  try {
    // A page's first read of the measure (a module instance of its own).
    const fresh = await import(`../assets/js/data/opening-cost.js?page=${Date.now()}`);
    assert.equal(fresh.shownMsPerCell(), null, 'a v1 record (resize commits) is another quantity');
    fresh.recordShownCells(1000, 2);
    assert.deepEqual(JSON.parse(stored.get(OPENING_COST_STORAGE_KEY)), { w: 1, x: 1000, y: 2, xx: 1e6, xy: 2000 });
    const next = await import(`../assets/js/data/opening-cost.js?page=${Date.now() + 1}`);
    assert.equal(next.shownMsPerCell(), 0.002, 'read back on the next visit');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', previous);
  }
});
