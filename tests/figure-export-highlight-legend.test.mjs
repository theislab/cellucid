/**
 * A figure that draws highlighted cells says so in its legend.
 *
 * Screen, figure and export alike draw the active highlight page's cells over
 * the coloring in the highlight's color. A reader of an exported figure who
 * never saw the app would read the cyan highlight of the germ cells over a
 * gene's viridis as "the cells with high NANOS3" if the legend had no entry
 * for that color. So the legend of every panel that draws highlighted cells
 * carries an entry for them — the highlight's color, the page's name and its
 * cell count — in the PNG and the SVG alike, and the layout sizes the legend
 * with it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drawCanvasLegend,
  planLegend,
  renderSvgLegend,
} from '../assets/js/app/ui/modules/figure-export/components/legend-builder.js';
import {
  computeFigureLayout,
  computeGridFigureLayout,
  computeSingleViewLayout,
} from '../assets/js/app/ui/modules/figure-export/utils/layout.js';
import {
  HIGHLIGHT_CSS,
  figureHighlightLegend,
  highlightLegendEntry,
} from '../assets/js/app/ui/modules/figure-export/utils/highlight-legend.js';
import { HIGHLIGHT_COLOR } from '../assets/js/rendering/shaders/high-perf-shaders.js';
import { renderFigureToSvgBlob } from '../assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js';
import { assertFigureExportPayload } from '../assets/js/app/ui/modules/figure-export/figure-export-contract.js';
import { estimateTextWidth } from '../assets/js/app/ui/modules/figure-export/utils/text-measure.js';
import './helpers/figure-export-worker-in-process.mjs';
import { colorsOf, visibleOf } from './helpers/category-state.mjs';

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const ENTRY = highlightLegendEntry({ pageName: 'Germ cells', cellCount: 1234 });

function categoryLegend() {
  return {
    kind: 'category',
    categories: ['Alpha', 'Beta'],
    colors: colorsOf([[1, 0, 0], [0, 1, 0]]),
    visible: visibleOf([true, true]),
    picker: [[1, 0, 0], [0, 1, 0]],
    counts: null,
  };
}

function colorBar() {
  return { kind: 'continuous', colorbar: { min: 0, max: 7.5 }, colorStops: ['#440154', '#fde725'], stats: { min: 0, max: 7.5 } };
}

/** The swatch and label of every entry an SVG legend writes. */
function svgEntries(svg) {
  return [...svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="10" height="10" fill="([^"]+)"[^>]*\/><text x="([^"]+)" y="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
    .map(([, x, y, fill, textX, textY, label]) => ({ x: Number(x), y: Number(y), fill, textX: Number(textX), textY: Number(textY), label }));
}

/** Canvas2D recorder for a legend: filled swatches and texts. */
function recordingContext() {
  const record = { filled: [], texts: [] };
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, strokeRect() {},
    fillRect(x, y, w, h) { record.filled.push({ x, y, w, h, fill: ctx.fillStyle }); },
    fillText(text, x, y) { record.texts.push({ text, x, y }); },
    createLinearGradient() { return { addColorStop() {} }; },
  };
  return { ctx, record };
}

test('the entry names the page and its cells in the color the figure draws them', () => {
  assert.deepEqual(ENTRY, { label: 'Highlighted: Germ cells (1,234 cells)', color: HIGHLIGHT_CSS });
  // One color for the screen, the raster, the vector rings and the legend.
  assert.equal(HIGHLIGHT_CSS, `rgb(${HIGHLIGHT_COLOR.map(channel => Math.round(channel * 255)).join(', ')})`);
  assert.equal(highlightLegendEntry({ pageName: '  ', cellCount: 1 }).label, 'Highlighted (1 cell)');
  assert.equal(highlightLegendEntry({ pageName: 'Page 1', cellCount: 0 }), null);
});

