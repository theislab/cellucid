/**
 * @fileoverview Active field (obs + var) serialization helpers.
 *
 * @module state-serializer/active-fields
 */

import { debug } from '../utils/debug.js';

export function serializeActiveFields(state) {
  const activeField = state.getActiveField?.();
  const activeFieldSource = state.activeFieldSource;

  return {
    activeFieldKey: activeField?.key || null,
    activeFieldSource: activeFieldSource || null,
    activeVarFieldKey: state.activeVarFieldIndex >= 0
      ? state.getVarFields?.()[state.activeVarFieldIndex]?.key
      : null
  };
}

/**
 * Restore active field selections.
 * Handles both obs fields (categorical/continuous) and var fields (gene expression).
 * @param {object} state
 * @param {any} activeFields
 */
export async function restoreActiveFields(state, activeFields) {
  if (!activeFields) return;

  // First, handle var field (gene expression) if present
  if (activeFields.activeVarFieldKey) {
    const varFields = state.getVarFields?.() || [];
    const varIdx = varFields.findIndex(f => f?.key === activeFields.activeVarFieldKey && f?._isDeleted !== true);
    if (varIdx >= 0) {
      debug.log(`[StateSerializer] Activating var field: ${activeFields.activeVarFieldKey} (index: ${varIdx})`);
      await state.ensureVarFieldLoaded?.(varIdx);
      state.setActiveVarField?.(varIdx);

      const geneSearch = document.getElementById('gene-expression-search');
      if (geneSearch) {
        geneSearch.value = activeFields.activeVarFieldKey;
      }
    }
  }

  // Then handle obs field
  if (activeFields.activeFieldKey && activeFields.activeFieldSource === 'obs') {
    const fields = state.getFields?.() || [];
    const idx = fields.findIndex(f => f?.key === activeFields.activeFieldKey && f?._isDeleted !== true);

    if (idx >= 0) {
      const field = fields[idx];
      debug.log(`[StateSerializer] Activating obs field: ${field?.key} (index: ${idx})`);

      await state.ensureFieldLoaded?.(idx);
      state.setActiveField?.(idx);

      if (field) {
        const selectId = field.kind === 'category' ? 'categorical-field' : 'continuous-field';
        const select = document.getElementById(selectId);
        if (select) {
          const otherSelectId = field.kind === 'category' ? 'continuous-field' : 'categorical-field';
          const otherSelect = document.getElementById(otherSelectId);
          if (otherSelect) {
            otherSelect.value = '-1';
          }
          select.value = String(idx);
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } else {
      console.warn(`[StateSerializer] Obs field not found: ${activeFields.activeFieldKey}`);
    }
  } else if (activeFields.activeFieldSource === 'var' && activeFields.activeFieldKey) {
    // Active field is a var field (gene) - handled above, but also activate it as primary
    const varFields = state.getVarFields?.() || [];
    const varIdx = varFields.findIndex(f => f?.key === activeFields.activeFieldKey && f?._isDeleted !== true);
    if (varIdx >= 0) {
      debug.log(`[StateSerializer] Activating var field as primary: ${activeFields.activeFieldKey}`);
      await state.ensureVarFieldLoaded?.(varIdx);
      state.setActiveVarField?.(varIdx);
    }
  }
}

/**
 * Sync field select dropdowns to match the current active field in state.
 * This ensures the UI reflects the active field without triggering change events.
 * @param {object} state
 */
export function syncFieldSelectsToActiveField(state) {
  const activeField = state.getActiveField?.();
  const activeFieldSource = state.activeFieldSource;
  const fields = state.getFields?.() || [];

  const categoricalSelect = document.getElementById('categorical-field');
  const continuousSelect = document.getElementById('continuous-field');
  const geneSearch = document.getElementById('gene-expression-search');

  if (!activeField) {
    if (categoricalSelect) categoricalSelect.value = '-1';
    if (continuousSelect) continuousSelect.value = '-1';
    if (geneSearch) geneSearch.value = '';
    return;
  }

  if (activeFieldSource === 'var') {
    if (categoricalSelect) categoricalSelect.value = '-1';
    if (continuousSelect) continuousSelect.value = '-1';
    if (geneSearch) geneSearch.value = activeField.key || '';
    return;
  }

  const fieldIndex = fields.findIndex(f => f?.key === activeField.key);
  if (activeField.kind === 'category') {
    if (categoricalSelect) categoricalSelect.value = String(fieldIndex);
    if (continuousSelect) continuousSelect.value = '-1';
  } else if (activeField.kind === 'continuous') {
    if (categoricalSelect) categoricalSelect.value = '-1';
    if (continuousSelect) continuousSelect.value = String(fieldIndex);
  }
  if (geneSearch) geneSearch.value = '';
}

