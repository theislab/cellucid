/**
 * @fileoverview Vector reproduction of the viewer's studio backdrop.
 *
 * WHAT THE VIEWER DRAWS
 * `drawStudioBackdrop()` (`rendering/viewer.js`) runs one procedural pass per
 * pane (`rendering/shaders/studio-shaders.js`): for a 3-D pane, a floor of
 * hairlines seen from above; for a flat or planar pane, a dot surface behind
 * the data; over a
 * surface colour with a soft glow and, on the
 * floor, a soft pool of ink under the data. Every constant and every
 * weighting function lives in `rendering/studio-backdrop.js`, and this file
 * evaluates those same functions, so the figure and the screen are computed
 * from one definition.
 *
 * HOW EACH PART BECOMES A VECTOR
 * - Hairlines are straight lines on a plane, so each one is a `<line>`. The
 *   shader's strength varies along a rule — the floor fades with distance
 *   from the stage, with the grazing angle, and with the lattice family's
 *   on-screen spacing — so each rule is stroked with a linear gradient
 *   sampled at `LINE_STOPS` points along it, in screen space.
 * - Dots are round on screen whatever the plane's slant, so each is a circle.
 * - The glow and the pool are each the affine image of a circle in pane
 *   space (`resolveStudioPool`), which is exactly what an SVG radial
 *   gradient with a `gradientTransform` — and a Canvas radial gradient under
 *   a transform — draws. The glow lightens the viewer's own surface, so it
 *   is drawn only on that paper; the pool is ink at a varying opacity, so it
 *   is exact over any paper, including none.
 * Marks are composited onto the colour beneath them — surface, glow, pool — and
 * drawn opaque, so a crossing is as dark as one rule, exactly as the shader's
 * `max()` makes it, never as dark as two.
 *
 * WHICH MARKS EXIST
 * The shader evaluates, at each pixel, the three lattice families around the
 * pixel's footprint. Here the same footprint is measured at a grid of screen
 * samples; each family is enumerated over the part of the plane where it can
 * be visible, and every mark is weighed at its own position by the shader's
 * rule. Marks the shader would draw below half a code value are omitted.
 *
 * KNOWN, BOUNDED DIFFERENCES FROM THE SCREEN
 * - A rule's strength between two gradient stops is interpolated linearly;
 *   with 24 stops the error is far below one code value.
 * - A rule's width is the width the shader gives it where it is strongest;
 *   the shader widens a rule by at most a quarter pixel as it turns major.
 * - The screen's sub-code-value dither is not reproduced.
 * - The surface crossfade after a dimension or navigation change, and the
 *   fade after a background change, last 0.3 s; an export reproduces the
 *   settled frame.
 * None of these carries a data claim.
 *
 * @module ui/modules/figure-export/components/studio-backdrop-export
 */

import {
  STUDIO_LATTICE,
  STUDIO_MARKS,
  STUDIO_STAGE,
  STUDIO_SURFACES,
  resolveStudioBackdropPlane,
  resolveStudioPool,
  resolveStudioSurfaceWeights,
  studioClearanceFade,
  studioColor01,
  studioFamilyLevel,
  studioFamilySpacing,
  studioMarkStrength,
  studioFalloff,
  studioGrazingFade,
  studioStageFade,
} from '../../../../../rendering/studio-backdrop.js';
import { rgb01ToHex } from '../utils/color-utils.js';
import {
  clipSegmentDepthRange,
  createPlotProjection,
  lerpPoint,
  toClipSpace,
} from '../utils/plot-projection.js';

/** Screen samples used to find where each lattice family can be visible. */
const SCREEN_SAMPLES_X = 64;
const SCREEN_SAMPLES_Y = 40;
/** Gradient stops along one rule. */
const LINE_STOPS = 24;
/** Stops of the glow's and the pool's radial gradients. */
const TONE_STOPS = 12;
/** Marks fainter than half a code value are not drawn. */
const INVISIBLE_CONTRAST = 0.5 / 255;

