/**
 * No draw call may submit more vertices than every engine accepts.
 *
 * Firefox refuses a draw over 30,000,000 vertex ids with INVALID_OPERATION and
 * draws nothing, so a full-detail frame above 30M points used to be blank
 * there. Every draw whose vertex count grows with the data goes through
 * `drawPointsInSegments`, which submits the same vertices in the same order as
 * consecutive calls of at most `MAX_VERTICES_PER_DRAW`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_VERTICES_PER_DRAW,
  drawPointsInSegments,
} from '../assets/js/rendering/gl-utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIREFOX_MAX_VERTEX_IDS_PER_DRAW = 30_000_000;

function recordingGl() {
  const calls = [];
  return {
    POINTS: 0,
    calls,
    drawArrays(mode, first, count) {
      calls.push({ mode, first, count });
    },
  };
}

test('segments stay under the Firefox per-draw limit', () => {
  assert.ok(MAX_VERTICES_PER_DRAW <= FIREFOX_MAX_VERTEX_IDS_PER_DRAW);
  assert.equal(MAX_VERTICES_PER_DRAW, 2 ** 24);
});

test('segments cover the range exactly, in order, with no gap or overlap', () => {
  for (const [first, count] of [
    [0, 0],
    [0, 1],
    [7, MAX_VERTICES_PER_DRAW - 1],
    [0, MAX_VERTICES_PER_DRAW],
    [0, MAX_VERTICES_PER_DRAW + 1],
    [123, 30_000_001],
    [0, 100_000_000],
    [5_000_000, 250_000_000],
  ]) {
    const gl = recordingGl();
    const calls = drawPointsInSegments(gl, first, count);
    assert.equal(calls, gl.calls.length);
    assert.equal(calls, Math.ceil(count / MAX_VERTICES_PER_DRAW));
    let next = first;
    for (const call of gl.calls) {
      assert.equal(call.mode, gl.POINTS);
      assert.equal(call.first, next);
      assert.ok(call.count > 0 && call.count <= MAX_VERTICES_PER_DRAW);
      next += call.count;
    }
    assert.equal(next, first + count);
  }
});

function listSources(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSources(full));
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Draws whose vertex count is bounded by a constant that is not the data
// size. Each entry names the file, the exact count expression and why it is
// bounded; anything else must use drawPointsInSegments.
const BOUNDED_POINT_DRAWS = new Map([
  ['assets/js/rendering/viewer.js', new Set([
    'numPoints', // one centroid a category (at most 65,535)
    'snapshot.count', // one centroid a category of a kept view
  ])],
  ['assets/js/rendering/projectiles.js', new Set([
    'projectilePointCount', // live projectiles and their trails
    'count', // impact flashes
  ])],
  ['assets/js/rendering/smoke-cloud/smoke-density.js', new Set([
    'batchPointCount', // splat batches of at most MAX_SPLAT_POINTS_PER_BATCH
  ])],
  ['assets/js/rendering/overlays/velocity/velocity-overlay.js', new Set([
    'particleState.activeParticleCount', // the particle pool, at most the spawn table
  ])],
  ['assets/js/rendering/backdrops/backdrop-look-renderer.js', new Set([
    'MOTE_COUNT', // Abyss marine snow: a fixed 3,200 sprites
  ])],
]);

test('every data-sized point draw is segmented', () => {
  const offenders = [];
  for (const file of listSources(path.join(ROOT, 'assets/js'))) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (relative === 'assets/js/rendering/gl-utils.js') continue;
    const source = readFileSync(file, 'utf8');
    const pattern = /\.drawArrays\(\s*gl\.POINTS\s*,\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/g;
    for (const match of source.matchAll(pattern)) {
      const count = match[2].trim();
      if (BOUNDED_POINT_DRAWS.get(relative)?.has(count)) continue;
      offenders.push(`${relative}: drawArrays(POINTS, ${match[1]}, ${count})`);
    }
  }
  assert.deepEqual(offenders, []);
});
