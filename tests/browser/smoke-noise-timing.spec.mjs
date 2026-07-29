import { expect, test } from '@playwright/test';

const WEBGL_HARNESS = '/tests/browser/fixtures/webgl-harness.html';
const TIMING_ENABLED = process.env.CELLUCID_GPU_TIMING === '1';

test('headed GPU noise callback timing at 128 and 256', async ({
  browserName,
  page,
}) => {
  test.skip(!TIMING_ENABLED, 'Set CELLUCID_GPU_TIMING=1 for GPU timing');
  test.skip(browserName !== 'chromium', 'Headed timing is sampled in Chromium');
  test.setTimeout(240_000);
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { startCloudNoiseGenerationGPU } = await import(
      '/assets/js/rendering/smoke-cloud/gpu-noise-generator.js'
    );

    const run = async size => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        desynchronized: true,
        depth: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
        stencil: false,
      });
      if (!(gl instanceof WebGL2RenderingContext)) {
        throw new Error(`GPU timing at ${size} requires WebGL2`);
      }
      let transaction = null;
      const gpuDrainedTimings = [];
      const schedule = callback => {
        let active = true;
        const frameId = requestAnimationFrame(() => {
          if (!active) return;
          active = false;
          const phase = transaction._phase;
          const sliceStart = transaction._slice;
          const startedAt = performance.now();
          callback();
          gl.finish();
          const endedAt = performance.now();
          gpuDrainedTimings.push({
            duration: endedAt - startedAt,
            phase,
            sliceEnd: transaction._slice,
            sliceStart,
          });
        });
        return () => {
          if (!active) return;
          active = false;
          cancelAnimationFrame(frameId);
        };
      };
      transaction = startCloudNoiseGenerationGPU(gl, size, size, {
        maxSlicesPerBatch: 16,
        schedule,
      });
      await transaction.completion;
      const submissionTimings = transaction.getTaskTimings();
      const summarize = timings => {
        const byPhase = {};
        for (const timing of timings) {
          const current = byPhase[timing.phase] ?? {
            callbacks: 0,
            maximum: 0,
            total: 0,
          };
          current.callbacks++;
          current.maximum = Math.max(current.maximum, timing.duration);
          current.total += timing.duration;
          byPhase[timing.phase] = current;
        }
        return {
          byPhase,
          maximum: Math.max(...timings.map(timing => timing.duration)),
          total: timings.reduce(
            (sum, timing) => sum + timing.duration,
            0
          ),
        };
      };
      const maximumSliceDelta = Math.max(
        ...gpuDrainedTimings
          .filter(timing => timing.phase.endsWith('-slices'))
          .map(timing => timing.sliceEnd - timing.sliceStart)
      );
      transaction.cancel();
      return {
        callbackCount: gpuDrainedTimings.length,
        cleanupComplete: transaction.cleanupComplete,
        gpuDrained: summarize(gpuDrainedTimings),
        maximumSliceDelta,
        submission: summarize(submissionTimings),
        webglError: gl.getError(),
      };
    };

    return {
      resolution128: await run(128),
      resolution256: await run(256),
    };
  });

  console.log(`CELLUCID_GPU_NOISE_TIMING ${JSON.stringify(proof)}`);
  expect(proof.resolution128.maximumSliceDelta).toBeLessThanOrEqual(16);
  expect(proof.resolution256.maximumSliceDelta).toBeLessThanOrEqual(4);
  for (const result of Object.values(proof)) {
    expect(result.callbackCount).toBeGreaterThan(0);
    expect(result.cleanupComplete).toBe(true);
    expect(result.gpuDrained.maximum).toBeGreaterThanOrEqual(0);
    expect(result.submission.maximum).toBeGreaterThanOrEqual(0);
    expect(result.gpuDrained.byPhase.initialize).toBeTruthy();
    expect(result.gpuDrained.byPhase['shape-finalize']).toBeTruthy();
    expect(result.gpuDrained.byPhase['detail-finalize']).toBeTruthy();
    expect(result.webglError).toBe(0);
  }
});
