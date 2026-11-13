/**
 * A figure of a view with the vector field shown draws a still picture of the
 * flow, arrows on a grid as scVelo's `velocity_embedding_grid`, from the same
 * cells, vectors, camera, filters and color scheme as the screen, in SVG and
 * PNG alike, with a key, and its provenance names the field.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRID_ACROSS,
  drawCanvasVectorField,
  formatSpeed,
  planVectorFieldFigure,
  planVectorFieldKey,
  renderSvgVectorField,
} from '../assets/js/app/ui/modules/figure-export/components/vector-field-figure.js';
import { renderFigureToSvgBlob } from '../assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js';
import { assertFigureExportPayload } from '../assets/js/app/ui/modules/figure-export/figure-export-contract.js';
import { buildProvenanceDescription } from '../assets/js/app/ui/modules/figure-export/utils/figure-provenance.js';
import { getColormap } from '../assets/js/data/palettes.js';
import './helpers/figure-export-worker-in-process.mjs';

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const PLOT = { x: 0, y: 0, width: 400, height: 300 };
const INK = { surface: '#ffffff', surfaceInk: '#111111', frame: '#e5e7eb', halo: '#ffffff' };

function renderState() {
  return {
    antialias: true,
    backdrop: {
      centerY: 0, extentX: 1, extentY: 1, extentZ: 1, flat: true, floorY: -1.12, glowCenterX: 0,
      look: null, pixelRatio: 1, planarity: 1, stageX: 0, stageZ: 0,
    },
    bgColor: Float32Array.from([1, 1, 1]),
    cameraDistance: 3,
    pointSizeMax: 160,
    cameraPosition: [0, 0, 3],
    far: 100,
    fogColor: Float32Array.from([1, 1, 1]),
    fogDensity: 0,
    fogFar: 3.5,
    fogNear: 2.5,
    fov: Math.PI / 4,
    lightDir: Float32Array.from([0, 0, 1]),
    lightingStrength: 1,
    modelMatrix: new Float32Array(IDENTITY),
    mvpMatrix: new Float32Array(IDENTITY),
    near: 0.01,
    pointSize: 4,
    projectionMatrix: new Float32Array(IDENTITY),
    shaderQuality: 'full',
    sizeAttenuation: 0,
    viewMatrix: new Float32Array(IDENTITY),
    viewportHeight: 300,
    viewportWidth: 400,
  };
}

/**
 * A 2-D view of cells on a lattice: the left half flows right at speed 0.2,
 * the right half flows up at speed 0.1; `hideRight` filters the right half
 * out, `nanEvery` leaves every n-th cell without a vector.
 */
function scene({ hideRight = false, nanEvery = 0 } = {}) {
  const positions = [];
  const vectors = [];
  const transparency = [];
  let i = 0;
  for (let gy = 0; gy < 30; gy++) {
    for (let gx = 0; gx < 40; gx++) {
      const x = -0.95 + (gx / 39) * 1.9;
      const y = -0.95 + (gy / 29) * 1.9;
      positions.push(x, y);
      const right = x > 0;
      const missing = nanEvery > 0 && i % nanEvery === 0;
      vectors.push(...(missing ? [NaN, NaN] : right ? [0, 0.1] : [0.2, 0]));
      transparency.push(hideRight && right ? 0 : 1);
      i++;
    }
  }
  return {
    positions: Float32Array.from(positions),
    transparency: Uint8Array.from(transparency),
    vectorField: {
      label: 'velocity', colormapId: 'viridis', vectors: Float32Array.from(vectors), maxMagnitude: 0.2, unitsPerRender: 5,
    },
  };
}

function plan(options = {}) {
  const { positions, transparency, vectorField } = scene(options);
  return planVectorFieldFigure({ vectorField, positions, dimension: 2, transparency, renderState: renderState(), plotRect: PLOT });
}

