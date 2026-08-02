/**
 * Regression coverage for the ways a figure export could publish a claim the
 * viewer never made:
 *
 * 1. Exporting while the viewer draws volumetric smoke, producing a point
 *    cloud stamped with metadata that says it is the active view.
 * 2. Exporting a legend that describes categories the figure does not draw, or
 *    a logarithmic colorbar labelled only with its endpoints.
 * 3. Exporting a multi-panel grid with no legend at all, and stamping the
 *    whole file with the active panel's field and filters.
 *
 * These defects survive every other test, because `legend-builder.js`,
 * `utils/layout.js`, `utils/render-mode.js`, `utils/figure-provenance.js` and
 * `fidelity-warning-dialog.js` carried no coverage at all.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildColorScaleNote,
  drawCanvasLegend,
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
  computeGridPaneLayout,
  computeSingleViewLayout,
} from '../assets/js/app/ui/modules/figure-export/utils/layout.js';
import {
  renderFigureToSvgBlob,
} from '../assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js';
import {
  buildPngTextMetadata,
} from '../assets/js/app/ui/modules/figure-export/renderers/png-renderer.js';
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
    colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    // `_categoryVisible` is a plain index->boolean map, not an array.
    visible: { 0: true, 1: false, 2: true },
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

// ---------------------------------------------------------------------------
// CEL-AUDIT-0024 - volumetric render mode must block the export
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
// CEL-AUDIT-0025 - the exported legend must describe the exported figure
// ---------------------------------------------------------------------------

test('SVG legend never gives a hidden category a colored swatch', () => {
  const { svg } = renderSvgLegend({
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
  drawCanvasLegend({
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

test('SVG and Canvas legends publish identical category text', () => {
  const model = categoryModel();
  const { svg } = renderSvgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'cell_type',
    model,
  });
  const { ctx, record } = recordingContext();
  drawCanvasLegend({
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

test('a narrow legend truncates the name, never the hidden marker', () => {
  const model = categoryModel({
    categories: ['Plasmacytoid dendritic cell', 'Erythroid progenitor'],
    colors: [[1, 0, 0], [0, 1, 0]],
    visible: { 0: true, 1: false },
  });
  const narrow = { x: 0, y: 0, width: 96, height: 200 };

  const { svg } = renderSvgLegend({
    legendRect: narrow,
    fieldKey: 'cell_type',
    model,
  });
  const { ctx, record } = recordingContext();
  drawCanvasLegend({ ctx, legendRect: narrow, fieldKey: 'cell_type', model });

  const svgHidden = svgTexts(svg).at(-1);
  const canvasHidden = record.texts.at(-1).text;
  assert.ok(svgHidden.endsWith(' (hidden)'), `SVG label was "${svgHidden}"`);
  assert.ok(
    canvasHidden.endsWith(' (hidden)'),
    `Canvas label was "${canvasHidden}"`
  );
  assert.ok(svgHidden.length < 'Erythroid progenitor (hidden)'.length);
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

  const { svg } = renderSvgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'CD19',
    model,
  });
  assert.ok(svgTexts(svg).includes('Log10 color scale (midpoint 31.6)'));

  const { ctx, record } = recordingContext();
  drawCanvasLegend({ ctx, legendRect: WIDE_RECT, fieldKey: 'CD19', model });
  assert.deepEqual(
    svgTexts(svg),
    record.texts.map((entry) => entry.text)
  );
});

test('a linear colorbar carries no logarithmic claim', () => {
  const model = continuousModel();
  assert.equal(buildColorScaleNote(model, 1, 1000), null);

  const { svg } = renderSvgLegend({
    legendRect: WIDE_RECT,
    fieldKey: 'CD19',
    model,
  });
  assert.doesNotMatch(svg, /Log10/);

  const { ctx, record } = recordingContext();
  drawCanvasLegend({ ctx, legendRect: WIDE_RECT, fieldKey: 'CD19', model });
  assert.ok(!record.texts.some((entry) => /Log10/.test(entry.text)));
});

test('a log colorbar whose domain is unusable still declares the scale', () => {
  const model = continuousModel({ scale: 'log', logEnabled: true });
  assert.equal(buildColorScaleNote(model, 0, 1000), 'Log10 color scale');
  assert.equal(buildColorScaleNote(model, Number.NaN, 10), 'Log10 color scale');
});

test('legend sizing reserves room for the hidden marker', () => {
  const categories = ['Erythroid progenitor', 'B cell'];
  const colors = [[1, 0, 0], [0, 1, 0]];
  const dimensions = (visible) => computeSingleViewLayout({
    width: 800,
    height: 600,
    title: '',
    includeAxes: false,
    includeLegend: true,
    legendPosition: 'right',
    legendModel: { kind: 'category', categories, colors, visible },
    legendFontSizePx: 12,
  }).legendRect.width;

  assert.ok(
    dimensions({ 0: false, 1: true }) > dimensions({ 0: true, 1: true }),
    'a marked entry needs more width than the bare name'
  );
});

// ---------------------------------------------------------------------------
// CEL-AUDIT-0035 - a multi-panel figure must carry a legend for every panel
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
    bgColor: Float32Array.from([1, 1, 1]),
    cameraDistance: 3,
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

/** One panel of a grid export, coloured by its own field with its own filters. */
function gridView({ id, label, fieldKey, fieldKind, legendModel, filters = [] }) {
  return {
    cameraState: gridCameraState(),
    data: {
      centroidColors: null,
      centroidFlags: { labels: false, points: false },
      centroidLabelTexts: [],
      centroidPositions: null,
      colors: Uint8Array.from([255, 0, 0, 255]),
      pointCount: 1,
      positions: Float32Array.from([0, 0, 0]),
      transparency: Float32Array.from([1]),
    },
    id,
    label,
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
      lodSizeMultiplier: 1,
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
    selection: { highlightArray: null, totalCount: 0, visibleCount: 0 },
    title: '',
    views,
    width,
  };
}

