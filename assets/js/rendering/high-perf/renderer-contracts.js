/**
 * Renderer input contracts.
 *
 * Every validator that guards a public HighPerfRenderer entry point, and the
 * records the renderer publishes to the rest of the app (`LodMembership`)
 * with the one validator of each that every consumer uses. Pure: no WebGL, no
 * renderer state, no spatial index. The renderer and the spatial index both
 * depend on this module; it depends on neither.
 */

import {
  describeShaderQualities,
  SHADER_QUALITIES,
} from '../shader-quality.js';
import { formatCountOf } from '../../utils/format-units.js';

const SUPPORTED_DIMENSION_LEVELS = new Set([1, 2, 3]);
const SUPPORTED_SHADER_QUALITIES = new Set(SHADER_QUALITIES);
const REQUIRED_RENDER_SCALAR_KEYS = Object.freeze([
  'pointSize',
  'sizeAttenuation',
  'viewportHeight',
  'viewportWidth',
  'fov',
  'lightingStrength',
  'fogDensity',
  'cameraDistance',
]);
const REQUIRED_RENDER_VECTOR_CONTRACTS = Object.freeze([
  Object.freeze(['mvpMatrix', 16]),
  Object.freeze(['viewMatrix', 16]),
  Object.freeze(['modelMatrix', 16]),
  Object.freeze(['projectionMatrix', 16]),
  Object.freeze(['fogColor', 3]),
  Object.freeze(['lightDir', 3]),
  Object.freeze(['cameraPosition', 3]),
]);
function requireDimensionLevel(value, owner = 'Renderer dimensionLevel') {
  if (!Number.isInteger(value) || !SUPPORTED_DIMENSION_LEVELS.has(value)) {
    throw new RangeError(
      `${owner} is required and must be exactly 1, 2, or 3; received ${String(value)}.`
    );
  }
  return value;
}

function requireViewId(value, owner = 'Renderer viewId') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${owner} must be a non-empty string.`);
  }
  return value;
}

function requireShaderQuality(value, owner = 'Renderer quality') {
  if (!SUPPORTED_SHADER_QUALITIES.has(value)) {
    throw new RangeError(
      `${owner} must be exactly ${describeShaderQualities()}; received ${String(value)}.`
    );
  }
  return value;
}

function requireFiniteNumber(value, owner) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${owner} must be a finite number; received ${String(value)}.`);
  }
  return value;
}

function requireNumericVector(value, length, owner) {
  if (
    (!Array.isArray(value) && !ArrayBuffer.isView(value)) ||
    value.length !== length
  ) {
    throw new TypeError(`${owner} must contain exactly ${length} numeric values.`);
  }
  for (let i = 0; i < length; i++) {
    if (!Number.isFinite(value[i])) {
      throw new TypeError(
        `${owner}[${i}] must be a finite number; received ${String(value[i])}.`
      );
    }
  }
  return value;
}
function getRenderContractOwner(snapshotId) {
  return snapshotId === null
    ? 'HighPerfRenderer render'
    : `HighPerfRenderer snapshot "${snapshotId}"`;
}

function hasExactFiniteVector(value, length) {
  if (
    (!Array.isArray(value) && !ArrayBuffer.isView(value)) ||
    value.length !== length
  ) {
    return false;
  }
  for (let index = 0; index < length; index++) {
    if (!Number.isFinite(value[index])) return false;
  }
  return true;
}

function requireRenderContract(params, snapshotId = null) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError(
      `${getRenderContractOwner(snapshotId)} parameters must be an object.`
    );
  }
  for (
    let index = 0;
    index < REQUIRED_RENDER_VECTOR_CONTRACTS.length;
    index++
  ) {
    const contract = REQUIRED_RENDER_VECTOR_CONTRACTS[index];
    if (!hasExactFiniteVector(params[contract[0]], contract[1])) {
      requireNumericVector(
        params[contract[0]],
        contract[1],
        `${getRenderContractOwner(snapshotId)} ${contract[0]}`
      );
    }
  }
  // Indexed, like the vector loop above: this runs for every pane of every
  // frame, and an array iterator is a per-call allocation.
  for (
    let index = 0;
    index < REQUIRED_RENDER_SCALAR_KEYS.length;
    index++
  ) {
    const key = REQUIRED_RENDER_SCALAR_KEYS[index];
    const value = params[key];
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `${getRenderContractOwner(snapshotId)} ${key} must be a finite number; received ${String(value)}.`
      );
    }
  }
  if (!Number.isInteger(params.forceLOD) || params.forceLOD < -1) {
    throw new RangeError(
      `${getRenderContractOwner(snapshotId)} forceLOD must be an integer greater than or equal to -1.`
    );
  }
  if (typeof params.autoFog !== 'boolean') {
    throw new TypeError(
      `${getRenderContractOwner(snapshotId)} autoFog must be a boolean.`
    );
  }
  if (typeof params.useAlphaTexture !== 'boolean') {
    throw new TypeError(
      `${getRenderContractOwner(snapshotId)} useAlphaTexture must be a boolean.`
    );
  }
  // Optional: whether the pass draws into a multisampled target. Absent means
  // single-sampled, which is what a caller that never multisamples draws into.
  if (
    params.multisampled !== undefined &&
    typeof params.multisampled !== 'boolean'
  ) {
    throw new TypeError(
      `${getRenderContractOwner(snapshotId)} multisampled must be a boolean when given.`
    );
  }
  if (!SUPPORTED_SHADER_QUALITIES.has(params.quality)) {
    requireShaderQuality(
      params.quality,
      `${getRenderContractOwner(snapshotId)} quality`
    );
  }
  if (typeof params.viewId !== 'string' || params.viewId.length === 0) {
    requireViewId(
      params.viewId,
      `${getRenderContractOwner(snapshotId)} viewId`
    );
  }
  if (!SUPPORTED_DIMENSION_LEVELS.has(params.dimensionLevel)) {
    requireDimensionLevel(
      params.dimensionLevel,
      `${getRenderContractOwner(snapshotId)} dimensionLevel`
    );
  }
  return params;
}

