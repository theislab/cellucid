/**
 * @fileoverview Off-main-thread synthetic dataset generation for benchmarks.
 *
 * Generating twenty million points costs six to twenty-five transcendental
 * calls per point in one uninterruptible loop. Run on the main thread that
 * loop freezes the tab for the whole of it: no animation frame runs, no
 * progress can be reported, and an automated run has no way to tell a slow
 * generation apart from a hung page — the driver's own timeout fires first.
 *
 * This worker hosts the exact same generators. Nothing about the data changes;
 * only the thread it is built on does. The result crosses back as transferred
 * buffers, so the payload is moved rather than copied.
 *
 * @module app/ui/modules/benchmark/generation-worker
 */

import { SyntheticDataGenerator } from '../../../../dev/benchmark.js';
import { assertGenerationRequest } from './generation-contract.js';

const GENERATORS = Object.freeze({
  atlas: (count) => SyntheticDataGenerator.atlasLike(count),
  batches: (count) => SyntheticDataGenerator.batchEffects(count),
  clusters: (count) => SyntheticDataGenerator.gaussianClusters(count),
  flatumap: (count) => SyntheticDataGenerator.flatUMAP(count),
  glb: (count, sourceUrl) =>
    SyntheticDataGenerator.fromGLBUrl(count, sourceUrl),
  octopus: (count) => SyntheticDataGenerator.octopus(count),
  spirals: (count) => SyntheticDataGenerator.spirals(count),
  uniform: (count) => SyntheticDataGenerator.uniformRandom(count)
});

self.addEventListener('message', async event => {
  let request;
  try {
    request = assertGenerationRequest(event.data);
  } catch (error) {
    self.postMessage({
      requestId:
        Number.isSafeInteger(event.data?.requestId) ? event.data.requestId : -1,
      ok: false,
      name: error.name,
      message: error.message
    });
    return;
  }

  const startedAt = performance.now();
  try {
    const data = await GENERATORS[request.pattern](
      request.count,
      request.sourceUrl
    );
    const elapsedMs = performance.now() - startedAt;
    self.postMessage(
      {
        requestId: request.requestId,
        ok: true,
        positions: data.positions,
        colors: data.colors,
        dimensionLevel: data.dimensionLevel,
        elapsedMs
      },
      [data.positions.buffer, data.colors.buffer]
    );
  } catch (error) {
    self.postMessage({
      requestId: request.requestId,
      ok: false,
      name: error.name,
      message: error.message
    });
  }
});
