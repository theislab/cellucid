/**
 * @fileoverview Gene expression (var field) selector UI.
 *
 * Owns the gene search input + dropdown, and the gene-specific actions
 * (duplicate/rename/delete/clear). This keeps the main field selector module
 * focused on obs field selection + shared field operations.
 *
 * @module ui/modules/field-selector-gene-expression
 */

import { getNotificationCenter } from '../../notification-center.js';
import { FieldSource } from '../../utils/field-constants.js';

/**
 * @typedef {object} GeneExpressionSelectorDom
 * @property {HTMLElement|null} [geneContainer]
 * @property {HTMLInputElement|null} [geneSearch]
 * @property {HTMLElement|null} [geneDropdown]
 * @property {HTMLButtonElement|null} [geneCopyBtn]
 * @property {HTMLButtonElement|null} [geneRenameBtn]
 * @property {HTMLButtonElement|null} [geneDeleteBtn]
 * @property {HTMLButtonElement|null} [geneClearBtn]
 */

/**
 * @typedef {object} GeneExpressionSelectorCallbacks
 * @property {(fieldInfo: any) => void} [onActiveFieldChanged]
 * @property {(source: string, fieldIndex: number, inputEl: HTMLElement) => void} [onStartFieldRename]
 * @property {(source: string, fieldIndex: number) => void} [onStartFieldDelete]
 * @property {(busy: boolean) => void} [onBusyChanged]
 * @property {(idx: number) => Promise<void>} [onActivateField]
 */

/**
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {GeneExpressionSelectorDom} options.dom
 * @param {GeneExpressionSelectorCallbacks} options.callbacks
 * @param {object} options.obsDom
 * @param {HTMLSelectElement|null} [options.obsDom.categoricalSelect]
 * @param {HTMLSelectElement|null} [options.obsDom.continuousSelect]
 * @param {string} options.noneFieldValue
 */
