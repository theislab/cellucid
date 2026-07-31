/**
 * @fileoverview Vector reproduction of the viewer's reference grid box.
 *
 * WHAT THE VIEWER DRAWS
 * `drawGrid()` (`rendering/viewer.js`) rasterises six quads forming a cube of
 * half-extent `GRID_SIZE`, shading each fragment with `GRID_FS_SOURCE`
 * (`rendering/shaders/edge-grid-shaders.js`). The shader is a pure line
 * pattern: minor rules every `u_gridSpacing`, major rules every fifth, a frame
 * at the box edges, and origin-axis rules — all straight lines in world space,
 * with no fog term (`edge-grid-shaders.js` states this explicitly).
 *
 * WHY THIS IS VECTOR AND NOT A SECOND RASTER PASS
 * Straight 3D lines project to straight 2D lines, so the grid is exactly
 * representable as `<line>` elements and Canvas2D strokes. That keeps a
 * full-vector SVG fully editable — a figure whose grid arrives as an embedded
 * bitmap cannot be recoloured or removed in Illustrator — and it lets PNG and
 * SVG consume one geometry model, so the two formats can never disagree.
 *
 * HOW THE SHADER'S PER-FRAGMENT COLOUR BECOMES A STROKE
 * At a line centre the shader produces
 *
 *   effectiveOpacity eo = u_gridOpacity * u_planeAlpha
 *   gridMix             = clamp(minor*minorStrength + major*majorStrength
 *                               + frame*frameStrength, 0, 1)
 *   colour              = mix(surfaceColor, u_gridColor, gridMix)
 *                         then mix(., axisColour, axisStrength) on an origin rule
 *   alpha               = eo                         (0.55 + 0.45 * lineMask, lineMask = 1)
 *
 * and away from every rule it produces `surfaceColor` at `0.55 * eo`, which
 * differs from the background by at most 0.005 in 0..1 — under 1.3/255 — so the
 * plane surfaces are not drawn at all.
 *
 * Each rule is therefore emitted as one opaque stroke whose colour is the
 * shader's fragment colour already composited at `eo` over the background the
 * figure will actually have. Opaque strokes are what make crossings correct:
 * the shader takes `max()` across the two rule families, so a crossing must be
 * as dark as one rule, not as dark as two, which is exactly what an opaque
 * overdraw gives and exactly what stacked semi-transparent strokes would not.
 *
 * The classes have different widths (`gridLine` half-width `w/2`, `edgeLine`
 * `1.4w`, `originLine` `1.55w`, major `1.20w` overall), so a rule that belongs
 * to several classes is emitted as nested concentric bands, widest first,
 * reproducing the shader's cross-section rather than flattening it.
 *
 * KNOWN, BOUNDED DIFFERENCES FROM THE SCREEN
 * - The plane surface vignette (`±0.012..0.020` luma, further scaled by
 *   `0.55 * eo`) is not drawn: at most ~1.3/255.
 * - Where the rules of two different planes cross, the export paints the later
 *   plane's rule over the background rather than over the earlier plane's rule;
 *   those crossings are up to ~6/255 lighter than on screen.
 * - Where a frame or origin rule's outer band crosses another family's core,
 *   the export paints the last-drawn class instead of the sum of the two.
 * None of these carry a data claim; all are far below print tolerance.
 *
 * @module ui/modules/figure-export/components/reference-grid
 */

import { assertCropRect01, cropRect01ToPx } from '../utils/crop.js';
import { hexToRgb01, rgb01ToHex } from '../utils/color-utils.js';

/**
 * Line-strength curves, exactly as written in `GRID_FS_SOURCE`.
 * `isLightBg` is `step(0.55, luma(surfaceColor))`.
 */
const MINOR_BASE = 0.35;
const MINOR_LIGHT_BONUS = 0.16;
const MINOR_EXPONENT = 0.60;
const MAJOR_FACTOR = 0.58;
const MAJOR_EXPONENT = 0.50;
const FRAME_FACTOR = 0.18;
const FRAME_EXPONENT = 0.65;
const AXIS_BASE = 0.32;
const AXIS_LIGHT_BONUS = 0.03;
const AXIS_EXPONENT = 0.55;
const LIGHT_BACKGROUND_LUMA = 0.55;
const LUMA_WEIGHTS = Object.freeze([0.2126, 0.7152, 0.0722]);

/** Every fifth rule is a major rule (`majorSpacing = u_gridSpacing * 5.0`). */
const MAJOR_SPACING_MULTIPLE = 5;

