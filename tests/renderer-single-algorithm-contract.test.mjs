import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';

const renderingRoot = new URL('../assets/js/rendering/', import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, renderingRoot), 'utf8');
}

test('velocity spawn tables are deterministic samples without replacement', () => {
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: { spawnTableSize: 128 },
  });
  const transparency = new Float32Array(512).fill(1);
  const originalNow = Date.now;

  try {
    Date.now = () => 123456789;
    const first = overlay._buildSpawnTable(transparency, 512, null);
    const second = overlay._buildSpawnTable(transparency, 512, null);

    assert.deepEqual(first, second);
    assert.equal(first.length, 128);
    assert.equal(new Set(first).size, first.length);
    assert.notDeepEqual(first, Uint32Array.from({ length: 128 }, (_, index) => index));
    assert.throws(
      () => overlay._buildSpawnTable(transparency, 512, new Int32Array([0, 1])),
      /must be a Uint32Array or null/
    );
  } finally {
    Date.now = originalNow;
  }
});

test('projectile collision owns one full-resolution query and one geometric normal', async () => {
  const projectileSource = await source('projectiles.js');

  assert.doesNotMatch(projectileSource, /queryRadiusAtLOD|avgNormal|opposite of velocity/i);
  assert.match(
    projectileSource,
    /const indices = spatialIndex\.queryRadius\(center, radius, maxResults\)/
  );
  assert.match(
    projectileSource,
    /vec3\.sub\(tempVec3, p\.position, closestHit\.position\)/
  );
});

test('smoke ray marching validates one camera-to-near-plane ray', async () => {
  const shaderSource = await source('shaders/smoke-shaders.js');
  const rayDirectionAssignments = shaderSource.match(/\brayDir\s*=/g) ?? [];

  assert.match(
    shaderSource,
    /vec3 rayVec = worldNear\.xyz - u_cameraPos;[\s\S]{0,500}vec3 rayDir = rayVec \/ rayDirLen;/
  );
  assert.equal(rayDirectionAssignments.length, 1);
  assert.doesNotMatch(
    shaderSource,
    /normalize\(worldNear\.xyz - u_cameraPos\)|worldFar\.xyz - worldNear\.xyz/
  );
});

test('GPU smoke noise requires only shader inputs that affect its exact output', async () => {
  const [generatorSource, noiseShaderSource] = await Promise.all([
    source('smoke-cloud/gpu-noise-generator.js'),
    source('shaders/noise-shaders.js'),
  ]);

  assert.doesNotMatch(generatorSource, /uniforms\.(?:shape|detail)[\s\S]{0,100}size:/);
  assert.doesNotMatch(generatorSource, /uniform1f\(uniforms\.size/);
  assert.doesNotMatch(noiseShaderSource, /uniform float u_size/);
});

test('snapshot rendering requires its owned GPU buffer', async () => {
  const viewerSource = await source('viewer.js');
  const resolverCalls = viewerSource.match(
    /requireSnapshotBufferId\(view\.id\)/g
  ) ?? [];

  assert.equal(resolverCalls.length, 3);
  assert.match(
    viewerSource,
    /function requireSnapshotBufferId\(viewId\)[\s\S]{0,500}has no published snapshot GPU buffer/
  );
  assert.doesNotMatch(
    viewerSource,
    /currentLoadedViewId|let hasSnapshotBuffer|hpRenderer\.updateColors\(snap\.colors\)|fallback/i
  );
});
