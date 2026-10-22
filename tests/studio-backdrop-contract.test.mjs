/**
 * The studio backdrop (`Studio (light)` / `Studio (dark)`): its weighting is
 * seamless across zoom, its geometry follows the data, its shader is built
 * from the one constant table, and figure export reproduces it from the same
 * functions the shader mirrors.
 *
 * Every assertion is about produced numbers, generated GLSL, emitted markup or
 * recorded Canvas2D calls, never about a function merely running.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  STUDIO_LATTICE,
  STUDIO_MARKS,
  STUDIO_PALETTES,
  STUDIO_STAGE,
  STUDIO_SURFACES,
  resolveStudioBackdropPlane,
  resolveStudioPaneGeometry,
  resolveStudioPool,
  resolveStudioSurfaceWeights,
  studioColor01,
  studioFalloff,
  studioFamilyLevel,
  studioFamilySpacing,
  studioFamilyWeights,
  studioMarkStrength,
  studioSurfacePlanarity,
} from '../assets/js/rendering/studio-backdrop.js';
import {
  STUDIO_FS_SOURCE,
  STUDIO_VS_SOURCE,
} from '../assets/js/rendering/shaders/studio-shaders.js';
import {
  buildReferenceGridModel,
  drawCanvasReferenceGrid,
  renderSvgReferenceGrid,
  resolveReferenceGridSurface,
} from '../assets/js/app/ui/modules/figure-export/components/reference-grid.js';
import { readActiveReferenceGridAppearance } from '../assets/js/app/ui/modules/figure-export/utils/viewer-background.js';

const repositoryRoot = new URL('../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, repositoryRoot), 'utf8');

// ---------------------------------------------------------------------------
// Column-major camera matrices, as gl-matrix builds them for the viewer.
// ---------------------------------------------------------------------------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ];
}

function lookAt(eye, target, up) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let length = Math.hypot(zx, zy, zz);
  zx /= length; zy /= length; zz /= length;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  length = Math.hypot(xx, xy, xz);
  xx /= length; xy /= length; xz /= length;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return [
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}

const VIEWPORT = { width: 1200, height: 800 };
const PLOT_RECT = { x: 40, y: 30, width: 600, height: 400 };

function paneRenderState({ eye, target = [0, 0, 0], up = [0, 1, 0], planarity, pixelRatio = 1 }) {
  const projection = perspective(Math.PI / 4, VIEWPORT.width / VIEWPORT.height, 0.02, 1000);
  const view = lookAt(eye, target, up);
  const geometry = resolveStudioPaneGeometry(
    { min: [-1, -0.6, -0.8], max: [1, 0.7, 0.8] },
    3,
    {}
  );
  return {
    backdrop: {
      centerY: geometry.centerY,
      extentX: geometry.extentX,
      extentY: geometry.extentY,
      extentZ: geometry.extentZ,
      flat: geometry.flat,
      floorY: geometry.floorY,
      glowCenterX: 0,
      look: null,
      pixelRatio,
      planarity,
      stageX: geometry.stageX,
      stageZ: geometry.stageZ,
    },
    cameraPosition: [...eye],
    mvpMatrix: Float32Array.from(multiply(projection, view)),
    viewMatrix: Float32Array.from(view),
    viewportHeight: VIEWPORT.height,
    viewportWidth: VIEWPORT.width,
  };
}

const appearanceFor = (mode) => readActiveReferenceGridAppearance({
  getElementById: (id) => (id === 'background-select' ? { value: mode } : null),
});
const LIGHT = appearanceFor('studio');
const DARK = appearanceFor('studio-dark');

function model({ appearance = LIGHT, renderState, background = 'viewer', backgroundColor }) {
  return buildReferenceGridModel({
    appearance,
    renderState,
    plotRect: PLOT_RECT,
    crop: null,
    surface: resolveReferenceGridSurface({
      appearance,
      background,
      backgroundColor: backgroundColor
        ?? `#${appearance.palette.surface.map((c) => c.toString(16).padStart(2, '0')).join('')}`,
    }),
  });
}

// ---------------------------------------------------------------------------
// Weighting
// ---------------------------------------------------------------------------

test('a family fades in with its on-screen spacing and turns major one ratio later', () => {
  const minCell = STUDIO_SURFACES.backdrop.minCellCssPx;
  const at = (css) => studioFamilyWeights(STUDIO_SURFACES.backdrop, 1, css);
  assert.equal(at(minCell * STUDIO_LATTICE.fadeInFraction).presence, 0);
  assert.equal(at(minCell).presence, 1);
  assert.equal(at(minCell).majorness, 0);
  assert.equal(at(minCell * STUDIO_LATTICE.ratio).majorness, 1);
  let previous = -1;
  for (let css = 0; css <= minCell * STUDIO_LATTICE.ratio * 2; css += 0.25) {
    const { presence } = at(css);
    assert.ok(presence >= previous - 1e-12, 'presence must not fall as spacing grows');
    previous = presence;
  }
});

test('floor families as wide as the stage recede instead of drawing a lone cross', () => {
  const floor = STUDIO_SURFACES.floor;
  const max = floor.maxFamilySpacing;
  assert.equal(studioFamilyWeights(floor, max * 0.5, 200).presence, 1);
  assert.equal(studioFamilyWeights(floor, max, 200).presence, 0);
  assert.equal(studioFamilyWeights(floor, 25, 200).presence, 0);
  assert.equal(studioFamilyWeights(STUDIO_SURFACES.backdrop, 25, 200).presence, 1);
});

test('three evaluated families draw every mark exactly as all families would', () => {
  // The shader evaluates `level`..`level + 2` around each fragment's
  // footprint. Neighbouring fragments with different levels must agree, so
  // the window has to equal the strongest of *every* family a mark is on.
  for (const surface of Object.values(STUDIO_SURFACES)) {
    for (let footprint = 1e-4; footprint < 0.5; footprint *= 1.07) {
      for (const pixelRatio of [1, 2, 3]) {
        const level = studioFamilyLevel(surface, footprint, pixelRatio);
        for (let coarsest = level - 2; coarsest <= level + 6; coarsest++) {
          const windowed = studioMarkStrength({
            surface,
            coarsestLevel: coarsest,
            level,
            footprint,
            pixelRatio,
            minorAlpha: 0.1,
            majorAlpha: 0.3,
          }).strength;
          let exhaustive = 0;
          for (let family = level - 6; family <= coarsest; family++) {
            const spacing = studioFamilySpacing(family);
            const weights = studioFamilyWeights(surface, spacing, spacing / footprint / pixelRatio);
            exhaustive = Math.max(exhaustive, weights.presence * (0.1 + 0.2 * weights.majorness));
          }
          assert.ok(
            Math.abs(windowed - exhaustive) < 1e-12,
            `footprint ${footprint}, dpr ${pixelRatio}, coarsest ${coarsest}`
          );
        }
      }
    }
  }
});

test('the finest evaluated family sits between a ratio below and at the minimum cell', () => {
  for (const surface of Object.values(STUDIO_SURFACES)) {
    for (const pixelRatio of [1, 2, 3]) {
      for (let footprint = 1e-4; footprint < 1; footprint *= 1.13) {
        const level = studioFamilyLevel(surface, footprint, pixelRatio);
        const css = studioFamilySpacing(level) / footprint / pixelRatio;
        assert.ok(css <= surface.minCellCssPx * (1 + 1e-9));
        assert.ok(css > surface.minCellCssPx / STUDIO_LATTICE.ratio * (1 - 1e-9));
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test('the floor sits just under the data, and flat data lies on its dot surface', () => {
  const cloud = resolveStudioPaneGeometry({ min: [-1, -0.4, -0.5], max: [1, 0.9, 0.3] }, 3, {});
  assert.equal(cloud.floorY, -0.4 - STUDIO_STAGE.floorClearance);
  assert.equal(cloud.flat, false);
  assert.equal(cloud.stageX, 0);
  assert.equal(cloud.centerY, 0.25);
  assert.equal(cloud.stageZ, -0.1);
  assert.equal(cloud.extentX, 1);
  assert.equal(cloud.extentY, 0.65);
  assert.equal(cloud.extentZ, 0.4);
  const flat = resolveStudioPaneGeometry({ min: [-1, -1, 0], max: [1, 1, 0] }, 2, {});
  assert.equal(flat.flat, true);
  // A flat embedding's dot surface is its own plane whatever the camera.
  const tilted = lookAt([2, 1.5, 2], [0, 0, 0], [0, 1, 0]);
  const flatPlane = resolveStudioBackdropPlane(tilted, flat, {});
  assert.deepEqual(
    [flatPlane.normalX, flatPlane.normalY, flatPlane.normalZ, flatPlane.offset],
    [0, 0, -1, -0]
  );
  const empty = resolveStudioPaneGeometry(null, 3, {});
  for (const [key, value] of Object.entries(empty)) {
    if (key !== 'flat') assert.ok(Number.isFinite(value), key);
  }
});

test('a 3-D cloud seen level stands in front of a dot surface square to the camera', () => {
  const cloud = resolveStudioPaneGeometry({ min: [-1, -0.6, -0.8], max: [1, 0.7, 0.8] }, 3, {});
  const corners = [];
  for (const x of [-1, 1]) for (const y of [-0.6, 0.7]) for (const z of [-0.8, 0.8]) corners.push([x, y, z]);
  // Every azimuth and pitch: the plane faces the camera, lies behind every
  // cell, and its lattice axes are the screen's right and up.
  for (let theta = 0; theta < 2 * Math.PI; theta += 0.37) {
    for (const pitch of [-0.6, -0.2, 0, 0.05, 0.3]) {
      const eye = [
        4 * Math.cos(pitch) * Math.cos(theta),
        4 * Math.sin(pitch),
        4 * Math.cos(pitch) * Math.sin(theta),
      ];
      const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
      const plane = resolveStudioBackdropPlane(view, cloud, {});
      const normal = [plane.normalX, plane.normalY, plane.normalZ];
      const forward = [-view[2], -view[6], -view[10]];
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(normal[i] - forward[i]) < 1e-9);
      for (const corner of corners) {
        const depth = normal[0] * corner[0] + normal[1] * corner[1] + normal[2] * corner[2];
        assert.ok(depth < plane.offset, `a cell is behind the dot surface at theta ${theta}`);
      }
      const dotUV = plane.uX * plane.vX + plane.uY * plane.vY + plane.uZ * plane.vZ;
      const dotUN = plane.uX * normal[0] + plane.uY * normal[1] + plane.uZ * normal[2];
      assert.ok(Math.abs(dotUV) < 1e-9 && Math.abs(dotUN) < 1e-9);
    }
  }
});

test('the surface follows the pane, never the camera angle', () => {
  // A 3-D pane is on the floor and a flat or planar pane on the dot surface,
  // whatever the camera's pitch; the two crossfade only while a pane changes
  // between them.
  assert.deepEqual(resolveStudioSurfaceWeights(0, {}), { floor: 1, backdrop: 0 });
  assert.deepEqual(resolveStudioSurfaceWeights(1, {}), { floor: 0, backdrop: 1 });
  assert.deepEqual(resolveStudioSurfaceWeights(0.25, {}), { floor: 0.75, backdrop: 0.25 });
  assert.equal(resolveStudioSurfaceWeights.length, 2, 'the weights take no camera input');
});

test('flat panes and planar navigation sit on dots; 3-D orbit and free-fly stand on the floor', () => {
  assert.equal(studioSurfacePlanarity(1, 'planar'), 1);
  assert.equal(studioSurfacePlanarity(2, 'orbit'), 1);
  assert.equal(studioSurfacePlanarity(3, 'planar'), 1);
  assert.equal(studioSurfacePlanarity(3, 'orbit'), 0);
  assert.equal(studioSurfacePlanarity(3, 'free'), 0);
});

test('the pool lies under the data and disappears from below the floor', () => {
  const above = paneRenderState({ eye: [3, 2, 3], planarity: 0 });
  const pool = resolveStudioPool(above.mvpMatrix, above.cameraPosition, above.backdrop, {});
  assert.ok(pool.gate > 0);
  for (const key of ['centerX', 'centerY', 'axisAX', 'axisAY', 'axisBX', 'axisBY']) {
    assert.ok(Number.isFinite(pool[key]), key);
  }
  assert.ok(pool.centerY < 0, 'the pool is below the data centre on screen');

  const below = paneRenderState({ eye: [3, -3, 3], planarity: 0 });
  assert.equal(
    resolveStudioPool(below.mvpMatrix, below.cameraPosition, below.backdrop, {}).gate,
    0
  );
  assert.equal(studioFalloff(0), 1);
  assert.equal(studioFalloff(1), 0);
  assert.equal(studioFalloff(3), 0);
});

// ---------------------------------------------------------------------------
// Shader source
// ---------------------------------------------------------------------------

test('the shader is generated from the constant table and declares every uniform the viewer sets', async () => {
  assert.match(STUDIO_VS_SOURCE, /^#version 300 es/);
  assert.match(STUDIO_FS_SOURCE, /^#version 300 es/);
  const constant = (name) => {
    const match = STUDIO_FS_SOURCE.match(new RegExp(`const float ${name} = ([-0-9.e]+);`));
    assert.ok(match, `missing ${name}`);
    return Number(match[1]);
  };
  assert.equal(constant('LATTICE_RATIO'), STUDIO_LATTICE.ratio);
  assert.equal(constant('FLOOR_MIN_CELL_CSS'), STUDIO_SURFACES.floor.minCellCssPx);
  assert.equal(constant('BACKDROP_MIN_CELL_CSS'), STUDIO_SURFACES.backdrop.minCellCssPx);
  assert.equal(constant('LINE_WIDTH_CSS'), STUDIO_MARKS.lineWidthCssPx);
  assert.equal(constant('MAJOR_DOT_RADIUS_CSS'), STUDIO_MARKS.majorDotRadiusCssPx);
  assert.equal(constant('STAGE_OUTER'), STUDIO_STAGE.outerRadius);
  assert.equal(constant('FLOOR_MAX_SPACING'), STUDIO_SURFACES.floor.maxFamilySpacing);

  const viewerSource = await read('assets/js/rendering/viewer.js');
  const block = viewerSource.slice(
    viewerSource.indexOf('const studioUniformLocations = {'),
    viewerSource.indexOf('};', viewerSource.indexOf('const studioUniformLocations = {'))
  );
  const requested = [...block.matchAll(/'(u_[A-Za-z]+)'/g)].map((match) => match[1]);
  const declared = [...STUDIO_FS_SOURCE.matchAll(/^uniform \w+ (u_[A-Za-z]+);/gm)].map((match) => match[1]);
  assert.deepEqual([...requested].sort(), [...declared].sort());
  // Derivatives are taken before any branch, in uniform control flow.
  const main = STUDIO_FS_SOURCE.slice(STUDIO_FS_SOURCE.indexOf('void main()'));
  assert.ok(main.lastIndexOf('dFdy(') < main.indexOf('if ('));
});

test('palette surfaces are exact 8-bit colours and the dark stage is a neutral charcoal below Grid (dark)', () => {
  for (const palette of Object.values(STUDIO_PALETTES)) {
    for (const key of ['surface', 'glow', 'ink']) {
      for (const channel of palette[key]) assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255);
    }
  }
  const [r, g, b] = STUDIO_PALETTES['studio-dark'].surface;
  assert.ok(r === g && g === b, 'no colour cast');
  // Grid (dark) is #14161a; its luma is ~21.9.
  assert.ok(0.2126 * r + 0.7152 * g + 0.0722 * b < 0.2126 * 20 + 0.7152 * 22 + 0.0722 * 26);
});

// ---------------------------------------------------------------------------
// Figure export
// ---------------------------------------------------------------------------

test('a planar pane exports its dot surface on the lattice, with the glow on viewer paper', () => {
  const renderState = paneRenderState({ eye: [0, 0, 2.5], planarity: 1 });
  const built = model({ renderState });
  assert.equal(built.kind, 'studio');
  assert.equal(built.segments.length, 0);
  assert.ok(built.dots.length > 20);
  assert.equal(built.gradients.length, 1, 'glow only: a planar pane has no floor pool');

  // Fronto-parallel: dot centres are exactly a lattice in plot space, never
  // closer than the fade-in spacing on screen.
  const xs = [...new Set(built.dots.map((dot) => dot.cx.toFixed(3)))].map(Number).sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, index) => x - xs[index]);
  const scale = Math.min(PLOT_RECT.width / VIEWPORT.width, PLOT_RECT.height / VIEWPORT.height);
  const minimumGap =
    STUDIO_SURFACES.backdrop.minCellCssPx * STUDIO_LATTICE.fadeInFraction * scale;
  assert.ok(Math.min(...gaps) >= minimumGap - 1e-6);
  for (const dot of built.dots) {
    assert.ok(dot.r >= STUDIO_MARKS.dotRadiusCssPx * scale - 1e-9);
    assert.ok(dot.r <= STUDIO_MARKS.majorDotRadiusCssPx * scale + 1e-9);
  }

  const onWhite = model({ renderState, background: 'white', backgroundColor: '#ffffff' });
  assert.equal(onWhite.gradients.length, 0, 'the glow lightens only the viewer surface');
  const transparent = model({ renderState, background: 'transparent', backgroundColor: '#ffffff' });
  assert.equal(transparent.gradients.length, 0);
});

test('an oblique 3-D pane exports fading floor rules and its pool, and nothing past the stage', () => {
  const renderState = paneRenderState({ eye: [3.2, 2.0, 3.6], planarity: 0 });
  const built = model({ appearance: DARK, renderState });
  assert.ok(built.segments.length > 10);
  assert.equal(built.dots.length, 0, 'rules, not dots, from an oblique camera');
  assert.equal(built.gradients.length, 2, 'glow and pool');
  const surfaceHex = `#${STUDIO_PALETTES['studio-dark'].surface.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  let fadedEnds = 0;
  for (const segment of built.segments) {
    assert.ok(segment.stops.length > 2);
    assert.ok(segment.widthPx > 0);
    for (let i = 1; i < segment.stops.length; i++) {
      assert.ok(segment.stops[i].offset >= segment.stops[i - 1].offset - 1e-9);
    }
    if (segment.stops.at(-1).color === surfaceHex || segment.stops[0].color === surfaceHex) fadedEnds += 1;
  }
  assert.ok(fadedEnds > 0, 'rules fade into the surface at the stage edge');

  // The pool is ink at a varying opacity, never stronger than the palette.
  const pool = built.gradients[1];
  const ink = `#${STUDIO_PALETTES['studio-dark'].ink.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  for (const stop of pool.stops) {
    assert.equal(stop.color, ink);
    assert.ok(stop.opacity <= STUDIO_PALETTES['studio-dark'].poolAlpha + 1e-12);
  }
  assert.equal(pool.stops.at(-1).opacity, 0);
});

test('a camera under the floor exports a plain stage: no floor, no dot surface', () => {
  // The floor is seen from above only; below it, it has faded away, and a 3-D
  // pane never shows the dot surface.
  const renderState = paneRenderState({ eye: [3, -2.5, 3], planarity: 0 });
  const built = model({ renderState });
  assert.equal(built.segments.length, 0, 'no floor rules from below');
  assert.equal(built.dots.length, 0, 'no dot surface for a 3-D pane');
});

test('a 3-D floor seen from straight above is still ruled, never dots', () => {
  const renderState = paneRenderState({ eye: [0, 4, 0], up: [0, 0, -1], planarity: 0 });
  const built = model({ renderState });
  assert.ok(built.segments.length > 0, 'rules from straight above');
  assert.equal(built.dots.length, 0, 'the floor never turns into dots');
});

test('a level 3-D view never exports the dot surface', () => {
  const renderState = paneRenderState({ eye: [3.4, 0.05, 3.4], planarity: 0 });
  const built = model({ renderState });
  assert.equal(built.dots.length, 0);
});

test('SVG and Canvas2D draw the same studio backdrop', () => {
  const built = model({ appearance: DARK, renderState: paneRenderState({ eye: [3.2, 2.0, 3.6], planarity: 0 }) });
  const svg = renderSvgReferenceGrid(built, 'reference_layer_3');
  assert.equal((svg.match(/<line /g) ?? []).length, built.segments.length);
  assert.equal((svg.match(/<linearGradient id="reference_layer_3-rule-/g) ?? []).length, built.segments.length);
  assert.equal((svg.match(/<radialGradient id="reference_layer_3-tone-/g) ?? []).length, built.gradients.length);
  assert.equal((svg.match(/<circle /g) ?? []).length, built.dots.length);
  assert.throws(() => renderSvgReferenceGrid(built, '3bad'), /element-id prefix/);

  const calls = { stroke: 0, fill: 0, linear: 0, radial: 0 };
  const gradient = { addColorStop() {} };
  const ctx = {
    save() {}, restore() {}, beginPath() {}, rect() {}, transform() {}, moveTo() {}, lineTo() {}, arc() {},
    stroke() { calls.stroke += 1; },
    fill() { calls.fill += 1; },
    createLinearGradient() { calls.linear += 1; return gradient; },
    createRadialGradient() { calls.radial += 1; return gradient; },
  };
  drawCanvasReferenceGrid({ ctx, model: built });
  assert.equal(calls.stroke, built.segments.length);
  assert.equal(calls.linear, built.segments.length);
  assert.equal(calls.radial, built.gradients.length);
  assert.equal(calls.fill, built.gradients.length + built.dots.length);
});

test('the studio appearance carries the viewer palette and surface', () => {
  for (const [mode, appearance] of [['studio', LIGHT], ['studio-dark', DARK]]) {
    assert.equal(appearance.kind, 'studio');
    assert.equal(appearance.palette, STUDIO_PALETTES[mode]);
    assert.deepEqual([...appearance.surfaceColor], studioColor01(STUDIO_PALETTES[mode].surface));
  }
});

test('a flat pane seen at a grazing angle exports each visible dot once, with no candidate ceiling', () => {
  // A flat embedding keeps its dot surface on its own plane (z = 0) whatever
  // the camera, so an orbit camera skimming that plane sees the lattice run
  // to the horizon. Candidates are taken only near the screen samples where
  // a family shows, so the work follows what is visible, not the plane's
  // extent: there is no count at which the export refuses.
  const geometry = resolveStudioPaneGeometry({ min: [-1, -0.6, 0], max: [1, 0.7, 0] }, 2, {});
  const scale = Math.min(PLOT_RECT.width / VIEWPORT.width, PLOT_RECT.height / VIEWPORT.height);
  for (const [distance, degrees, pixelRatio] of [[3, 30, 1], [3, 5, 2], [1, 3, 2], [0.05, 30, 2]]) {
    const elevation = degrees * Math.PI / 180;
    const eye = [0, -distance * Math.cos(elevation), distance * Math.sin(elevation)];
    const projection = perspective(Math.PI / 4, VIEWPORT.width / VIEWPORT.height, 0.0005, 1000);
    const view = lookAt(eye, [0, 0, 0], [0, 0, 1]);
    const built = model({
      renderState: {
        backdrop: { ...geometry, glowCenterX: 0, pixelRatio, planarity: 1 },
        cameraPosition: eye,
        mvpMatrix: Float32Array.from(multiply(projection, view)),
        viewMatrix: Float32Array.from(view),
        viewportHeight: VIEWPORT.height,
        viewportWidth: VIEWPORT.width,
      },
    });
    assert.ok(built.dots.length > 0, `dots at ${degrees}°`);
    const centres = new Set(built.dots.map((dot) => `${dot.cx.toFixed(4)},${dot.cy.toFixed(4)}`));
    assert.equal(centres.size, built.dots.length, 'no lattice position is drawn twice');
    const reach = STUDIO_MARKS.majorDotRadiusCssPx * pixelRatio * scale;
    for (const dot of built.dots) {
      assert.ok(dot.cx >= PLOT_RECT.x - reach && dot.cx <= PLOT_RECT.x + PLOT_RECT.width + reach);
      assert.ok(dot.cy >= PLOT_RECT.y - reach && dot.cy <= PLOT_RECT.y + PLOT_RECT.height + reach);
    }
  }
});
