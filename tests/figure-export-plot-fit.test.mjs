/**
 * F62: a figure shows exactly what its view frames on screen. The plot takes
 * the view's aspect (or the framing crop's) inside the requested size, the
 * view fills it with the screen's own projection (no letterbox, no blank
 * band), points keep their on-screen size, and the axes are the rulers of
 * exactly what is drawn.
 *
 * Before the fix a 16:10 view exported at 720 × 500 drew its cells in a
 * 720 × 450 band of a 720 × 500 plot while the axes spanned all 500 px, and a
 * narrow grid pane drew its cells in a middle band of a wide plot.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlotPlacement,
  figureSourceAspect,
  fitPlotSize,
} from '../assets/js/app/ui/modules/figure-export/utils/plot-fit.js';
import {
  computeGridFigureLayout,
  computeSingleViewLayout,
} from '../assets/js/app/ui/modules/figure-export/utils/layout.js';
import {
  axisTicksAtStep,
  computeSourceAxisBounds,
  figurePanelAxes,
  figureViewHasAxes,
  planAxisTicks,
  planFigureAxes,
  renderSvgAxes,
} from '../assets/js/app/ui/modules/figure-export/components/axes-builder.js';
import { renderSvgOrientationIndicator } from '../assets/js/app/ui/modules/figure-export/components/orientation-indicator.js';
import { estimateTextWidth } from '../assets/js/app/ui/modules/figure-export/utils/text-measure.js';
import { forEachProjectedPoint } from '../assets/js/app/ui/modules/figure-export/utils/point-projector.js';

/** What a flat 2-D plot's axes show (`AxesSpec`). */
const AXES = { bounds: { minX: -8, maxX: 12, minY: -6, maxY: 9 }, xLabel: 'UMAP 1', yLabel: 'UMAP 2', tickFontPx: 12, labelFontPx: 12 };

