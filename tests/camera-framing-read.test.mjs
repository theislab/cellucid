// `camera.framing` (`app/reads/framing.js`): where groups sit in a view and
// cameras that frame them, measured here through the same perspective the
// viewer draws with (45° on the shorter side, the view's own shape): each
// group centered, filling about the share of the frame asked for, hidden cells
// left out, a 2D view framed flat (planar) and a 3D one from the direction
// asked for (lane-director L2-1).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFramingReads } from '../assets/js/app/reads/framing.js';

const FOV = 45 * Math.PI / 180;

/** Deterministic normal noise (mulberry32, Box–Muller). */
function noise(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

function scene({ dimension, groups, hidden = [] }) {
  const positions = [];
  const codes = [];
  groups.forEach(({ center, spread, n }, code) => {
    const next = noise(code + 7);
    for (let i = 0; i < n; i++) {
      // Packed as the viewer holds them: as many coordinates per cell as dimensions.
      const cell = [center[0] + spread[0] * next(), center[1] + spread[1] * next(), center[2] + spread[2] * next()];
      positions.push(...cell.slice(0, dimension));
      codes.push(code);
    }
  });
  const pointCount = codes.length;
  const transparency = new Float32Array(pointCount).map((_, i) => (hidden.includes(codes[i]) ? 0 : 1));
  const field = { key: 'cell_type', kind: 'category', categories: groups.map(g => g.label), codes: Uint8Array.from(codes) };
  const state = {
    pointCount,
    obsData: { fields: [field] },
    getFields: () => [field],
    getVarFields: () => [],
    getActiveViewId: () => 'live',
    ensureFieldLoaded: async () => field,
    describeViewEmbedding: () => ({ name: 'UMAP', dimension }),
  };
  const viewer = {
    getCameraParams: () => ({ fov: FOV }),
    getPresentedLayout: () => ({ panes: [{ viewId: 'live', visibleCssWidth: 1200, visibleCssHeight: 800 }] }),
    getViewCameraState: () => ({ navigationMode: dimension === 3 ? 'orbit' : 'planar', orbit: { theta: Math.PI / 4, phi: Math.PI / 4, radius: 3, targetRadius: 3, target: [0, 0, 0] } }),
    withBorrowedViewData: (viewId, callback) => callback({ positions: Float32Array.from(positions), transparency, pointCount, dimensionLevel: dimension }),
    getSnapshotViews: () => [],
    getLiveViewHidden: () => false,
    getViewLayout: () => ({ mode: 'single', activeId: 'live', liveViewHidden: false }),
    getLiveViewLabel: () => 'cell_type',
  };
  return { state, viewer, positions, codes, transparency };
}

/** Project the shown cells of `code` with a camera; their 2.5–97.5% ranges as fractions of the half frame. */
function measure({ positions, codes, transparency }, code, camera) {
  const { target, radius, theta, phi } = camera.orbit;
  const toward = camera.navigationMode === 'planar' ? [0, 0, 1] : [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
  const eye = target.map((v, a) => v + radius * toward[a]);
  const forward = toward.map(v => -v);
  let right = [-forward[2], 0, forward[0]];
  if (camera.navigationMode === 'planar') right = [1, 0, 0];
  const length = Math.hypot(...right);
  right = right.map(v => v / length);
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  const tanY = Math.tan(FOV / 2);
  const tanX = tanY * 1.5;
  const xs = [];
  const ys = [];
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] !== code || !(transparency[i] > 0)) continue;
    const dimension = positions.length / codes.length;
    const q = [0, 1, 2].map(a => (a < dimension ? positions[i * dimension + a] : 0) - eye[a]);
    const ahead = q[0] * forward[0] + q[1] * forward[1] + q[2] * forward[2];
    xs.push((q[0] * right[0] + q[1] * right[1] + q[2] * right[2]) / (ahead * tanX));
    ys.push((q[0] * up[0] + q[1] * up[1] + q[2] * up[2]) / (ahead * tanY));
  }
  const range = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return [sorted[Math.floor(0.025 * (sorted.length - 1))], sorted[Math.floor(0.975 * (sorted.length - 1))]];
  };
  const [x0, x1] = range(xs);
  const [y0, y1] = range(ys);
  return { fill: Math.max((x1 - x0) / 2, (y1 - y0) / 2), center: [(x0 + x1) / 2, (y0 + y1) / 2] };
}

