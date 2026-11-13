/**
 * Regression coverage for the ways a figure export could publish a claim the
 * viewer never made:
 *
 * 1. Exporting while the viewer draws volumetric smoke, producing a point
 *    cloud stamped with metadata that says it is the active view.
 * 2. Exporting a legend that describes categories the figure does not draw, or
 *    a logarithmic colorbar labeled only with its endpoints.
 * 3. Exporting a multi-panel grid with no legend at all, and stamping the
 *    whole file with the active panel's field and filters.
 *
 * These are covered here and nowhere else: `legend-builder.js`,
 * `utils/layout.js`, `utils/render-mode.js`, `utils/figure-provenance.js` and
 * `fidelity-warning-dialog.js`.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HIDDEN_LEGEND_ENTRY_SUFFIX,
  buildColorScaleNote,
  drawCanvasLegend,
  legendEntries,
  planLegend,
  renderSvgLegend,
  resolveSharedGridLegend,
} from '../assets/js/app/ui/modules/figure-export/components/legend-builder.js';
import {
  buildRenderModeFidelityWarnings,
  readActiveRenderMode,
} from '../assets/js/app/ui/modules/figure-export/utils/render-mode.js';
import {
  confirmExportFidelityWarnings,
} from '../assets/js/app/ui/modules/figure-export/components/fidelity-warning-dialog.js';
import {
  computeFigureLayout,
  computeGridFigureLayout,
  computeSingleViewLayout,
} from '../assets/js/app/ui/modules/figure-export/utils/layout.js';

/** What a flat 2-D plot's axes show (`AxesSpec`). */
const AXES = { bounds: { minX: -8, maxX: 12, minY: -6, maxY: 9 }, xLabel: 'UMAP 1', yLabel: 'UMAP 2', tickFontPx: 12, labelFontPx: 12 };
import {
  renderFigureToSvgBlob,
} from '../assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js';
import {
  buildPngTextMetadata,
  renderFigureToPngBlob,
} from '../assets/js/app/ui/modules/figure-export/renderers/png-renderer.js';
import {
  estimateTextWidth,
} from '../assets/js/app/ui/modules/figure-export/utils/text-measure.js';
import {
  buildProvenanceDescription,
} from '../assets/js/app/ui/modules/figure-export/utils/figure-provenance.js';
import {
  panelLetter,
} from '../assets/js/app/ui/modules/figure-export/utils/panel-label.js';
import {
  buildSelectionBadge,
  countHighlightedVisiblePoints,
} from '../assets/js/app/ui/modules/figure-export/utils/selection-badge.js';
import './helpers/figure-export-worker-in-process.mjs';
import { colorsOf, visibleOf } from './helpers/category-state.mjs';

const figureExportRoot = new URL(
  '../assets/js/app/ui/modules/figure-export/',
  import.meta.url
);

function source(relativePath) {
  return readFile(new URL(relativePath, figureExportRoot), 'utf8');
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

function documentWithRenderMode(value) {
  return {
    getElementById(id) {
      if (id !== 'render-mode') return null;
      return value === null ? null : { value };
    },
  };
}

/** Canvas2D recorder: keeps every filled rect, stroked rect and drawn string. */
function recordingContext() {
  const record = {
    filledRects: [],
    strokedRects: [],
    texts: [],
  };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    fillRect(x, y, w, h) {
      record.filledRects.push({ x, y, w, h, style: ctx.fillStyle });
    },
    strokeRect(x, y, w, h) {
      record.strokedRects.push({ x, y, w, h, style: ctx.strokeStyle });
    },
    fillText(text, x, y) {
      record.texts.push({ text, x, y, style: ctx.fillStyle });
    },
    // Deterministic stand-in for real font metrics.
    measureText(text) {
      return { width: String(text).length * 7 };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };
  return { ctx, record };
}

function svgTexts(svg) {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(
    (match) => match[1]
  );
}

function categoryModel(overrides = {}) {
  return {
    kind: 'category',
    categories: ['B cell', 'T cell', 'Macrophage'],
    colors: colorsOf([[1, 0, 0], [0, 1, 0], [0, 0, 1]]),
    // `_categoryVisible` is a plain index->boolean map, not an array.
    visible: visibleOf({ 0: true, 1: false, 2: true }),
    picker: [],
    counts: null,
    ...overrides,
  };
}

function continuousModel(overrides = {}) {
  return {
    kind: 'continuous',
    stats: { min: 0.5, max: 2000 },
    filter: null,
    scale: 'linear',
    logEnabled: false,
    colorStops: ['rgb(68,1,84) 0%', 'rgb(253,231,37) 100%'],
    colormap: { id: 'viridis', label: 'Viridis' },
    colorbar: { min: 1, max: 1000, usingFilter: false, scale: 'linear' },
    ...overrides,
  };
}

const WIDE_RECT = { x: 0, y: 0, width: 420, height: 300 };

/** Deterministic stand-in for font metrics, as `recordingContext` measures. */
const measure7 = (text) => String(text).length * 7;

/** The plan a layout makes for a legend standing in `legendRect`. */
function planIn(legendRect, fieldKey, model) {
  return planLegend({
    model,
    fieldKey,
    fontPx: 12,
    measureText: measure7,
    placement: 'beside',
    extentPx: legendRect.height,
    minWidth: legendRect.width,
  });
}

function svgLegend({ legendRect, fieldKey, model }) {
  return renderSvgLegend({ legendRect, legendPlan: planIn(legendRect, fieldKey, model), model });
}

function canvasLegend({ ctx, legendRect, fieldKey, model }) {
  drawCanvasLegend({ ctx, legendRect, legendPlan: planIn(legendRect, fieldKey, model), model });
}

// ---------------------------------------------------------------------------
// Volumetric render mode must block the export
// ---------------------------------------------------------------------------

test('the active render mode is read from the control that owns it', () => {
  assert.equal(readActiveRenderMode(documentWithRenderMode('points')), 'points');
  assert.equal(readActiveRenderMode(documentWithRenderMode('smoke')), 'smoke');
  assert.equal(readActiveRenderMode(documentWithRenderMode(null)), null);
  assert.equal(readActiveRenderMode(documentWithRenderMode('raster')), null);
  assert.equal(readActiveRenderMode(null), null);
});

test('smoke render mode raises one fidelity blocker naming the mode', () => {
  const warnings = buildRenderModeFidelityWarnings(
    documentWithRenderMode('smoke')
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].title, /Volumetric smoke cloud/);
  assert.match(warnings[0].detail, /point layer only/i);
  assert.match(warnings[0].detail, /Set "Render mode" to Points/);
});

test('an unreadable render mode blocks instead of assuming points', () => {
  for (const documentRef of [
    documentWithRenderMode(null),
    documentWithRenderMode('raster'),
    null,
  ]) {
    const warnings = buildRenderModeFidelityWarnings(documentRef);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].title, /Active render mode unavailable/);
  }
});

