/**
 * @fileoverview KNN drag selection tool.
 *
 * Tracks multi-step KNN selections with undo/redo and updates the preview
 * highlight during drags.
 *
 * @module ui/modules/highlight/knn-selection
 */

import { debug } from '../../../utils/debug.js';
import { HIGHLIGHT_MODE_COPY } from './mode-copy.js';
import { MAX_HISTORY_STEPS } from './selection-state.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {ReturnType<import('./selection-state.js').createHighlightSelectionState>} options.selectionState
 * @param {object} options.ui
 * @param {HTMLElement|null} options.ui.modeDescriptionEl
 * @returns {{ handleKnnStep: (stepEvent: any) => void }}
 */
export function initKnnSelection({ state, viewer, selectionState, ui }) {
  const highlightModeDescriptionEl = ui?.modeDescriptionEl || null;

  function handleKnnSelection(knnEvent) {
    if (!knnEvent || !knnEvent.cellIndices || knnEvent.cellIndices.length === 0) {
      debug.log('[UI] KNN selection empty');
      state.clearPreviewHighlight?.();
      selectionState.knnHistory = [];
      selectionState.knnRedoStack = [];
      selectionState.lastKnnCandidates = null;
      selectionState.lastKnnStep = 0;
      updateKnnUI(null);
      return;
    }

    const stepsLabel = knnEvent.steps > 1 ? ` (${knnEvent.steps} selections)` : '';
    const group = state.addHighlightDirect({
      type: 'knn',
      label: `KNN${stepsLabel} (${knnEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: knnEvent.cellIndices
    });

    if (group) {
      debug.log(`[UI] KNN selected ${knnEvent.cellCount} cells from ${knnEvent.steps} selection(s)`);
    }

    selectionState.knnHistory = [];
    selectionState.knnRedoStack = [];
    selectionState.lastKnnCandidates = null;
    selectionState.lastKnnStep = 0;
    updateKnnUI(null);
  }

  function handleKnnStep(stepEvent) {
    if (stepEvent.cancelled) {
      selectionState.knnHistory = [];
      selectionState.knnRedoStack = [];
      selectionState.lastKnnCandidates = null;
      selectionState.lastKnnStep = 0;
      updateKnnUI(null);
      state.clearPreviewHighlight?.();
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

    selectionState.lastKnnCandidates = stepEvent.candidates ? [...stepEvent.candidates] : null;
    selectionState.lastKnnStep = stepEvent.step;

    updateKnnUI(stepEvent);

    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices?.(stepEvent.candidates);
    } else {
      state.clearPreviewHighlight?.();
    }
  }

  function handleKnnUndo() {
    if (selectionState.knnHistory.length === 0) return;

    selectionState.knnRedoStack.push({
      candidates: selectionState.lastKnnCandidates ? [...selectionState.lastKnnCandidates] : null,
      step: selectionState.lastKnnStep
    });

    const prevState = selectionState.knnHistory.pop();
    selectionState.lastKnnCandidates = prevState.candidates;
    selectionState.lastKnnStep = prevState.step;

    viewer.restoreKnnState?.(prevState.candidates, prevState.step);

    if (prevState.candidates && prevState.candidates.length > 0) {
      updateKnnUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        candidates: prevState.candidates,
        mode: 'intersect',
        degree: 0
      });
      state.setPreviewHighlightFromIndices?.(prevState.candidates);
    } else {
      updateKnnUI({ step: 0, candidateCount: 0, mode: 'intersect', degree: 0, keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  function handleKnnRedo() {
    if (selectionState.knnRedoStack.length === 0) return;

    selectionState.knnHistory.push({
      candidates: selectionState.lastKnnCandidates ? [...selectionState.lastKnnCandidates] : null,
      step: selectionState.lastKnnStep
    });

    const redoState = selectionState.knnRedoStack.pop();
    selectionState.lastKnnCandidates = redoState.candidates;
    selectionState.lastKnnStep = redoState.step;

    viewer.restoreKnnState?.(redoState.candidates, redoState.step);

    if (redoState.candidates && redoState.candidates.length > 0) {
      updateKnnUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        candidates: redoState.candidates,
        mode: 'intersect',
        degree: 0
      });
      state.setPreviewHighlightFromIndices?.(redoState.candidates);
    } else {
      updateKnnUI({ step: 0, candidateCount: 0, mode: 'intersect', degree: 0, keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  function handleKnnPreview(previewEvent) {
    if (!previewEvent || !previewEvent.cellIndices) return;

    if (previewEvent.cellIndices.length > 0) {
      state.setPreviewHighlightFromIndices?.(previewEvent.cellIndices);
    } else {
      state.clearPreviewHighlight?.();
    }
  }

  function updateKnnUI(stepEvent) {
    if (!highlightModeDescriptionEl) return;

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.knn;
      const existingControls = document.getElementById('knn-step-controls');
      if (existingControls) existingControls.remove();
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const stepInfo =
        '<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>';

      let controls = document.getElementById('knn-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'knn-step-controls';
        controls.className = 'lasso-step-controls';
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="knn-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="knn-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="knn-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="knn-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement?.appendChild(controls);

        document.getElementById('knn-undo-btn')?.addEventListener('click', () => handleKnnUndo());
        document.getElementById('knn-redo-btn')?.addEventListener('click', () => handleKnnRedo());
        document.getElementById('knn-confirm-btn')?.addEventListener('click', () => {
          viewer.confirmKnnSelection?.();
          state.clearPreviewHighlight?.();
        });
        document.getElementById('knn-cancel-btn')?.addEventListener('click', () => viewer.cancelKnnSelection?.());
      }

      const undoBtn = document.getElementById('knn-undo-btn');
      const redoBtn = document.getElementById('knn-redo-btn');
      const confirmBtn = document.getElementById('knn-confirm-btn');
      if (undoBtn) undoBtn.disabled = selectionState.knnHistory.length === 0;
      if (redoBtn) redoBtn.disabled = selectionState.knnRedoStack.length === 0;
      if (confirmBtn) confirmBtn.disabled = true;

      highlightModeDescriptionEl.innerHTML = stepInfo;
      return;
    }

    let modeLabel = '';
    if (stepEvent.mode === 'union') {
      modeLabel = ' <span class="lasso-mode-tag union">+added</span>';
    } else if (stepEvent.mode === 'subtract') {
      modeLabel = ' <span class="lasso-mode-tag subtract">−removed</span>';
    } else if (stepEvent.step > 1) {
      modeLabel = ' <span class="lasso-mode-tag intersect">intersected</span>';
    }

    const degreeLabel = stepEvent.degree === 0 ? 'seed only' : `${stepEvent.degree}° neighbors`;
    const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells (${degreeLabel})${modeLabel}<br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

    let controls = document.getElementById('knn-step-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'knn-step-controls';
      controls.className = 'lasso-step-controls';
      controls.innerHTML = `
        <button type="button" class="btn-small lasso-confirm" id="knn-confirm-btn">Confirm</button>
        <button type="button" class="btn-small btn-undo" id="knn-undo-btn" title="Undo">↩</button>
        <button type="button" class="btn-small btn-redo" id="knn-redo-btn" title="Redo">↪</button>
        <button type="button" class="btn-small lasso-cancel" id="knn-cancel-btn">Cancel</button>
      `;
      highlightModeDescriptionEl.parentElement?.appendChild(controls);

      document.getElementById('knn-undo-btn')?.addEventListener('click', () => handleKnnUndo());
      document.getElementById('knn-redo-btn')?.addEventListener('click', () => handleKnnRedo());
      document.getElementById('knn-confirm-btn')?.addEventListener('click', () => {
        viewer.confirmKnnSelection?.();
        state.clearPreviewHighlight?.();
      });
      document.getElementById('knn-cancel-btn')?.addEventListener('click', () => viewer.cancelKnnSelection?.());
    }

    const undoBtn = document.getElementById('knn-undo-btn');
    const redoBtn = document.getElementById('knn-redo-btn');
    if (undoBtn) undoBtn.disabled = selectionState.knnHistory.length === 0;
    if (redoBtn) redoBtn.disabled = selectionState.knnRedoStack.length === 0;

    highlightModeDescriptionEl.innerHTML = stepInfo;
  }

  if (viewer.setKnnCallback) {
    viewer.setKnnCallback(handleKnnSelection);
  }
  if (viewer.setKnnStepCallback) {
    viewer.setKnnStepCallback(handleKnnStep);
  }
  if (viewer.setKnnPreviewCallback) {
    viewer.setKnnPreviewCallback(handleKnnPreview);
  }

  return { handleKnnStep };
}

