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
  requireCallback,
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
  'getHighlightMode',
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

  const summaryUi = initHighlightSummaryUI({
    state,
    dom: {
      countEl: highlightCountEl,
      groupsEl: highlightedGroupsEl,
      clearAllBtn: clearAllHighlightsBtn
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
    jupyterSource,
    dom: {
      modeButtons: highlightModeButtons,
      modeDescription: highlightModeDescription
    },
    renderHighlightSummary,
    renderHighlightPages
  });

  let destroyed = false;
  let destructionPromise = null;

  /**
   * The renderer's highlight mode implied by the field the app is colouring by.
   *
   * @returns {'none'|'continuous'|'categorical'}
   */
  function highlightModeForActiveField() {
    const activeField = state.getActiveField();
    if (activeField === null) return 'none';
    if (activeField.kind === 'continuous') return 'continuous';
    if (activeField.kind === 'category') return 'categorical';
    throw new TypeError(
      `Unknown active highlight field kind: ${activeField.kind}.`
    );
  }

  /**
   * Publish the mode the current active field implies, if it is not already
   * the one the renderer holds.
   *
   * Republishing a mode the renderer already has is not free: `setHighlightMode`
   * drops `selectionDragStart` and resets the renderer's annotation step
   * counter, so a gesture in the user's hand would be thrown away by an
   * unrelated filter change. Comparing first is what makes this safe to run on
   * every visibility event, and it reads the renderer rather than a local copy
   * so a divergence from any source is corrected rather than assumed absent.
   */
  function updateHighlightMode() {
    if (destroyed) return;
    const mode = highlightModeForActiveField();
    if (viewer.getHighlightMode() === mode) return;
    viewer.setHighlightMode(mode);
  }

  // The renderer's highlight mode is a cache of the active field's kind: with
  // no field, `handleMouseDown` discards every Alt gesture before any tool sees
  // it. Nothing in DataState announces "the active field changed", but
  // `setActiveField`, `setActiveVarField` and `clearActiveField` all run
  // `computeGlobalVisibility()`, which ends in `visibility:changed` — the same
  // signal `annotation-selection.js` already follows to decide whether the
  // panel may invite a click. Following it here too is what keeps the invitation
  // and the renderer from disagreeing: every path that activates a field
  // reaches this, including the ones that bypass the field selector's change
  // event (a published dataset's default state, a loaded session, a Jupyter
  // command), which is where the panel used to promise a gesture the renderer
  // then dropped in silence.
  const unsubscribeVisibility = state.on(
    'visibility:changed',
    updateHighlightMode
  );
  requireCallback(
    unsubscribeVisibility,
    'Highlight mode visibility unsubscribe'
  );

  function destroy() {
    if (destructionPromise !== null) return destructionPromise;
    destroyed = true;
    const failures = [];
    const pending = [];
    for (const operation of [
      () => unsubscribeVisibility(),
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
    updateHighlightMode,
    destroy
  };
}