/**
 * Half-widths as multiples of `u_gridLineWidth`, from the shader's three
 * coverage helpers: `gridLine` uses `lineWidth * 0.5`, `edgeLine` uses
 * `lineWidth * 1.4`, `originLine` uses `lineWidth * 1.55`, and the major rule
 * passes `mainLineWidth * 1.20` through `gridLine`.
 */
const MINOR_HALF_WIDTH = 0.5;
const MAJOR_HALF_WIDTH = 0.5 * 1.20;
const FRAME_HALF_WIDTH = 1.4;
const ORIGIN_HALF_WIDTH = 1.55;

/** Per-plane fade, from `drawGrid()`'s `smoothstep(fadeStart, fadeEnd, dot)`. */
const PLANE_FADE_START = -0.2;
const PLANE_FADE_END = 0.05;
const PLANE_MIN_ALPHA = 0.01;

/** Axis order used by `renderState` matrices and by the plane table. */
const AXIS_KEYS = Object.freeze(['x', 'y', 'z']);

/**
 * The six grid planes, in `gridPlaneDescriptors` order so overdraw matches the
 * viewer's draw order. `fixedAxis` is the axis the quad is perpendicular to;
 * `axisA`/`axisB` are the two axes its rules run along.
 */
const GRID_PLANES = Object.freeze([
  Object.freeze({ key: 'bottom', fixedAxis: 1, fixedSign: -1, axisA: 0, axisB: 2 }),
  Object.freeze({ key: 'top', fixedAxis: 1, fixedSign: 1, axisA: 0, axisB: 2 }),
  Object.freeze({ key: 'back', fixedAxis: 2, fixedSign: -1, axisA: 0, axisB: 1 }),
  Object.freeze({ key: 'front', fixedAxis: 2, fixedSign: 1, axisA: 0, axisB: 1 }),
  Object.freeze({ key: 'left', fixedAxis: 0, fixedSign: -1, axisA: 1, axisB: 2 }),
  Object.freeze({ key: 'right', fixedAxis: 0, fixedSign: 1, axisA: 1, axisB: 2 }),
]);

/** Draw rank inside one plane: stronger rules land on top of weaker ones. */
const RULE_RANK_MINOR = 0;
const RULE_RANK_MAJOR = 1;
const RULE_RANK_FRAME = 2;
const RULE_RANK_ORIGIN = 3;

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mixRgb(from, to, amount) {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

function assertRgb01(value, context) {
  if (
    (!Array.isArray(value) && !(value instanceof Float32Array)) ||
    value.length !== 3 ||
    Array.from(value).some(
      (entry) => !Number.isFinite(entry) || entry < 0 || entry > 1
    )
  ) {
    throw new TypeError(`${context} must contain exactly three 0..1 numbers.`);
  }
  return [value[0], value[1], value[2]];
}

/**
 * Project a model-space point with a column-major MVP matrix.
 *
 * @param {Float32Array} mvp
 * @param {number[]} p
 * @returns {{ x: number; y: number; z: number; w: number }}
 */
function toClipSpace(mvp, p) {
  const [x, y, z] = p;
  return {
    x: mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12],
    y: mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13],
    z: mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14],
    w: mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15],
  };
}

/**
 * The sub-range of a segment that survives the near and far clip planes.
 * Clip coordinates are linear in the model-space parameter, so clipping in `t`
 * is exact rather than an approximation.
 *
 * @returns {[number, number]|null}
 */
function clipSegmentDepthRange(c0, c1) {
  let tMin = 0;
  let tMax = 1;
  const distances = [
    [c0.z + c0.w, c1.z + c1.w],
    [c0.w - c0.z, c1.w - c1.z],
  ];
  for (const [d0, d1] of distances) {
    if (d0 < 0 && d1 < 0) return null;
    if (d0 === d1) continue;
    const t = d0 / (d0 - d1);
    if (d0 < 0) {
      if (t > tMin) tMin = t;
    } else if (d1 < 0) {
      if (t < tMax) tMax = t;
    }
  }
  if (!(tMax > tMin)) return null;
  return [tMin, tMax];
}

