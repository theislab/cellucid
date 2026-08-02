/**
 * Regression coverage for viewer layers a figure export used to drop without
 * saying so:
 *
 * 1. The reference grid. `Grid (light)` is the viewer's default background
 *    (`index.html`), `drawGrid()` paints it behind every frame, and neither the
 *    SVG nor the PNG renderer emitted a single mark for it — nor did the
 *    fidelity gate mention it. A figure exported from the default view simply
 *    lost its spatial reference box.
 * 2. Atmospheric fog. `fogDensity` starts at 0.5 and the `full` point shader
 *    fades and thins every point with distance, which is the depth cue a 3D
 *    scatter reads by. The `full-vector` and `optimized-vector` SVG strategies
 *    emitted raw colours, flattening the depth axis with no warning.
 * 3. The velocity vector field. Connectivity edges block the export; the
 *    velocity overlay, which is equally a data layer, did not.
 *
 * Every assertion here is written against produced markup, recorded Canvas2D
 * draw calls, or the shader source, so none of them can pass because a function
 * merely ran.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildReferenceGridModel,
  drawCanvasReferenceGrid,
  renderSvgReferenceGrid,
  resolveReferenceGridSurfaceRgb,
} from '../assets/js/app/ui/modules/figure-export/components/reference-grid.js';
import {
  assertReferenceGridAppearance,
  buildViewerBackgroundFidelityWarnings,
  readActiveReferenceGridAppearance,
  readActiveViewerBackground,
  REFERENCE_GRID_SIZE,
} from '../assets/js/app/ui/modules/figure-export/utils/viewer-background.js';
import {
  buildOverlayFidelityWarnings,
  readVelocityOverlayEnabled,
} from '../assets/js/app/ui/modules/figure-export/utils/overlay-fidelity.js';
import {
  applyFogAlpha,
  applyFogChannel,
  createFogEvaluator,
} from '../assets/js/app/ui/modules/figure-export/utils/fog.js';
import {
  resolveFigureInk,
} from '../assets/js/app/ui/modules/figure-export/utils/figure-ink.js';
import {
  renderFigureToSvgBlob,
} from '../assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js';
import {
  assertFigureExportPayload,
} from '../assets/js/app/ui/modules/figure-export/figure-export-contract.js';

const repositoryRoot = new URL('../', import.meta.url);

function readRepoFile(relativePath) {
  return readFile(new URL(relativePath, repositoryRoot), 'utf8');
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

function documentWith(values) {
  return {
    getElementById(id) {
      if (!Object.hasOwn(values, id)) return null;
      return values[id];
    },
  };
}

/** Canvas2D recorder that keeps every stroked path with its style and width. */
function recordingLineContext() {
  const record = { strokes: [] };
  let current = null;
  const ctx = {
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    save() {},
    restore() {},
    beginPath() {
      current = { points: [] };
    },
    moveTo(x, y) {
      current.points.push([x, y]);
    },
    lineTo(x, y) {
      current.points.push([x, y]);
    },
    stroke() {
      record.strokes.push({
        points: current.points,
        style: ctx.strokeStyle,
        width: ctx.lineWidth,
      });
    },
  };
  return { ctx, record };
}

