/**
 * DE Adapter (Marker-style backend)
 *
 * Builds a 2-group categorical context so DE can reuse the marker worker ops:
 * - broadcast MARKERS_SET_CONTEXT once per run
 * - per gene: send raw per-cell values and read group 0 stats as A vs B
 *
 * NOTE: Cells not in A or B are marked as "ignore".
 */

/**
 * @typedef {Object} DEGroupSpec
 * @property {'explicit'|'rest_of'} kind
 * @property {string} pageId
 * @property {string} pageName
 * @property {number[]|Uint32Array} [cellIndices]
 * @property {number[]|Uint32Array} [excludedCellIndices]
 */

const IGNORE_CODE = 65535;

function markExplicit(mask, indices) {
  if (!indices || indices.length === 0) return;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx >= 0 && idx < mask.length) mask[idx] = 1;
  }
}

function markRestOf(mask, totalCells, excludedCellIndices) {
  mask.fill(1);
  if (!excludedCellIndices || excludedCellIndices.length === 0) return;
  for (let i = 0; i < excludedCellIndices.length; i++) {
    const idx = excludedCellIndices[i];
    if (idx >= 0 && idx < totalCells) mask[idx] = 0;
  }
}

/**
 * Convert the DE group specs to a marker-style categorical code array.
 *
 * Code meanings:
 * - 0: group A
 * - 1: group B
 * - 65535: ignore (in neither group)
 *
 * @param {Object} options
 * @param {DEGroupSpec} options.groupA
 * @param {DEGroupSpec} options.groupB
 * @param {number} options.totalCells
 * @returns {{ obsCodes: Uint16Array, groupASize: number, groupBSize: number }}
 */
export function buildDEObsCodes({ groupA, groupB, totalCells }) {
  const n = Number.isFinite(totalCells) ? Math.max(0, Math.floor(totalCells)) : 0;
  if (n <= 0) throw new Error('[DEAdapter] totalCells is required');

  const aMask = new Uint8Array(n);
  const bMask = new Uint8Array(n);

  if (groupA?.kind === 'rest_of') {
    markRestOf(aMask, n, groupA.excludedCellIndices);
  } else {
    markExplicit(aMask, groupA?.cellIndices);
  }

  if (groupB?.kind === 'rest_of') {
    markRestOf(bMask, n, groupB.excludedCellIndices);
  } else {
    markExplicit(bMask, groupB?.cellIndices);
  }

  const obsCodes = new Uint16Array(n);
  obsCodes.fill(IGNORE_CODE);

  let groupASize = 0;
  let groupBSize = 0;

  for (let i = 0; i < n; i++) {
    const inA = aMask[i] === 1;
    const inB = bMask[i] === 1;
    if (inA && inB) {
      throw new Error(`[DEAdapter] Groups overlap at cell index ${i} (${groupA?.pageName || 'A'} vs ${groupB?.pageName || 'B'})`);
    }
    if (inA) {
      obsCodes[i] = 0;
      groupASize++;
    } else if (inB) {
      obsCodes[i] = 1;
      groupBSize++;
    }
  }

  return { obsCodes, groupASize, groupBSize };
}

export const DE_MARKER_CONTEXT = Object.freeze({
  IGNORE_CODE
});

