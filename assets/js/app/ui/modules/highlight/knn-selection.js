/**
 * @fileoverview KNN drag selection tool.
 *
 * Tracks multi-step KNN selections with undo/redo and updates the preview
 * highlight during drags.
 *
 * @module ui/modules/highlight/knn-selection
 */

import { debug } from '../../../../utils/debug.js';
import { HIGHLIGHT_MODE_COPY } from './mode-copy.js';
import { MAX_HISTORY_STEPS } from './selection-state.js';
import {
  deliverSelectionToJupyter,
  showSelectionDeliveryFailure
} from './selection-notification.js';
import {
  requireCombineMode,
  requireCompletedSelectionEvent,
  requireDomElement,
  requireExactKeys,
  requireHighlightSelectionState,
  requireJupyterSource,
  requireMethods,
  requireSafeInteger,
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
 * @returns {{ handleKnnStep: (stepEvent: any) => void }}
 */
export function initKnnSelection(options) {
  requireExactKeys(
    options,
    ['state', 'viewer', 'jupyterSource', 'selectionState', 'ui'],
    'KNN selection options'
  );
  const { state, viewer, jupyterSource, selectionState, ui } = options;
  requireMethods(
    state,
    'KNN selection state',
    [
      'addHighlightDirect',
      'clearPreviewHighlight',
      'setPreviewHighlightFromIndices'
    ]
  );
  requireMethods(
    viewer,
    'KNN selection viewer',
    [
      'cancelKnnSelection',
      'confirmKnnSelection',
      'restoreKnnState',
      'setKnnCallback',
      'setKnnPreviewCallback',
      'setKnnStepCallback'
    ]
  );
  requireJupyterSource(jupyterSource);
  requireHighlightSelectionState(selectionState);
  requireExactKeys(ui, ['modeDescriptionEl'], 'KNN selection UI');
  const highlightModeDescriptionEl = requireDomElement(
    ui.modeDescriptionEl,
    'KNN mode description'
  );
  requireDomElement(
    highlightModeDescriptionEl.parentElement,
    'KNN mode description parent',
    ['appendChild']
  );
  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'KNN selection document',
    ['createElement', 'getElementById']
  );
  const lifecycleController = new AbortController();
  const pendingDeliveries = new Set();
  let destroyed = false;
  let destructionPromise = null;

  function listen(target, eventName, listener) {
    target.addEventListener(eventName, (...args) => {
      if (destroyed) return;
      listener(...args);
    }, { signal: lifecycleController.signal });
  }

  function trackDelivery(delivery) {
    pendingDeliveries.add(delivery);
    void delivery.then(
      () => pendingDeliveries.delete(delivery),
      () => pendingDeliveries.delete(delivery)
    );
  }

  function handleKnnSelection(knnEvent) {
    if (destroyed) return;
    requireCompletedSelectionEvent(knnEvent, 'knn');

    const stepsLabel = knnEvent.steps > 1 ? ` (${knnEvent.steps} selections)` : '';
    const savedGroup = state.addHighlightDirect({
      type: 'knn',
      label: `KNN${stepsLabel} (${knnEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: knnEvent.cellIndices
    });
    requireSavedHighlightGroup(
      savedGroup,
      'knn',
      knnEvent.cellCount,
      'Saved KNN highlight group'
    );

    debug.log(`[UI] KNN selected ${knnEvent.cellCount} cells from ${knnEvent.steps} selection(s)`);
    trackDelivery(deliverSelectionToJupyter({
      jupyterSource,
      cellIndices: knnEvent.cellIndices,
      source: 'knn',
      onFailure: error => {
        if (!destroyed) showSelectionDeliveryFailure(error, 'knn');
      }
    }));

    selectionState.knnHistory = [];
    selectionState.knnRedoStack = [];
    selectionState.lastKnnCandidates = null;
    selectionState.lastKnnStep = 0;
    updateKnnUI(null);
  }

  function handleKnnStep(stepEvent) {
    if (destroyed) return;
    requireSelectionStepEvent(
      stepEvent,
      'knn',
      ['seedCellIndex', 'degree']
    );
    if (stepEvent.cancelled !== true) {
      requireSafeInteger(
        stepEvent.seedCellIndex,
        'KNN step seedCellIndex',
        0
      );
      requireSafeInteger(stepEvent.degree, 'KNN step degree', 0);
    }
    if (stepEvent.cancelled) {
      selectionState.knnHistory = [];
      selectionState.knnRedoStack = [];
      selectionState.lastKnnCandidates = null;
      selectionState.lastKnnStep = 0;
      updateKnnUI(null);
      state.clearPreviewHighlight();
      return;
    }

    if (selectionState.lastKnnCandidates !== null || selectionState.lastKnnStep > 0) {
      selectionState.knnHistory.push({
        candidates: selectionState.lastKnnCandidates ? [...selectionState.lastKnnCandidates] : null,
        step: selectionState.lastKnnStep
      });
      if (selectionState.knnHistory.length > MAX_HISTORY_STEPS) {
        selectionState.knnHistory.shift();
      }
      selectionState.knnRedoStack = [];
    }

    selectionState.lastKnnCandidates = [...stepEvent.candidates];
    selectionState.lastKnnStep = stepEvent.step;

    updateKnnUI(stepEvent);

    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices(stepEvent.candidates);
    } else {
      state.clearPreviewHighlight();
    }
  }

  function handleKnnUndo() {
    if (destroyed) return;
    if (selectionState.knnHistory.length === 0) return;

    selectionState.knnRedoStack.push({
      candidates: selectionState.lastKnnCandidates ? [...selectionState.lastKnnCandidates] : null,
      step: selectionState.lastKnnStep
    });

    const prevState = selectionState.knnHistory.pop();
    selectionState.lastKnnCandidates = prevState.candidates;
    selectionState.lastKnnStep = prevState.step;

    viewer.restoreKnnState(prevState.candidates, prevState.step);

    if (prevState.candidates && prevState.candidates.length > 0) {
      updateKnnUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        restored: true
      });
      state.setPreviewHighlightFromIndices(prevState.candidates);
    } else {
      updateKnnUI({ step: 0, candidateCount: 0, keepControls: true });
      state.clearPreviewHighlight();
    }
  }

  function handleKnnRedo() {
    if (destroyed) return;
    if (selectionState.knnRedoStack.length === 0) return;

    selectionState.knnHistory.push({
      candidates: selectionState.lastKnnCandidates ? [...selectionState.lastKnnCandidates] : null,
      step: selectionState.lastKnnStep
    });

    const redoState = selectionState.knnRedoStack.pop();
    selectionState.lastKnnCandidates = redoState.candidates;
    selectionState.lastKnnStep = redoState.step;

    viewer.restoreKnnState(redoState.candidates, redoState.step);

    if (redoState.candidates && redoState.candidates.length > 0) {
      updateKnnUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        restored: true
      });
      state.setPreviewHighlightFromIndices(redoState.candidates);
    } else {
      updateKnnUI({ step: 0, candidateCount: 0, keepControls: true });
      state.clearPreviewHighlight();
    }
  }

  function handleKnnPreview(previewEvent) {
    if (destroyed) return;
    requireSelectionPreviewEvent(
      previewEvent,
      'knn',
      ['newCellCount', 'seedCellIndex', 'degree', 'mode']
    );
    requireSafeInteger(
      previewEvent.newCellCount,
      'KNN preview newCellCount',
      0
    );
    requireSafeInteger(
      previewEvent.seedCellIndex,
      'KNN preview seedCellIndex',
      0
    );
    requireSafeInteger(previewEvent.degree, 'KNN preview degree', 0);
    requireCombineMode(previewEvent.mode, 'KNN preview');

    if (previewEvent.cellIndices.length > 0) {
      state.setPreviewHighlightFromIndices(previewEvent.cellIndices);
    } else {
      state.clearPreviewHighlight();
    }
  }

  function getKnnControls() {
    let controls = documentOwner.getElementById('knn-step-controls');
    const created = controls === null;
    if (created) {
      controls = documentOwner.createElement('div');
      controls.id = 'knn-step-controls';
      controls.className = 'lasso-step-controls';
      controls.innerHTML = `
        <button type="button" class="btn-small lasso-confirm" id="knn-confirm-btn">Confirm</button>
        <button type="button" class="btn-small btn-undo" id="knn-undo-btn" title="Undo">↩</button>
        <button type="button" class="btn-small btn-redo" id="knn-redo-btn" title="Redo">↪</button>
        <button type="button" class="btn-small lasso-cancel" id="knn-cancel-btn">Cancel</button>
      `;
      highlightModeDescriptionEl.parentElement.appendChild(controls);
    }
    const undoButton = requireDomElement(
      documentOwner.getElementById('knn-undo-btn'),
      'KNN undo button',
      ['addEventListener']
    );
    const redoButton = requireDomElement(
      documentOwner.getElementById('knn-redo-btn'),
      'KNN redo button',
      ['addEventListener']
    );
    const confirmButton = requireDomElement(
      documentOwner.getElementById('knn-confirm-btn'),
      'KNN confirm button',
      ['addEventListener']
    );
    const cancelButton = requireDomElement(
      documentOwner.getElementById('knn-cancel-btn'),
      'KNN cancel button',
      ['addEventListener']
    );
    if (created) {
      listen(undoButton, 'click', handleKnnUndo);
      listen(redoButton, 'click', handleKnnRedo);
      listen(confirmButton, 'click', () => {
        viewer.confirmKnnSelection();
        state.clearPreviewHighlight();
      });
      listen(cancelButton, 'click', () => {
        viewer.cancelKnnSelection();
      });
    }
    return { undoButton, redoButton, confirmButton };
  }

  function updateKnnUI(stepEvent) {
    if (destroyed) return;
    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.knn;
      const existingControls = documentOwner.getElementById('knn-step-controls');
      if (existingControls) existingControls.remove();
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const stepInfo =
        '<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>';

      const { undoButton, redoButton, confirmButton } = getKnnControls();
      undoButton.disabled = selectionState.knnHistory.length === 0;
      redoButton.disabled = selectionState.knnRedoStack.length === 0;
      confirmButton.disabled = true;

      highlightModeDescriptionEl.innerHTML = stepInfo;
      return;
    }

    let modeLabel = '';
    if (stepEvent.restored !== true && stepEvent.mode === 'union') {
      modeLabel = ' <span class="lasso-mode-tag union">+added</span>';
    } else if (stepEvent.restored !== true && stepEvent.mode === 'subtract') {
      modeLabel = ' <span class="lasso-mode-tag subtract">−removed</span>';
    } else if (stepEvent.restored !== true && stepEvent.step > 1) {
      modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
    }

    const degreeLabel = stepEvent.restored === true
      ? 'current selection'
      : stepEvent.degree === 0
        ? 'seed only'
        : `${stepEvent.degree}° neighbors`;
    const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells (${degreeLabel})${modeLabel}<br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

    const { undoButton, redoButton, confirmButton } = getKnnControls();
    undoButton.disabled = selectionState.knnHistory.length === 0;
    redoButton.disabled = selectionState.knnRedoStack.length === 0;
    confirmButton.disabled = stepEvent.candidateCount === 0;

    highlightModeDescriptionEl.innerHTML = stepInfo;
  }

  function restoreKnnSelection(unifiedState) {
    if (destroyed) return;
    requireUnifiedSelectionState(unifiedState);
    selectionState.knnHistory = [];
    selectionState.knnRedoStack = [];
    selectionState.lastKnnCandidates = unifiedState.inProgress
      ? [...unifiedState.candidates]
      : null;
    selectionState.lastKnnStep = unifiedState.stepCount;
    if (!unifiedState.inProgress) {
      updateKnnUI(null);
      state.clearPreviewHighlight();
      return;
    }
    updateKnnUI({
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

  viewer.setKnnCallback(handleKnnSelection);
  viewer.setKnnStepCallback(handleKnnStep);
  viewer.setKnnPreviewCallback(handleKnnPreview);

  return {
    handleKnnStep,
    restoreKnnSelection,
    destroy() {
      if (destructionPromise !== null) return destructionPromise;
      destroyed = true;
      const failures = [];
      for (const operation of [
        () => lifecycleController.abort(),
        () => viewer.setKnnCallback(() => {}),
        () => viewer.setKnnStepCallback(() => {}),
        () => viewer.setKnnPreviewCallback(() => {})
      ]) {
        try {
          operation();
        } catch (error) {
          failures.push(error);
        }
      }
      destructionPromise = Promise.allSettled(
        [...pendingDeliveries]
      ).then(() => {
        const exactFailures = [...new Set(failures)];
        if (exactFailures.length === 1) throw exactFailures[0];
        if (exactFailures.length > 1) {
          throw new AggregateError(
            exactFailures,
            'KNN selection failed to release every owned resource.'
          );
        }
      });
      return destructionPromise;
    }
  };
}
