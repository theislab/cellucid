/**
 * Cells added or removed in place draw exactly what a direct open of the same
 * cells draws.
 *
 * Cells opened in priority order (a priority-ordered file, any cell-level
 * subsample: `data/cell-priority.js`, `OPEN_ORDER_PRIORITY`) are drawn by
 * levels of detail at once, as prefixes of their stores in rank order
 * (`rendering/high-perf/lod-levels.js`, `RankLevels`), and take their tree's
 * order band by band while drawn (`rendering/high-perf/store-order.js`). An
 * Apply that raises or lowers the open cells keeps the stores of the cells
 * kept (`HighPerfRenderer#resizeLiveCells`): added cells are appended, a cut
 * rewrites at most the band it falls in, and the next tree's order is
 * adopted the same way.
 *
 * So after a raise (20,000 -> 30,000) or a lower (30,000 -> 12,345), once
 * the new tree's order is adopted, every frame -- full detail, culled, a
 * reduced level, a reduced level culled -- is byte-identical to the frame of
 * the same cells published directly, and so are the position and color
 * stores, in 3D and in 2D. Right after the Apply, before the tree, the
 * reduced level draws its cells by rank at once. Stores are forced into
 * segments of 4,096 points so the resize crosses segment boundaries. The
 * cameras are the same object, checked equal before any pixel is compared,
 * and so is what the two frames submitted to the GPU
 * (`helpers/gl-submissions.mjs`).
 */

import { expect, test } from './helpers/test.mjs';
import { labelProgramsBySource, recordSubmissions } from './helpers/gl-submissions.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { loadSyntheticDataset } from './helpers/synthetic-dataset.mjs';

