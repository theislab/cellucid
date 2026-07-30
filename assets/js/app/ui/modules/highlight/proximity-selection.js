/**
 * @fileoverview Proximity drag selection tool.
 *
 * Tracks multi-step proximity selections with undo/redo and updates the preview
 * highlight during drags.
 *
 * @module ui/modules/highlight/proximity-selection
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
  requireFiniteNumber,
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
 * @returns {{ handleProximityStep: (stepEvent: any) => void }}
 */
export function initProximitySelection(options) {
  requireExactKeys(
    options,
    ['state', 'viewer', 'jupyterSource', 'selectionState', 'ui'],
    'Proximity selection options'
  );
  const { state, viewer, jupyterSource, selectionState, ui } = options;
  requireMethods(
    state,
    'Proximity selection state',
    [
      'addHighlightDirect',
      'clearPreviewHighlight',
      'setPreviewHighlightFromIndices'
    ]
  );
  requireMethods(
    viewer,
    'Proximity selection viewer',
    [
      'cancelProximitySelection',
      'confirmProximitySelection',
      'restoreProximityState',
      'setProximityCallback',
      'setProximityPreviewCallback',
      'setProximityStepCallback'
    ]
  );
  requireJupyterSource(jupyterSource);
  requireHighlightSelectionState(selectionState);
  requireExactKeys(ui, ['modeDescriptionEl'], 'Proximity selection UI');
  const highlightModeDescriptionEl = requireDomElement(
    ui.modeDescriptionEl,
    'Proximity mode description'
  );
  requireDomElement(
    highlightModeDescriptionEl.parentElement,
    'Proximity mode description parent',
    ['appendChild']
  );
  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'Proximity selection document',
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

  function handleProximitySelection(proximityEvent) {
    if (destroyed) return;
    requireCompletedSelectionEvent(proximityEvent, 'proximity');

    const stepsLabel = proximityEvent.steps > 1 ? ` (${proximityEvent.steps} drags)` : '';
    const savedGroup = state.addHighlightDirect({
      type: 'proximity',
      label: `Proximity${stepsLabel} (${proximityEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: proximityEvent.cellIndices
    });
    requireSavedHighlightGroup(
      savedGroup,
      'proximity',
      proximityEvent.cellCount,
      'Saved proximity highlight group'
    );

    debug.log(`[UI] Proximity selected ${proximityEvent.cellCount} cells from ${proximityEvent.steps} drag(s)`);
    trackDelivery(deliverSelectionToJupyter({
      jupyterSource,
      cellIndices: proximityEvent.cellIndices,
      source: 'proximity',
      onFailure: error => {
        if (!destroyed) showSelectionDeliveryFailure(error, 'proximity');
      }
    }));

    selectionState.proximityHistory = [];
    selectionState.proximityRedoStack = [];
    selectionState.lastProximityCandidates = null;
    selectionState.lastProximityStep = 0;
    updateProximityUI(null);
  }

  function handleProximityStep(stepEvent) {
    if (destroyed) return;
    requireSelectionStepEvent(
      stepEvent,
      'proximity',
      ['centerCellIndex', 'radius']
    );
    if (stepEvent.cancelled !== true) {
      requireSafeInteger(
        stepEvent.centerCellIndex,
        'Proximity step centerCellIndex',
        0
      );
      requireFiniteNumber(stepEvent.radius, 'Proximity step radius');
      if (stepEvent.radius < 0) {
        throw new RangeError('Proximity step radius must not be negative.');
      }
    }
    if (stepEvent.cancelled) {
      selectionState.proximityHistory = [];
      selectionState.proximityRedoStack = [];
      selectionState.lastProximityCandidates = null;
      selectionState.lastProximityStep = 0;
      updateProximityUI(null);
      state.clearPreviewHighlight();
      return;
    }

    if (selectionState.lastProximityCandidates !== null || selectionState.lastProximityStep > 0) {
      selectionState.proximityHistory.push({
        candidates: selectionState.lastProximityCandidates ? [...selectionState.lastProximityCandidates] : null,
        step: selectionState.lastProximityStep
      });
      if (selectionState.proximityHistory.length > MAX_HISTORY_STEPS) {
        selectionState.proximityHistory.shift();
      }
      selectionState.proximityRedoStack = [];
    }

    selectionState.lastProximityCandidates = [...stepEvent.candidates];
    selectionState.lastProximityStep = stepEvent.step;

    updateProximityUI(stepEvent);

    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices(stepEvent.candidates);
    } else {
      state.clearPreviewHighlight();
    }
  }

  function handleProximityUndo() {
    if (destroyed) return;
    if (selectionState.proximityHistory.length === 0) return;

    selectionState.proximityRedoStack.push({
      candidates: selectionState.lastProximityCandidates ? [...selectionState.lastProximityCandidates] : null,
      step: selectionState.lastProximityStep
    });

    const prevState = selectionState.proximityHistory.pop();
    selectionState.lastProximityCandidates = prevState.candidates;
    selectionState.lastProximityStep = prevState.step;

    viewer.restoreProximityState(prevState.candidates, prevState.step);

    if (prevState.candidates && prevState.candidates.length > 0) {
      updateProximityUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        restored: true
      });
      state.setPreviewHighlightFromIndices(prevState.candidates);
    } else {
      updateProximityUI({ step: 0, candidateCount: 0, keepControls: true });
      state.clearPreviewHighlight();
    }
  }

  function handleProximityRedo() {
    if (destroyed) return;
    if (selectionState.proximityRedoStack.length === 0) return;

    selectionState.proximityHistory.push({
      candidates: selectionState.lastProximityCandidates ? [...selectionState.lastProximityCandidates] : null,
      step: selectionState.lastProximityStep
    });

    const redoState = selectionState.proximityRedoStack.pop();
    selectionState.lastProximityCandidates = redoState.candidates;
    selectionState.lastProximityStep = redoState.step;

    viewer.restoreProximityState(redoState.candidates, redoState.step);

    if (redoState.candidates && redoState.candidates.length > 0) {
      updateProximityUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        restored: true
      });
      state.setPreviewHighlightFromIndices(redoState.candidates);
    } else {
      updateProximityUI({ step: 0, candidateCount: 0, keepControls: true });
      state.clearPreviewHighlight();
    }
  }

  function handleProximityPreview(previewEvent) {
    if (destroyed) return;
    requireSelectionPreviewEvent(
      previewEvent,
      'proximity',
      ['newCellCount', 'centerCellIndex', 'radius', 'mode']
    );
    requireSafeInteger(
      previewEvent.newCellCount,
      'Proximity preview newCellCount',
      0
    );
    requireSafeInteger(
      previewEvent.centerCellIndex,
      'Proximity preview centerCellIndex',
      -1
    );
    requireFiniteNumber(previewEvent.radius, 'Proximity preview radius');
    requireCombineMode(previewEvent.mode, 'Proximity preview');
    if (previewEvent.radius < 0) {
      throw new RangeError('Proximity preview radius must not be negative.');
    }

    if (previewEvent.cellIndices.length > 0) {
      state.setPreviewHighlightFromIndices(previewEvent.cellIndices);
    } else {
      state.clearPreviewHighlight();
    }
  }

  function getProximityControls() {
    let controls = documentOwner.getElementById('proximity-step-controls');
    const created = controls === null;
    if (created) {
      controls = documentOwner.createElement('div');
      controls.id = 'proximity-step-controls';
      controls.className = 'lasso-step-controls';
      controls.innerHTML = `
        <button type="button" class="btn-small lasso-confirm" id="proximity-confirm-btn">Confirm</button>
        <button type="button" class="btn-small btn-undo" id="proximity-undo-btn" title="Undo">↩</button>
        <button type="button" class="btn-small btn-redo" id="proximity-redo-btn" title="Redo">↪</button>
        <button type="button" class="btn-small lasso-cancel" id="proximity-cancel-btn">Cancel</button>
      `;
      highlightModeDescriptionEl.parentElement.appendChild(controls);
    }
    const undoButton = requireDomElement(
      documentOwner.getElementById('proximity-undo-btn'),
      'Proximity undo button',
      ['addEventListener']
    );
    const redoButton = requireDomElement(
      documentOwner.getElementById('proximity-redo-btn'),
      'Proximity redo button',
      ['addEventListener']
    );
    const confirmButton = requireDomElement(
      documentOwner.getElementById('proximity-confirm-btn'),
      'Proximity confirm button',
      ['addEventListener']
    );
    const cancelButton = requireDomElement(
      documentOwner.getElementById('proximity-cancel-btn'),
      'Proximity cancel button',
      ['addEventListener']
    );
    if (created) {
      listen(undoButton, 'click', handleProximityUndo);
      listen(redoButton, 'click', handleProximityRedo);
      listen(confirmButton, 'click', () => {
        viewer.confirmProximitySelection();
        state.clearPreviewHighlight();
      });
      listen(cancelButton, 'click', () => {
        viewer.cancelProximitySelection();
      });
    }
    return { undoButton, redoButton, confirmButton };
  }

  function updateProximityUI(stepEvent) {
    if (destroyed) return;
    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.proximity;
      const existingControls = documentOwner.getElementById('proximity-step-controls');
      if (existingControls) existingControls.remove();
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const stepInfo =
        '<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>';

      const {
        undoButton,
        redoButton,
        confirmButton
      } = getProximityControls();
      undoButton.disabled = selectionState.proximityHistory.length === 0;
      redoButton.disabled = selectionState.proximityRedoStack.length === 0;
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

    const {
      undoButton,
      redoButton,
      confirmButton
    } = getProximityControls();
    undoButton.disabled = selectionState.proximityHistory.length === 0;
    redoButton.disabled = selectionState.proximityRedoStack.length === 0;
    confirmButton.disabled = stepEvent.candidateCount === 0;

    highlightModeDescriptionEl.innerHTML = stepInfo;
  }

  function restoreProximitySelection(unifiedState) {
    if (destroyed) return;
    requireUnifiedSelectionState(unifiedState);
    selectionState.proximityHistory = [];
    selectionState.proximityRedoStack = [];
    selectionState.lastProximityCandidates = unifiedState.inProgress
      ? [...unifiedState.candidates]
      : null;
    selectionState.lastProximityStep = unifiedState.stepCount;
    if (!unifiedState.inProgress) {
      updateProximityUI(null);
      state.clearPreviewHighlight();
      return;
    }
    updateProximityUI({
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

  viewer.setProximityCallback(handleProximitySelection);
  viewer.setProximityStepCallback(handleProximityStep);
  viewer.setProximityPreviewCallback(handleProximityPreview);

  return {
    handleProximityStep,
    restoreProximitySelection,
    destroy() {
      if (destructionPromise !== null) return destructionPromise;
      destroyed = true;
      const failures = [];
      for (const operation of [
        () => lifecycleController.abort(),
        () => viewer.setProximityCallback(() => {}),
        () => viewer.setProximityStepCallback(() => {}),
        () => viewer.setProximityPreviewCallback(() => {})
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
            'Proximity selection failed to release every owned resource.'
          );
        }
      });
      return destructionPromise;
    }
  };
}
