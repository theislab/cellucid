/**
 * @fileoverview Highlight selection → UI/viewer synchronization.
 *
 * Centralizes the bookkeeping that keeps the highlight UI (counts/pages) and
 * the viewer buffers in sync with DataState highlight changes.
 *
 * @module ui/modules/highlight/selection-sync
 */

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {() => void} options.renderHighlightSummary
 * @param {() => void} options.renderHighlightPages
 */
export function initHighlightSelectionSync({ state, viewer, renderHighlightSummary, renderHighlightPages }) {
  const unsubscribeHighlightChanged =
    typeof state.on === 'function'
      ? state.on('highlight:changed', () => {
          renderHighlightSummary();
          renderHighlightPages(); // update page tab counts
          if (viewer.updateHighlight && state.highlightArray) {
            viewer.updateHighlight(state.highlightArray);
          }
        })
      : null;

  const unsubscribePageChanged =
    typeof state.on === 'function'
      ? state.on('page:changed', () => {
          renderHighlightPages();
          renderHighlightSummary();
        })
      : null;

  let lodInterval = null;
  if (viewer.getCurrentLODLevel && viewer.getLodVisibilityArray) {
    let lastHighlightLodLevel = viewer.getCurrentLODLevel();
    lodInterval = setInterval(() => {
      const currentLod = viewer.getCurrentLODLevel();
      if (currentLod === lastHighlightLodLevel) return;
      lastHighlightLodLevel = currentLod;
      if ((state.getHighlightedGroups?.() || []).length > 0) {
        renderHighlightSummary();
      }
    }, 200);
  }

  return {
    destroy: () => {
      unsubscribeHighlightChanged?.();
      unsubscribePageChanged?.();
      if (lodInterval) clearInterval(lodInterval);
    }
  };
}

