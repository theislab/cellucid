/**
 * @fileoverview Highlight selection tool system initializer.
 *
 * Composes the mode toolbelt UI + individual selection tools (annotation,
 * lasso, proximity, KNN) and connects their events to DataState + viewer.
 *
 * @module ui/modules/highlight/highlight-selection-tools
 */

import { getSelectionRangeLabel } from '../../core/selection-range-label.js';
import { createHighlightSelectionState } from './selection-state.js';
import { initHighlightSelectionSync } from './selection-sync.js';
import { initHighlightModeUI } from './mode-ui.js';
import { initAnnotationSelection } from './annotation-selection.js';
import { initLassoSelection } from './lasso-selection.js';
import { initProximitySelection } from './proximity-selection.js';
import { initKnnSelection } from './knn-selection.js';
import { initContinuousSelectionPreview } from './continuous-selection-preview.js';
import {
  requireCallback,
  requireDomElement,
  requireExactKeys,
  requireJupyterSource,
  requireMethods,
  requireModeButtons
} from './exact-contract.js';

const REQUIRED_SELECTION_STATE_METHODS = Object.freeze([
  'addHighlightDirect',
  'clearPreviewHighlight',
  'getActiveField',
  'getActiveViewId',
  'getCategoryForCell',
  'getCellIndicesForCategory',
  'getCellIndicesForRange',
  'getHighlightedGroups',
  'getValueForCell',
  'on',
  'setPreviewHighlightFromIndices'
]);

const REQUIRED_SELECTION_VIEWER_METHODS = Object.freeze([
  'cancelAnnotationSelection',
  'cancelKnnSelection',
  'cancelLassoSelection',
  'cancelProximitySelection',
  'cancelUnifiedSelection',
  'confirmAnnotationSelection',
  'confirmKnnSelection',
  'confirmLassoSelection',
  'confirmProximitySelection',
  'getUnifiedSelectionState',
  'getViewTransparency',
  'onLodChanged',
  'restoreKnnState',
  'restoreLassoState',
  'restoreProximityState',
  'restoreUnifiedState',
  'setKnnCallback',
  'setKnnEnabled',
  'setKnnPreviewCallback',
  'setKnnStepCallback',
  'setLassoCallback',
  'setLassoEnabled',
  'setLassoPreviewCallback',
  'setLassoStepCallback',
  'setProximityCallback',
  'setProximityEnabled',
  'setProximityPreviewCallback',
  'setProximityStepCallback',
  'setSelectionPreviewCallback',
  'setSelectionStepCallback',
  'updateHighlight'
]);

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {any|null} [options.jupyterSource]
 * @param {object} [options.dom]
 * @param {HTMLElement|HTMLElement[]|null} [options.dom.modeButtons]
 * @param {HTMLElement|null} [options.dom.modeDescription]
 * @param {() => void} options.renderHighlightSummary
 * @param {() => void} options.renderHighlightPages
 */
export function initHighlightSelectionTools(options) {
  requireExactKeys(
    options,
    [
      'state',
      'viewer',
      'jupyterSource',
      'dom',
      'renderHighlightSummary',
      'renderHighlightPages'
    ],
    'Highlight selection tools options'
  );
  const {
    state,
    viewer,
    jupyterSource,
    dom,
    renderHighlightSummary,
    renderHighlightPages
  } = options;
  requireMethods(
    state,
    'Highlight selection state owner',
    REQUIRED_SELECTION_STATE_METHODS
  );
  requireMethods(
    viewer,
    'Highlight selection viewer',
    REQUIRED_SELECTION_VIEWER_METHODS
  );
  requireJupyterSource(jupyterSource);
  requireCallback(renderHighlightSummary, 'Highlight summary renderer');
  requireCallback(renderHighlightPages, 'Highlight pages renderer');
  requireExactKeys(
    dom,
    ['modeButtons', 'modeDescription'],
    'Highlight selection DOM'
  );
  requireModeButtons(dom.modeButtons);
  requireDomElement(
    dom.modeDescription,
    'Highlight mode description'
  );
  requireDomElement(
    dom.modeDescription.parentElement,
    'Highlight mode description parent',
    ['appendChild']
  );
  const selectionState = createHighlightSelectionState();

  const { show: showRangeLabel, hide: hideRangeLabel } = getSelectionRangeLabel();

  const ui = {
    modeDescriptionEl: dom.modeDescription,
    showRangeLabel,
    hideRangeLabel
  };

  const annotation = initAnnotationSelection({
    state,
    viewer,
    jupyterSource,
    selectionState,
    ui: {
      modeDescriptionEl: ui.modeDescriptionEl,
      hideRangeLabel: ui.hideRangeLabel
    }
  });

  const lasso = initLassoSelection({
    state,
    viewer,
    jupyterSource,
    selectionState,
    ui: { modeDescriptionEl: ui.modeDescriptionEl }
  });

  const proximity = initProximitySelection({
    state,
    viewer,
    jupyterSource,
    selectionState,
    ui: { modeDescriptionEl: ui.modeDescriptionEl }
  });

  const knn = initKnnSelection({
    state,
    viewer,
    jupyterSource,
    selectionState,
    ui: { modeDescriptionEl: ui.modeDescriptionEl }
  });

  initContinuousSelectionPreview({
    state,
    viewer,
    selectionState,
    ui: { showRangeLabel: ui.showRangeLabel, hideRangeLabel: ui.hideRangeLabel }
  });

  const sync = initHighlightSelectionSync({
    state,
    viewer,
    renderHighlightSummary,
    renderHighlightPages
  });

  const modeUi = initHighlightModeUI({
    viewer,
    dom: {
      modeButtons: dom.modeButtons,
      modeDescription: ui.modeDescriptionEl
    },
    selectionState,
    modeHandlers: {
      restoreAnnotationSelection: annotation.restoreAnnotationSelection,
      restoreLassoSelection: lasso.restoreLassoSelection,
      restoreProximitySelection: proximity.restoreProximitySelection,
      restoreKnnSelection: knn.restoreKnnSelection
    }
  });

  return {
    selectionState,
    modeUi,
    destroy: () => {
      sync.destroy();
    }
  };
}
