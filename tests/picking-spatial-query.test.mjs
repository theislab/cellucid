/**
 * Screen-space picking (assets/js/rendering/picking.js): the cell is the dot
 * drawn under the pointer, sized exactly as the vertex shader sizes it. Hidden
 * cells and cells the current level of detail does not draw are never picked,
 * and the spatial-index traversal finds exactly what a full scan finds.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
import {
  PICK_TOLERANCE_CSS_PX,
  drawnPointRadiusCss,
  findScreenSpacePick,
} from '../assets/js/rendering/picking.js';

const FOV = (45 * Math.PI) / 180;
const PANE = Object.freeze({ cssWidth: 800, cssHeight: 600, framebufferHeight: 600 });

/** Column-major perspective × translate(0, 0, -distance): a camera on +Z looking at the origin. */
function cameraMvp(distance = 3, aspect = PANE.cssWidth / PANE.cssHeight, near = 0.1, far = 100) {
  const f = 1 / Math.tan(FOV / 2);
  const projection = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -distance, 1];
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += projection[k * 4 + row] * view[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Where a world point lands on the pane, in CSS pixels. */
function project(mvp, [x, y, z]) {
  const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  const ndcX = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w;
  const ndcY = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w;
  return { x: (ndcX * 0.5 + 0.5) * PANE.cssWidth, y: (0.5 - ndcY * 0.5) * PANE.cssHeight, w };
}

function pick(overrides) {
  return findScreenSpacePick({
    dimension: 3,
    transparency: new Uint8Array(overrides.positions.length / (overrides.dimension ?? 3)).fill(1),
    mvpMatrix: cameraMvp(),
    pane: PANE,
    pointSize: 8,
    sizeAttenuation: 0,
    fov: FOV,
    spatialIndex: null,
    ...overrides,
  });
}

function makeSpatialIndex(positions, dimension = 3) {
  return new SpatialIndex(positions, null, dimension, 4, 12, {
    buildLOD: false,
  });
}

test('the dot under the pointer wins over a nearer dot beside it', () => {
  // The reported defect: the old ray search took the first cell within a fixed
  // world radius of the ray, so a dot nearer the camera but beside the pointer
  // beat the dot drawn right under it.
  const mvp = cameraMvp();
  const under = [0, 0, 0];
  // 0.025 from the ray: inside the old 0.03 world radius, yet about 7.5 px
  // from the pointer, beyond its 4 px dot plus the 3 px tolerance.
  const nearerBeside = [0.025, 0, 0.6];
  const positions = Float32Array.from([...nearerBeside, ...under]);
  const cursor = project(mvp, under);
  const beside = project(mvp, nearerBeside);
  const besideRadius = drawnPointRadiusCss({
    w: beside.w, pointSize: 8, sizeAttenuation: 0, fov: FOV, framebufferHeight: 600, devicePixelRatio: 1,
  });
  assert.ok(Math.hypot(beside.x - cursor.x, beside.y - cursor.y) > besideRadius + PICK_TOLERANCE_CSS_PX);
  assert.equal(pick({ positions, mvpMatrix: mvp, cursor }).cellIndex, 1);
});

test('where drawn dots overlap, the front-most one is picked', () => {
  const mvp = cameraMvp();
  const back = [0, 0, -0.5];
  const front = [0.001, 0, 0.5];
  const positions = Float32Array.from([...back, ...front]);
  assert.equal(pick({ positions, mvpMatrix: mvp, cursor: project(mvp, [0, 0, 0]) }).cellIndex, 1);
});

test('the hit area is the drawn dot plus the tolerance, and follows point size', () => {
  const mvp = cameraMvp();
  const positions = Float32Array.from([0, 0, 0]);
  const centre = project(mvp, [0, 0, 0]);
  const cursor = { x: centre.x + 6, y: centre.y };
  // 16 px dot: radius 8 covers 6 px away.
  assert.equal(pick({ positions, mvpMatrix: mvp, cursor, pointSize: 16 }).cellIndex, 0);
  // 2 px dot: radius 1 plus 3 px of tolerance does not reach 6 px away.
  assert.equal(pick({ positions, mvpMatrix: mvp, cursor, pointSize: 2 }).cellIndex, -1);
  // Perspective attenuation grows a near dot exactly as the shader does.
  const radius = drawnPointRadiusCss({
    w: centre.w, pointSize: 2, sizeAttenuation: 1, fov: FOV, framebufferHeight: 600, devicePixelRatio: 1,
  });
  assert.equal(
    pick({ positions, mvpMatrix: mvp, cursor, pointSize: 2, sizeAttenuation: 1 }).cellIndex,
    6 <= radius + PICK_TOLERANCE_CSS_PX ? 0 : -1,
  );
});

test('a filtered-out cell is never picked; the visible cell behind it is', () => {
  const mvp = cameraMvp();
  const positions = Float32Array.from([0, 0, 0.5, 0, 0, -0.5]);
  const transparency = Uint8Array.of(0, 1);
  const cursor = project(mvp, [0, 0, 0]);
  assert.equal(pick({ positions, mvpMatrix: mvp, cursor, transparency }).cellIndex, 1);
  assert.equal(pick({ positions, mvpMatrix: mvp, cursor, transparency: Uint8Array.of(0, 0) }).cellIndex, -1);
});

test('a cell the current level of detail does not draw is never picked', () => {
  const mvp = cameraMvp();
  const positions = Float32Array.from([0, 0, 0.5, 0, 0, -0.5, 5, 5, 0]);
  const lodMembership = Object.freeze({
    admissionLevels: Uint8Array.from([0xff, 0, 0]),
    dimensionLevel: 3,
    generationToken: Object.freeze({}),
    indices: Uint32Array.of(1, 2),
    lodLevel: 0,
    pointCount: 3,
  });
  const cursor = project(mvp, [0, 0, 0]);
  assert.equal(pick({ positions, mvpMatrix: mvp, cursor }).cellIndex, 0);
  const coarse = pick({ positions, mvpMatrix: mvp, cursor, lodMembership });
  assert.equal(coarse.cellIndex, 1);
  assert.equal(coarse.examinedPointCount, 2);
});

test('a malformed level-of-detail certificate is refused', () => {
  const positions = Float32Array.from([0, 0, 0.1, 0, 0, 0.2]);
  const base = { positions, cursor: { x: 400, y: 300 } };
  const membership = ({ admissionLevels = Uint8Array.from([0, 0xff]), indices = Uint32Array.of(0), extra = false } = {}) => Object.freeze({
    admissionLevels,
    dimensionLevel: 3,
    generationToken: Object.freeze({}),
    indices,
    lodLevel: 0,
    pointCount: 2,
    ...(extra ? { unexpected: true } : {}),
  });
  assert.throws(() => pick({ ...base, lodMembership: membership({ extra: true }) }), /frozen renderer certificate/);
  assert.throws(() => pick({ ...base, lodMembership: membership({ indices: Uint32Array.of(2) }) }), /does not name an admitted source point/);
  assert.throws(() => pick({ ...base, lodMembership: membership({ admissionLevels: Uint8Array.from([0xff, 0]) }) }), /does not name an admitted source point/);
});

test('the spatial index finds exactly what a full scan finds', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pointCount = 4000;
  const positions = new Float32Array(pointCount * 3);
  for (let index = 0; index < positions.length; index++) positions[index] = random() * 2 - 1;
  const transparency = new Uint8Array(pointCount);
  for (let index = 0; index < pointCount; index++) transparency[index] = random() < 0.8 ? 1 : 0;
  const spatialIndex = makeSpatialIndex(positions);
  const mvp = cameraMvp(3.2);
  for (const attenuation of [0, 0.65, 1]) {
    for (let trial = 0; trial < 200; trial++) {
      const cursor = { x: random() * PANE.cssWidth, y: random() * PANE.cssHeight };
      const common = { positions, transparency, mvpMatrix: mvp, cursor, pointSize: 6, sizeAttenuation: attenuation };
      const direct = pick(common);
      const indexed = pick({ ...common, spatialIndex });
      assert.equal(indexed.cellIndex, direct.cellIndex, `trial ${trial}, attenuation ${attenuation}`);
      assert.ok(indexed.examinedPointCount <= direct.examinedPointCount);
    }
  }
});