const LOG_RATIO = Math.log(STUDIO_LATTICE.ratio);

function mixRgb(from, to, amount) {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

/** Inverse of a column-major 4x4 matrix, or null when it is singular. */
function invertMatrix4(m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || det === 0) return null;
  const inv = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * inv,
    (a02 * b10 - a01 * b11 - a03 * b09) * inv,
    (a31 * b05 - a32 * b04 + a33 * b03) * inv,
    (a22 * b04 - a21 * b05 - a23 * b03) * inv,
    (a12 * b08 - a10 * b11 - a13 * b07) * inv,
    (a00 * b11 - a02 * b08 + a03 * b07) * inv,
    (a32 * b02 - a30 * b05 - a33 * b01) * inv,
    (a20 * b05 - a22 * b02 + a23 * b01) * inv,
    (a10 * b10 - a11 * b08 + a13 * b06) * inv,
    (a01 * b08 - a00 * b10 - a03 * b06) * inv,
    (a30 * b04 - a31 * b02 + a33 * b00) * inv,
    (a21 * b02 - a20 * b04 - a23 * b00) * inv,
    (a11 * b07 - a10 * b09 - a12 * b06) * inv,
    (a00 * b09 - a01 * b07 + a02 * b06) * inv,
    (a31 * b01 - a30 * b03 - a32 * b00) * inv,
    (a20 * b03 - a21 * b01 + a22 * b00) * inv,
  ];
}

/** How many times `ratio` divides the lattice index `m` (capped). */
function divisibilityDepth(m) {
  if (m === 0) return Infinity;
  let depth = 0;
  let value = Math.abs(m);
  while (value % STUDIO_LATTICE.ratio === 0 && depth < 64) {
    value /= STUDIO_LATTICE.ratio;
    depth += 1;
  }
  return depth;
}


/**
 * Build the plot-space model of one pane's studio backdrop.
 *
 * @param {object} options
 * @param {object} options.appearance - a `kind: 'studio'` appearance from
 *   `utils/viewer-background.js`
 * @param {object} options.renderState - the pane's export render state; its
 *   `backdrop` is the geometry the viewer drew the pane with
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {object|null} [options.crop]
 * @param {{ rgb: number[]; viewerPaper: boolean }} options.surface
 * @returns {object|null}
 */
