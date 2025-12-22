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

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {object} [options.dom]
 * @param {HTMLElement|HTMLElement[]|null} [options.dom.modeButtons]
 * @param {HTMLElement|null} [options.dom.modeDescription]
 * @param {() => void} options.renderHighlightSummary
 * @param {() => void} options.renderHighlightPages
 */
export function initHighlightSelectionTools({
  state,
  viewer,
  dom,
  renderHighlightSummary,
  renderHighlightPages
}) {
  const selectionState = createHighlightSelectionState();

  const { show: showRangeLabel, hide: hideRangeLabel } = getSelectionRangeLabel();

  const ui = {
    modeDescriptionEl: dom?.modeDescription || null,
    showRangeLabel,
    hideRangeLabel
  };

  const annotation = initAnnotationSelection({
    state,
    viewer,
    selectionState,
    ui: {
      modeDescriptionEl: ui.modeDescriptionEl,
      hideRangeLabel: ui.hideRangeLabel
    }
  });

  const lasso = initLassoSelection({
    state,
    viewer,
    selectionState,
    ui: { modeDescriptionEl: ui.modeDescriptionEl }
  });

  const proximity = initProximitySelection({
    state,
    viewer,
    selectionState,
    ui: { modeDescriptionEl: ui.modeDescriptionEl }
  });

  const knn = initKnnSelection({
    state,
    viewer,
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
    state,
    viewer,
    dom: {
      modeButtons: dom?.modeButtons || null,
      modeDescription: ui.modeDescriptionEl
    },
    selectionState,
    stepHandlers: {
      handleAnnotationStep: annotation.handleAnnotationStep,
      handleLassoStep: lasso.handleLassoStep,
      handleProximityStep: proximity.handleProximityStep,
      handleKnnStep: knn.handleKnnStep
    }
  });

  return {
    selectionState,
    modeUi,
    destroy: () => {
      sync.destroy?.();
    }
  };
}