test('points render mode is the only mode that clears the fidelity gate', async () => {
  const cleared = buildRenderModeFidelityWarnings(
    documentWithRenderMode('points')
  );
  assert.deepEqual(cleared, []);
  // An empty warning list is the sole path through which the gate resolves
  // true, so it is the sole path to an export.
  assert.equal(
    await confirmExportFidelityWarnings({
      warnings: cleared,
      signal: new AbortController().signal,
    }),
    true
  );

  // The smoke blockers satisfy the gate's exact warning contract (it throws on
  // any other shape) and, being non-empty, can never resolve true.
  const blockers = buildRenderModeFidelityWarnings(
    documentWithRenderMode('smoke')
  );
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    await confirmExportFidelityWarnings({
      warnings: blockers,
      signal: aborted.signal,
    }),
    false
  );
});

test('the export path feeds the render mode into the fidelity gate', async () => {
  const uiSource = await source('figure-export-ui.js');

  assert.match(
    uiSource,
    /import \{ buildRenderModeFidelityWarnings \} from '\.\/utils\/render-mode\.js';/
  );
  assert.match(
    uiSource,
    /warnings\.push\(\s*\.\.\.buildRenderModeFidelityWarnings\(/
  );

  const pushIndex = uiSource.indexOf('warnings.push(');
  const gateIndex = uiSource.indexOf('await confirmExportFidelityWarnings({');
  assert.ok(pushIndex > 0, 'render-mode warnings must be collected');
  assert.ok(gateIndex > 0, 'the fidelity gate must still run');
  assert.ok(
    pushIndex < gateIndex,
    'the render mode must be checked before the gate decides'
  );
});

// ---------------------------------------------------------------------------
// The exported legend must describe the exported figure
// ---------------------------------------------------------------------------

test('SVG legend never gives a hidden category a colored swatch', () => {
  const { svg } = svgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'cell_type',
    model: categoryModel(),
  });

  // The hidden category keeps its entry, marked, so a filtered view cannot be
  // mistaken for a complete one.
  assert.match(svg, /T cell \(hidden\)/);
  // ...but its color is gone from the legend entirely: nothing invites the
  // reader to hunt the plot for green points that were never drawn.
  assert.doesNotMatch(svg, /rgb\(0,255,0\)/);
  assert.match(svg, /fill="none" stroke="#6b7280"/);

  // Drawn categories are untouched.
  assert.match(svg, /fill="rgb\(255,0,0\)"/);
  assert.match(svg, /fill="rgb\(0,0,255\)"/);
  assert.ok(svgTexts(svg).includes('B cell'));
  assert.ok(svgTexts(svg).includes('Macrophage'));
});

test('Canvas legend never gives a hidden category a colored swatch', () => {
  const { ctx, record } = recordingContext();
  canvasLegend({
    ctx,
    legendRect: WIDE_RECT,
    fieldKey: 'cell_type',
    model: categoryModel(),
  });

  const swatchFills = record.filledRects
    .filter((entry) => entry.w === 10 && entry.h === 10)
    .map((entry) => entry.style);
  assert.deepEqual(swatchFills, ['rgb(255,0,0)', 'rgb(0,0,255)']);

  const drawn = record.texts.map((entry) => entry.text);
  assert.ok(drawn.includes('T cell (hidden)'));
  assert.ok(drawn.includes('B cell'));
  assert.ok(drawn.includes('Macrophage'));

  // The hidden entry keeps a hollow placeholder at the swatch position.
  assert.ok(
    record.strokedRects.some(
      (entry) => entry.w === 10 && entry.h === 10 && entry.style === '#6b7280'
    )
  );
});

test('a category other filters leave without cells is not listed; one the person hid is marked', () => {
  // On screen a category emptied by a filter on another field is a disabled
  // row ("No cells available in this category after other filters"); the
  // figure has none of its cells to hide, so it lists only what it draws and
  // what the person hid. It never says "(hidden)" of the types a filter on
  // another field emptied (30 of He's 41 LVL2 types after a filter kept the epithelial cells).
  const model = categoryModel({
    categories: ['B cell', 'T cell', 'Macrophage', 'NK cell'],
    colors: colorsOf([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]]),
    // T cell ticked but emptied; NK cell hidden and emptied; Macrophage hidden with cells.
    visible: visibleOf({ 0: true, 1: true, 2: false, 3: false }),
    counts: {
      available: [4, 0, 2, 0],
      availableTotal: 6,
      total: [5, 3, 2, 1],
      visible: [4, 0, 0, 0],
      visibleTotal: 4,
    },
  });
  assert.deepEqual(legendEntries(model), [{ category: 0, hidden: false }, { category: 2, hidden: true }]);
  const { svg } = svgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'cell_type',
    model,
  });
  assert.deepEqual(svgTexts(svg), [
    'cell_type',
    'B cell',
    'Macrophage (hidden)',
  ]);
  assert.doesNotMatch(svg, /rgb\(0,255,0\)|rgb\(255,255,0\)/);

  const { ctx, record } = recordingContext();
  canvasLegend({
    ctx,
    legendRect: WIDE_RECT,
    fieldKey: 'cell_type',
    model,
  });
  // Each entry keeps its category's color: B cell red; Macrophage hollow.
  assert.deepEqual(
    record.filledRects
      .filter((entry) => entry.w === 10 && entry.h === 10)
      .map((entry) => entry.style),
    ['rgb(255,0,0)']
  );
  assert.deepEqual(record.texts.map((entry) => entry.text), ['cell_type', 'B cell', 'Macrophage (hidden)']);

  // Without counts (nothing says which have cells), every category is listed.
  assert.deepEqual(legendEntries(categoryModel()).map(entry => entry.category), [0, 1, 2]);
});

test('SVG and Canvas legends publish identical category text', () => {
  const model = categoryModel();
  const { svg } = svgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'cell_type',
    model,
  });
  const { ctx, record } = recordingContext();
  canvasLegend({
    ctx,
    legendRect: WIDE_RECT,
    fieldKey: 'cell_type',
    model,
  });

  assert.deepEqual(
    svgTexts(svg),
    record.texts.map((entry) => entry.text)
  );
  assert.deepEqual(svgTexts(svg), [
    'cell_type',
    'B cell',
    'T cell (hidden)',
    'Macrophage',
  ]);
});