const close = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${label}: ${actual} !== ${expected}`
);

/** Column-major perspective projection, the viewer's (`mat4.perspective`). */
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function multiply(a, b) {
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

/** A camera at (cx, cy, distance) looking down -z at (cx, cy, 0). */
function lookingDown(cx, cy, distance) {
  return Float32Array.from([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -cx, -cy, -distance, 1,
  ]);
}

function viewState({ viewportWidth, viewportHeight, cx = 0, cy = 0, distance = 3 }) {
  const projectionMatrix = perspective(Math.PI / 4, viewportWidth / viewportHeight, 0.01, 100);
  const viewMatrix = lookingDown(cx, cy, distance);
  return {
    viewportWidth,
    viewportHeight,
    projectionMatrix,
    viewMatrix,
    modelMatrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    lightDir: Float32Array.from([0, 0, 1]),
    fov: Math.PI / 4,
    sizeAttenuation: 0.8,
    pointSizeMax: 160,
    mvpMatrix: multiply(projectionMatrix, viewMatrix),
  };
}

function cameraState(navigationMode, target) {
  return {
    navigationMode,
    orbit: { radius: 3, targetRadius: 3, theta: 0, phi: Math.PI / 2, target },
    freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 },
  };
}

/** The plot point a model-space point is drawn at, or null where it is not. */
function drawnAt({ renderState, plotRect, crop = null, point }) {
  let at = null;
  forEachProjectedPoint({
    positions: Float32Array.from(point),
    dimension: 3,
    colors: Uint8Array.from([0, 0, 0, 255]),
    colorAlpha: 'layer',
    pointDiameterViewportPx: 3,
    renderState,
    plotRect,
    crop,
    onPoint: (x, y) => { at = { x, y }; },
  });
  return at;
}

test('the plot is the largest rectangle of the view\'s aspect inside the requested size', () => {
  // The F62 case: a 1440 × 900 (16:10) screen exported at 720 × 500.
  const aspect = figureSourceAspect({ renderState: { viewportWidth: 1440, viewportHeight: 900 } });
  assert.deepEqual(fitPlotSize({ aspect, width: 720, height: 500 }), { width: 720, height: 450 });
  // A tall box keeps the width and gives up height.
  assert.deepEqual(fitPlotSize({ aspect, width: 300, height: 700 }), { width: 300, height: 187.5 });
  // A narrow on-screen pane (a grid of two on that screen) in the same box.
  const narrow = figureSourceAspect({ renderState: { viewportWidth: 720, viewportHeight: 900 } });
  assert.deepEqual(fitPlotSize({ aspect: narrow, width: 720, height: 500 }), { width: 400, height: 500 });
  // A crop's aspect, in viewport pixels.
  const cropAspect = figureSourceAspect({
    renderState: { viewportWidth: 1440, viewportHeight: 900 },
    crop: { enabled: true, x: 0.25, y: 0.25, width: 0.5, height: 0.25 },
  });
  assert.equal(cropAspect, 720 / 225);
});

test('a single-view figure is laid out around the fitted plot, with no band beside it', () => {
  const base = { title: '', includeLegend: false, axes: AXES, measureText: () => 0 };
  const wide = computeSingleViewLayout({ ...base, width: 720, height: 500, plotAspect: 16 / 10 });
  assert.equal(wide.plotRect.width, 720);
  assert.equal(wide.plotRect.height, 450);
  // The figure is the plot plus its margins: 50 px shorter than a 720 × 500 plot's.
  const square = computeSingleViewLayout({ ...base, width: 720, height: 500, plotAspect: 720 / 500 });
  assert.equal(square.totalWidth, wide.totalWidth);
  assert.equal(square.totalHeight - wide.totalHeight, 50);
  const tall = computeSingleViewLayout({ ...base, width: 720, height: 500, plotAspect: 0.8 });
  assert.equal(tall.plotRect.height, 500);
  assert.equal(tall.plotRect.width, 400);
  assert.equal(square.totalWidth - tall.totalWidth, 320);
});

test('every grid panel\'s plot takes its own view\'s aspect inside its cell', () => {
  const views = ['a', 'b'].map(id => ({ id, scientificState: { fieldKey: null, legendModel: null } }));
  const plotAspects = [16 / 10, 0.8];
  const layout = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
    width: 1200,
    height: 600,
    views,
    plotAspects,
    panelAxes: [AXES, AXES],
    includeLegend: false,
    fontSize: 12,
    measureText: () => 0,
  });
  for (const [index, pane] of layout.panes.entries()) {
    close(pane.plotRect.width / pane.plotRect.height, plotAspects[index], 1e-12, `pane ${index} aspect`);
    // Inside its cell.
    assert.ok(pane.plotRect.x >= pane.panelRect.x && pane.plotRect.y >= pane.panelRect.y);
    assert.ok(pane.plotRect.x + pane.plotRect.width <= pane.panelRect.x + pane.panelRect.width);
    assert.ok(pane.plotRect.y + pane.plotRect.height <= pane.panelRect.y + pane.panelRect.height);
  }
  // The panels' plots start at one height.
  assert.equal(layout.panes[0].plotRect.y, layout.panes[1].plotRect.y);
  assert.throws(
    () => computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)),  width: 1200, height: 600, views, plotAspects: [1], panelAxes: [AXES, AXES], fontSize: 12, measureText: () => 0 }),
    /one plot aspect per view/
  );
  assert.throws(
    () => computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)),  width: 1200, height: 600, views, plotAspects, panelAxes: [AXES], fontSize: 12, measureText: () => 0 }),
    /what each panel's axes show/
  );
});

test('the view fills the plot exactly, with the screen\'s projection and point size', () => {
  const renderState = viewState({ viewportWidth: 1440, viewportHeight: 900 });
  const plotRect = { x: 82, y: 30, ...fitPlotSize({ aspect: 1440 / 900, width: 720, height: 500 }) };
  const placement = createPlotPlacement({ renderState, plotRect });
  // The viewport's corners are the plot's corners.
  assert.deepEqual(placement.viewportToPlot(0, 0), { x: 82, y: 30 });
  const corner = placement.viewportToPlot(1440, 900);
  close(corner.x, 82 + 720, 1e-9, 'right edge');
  close(corner.y, 30 + 450, 1e-9, 'bottom edge');
  // WYSIWYG: a viewer pixel is `scale` plot units in both directions, so a
  // 4 px point is 2 plot units at half the screen's size.
  assert.equal(placement.scale, 0.5);
  // The cell at the screen's center is drawn at the plot's center.
  const drawn = drawnAt({ renderState, plotRect, point: [0, 0, 0] });
  close(drawn.x, 82 + 360, 1e-3, 'centre x');
  close(drawn.y, 30 + 225, 1e-3, 'centre y');
  // A plot of another aspect is refused: a figure is never letterboxed.
  assert.throws(
    () => createPlotPlacement({ renderState, plotRect: { x: 0, y: 0, width: 720, height: 500 } }),
    /aspect/
  );
});

test('the axes of a 2-D view frame exactly what is drawn', () => {
  // A planar view of an embedding normalized by scale 0.5 around (10, -4),
  // panned off-center, on a 16:10 screen, exported at 720 × 500.
  const renderState = viewState({ viewportWidth: 1440, viewportHeight: 900, cx: 0.3, cy: -0.2, distance: 2 });
  const plotRect = { x: 0, y: 0, ...fitPlotSize({ aspect: 1440 / 900, width: 720, height: 500 }) };
  const normTransform = { center: [10, -4, 0], scale: 0.5 };
  const bounds = computeSourceAxisBounds({
    renderState,
    dimension: 2,
    cameraState: cameraState('planar', [0.3, -0.2, 0]),
    normTransform,
  });
  // The view is 1.6 times as wide as tall, and so are the axes.
  close((bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY), 1440 / 900, 1e-6, 'axis aspect');
  // A cell at each axis end lies on the matching plot edge.
  const toModel = (x, y) => [(x - 10) * 0.5, (y + 4) * 0.5, 0];
  const inset = 1e-4 * (bounds.maxX - bounds.minX);
  const topRight = drawnAt({ renderState, plotRect, point: toModel(bounds.maxX - inset, bounds.maxY - inset) });
  const bottomLeft = drawnAt({ renderState, plotRect, point: toModel(bounds.minX + inset, bounds.minY + inset) });
  close(topRight.x, plotRect.width, 0.2, 'max x at the right edge');
  close(topRight.y, 0, 0.2, 'max y at the top edge');
  close(bottomLeft.x, 0, 0.2, 'min x at the left edge');
  close(bottomLeft.y, plotRect.height, 0.2, 'min y at the bottom edge');
  // A cell just past an axis end is not drawn: the axes cover nothing empty.
  assert.equal(drawnAt({ renderState, plotRect, point: toModel(bounds.maxX + inset, 0) }), null);

  // A crop: the axes are the crop's edges.
  const crop = { enabled: true, x: 0.5, y: 0, width: 0.5, height: 0.5 };
  const cropped = computeSourceAxisBounds({
    renderState,
    crop,
    dimension: 2,
    cameraState: cameraState('planar', [0.3, -0.2, 0]),
    normTransform,
  });
  close(cropped.minX, (bounds.minX + bounds.maxX) / 2, 1e-5, 'crop left edge is the view centre');
  close(cropped.maxX, bounds.maxX, 1e-5, 'crop right edge');
  close(cropped.minY, (bounds.minY + bounds.maxY) / 2, 1e-5, 'crop bottom edge is the view centre');
  close(cropped.maxY, bounds.maxY, 1e-5, 'crop top edge');
});

test('axes only where they are rulers: a 1-D or 2-D view seen planar', () => {
  // Found 2026-11-11 (F86): a 3-D orbit view's figure carried X/Y ticks in
  // camera units on the focal plane, exact at one depth only and read by
  // everyone as UMAP coordinates. A perspective picture of cells at many
  // depths has no single scale: no axes, and no margins for them.
  assert.equal(figureViewHasAxes({ dimension: 2, navigationMode: 'planar' }), true);
  assert.equal(figureViewHasAxes({ dimension: 1, navigationMode: 'planar' }), true);
  assert.equal(figureViewHasAxes({ dimension: 3, navigationMode: 'orbit' }), false);
  assert.equal(figureViewHasAxes({ dimension: 3, navigationMode: 'free' }), false);
  // A 3-D cloud seen from above is still cells at many depths.
  assert.equal(figureViewHasAxes({ dimension: 3, navigationMode: 'planar' }), false);
  // A flat embedding tilted by orbiting: one plot length is a different
  // embedding distance at every depth.
  assert.equal(figureViewHasAxes({ dimension: 2, navigationMode: 'orbit' }), false);

  const view = (dimensionLevel, navigationMode) => ({ scientificState: { dimensionLevel }, cameraState: { navigationMode } });
  assert.deepEqual(figurePanelAxes([view(2, 'planar'), view(3, 'orbit')], true), [true, false]);
  assert.deepEqual(figurePanelAxes([view(2, 'planar'), view(3, 'orbit')], false), [false, false]);

  // Nothing measures a 3-D view's axes.
  assert.throws(() => computeSourceAxisBounds({
    renderState: viewState({ viewportWidth: 1440, viewportHeight: 900 }),
    dimension: 3,
    cameraState: cameraState('orbit', [0, 0, 0]),
    normTransform: { center: [0, 0, 0], scale: 1 },
  }), /figureViewHasAxes/);

  // A single 3-D view's figure has no axis margins: its plot is only padded.
  const base = { width: 720, height: 450, plotAspect: 1.6, title: '', includeLegend: false, measureText: () => 0 };
  const flat = computeSingleViewLayout({ ...base, axes: AXES });
  const orbit = computeSingleViewLayout({ ...base, axes: null });
  assert.equal(orbit.axes, null);
  assert.equal(flat.totalWidth - orbit.totalWidth, flat.axes.margins.left - 10);
  assert.equal(orbit.plotRect.x, 30);
});

test('an axis is a ruler: its ticks lie between its ends, where their values are', () => {
  const axis = planAxisTicks({
    min: -0.93, max: 1.07, lengthPx: 1000, direction: 'x', fontPx: 12, measureText: estimateTextWidth,
  });
  assert.deepEqual(axis.labels, ['-0.5', '0', '0.5', '1']);
  for (const [index, value] of [-0.5, 0, 0.5, 1].entries()) {
    close(axis.fractions[index], (value + 0.93) / 2, 1e-12, `tick ${value}`);
  }
  assert.throws(() => axisTicksAtStep(1, 1, 0.1), /max above min/);
});

/** The tick labels an SVG axis group writes along one axis, with their positions. */
function svgTickLabels(svg, anchor) {
  return [...svg.matchAll(new RegExp(`<text x="([^"]+)" y="([^"]+)" text-anchor="${anchor}" font-size="[^"]+" stroke="none">([^<]+)</text>`, 'g'))]
    .map(([, x, y, label]) => ({ x: Number(x), y: Number(y), label }));
}

