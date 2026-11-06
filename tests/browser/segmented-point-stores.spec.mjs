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
 * level of detail that spans more than one segment, highlights drawn from the
 * store, and a kept view of the same geometry beside the live one, in 3D and
 * in 2D. The same dataset is published twice (the generator is seeded); the
 * camera is copied after the scene settled and checked equal to the digit
 * before any pixel is compared.
 *
 * Every frame read is a steady frame of the highlight's pulse, and what both
 * sides submitted to the GPU in it is asserted equal before their pixels
 * (`helpers/gl-submissions.mjs`): a frame read four animation frames after a
 * change was, on a slow renderer, still the first frame after it on one side
 * and a later one on the other.
 */

import { expect, test } from './helpers/test.mjs';
import { recordSubmissions } from './helpers/gl-submissions.mjs';
import { isHostedMacosFirefox } from './helpers/hosted-gl.mjs';
import { ROUNDING_SHARE_ON_HOSTED_MACOS_FIREFOX } from './helpers/pixel-parity.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=segmented-point-stores-ci';
const FULL_POINT_COUNT = 60_000;
const SEGMENT_POINTS = 4_096;

/**
 * Configure the scene, wait until it draws steady frames with the stores in
 * their tree's order, and capture every configuration: pixels, what the
 * frame submitted, cameras, store bytes and segment counts.
 */
