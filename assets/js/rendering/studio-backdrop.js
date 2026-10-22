/**
 * The studio backdrop: what the `Studio (light)` and `Studio (dark)`
 * backgrounds draw behind the data.
 *
 * WHAT IT IS
 * - A 3-D pane stands on a floor: one horizontal plane just under the data,
 *   ruled with hairlines that fade out long before the stage ends, so no edge
 *   is ever visible. It is always the same ruled floor, from any angle; only
 *   where the camera sees it nearly edge-on, or has gone below it, does it
 *   fade away, as a real floor would.
 * - A 1-D or 2-D pane, and any pane navigated in planar mode, sits on a dot
 *   surface: the plane behind the data, like dotted paper.
 *
 * HOW IT STAYS CALM AT EVERY ZOOM
 * Marks lie on a lattice of nested families: family `k` has spacing
 * `base * ratio^k`, so every coarser family is a subset of every finer one.
 * A family's weight is a function of its spacing alone
 * (`studioFamilyWeights`): it fades in as its on-screen spacing grows past
 * half the minimum cell, and turns from a minor into a major mark over one
 * further ratio. Because the weight depends only on spacing, a pixel can
 * evaluate the three families around its own footprint and still agree with
 * its neighbours, so the pattern crossfades with zoom and never pops. Rules and
 * dots have a constant width in CSS pixels, so they read the same on a DPR 1
 * and a DPR 3 screen, and they are anti-aliased against the pixel footprint.
 *
 * WHO READS THIS FILE
 * - `shaders/studio-shaders.js` builds its GLSL from these constants.
 * - `viewer.js` resolves each pane's geometry with `resolveStudioPaneGeometry`
 *   and its palette from `STUDIO_PALETTES`.
 * - Figure export (`components/studio-backdrop-export.js`) evaluates the same
 *   functions to reproduce the backdrop as vectors.
 * One source means the screen, the shader and an exported figure cannot
 * disagree about a constant.
 *
 * Everything here is pure: no WebGL, no DOM, no viewer state.
 */

/** The nested mark lattice. Lengths are in normalized data units. */
export const STUDIO_LATTICE = Object.freeze({
  /** Spacing of family 0; integer coordinates are always on the lattice. */
  base: 1.0,
  /** Spacing ratio between neighbouring families (major every fifth mark). */
  ratio: 5,
  /** A family starts to fade in at this fraction of its surface's minimum cell. */
  fadeInFraction: 0.6,
});

/**
 * How each surface uses the lattice.
 *
 * - `minCellCssPx`: the on-screen spacing (CSS px) at which a family reaches
 *   minor strength. The floor's rules are calmest a little apart; the dot
 *   surface, where a family spans five times this spacing before the next
 *   finer one takes over, reads as paper only if it starts denser.
 * - `maxFamilySpacing`: families spaced wider than this fade out (from half
 *   of it). Seen from far away, floor rules as wide apart as the stage itself
 *   would no longer read as a floor but as a lone cross, so the floor recedes
 *   instead. The dot surface has no stage and no bound.
 *
 * The floor's dots, seen from straight above, sit on its rule crossings, so
 * they use the floor's lattice.
 */
export const STUDIO_SURFACES = Object.freeze({
  floor: Object.freeze({ minCellCssPx: 22, maxFamilySpacing: 2.5 }),
  backdrop: Object.freeze({ minCellCssPx: 16, maxFamilySpacing: Infinity }),
});

/** Mark sizes, in CSS pixels. */
export const STUDIO_MARKS = Object.freeze({
  lineWidthCssPx: 1.0,
  majorLineWidthCssPx: 1.0,
  dotRadiusCssPx: 1.05,
  majorDotRadiusCssPx: 1.3,
});

