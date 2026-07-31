// The smoke shaders address two things that no other test pins down: which mip
// level the ray march reads, and which texel of the density volume a world
// position lands on. Both are silent when wrong -- the picture still renders,
// just wider than the data and off the cells it represents -- so the contract
// is asserted here in source, and measured end to end in
// tests/browser/smoke-volume-reconstruction.spec.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '..');
const SMOKE_SHADERS = path.join(
  REPOSITORY_ROOT,
  'assets/js/rendering/shaders/smoke-shaders.js'
);
const DENSITY_SHADERS = path.join(
  REPOSITORY_ROOT,
  'assets/js/rendering/shaders/density-shaders.js'
);

function read(filename) {
  return fs.readFileSync(filename, 'utf8');
}

function section(source, marker, terminator) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} is missing`);
  const end = source.indexOf(terminator, start + marker.length);
  assert.notEqual(end, -1, `${marker} is not terminated by ${terminator}`);
  return source.slice(start, end);
}

// Every sampler the ray march reads is minified through a mip chain:
// smoke-density.js builds the density volume LINEAR_MIPMAP_LINEAR for the
// empty-space skip, and gpu-noise-generator.js does the same for both noise
// volumes. GLSL ES 3.00 leaves screen-space derivatives undefined in
// non-uniform control flow, and the march loop is nothing but non-uniform
// control flow -- it breaks on transmittance and continues on empty space. An
// implicit level there is an undefined level.
const MIPMAPPED_SAMPLERS = ['u_densityTex3D', 'u_shapeNoise', 'u_detailNoise'];

test('the smoke ray march never selects a mip level implicitly', () => {
  const source = read(SMOKE_SHADERS);
  const marchSource = section(
    source,
    'export const SMOKE_FS_SOURCE',
    'export const SMOKE_COMPOSITE_VS'
  );
  const implicit = [];
  for (const line of marchSource.split('\n')) {
    if (!/(?<![A-Za-z0-9_])texture\s*\(/.test(line)) continue;
    implicit.push(line.trim());
  }
  assert.deepEqual(
    implicit,
    [],
    'the ray march must read every sampler with textureLod:\n' +
    implicit.join('\n')
  );
  for (const sampler of MIPMAPPED_SAMPLERS) {
    assert.ok(
      marchSource.includes(`textureLod(${sampler}`),
      `${sampler} is not read with an explicit level`
    );
  }
});

test('the density volume is addressed only through the splat index map', () => {
  const smoke = read(SMOKE_SHADERS);
  const marchSource = section(
    smoke,
    'export const SMOKE_FS_SOURCE',
    'export const SMOKE_COMPOSITE_VS'
  );

  // Reader: normalized volume position -> texture coordinate.
  const readerMap =
    'return (clamp(p01, 0.0, 1.0) * (grid - 1.0) + 0.5) / grid;';
  assert.ok(
    marchSource.includes(readerMap),
    'densityTexCoord no longer implements the splat index map'
  );

  // Writer: world position in [-1,1] -> splat index.
  const writerMap =
    'vec3 fp = (a_position + halfExtent) / (2.0 * halfExtent) * (gridSize - 1.0);';
  assert.ok(
    read(DENSITY_SHADERS).includes(writerMap),
    'the splat no longer maps positions onto (gridSize - 1) index space'
  );

  // The two above, as arithmetic. A 3D texture places texel i at
  // (i + 0.5) / gridSize, so the reader's coordinate must invert to exactly the
  // index the writer chose, for every grid size and every position.
  const writerIndex = (position, gridSize) =>
    ((position + 1) / 2) * (gridSize - 1);
  const readerIndex = (position, gridSize) => {
    const normalized = (position + 1) / 2;
    const coordinate = (normalized * (gridSize - 1) + 0.5) / gridSize;
    return coordinate * gridSize - 0.5;
  };
  for (const gridSize of [8, 32, 48, 64, 96, 128]) {
    for (let step = 0; step <= 16; step++) {
      const position = -1 + (2 * step) / 16;
      assert.ok(
        Math.abs(writerIndex(position, gridSize) - readerIndex(position, gridSize)) < 1e-9,
        `grid ${gridSize} position ${position} splats to index ` +
        `${writerIndex(position, gridSize)} but reads back ` +
        `${readerIndex(position, gridSize)}`
      );
    }
  }

  // Both the full sample and the conservative empty-space skip must go through
  // it; a skip on a half-texel-shifted copy is not conservative about the
  // voxels the full sample then reads.
  const densityReads = marchSource
    .split('\n')
    .filter(line => line.includes('u_densityTex3D') && line.includes('textureLod'));
  assert.equal(densityReads.length, 2, 'expected exactly two density reads');
  for (const line of densityReads) {
    assert.ok(
      line.includes('densityTexCoord('),
      `density read does not go through densityTexCoord: ${line.trim()}`
    );
  }
});

test('the upsample composite gates on alpha, where the silhouette is', () => {
  const source = read(SMOKE_SHADERS);
  const composite = section(
    source,
    'export const SMOKE_COMPOSITE_FS',
    '\n`;'
  );
  const weightLines = composite
    .split('\n')
    .filter(line => /^\s*float w[1-8] =/.test(line));
  assert.equal(weightLines.length, 8, 'expected eight tap weights');
  for (const line of weightLines) {
    assert.ok(
      /exp\(-abs\(c[1-8]\.a - c0\.a\) \* gate\)/.test(line),
      `tap weight is not an alpha range weight: ${line.trim()}`
    );
    // The offscreen target is premultiplied, so rgb is alpha scaled by the
    // lighting: gating on it makes the filter's geometry follow the sliders.
    assert.ok(
      !line.includes('.rgb'),
      `tap weight reads rgb: ${line.trim()}`
    );
  }

  // Nothing declared and never used.
  const declarations = composite.matchAll(/^\s*(?:const\s+)?(?:float|vec[234]) (\w+)\s*=/gm);
  for (const [, name] of declarations) {
    const uses = composite.split(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`)).length - 1;
    assert.ok(uses > 1, `${name} is declared and never read`);
  }
});