export function buildStudioBackdropModel({
  appearance,
  renderState,
  plotRect,
  crop = null,
  surface,
}) {
  const backdrop = renderState?.backdrop;
  if (
    !(renderState?.mvpMatrix instanceof Float32Array) ||
    renderState.mvpMatrix.length !== 16 ||
    !(renderState.viewMatrix instanceof Float32Array) ||
    renderState.viewMatrix.length !== 16 ||
    !Array.isArray(renderState.cameraPosition) ||
    backdrop === null ||
    typeof backdrop !== 'object'
  ) {
    throw new TypeError(
      'Studio backdrop export requires exact matrices, the camera position, and the pane backdrop.'
    );
  }
  if (
    !Number.isFinite(plotRect?.width) ||
    plotRect.width <= 0 ||
    !Number.isFinite(plotRect?.height) ||
    plotRect.height <= 0
  ) {
    throw new TypeError('Studio backdrop export requires a positive plot rectangle.');
  }
  if (
    !Array.isArray(surface?.rgb) ||
    surface.rgb.length !== 3 ||
    typeof surface.viewerPaper !== 'boolean'
  ) {
    throw new TypeError('Studio backdrop export requires the resolved figure surface.');
  }

  const palette = appearance.palette;
  const ink = studioColor01(palette.ink);
  const glowColor = studioColor01(palette.glow);
  const surfaceRgb = surface.rgb;
  const mvp = renderState.mvpMatrix;
  const eye = renderState.cameraPosition;
  const pixelRatio = backdrop.pixelRatio;
  const projection = createPlotProjection({ renderState, plotRect, crop });
  const { viewportW, viewportH, srcX0, srcY0, srcW, srcH, scale } = projection;
  const inverseMvp = invertMatrix4(mvp);
  if (inverseMvp === null) return null;

  const glowCenterX = backdrop.glowCenterX;
  const glowRadiusX = Math.max(1 - glowCenterX, 1e-3);
  const drawGlow = surface.viewerPaper;
  const weights = resolveStudioSurfaceWeights(backdrop.planarity, {});
  const floorWeight = weights.floor;
  const pool = resolveStudioPool(mvp, eye, backdrop, {});
  const poolStrength = pool.gate * palette.poolAlpha * floorWeight;
  const poolDeterminant = pool.axisAX * pool.axisBY - pool.axisBX * pool.axisAY;

  /** The colour beneath a mark at viewport pixel (vx, vy). */
  const baseAt = (vx, vy) => {
    const ndcX = vx / viewportW * 2 - 1;
    const ndcY = 1 - vy / viewportH * 2;
    let base = surfaceRgb;
    if (drawGlow) {
      const radius = Math.hypot((ndcX - glowCenterX) / glowRadiusX, ndcY);
      base = mixRgb(base, glowColor, studioFalloff(radius));
    }
    if (poolStrength > 0) {
      const dx = ndcX - pool.centerX;
      const dy = ndcY - pool.centerY;
      const u = (pool.axisBY * dx - pool.axisBX * dy) / poolDeterminant;
      const v = (-pool.axisAY * dx + pool.axisAX * dy) / poolDeterminant;
      base = mixRgb(base, ink, studioFalloff(Math.hypot(u, v)) * poolStrength);
    }
    return base;
  };
  const contrastAt = (base) => Math.max(
    Math.abs(ink[0] - base[0]),
    Math.abs(ink[1] - base[1]),
    Math.abs(ink[2] - base[2])
  );

  // Each plane: unit normal, offset (normal . p = offset), and orthonormal
  // lattice axes u and v, exactly as the shader receives them.
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const planes = [];
  if (floorWeight > 0) {
    planes.push({
      normal: [0, 1, 0],
      offset: backdrop.floorY,
      u: [1, 0, 0],
      v: [0, 0, 1],
      weight: floorWeight,
      lineMix: 1,
      dotMix: 0,
      surface: STUDIO_SURFACES.floor,
      floor: true,
    });
  }
  if (weights.backdrop > 0) {
    const back = resolveStudioBackdropPlane(renderState.viewMatrix, backdrop, {});
    planes.push({
      normal: [back.normalX, back.normalY, back.normalZ],
      offset: back.offset,
      u: [back.uX, back.uY, back.uZ],
      v: [back.vX, back.vY, back.vZ],
      weight: weights.backdrop,
      lineMix: 0,
      dotMix: 1,
      surface: STUDIO_SURFACES.backdrop,
      floor: false,
    });
  }

  const pointOn = (plane, u, v) => [
    plane.normal[0] * plane.offset + plane.u[0] * u + plane.v[0] * v,
    plane.normal[1] * plane.offset + plane.u[1] * u + plane.v[1] * v,
    plane.normal[2] * plane.offset + plane.u[2] * u + plane.v[2] * v,
  ];

  /** The shader's fade for a point on a plane (`fade` in STUDIO_FS_SOURCE). */
  const fadeAt = (plane, point) => {
    const dx = point[0] - eye[0];
    const dy = point[1] - eye[1];
    const dz = point[2] - eye[2];
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 0)) return 0;
    if (plane.floor) {
      return plane.weight
        * studioStageFade(Math.hypot(point[0] - backdrop.stageX, point[2] - backdrop.stageZ))
        * studioGrazingFade(-dy / length)
        * studioClearanceFade(eye[1] - plane.offset);
    }
    const gap = plane.offset - dot3(plane.normal, eye);
    const rate = dot3(plane.normal, [dx, dy, dz]);
    if (gap * rate < 0) return 0;
    return plane.weight
      * studioGrazingFade(Math.abs(rate) / length)
      * studioClearanceFade(Math.abs(gap));
  };

  /**
   * World units per viewport pixel across each lattice axis at a point: the
   * shader's `axisFootprint`, from the inverse of the screen Jacobian.
   */
  const footprintAt = (plane, point) => {
    const epsilon = 1e-4 * Math.max(
      1,
      Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2])
    );
    const origin = projection.clipToViewport(toClipSpace(mvp, point));
    const alongU = point.map((value, axis) => value + plane.u[axis] * epsilon);
    const alongV = point.map((value, axis) => value + plane.v[axis] * epsilon);
    const screenU = projection.clipToViewport(toClipSpace(mvp, alongU));
    const screenV = projection.clipToViewport(toClipSpace(mvp, alongV));
    if (origin === null || screenU === null || screenV === null) return null;
    const ax = (screenU.x - origin.x) / epsilon;
    const ay = (screenU.y - origin.y) / epsilon;
    const bx = (screenV.x - origin.x) / epsilon;
    const by = (screenV.y - origin.y) / epsilon;
    const det = Math.abs(ax * by - bx * ay);
    if (!(det > 0)) return null;
    const footprint = Math.max(Math.hypot(bx, by) / det, Math.hypot(ax, ay) / det);
    return {
      screen: origin,
      footprint,
      level: studioFamilyLevel(plane.surface, footprint, pixelRatio),
    };
  };

  const segments = [];
  const dots = [];

  for (const plane of planes) {
    // Where the plane is visible on screen, and how fine a lattice it shows.
    const samples = [];
    for (let iy = 0; iy <= SCREEN_SAMPLES_Y; iy++) {
      for (let ix = 0; ix <= SCREEN_SAMPLES_X; ix++) {
        const vx = srcX0 + srcW * ix / SCREEN_SAMPLES_X;
        const vy = srcY0 + srcH * iy / SCREEN_SAMPLES_Y;
        const ndcX = vx / viewportW * 2 - 1;
        const ndcY = 1 - vy / viewportH * 2;
        const far = [
          inverseMvp[0] * ndcX + inverseMvp[4] * ndcY + inverseMvp[8] + inverseMvp[12],
          inverseMvp[1] * ndcX + inverseMvp[5] * ndcY + inverseMvp[9] + inverseMvp[13],
          inverseMvp[2] * ndcX + inverseMvp[6] * ndcY + inverseMvp[10] + inverseMvp[14],
          inverseMvp[3] * ndcX + inverseMvp[7] * ndcY + inverseMvp[11] + inverseMvp[15],
        ];
        if (!(Math.abs(far[3]) > 0)) continue;
        const ray = [
          far[0] / far[3] - eye[0],
          far[1] / far[3] - eye[1],
          far[2] / far[3] - eye[2],
        ];
        const rate = dot3(plane.normal, ray);
        if (Math.abs(rate) < 1e-12) continue;
        const t = (plane.offset - dot3(plane.normal, eye)) / rate;
        if (!(t > 0)) continue;
        const point = [eye[0] + ray[0] * t, eye[1] + ray[1] * t, eye[2] + ray[2] * t];
        if (fadeAt(plane, point) <= 0) continue;
        const measured = footprintAt(plane, point);
        if (measured === null) continue;
        samples.push({
          u: dot3(point, plane.u),
          v: dot3(point, plane.v),
          footprint: measured.footprint,
          // The finest family that has started to fade in here.
          visibleFrom: Math.ceil(
            Math.log(
              STUDIO_LATTICE.fadeInFraction * plane.surface.minCellCssPx
              * pixelRatio * measured.footprint / STUDIO_LATTICE.base
            ) / LOG_RATIO - 1e-9
          ),
        });
      }
    }
    if (samples.length === 0) continue;

    let finest = Infinity;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const sample of samples) {
      finest = Math.min(finest, sample.visibleFrom);
      uMin = Math.min(uMin, sample.u); uMax = Math.max(uMax, sample.u);
      vMin = Math.min(vMin, sample.v); vMax = Math.max(vMax, sample.v);
    }
    // The coarsest family worth enumerating holds at most a mark or two in
    // the visible region (or on the stage); it also carries every coarser one.
    const extent = plane.floor
      ? 2 * STUDIO_STAGE.outerRadius
      : Math.max(uMax - uMin, vMax - vMin);
    const coarsest = Math.max(
      finest,
      Math.ceil(Math.log(Math.max(extent, STUDIO_LATTICE.base) / STUDIO_LATTICE.base) / LOG_RATIO) + 1
    );
    const sampleStepPx = Math.max(srcW / SCREEN_SAMPLES_X, srcH / SCREEN_SAMPLES_Y);

    for (let level = finest; level <= coarsest; level++) {
      const spacing = studioFamilySpacing(level);
      // The region where this family can be visible, padded by one sample.
      let bMinU = Infinity, bMaxU = -Infinity, bMinV = Infinity, bMaxV = -Infinity;
      let pad = 0;
      for (const sample of samples) {
        if (sample.visibleFrom > level) continue;
        bMinU = Math.min(bMinU, sample.u); bMaxU = Math.max(bMaxU, sample.u);
        bMinV = Math.min(bMinV, sample.v); bMaxV = Math.max(bMaxV, sample.v);
        pad = Math.max(pad, 1.5 * sampleStepPx * sample.footprint);
      }
      if (!(bMaxU >= bMinU)) continue;
      bMinU -= pad; bMaxU += pad; bMinV -= pad; bMaxV += pad;
      if (plane.floor) {
        bMinU = Math.max(bMinU, backdrop.stageX - STUDIO_STAGE.outerRadius);
        bMaxU = Math.min(bMaxU, backdrop.stageX + STUDIO_STAGE.outerRadius);
        bMinV = Math.max(bMinV, backdrop.stageZ - STUDIO_STAGE.outerRadius);
        bMaxV = Math.min(bMaxV, backdrop.stageZ + STUDIO_STAGE.outerRadius);
      }
      const mMin = Math.ceil(bMinU / spacing), mMax = Math.floor(bMaxU / spacing);
      const nMin = Math.ceil(bMinV / spacing), nMax = Math.floor(bMaxV / spacing);
      if (mMax < mMin || nMax < nMin) continue;
      const allMarks = level === coarsest;
      const ownsIndex = (index) => allMarks || index % STUDIO_LATTICE.ratio !== 0;

      if (plane.lineMix > 0) {
        for (const [constantIsU, indexMin, indexMax, runMin, runMax] of [
          [true, mMin, mMax, bMinV, bMaxV],
          [false, nMin, nMax, bMinU, bMaxU],
        ]) {
          for (let index = indexMin; index <= indexMax; index++) {
            if (!ownsIndex(index)) continue;
            const coordinate = index * spacing;
            const coarsestLevel = level + divisibilityDepth(index);
            emitRule(plane, constantIsU, coordinate, coarsestLevel, runMin, runMax);
          }
        }
      }

      if (plane.dotMix > 0) {
        // Candidates are the lattice positions near a screen sample where
        // this family shows: each such sample contributes the box of
        // positions within one-and-a-half sample steps of it. Where the
        // family shows, its spacing is at least `fadeInFraction *
        // minCellCssPx` device pixels, so a box holds a bounded handful of
        // positions however obliquely the plane is seen; positions far from
        // every such sample fade to nothing. The family's whole rectangle is
        // enumerated instead when it holds no more positions than the boxes
        // (the usual, square-on case), so the work never exceeds either.
        const boxes = [];
        let boxPositions = 0;
        for (const sample of samples) {
          if (sample.visibleFrom > level) continue;
          const reach = 1.5 * sampleStepPx * sample.footprint;
          const m0 = Math.max(mMin, Math.ceil((sample.u - reach) / spacing));
          const m1 = Math.min(mMax, Math.floor((sample.u + reach) / spacing));
          const n0 = Math.max(nMin, Math.ceil((sample.v - reach) / spacing));
          const n1 = Math.min(nMax, Math.floor((sample.v + reach) / spacing));
          if (m1 < m0 || n1 < n0) continue;
          boxes.push(m0, m1, n0, n1);
          boxPositions += (m1 - m0 + 1) * (n1 - n0 + 1);
        }
        const emitRow = (m, columns) => {
          const depthM = divisibilityDepth(m);
          for (const n of columns) {
            if (!allMarks && depthM > 0 && n % STUDIO_LATTICE.ratio === 0) continue;
            emitDot(plane, m * spacing, n * spacing, level + Math.min(depthM, divisibilityDepth(n)));
          }
        };
        if ((mMax - mMin + 1) * (nMax - nMin + 1) <= boxPositions) {
          const columns = [];
          for (let n = nMin; n <= nMax; n++) columns.push(n);
          for (let m = mMin; m <= mMax; m++) emitRow(m, columns);
        } else {
          // The union of the boxes, in lattice order, each position once.
          const rows = new Map();
          for (let box = 0; box < boxes.length; box += 4) {
            for (let m = boxes[box]; m <= boxes[box + 1]; m++) {
              let row = rows.get(m);
              if (row === undefined) {
                row = new Set();
                rows.set(m, row);
              }
              for (let n = boxes[box + 2]; n <= boxes[box + 3]; n++) row.add(n);
            }
          }
          const ascending = (a, b) => a - b;
          for (const m of [...rows.keys()].sort(ascending)) {
            emitRow(m, [...rows.get(m)].sort(ascending));
          }
        }
      }
    }
  }

  // Rules exist only on the floor, whose u is x and v is z.
  function emitRule(plane, constantIsU, coordinate, coarsestLevel, runMin, runMax) {
    let from = runMin;
    let to = runMax;
    if (plane.floor) {
      const stageConstant = constantIsU ? backdrop.stageX : backdrop.stageZ;
      const stageRun = constantIsU ? backdrop.stageZ : backdrop.stageX;
      const halfChord2 = STUDIO_STAGE.outerRadius ** 2 - (coordinate - stageConstant) ** 2;
      if (!(halfChord2 > 0)) return;
      const halfChord = Math.sqrt(halfChord2);
      from = Math.max(from, stageRun - halfChord);
      to = Math.min(to, stageRun + halfChord);
    }
    if (!(to > from)) return;
    const pointAt = (run) => (
      constantIsU ? pointOn(plane, coordinate, run) : pointOn(plane, run, coordinate)
    );
    const start = pointAt(from);
    const end = pointAt(to);
    const range = clipSegmentDepthRange(toClipSpace(mvp, start), toClipSpace(mvp, end));
    if (range === null) return;
    const near = lerpPoint(start, end, range[0]);
    const far = lerpPoint(start, end, range[1]);

    const stops = [];
    let strongest = 0;
    let strongestMajorness = 0;
    let visible = false;
    for (let i = 0; i <= LINE_STOPS; i++) {
      const point = lerpPoint(near, far, i / LINE_STOPS);
      const measured = footprintAt(plane, point);
      if (measured === null) return;
      const mark = studioMarkStrength({
        coarsestLevel,
        level: measured.level,
        footprint: measured.footprint,
        pixelRatio,
        surface: plane.surface,
        minorAlpha: palette.lineMinorAlpha,
        majorAlpha: palette.lineMajorAlpha,
      });
      const strength = fadeAt(plane, point) * plane.lineMix * mark.strength;
      const base = baseAt(measured.screen.x, measured.screen.y);
      if (strength * contrastAt(base) >= INVISIBLE_CONTRAST) visible = true;
      if (strength > strongest) {
        strongest = strength;
        strongestMajorness = mark.majorness;
      }
      stops.push({
        plot: projection.viewportToPlot(measured.screen.x, measured.screen.y),
        color: rgb01ToHex(mixRgb(base, ink, strength)),
      });
    }
    if (!visible) return;
    const a = stops[0].plot;
    const b = stops[stops.length - 1].plot;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (!(length2 > 0)) return;
    const widthCss = STUDIO_MARKS.lineWidthCssPx
      + (STUDIO_MARKS.majorLineWidthCssPx - STUDIO_MARKS.lineWidthCssPx) * strongestMajorness;
    segments.push({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      widthPx: widthCss * pixelRatio * scale,
      stops: stops.map((stop) => ({
        offset: Math.min(1, Math.max(0, ((stop.plot.x - a.x) * dx + (stop.plot.y - a.y) * dy) / length2)),
        color: stop.color,
      })),
    });
  }

  function emitDot(plane, u, v, coarsestLevel) {
    const point = pointOn(plane, u, v);
    const measured = footprintAt(plane, point);
    if (measured === null) return;
    const radiusLimit = STUDIO_MARKS.majorDotRadiusCssPx * pixelRatio;
    if (
      measured.screen.x < srcX0 - radiusLimit ||
      measured.screen.x > srcX0 + srcW + radiusLimit ||
      measured.screen.y < srcY0 - radiusLimit ||
      measured.screen.y > srcY0 + srcH + radiusLimit
    ) {
      return;
    }
    const mark = studioMarkStrength({
      coarsestLevel,
      level: measured.level,
      footprint: measured.footprint,
      pixelRatio,
      surface: plane.surface,
      minorAlpha: palette.dotMinorAlpha,
      majorAlpha: palette.dotMajorAlpha,
    });
    const strength = fadeAt(plane, point) * plane.dotMix * mark.strength;
    const base = baseAt(measured.screen.x, measured.screen.y);
    if (strength * contrastAt(base) < INVISIBLE_CONTRAST) return;
    const radiusCss = STUDIO_MARKS.dotRadiusCssPx
      + (STUDIO_MARKS.majorDotRadiusCssPx - STUDIO_MARKS.dotRadiusCssPx) * mark.majorness;
    const plot = projection.viewportToPlot(measured.screen.x, measured.screen.y);
    dots.push({
      cx: plot.x,
      cy: plot.y,
      r: radiusCss * pixelRatio * scale,
      color: rgb01ToHex(mixRgb(base, ink, strength)),
    });
  }

  // Pane-NDC ellipses as plot-space affine maps of the unit circle.
  const ndcScaleX = 0.5 * viewportW * scale;
  const ndcScaleY = -0.5 * viewportH * scale;
  const ellipseMatrix = (centerX, centerY, axisAX, axisAY, axisBX, axisBY) => {
    const center = projection.viewportToPlot(
      (centerX * 0.5 + 0.5) * viewportW,
      (0.5 - centerY * 0.5) * viewportH
    );
    return [
      axisAX * ndcScaleX,
      axisAY * ndcScaleY,
      axisBX * ndcScaleX,
      axisBY * ndcScaleY,
      center.x,
      center.y,
    ];
  };
  const falloffStops = (color, strength) => {
    const stops = [];
    for (let i = 0; i <= TONE_STOPS; i++) {
      const offset = i / TONE_STOPS;
      stops.push({ offset, color, opacity: studioFalloff(offset) * strength });
    }
    return stops;
  };
  const gradients = [];
  if (drawGlow) {
    gradients.push({
      matrix: ellipseMatrix(glowCenterX, 0, glowRadiusX, 0, 0, 1),
      stops: falloffStops(rgb01ToHex(glowColor), 1),
    });
  }
  if (poolStrength > 0) {
    gradients.push({
      matrix: ellipseMatrix(
        pool.centerX,
        pool.centerY,
        pool.axisAX,
        pool.axisAY,
        pool.axisBX,
        pool.axisBY
      ),
      stops: falloffStops(rgb01ToHex(ink), poolStrength),
    });
  }

  if (gradients.length === 0 && segments.length === 0 && dots.length === 0) return null;
  return {
    kind: 'studio',
    rect: { x: plotRect.x, y: plotRect.y, width: plotRect.width, height: plotRect.height },
    gradients,
    segments,
    dots,
  };
}

