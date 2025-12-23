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

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {ReturnType<import('./selection-state.js').createHighlightSelectionState>} options.selectionState
 * @param {object} options.ui
 * @param {HTMLElement|null} options.ui.modeDescriptionEl
 * @returns {{ handleLassoStep: (stepEvent: any) => void }}
 */
export function initLassoSelection({ state, viewer, selectionState, ui }) {
  const highlightModeDescriptionEl = ui?.modeDescriptionEl || null;

  function handleLassoSelection(lassoEvent) {
    if (!lassoEvent.cellIndices || lassoEvent.cellIndices.length === 0) {
      debug.log('[UI] Lasso selection empty');
      state.clearPreviewHighlight?.();
      selectionState.lassoHistory = [];
      selectionState.lassoRedoStack = [];
      selectionState.lastLassoCandidates = null;
      selectionState.lastLassoStep = 0;
      updateLassoUI(null);
      return;
    }

    const stepsLabel = lassoEvent.steps > 1 ? ` (${lassoEvent.steps} views)` : '';
    const group = state.addHighlightDirect({
      type: 'lasso',
      label: `Lasso${stepsLabel} (${lassoEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: lassoEvent.cellIndices
    });

    if (group) {
      debug.log(`[UI] Lasso selected ${lassoEvent.cellCount} cells from ${lassoEvent.steps} view(s)`);
    }

    selectionState.lassoHistory = [];
    selectionState.lassoRedoStack = [];
    selectionState.lastLassoCandidates = null;
    selectionState.lastLassoStep = 0;
    updateLassoUI(null);
  }

  function handleLassoStep(stepEvent) {
    if (stepEvent.cancelled) {
      selectionState.lassoHistory = [];
      selectionState.lassoRedoStack = [];
      selectionState.lastLassoCandidates = null;
      selectionState.lastLassoStep = 0;
      updateLassoUI(null);
      state.clearPreviewHighlight?.();
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

    selectionState.lastLassoCandidates = stepEvent.candidates ? [...stepEvent.candidates] : null;
    selectionState.lastLassoStep = stepEvent.step;

    updateLassoUI(stepEvent);

    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices?.(stepEvent.candidates);
    } else {
      state.clearPreviewHighlight?.();
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

    viewer.restoreLassoState?.(prevState.candidates, prevState.step);

    if (prevState.candidates && prevState.candidates.length > 0) {
      updateLassoUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        candidates: prevState.candidates,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.(prevState.candidates);
    } else {
      updateLassoUI({ step: 0, candidateCount: 0, mode: 'intersect', keepControls: true });
      state.clearPreviewHighlight?.();
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

    viewer.restoreLassoState?.(redoState.candidates, redoState.step);

    if (redoState.candidates && redoState.candidates.length > 0) {
      updateLassoUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        candidates: redoState.candidates,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.(redoState.candidates);
    } else {
      updateLassoUI({ step: 0, candidateCount: 0, mode: 'intersect', keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  function updateLassoUI(stepEvent) {
    if (!highlightModeDescriptionEl) return;

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.lasso;
      const existingControls = document.getElementById('lasso-step-controls');
      if (existingControls) existingControls.remove();
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const stepInfo =
        '<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>';

      let controls = document.getElementById('lasso-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'lasso-step-controls';
        controls.className = 'lasso-step-controls';
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="lasso-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="lasso-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="lasso-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="lasso-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement?.appendChild(controls);

        document.getElementById('lasso-undo-btn')?.addEventListener('click', () => handleLassoUndo());
        document.getElementById('lasso-redo-btn')?.addEventListener('click', () => handleLassoRedo());
        document.getElementById('lasso-confirm-btn')?.addEventListener('click', () => {
          viewer.confirmLassoSelection?.();
          state.clearPreviewHighlight?.();
        });
        document.getElementById('lasso-cancel-btn')?.addEventListener('click', () => viewer.cancelLassoSelection?.());
      }

      const undoBtn = document.getElementById('lasso-undo-btn');
      const redoBtn = document.getElementById('lasso-redo-btn');
      const confirmBtn = document.getElementById('lasso-confirm-btn');
      if (undoBtn) undoBtn.disabled = selectionState.lassoHistory.length === 0;
      if (redoBtn) redoBtn.disabled = selectionState.lassoRedoStack.length === 0;
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

    const stepInfo = `<strong>Step ${stepEvent.step}:</strong> ${stepEvent.candidateCount.toLocaleString()} cells${modeLabel}<br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>`;

    let controls = document.getElementById('lasso-step-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'lasso-step-controls';
      controls.className = 'lasso-step-controls';
      controls.innerHTML = `
        <button type="button" class="btn-small lasso-confirm" id="lasso-confirm-btn">Confirm</button>
        <button type="button" class="btn-small btn-undo" id="lasso-undo-btn" title="Undo">↩</button>
        <button type="button" class="btn-small btn-redo" id="lasso-redo-btn" title="Redo">↪</button>
        <button type="button" class="btn-small lasso-cancel" id="lasso-cancel-btn">Cancel</button>
      `;
      highlightModeDescriptionEl.parentElement?.appendChild(controls);

      document.getElementById('lasso-undo-btn')?.addEventListener('click', () => handleLassoUndo());
      document.getElementById('lasso-redo-btn')?.addEventListener('click', () => handleLassoRedo());
      document.getElementById('lasso-confirm-btn')?.addEventListener('click', () => {
        viewer.confirmLassoSelection?.();
        state.clearPreviewHighlight?.();
      });
      document.getElementById('lasso-cancel-btn')?.addEventListener('click', () => viewer.cancelLassoSelection?.());
    }

    const undoBtn = document.getElementById('lasso-undo-btn');
    const redoBtn = document.getElementById('lasso-redo-btn');
    if (undoBtn) undoBtn.disabled = selectionState.lassoHistory.length === 0;
    if (redoBtn) redoBtn.disabled = selectionState.lassoRedoStack.length === 0;

    highlightModeDescriptionEl.innerHTML = stepInfo;
  }

  if (viewer.setLassoCallback) {
    viewer.setLassoCallback(handleLassoSelection);
  }
  if (viewer.setLassoStepCallback) {
    viewer.setLassoStepCallback(handleLassoStep);
  }

  return { handleLassoStep };
}
