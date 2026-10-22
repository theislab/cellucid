// The Volumetric smoke sliders: fixed, independent scales whose readouts mean
// the same thing at every grid and noise resolution, and markup whose static
// readouts are exactly what the scales print for the shipped positions.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  smokeAbsorptionScale,
  smokeDensityScale,
  smokeDetailScale,
  smokeDirectLightScale,
  smokeEdgeScale,
  smokeGridScale,
  smokeNoiseScale,
  smokeRayQualityScale,
  smokeResolutionScale,
  smokeScatterScale,
  smokeSpeedScale,
  smokeTurbulenceScale,
} from '../assets/js/app/ui/modules/smoke-control-scales.js';
import {
  MAX_SMOKE_GRID_SIZE,
  MAX_SMOKE_NOISE_RESOLUTION,
  SMOKE_GRID_SIZES,
  SMOKE_NOISE_RESOLUTIONS,
} from '../assets/js/rendering/smoke-cloud/smoke-density-contract.js';
import {
  MAX_SMOKE_RESOLUTION_SCALE,
  MIN_SMOKE_RESOLUTION_SCALE,
} from '../assets/js/rendering/smoke-cloud/smoke-renderer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');

const SLIDERS = [
  ['smoke-grid', smokeGridScale],
  ['smoke-steps', smokeRayQualityScale],
  ['cloud-resolution', smokeResolutionScale],
  ['noise-resolution', smokeNoiseScale],
  ['smoke-density', smokeDensityScale],
  ['smoke-detail', smokeDetailScale],
  ['smoke-warp', smokeTurbulenceScale],
  ['smoke-speed', smokeSpeedScale],
  ['smoke-edge', smokeEdgeScale],
  ['smoke-absorption', smokeAbsorptionScale],
  ['smoke-scatter', smokeScatterScale],
  ['smoke-direct-light', smokeDirectLightScale],
];

function markupSlider(id) {
  const input = new RegExp(
    `<input id="${id}" type="range" min="0" max="100" step="1" value="(\\d+)" />`
  ).exec(INDEX_HTML);
  assert.ok(input, `${id} is not a 0-100 step-1 range in index.html`);
  const display = new RegExp(
    `<span id="${id}-display" class="slider-value">([^<]*)</span>`
  ).exec(INDEX_HTML);
  assert.ok(display, `${id}-display is missing from index.html`);
  return { position: Number(input[1]), readout: display[1] };
}

test('every smoke slider ships the readout its scale prints for its position', () => {
  for (const [id, scale] of SLIDERS) {
    const { position, readout } = markupSlider(id);
    assert.equal(
      scale(position).readout,
      readout,
      `${id} at ${position} prints ${scale(position).readout}, markup says ${readout}`
    );
  }
});

test('every continuous smoke scale is monotone over the whole slider', () => {
  for (const [id, scale] of SLIDERS) {
    let previous = -Infinity;
    for (let position = 0; position <= 100; position++) {
      const { value } = scale(position);
      assert.ok(Number.isFinite(value), `${id} at ${position} is not finite`);
      assert.ok(value >= previous, `${id} decreases at ${position}`);
      previous = value;
    }
  }
});

test('smoke scales reject positions outside the slider', () => {
  for (const [id, scale] of SLIDERS) {
    for (const position of [-1, 101, Number.NaN, Infinity]) {
      assert.throws(() => scale(position), RangeError, `${id} accepted ${position}`);
    }
  }
});

test('grid and noise sliders reach exactly the allocatable sizes', () => {
  const grids = new Set();
  const noises = new Set();
  for (let position = 0; position <= 100; position++) {
    grids.add(smokeGridScale(position).value);
    noises.add(smokeNoiseScale(position).value);
  }
  assert.deepEqual([...grids], [...SMOKE_GRID_SIZES]);
  assert.deepEqual([...noises], [...SMOKE_NOISE_RESOLUTIONS]);
  assert.equal(Math.max(...grids), MAX_SMOKE_GRID_SIZE);
  assert.equal(Math.max(...noises), MAX_SMOKE_NOISE_RESOLUTION);
});

test('render resolution spans exactly what the renderer accepts, never supersampling', () => {
  assert.equal(smokeResolutionScale(0).value, MIN_SMOKE_RESOLUTION_SCALE);
  assert.equal(smokeResolutionScale(100).value, MAX_SMOKE_RESOLUTION_SCALE);
  assert.equal(MAX_SMOKE_RESOLUTION_SCALE, 1);
  for (let position = 0; position <= 100; position++) {
    const { value, readout } = smokeResolutionScale(position);
    // Readouts are exact twentieths, so a readout reproduces the scale.
    assert.equal(value * 20, Math.round(value * 20));
    assert.equal(readout, `${value.toFixed(2)}×`);
  }
});

test('ray quality bands are ordered and the shipped default is High', () => {
  assert.equal(smokeRayQualityScale(0).readout, 'Fast');
  assert.equal(smokeRayQualityScale(50).readout, 'Balanced');
  assert.equal(smokeRayQualityScale(75).readout, 'High');
  assert.equal(smokeRayQualityScale(100).readout, 'Ultra');
  assert.equal(smokeRayQualityScale(0).value, 0.5);
  assert.equal(smokeRayQualityScale(100).value, 2);
  assert.equal(markupSlider('smoke-steps').position, 75);
});

test('animation speed zero reads Still: the view is not redrawn while idle', () => {
  assert.deepEqual(smokeSpeedScale(0), { value: 0, readout: 'Still' });
  assert.equal(smokeSpeedScale(40).readout, '1.00');
});
