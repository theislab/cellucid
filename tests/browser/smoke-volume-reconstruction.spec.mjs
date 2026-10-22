// What the smoke ray march reconstructs from a known density volume.
//
// The splat and the renderer are two halves of one contract: the splat writes a
// point at p in [-1,1] into index (p + 1) / 2 * (gridSize - 1), and the
// renderer must read that index back at the same world position, at full
// resolution, and nowhere outside the support of the voxels that were written.
// Nothing else in the suite asserts any of that, so a mapping or mip-level
// change moves the smoke off the cells it represents in silence.

import { expect, test } from './helpers/test.mjs';

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
      //
      // A lone column has no extent along X and Y, so the build would spread
      // it into a soft slab (the treatment of 1D and 2D embeddings). Two
      // anchor cells in opposite corners give the cloud full extent on every
      // axis; they sit in rows 0 and gridSize - 1, outside the measured rows.
      const positions = new Float32Array((gridSize + 2) * 3);
      for (let k = 0; k < gridSize; k++) {
        positions[k * 3] = worldX;
        positions[k * 3 + 1] = worldY;
        positions[k * 3 + 2] = indexToWorld(k, gridSize);
      }
      positions.set([-1, -1, -1, 1, 1, 1], gridSize * 3);
      const built = buildDensityTextureGPU(gl, positions, {
        colors: new Uint8Array((gridSize + 2) * 4).fill(255),
        dimension: 3,
        gridSize,
        gamma: 1,
      });
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

test('empty-space skipping through the occupancy volume loses no smoke', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const comparison = await page.evaluate(async ([probeUrl, densityUrl]) => {
    const { marchVolume } = await import(probeUrl);
    const {
      buildDensityTextureGPU,
      buildDerivedVolumesGPU,
      disposeDensityPipelineResources,
    } = await import(densityUrl);
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke occupancy test requires WebGL2');
    }
    // Sparse, thin and faint structure: three dense clumps, a one-point-wide
    // filament between two of them and isolated single cells, so most blocks
    // are empty and the occupied ones include the faintest possible voxels.
    const points = [];
    let state = 12345;
    const random = () => ((state = (state * 1103515245 + 12345) >>> 0) / 4294967296);
    for (const [cx, cy, cz] of [[-0.6, -0.4, 0.1], [0.5, 0.45, -0.3], [0.2, -0.55, 0.5]]) {
      for (let i = 0; i < 4000; i++) {
        points.push(cx + (random() - 0.5) * 0.25, cy + (random() - 0.5) * 0.25, cz + (random() - 0.5) * 0.25);
      }
    }
    for (let i = 0; i <= 200; i++) {
      const f = i / 200;
      points.push(-0.6 + 1.1 * f, -0.4 + 0.85 * f, 0.1 - 0.4 * f);
    }
    for (let i = 0; i < 40; i++) {
      points.push(random() * 1.8 - 0.9, random() * 1.8 - 0.9, random() * 1.8 - 0.9);
    }
    const positions = new Float32Array(points);
    const gridSize = 64;
    const built = buildDensityTextureGPU(gl, positions, {
      colors: new Uint8Array((positions.length / 3) * 4).fill(255),
      dimension: 3,
      gridSize,
      gamma: 0.7,
    });
    const derived = buildDerivedVolumesGPU(gl, built.texture, {
      gridSize,
      lightDir: [0.5, 0.7, 0.5],
    });
    const options = {
      densityTexture: built.texture,
      gridSize,
      size: 256,
      half: 1.05,
      densityMultiplier: 1,
      stepMultiplier: 1.5,
    };
    const full = marchVolume(gl, options);
    const skipped = marchVolume(gl, { ...options, occupancyTexture: derived.occupancyTexture });
    let paintedFull = 0;
    let lost = 0;
    let gained = 0;
    let maxDifference = 0;
    let sumDifference = 0;
    for (let y = 0; y < full.size; y++) {
      for (let x = 0; x < full.size; x++) {
        const a = full.alphaAt(x, y);
        const b = skipped.alphaAt(x, y);
        if (a > 0) paintedFull++;
        if (a > 2 && b === 0) lost++;
        if (b > 2 && a === 0) gained++;
        maxDifference = Math.max(maxDifference, Math.abs(a - b));
        sumDifference += Math.abs(a - b);
      }
    }
    gl.deleteTexture(built.texture);
    gl.deleteTexture(derived.lightTexture);
    gl.deleteTexture(derived.occupancyTexture);
    disposeDensityPipelineResources(gl);
    return {
      paintedFull,
      lost,
      gained,
      maxDifference,
      meanDifference: sumDifference / (full.size * full.size),
      occupancyGridSize: derived.occupancyGridSize,
      lightGridSize: derived.lightGridSize,
      error: gl.getError(),
    };
  }, [PROBE, DENSITY]);

  expect(comparison.error).toBe(0);
  expect(comparison.occupancyGridSize).toBe(16);
  expect(comparison.lightGridSize).toBe(32);
  expect(comparison.paintedFull).toBeGreaterThan(2000);
  // No pixel the full march paints is dropped by the skip, none is invented,
  // and the rest differ only by the sample phase a leap re-aligns.
  expect(comparison.lost).toBe(0);
  expect(comparison.gained).toBe(0);
  expect(comparison.meanDifference).toBeLessThan(0.5);
  expect(comparison.maxDifference).toBeLessThanOrEqual(24);
});
