/**
 * Point stores on the GPU hold a geometry's points in its tree's draw order,
 * so slot k of a store is not cell k. No per-cell consumer may read those
 * stores with a source id:
 *
 * - nothing outside the renderer reaches its point buffers, vertex arrays,
 *   colour stores or draw-order records;
 * - the one shader that reads a per-cell texture by vertex maps the stored
 *   slot back to its source index through the order's permutation;
 * - every per-cell CPU consumer (highlight rings, picking, the cell card,
 *   lasso and proximity, KNN previews and edges, velocity, centroids, smoke,
 *   figure export, the benchmark, analysis read-backs) reads source-order
 *   arrays: the published positions, LOD membership in source ids, and the
 *   view's draw order as a list of source ids.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = 'assets/js/rendering/high-perf-renderer.js';

async function sources(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const FILES = await sources(path.join(ROOT, 'assets', 'js'));
const CODE = new Map(await Promise.all(FILES.map(async file => [
  path.relative(ROOT, file).split(path.sep).join('/'),
  await readFile(file, 'utf8'),
])));

function hits(pattern, { except = [] } = {}) {
  const found = [];
  for (const [file, text] of CODE) {
    if (except.includes(file)) continue;
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

test('nothing outside the renderer reaches its draw-ordered point stores', () => {
  // The renderer instance is reached as `hpRenderer` (viewer), `renderer`
  // (dev tools) or `ctx._hpRenderer` (overlays).
  assert.deepEqual(
    hits(
      /\b(?:hpRenderer|_hpRenderer|renderer)\??\.(?:buffers|snapshotBuffers|vao|_liveOrder|_liveColorOrder|_snapshotGeometryPools|_writeOrdered\w+|_createDrawOrderRecord)\b/,
      { except: [RENDERER] },
    ),
    [],
  );
  // Draw-order and colour-store records exist only in the renderer.
  assert.deepEqual(
    hits(/\bcolorOwner\b|\b_liveOrder\b|\bgeometry\.order\b|\b_advanceDrawOrderAdoption\b/, { except: [RENDERER] }),
    [],
  );
});

test('the point shader maps a stored slot back to its source index before any per-cell lookup', () => {
  const shaders = CODE.get('assets/js/rendering/shaders/high-perf-shaders.js');
  const lookups = shaders.match(/texelFetch\(u_alphaTex,/g) ?? [];
  assert.ok(lookups.length > 0);
  // Every per-cell alpha lookup is preceded by the permutation fetch.
  const routed = shaders.match(
    /int origIdx = u_useLodIndexTex\s*\? int\(texelFetch\(u_lodIndexTex, linearTexel\(gl_VertexID, u_lodIndexLayout\), 0\)\.r\)\s*: gl_VertexID;\s*alpha = texelFetch\(u_alphaTex, linearTexel\(origIdx, u_alphaLayout\), 0\)/g,
  ) ?? [];
  assert.equal(routed.length, lookups.length);
  // No other shader indexes a per-cell texture by gl_VertexID.
  const elsewhere = hits(/gl_VertexID/, {
    except: ['assets/js/rendering/shaders/high-perf-shaders.js'],
  }).filter(line => !/^\S+:\d+: \/\//.test(line));
  for (const line of elsewhere) {
    assert.doesNotMatch(line, /texelFetch|u_alphaTex|u_lodIndexTex/, line);
  }
  // The renderer binds the order's permutation whenever the per-cell alpha
  // texture is read from a draw-ordered store.
  const bind = HighPerfRenderer.prototype._bindPointAlpha.toString();
  assert.match(bind, /alphaTexture !== null && order !== null \? order : null/);
  assert.match(bind, /u_useLodIndexTex, permutation !== null \? 1 : 0/);
});

function silenceCalculationNotifications(t) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  Object.assign(notifications, {
    completeCalculation() {},
    failCalculation() {},
    hasNotification: () => true,
    startCalculation: () => 'consumer-contract',
  });
  t.after(() => Object.assign(notifications, previous));
}

test('per-cell CPU read-backs are source-order: positions, LOD membership and the draw order as source ids', t => {
  silenceCalculationNotifications(t);
  const pointCount = 2_000;
  const positions = new Float32Array(pointCount * 2);
  for (let id = 0; id < pointCount; id++) {
    positions[id * 2] = Math.cos(id * 0.37) * (id % 97);
    positions[id * 2 + 1] = Math.sin(id * 0.11) * (id % 89);
  }
  const tree = new SpatialIndex(positions, null, 2, 32, 8, { buildLOD: true });
  const drawOrder = tree.drawOrder;
  const level = 4;
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    currentDimensionLevel: 2,
    pointCount,
    snapshotBuffers: new Map(),
    spatialIndices: new Map([[2, tree]]),
    _liveGeometryGeneration: 1,
    _liveOrder: { drawOrder, texture: {}, width: pointCount, height: 1, byteLength: pointCount * 4 },
    _lodSequentialMemberships: new WeakMap(),
    _lodSpatialOwnerTokens: new WeakMap(),
    _perViewState: new Map([['live', { lastLodLevel: level }]]),
    _positions: positions,
    _snapshotGeometryPools: new Map(),
  });

  // The published positions are the source array itself, never a read-back
  // of a draw-ordered store.
  assert.strictEqual(renderer.getPositions(), positions);

  // LOD membership names source ids: the level's set, whatever the order.
  const indices = renderer.getCurrentLodIndices('live', 2);
  assert.deepEqual(
    new Set(indices),
    new Set(tree.lodLevels[level].indices),
  );
  for (const id of indices) assert.ok(id < pointCount);
  const sequential = renderer.getCurrentLodSequentialMembership('live', 2);
  assert.strictEqual(sequential.indices, indices);

  // The view's draw order is a list of source ids, one per stored slot:
  // drawing a figure in this order overlaps points as the pane does, and
  // every lookup it makes is by source id.
  const order = renderer.getViewDrawOrder('live');
  assert.strictEqual(order, drawOrder.indices);
  assert.deepEqual(
    Array.from(order).sort((a, b) => a - b),
    Array.from({ length: pointCount }, (_, id) => id),
  );
  // A reduced level's draw is the order's prefix: the same ids as its membership.
  assert.deepEqual(
    Array.from(order.subarray(0, tree.lodLevels[level].pointCount)),
    Array.from(indices),
  );

  // A geometry still in source order has no draw order to report.
  renderer._liveOrder = null;
  assert.equal(renderer.getViewDrawOrder('live'), null);
});