function clusterModel() {
  return {
    kind: 'category',
    categories: ['T cell', 'B cell'],
    colors: [[1, 0, 0], [0, 0, 1]],
    visible: { 0: true, 1: true },
    picker: [],
    counts: null,
  };
}

function sampleModel() {
  return {
    kind: 'category',
    categories: ['Donor 1', 'Donor 2'],
    colors: [[0, 1, 1], [1, 1, 0]],
    visible: { 0: true, 1: true },
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

/** The four panels of the audited figure: leiden, CD3E, MS4A1, sample. */
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

  // Before this fix the grid emitted no legend whatsoever: four coloured
  // panels a reader could not decode at all.
  assert.deepEqual(legendTitles(svg), ['leiden', 'CD3E', 'MS4A1', 'sample']);

  // Each categorical panel shows its own categories, with its own colours.
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
  filtered.visible = { 0: true, 1: false };
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

test('a panel legend takes room from the plot instead of covering it', () => {
  const cell = {
    cellX: 40,
    cellY: 60,
    cellWidth: 560,
    cellHeight: 420,
    includeAxes: true,
    fontSize: 12,
    legendFontSizePx: 12,
  };
  const bare = computeGridPaneLayout({ ...cell, legendModel: null });
  assert.equal(bare.legendRect, null);

  for (const legendPosition of ['right', 'bottom']) {
    const withLegend = computeGridPaneLayout({
      ...cell,
      legendModel: clusterModel(),
      legendPosition,
    });
    const { legendRect, plotRect, panelRect, labelY } = withLegend;
    assert.ok(legendRect, `${legendPosition} legend must be placed`);

    // Disjoint from the plot: no legend entry can sit on top of a data point.
    const overlaps =
      legendRect.x < plotRect.x + plotRect.width &&
      plotRect.x < legendRect.x + legendRect.width &&
      legendRect.y < plotRect.y + plotRect.height &&
      plotRect.y < legendRect.y + legendRect.height;
    assert.equal(overlaps, false, `${legendPosition} legend overlaps the plot`);

    // Below the panel label ("A. Live"), and inside the panel.
    assert.ok(legendRect.y >= labelY, `${legendPosition} legend hits the label`);
    assert.ok(legendRect.x >= panelRect.x);
    assert.ok(legendRect.y >= panelRect.y);
    assert.ok(
      legendRect.x + legendRect.width <= panelRect.x + panelRect.width + 1
    );
    assert.ok(
      legendRect.y + legendRect.height <= panelRect.y + panelRect.height + 1
    );

    // The plot pays for the legend rather than the legend being dropped.
    const shrunk = legendPosition === 'right'
      ? plotRect.width < bare.plotRect.width
      : plotRect.height < bare.plotRect.height;
    assert.ok(shrunk, `${legendPosition} legend must reserve its own space`);
  }

  // A cell with no room for a readable legend says so instead of drawing an
  // unreadable one on top of the data.
  assert.equal(
    computeGridPaneLayout({
      cellX: 0,
      cellY: 0,
      cellWidth: 90,
      cellHeight: 70,
      includeAxes: false,
      fontSize: 12,
      legendModel: clusterModel(),
    }).legendRect,
    null
  );
});

test('grid provenance describes every panel, never one panel four times', async () => {
  const views = fourDisagreeingPanels();
  const payload = gridPayload(views);
  const svg = await (await renderFigureToSvgBlob({ payload })).text();

  // Before this fix the description read "Field: leiden • View: Live •
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

  // No single colour field may be claimed for the whole figure.
  assert.doesNotMatch(svg, /<cellucid:colorField>/);

  const json = svgProvenanceJson(svg);
  assert.deepEqual(
    json.views,
    [
      {
        panel: 'A',
        id: 'live',
        label: 'Live',
        field: { key: 'leiden', kind: 'category' },
        filters: ['cell_type: hiding B cell'],
      },
      {
        panel: 'B',
        id: 'snapshot-cd3e',
        label: 'CD3E view',
        field: { key: 'CD3E', kind: 'continuous' },
        filters: [],
      },
      {
        panel: 'C',
        id: 'snapshot-ms4a1',
        label: 'MS4A1 view',
        field: { key: 'MS4A1', kind: 'continuous' },
        filters: [],
      },
      {
        panel: 'D',
        id: 'snapshot-sample',
        label: 'Sample view',
        field: { key: 'sample', kind: 'category' },
        filters: [],
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
  views[0].data.transparency = Float32Array.from([1, 1]);
  views[1].data.transparency = Float32Array.from([1, 0]);
  for (const view of views.slice(2)) {
    view.data.pointCount = 2;
    view.data.positions = Float32Array.from([0, 0, 0, 0.1, 0.1, 0]);
    view.data.colors = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]);
    view.data.transparency = Float32Array.from([0, 0]);
  }

  const payload = gridPayload(views);
  payload.options.emphasizeSelection = true;
  payload.selection = {
    highlightArray: Uint8Array.from([255, 255]),
    totalCount: 2,
    visibleCount: 2,
  };

  const svg = await (await renderFigureToSvgBlob({ payload })).text();
  const badges = [...svg.matchAll(/>n = (\d+) selected<\/text>/g)].map(
    (match) => match[1]
  );
  // Panel A draws both selected cells, panel B only one, and the panels that
  // draw none carry no badge at all - the grid used to carry none either.
  assert.deepEqual(badges, ['2', '1']);

  assert.equal(
    countHighlightedVisiblePoints({
      highlightArray: Uint8Array.from([255, 255]),
      transparency: Float32Array.from([1, 0]),
    }),
    1
  );
  assert.equal(
    countHighlightedVisiblePoints({
      highlightArray: Uint8Array.from([255, 255]),
      transparency: Float32Array.from([1, 1]),
      lodMembership: { indices: Uint32Array.from([1]) },
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

test('both renderers place panel legends through the one shared layout', async () => {
  const [svgSource, pngSource] = await Promise.all([
    source('renderers/svg-renderer.js'),
    source('renderers/png-renderer.js'),
  ]);

  for (const [name, rendererSource] of [
    ['SVG', svgSource],
    ['PNG', pngSource],
  ]) {
    // No renderer-local copy of the grid cell geometry may come back: the two
    // renderers drifting apart is what a shared layout module prevents.
    assert.doesNotMatch(
      rendererSource,
      /function computeGridPaneLayout/,
      `${name} renderer must not own a private grid pane layout`
    );
    assert.match(
      rendererSource,
      /legendModel: panelLegendModel,\s*\n\s*legendPosition,/,
      `${name} renderer must feed the panel legend into the shared layout`
    );
    assert.match(
      rendererSource,
      /rendersPanelLegends = includeLegend && !rendersSharedLegend/,
      `${name} renderer must fall back to per-panel legends`
    );
    assert.match(
      rendererSource,
      /countHighlightedVisiblePoints\(\{/,
      `${name} renderer must count each panel's own selection`
    );
    assert.match(
      rendererSource,
      /buildProvenanceDescription\(meta\)/,
      `${name} renderer must embed the shared provenance description`
    );
  }
});
