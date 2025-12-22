/**
 * @fileoverview Highlight selection UI wiring.
 *
 * Encapsulates the highlight mode toolbelt (annotation/lasso/proximity/knn),
 * highlight page tabs, and selection preview plumbing with the viewer.
 *
 * @module ui/modules/highlight-controls
 */

import { initHighlightPagesUI } from './highlight/highlight-pages-ui.js';
import { initHighlightSelectionTools } from './highlight/highlight-selection-tools.js';
import { initHighlightSummaryUI } from './highlight/highlight-summary-ui.js';

export function initHighlightControls({ state, viewer, dom }) {
  const {
    countEl: highlightCountEl,
    groupsEl: highlightedGroupsEl,
    clearAllBtn: clearAllHighlightsBtn,
    pagesTabsEl: highlightPagesTabsEl,
    addPageBtn: addHighlightPageBtn,
    modeButtons: highlightModeButtons,
    modeDescription: highlightModeDescription
  } = dom || {};

  const { renderHighlightSummary } = initHighlightSummaryUI({
    state,
    dom: {
      countEl: highlightCountEl,
      groupsEl: highlightedGroupsEl,
      clearAllBtn: clearAllHighlightsBtn
    }
  });

  const { renderHighlightPages } = initHighlightPagesUI({
    state,
    dom: {
      pagesTabsEl: highlightPagesTabsEl,
      addPageBtn: addHighlightPageBtn
    }
  });

  initHighlightSelectionTools({
    state,
    viewer,
    dom: {
      modeButtons: highlightModeButtons,
      modeDescription: highlightModeDescription
    },
    renderHighlightSummary,
    renderHighlightPages
  });

  function updateHighlightMode() {
    if (!viewer.setHighlightMode) return;
    const activeField = state.getActiveField ? state.getActiveField() : null;
    if (!activeField) {
      viewer.setHighlightMode('none');
      return;
    }
    if (activeField.kind === 'continuous') {
      viewer.setHighlightMode('continuous');
      return;
    }
    if (activeField.kind === 'category') {
      viewer.setHighlightMode('categorical');
      return;
    }
    viewer.setHighlightMode('none');
  }

  return { renderHighlightSummary, renderHighlightPages, updateHighlightMode };
}