function lerpPoint(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Every distinct rule coordinate on one plane axis, with its class flags.
 *
 * @param {number} size
 * @param {number} spacing
 * @returns {{ coordinate: number; minor: boolean; major: boolean; frame: boolean; origin: boolean; rank: number }[]}
 */
function enumerateRuleCoordinates(size, spacing) {
  const steps = Math.round(size / spacing);
  if (steps < 1 || Math.abs(steps * spacing - size) > 1e-6) {
    throw new RangeError(
      'Reference grid spacing must divide the grid half-extent exactly.'
    );
  }
  const rules = [];
  for (let k = -steps; k <= steps; k++) {
    const origin = k === 0;
    const frame = Math.abs(k) === steps;
    const major = k % MAJOR_SPACING_MULTIPLE === 0;
    let rank = RULE_RANK_MINOR;
    if (origin) rank = RULE_RANK_ORIGIN;
    else if (frame) rank = RULE_RANK_FRAME;
    else if (major) rank = RULE_RANK_MAJOR;
    rules.push({
      coordinate: k * spacing,
      minor: true,
      major,
      frame,
      origin,
      rank,
    });
  }
  return rules;
}

/**
 * The concentric colour bands of one rule, widest first.
 *
 * @returns {{ halfWidthWorld: number; color: string }[]}
 */
function buildRuleBands({
  rule,
  strengths,
  lineWidth,
  lineColor,
  axisColor,
  surfaceRgb,
  effectiveOpacity,
}) {
  /** @type {{ half: number; strength: number; axis: boolean }[]} */
  const classes = [
    { half: MINOR_HALF_WIDTH, strength: strengths.minor, axis: false },
  ];
  if (rule.major) {
    classes.push({ half: MAJOR_HALF_WIDTH, strength: strengths.major, axis: false });
  }
  if (rule.frame) {
    classes.push({ half: FRAME_HALF_WIDTH, strength: strengths.frame, axis: false });
  }
  if (rule.origin) {
    classes.push({ half: ORIGIN_HALF_WIDTH, strength: strengths.axis, axis: true });
  }

  const halves = [...new Set(classes.map((entry) => entry.half))]
    .sort((a, b) => b - a);

  const bands = [];
  for (const half of halves) {
    let gridMix = 0;
    let axisMix = 0;
    for (const entry of classes) {
      if (entry.half < half) continue;
      if (entry.axis) axisMix = entry.strength;
      else gridMix += entry.strength;
    }
    gridMix = Math.min(1, gridMix);
    if (gridMix <= 0 && axisMix <= 0) continue;
    let rgb = mixRgb(surfaceRgb, lineColor, gridMix);
    if (axisMix > 0) rgb = mixRgb(rgb, axisColor, axisMix);
    // The shader's fragment alpha at a rule centre is exactly `eo`; folding it
    // into the stroke colour keeps overdraw at crossings single-composited.
    const composited = mixRgb(surfaceRgb, rgb, effectiveOpacity);
    bands.push({
      halfWidthWorld: half * lineWidth,
      color: rgb01ToHex(composited),
    });
  }
  return bands;
}

/**
 * The colour the grid rules composite over.
 *
 * A transparent figure has no paper for the grid to sit on, so its rules are
 * composited over the viewer's own background — they then look exactly as they
 * do on screen, and everything between them stays transparent.
 *
 * @param {object} options
 * @param {object|null} options.appearance
 * @param {string} options.background
 * @param {string} options.backgroundColor - exact #RRGGBB
 * @returns {number[]|null}
 */
export function resolveReferenceGridSurfaceRgb({
  appearance,
  background,
  backgroundColor,
}) {
  if (appearance === null || appearance === undefined) return null;
  if (background === 'transparent') {
    return [
      appearance.surfaceColor[0],
      appearance.surfaceColor[1],
      appearance.surfaceColor[2],
    ];
  }
  const rgb = hexToRgb01(backgroundColor);
  if (rgb === null) {
    throw new TypeError(
      'Reference grid export requires an exact #RRGGBB figure background.'
    );
  }
  return rgb;
}

/**
 * Build the plot-space line model of the viewer's reference grid.
 *
 * @param {object} options
 * @param {object|null} options.appearance - from `utils/viewer-background.js`
 * @param {{ mvpMatrix: Float32Array; viewMatrix: Float32Array; viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {object|null} [options.crop]
 * @param {number[]|Float32Array} options.surfaceRgb - what the grid composites over, 0..1
 * @returns {{ segments: { x1: number; y1: number; x2: number; y2: number; widthPx: number; color: string }[] }|null}
 */
export function buildReferenceGridModel({
  appearance,
  renderState,
  plotRect,
  crop = null,
  surfaceRgb,
}) {
  if (appearance === null || appearance === undefined) return null;
  if (
    !(renderState?.mvpMatrix instanceof Float32Array) ||
    renderState.mvpMatrix.length !== 16 ||
    !(renderState.viewMatrix instanceof Float32Array) ||
    renderState.viewMatrix.length !== 16
  ) {
    throw new TypeError(
      'Reference grid export requires exact 16-value MVP and view matrices.'
    );
  }
  if (
    !Number.isFinite(plotRect?.width) ||
    plotRect.width <= 0 ||
    !Number.isFinite(plotRect?.height) ||
    plotRect.height <= 0
  ) {
    throw new TypeError('Reference grid export requires a positive plot rectangle.');
  }

  const surface = assertRgb01(surfaceRgb, 'Reference grid surface colour');
  const lineColor = assertRgb01(appearance.lineColor, 'Reference grid line colour');
  const axisColors = {
    x: assertRgb01(appearance.axisColors.x, 'Reference grid X-axis colour'),
    y: assertRgb01(appearance.axisColors.y, 'Reference grid Y-axis colour'),
    z: assertRgb01(appearance.axisColors.z, 'Reference grid Z-axis colour'),
  };

  // `isLightBg` is decided by the surface the shader mixes against, which is
  // the viewer's own background — never the figure's chosen paper colour.
  const shaderSurface = assertRgb01(
    appearance.surfaceColor,
    'Reference grid viewer surface colour'
  );
  const bgLuma =
    shaderSurface[0] * LUMA_WEIGHTS[0] +
    shaderSurface[1] * LUMA_WEIGHTS[1] +
    shaderSurface[2] * LUMA_WEIGHTS[2];
  const isLightBg = bgLuma >= LIGHT_BACKGROUND_LUMA ? 1 : 0;

  const size = appearance.size;
  const spacing = appearance.spacing;
  const lineWidth = appearance.lineWidth;
  const gridOpacity = appearance.opacity;

  const mvp = renderState.mvpMatrix;
  const view = renderState.viewMatrix;
  const viewportW = Math.max(1, renderState.viewportWidth || 1);
  const viewportH = Math.max(1, renderState.viewportHeight || 1);

  const crop01 = assertCropRect01(crop);
  const cropPx = cropRect01ToPx(crop01, viewportW, viewportH);
  const hasCrop = Boolean(
    cropPx &&
    (
      cropPx.width < viewportW - 0.5 ||
      cropPx.height < viewportH - 0.5 ||
      cropPx.x > 0.5 ||
      cropPx.y > 0.5
    )
  );
  const srcX0 = hasCrop && cropPx ? cropPx.x : 0;
  const srcY0 = hasCrop && cropPx ? cropPx.y : 0;
  const srcW = hasCrop && cropPx ? cropPx.width : viewportW;
  const srcH = hasCrop && cropPx ? cropPx.height : viewportH;
  const scale = Math.min(plotRect.width / srcW, plotRect.height / srcH);
  const offsetX = plotRect.x + (plotRect.width - srcW * scale) / 2;
  const offsetY = plotRect.y + (plotRect.height - srcH * scale) / 2;

  const toPlot = (clip) => {
    if (!(clip.w > 1e-9)) return null;
    const ndcX = clip.x / clip.w;
    const ndcY = clip.y / clip.w;
    const vx = (ndcX * 0.5 + 0.5) * viewportW;
    const vy = (-ndcY * 0.5 + 0.5) * viewportH;
    return {
      x: offsetX + (vx - srcX0) * scale,
      y: offsetY + (vy - srcY0) * scale,
    };
  };

  // The view matrix's third row is the camera's backward axis in world space;
  // `drawGrid()` negates it to get the direction the camera looks along.
  const viewDir = [-view[2], -view[6], -view[10]];

  const rules = enumerateRuleCoordinates(size, spacing);
  const segments = [];

  // Cull to the plot rectangle so a zoomed-in figure carries no off-canvas
  // geometry. The renderers clip too; this keeps the file small.
  const cullPad = Math.max(plotRect.width, plotRect.height);
  const cullMinX = plotRect.x - cullPad;
  const cullMaxX = plotRect.x + plotRect.width + cullPad;
  const cullMinY = plotRect.y - cullPad;
  const cullMaxY = plotRect.y + plotRect.height + cullPad;

  for (const plane of GRID_PLANES) {
    const normal = [0, 0, 0];
    normal[plane.fixedAxis] = plane.fixedSign;
    const facing =
      viewDir[0] * normal[0] + viewDir[1] * normal[1] + viewDir[2] * normal[2];
    const planeAlpha = smoothstep(PLANE_FADE_START, PLANE_FADE_END, facing);
    if (planeAlpha < PLANE_MIN_ALPHA) continue;

    const effectiveOpacity = gridOpacity * planeAlpha;
    const strengths = {
      minor:
        (MINOR_BASE + MINOR_LIGHT_BONUS * isLightBg) *
        effectiveOpacity ** MINOR_EXPONENT,
      major: MAJOR_FACTOR * effectiveOpacity ** MAJOR_EXPONENT,
      frame: FRAME_FACTOR * effectiveOpacity ** FRAME_EXPONENT,
      axis:
        (AXIS_BASE + AXIS_LIGHT_BONUS * isLightBg) *
        effectiveOpacity ** AXIS_EXPONENT,
    };

    /** Both rule families of this plane, ordered weakest class first. */
    const planeRules = [];
    for (const [constantAxis, runningAxis] of [
      [plane.axisA, plane.axisB],
      [plane.axisB, plane.axisA],
    ]) {
      for (const rule of rules) {
        planeRules.push({ rule, constantAxis, runningAxis });
      }
    }
    planeRules.sort((a, b) => a.rule.rank - b.rule.rank);

    for (const { rule, constantAxis, runningAxis } of planeRules) {
      const start = [0, 0, 0];
      const end = [0, 0, 0];
      start[plane.fixedAxis] = plane.fixedSign * size;
      end[plane.fixedAxis] = plane.fixedSign * size;
      start[constantAxis] = rule.coordinate;
      end[constantAxis] = rule.coordinate;
      start[runningAxis] = -size;
      end[runningAxis] = size;

      const clipStart = toClipSpace(mvp, start);
      const clipEnd = toClipSpace(mvp, end);
      const range = clipSegmentDepthRange(clipStart, clipEnd);
      if (range === null) continue;

      const [tMin, tMax] = range;
      const nearPoint = lerpPoint(start, end, tMin);
      const farPoint = lerpPoint(start, end, tMax);
      const a = toPlot(toClipSpace(mvp, nearPoint));
      const b = toPlot(toClipSpace(mvp, farPoint));
      if (a === null || b === null) continue;
      if (
        (a.x < cullMinX && b.x < cullMinX) ||
        (a.x > cullMaxX && b.x > cullMaxX) ||
        (a.y < cullMinY && b.y < cullMinY) ||
        (a.y > cullMaxY && b.y > cullMaxY)
      ) {
        continue;
      }

      // Rule widths are world-space, so they are measured on screen by
      // projecting the rule's own cross-section at its visible midpoint.
      const mid = lerpPoint(nearPoint, farPoint, 0.5);
      const axisColor = axisColors[AXIS_KEYS[runningAxis]];
      const bands = buildRuleBands({
        rule,
        strengths,
        lineWidth,
        lineColor,
        axisColor,
        surfaceRgb: surface,
        effectiveOpacity,
      });

      for (const band of bands) {
        const probeLow = [...mid];
        const probeHigh = [...mid];
        probeLow[constantAxis] -= band.halfWidthWorld;
        probeHigh[constantAxis] += band.halfWidthWorld;
        const low = toPlot(toClipSpace(mvp, probeLow));
        const high = toPlot(toClipSpace(mvp, probeHigh));
        if (low === null || high === null) continue;
        const widthPx = Math.hypot(high.x - low.x, high.y - low.y);
        if (!Number.isFinite(widthPx) || widthPx <= 0) continue;
        segments.push({
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          widthPx,
          color: band.color,
        });
      }
    }
  }

  if (segments.length === 0) return null;
  return { segments };
}

/**
 * @param {{ segments: { x1: number; y1: number; x2: number; y2: number; widthPx: number; color: string }[] }|null} model
 * @returns {string}
 */
export function renderSvgReferenceGrid(model) {
  if (model === null) return '';
  const parts = ['<g class="cellucid-reference-grid" fill="none" stroke-linecap="butt">'];
  for (const segment of model.segments) {
    parts.push(
      `<line x1="${segment.x1.toFixed(2)}" y1="${segment.y1.toFixed(2)}" ` +
      `x2="${segment.x2.toFixed(2)}" y2="${segment.y2.toFixed(2)}" ` +
      `stroke="${segment.color}" stroke-width="${segment.widthPx.toFixed(3)}"/>`
    );
  }
  parts.push('</g>');
  return parts.join('');
}

/**
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {{ segments: { x1: number; y1: number; x2: number; y2: number; widthPx: number; color: string }[] }|null} options.model
 */
export function drawCanvasReferenceGrid({ ctx, model }) {
  if (model === null) return;
  ctx.save();
  ctx.lineCap = 'butt';
  for (const segment of model.segments) {
    ctx.beginPath();
    ctx.moveTo(segment.x1, segment.y1);
    ctx.lineTo(segment.x2, segment.y2);
    ctx.strokeStyle = segment.color;
    ctx.lineWidth = segment.widthPx;
    ctx.stroke();
  }
  ctx.restore();
}
