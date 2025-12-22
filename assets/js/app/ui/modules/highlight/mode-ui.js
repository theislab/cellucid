/**
 * @fileoverview Highlight mode toolbelt UI.
 *
 * Manages the mode toggle buttons (annotation / lasso / proximity / KNN),
 * enables/disables the corresponding viewer tools, and handles cross-tool
 * selection persistence via the viewer's unified selection state.
 *
 * @module ui/modules/highlight/mode-ui
 */

import { HIGHLIGHT_MODE_COPY } from './mode-copy.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {object} [options.dom]
 * @param {HTMLElement|HTMLElement[]|null} [options.dom.modeButtons]
 * @param {HTMLElement|null} [options.dom.modeDescription]
 * @param {ReturnType<import('./selection-state.js').createHighlightSelectionState>} options.selectionState
 * @param {object} options.stepHandlers
 * @param {(evt: any) => void} [options.stepHandlers.handleAnnotationStep]
 * @param {(evt: any) => void} [options.stepHandlers.handleLassoStep]
 * @param {(evt: any) => void} [options.stepHandlers.handleProximityStep]
 * @param {(evt: any) => void} [options.stepHandlers.handleKnnStep]
 */
export function initHighlightModeUI({ state, viewer, dom, selectionState, stepHandlers }) {
  const highlightModeButtonsList = Array.isArray(dom?.modeButtons)
    ? dom.modeButtons
    : dom?.modeButtons
      ? [dom.modeButtons]
      : [];

  const highlightModeDescriptionEl = dom?.modeDescription || null;

  let activeHighlightMode = selectionState.activeMode || 'annotation';

  function removeStepControls() {
    document.getElementById('lasso-step-controls')?.remove();
    document.getElementById('proximity-step-controls')?.remove();
    document.getElementById('knn-step-controls')?.remove();
    document.getElementById('annotation-step-controls')?.remove();
  }

  function setHighlightModeUI(mode) {
    const wasLasso = activeHighlightMode === 'lasso';
    const wasProximity = activeHighlightMode === 'proximity';
    const wasKnn = activeHighlightMode === 'knn';
    const wasAnnotation = activeHighlightMode === 'annotation';

    const selectionModes = new Set(['lasso', 'proximity', 'knn', 'annotation']);
    const wasSelectionMode = selectionModes.has(activeHighlightMode);
    const isSelectionMode = selectionModes.has(mode);

    activeHighlightMode = mode;
    selectionState.activeMode = mode;

    highlightModeButtonsList.forEach((btn) => {
      const isActive = btn?.dataset?.mode === mode;
      btn?.setAttribute?.('aria-pressed', isActive ? 'true' : 'false');
    });

    if (wasSelectionMode && !isSelectionMode) {
      selectionState.lassoHistory = [];
      selectionState.lassoRedoStack = [];
      selectionState.proximityHistory = [];
      selectionState.proximityRedoStack = [];
      selectionState.knnHistory = [];
      selectionState.knnRedoStack = [];
      selectionState.annotationHistory = [];
      selectionState.annotationRedoStack = [];
      selectionState.annotationCandidateSet = null;
      selectionState.annotationStepCount = 0;

      viewer.cancelUnifiedSelection?.();
      viewer.cancelAnnotationSelection?.();
      state.clearPreviewHighlight?.();
    }

    const oldMode = wasLasso ? 'lasso' : wasProximity ? 'proximity' : wasKnn ? 'knn' : wasAnnotation ? 'annotation' : null;
    if (wasSelectionMode && isSelectionMode && oldMode !== mode) {
      if (wasLasso) {
        selectionState.lassoHistory = [];
        selectionState.lassoRedoStack = [];
      }
      if (wasProximity) {
        selectionState.proximityHistory = [];
        selectionState.proximityRedoStack = [];
      }
      if (wasKnn) {
        selectionState.knnHistory = [];
        selectionState.knnRedoStack = [];
      }
      if (wasAnnotation) {
        selectionState.annotationHistory = [];
        selectionState.annotationRedoStack = [];
      }
    }

    removeStepControls();

    if (highlightModeDescriptionEl) {
      const text = HIGHLIGHT_MODE_COPY[mode] || '';
      highlightModeDescriptionEl.textContent = text;
      highlightModeDescriptionEl.style.display = text ? 'block' : 'none';
    }

    if (wasAnnotation && selectionState.annotationCandidateSet && selectionState.annotationCandidateSet.size > 0) {
      viewer.restoreUnifiedState?.([...selectionState.annotationCandidateSet], selectionState.annotationStepCount);
    }

    if (mode === 'annotation') {
      const unifiedState = viewer.getUnifiedSelectionState?.() || { inProgress: false };
      if (unifiedState.inProgress && unifiedState.candidateCount > 0) {
        selectionState.annotationCandidateSet = new Set(unifiedState.candidates);
        selectionState.annotationStepCount = unifiedState.stepCount;
      }
    }

    if (isSelectionMode) {
      setTimeout(() => {
        const unifiedState = viewer.getUnifiedSelectionState?.() || { inProgress: false };
        if (!unifiedState.inProgress || unifiedState.candidateCount <= 0) return;

        const stepEvent = {
          step: unifiedState.stepCount,
          candidateCount: unifiedState.candidateCount,
          candidates: unifiedState.candidates,
          mode: 'intersect'
        };

        if (mode === 'lasso' && typeof stepHandlers.handleLassoStep === 'function') {
          stepHandlers.handleLassoStep(stepEvent);
        } else if (mode === 'proximity' && typeof stepHandlers.handleProximityStep === 'function') {
          stepHandlers.handleProximityStep(stepEvent);
        } else if (mode === 'knn' && typeof stepHandlers.handleKnnStep === 'function') {
          stepHandlers.handleKnnStep({ ...stepEvent, degree: 0, edgesLoaded: viewer.isKnnEdgesLoaded?.() });
        } else if (mode === 'annotation' && typeof stepHandlers.handleAnnotationStep === 'function') {
          stepHandlers.handleAnnotationStep(stepEvent);
        }
      }, 0);
    }

    viewer.setLassoEnabled?.(mode === 'lasso');
    viewer.setProximityEnabled?.(mode === 'proximity');

    if (viewer.setKnnEnabled) {
      viewer.setKnnEnabled(mode === 'knn');

      if (mode === 'knn' && !viewer.isKnnEdgesLoaded?.()) {
        if (highlightModeDescriptionEl) {
          highlightModeDescriptionEl.innerHTML =
            HIGHLIGHT_MODE_COPY.knn +
            '<br><small class="highlight-mode-note">Loading neighbor graph... (see notifications)</small>';
        }

        let attempts = 0;
        const maxAttempts = 100;
        const checkLoaded = setInterval(() => {
          attempts += 1;
          if (viewer.isKnnEdgesLoaded?.()) {
            clearInterval(checkLoaded);
            if (highlightModeDescriptionEl && activeHighlightMode === 'knn') {
              highlightModeDescriptionEl.innerHTML = HIGHLIGHT_MODE_COPY.knn;
            }
            return;
          }
          if (attempts >= maxAttempts) {
            clearInterval(checkLoaded);
            if (highlightModeDescriptionEl && activeHighlightMode === 'knn') {
              highlightModeDescriptionEl.innerHTML =
                HIGHLIGHT_MODE_COPY.knn +
                '<br><small class="highlight-mode-note">Neighbor graph not available. Enable "Show edges" to load connectivity data.</small>';
            }
          }
        }, 100);
      }
    }
  }

  function initHighlightModeButtons() {
    if (!highlightModeButtonsList.length) {
      setHighlightModeUI(activeHighlightMode);
      return;
    }

    highlightModeButtonsList.forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.mode || 'annotation';
        setHighlightModeUI(nextMode);
      });
    });

    const pressed = highlightModeButtonsList.find((btn) => btn.getAttribute('aria-pressed') === 'true');
    const initialMode = pressed?.dataset?.mode || activeHighlightMode;
    setHighlightModeUI(initialMode);
  }

  initHighlightModeButtons();

  return {
    setHighlightModeUI,
    initHighlightModeButtons,
    getActiveMode: () => activeHighlightMode
  };
}