test('arrows follow the field through the camera: right on the left, up on the right, the mean half a step', () => {
  const { arrows, step } = plan();
  assert.ok(arrows.length > 100, 'a grid of arrows covers the cells');
  const left = arrows.filter(arrow => (arrow.x0 + arrow.x1) / 2 < 150);
  const right = arrows.filter(arrow => (arrow.x0 + arrow.x1) / 2 > 250);
  for (const arrow of left) {
    assert.ok(arrow.x1 > arrow.x0 && Math.abs(arrow.y1 - arrow.y0) < 1e-6, 'left half points right');
  }
  for (const arrow of right) {
    // Screen y grows downward: up in the embedding is up on the plot.
    assert.ok(arrow.y1 < arrow.y0 && Math.abs(arrow.x1 - arrow.x0) < 1e-6, 'right half points up');
  }
  // Scaled by the mean, as matplotlib's quiver autoscale (scVelo's): the mean arrow is half a step.
  const lengths = arrows.map(arrow => Math.hypot(arrow.x1 - arrow.x0, arrow.y1 - arrow.y0));
  const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  const gridStep = Math.min(PLOT.width / Math.round(PLOT.width / step), PLOT.height / Math.round(PLOT.height / step));
  assert.ok(Math.abs(mean - 0.5 * gridStep) < 1e-6, `mean arrow ${mean}, half a step ${0.5 * gridStep}`);
  // Length is the vector's image on the plot: 0.2 across 200 px a unit against 0.1 up 150 px a unit.
  // Interior nodes, where every nearby cell is of one half.
  const nearest = (x, y) => arrows.reduce((best, arrow) => {
    const d = Math.hypot((arrow.x0 + arrow.x1) / 2 - x, (arrow.y0 + arrow.y1) / 2 - y);
    return d < best.d ? { d, arrow } : best;
  }, { d: Infinity, arrow: null }).arrow;
  const lengthOf = arrow => Math.hypot(arrow.x1 - arrow.x0, arrow.y1 - arrow.y0);
  const leftLength = lengthOf(nearest(100, 150));
  const rightLength = lengthOf(nearest(300, 150));
  assert.ok(Math.abs(leftLength / rightLength - (0.2 * 200) / (0.1 * 150)) < 0.05, `${leftLength / rightLength}`);
  assert.equal(step, Math.max(PLOT.width, PLOT.height) / GRID_ACROSS);
  // Colored as the overlay colors a particle: speed over the field's largest.
  const fast = getColormap('viridis').sample(1).map(channel => Math.round(channel * 255));
  const slow = getColormap('viridis').sample(0.5).map(channel => Math.round(channel * 255));
  assert.deepEqual(left[Math.floor(left.length / 2)].rgb, fast);
  assert.deepEqual(right[Math.floor(right.length / 2)].rgb, slow);
});

test('the view\'s filter is the figure\'s: cells it hides draw no arrow; cells without a vector add none', () => {
  const filtered = plan({ hideRight: true });
  assert.equal(filtered.arrows.filter(arrow => (arrow.x0 + arrow.x1) / 2 > 260).length, 0);
  assert.ok(filtered.arrows.length > 50);
  const withNaN = plan({ nanEvery: 3 });
  assert.ok(withNaN.arrows.every(arrow => [arrow.x0, arrow.y0, arrow.x1, arrow.y1].every(Number.isFinite)));
  assert.equal(withNaN.cells, 1200 - 400);
  const none = plan({ hideRight: true, nanEvery: 1 });
  assert.deepEqual(none.arrows, []);
});

