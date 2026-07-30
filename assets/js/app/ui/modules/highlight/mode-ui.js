/**
 * @fileoverview Exact highlight mode toolbelt wiring.
 *
 * @module ui/modules/highlight/mode-ui
 */

import { HIGHLIGHT_MODE_COPY } from './mode-copy.js';
import {
  requireDomElement,
  requireExactKeys,
  requireHighlightSelectionMode,
  requireHighlightSelectionState,
  requireMethods,
  requireModeButtons,
  requireUnifiedSelectionState
} from './exact-contract.js';

const MODE_HANDLER_NAMES = Object.freeze({
  annotation: 'restoreAnnotationSelection',
  knn: 'restoreKnnSelection',
  proximity: 'restoreProximitySelection',
  lasso: 'restoreLassoSelection'
});

const HISTORY_KEYS = Object.freeze({
  annotation: ['annotationHistory', 'annotationRedoStack'],
  knn: ['knnHistory', 'knnRedoStack'],
  proximity: ['proximityHistory', 'proximityRedoStack'],
  lasso: ['lassoHistory', 'lassoRedoStack']
});

function requireModeHandlers(modeHandlers) {
  requireExactKeys(
    modeHandlers,
    Object.values(MODE_HANDLER_NAMES),
    'Highlight mode handlers'
  );
  requireMethods(
    modeHandlers,
    'Highlight mode handlers',
    Object.values(MODE_HANDLER_NAMES)
  );
  return modeHandlers;
}

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.dom
 * @param {HTMLElement[]} options.dom.modeButtons
 * @param {HTMLElement} options.dom.modeDescription
 * @param {ReturnType<import('./selection-state.js').createHighlightSelectionState>} options.selectionState
 * @param {object} options.modeHandlers
 */
export function initHighlightModeUI(options) {
  requireExactKeys(
    options,
    ['viewer', 'dom', 'selectionState', 'modeHandlers'],
    'Highlight mode UI options'
  );
  const { viewer, dom, selectionState, modeHandlers } = options;
  requireMethods(
    viewer,
    'Highlight mode viewer',
    [
      'cancelUnifiedSelection',
      'getUnifiedSelectionState',
      'restoreUnifiedState',
      'setKnnEnabled',
      'setLassoEnabled',
      'setProximityEnabled'
    ]
  );
  requireExactKeys(
    dom,
    ['modeButtons', 'modeDescription'],
    'Highlight mode DOM'
  );
  const {
    buttons: highlightModeButtonsList,
    pressedMode
  } = requireModeButtons(dom.modeButtons);
  const highlightModeDescriptionEl = requireDomElement(
    dom.modeDescription,
    'Highlight mode description'
  );
  requireDomElement(
    highlightModeDescriptionEl.parentElement,
    'Highlight mode description parent',
    ['appendChild']
  );
  requireHighlightSelectionState(selectionState);
  requireModeHandlers(modeHandlers);

  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'Highlight document',
    ['getElementById']
  );

  if (pressedMode !== selectionState.activeMode) {
    throw new TypeError(
      'Pressed highlight mode must match selectionState.activeMode.'
    );
  }
  const lifecycleController = new AbortController();
  let destroyed = false;
  let activeHighlightMode = pressedMode;

  function listen(target, eventName, listener) {
    target.addEventListener(eventName, (...args) => {
      if (destroyed) return;
      listener(...args);
    }, { signal: lifecycleController.signal });
  }

  function removeStepControls() {
    for (const id of [
      'lasso-step-controls',
      'proximity-step-controls',
      'knn-step-controls',
      'annotation-step-controls'
    ]) {
      const controls = documentOwner.getElementById(id);
      if (controls !== null) controls.remove();
    }
  }

  function resetModeHistory(mode) {
    for (const key of HISTORY_KEYS[mode]) {
      selectionState[key] = [];
    }
  }

  function restoreModeSelection(mode, unifiedState) {
    const handlerName = MODE_HANDLER_NAMES[mode];
    modeHandlers[handlerName](unifiedState);
  }

  function setHighlightModeUI(mode) {
    if (destroyed) return;
    const exactMode = requireHighlightSelectionMode(mode);
    const previousMode = activeHighlightMode;

    if (
      previousMode === 'annotation'
      && selectionState.annotationCandidateSet !== null
    ) {
      if (selectionState.annotationCandidateSet.size === 0) {
        viewer.cancelUnifiedSelection();
      } else {
        viewer.restoreUnifiedState(
          [...selectionState.annotationCandidateSet],
          selectionState.annotationStepCount
        );
      }
    }
    const unifiedState = requireUnifiedSelectionState(
      viewer.getUnifiedSelectionState()
    );

    viewer.setLassoEnabled(exactMode === 'lasso');
    viewer.setProximityEnabled(exactMode === 'proximity');
    viewer.setKnnEnabled(exactMode === 'knn');

    if (previousMode !== exactMode) {
      resetModeHistory(previousMode);
    }
    activeHighlightMode = exactMode;
    selectionState.activeMode = exactMode;

    for (const button of highlightModeButtonsList) {
      button.setAttribute(
        'aria-pressed',
        button.dataset.mode === exactMode ? 'true' : 'false'
      );
    }

    removeStepControls();
    highlightModeDescriptionEl.textContent = HIGHLIGHT_MODE_COPY[exactMode];
    highlightModeDescriptionEl.style.display = 'block';
    restoreModeSelection(exactMode, unifiedState);
  }

  for (const button of highlightModeButtonsList) {
    listen(button, 'click', () => {
      setHighlightModeUI(button.dataset.mode);
    });
  }
  setHighlightModeUI(pressedMode);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    const failures = [];
    for (const cleanup of [
      () => lifecycleController.abort(),
      removeStepControls
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    const exactFailures = [...new Set(failures)];
    if (exactFailures.length === 1) throw exactFailures[0];
    if (exactFailures.length > 1) {
      throw new AggregateError(
        exactFailures,
        'Highlight mode UI failed to release every owned resource.'
      );
    }
  }

  return {
    setHighlightModeUI,
    getActiveMode: () => activeHighlightMode,
    destroy
  };
}
