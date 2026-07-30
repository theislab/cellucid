/**
 * @fileoverview Helpers for matching point size to the interactive viewer.
 *
 * The interactive viewer may apply a per-LOD size multiplier so that density
 * reduction keeps visual coverage consistent. For WYSIWYG figure export we
 * must apply the same multiplier, otherwise exported dots will not match the
 * on-screen appearance.
 *
 * @module ui/modules/figure-export/utils/point-size
 */

import { isFiniteNumber, clamp } from '../../../../utils/number-utils.js';
import { assertLodMembership } from './lod-membership.js';

function getHPRenderer(viewer) {
  return typeof viewer?.getHPRenderer === 'function' ? viewer.getHPRenderer() : null;
}

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {string|number|null} options.viewId
 * @param {number} [options.dimensionLevel]
 * @returns {number}
 */
export function getLodSizeMultiplier({ viewer, viewId, dimensionLevel }) {
  const hp = getHPRenderer(viewer);
  if (!hp || typeof hp.getCurrentLODSizeMultiplier !== 'function') return 1.0;
  const mult = hp.getCurrentLODSizeMultiplier(viewId != null ? String(viewId) : undefined, dimensionLevel);
  return isFiniteNumber(mult) && mult > 0 ? clamp(mult, 0.01, 100) : 1.0;
}

/**
 * Compute effective point DIAMETER (in the viewer's logical pixel units).
 *
 * @param {object} options
 * @param {object} options.viewer
 * @param {object|null} options.renderState
 * @param {string|number|null} options.viewId
 * @param {number} [options.dimensionLevel]
 * @returns {number}
 */
export function getEffectivePointDiameterPx({ viewer, renderState, viewId, dimensionLevel }) {
  const base = renderState?.pointSize;
  const basePx = isFiniteNumber(base) && base > 0 ? base : 5.0;
  const mult = getLodSizeMultiplier({ viewer, viewId, dimensionLevel });
  return basePx * mult;
}

/**
 * Compute effective point RADIUS (in the viewer's logical pixel units).
 *
 * @param {object} options
 * @param {object} options.viewer
 * @param {object|null} options.renderState
 * @param {string|number|null} options.viewId
 * @param {number} [options.dimensionLevel]
 * @returns {number}
 */
export function getEffectivePointRadiusPx({ viewer, renderState, viewId, dimensionLevel }) {
  return getEffectivePointDiameterPx({ viewer, renderState, viewId, dimensionLevel }) / 2;
}

/**
 * Immutable LOD admission descriptor for the current view.
 *
 * `null` means full detail. Alpha/filter visibility remains independently owned
 * by transparency and the alpha threshold.
 *
 * @param {object} options
 * @param {object} options.viewer
 * @param {string|number|null} options.viewId
 * @param {number} [options.dimensionLevel]
 * @returns {import('./lod-membership.js').LodMembership|null}
 */
export function getLodMembership({ viewer, viewId, dimensionLevel }) {
  if (typeof viewer?.getCurrentLodMembership !== 'function') {
    throw new TypeError(
      'Figure export requires viewer.getCurrentLodMembership().'
    );
  }
  const membership = viewer.getCurrentLodMembership(
    viewId != null ? String(viewId) : undefined,
    dimensionLevel
  );
  return assertLodMembership(membership, { dimensionLevel });
}