test('every kind of legend lists the highlight in one more row, the same in PNG and SVG', () => {
  for (const [kind, model] of [['category', categoryLegend()], ['continuous', colorBar()], ['highlight alone', null]]) {
    for (const placement of ['beside', 'below']) {
      const options = { model, fieldKey: model === null ? null : 'cluster', fontPx: 14, measureText: estimateTextWidth, placement, extentPx: 400 };
      const plan = planLegend({ ...options, highlight: ENTRY });
      const label = `${kind}, ${placement}`;
      assert.ok(plan.highlight !== null, `${label}: planned`);
      if (model !== null) {
        const bare = planLegend(options);
        assert.ok(plan.height > bare.height, `${label}: the box holds the row`);
        assert.ok(plan.highlight.top >= bare.height - 8, `${label}: under everything else`);
      }
      assert.ok(plan.width >= 16 + 10 + 6 + estimateTextWidth(ENTRY.label, 14), `${label}: as wide as the entry`);
      const legendRect = { x: 40.5, y: 20, width: plan.width, height: plan.height };
      const { svg } = renderSvgLegend({ legendRect, legendPlan: plan, model });
      const written = svgEntries(svg).find(entry => entry.label === ENTRY.label);
      assert.ok(written, `${label}: the SVG writes it`);
      assert.equal(written.fill, HIGHLIGHT_CSS);
      assert.ok(written.y + 10 <= legendRect.y + legendRect.height && written.textY <= legendRect.y + legendRect.height, `${label}: inside the box`);
      const { ctx, record } = recordingContext();
      drawCanvasLegend({ ctx, legendRect, legendPlan: plan, model });
      const swatch = record.filled.find(rect => rect.fill === HIGHLIGHT_CSS);
      const text = record.texts.find(each => each.text === ENTRY.label);
      assert.deepEqual([swatch.x, swatch.y], [written.x, written.y], `${label}: the PNG's swatch where the SVG's is`);
      assert.deepEqual([text.x, text.y], [written.textX, written.textY], `${label}: the PNG's label where the SVG's is`);
    }
  }
  // Beside a plot, the entries leave the highlight's row free.
  const many = { ...categoryLegend(), categories: Array.from({ length: 40 }, (_, i) => `Type ${i}`), colors: new Uint8Array(120), visible: null };
  const plan = planLegend({ model: many, fieldKey: 'cluster', fontPx: 12, measureText: estimateTextWidth, placement: 'beside', extentPx: 300, highlight: ENTRY });
  assert.ok(plan.height <= 300, `${plan.height} px beside a 300 px plot`);
});

/** One panel of an export payload: a flat 2-D view seen planar, or a 3-D one. */
function makeView({ id, legendModel = null, transparency = [1, 1], dimension = 2 }) {
  return {
    cameraState: {
      navigationMode: dimension === 3 ? 'orbit' : 'planar',
      orbit: { radius: 3, targetRadius: 3, theta: 0, phi: Math.PI / 2, target: [0, 0, 0] },
      freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 },
    },
    data: {
      centroidColors: null,
      centroidFlags: { labels: false, points: false },
      vectorField: null,
      centroidLabelTexts: [],
      centroidPositions: null,
      colors: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]),
      pointCount: 2,
      positions: new Float32Array(2 * dimension),
      transparency: Uint8Array.from(transparency),
    },
    id,
    label: id,
    name: null,
    renderState: {
      antialias: true,
      backdrop: { centerY: 0, extentX: 1, extentY: 1, extentZ: 1, flat: false, floorY: -1.12, glowCenterX: 0, look: null, pixelRatio: 1, planarity: 0, stageX: 0, stageZ: 0 },
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
      sizeAttenuation: 1,
      viewMatrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1]),
      viewportHeight: 240,
      viewportWidth: 320,
    },
    scientificState: {
      datasetGeneration: 7,
      dimensionLevel: dimension,
      fieldKey: legendModel === null ? null : 'cluster',
      fieldKind: legendModel === null ? null : 'category',
      filters: [],
      geometryGeneration: 11,
      legendModel,
      lodMembership: null,
      drawOrder: null,
      lodSizeMultiplier: 1,
      pointLayers: { readScale: 1, readEveryLevel: true },
      normTransform: { center: [0, 0, 0], scale: 1 },
    },
  };
}

