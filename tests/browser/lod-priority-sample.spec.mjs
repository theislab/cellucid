/**
 * Levels of detail draw a uniform random sample of the cells.
 *
 * Every reduced level admits cells in their priority order
 * (`data/cell-priority.js`), so the cells a level draws are exactly the first
 * cells of that order, and they cover the cloud and its colours in the
 * proportions all cells do, within sampling error. At full detail the level
 * draws every cell, in the same stored order as with LOD off, so the two
 * frames are the same picture.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { pixelParityVerdict } from './helpers/pixel-parity.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=lod-priority-sample-ci';
const POINT_COUNT = 200_000;
const LEVELS = [0, 4, 9, 14];

test('every reduced level is the priority prefix and draws the population; full detail is the LOD-off frame', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern: 'atlas' });

  const result = await page.evaluate(async ({ pointCount, levels }) => {
    const { buildPriorityOrder } = await import('/assets/js/data/cell-priority.js');
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const renderer = viewer.getHPRenderer();
    const gl = viewer.getGLContext();
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    const settled = async () => {
      for (let attempt = 0; attempt < 900; attempt += 1) {
        if (viewer.getFrameScheduleState().settled) return;
        await frames(1);
      }
      throw new Error(`Scene never settled: ${JSON.stringify(viewer.getFrameScheduleState())}`);
    };
    const capture = async () => {
      await frames(4);
      await settled();
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    viewer.setFrustumCulling(false);
    viewer.setAdaptiveLOD(true);
    const dimension = state.positionsDimension;
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const index = renderer.spatialIndices.get(dimension);
      if (index && index.lodLevels.length > 0) break;
      await frames(1);
    }
    const index = renderer.spatialIndices.get(dimension);
    if (!index || index.lodLevels.length === 0) throw new Error('No LOD levels were built.');

    // What each level should hold, and what the whole cloud holds: an 8 x 8
    // grid over the first two axes, and six colour buckets.
    const positions = state.positionsArray;
    const colors = state.colorsArray;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let cell = 0; cell < pointCount; cell++) {
      const x = positions[cell * dimension];
      const y = positions[cell * dimension + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const boxOf = cell => {
      const bx = Math.min(7, Math.floor(((positions[cell * dimension] - minX) / (maxX - minX || 1)) * 8));
      const by = Math.min(7, Math.floor(((positions[cell * dimension + 1] - minY) / (maxY - minY || 1)) * 8));
      return by * 8 + bx;
    };
    const bucketOf = cell => {
      const r = colors[cell * 4]; const g = colors[cell * 4 + 1]; const b = colors[cell * 4 + 2];
      return (r >= g ? 1 : 0) + (g >= b ? 2 : 0) + (b >= r ? 4 : 0) - 1;
    };
    const shares = (cells, keyOf, keys) => {
      const counts = new Float64Array(keys);
      for (const cell of cells) counts[keyOf(cell)]++;
      return Array.from(counts, count => count / cells.length);
    };
    const all = Uint32Array.from({ length: pointCount }, (_, cell) => cell);
    const truth = { box: shares(all, boxOf, 64), colour: shares(all, bucketOf, 7) };
    const order = buildPriorityOrder(pointCount, renderer.getCellPriority());
    const report = [];
    for (const level of levels) {
      viewer.setForceLOD(level);
      await frames(3);
      const drawn = renderer.getCurrentLodIndices('live', dimension);
      const sorted = Array.from(drawn).sort((a, b) => a - b);
      const expected = Array.from(order.subarray(0, drawn.length)).sort((a, b) => a - b);
      const prefix = sorted.length === expected.length && sorted.every((cell, i) => cell === expected[i]);
      const m = drawn.length;
      // The largest share difference, in standard errors of a uniform sample
      // of m of the cells (finite population).
      let worst = 0;
      for (const [kind, keyOf, keys] of [['box', boxOf, 64], ['colour', bucketOf, 7]]) {
        const got = shares(drawn, keyOf, keys);
        got.forEach((share, key) => {
          const p = truth[kind][key];
          const se = Math.sqrt((p * (1 - p) / m) * ((pointCount - m) / (pointCount - 1)));
          if (se > 0) worst = Math.max(worst, Math.abs(share - p) / se);
        });
      }
      report.push({ level, m, prefix, worst, visible: renderer.getStats('live').visiblePoints });
    }
    // Full detail: forced to the last level, then LOD off. Same stored
    // order, every cell: the same picture.
    viewer.setForceLOD(index.lodLevels.length - 1);
    const fullDetail = await capture();
    viewer.setForceLOD(-1);
    viewer.setAdaptiveLOD(false);
    const lodOff = await capture();
    let lit = 0; let mismatched = 0; let maxDelta = 0;
    for (let i = 0; i < fullDetail.length; i += 4) {
      if (lodOff[i + 3] !== 0) lit += 1;
      let delta = 0;
      for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(fullDetail[i + c] - lodOff[i + c]));
      if (delta !== 0) { mismatched += 1; maxDelta = Math.max(maxDelta, delta); }
    }
    return { report, parity: { lit, mismatched, maxDelta, first: [] }, levelCount: index.lodLevels.length };
  }, { pointCount: POINT_COUNT, levels: LEVELS });

  expect(result.levelCount).toBeGreaterThan(LEVELS.at(-1));
  for (const row of result.report) {
    expect(row.prefix, `level ${row.level} draws the priority prefix`).toBe(true);
    expect(row.visible, `level ${row.level} draws its cells`).toBe(row.m);
    // Five standard errors over 71 shares: a uniform sample passes with
    // probability above 0.9999; a level biased by where or what a cell is
    // does not.
    expect(row.worst, `level ${row.level} (${row.m} cells) draws the population`).toBeLessThan(5);
  }
  expect(result.parity.lit).toBeGreaterThan(1_000);
  expect(pixelParityVerdict(result.parity, 'full detail vs LOD off')).toBeNull();
});
