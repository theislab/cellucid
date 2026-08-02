import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertFigureExportPayload,
} from '../assets/js/app/ui/modules/figure-export/figure-export-contract.js';
import {
  buildOverlayFidelityWarnings,
} from '../assets/js/app/ui/modules/figure-export/utils/overlay-fidelity.js';
import {
  buildRenderModeFidelityWarnings,
} from '../assets/js/app/ui/modules/figure-export/utils/render-mode.js';
import {
  buildViewerBackgroundFidelityWarnings,
} from '../assets/js/app/ui/modules/figure-export/utils/viewer-background.js';
import {
  scalePointDiameterToRaster,
} from '../assets/js/app/ui/modules/figure-export/utils/point-size.js';
import {
  rasterizePointsWebgl,
} from '../assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js';

/**
 * Antialiasing is a viewer layer, not an export preference.
 *
 * `antialias` is a WebGL context-creation attribute, and since the viewer let
 * the user turn it off it is a published property of the drawing buffer the
 * user is looking at — `viewer.getGrantedAntialiasing()`. The app's own control
 * measures the difference at 18% of pixels at the default point size and 32%
 * with ultra-light square points (`index.html`, the antialiasing tooltip), so a
 * figure rasterised with multisampling the screen does not have is a different
 * picture of the same data, which is exactly what this module exists to
 * prevent.
 *
 * The export therefore carries the granted value through the render state, the
 * same way it carries shader quality and fog, rather than requesting a fixed
 * `true` for every export.
 */

const IDENTITY = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function renderState({ antialias = true } = {}) {
  return {
    antialias,
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
    viewportHeight: 100,
    viewportWidth: 100,
  };
}

/**
 * A document whose canvas records the context attributes and then declines.
 *
 * Declining is what keeps this a real exercise of the shipped path rather than
 * a source sweep: the rasterizer asks for its context exactly once, with the
 * attributes it decided on, before anything needs a GPU.
 */
function recordingDocument(record) {
  return {
    createElement(tagName) {
      assert.equal(tagName, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext(type, attributes) {
          record.push({ type, attributes });
          return null;
        },
      };
    },
  };
}

