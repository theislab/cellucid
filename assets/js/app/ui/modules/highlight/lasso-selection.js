/**
 * @fileoverview Lasso selection tool.
 *
 * Tracks multi-step lasso selections with undo/redo and updates the preview
 * highlight while the selection is in progress.
 *
 * @module ui/modules/highlight/lasso-selection
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
  requireHighlightSelectionState(selectionState, state.pointCount);
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

  function handleLassoSelection(lassoEvent) {
    if (destroyed) return;
    requireCompletedSelectionEvent(lassoEvent, 'lasso', state.pointCount);

    const stepsLabel = lassoEvent.steps > 1 ? ` (${lassoEvent.steps} views)` : '';
    const savedGroup = state.addHighlightDirect({
      type: 'lasso',
      label: `Lasso${stepsLabel} (${lassoEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: lassoEvent.cellIndices
    });
    requireSavedHighlightGroup(
      savedGroup,
      'lasso',
      lassoEvent.cellIndices,
      'Saved lasso highlight group',
      state.pointCount
    );

    debug.log(`[UI] Lasso selected ${lassoEvent.cellCount} cells from ${lassoEvent.steps} view(s)`);
    trackDelivery(deliverSelectionToJupyter({
      jupyterSource,
      cellIndices: lassoEvent.cellIndices,
      source: 'lasso',
      onFailure: error => {
        if (!destroyed) showSelectionDeliveryFailure(error, 'lasso');
      }
    }));

    selectionState.lassoHistory = [];
    selectionState.lassoRedoStack = [];
    selectionState.lastLassoCandidates = null;
    selectionState.lastLassoStep = 0;
    updateLassoUI(null);
  }

  function handleLassoStep(stepEvent) {
    if (destroyed) return;
    requireSelectionStepEvent(stepEvent, 'lasso', state.pointCount);
    if (stepEvent.cancelled) {
      selectionState.lassoHistory = [];
      selectionState.lassoRedoStack = [];
      selectionState.lastLassoCandidates = null;
      selectionState.lastLassoStep = 0;
      updateLassoUI(null);
      state.clearPreviewHighlight();
      return;
    }
    if (stepEvent.abandoned !== undefined) {
      renderLassoState(abandonedGestureNotice(stepEvent.abandoned));
      return;
    }

    if (
      selectionUnchanged(
        selectionState.lastLassoCandidates,
        stepEvent.candidates
      )
    ) {
      // Roll the renderer's own step counter back, or the next real step is
      // numbered as if this one had happened.
      viewer.restoreLassoState(
        selectionState.lastLassoCandidates,
        selectionState.lastLassoStep
      );
      renderLassoState(SELECTION_NOTICE.unchanged);
      return;
    }

    // The empty state before the first step is recorded like any other, so
    // Undo can reach it — the annotation tool has always done this, and a
    // greyed-out Undo immediately after drawing reads as a broken control.
    selectionState.lassoHistory.push({
      candidates: selectionState.lastLassoCandidates ? [...selectionState.lastLassoCandidates] : null,
      step: selectionState.lastLassoStep
    });
    if (selectionState.lassoHistory.length > MAX_HISTORY_STEPS) {
      selectionState.lassoHistory.shift();
    }
    selectionState.lassoRedoStack = [];

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
    if (destroyed) return;
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
    if (destroyed) return;
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
    if (destroyed) return;
    requireSelectionPreviewEvent(
      previewEvent,
      'lasso',
      state.pointCount,
      ['polygon', 'mode', 'newCellCount']
    );
    requireSafeInteger(
      previewEvent.newCellCount,
      'Lasso preview newCellCount',
      0
    );
    requireCombineMode(previewEvent.mode, 'Lasso preview');
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
    // cellIndices is the combined set the release would commit, exactly as the
    // KNN and proximity previews publish it; newCellCount is this polygon's own
    // hit count before combining.
    if (previewEvent.cellIndices.length === 0) {
      state.clearPreviewHighlight();
    } else {
      state.setPreviewHighlightFromIndices(previewEvent.cellIndices);
    }
  }

  function getLassoControls() {
    return getStepControls({
      documentOwner,
      tool: 'lasso',
      parent: highlightModeDescriptionEl.parentElement,
      listen,
      handlers: {
        undo: handleLassoUndo,
        redo: handleLassoRedo,
        confirm: () => {
          viewer.confirmLassoSelection();
          state.clearPreviewHighlight();
        },
        cancel: () => {
          viewer.cancelLassoSelection();
        }
      }
    });
  }

  /**
   * Re-publish what the tool already holds, with one explanatory notice.
   *
   * The live preview repaints the highlight while the polygon is being drawn,
   * so a gesture that commits no step still has to restore the standing
   * selection the preview painted over.
   */
  function renderLassoState(notice) {
    const candidates = selectionState.lastLassoCandidates;
    if (candidates === null) {
      updateLassoUI(null, notice);
      state.clearPreviewHighlight();
      return;
    }
    if (candidates.length === 0) {
      updateLassoUI({ step: 0, candidateCount: 0, keepControls: true }, notice);
      state.clearPreviewHighlight();
      return;
    }
    updateLassoUI({
      step: selectionState.lastLassoStep,
      candidateCount: candidates.length,
      restored: true
    }, notice);
    state.setPreviewHighlightFromIndices(candidates);
  }

  function updateLassoUI(stepEvent, notice = '') {
    if (destroyed) return;
    const noticeHtml = selectionNoticeHtml(notice);
    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML =
        `${HIGHLIGHT_MODE_COPY.lasso}${noticeHtml}`;
      removeStepControls(
        documentOwner,
        'lasso',
        highlightModeDescriptionEl.parentElement
      );
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const stepInfo =
        '<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>';

      const { undoButton, redoButton, confirmButton } = getLassoControls();
      undoButton.disabled = selectionState.lassoHistory.length === 0;
      redoButton.disabled = selectionState.lassoRedoStack.length === 0;
      confirmButton.disabled = true;

      highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;
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

    highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;
  }

  function restoreLassoSelection(unifiedState) {
    if (destroyed) return;
    requireUnifiedSelectionState(unifiedState, state.pointCount);
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

  return {
    handleLassoStep,
    restoreLassoSelection,
    destroy() {
      if (destructionPromise !== null) return destructionPromise;
      destroyed = true;
      const failures = [];
      const operations = [() => lifecycleController.abort()];
      if (viewerNeedsUiRetirement(viewer)) {
        operations.push(
          () => viewer.setLassoCallback(() => {}),
          () => viewer.setLassoPreviewCallback(() => {}),
          () => viewer.setLassoStepCallback(() => {})
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
            'Lasso selection failed to release every owned resource.'
          );
        }
      });
      return destructionPromise;
    }
  };
}
