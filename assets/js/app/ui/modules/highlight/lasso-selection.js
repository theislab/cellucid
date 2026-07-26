/**
 * @fileoverview Lasso selection tool.
 *
 * Tracks multi-step lasso selections with undo/redo and updates the preview
 * highlight while the selection is in progress.
 *
 * @module ui/modules/highlight/lasso-selection
 */

import { debug } from '../../../../utils/debug.js';
import { HIGHLIGHT_MODE_COPY } from './mode-copy.js';
import { MAX_HISTORY_STEPS } from './selection-state.js';
import {
  deliverSelectionToJupyter,
  showSelectionDeliveryFailure
} from './selection-notification.js';
import {
  requireCompletedSelectionEvent,
  requireDomElement,
  requireExactKeys,
  requireFiniteNumber,
  requireHighlightSelectionState,
  requireJupyterSource,
  requireMethods,
  requireSavedHighlightGroup,
  requireSelectionPreviewEvent,
  requireSelectionStepEvent,
  requireUnifiedSelectionState
} from './exact-contract.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {any|null} [options.jupyterSource]
 * @param {ReturnType<import('./selection-state.js').createHighlightSelectionState>} options.selectionState
 * @param {object} options.ui
 * @param {HTMLElement|null} options.ui.modeDescriptionEl
 * @returns {{ handleLassoStep: (stepEvent: any) => void }}
 */