function payload(views, { highlighted = true, includeLegend = true, legendPosition = 'right' } = {}) {
  return {
    dpi: null,
    format: 'svg',
    height: 300,
    gridColumns: views.length,
    meta: {
      views: views.map(view => ({
        fieldKey: view.scientificState.fieldKey, fieldKind: view.scientificState.fieldKind,
        filters: [], id: view.id, label: view.label, name: view.name, vectorField: null,
      })),
    },
    options: {
      axisLabelFontSizePx: 12,
      background: 'viewer',
      backgroundColor: '#ffffff',
      centroidLabelFontSizePx: 12,
      crop: null,
      depthSort3d: false,
      emphasizeSelection: false,
      fontFamily: 'Arial, sans-serif',
      fontSizePx: 12,
      height: 300,
      includeAxes: true,
      includeLegend,
      legendFontSizePx: 12,
      legendPosition,
      optimizedTargetCount: null,
      referenceGrid: null,
      selectionMutedOpacity: 0.15,
      showOrientation: false,
      strategy: 'full-vector',
      tickFontSizePx: 12,
      title: '',
      titleFontSizePx: 15,
      width: 400,
      xLabel: 'UMAP 1',
      yLabel: 'UMAP 2',
    },
    // The second cell is on the page "Germ cells".
    selection: highlighted
      ? { highlightArray: Uint8Array.from([0, 255]), pageName: 'Germ cells', totalCount: 1, visibleCount: 1 }
      : { highlightArray: null, pageName: null, totalCount: 0, visibleCount: 0 },
    title: '',
    views,
    width: 400,
  };
}

const GERM = 'Highlighted: Germ cells (1 cell)';

test('a single-view figure with highlighted cells lists them in its legend, PNG and SVG alike', async () => {
  for (const legendModel of [categoryLegend(), null]) {
    const exact = payload([makeView({ id: 'live', legendModel })]);
    assertFigureExportPayload(exact);
    const { single } = computeFigureLayout(exact);
    assert.equal(single.legendPlan.highlight.label, GERM);
    if (legendModel === null) assert.equal(single.legendPlan.kind, 'other', 'a view colored by no field: a legend of the highlight alone');
    // The legend's room is part of the figure, clear of the plot and its axes.
    assert.ok(single.legendRect.x >= single.plotRect.x + single.plotRect.width + single.axes.margins.right);
    assert.ok(single.legendRect.x + single.legendRect.width <= single.totalWidth);
    const svg = await (await renderFigureToSvgBlob({ payload: exact })).text();
    const entry = svgEntries(svg).find(each => each.label === GERM);
    assert.ok(entry, 'the SVG legend lists the highlighted cells');
    assert.equal(entry.fill, HIGHLIGHT_CSS);
  }

  // No highlighted cell, no entry; Legend off, none either.
  const none = await (await renderFigureToSvgBlob({ payload: payload([makeView({ id: 'live', legendModel: categoryLegend() })], { highlighted: false }) })).text();
  assert.doesNotMatch(none, /Highlighted/);
  const off = payload([makeView({ id: 'live', legendModel: categoryLegend() })], { includeLegend: false });
  assert.equal(computeFigureLayout(off).single.legendRect, null);
  assert.doesNotMatch(await (await renderFigureToSvgBlob({ payload: off })).text(), /Highlighted/);
  // A highlighted cell the view does not draw (filtered out) draws nothing to explain.
  const hidden = payload([makeView({ id: 'live', legendModel: categoryLegend(), transparency: [1, 0] })]);
  assert.equal(figureHighlightLegend(hidden), null);
  assert.equal(computeFigureLayout(hidden).single.legendPlan.highlight, null);
});

