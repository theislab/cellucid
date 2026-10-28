/**
 * A point store split into many segments draws exactly the pixels of one
 * store, and holds exactly its bytes.
 *
 * Per-point vertex stores are lists of segments, one buffer each
 * (`rendering/high-perf/point-store-segments.js`), so no single WebGL
 * buffer limits the cell count; a draw issues one call a segment in slot
 * order and a gather into the draw order runs one chunk at a time. Both are
 * the same points in the same order, so with segments forced small
 * (`HighPerfRenderer#setStoreSegmentPoints`, 4,096 points: 15 segments for
 * 60,000 cells) every frame must be byte-identical to the one-segment frame:
 * full detail, frustum-culled ranges split at segment boundaries, a reduced
 * level of detail, highlights drawn from the store, and a kept view of the
 * same geometry beside the live one, in 3D and in 2D. The same dataset is
 * published twice (the generator is seeded); the camera is copied after the
 * scene settled and checked equal to the digit before any pixel is compared.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=segmented-point-stores-ci';
const POINT_COUNT = 60_000;
const SEGMENT_POINTS = 4_096;
const REDUCED_LEVEL = 6;

/**
 * Configure the scene, wait until it settled with the stores in their
 * tree's order, and capture every configuration: pixels, cameras, store
 * bytes and segment counts.
 */
function captureScene(page, { pointCount, level, camera }) {
  return page.evaluate(async ({ pointCount, level, camera }) => {
    const viewer = window._cellucidViewer;
    const renderer = viewer.getHPRenderer();
    const gl = viewer.getGLContext();
    const frames = count => new Promise(resolve => {
      const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    // Settled: nothing but the highlight pulse (pinned to one phase, so
    // every pulse frame is the same picture) still asks for frames.
    const settled = async () => {
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const state = viewer.getFrameScheduleState();
        if (state.settled || (state.animationCause === 'highlight' && !state.invalidated)) return;
        await frames(1);
      }
      throw new Error(`Scene never settled: ${JSON.stringify(viewer.getFrameScheduleState())}`);
    };
    if (camera !== null) viewer.setCameraState(camera);
    viewer.setAntialiasing(false);
    viewer.setPointSize(6);
    viewer.setPulseLayerCaching(false);
    viewer.setHighlightAnimationTime(3.25);
    // Hidden and shown cells scattered through every segment: a slot read
    // through the wrong segment's base shows or hides the wrong cell.
    const alpha = new Uint8Array(pointCount);
    for (let index = 0; index < pointCount; index++) {
      alpha[index] = (((index * 2654435761) >>> 0) % 1000) < 700 ? 1 : 0;
    }
    viewer.updateTransparency(alpha);
    const highlighted = [];
    for (let index = 0; index < pointCount; index += 3) highlighted.push(index);
    window._cellucidState.addHighlightDirect({ type: 'annotation', label: 'segments', cellIndices: Uint32Array.from(highlighted) });
    viewer.setAdaptiveLOD(true);
    viewer.setFrustumCulling(false);
    viewer.setForceLOD(-1);
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const tree = renderer.spatialIndices.get(renderer.currentDimensionLevel);
      if (tree?.lodLevels?.length > 0 && renderer._liveOrder?.drawOrder === tree.drawOrder) break;
      await frames(1);
    }
    await settled();
    const read = () => {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { width, height, pixels };
    };
    const captures = {};
    for (const [name, cull, forced] of [
      ['full detail', false, -1],
      ['full detail, culled', true, -1],
      ['reduced level', false, level],
      ['reduced level, culled', true, level],
    ]) {
      viewer.setFrustumCulling(cull);
      viewer.setForceLOD(forced);
      viewer.setPointSize(cull ? 6.01 : 6);
      viewer.setPointSize(6);
      await frames(4);
      await settled();
      captures[name] = {
        ...read(),
        drawn: renderer.getStats('live').visiblePoints,
        lodLevel: renderer.getStats('live').lodLevel,
      };
    }
    // Every segment of a segmented store (point-store-segments.js), read
    // with the GL calls themselves: the renderer facade hands out its stores
    // read-only, so none of their methods is called through it.
    const readStore = (store, out) => {
      const segments = store.segments;
      const elements = store.bytesPerPoint / out.BYTES_PER_ELEMENT;
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out, segment.first * elements, segment.count * elements);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return out;
    };
    const positions = renderer.buffers.positions;
    const words = readStore(positions, new Uint32Array(positions.pointCount * positions.bytesPerPoint / 4));
    const colors = readStore(renderer.buffers.colors, new Uint32Array(renderer.buffers.colors.pointCount));
    const views = viewer.getSnapshotViews().map(view => view.id);
    const scene = {
      captures,
      cameras: ['live', ...views].map(id => viewer.getViewCameraState(id)),
      storeWords: words,
      colorWords: colors,
      positionSegments: positions.segments.length,
      colorSegments: renderer.buffers.colors.segments.length,
      highlightStoreViews: viewer.getHighlightStoreDrawnViewCount(),
    };
    // The first scene stays in the page; the second is compared with it
    // there (megabytes of pixels never cross to the test).
    const first = window.__segmentedStoreScene ?? null;
    if (first === null) {
      window.__segmentedStoreScene = scene;
      return { positionSegments: scene.positionSegments };
    }
    const firstDifference = (left, right) => {
      if (left.length !== right.length) return `length ${left.length} vs ${right.length}`;
      for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return index;
      return -1;
    };
    const compared = {};
    for (const [name, frame] of Object.entries(first.captures)) {
      const other = scene.captures[name];
      let lit = 0;
      const differing = [];
      for (let index = 0; index < frame.pixels.length; index += 4) {
        if (frame.pixels[index + 3] !== 0) lit += 1;
        for (let channel = 0; channel < 4; channel++) {
          if (frame.pixels[index + channel] !== other.pixels[index + channel]) {
            if (differing.length < 8) {
              const pixel = index / 4;
              differing.push([pixel % frame.width, Math.floor(pixel / frame.width),
                Array.from(frame.pixels.subarray(index, index + 4)), Array.from(other.pixels.subarray(index, index + 4))]);
            }
            break;
          }
        }
      }
      compared[name] = {
        inputs: [[frame.width, frame.height, frame.drawn, frame.lodLevel], [other.width, other.height, other.drawn, other.lodLevel]],
        lit,
        differing,
      };
    }
    return {
      positionSegments: scene.positionSegments,
      colorSegments: scene.colorSegments,
      cameras: [first.cameras, scene.cameras],
      highlightStoreViews: [first.highlightStoreViews, scene.highlightStoreViews],
      storeWordDifference: firstDifference(first.storeWords, scene.storeWords),
      colorWordDifference: firstDifference(first.colorWords, scene.colorWords),
      frames: compared,
    };
  }, { pointCount, level, camera });
}