test('the key stays inside a narrow plot, its text at its size: the field\'s line wraps at its words', () => {
  const thePlan = plan();
  const measure = (text, size) => text.length * size * 0.62;
  // A single-column figure's plot (35 mm, 134 figure pixels) at 7 pt (the key at 0.85 of 9 1/3 px).
  for (const plotRect of [{ x: 62, y: 64, width: 134, height: 100 }, { x: 0, y: 0, width: 90, height: 120 }, PLOT]) {
    const key = planVectorFieldKey(thePlan, { plotRect, fontSizePx: 28 / 3, measure });
    const at = `plot ${plotRect.width} wide`;
    assert.ok(key.x >= plotRect.x, at);
    assert.ok(key.y >= plotRect.y, at);
    // Every word but one wider than the plot itself keeps to it.
    assert.ok(key.x + key.width <= plotRect.x + plotRect.width + 1e-9 || key.lines.some(line => !line.includes(' ')), at);
    assert.equal(key.size, Math.max(8, (28 / 3) * 0.85), 'the text keeps its size');
    assert.equal(key.lines.slice(0, key.labelLines).join(' '), 'velocity: mean arrows of nearby cells', at);
    assert.equal(key.lines[key.labelLines], 'speed 0 – 1');
  }
  // A wide plot keeps the one line.
  assert.equal(planVectorFieldKey(thePlan, { plotRect: PLOT, fontSizePx: 12, measure }).labelLines, 1);
  const narrow = { x: 62, y: 64, width: 134, height: 100 };
  assert.ok(planVectorFieldKey(thePlan, { plotRect: narrow, fontSizePx: 28 / 3, measure }).labelLines > 1);
  // Both renderers draw the wrapped lines.
  const svg = renderSvgVectorField(thePlan, { plotRect: narrow, ink: INK, fontFamily: 'Arial', fontSizePx: 28 / 3, haloColor: '#ffffff', inPlotKey: true });
  const texts = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
  assert.equal(texts.slice(0, -1).join(' '), 'velocity: mean arrows of nearby cells');
});

test('SVG and canvas draw one plan, with the key: the field, how it is drawn, the speed in the embedding\'s units', () => {
  const thePlan = plan();
  const svg = renderSvgVectorField(thePlan, { plotRect: PLOT, ink: INK, fontFamily: 'Arial', fontSizePx: 12, haloColor: '#ffffff', inPlotKey: true });
  assert.equal((svg.match(/<polygon /g) ?? []).length, thePlan.arrows.length * 2 + 1, 'one halo and one head per arrow, one in the key');
  assert.match(svg, /velocity: mean arrows of nearby cells/);
  // 0.2 render units at 5 embedding units each.
  assert.match(svg, /speed 0 – 1</);
  assert.equal(formatSpeed(0.00456), '0.00456');
  const calls = [];
  const ctx = new Proxy({ measureText: text => ({ width: text.length * 6 }), createLinearGradient: () => ({ addColorStop() {} }) }, {
    get: (target, key) => target[key] ?? ((...args) => calls.push([key, args])),
    set: () => true,
  });
  drawCanvasVectorField(ctx, thePlan, { plotRect: PLOT, ink: INK, fontFamily: 'Arial', fontSizePx: 12, haloColor: '#ffffff', inPlotKey: true });
  // Two passes (halo, color) of one head each, plus the key's head.
  assert.equal(calls.filter(([key]) => key === 'closePath').length, thePlan.arrows.length * 2 + 1);
  assert.deepEqual(calls.filter(([key]) => key === 'fillText').map(([, args]) => args[0]), ['velocity: mean arrows of nearby cells', 'speed 0 – 1']);
});

