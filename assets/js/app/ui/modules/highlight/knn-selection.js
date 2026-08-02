/**
 * @fileoverview KNN drag selection tool.
 *
 * Tracks multi-step KNN selections with undo/redo and updates the preview
 * highlight during drags.
 *
 * @module ui/modules/highlight/knn-selection
 */

import { debug } from '../../../../utils/debug.js';
import {
  abandonedGestureNotice,
  HIGHLIGHT_MODE_COPY,
  SELECTION_NOTICE,
  selectionNoticeHtml
} from './mode-copy.js';
import { MAX_HISTORY_STEPS, selectionUnchanged } from './selection-state.js';
import { viewerNeedsUiRetirement } from '../../core/viewer-lifecycle.js';
import { getStepControls, removeStepControls } from './step-controls.js';
import {
  deliverSelectionToJupyter,
  showSelectionDeliveryFailure
} from './selection-notification.js';
import {
  requireCellIndex,
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
  requireHighlightSelectionState(selectionState, state.pointCount);
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
    requireCompletedSelectionEvent(knnEvent, 'knn', state.pointCount);

    const stepsLabel = knnEvent.steps > 1 ? ` (${knnEvent.steps} selections)` : '';
    const savedGroup = state.addHighlightDirect({
      type: 'knn',
      label: `KNN${stepsLabel} (${knnEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: knnEvent.cellIndices
    });
    requireSavedHighlightGroup(
      savedGroup,
      'knn',
      knnEvent.cellIndices,
      'Saved KNN highlight group',
      state.pointCount
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
      state.pointCount,
      ['seedCellIndex', 'degree']
    );
    if (stepEvent.abandoned !== undefined) {
      renderKnnState(abandonedGestureNotice(stepEvent.abandoned));
      return;
    }
    if (stepEvent.cancelled !== true) {
      requireCellIndex(
        stepEvent.seedCellIndex,
        'KNN step seedCellIndex',
        state.pointCount
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

    if (
      selectionUnchanged(
        selectionState.lastKnnCandidates,
        stepEvent.candidates
      )
    ) {
      // Roll the renderer's own step counter back, or the next real step is
      // numbered as if this one had happened.
      viewer.restoreKnnState(
        selectionState.lastKnnCandidates,
        selectionState.lastKnnStep
      );
      renderKnnState(SELECTION_NOTICE.unchanged);
      return;
    }

    // The empty state before the first step is recorded like any other, so
    // Undo can reach it — the annotation tool has always done this, and a
    // greyed-out Undo immediately after dragging reads as a broken control.
    selectionState.knnHistory.push({
      candidates: selectionState.lastKnnCandidates ? [...selectionState.lastKnnCandidates] : null,
      step: selectionState.lastKnnStep
    });
    if (selectionState.knnHistory.length > MAX_HISTORY_STEPS) {
      selectionState.knnHistory.shift();
    }
    selectionState.knnRedoStack = [];

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
      state.pointCount,
      ['newCellCount', 'seedCellIndex', 'degree', 'mode']
    );
    requireSafeInteger(
      previewEvent.newCellCount,
      'KNN preview newCellCount',
      0
    );
    requireCellIndex(
      previewEvent.seedCellIndex,
      'KNN preview seedCellIndex',
      state.pointCount
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
    return getStepControls({
      documentOwner,
      tool: 'knn',
      parent: highlightModeDescriptionEl.parentElement,
      listen,
      handlers: {
        undo: handleKnnUndo,
        redo: handleKnnRedo,
        confirm: () => {
          viewer.confirmKnnSelection();
          state.clearPreviewHighlight();
        },
        cancel: () => {
          viewer.cancelKnnSelection();
        }
      }
    });
  }

  /**
   * Re-publish what the tool already holds, with one explanatory notice.
   *
   * The live preview repaints the highlight as the degree grows with the drag,
   * so a gesture that commits no step still has to restore the standing
   * selection the preview painted over.
   */
  function renderKnnState(notice) {
    const candidates = selectionState.lastKnnCandidates;
    if (candidates === null) {
      updateKnnUI(null, notice);
      state.clearPreviewHighlight();
      return;
    }
    if (candidates.length === 0) {
      updateKnnUI({ step: 0, candidateCount: 0, keepControls: true }, notice);
      state.clearPreviewHighlight();
      return;
    }
    updateKnnUI({
      step: selectionState.lastKnnStep,
      candidateCount: candidates.length,
      restored: true
    }, notice);
    state.setPreviewHighlightFromIndices(candidates);
  }

  function updateKnnUI(stepEvent, notice = '') {
    if (destroyed) return;
    const noticeHtml = selectionNoticeHtml(notice);
    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML =
        `${HIGHLIGHT_MODE_COPY.knn}${noticeHtml}`;
      removeStepControls(
        documentOwner,
        'knn',
        highlightModeDescriptionEl.parentElement
      );
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const stepInfo =
        '<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>';

      const { undoButton, redoButton, confirmButton } = getKnnControls();
      undoButton.disabled = selectionState.knnHistory.length === 0;
      redoButton.disabled = selectionState.knnRedoStack.length === 0;
      confirmButton.disabled = true;

      highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;
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

    highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;
  }

  function restoreKnnSelection(unifiedState) {
    if (destroyed) return;
    requireUnifiedSelectionState(unifiedState, state.pointCount);
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
      const operations = [() => lifecycleController.abort()];
      if (viewerNeedsUiRetirement(viewer)) {
        operations.push(
          () => viewer.setKnnCallback(() => {}),
          () => viewer.setKnnStepCallback(() => {}),
          () => viewer.setKnnPreviewCallback(() => {})
        );
      }
      for (const operation of operations) {
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
