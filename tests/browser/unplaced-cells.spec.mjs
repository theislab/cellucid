import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

/**
 * A 3D embedding that does not place 30% of 1M cells (NaN positions in
 * every axis, `rendering/unplaced-positions.js`). The view draws exactly what
 * it draws with those cells hidden, picking never finds one, a tree holds
 * only the placed cells, levels of detail and culling draw, and no WebGL
 * error is raised: NaN never reaches the GPU.
 *
 * The two frames compared draw every placed cell in the same order. A store
 * takes the draw order of any tree built for its positions, a cell lookup's
 * too (`prepareCellPicking`, which the cell info card asks for when the
 * browser is idle), and translucent fogged points overlap in that order. A
 * tree of the reference holds the hidden cells at the anchor and one of the
 * unplaced positions leaves them out, so their orders differ; source order is
 * the only one both frames share. The card is off, and each frame records
 * the order it was drawn in. With the card on, the reference can be drawn in a
 * lookup tree's order, the card's idle request having run after the positions
 * changed, and the second frame in source order (the frames then differ in
 * tens of thousands of pixels).
 */

const POINT_COUNT = 1_000_000;

async function open(page) {
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  // No lookup tree, so no tree's draw order, for the frames compared.
  await page.locator('#cell-info-toggle').uncheck();
  await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern: 'atlas' });
}

async function settled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => page.evaluate(() => {
    const viewer = window._cellucidViewer;
    return viewer.getFrameScheduleState().settled && viewer.isPresentedGeometrySettled();
  }), { timeout: 120_000 }).toBe(true);
}

function frame(page) {
  return page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    window.__frames ??= [];
    window.__frames.push(pixels);
    // What the frame was drawn from, so a difference names the input that differed.
    const viewer = window._cellucidViewer;
    const stats = viewer.getRendererStats('live');
    window.__frameInputs ??= [];
    window.__frameInputs.push({
      camera: JSON.stringify(viewer.getCameraState()),
      lodLevel: stats.lodLevel,
      visiblePoints: stats.visiblePoints,
      drawOrder: viewer.debugRendererStatus().drawOrder,
      renderer: gl.getParameter(gl.RENDERER),
    });
    let lit = 0;
    for (let at = 3; at < pixels.length; at += 4) if (pixels[at] !== 0) lit++;
    return { lit, error: gl.getError() };
  });
}

/**
 * Where the last two frames differ, and what each was drawn from (camera,
 * level of detail, cells drawn, draw order, GL renderer), attached to the
 * report with both frames and their difference as images.
 */