test('a 2D or 1D layout picks exactly what its zero-padded XYZ copy picks', () => {
  const mvp = cameraMvp();
  const xyz = Float32Array.from([-0.2, 0.1, 0, 0.3, -0.2, 0, 0.05, 0.05, 0]);
  const xy = Float32Array.from([-0.2, 0.1, 0.3, -0.2, 0.05, 0.05]);
  const x = Float32Array.from([-0.2, 0.3, 0.05]);
  const xOnly = Float32Array.from([-0.2, 0, 0, 0.3, 0, 0, 0.05, 0, 0]);
  for (const target of [[-0.2, 0.1, 0], [0.3, -0.2, 0], [0.05, 0.05, 0]]) {
    const cursor = project(mvp, target);
    const expected = pick({ positions: xyz, mvpMatrix: mvp, cursor }).cellIndex;
    assert.equal(pick({ positions: xy, dimension: 2, mvpMatrix: mvp, cursor }).cellIndex, expected);
    assert.equal(
      pick({ positions: xy, dimension: 2, mvpMatrix: mvp, cursor, spatialIndex: makeSpatialIndex(xy, 2) }).cellIndex,
      expected,
    );
  }
  for (const target of [[-0.2, 0, 0], [0.3, 0, 0]]) {
    const cursor = project(mvp, target);
    assert.equal(
      pick({ positions: x, dimension: 1, mvpMatrix: mvp, cursor }).cellIndex,
      pick({ positions: xOnly, mvpMatrix: mvp, cursor }).cellIndex,
    );
  }
});

test('nothing behind the camera or outside the clip range is picked', () => {
  const mvp = cameraMvp(3, PANE.cssWidth / PANE.cssHeight, 0.1, 4);
  const cursor = project(mvp, [0, 0, 0]);
  // Behind the camera (z beyond +3) and past the far plane (z below -1).
  const positions = Float32Array.from([0, 0, 3.5, 0, 0, -1.5]);
  assert.equal(pick({ positions, mvpMatrix: mvp, cursor }).cellIndex, -1);
});

test('picking input is validated', () => {
  const positions = Float32Array.from([0, 0, 0]);
  assert.throws(() => pick({ positions, cursor: { x: 1, y: 1 }, mvpMatrix: new Float32Array(15) }), /16 values/);
  assert.throws(() => pick({ positions, cursor: { x: Number.NaN, y: 1 } }), /cursor.x/);
  assert.throws(() => pick({ positions, cursor: { x: 1, y: 1 }, pane: { ...PANE, cssWidth: 0 } }), /cssWidth/);
  assert.throws(() => pick({ positions, cursor: { x: 1, y: 1 }, pointSize: 0 }), /pointSize/);
  assert.throws(
    () => pick({ positions, cursor: { x: 1, y: 1 }, spatialIndex: makeSpatialIndex(Float32Array.from([1, 1, 1])) }),
    /exact matching spatial owner/,
  );
});
