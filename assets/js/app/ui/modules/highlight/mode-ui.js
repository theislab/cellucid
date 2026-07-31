/**
 * @fileoverview Exact highlight mode toolbelt wiring.
 *
 * @module ui/modules/highlight/mode-ui
 */

import { HIGHLIGHT_MODE_COPY } from './mode-copy.js';
import { STEP_CONTROL_TOOLS, removeStepControls } from './step-controls.js';
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

/** The viewer call each mode's Cancel button already makes. */
const CANCEL_METHOD_NAMES = Object.freeze({
  annotation: 'cancelAnnotationSelection',
  knn: 'cancelKnnSelection',
  proximity: 'cancelProximitySelection',
  lasso: 'cancelLassoSelection'
});

/**
 * Does the given mode currently hold something Escape should abandon?
 *
 * Each tool mirrors the renderer's candidate set here while a selection is in
 * progress and clears it on confirm, cancel, and mode switch, so this is the
 * same "is there anything to cancel" the step controls' own presence expresses.
 *
 * @param {object} selectionState
 * @param {string} mode
 * @returns {boolean}
 */
function hasSelectionInProgress(selectionState, mode) {
  if (mode === 'annotation') {
    return selectionState.annotationCandidateSet !== null;
  }
  if (mode === 'knn') {
    return selectionState.lastKnnCandidates !== null
      || selectionState.lastKnnStep > 0;
  }
  if (mode === 'proximity') {
    return selectionState.lastProximityCandidates !== null
      || selectionState.lastProximityStep > 0;
  }
  return selectionState.lastLassoCandidates !== null
    || selectionState.lastLassoStep > 0;
}

/**
 * Is this keystroke a plain Escape nobody else has already claimed?
 *
 * Modals and popovers in this app own Escape from a capture-phase listener and
 * stop the event or mark it handled, and inline renames call `preventDefault`
 * on their own input. Deferring to both keeps one Escape from closing a dialog
 * and throwing away a selection behind it.
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function isUnclaimedEscape(event) {
  if (event.key !== 'Escape') return false;
  if (event.defaultPrevented === true) return false;
  if (
    event.altKey === true
    || event.ctrlKey === true
    || event.metaKey === true
    || event.shiftKey === true
  ) {
    return false;
  }
  const target = event.target;
  if (target === null || target === undefined) return true;
  const tagName = String(target.tagName);
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return false;
  }
  return target.isContentEditable !== true;
}

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
 * @param {import('../../../state/core/data-state.js').DataState} options.state
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
    ['state', 'viewer', 'dom', 'selectionState', 'modeHandlers'],
    'Highlight mode UI options'
  );
  const { state, viewer, dom, selectionState, modeHandlers } = options;
  requireMethods(
    viewer,
    'Highlight mode viewer',
    [
      ...Object.values(CANCEL_METHOD_NAMES),
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
  requireHighlightSelectionState(selectionState, state.pointCount);
  requireModeHandlers(modeHandlers);

  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'Highlight document',
    ['addEventListener', 'getElementById']
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

  function removeAllStepControls() {
    for (const tool of STEP_CONTROL_TOOLS) {
      removeStepControls(
        documentOwner,
        tool,
        highlightModeDescriptionEl.parentElement
      );
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
      viewer.getUnifiedSelectionState(),
      state.pointCount
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

    removeAllStepControls();
    highlightModeDescriptionEl.textContent = HIGHLIGHT_MODE_COPY[exactMode];
    highlightModeDescriptionEl.style.display = 'block';
    restoreModeSelection(exactMode, unifiedState);
  }

  /**
   * Abandon the in-progress selection, exactly as the active tool's Cancel
   * button does.
   *
   * Escape means "abandon what I am doing" everywhere else in this app, and
   * every one of these tools already has a Cancel button that does precisely
   * that; stepping back a single step instead would only duplicate the Undo
   * control that sits beside it and would still leave no way to walk away. The
   * key is only consumed when there is something to abandon, so it keeps
   * reaching whatever else would have handled it.
   */
  function cancelActiveSelection() {
    if (!hasSelectionInProgress(selectionState, activeHighlightMode)) {
      return false;
    }
    viewer[CANCEL_METHOD_NAMES[activeHighlightMode]]();
    return true;
  }

  for (const button of highlightModeButtonsList) {
    listen(button, 'click', () => {
      setHighlightModeUI(button.dataset.mode);
    });
  }
  listen(documentOwner, 'keydown', event => {
    if (!isUnclaimedEscape(event)) return;
    if (!cancelActiveSelection()) return;
    event.preventDefault();
    event.stopPropagation();
  });
  setHighlightModeUI(pressedMode);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    const failures = [];
    for (const cleanup of [
      () => lifecycleController.abort(),
      removeAllStepControls
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