function payload({ vectorField }) {
  const { positions, transparency } = scene();
  const pointCount = transparency.length;
  const view = {
    cameraState: { navigationMode: 'planar', orbit: { radius: 3, targetRadius: 3, theta: 0, phi: Math.PI / 2, target: [0, 0, 0] }, freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 } },
    data: {
      centroidColors: null,
      centroidFlags: { labels: false, points: false },
      centroidLabelTexts: [],
      centroidPositions: null,
      colors: new Uint8Array(pointCount * 4).fill(200),
      pointCount,
      positions,
      transparency,
      vectorField,
    },
    id: 'live',
    label: 'Live',
    name: null,
    renderState: renderState(),
    scientificState: {
      datasetGeneration: 1, dimensionLevel: 2, drawOrder: null, fieldKey: null, fieldKind: null, filters: [],
      geometryGeneration: 1, legendModel: null, lodMembership: null, lodSizeMultiplier: 1,
      normTransform: { center: [0, 0, 0], scale: 0.2 }, pointLayers: { readScale: 1, readEveryLevel: true },
    },
  };
  return {
    dpi: null,
    format: 'svg',
    height: 300,
    gridColumns: 1,
    meta: {
      datasetName: 'Flow', exportedAt: '2026-11-11T00:00:00.000Z',
      views: [{ fieldKey: null, fieldKind: null, filters: [], id: 'live', label: 'Live', name: null, vectorField: vectorField === null ? null : vectorField.label }],
    },
    options: {
      axisLabelFontSizePx: 12, background: 'viewer', backgroundColor: '#ffffff', centroidLabelFontSizePx: 12, crop: null,
      depthSort3d: false, emphasizeSelection: false, fontFamily: 'Arial, sans-serif', fontSizePx: 12, height: 300,
      includeAxes: false, includeLegend: false, legendFontSizePx: 12, legendPosition: 'right', optimizedTargetCount: null,
      referenceGrid: null, selectionMutedOpacity: 0.15, showOrientation: false, strategy: 'full-vector', tickFontSizePx: 12,
      title: '', titleFontSizePx: 15, width: 400, xLabel: 'X', yLabel: 'Y',
    },
    selection: { highlightArray: null, pageName: null, totalCount: 0, visibleCount: 0 },
    title: '',
    views: [view],
    width: 400,
  };
}