function requireSnapshotPointData(
  pointCount,
  positions,
  dimensionLevel,
  colors,
  alphas,
  owner
) {
  const dimension = requireDimensionLevel(
    dimensionLevel,
    `${owner} dimensionLevel`
  );
  if (
    !(positions instanceof Float32Array) ||
    positions.length !== pointCount * dimension
  ) {
    throw new TypeError(
      `${owner} positions must be a Float32Array with exactly ${formatCountOf(pointCount * dimension, 'value')} (${dimension} per point).`
    );
  }
  if (!(colors instanceof Uint8Array) || colors.length !== pointCount * 4) {
    throw new TypeError(
      `${owner} colors must be an RGBA Uint8Array with exactly ${formatCountOf(pointCount * 4, 'byte')}.`
    );
  }
  if (alphas !== null) {
    if (
      !(alphas instanceof Uint8Array) ||
      alphas.length !== pointCount
    ) {
      throw new TypeError(
        `${owner} alpha values must be null or a Uint8Array with exactly ${formatCountOf(pointCount, 'entry', 'entries')}.`
      );
    }
  }

  return {
    alphas,
    colors,
    positions,
  };
}

function requireSnapshotColors(pointCount, colors, owner) {
  if (
    !(colors instanceof Uint8Array) ||
    colors.length !== pointCount * 4
  ) {
    throw new TypeError(
      `${owner} colors must be an RGBA Uint8Array with exactly ${formatCountOf(pointCount * 4, 'byte')}.`
    );
  }
  return colors;
}

/**
 * The admission level of a cell drawn only at full detail
 * (`LodMembership.admissionLevels`); the ladder's bands are counted in the
 * same byte, so a ladder has fewer.
 */
const LOD_FULL_DETAIL_ADMISSION_LEVEL = 0xff;

/**
 * @typedef {Readonly<{
 *   admissionLevels: Uint8Array|null,
 *   count: number,
 *   dimensionLevel: number,
 *   generationToken: object,
 *   indices: Uint32Array|null,
 *   lodLevel: number,
 *   pointCount: number,
 * }>} LodMembership
 *
 * The cells one reduced level of detail of one view draws: the one record
 * every consumer of a level reads (picking, highlights, connectivity edges,
 * the velocity overlay's spawn sources, the highlight count, figure export),
 * made by the owner of the levels (`SpatialIndex`, `RankLevels`) and
 * published by `HighPerfRenderer#getCurrentLodMembership`. Null means full
 * detail: every cell. A record is frozen, and the same object for as long as
 * the view draws the same level of the same owner, so consumers key what
 * they derive from it on its identity.
 *
 * - `pointCount`, `dimensionLevel`: the view's cells and dimension.
 * - `lodLevel`: the level, 0 the coarsest, below the full-detail level.
 * - `count`: the cells the level draws.
 * - `generationToken`: a frozen object, one per owner of the levels.
 * - `admissionLevels`: null when the level's cells are the first `count`
 *   open cells. That holds whenever the open cells are in priority order
 *   (`data/cell-priority.js`, `OPEN_ORDER_PRIORITY`): a cell's rank is its
 *   open position, and every level is the cells of the ranks below its
 *   count, drawn as the first `count` slots of any store holding the cells
 *   by rank. Otherwise one byte a cell, the coarsest level admitting it
 *   (`LOD_FULL_DETAIL_ADMISSION_LEVEL` for a cell drawn only at full
 *   detail), shared by every level of the owner. A cell is admitted when
 *   `admissionLevels === null ? cell < count : admissionLevels[cell] <= lodLevel`
 *   (`lodMembershipAdmits`, and the hot loops that inline it).
 * - `indices`: the level's cells in the order they are drawn, when the owner
 *   holds that order (a tree: a view of its draw order, no copy); null for a
 *   level drawn by rank from a store as it is (`RankLevels`), whose cells are
 *   `[0, count)` in whatever order the store holds them
 *   (`HighPerfRenderer#getViewDrawOrder` names it).
 *
 * Consumers check the fields they read, never the set of keys, so an owner
 * may carry more than this record names.
 */