/** The stage the floor describes, and how it fades. */
export const STUDIO_STAGE = Object.freeze({
  /** Gap between the lowest cell and the floor, in normalized data units. */
  floorClearance: 0.12,
  /** The floor is at full strength within this radius of the data centre. */
  innerRadius: 2.6,
  /** ...and has faded out completely at this radius. */
  outerRadius: 8.5,
  /**
   * Grazing fade on the sine of the angle between a view ray and the plane:
   * a plane seen nearly edge-on fades out before it can shimmer.
   */
  grazingFadeStart: 0.035,
  grazingFadeEnd: 0.2,
  /** A camera this close to a plane (or behind it) sees it fade out. */
  clearanceFade: 0.06,
  /**
   * The pool under the data reaches this many of the data's half-extents
   * from its centre...
   */
  poolReach: 1.8,
  /** ...and is never narrower than this fraction of its wider half-extent. */
  poolRoundness: 0.4,
});

/**
 * Seconds a pane takes to cross between the floor and the dot surface when
 * its dimension or navigation mode changes.
 */
export const STUDIO_SURFACE_TRANSITION_SECONDS = 0.3;

/**
 * Exact 8-bit colours, so the page colour in `assets/css` and the WebGL
 * clear colour are the same value with no rounding seam between them.
 *
 * - `surface` is the clear colour, the CSS page colour and the backdrop's
 *   colour at every pane edge.
 * - `glow` is the backdrop's colour at the centre of the presented area: a
 *   soft, dithered rise in lightness that gives the stage depth.
 * - `ink` is the colour marks are drawn in, at the per-class alphas.
 * - `poolAlpha` is the strength of the soft pool of ink on the floor under
 *   the data: a contact shadow on the light stage, a pool of light on the
 *   dark one.
 *
 * @type {Readonly<Record<'studio'|'studio-dark', Readonly<{
 *   surface: readonly number[];
 *   glow: readonly number[];
 *   ink: readonly number[];
 *   lineMinorAlpha: number;
 *   lineMajorAlpha: number;
 *   dotMinorAlpha: number;
 *   dotMajorAlpha: number;
 *   poolAlpha: number;
 * }>>>}
 */
export const STUDIO_PALETTES = Object.freeze({
  studio: Object.freeze({
    surface: Object.freeze([236, 236, 236]),
    glow: Object.freeze([246, 246, 246]),
    ink: Object.freeze([96, 96, 96]),
    lineMinorAlpha: 0.15,
    lineMajorAlpha: 0.28,
    dotMinorAlpha: 0.32,
    dotMajorAlpha: 0.42,
    poolAlpha: 0.09,
  }),
  'studio-dark': Object.freeze({
    surface: Object.freeze([17, 17, 17]),
    glow: Object.freeze([27, 27, 27]),
    ink: Object.freeze([200, 200, 200]),
    lineMinorAlpha: 0.12,
    lineMajorAlpha: 0.22,
    dotMinorAlpha: 0.26,
    dotMajorAlpha: 0.34,
    poolAlpha: 0.09,
  }),
});

/**
 * An 8-bit palette colour as the 0..1 triple WebGL takes.
 *
 * @param {readonly number[]} rgb8
 * @returns {number[]}
 */
