/**
 * @fileoverview Annotation (Alt+click / Alt+drag) selection tool.
 *
 * Converts viewer selection gestures into highlight candidate sets with
 * undo/redo + confirm/cancel controls, and updates the preview highlight in
 * DataState while the selection is in progress.
 *
 * @module ui/modules/highlight/annotation-selection
 */

import { debug } from '../../../../utils/debug.js';
import {
  combineAnnotationCandidates,
  computeAnnotationGestureCells
} from './annotation-cells.js';
import {
  abandonedGestureNotice,
  ANNOTATION_NEEDS_FIELD_COPY,
  HIGHLIGHT_MODE_COPY,
  SELECTION_NOTICE,
  selectionNoticeHtml
} from './mode-copy.js';
import { MAX_HISTORY_STEPS, selectionUnchanged } from './selection-state.js';
import { getStepControls, removeStepControls } from './step-controls.js';
import {
  deliverSelectionToJupyter,
  showSelectionDeliveryFailure
} from './selection-notification.js';
import {
  requireAnnotationStepEvent,
  requireDomElement,
  requireExactKeys,
  requireHighlightSelectionState,
  requireJupyterSource,
  requireMethods,
  requireSavedHighlightGroup,
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
 * @param {() => void} options.ui.hideRangeLabel
 * @returns {{ handleAnnotationStep: (stepEvent: any) => void }}
 */
export function initAnnotationSelection(options) {
  requireExactKeys(
    options,
    ['state', 'viewer', 'jupyterSource', 'selectionState', 'ui'],
    'Annotation selection options'
  );
  const { state, viewer, jupyterSource, selectionState, ui } = options;
  requireMethods(
    state,
    'Annotation selection state',
    [
      'addHighlightDirect',
      'clearPreviewHighlight',
      'getActiveField',
      'getCategoryForCell',
      'getCellIndicesForCategory',
      'getCellIndicesForRange',
      'getValueForCell',
      'on',
      'setPreviewHighlightFromIndices'
    ]
  );
  requireMethods(
    viewer,
    'Annotation selection viewer',
    [
      'cancelAnnotationSelection',
      'confirmAnnotationSelection',
      'getViewTransparency',
      'restoreUnifiedState',
      'setSelectionStepCallback'
    ]
  );
  requireJupyterSource(jupyterSource);
  requireHighlightSelectionState(selectionState, state.pointCount);
  requireExactKeys(
    ui,
    ['modeDescriptionEl', 'hideRangeLabel'],
    'Annotation selection UI'
  );
  const highlightModeDescriptionEl = requireDomElement(
    ui.modeDescriptionEl,
    'Annotation mode description'
  );
  requireDomElement(
    highlightModeDescriptionEl.parentElement,
    'Annotation mode description parent',
    ['appendChild']
  );
  if (typeof ui.hideRangeLabel !== 'function') {
    throw new TypeError(
      'Annotation hideRangeLabel must be a function.'
    );
  }
  const hideRangeLabel = ui.hideRangeLabel;
  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'Annotation selection document',
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

  function computeAnnotationCellIndices(selectionEvent, viewTransparency) {
    const activeField = state.getActiveField();
    if (activeField === null) {
      throw new Error(
        'Annotation selection requires an active categorical or continuous field.'
      );
    }
    return computeAnnotationGestureCells({
      state,
      activeField,
      cellIndex: selectionEvent.cellIndex,
      gestureType: selectionEvent.type,
      dragDeltaY: selectionEvent.dragDeltaY,
      viewTransparency
    }).cellIndices;
  }

  /**
   * Drop the in-progress candidate set, in the tool and in the renderer.
   *
   * The other three tools keep their candidates inside the renderer, so their
   * own confirm and cancel clear the unified set. The annotation tool keeps
   * them here and publishes them with `restoreUnifiedState`, so it has to
   * retract them the same way; otherwise `mode-ui.js` reads the stale unified
   * state on the next mode switch and hands a cancelled or already-confirmed
   * selection back to whichever tool the user just picked.
   */
  function retireAnnotationCandidates() {
    selectionState.annotationCandidateSet = null;
    selectionState.annotationStepCount = 0;
    selectionState.annotationHistory = [];
    selectionState.annotationRedoStack = [];
    viewer.restoreUnifiedState([], 0);
  }

  function handleAnnotationStep(stepEvent) {
    if (destroyed) return;
    requireAnnotationStepEvent(stepEvent, state.pointCount);
    if (stepEvent.cancelled) {
      retireAnnotationCandidates();
      updateAnnotationUI(null);
      state.clearPreviewHighlight();
      return;
    }
    if (stepEvent.abandoned !== undefined) {
      // The gesture reached no cell, so there is nothing to combine — but it
      // was a real Alt+click, and answering it with nothing at all is what
      // reads as "Alt+click does not select".
      hideRangeLabel();
      renderAnnotationState(abandonedGestureNotice(stepEvent.abandoned));
      return;
    }

    hideRangeLabel();

    const activeField = state.getActiveField();
    if (activeField === null) {
      throw new Error(
        'Annotation selection requires an active categorical or continuous field.'
      );
    }

    const viewTransparency = viewer.getViewTransparency(stepEvent.viewId);
    const mode = stepEvent.mode;
    const newCellIndices = computeAnnotationCellIndices(stepEvent, viewTransparency);

    if (newCellIndices.length === 0 && mode !== 'subtract') {
      // The gesture landed on a cell the active field has no value for. Saying
      // nothing here is what reads as "the tool does not select".
      renderAnnotationState(SELECTION_NOTICE.noFieldValue);
      return;
    }

    const combined = combineAnnotationCandidates({
      candidates: selectionState.annotationCandidateSet,
      cellIndices: newCellIndices,
      mode,
      fieldKind: activeField.kind
    });

    if (
      selectionUnchanged(
        selectionState.annotationCandidateSet,
        combined.candidates
      )
    ) {
      renderAnnotationState(SELECTION_NOTICE.unchanged);
      return;
    }

    selectionState.annotationHistory.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });
    if (selectionState.annotationHistory.length > MAX_HISTORY_STEPS) {
      selectionState.annotationHistory.shift();
    }
    selectionState.annotationRedoStack = [];

    selectionState.annotationCandidateSet = combined.candidates;
    selectionState.annotationStepCount += 1;

    viewer.restoreUnifiedState(
      [...selectionState.annotationCandidateSet],
      selectionState.annotationStepCount
    );

    updateAnnotationUI({
      step: selectionState.annotationStepCount,
      candidateCount: selectionState.annotationCandidateSet.size,
      mode: combined.effectiveMode
    });

    if (selectionState.annotationCandidateSet.size > 0) {
      state.setPreviewHighlightFromIndices([...selectionState.annotationCandidateSet]);
    } else {
      state.clearPreviewHighlight();
    }
  }

  function handleAnnotationConfirm() {
    if (destroyed) return;
    if (!selectionState.annotationCandidateSet || selectionState.annotationCandidateSet.size === 0) {
      debug.log('[UI] Annotation selection empty');
      retireAnnotationCandidates();
      updateAnnotationUI(null);
      return;
    }

    const cellIndices = [...selectionState.annotationCandidateSet];
    const stepsLabel = selectionState.annotationStepCount > 1 ? ` (${selectionState.annotationStepCount} steps)` : '';

    const savedGroup = state.addHighlightDirect({
      type: 'annotation',
      label: `Annotation${stepsLabel} (${cellIndices.length.toLocaleString()} cells)`,
      cellIndices
    });
    requireSavedHighlightGroup(
      savedGroup,
      'annotation',
      cellIndices,
      'Saved annotation highlight group',
      state.pointCount
    );

    trackDelivery(deliverSelectionToJupyter({
      jupyterSource,
      cellIndices,
      source: 'annotation',
      onFailure: error => {
        if (!destroyed) showSelectionDeliveryFailure(error, 'annotation');
      }
    }));

    debug.log(`[UI] Annotation selected ${cellIndices.length} cells from ${selectionState.annotationStepCount} step(s)`);

    retireAnnotationCandidates();
    updateAnnotationUI(null);

    state.clearPreviewHighlight();
    viewer.confirmAnnotationSelection();
  }

  function handleAnnotationUndo() {
    if (destroyed) return;
    if (selectionState.annotationHistory.length === 0) return;

    const prevState =
      selectionState.annotationHistory[selectionState.annotationHistory.length - 1];
    const restoredCandidates = prevState.candidates === null
      ? []
      : [...prevState.candidates];
    viewer.restoreUnifiedState(
      restoredCandidates,
      restoredCandidates.length === 0 ? 0 : prevState.step
    );

    selectionState.annotationRedoStack.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });

    selectionState.annotationHistory.pop();
    selectionState.annotationCandidateSet = prevState.candidates;
    selectionState.annotationStepCount = prevState.step;

    if (selectionState.annotationCandidateSet && selectionState.annotationCandidateSet.size > 0) {
      updateAnnotationUI({
        step: selectionState.annotationStepCount,
        candidateCount: selectionState.annotationCandidateSet.size,
        restored: true
      });
      state.setPreviewHighlightFromIndices([...selectionState.annotationCandidateSet]);
    } else {
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        keepControls: true
      });
      state.clearPreviewHighlight();
    }
  }

  function handleAnnotationRedo() {
    if (destroyed) return;
    if (selectionState.annotationRedoStack.length === 0) return;

    const redoState =
      selectionState.annotationRedoStack[selectionState.annotationRedoStack.length - 1];
    const restoredCandidates = redoState.candidates === null
      ? []
      : [...redoState.candidates];
    viewer.restoreUnifiedState(
      restoredCandidates,
      restoredCandidates.length === 0 ? 0 : redoState.step
    );

    selectionState.annotationHistory.push({
      candidates: selectionState.annotationCandidateSet ? new Set(selectionState.annotationCandidateSet) : null,
      step: selectionState.annotationStepCount
    });

    selectionState.annotationRedoStack.pop();
    selectionState.annotationCandidateSet = redoState.candidates;
    selectionState.annotationStepCount = redoState.step;

    if (selectionState.annotationCandidateSet && selectionState.annotationCandidateSet.size > 0) {
      updateAnnotationUI({
        step: selectionState.annotationStepCount,
        candidateCount: selectionState.annotationCandidateSet.size,
        restored: true
      });
      state.setPreviewHighlightFromIndices([...selectionState.annotationCandidateSet]);
    } else {
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        keepControls: true
      });
      state.clearPreviewHighlight();
    }
  }

  function getAnnotationControls() {
    return getStepControls({
      documentOwner,
      tool: 'annotation',
      parent: highlightModeDescriptionEl.parentElement,
      listen,
      handlers: {
        undo: handleAnnotationUndo,
        redo: handleAnnotationRedo,
        confirm: handleAnnotationConfirm,
        cancel: () => {
          viewer.cancelAnnotationSelection();
        }
      }
    });
  }

  /**
   * Re-publish what the tool already holds, with one explanatory notice.
   *
   * The live preview repaints the highlight on every pointer move, including
   * the move that ends on nothing, so a gesture that commits no step still has
   * to restore the standing selection — otherwise the panel keeps saying
   * "Step 3: 812 cells" over a canvas the preview has already wiped.
   */
  function renderAnnotationState(notice) {
    const candidates = selectionState.annotationCandidateSet;
    if (candidates === null) {
      updateAnnotationUI(null, notice);
      state.clearPreviewHighlight();
      return;
    }
    if (candidates.size === 0) {
      updateAnnotationUI(
        { step: 0, candidateCount: 0, keepControls: true },
        notice
      );
      state.clearPreviewHighlight();
      return;
    }
    updateAnnotationUI({
      step: selectionState.annotationStepCount,
      candidateCount: candidates.size,
      restored: true
    }, notice);
    state.setPreviewHighlightFromIndices([...candidates]);
  }

  function updateAnnotationUI(stepEvent, notice = '') {
    if (destroyed) return;
    const activeField = state.getActiveField();
    const isCategorical =
      activeField !== null && activeField.kind === 'category';
    const noticeHtml = selectionNoticeHtml(notice);

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      // Without an active field the viewer never starts an annotation gesture
      // at all, so the idle copy has to say that instead of inviting a click
      // that cannot do anything.
      const idleCopy = activeField === null
        ? ANNOTATION_NEEDS_FIELD_COPY
        : HIGHLIGHT_MODE_COPY.annotation;
      highlightModeDescriptionEl.innerHTML = `${idleCopy}${noticeHtml}`;
      removeStepControls(
        documentOwner,
        'annotation',
        highlightModeDescriptionEl.parentElement
      );
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const helpText = isCategorical
        ? 'Alt to replace, Shift+Alt to add, Ctrl+Alt to subtract'
        : 'Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract';
      const stepInfo = `<strong>No selection</strong><br><small>${helpText}</small>`;

      const {
        undoButton,
        redoButton,
        confirmButton
      } = getAnnotationControls();
      undoButton.disabled = selectionState.annotationHistory.length === 0;
      redoButton.disabled = selectionState.annotationRedoStack.length === 0;
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
    } else if (stepEvent.mode === 'replace') {
      if (stepEvent.step > 1) {
        modeLabel = ' <span class="lasso-mode-tag intersect">replaced</span>';
      }
    } else if (stepEvent.step > 1) {
      modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
    }

    const helpText = isCategorical
      ? 'Alt to replace, Shift+Alt to add, Ctrl+Alt to subtract'
      : 'Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract';

    const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells${modeLabel}<br><small>${helpText}</small>`;

    const {
      undoButton,
      redoButton,
      confirmButton
    } = getAnnotationControls();
    undoButton.disabled = selectionState.annotationHistory.length === 0;
    redoButton.disabled = selectionState.annotationRedoStack.length === 0;
    confirmButton.disabled = stepEvent.candidateCount === 0;

    highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;
  }

  function restoreAnnotationSelection(unifiedState) {
    if (destroyed) return;
    requireUnifiedSelectionState(unifiedState, state.pointCount);
    selectionState.annotationHistory = [];
    selectionState.annotationRedoStack = [];
    selectionState.annotationCandidateSet = unifiedState.inProgress
      ? new Set(unifiedState.candidates)
      : null;
    selectionState.annotationStepCount = unifiedState.stepCount;
    if (!unifiedState.inProgress) {
      updateAnnotationUI(null);
      state.clearPreviewHighlight();
      return;
    }
    updateAnnotationUI({
      step: unifiedState.stepCount,
      candidateCount: unifiedState.candidateCount,
      restored: true
    });
    if (unifiedState.candidateCount === 0) {
      state.clearPreviewHighlight();
    } else {
      state.setPreviewHighlightFromIndices(unifiedState.candidates);
    }
  }

  viewer.setSelectionStepCallback(handleAnnotationStep);

  // Whether an annotation gesture can do anything is decided by the active
  // field, and the app publishes every change to it — and to the filters that
  // decide which cells a gesture may reach — as `visibility:changed`. Without
  // this the idle copy would keep whichever precondition was true when the mode
  // was last entered. Only the idle copy is refreshed: an in-progress selection
  // owns the panel, and the other three tools own it in their own modes.
  const unsubscribeVisibility = state.on('visibility:changed', () => {
    if (destroyed) return;
    if (selectionState.activeMode !== 'annotation') return;
    if (selectionState.annotationCandidateSet !== null) return;
    updateAnnotationUI(null);
  });
  if (typeof unsubscribeVisibility !== 'function') {
    throw new TypeError(
      'Annotation selection requires a visibility unsubscribe function.'
    );
  }

  return {
    handleAnnotationStep,
    restoreAnnotationSelection,
    destroy() {
      if (destructionPromise !== null) return destructionPromise;
      destroyed = true;
      const failures = [];
      try {
        lifecycleController.abort();
      } catch (error) {
        failures.push(error);
      }
      try {
        unsubscribeVisibility();
      } catch (error) {
        failures.push(error);
      }
      try {
        viewer.setSelectionStepCallback(() => {});
      } catch (error) {
        failures.push(error);
      }
      destructionPromise = Promise.allSettled(
        [...pendingDeliveries]
      ).then(() => {
        const exactFailures = [...new Set(failures)];
        if (exactFailures.length === 1) throw exactFailures[0];
        if (exactFailures.length > 1) {
          throw new AggregateError(
            exactFailures,
            'Annotation selection failed to release every owned resource.'
          );
        }
      });
      return destructionPromise;
    }
  };
}