export function initLassoSelection(options) {
  requireExactKeys(
    options,
    ['state', 'viewer', 'jupyterSource', 'selectionState', 'ui'],
    'Lasso selection options'
  );
  const { state, viewer, jupyterSource, selectionState, ui } = options;
  requireMethods(
    state,
    'Lasso selection state',
    [
      'addHighlightDirect',
      'clearPreviewHighlight',
      'setPreviewHighlightFromIndices'
    ]
  );
  requireMethods(
    viewer,
    'Lasso selection viewer',
    [
      'cancelLassoSelection',
      'confirmLassoSelection',
      'restoreLassoState',
      'setLassoCallback',
      'setLassoPreviewCallback',
      'setLassoStepCallback'
    ]
  );
  requireJupyterSource(jupyterSource);
  requireHighlightSelectionState(selectionState);
  requireExactKeys(ui, ['modeDescriptionEl'], 'Lasso selection UI');
  const highlightModeDescriptionEl = requireDomElement(
    ui.modeDescriptionEl,
    'Lasso mode description'
  );
  requireDomElement(
    highlightModeDescriptionEl.parentElement,
    'Lasso mode description parent',
    ['appendChild']
  );
  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'Lasso selection document',
    ['createElement', 'getElementById']
  );

  function handleLassoSelection(lassoEvent) {
    requireCompletedSelectionEvent(lassoEvent, 'lasso');

    const stepsLabel = lassoEvent.steps > 1 ? ` (${lassoEvent.steps} views)` : '';
    const savedGroup = state.addHighlightDirect({
      type: 'lasso',
      label: `Lasso${stepsLabel} (${lassoEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: lassoEvent.cellIndices
    });
    requireSavedHighlightGroup(
      savedGroup,
      'lasso',
      lassoEvent.cellCount,
      'Saved lasso highlight group'
    );

    debug.log(`[UI] Lasso selected ${lassoEvent.cellCount} cells from ${lassoEvent.steps} view(s)`);
    void deliverSelectionToJupyter({
      jupyterSource,
      cellIndices: lassoEvent.cellIndices,
      source: 'lasso',
      onFailure: error => showSelectionDeliveryFailure(error, 'lasso')
    });

    selectionState.lassoHistory = [];
    selectionState.lassoRedoStack = [];
    selectionState.lastLassoCandidates = null;
    selectionState.lastLassoStep = 0;
    updateLassoUI(null);
  }

  function handleLassoStep(stepEvent) {
    requireSelectionStepEvent(stepEvent, 'lasso');
    if (stepEvent.cancelled) {
      selectionState.lassoHistory = [];
      selectionState.lassoRedoStack = [];
      selectionState.lastLassoCandidates = null;
      selectionState.lastLassoStep = 0;
      updateLassoUI(null);
      state.clearPreviewHighlight();
      return;
    }

    if (selectionState.lastLassoCandidates !== null || selectionState.lastLassoStep > 0) {
      selectionState.lassoHistory.push({
        candidates: selectionState.lastLassoCandidates ? [...selectionState.lastLassoCandidates] : null,
        step: selectionState.lastLassoStep
      });
      if (selectionState.lassoHistory.length > MAX_HISTORY_STEPS) {
        selectionState.lassoHistory.shift();
      }
      selectionState.lassoRedoStack = [];
    }

    selectionState.lastLassoCandidates = [...stepEvent.candidates];
    selectionState.lastLassoStep = stepEvent.step;

    updateLassoUI(stepEvent);

    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices(stepEvent.candidates);
    } else {
      state.clearPreviewHighlight();
    }
  }

  function handleLassoUndo() {
    if (selectionState.lassoHistory.length === 0) return;

    selectionState.lassoRedoStack.push({
      candidates: selectionState.lastLassoCandidates ? [...selectionState.lastLassoCandidates] : null,
      step: selectionState.lastLassoStep
    });

    const prevState = selectionState.lassoHistory.pop();
    selectionState.lastLassoCandidates = prevState.candidates;
    selectionState.lastLassoStep = prevState.step;

    viewer.restoreLassoState(prevState.candidates, prevState.step);

    if (prevState.candidates && prevState.candidates.length > 0) {
      updateLassoUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        restored: true
      });
      state.setPreviewHighlightFromIndices(prevState.candidates);
    } else {
      updateLassoUI({ step: 0, candidateCount: 0, keepControls: true });
      state.clearPreviewHighlight();
    }
  }

  function handleLassoRedo() {
    if (selectionState.lassoRedoStack.length === 0) return;

    selectionState.lassoHistory.push({
      candidates: selectionState.lastLassoCandidates ? [...selectionState.lastLassoCandidates] : null,
      step: selectionState.lastLassoStep
    });

    const redoState = selectionState.lassoRedoStack.pop();
    selectionState.lastLassoCandidates = redoState.candidates;
    selectionState.lastLassoStep = redoState.step;

    viewer.restoreLassoState(redoState.candidates, redoState.step);

    if (redoState.candidates && redoState.candidates.length > 0) {
      updateLassoUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        restored: true
      });
      state.setPreviewHighlightFromIndices(redoState.candidates);
    } else {
      updateLassoUI({ step: 0, candidateCount: 0, keepControls: true });
      state.clearPreviewHighlight();
    }
  }

  function handleLassoPreview(previewEvent) {
    requireSelectionPreviewEvent(
      previewEvent,
      'lasso',
      ['polygon']
    );
    if (!Array.isArray(previewEvent.polygon) || previewEvent.polygon.length < 3) {
      throw new TypeError(
        'Lasso preview polygon must contain at least three points.'
      );
    }
    for (const point of previewEvent.polygon) {
      requireExactKeys(point, ['x', 'y'], 'Lasso preview polygon point');
      requireFiniteNumber(point.x, 'Lasso preview polygon x');
      requireFiniteNumber(point.y, 'Lasso preview polygon y');
    }
    if (previewEvent.cellIndices.length === 0) {
      state.clearPreviewHighlight();
    } else {
      state.setPreviewHighlightFromIndices(previewEvent.cellIndices);
    }
  }

  function getLassoControls() {
    let controls = documentOwner.getElementById('lasso-step-controls');
    const created = controls === null;
    if (created) {
      controls = documentOwner.createElement('div');
      controls.id = 'lasso-step-controls';
      controls.className = 'lasso-step-controls';
      controls.innerHTML = `
        <button type="button" class="btn-small lasso-confirm" id="lasso-confirm-btn">Confirm</button>
        <button type="button" class="btn-small btn-undo" id="lasso-undo-btn" title="Undo">↩</button>
        <button type="button" class="btn-small btn-redo" id="lasso-redo-btn" title="Redo">↪</button>
        <button type="button" class="btn-small lasso-cancel" id="lasso-cancel-btn">Cancel</button>
      `;
      highlightModeDescriptionEl.parentElement.appendChild(controls);
    }

    const undoButton = requireDomElement(
      documentOwner.getElementById('lasso-undo-btn'),
      'Lasso undo button',
      ['addEventListener']
    );
    const redoButton = requireDomElement(
      documentOwner.getElementById('lasso-redo-btn'),
      'Lasso redo button',
      ['addEventListener']
    );
    const confirmButton = requireDomElement(
      documentOwner.getElementById('lasso-confirm-btn'),
      'Lasso confirm button',
      ['addEventListener']
    );
    const cancelButton = requireDomElement(
      documentOwner.getElementById('lasso-cancel-btn'),
      'Lasso cancel button',
      ['addEventListener']
    );
    if (created) {
      undoButton.addEventListener('click', handleLassoUndo);
      redoButton.addEventListener('click', handleLassoRedo);
      confirmButton.addEventListener('click', () => {
        viewer.confirmLassoSelection();
        state.clearPreviewHighlight();
      });
      cancelButton.addEventListener('click', () => {
        viewer.cancelLassoSelection();
      });
    }
    return { undoButton, redoButton, confirmButton };
  }

  function updateLassoUI(stepEvent) {
    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.lasso;
      const existingControls = documentOwner.getElementById('lasso-step-controls');
      if (existingControls) existingControls.remove();
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const stepInfo =
        '<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>';

      const { undoButton, redoButton, confirmButton } = getLassoControls();
      undoButton.disabled = selectionState.lassoHistory.length === 0;
      redoButton.disabled = selectionState.lassoRedoStack.length === 0;
      confirmButton.disabled = true;

      highlightModeDescriptionEl.innerHTML = stepInfo;
      return;
    }

    let modeLabel = '';
    if (stepEvent.restored === true) {
      modeLabel = ' <span class="lasso-mode-tag intersect">current selection</span>';
    } else if (stepEvent.mode === 'union') {
      modeLabel = ' <span class="lasso-mode-tag union">+added</span>';
    } else if (stepEvent.mode === 'subtract') {
      modeLabel = ' <span class="lasso-mode-tag subtract">−removed</span>';
    } else if (stepEvent.step > 1) {
      modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
    }

    const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells${modeLabel}<br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

    const { undoButton, redoButton, confirmButton } = getLassoControls();
    undoButton.disabled = selectionState.lassoHistory.length === 0;
    redoButton.disabled = selectionState.lassoRedoStack.length === 0;
    confirmButton.disabled = stepEvent.candidateCount === 0;

    highlightModeDescriptionEl.innerHTML = stepInfo;
  }

  function restoreLassoSelection(unifiedState) {
    requireUnifiedSelectionState(unifiedState);
    selectionState.lassoHistory = [];
    selectionState.lassoRedoStack = [];
    selectionState.lastLassoCandidates = unifiedState.inProgress
      ? [...unifiedState.candidates]
      : null;
    selectionState.lastLassoStep = unifiedState.stepCount;
    if (!unifiedState.inProgress) {
      updateLassoUI(null);
      state.clearPreviewHighlight();
      return;
    }
    updateLassoUI({
      step: unifiedState.stepCount,
      candidateCount: unifiedState.candidateCount,
      candidates: unifiedState.candidates,
      restored: true
    });
    if (unifiedState.candidateCount === 0) {
      state.clearPreviewHighlight();
    } else {
      state.setPreviewHighlightFromIndices(unifiedState.candidates);
    }
  }

  viewer.setLassoCallback(handleLassoSelection);
  viewer.setLassoPreviewCallback(handleLassoPreview);
  viewer.setLassoStepCallback(handleLassoStep);

  return { handleLassoStep, restoreLassoSelection };
}