test('a legend never shortens a name: its column is as wide as its longest entry, marker included', () => {
  const model = categoryModel({
    categories: ['Plasmacytoid dendritic cell', 'Erythroid progenitor'],
    colors: colorsOf([[1, 0, 0], [0, 1, 0]]),
    visible: visibleOf({ 0: true, 1: false }),
  });
  // Planned beside a short plot: one row per column, so each entry decides
  // its own column's width.
  const plan = planLegend({
    model,
    fieldKey: 'cell_type',
    fontPx: 12,
    measureText: measure7,
    placement: 'beside',
    extentPx: 40,
  });
  assert.deepEqual(plan.entries.map(entry => entry.label), ['Plasmacytoid dendritic cell', 'Erythroid progenitor (hidden)']);
  assert.equal(plan.rowsPerColumn, 1);
  assert.equal(plan.columns, 2);
  const longest = Math.max(...plan.entries.map(entry => measure7(entry.label)));
  assert.ok(plan.columnWidth >= 10 + 6 + longest, `column ${plan.columnWidth} px for a ${longest} px label`);
  assert.ok(plan.width >= 2 * 8 + plan.columns * plan.columnWidth);

  const legendRect = { x: 0, y: 0, width: plan.width, height: plan.height };
  const { svg } = renderSvgLegend({ legendRect, legendPlan: plan, model });
  const { ctx, record } = recordingContext();
  let measured = 0;
  ctx.measureText = (text) => {
    measured += 1;
    return { width: measure7(text) };
  };
  drawCanvasLegend({ ctx, legendRect, legendPlan: plan, model });
  // Nothing is measured inside the builders: they draw the plan.
  assert.equal(measured, 0);
  for (const drawn of [svgTexts(svg), record.texts.map(entry => entry.text)]) {
    assert.deepEqual(drawn, ['cell_type', 'Plasmacytoid dendritic cell', 'Erythroid progenitor (hidden)']);
  }
  // The builders draw the plan's columns: the second entry starts one column
  // width to the right of the first.
  const xs = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" fill=/g)].map(match => Number(match[1]));
  assert.deepEqual(xs, [8 + 10 + 6, 8 + plan.columnWidth + 10 + 6]);
  assert.doesNotMatch(svg, /…/);
});

test('a legend cannot be drawn from another model\'s plan', () => {
  const model = categoryModel();
  const plan = planIn(WIDE_RECT, 'cell_type', categoryModel({ categories: ['only one'] }));
  assert.throws(() => renderSvgLegend({ legendRect: WIDE_RECT, legendPlan: plan, model }), /must list the entries of its model/);
  assert.throws(() => renderSvgLegend({ legendRect: WIDE_RECT, legendPlan: null, model }), /planLegend/);
});

test('a logarithmic colorbar says so and names its true midpoint', () => {
  const model = continuousModel({
    scale: 'log',
    logEnabled: true,
    colorbar: { min: 1, max: 1000, usingFilter: false, scale: 'log' },
  });

  // Color position tracks log10(value), so the mid-bar value is the geometric
  // mean (31.6), not the arithmetic one (500.5) a linear read-off produces.
  assert.equal(
    buildColorScaleNote(model, 1, 1000),
    'Log10 color scale (midpoint 31.6)'
  );

  const { svg } = svgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'CD19',
    model,
  });
  assert.ok(svgTexts(svg).includes('Log10 color scale (midpoint 31.6)'));

  const { ctx, record } = recordingContext();
  canvasLegend({ ctx, legendRect: WIDE_RECT, fieldKey: 'CD19', model });
  assert.deepEqual(
    svgTexts(svg),
    record.texts.map((entry) => entry.text)
  );
});

test('a linear colorbar carries no logarithmic claim', () => {
  const model = continuousModel();
  assert.equal(buildColorScaleNote(model, 1, 1000), null);

  const { svg } = svgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'CD19',
    model,
  });
  assert.doesNotMatch(svg, /Log10/);

  const { ctx, record } = recordingContext();
  canvasLegend({ ctx, legendRect: WIDE_RECT, fieldKey: 'CD19', model });
  assert.ok(!record.texts.some((entry) => /Log10/.test(entry.text)));
});

test('a log colorbar whose domain is unusable still declares the scale', () => {
  const model = continuousModel({ scale: 'log', logEnabled: true });
  assert.equal(buildColorScaleNote(model, 0, 1000), 'Log10 color scale');
  assert.equal(buildColorScaleNote(model, Number.NaN, 10), 'Log10 color scale');
});

test('legend sizing reserves room for the hidden marker', () => {
  const categories = ['Erythroid progenitor', 'B cell'];
  const colors = colorsOf([[1, 0, 0], [0, 1, 0]]);
  const dimensions = (visible) => computeSingleViewLayout({
    width: 800,
    height: 600,
    plotAspect: 800 / 600,
    title: '',
    axes: null,
    includeLegend: true,
    legendPosition: 'right',
    legendModel: { kind: 'category', categories, colors, visible },
    legendFontSizePx: 12,
  }).legendRect.width;

  assert.ok(
    dimensions(visibleOf([false, true])) > dimensions(visibleOf([true, true])),
    'a marked entry needs more width than the bare name'
  );
});

/** 69 long cell-type names, as Suo's `cell_type`, which a legend must not cut with "…". */
function longCellTypeModel(count = 69) {
  const categories = Array.from({ length: count }, (_, index) =>
    `Proliferating double-negative thymocyte ${String.fromCharCode(65 + (index % 26))}${index}`);
  const visible = new Uint8Array(count).fill(1);
  visible[3] = 0;
  return {
    kind: 'category',
    categories,
    colors: new Uint8Array(count * 3).fill(128),
    visible,
    picker: [],
    counts: null,
  };
}

