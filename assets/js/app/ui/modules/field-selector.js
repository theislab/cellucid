/**
 * @fileoverview Field selection + field operations UI.
 *
 * Handles:
 * - Categorical/continuous obs field selectors
 * - Gene expression (var) search + selection
 * - Field rename/duplicate/delete/clear actions
 * - Deleted fields restore/confirm deletion panel
 * - CategoryBuilder initialization (custom categoricals)
 *
 * This module focuses on UI → state interactions for selecting/maintaining the
 * active field. Cross-module rendering (legend, filters, highlights, smoke) is
 * delegated via callbacks to keep responsibilities crisp.
 *
 * @module ui/modules/field-selector
 */

import { getNotificationCenter } from '../../notification-center.js';
import { InlineEditor } from '../components/inline-editor.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';
import { CategoryBuilder } from '../category-builder.js';
import { FieldKind, FieldSource } from '../../utils/field-constants.js';
import { StateValidator } from '../../utils/state-validator.js';
import { initDeletedFieldsPanel } from './field-selector-deleted-fields.js';
import { initGeneExpressionSelector } from './field-selector-gene-expression.js';
import { getCommunityAnnotationSession } from '../../community-annotations/session.js';
import {
  getCommunityAnnotationAccessStore,
  isAnnotationRepoConnected,
  isSimulateRepoConnectedEnabled
} from '../../community-annotations/access-store.js';
import { getAnnotationRepoForDataset, getLastAnnotationRepoForDataset } from '../../community-annotations/repo-store.js';
import { ANNOTATION_CONNECTION_CHANGED_EVENT } from '../../community-annotations/connection-events.js';
import { getGitHubAuthSession, getLastGitHubUserKey, toGitHubUserKey } from '../../community-annotations/github-auth.js';

/**
 * @typedef {object} FieldSelectorCallbacks
 * @property {(fieldInfo: any) => void} [onActiveFieldChanged]
 */

