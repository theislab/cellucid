/**
 * @fileoverview The cells a figure draws at a reduced level of detail.
 *
 * The viewer publishes a view's level as the renderer's `LodMembership`
 * (`rendering/high-perf/renderer-contracts.js`): its count, and its cells by
 * admission level or as the first `count` cells. A figure iterates the cells
 * it draws in the order the pane draws them, so the export engine makes its
 * own copy of that record naming them (`ownedLodMembership`: `indices`, one
 * Uint32Array in draw order). Sequential export work then scales with the K
 * drawn cells rather than all N.
 *
 * `null` is full detail.
 *
 * @module ui/modules/figure-export/utils/lod-membership
 */

import { requireLodMembership } from '../../../../../rendering/high-perf/renderer-contracts.js';

export {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from '../../../../../rendering/alpha-visibility.js';
import { BENEATH_ALPHA_BYTE, UNREAD_ALPHA_BYTE, colorLayersOf } from '../../../../../rendering/alpha-visibility.js';
import { allocateLargeArray } from '../../../../../utils/large-arrays.js';
import { unreadCellColor, zeroCellColor } from '../../../../../rendering/read-cell-layer.js';

/**
 * Validate and return a figure's LOD record: a `LodMembership` that names
 * its drawn cells (`indices`), as `ownedLodMembership` makes it. A boundary
 * check rather than a per-point helper: hot loops cache `indices` after it
 * returns.
 *
 * @param {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null} membership
 * @param {object} [expected]
 * @param {number|null} [expected.pointCount] - Null: the record's own.
 * @param {number|null} [expected.dimensionLevel]
 * @param {string} [expected.label]
 * @returns {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null}
 */
export function assertLodMembership(
  membership,
  {
    pointCount = null,
    dimensionLevel = null,
    label = 'Figure-export LOD membership',
  } = {}
) {
  return requireLodMembership(membership, {
    pointCount: pointCount ?? membership?.pointCount,
    dimensionLevel,
    requireIndices: true,
    owner: label,
  });
}

/**
 * A figure's own copy of the level a view draws, from the renderer's record
 * (`LodMembership`) and the view's full-detail draw order
 * (`getViewDrawOrder`, null for source order): the same record, naming the
 * level's cells in the order the pane draws them (`indices`, copied). A
 * tree's level names them; a level drawn by rank is the first `count` slots
 * of the store, in its order. The admission bytes, immutable, are shared.
 *
 * @param {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null} membership
 * @param {Uint32Array|null} drawOrder
 * @param {{pointCount: number, dimensionLevel: number, label: string}} expected
 * @returns {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null}
 */
export function ownedLodMembership(membership, drawOrder, { pointCount, dimensionLevel, label }) {
  const exact = requireLodMembership(membership, { pointCount, dimensionLevel, owner: label });
  if (exact === null) return null;
  const order = assertDrawOrder(drawOrder, { pointCount, label: `${label} draw order` });
  let indices;
  if (exact.indices !== null) {
    indices = new Uint32Array(exact.indices);
  } else if (order !== null) {
    indices = order.slice(0, exact.count);
  } else {
    indices = new Uint32Array(exact.count);
    for (let cell = 0; cell < exact.count; cell++) indices[cell] = cell;
  }
  return Object.freeze({
    admissionLevels: exact.admissionLevels,
    count: exact.count,
    dimensionLevel: exact.dimensionLevel,
    generationToken: Object.freeze({}),
    indices,
    lodLevel: exact.lodLevel,
    pointCount: exact.pointCount,
  });
}

/**
 * Compare one lightweight presented LOD certificate with the exact borrowed
 * renderer membership without exposing either admitted-index owner.
 *
 * @param {object|null} presented
 * @param {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null} membership
 * @returns {boolean}
 */
export function matchesLodMembershipPresentation(
  presented,
  membership
) {
  if (presented === null || membership === null) {
    return presented === null && membership === null;
  }
  return (
    typeof presented === 'object' &&
    !Array.isArray(presented) &&
    Object.isFrozen(presented) &&
    Number.isSafeInteger(presented.admittedCount) &&
    presented.admittedCount === membership.count &&
    presented.dimensionLevel === membership.dimensionLevel &&
    presented.generationToken === membership.generationToken &&
    presented.lodLevel === membership.lodLevel &&
    presented.pointCount === membership.pointCount
  );
}

/**
 * Assert one view's full-detail draw order: null (the view draws in source
 * order) or a Uint32Array holding every source index once, in the order the
 * renderer stores and draws the view's points (`getViewDrawOrder`).
 *
 * @param {unknown} drawOrder
 * @param {{ pointCount: number, label?: string }} options
 * @returns {Uint32Array|null}
 */
export function assertDrawOrder(drawOrder, { pointCount, label = 'Figure export draw order' }) {
  if (drawOrder === null) return null;
  if (!(drawOrder instanceof Uint32Array) || drawOrder.length !== pointCount) {
    throw new TypeError(`${label} must be null or a Uint32Array of ${pointCount} source indices.`);
  }
  return drawOrder;
}

/**
 * The source indices a figure draws, in the order the pane draws them: the
 * admitted prefix of a reduced LOD level, else the full draw order, else
 * null for every point in source order. Order matters wherever translucent
 * points overlap, so every point pass and vector writer iterates this.
 *
 * With `colors` layering the cells (`alpha-visibility.js`), the layers come
 * bottom first, each in that order, as the pane draws them a pass a layer:
 * the cells not read (`UNREAD_ALPHA_BYTE`), the grey beneath
 * (`BENEATH_ALPHA_BYTE`), the coloured cells. When the pane drew the cells
 * read at every level (`readEveryLevel`, `rendering/read-cell-layer.js`),
 * the read layers hold every read cell of the full draw order, not only the
 * level's.
 *
 * @param {import('../../../../../rendering/high-perf/renderer-contracts.js').LodMembership|null} lodMembership
 * @param {Uint32Array|null} drawOrder
 * @param {Uint8Array|null} [colors]
 * @param {boolean} [readEveryLevel]
 * @returns {Uint32Array|null}
 */
export function drawnSequence(lodMembership, drawOrder, colors = null, readEveryLevel = false) {
  const sequence = lodMembership?.indices ?? drawOrder ?? null;
  if (colors === null) return sequence;
  const layers = colorLayersOf(colors);
  if (!layers.layered) return sequence;
  const readSequence = layers.unread > 0 && readEveryLevel && lodMembership !== null ? drawOrder : sequence;
  const count = sequence === null ? colors.length >>> 2 : sequence.length;
  const readSequenceCount = readSequence === null ? colors.length >>> 2 : readSequence.length;
  let unread = 0;
  for (let k = 0; k < count; k++) {
    if (colors[(sequence === null ? k : sequence[k]) * 4 + 3] === UNREAD_ALPHA_BYTE) unread++;
  }
  let read = readSequenceCount;
  if (readSequence !== sequence || layers.unread > 0) {
    read = 0;
    for (let k = 0; k < readSequenceCount; k++) {
      if (colors[(readSequence === null ? k : readSequence[k]) * 4 + 3] !== UNREAD_ALPHA_BYTE) read++;
    }
  }
  const layered = allocateLargeArray(Uint32Array, unread + read);
  let at = 0;
  const take = (from, fromCount, byte) => {
    for (let k = 0; k < fromCount; k++) {
      const cell = from === null ? k : from[k];
      if (colors[cell * 4 + 3] === byte) layered[at++] = cell;
    }
  };
  take(sequence, count, UNREAD_ALPHA_BYTE);
  take(readSequence, readSequenceCount, BENEATH_ALPHA_BYTE);
  // Every other byte is drawn on top (255).
  for (let k = 0; k < readSequenceCount; k++) {
    const cell = readSequence === null ? k : readSequence[k];
    const byte = colors[cell * 4 + 3];
    if (byte !== UNREAD_ALPHA_BYTE && byte !== BENEATH_ALPHA_BYTE) layered[at++] = cell;
  }
  return layered;
}

/**
 * How a figure draws the layers of its cells (`rendering/read-cell-layer.js`)
 * when any cell lies below the top layer: the colour the grey of the cells
 * with no value is drawn in and the colour the cells not read are drawn in
 * (both from the figure's own background, `zeroCellColor`,
 * `unreadCellColor`, channels 0..1), and, while some cells are not read, the
 * read cells' size over the others' (`readScale`, the pane's) and whether the
 * pane drew every read cell whatever its level (1 and false when every cell
 * is read).
 *
 * @typedef {{readScale: number, readEveryLevel: boolean, unreadColor: number[], zeroColor: number[]}} FigurePointLayers
 */

/**
 * Check a figure's point layers (`FigurePointLayers`), or null (every cell
 * read, drawn at one size).
 *
 * @param {unknown} layers
 * @param {string} label
 * @returns {FigurePointLayers|null}
 */
export function requireFigurePointLayers(layers, label) {
  if (layers === null) return null;
  if (
    typeof layers !== 'object'
    || !(Number.isFinite(layers.readScale) && layers.readScale >= 1)
    || typeof layers.readEveryLevel !== 'boolean'
    || !Array.isArray(layers.unreadColor)
    || layers.unreadColor.length !== 3
    || !layers.unreadColor.every(channel => channel >= 0 && channel <= 1)
    || !Array.isArray(layers.zeroColor)
    || layers.zeroColor.length !== 3
    || !layers.zeroColor.every(channel => channel >= 0 && channel <= 1)
  ) {
    throw new TypeError(`${label} must be null or {readScale >= 1, readEveryLevel, unreadColor, zeroColor: three channels 0..1 each}.`);
  }
  return layers;
}

/**
 * A panel's point layers as its figure draws them (`FigurePointLayers`), or
 * null when every cell of `colors` is on the top layer: the colours of the
 * grey beneath and of the cells not read made from the figure's own
 * background, and, while some cells are not read, the pane's read-cell size
 * and levels (`scientificState.pointLayers`).
 *
 * @param {Uint8Array|null} colors
 * @param {{readScale: number, readEveryLevel: boolean}} pointLayers
 * @param {ArrayLike<number>} background - sRGB, channels 0..1
 * @returns {FigurePointLayers|null}
 */
export function figurePointLayersOf(colors, pointLayers, background) {
  if (colors === null) return null;
  const { layered, unread } = colorLayersOf(colors);
  if (!layered) return null;
  return requireFigurePointLayers({
    readScale: unread > 0 ? pointLayers.readScale : 1,
    readEveryLevel: unread > 0 && pointLayers.readEveryLevel,
    unreadColor: Array.from(unreadCellColor(background)),
    zeroColor: Array.from(zeroCellColor(background)),
  }, 'Figure point layers');
}
