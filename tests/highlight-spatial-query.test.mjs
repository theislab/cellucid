import assert from 'node:assert/strict';
import test from 'node:test';

import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';
import { POINT_VISIBILITY_THRESHOLD } from '../assets/js/rendering/alpha-visibility.js';
import {
  LassoHitTest,
  ProximityHitTest,
} from '../assets/js/rendering/selection-gesture-queries.js';
import {
  findScreenSpacePick,
} from '../assets/js/rendering/picking.js';

function identityMatrix() {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  return matrix;
}

function makeViewport() {
  return {
    vpWidth: 160,
    vpHeight: 120,
    vpOffsetX: 25,
    vpOffsetY: 15,
    visibleOffsetX: 25,
    visibleOffsetY: 15,
    visibleWidth: 160,
    visibleHeight: 120,
  };
}

// The selection rules, written out cell by cell: the even-odd test over the
// path's vertices in drawing order, on each drawn cell's projected
// pane-local position.
function referenceLasso({ path, mvp, viewport, transparency, positions, dimensionLevel }) {
  if (path.length < 3) return [];
  const local = path.map(point => ({
    x: point.x - viewport.vpOffsetX,
    y: point.y - viewport.vpOffsetY,
  }));
  const minX = viewport.visibleOffsetX - viewport.vpOffsetX;
  const minY = viewport.visibleOffsetY - viewport.vpOffsetY;
  const out = [];
  for (let cell = 0; cell < transparency.length; cell++) {
    if (!(transparency[cell] >= POINT_VISIBILITY_THRESHOLD)) continue;
    const base = cell * dimensionLevel;
    const px = positions[base];
    const py = dimensionLevel > 1 ? positions[base + 1] : 0;
    const pz = dimensionLevel > 2 ? positions[base + 2] : 0;
    const clipX = mvp[0] * px + mvp[4] * py + mvp[8] * pz + mvp[12];
    const clipY = mvp[1] * px + mvp[5] * py + mvp[9] * pz + mvp[13];
    const clipZ = mvp[2] * px + mvp[6] * py + mvp[10] * pz + mvp[14];
    const clipW = mvp[3] * px + mvp[7] * py + mvp[11] * pz + mvp[15];
    if (Math.abs(clipW) < 1e-10) continue;
    const ndcZ = clipZ / clipW;
    if (ndcZ < -1 || ndcZ > 1) continue;
    const x = (clipX / clipW + 1) * 0.5 * viewport.vpWidth;
    const y = (1 - clipY / clipW) * 0.5 * viewport.vpHeight;
    if (x < minX || x > minX + viewport.visibleWidth || y < minY || y > minY + viewport.visibleHeight) continue;
    let inside = false;
    for (let i = 0, j = local.length - 1; i < local.length; j = i++) {
      const xi = local[i].x, yi = local[i].y;
      const xj = local[j].x, yj = local[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    if (inside) out.push(cell);
  }
  return out;
}

function referenceProximity({ center, radius, transparency, positions, dimensionLevel }) {
  if (radius === 0) return [];
  const out = [];
  for (let cell = 0; cell < transparency.length; cell++) {
    if (!(transparency[cell] >= POINT_VISIBILITY_THRESHOLD)) continue;
    const base = cell * dimensionLevel;
    const dx = positions[base] - center[0];
    const dy = (dimensionLevel > 1 ? positions[base + 1] : 0) - center[1];
    const dz = (dimensionLevel > 2 ? positions[base + 2] : 0) - center[2];
    if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(cell);
  }
  return out;
}

function lassoHits({ path, mvp, viewport, transparency, positions, dimensionLevel }) {
  const lasso = new LassoHitTest({
    positions,
    dimensionLevel,
    transparency,
    mvpMatrix: mvp,
    viewport,
  });
  lasso.prepare(Infinity);
  for (const point of path) lasso.appendVertex(point.x, point.y);
  return lasso.hits().toArray();
}

function makeSpatialIndex(
  positions,
  dimensionLevel,
  maxPointsPerNode = 8,
) {
  return new SpatialIndex(
    positions,
    null,
    dimensionLevel,
    maxPointsPerNode,
    18,
    {
      buildLOD: false,
    },
  );
}

test('lasso and proximity queries answer every move exactly as the cell-by-cell rule', () => {
  let randomState = 0x51f15e;
  const random = () => {
    randomState = (
      Math.imul(randomState, 1664525) + 1013904223
    ) >>> 0;
    return randomState / 0x100000000;
  };

  for (const dimensionLevel of [1, 2, 3]) {
    const pointCount = 40_000;
    // Exactly `dimensionLevel` components per cell.
    const positions = new Float32Array(pointCount * dimensionLevel);
    const transparency = new Uint8Array(pointCount);
    const axisRange = [[4, -2], [4, -2], [2.8, -1.4]];
    for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
      const offset = cellIndex * dimensionLevel;
      for (let axis = 0; axis < dimensionLevel; axis++) {
        positions[offset + axis] =
          random() * axisRange[axis][0] + axisRange[axis][1];
      }
      transparency[cellIndex] = cellIndex % 17 === 0 ? 0 : 1;
    }
    // A cell without a position is never selected.
    positions[3 * dimensionLevel] = Number.NaN;

    const center = [0.1, -0.15, 0.05];
    const proximity = new ProximityHitTest({
      positions,
      dimensionLevel,
      transparency,
      center,
    });
    proximity.setRadius(0.42);
    // A past deadline: one chunk of the pass a call.
    let slices = 1;
    while (!proximity.prepare(0)) slices++;
    assert.ok(slices > 2, 'the distance pass runs in slices');
    // Growing, shrinking, zero and covering-everything radii, and radii that
    // land exactly on a cell's distance.
    const onCell = cell => {
      const base = cell * dimensionLevel;
      const dx = positions[base] - center[0];
      const dy = (dimensionLevel > 1 ? positions[base + 1] : 0) - center[1];
      const dz = (dimensionLevel > 2 ? positions[base + 2] : 0) - center[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    for (const radius of [0.42, 0.43, 1.7, 0.2, 0, 9, onCell(11), onCell(12345), 0.05]) {
      proximity.setRadius(radius);
      assert.deepEqual(
        proximity.hits().toArray(),
        referenceProximity({ center, radius, transparency, positions, dimensionLevel }),
        `${dimensionLevel}D proximity at ${radius}`
      );
    }

    const viewport = makeViewport();
    const mvp = identityMatrix();
    // Pane-local cell positions, so vertices can sit exactly on cells.
    const cellOnPane = cell => ({
      x: (positions[cell * dimensionLevel] + 1) * 0.5 * 160 + 25,
      y: (1 - (dimensionLevel > 1 ? positions[cell * dimensionLevel + 1] : 0)) * 0.5 * 120 + 15,
    });
    const paths = {
      convex: [{ x: 73, y: 40 }, { x: 131, y: 37 }, { x: 146, y: 72 }, { x: 112, y: 104 }, { x: 66, y: 83 }],
      // A figure eight and a pentagram cross themselves.
      figureEight: Array.from({ length: 120 }, (_, index) => {
        const angle = 2 * Math.PI * index / 120;
        return { x: 105 + 70 * Math.sin(angle), y: 75 + 70 * Math.sin(angle) * Math.cos(angle) };
      }),
      pentagram: Array.from({ length: 5 }, (_, index) => {
        const angle = 4 * Math.PI * index / 5;
        return { x: 105 + 55 * Math.cos(angle), y: 75 + 55 * Math.sin(angle) };
      }),
      // Vertices on cells, and a horizontal edge through a cell.
      onCells: [cellOnPane(5), cellOnPane(6), cellOnPane(7), cellOnPane(8), cellOnPane(9)],
      horizontal: [
        { x: 30, y: cellOnPane(21).y }, { x: 180, y: cellOnPane(21).y },
        { x: 180, y: 130 }, { x: 30, y: 130 },
      ],
      // Partly beyond the presented pane.
      offPane: [{ x: 150, y: 10 }, { x: 260, y: 30 }, { x: 240, y: 160 }, { x: 140, y: 120 }],
    };
    for (const [name, path] of Object.entries(paths)) {
      const lasso = new LassoHitTest({
        positions,
        dimensionLevel,
        transparency,
        mvpMatrix: mvp,
        viewport,
      });
      lasso.appendVertex(path[0].x, path[0].y);
      while (!lasso.prepare(0));
      for (let count = 1; count < path.length; count++) {
        lasso.appendVertex(path[count].x, path[count].y);
        assert.deepEqual(
          lasso.hits().toArray(),
          referenceLasso({
            path: path.slice(0, count + 1),
            mvp,
            viewport,
            transparency,
            positions,
            dimensionLevel,
          }),
          `${dimensionLevel}D ${name} lasso after ${count + 1} vertices`
        );
      }
    }
  }
});

test('proximity selection has no cap and holds every cell once', () => {
  const pointCount = 513;
  const positions = new Float32Array(pointCount * 3);
  const transparency = new Uint8Array(pointCount).fill(1);
  for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
    const offset = cellIndex * 3;
    positions[offset] = (cellIndex % 9) * 0.0001;
    positions[offset + 1] = (cellIndex % 7) * 0.0001;
    positions[offset + 2] = (cellIndex % 5) * 0.0001;
  }
  const proximity = new ProximityHitTest({
    positions,
    dimensionLevel: 3,
    transparency,
    center: [0, 0, 0],
  });
  proximity.prepare(Infinity);
  proximity.setRadius(0.01);
  const selected = proximity.hits().toArray();
  assert.equal(selected.length, pointCount);
  assert.equal(new Set(selected).size, pointCount);
});

test('the lasso projection is exact across clip-W and near-plane adversaries', () => {
  // clipW=z. Negative-W points reverse screen inequalities.
  const projection = identityMatrix();
  projection[11] = 1;
  projection[15] = 0;
  const positions = Float32Array.from([
    0, 0, -1,
    0, 0, 1,
    0.05, -0.05, -0.5,
    0.05, -0.05, 0.5,
    2, 0, 1,
    -2, 0, -1,
    0, 0, 1e-11,
    0, 0, -1e-11,
    0, 0, 2,
    0, 0, -2,
    4, 4, 1,
    -4, -4, -1,
  ]);
  const transparency = Uint8Array.from([
    1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 0,
  ]);
  const path = [
    { x: 85, y: 55 },
    { x: 125, y: 55 },
    { x: 125, y: 95 },
    { x: 85, y: 95 },
  ];
  const query = {
    path,
    mvp: projection,
    viewport: makeViewport(),
    transparency,
    positions,
    dimensionLevel: 3,
  };
  const selected = lassoHits(query);
  assert.deepEqual(selected, referenceLasso(query));
  assert.ok(selected.includes(0), 'negative clip-W point remains selectable');
  assert.ok(selected.includes(1), 'positive clip-W point remains selectable');
  assert.ok(!selected.includes(6), 'clip-W singularity is rejected exactly');
  assert.ok(!selected.includes(7), 'negative clip-W singularity is rejected exactly');
});

test('picking rejects a same-size spatial index from another position owner', () => {
  const positions = Float32Array.from([
    0, 0, 0,
    0.1, 0.1, 0.1,
  ]);
  const wrongPositions = Float32Array.from([
    50, 50, 50,
    60, 60, 60,
  ]);
  const transparency = Uint8Array.of(1, 1);
  const wrongIndex = makeSpatialIndex(wrongPositions, 3, 1);

  assert.throws(
    () => findScreenSpacePick({
      dimension: 3,
      positions,
      transparency,
      mvpMatrix: identityMatrix(),
      cursor: { x: 10, y: 10 },
      pane: { cssWidth: 20, cssHeight: 20, framebufferHeight: 20 },
      pointSize: 4,
      sizeAttenuation: 0,
      fov: Math.PI / 4,
      spatialIndex: wrongIndex,
    }),
    /exact matching spatial owner/,
  );
});

test('lasso and proximity admit exactly the cells the shader draws', () => {
  const positions = Float32Array.from([
    0, 0, 0,
    0.01, 0, 0,
    -0.01, 0, 0,
  ]);
  const transparency = Uint8Array.from([0, 1, 0]);

  const proximity = new ProximityHitTest({
    positions,
    dimensionLevel: 3,
    transparency,
    center: [0, 0, 0],
  });
  proximity.prepare(Infinity);
  proximity.setRadius(1);
  const lasso = lassoHits({
    path: [
      { x: 80, y: 55 },
      { x: 130, y: 55 },
      { x: 130, y: 100 },
      { x: 80, y: 100 },
    ],
    mvp: identityMatrix(),
    viewport: makeViewport(),
    transparency,
    positions,
    dimensionLevel: 3,
  });

  assert.deepEqual(proximity.hits().toArray(), [1]);
  assert.deepEqual(lasso, [1]);
});
