import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderFigureToSvgBlob,
} from '../assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js';
import {
  areLegendModelsSemanticallyEqual,
} from '../assets/js/app/ui/modules/figure-export/utils/legend-model-equality.js';

const IDENTITY = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function cameraState() {
  return {
    navigationMode: 'orbit',
    orbit: {
      radius: 3,
      targetRadius: 3,
      theta: 0,
      phi: Math.PI / 2,
      target: [0, 0, 0],
    },
    freefly: {
      position: [0, 0, 3],
      yaw: 0,
      pitch: 0,
    },
  };
}

function renderState() {
  return {
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

function categoryLegend() {
  return {
    kind: 'category',
    categories: ['Alpha', 'Beta'],
    colors: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    visible: [true, true],
    picker: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    counts: [1, 0],
  };
}

function makeView({
  id,
  label,
  transparency = 1,
  legendModel = null,
  fieldKey = legendModel === null ? null : 'cluster',
  filters = [],
}) {
  return {
    cameraState: cameraState(),
    data: {
      centroidColors: null,
      centroidFlags: { labels: false, points: false },
      centroidLabelTexts: [],
      centroidPositions: null,
      colors: Uint8Array.from([255, 0, 0, 255]),
      pointCount: 1,
      positions: Float32Array.from([0, 0, 0]),
      transparency: Float32Array.from([transparency]),
    },
    id,
    label,
    renderState: renderState(),
    scientificState: {
      datasetGeneration: 7,
      dimensionLevel: 3,
      fieldKey,
      fieldKind: fieldKey === null ? null : 'category',
      filters,
      geometryGeneration: 11,
      legendModel,
      lodMembership: null,
      lodSizeMultiplier: 1,
      normTransform: {
        center: [0, 0, 0],
        scale: 1,
      },
    },
  };
}

/** The provenance record the engine derives from the exported views. */
function provenanceViews(views) {
  return views.map((view) => ({
    fieldKey: view.scientificState.fieldKey,
    fieldKind: view.scientificState.fieldKind,
    filters: [...view.scientificState.filters],
    id: view.id,
    label: view.label,
  }));
}

function payload({
  crop = null,
  depthSort3d = false,
  fontFamily = 'Arial, sans-serif',
  includeAxes = true,
  includeLegend = false,
  referenceGrid = null,
  showOrientation = true,
  strategy = 'full-vector',
  views,
  width = 900,
  height = 520,
}) {
  return {
    dpi: null,
    format: 'svg',
    height,
    meta: { views: provenanceViews(views) },
    options: {
      axisLabelFontSizePx: 12,
      background: 'viewer',
      backgroundColor: '#ffffff',
      centroidLabelFontSizePx: 12,
      crop,
      depthSort3d,
      emphasizeSelection: false,
      fontFamily,
      fontSizePx: 12,
      height,
      includeAxes,
      includeLegend,
      legendFontSizePx: 12,
      legendPosition: 'right',
      optimizedTargetCount: strategy === 'optimized-vector' ? 1000 : null,
      referenceGrid,
      selectionMutedOpacity: 0.15,
      showOrientation,
      strategy,
      tickFontSizePx: 12,
      title: '',
      titleFontSizePx: 15,
      width,
      xLabel: 'UMAP 1',
      yLabel: 'UMAP 2',
    },
    selection: {
      highlightArray: null,
      totalCount: 0,
      visibleCount: 0,
    },
    title: '',
    views,
    width,
  };
}

function occurrences(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function assertSvgStartTagAttributesAreWellFormed(svg) {
  const xmlName = '[A-Za-z_:][A-Za-z0-9_.:-]*';
  const attribute =
    `${xmlName}\\s*=\\s*(?:\"[^\"<]*\"|'[^'<]*')`;
  const startTag = new RegExp(
    `^<${xmlName}(?:\\s+${attribute})*\\s*\\/?>$`
  );
  const tags = svg.match(/<(?![!?/])[^>]+>/g) ?? [];
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    assert.match(tag, startTag, `malformed SVG start tag: ${tag}`);
  }
}

test('legend-model equality is deep, key-order independent, and non-mutating', () => {
  const left = categoryLegend();
  const right = {
    counts: [1, 0],
    picker: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    visible: [true, true],
    colors: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    categories: ['Alpha', 'Beta'],
    kind: 'category',
  };
  const leftBefore = structuredClone(left);
  const rightBefore = structuredClone(right);

  assert.equal(areLegendModelsSemanticallyEqual(left, right), true);
  assert.deepEqual(left, leftBefore);
  assert.deepEqual(right, rightBefore);

  right.colors[1][2] = 0.25;
  assert.equal(areLegendModelsSemanticallyEqual(left, right), false);
  right.colors[1][2] = 0;
  right.categories.reverse();
  assert.equal(areLegendModelsSemanticallyEqual(left, right), false);
});

test('multiview SVG shares only separately owned, semantically equal legends', async () => {
  const equal = payload({
    includeAxes: false,
    includeLegend: true,
    showOrientation: false,
    views: [
      makeView({ id: 'live', label: 'Live', legendModel: categoryLegend() }),
      makeView({
        id: 'snapshot',
        label: 'Snapshot',
        legendModel: structuredClone(categoryLegend()),
      }),
    ],
  });
  const equalSvg = await (await renderFigureToSvgBlob({ payload: equal })).text();
  // Panels that genuinely agree are explained once, not once per panel.
  assert.equal(
    occurrences(equalSvg, /font-weight="600">cluster<\/text>/g),
    1
  );

  const differentModel = structuredClone(categoryLegend());
  differentModel.colors[1][2] = 0.25;
  const different = payload({
    includeAxes: false,
    includeLegend: true,
    showOrientation: false,
    views: [
      makeView({ id: 'live', label: 'Live', legendModel: categoryLegend() }),
      makeView({
        id: 'snapshot',
        label: 'Snapshot',
        legendModel: differentModel,
      }),
    ],
  });
  const differentSvg = await (
    await renderFigureToSvgBlob({ payload: different })
  ).text();
  // Panels that disagree are never merged into one legend, and are never left
  // without one either: each panel explains its own colors.
  assert.equal(
    occurrences(differentSvg, /font-weight="600">cluster<\/text>/g),
    2
  );
  assert.match(differentSvg, /fill="rgb\(0,255,0\)"/);
  assert.match(differentSvg, /fill="rgb\(0,255,64\)"/);

  const missing = payload({
    includeAxes: false,
    includeLegend: true,
    showOrientation: false,
    views: [
      makeView({ id: 'live', label: 'Live', legendModel: categoryLegend() }),
      makeView({
        id: 'snapshot',
        label: 'Snapshot',
        legendModel: null,
        fieldKey: null,
      }),
    ],
  });
  const missingSvg = await (
    await renderFigureToSvgBlob({ payload: missing })
  ).text();
  // The coloured panel keeps its legend; the panel with no active field has
  // nothing to explain.
  assert.equal(
    occurrences(missingSvg, /font-weight="600">cluster<\/text>/g),
    1
  );
});

test('Times-family axes and legends remain well-formed escaped SVG attributes', async () => {
  const timesFamily = '"Times New Roman", Times, serif';
  const exact = payload({
    fontFamily: timesFamily,
    includeLegend: true,
    views: [
      makeView({
        id: 'live',
        label: 'Live',
        legendModel: categoryLegend(),
      }),
    ],
  });
  const svg = await (await renderFigureToSvgBlob({ payload: exact })).text();

  assertSvgStartTagAttributesAreWellFormed(svg);
  assert.match(
    svg,
    /font-family="&quot;Times New Roman&quot;, Times, serif"/
  );
  assert.doesNotMatch(svg, /font-family=""Times New Roman"/);
});

test('multiview SVG renders axes and orientation for every eligible pane', async () => {
  const exact = payload({
    views: [
      makeView({ id: 'live', label: 'Live' }),
      makeView({ id: 'snapshot', label: 'Snapshot' }),
    ],
  });
  const svg = await (await renderFigureToSvgBlob({ payload: exact })).text();

  assert.equal(occurrences(svg, />UMAP 1<\/text>/g), 2);
  assert.equal(occurrences(svg, />UMAP 2<\/text>/g), 2);
  assert.equal(occurrences(svg, />az 0°<\/text>/g), 2);
  assert.match(svg, />A\. Live<\/text>/);
  assert.match(svg, />B\. Snapshot<\/text>/);
});

test('single-view SVG emits orientation and selection annotations after every point overlay', async () => {
  const exact = payload({
    includeAxes: false,
    views: [makeView({ id: 'live', label: 'Live' })],
  });
  exact.options.emphasizeSelection = true;
  exact.selection = {
    highlightArray: Uint8Array.from([255]),
    totalCount: 1,
    visibleCount: 1,
  };

  const svg = await (await renderFigureToSvgBlob({ payload: exact })).text();
  const lastPointOverlay = svg.lastIndexOf('<circle ');
  const orientation = svg.indexOf('>az 0°</text>');
  const selection = svg.indexOf('>n = 1 selected</text>');

  assert.notEqual(lastPointOverlay, -1);
  assert.ok(orientation > lastPointOverlay);
  assert.ok(selection > lastPointOverlay);
});

test('multiview SVG emits one deterministic empty state across vector strategies', async () => {
  for (const strategy of ['full-vector', 'optimized-vector']) {
    const exact = payload({
      includeAxes: false,
      showOrientation: false,
      strategy,
      views: [
        makeView({ id: 'visible', label: 'Visible' }),
        makeView({
          id: 'filtered',
          label: 'Filtered',
          transparency: 0,
        }),
      ],
    });
    const svg = await (await renderFigureToSvgBlob({ payload: exact })).text();
    assert.equal(
      occurrences(svg, />No visible cells<\/text>/g),
      1,
      strategy
    );
  }
});

test('axes-off SVG empty states remain projection- and crop-aware', async () => {
  const offscreenView = makeView({ id: 'live', label: 'Live' });
  offscreenView.data.positions[0] = 2;
  const singleSvg = await (
    await renderFigureToSvgBlob({
      payload: payload({
        includeAxes: false,
        showOrientation: false,
        views: [offscreenView],
      }),
    })
  ).text();
  assert.equal(occurrences(singleSvg, />No visible cells<\/text>/g), 1);
  assert.equal(occurrences(singleSvg, /<circle /g), 0);

  const inCropView = makeView({ id: 'inside', label: 'Inside' });
  inCropView.data.positions[0] = 0.5;
  const outsideCropView = makeView({ id: 'outside', label: 'Outside' });
  outsideCropView.data.positions[0] = -0.5;
  const gridSvg = await (
    await renderFigureToSvgBlob({
      payload: payload({
        crop: {
          enabled: true,
          x: 0.5,
          y: 0,
          width: 0.5,
          height: 1,
        },
        includeAxes: false,
        showOrientation: false,
        views: [inCropView, outsideCropView],
      }),
    })
  ).text();
  assert.equal(occurrences(gridSvg, />No visible cells<\/text>/g), 1);
  assert.equal(occurrences(gridSvg, /<circle /g), 1);
});

test('full-vector SVG depth sorting ignores earlier off-crop points without corrupting packed bins', async () => {
  const view = makeView({ id: 'live', label: 'Live' });
  view.data.positions = Float32Array.from([
    -0.5, 0, 0,
    0.5, 0, 0,
  ]);
  view.data.colors = Uint8Array.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
  ]);
  view.data.transparency = Float32Array.from([1, 1]);
  view.data.pointCount = 2;

  const exact = payload({
    crop: {
      enabled: true,
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 1,
    },
    depthSort3d: true,
    includeAxes: false,
    showOrientation: false,
    views: [view],
  });
  const svg = await (await renderFigureToSvgBlob({ payload: exact })).text();

  assert.equal(occurrences(svg, /<circle /g), 1);
  assert.match(svg, /fill="rgb\(0,255,0\)"/);
  assert.doesNotMatch(svg, /fill="rgb\(255,0,0\)"/);
  assert.doesNotMatch(svg, /(?:NaN|undefined|Infinity)/);
});

test('mixed multiview SVG replaces empty-pane axes with one message', async () => {
  const exact = payload({
    views: [
      makeView({ id: 'visible', label: 'Visible' }),
      makeView({
        id: 'filtered',
        label: 'Filtered',
        transparency: 0,
      }),
    ],
  });
  const svg = await (await renderFigureToSvgBlob({ payload: exact })).text();

  assert.equal(occurrences(svg, />UMAP 1<\/text>/g), 1);
  assert.equal(occurrences(svg, />UMAP 2<\/text>/g), 1);
  assert.equal(occurrences(svg, />No visible cells<\/text>/g), 1);
  assert.equal(occurrences(svg, />az 0°<\/text>/g), 2);
});

test('tiny multiview SVG panes keep bounded gutters and finite geometry', async () => {
  const exact = payload({
    width: 120,
    height: 100,
    includeLegend: true,
    views: [
      makeView({ id: 'a', label: 'A', legendModel: categoryLegend() }),
      makeView({ id: 'b', label: 'B', legendModel: categoryLegend() }),
      makeView({ id: 'c', label: 'C', legendModel: categoryLegend() }),
      makeView({ id: 'd', label: 'D', legendModel: categoryLegend() }),
    ],
  });
  const svg = await (await renderFigureToSvgBlob({ payload: exact })).text();

  assert.doesNotMatch(svg, /(?:NaN|Infinity)/);
  assert.doesNotMatch(svg, /(?:width|height)="-/);
  assert.doesNotMatch(svg, /font-weight="600">cluster<\/text>/);
  for (const label of ['A. A', 'B. B', 'C. C', 'D. D']) {
    assert.match(svg, new RegExp(`>${label.replace('.', '\\.')}<\\/text>`));
  }
});
