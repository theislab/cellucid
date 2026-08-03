/**
 * Smoke coverage for the render benchmark harness.
 *
 * This spec proves the harness works. It is deliberately not a baseline: the
 * point counts are small, the windows are short, and no result it prints may
 * be recorded as a performance number. What it must establish is that the
 * harness can observe the things the previous harness structurally could not:
 *
 * - the scripted camera actually crosses LOD levels and moves geometry out of
 *   the frustum, rather than being assumed to;
 * - buffer uploads are counted per frame without any change to the renderer;
 * - the STATIC and ORBIT regimes differ in the way the renderer's guards say
 *   they must, which is what makes their difference a measurement;
 * - a dataset can be generated without freezing the main thread.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
/** The last rung of the 18-level ladder: every point, no reduction. */
// Two different numbers for two different things, and conflating them is what
// this spec got wrong. `FULL_DETAIL_LADDER_INDEX` is the rung you force to ask
// for the whole cloud. `FULL_DETAIL_REPORTED_LEVEL` is what the renderer
// publishes once it draws it: full detail is not a reduced level, so it draws
// from the full buffer and reports -1, exactly as the LOD membership contract
// publishes null for it.
const FULL_DETAIL_LADDER_INDEX = 17;
const FULL_DETAIL_REPORTED_LEVEL = -1;
const ADAPTIVE_FLOOR_LADDER_INDEX = 8;