test('the tick labels of a narrow axis never overlap at the figure\'s font', () => {
  // A narrow grid panel of a two-view export (r7): a ±0.45 view about
  // 110 px wide, and a short y-axis.
  const plotRect = { x: 62, y: 40, width: 110, height: 60 };
  const bounds = { minX: -0.45, maxX: 0.45, minY: -0.62, maxY: 0.62 };
  const fontPx = 12;
  // The five ticks of a long axis (step 0.2) collide on this one.
  const crowded = axisTicksAtStep(bounds.minX, bounds.maxX, 0.2);
  const crowdedCollide = crowded.fractions.some((fraction, i) => i > 0 &&
    (fraction - crowded.fractions[i - 1]) * plotRect.width <
      (estimateTextWidth(crowded.labels[i - 1], fontPx) + estimateTextWidth(crowded.labels[i], fontPx)) / 2);
  assert.equal(crowdedCollide, true, 'the fixture reproduces "-0.40.2 0 0.20.4"');

  const axes = planFigureAxes({
    bounds, plotWidth: plotRect.width, plotHeight: plotRect.height, tickFontPx: fontPx, measureText: estimateTextWidth,
  });
  const svg = renderSvgAxes({ plotRect, axes });
  const gap = Math.max(4, fontPx * 0.5);
  const xTicks = svgTickLabels(svg, 'middle').filter(tick => tick.label !== 'X');
  assert.ok(xTicks.length >= 2, `x ticks: ${xTicks.map(tick => tick.label)}`);
  for (let i = 1; i < xTicks.length; i++) {
    const room = xTicks[i].x - xTicks[i - 1].x;
    const need = (estimateTextWidth(xTicks[i - 1].label, fontPx) + estimateTextWidth(xTicks[i].label, fontPx)) / 2 + gap;
    assert.ok(room >= need, `${xTicks[i - 1].label} and ${xTicks[i].label}: ${room} px < ${need} px`);
  }
  const yTicks = svgTickLabels(svg, 'end');
  assert.ok(yTicks.length >= 1);
  for (let i = 1; i < yTicks.length; i++) {
    assert.ok(Math.abs(yTicks[i].y - yTicks[i - 1].y) >= fontPx + gap, 'y labels keep a line and a gap apart');
  }

  // A long axis keeps its five ticks; a shorter one gets fewer, never more.
  const ticksAt = lengthPx => planAxisTicks({
    min: -0.45, max: 0.45, lengthPx, direction: 'x', fontPx, measureText: estimateTextWidth,
  }).labels.length;
  assert.equal(ticksAt(1000), 5);
  let previous = Infinity;
  for (const lengthPx of [1000, 400, 200, 110, 80, 40]) {
    const count = ticksAt(lengthPx);
    assert.ok(count >= 1 && count <= previous, `${lengthPx} px: ${count} ticks`);
    previous = count;
  }
});