export function initFieldSelector({ state, dom, dataSourceManager = null, callbacks = /** @type {FieldSelectorCallbacks} */ ({}) }) {
  const {
    categoricalSelect,
    categoricalCopyBtn,
    categoricalRenameBtn,
    categoricalDeleteBtn,
    categoricalClearBtn,

    continuousSelect,
    continuousCopyBtn,
    continuousRenameBtn,
    continuousDeleteBtn,
    continuousClearBtn,

    geneContainer,
    geneSearch,
    geneDropdown,
    geneCopyBtn,
    geneRenameBtn,
    geneDeleteBtn,
    geneClearBtn,

    categoryBuilderContainer,
    deletedFieldsSection
  } = dom || {};

  const NONE_FIELD_VALUE = '-1';

  let forceDisableFieldSelects = false;
  let hasCategoricalFields = false;
  let hasContinuousFields = false;
  let geneSelector = null;

  const annotationSession = getCommunityAnnotationSession();
  const access = getCommunityAnnotationAccessStore();
  const lifecycle = typeof AbortController !== 'undefined' ? new AbortController() : null;
  try {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    annotationSession.setDatasetId?.(datasetId);
  } catch {
    // ignore
  }

  function isCommunityAnnotationUiEnabled() {
    try {
      const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
      const auth = getGitHubAuthSession();
      const authedKey = auth.isAuthenticated?.() ? toGitHubUserKey(auth.getUser?.()) : null;
      const username = authedKey
        ? String(authedKey)
        : (isSimulateRepoConnectedEnabled() ? (getLastGitHubUserKey() || (annotationSession.getProfile?.()?.username || 'local')) : (annotationSession.getProfile?.()?.username || 'local'));
      return isAnnotationRepoConnected(datasetId, username);
    } catch {
      return false;
    }
  }

  const { renderDeletedFieldsSection } = initDeletedFieldsPanel({ state, deletedFieldsSection });

  function getFieldsByKind(kind) {
    const entries = state.getVisibleFields
      ? state.getVisibleFields(FieldSource.OBS)
      : (state.getFields?.() || [])
          .map((field, index) => ({ field, index }))
          .filter(({ field }) => field && field._isDeleted !== true);

    return entries
      .filter(({ field }) => field.kind === kind)
      .map(({ field, index }) => ({ field, idx: index }));
  }

  function updateFieldActionButtons() {
    const catIdx = parseInt(categoricalSelect?.value || NONE_FIELD_VALUE, 10);
    const contIdx = parseInt(continuousSelect?.value || NONE_FIELD_VALUE, 10);

    const catSelected = Number.isInteger(catIdx) && catIdx >= 0;
    const contSelected = Number.isInteger(contIdx) && contIdx >= 0;

    const catDisabled = Boolean(categoricalSelect?.disabled) || !catSelected;
    const contDisabled = Boolean(continuousSelect?.disabled) || !contSelected;

    const catField = catSelected ? state.getFields?.()?.[catIdx] : null;
    const catVotingLocked = Boolean(
      isCommunityAnnotationUiEnabled() &&
      catField?.kind === FieldKind.CATEGORY &&
      annotationSession.isFieldAnnotated(catField?.key)
    );

    if (categoricalCopyBtn) categoricalCopyBtn.disabled = catDisabled;
    if (categoricalRenameBtn) categoricalRenameBtn.disabled = catDisabled || catVotingLocked;
    if (categoricalDeleteBtn) categoricalDeleteBtn.disabled = catDisabled || catVotingLocked;
    if (categoricalClearBtn) categoricalClearBtn.disabled = catDisabled;

    if (continuousCopyBtn) continuousCopyBtn.disabled = contDisabled;
    if (continuousRenameBtn) continuousRenameBtn.disabled = contDisabled;
    if (continuousDeleteBtn) continuousDeleteBtn.disabled = contDisabled;
    if (continuousClearBtn) continuousClearBtn.disabled = contDisabled;
  }

  function updateFieldSelectDisabledStates() {
    if (categoricalSelect) categoricalSelect.disabled = forceDisableFieldSelects || !hasCategoricalFields;
    if (continuousSelect) continuousSelect.disabled = forceDisableFieldSelects || !hasContinuousFields;
    updateFieldActionButtons();
    geneSelector?.updateGeneActionButtons?.(forceDisableFieldSelects);
  }

  geneSelector = initGeneExpressionSelector({
    state,
    dom: {
      geneContainer,
      geneSearch,
      geneDropdown,
      geneCopyBtn,
      geneRenameBtn,
      geneDeleteBtn,
      geneClearBtn
    },
    obsDom: {
      categoricalSelect,
      continuousSelect
    },
    noneFieldValue: NONE_FIELD_VALUE,
    callbacks: {
      onActiveFieldChanged: callbacks.onActiveFieldChanged,
      onStartFieldRename: startFieldRename,
      onStartFieldDelete: startFieldDelete,
      onBusyChanged: (busy) => {
        forceDisableFieldSelects = Boolean(busy);
        updateFieldSelectDisabledStates();
      },
      onActivateField: (idx) => activateField(idx)
    }
  });

  function renderFieldSelects() {
    if (!categoricalSelect || !continuousSelect) return;

    let annotationUiEnabled = false;
    try {
      const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
      const auth = getGitHubAuthSession();
      const authedKey = auth.isAuthenticated?.() ? toGitHubUserKey(auth.getUser?.()) : null;
      const username = authedKey
        ? String(authedKey)
        : (isSimulateRepoConnectedEnabled() ? (getLastGitHubUserKey() || (annotationSession.getProfile?.()?.username || 'local')) : (annotationSession.getProfile?.()?.username || 'local'));
      let repoRef = getAnnotationRepoForDataset(datasetId, username) || null;
      if (!repoRef && isSimulateRepoConnectedEnabled()) {
        repoRef = getLastAnnotationRepoForDataset(datasetId, username) || null;
      }
      annotationSession.setCacheContext?.({ datasetId, repoRef, username });
      annotationUiEnabled = isAnnotationRepoConnected(datasetId, username);
    } catch {
      // ignore
    }

    const fields = state.getFields?.() || [];
    const categoricalFields = getFieldsByKind(FieldKind.CATEGORY);
    const continuousFields = getFieldsByKind(FieldKind.CONTINUOUS);
    hasCategoricalFields = categoricalFields.length > 0;
    hasContinuousFields = continuousFields.length > 0;

    function populateSelect(select, entries, emptyLabel) {
      select.innerHTML = '';
      const noneOption = document.createElement('option');
      noneOption.value = NONE_FIELD_VALUE;
      noneOption.textContent = entries.length ? 'None' : emptyLabel;
      select.appendChild(noneOption);
      entries.forEach(({ field, idx }) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        const baseLabel = field._originalKey ? `${field.key} *` : field.key;
        let annotateBadge = '';
        if (annotationUiEnabled && select === categoricalSelect && annotationSession.isFieldAnnotated(field.key)) {
          const closed = annotationSession.isFieldClosed?.(field.key) === true;
          annotateBadge = closed ? '🗳️🏁 ' : '🗳️ ';
        }
        opt.textContent = annotateBadge + baseLabel;
        select.appendChild(opt);
      });
      select.value = NONE_FIELD_VALUE;
    }

    populateSelect(categoricalSelect, categoricalFields, '(no categorical obs fields)');
    populateSelect(continuousSelect, continuousFields, '(no continuous obs fields)');
    updateFieldSelectDisabledStates();

    // Preserve current selection (active field can move due to delete/restore).
    syncFromState();

    if (!fields.length) {
      callbacks.onActiveFieldChanged?.({ field: null, pointCount: 0, centroidInfo: '' });
    }
  }

  // Right-click the categorical field selector to toggle annotation mode for the selected field.
  if (categoricalSelect) {
    categoricalSelect.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const repoConnected = isCommunityAnnotationUiEnabled();
      if (!repoConnected) return;
      if (!access.isAuthor()) {
        getNotificationCenter().error('Only repo authors can change which columns are annotatable', { category: 'annotation' });
        return;
      }
      const idx = parseInt(categoricalSelect.value || NONE_FIELD_VALUE, 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      const field = state.getFields?.()?.[idx] || null;
      if (!field || field.kind !== FieldKind.CATEGORY || !field.key) return;

      const enabled = annotationSession.isFieldAnnotated(field.key);
      showConfirmDialog({
        title: enabled ? 'Disable community annotation' : 'Enable community annotation',
        message: enabled
          ? `Disable annotation voting for "${field.key}"? (Votes remain in local storage.)`
          : `Enable annotation voting for "${field.key}"? You will see 🗳️ next to the field name and can click category labels to vote in a popup.`,
        confirmText: enabled ? 'Disable' : 'Enable',
        onConfirm: () => {
          annotationSession.setFieldAnnotated(field.key, !enabled);
          const notifications = getNotificationCenter();
          notifications.success(
            `${enabled ? 'Disabled' : 'Enabled'} community annotation for "${field.key}"`,
            { category: 'annotation', duration: 2400 }
          );
          renderFieldSelects();
        }
      });
    });
  }

  // Keep 🗳️ badges in sync if annotation session changes elsewhere (accordion, legend, etc.).
  const unsubscribeAnnotation = annotationSession.on('changed', () => {
    renderFieldSelects();
  });

  // Keep UI in sync when repo connect/disconnect or dev simulate toggles change.
  const rerenderForConnectionChange = () => {
    try {
      const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
      annotationSession.setDatasetId?.(datasetId);
    } catch {
      // ignore
    }
    renderFieldSelects();
  };

  const unsubscribeAccess = access.on?.('changed', () => rerenderForConnectionChange()) || null;
  try {
    if (typeof window !== 'undefined' && lifecycle?.signal) {
      window.addEventListener(ANNOTATION_CONNECTION_CHANGED_EVENT, rerenderForConnectionChange, { signal: lifecycle.signal });
    }
  } catch {
    // ignore
  }

  if (dataSourceManager?.onDatasetChange) {
    dataSourceManager.onDatasetChange(() => {
      rerenderForConnectionChange();
    });
  }

  function validateUniqueFieldName(nextValue, fields, fieldIndex) {
    const value = String(nextValue ?? '').trim();
    try {
      StateValidator.validateFieldKey(value);
    } catch (err) {
      return err?.message || 'Invalid field name';
    }
    if (StateValidator.isDuplicateKey(value, fields, fieldIndex)) {
      return 'A field with this name already exists';
    }
    return true;
  }

  function startFieldRename(source, fieldIndex, targetEl) {
    const fields = source === FieldSource.VAR ? state.getVarFields?.() : state.getFields?.();
    const field = fields?.[fieldIndex];
    if (!field) return;
    if (isCommunityAnnotationUiEnabled() && source === FieldSource.OBS && field.kind === FieldKind.CATEGORY && annotationSession.isFieldAnnotated(field.key)) {
      getNotificationCenter().error('Rename is disabled while voting is enabled for this field', { category: 'annotation' });
      return;
    }

    InlineEditor.create(targetEl, field.key, {
      onSave: (newName) => {
        const ok = state.renameField?.(source, fieldIndex, newName);
        if (!ok) {
          getNotificationCenter().error('Failed to rename field', { category: 'filter' });
          return;
        }
        getNotificationCenter().success(`Renamed to "${newName}"`, { category: 'filter', duration: 2000 });
      },
      validate: (name) => validateUniqueFieldName(name, fields, fieldIndex)
    });
  }

  function startFieldDelete(source, fieldIndex) {
    const fields = source === FieldSource.VAR ? state.getVarFields?.() : state.getFields?.();
    const field = fields?.[fieldIndex];
    if (!field) return;
    if (isCommunityAnnotationUiEnabled() && source === FieldSource.OBS && field.kind === FieldKind.CATEGORY && annotationSession.isFieldAnnotated(field.key)) {
      getNotificationCenter().error('Delete is disabled while voting is enabled for this field', { category: 'annotation' });
      return;
    }

    showConfirmDialog({
      title: 'Delete field',
      message: `Delete "${field.key}"? You can restore it from Deleted Fields.`,
      confirmText: 'Delete',
      onConfirm: () => {
        const ok = state.deleteField?.(source, fieldIndex);
        if (!ok) {
          getNotificationCenter().error('Failed to delete field', { category: 'filter' });
          return;
        }
        getNotificationCenter().success(`Deleted "${field.key}"`, { category: 'filter', duration: 2500 });
      }
    });
  }

  function initGeneExpressionDropdown() {
    geneSelector?.initGeneExpressionDropdown?.();
    geneSelector?.updateGeneActionButtons?.(forceDisableFieldSelects);
  }

  async function selectGene(originalIdx) {
    await geneSelector?.selectGene?.(originalIdx);
  }

  function clearFieldSelections() {
    if (categoricalSelect) categoricalSelect.value = NONE_FIELD_VALUE;
    if (continuousSelect) continuousSelect.value = NONE_FIELD_VALUE;
  }

  function syncSelectsForField(idx) {
    if (!categoricalSelect || !continuousSelect) return;
    const fields = state.getFields?.() || [];
    const field = fields[idx];
    if (!field) return;
    if (field.kind === FieldKind.CATEGORY) {
      categoricalSelect.value = String(idx);
      continuousSelect.value = NONE_FIELD_VALUE;
    } else if (field.kind === FieldKind.CONTINUOUS) {
      continuousSelect.value = String(idx);
      categoricalSelect.value = NONE_FIELD_VALUE;
    }
  }

  function syncFromState() {
    const source = state.activeFieldSource;
    const obsIdx = typeof state.activeFieldIndex === 'number' ? state.activeFieldIndex : -1;

    if (source === FieldSource.OBS && obsIdx >= 0) {
      geneSelector?.clearLocalSelectionUI?.();
      syncSelectsForField(obsIdx);
    } else if (source === FieldSource.VAR) {
      clearFieldSelections();
    } else {
      clearFieldSelections();
      geneSelector?.clearLocalSelectionUI?.();
    }

    updateFieldActionButtons();
    geneSelector?.syncFromState?.();
    geneSelector?.updateGeneActionButtons?.(forceDisableFieldSelects);
  }

  // Best-effort cleanup for embedders/tests.
  // (Most UI modules in the app do not currently expose a destroy lifecycle.)
  if (typeof window !== 'undefined') {
    window.addEventListener?.(
      'beforeunload',
      () => {
        unsubscribeAnnotation?.();
        unsubscribeAccess?.();
        lifecycle?.abort?.();
      },
      { once: true }
    );
  }

  async function activateField(idx) {
    if (Number.isNaN(idx)) return;
    try {
      const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
      annotationSession.setDatasetId?.(datasetId);
    } catch {
      // ignore
    }

    // Activating an obs field clears any gene selection.
    if (idx >= 0) {
      geneSelector?.clearLocalSelectionUI?.();
      geneSelector?.updateGeneActionButtons?.(forceDisableFieldSelects);
    }

    if (idx < 0) {
      const cleared = state.clearActiveField?.() || null;
      clearFieldSelections();
      geneSelector?.clearLocalSelectionUI?.();
      geneSelector?.updateGeneActionButtons?.(forceDisableFieldSelects);

      updateFieldSelectDisabledStates();
      if (cleared) {
        callbacks.onActiveFieldChanged?.(cleared);
      } else {
        const counts = state.getFilteredCount ? state.getFilteredCount() : { total: 0 };
        callbacks.onActiveFieldChanged?.({ field: null, pointCount: counts.total || 0, centroidInfo: '' });
      }
      return;
    }

    const fields = state.getFields?.() || [];
    const field = fields[idx];
    if (!field) return;
    syncSelectsForField(idx);

    try {
      forceDisableFieldSelects = true;
      updateFieldSelectDisabledStates();
      await state.ensureFieldLoaded?.(idx);
      const info = state.setActiveField?.(idx);
      callbacks.onActiveFieldChanged?.(info);
    } catch (err) {
      console.error(err);
      getNotificationCenter().error(`Failed to load field: ${err?.message || err}`, { category: 'data' });
    } finally {
      forceDisableFieldSelects = false;
      updateFieldSelectDisabledStates();
    }
  }

  function clearGeneSelection() {
    geneSelector?.clearGeneSelection?.();
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  if (categoricalSelect) {
    categoricalSelect.addEventListener('change', async () => {
      const idx = parseInt(categoricalSelect.value, 10);
      if (Number.isNaN(idx)) return;
      if (idx >= 0) {
        if (continuousSelect && continuousSelect.value !== NONE_FIELD_VALUE) {
          continuousSelect.value = NONE_FIELD_VALUE;
        }
        await activateField(idx);
      } else if (continuousSelect && continuousSelect.value === NONE_FIELD_VALUE) {
        await activateField(-1);
      }
    });
  }

  if (continuousSelect) {
    continuousSelect.addEventListener('change', async () => {
      const idx = parseInt(continuousSelect.value, 10);
      if (Number.isNaN(idx)) return;
      if (idx >= 0) {
        if (categoricalSelect && categoricalSelect.value !== NONE_FIELD_VALUE) {
          categoricalSelect.value = NONE_FIELD_VALUE;
        }
        await activateField(idx);
      } else if (categoricalSelect && categoricalSelect.value === NONE_FIELD_VALUE) {
        await activateField(-1);
      }
    });
  }

  if (categoricalCopyBtn) {
    categoricalCopyBtn.addEventListener('click', async () => {
      const idx = parseInt(categoricalSelect?.value || NONE_FIELD_VALUE, 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      const field = state.getFields?.()?.[idx];
      if (!field) return;

      const notify = getNotificationCenter();
      const notifId = notify.loading(`Duplicating "${field.key}"…`, { category: 'filter' });
      try {
        const result = await state.duplicateField?.(FieldSource.OBS, idx);
        if (!result) {
          notify.fail(notifId, 'Duplicate failed');
          return;
        }

        if (categoricalSelect) categoricalSelect.value = String(result.newFieldIndex);
        if (continuousSelect) continuousSelect.value = NONE_FIELD_VALUE;
        await activateField(result.newFieldIndex);
        // Ensure the duplicated field is not implicitly treated as "voting-enabled".
        try {
          annotationSession.setFieldAnnotated(result.newKey, false);
        } catch {
          // ignore
        }

        notify.complete(notifId, `Created "${result.newKey}"`);
      } catch (err) {
        console.error(err);
        notify.fail(notifId, `Duplicate failed: ${err?.message || err}`);
      }
    });
  }

  if (categoricalRenameBtn) {
    categoricalRenameBtn.addEventListener('click', () => {
      const idx = parseInt(categoricalSelect?.value || NONE_FIELD_VALUE, 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      startFieldRename(FieldSource.OBS, idx, categoricalSelect);
    });
  }

  if (categoricalDeleteBtn) {
    categoricalDeleteBtn.addEventListener('click', () => {
      const idx = parseInt(categoricalSelect?.value || NONE_FIELD_VALUE, 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      startFieldDelete(FieldSource.OBS, idx);
    });
  }

  if (categoricalClearBtn) {
    categoricalClearBtn.addEventListener('click', () => {
      activateField(-1);
    });
  }

  if (continuousCopyBtn) {
    continuousCopyBtn.addEventListener('click', async () => {
      const idx = parseInt(continuousSelect?.value || NONE_FIELD_VALUE, 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      const field = state.getFields?.()?.[idx];
      if (!field) return;

      const notify = getNotificationCenter();
      const notifId = notify.loading(`Duplicating "${field.key}"…`, { category: 'filter' });
      try {
        const result = await state.duplicateField?.(FieldSource.OBS, idx);
        if (!result) {
          notify.fail(notifId, 'Duplicate failed');
          return;
        }

        if (continuousSelect) continuousSelect.value = String(result.newFieldIndex);
        if (categoricalSelect) categoricalSelect.value = NONE_FIELD_VALUE;
        await activateField(result.newFieldIndex);

        notify.complete(notifId, `Created "${result.newKey}"`);
      } catch (err) {
        console.error(err);
        notify.fail(notifId, `Duplicate failed: ${err?.message || err}`);
      }
    });
  }

  if (continuousRenameBtn) {
    continuousRenameBtn.addEventListener('click', () => {
      const idx = parseInt(continuousSelect?.value || NONE_FIELD_VALUE, 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      startFieldRename(FieldSource.OBS, idx, continuousSelect);
    });
  }

  if (continuousDeleteBtn) {
    continuousDeleteBtn.addEventListener('click', () => {
      const idx = parseInt(continuousSelect?.value || NONE_FIELD_VALUE, 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      startFieldDelete(FieldSource.OBS, idx);
    });
  }

  if (continuousClearBtn) {
    continuousClearBtn.addEventListener('click', () => {
      activateField(-1);
    });
  }

  if (categoryBuilderContainer && !categoryBuilderContainer.dataset.catBuilderInitialized) {
    categoryBuilderContainer.dataset.catBuilderInitialized = 'true';
    new CategoryBuilder(state, categoryBuilderContainer).init();
  }

  return {
    destroy: () => {
      unsubscribeAnnotation?.();
      unsubscribeAccess?.();
      lifecycle?.abort?.();
    },
    activateField,
    selectGene,
    syncFromState,

    renderFieldSelects,
    initGeneExpressionDropdown,
    renderDeletedFieldsSection,
    clearGeneSelection,

    updateFieldSelectDisabledStates
  };
}