test('a grid lists the highlight in the legend of each panel that draws it, and its layout holds it', async () => {
  // Panels that disagree: their own legends, the entry where the panel draws highlighted cells.
  const own = payload([
    makeView({ id: 'a', legendModel: categoryLegend() }),
    makeView({ id: 'b', legendModel: colorBar(), transparency: [1, 0] }),
  ]);
  assert.deepEqual(figureHighlightLegend(own).panels, [true, false]);
  for (const legendPosition of ['right', 'bottom']) {
    own.options.legendPosition = legendPosition;
    const { grid } = computeFigureLayout(own);
    assert.equal(grid.sharedLegend, null);
    assert.equal(grid.panes[0].legendPlan.highlight.label, GERM);
    assert.equal(grid.panes[1].legendPlan.highlight, null);
    for (const pane of grid.panes) {
      const legend = pane.legendRect;
      const plot = pane.plotRect;
      const clear = legend.x >= plot.x + plot.width + (pane.axes?.margins.right ?? 0)
        || legend.y >= plot.y + plot.height + (pane.axes?.margins.bottom ?? 0);
      assert.ok(clear, `${legendPosition}: the legend clear of its plot and axes`);
      assert.equal(legend.height, pane.legendPlan.height);
    }
  }
  const svg = await (await renderFigureToSvgBlob({ payload: own })).text();
  assert.equal(svgEntries(svg).filter(entry => entry.label === GERM).length, 1);

  // Panels that agree: one shared legend carries the entry once.
  const agreed = payload([makeView({ id: 'a', legendModel: categoryLegend() }), makeView({ id: 'b', legendModel: categoryLegend() })]);
  const shared = computeFigureLayout(agreed).grid;
  assert.equal(shared.sharedLegendPlan.highlight.label, GERM);
  assert.equal(svgEntries(await (await renderFigureToSvgBlob({ payload: agreed })).text()).filter(entry => entry.label === GERM).length, 1);

  // Panels colored by no field: one shared legend of the highlight alone.
  const uncolored = payload([makeView({ id: 'a' }), makeView({ id: 'b', dimension: 3 })]);
  const bare = computeFigureLayout(uncolored).grid;
  assert.ok(bare.sharedLegendRect !== null);
  assert.equal(bare.sharedLegendPlan.kind, 'other');
  assert.equal(bare.sharedLegendPlan.highlight.label, GERM);
  assert.ok(bare.panes.every(pane => pane.legendRect === null));
  assert.equal(svgEntries(await (await renderFigureToSvgBlob({ payload: uncolored })).text()).filter(entry => entry.label === GERM).length, 1);

  // The composed grid accounts for the entry: the legends grow, nothing overlaps.
  const views = [0, 1].map(() => ({ scientificState: { fieldKey: 'cluster', legendModel: categoryLegend() } }));
  const without = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)),  width: 900, height: 500, views, plotAspects: [1.6, 1.6], panelAxes: [null, null], fontSize: 12, measureText: estimateTextWidth });
  const withEntry = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
    width: 900, height: 500, views, plotAspects: [1.6, 1.6], panelAxes: [null, null], fontSize: 12, measureText: estimateTextWidth,
    legendHighlight: { entry: ENTRY, panels: [true, true] },
  });
  assert.ok(withEntry.sharedLegendPlan.height > without.sharedLegendPlan.height);
  assert.ok(withEntry.sharedLegendRect.width >= 16 + 16 + estimateTextWidth(ENTRY.label, 12));
  assert.throws(
    () => computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)),  width: 900, height: 500, views, plotAspects: [1.6, 1.6], panelAxes: [null, null], fontSize: 12, legendHighlight: { entry: ENTRY, panels: [true] } }),
    /whether each panel draws highlighted cells/
  );
});

test('the payload names the highlight page whose cells it draws', () => {
  const view = makeView({ id: 'live' });
  const exact = payload([view]);
  assertFigureExportPayload(exact);
  assert.throws(() => assertFigureExportPayload({ ...exact, selection: { ...exact.selection, pageName: null } }), /pageName/);
  const none = payload([view], { highlighted: false });
  assertFigureExportPayload(none);
  assert.throws(() => assertFigureExportPayload({ ...none, selection: { ...none.selection, pageName: 'Page 1' } }), /pageName/);
  // The single-view layout of the preview takes the same entry.
  const layout = computeSingleViewLayout({ width: 400, height: 300, plotAspect: 4 / 3, legendHighlight: ENTRY, measureText: estimateTextWidth });
  assert.equal(layout.legendPlan.highlight.label, ENTRY.label);
});