for (const pattern of ['atlas', 'flatumap']) {
  test(`${pattern}: segmented stores draw and hold exactly what one store does`, async ({ page }) => {
    test.setTimeout(600_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await openCollapsedPanels(page);

    // One segment: the default for this size.
    await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern });
    const camera = await page.evaluate(async () => {
      const viewer = window._cellucidViewer;
      for (let attempt = 0; attempt < 900 && !viewer.getFrameScheduleState().settled; attempt += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return viewer.getCameraState();
    });
    await page.locator('#split-keep-view-btn').click();
    await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(1);
    const whole = await captureScene(page, { pointCount: POINT_COUNT, level: REDUCED_LEVEL, camera: null });
    expect(whole.positionSegments).toBe(1);

    // The same dataset again, its stores in segments of 4,096 points.
    await page.evaluate(points => window._cellucidViewer.getHPRenderer().setStoreSegmentPoints(points), SEGMENT_POINTS);
    // The Benchmark panel is open already; the same count and pattern again,
    // published once its stores are the segmented ones.
    await page.locator('#benchmark-count').fill(String(POINT_COUNT));
    await page.locator('#benchmark-pattern').selectOption(pattern);
    await page.locator('#benchmark-run').click();
    await expect
      .poll(() => page.evaluate(() => window._cellucidViewer.getHPRenderer().buffers.positions?.segments?.length ?? 0), { timeout: 120_000 })
      .toBe(Math.ceil(POINT_COUNT / SEGMENT_POINTS));
    // The replacement retires the view kept of the first publication.
    await expect
      .poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length), { timeout: 120_000 })
      .toBe(0);
    await page.locator('#split-keep-view-btn').click();
    // A refused keep is a notification: the expectation names it.
    await expect.poll(() => page.evaluate(() => (window._cellucidViewer.getSnapshotViews().length === 1
      ? 1
      : (document.body.innerText.match(/[^\n]*failed[^\n]*/gi) ?? []).join(' | ') || 0))).toBe(1);
    const split = await captureScene(page, { pointCount: POINT_COUNT, level: REDUCED_LEVEL, camera });
    expect(split.positionSegments).toBe(Math.ceil(POINT_COUNT / SEGMENT_POINTS));
    expect(split.colorSegments).toBe(split.positionSegments);

    // Every input the frames depend on is equal first.
    expect(split.cameras[1]).toEqual(split.cameras[0]);
    expect(split.highlightStoreViews[1]).toBe(split.highlightStoreViews[0]);
    expect(split.storeWordDifference, 'first position word that differs').toBe(-1);
    expect(split.colorWordDifference, 'first colour word that differs').toBe(-1);
    for (const [name, frame] of Object.entries(split.frames)) {
      expect(frame.inputs[1], `${name}: size, points drawn, level`).toEqual(frame.inputs[0]);
      expect(frame.lit, `${name}: lit pixels`).toBeGreaterThan(1_000);
      expect(frame.differing, `${name}: pixels that differ (x, y, one segment, segmented)`).toEqual([]);
    }
    expect(pageErrors).toEqual([]);
  });
}
