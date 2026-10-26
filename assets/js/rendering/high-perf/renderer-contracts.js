/**
 * Renderer input contracts.
 *
 * Every validator that guards a public HighPerfRenderer entry point, moved
 * verbatim out of high-perf-renderer.js. Pure: no WebGL, no renderer state, no
 * spatial index. The renderer and the spatial index both depend on this module;
 * it depends on neither.
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

export { requireDimensionLevel, requireViewId, requireShaderQuality, requireFiniteNumber, requireNumericVector, requireRenderContract, requireSnapshotPointData, requireSnapshotColors, requireSnapshotAlphas };
