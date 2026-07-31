// What the smoke ray march reconstructs from a known density volume.
//
// The splat and the renderer are two halves of one contract: the splat writes a
// point at p in [-1,1] into index (p + 1) / 2 * (gridSize - 1), and the
// renderer must read that index back at the same world position, at full
// resolution, and nowhere outside the support of the voxels that were written.
// Nothing else in the suite asserts any of that, so a mapping or mip-level
// change moves the smoke off the cells it represents in silence.

import { expect, test } from '@playwright/test';

const HARNESS_URL = '/tests/browser/fixtures/webgl-harness.html';
const PROBE = '/tests/browser/helpers/smoke-volume-probe.mjs';
const DENSITY = '/assets/js/rendering/smoke-cloud/smoke-density.js';

test('the smoke is reconstructed at the world positions the splat wrote', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const measurements = await page.evaluate(async ([probeUrl, densityUrl]) => {
    const {
      marchVolume,
      columnWeights,
      weightedCentroid,
      indexToWorld,
      indexStepWorld,
    } = await import(probeUrl);
    const { buildDensityTextureGPU, disposeDensityPipelineResources } =
      await import(densityUrl);

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke reconstruction test requires WebGL2');
    }

    const gridSize = 32;
    const step = indexStepWorld(gridSize);
    const results = [];
    // The boundary shell and the interior. A reader that addresses the volume
    // as if the splat had been voxel-centred lands half a texel inwards at
    // index 0, half a texel outwards at the last index, and exactly right in
    // the middle -- so only the shell reveals the error.
    for (const columnIndex of [0, 3, 16, 28, gridSize - 1]) {
      const rowIndex = 16;
      const worldX = indexToWorld(columnIndex, gridSize);
      const worldY = indexToWorld(rowIndex, gridSize);
      // A column of points along Z at one exact splat index: every voxel of
      // that column receives the full weight of one point, so the volume is
      // uniform in Z and the marched footprint is the reconstructed 2-D kernel.
      const positions = new Float32Array(gridSize * 3);
      for (let k = 0; k < gridSize; k++) {
        positions[k * 3] = worldX;
        positions[k * 3 + 1] = worldY;
        positions[k * 3 + 2] = indexToWorld(k, gridSize);
      }
      const built = buildDensityTextureGPU(gl, positions, { gridSize, gamma: 1 });
      if (built === null) throw new Error('splat produced no volume');
      const frame = marchVolume(gl, {
        densityTexture: built.texture,
        gridSize,
        size: 256,
        jitter: true,
      });
      const weights = columnWeights(frame, worldY);
      const { centroid, peak } = weightedCentroid(frame, weights);
      // Support edges, in index steps measured from the written position.
      let reachLow = 0;
      let reachHigh = 0;
      for (let x = 0; x < weights.length; x++) {
        if (weights[x] <= peak * 0.02) continue;
        const offset = (frame.worldOf(x) - worldX) / step;
        reachLow = Math.min(reachLow, offset);
        reachHigh = Math.max(reachHigh, offset);
      }
      results.push({
        columnIndex,
        worldX,
        centroid,
        peak,
        reachLow,
        reachHigh,
        offsetTexels: (centroid - worldX) / step,
        // where a voxel-centred reader would have put it
        voxelCentredOffsetTexels:
          ((2 * (columnIndex + 0.5)) / gridSize - 1 - worldX) / step,
      });
      gl.deleteTexture(built.texture);
    }
    disposeDensityPipelineResources(gl);
    return results;
  }, [PROBE, DENSITY]);

  const gridSize = 32;
  for (const measurement of measurements) {
    expect(
      Number.isFinite(measurement.centroid),
      `index ${measurement.columnIndex} produced no smoke`,
    ).toBe(true);
    expect(measurement.peak).toBeGreaterThan(0.05);

    const onShell =
      measurement.columnIndex === 0 || measurement.columnIndex === gridSize - 1;
    if (onShell) {
      // The wall truncates the kernel, so the centroid is pulled inwards by a
      // third of a step no matter how right the addressing is. What the shell
      // does pin down is reach: trilinear reconstruction of one index reaches
      // exactly one index step inwards. A reader that places the outermost
      // voxel half a texel inside the wall reaches one and a half.
      const inward = measurement.columnIndex === 0
        ? measurement.reachHigh
        : -measurement.reachLow;
      expect(
        inward,
        `boundary index ${measurement.columnIndex} reaches ${inward} index steps inwards`,
      ).toBeLessThan(1.2);
      expect(inward).toBeGreaterThan(0.8);
    } else {
      expect(
        Math.abs(measurement.offsetTexels),
        `index ${measurement.columnIndex} reconstructed ${measurement.offsetTexels} ` +
        `index steps from where the splat wrote it`,
      ).toBeLessThan(0.05);
    }
  }
  // The measurement has to be able to see the error it exists to catch: away
  // from the centre a voxel-centred reader is a large fraction of a step out,
  // many times the tolerance above.
  const offCentre = measurements.find(m => m.columnIndex === 3);
  expect(Math.abs(offCentre.voxelCentredOffsetTexels)).toBeGreaterThan(0.35);
});

