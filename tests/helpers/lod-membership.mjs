/**
 * Level-of-detail membership records (`LodMembership`,
 * `assets/js/rendering/high-perf/renderer-contracts.js`) as the renderer's
 * owners make them, for contract tests that feed a consumer directly.
 */

/**
 * A level admitting cells by admission byte (a tree over cells not in
 * priority order): `admissionLevels[cell] <= lodLevel`.
 *
 * @param {Uint8Array} admissionLevels
 * @param {number} lodLevel
 * @param {{dimensionLevel?: number, indices?: Uint32Array|null, generationToken?: object}} [options]
 */
export function admissionMembership(admissionLevels, lodLevel, {
  dimensionLevel = 3,
  indices = undefined,
  generationToken = Object.freeze({}),
} = {}) {
  const admitted = [];
  for (let cell = 0; cell < admissionLevels.length; cell++) {
    if (admissionLevels[cell] <= lodLevel) admitted.push(cell);
  }
  const drawn = indices === undefined ? Uint32Array.from(admitted) : indices;
  return Object.freeze({
    admissionLevels,
    count: drawn === null ? admitted.length : drawn.length,
    dimensionLevel,
    generationToken,
    indices: drawn,
    lodLevel,
    pointCount: admissionLevels.length,
  });
}

/**
 * A level drawing the first `count` cells (cells in priority order, rank =
 * open position), as `RankLevels` publishes it (`indices` null) or a ranked
 * tree does (`indices` its draw-order prefix).
 *
 * @param {number} pointCount
 * @param {number} count
 * @param {{dimensionLevel?: number, lodLevel?: number, indices?: Uint32Array|null, generationToken?: object}} [options]
 */
export function prefixMembership(pointCount, count, {
  dimensionLevel = 3,
  lodLevel = 0,
  indices = null,
  generationToken = Object.freeze({}),
} = {}) {
  return Object.freeze({
    admissionLevels: null,
    count,
    dimensionLevel,
    generationToken,
    indices,
    lodLevel,
    pointCount,
  });
}
