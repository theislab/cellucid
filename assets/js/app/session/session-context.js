/**
 * @fileoverview Session serializer context construction helpers.
 *
 * Contributors receive a small `ctx` object so they can capture/restore
 * feature-owned state without the orchestrator knowing any feature internals.
 *
 * @module session/session-context
 */

import { getNotificationCenter } from '../notification-center.js';
import { getDockableAccordions } from '../dockable-accordions-registry.js';

/**
 * @typedef {object} SessionContextBase
 * @property {import('../state/core/data-state.js').DataState} state
 * @property {object} viewer
 * @property {HTMLElement|null} sidebar
 * @property {import('../../data/data-source-manager.js').DataSourceManager|null} dataSourceManager
 * @property {any|null} comparisonModule
 * @property {any|null} analysisWindowManager
 */

/**
 * Build the context passed to all contributors.
 *
 * @param {SessionContextBase} base
 * @param {{ abortSignal?: AbortSignal | null }} [options]
 * @returns {object}
 */
export function buildSessionContext(base, options = {}) {
  return {
    state: base.state,
    viewer: base.viewer,
    sidebar: base.sidebar || document.getElementById('sidebar'),
    dataSourceManager: base.dataSourceManager || null,
    dockableAccordions: getDockableAccordions(),
    comparisonModule: base.comparisonModule || null,
    analysisWindowManager: base.analysisWindowManager || null,
    notifications: getNotificationCenter(),
    abortSignal: options.abortSignal ?? null
  };
}

/**
 * Create a dataset fingerprint for dev-phase safety checks.
 *
 * Minimum fields (per plan): { sourceType, datasetId }
 * Recommended: include fast mismatch guards (cellCount, varCount).
 *
 * @param {object} ctx
 * @returns {{ sourceType: string|null, datasetId: string|null, cellCount?: number, varCount?: number }}
 */
export function getDatasetFingerprint(ctx) {
  const sourceType = ctx?.dataSourceManager?.getCurrentSourceType?.() ?? null;
  const datasetId = ctx?.dataSourceManager?.getCurrentDatasetId?.() ?? null;

  const cellCount = typeof ctx?.state?.pointCount === 'number' ? ctx.state.pointCount : undefined;
  const varCount = typeof ctx?.state?.varData?.fields?.length === 'number' ? ctx.state.varData.fields.length : undefined;

  /** @type {{ sourceType: string|null, datasetId: string|null, cellCount?: number, varCount?: number }} */
  const fp = { sourceType, datasetId };
  if (typeof cellCount === 'number') fp.cellCount = cellCount;
  if (typeof varCount === 'number') fp.varCount = varCount;
  return fp;
}

/**
 * Compare two dataset fingerprints.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function datasetFingerprintMatches(a, b) {
  if (!a || !b) return false;
  if (a.sourceType !== b.sourceType) return false;
  if (a.datasetId !== b.datasetId) return false;
  if (typeof a.cellCount === 'number' && typeof b.cellCount === 'number' && a.cellCount !== b.cellCount) return false;
  if (typeof a.varCount === 'number' && typeof b.varCount === 'number' && a.varCount !== b.varCount) return false;
  return true;
}

