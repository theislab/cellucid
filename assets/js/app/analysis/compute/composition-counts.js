/**
 * @fileoverview Cell counts per cell type and per unit (a sample, a
 * condition, or a sample within a condition) — the table every composition
 * analysis starts from.
 *
 * One pass over the cells, O(cells), reading the categorical codes at the
 * width they are stored in (no copies). Runs in a worker
 * (`COMPOSITION_COUNTS`) and on the main thread with the same code.
 *
 * @module analysis/compute/composition-counts
 */

import {
  isCategoricalCodes,
  missingCategoryCode
} from '../../../data/categorical-storage-contract.js';

function requireCodeMap(map, label) {
  if (!(map instanceof Int32Array) || map.length === 0) {
    throw new TypeError(`${label} must be a non-empty Int32Array (code to index, -1 to leave out)`);
  }
  return map;
}

function requireCodes(codes, cellCount, label) {
  if (!isCategoricalCodes(codes) || codes.length !== cellCount) {
    throw new TypeError(`${label} must be categorical codes of one per cell`);
  }
  return codes;
}

/**
 * Count the cells of each type in each unit.
 *
 * A cell is counted when it is in scope (`scope[cell] !== 0`, or every cell
 * without a scope), its type maps to a type index and, when there are
 * sample or condition codes, its sample and condition map to indices too. A
 * missing code, or a code whose map entry is -1, leaves the cell out.
 *
 * The unit of a cell is `sampleIndex * conditionCount + conditionIndex`
 * (with 0 for an absent axis), so a sample split across conditions counts in
 * one unit per condition.
 *
 * @param {object} payload
 * @param {Uint8Array|Uint16Array|Uint32Array} payload.typeCodes
 * @param {Int32Array} payload.typeIndexOfCode
 * @param {number} payload.typeCount
 * @param {Uint8Array|Uint16Array|Uint32Array|null} payload.sampleCodes
 * @param {Int32Array|null} payload.sampleIndexOfCode
 * @param {number} payload.sampleCount - 1 without samples.
 * @param {Uint8Array|Uint16Array|Uint32Array|null} payload.conditionCodes
 * @param {Int32Array|null} payload.conditionIndexOfCode
 * @param {number} payload.conditionCount - 1 without a condition.
 * @param {Uint8Array|null} payload.scope - One byte a cell, or null for all.
 * @returns {{counts: Uint32Array, typeCount: number, unitCount: number}}
 *   `counts[type * unitCount + unit]`.
 */