/** Every entry an SVG legend wrote, as text. */
/** A legend's entry labels: the text written right after each swatch. */
function svgEntryTexts(svg) {
  return [...svg.matchAll(/<rect [^>]*width="10" height="10"[^>]*\/><text [^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
}

test('a single-view legend of 69 long names grows the figure and cuts none of them', () => {
  const model = longCellTypeModel();
  const expected = model.categories.map((name, index) => (index === 3 ? `${name}${HIDDEN_LEGEND_ENTRY_SUFFIX}` : name));
  for (const legendPosition of ['right', 'bottom']) {
    const layout = computeSingleViewLayout({
      width: 720,
      height: 500,
      plotAspect: 720 / 500,
      title: '',
      axes: AXES,
      includeLegend: true,
      legendPosition,
      legendModel: model,
      legendFieldKey: 'cell_type',
      legendFontSizePx: 12,
      fontFamily: 'Arial, sans-serif',
      measureText: estimateTextWidth,
    });
    const { legendRect, legendPlan: plan, plotRect } = layout;
    assert.deepEqual(plan.entries.map(entry => entry.label), expected, `${legendPosition}: every label whole`);
    const longest = Math.max(...plan.entries.map(entry => estimateTextWidth(entry.label, 12)));
    assert.ok(plan.columnWidth >= 10 + 6 + longest, `${legendPosition}: column ${plan.columnWidth} px < ${longest} px label`);
    assert.ok(legendRect.width >= 16 + plan.columns * plan.columnWidth, `${legendPosition}: box narrower than its columns`);
    assert.ok(legendRect.height >= plan.height);
    assert.equal(plan.columns * plan.rowsPerColumn >= model.categories.length, true);
    // The plot keeps its size; the figure grows around the legend.
    assert.equal(plotRect.width, 720);
    assert.equal(plotRect.height, 500);
    assert.ok(legendRect.x + legendRect.width <= layout.totalWidth);
    assert.ok(legendRect.y + legendRect.height <= layout.totalHeight);
    if (legendPosition === 'right') {
      assert.ok(legendRect.width > plotRect.width, 'the legend is wider than the plot, and that is allowed');
      assert.ok(legendRect.x >= plotRect.x + plotRect.width);
    } else {
      // Below the x axis and its label, not on top of them.
      assert.ok(legendRect.y >= plotRect.y + plotRect.height + layout.axes.margins.bottom);
    }

    const { svg } = renderSvgLegend({ legendRect, legendPlan: plan, model });
    assert.deepEqual(svgEntryTexts(svg), expected);
    assert.doesNotMatch(svg, /…/);
    const { ctx, record } = recordingContext();
    drawCanvasLegend({ ctx, legendRect, legendPlan: plan, model });
    assert.deepEqual(record.texts.slice(1).map(entry => entry.text), expected);
  }
});

test('the layout reserves what the builders draw, measured by one source', () => {
  // Capitals are wider than the old 0.62 em average: a width estimated from
  // the character count reserved less than the canvas then drew.
  const model = categoryModel({
    categories: ['MMMMMMMMMMMMMMMMMMMM', 'WWWWWWWWWWWWWWWWWWWW'],
    colors: colorsOf([[1, 0, 0], [0, 1, 0]]),
    visible: visibleOf({ 0: true, 1: true }),
  });
  const wide = (text, fontPx, weight = 400) => String(text).length * fontPx * (weight >= 600 ? 1.1 : 0.95);
  const layout = computeSingleViewLayout({
    width: 400,
    height: 300,
    plotAspect: 400 / 300,
    axes: null,
    legendModel: model,
    legendFieldKey: 'f',
    measureText: wide,
  });
  assert.ok(layout.legendPlan.columnWidth >= 10 + 6 + 20 * 12 * 0.95);
  assert.ok(layout.legendRect.width >= 16 + layout.legendPlan.columnWidth);
});

test('a legend of a million categories is laid out whole: nothing caps it at the plot', () => {
  const count = 1_000_000;
  const categories = Array.from({ length: count }, (_, i) => `bg ${i}`);
  const layout = computeSingleViewLayout({
    width: 800,
    height: 600,
    plotAspect: 800 / 600,
    axes: null,
    legendModel: { kind: 'category', categories, colors: new Uint8Array(count * 3) },
    legendFieldKey: 'barcode',
    measureText: measure7,
  });
  assert.equal(layout.legendPlan.entries.length, count);
  assert.ok(layout.legendPlan.columns * layout.legendPlan.rowsPerColumn >= count);
  // Far larger than any browser canvas: the PNG export refuses it (below).
  assert.ok(layout.totalWidth > 1_000_000, `figure ${layout.totalWidth} px wide`);
});

/**
 * A document whose canvases draw only up to `maxSide` device pixels a side,
 * as a browser past its canvas limit does: the context is handed out, and
 * drawing past the limit silently leaves nothing.
 */
function limitedCanvasDocument(maxSide, allocations) {
  return {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 300,
        height: 150,
        getContext() {
          const fits = () => canvas.width <= maxSide && canvas.height <= maxSide;
          let lastFill = false;
          return {
            fillStyle: '#000',
            fillRect() { lastFill = fits(); },
            clearRect() {},
            getImageData() { return { data: Uint8ClampedArray.from([0, 0, 0, lastFill ? 255 : 0]) }; },
          };
        },
      };
      allocations.push(canvas);
      return canvas;
    },
  };
}

test('a PNG whose legend is larger than the browser can draw is refused with one sentence, never cut', async () => {
  const view = gridView({
    id: 'live',
    label: 'Live',
    fieldKey: 'cell_type',
    fieldKind: 'category',
    legendModel: longCellTypeModel(4000),
  });
  const payload = gridPayload([view], { format: 'png' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const allocations = [];
  // The 1200 × 900 plot at 300 DPI without its legend is 4,100 × 3,163 px:
  // within this browser's 6,000 px; with 4,000 categories beside it, far past it.
  globalThis.document = limitedCanvasDocument(6000, allocations);
  try {
    await assert.rejects(
      renderFigureToPngBlob({ payload }),
      (error) => {
        assert.match(
          error.message,
          /^The legend of 4,000 categories needs a [\d,]+×[\d,]+ px figure, more than this browser can draw; turn the legend off or show fewer categories\.$/
        );
        return true;
      }
    );
    // The canvases it tried were released, and no worker work began.
    assert.ok(allocations.length >= 2);
    for (const canvas of allocations) assert.equal(canvas.width * canvas.height, 0);

    // Too large without any legend: the remedy is the size or the DPI.
    globalThis.document = limitedCanvasDocument(2000, []);
    await assert.rejects(
      renderFigureToPngBlob({ payload }),
      (error) => {
        assert.match(
          error.message,
          /^This figure is [\d,]+×[\d,]+ px, more than this browser can draw; choose a smaller size or a lower DPI\.$/
        );
        return true;
      }
    );
  } finally {
    if (previous === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', previous);
  }
});

// ---------------------------------------------------------------------------
// A multi-panel figure must carry a legend for every panel
// and provenance for every panel
// ---------------------------------------------------------------------------

const IDENTITY = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function gridCameraState() {
  return {
    navigationMode: 'orbit',
    orbit: {
      radius: 3,
      targetRadius: 3,
      theta: 0,
      phi: Math.PI / 2,
      target: [0, 0, 0],
    },
    freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 },
  };
}

function gridRenderState() {
  return {
    antialias: true,
    backdrop: {
      centerY: 0,
      extentX: 1,
      extentY: 1,
      extentZ: 1,
      flat: false,
      floorY: -1.12,
      glowCenterX: 0,
      look: null,
      pixelRatio: 1,
      planarity: 0,
      stageX: 0,
      stageZ: 0,
    },
    bgColor: Float32Array.from([1, 1, 1]),
    cameraDistance: 3,
    // The sprite cap (rendering/point-sprite.js).
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
    viewMatrix: new Float32Array(IDENTITY),
    viewportHeight: 240,
    viewportWidth: 320,
  };
}

/** One panel of a grid export, colored by its own field with its own filters. */
function gridView({ id, label, name = null, fieldKey, fieldKind, legendModel, filters = [] }) {
  return {
    cameraState: gridCameraState(),
    data: {
      centroidColors: null,
      centroidFlags: { labels: false, points: false },
      vectorField: null,
      centroidLabelTexts: [],
      centroidPositions: null,
      colors: Uint8Array.from([255, 0, 0, 255]),
      pointCount: 1,
      positions: Float32Array.from([0, 0, 0]),
      transparency: Uint8Array.from([1]),
    },
    id,
    label,
    name,
    renderState: gridRenderState(),
    scientificState: {
      datasetGeneration: 7,
      dimensionLevel: 3,
      fieldKey,
      fieldKind,
      filters,
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

function gridPayload(views, { format = 'svg', legendPosition = 'right' } = {}) {
  const width = 1200;
  const height = 900;
  return {
    dpi: format === 'png' ? 300 : null,
    format,
    height,
    gridColumns: views.length <= 3 ? views.length : Math.ceil(views.length / 2),
    meta: {
      datasetName: 'Suo',
      datasetId: 'suo-2022',
      datasetUserPath: '/data/suo',
      exportedAt: '2026-07-30T00:00:00.000Z',
      views: views.map((view) => ({
        fieldKey: view.scientificState.fieldKey,
        fieldKind: view.scientificState.fieldKind,
        filters: [...view.scientificState.filters],
        id: view.id,
        label: view.label,
        name: view.name,
        vectorField: null,
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
      height,
      includeAxes: true,
      includeLegend: true,
      legendFontSizePx: 12,
      legendPosition,
      optimizedTargetCount: null,
      referenceGrid: null,
      selectionMutedOpacity: 0.15,
      showOrientation: false,
      strategy: format === 'svg' ? 'full-vector' : null,
      tickFontSizePx: 12,
      title: '',
      titleFontSizePx: 15,
      width,
      xLabel: 'UMAP 1',
      yLabel: 'UMAP 2',
    },
    selection: { highlightArray: null, pageName: null, totalCount: 0, visibleCount: 0 },
    title: '',
    views,
    width,
  };
}

function clusterModel() {
  return {
    kind: 'category',
    categories: ['T cell', 'B cell'],
    colors: colorsOf([[1, 0, 0], [0, 0, 1]]),
    visible: visibleOf({ 0: true, 1: true }),
    picker: [],
    counts: null,
  };
}

function sampleModel() {
  return {
    kind: 'category',
    categories: ['Donor 1', 'Donor 2'],
    colors: colorsOf([[0, 1, 1], [1, 1, 0]]),
    visible: visibleOf({ 0: true, 1: true }),
    picker: [],
    counts: null,
  };
}

function geneModel(colorStops) {
  return {
    kind: 'continuous',
    stats: { min: 0, max: 5 },
    filter: null,
    scale: 'linear',
    logEnabled: false,
    colorStops,
    colormap: { id: 'viridis', label: 'Viridis' },
    colorbar: { min: 0, max: 5, usingFilter: false, scale: 'linear' },
  };
}

/** The four panels of the figure: leiden, CD3E, MS4A1, sample. */
function fourDisagreeingPanels() {
  return [
    gridView({
      id: 'live',
      label: 'Live',
      fieldKey: 'leiden',
      fieldKind: 'category',
      legendModel: clusterModel(),
      filters: ['cell_type: hiding B cell'],
    }),
    gridView({
      id: 'snapshot-cd3e',
      label: 'CD3E view',
      fieldKey: 'CD3E',
      fieldKind: 'continuous',
      legendModel: geneModel(['rgb(68,1,84) 0%', 'rgb(253,231,37) 100%']),
    }),
    gridView({
      id: 'snapshot-ms4a1',
      label: 'MS4A1 view',
      fieldKey: 'MS4A1',
      fieldKind: 'continuous',
      legendModel: geneModel(['rgb(0,0,4) 0%', 'rgb(252,253,191) 100%']),
      filters: ['No filters active'],
    }),
    gridView({
      id: 'snapshot-sample',
      label: 'Sample view',
      fieldKey: 'sample',
      fieldKind: 'category',
      legendModel: sampleModel(),
    }),
  ];
}

function legendTitles(svg) {
  return [...svg.matchAll(/font-weight="600">([^<]*)<\/text>/g)].map(
    (match) => match[1]
  );
}

function svgDescription(svg) {
  return svg.match(/<dc:description>([\s\S]*?)<\/dc:description>/)?.[1] ?? null;
}

function svgProvenanceJson(svg) {
  const raw = svg.match(/<cellucid:json>([\s\S]*?)<\/cellucid:json>/)?.[1];
  assert.ok(raw, 'the SVG must embed a JSON provenance blob');
  return JSON.parse(
    raw
      .replaceAll('&quot;', '"')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
  );
}

test('a grid whose panels disagree still explains every panel', async () => {
  const views = fourDisagreeingPanels();
  const svg = await (
    await renderFigureToSvgBlob({ payload: gridPayload(views) })
  ).text();

  // A grid with no legend whatsoever leaves four colored panels a reader
  // cannot decode at all.
  assert.deepEqual(legendTitles(svg), ['leiden', 'CD3E', 'MS4A1', 'sample']);

  // Each categorical panel shows its own categories, with its own colors.
  for (const entry of ['T cell', 'B cell', 'Donor 1', 'Donor 2']) {
    assert.equal(
      [...svg.matchAll(new RegExp(`>${entry}</text>`, 'g'))].length,
      1,
      `${entry} must appear in exactly one panel legend`
    );
  }
  assert.match(svg, /fill="rgb\(0,255,255\)"/);
  assert.match(svg, /fill="rgb\(255,255,0\)"/);

  // Two colorbars in one document need two gradients; a shared id would paint
  // the second panel's bar with the first panel's ramp.
  const gradientIds = [...svg.matchAll(/<linearGradient id="([^"]+)"/g)].map(
    (match) => match[1]
  );
  assert.equal(gradientIds.length, 2);
  assert.equal(new Set(gradientIds).size, 2);
  for (const id of gradientIds) {
    assert.equal(
      [...svg.matchAll(new RegExp(`url\\(#${id}\\)`, 'g'))].length,
      1
    );
  }
});

test('a grid whose panels agree is still explained once, not four times', async () => {
  const views = [
    gridView({
      id: 'live',
      label: 'Live',
      fieldKey: 'leiden',
      fieldKind: 'category',
      legendModel: clusterModel(),
    }),
    gridView({
      id: 'snapshot',
      label: 'Snapshot',
      fieldKey: 'leiden',
      fieldKind: 'category',
      legendModel: clusterModel(),
    }),
  ];
  const svg = await (
    await renderFigureToSvgBlob({ payload: gridPayload(views) })
  ).text();
  assert.deepEqual(legendTitles(svg), ['leiden']);

  // The shared legend is refused as soon as the panels stop being the same
  // claim - including when only the hidden categories differ, because one
  // legend would then say both panels draw the same categories.
  assert.deepEqual(resolveSharedGridLegend(views), {
    fieldKey: 'leiden',
    model: views[0].scientificState.legendModel,
  });
  const filtered = clusterModel();
  filtered.visible = visibleOf([true, false]);
  views[1].scientificState.legendModel = filtered;
  assert.equal(resolveSharedGridLegend(views), null);

  const splitSvg = await (
    await renderFigureToSvgBlob({ payload: gridPayload(views) })
  ).text();
  assert.deepEqual(legendTitles(splitSvg), ['leiden', 'leiden']);
  assert.equal(
    [...splitSvg.matchAll(/>B cell \(hidden\)<\/text>/g)].length,
    1,
    'only the panel that hides the category may say so'
  );
});

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Every rectangle of a grid layout is disjoint from every other, and inside the figure. */
function assertDisjointGrid(layout) {
  const rects = [];
  layout.panes.forEach((pane, index) => {
    rects.push([`plot ${index}`, pane.plotRect]);
    if (pane.legendRect) rects.push([`legend ${index}`, pane.legendRect]);
    // The label row sits above the plot and the panel legend.
    assert.ok(pane.plotRect.y >= pane.labelY, `pane ${index}: plot under its label`);
    if (pane.legendRect) {
      assert.ok(pane.legendRect.y >= pane.labelY, `pane ${index}: legend under its label`);
      const { panelRect, legendRect } = pane;
      assert.ok(legendRect.x >= panelRect.x && legendRect.y >= panelRect.y);
      assert.ok(legendRect.x + legendRect.width <= panelRect.x + panelRect.width + 1);
      assert.ok(legendRect.y + legendRect.height <= panelRect.y + panelRect.height + 1);
    }
  });
  if (layout.sharedLegendRect) rects.push(['shared legend', layout.sharedLegendRect]);
  for (let i = 0; i < rects.length; i++) {
    const [name, rect] = rects[i];
    assert.ok(rect.x >= 0 && rect.y >= 0, `${name} inside the figure`);
    assert.ok(rect.x + rect.width <= layout.totalWidth && rect.y + rect.height <= layout.totalHeight, `${name} inside the figure`);
    for (let j = i + 1; j < rects.length; j++) {
      assert.equal(overlaps(rect, rects[j][1]), false, `${name} overlaps ${rects[j][0]}`);
    }
  }
}

test('a panel legend takes room beside or below its plot, never over it', () => {
  const views = [
    gridView({ id: 'live', label: 'Live', fieldKey: 'leiden', fieldKind: 'category', legendModel: clusterModel() }),
    gridView({ id: 'snap', label: 'Snap', fieldKey: 'sample', fieldKind: 'category', legendModel: sampleModel() }),
  ];
  // The legend takes room on the side that limits the fitted plot: a wide
  // view beside a legend on the right, a tall one above a legend below.
  const aspectFor = (legendPosition) => (legendPosition === 'right' ? 3 : 1 / 3);
  const grid = (legendPosition, includeLegend = true) => computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
    width: 1200,
    height: 900,
    views,
    plotAspects: views.map(() => aspectFor(legendPosition)),
    panelAxes: views.map(() => AXES),
    includeLegend,
    legendPosition,
    fontSize: 12,
    legendFontSizePx: 12,
    measureText: measure7,
  });
  for (const legendPosition of ['right', 'bottom']) {
    const bare = grid(legendPosition, false);
    assert.ok(bare.panes.every(pane => pane.legendRect === null));
    const layout = grid(legendPosition);
    assertDisjointGrid(layout);
    for (const [index, pane] of layout.panes.entries()) {
      assert.ok(pane.legendRect, `${legendPosition} legend must be placed`);
      assert.equal(pane.legendSide, legendPosition === 'right' ? 'right' : 'below');
      // The plot pays for a short legend rather than the legend being dropped.
      const shrunk = legendPosition === 'right'
        ? pane.plotRect.width < bare.panes[index].plotRect.width
        : pane.plotRect.height < bare.panes[index].plotRect.height;
      assert.ok(shrunk, `${legendPosition} legend must reserve its own space`);
    }
    // Two short legends fit the requested box, and the figure is its
    // composition: one side reaches the box, nothing pads the other.
    assert.ok(layout.totalWidth <= 1200 && layout.totalHeight <= 900, `${layout.totalWidth} × ${layout.totalHeight}`);
    assert.ok(layout.totalWidth >= 1198 || layout.totalHeight >= 898, `${layout.totalWidth} × ${layout.totalHeight}`);
  }

  // A cell too small for a legend does not drop it: the figure grows.
  const tiny = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
    width: 90,
    height: 70,
    views,
    plotAspects: views.map(() => 16 / 10),
    panelAxes: views.map(() => null),
    legendPosition: 'right',
    fontSize: 12,
    measureText: measure7,
  });
  assertDisjointGrid(tiny);
  assert.ok(tiny.panes.every(pane => pane.legendRect !== null));
  assert.ok(tiny.totalWidth > 90 && tiny.totalHeight > 70);
});

test('a grid of two disagreeing panels names every entry whole, its long legend below its plot', async () => {
  // UMAP colored by cell_type (69) beside PCA colored by
  // organ: panel A's legend lists its categories, not swatches followed by "…".
  const cellType = longCellTypeModel();
  const organ = {
    kind: 'category',
    categories: ['Blood', 'Bone marrow', 'Gut', 'Kidney', 'Liver', 'Skin', 'Spleen', 'Thymus', 'Yolk sac'],
    colors: new Uint8Array(27).fill(64),
    visible: new Uint8Array(9).fill(1),
    picker: [],
    counts: null,
  };
  const views = [
    gridView({ id: 'live', label: 'UMAP', fieldKey: 'cell_type', fieldKind: 'category', legendModel: cellType }),
    gridView({ id: 'pca', label: 'PCA', fieldKey: 'organ', fieldKind: 'category', legendModel: organ }),
  ];
  for (const legendPosition of ['right', 'bottom']) {
    const payload = gridPayload(views, { legendPosition });
    payload.width = 720;
    payload.height = 500;
    payload.options.width = 720;
    payload.options.height = 500;
    // The payload's layout, as both renderers lay it out: each panel's view
    // shape (a 320 × 240 pane), axes where they are rulers (none on 3-D).
    const { grid: layout } = computeFigureLayout(payload);
    assertDisjointGrid(layout);
    const [a, b] = layout.panes;
    // Panel A's names, beside its plot, would be wider than the plot: it moves below.
    assert.equal(a.legendSide, 'below');
    if (legendPosition === 'bottom') assert.equal(b.legendSide, 'below');
    for (const pane of layout.panes) {
      const longest = Math.max(...pane.legendPlan.entries.map(entry => estimateTextWidth(entry.label, 12)));
      assert.ok(pane.legendPlan.columnWidth >= 10 + 6 + longest);
      assert.ok(pane.legendRect.width >= 16 + pane.legendPlan.columns * pane.legendPlan.columnWidth);
      assert.ok(pane.legendRect.height >= pane.legendPlan.height);
      assert.ok(pane.plotRect.width >= 80 && pane.plotRect.height >= 64, 'a readable plot');
    }
    // The panels of a row line up: their plots start at one height, each
    // with its own view's aspect.
    assert.equal(a.plotRect.y, b.plotRect.y);
    for (const pane of layout.panes) {
      assert.ok(Math.abs(pane.plotRect.width / pane.plotRect.height - 4 / 3) < 1e-9);
    }
    assert.ok(layout.totalHeight > 500, `figure ${layout.totalHeight} px tall`);

    const svg = await (await renderFigureToSvgBlob({ payload })).text();
    // The figure in figure pixels (1/96 inch), its printed size in millimetres.
    const [, mmWidth, mmHeight, svgWidth, svgHeight] = svg.match(/^<svg[^>]* width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 (\d+) (\d+)"/);
    assert.equal(Number(svgWidth), layout.totalWidth);
    assert.equal(Number(svgHeight), layout.totalHeight);
    assert.ok(Math.abs(Number(mmWidth) - layout.totalWidth * 25.4 / 96) < 1e-3);
    assert.ok(Math.abs(Number(mmHeight) - layout.totalHeight * 25.4 / 96) < 1e-3);
    const entries = svgEntryTexts(svg);
    for (const name of [...cellType.categories.filter((_, index) => index !== 3), `${cellType.categories[3]} (hidden)`, ...organ.categories]) {
      assert.ok(entries.includes(name), `${name} drawn whole`);
    }
    assert.doesNotMatch(svg, /…/);
  }
});

test('the shared grid legend is sized to its entries, and the grid grows to keep it', () => {
  const model = longCellTypeModel();
  const views = [
    gridView({ id: 'a', label: 'A', fieldKey: 'cell_type', fieldKind: 'category', legendModel: model }),
    gridView({ id: 'b', label: 'B', fieldKey: 'cell_type', fieldKind: 'category', legendModel: structuredClone(model) }),
  ];
  for (const legendPosition of ['right', 'bottom']) {
    const layout = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
      width: 720,
      height: 500,
      views,
      plotAspects: views.map(() => 16 / 10),
      panelAxes: views.map(() => AXES),
      legendPosition,
      fontSize: 12,
      measureText: estimateTextWidth,
    });
    assertDisjointGrid(layout);
    assert.ok(layout.sharedLegendRect);
    assert.ok(layout.panes.every(pane => pane.legendRect === null));
    const plan = layout.sharedLegendPlan;
    assert.equal(plan.entries.length, 69);
    const longest = Math.max(...plan.entries.map(entry => estimateTextWidth(entry.label, 12)));
    assert.ok(plan.columnWidth >= 16 + longest);
    assert.ok(layout.sharedLegendRect.width >= 16 + plan.columns * plan.columnWidth);
    assert.ok(layout.sharedLegendRect.height >= plan.height);
    for (const pane of layout.panes) assert.ok(pane.plotRect.width >= 80 && pane.plotRect.height >= 64);
    assert.ok(layout.totalWidth > 720 || layout.totalHeight > 500);
  }
});

test('grid provenance describes every panel, never one panel four times', async () => {
  const views = fourDisagreeingPanels();
  const payload = gridPayload(views);
  const svg = await (await renderFigureToSvgBlob({ payload })).text();

  // The description must not read "Field: leiden • View: Live •
  // Filters: cell_type: hiding B cell" for a figure whose other three panels
  // used other fields and no filters at all.
  const description = svgDescription(svg);
  assert.equal(
    description,
    'Views: A. Live (Field: leiden; Filters: cell_type: hiding B cell) | ' +
    'B. CD3E view (Field: CD3E; Filters: none) | ' +
    'C. MS4A1 view (Field: MS4A1; Filters: none) | ' +
    'D. Sample view (Field: sample; Filters: none) • Source: /data/suo'
  );

  // No single color field may be claimed for the whole figure.
  assert.doesNotMatch(svg, /<cellucid:colorField>/);

  const json = svgProvenanceJson(svg);
  assert.deepEqual(
    json.views,
    [
      {
        panel: 'A',
        id: 'live',
        label: 'Live',
        name: null,
        field: { key: 'leiden', kind: 'category' },
        filters: ['cell_type: hiding B cell'],
        vectorField: null,
      },
      {
        panel: 'B',
        id: 'snapshot-cd3e',
        label: 'CD3E view',
        name: null,
        field: { key: 'CD3E', kind: 'continuous' },
        filters: [],
        vectorField: null,
      },
      {
        panel: 'C',
        id: 'snapshot-ms4a1',
        label: 'MS4A1 view',
        name: null,
        field: { key: 'MS4A1', kind: 'continuous' },
        filters: [],
        vectorField: null,
      },
      {
        panel: 'D',
        id: 'snapshot-sample',
        label: 'Sample view',
        name: null,
        field: { key: 'sample', kind: 'category' },
        filters: [],
        vectorField: null,
      },
    ]
  );
  // The retired single-view record must not linger beside the per-panel one.
  assert.equal(json.field, undefined);
  assert.equal(json.view, undefined);
  assert.equal(json.filters, undefined);

  // The PNG of the same export embeds the same claims, word for word.
  const pngChunks = buildPngTextMetadata(
    payload.meta,
    { ...payload, format: 'png', dpi: 300 }
  );
  assert.equal(pngChunks.Description, description);
  assert.equal(pngChunks['Color Field'], undefined);
  const pngJson = JSON.parse(pngChunks.Comment);
  assert.deepEqual(pngJson.views, json.views);
  assert.equal(pngJson.export.format, 'png');
  assert.equal(json.export.format, 'svg');
});

test('a single-view export keeps one truthful provenance record', async () => {
  const views = [
    gridView({
      id: 'live',
      label: 'Live',
      fieldKey: 'leiden',
      fieldKind: 'category',
      legendModel: clusterModel(),
      filters: ['No filters active'],
    }),
  ];
  const payload = gridPayload(views);
  const svg = await (await renderFigureToSvgBlob({ payload })).text();

  // One panel carries no panel letter, and the placeholder filter line is not
  // reported as a filter.
  assert.equal(
    svgDescription(svg),
    'Views: Live (Field: leiden; Filters: none) • Source: /data/suo'
  );
  // A field every panel shares may still be claimed for the file.
  assert.match(svg, /<cellucid:colorField>leiden<\/cellucid:colorField>/);
  assert.equal(svgProvenanceJson(svg).views[0].panel, null);
});

test('provenance refuses to describe views the figure does not draw', () => {
  assert.throws(
    () => buildProvenanceDescription({ fieldKey: 'leiden', viewLabel: 'Live' }),
    /one provenance record per exported view/
  );
  assert.throws(
    () => buildProvenanceDescription({ views: [] }),
    /one provenance record per exported view/
  );
  assert.throws(
    () => buildProvenanceDescription({
      views: [{ id: 'live', label: 'Live', fieldKey: 'leiden' }],
    }),
    /incomplete/
  );
});

test('panel letters keep counting past Z', () => {
  assert.equal(panelLetter(0), 'A');
  assert.equal(panelLetter(25), 'Z');
  assert.equal(panelLetter(26), 'AA');
  assert.equal(panelLetter(27), 'AB');
  assert.equal(panelLetter(51), 'AZ');
  assert.equal(panelLetter(52), 'BA');
  assert.throws(() => panelLetter(-1), RangeError);
});

test('each panel counts its own selection instead of copying the active one', async () => {
  const views = fourDisagreeingPanels();
  // Two cells, selected in both panels, but filtered out of the second.
  for (const view of views.slice(0, 2)) {
    view.data.pointCount = 2;
    view.data.positions = Float32Array.from([0, 0, 0, 0.1, 0.1, 0]);
    view.data.colors = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]);
  }
  views[0].data.transparency = Uint8Array.from([1, 1]);
  views[1].data.transparency = Uint8Array.from([1, 0]);
  for (const view of views.slice(2)) {
    view.data.pointCount = 2;
    view.data.positions = Float32Array.from([0, 0, 0, 0.1, 0.1, 0]);
    view.data.colors = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]);
    view.data.transparency = Uint8Array.from([0, 0]);
  }

  const payload = gridPayload(views);
  payload.options.emphasizeSelection = true;
  payload.selection = {
    highlightArray: Uint8Array.from([255, 255]),
    pageName: 'Page 1',
    totalCount: 2,
    visibleCount: 2,
  };

  const svg = await (await renderFigureToSvgBlob({ payload })).text();
  const badges = [...svg.matchAll(/>n = (\d+) selected<\/text>/g)].map(
    (match) => match[1]
  );
  // Panel A draws both selected cells, panel B only one, and the panels that
  // draw none carry no badge at all.
  assert.deepEqual(badges, ['2', '1']);

  assert.equal(
    countHighlightedVisiblePoints({
      highlightArray: Uint8Array.from([255, 255]),
      transparency: Uint8Array.from([1, 0]),
    }),
    1
  );
  assert.equal(
    countHighlightedVisiblePoints({
      highlightArray: Uint8Array.from([255, 255]),
      transparency: Uint8Array.from([1, 1]),
      lodMembership: { indices: Uint32Array.from([1]) },
      drawOrder: null,
    }),
    1
  );
  assert.equal(
    buildSelectionBadge({
      count: 0,
      plotRect: { x: 0, y: 0, width: 100, height: 100 },
      fontSizePx: 12,
    }),
    null
  );
});