function captureScene(page, { pointCount, segmentPoints, camera }) {
  return page.evaluate(async ({ pointCount, segmentPoints, camera }) => {
    const viewer = window._cellucidViewer;
    const renderer = viewer.getHPRenderer();
    const gl = viewer.getGLContext();
    const submissions = window.__submissions;
    const nextFrame = () => new Promise(resolve => { requestAnimationFrame(resolve); });
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
    // The stores in their tree's order, whole (`StoreOrder#complete`): a tree
    // is built in a worker and its order adopted over frames, as long as the
    // machine takes (the test's timeout bounds it). This once compared a
    // `drawOrder` the store order does not have, for 900 animation frames a
    // scene, and went on whatever they showed: on a renderer that takes
    // seconds a frame those frames were the test's ten minutes (hosted macOS
    // and Windows Firefox, nightly runs 41382954122 to 42156397746).
    let tree = null;
    for (;;) {
      tree = renderer.spatialIndices.get(renderer.currentDimensionLevel) ?? null;
      if (tree?.lodLevels?.length > 0 && renderer._liveOrder?.complete === true) break;
      await nextFrame();
    }
    // The coarsest reduced level that spans more than one segment: its draw
    // crosses a segment boundary, as full detail does.
    const level = tree.lodLevels.findIndex(candidate => candidate.pointCount > segmentPoints && candidate.isFullDetail !== true);
    if (level < 0) throw new Error(`No reduced level of ${pointCount} points spans a segment of ${segmentPoints}.`);
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
      const before = submissions.frames;
      viewer.setFrustumCulling(cull);
      viewer.setForceLOD(forced);
      // A change of the point size and back: the frame is drawn again even
      // where culling and the level stayed as they were.
      viewer.setPointSize(6.01);
      viewer.setPointSize(6);
      await submissions.steadyPulseFrame(before);
      captures[name] = {
        ...read(),
        drawn: renderer.getStats('live').visiblePoints,
        lodLevel: renderer.getStats('live').lodLevel,
        submitted: submissions.last,
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
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const scene = {
      context: {
        renderer: String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL)),
        vendor: String(gl.getParameter(debug === null ? gl.VENDOR : debug.UNMASKED_VENDOR_WEBGL)),
        attributes: gl.getContextAttributes(),
        samples: gl.getParameter(gl.SAMPLES),
      },
      level,
      levelPoints: tree.lodLevels[level].pointCount,
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
      return { positionSegments: scene.positionSegments, level: scene.level, levelPoints: scene.levelPoints };
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
      let differingPixels = 0;
      const differing = [];
      for (let index = 0; index < frame.pixels.length; index += 4) {
        if (frame.pixels[index + 3] !== 0) lit += 1;
        for (let channel = 0; channel < 4; channel++) {
          if (frame.pixels[index + channel] !== other.pixels[index + channel]) {
            differingPixels += 1;
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
        differingPixels,
        // What the two frames submitted: the first difference, and how many draws each joined to.
        submittedDifference: submissions.difference(frame.submitted, other.submitted),
        draws: [submissions.joined(frame.submitted).length, submissions.joined(other.submitted).length],
        calls: [frame.submitted.length, other.submitted.length],
        // The draws of both frames in full, only where they are needed.
        submitted: differing.length > 0 ? [frame.submitted, other.submitted] : null,
      };
    }
    return {
      context: scene.context,
      positionSegments: scene.positionSegments,
      colorSegments: scene.colorSegments,
      levels: [[first.level, first.levelPoints], [scene.level, scene.levelPoints]],
      cameras: [first.cameras, scene.cameras],
      highlightStoreViews: [first.highlightStoreViews, scene.highlightStoreViews],
      storeWordDifference: firstDifference(first.storeWords, scene.storeWords),
      colorWordDifference: firstDifference(first.colorWords, scene.colorWords),
      frames: compared,
    };
  }, { pointCount, segmentPoints, camera });
}

for (const pattern of ['atlas', 'flatumap']) {
  test(`${pattern}: segmented stores draw and hold exactly what one store does`, async ({ page, browserName }) => {
    // A frame of 60,000 points takes seconds on hosted macOS Firefox
    // (`helpers/hosted-gl.mjs`), and the count is not the subject: there, as
    // many as make three segments, the same stores and draws of fewer points.
    // Full detail and the reduced level each cross a segment boundary at
    // either count.
    const POINT_COUNT = isHostedMacosFirefox(browserName) ? 12_000 : FULL_POINT_COUNT;
    test.setTimeout(600_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await openCollapsedPanels(page);

    // One segment: the default for this size.
    await loadSyntheticDataset(page, { pointCount: POINT_COUNT, pattern });
    // The camera once the publication's zoom has eased out: a camera copied
    // mid-ease is another camera a frame later. Frame by frame, as slow as
    // the renderer draws them.
    const camera = await page.evaluate(async () => {
      const viewer = window._cellucidViewer;
      while (!viewer.getFrameScheduleState().settled) await new Promise(resolve => { requestAnimationFrame(resolve); });
      return viewer.getCameraState();
    });
    await page.evaluate(recordSubmissions);
    const capturing = Date.now();
    await page.locator('#split-keep-view-btn').click();
    await expect.poll(() => page.evaluate(() => window._cellucidViewer.getSnapshotViews().length)).toBe(1);
    const whole = await captureScene(page, { pointCount: POINT_COUNT, segmentPoints: SEGMENT_POINTS, camera: null });
    expect(whole.positionSegments).toBe(1);
    expect(whole.levelPoints, 'the reduced level spans more than one segment').toBeGreaterThan(SEGMENT_POINTS);
    expect(whole.levelPoints).toBeLessThan(POINT_COUNT);
    // The second scene draws the same frames on the same GPU, after
    // publishing the dataset again: the budget follows what the first took.
    test.setTimeout(test.info().timeout + 3 * (Date.now() - capturing));

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
    const split = await captureScene(page, { pointCount: POINT_COUNT, segmentPoints: SEGMENT_POINTS, camera });
    expect(split.positionSegments).toBe(Math.ceil(POINT_COUNT / SEGMENT_POINTS));
    expect(split.colorSegments).toBe(split.positionSegments);

    // Every input the frames depend on is equal first.
    expect(split.levels[1], 'the reduced level and its points').toEqual(split.levels[0]);
    expect(split.cameras[1]).toEqual(split.cameras[0]);
    expect(split.highlightStoreViews[1]).toBe(split.highlightStoreViews[0]);
    expect(split.storeWordDifference, 'first position word that differs').toBe(-1);
    expect(split.colorWordDifference, 'first colour word that differs').toBe(-1);
    const differing = Object.entries(split.frames).filter(([, frame]) => frame.differing.length > 0);
    if (differing.length > 0) {
      // What drew each frame, for a run that differs: the context and
      // everything both frames of each configuration that differed submitted.
      await test.info().attach('segmented-frames.json', {
        body: JSON.stringify({ context: split.context, frames: Object.fromEntries(differing) }, null, 1),
        contentType: 'application/json',
      });
    }
    for (const [name, frame] of Object.entries(split.frames)) {
      expect(frame.inputs[1], `${name}: size, points drawn, level`).toEqual(frame.inputs[0]);
      expect(frame.lit, `${name}: lit pixels`).toBeGreaterThan(1_000);
      // The same draws with the same uniforms, in more calls: one a segment.
      expect(frame.submittedDifference, `${name}: what the two frames submitted`).toBeNull();
      expect(frame.calls[1], `${name}: the segmented frame takes more draw calls`).toBeGreaterThan(frame.calls[0]);
      if (isHostedMacosFirefox(browserName)) {
        // Two GPU objects holding the same bytes: hosted macOS Firefox has drawn such
        // pairs a few pixels apart (`helpers/hosted-gl.mjs`). Everything above is held
        // there exactly; of the pixels, that no more than rounding's share differs.
        expect(frame.differingPixels, `${name}: pixels that differ ${JSON.stringify(frame.differing)}`)
          .toBeLessThanOrEqual(frame.lit * ROUNDING_SHARE_ON_HOSTED_MACOS_FIREFOX);
      } else {
        expect(frame.differing, `${name}: pixels that differ (x, y, one segment, segmented)`).toEqual([]);
      }
    }
    expect(pageErrors).toEqual([]);
  });
}