/** Column-major 4x4 multiply, matching glMatrix's `mat4.multiply(out, a, b)`. */
function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function perspectiveMat4(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  return Float32Array.from([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

function lookAtMat4(eye, target, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => {
    const length = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return Float32Array.from([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

const IDENTITY_MAT4 = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/**
 * A camera at the given eye point looking at the origin, with a real
 * perspective projection, so the grid box falls inside the frustum.
 */
function cameraRenderState(eye, overrides = {}) {
  const near = 0.1;
  const far = 100;
  const fov = Math.PI / 4;
  const projection = perspectiveMat4(fov, 320 / 240, near, far);
  const view = lookAtMat4(eye, [0, 0, 0], [0, 1, 0]);
  const model = IDENTITY_MAT4;
  const mvp = multiplyMat4(multiplyMat4(projection, view), model);
  return {
    antialias: true,
    bgColor: Float32Array.from([0.965, 0.965, 0.970]),
    cameraDistance: Math.hypot(eye[0], eye[1], eye[2]),
    cameraPosition: [...eye],
    far,
    fogColor: Float32Array.from([0.965, 0.965, 0.970]),
    fogDensity: 0.5,
    fogFar: 8,
    fogNear: 4,
    fov,
    lightDir: Float32Array.from([0, 0, 1]),
    lightingStrength: 0.6,
    modelMatrix: model,
    mvpMatrix: mvp,
    near,
    pointSize: 4,
    projectionMatrix: projection,
    shaderQuality: 'full',
    sizeAttenuation: 0.65,
    viewMatrix: view,
    viewportHeight: 240,
    viewportWidth: 320,
    ...overrides,
  };
}

/** Straight down -Z from z = +6: four planes land exactly edge-on. */
function lookDownZRenderState(overrides = {}) {
  return cameraRenderState([0, 0, 6], overrides);
}

/** The viewer's default orbit direction: exactly three planes face the camera. */
function obliqueRenderState(overrides = {}) {
  return cameraRenderState([3.5, 3.5, 3.5], overrides);
}

const PLOT_RECT = { x: 40, y: 30, width: 640, height: 480 };

/**
 * Rules per plane, derived from the geometry rather than observed:
 * 21 rule coordinates per axis over [-2, 2] at spacing 0.2, two axes per
 * plane. Sixteen of the 21 are minor-only (one band); k = ±5 are also major
 * (two bands); k = 0 is also the origin axis (three bands); k = ±10 are also
 * the frame (three bands).
 */
const BANDS_PER_PLANE = 2 * (16 * 1 + 2 * 2 + 1 * 3 + 2 * 3);

const LIGHT_GRID = readActiveReferenceGridAppearance(
  documentWith({ 'background-select': { value: 'grid' } })
);
const DARK_GRID = readActiveReferenceGridAppearance(
  documentWith({ 'background-select': { value: 'grid-dark' } })
);

function gridModel({ appearance = LIGHT_GRID, renderState = lookDownZRenderState() } = {}) {
  return buildReferenceGridModel({
    appearance,
    renderState,
    plotRect: PLOT_RECT,
    crop: null,
    surfaceRgb: resolveReferenceGridSurfaceRgb({
      appearance,
      background: 'viewer',
      backgroundColor: '#f6f6f7',
    }),
  });
}

// ---------------------------------------------------------------------------
// The background control owns the grid, and the mirror never drifts
// ---------------------------------------------------------------------------

test('the viewer background is read from the control that owns it', () => {
  for (const value of ['grid', 'grid-dark', 'white', 'black']) {
    assert.equal(
      readActiveViewerBackground(documentWith({ 'background-select': { value } })),
      value
    );
  }
  assert.equal(
    readActiveViewerBackground(documentWith({ 'background-select': { value: 'plaid' } })),
    null
  );
  assert.equal(readActiveViewerBackground(documentWith({})), null);
  assert.equal(readActiveViewerBackground(null), null);
});

test('only the two grid backgrounds publish a reference grid', () => {
  assert.notEqual(LIGHT_GRID, null);
  assert.notEqual(DARK_GRID, null);
  for (const value of ['white', 'black']) {
    assert.equal(
      readActiveReferenceGridAppearance(
        documentWith({ 'background-select': { value } })
      ),
      null
    );
  }
});

test('an unreadable background blocks instead of guessing whether a grid exists', () => {
  for (const documentRef of [
    null,
    documentWith({}),
    documentWith({ 'background-select': { value: 'plaid' } }),
  ]) {
    const warnings = buildViewerBackgroundFidelityWarnings(documentRef);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].title, /Active viewer background unavailable/);
    assert.match(warnings[0].detail, /reference grid/i);
  }
  assert.deepEqual(
    buildViewerBackgroundFidelityWarnings(
      documentWith({ 'background-select': { value: 'grid' } })
    ),
    []
  );
});

test('the exported grid appearance is the viewer’s, byte for byte', async () => {
  const viewerSource = await readRepoFile('assets/js/rendering/viewer.js');
  // `setBackground()` publishes these scalars; the export mirrors them. If the
  // viewer retunes its grid, this test fails before a figure can lie about it.
  const light = viewerSource.slice(
    viewerSource.indexOf("case 'grid':"),
    viewerSource.indexOf("case 'grid-dark':")
  );
  const dark = viewerSource.slice(
    viewerSource.indexOf("case 'grid-dark':"),
    viewerSource.indexOf("case 'black':")
  );

  assert.match(light, /targetGridOpacity = 0\.85/);
  assert.match(light, /gridColor = \[0\.56, 0\.56, 0\.57\]/);
  assert.match(light, /gridBgColor = \[0\.965, 0\.965, 0\.970\]/);
  assert.match(light, /gridSpacing = 0\.2/);
  assert.match(light, /gridLineWidth = 0\.010/);
  assert.match(light, /axisXColor = \[0\.48, 0\.46, 0\.46\]/);

  assert.match(dark, /targetGridOpacity = 0\.75/);
  assert.match(dark, /gridColor = \[0\.38, 0\.38, 0\.42\]/);
  assert.match(dark, /gridBgColor = \[0\.08, 0\.09, 0\.1\]/);
  assert.match(dark, /gridLineWidth = 0\.008/);
  assert.match(dark, /axisZColor = \[0\.58, 0\.58, 0\.62\]/);

  assert.equal(LIGHT_GRID.opacity, 0.85);
  assert.deepEqual([...LIGHT_GRID.lineColor], [0.56, 0.56, 0.57]);
  assert.deepEqual([...LIGHT_GRID.surfaceColor], [0.965, 0.965, 0.970]);
  assert.equal(LIGHT_GRID.spacing, 0.2);
  assert.equal(LIGHT_GRID.lineWidth, 0.010);
  assert.deepEqual([...LIGHT_GRID.axisColors.x], [0.48, 0.46, 0.46]);

  assert.equal(DARK_GRID.opacity, 0.75);
  assert.deepEqual([...DARK_GRID.lineColor], [0.38, 0.38, 0.42]);
  assert.deepEqual([...DARK_GRID.surfaceColor], [0.08, 0.09, 0.10]);
  assert.equal(DARK_GRID.lineWidth, 0.008);
  assert.deepEqual([...DARK_GRID.axisColors.z], [0.58, 0.58, 0.62]);

  assert.match(viewerSource, /const GRID_SIZE = 2\.0;/);
  assert.equal(REFERENCE_GRID_SIZE, 2.0);
});

test('the strength curves match the grid fragment shader', async () => {
  const shaderSource = await readRepoFile(
    'assets/js/rendering/shaders/edge-grid-shaders.js'
  );
  assert.match(
    shaderSource,
    /minorStrength = \(0\.35 \+ 0\.16 \* isLightBg\) \* pow\(effectiveOpacity, 0\.60\)/
  );
  assert.match(
    shaderSource,
    /majorStrength = 0\.58 \* pow\(effectiveOpacity, 0\.50\)/
  );
  assert.match(
    shaderSource,
    /frameStrength = 0\.18 \* pow\(effectiveOpacity, 0\.65\)/
  );
  assert.match(
    shaderSource,
    /axisStrength = \(0\.32 \+ 0\.03 \* isLightBg\) \* pow\(effectiveOpacity, 0\.55\)/
  );
  assert.match(shaderSource, /majorSpacing = u_gridSpacing \* 5\.0/);
  assert.match(shaderSource, /float lineHalf = lineWidth \* 0\.5;/);
  assert.match(shaderSource, /float edgeWidth = lineWidth \* 1\.4;/);
  assert.match(shaderSource, /float w = lineWidth \* 1\.55;/);
  assert.match(shaderSource, /majorLineWidth = mainLineWidth \* 1\.20/);
  // The grid's alpha carries no fog term, which is what makes an exact vector
  // reproduction possible at all.
  assert.match(shaderSource, /Alpha emphasizes lines while keeping surfaces airy \(no fog dependence\)/);
});

// ---------------------------------------------------------------------------
// The model itself
// ---------------------------------------------------------------------------

test('a grid background produces real geometry and a plain background produces none', () => {
  const model = gridModel();
  assert.notEqual(model, null);
  assert.ok(model.segments.length > 100, 'a grid box carries many rules');
  assert.equal(gridModel({ appearance: null }), null);
});

test('only the planes facing the camera are drawn', () => {
  // `drawGrid()` fades each plane by smoothstep(-0.2, 0.05, dot(viewDir,
  // normal)) and skips it below 0.01. Opposite planes carry opposite dots, so
  // an oblique camera sees exactly three of the six — the matplotlib box.
  assert.equal(
    gridModel({ renderState: obliqueRenderState() }).segments.length,
    3 * BANDS_PER_PLANE
  );

  // Down the Z axis, four planes sit exactly edge-on (dot 0, alpha 0.896) and
  // only the near wall is culled: five planes, never all six.
  assert.equal(gridModel().segments.length, 5 * BANDS_PER_PLANE);

  // A camera on the far side is the mirror image, not a different count.
  assert.equal(
    gridModel({ renderState: cameraRenderState([0, 0, -6]) }).segments.length,
    5 * BANDS_PER_PLANE
  );
});

test('every rule carries a positive stroke width and an exact hex colour', () => {
  for (const segment of gridModel().segments) {
    assert.ok(segment.widthPx > 0);
    assert.match(segment.color, /^#[0-9a-f]{6}$/);
    assert.ok(Number.isFinite(segment.x1) && Number.isFinite(segment.y1));
    assert.ok(Number.isFinite(segment.x2) && Number.isFinite(segment.y2));
  }
});

test('each rule class carries the exact colour the shader computes', () => {
  // A second implementation, transcribed straight from GRID_FS_SOURCE rather
  // than reused from the export module, so agreement means the arithmetic is
  // right and not merely self-consistent.
  const surface = [246 / 255, 246 / 255, 247 / 255]; // #f6f6f7
  const line = [0.56, 0.56, 0.57];
  const axisX = [0.48, 0.46, 0.46];
  const bgLuma =
    0.965 * 0.2126 + 0.965 * 0.7152 + 0.970 * 0.0722;
  const isLightBg = bgLuma >= 0.55 ? 1 : 0;
  assert.equal(isLightBg, 1);

  // The plane that squarely faces the camera has planeAlpha exactly 1.
  const eo = 0.85;
  const minorStrength = (0.35 + 0.16 * isLightBg) * eo ** 0.60;
  const majorStrength = 0.58 * eo ** 0.50;
  const frameStrength = 0.18 * eo ** 0.65;
  const axisStrength = (0.32 + 0.03 * isLightBg) * eo ** 0.55;

  const mix = (from, to, amount) =>
    from.map((channel, i) => channel + (to[i] - channel) * amount);
  const hex = (rgb) =>
    `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16).padStart(2, '0')).join('')}`;
  const rule = (gridMix, { axis = false } = {}) => {
    let color = mix(surface, line, Math.min(1, gridMix));
    if (axis) color = mix(color, axisX, axisStrength);
    return hex(mix(surface, color, eo));
  };

  const model = gridModel();
  const colors = new Set(model.segments.map((segment) => segment.color));

  // Minor-only rule.
  assert.ok(colors.has(rule(minorStrength)), 'minor rule colour');
  // A major coordinate is also a minor coordinate, so the strengths add.
  assert.ok(colors.has(rule(minorStrength + majorStrength)), 'major rule core');
  // The box edge is minor + major + frame in its core, frame alone in its wings.
  assert.ok(
    colors.has(rule(minorStrength + majorStrength + frameStrength)),
    'frame rule core'
  );
  assert.ok(colors.has(rule(frameStrength)), 'frame rule wing');
  // The X origin rule runs along x, so it takes the X axis colour.
  assert.ok(
    colors.has(rule(minorStrength + majorStrength, { axis: true })),
    'origin axis core'
  );
  assert.ok(colors.has(rule(0, { axis: true })), 'origin axis wing');
});

test('rule widths follow the shader’s three coverage helpers', () => {
  // gridLine half-width w/2, major w*0.6, edgeLine w*1.4, originLine w*1.55,
  // so one plane's rules must appear at 1 : 1.2 : 2.8 : 3.1.
  //
  // Looking down -Z, the far wall is fronto-parallel, so all of its rules
  // project at one scale while the four edge-on planes stretch theirs across a
  // continuum. That makes the fronto-parallel wall's minor width the single
  // most repeated width in the whole model, and the yardstick for the rest.
  const model = gridModel();
  const counts = new Map();
  for (const segment of model.segments) {
    const key = Number(segment.widthPx.toFixed(6));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [minorWidth, minorCount] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])[0];
  assert.ok(
    minorCount >= 32,
    'the fronto-parallel wall contributes 32 minor-only rules'
  );

  const widths = [...counts.keys()];
  for (const expected of [1.2, 2.8, 3.1]) {
    assert.ok(
      widths.some(
        (width) => Math.abs(width / minorWidth - expected) < 0.005
      ),
      `expected a ${expected}× rule width beside ${minorWidth}`
    );
  }
});

test('the dark grid is lighter than its background and the light grid darker', () => {
  const luma = (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return (((value >> 16) & 255) + ((value >> 8) & 255) + (value & 255)) / 3;
  };
  const light = gridModel({ appearance: LIGHT_GRID });
  // #f6f6f7 is the viewer's light background, ~246.
  assert.ok(Math.max(...light.segments.map((s) => luma(s.color))) < 246);

  const darkState = lookDownZRenderState({
    bgColor: Float32Array.from([0.08, 0.09, 0.10]),
    fogColor: Float32Array.from([0.08, 0.09, 0.10]),
  });
  const dark = buildReferenceGridModel({
    appearance: DARK_GRID,
    renderState: darkState,
    plotRect: PLOT_RECT,
    crop: null,
    surfaceRgb: resolveReferenceGridSurfaceRgb({
      appearance: DARK_GRID,
      background: 'viewer',
      backgroundColor: '#141719',
    }),
  });
  // #141719 is ~22; every dark-theme rule must be brighter than that.
  assert.ok(Math.min(...dark.segments.map((s) => luma(s.color))) > 22);
});

test('a light viewer grid is not exported as the dark one', () => {
  const light = new Set(gridModel({ appearance: LIGHT_GRID }).segments.map((s) => s.color));
  const dark = new Set(
    buildReferenceGridModel({
      appearance: DARK_GRID,
      renderState: lookDownZRenderState(),
      plotRect: PLOT_RECT,
      crop: null,
      surfaceRgb: resolveReferenceGridSurfaceRgb({
        appearance: DARK_GRID,
        background: 'viewer',
        backgroundColor: '#141719',
      }),
    }).segments.map((s) => s.color)
  );
  for (const color of light) {
    assert.equal(dark.has(color), false, `theme leak on ${color}`);
  }
});

test('the grid honours a framing crop and takes raw crop input', () => {
  // `assertCropRect01()` returns a four-key rect that is not itself valid crop
  // input; the preview passed its result straight back in and threw on every
  // framed redraw.
  const crop = { enabled: true, x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  const cropped = gridModel({ renderState: lookDownZRenderState() });
  const framed = buildReferenceGridModel({
    appearance: LIGHT_GRID,
    renderState: lookDownZRenderState(),
    plotRect: PLOT_RECT,
    crop,
    surfaceRgb: [1, 1, 1],
  });
  assert.notEqual(framed, null);
  // A half-size crop fills the same plot rect, so every rule is twice as wide.
  const widest = (model) => Math.max(...model.segments.map((s) => s.widthPx));
  assert.ok(Math.abs(widest(framed) / widest(cropped) - 2) < 0.01);

  assert.throws(
    () => buildReferenceGridModel({
      appearance: LIGHT_GRID,
      renderState: lookDownZRenderState(),
      plotRect: PLOT_RECT,
      crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      surfaceRgb: [1, 1, 1],
    }),
    /must contain exactly/
  );
});

test('a transparent figure composites the rules over the viewer background', () => {
  assert.deepEqual(
    resolveReferenceGridSurfaceRgb({
      appearance: LIGHT_GRID,
      background: 'transparent',
      backgroundColor: '#ffffff',
    }),
    [0.965, 0.965, 0.970]
  );
  assert.deepEqual(
    resolveReferenceGridSurfaceRgb({
      appearance: LIGHT_GRID,
      background: 'white',
      backgroundColor: '#ffffff',
    }),
    [1, 1, 1]
  );
  assert.equal(
    resolveReferenceGridSurfaceRgb({
      appearance: null,
      background: 'white',
      backgroundColor: '#ffffff',
    }),
    null
  );
});

// ---------------------------------------------------------------------------
// SVG and Canvas draw the same grid
// ---------------------------------------------------------------------------

test('SVG and Canvas2D emit the identical set of rules', () => {
  const model = gridModel();
  const svg = renderSvgReferenceGrid(model);
  const lines = [...svg.matchAll(
    /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)" stroke="(#[0-9a-f]{6})" stroke-width="([\d.]+)"\/>/g
  )];
  assert.equal(lines.length, model.segments.length);

  const { ctx, record } = recordingLineContext();
  drawCanvasReferenceGrid({ ctx, model });
  assert.equal(record.strokes.length, model.segments.length);

  for (let i = 0; i < model.segments.length; i++) {
    const segment = model.segments[i];
    assert.equal(lines[i][5], segment.color);
    assert.equal(record.strokes[i].style, segment.color);
    assert.equal(record.strokes[i].width, segment.widthPx);
    assert.deepEqual(record.strokes[i].points, [
      [segment.x1, segment.y1],
      [segment.x2, segment.y2],
    ]);
    assert.equal(Number(lines[i][1]), Number(segment.x1.toFixed(2)));
    assert.equal(Number(lines[i][6]), Number(segment.widthPx.toFixed(3)));
  }

  assert.equal(renderSvgReferenceGrid(null), '');
  const empty = recordingLineContext();
  drawCanvasReferenceGrid({ ctx: empty.ctx, model: null });
  assert.equal(empty.record.strokes.length, 0);
});

// ---------------------------------------------------------------------------
// The renderers actually put it in the file
// ---------------------------------------------------------------------------

function gridPayload({ referenceGrid, strategy = 'full-vector', background = 'viewer' }) {
  const renderState = lookDownZRenderState();
  const width = 800;
  const height = 600;
  const view = {
    cameraState: {
      navigationMode: 'orbit',
      orbit: { radius: 6, targetRadius: 6, theta: 0, phi: Math.PI / 2, target: [0, 0, 0] },
      freefly: { position: [0, 0, 6], yaw: 0, pitch: 0 },
    },
    data: {
      centroidColors: null,
      centroidFlags: { labels: false, points: false },
      centroidLabelTexts: [],
      centroidPositions: null,
      colors: Uint8Array.from([220, 30, 30, 255, 30, 30, 220, 255]),
      pointCount: 2,
      // One point close to the camera, one far behind it inside the fog span.
      positions: Float32Array.from([0, 0, 1.5, 0, 0, -1.5]),
      transparency: Float32Array.from([1, 1]),
    },
    id: 'live',
    label: 'Live',
    renderState,
    scientificState: {
      datasetGeneration: 3,
      dimensionLevel: 3,
      fieldKey: 'cluster',
      fieldKind: 'categorical',
      filters: [],
      geometryGeneration: 5,
      legendModel: null,
      lodMembership: null,
      lodSizeMultiplier: 1,
      normTransform: { center: [0, 0, 0], scale: 1 },
    },
  };
  return {
    dpi: null,
    format: 'svg',
    height,
    meta: {
      datasetName: 'Suo',
      datasetId: 'suo-2022',
      exportedAt: '2026-07-30T00:00:00.000Z',
      views: [{
        fieldKey: 'cluster',
        fieldKind: 'categorical',
        filters: [],
        id: 'live',
        label: 'Live',
      }],
    },
    options: {
      axisLabelFontSizePx: 12,
      background,
      backgroundColor: '#ffffff',
      centroidLabelFontSizePx: 12,
      crop: null,
      depthSort3d: false,
      emphasizeSelection: false,
      fontFamily: 'Arial, sans-serif',
      fontSizePx: 12,
      height,
      includeAxes: false,
      includeLegend: false,
      legendFontSizePx: 12,
      legendPosition: 'right',
      optimizedTargetCount: strategy === 'optimized-vector' ? 1000 : null,
      referenceGrid,
      selectionMutedOpacity: 0.15,
      showOrientation: false,
      strategy,
      tickFontSizePx: 12,
      title: '',
      titleFontSizePx: 15,
      width,
      xLabel: 'UMAP 1',
      yLabel: 'UMAP 2',
    },
    selection: { highlightArray: null, totalCount: 0, visibleCount: 0 },
    title: '',
    views: [view],
    width,
  };
}

test('an SVG exported from a light-grid viewer carries the light grid', async () => {
  const svg = await new Response(
    await renderFigureToSvgBlob({ payload: gridPayload({ referenceGrid: LIGHT_GRID }) })
  ).text();
  assert.match(svg, /class="cellucid-reference-grid"/);
  const rules = [...svg.matchAll(/<line [^>]*stroke="(#[0-9a-f]{6})"/g)];
  assert.ok(rules.length > 100, `expected a full grid, saw ${rules.length} rules`);

  // The grid must be behind the data: its group opens before the first circle.
  assert.ok(
    svg.indexOf('cellucid-reference-grid') < svg.indexOf('<circle'),
    'the reference grid must be painted behind the points'
  );
});

test('a plain-background viewer exports no grid at all', async () => {
  const svg = await new Response(
    await renderFigureToSvgBlob({ payload: gridPayload({ referenceGrid: null }) })
  ).text();
  assert.doesNotMatch(svg, /cellucid-reference-grid/);
  assert.doesNotMatch(svg, /<line /);
});

test('a dark-grid viewer does not export the light grid', async () => {
  const light = await new Response(
    await renderFigureToSvgBlob({ payload: gridPayload({ referenceGrid: LIGHT_GRID }) })
  ).text();
  const dark = await new Response(
    await renderFigureToSvgBlob({ payload: gridPayload({ referenceGrid: DARK_GRID }) })
  ).text();
  const colorsOf = (svg) => new Set(
    [...svg.matchAll(/<line [^>]*stroke="(#[0-9a-f]{6})"/g)].map((m) => m[1])
  );
  const lightColors = colorsOf(light);
  const darkColors = colorsOf(dark);
  assert.ok(lightColors.size > 0 && darkColors.size > 0);
  for (const color of lightColors) {
    assert.equal(darkColors.has(color), false, `theme leak on ${color}`);
  }
});

test('the payload contract accepts only appearances the viewer publishes', () => {
  assert.equal(assertReferenceGridAppearance(null, 'ctx'), null);
  assert.equal(assertReferenceGridAppearance(LIGHT_GRID, 'ctx'), LIGHT_GRID);
  for (const invalid of [
    { ...LIGHT_GRID },
    { mode: 'grid' },
    'grid',
    true,
  ]) {
    assert.throws(
      () => assertReferenceGridAppearance(invalid, 'ctx'),
      /published viewer reference-grid appearance/
    );
  }
  assert.throws(
    () => assertFigureExportPayload(gridPayload({ referenceGrid: { mode: 'grid' } })),
    /published viewer reference-grid appearance/
  );
});

// ---------------------------------------------------------------------------
// Fog: the depth cue the vector strategies used to drop
// ---------------------------------------------------------------------------

test('the fog evaluator reproduces the shader formula', async () => {
  const shaderSource = await readRepoFile(
    'assets/js/rendering/shaders/high-perf-shaders.js'
  );
  assert.match(shaderSource, /float fogSpan = max\(u_fogFar - u_fogNear, 0\.0001\);/);
  assert.match(
    shaderSource,
    /float normalizedDistance = max\(v_viewDistance - u_fogNear, 0\.0\) \/ fogSpan;/
  );
  assert.match(shaderSource, /float extinction = u_fogDensity \* u_fogDensity \* 0\.6;/);
  assert.match(shaderSource, /float transmittance = exp\(-extinction \* normalizedDistance\);/);
  assert.match(shaderSource, /float alpha = \(0\.1 \+ 0\.9 \* transmittance\) \* v_alpha;/);

  const fog = createFogEvaluator(lookDownZRenderState());
  assert.notEqual(fog, null);

  // Camera sits at z = +6; the point at z = +1.5 is 4.5 away, the one at
  // z = -1.5 is 7.5 away. fogNear 4, fogFar 8, density 0.5.
  const extinction = 0.5 * 0.5 * 0.6;
  const near = Math.exp(-extinction * ((4.5 - 4) / 4));
  const far = Math.exp(-extinction * ((7.5 - 4) / 4));
  assert.ok(Math.abs(fog.transmittanceAt(0, 0, 1.5) - near) < 1e-6);
  assert.ok(Math.abs(fog.transmittanceAt(0, 0, -1.5) - far) < 1e-6);
  assert.ok(far < near, 'the farther point must be more attenuated');

  assert.equal(applyFogAlpha(1, 0.8), 0.8);
  assert.ok(Math.abs(applyFogAlpha(0, 0.8) - 0.08) < 1e-12);
  assert.equal(applyFogChannel(200, 100, 1), 100);
  assert.equal(applyFogChannel(200, 100, 0), 200);
});

test('shader qualities without fog get no fog', () => {
  for (const shaderQuality of ['light', 'ultralight']) {
    assert.equal(
      createFogEvaluator(lookDownZRenderState({ shaderQuality })),
      null
    );
  }
  assert.equal(createFogEvaluator(lookDownZRenderState({ fogDensity: 0 })), null);
  assert.equal(createFogEvaluator(null), null);
});

test('full-vector SVG fades distant points exactly as the viewer does', async () => {
  const payload = gridPayload({ referenceGrid: null, strategy: 'full-vector' });
  const svg = await new Response(
    await renderFigureToSvgBlob({ payload })
  ).text();
  const circles = [...svg.matchAll(
    /<circle cx="[-\d.]+" cy="[-\d.]+" r="[\d.]+" fill="rgb\((\d+),(\d+),(\d+)\)"(?: fill-opacity="([\d.]+)")?\/>/g
  )];
  assert.equal(circles.length, 2, 'both points are drawn');

  const fog = createFogEvaluator(lookDownZRenderState());
  const expected = [
    { z: 1.5, rgb: [220, 30, 30] },
    { z: -1.5, rgb: [30, 30, 220] },
  ].map(({ z, rgb }) => {
    const t = fog.transmittanceAt(0, 0, z);
    return {
      rgb: rgb.map((channel) => applyFogChannel(
        Math.round(0.965 * 255),
        channel,
        t
      )),
      alpha: applyFogAlpha(t, 1),
    };
  });

  const drawn = circles.map((match) => ({
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  }));

  // Before the fix both circles carried their raw colour at full opacity.
  for (const point of expected) {
    const hit = drawn.find(
      (candidate) =>
        candidate.rgb.every((channel, i) => channel === point.rgb[i]) &&
        Math.abs(candidate.alpha - point.alpha) < 0.001
    );
    assert.ok(hit, `no circle matched fogged ${JSON.stringify(point)}`);
  }
  assert.notDeepEqual(drawn[0].rgb, [220, 30, 30]);
  assert.notDeepEqual(drawn[1].rgb, [30, 30, 220]);
  assert.ok(drawn.every((point) => point.alpha < 1));
});

test('optimized-vector SVG carries the same fog as full-vector', async () => {
  const read = async (strategy) => {
    const svg = await new Response(
      await renderFigureToSvgBlob({
        payload: gridPayload({ referenceGrid: null, strategy }),
      })
    ).text();
    return [...svg.matchAll(/fill="rgb\((\d+),(\d+),(\d+)\)"/g)]
      .map((m) => `${m[1]},${m[2]},${m[3]}`)
      .sort();
  };
  const optimized = await read('optimized-vector');
  assert.deepEqual(optimized, await read('full-vector'));
  // Both strategies used to emit the source colours untouched.
  assert.equal(optimized.includes('220,30,30'), false);
  assert.equal(optimized.includes('30,30,220'), false);
});

test('the PNG renderer draws the same reference grid the SVG does', async () => {
  const png = await readRepoFile(
    'assets/js/app/ui/modules/figure-export/renderers/png-renderer.js'
  );
  const svg = await readRepoFile(
    'assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js'
  );
  for (const source of [png, svg]) {
    assert.match(source, /buildReferenceGridModel\(\{/);
    assert.match(source, /resolveReferenceGridSurfaceRgb\(\{/);
    assert.match(source, /appearance: referenceGrid,/);
    // Single view and every panel of a grid export, both formats.
    assert.equal(
      (source.match(/buildReferenceGridModel\(\{/g) ?? []).length,
      2
    );
  }
  assert.match(png, /drawCanvasReferenceGrid\(\{/);
  assert.match(svg, /renderSvgReferenceGrid\(buildReferenceGridModel/);
});

test('a white figure fogs toward the paper, not the viewer background', async () => {
  const svg = await new Response(
    await renderFigureToSvgBlob({
      payload: gridPayload({ referenceGrid: null, background: 'white' }),
    })
  ).text();
  const fog = createFogEvaluator(lookDownZRenderState());
  const t = fog.transmittanceAt(0, 0, -1.5);
  const expected = [30, 30, 220].map(
    (channel) => applyFogChannel(255, channel, t)
  );
  assert.match(
    svg,
    new RegExp(`fill="rgb\\(${expected[0]},${expected[1]},${expected[2]}\\)"`)
  );
});

// ---------------------------------------------------------------------------
// The velocity overlay is a data layer and must gate the export
// ---------------------------------------------------------------------------

test('the velocity overlay state is read from the control that owns it', () => {
  assert.equal(
    readVelocityOverlayEnabled(
      documentWith({ 'velocity-overlay-enabled': { checked: true } })
    ),
    true
  );
  assert.equal(
    readVelocityOverlayEnabled(
      documentWith({ 'velocity-overlay-enabled': { checked: false } })
    ),
    false
  );
  assert.equal(readVelocityOverlayEnabled(documentWith({})), null);
  assert.equal(readVelocityOverlayEnabled(null), null);
});

test('an enabled velocity field blocks the export, as connectivity already does', () => {
  const off = documentWith({ 'velocity-overlay-enabled': { checked: false } });
  const on = documentWith({ 'velocity-overlay-enabled': { checked: true } });

  assert.deepEqual(
    buildOverlayFidelityWarnings({ documentRef: off, connectivityVisible: false }),
    []
  );

  const velocity = buildOverlayFidelityWarnings({
    documentRef: on,
    connectivityVisible: false,
  });
  assert.equal(velocity.length, 1);
  assert.match(velocity[0].title, /Velocity overlay not exported/);
  assert.match(velocity[0].detail, /point layer only/i);

  const both = buildOverlayFidelityWarnings({
    documentRef: on,
    connectivityVisible: true,
  });
  assert.equal(both.length, 2);
  assert.match(both[0].title, /Connectivity overlay not exported/);

  const unreadable = buildOverlayFidelityWarnings({
    documentRef: documentWith({}),
    connectivityVisible: false,
  });
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].title, /Velocity overlay state unavailable/);

  assert.throws(
    () => buildOverlayFidelityWarnings({ documentRef: off, connectivityVisible: null }),
    /exact connectivity visibility boolean/
  );
});

// ---------------------------------------------------------------------------
// A figure on dark paper must still be readable
// ---------------------------------------------------------------------------

test('annotation ink follows the figure background, not a fixed near-black', () => {
  const light = resolveFigureInk({ background: 'viewer', backgroundColor: '#f6f6f7' });
  const dark = resolveFigureInk({ background: 'viewer', backgroundColor: '#141719' });
  assert.equal(light.scheme, 'light');
  assert.equal(dark.scheme, 'dark');
  assert.notEqual(light.text, dark.text);

  const luma = (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return (
      ((value >> 16) & 255) * 0.2126 +
      ((value >> 8) & 255) * 0.7152 +
      (value & 255) * 0.0722
    ) / 255;
  };
  // Every ink must contrast with its own paper, in both directions.
  assert.ok(luma(light.text) < 0.3 && luma(dark.text) > 0.7);
  assert.ok(luma(light.mutedText) < luma('#f6f6f7'));
  assert.ok(luma(dark.mutedText) > luma('#141719'));

  // A transparent figure lands on paper of unknown colour; light is the safe
  // assumption and the one the label halo already makes.
  assert.equal(
    resolveFigureInk({ background: 'transparent', backgroundColor: '#000000' }).scheme,
    'light'
  );
  assert.throws(
    () => resolveFigureInk({ background: 'white', backgroundColor: 'white' }),
    /exact #RRGGBB/
  );
});

test('a dark-background SVG writes no near-black text', async () => {
  const dark = gridPayload({ referenceGrid: DARK_GRID });
  const payload = {
    ...dark,
    options: {
      ...dark.options,
      background: 'custom',
      backgroundColor: '#141719',
      includeAxes: true,
      title: 'Dark figure',
    },
    title: 'Dark figure',
  };
  const svg = await new Response(
    await renderFigureToSvgBlob({ payload })
  ).text();

  // Before this fix the title, ticks and axis labels were all `#111` on
  // #141719 paper — present in the file and invisible in the figure.
  const textFills = [...svg.matchAll(/<text[^>]*fill="(#[0-9a-fA-F]{6})"/g)]
    .map((match) => match[1].toLowerCase());
  const groupFills = [...svg.matchAll(/<g [^>]*font-size="[^"]*" fill="(#[0-9a-fA-F]{6})"/g)]
    .map((match) => match[1].toLowerCase());
  const inks = new Set([...textFills, ...groupFills]);
  assert.ok(inks.size > 0, 'the figure carries annotation text');
  for (const value of inks) {
    assert.notEqual(value, '#111', `near-black annotation ink ${value}`);
    assert.notEqual(value, '#111111', `near-black annotation ink ${value}`);
  }
  assert.ok(svg.includes('Dark figure'));
  assert.ok(inks.has('#f3f4f6'), 'the dark palette is the one that was used');
});

test('the export UI routes both the background and the overlay gates', async () => {
  const ui = await readRepoFile(
    'assets/js/app/ui/modules/figure-export/figure-export-ui.js'
  );
  assert.match(ui, /buildViewerBackgroundFidelityWarnings\(/);
  assert.match(ui, /buildOverlayFidelityWarnings\(/);
  assert.match(ui, /referenceGrid: resolveExportReferenceGrid\(\)/);
  // The preview must draw the same grid the file will carry.
  assert.match(ui, /drawCanvasReferenceGrid\(/);
});
