/**
 * Renderer input contracts.
 *
 * Every validator that guards a public HighPerfRenderer entry point, moved
 * verbatim out of high-perf-renderer.js. Pure: no WebGL, no renderer state, no
 * spatial index. The renderer and the spatial index both depend on this module;
 * it depends on neither.
 */

const SUPPORTED_DIMENSION_LEVELS = new Set([1, 2, 3]);
const SUPPORTED_SHADER_QUALITIES = new Set(['full', 'light', 'ultralight']);
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
      `${owner} must be exactly "full", "light", or "ultralight"; received ${String(value)}.`
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
  for (const key of REQUIRED_RENDER_SCALAR_KEYS) {
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
  colors,
  alphas,
  owner
) {
  if (
    !(positions instanceof Float32Array) ||
    positions.length !== pointCount * 3
  ) {
    throw new TypeError(
      `${owner} positions must be a Float32Array with exactly ${pointCount * 3} values.`
    );
  }
  if (!(colors instanceof Uint8Array) || colors.length !== pointCount * 4) {
    throw new TypeError(
      `${owner} colors must be an RGBA Uint8Array with exactly ${pointCount * 4} bytes.`
    );
  }
  if (alphas !== null) {
    if (
      !(alphas instanceof Float32Array) ||
      alphas.length !== pointCount
    ) {
      throw new TypeError(
        `${owner} alpha values must be null or a Float32Array with exactly ${pointCount} entries.`
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
      `${owner} colors must be an RGBA Uint8Array with exactly ${pointCount * 4} bytes.`
    );
  }
  return colors;
}

function requireSnapshotAlphas(pointCount, alphas, owner) {
  if (
    !(alphas instanceof Float32Array) ||
    alphas.length !== pointCount
  ) {
    throw new TypeError(
      `${owner} alpha values must be a Float32Array with exactly ${pointCount} entries.`
    );
  }
  return alphas;
}

export {
  SUPPORTED_DIMENSION_LEVELS,
  SUPPORTED_SHADER_QUALITIES,
  REQUIRED_RENDER_SCALAR_KEYS,
  REQUIRED_RENDER_VECTOR_CONTRACTS,
  requireDimensionLevel,
  requireViewId,
  requireShaderQuality,
  requireFiniteNumber,
  requireNumericVector,
  getRenderContractOwner,
  hasExactFiniteVector,
  requireRenderContract,
  requireSnapshotPointData,
  requireSnapshotColors,
  requireSnapshotAlphas,
};