export function studioColor01(rgb8) {
  return [rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The weight of one lattice family on one surface.
 *
 * `presence` rises from 0 at `fadeInFraction * minCell` on-screen spacing to
 * 1 at `minCell`, and falls back to 0 as the family's own spacing grows from
 * half of `maxSpacing` to `maxSpacing`; `majorness` rises from 0 to 1
 * between `minCell` and `ratio * minCell` on screen. Mirrors
 * `studioFamilyWeights` in `STUDIO_GLSL_LATTICE`.
 *
 * @param {{ minCellCssPx: number; maxFamilySpacing: number }} surface - one
 *   of `STUDIO_SURFACES`
 * @param {number} spacing - the family's spacing in data units
 * @param {number} spacingCssPx - the same spacing on screen
 * @returns {{ presence: number; majorness: number }}
 */
export function studioFamilyWeights(surface, spacing, spacingCssPx) {
  const minCell = surface.minCellCssPx;
  const maxSpacing = surface.maxFamilySpacing;
  return {
    presence:
      smoothstep(minCell * STUDIO_LATTICE.fadeInFraction, minCell, spacingCssPx)
      * (maxSpacing === Infinity ? 1 : 1 - smoothstep(maxSpacing * 0.5, maxSpacing, spacing)),
    majorness: smoothstep(minCell, minCell * STUDIO_LATTICE.ratio, spacingCssPx),
  };
}

/** Spacing of lattice family `level`. */
export function studioFamilySpacing(level) {
  return STUDIO_LATTICE.base * STUDIO_LATTICE.ratio ** level;
}

/**
 * The finest family a fragment evaluates, from its footprint: the coarsest
 * family whose on-screen spacing is still at most the surface's minimum
 * cell. The shader evaluates it and the next two.
 *
 * @param {{ minCellCssPx: number }} surface - one of `STUDIO_SURFACES`
 * @param {number} footprint - data units per device pixel
 * @param {number} pixelRatio - device pixels per CSS pixel
 */
export function studioFamilyLevel(surface, footprint, pixelRatio) {
  return Math.floor(
    Math.log(footprint * surface.minCellCssPx * pixelRatio / STUDIO_LATTICE.base)
    / Math.log(STUDIO_LATTICE.ratio)
  );
}

/**
 * The strength the shader gives a mark at its centre, where every family it
 * belongs to covers it fully: the strongest of the families the fragment
 * evaluates (`level` to `level + 2`) that contain the mark, which are those
 * up to `coarsestLevel`. Mirrors the family loop of `studioLatticeMarks`
 * (without its sub-pixel width compensation, which a vector stroke does not
 * need).
 *
 * @param {object} options
 * @param {object} options.surface - one of `STUDIO_SURFACES`
 * @param {number} options.coarsestLevel - the coarsest family the mark is on
 *   (`Infinity` for the lattice origin)
 * @param {number} options.level - `studioFamilyLevel` at the mark
 * @param {number} options.footprint - data units per device pixel at the mark
 * @param {number} options.pixelRatio
 * @param {number} options.minorAlpha
 * @param {number} options.majorAlpha
 * @returns {{ strength: number; majorness: number }}
 */
export function studioMarkStrength({
  surface,
  coarsestLevel,
  level,
  footprint,
  pixelRatio,
  minorAlpha,
  majorAlpha,
}) {
  let strength = 0;
  let majorness = 0;
  for (let family = level; family <= Math.min(coarsestLevel, level + 2); family++) {
    const spacing = studioFamilySpacing(family);
    const weights = studioFamilyWeights(surface, spacing, spacing / footprint / pixelRatio);
    const value = weights.presence * (minorAlpha + (majorAlpha - minorAlpha) * weights.majorness);
    if (value > strength) {
      strength = value;
      majorness = weights.majorness;
    }
  }
  return { strength, majorness };
}

/**
 * The falloff of the glow and of the pool at a radius normalized to their
 * ellipse: 1 at the centre, 0 on and outside it. Mirrors `studioFalloff` in
 * `STUDIO_FS_SOURCE`.
 *
 * @param {number} radius
 */
export function studioFalloff(radius) {
  return 1 - smoothstep(0, 1, radius);
}

/** The fade with a plane's distance from the data centre (floor only). */
export function studioStageFade(radius) {
  return 1 - smoothstep(STUDIO_STAGE.innerRadius, STUDIO_STAGE.outerRadius, radius);
}

/** The fade with the sine of a view ray's angle to a plane. */
export function studioGrazingFade(sine) {
  return smoothstep(STUDIO_STAGE.grazingFadeStart, STUDIO_STAGE.grazingFadeEnd, sine);
}

/** The fade with the camera's signed distance in front of a plane. */
export function studioClearanceFade(distance) {
  return smoothstep(0, STUDIO_STAGE.clearanceFade, distance);
}

/**
 * Whether a pane sits on the dot surface (1) or stands on the floor (0).
 *
 * @param {1|2|3} dimensionLevel
 * @param {'orbit'|'planar'|'free'} navigationMode
 * @returns {0|1}
 */
export function studioSurfacePlanarity(dimensionLevel, navigationMode) {
  return dimensionLevel < 3 || navigationMode === 'planar' ? 1 : 0;
}

/**
 * How strongly a pane draws its floor and its dot surface, each 0..1, from
 * its planarity alone: a 3-D pane is on the floor and a flat or planar one on
 * the dot surface, whatever the camera's angle, and the two only crossfade
 * while the pane changes between them. The viewer passes the result as
 * uniforms, and figure export calls this same function. Writes into `out`
 * (no allocation).
 *
 * @param {number} planarity - `studioSurfacePlanarity`, possibly mid-crossfade
 * @param {{ floor: number; backdrop: number }} out
 */
export function resolveStudioSurfaceWeights(planarity, out) {
  out.floor = 1 - planarity;
  out.backdrop = planarity;
  return out;
}

/**
 * The backdrop geometry of one pane, from the bounds of the positions it
 * shows. Writes into `out` so the render loop allocates nothing.
 *
 * - `floorY`: the floor, `floorClearance` under the lowest cell.
 * - `flat`: whether the embedding is 1-D or 2-D. Its dot surface is then the
 *   data plane itself (z = 0), so the dots stay registered with the cells.
 * - `stageX`, `centerY`, `stageZ`: the data centre (`stageX`, `stageZ` is
 *   also the floor point under it).
 * - `extentX`, `extentY`, `extentZ`: the data's half-extents.
 *
 * @param {{ min: readonly number[]; max: readonly number[] }|null} bounds -
 *   per-axis bounds, or null for a view with no cells.
 * @param {1|2|3} dimensionLevel
 * @param {{ floorY: number; flat: boolean; stageX: number; centerY: number;
 *   stageZ: number; extentX: number; extentY: number; extentZ: number }} out
 */
export function resolveStudioPaneGeometry(bounds, dimensionLevel, out) {
  const minY = bounds === null ? -1 : bounds.min[1];
  out.floorY = minY - STUDIO_STAGE.floorClearance;
  out.flat = dimensionLevel < 3;
  out.stageX = bounds === null ? 0 : (bounds.min[0] + bounds.max[0]) * 0.5;
  out.stageZ = bounds === null ? 0 : (bounds.min[2] + bounds.max[2]) * 0.5;
  out.centerY = bounds === null ? 0 : (bounds.min[1] + bounds.max[1]) * 0.5;
  out.extentX = bounds === null ? 1 : (bounds.max[0] - bounds.min[0]) * 0.5;
  out.extentY = bounds === null ? 1 : (bounds.max[1] - bounds.min[1]) * 0.5;
  out.extentZ = bounds === null ? 1 : (bounds.max[2] - bounds.min[2]) * 0.5;
  return out;
}

/**
 * The dot surface of one pane: a plane behind the data, facing the
 * camera. Writes into `out` (no allocation): the unit normal `normalX/Y/Z`
 * pointing away from the camera, the plane offset (`normal · p = offset`),
 * and the unit lattice axes `uX/Y/Z` (screen right) and `vX/Y/Z` (screen up).
 *
 * - A flat embedding's surface is its own plane, z = 0, whatever the camera:
 *   u = x, v = y, so the dots stay registered with the cells.
 * - A 3-D cloud's surface faces the camera squarely, just past the cloud's
 *   extent along the view direction. Seen square-on, its dots are evenly
 *   spaced across the whole pane, like paper behind the data, whatever the
 *   camera's heading or pitch; the data turns in front of it. In planar
 *   navigation the camera looks down -z with x right and y up, which makes
 *   it the XY plane just behind the deepest cell.
 *
 * @param {ArrayLike<number>} viewMatrix - column-major
 * @param {{ flat: boolean; stageX: number; centerY: number; stageZ: number;
 *   extentX: number; extentY: number; extentZ: number }} geometry
 * @param {object} out
 */
export function resolveStudioBackdropPlane(viewMatrix, geometry, out) {
  if (geometry.flat) {
    out.normalX = 0; out.normalY = 0; out.normalZ = -1;
    out.offset = -geometry.stageZ;
    out.uX = 1; out.uY = 0; out.uZ = 0;
    out.vX = 0; out.vY = 1; out.vZ = 0;
    return out;
  }
  // The view matrix's rows are the camera's right, up and backward axes.
  const normalX = -viewMatrix[2];
  const normalY = -viewMatrix[6];
  const normalZ = -viewMatrix[10];
  const depth = geometry.extentX * Math.abs(normalX)
    + geometry.extentY * Math.abs(normalY)
    + geometry.extentZ * Math.abs(normalZ)
    + STUDIO_STAGE.floorClearance;
  out.normalX = normalX;
  out.normalY = normalY;
  out.normalZ = normalZ;
  out.offset = normalX * geometry.stageX
    + normalY * geometry.centerY
    + normalZ * geometry.stageZ
    + depth;
  out.uX = viewMatrix[0]; out.uY = viewMatrix[4]; out.uZ = viewMatrix[8];
  out.vX = viewMatrix[1]; out.vY = viewMatrix[5]; out.vZ = viewMatrix[9];
  return out;
}

/** Project a model-space point; writes NDC x, y into out[0..1]. */
function projectToNdc(mvp, x, y, z, out) {
  const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  if (!(w > 1e-9)) return false;
  out[0] = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w;
  out[1] = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w;
  return true;
}

const _poolCenter = [0, 0];
const _poolAxis = [0, 0];

/**
 * The pool under the data, as the pane-space ellipse it occupies.
 *
 * The pool is the floor ellipse under the data's footprint, `poolReach`
 * half-extents wide, seen through the pane's camera. It is taken as the
 * affine image of the unit circle at its centre — exactly what an SVG or
 * Canvas radial gradient can express — so the screen and an exported figure
 * draw the same ellipse. `gate` fades it with the camera's height above the
 * floor and with how obliquely the camera sees the stage centre; it is 0
 * when the pool is not drawn.
 *
 * Writes into `out` (no allocation): `gate`, `centerX`, `centerY`, and the
 * semi-axes `axisAX`, `axisAY`, `axisBX`, `axisBY`, all in pane NDC.
 *
 * @param {ArrayLike<number>} mvp - column-major model-view-projection
 * @param {ArrayLike<number>} eye - camera position in model space
 * @param {{ floorY: number; stageX: number; stageZ: number;
 *   extentX: number; extentZ: number }} geometry
 * @param {object} out
 */
export function resolveStudioPool(mvp, eye, geometry, out) {
  out.gate = 0;
  const height = eye[1] - geometry.floorY;
  const toCenter = Math.hypot(
    eye[0] - geometry.stageX,
    height,
    eye[2] - geometry.stageZ
  );
  if (!(height > 0) || !(toCenter > 0)) return out;
  const gate = studioClearanceFade(height) * studioGrazingFade(height / toCenter);
  if (!(gate > 0)) return out;
  const minimum = Math.max(geometry.extentX, geometry.extentZ) * STUDIO_STAGE.poolRoundness;
  const reachX = Math.max(geometry.extentX, minimum) * STUDIO_STAGE.poolReach;
  const reachZ = Math.max(geometry.extentZ, minimum) * STUDIO_STAGE.poolReach;
  if (!(reachX > 0) || !(reachZ > 0)) return out;
  const y = geometry.floorY;
  if (!projectToNdc(mvp, geometry.stageX, y, geometry.stageZ, _poolCenter)) return out;
  out.centerX = _poolCenter[0];
  out.centerY = _poolCenter[1];
  if (!projectToNdc(mvp, geometry.stageX + reachX, y, geometry.stageZ, _poolAxis)) return out;
  out.axisAX = _poolAxis[0] - out.centerX;
  out.axisAY = _poolAxis[1] - out.centerY;
  if (!projectToNdc(mvp, geometry.stageX, y, geometry.stageZ + reachZ, _poolAxis)) return out;
  out.axisBX = _poolAxis[0] - out.centerX;
  out.axisBY = _poolAxis[1] - out.centerY;
  const determinant = out.axisAX * out.axisBY - out.axisBX * out.axisAY;
  if (!(Math.abs(determinant) > 1e-9)) return out;
  out.gate = gate;
  return out;
}