export function initGeneExpressionSelector({ state, dom, callbacks, obsDom, noneFieldValue }) {
  const geneContainer = dom?.geneContainer || null;
  const geneSearch = dom?.geneSearch || null;
  const geneDropdown = dom?.geneDropdown || null;
  const geneCopyBtn = dom?.geneCopyBtn || null;
  const geneRenameBtn = dom?.geneRenameBtn || null;
  const geneDeleteBtn = dom?.geneDeleteBtn || null;
  const geneClearBtn = dom?.geneClearBtn || null;

  const categoricalSelect = obsDom?.categoricalSelect || null;
  const continuousSelect = obsDom?.continuousSelect || null;

  let hasGeneExpressionFields = false;
  /** @type {{field: any, originalIdx: number}[]} */
  let geneFieldList = [];
  let selectedGeneOriginalIdx = -1;
  let forceDisabled = false;

  function updateGeneActionButtons(nextForceDisabled = forceDisabled) {
    forceDisabled = Boolean(nextForceDisabled);
    const hasSelection = Number.isInteger(selectedGeneOriginalIdx) && selectedGeneOriginalIdx >= 0;
    const disableAll = forceDisabled || !hasGeneExpressionFields;
    if (geneCopyBtn) geneCopyBtn.disabled = disableAll || !hasSelection;
    if (geneRenameBtn) geneRenameBtn.disabled = disableAll || !hasSelection;
    if (geneDeleteBtn) geneDeleteBtn.disabled = disableAll || !hasSelection;
    if (geneClearBtn) geneClearBtn.disabled = forceDisabled || !hasSelection;
  }

  function initGeneExpressionDropdown() {
    const entries = state.getVisibleFields
      ? state.getVisibleFields(FieldSource.VAR)
      : (state.getVarFields?.() || [])
          .map((field, index) => ({ field, index }))
          .filter(({ field }) => field && field._isDeleted !== true);

    geneFieldList = entries.map(({ field, index }) => ({ field, originalIdx: index }));
    hasGeneExpressionFields = geneFieldList.length > 0;

    if (geneContainer) {
      geneContainer.classList.toggle('visible', hasGeneExpressionFields);
    }

    if (!geneFieldList.some(({ originalIdx }) => originalIdx === selectedGeneOriginalIdx)) {
      selectedGeneOriginalIdx = -1;
    }

    updateGeneActionButtons();
  }

  function renderGeneDropdownResults(query) {
    if (!geneDropdown) return;
    geneDropdown.innerHTML = '';

    const lowerQuery = (query || '').toLowerCase().trim();
    let filtered = geneFieldList.map((entry, listIndex) => ({ ...entry, listIndex }));

    if (lowerQuery) {
      filtered = filtered.filter(({ field }) => field.key.toLowerCase().includes(lowerQuery));
    }

    const maxResults = 100;
    const toShow = filtered.slice(0, maxResults);

    if (toShow.length === 0) {
      const noResults = document.createElement('div');
      noResults.className = 'dropdown-no-results';
      noResults.textContent = lowerQuery ? 'No genes found' : 'Type to search genes...';
      geneDropdown.appendChild(noResults);
      return;
    }

    toShow.forEach(({ field, originalIdx }) => {
      const item = document.createElement('div');
      item.className = 'dropdown-item';
      if (originalIdx === selectedGeneOriginalIdx) {
        item.classList.add('selected');
      }
      item.textContent = field._originalKey ? `${field.key} *` : field.key;
      if (field._originalKey) item.title = `Original: ${field._originalKey}`;
      item.dataset.originalIdx = String(originalIdx);
      item.addEventListener('click', () => selectGene(originalIdx));
      geneDropdown.appendChild(item);
    });

    if (filtered.length > maxResults) {
      const moreMsg = document.createElement('div');
      moreMsg.className = 'dropdown-no-results';
      moreMsg.textContent = `...and ${filtered.length - maxResults} more. Type to narrow results.`;
      geneDropdown.appendChild(moreMsg);
    }
  }

  function showGeneDropdown() {
    if (!geneDropdown) return;
    renderGeneDropdownResults(geneSearch?.value || '');
    geneDropdown.classList.add('visible');
  }

  function hideGeneDropdown() {
    if (!geneDropdown) return;
    geneDropdown.classList.remove('visible');
  }

  async function selectGene(originalIdx) {
    if (!Number.isInteger(originalIdx) || originalIdx < 0) return;
    const entry = geneFieldList.find((e) => e.originalIdx === originalIdx);
    const field = entry?.field;
    if (!field) return;

    hideGeneDropdown();
    selectedGeneOriginalIdx = originalIdx;

    if (categoricalSelect) categoricalSelect.value = noneFieldValue;
    if (continuousSelect) continuousSelect.value = noneFieldValue;

    if (geneSearch) {
      geneSearch.value = field.key || '';
    }
    updateGeneActionButtons();

    try {
      updateGeneActionButtons(true);
      callbacks?.onBusyChanged?.(true);

      await state.ensureVarFieldLoaded?.(originalIdx);
      const info = state.setActiveVarField?.(originalIdx);
      callbacks.onActiveFieldChanged?.(info);
    } catch (err) {
      console.error(err);
      getNotificationCenter().error(`Failed to load gene: ${err?.message || err}`, { category: 'data' });
    } finally {
      callbacks?.onBusyChanged?.(false);
      updateGeneActionButtons(false);
    }
  }

  async function clearGeneSelection() {
    selectedGeneOriginalIdx = -1;
    updateGeneActionButtons();
    if (geneSearch) geneSearch.value = '';
    try {
      await callbacks?.onActivateField?.(-1);
    } catch (err) {
      console.error(err);
      getNotificationCenter().error(`Failed to clear gene selection: ${err?.message || err}`, { category: 'filter' });
    }
  }

  function clearLocalSelectionUI() {
    selectedGeneOriginalIdx = -1;
    if (geneSearch) geneSearch.value = '';
  }

  function syncFromState() {
    const source = state.activeFieldSource;
    const varIdx = typeof state.activeVarFieldIndex === 'number' ? state.activeVarFieldIndex : -1;

    if (source === FieldSource.VAR && varIdx >= 0) {
      selectedGeneOriginalIdx = varIdx;
      const field = state.getVarFields?.()?.[varIdx];
      if (geneSearch) geneSearch.value = field?.key || '';
    } else {
      selectedGeneOriginalIdx = -1;
      if (geneSearch) geneSearch.value = '';
    }

    updateGeneActionButtons();
  }

  if (geneCopyBtn) {
    geneCopyBtn.addEventListener('click', async () => {
      if (!Number.isInteger(selectedGeneOriginalIdx) || selectedGeneOriginalIdx < 0) return;

      const field = state.getVarFields?.()?.[selectedGeneOriginalIdx];
      if (!field) return;

      const notify = getNotificationCenter();
      const notifId = notify.loading(`Duplicating "${field.key}"…`, { category: 'filter' });
      try {
        const result = await state.duplicateField?.(FieldSource.VAR, selectedGeneOriginalIdx);
        if (!result) {
          notify.fail(notifId, 'Duplicate failed');
          return;
        }

        initGeneExpressionDropdown();
        await selectGene(result.newFieldIndex);
        notify.complete(notifId, `Created "${result.newKey}"`);
      } catch (err) {
        console.error(err);
        notify.fail(notifId, `Duplicate failed: ${err?.message || err}`);
      }
    });
  }

  if (geneRenameBtn) {
    geneRenameBtn.addEventListener('click', () => {
      if (!Number.isInteger(selectedGeneOriginalIdx) || selectedGeneOriginalIdx < 0) return;
      if (!geneSearch) return;
      callbacks.onStartFieldRename?.(FieldSource.VAR, selectedGeneOriginalIdx, geneSearch);
    });
  }

  if (geneDeleteBtn) {
    geneDeleteBtn.addEventListener('click', () => {
      if (!Number.isInteger(selectedGeneOriginalIdx) || selectedGeneOriginalIdx < 0) return;
      callbacks.onStartFieldDelete?.(FieldSource.VAR, selectedGeneOriginalIdx);
    });
  }

  if (geneClearBtn) {
    geneClearBtn.addEventListener('click', () => {
      clearGeneSelection();
    });
  }

  if (geneSearch) {
    geneSearch.addEventListener('focus', () => {
      geneSearch.select?.();
      showGeneDropdown();
    });

    geneSearch.addEventListener('input', () => {
      renderGeneDropdownResults(geneSearch.value);
      if (geneDropdown && !geneDropdown.classList.contains('visible')) {
        showGeneDropdown();
      }
    });

    geneSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideGeneDropdown();
        geneSearch.blur();
      } else if (e.key === 'Enter') {
        const firstItem = geneDropdown?.querySelector?.('.dropdown-item');
        if (firstItem) {
          const originalIdx = parseInt(firstItem.dataset.originalIdx || '-1', 10);
          selectGene(originalIdx);
        }
      }
    });

    geneSearch.addEventListener('blur', () => {
      if (selectedGeneOriginalIdx >= 0 && !geneSearch.value) {
        const field = geneFieldList.find(({ originalIdx }) => originalIdx === selectedGeneOriginalIdx)?.field;
        if (field) geneSearch.value = field.key || '';
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (!geneSearch || !geneDropdown) return;
    const isClickInside = geneSearch.contains(e.target) || geneDropdown.contains(e.target);
    if (!isClickInside) {
      hideGeneDropdown();
    }
  });

  return {
    initGeneExpressionDropdown,
    selectGene,
    clearGeneSelection,
    clearLocalSelectionUI,
    syncFromState,
    updateGeneActionButtons
  };
}
