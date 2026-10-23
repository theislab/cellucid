/**
 * @fileoverview Annotation (Alt+click / Alt+drag) selection tool.
 *
 * Converts viewer selection gestures into highlight candidate sets with
 * undo/redo + confirm/cancel controls, and updates the preview highlight in
 * DataState while the selection is in progress.
 *
 * @module ui/modules/highlight/annotation-selection
 */

import { CellSet } from '../../../utils/cell-set.js';
import { debug } from '../../../../utils/debug.js';
import {
  annotationFieldForPane,
  combineAnnotationCandidates,
  computeAnnotationGestureCells
} from './annotation-cells.js';
import {
  abandonedGestureNotice,
  ANNOTATION_NEEDS_FIELD_COPY,
  HIGHLIGHT_MODE_COPY,
  SELECT_BAR_ANNOTATION_NEEDS_FIELD_HINT,
  SELECT_BAR_HINT,
  SELECTION_NOTICE,
  selectionNoticeHtml
} from './mode-copy.js';
import { pushHistoryStep, selectionUnchanged } from './selection-state.js';
import { viewerNeedsUiRetirement } from '../../core/viewer-lifecycle.js';
import {
  publishSelectBarHint,
  removeStepControls,
  showStepControls
} from './step-controls.js';
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
import { formatCount } from '../../components/display-format.js';

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
      'getCellIndicesForCategory',
      'getCellIndicesForRange',
      'getFieldForView',
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
      'onPresentedLayoutChange',
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
  // Kind of the field the last gesture was read with: the field of the pane
  // it landed in, which need not be the focused view's. The step help text
  // ("Alt to replace" for categories, "Alt to intersect" for ranges) follows
  // it, so it describes the panel the user is selecting in.
  let gestureFieldKind = null;
  // Views on screen, from the last presented layout; null until the canvas
  // has an area, when only the focused view is known.
  let presentedViewIds = null;

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
    gestureFieldKind = null;
    viewer.restoreUnifiedState(new Uint32Array(0), 0);
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

    // The gesture is read on the pane it landed in — its field and its
    // filters — and never moves view focus, so the focused view's field is
    // not the one to read when the two differ.
    const field = annotationFieldForPane(state, stepEvent.viewId);
    if (field === null) {
      renderAnnotationState(SELECTION_NOTICE.noPanelField);
      return;
    }
    gestureFieldKind = field.kind;

    const mode = stepEvent.mode;
    const newCellIndices = computeAnnotationGestureCells({
      state,
      field,
      cellIndex: stepEvent.cellIndex,
      gestureType: stepEvent.type,
      dragDeltaY: stepEvent.dragDeltaY,
      viewTransparency: viewer.getViewTransparency(stepEvent.viewId)
    }).cellIndices;

    if (newCellIndices.length === 0 && mode !== 'subtract') {
      // The gesture landed on a cell the pane's field has no value for.
      // Saying nothing here is what reads as "the tool does not select".
      renderAnnotationState(SELECTION_NOTICE.noFieldValue);
      return;
    }

    const combined = combineAnnotationCandidates({
      candidates: selectionState.annotationCandidateSet,
      cellIndices: newCellIndices,
      mode,
      fieldKind: field.kind,
      cellCount: state.pointCount
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

    pushHistoryStep(selectionState, 'annotationHistory', {
      candidates: selectionState.annotationCandidateSet ? selectionState.annotationCandidateSet.clone() : null,
      step: selectionState.annotationStepCount
    });
    selectionState.annotationRedoStack = [];

    selectionState.annotationCandidateSet = combined.candidates;
    selectionState.annotationStepCount += 1;

    viewer.restoreUnifiedState(
      selectionState.annotationCandidateSet.toUint32Array(),
      selectionState.annotationStepCount
    );

    updateAnnotationUI({
      step: selectionState.annotationStepCount,
      candidateCount: selectionState.annotationCandidateSet.size,
      mode: combined.effectiveMode
    });

    if (selectionState.annotationCandidateSet.size > 0) {
      state.setPreviewHighlightFromIndices(selectionState.annotationCandidateSet.toUint32Array());
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

    const cellIndices = selectionState.annotationCandidateSet.toUint32Array();
    const stepsLabel = selectionState.annotationStepCount > 1 ? ` (${selectionState.annotationStepCount} steps)` : '';

    const savedGroup = state.addHighlightDirect({
      type: 'annotation',
      label: `Annotation${stepsLabel} (${formatCount(cellIndices.length)} cells)`,
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
      ? new Uint32Array(0)
      : prevState.candidates.toUint32Array();
    viewer.restoreUnifiedState(
      restoredCandidates,
      restoredCandidates.length === 0 ? 0 : prevState.step
    );

    selectionState.annotationRedoStack.push({
      candidates: selectionState.annotationCandidateSet ? selectionState.annotationCandidateSet.clone() : null,
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
      state.setPreviewHighlightFromIndices(selectionState.annotationCandidateSet.toUint32Array());
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
      ? new Uint32Array(0)
      : redoState.candidates.toUint32Array();
    viewer.restoreUnifiedState(
      restoredCandidates,
      restoredCandidates.length === 0 ? 0 : redoState.step
    );

    selectionState.annotationHistory.push({
      candidates: selectionState.annotationCandidateSet ? selectionState.annotationCandidateSet.clone() : null,
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
      state.setPreviewHighlightFromIndices(selectionState.annotationCandidateSet.toUint32Array());
    } else {
      updateAnnotationUI({
        step: 0,
        candidateCount: 0,
        keepControls: true
      });
      state.clearPreviewHighlight();
    }
  }

  /**
   * Publish the step controls for a selection of `candidateCount` cells, on
   * the panel and the selection bar alike.
   */
  function showAnnotationControls(candidateCount, notice) {
    showStepControls({
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
      },
      readout: {
        candidateCount,
        canUndo: selectionState.annotationHistory.length > 0,
        canRedo: selectionState.annotationRedoStack.length > 0,
        notice
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
    state.setPreviewHighlightFromIndices(candidates.toUint32Array());
  }

  /**
   * Can an annotation press on screen select anything at all?
   *
   * A press reads the field of the pane it lands in, so the answer is "no"
   * only when no presented pane is colored by a field; in a grid the focused
   * view having none is not enough.
   */
  function anyPresentedPaneHasField() {
    if (presentedViewIds === null) return state.getActiveField() !== null;
    return presentedViewIds.some(
      viewId => annotationFieldForPane(state, viewId) !== null
    );
  }

  function updateAnnotationUI(stepEvent, notice = '') {
    if (destroyed) return;
    const activeField = state.getActiveField();
    // The help line describes the panel the last gesture was read in; before
    // any gesture that is the focused view, where a selection starts.
    const helpFieldKind = gestureFieldKind
      ?? (activeField === null ? null : activeField.kind);
    const isCategorical = helpFieldKind === 'category';
    const noticeHtml = selectionNoticeHtml(notice);

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      // With no field on any pane on screen, no press can select anything,
      // so the idle copy has to say that instead of inviting a click that
      // cannot do anything. A press in one field-less pane of a grid is
      // answered on its own (`noPanelField`).
      const canSelect = anyPresentedPaneHasField();
      const idleCopy = canSelect
        ? HIGHLIGHT_MODE_COPY.annotation
        : ANNOTATION_NEEDS_FIELD_COPY;
      highlightModeDescriptionEl.innerHTML = `${idleCopy}${noticeHtml}`;
      publishSelectBarHint(
        documentOwner,
        canSelect
          ? SELECT_BAR_HINT.annotation
          : SELECT_BAR_ANNOTATION_NEEDS_FIELD_HINT
      );
      removeStepControls(
        documentOwner,
        'annotation',
        highlightModeDescriptionEl.parentElement,
        notice
      );
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const helpText = isCategorical
        ? 'Alt to replace, Shift+Alt to add, Ctrl+Alt to subtract'
        : 'Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract';
      const stepInfo = `<strong>No selection</strong><br><small>${helpText}</small>`;

      showAnnotationControls(0, notice);

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

    const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${formatCount(stepEvent.candidateCount)} cells${modeLabel}<br><small>${helpText}</small>`;

    showAnnotationControls(stepEvent.candidateCount, notice);

    highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;
  }

  function restoreAnnotationSelection(unifiedState) {
    if (destroyed) return;
    requireUnifiedSelectionState(unifiedState, state.pointCount);
    selectionState.annotationHistory = [];
    selectionState.annotationRedoStack = [];
    gestureFieldKind = null;
    selectionState.annotationCandidateSet = unifiedState.inProgress
      ? CellSet.fromCellList(unifiedState.candidates, state.pointCount)
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

  // Whether an annotation gesture can do anything is decided by the fields of
  // the panes on screen. The app publishes every field change — and every
  // change to the filters that decide which cells a gesture may reach — as
  // `visibility:changed`, and the viewer publishes every change to which
  // panes are on screen (a kept or removed view, single or grid layout) as a
  // new presented layout. Without both the idle copy would keep whichever
  // precondition was true when the mode was last entered. Only the idle copy
  // is refreshed: an in-progress selection owns the panel, and the other
  // three tools own it in their own modes.
  function refreshIdleCopy() {
    if (destroyed) return;
    if (selectionState.activeMode !== 'annotation') return;
    if (selectionState.annotationCandidateSet !== null) return;
    updateAnnotationUI(null);
  }
  const unsubscribeVisibility = state.on('visibility:changed', refreshIdleCopy);
  if (typeof unsubscribeVisibility !== 'function') {
    throw new TypeError(
      'Annotation selection requires a visibility unsubscribe function.'
    );
  }
  const unsubscribeLayout = viewer.onPresentedLayoutChange(layout => {
    presentedViewIds = layout.panes.map(pane => pane.viewId);
    refreshIdleCopy();
  });
  if (typeof unsubscribeLayout !== 'function') {
    throw new TypeError(
      'Annotation selection requires a presented-layout unsubscribe function.'
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
        unsubscribeLayout();
      } catch (error) {
        failures.push(error);
      }
      if (viewerNeedsUiRetirement(viewer)) {
        try {
          viewer.setSelectionStepCallback(() => {});
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
            'Annotation selection failed to release every owned resource.'
          );
        }
      });
      return destructionPromise;
    }
  };
}