function rasterizeWith(state, record) {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  globalThis.document = recordingDocument(record);
  try {
    rasterizePointsWebgl({
      positions: Float32Array.from([0, 0, 0]),
      colors: Uint8Array.from([255, 255, 255, 255]),
      transparency: Float32Array.from([1]),
      renderState: state,
      outputWidthPx: 8,
      outputHeightPx: 8,
      pointSizePx: 4,
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', previousDocument);
  }
}

test('the export raster is created with the antialiasing the viewer granted', () => {
  for (const antialias of [true, false]) {
    const record = [];
    assert.throws(
      () => rasterizeWith(renderState({ antialias }), record),
      /requires WebGL2 rasterization support/
    );
    assert.equal(record.length, 1, 'exactly one context request per raster');
    assert.equal(record[0].type, 'webgl2');
    assert.equal(
      record[0].attributes.antialias,
      antialias,
      'a figure rasterised with multisampling the screen does not have is a '
        + 'different picture: the app measures the difference at 18% of pixels',
    );
  }
});

test('an export raster with no published antialiasing is a contract error', () => {
  for (const antialias of [undefined, null, 'true', 1, 0]) {
    const state = renderState();
    if (antialias === undefined) delete state.antialias;
    else state.antialias = antialias;
    const record = [];
    assert.throws(
      () => rasterizeWith(state, record),
      /renderState\.antialias must be an exact boolean/,
    );
    assert.equal(
      record.length,
      0,
      'the contract is checked before any context is requested',
    );
  }
});

test('an exported view must publish the antialiasing it was drawn with', () => {
  const view = {
    cameraState: {
      navigationMode: 'orbit',
      orbit: {
        radius: 3,
        targetRadius: 3,
        theta: 0,
        phi: Math.PI / 2,
        target: [0, 0, 0],
      },
      freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 },
    },
    data: {
      centroidColors: null,
      centroidFlags: { labels: false, points: false },
      centroidLabelTexts: [],
      centroidPositions: null,
      colors: Uint8Array.from([255, 255, 255, 255]),
      pointCount: 1,
      positions: Float32Array.from([0, 0, 0]),
      transparency: Float32Array.from([1]),
    },
    id: 'live',
    label: 'Live',
    renderState: renderState(),
    scientificState: {
      datasetGeneration: 7,
      dimensionLevel: 3,
      fieldKey: null,
      fieldKind: null,
      filters: [],
      geometryGeneration: 11,
      legendModel: null,
      lodMembership: null,
      lodSizeMultiplier: 1,
      normTransform: { center: [0, 0, 0], scale: 1 },
    },
  };
  const build = () => ({
    dpi: null,
    format: 'svg',
    height: 100,
    meta: {
      views: [{
        fieldKey: null,
        fieldKind: null,
        filters: [],
        id: 'live',
        label: 'Live',
      }],
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
      height: 100,
      includeAxes: true,
      includeLegend: false,
      legendFontSizePx: 12,
      legendPosition: 'right',
      optimizedTargetCount: null,
      referenceGrid: null,
      selectionMutedOpacity: 0.15,
      showOrientation: true,
      strategy: 'full-vector',
      tickFontSizePx: 12,
      title: '',
      titleFontSizePx: 15,
      width: 100,
      xLabel: 'X',
      yLabel: 'Y',
    },
    selection: { highlightArray: null, totalCount: 0, visibleCount: 0 },
    title: '',
    views: [structuredClone(view)],
    width: 100,
  });

  const exact = build();
  assert.equal(assertFigureExportPayload(exact), exact);

  const missing = build();
  delete missing.views[0].renderState.antialias;
  assert.throws(() => assertFigureExportPayload(missing), /antialias/);

  const wrongType = build();
  wrongType.views[0].renderState.antialias = 'false';
  assert.throws(() => assertFigureExportPayload(wrongType), /antialias/);
});

// ---------------------------------------------------------------------------
// Every refusal must name the control that clears it
// ---------------------------------------------------------------------------

/**
 * The export blocker dialog offers one button, `Back`. There is no "export
 * anyway". So a blocker that states only what is wrong leaves the user to
 * guess which of the sidebar's controls to go and find, and two of the three
 * togglable causes live in accordions that are closed by default.
 *
 * The rule is therefore about the *remedy*, not about a phrase: a blocker
 * raised by a control the user can operate must quote that control's on-screen
 * label, and that label must be markup the shipped page really carries. The
 * only blockers exempt are the ones whose cause is the control being
 * unreadable — they cannot name a label they could not find, and they say so.
 *
 * Checking the label against `index.html` is what keeps this honest in both
 * directions: renaming the control in the page without updating the advice
 * fails here, and inventing advice for a control that does not exist fails too.
 */
function documentWith(elements) {
  return {
    getElementById(id) {
      return Object.hasOwn(elements, id) ? elements[id] : null;
    },
  };
}

/** A blocker that cannot name its control says so instead. */
const UNREADABLE_CONTROL = /could not be read/;

test('every export blocker names a control the shipped page carries', async () => {
  const indexHtml = await readFile(
    new URL('../index.html', import.meta.url),
    'utf8'
  );

  // One case per togglable cause, each in the state a user can really reach.
  const cases = [
    {
      cause: 'connectivity edges drawn in the viewer',
      label: 'Show connectivity edges',
      warnings: buildOverlayFidelityWarnings({
        documentRef: documentWith({
          'velocity-overlay-enabled': { checked: false },
        }),
        connectivityVisible: true,
      }),
    },
    {
      cause: 'velocity vector field drawn in the viewer',
      label: 'Show overlay',
      warnings: buildOverlayFidelityWarnings({
        documentRef: documentWith({
          'velocity-overlay-enabled': { checked: true },
        }),
        connectivityVisible: false,
      }),
    },
    {
      cause: 'viewer drawing the volumetric smoke cloud',
      label: 'Render mode',
      warnings: buildRenderModeFidelityWarnings(
        documentWith({ 'render-mode': { value: 'smoke' } })
      ),
    },
  ];

  for (const { cause, label, warnings } of cases) {
    assert.equal(warnings.length, 1, `${cause} must raise exactly one blocker`);
    const [warning] = warnings;
    assert.ok(
      indexHtml.includes(label),
      `the advice for ${cause} names "${label}", which the page does not carry`
    );
    assert.ok(
      warning.detail.includes(label),
      `the blocker for ${cause} does not name the control that clears it; `
        + `it says: ${warning.detail}`
    );
  }
});

test('a blocker that cannot read its control says so instead of advising a toggle', () => {
  const blind = documentWith({});
  const unreadable = [
    ...buildRenderModeFidelityWarnings(blind),
    ...buildViewerBackgroundFidelityWarnings(blind),
    ...buildOverlayFidelityWarnings({
      documentRef: blind,
      connectivityVisible: false,
    }),
  ];
  assert.equal(unreadable.length, 3);
  for (const warning of unreadable) {
    assert.match(warning.detail, UNREADABLE_CONTROL);
    assert.match(warning.title, /unavailable/);
  }
});

// ---------------------------------------------------------------------------
// The raster point size is the scaled one, never a floored one
// ---------------------------------------------------------------------------

/**
 * `u_pointSize` is a scale, not a pixel count, and the rendered size is linear
 * in it. So a raster `s` times the on-screen viewport reproduces the screen
 * exactly when the point diameter is multiplied by `s` and by nothing else.
 *
 * The PNG renderer used to floor that product at one, and the hybrid-SVG
 * renderer did not, so one view exported twice disagreed with itself. The floor
 * also inflates: the viewer's default point size is 0.75 and the default export
 * is half the viewport, so a 150-DPI PNG asked for 0.586 and drew 1 — every
 * cell 1.7x too large, and 5.1x at the smallest point size the slider offers.
 *
 * The minimum that genuinely keeps a point visible is the shaders'
 * `clamp(gl_PointSize, 0.5, 128.0)`, applied to the rendered size.
 */
test('the raster point diameter is the exact scaled diameter', () => {
  // Default viewer point size, default "Screen (half)" preset, 150 DPI.
  assert.equal(
    scalePointDiameterToRaster(0.75, 0.5 * (150 / 96)),
    0.75 * 0.78125,
  );
  assert.ok(
    scalePointDiameterToRaster(0.75, 0.5 * (150 / 96)) < 1,
    'the case a one-pixel floor used to inflate must stay below one',
  );
  // Linearity is the whole contract: twice the raster, twice the diameter.
  assert.equal(
    scalePointDiameterToRaster(0.75, 2 * 0.78125),
    2 * scalePointDiameterToRaster(0.75, 0.78125),
  );
  // The smallest point the slider offers, at the same export.
  assert.equal(scalePointDiameterToRaster(0.25, 0.78125), 0.1953125);

  for (const diameter of [0, -1, NaN, Infinity, '1']) {
    assert.throws(
      () => scalePointDiameterToRaster(diameter, 1),
      /point diameter must be a finite positive number/,
    );
  }
  for (const scale of [0, -1, NaN, Infinity, '1']) {
    assert.throws(
      () => scalePointDiameterToRaster(1, scale),
      /viewport scale must be a finite positive number/,
    );
  }
});

test('both renderers resolve every raster point size through that one helper', async () => {
  // The two renderers disagreeing about point size is the defect this replaces,
  // so the check is that neither carries its own arithmetic: every point size
  // handed to the rasterizer must be a call to the shared resolver. Reading the
  // argument rather than searching for a floor is what makes this survive a
  // differently-spelled clamp.
  const root = new URL(
    '../assets/js/app/ui/modules/figure-export/renderers/',
    import.meta.url
  );
  for (const name of ['png-renderer.js', 'svg-renderer.js']) {
    const source = await readFile(new URL(name, root), 'utf8');
    const sizes = [...source.matchAll(/\bpointSizePx:\s*([^\n]*)/g)]
      .map((match) => match[1].trim());
    assert.ok(sizes.length > 0, `${name} passes no raster point size at all`);
    for (const expression of sizes) {
      assert.equal(
        expression,
        'scalePointDiameterToRaster(',
        `${name} resolves a raster point size with its own arithmetic: `
          + expression,
      );
    }
  }
});
