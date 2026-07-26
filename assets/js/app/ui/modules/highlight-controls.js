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
import {
  requireDomElement,
  requireExactKeys,
  requireJupyterSource,
  requireMethods,
  requireModeButtons
} from './highlight/exact-contract.js';

const REQUIRED_STATE_METHODS = Object.freeze([
  'getActiveField',
  'getHighlightPages',
  'getActivePageId',
  'getHighlightedCellCountForPage',
  'combineHighlightPages',
  'switchToPage',
  'renameHighlightPage',
  'deleteHighlightPage',
  'setHighlightPageColor',
  'createHighlightPage',
  'ensureHighlightPage',
  'getHighlightedGroups',
  'getHighlightedCellCount',
  'getTotalHighlightedCellCount',
  'toggleHighlightEnabled',
  'removeHighlightGroup',
  'clearAllHighlights',
  'clearPreviewHighlight',
  'setPreviewHighlightFromIndices',
  'addHighlightDirect',
  'getCategoryForCell',
  'getCellIndicesForCategory',
  'getValueForCell',
  'getCellIndicesForRange',
  'getActiveViewId',
  'on'
]);

const REQUIRED_VIEWER_METHODS = Object.freeze([
  'setHighlightMode',
  'getViewTransparency',
  'setSelectionStepCallback',
  'setSelectionPreviewCallback',
  'restoreUnifiedState',
  'confirmAnnotationSelection',
  'cancelAnnotationSelection',
  'getUnifiedSelectionState',
  'cancelUnifiedSelection',
  'setLassoEnabled',
  'setLassoCallback',
  'setLassoPreviewCallback',
  'setLassoStepCallback',
  'restoreLassoState',
  'confirmLassoSelection',
  'cancelLassoSelection',
  'setProximityEnabled',
  'setProximityCallback',
  'setProximityStepCallback',
  'setProximityPreviewCallback',
  'restoreProximityState',
  'confirmProximitySelection',
  'cancelProximitySelection',
  'setKnnEnabled',
  'setKnnCallback',
  'setKnnStepCallback',
  'setKnnPreviewCallback',
  'restoreKnnState',
  'confirmKnnSelection',
  'cancelKnnSelection',
  'updateHighlight',
  'onLodChanged'
]);

export function initHighlightControls(options) {
  requireExactKeys(
    options,
    ['state', 'viewer', 'dom', 'jupyterSource'],
    'Highlight controls options'
  );
  const { state, viewer, dom, jupyterSource } = options;
  requireMethods(state, 'Highlight state', REQUIRED_STATE_METHODS);
  requireMethods(viewer, 'Highlight viewer', REQUIRED_VIEWER_METHODS);
  requireJupyterSource(jupyterSource);
  requireExactKeys(
    dom,
    [
      'countEl',
      'groupsEl',
      'clearAllBtn',
      'pagesTabsEl',
      'addPageBtn',
      'modeButtons',
      'modeDescription'
    ],
    'Highlight DOM'
  );
  const {
    countEl: highlightCountEl,
    groupsEl: highlightedGroupsEl,
    clearAllBtn: clearAllHighlightsBtn,
    pagesTabsEl: highlightPagesTabsEl,
    addPageBtn: addHighlightPageBtn,
    modeButtons: highlightModeButtons,
    modeDescription: highlightModeDescription
  } = dom;
  requireDomElement(highlightCountEl, 'Highlight count element');
  requireDomElement(
    highlightedGroupsEl,
    'Highlighted groups element',
    ['appendChild']
  );
  requireDomElement(
    clearAllHighlightsBtn,
    'Clear highlights button',
    ['addEventListener']
  );
  requireDomElement(
    highlightPagesTabsEl,
    'Highlight pages tabs element',
    ['appendChild', 'querySelectorAll']
  );
  requireDomElement(
    addHighlightPageBtn,
    'Add highlight page button',
    ['addEventListener']
  );
  requireModeButtons(highlightModeButtons);
  requireDomElement(
    highlightModeDescription,
    'Highlight mode description element'
  );
  requireDomElement(
    highlightModeDescription.parentElement,
    'Highlight mode description parent',
    ['appendChild']
  );

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
    jupyterSource,
    dom: {
      modeButtons: highlightModeButtons,
      modeDescription: highlightModeDescription
    },
    renderHighlightSummary,
    renderHighlightPages
  });

  function updateHighlightMode() {
    const activeField = state.getActiveField();
    if (activeField === null) {
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
    throw new TypeError(
      `Unknown active highlight field kind: ${activeField.kind}.`
    );
  }

  return { renderHighlightSummary, renderHighlightPages, updateHighlightMode };
}
