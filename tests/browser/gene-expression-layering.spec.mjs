import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

/**
 * UX-8: a gene's cells that do not express it are the neutral no-value grey
 * (`writeContinuousColors`, alpha byte BENEATH_ALPHA_BYTE), and they are
 * drawn beneath the expressing cells (`HighPerfRenderer`, two passes over the
 * same points): in 2D by blending order, in 3D at every depth tie. Held
 * against a reference that draws the expressing cells alone: every pixel a
 * red expressing cell paints there it also paints with the grey cells drawn,
 * at full detail and at every forced level of detail, culled or not.
 */

const POINT_COUNT = 1_000_000;
/** Every this-many cells express the gene (a sparse gene). */
const EXPRESSING_EVERY = 97;

async function open(page) {
  await page.goto(`/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern: 'atlas' });
}

/**
 * Publish the layout and the sparse gene's colours. 2D: the view is made a 2D
 * view (`setViewEmbedding`), drawn without depth. 3D: a flat sheet facing the
 * camera (the orbit looks down -z), so every overlap is a depth tie; on a
 * sheet seen at an angle, an overlap is a real difference in depth, which the
 * nearer cell wins whatever its colour.
 */
function publish(page, dimension) {
  return page.evaluate(({ dimension, every }) => {
    const viewer = window._cellucidViewer;
    viewer.setAntialiasing(false);
    const source = viewer.getPositions();
    const sourceDimension = viewer.getViewDimension('live');
    const n = source.length / sourceDimension;
    const positions = new Float32Array(n * dimension);
    for (let cell = 0; cell < n; cell++) {
      positions[cell * dimension] = source[cell * sourceDimension];
      positions[cell * dimension + 1] = source[cell * sourceDimension + 1];
      // 3D: a flat sheet, so every overlap is a depth tie.
      if (dimension === 3) positions[cell * dimension + 2] = 0;
    }
    viewer.updatePositions(positions, dimension);
    viewer.setViewEmbedding('live', { dimension, layoutKey: `layering-${dimension}d` });
    if (dimension === 3) {
      const camera = viewer.getViewCameraState('live');
      viewer.setViewCameraState('live', {
        ...camera,
        navigationMode: 'orbit',
        orbit: { ...camera.orbit, theta: Math.PI / 2, phi: Math.PI / 2 },
      });
    }
    const colors = new Uint8Array(n * 4);
    for (let cell = 0; cell < n; cell++) {
      const expressing = cell % every === 0;
      colors.set(expressing ? [230, 20, 20, 255] : [200, 200, 200, 254], cell * 4);
    }
    window.__layering = { colors, n, every };
    viewer.updateColors(colors);
  }, { dimension, every: EXPRESSING_EVERY });
}

async function settled(page) {
  // A frame drawn after the change, then nothing left to draw.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => page.evaluate(() => {
    const viewer = window._cellucidViewer;
    return viewer.getFrameScheduleState().settled && viewer.isPresentedGeometrySettled();
  }), { timeout: 120_000 }).toBe(true);
}

/** Pixels where a red expressing cell shows. */
function redPixels(page) {
  return page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const red = [];
    for (let at = 0; at < pixels.length; at += 4) {
      if (pixels[at] > 150 && pixels[at + 1] < 90 && pixels[at + 2] < 90) red.push(at >> 2);
    }
    return red;
  });
}

/** Show every cell, or the expressing cells alone (the reference). */
function showOnlyExpressing(page, only) {
  return page.evaluate(only => {
    const { n, every } = window.__layering;
    const visible = new Uint8Array(n);
    for (let cell = 0; cell < n; cell++) visible[cell] = !only || cell % every === 0 ? 1 : 0;
    window._cellucidViewer.updateTransparency(visible);
  }, only);
}

for (const dimension of [2, 3]) {
  test(`${dimension}D: a sparse gene's expressing cells are drawn above its grey cells, at every level of detail`, async ({ page }) => {
    test.setTimeout(600_000);
    await open(page);
    await publish(page, dimension);
    await settled(page);
    // The camera the new layout settled on, pinned for every capture (a
    // camera that still moved between two captures would shift the cells).
    const camera = await page.evaluate(() => JSON.stringify(window._cellucidViewer.getViewCameraState('live')));
    const cameraNow = () => page.evaluate(() => JSON.stringify(window._cellucidViewer.getViewCameraState('live')));
    const levels = await page.evaluate(() => window._cellucidViewer.getLODLevelCount());
    const states = [
      { lod: false, culling: false, level: -1 },
      { lod: true, culling: true, level: 0 },
      { lod: true, culling: false, level: Math.floor(levels / 2) },
      { lod: true, culling: true, level: levels - 1 },
    ];
    for (const state of states) {
      await page.evaluate(({ lod, culling, level }) => {
        const viewer = window._cellucidViewer;
        viewer.setAdaptiveLOD(lod);
        viewer.setFrustumCulling(culling);
        if (lod) viewer.setForceLOD(level);
      }, state);
      await page.evaluate(camera => window._cellucidViewer.setViewCameraState('live', JSON.parse(camera)), camera);
      await showOnlyExpressing(page, true);
      await settled(page);
      const referenceCamera = await cameraNow();
      const reference = await redPixels(page);
      await showOnlyExpressing(page, false);
      await settled(page);
      const label = `${dimension}D, ${JSON.stringify(state)}`;
      expect(await cameraNow(), `${label}: the camera moved between the captures`).toBe(referenceCamera);
      const layered = new Set(await redPixels(page));
      const covered = reference.filter(pixel => !layered.has(pixel)).length;
      // Not vacuous: full detail shows every expressing cell (about 10,000);
      // the coarsest level about 10 of its 1,000 cells, drawn larger.
      expect(reference.length, label).toBeGreaterThan(state.level === -1 ? 500 : 20);
      expect(covered, `${label}: ${covered} of ${reference.length} red pixels covered by grey`).toBe(0);
    }
  });
}