const FIXTURE_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}` +
  '&dataset=current-ui-prepared&acceptance=benchmark-harness-ci';

const HARNESS_MODULE = '/assets/js/app/ui/modules/benchmark/index.js';
const PROCESS_INTENSIVE = Object.freeze({
  tag: '@browser-process-intensive',
});

/** Small enough to stay a smoke test on a busy machine. */
const SMOKE_POINT_COUNT = 120_000;
// The measured window's length, passed into the page and asserted against on the
// way out. A literal on each side is how `samples` came to expect 180 frames
// from a window configured for 60.
const SMOKE_WARMUP_FRAMES = 10;
const SMOKE_MEASURE_FRAMES = 60;

async function publishSyntheticDataset(page, pointCount, pattern) {
  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-section')).toHaveAttribute('open', '');
  await page.locator('#benchmark-count').fill(String(pointCount));
  await page.locator('#benchmark-pattern').selectOption(pattern);
  await page.locator('#benchmark-run').click();
  await expect
    .poll(() => page.evaluate(() => window._cellucidState.pointCount), {
      timeout: 120_000
    })
    .toBe(pointCount);
}

test('the harness observes LOD, culling and uploads under scripted motion', PROCESS_INTENSIVE, async ({
  page
}, testInfo) => {
  test.setTimeout(600_000);
  const browserErrors = [];
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points'
  );
  await publishSyntheticDataset(page, SMOKE_POINT_COUNT, 'atlas');

  const outcome = await page.evaluate(
    async ({ moduleUrl, warmupFrames, measureFrames }) => {
      const harnessModule = await import(moduleUrl);
      const viewer = window._cellucidViewer;
      const canvas = document.getElementById('glcanvas');
      const harness = harnessModule.createBenchmarkHarness({ viewer, canvas });
      try {
        const runner = harness.runner;
        const path = runner.createPathFromCurrentCamera();
        const windows = {};

        // Culling on is the configuration whose per-frame element-buffer
        // publication the counters exist to observe. The windows are short:
        // this spec proves the counters work and publishes no number anyone
        // may record.
        for (const regime of ['static', 'orbit']) {
          await runner.applyConfiguration({
            viewCount: 1,
            lod: true,
            frustumCulling: true,
            forceLodLevel: -1,
            regime
          });
          windows[regime] = await runner.runWindow({
            regime,
            path,
            warmupFrames,
            measureFrames
          });
        }

        // A separate probe pass reads the renderer's own per-view statistics.
        // It allocates, so it is deliberately kept outside a measured window.
        await runner.applyConfiguration({
          viewCount: 1,
          lod: true,
          frustumCulling: true,
          forceLodLevel: -1,
          regime: 'orbit'
        });
        const probe = {
          lodLevels: [],
          cullPercents: [],
          visiblePoints: [],
          drawCalls: []
        };
        const cameraState = harnessModule.createMutableCameraState();
        for (let frameIndex = 0; frameIndex < 90; frameIndex++) {
          path.sampleInto(cameraState, frameIndex * 3);
          viewer.setCameraState(cameraState);
          await new Promise(resolve => requestAnimationFrame(resolve));
          const stats = viewer.getRendererStats('live');
          probe.lodLevels.push(stats.lodLevel);
          probe.cullPercents.push(stats.cullPercent);
          probe.visiblePoints.push(stats.visiblePoints);
          probe.drawCalls.push(stats.drawCalls);
        }

        // A second pass over forced levels. Adaptive selection has a floor, and
        // a forced level is deliberately not held to it, so this reaches rungs
        // the camera cannot: the harness has to see one level from another
        // across the whole ladder, not only the part `Auto` uses.
        const forced = [];
        for (const forceLodLevel of [0, 8, 17]) {
          await runner.applyConfiguration({
            viewCount: 1,
            lod: true,
            frustumCulling: true,
            forceLodLevel,
            regime: 'static'
          });
          await new Promise(resolve => requestAnimationFrame(resolve));
          await new Promise(resolve => requestAnimationFrame(resolve));
          const stats = viewer.getRendererStats('live');
          forced.push({
            requested: forceLodLevel,
            observed: stats.lodLevel,
            visiblePoints: stats.visiblePoints
          });
        }

        return {
          forced,
          identity: harness.identity,
          rasterizer: harness.rasterizer,
          baselineKey: harness.baselineKey(),
          windows,
          probe: {
            distinctLodLevels: [...new Set(probe.lodLevels)].sort(
              (a, b) => a - b
            ),
            minCullPercent: Math.min(...probe.cullPercents),
            maxCullPercent: Math.max(...probe.cullPercents),
            framesWithCulledGeometry: probe.cullPercents.filter(
              value => value > 0
            ).length,
            minVisiblePoints: Math.min(...probe.visiblePoints),
            maxVisiblePoints: Math.max(...probe.visiblePoints),
            maxDrawCalls: Math.max(...probe.drawCalls)
          },
          pathCoverage: path.describeLodCoverage(path.baseRadius)
        };
      } finally {
        harness.dispose();
      }
    },
    {
      moduleUrl: HARNESS_MODULE,
      warmupFrames: SMOKE_WARMUP_FRAMES,
      measureFrames: SMOKE_MEASURE_FRAMES
    }
  );

  // The rasterizer must be identified and recorded on every run, so a later
  // cycle cannot record software-rasterized numbers as a hardware baseline.
  expect(outcome.identity.canvas.backingStorePixels).toBeGreaterThan(0);
  expect(['hardware', 'software', 'unknown']).toContain(outcome.rasterizer.kind);
  expect(outcome.baselineKey).toMatch(/^[a-z0-9-]+$/);

  // Adaptive selection follows the camera at every dataset size. Its floor is
  // the smaller of an absolute point budget and a fixed reduction cap, so a
  // 120,000-point cloud — far inside the budget, where an absolute-budget-only
  // floor pinned every distance to full detail and made `Auto` inert — still
  // has levels between full detail and its floor for the scripted path to cross.
  const reportedLodLevels = outcome.probe.distinctLodLevels;
  expect(reportedLodLevels.length).toBeGreaterThan(1);
  expect(reportedLodLevels).toContain(FULL_DETAIL_REPORTED_LEVEL);
  const reducedLodLevels = reportedLodLevels.filter(
    level => level !== FULL_DETAIL_REPORTED_LEVEL
  );
  expect(reducedLodLevels.length).toBeGreaterThan(0);
  expect(Math.min(...reducedLodLevels)).toBe(ADAPTIVE_FLOOR_LADDER_INDEX);
  expect(Math.max(...reducedLodLevels)).toBeLessThan(FULL_DETAIL_LADDER_INDEX);

  // The measured windows are sixty frames of whatever part of the path they
  // happen to cover, so how many level changes fall inside one is a property of
  // the window, not of the renderer. Assert that the counter is published and
  // countable; the deterministic traversal above is what proves the level moves.
  for (const regime of ['static', 'orbit']) {
    const transitions = outcome.windows[regime].lod.transitions;
    expect(Number.isSafeInteger(transitions)).toBe(true);
    expect(transitions).toBeGreaterThanOrEqual(0);
  }

  // The ladder itself is untouched by the floor — a forced level is an explicit
  // request and is still honoured — so the harness can still tell one level from
  // another, which is what it exists to measure. Level 0 is below the adaptive
  // floor and only a forced request reaches it.
  expect(outcome.forced.map(entry => entry.observed)).toEqual([
    0,
    ADAPTIVE_FLOOR_LADDER_INDEX,
    FULL_DETAIL_REPORTED_LEVEL
  ]);
  const [coarsest, middle, full] = outcome.forced;
  expect(coarsest.visiblePoints).toBeLessThan(middle.visiblePoints);
  expect(middle.visiblePoints).toBeLessThan(full.visiblePoints);
  // Frustum culling is on in this pass, so `visiblePoints` is what survived the
  // frustum, not what the level holds. Asserting the whole cloud here would be
  // asserting that the camera happens to see all of it, which is a property of
  // wherever the scripted path left the camera. What the ladder owes is the
  // ordering above and a full-detail count no reduced level can reach.
  expect(full.visiblePoints).toBeGreaterThan(0);
  expect(full.visiblePoints).toBeLessThanOrEqual(SMOKE_POINT_COUNT);

  // Proof that geometry leaves the frustum rather than merely being tested
  // against it: the renderer reports a nonzero culled fraction, and the
  // visible-point count swings across the path.
  expect(outcome.probe.maxCullPercent).toBeGreaterThan(0);
  expect(outcome.probe.framesWithCulledGeometry).toBeGreaterThan(0);
  expect(outcome.probe.minVisiblePoints).toBeLessThan(
    outcome.probe.maxVisiblePoints
  );
  expect(outcome.probe.minVisiblePoints).toBeLessThan(SMOKE_POINT_COUNT);

  // The upload counters must work without any renderer change, and must
  // separate a moving camera from a still one. The renderer publishes a new
  // element buffer only when the ordered visible set changes, so a still
  // camera must produce none.
  expect(outcome.windows.orbit.uploads.totalElementCalls).toBeGreaterThan(0);
  expect(outcome.windows.static.uploads.totalElementCalls).toBe(0);
  expect(outcome.windows.orbit.uploads.totalBytes).toBeGreaterThan(
    outcome.windows.static.uploads.totalBytes
  );

  // The synchronous GL points are on the same guard, but the guard moved.
  // `_uploadToViewIndexBuffer` used to bracket every per-view, per-frame index
  // publication in two `gl.getError()` calls; CEL-0071 takes that bracket only
  // when publishing wider than any size the element buffer has been proven to
  // hold, and skips it when replacing at or below that watermark. So a still
  // camera stalls not at all, a moving one stalls only where the buffer grows,
  // and the per-frame pipeline drain this counter was added to expose is gone.
  // Asserting it is still there would assert the defect CEL-0071 removed; what
  // must hold is that it cannot come back.
  expect(outcome.windows.static.uploads.totalSyncStallCalls).toBe(0);
  expect(outcome.windows.orbit.uploads.totalSyncStallCalls).toBeLessThan(
    outcome.windows.orbit.samples
  );

  // Percentiles are withheld, not invented, when the window is this short.
  for (const regime of ['static', 'orbit']) {
    const summary = outcome.windows[regime];
    expect(summary.samples).toBe(SMOKE_MEASURE_FRAMES);
    expect(summary.percentileSupport.p99.reported).toBe(false);
    expect(summary.frameTimeMs.p99).toBeNull();
    expect(summary.frameTimeMs.median).toBeGreaterThan(0);
  }

  await testInfo.attach('benchmark-harness-smoke.json', {
    body: JSON.stringify(outcome, null, 2),
    contentType: 'application/json'
  });
  expect(browserErrors).toEqual([]);
});

test('the view-count axis reaches the viewer snapshot ceiling', PROCESS_INTENSIVE, async ({
  page
}) => {
  test.setTimeout(600_000);
  const browserErrors = [];
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await publishSyntheticDataset(page, SMOKE_POINT_COUNT, 'atlas');

  const measured = await page.evaluate(
    async ({ moduleUrl }) => {
      const harnessModule = await import(moduleUrl);
      const viewer = window._cellucidViewer;
      const canvas = document.getElementById('glcanvas');
      const harness = harnessModule.createBenchmarkHarness({ viewer, canvas });
      try {
        const runner = harness.runner;
        const path = runner.createPathFromCurrentCamera();
        const cells = [];
        for (const viewCount of [1, 2, 4]) {
          const layout = await runner.applyConfiguration({
            viewCount,
            lod: true,
            frustumCulling: true,
            forceLodLevel: -1,
            regime: 'orbit'
          });
          const summary = await runner.runWindow({
            regime: 'orbit',
            path,
            warmupFrames: 20,
            measureFrames: 90
          });
          cells.push({
            viewCount,
            layout,
            elementUploadCalls: summary.uploads.totalElementCalls,
            syncStallCalls: summary.uploads.totalSyncStallCalls,
            samples: summary.samples
          });
        }
        let refusedBeyondCeiling = null;
        try {
          await runner.ensureViewCount(harnessModule.MAX_BENCHMARK_VIEWS + 1);
        } catch (error) {
          refusedBeyondCeiling = error.message;
        }
        return { cells, refusedBeyondCeiling };
      } finally {
        harness.dispose();
      }
    },
    { moduleUrl: HARNESS_MODULE }
  );

  // Setting the layout alone leaves the renderer on its single-viewport path;
  // the axis is real only when the viewer publishes the extra views.
  expect(measured.cells.map(cell => cell.layout)).toEqual([
    { viewCount: 1, layoutMode: 'single' },
    { viewCount: 2, layoutMode: 'grid' },
    { viewCount: 4, layoutMode: 'grid' }
  ]);
  // Per-view work must scale with the number of panes, not stay flat.
  expect(measured.cells[1].elementUploadCalls).toBeGreaterThan(
    measured.cells[0].elementUploadCalls
  );
  expect(measured.cells[2].elementUploadCalls).toBeGreaterThan(
    measured.cells[1].elementUploadCalls
  );
  expect(measured.refusedBeyondCeiling).toMatch(/exceeds the viewer ceiling/);
  expect(browserErrors).toEqual([]);
});

test('synthetic generation runs off the main thread', PROCESS_INTENSIVE, async ({ page }) => {
  test.setTimeout(600_000);
  const browserErrors = [];
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });

  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  const result = await page.evaluate(
    async ({ moduleUrl, count }) => {
      const harnessModule = await import(moduleUrl);
      // Audit the runtime boundary itself. Frame delivery is allowed to be
      // throttled independently from worker scheduling, especially in a
      // headless background tab, so RAF counts cannot prove thread ownership.
      const NativeWorker = window.Worker;
      const workers = [];
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          workers.push({
            url: String(args[0]),
            type: args[1]?.type ?? null,
          });
          return Reflect.construct(target, args);
        },
      });

      const startedAt = performance.now();
      let data;
      try {
        data = await harnessModule.generateSyntheticDataOffThread({
          pattern: 'atlas',
          count
        });
      } finally {
        window.Worker = NativeWorker;
      }
      return {
        wallMs: performance.now() - startedAt,
        workerMs: data.elapsedMs,
        workers,
        positions: data.positions.length,
        colors: data.colors.length,
        dimensionLevel: data.dimensionLevel,
        positionsAreFloat32: data.positions instanceof Float32Array,
        colorsAreUint8: data.colors instanceof Uint8Array
      };
    },
    { moduleUrl: HARNESS_MODULE, count: 1_000_000 }
  );

  expect(result.positions).toBe(3_000_000);
  expect(result.colors).toBe(4_000_000);
  expect(result.dimensionLevel).toBe(3);
  expect(result.positionsAreFloat32).toBe(true);
  expect(result.colorsAreUint8).toBe(true);
  expect(result.workerMs).toBeGreaterThan(0);
  expect(result.workers).toEqual([{
    url: expect.stringMatching(/\/generation-worker\.js$/),
    type: 'module',
  }]);
  expect(browserErrors).toEqual([]);
});

test('the worker builds exactly what the main thread would have built', PROCESS_INTENSIVE, async ({
  page
}) => {
  // The Run button generates off-thread, so the worker evaluates its own copy
  // of the generator module. Nothing may make the two copies disagree — a
  // generator that reached for main-thread-only state, or a seed that did not
  // survive the boundary, would silently produce a different dataset in the
  // application than in every node test that calls the class directly.
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  const compared = await page.evaluate(
    async ({ moduleUrl, count }) => {
      const generatorModule = await import('/assets/js/dev/benchmark.js');
      const harnessModule = await import(moduleUrl);
      const digest = async view => {
        const hash = await crypto.subtle.digest(
          'SHA-256',
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        );
        return [...new Uint8Array(hash)]
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');
      };
      const entryPoints = {
        atlas: 'atlasLike',
        batches: 'batchEffects',
        clusters: 'gaussianClusters',
        flatumap: 'flatUMAP',
        octopus: 'octopus',
        spirals: 'spirals',
        uniform: 'uniformRandom'
      };
      const rows = [];
      for (const [pattern, entryPoint] of Object.entries(entryPoints)) {
        const onThread =
          generatorModule.SyntheticDataGenerator[entryPoint](count);
        const offThread = await harnessModule.generateSyntheticDataOffThread({
          pattern,
          count
        });
        rows.push({
          pattern,
          positionsMatch:
            (await digest(onThread.positions)) ===
            (await digest(offThread.positions)),
          colorsMatch:
            (await digest(onThread.colors)) === (await digest(offThread.colors)),
          dimensionMatch:
            onThread.dimensionLevel === offThread.dimensionLevel
        });
      }
      return {
        seed: generatorModule.SyntheticDataGenerator.seed,
        defaultSeed: generatorModule.DEFAULT_SYNTHETIC_SEED,
        rows
      };
    },
    { moduleUrl: HARNESS_MODULE, count: 5_000 }
  );

  expect(compared.seed).toBe(compared.defaultSeed);
  expect(compared.rows.length).toBe(7);
  for (const row of compared.rows) {
    expect(row, `pattern ${row.pattern}`).toEqual({
      pattern: row.pattern,
      positionsMatch: true,
      colorsMatch: true,
      dimensionMatch: true
    });
  }
});

test('an aborted generation terminates its worker', PROCESS_INTENSIVE, async ({ page }) => {
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  const aborted = await page.evaluate(async ({ moduleUrl }) => {
    const harnessModule = await import(moduleUrl);
    const controller = new AbortController();
    const pending = harnessModule.generateSyntheticDataOffThread({
      pattern: 'atlas',
      count: 5_000_000,
      signal: controller.signal
    });
    controller.abort();
    try {
      await pending;
      return { rejected: false, name: null };
    } catch (error) {
      return { rejected: true, name: error.name };
    }
  }, { moduleUrl: HARNESS_MODULE });

  expect(aborted.rejected).toBe(true);
  expect(aborted.name).toBe('AbortError');
});