test('an SVG export of a view with the field shown draws it and names it in its provenance', async () => {
  const withField = payload({ vectorField: scene().vectorField });
  const svg = await (await renderFigureToSvgBlob({ payload: withField })).text();
  assert.match(svg, /<g class="cellucid-vector-field"/);
  assert.match(svg, /velocity: mean arrows of nearby cells/);
  assert.match(svg, /Vector field: velocity \(arrows: Gaussian-weighted mean of nearby cells(&#39;|') vectors on a grid/);
  const without = await (await renderFigureToSvgBlob({ payload: payload({ vectorField: null }) })).text();
  assert.doesNotMatch(without, /cellucid-vector-field/);
  assert.doesNotMatch(buildProvenanceDescription(payload({ vectorField: null }).meta), /Vector field/);
});

test('the payload holds one vector a cell, and its provenance names the field the panel draws', () => {
  assert.doesNotThrow(() => assertFigureExportPayload(payload({ vectorField: scene().vectorField })));
  const short = payload({ vectorField: { ...scene().vectorField, vectors: new Float32Array(4) } });
  assert.throws(() => assertFigureExportPayload(short), /one vector per point/);
  const unnamed = payload({ vectorField: scene().vectorField });
  unnamed.meta.views[0].vectorField = null;
  assert.throws(() => assertFigureExportPayload(unnamed), /must name the vector field its view draws/);
});

test('with the legend on, the key is the legend\'s rows, laid out with it; only a figure without a legend draws it in the plot', async () => {
  const { computeFigureLayout } = await import('../assets/js/app/ui/modules/figure-export/utils/layout.js');
  const { figureWidthPxOf, figurePxOfPt } = await import('../assets/js/app/ui/modules/figure-export/utils/figure-size.js');
  // A single-column figure (89 mm) in print sizes: the key in its plot covered the cells.
  const legended = payload({ vectorField: scene().vectorField });
  legended.options.includeLegend = true;
  legended.width = figureWidthPxOf(89);
  legended.height = null;
  for (const key of ['fontSizePx', 'legendFontSizePx', 'tickFontSizePx', 'axisLabelFontSizePx', 'centroidLabelFontSizePx']) legended.options[key] = figurePxOfPt(7);
  const { single } = computeFigureLayout(legended);
  assert.equal(single.vectorKeyInLegend, true);
  assert.deepEqual(
    { label: single.legendPlan.vectorKey.label, speed: single.legendPlan.vectorKey.speed },
    { label: 'velocity: mean arrows of nearby cells', speed: 'speed 0 – 1' },
  );
  // The legend's box holds the key's two rows, never over the plot: asked beside the plot, it
  // stands below it, as beside it the figure would be wider than the column (a grid's rule).
  const { legendRect, plotRect } = single;
  assert.equal(single.legendMovedBelow, true);
  assert.equal(single.totalWidth, figureWidthPxOf(89));
  assert.ok(legendRect.y >= plotRect.y + plotRect.height, 'the legend stands below the plot');
  assert.ok(single.legendPlan.vectorKey.top + 2 * 11 <= single.legendPlan.height);
  assert.ok(single.legendPlan.width >= 16 + 'velocity: mean arrows of nearby cells'.length * figurePxOfPt(7) * 0.5);
  const svg = await (await renderFigureToSvgBlob({ payload: legended })).text();
  assert.doesNotMatch(svg, /cellucid-vector-field-key/, 'no key in the plot');
  assert.match(svg, /vector-ramp/);
  assert.equal((svg.match(/velocity: mean arrows of nearby cells/g) ?? []).length, 1);
  // Without the legend the key stands in the plot, as before.
  const bare = payload({ vectorField: scene().vectorField });
  assert.equal(computeFigureLayout(bare).single.vectorKeyInLegend, false);
  assert.match(await (await renderFigureToSvgBlob({ payload: bare })).text(), /cellucid-vector-field-key/);
});

test('in a grid, panels of one key share it in the shared legend; keys that differ each go in their own legend', async () => {
  const { computeGridFigureLayout } = await import('../assets/js/app/ui/modules/figure-export/utils/layout.js');
  const { estimateTextWidth } = await import('../assets/js/app/ui/modules/figure-export/utils/text-measure.js');
  const key = { label: 'velocity: mean arrows of nearby cells', speed: 'speed 0 – 1', colormapId: 'viridis' };
  const other = { ...key, speed: 'speed 0 – 2.5' };
  const views = [{ scientificState: { fieldKey: null, legendModel: null } }, { scientificState: { fieldKey: null, legendModel: null } }];
  const laid = keys => computeGridFigureLayout({
    width: 900, height: 600, columns: 2, views, plotAspects: [1.4, 1.4], panelAxes: [null, null], fontSize: 12,
    legendVectorKeys: keys, measureText: estimateTextWidth,
  });
  const same = laid([key, key]);
  assert.ok(same.sharedLegendPlan.vectorKey !== null);
  assert.deepEqual(same.panes.map(pane => pane.vectorKeyInLegend), [true, true]);
  const differ = laid([key, other]);
  assert.equal(differ.sharedLegendPlan, null);
  assert.deepEqual(differ.panes.map(pane => pane.legendPlan.vectorKey.speed), ['speed 0 – 1', 'speed 0 – 2.5']);
  assert.deepEqual(differ.panes.map(pane => pane.vectorKeyInLegend), [true, true]);
  // One panel without a field: it carries none, the other its own.
  const one = laid([key, null]);
  assert.deepEqual(one.panes.map(pane => pane.vectorKeyInLegend), [true, false]);
  // No legend: every key in its plot.
  const off = computeGridFigureLayout({
    width: 900, height: 600, columns: 2, views, plotAspects: [1.4, 1.4], panelAxes: [null, null], fontSize: 12,
    includeLegend: false, legendVectorKeys: [key, key], measureText: estimateTextWidth,
  });
  assert.deepEqual(off.panes.map(pane => pane.vectorKeyInLegend), [false, false]);
});