async function attachFrameDifference(page) {
  const evidence = await page.evaluate(() => {
    const [a, b] = window.__frames.slice(-2);
    const [inputsA, inputsB] = window.__frameInputs.slice(-2);
    const gl = window._cellucidViewer.getGLContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const diff = new Uint8ClampedArray(a.length);
    let pixels = 0;
    let maxDelta = 0;
    const box = [width, height, -1, -1];
    for (let at = 0; at < a.length; at += 4) {
      const delta = Math.max(
        Math.abs(a[at] - b[at]), Math.abs(a[at + 1] - b[at + 1]),
        Math.abs(a[at + 2] - b[at + 2]), Math.abs(a[at + 3] - b[at + 3]),
      );
      diff[at + 3] = 255;
      if (delta === 0) continue;
      diff[at] = 255;
      pixels++;
      maxDelta = Math.max(maxDelta, delta);
      const x = (at / 4) % width;
      const y = height - 1 - Math.floor(at / 4 / width);
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
    // readPixels rows run bottom up; an image's top down.
    const png = rgba => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const image = new ImageData(width, height);
      for (let row = 0; row < height; row++) {
        image.data.set(rgba.subarray((height - 1 - row) * width * 4, (height - row) * width * 4), row * width * 4);
      }
      canvas.getContext('2d').putImageData(image, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    };
    return {
      summary: { pixels, maxDelta, box, reference: inputsA, drawn: inputsB },
      images: { reference: png(a), drawn: png(b), difference: png(diff) },
    };
  });
  const info = test.info();
  await info.attach('frame-difference.json', { body: JSON.stringify(evidence.summary, null, 2), contentType: 'application/json' });
  for (const [name, base64] of Object.entries(evidence.images)) {
    await info.attach(`${name}.png`, { body: Buffer.from(base64, 'base64'), contentType: 'image/png' });
  }
}

test('a 3D embedding that does not place 30% of 1M cells draws, picks and builds its tree over the placed cells only', async ({ page }) => {
  test.setTimeout(600_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await open(page);
  await page.evaluate(() => {
    // 30% of the cells, spread over the cloud.
    const unplacedOf = cell => (Math.imul(cell, 2654435761) >>> 0) % 10 < 3;
    const viewer = window._cellucidViewer;
    viewer.setAntialiasing(false);
    viewer.setAdaptiveLOD(false);
    viewer.setFrustumCulling(false);
    const from = viewer.getPositions();
    const fromDimension = viewer.getViewDimension('live');
    const n = from.length / fromDimension;
    const placed = new Float32Array(n * 3);
    for (let cell = 0; cell < n; cell++) {
      for (let axis = 0; axis < 3; axis++) placed[cell * 3 + axis] = from[cell * fromDimension + axis] ?? 0;
    }
    const unplaced = placed.slice();
    let count = 0;
    for (let cell = 0; cell < n; cell++) {
      if (unplacedOf(cell)) {
        unplaced.fill(NaN, cell * 3, cell * 3 + 3);
        count++;
      }
    }
    window.__unplaced = { placed, unplaced, count, n, unplacedOf };
    // The reference: the unplaced cells hidden, at a placed cell's position
    // (so the bounds, which the fog and the camera read, are the placed
    // cells' in both frames).
    let anchor = 0;
    while (unplacedOf(anchor)) anchor++;
    const reference = placed.slice();
    const hidden = new Uint8Array(n);
    for (let cell = 0; cell < n; cell++) {
      hidden[cell] = unplacedOf(cell) ? 0 : 1;
      if (unplacedOf(cell)) reference.copyWithin(cell * 3, anchor * 3, anchor * 3 + 3);
    }
    viewer.updatePositions(reference, 3);
    viewer.updateTransparency(hidden);
  });
  await settled(page);
  const reference = await frame(page);

  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const { unplaced, n } = window.__unplaced;
    viewer.updateTransparency(new Uint8Array(n).fill(1));
    viewer.updatePositions(unplaced, 3);
  });
  await settled(page);
  const drawn = await frame(page);
  expect(reference.error).toBe(0);
  expect(drawn.error).toBe(0);
  expect(drawn.lit).toBeGreaterThan(10_000);
  // Every input of the two frames is equal before any pixel is compared.
  const inputs = await page.evaluate(() => window.__frameInputs.slice(-2));
  expect(inputs[0].drawOrder, 'the reference is drawn in source order').toBe('source');
  expect(inputs[1], 'camera, level, cells drawn, draw order').toEqual(inputs[0]);
  const differing = await page.evaluate(() => {
    const [a, b] = window.__frames.slice(-2);
    let count = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
    return count;
  });
  if (differing > 0) await attachFrameDifference(page);
  expect(differing, 'the unplaced cells are drawn as if hidden').toBe(0);

  // A lookup tree's order is the view's to adopt: the view is not settled
  // while the tree is built, and is settled in its order once adopted.
  const building = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    viewer.prepareCellPicking();
    return viewer.isPresentedGeometrySettled();
  });
  expect(building, 'settled while a lookup tree is built').toBe(false);
  await settled(page);
  const adopted = await page.evaluate(() => window._cellucidViewer.debugRendererStatus());
  expect(adopted.drawOrderComplete, adopted.drawOrder).toBe(true);

  // Picking over the whole view never finds an unplaced cell.
  const picks = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const { unplacedOf } = window.__unplaced;
    const canvas = document.getElementById('glcanvas').getBoundingClientRect();
    let found = 0;
    let unplacedFound = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const record = viewer.pickCellRecordAtScreen(
          canvas.left + ((x + 0.5) / 24) * canvas.width,
          canvas.top + ((y + 0.5) / 24) * canvas.height,
        );
        if (record === null || record.cellIndex < 0) continue;
        found++;
        if (unplacedOf(record.cellIndex)) unplacedFound++;
      }
    }
    return { found, unplacedFound };
  });
  expect(picks.found).toBeGreaterThan(20);
  expect(picks.unplacedFound).toBe(0);

  // Levels of detail and culling: the tree holds the placed cells only.
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    viewer.setAdaptiveLOD(true);
    viewer.setFrustumCulling(true);
    viewer.setForceLOD(-1);
  });
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.isPresentedGeometrySettled()), { timeout: 120_000 }).toBe(true);
  for (const level of [0, 10, -1]) {
    await page.evaluate(level => window._cellucidViewer.setForceLOD(level), level);
    await settled(page);
    const state = await frame(page);
    expect(state.error, `level ${level}`).toBe(0);
    expect(state.lit, `level ${level}`).toBeGreaterThan(1_000);
  }
  const tree = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const status = viewer.debugRendererStatus();
    return { hasSpatialIndex: status.hasSpatialIndex, pointCount: status.spatialIndexPointCount };
  });
  expect(tree.hasSpatialIndex).toBe(true);
  expect(tree.pointCount).toBe(POINT_COUNT);
  expect(pageErrors).toEqual([]);
});
