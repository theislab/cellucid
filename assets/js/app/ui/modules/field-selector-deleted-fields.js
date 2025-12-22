/**
 * @fileoverview Deleted fields (restore / confirm delete) UI.
 *
 * Extracted from `field-selector.js` to keep the main selector module focused
 * on active field selection + field actions, while this module owns the
 * "Deleted Fields" panel rendering and click handling.
 *
 * UI updates are driven by `state.emit('field:changed', …)`; the coordinator
 * listens and calls `renderDeletedFieldsSection()` as needed.
 *
 * @module ui/modules/field-selector-deleted-fields
 */

import { getNotificationCenter } from '../../notification-center.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';
import { getFieldRegistry } from '../../utils/field-registry.js';
import { FieldSource } from '../../utils/field-constants.js';

/**
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {HTMLElement|null} options.deletedFieldsSection
 */
export function initDeletedFieldsPanel({ state, deletedFieldsSection }) {
  function renderDeletedFieldsSection() {
    if (!deletedFieldsSection) return;

    const deletedObs = getFieldRegistry().getDeletedFields(FieldSource.OBS);
    const deletedVar = getFieldRegistry().getDeletedFields(FieldSource.VAR);
    const total = deletedObs.length + deletedVar.length;

    if (!total) {
      deletedFieldsSection.hidden = true;
      deletedFieldsSection.innerHTML = '';
      return;
    }

    deletedFieldsSection.hidden = false;
    deletedFieldsSection.innerHTML = '';

    const open = deletedFieldsSection.dataset.open === 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'analysis-accordion deleted-fields-wrapper';
    wrapper.innerHTML = `
      <div class="analysis-accordion-item ${open ? 'open' : ''}" id="deleted-fields-accordion-item">
        <button type="button" class="analysis-accordion-header" aria-expanded="${open ? 'true' : 'false'}">
          <span class="analysis-accordion-title">Deleted Fields</span>
          <span class="analysis-accordion-desc">${total} restorable item${total === 1 ? '' : 's'}</span>
          <span class="analysis-accordion-chevron" aria-hidden="true"></span>
        </button>

        <div class="analysis-accordion-content">
          <div class="deleted-fields-hint">
            Restore soft-deleted fields, or confirm deletion to remove restore capability.
          </div>
          <div class="deleted-fields-list" id="deleted-fields-list"></div>
        </div>
      </div>
    `;

    deletedFieldsSection.appendChild(wrapper);

    const item = wrapper.querySelector('#deleted-fields-accordion-item');
    const toggle = wrapper.querySelector('.analysis-accordion-header');
    const list = wrapper.querySelector('#deleted-fields-list');

    toggle?.addEventListener('click', () => {
      const next = !(deletedFieldsSection.dataset.open === 'true');
      deletedFieldsSection.dataset.open = next ? 'true' : 'false';
      toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      item?.classList.toggle('open', next);
    });

    const addGroup = (title, entries, source) => {
      if (!entries.length || !list) return;

      const groupTitle = document.createElement('div');
      groupTitle.className = 'deleted-fields-group-title';
      groupTitle.textContent = title;
      list.appendChild(groupTitle);

      entries.forEach(({ field, index }) => {
        const row = document.createElement('div');
        row.className = 'deleted-field-row';

        const name = document.createElement('span');
        name.className = 'deleted-field-name';
        name.textContent = field._originalKey ? `${field.key} *` : field.key;
        if (field._originalKey) name.title = `Original: ${field._originalKey}`;

        const buttons = document.createElement('div');
        buttons.className = 'deleted-field-actions';

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'deleted-field-restore-btn';
        restoreBtn.textContent = 'Restore';
        restoreBtn.dataset.action = 'restore-field';
        restoreBtn.dataset.source = source;
        restoreBtn.dataset.index = String(index);
        if (field._userDefinedId) restoreBtn.dataset.userDefinedId = field._userDefinedId;

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'deleted-field-confirm-btn';
        confirmBtn.textContent = 'Confirm';
        confirmBtn.dataset.action = 'purge-field';
        confirmBtn.dataset.source = source;
        confirmBtn.dataset.index = String(index);
        confirmBtn.title = 'Permanently confirm deletion (cannot be restored)';
        if (field._userDefinedId) confirmBtn.dataset.userDefinedId = field._userDefinedId;

        buttons.appendChild(restoreBtn);
        buttons.appendChild(confirmBtn);

        row.appendChild(name);
        row.appendChild(buttons);
        list.appendChild(row);
      });
    };

    addGroup('Obs', deletedObs, FieldSource.OBS);
    addGroup('Genes', deletedVar, FieldSource.VAR);
  }

  if (deletedFieldsSection) {
    deletedFieldsSection.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement|null} */ (e.target);

      const purgeBtn = target?.closest?.('button[data-action="purge-field"]');
      if (purgeBtn) {
        const source = purgeBtn.dataset.source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
        const fieldIndex = parseInt(purgeBtn.dataset.index || '-1', 10);
        const userDefinedId = purgeBtn.dataset.userDefinedId || null;

        let label = 'field';
        if (fieldIndex >= 0) {
          const fields = source === FieldSource.VAR ? state.getVarFields?.() : state.getFields?.();
          const field = fields?.[fieldIndex];
          label = field?.key || 'field';
        } else if (userDefinedId) {
          const template = state.getUserDefinedFieldsRegistry?.()?.getField?.(userDefinedId);
          label = template?.key || 'field';
        } else {
          return;
        }

        showConfirmDialog({
          title: 'Confirm deletion',
          message:
            `Permanently confirm deletion of "${label}"?\n\n` +
            `This removes restore capability for this field in the current session and in saved states.`,
          confirmText: 'Confirm delete',
          onConfirm: () => {
            let ok;
            if (fieldIndex >= 0) {
              ok = state.purgeDeletedField?.(source, fieldIndex);
            } else if (userDefinedId) {
              ok = state.purgeUserDefinedField?.(userDefinedId, source);
            }
            if (!ok) {
              getNotificationCenter().error('Failed to confirm deletion', { category: 'filter' });
              return;
            }
            getNotificationCenter().success(`Confirmed deletion of "${label}"`, { category: 'filter', duration: 2500 });
          }
        });
        return;
      }

      const restoreBtn = target?.closest?.('button[data-action="restore-field"]');
      if (!restoreBtn) return;

      const source = restoreBtn.dataset.source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
      const fieldIndex = parseInt(restoreBtn.dataset.index || '-1', 10);
      const userDefinedId = restoreBtn.dataset.userDefinedId || null;

      let result;
      let label = 'field';

      if (fieldIndex >= 0) {
        // Restore by index (field exists in array)
        const fields = source === FieldSource.VAR ? state.getVarFields?.() : state.getFields?.();
        const field = fields?.[fieldIndex];
        label = field?.key || 'field';
        result = state.restoreField?.(source, fieldIndex);
      } else if (userDefinedId) {
        // Restore by userDefinedId (field only in registry)
        result = state.restoreUserDefinedField?.(userDefinedId, source);
        label = result?.key || 'field';
      } else {
        return;
      }

      if (!result || result.ok !== true) {
        getNotificationCenter().error('Failed to restore field', { category: 'filter' });
        return;
      }

      if (result.renamedTo) {
        getNotificationCenter().success(`Restored "${label}" as "${result.key}"`, { category: 'filter', duration: 2800 });
      } else {
        getNotificationCenter().success(`Restored "${result.key || label}"`, { category: 'filter', duration: 2500 });
      }
    });
  }

  return { renderDeletedFieldsSection };
}