function formatStops(stops) {
  return stops
    .map((stop) => (
      `<stop offset="${stop.offset.toFixed(4)}" stop-color="${stop.color}"` +
      (stop.opacity === undefined ? '' : ` stop-opacity="${stop.opacity.toFixed(5)}"`) +
      '/>'
    ))
    .join('');
}

/**
 * @param {object} model - from `buildStudioBackdropModel`
 * @param {string} idPrefix - unique within the SVG document
 * @returns {string}
 */
export function renderSvgStudioBackdrop(model, idPrefix) {
  if (typeof idPrefix !== 'string' || !/^[A-Za-z][\w-]*$/.test(idPrefix)) {
    throw new TypeError('Studio backdrop SVG requires an exact element-id prefix.');
  }
  const defs = [];
  const body = [];
  const { rect } = model;
  model.gradients.forEach((gradient, index) => {
    const id = `${idPrefix}-tone-${index}`;
    defs.push(
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" ` +
      `gradientTransform="matrix(${gradient.matrix.map((value) => value.toFixed(4)).join(' ')})">` +
      `${formatStops(gradient.stops)}</radialGradient>`
    );
    body.push(
      `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="url(#${id})"/>`
    );
  });
  if (model.segments.length > 0) {
    body.push('<g fill="none" stroke-linecap="butt">');
    model.segments.forEach((segment, index) => {
      const id = `${idPrefix}-rule-${index}`;
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
        `x1="${segment.x1.toFixed(2)}" y1="${segment.y1.toFixed(2)}" ` +
        `x2="${segment.x2.toFixed(2)}" y2="${segment.y2.toFixed(2)}">` +
        `${formatStops(segment.stops)}</linearGradient>`
      );
      body.push(
        `<line x1="${segment.x1.toFixed(2)}" y1="${segment.y1.toFixed(2)}" ` +
        `x2="${segment.x2.toFixed(2)}" y2="${segment.y2.toFixed(2)}" ` +
        `stroke="url(#${id})" stroke-width="${segment.widthPx.toFixed(3)}"/>`
      );
    });
    body.push('</g>');
  }
  if (model.dots.length > 0) {
    body.push('<g stroke="none">');
    for (const dot of model.dots) {
      body.push(
        `<circle cx="${dot.cx.toFixed(2)}" cy="${dot.cy.toFixed(2)}" ` +
        `r="${dot.r.toFixed(3)}" fill="${dot.color}"/>`
      );
    }
    body.push('</g>');
  }
  return (
    '<g class="cellucid-studio-backdrop">' +
    (defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '') +
    body.join('') +
    '</g>'
  );
}

