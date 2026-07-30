/**
 * @fileoverview Event-driven highlight UI/viewer synchronization.
 *
 * @module ui/modules/highlight/selection-sync
 */

import {
  requireCallback,
  requireExactKeys,
  requireLodChangeEvent,
  requireMethods
} from './exact-contract.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {() => void} options.renderHighlightSummary
 * @param {() => void} options.renderHighlightPages
 */
export function initHighlightSelectionSync(options) {
  requireExactKeys(
    options,
    [
      'state',
      'viewer',
      'renderHighlightSummary',
      'renderHighlightPages'
    ],
    'Highlight selection synchronization options'
  );
  const {
    state,
    viewer,
    renderHighlightSummary,
    renderHighlightPages
  } = options;
  requireMethods(
    state,
    'Highlight synchronization state',
    ['getActiveViewId', 'getHighlightedGroups', 'on']
  );
  requireMethods(
    viewer,
    'Highlight synchronization viewer',
    ['onLodChanged']
  );
  requireCallback(renderHighlightSummary, 'Highlight summary renderer');
  requireCallback(renderHighlightPages, 'Highlight pages renderer');

  let destroyed = false;
  const unsubscribeHighlightChanged = state.on(
    'highlight:changed',
    () => {
      if (destroyed) return;
      if (!(state.highlightArray instanceof Uint8Array)) {
        throw new TypeError(
          'Highlight state must publish a Uint8Array highlightArray.'
        );
      }
      renderHighlightSummary();
      renderHighlightPages();
    }
  );
  requireCallback(
    unsubscribeHighlightChanged,
    'Highlight change unsubscribe'
  );

  const unsubscribePageChanged = state.on('page:changed', () => {
    if (destroyed) return;
    renderHighlightPages();
    renderHighlightSummary();
  });
  requireCallback(unsubscribePageChanged, 'Highlight page unsubscribe');

  const unsubscribeLodChanged = viewer.onLodChanged(event => {
    if (destroyed) return;
    requireLodChangeEvent(event);
    if (event.viewId !== state.getActiveViewId()) return;
    const groups = state.getHighlightedGroups();
    if (!Array.isArray(groups)) {
      throw new TypeError('Highlighted groups must be an array.');
    }
    if (groups.length > 0) renderHighlightSummary();
  });
  requireCallback(unsubscribeLodChanged, 'Highlight LOD unsubscribe');

  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      const failures = [];
      for (const unsubscribe of [
        unsubscribeHighlightChanged,
        unsubscribePageChanged,
        unsubscribeLodChanged
      ]) {
        try {
          unsubscribe();
        } catch (error) {
          failures.push(error);
        }
      }
      const exactFailures = [...new Set(failures)];
      if (exactFailures.length === 1) throw exactFailures[0];
      if (exactFailures.length > 1) {
        throw new AggregateError(
          exactFailures,
          'Highlight synchronization failed to release every subscription.'
        );
      }
    }
  };
}
