/**
 * @fileoverview Proximity drag selection tool.
 *
 * Tracks multi-step proximity selections with undo/redo and updates the preview
 * highlight during drags.
 *
 * @module ui/modules/highlight/proximity-selection
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
  requireHighlightSelectionState(selectionState, state.pointCount);
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
    requireCompletedSelectionEvent(
      proximityEvent,
      'proximity',
      state.pointCount
    );

    const stepsLabel = proximityEvent.steps > 1 ? ` (${proximityEvent.steps} drags)` : '';
    const savedGroup = state.addHighlightDirect({
      type: 'proximity',
      label: `Proximity${stepsLabel} (${proximityEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: proximityEvent.cellIndices
    });
    requireSavedHighlightGroup(
      savedGroup,
      'proximity',
      proximityEvent.cellIndices,
      'Saved proximity highlight group',
      state.pointCount
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
      state.pointCount,
      ['centerCellIndex', 'radius']
    );
    if (stepEvent.abandoned !== undefined) {
      renderProximityState(abandonedGestureNotice(stepEvent.abandoned));
      return;
    }
    if (stepEvent.cancelled !== true) {
      // A drag that starts on empty space while a selection already exists is
      // centred on that selection's plane, and the renderer reports -1 for the
      // cell it did not hit. The preview accepts that; so must the step, or the
      // add or subtract the user just drew is thrown away at release.
      requireSafeInteger(
        stepEvent.centerCellIndex,
        'Proximity step centerCellIndex',
        -1
      );
      if (stepEvent.centerCellIndex >= 0) {
        requireCellIndex(
          stepEvent.centerCellIndex,
          'Proximity step centerCellIndex',
          state.pointCount
        );
      }
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

    if (
      selectionUnchanged(
        selectionState.lastProximityCandidates,
        stepEvent.candidates
      )
    ) {
      // Roll the renderer's own step counter back, or the next real step is
      // numbered as if this one had happened.
      viewer.restoreProximityState(
        selectionState.lastProximityCandidates,
        selectionState.lastProximityStep
      );
      renderProximityState(SELECTION_NOTICE.unchanged);
      return;
    }

    // The empty state before the first step is recorded like any other, so
    // Undo can reach it — the annotation tool has always done this, and a
    // greyed-out Undo immediately after dragging reads as a broken control.
    selectionState.proximityHistory.push({
      candidates: selectionState.lastProximityCandidates ? [...selectionState.lastProximityCandidates] : null,
      step: selectionState.lastProximityStep
    });
    if (selectionState.proximityHistory.length > MAX_HISTORY_STEPS) {
      selectionState.proximityHistory.shift();
    }
    selectionState.proximityRedoStack = [];

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
      state.pointCount,
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
    if (previewEvent.centerCellIndex >= 0) {
      requireCellIndex(
        previewEvent.centerCellIndex,
        'Proximity preview centerCellIndex',
        state.pointCount
      );
    }
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
    return getStepControls({
      documentOwner,
      tool: 'proximity',
      parent: highlightModeDescriptionEl.parentElement,
      listen,
      handlers: {
        undo: handleProximityUndo,
        redo: handleProximityRedo,
        confirm: () => {
          viewer.confirmProximitySelection();
          state.clearPreviewHighlight();
        },
        cancel: () => {
          viewer.cancelProximitySelection();
        }
      }
    });
  }

  /**
   * Re-publish what the tool already holds, with one explanatory notice.
   *
   * The live preview repaints the highlight throughout the drag, so a gesture
   * that commits no step still has to restore the standing selection the
   * preview painted over.
   */
  function renderProximityState(notice) {
    const candidates = selectionState.lastProximityCandidates;
    if (candidates === null) {
      updateProximityUI(null, notice);
      state.clearPreviewHighlight();
      return;
    }
    if (candidates.length === 0) {
      updateProximityUI(
        { step: 0, candidateCount: 0, keepControls: true },
        notice
      );
      state.clearPreviewHighlight();
      return;
    }
    updateProximityUI({
      step: selectionState.lastProximityStep,
      candidateCount: candidates.length,
      restored: true
    }, notice);
    state.setPreviewHighlightFromIndices(candidates);
  }

  function updateProximityUI(stepEvent, notice = '') {
    if (destroyed) return;
    const noticeHtml = selectionNoticeHtml(notice);
    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML =
        `${HIGHLIGHT_MODE_COPY.proximity}${noticeHtml}`;
      removeStepControls(
        documentOwner,
        'proximity',
        highlightModeDescriptionEl.parentElement
      );
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

    const {
      undoButton,
      redoButton,
      confirmButton
    } = getProximityControls();
    undoButton.disabled = selectionState.proximityHistory.length === 0;
    redoButton.disabled = selectionState.proximityRedoStack.length === 0;
    confirmButton.disabled = stepEvent.candidateCount === 0;

    highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;
  }

  function restoreProximitySelection(unifiedState) {
    if (destroyed) return;
    requireUnifiedSelectionState(unifiedState, state.pointCount);
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
      const operations = [() => lifecycleController.abort()];
      if (viewerNeedsUiRetirement(viewer)) {
        operations.push(
          () => viewer.setProximityCallback(() => {}),
          () => viewer.setProximityStepCallback(() => {}),
          () => viewer.setProximityPreviewCallback(() => {})
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
            'Proximity selection failed to release every owned resource.'
          );
        }
      });
      return destructionPromise;
    }
  };
}