export function compositionCounts(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new TypeError('Composition counts need a payload object');
  }
  const { typeCount, sampleCount, conditionCount, scope } = payload;
  for (const [name, value] of [
    ['typeCount', typeCount], ['sampleCount', sampleCount], ['conditionCount', conditionCount]
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Composition ${name} must be a positive integer`);
    }
  }
  const typeCodes = payload.typeCodes;
  if (!isCategoricalCodes(typeCodes)) {
    throw new TypeError('Composition type codes must be categorical codes');
  }
  const cellCount = typeCodes.length;
  const typeIndexOfCode = requireCodeMap(payload.typeIndexOfCode, 'Composition type map');
  const hasSamples = payload.sampleCodes !== null;
  const hasConditions = payload.conditionCodes !== null;
  const sampleCodes = hasSamples ? requireCodes(payload.sampleCodes, cellCount, 'Composition sample codes') : null;
  const conditionCodes = hasConditions
    ? requireCodes(payload.conditionCodes, cellCount, 'Composition condition codes')
    : null;
  const sampleIndexOfCode = hasSamples ? requireCodeMap(payload.sampleIndexOfCode, 'Composition sample map') : null;
  const conditionIndexOfCode = hasConditions
    ? requireCodeMap(payload.conditionIndexOfCode, 'Composition condition map')
    : null;
  if (!hasSamples && sampleCount !== 1) throw new RangeError('Composition without samples has one sample');
  if (!hasConditions && conditionCount !== 1) throw new RangeError('Composition without a condition has one condition');
  if (scope !== null && (!(scope instanceof Uint8Array) || scope.length !== cellCount)) {
    throw new TypeError('Composition scope must be null or one byte a cell');
  }

  const unitCount = sampleCount * conditionCount;
  if (!Number.isSafeInteger(typeCount * unitCount)) {
    throw new RangeError('Composition table is too large to address');
  }
  const counts = new Uint32Array(typeCount * unitCount);
  const missingType = missingCategoryCode(typeCodes);
  const missingSample = hasSamples ? missingCategoryCode(sampleCodes) : -1;
  const missingCondition = hasConditions ? missingCategoryCode(conditionCodes) : -1;
  const typeMapLength = typeIndexOfCode.length;
  const sampleMapLength = hasSamples ? sampleIndexOfCode.length : 0;
  const conditionMapLength = hasConditions ? conditionIndexOfCode.length : 0;

  for (let cell = 0; cell < cellCount; cell++) {
    if (scope !== null && scope[cell] === 0) continue;
    const typeCode = typeCodes[cell];
    if (typeCode === missingType || typeCode >= typeMapLength) continue;
    const type = typeIndexOfCode[typeCode];
    if (type < 0) continue;
    let sample = 0;
    if (hasSamples) {
      const code = sampleCodes[cell];
      if (code === missingSample || code >= sampleMapLength) continue;
      sample = sampleIndexOfCode[code];
      if (sample < 0) continue;
    }
    let condition = 0;
    if (hasConditions) {
      const code = conditionCodes[cell];
      if (code === missingCondition || code >= conditionMapLength) continue;
      condition = conditionIndexOfCode[code];
      if (condition < 0) continue;
    }
    counts[type * unitCount + sample * conditionCount + condition] += 1;
  }
  return { counts, typeCount, unitCount };
}

/**
 * The units that have cells, from the counts of every sample × condition
 * pair: in sample, then condition order; a sample with cells in two
 * conditions is two units. The conditions that have cells are renumbered.
 *
 * @param {{counts: Uint32Array, typeCount: number, unitCount: number}} counted
 * @param {number} conditionCount - 1 without a condition.
 * @returns {{counts: Uint32Array, unitCount: number, unitSample: Int32Array, unitCondition: Int32Array, conditions: number[], splitSamples: number[]}}
 *   `unitSample` holds sample indices, `unitCondition` indices into
 *   `conditions` (the original condition indices that have cells);
 *   `splitSamples` the samples counted in more than one condition.
 */
export function presentCompositionUnits(counted, conditionCount) {
  const { counts, typeCount, unitCount } = counted;
  if (!Number.isSafeInteger(conditionCount) || conditionCount < 1 || unitCount % conditionCount !== 0) {
    throw new RangeError('Composition units must be samples × conditions');
  }
  const totals = new Float64Array(unitCount);
  for (let type = 0; type < typeCount; type++) {
    for (let unit = 0; unit < unitCount; unit++) totals[unit] += counts[type * unitCount + unit];
  }
  const kept = [];
  for (let unit = 0; unit < unitCount; unit++) if (totals[unit] > 0) kept.push(unit);
  const conditions = [...new Set(kept.map(unit => unit % conditionCount))].sort((a, b) => a - b);
  const conditionIndex = new Map(conditions.map((condition, index) => [condition, index]));
  const perSample = new Map();
  for (const unit of kept) {
    const sample = Math.floor(unit / conditionCount);
    perSample.set(sample, (perSample.get(sample) ?? 0) + 1);
  }
  const out = new Uint32Array(typeCount * kept.length);
  for (let type = 0; type < typeCount; type++) {
    kept.forEach((unit, column) => { out[type * kept.length + column] = counts[type * unitCount + unit]; });
  }
  return {
    counts: out,
    unitCount: kept.length,
    unitSample: Int32Array.from(kept.map(unit => Math.floor(unit / conditionCount))),
    unitCondition: Int32Array.from(kept.map(unit => conditionIndex.get(unit % conditionCount))),
    conditions,
    splitSamples: [...perSample].filter(([, n]) => n > 1).map(([sample]) => sample).sort((a, b) => a - b)
  };
}
