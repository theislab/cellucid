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
export function initProximitySelection({ state, viewer, jupyterSource = null, selectionState, ui }) {
  const highlightModeDescriptionEl = ui?.modeDescriptionEl || null;

  function handleProximitySelection(proximityEvent) {
    if (!proximityEvent || !proximityEvent.cellIndices || proximityEvent.cellIndices.length === 0) {
      debug.log('[UI] Proximity selection empty');
      state.clearPreviewHighlight?.();
      selectionState.proximityHistory = [];
      selectionState.proximityRedoStack = [];
      selectionState.lastProximityCandidates = null;
      selectionState.lastProximityStep = 0;
      updateProximityUI(null);
      return;
    }

    const stepsLabel = proximityEvent.steps > 1 ? ` (${proximityEvent.steps} drags)` : '';
    const group = state.addHighlightDirect({
      type: 'proximity',
      label: `Proximity${stepsLabel} (${proximityEvent.cellCount.toLocaleString()} cells)`,
      cellIndices: proximityEvent.cellIndices
    });

    if (group) {
      debug.log(`[UI] Proximity selected ${proximityEvent.cellCount} cells from ${proximityEvent.steps} drag(s)`);
    }
    try {
      jupyterSource?.notifySelection?.(proximityEvent.cellIndices, 'proximity');
    } catch {}

    selectionState.proximityHistory = [];
    selectionState.proximityRedoStack = [];
    selectionState.lastProximityCandidates = null;
    selectionState.lastProximityStep = 0;
    updateProximityUI(null);
  }

  function handleProximityStep(stepEvent) {
    if (stepEvent.cancelled) {
      selectionState.proximityHistory = [];
      selectionState.proximityRedoStack = [];
      selectionState.lastProximityCandidates = null;
      selectionState.lastProximityStep = 0;
      updateProximityUI(null);
      state.clearPreviewHighlight?.();
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

    selectionState.lastProximityCandidates = stepEvent.candidates ? [...stepEvent.candidates] : null;
    selectionState.lastProximityStep = stepEvent.step;

    updateProximityUI(stepEvent);

    if (stepEvent.candidates && stepEvent.candidates.length > 0) {
      state.setPreviewHighlightFromIndices?.(stepEvent.candidates);
    } else {
      state.clearPreviewHighlight?.();
    }
  }

  function handleProximityUndo() {
    if (selectionState.proximityHistory.length === 0) return;

    selectionState.proximityRedoStack.push({
      candidates: selectionState.lastProximityCandidates ? [...selectionState.lastProximityCandidates] : null,
      step: selectionState.lastProximityStep
    });

    const prevState = selectionState.proximityHistory.pop();
    selectionState.lastProximityCandidates = prevState.candidates;
    selectionState.lastProximityStep = prevState.step;

    viewer.restoreProximityState?.(prevState.candidates, prevState.step);

    if (prevState.candidates && prevState.candidates.length > 0) {
      updateProximityUI({
        step: prevState.step,
        candidateCount: prevState.candidates.length,
        candidates: prevState.candidates,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.(prevState.candidates);
    } else {
      updateProximityUI({ step: 0, candidateCount: 0, mode: 'intersect', keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  function handleProximityRedo() {
    if (selectionState.proximityRedoStack.length === 0) return;

    selectionState.proximityHistory.push({
      candidates: selectionState.lastProximityCandidates ? [...selectionState.lastProximityCandidates] : null,
      step: selectionState.lastProximityStep
    });

    const redoState = selectionState.proximityRedoStack.pop();
    selectionState.lastProximityCandidates = redoState.candidates;
    selectionState.lastProximityStep = redoState.step;

    viewer.restoreProximityState?.(redoState.candidates, redoState.step);

    if (redoState.candidates && redoState.candidates.length > 0) {
      updateProximityUI({
        step: redoState.step,
        candidateCount: redoState.candidates.length,
        candidates: redoState.candidates,
        mode: 'intersect'
      });
      state.setPreviewHighlightFromIndices?.(redoState.candidates);
    } else {
      updateProximityUI({ step: 0, candidateCount: 0, mode: 'intersect', keepControls: true });
      state.clearPreviewHighlight?.();
    }
  }

  function handleProximityPreview(previewEvent) {
    if (!previewEvent || !previewEvent.cellIndices) return;

    if (previewEvent.cellIndices.length > 0) {
      state.setPreviewHighlightFromIndices?.(previewEvent.cellIndices);
    } else {
      state.clearPreviewHighlight?.();
    }
  }

  function updateProximityUI(stepEvent) {
    if (!highlightModeDescriptionEl) return;

    if (!stepEvent || (stepEvent.step === 0 && !stepEvent.keepControls)) {
      highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.proximity;
      const existingControls = document.getElementById('proximity-step-controls');
      if (existingControls) existingControls.remove();
      return;
    }

    if (stepEvent.step === 0 && stepEvent.keepControls) {
      const stepInfo =
        '<strong>No selection</strong><br><small>Alt to intersect, Shift+Alt to add, Ctrl+Alt to subtract</small>';

      let controls = document.getElementById('proximity-step-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.id = 'proximity-step-controls';
        controls.className = 'lasso-step-controls';
        controls.innerHTML = `
          <button type="button" class="btn-small lasso-confirm" id="proximity-confirm-btn">Confirm</button>
          <button type="button" class="btn-small btn-undo" id="proximity-undo-btn" title="Undo">↩</button>
          <button type="button" class="btn-small btn-redo" id="proximity-redo-btn" title="Redo">↪</button>
          <button type="button" class="btn-small lasso-cancel" id="proximity-cancel-btn">Cancel</button>
        `;
        highlightModeDescriptionEl.parentElement?.appendChild(controls);

        document.getElementById('proximity-undo-btn')?.addEventListener('click', () => handleProximityUndo());
        document.getElementById('proximity-redo-btn')?.addEventListener('click', () => handleProximityRedo());
        document.getElementById('proximity-confirm-btn')?.addEventListener('click', () => {
          viewer.confirmProximitySelection?.();
          state.clearPreviewHighlight?.();
        });
        document.getElementById('proximity-cancel-btn')?.addEventListener('click', () => viewer.cancelProximitySelection?.());
      }

      const undoBtn = document.getElementById('proximity-undo-btn');
      const redoBtn = document.getElementById('proximity-redo-btn');
      const confirmBtn = document.getElementById('proximity-confirm-btn');
      if (undoBtn) undoBtn.disabled = selectionState.proximityHistory.length === 0;
      if (redoBtn) redoBtn.disabled = selectionState.proximityRedoStack.length === 0;
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

    let controls = document.getElementById('proximity-step-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'proximity-step-controls';
      controls.className = 'lasso-step-controls';
      controls.innerHTML = `
        <button type="button" class="btn-small lasso-confirm" id="proximity-confirm-btn">Confirm</button>
        <button type="button" class="btn-small btn-undo" id="proximity-undo-btn" title="Undo">↩</button>
        <button type="button" class="btn-small btn-redo" id="proximity-redo-btn" title="Redo">↪</button>
        <button type="button" class="btn-small lasso-cancel" id="proximity-cancel-btn">Cancel</button>
      `;
      highlightModeDescriptionEl.parentElement?.appendChild(controls);

      document.getElementById('proximity-undo-btn')?.addEventListener('click', () => handleProximityUndo());
      document.getElementById('proximity-redo-btn')?.addEventListener('click', () => handleProximityRedo());
      document.getElementById('proximity-confirm-btn')?.addEventListener('click', () => {
        viewer.confirmProximitySelection?.();
        state.clearPreviewHighlight?.();
      });
      document.getElementById('proximity-cancel-btn')?.addEventListener('click', () => viewer.cancelProximitySelection?.());
    }

    const undoBtn = document.getElementById('proximity-undo-btn');
    const redoBtn = document.getElementById('proximity-redo-btn');
    if (undoBtn) undoBtn.disabled = selectionState.proximityHistory.length === 0;
    if (redoBtn) redoBtn.disabled = selectionState.proximityRedoStack.length === 0;

    highlightModeDescriptionEl.innerHTML = stepInfo;
  }

  if (viewer.setProximityCallback) {
    viewer.setProximityCallback(handleProximitySelection);
  }
  if (viewer.setProximityStepCallback) {
    viewer.setProximityStepCallback(handleProximityStep);
  }
  if (viewer.setProximityPreviewCallback) {
    viewer.setProximityPreviewCallback(handleProximityPreview);
  }

  return { handleProximityStep };
}