/** A count of cells for a message, whatever value a malformed record holds. */
function cellsOf(value) {
  return Number.isFinite(value) ? formatCountOf(value, 'cell') : `${String(value)} (not a count of cells)`;
}

/**
 * Require a level-of-detail membership (`LodMembership`) for a view of
 * `pointCount` cells (and `dimensionLevel`, when given). Null passes as full
 * detail. `requireIndices` asks for the drawn order as well (figure export
 * owns its copy of it).
 *
 * @param {LodMembership|null} membership
 * @param {{pointCount: number, dimensionLevel?: number|null, requireIndices?: boolean, owner: string}} expected
 * @returns {LodMembership|null}
 */
function requireLodMembership(
  membership,
  { pointCount, dimensionLevel = null, requireIndices = false, owner }
) {
  if (membership === null) return null;
  if (
    membership === undefined ||
    typeof membership !== 'object' ||
    Array.isArray(membership) ||
    !Object.isFrozen(membership)
  ) {
    throw new TypeError(`${owner} must be null or one frozen level-of-detail membership.`);
  }
  const { admissionLevels, count, generationToken, indices, lodLevel } = membership;
  if (
    !Number.isSafeInteger(membership.pointCount) ||
    membership.pointCount !== pointCount ||
    !SUPPORTED_DIMENSION_LEVELS.has(membership.dimensionLevel) ||
    (dimensionLevel !== null && membership.dimensionLevel !== dimensionLevel)
  ) {
    throw new RangeError(
      `${owner} describes ${cellsOf(membership.pointCount)} in ${String(membership.dimensionLevel)}D, `
        + `not the view's ${cellsOf(pointCount)}${dimensionLevel === null ? '' : ` in ${dimensionLevel}D`}.`
    );
  }
  if (
    !Number.isInteger(lodLevel) ||
    lodLevel < 0 ||
    lodLevel >= LOD_FULL_DETAIL_ADMISSION_LEVEL ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > pointCount
  ) {
    throw new RangeError(
      `${owner} must name a reduced level below ${LOD_FULL_DETAIL_ADMISSION_LEVEL} drawing at most ${cellsOf(pointCount)}.`
    );
  }
  if (
    generationToken === null ||
    typeof generationToken !== 'object' ||
    !Object.isFrozen(generationToken)
  ) {
    throw new TypeError(`${owner} generationToken must be one frozen object.`);
  }
  if (
    admissionLevels !== null &&
    (!(admissionLevels instanceof Uint8Array) || admissionLevels.length !== pointCount)
  ) {
    throw new TypeError(`${owner} admissionLevels must be null or one byte a cell.`);
  }
  if (
    (indices !== null && (!(indices instanceof Uint32Array) || indices.length !== count)) ||
    (requireIndices && indices === null)
  ) {
    throw new TypeError(
      `${owner} indices must be ${requireIndices ? '' : 'null or '}the level's ${cellsOf(count)} as a Uint32Array.`
    );
  }
  return membership;
}

/**
 * Whether a level of detail draws `cell` (null: full detail, every cell).
 * For per-cell loops over millions of cells the consumers inline the same
 * test (see `LodMembership`).
 *
 * @param {LodMembership|null} membership
 * @param {number} cell
 * @returns {boolean}
 */
function lodMembershipAdmits(membership, cell) {
  if (membership === null) return true;
  const admissionLevels = membership.admissionLevels;
  return admissionLevels === null ? cell < membership.count : admissionLevels[cell] <= membership.lodLevel;
}

function requireSnapshotAlphas(pointCount, alphas, owner) {
  if (
    !(alphas instanceof Uint8Array) ||
    alphas.length !== pointCount
  ) {
    throw new TypeError(
      `${owner} alpha values must be a Uint8Array with exactly ${formatCountOf(pointCount, 'entry', 'entries')}.`
    );
  }
  return alphas;
}

export {
  LOD_FULL_DETAIL_ADMISSION_LEVEL,
  lodMembershipAdmits,
  requireDimensionLevel,
  requireLodMembership,
  requireViewId,
  requireShaderQuality,
  requireFiniteNumber,
  requireNumericVector,
  requireRenderContract,
  requireSnapshotPointData,
  requireSnapshotColors,
  requireSnapshotAlphas,
};