test('the orientation badge takes the same share of the plot as of the on-screen view', () => {
  const viewMatrix = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1]);
  const camera = cameraState('orbit', [0, 0, 0]);
  // One 720 × 1000 pane drawn at full size, and at a fifth of it in a grid panel.
  const badge = (plotRect, plotScale) => {
    const svg = renderSvgOrientationIndicator({ plotRect, plotScale, viewMatrix, cameraState: camera, fontSize: 12 });
    const [, tx, ty, scale] = svg.match(/transform="translate\(([^ ]+) ([^)]+)\) scale\(([^)]+)\)"/).map(Number);
    const [, x, y, width] = svg.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)"/).map(Number);
    return { left: tx + x * scale, top: ty + y * scale, size: width * scale };
  };
  const full = badge({ x: 0, y: 0, width: 720, height: 1000 }, 1);
  const panel = { x: 300, y: 50, width: 144, height: 200 };
  const small = badge(panel, 0.2);
  close(small.size / panel.width, full.size / 720, 1e-12, 'share of the plot\'s width');
  close(small.size, full.size * 0.2, 1e-12, 'scaled by plot px over viewport px');
  // Inside the panel's plot, at the same place relative to it.
  assert.ok(small.left >= panel.x && small.left + small.size <= panel.x + panel.width);
  assert.ok(small.top >= panel.y && small.top + small.size <= panel.y + panel.height);
  close((small.left - panel.x) / panel.width, full.left / 720, 1e-12, 'same place');
  assert.throws(
    () => renderSvgOrientationIndicator({ plotRect: panel, viewMatrix, cameraState: camera }),
    /plotScale/
  );
});
