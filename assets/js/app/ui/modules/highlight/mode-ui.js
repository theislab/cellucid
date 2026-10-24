/**
 * @fileoverview Exact highlight mode toolbelt wiring.
 *
 * @module ui/modules/highlight/mode-ui
 */

import { HIGHLIGHT_MODE_COPY, SELECT_BAR_HINT } from './mode-copy.js';
import {
  publishSelectBarHint,
  publishToolHint,
  removeStepControls,
  STEP_CONTROL_TOOLS
} from './step-controls.js';
import {
  requireDomElement,
  requireExactKeys,
  requireHighlightSelectionMode,
  requireHighlightSelectionState,
  requireMethods,
  requireModeButtons,
  requireSelectModeControls,
  requireUnifiedSelectionState
} from './exact-contract.js';
import {
  requireSelectMode,
  SELECT_MODE_COMBINES
} from '../../../../rendering/select-mode.js';

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
 * @param {HTMLElement[]} options.dom.selectModeSwitches every Select mode switch
 * @param {HTMLElement[]} options.dom.selectCombineGroups every combine group
 * @param {HTMLElement[]} options.dom.selectCombineButtons every combine button
 * @param {HTMLElement} options.dom.selectBarSteps the selection bar's step row
 * @param {HTMLElement[]} options.dom.selectBarStepButtons its Undo, Cancel, Confirm
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
      'setProximityEnabled',
      'setSelectMode'
    ]
  );
  requireExactKeys(
    dom,
    [
      'modeButtons',
      'modeDescription',
      'selectModeSwitches',
      'selectCombineGroups',
      'selectCombineButtons',
      'selectBarSteps',
      'selectBarStepButtons'
    ],
    'Highlight mode DOM'
  );
  const markedSelectMode = requireSelectModeControls(
    {
      switches: dom.selectModeSwitches,
      combineGroups: dom.selectCombineGroups,
      combineButtons: dom.selectCombineButtons
    },
    SELECT_MODE_COMBINES
  );
  const selectBarSteps = requireDomElement(
    dom.selectBarSteps,
    'Selection bar step row'
  );
  if (!Array.isArray(dom.selectBarStepButtons)) {
    throw new TypeError('Selection bar step buttons must be an array.');
  }
  const selectBarActions = dom.selectBarStepButtons.map(button => {
    requireDomElement(button, 'Selection bar step button', ['addEventListener']);
    requireDomElement(button.dataset, 'Selection bar step button dataset');
    return button.dataset.stepAction;
  });
  if (selectBarActions.slice().sort().join(',') !== 'cancel,confirm,undo') {
    throw new TypeError(
      'Selection bar needs exactly one undo, cancel and confirm button.'
    );
  }

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
  let selectMode = requireSelectMode(markedSelectMode);

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
        highlightModeDescriptionEl.parentElement,
        ''
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
          selectionState.annotationCandidateSet.toUint32Array(),
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
    highlightModeDescriptionEl.textContent = '';
    publishToolHint(documentOwner, HIGHLIGHT_MODE_COPY[exactMode]);
    publishSelectBarHint(documentOwner, SELECT_BAR_HINT[exactMode]);
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

  /**
   * Publish Select mode and paint every control that shows it.
   *
   * The viewer is told first, so a switch can never read as on while a tap
   * still orbits. Every switch carries the same `aria-checked`, and the
   * combine buttons are shown only while the mode is on, because Shift and
   * Ctrl keep choosing the combine for an Alt gesture.
   *
   * @param {{enabled: boolean, combine: string}} next
   */
  function setSelectMode(next) {
    if (destroyed) return;
    const exact = requireSelectMode(next);
    viewer.setSelectMode(exact);
    selectMode = exact;
    for (const control of dom.selectModeSwitches) {
      control.setAttribute('aria-checked', exact.enabled ? 'true' : 'false');
    }
    for (const button of dom.selectCombineButtons) {
      button.setAttribute(
        'aria-pressed',
        button.dataset.combine === exact.combine ? 'true' : 'false'
      );
    }
    for (const group of dom.selectCombineGroups) {
      group.hidden = !exact.enabled;
    }
  }

  /**
   * Leave Select mode, as releasing Alt would. Escape reaches this only when
   * there is no selection in progress to abandon first.
   */
  function leaveSelectMode() {
    if (!selectMode.enabled) return false;
    setSelectMode({ enabled: false, combine: selectMode.combine });
    return true;
  }

  for (const button of highlightModeButtonsList) {
    listen(button, 'click', () => {
      setHighlightModeUI(button.dataset.mode);
    });
  }
  for (const control of dom.selectModeSwitches) {
    listen(control, 'click', () => {
      setSelectMode({ enabled: !selectMode.enabled, combine: selectMode.combine });
    });
  }
  // The selection bar's Undo, Cancel and Confirm press the panel's buttons for
  // the tool whose controls they mirror (step-controls.js), so each action
  // keeps one handler, and a disabled panel button stays inert from the bar.
  dom.selectBarStepButtons.forEach((button, index) => {
    listen(button, 'click', () => {
      const tool = selectBarSteps.dataset.tool;
      if (!STEP_CONTROL_TOOLS.includes(tool)) return;
      const target = documentOwner.getElementById(
        `${tool}-${selectBarActions[index]}-btn`
      );
      if (target !== null) target.click();
    });
  });
  for (const button of dom.selectCombineButtons) {
    listen(button, 'click', () => {
      setSelectMode({ enabled: selectMode.enabled, combine: button.dataset.combine });
    });
  }
  listen(documentOwner, 'keydown', event => {
    if (!isUnclaimedEscape(event)) return;
    if (!cancelActiveSelection() && !leaveSelectMode()) return;
    event.preventDefault();
    event.stopPropagation();
  });
  setHighlightModeUI(pressedMode);
  setSelectMode(selectMode);

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
    setSelectMode,
    getSelectMode: () => selectMode,
    destroy
  };
}