const FIXTURE_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}` +
  '&dataset=current-ui&acceptance=lod-rank-order-resize-ci';
const SEGMENT_POINTS = 4_096;
const LARGEST = 30_000;

for (const dimension of [3, 2]) {
  test(`${dimension}D: cells added, then removed, in place draw what a direct open draws`, async ({ page }) => {
    test.setTimeout(300_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(labelProgramsBySource);
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    // A dataset of the dimension asked for, so the live view shows it.
    await loadSyntheticDataset(page, { pointCount: 5_000, pattern: dimension === 3 ? 'atlas' : 'flatumap' });
    await page.evaluate(recordSubmissions);

    // Each step publishes its own cells first, so the lower starts from a fresh opening of the largest.
    for (const [from, to] of [[20_000, LARGEST], [LARGEST, 12_345]]) {
      await test.step(`${dimension}D: ${from} -> ${to} cells in place draw what a direct open draws`, async () => {
        const result = await page.evaluate(async ({ dimension, from, to, largest, segmentPoints }) => {
          const viewer = window._cellucidViewer;
          const renderer = viewer.getHPRenderer();
          const gl = viewer.getGLContext();
          const submissions = window.__submissions;
          const { OPEN_ORDER_PRIORITY } = await import('/assets/js/data/cell-priority.js');
          const nextFrame = () => new Promise(resolve => { requestAnimationFrame(resolve); });
          // Each wait is on the state itself, one animation frame at a time,
          // as long as the machine takes: a tree is built in a worker and
          // adopted over frames, and a frame is as slow as the renderer. The
          // test's timeout bounds them.
          const settled = async () => {
            while (!viewer.getFrameScheduleState().settled) await nextFrame();
          };
          // The frame that shows a change has been drawn.
          const drawn = async () => {
            while (viewer.getFrameScheduleState().invalidated) await nextFrame();
          };
          const adopted = async () => {
            for (;;) {
              // The renderer facade hands out detached copies, so the store
              // order is asked whether it holds its tree's order whole.
              const tree = renderer.spatialIndices.get(dimension);
              if (tree?.lodLevels?.length > 0 && renderer._liveOrder?.complete === true) return;
              await nextFrame();
            }
          };
          // One seeded cloud; every publication is a prefix of it, as the
          // cells of a priority-ordered opening are.
          let state = 7;
          const random = () => {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            return state / 2 ** 32;
          };
          const positions = new Float32Array(largest * dimension);
          const colors = new Uint8Array(largest * 4);
          for (let cell = 0; cell < largest; cell++) {
            const cluster = cell % 7;
            for (let axis = 0; axis < dimension; axis++) {
              positions[cell * dimension + axis] = (cluster - 3) * 0.25 + (random() - 0.5) * 0.4;
            }
            colors.set([40 + cluster * 30, 200 - cluster * 20, 90 + (cell % 13) * 10, 255], cell * 4);
          }
          const payload = n => ({
            positions: positions.slice(0, n * dimension),
            colors: colors.slice(0, n * 4),
            transparency: Uint8Array.from({ length: n }, (_, cell) => ((((cell * 2654435761) >>> 0) % 1000) < 800 ? 1 : 0)),
            dimensionLevel: dimension,
            layoutKey: `rank-order-resize-${dimension}d`,
          });
          renderer.setStoreSegmentPoints(segmentPoints);
          viewer.setAntialiasing(false);
          viewer.setPointSize(5);
          viewer.setAdaptiveLOD(true);
          viewer.setFrustumCulling(false);
          viewer.setForceLOD(-1);
          const read = () => {
            const width = gl.drawingBufferWidth;
            const height = gl.drawingBufferHeight;
            const pixels = new Uint8Array(width * height * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            return pixels;
          };
          const readStore = (store, out) => {
            const elements = store.bytesPerPoint / out.BYTES_PER_ELEMENT;
            // Indexed: the facade's read-only arrays are not iterable.
            for (let index = 0; index < store.segments.length; index++) {
              const segment = store.segments[index];
              gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
              gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out, segment.first * elements, segment.count * elements);
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            return out;
          };
          const reducedLevel = 4;
          const capture = async camera => {
            viewer.setCameraState(camera);
            // Full detail is the tree's last level, forced: with adaptive LOD
            // on, no forced level (-1) is the level the camera distance picks,
            // a reduced one (as `segmented-point-stores` shows on hosted macOS
            // Firefox).
            const levels = renderer.spatialIndices.get(dimension).lodLevels;
            const fullDetail = levels.length - 1;
            if (levels[fullDetail].isFullDetail !== true) throw new Error('The tree\'s last level is not full detail.');
            const frames_ = {};
            for (const [name, cull, forced] of [
              ['full detail', false, fullDetail],
              ['full detail, culled', true, fullDetail],
              ['reduced level', false, reducedLevel],
              ['reduced level, culled', true, reducedLevel],
            ]) {
              viewer.setFrustumCulling(cull);
              viewer.setForceLOD(forced);
              // A change of the point size and back: the frame is drawn again
              // even where culling and the level stayed as they were.
              viewer.setPointSize(5.01);
              viewer.setPointSize(5);
              // Settled: the frame of the change and the one after it are drawn,
              // and nothing asks for another. Their uniforms are recorded.
              await submissions.recordingUniforms(settled);
              frames_[name] = {
                pixels: read(),
                drawn: renderer.getStats('live').visiblePoints,
                level: renderer.getStats('live').lodLevel,
                submitted: submissions.last,
              };
            }
            viewer.setFrustumCulling(false);
            viewer.setForceLOD(-1);
            return {
              frames: frames_,
              camera: viewer.getViewCameraState('live'),
              positions: readStore(renderer.buffers.positions, new Uint32Array(renderer.pointCount * renderer.buffers.positions.bytesPerPoint / 4)),
              colors: readStore(renderer.buffers.colors, new Uint32Array(renderer.pointCount)),
              segments: renderer.buffers.positions.segments.length,
            };
          };

          // The cells shown first, opened in priority order, settled in their
          // tree's order; then the Apply in place.
          // The viewer is driven directly: it gets highlight bytes for the
          // cells it shows, as the app publishes them.
          const publish = (n, inPlace) => {
            if (inPlace) viewer.resizeLiveCells(payload(n));
            else viewer.setData(payload(n));
            viewer.updateHighlight(new Uint8Array(n));
            viewer.setCellPriority(OPEN_ORDER_PRIORITY);
          };
          publish(from, false);
          await adopted();
          await settled();
          const camera = viewer.getCameraState();
          publish(to, true);
          // Right after the Apply: the reduced level draws by rank, at once.
          viewer.setForceLOD(reducedLevel);
          await drawn();
          const atOnce = {
            level: renderer.getStats('live').lodLevel,
            drawn: renderer.getStats('live').visiblePoints,
          };
          viewer.setForceLOD(-1);
          await adopted();
          const inPlace = await capture(camera);

          // The same cells, published directly.
          publish(to, false);
          await adopted();
          const direct = await capture(camera);

          const firstDifference = (left, right) => {
            if (left.length !== right.length) return `length ${left.length} vs ${right.length}`;
            for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return index;
            return -1;
          };
          const compared = {};
          for (const [name, frame] of Object.entries(direct.frames)) {
            const other = inPlace.frames[name];
            let lit = 0;
            for (let index = 3; index < frame.pixels.length; index += 4) if (frame.pixels[index] !== 0) lit += 1;
            let differing = 0;
            for (let index = 0; index < frame.pixels.length; index += 4) {
              if (frame.pixels[index] !== other.pixels[index] || frame.pixels[index + 1] !== other.pixels[index + 1]
                || frame.pixels[index + 2] !== other.pixels[index + 2] || frame.pixels[index + 3] !== other.pixels[index + 3]) differing += 1;
            }
            compared[name] = {
              inputs: [[frame.drawn, frame.level], [other.drawn, other.level]],
              lit,
              differing,
              difference: firstDifference(frame.pixels, other.pixels),
              submittedDifference: submissions.difference(frame.submitted, other.submitted),
            };
          }
          return {
            atOnce,
            cameras: [direct.camera, inPlace.camera],
            segments: [direct.segments, inPlace.segments],
            positionDifference: firstDifference(direct.positions, inPlace.positions),
            colorDifference: firstDifference(direct.colors, inPlace.colors),
            frames: compared,
          };
        }, { dimension, from, to, largest: LARGEST, segmentPoints: SEGMENT_POINTS });

        expect(result.atOnce.level, 'a reduced level draws right after the Apply').toBe(4);
        expect(result.frames['full detail'].inputs[0][0], 'full detail draws every cell').toBe(to);
        expect(result.cameras[1]).toEqual(result.cameras[0]);
        expect(result.segments[0]).toBe(Math.ceil(to / SEGMENT_POINTS));
        expect(result.segments[1]).toBe(result.segments[0]);
        expect(result.positionDifference, 'first position word that differs').toBe(-1);
        expect(result.colorDifference, 'first color word that differs').toBe(-1);
        for (const [name, frame] of Object.entries(result.frames)) {
          expect(frame.inputs[1], `${name}: points drawn, level`).toEqual(frame.inputs[0]);
          expect(frame.lit, `${name}: lit pixels`).toBeGreaterThan(500);
          // The same draws, ranges and uniforms on both sides.
          expect(frame.submittedDifference, `${name}: what the two frames submitted`).toBeNull();
          expect(frame.difference, `${name}: first byte that differs (${frame.differing} pixels differ)`).toBe(-1);
        }
      });
    }
    expect(pageErrors).toEqual([]);
  });
}
