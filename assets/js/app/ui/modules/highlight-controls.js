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
import { annotationFieldKindForPane } from './highlight/annotation-cells.js';
import { viewerNeedsUiRetirement } from '../core/viewer-lifecycle.js';
import {
  requireDomElement,
  requireViewerHostSource,
  requireMethods,
  requireModeButtons,
  SELECT_MODE_DOM_KEYS,
  pickSelectModeDom,
} from './highlight/exact-contract.js';
import { requireExactKeys } from '../../../utils/exact-record.js';

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
  'clearActivePageHighlights',
  'clearPreviewHighlight',
  'setPreviewHighlightFromIndices',
  'addHighlightDirect',
  'getCellIndicesForCategory',
  'getCellIndicesForRange',
  'getFieldForView',
  'getActiveViewId',
  'on'
]);

const REQUIRED_VIEWER_METHODS = Object.freeze([
  'setViewFieldKindSource',
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
    ['state', 'viewer', 'dom', 'viewerHostSource'],
    'Highlight controls options'
  );
  const { state, viewer, dom, viewerHostSource } = options;
  requireMethods(state, 'Highlight state', REQUIRED_STATE_METHODS);
  requireMethods(viewer, 'Highlight viewer', REQUIRED_VIEWER_METHODS);
  requireViewerHostSource(viewerHostSource);
  requireExactKeys(
    dom,
    [
      'countEls',
      'groupsEl',
      'clearButtons',
      'pagesTabsEl',
      'addPageBtn',
      'modeButtons',
      'modeDescription',
      ...SELECT_MODE_DOM_KEYS
    ],
    'Highlight DOM'
  );
  const {
    groupsEl: highlightedGroupsEl,
    pagesTabsEl: highlightPagesTabsEl,
    addPageBtn: addHighlightPageBtn,
    modeButtons: highlightModeButtons,
    modeDescription: highlightModeDescription
  } = dom;
  requireDomElement(
    highlightedGroupsEl,
    'Highlighted groups element',
    ['appendChild']
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

  const summaryUi = initHighlightSummaryUI({
    state,
    dom: {
      countEls: dom.countEls,
      groupsEl: highlightedGroupsEl,
      clearButtons: dom.clearButtons
    }
  });

  const pagesUi = initHighlightPagesUI({
    state,
    dom: {
      pagesTabsEl: highlightPagesTabsEl,
      addPageBtn: addHighlightPageBtn
    }
  });

  const { renderHighlightSummary } = summaryUi;
  const { renderHighlightPages } = pagesUi;
  const selectionTools = initHighlightSelectionTools({
    state,
    viewer,
    viewerHostSource,
    dom: {
      modeButtons: highlightModeButtons,
      modeDescription: highlightModeDescription,
      ...pickSelectModeDom(dom)
    },
    renderHighlightSummary,
    renderHighlightPages
  });

  let destructionPromise = null;

  // Whether an annotation press can start, and which cursor the armed tool
  // shows, is a question about the pane under the pointer: in a grid every
  // pane may be colored by a different field, or by none, and a selection
  // gesture never moves focus. The renderer therefore reads each pane's field
  // kind from the state at the moment it needs it. There is nothing to
  // publish when a field changes — by any path: the field selector, a
  // dataset's default state, Load State, a viewer host command — and no cached
  // kind that could disagree with the panel's invitation.
  viewer.setViewFieldKindSource(
    viewId => annotationFieldKindForPane(state, viewId)
  );

  function destroy() {
    if (destructionPromise !== null) return destructionPromise;
    const failures = [];
    const pending = [];
    for (const operation of [
      () => {
        // A retired panel must not keep the viewer reading a state it no
        // longer owns.
        if (viewerNeedsUiRetirement(viewer)) {
          viewer.setViewFieldKindSource(() => 'none');
        }
      },
      () => selectionTools.destroy(),
      () => pagesUi.destroy(),
      () => summaryUi.destroy()
    ]) {
      try {
        const result = operation();
        if (
          result !== null
          && typeof result === 'object'
          && typeof result.then === 'function'
        ) {
          pending.push(result);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    destructionPromise = Promise.allSettled(pending).then(outcomes => {
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') failures.push(outcome.reason);
      }
      const exactFailures = [...new Set(failures)];
      if (exactFailures.length === 1) throw exactFailures[0];
      if (exactFailures.length > 1) {
        throw new AggregateError(
          exactFailures,
          'Highlight controls failed to release every owned resource.'
        );
      }
    });
    return destructionPromise;
  }

  return {
    renderHighlightSummary,
    renderHighlightPages,
    destroy
  };
}