test('a single density column reconstructs as one monotone tent', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const profile = await page.evaluate(async ([probeUrl]) => {
    const { marchVolume, columnWeights, voxelVolume, indexToWorld } =
      await import(probeUrl);
    const { createDensityTexture3D } = await import(
      '/assets/js/rendering/smoke-cloud/smoke-density.js'
    );
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke reconstruction test requires WebGL2');
    }
    const gridSize = 32;
    const columnIndex = 16;
    const rowIndex = 16;
    const descriptor = voxelVolume(gridSize, (x, y) =>
      (x === columnIndex && y === rowIndex ? 1 : 0));
    const info = createDensityTexture3D(gl, descriptor);
    const frame = marchVolume(gl, {
      densityTexture: info.texture,
      gridSize,
      size: 256,
    });
    const weights = Array.from(columnWeights(frame, indexToWorld(rowIndex, gridSize)));
    gl.deleteTexture(info.texture);
    return {
      weights,
      worlds: weights.map((_, index) => frame.worldOf(index)),
      indexStep: 2 / (gridSize - 1),
    };
  }, [PROBE]);

  const { weights, worlds, indexStep } = profile;
  const peak = Math.max(...weights);
  expect(peak).toBeGreaterThan(0.05);
  const peakIndex = weights.indexOf(peak);

  // Unimodal: never rises again once it has started falling, in either
  // direction. A coarser mip level bleeding in reads as a shoulder here.
  const tolerance = peak * 0.02;
  for (let index = peakIndex + 1; index < weights.length; index++) {
    expect(
      weights[index],
      `profile rises again ${index - peakIndex} pixels right of the peak`,
    ).toBeLessThanOrEqual(weights[index - 1] + tolerance);
  }
  for (let index = peakIndex - 1; index >= 0; index--) {
    expect(
      weights[index],
      `profile rises again ${peakIndex - index} pixels left of the peak`,
    ).toBeLessThanOrEqual(weights[index + 1] + tolerance);
  }

  // Trilinear reconstruction of one voxel reaches exactly one index step to
  // each side. Anything wider is density reported where none was written.
  const floor = peak * 0.02;
  let low = worlds[weights.length - 1];
  let high = worlds[0];
  for (let index = 0; index < weights.length; index++) {
    if (weights[index] <= floor) continue;
    low = Math.min(low, worlds[index]);
    high = Math.max(high, worlds[index]);
  }
  expect((high - low) / indexStep).toBeLessThanOrEqual(2.15);
  expect((high - low) / indexStep).toBeGreaterThan(1.5);
});

test('the smoke silhouette stays inside the support of the voxels written', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const measurement = await page.evaluate(async ([probeUrl]) => {
    const { marchVolume, voxelVolume, indexToWorld, indexStepWorld } =
      await import(probeUrl);
    const { createDensityTexture3D } = await import(
      '/assets/js/rendering/smoke-cloud/smoke-density.js'
    );
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke reconstruction test requires WebGL2');
    }
    const gridSize = 32;
    const step = indexStepWorld(gridSize);
    const ballRadius = 0.45;
    let occupiedRadius = 0;
    const descriptor = voxelVolume(gridSize, (x, y, z) => {
      const wx = indexToWorld(x, gridSize);
      const wy = indexToWorld(y, gridSize);
      const wz = indexToWorld(z, gridSize);
      const radius = Math.hypot(wx, wy, wz);
      if (radius > ballRadius) return 0;
      const planar = Math.hypot(wx, wy);
      if (planar > occupiedRadius) occupiedRadius = planar;
      return 1;
    });
    const info = createDensityTexture3D(gl, descriptor);
    const frame = marchVolume(gl, {
      densityTexture: info.texture,
      gridSize,
      size: 320,
      half: 1.05,
      jitter: true,
      densityMultiplier: 8,
      stepMultiplier: 2.8,
    });
    let renderedRadius = 0;
    let painted = 0;
    for (let y = 0; y < frame.size; y++) {
      for (let x = 0; x < frame.size; x++) {
        if (frame.alphaAt(x, y) === 0) continue;
        painted++;
        const radius = Math.hypot(frame.worldOf(x), frame.worldOf(y));
        if (radius > renderedRadius) renderedRadius = radius;
      }
    }
    gl.deleteTexture(info.texture);
    // Trilinear reconstruction of the written voxels reaches one index step
    // past the outermost occupied voxel, and no further.
    const supportRadius = occupiedRadius + step;
    return {
      painted,
      supportRadius,
      renderedRadius,
      excessTexels: (renderedRadius - supportRadius) / step,
    };
  }, [PROBE]);

  expect(measurement.painted).toBeGreaterThan(1000);
  expect(
    measurement.excessTexels,
    `silhouette reaches ${measurement.excessTexels} texels past the written support`,
  ).toBeLessThanOrEqual(0.25);
});