test('SVG text from the data cannot carry characters XML forbids', async () => {
  const { svg } = svgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'cell\u0007type',
    model: categoryModel({
      categories: ['B\u0001cell <1>', 'T cell\uD800', 'Macro\u001Fphage'],
      visible: visibleOf({ 0: true, 1: true, 2: true }),
    }),
  });
  const xmlForbidden =
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(svg, xmlForbidden);
  assert.match(svg, />cell�type</);
  assert.match(svg, /B�cell &lt;1&gt;/);

  // Every figure-export SVG builder escapes through the XML-safe helper.
  const root = new URL(
    '../assets/js/app/ui/modules/figure-export/',
    import.meta.url
  );
  for (const file of [
    'renderers/svg-renderer.js',
    'components/axes-builder.js',
    'components/centroid-overlay.js',
    'components/legend-builder.js',
    'components/orientation-indicator.js',
  ]) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(source, /escapeHtml/, file);
    assert.match(source, /escapeXml\(/, file);
  }
});

test('a figure of a subsample says so: its cells, the dataset\'s, how they were chosen', async () => {
  const views = [
    gridView({
      id: 'live',
      label: 'Live',
      fieldKey: 'leiden',
      fieldKind: 'category',
      legendModel: clusterModel(),
      filters: ['No filters active'],
    }),
  ];
  const payload = gridPayload(views);
  payload.meta.datasetCells = { open: 228245, of: 2282447, method: 'uniform, seed 0', digest: '3f2a00c1d2e3f405' };
  const svg = await (await renderFigureToSvgBlob({ payload })).text();
  assert.equal(
    svgDescription(svg),
    'Views: Live (Field: leiden; Filters: none) • Cells: a subsample, 228,245 of 2,282,447 '
      + '(uniform, seed 0; cell set 3f2a00c1d2e3f405) • Source: /data/suo'
  );
  assert.deepEqual(svgProvenanceJson(svg).dataset.cells,
    { open: 228245, of: 2282447, method: 'uniform, seed 0', digest: '3f2a00c1d2e3f405' });
  // Every cell open: no claim, and the record says null.
  delete payload.meta.datasetCells;
  const whole = await (await renderFigureToSvgBlob({ payload })).text();
  assert.equal(svgProvenanceJson(whole).dataset.cells, null);
  assert.doesNotMatch(svgDescription(whole), /Cells:/);
  payload.meta.datasetCells = { open: 5, of: 5, method: 'uniform, seed 0', digest: 'x' };
  await assert.rejects(renderFigureToSvgBlob({ payload }), /describe a subsample/);
});

test('a color bar of the colormaps\' bare stops is drawn, and a gene sample\'s note wraps within the bar', () => {
  // `getCssStopsForColormap` gives bare colors (no positions), spaces inside.
  const model = { ...geneModel(['rgb(68, 1, 84)', 'rgb(33, 145, 140)', 'rgb(253, 231, 37)']), geneSample: { cells: 1_759, of: 2_282_447 }, zeroGray: { enabled: true, applies: true, drawn: true } };
  const narrow = { x: 0, y: 0, width: 220, height: 160 };
  const { svg, defs } = svgLegend({ legendRect: narrow, fieldKey: 'G', model });
  assert.deepEqual(
    [...defs.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"\/>/g)].map(match => [match[1], match[2]]),
    [['0%', 'rgb(68, 1, 84)'], ['50%', 'rgb(33, 145, 140)'], ['100%', 'rgb(253, 231, 37)']],
  );
  const lines = svgTexts(svg).slice(3);
  assert.ok(lines.length > 1, 'the note wraps');
  assert.equal(lines.join(' '), 'Gene read for 1,759 of 2,282,447 cells. Faded: not read · gray: 0', 'and nothing of it is cut');
});