const GROUPS = [
  { label: 'Ductal', center: [-0.6, 0.5, -0.2], spread: [0.15, 0.1, 0.08], n: 900 },
  { label: 'Beta', center: [0.5, -0.6, 0.3], spread: [0.08, 0.2, 0.12], n: 600 },
  { label: 'Delta', center: [0.1, 0.1, 0.6], spread: [0.03, 0.03, 0.03], n: 300 },
];

for (const dimension of [2, 3]) {
  test(`a ${dimension}D view: each category framed centered, filling about the share asked for`, async () => {
    const world = scene({ dimension, groups: GROUPS });
    const reads = createFramingReads(world);
    for (const fill of [0.8, 0.4]) {
      const result = await reads.framing({ field: { source: 'obs', key: 'cell_type' }, fill, azimuth: 60, elevation: 20 }, { signal: null });
      assert.equal(result.navigation, dimension === 3 ? 'orbit' : 'planar');
      assert.equal(result.groups.length, 3);
      result.groups.forEach((group, code) => {
        assert.equal(group.camera.navigationMode, result.navigation);
        const seen = measure(world, code, group.camera);
        assert.ok(Math.abs(seen.fill - fill) < 0.2 * fill + 0.02, `${group.label} at fill ${fill}: fills ${seen.fill.toFixed(3)}`);
        assert.ok(Math.hypot(...seen.center) < 0.08, `${group.label}: off center by ${seen.center.map(v => v.toFixed(3))}`);
      });
    }
  });
}

test('categories named are framed each and together; hidden ones are said, never framed', async () => {
  const world = scene({ dimension: 3, groups: GROUPS, hidden: [2] });
  const reads = createFramingReads(world);
  const result = await reads.framing({ field: { source: 'obs', key: 'cell_type' }, categories: ['Ductal', 'Beta', 'Delta'], fill: 0.8 }, { signal: null });
  assert.deepEqual(result.groups.map(group => group.label), ['Ductal', 'Beta']);
  assert.deepEqual(result.not_shown, ['Delta']);
  assert.equal(result.together.cells, 1500, 'Ductal and Beta: Delta is hidden');
  assert.equal(result.whole.cells, 1500);
  // The view's own direction when none is asked.
  assert.deepEqual(result.direction, { azimuth: 45, elevation: 45 });
  await assert.rejects(
    reads.framing({ field: { source: 'obs', key: 'cell_type' }, categories: ['Delta'], fill: 0.8 }, { signal: null }),
    { name: 'ActionRefused', message: /has no cells shown in View 1/ }
  );
  await assert.rejects(
    reads.framing({ categories: ['Beta'], fill: 0.8 }, { signal: null }),
    { name: 'ActionRefused', message: 'Categories are named with the field they belong to: give field too.' }
  );
});

test('a shot through another population says so (foreground); from the other side it is clear', async () => {
  const world = scene({
    dimension: 3,
    groups: [
      { label: 'Subject', center: [0, 0, 0], spread: [0.1, 0.1, 0.1], n: 400 },
      { label: 'In the way', center: [0.45, 0, 0], spread: [0.08, 0.15, 0.15], n: 400 },
    ],
  });
  const reads = createFramingReads(world);
  const frame = azimuth => reads.framing({ field: { source: 'obs', key: 'cell_type' }, categories: ['Subject'], azimuth, elevation: 0, fill: 0.6 }, { signal: null });
  const through = (await frame(0)).groups[0];
  const clear = (await frame(180)).groups[0];
  assert.ok(through.foreground > 0.3, `through the other population: foreground ${through.foreground}`);
  assert.equal(clear.foreground, 0, 'from the other side nothing is in front');
  assert.ok(through.nearest < clear.nearest, `the other population comes nearer (${through.nearest} vs ${clear.nearest})`);
});
