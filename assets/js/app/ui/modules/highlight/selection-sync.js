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
    ['onLodChanged', 'updateHighlight']
  );
  requireCallback(renderHighlightSummary, 'Highlight summary renderer');
  requireCallback(renderHighlightPages, 'Highlight pages renderer');

  const unsubscribeHighlightChanged = state.on(
    'highlight:changed',
    () => {
      if (!(state.highlightArray instanceof Uint8Array)) {
        throw new TypeError(
          'Highlight state must publish a Uint8Array highlightArray.'
        );
      }
      renderHighlightSummary();
      renderHighlightPages();
      viewer.updateHighlight(state.highlightArray);
    }
  );
  requireCallback(
    unsubscribeHighlightChanged,
    'Highlight change unsubscribe'
  );

  const unsubscribePageChanged = state.on('page:changed', () => {
    renderHighlightPages();
    renderHighlightSummary();
  });
  requireCallback(unsubscribePageChanged, 'Highlight page unsubscribe');

  const unsubscribeLodChanged = viewer.onLodChanged(event => {
    requireLodChangeEvent(event);
    if (event.viewId !== state.getActiveViewId()) return;
    const groups = state.getHighlightedGroups();
    if (!Array.isArray(groups)) {
      throw new TypeError('Highlighted groups must be an array.');
    }
    if (groups.length > 0) renderHighlightSummary();
  });
  requireCallback(unsubscribeLodChanged, 'Highlight LOD unsubscribe');

  let destroyed = false;
  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      unsubscribeHighlightChanged();
      unsubscribePageChanged();
      unsubscribeLodChanged();
    }
  };
}
