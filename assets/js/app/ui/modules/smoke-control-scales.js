/**
 * @fileoverview Slider scales of the Volumetric smoke controls.
 *
 * Every smoke slider is a 0–100 position. Each function here maps one
 * position to the renderer value it publishes and the readout printed beside
 * the slider. The mapping is fixed: no control rescales another, so a readout
 * means the same thing whatever the grid or noise resolution, and a recorded
 * readout reproduces an appearance.
 *
 * @module app/ui/modules/smoke-control-scales
 */

import {
  formatDecimal,
  formatMultiplier,
  formatPercent,
} from '../components/display-format.js';
import {
  SMOKE_GRID_SIZES,
  SMOKE_NOISE_RESOLUTIONS,
} from '../../../rendering/smoke-cloud/smoke-density-contract.js';

function requirePosition(position, label) {
  if (
    typeof position !== 'number'
    || !Number.isFinite(position)
    || position < 0
    || position > 100
  ) {
    throw new RangeError(`${label} must be a finite slider position from 0 to 100.`);
  }
  return position / 100;
}

function pickStep(steps, position, label) {
  const t = requirePosition(position, label);
  return steps[Math.min(steps.length - 1, Math.floor(t * steps.length))];
}

/** `Grid density` — edge length of the density volume. */
export function smokeGridScale(position) {
  const size = pickStep(SMOKE_GRID_SIZES, position, 'Smoke grid density');
  return { value: size, readout: `${size}³` };
}

/** `Noise detail` — edge length of the procedural noise volumes. */
export function smokeNoiseScale(position) {
  const size = pickStep(SMOKE_NOISE_RESOLUTIONS, position, 'Smoke noise detail');
  return { value: size, readout: `${size}³` };
}

/**
 * `Ray quality` — samples per occupied voxel along each ray, 0.5 to 2 on a
 * logarithmic scale (1.41 at the default). Cost is about proportional to it;
 * empty space costs the same at every setting.
 */
export function smokeRayQualityScale(position) {
  const t = requirePosition(position, 'Smoke ray quality');
  const samplesPerVoxel = 0.5 * Math.pow(4, t);
  const band = t < 0.33 ? 'Fast' : (t < 0.66 ? 'Balanced' : (t < 0.9 ? 'High' : 'Ultra'));
  return { value: samplesPerVoxel, readout: band };
}

/**
 * `Render resolution` — fraction of the canvas the ray march runs at, in
 * steps of 0.05 from 0.25× to 1.00×.
 */
export function smokeResolutionScale(position) {
  const t = requirePosition(position, 'Smoke render resolution');
  const scale = (5 + Math.round(t * 15)) / 20;
  return { value: scale, readout: formatMultiplier(scale, 2) };
}

/**
 * `Cloud density` — opacity, logarithmic from 0.05 to 5: equal slider
 * movements make equally noticeable changes, thin haze to solid cloud.
 */
export function smokeDensityScale(position) {
  const t = requirePosition(position, 'Smoke density');
  const density = 0.05 * Math.pow(100, t);
  return { value: density, readout: formatDecimal(density, density < 1 ? 2 : 1) };
}

/** `Fine detail` — strength and frequency of the detail noise, 0 to 5. */
export function smokeDetailScale(position) {
  const detailLevel = requirePosition(position, 'Smoke detail') * 5;
  return { value: detailLevel, readout: formatDecimal(detailLevel, 1) };
}

/** `Turbulence` — curl-noise warp, 0% to 100% (warp strength 0 to 2). */
export function smokeTurbulenceScale(position) {
  const t = requirePosition(position, 'Smoke turbulence');
  return { value: t * 2, readout: formatPercent(t * 100) };
}

/** `Animation speed` — 0 (still: no frames drawn while idle) to 2.5. */
export function smokeSpeedScale(position) {
  const speed = requirePosition(position, 'Smoke animation speed') * 2.5;
  return { value: speed, readout: speed === 0 ? 'Still' : formatDecimal(speed, 2) };
}

/** `Edge softness` — noise erosion of thin regions, 0 (off) to 2. */
export function smokeEdgeScale(position) {
  const edgeSoftness = requirePosition(position, 'Smoke edge softness') * 2;
  return { value: edgeSoftness, readout: formatDecimal(edgeSoftness, 1) };
}

/** `Light absorption` — shadow depth, 0 (no shadows) to 2. */
export function smokeAbsorptionScale(position) {
  const lightAbsorption = requirePosition(position, 'Smoke light absorption') * 2;
  return { value: lightAbsorption, readout: formatDecimal(lightAbsorption, 1) };
}

/** `Light scattering` — forward-scattering glow towards the light, 0 to 2. */
export function smokeScatterScale(position) {
  const scatterStrength = requirePosition(position, 'Smoke light scattering') * 2;
  return { value: scatterStrength, readout: formatDecimal(scatterStrength, 1) };
}

/** `Direct lighting` — key-light intensity, 0× to 2×. */
export function smokeDirectLightScale(position) {
  const intensity = requirePosition(position, 'Smoke direct light') * 2;
  return { value: intensity, readout: formatMultiplier(intensity, 2) };
}