/** A `#rrggbb` colour at an opacity, as a Canvas colour string. */
function canvasColor(hex, opacity) {
  if (opacity === undefined) return hex;
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

/**
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {object} options.model - from `buildStudioBackdropModel`
 */
export function drawCanvasStudioBackdrop({ ctx, model }) {
  ctx.save();
  const { rect } = model;
  for (const tone of model.gradients) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    // The path is fixed in figure space; the gradient is laid out on the
    // unit circle the transform maps onto the ellipse.
    ctx.transform(...tone.matrix);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const stop of tone.stops) {
      gradient.addColorStop(stop.offset, canvasColor(stop.color, stop.opacity));
    }
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();
  }
  ctx.lineCap = 'butt';
  for (const segment of model.segments) {
    const gradient = ctx.createLinearGradient(segment.x1, segment.y1, segment.x2, segment.y2);
    for (const stop of segment.stops) gradient.addColorStop(stop.offset, stop.color);
    ctx.beginPath();
    ctx.moveTo(segment.x1, segment.y1);
    ctx.lineTo(segment.x2, segment.y2);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = segment.widthPx;
    ctx.stroke();
  }
  for (const dot of model.dots) {
    ctx.beginPath();
    ctx.arc(dot.cx, dot.cy, dot.r, 0, Math.PI * 2);
    ctx.fillStyle = dot.color;
    ctx.fill();
  }
  ctx.restore();
}
