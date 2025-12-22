/**
 * @fileoverview Categorical legend rendering + interactions.
 *
 * Owns the categorical legend UI: category visibility checkboxes, color picker,
 * rename/delete operations, and drag-to-merge behavior.
 *
 * @module ui/modules/legend/categorical-legend
 */

import { StyleManager } from '../../../../utils/style-manager.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { InlineEditor } from '../../components/inline-editor.js';
import { showConfirmDialog } from '../../components/confirm-dialog.js';
import { FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { StateValidator } from '../../../utils/state-validator.js';
import { clamp } from '../../../utils/number-utils.js';

function rgbToHex(color) {
  const toChannel = (v) => clamp(Math.round(v * 255), 0, 255);
  const r = toChannel(color?.[0] ?? 0);
  const g = toChannel(color?.[1] ?? 0);
  const b = toChannel(color?.[2] ?? 0);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function hexToRgb01(hex) {
  if (typeof hex !== 'string') return null;
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  const r = parseInt(normalized.slice(0, 2), 16) / 255;
  const g = parseInt(normalized.slice(2, 4), 16) / 255;
  const b = parseInt(normalized.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function validateCategoryLabel(nextValue) {
  const value = String(nextValue ?? '').trim();
  if (!value) return 'Label cannot be empty';
  try {
    StateValidator.validateCategoryLabel(value);
  } catch (err) {
    return err?.message || 'Invalid category label';
  }
  return true;
}

function formatCategoryCount(visibleCount, availableCount) {
  const visible = Number.isFinite(visibleCount) ? visibleCount : 0;
  const available = Number.isFinite(availableCount) ? availableCount : visible;
  if (available > 0 && available !== visible) {
    return `${visible.toLocaleString()} / ${available.toLocaleString()} cells`;
  }
  return `${visible.toLocaleString()} cells`;
}

export function initCategoricalLegend({ state, legendEl }) {
  function refreshCategoryCounts() {
    const activeField = state.getActiveField ? state.getActiveField() : null;
    if (!activeField || activeField.kind !== 'category') return;
    const model = state.getLegendModel(activeField);
    const counts = model?.counts;
    if (!counts || !legendEl) return;
    const visibleList = counts.visible || [];
    const availableList = counts.available || [];
    const rows = legendEl.querySelectorAll('.legend-item[data-cat-index]');
    rows.forEach((row) => {
      const idx = parseInt(row.dataset.catIndex, 10);
      if (Number.isNaN(idx)) return;
      const visible = visibleList[idx] || 0;
      const available = availableList[idx] || 0;
      const hasCells = available > 0;
      row.classList.toggle('legend-item-disabled', !hasCells);
      row.title = hasCells ? '' : 'No cells available in this category after other filters';
      const checkbox = row.querySelector('.legend-checkbox');
      if (checkbox) checkbox.disabled = !hasCells;
      const colorInput = row.querySelector('.legend-color-input');
      if (colorInput) colorInput.disabled = !hasCells;
      const countSpan = row.querySelector('.legend-count');
      if (countSpan) countSpan.textContent = formatCategoryCount(visible, available);
    });
  }

  function renderCategoricalLegend(field, model) {
    if (!legendEl) return;

    const catSection = document.createElement('div');
    catSection.className = 'legend-section';
    const title = document.createElement('div');
    title.textContent = 'Click a swatch to pick a color';
    title.style.fontSize = '10px';
    title.style.opacity = '0.8';
    title.style.marginBottom = '4px';
    catSection.appendChild(title);

    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'legend-controls';
    const showAllBtn = document.createElement('button');
    showAllBtn.textContent = 'Show All';
    showAllBtn.addEventListener('click', () => {
      state.showAllCategories(field, { onlyAvailable: true });
      legendEl.querySelectorAll('.legend-checkbox:not(:disabled)').forEach((cb) => {
        cb.checked = true;
      });
    });
    const hideAllBtn = document.createElement('button');
    hideAllBtn.textContent = 'Hide All';
    hideAllBtn.addEventListener('click', () => {
      state.hideAllCategories(field, { onlyAvailable: true });
      legendEl.querySelectorAll('.legend-checkbox:not(:disabled)').forEach((cb) => {
        cb.checked = false;
      });
    });
    controlsDiv.appendChild(showAllBtn);
    controlsDiv.appendChild(hideAllBtn);
    catSection.appendChild(controlsDiv);

    const categories = model.categories || [];
    const counts = model.counts || {};
    const visibleCounts = counts.visible || [];
    const availableCounts = counts.available || [];
    const sortedIndices = categories
      .map((cat, idx) => ({ cat: String(cat), idx }))
      .sort((a, b) => a.cat.localeCompare(b.cat, undefined, { numeric: true, sensitivity: 'base' }))
      .map((item) => item.idx);

    const CATEGORY_DRAG_MIME = 'application/x-cellucid-category';

    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'legend-items-container';
    const needsScroll = sortedIndices.length > 16;
    if (needsScroll) {
      itemsContainer.classList.add('legend-items-scrollable');
      itemsContainer.addEventListener('scroll', () => {
        const isAtBottom =
          itemsContainer.scrollHeight - itemsContainer.scrollTop - itemsContainer.clientHeight < 8;
        itemsContainer.classList.toggle('scrolled-to-bottom', isAtBottom);
      });
    }

    sortedIndices.forEach((catIdx) => {
      const cat = String(categories[catIdx]);
      const isVisible = field._categoryVisible?.[catIdx] !== false;
      const visibleCount = visibleCounts[catIdx] || 0;
      const availableCount = availableCounts[catIdx] || 0;
      const hasCells = availableCount > 0;
      const originalLabel = field._originalCategories?.[catIdx];
      const isRenamed = originalLabel != null && String(originalLabel) !== cat;

      const row = document.createElement('div');
      row.className = 'legend-item';
      row.dataset.catIndex = String(catIdx);
      if (!hasCells) row.classList.add('legend-item-disabled');
      row.title = hasCells ? '' : 'No cells available in this category after other filters';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'legend-checkbox';
      checkbox.checked = isVisible;
      checkbox.disabled = !hasCells;
      checkbox.addEventListener('change', (e) => {
        state.setVisibilityForCategory(field, catIdx, e.target.checked);
      });

      const swatch = document.createElement('div');
      swatch.className = 'legend-swatch';

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'legend-color-input';
      colorInput.disabled = !hasCells;

      const updateColorUI = () => {
        const nextColor = state.getColorForCategory(field, catIdx);
        StyleManager.setVariable(swatch, '--legend-swatch-color', state.rgbToCss(nextColor));
        colorInput.value = rgbToHex(nextColor);
      };
      updateColorUI();

      colorInput.addEventListener('input', (e) => {
        const rgb = hexToRgb01(e.target.value);
        if (!rgb) return;
        state.setColorForCategory(field, catIdx, rgb);
        updateColorUI();
      });

      swatch.appendChild(colorInput);

      const labelSpan = document.createElement('span');
      labelSpan.className = 'legend-label';
      labelSpan.textContent = cat;
      if (isRenamed) {
        labelSpan.classList.add('is-renamed');
        labelSpan.title = `Original: ${originalLabel}`;
      } else {
        labelSpan.title = 'Double-click to rename • Drag onto another category to merge';
      }

      labelSpan.draggable = true;
      labelSpan.classList.add('legend-label-draggable');
      labelSpan.addEventListener('dragstart', (e) => {
        row.classList.add('legend-item-dragging');
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(CATEGORY_DRAG_MIME, JSON.stringify({ catIdx }));
        e.dataTransfer.setData('text/plain', String(catIdx));
      });
      labelSpan.addEventListener('dragend', () => {
        row.classList.remove('legend-item-dragging');
        itemsContainer
          .querySelectorAll('.legend-item-drag-over')
          .forEach((el) => el.classList.remove('legend-item-drag-over'));
      });

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'legend-rename-btn';
      renameBtn.title = 'Rename category';
      renameBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      `;

      const startRename = () => {
        const fieldIndex = state.activeFieldSource === FieldSource.OBS ? state.activeFieldIndex : -1;
        if (!Number.isInteger(fieldIndex) || fieldIndex < 0) return;
        const currentField = state.getFields?.()?.[fieldIndex];
        if (!currentField || currentField.kind !== FieldKind.CATEGORY) return;
        const currentLabel = currentField.categories?.[catIdx] ?? '';

        InlineEditor.create(labelSpan, currentLabel, {
          onSave: (newLabel) => {
            const ok = state.renameCategory?.(FieldSource.OBS, fieldIndex, catIdx, newLabel);
            if (!ok) {
              getNotificationCenter().error('Failed to rename category', { category: 'filter' });
              return;
            }
            getNotificationCenter().success(`Category renamed to \"${newLabel}\"`, { category: 'filter', duration: 2000 });
          },
          validate: validateCategoryLabel
        });
      };

      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRename();
      });
      labelSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'legend-delete-btn';
      deleteBtn.title = 'Delete category (merge into unassigned)';
      deleteBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      `;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        const fieldIndex = state.activeFieldSource === FieldSource.OBS ? state.activeFieldIndex : -1;
        if (!Number.isInteger(fieldIndex) || fieldIndex < 0) return;
        const currentField = state.getFields?.()?.[fieldIndex];
        if (!currentField || currentField.kind !== FieldKind.CATEGORY) return;

        const currentLabel = String(currentField.categories?.[catIdx] ?? '');
        const unassignedLabel = 'unassigned';
        const inPlace = currentField._isUserDefined === true;

        showConfirmDialog({
          title: 'Delete category label',
          message:
            `Delete category \"${currentLabel}\"?\n\n` +
            (inPlace
              ? `This edits the current derived column in place, merging \"${currentLabel}\" into \"${unassignedLabel}\".\n` +
                `To undo, restore the original column from Deleted Fields.`
              : `This creates a new categorical column where \"${currentLabel}\" is merged into \"${unassignedLabel}\".\n` +
                `The previous column is moved to Deleted Fields for restore.`),
          confirmText: 'Delete category',
          onConfirm: () => {
            const result = state.deleteCategoryToUnassigned?.(fieldIndex, catIdx, { unassignedLabel, editInPlace: inPlace });
            if (!result) {
              getNotificationCenter().error('Failed to delete category', { category: 'filter' });
              return;
            }
            const msg = result.updatedInPlace
              ? `Merged into \"${unassignedLabel}\" (edited in place)`
              : `Moved into \"${unassignedLabel}\"`;
            getNotificationCenter().success(msg, { category: 'filter', duration: 2400 });
          }
        });
      });

      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        if (!e.dataTransfer.types?.includes?.(CATEGORY_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('legend-item-drag-over');
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('legend-item-drag-over');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('legend-item-drag-over');

        let payload = null;
        try {
          payload = JSON.parse(e.dataTransfer?.getData?.(CATEGORY_DRAG_MIME) || 'null');
        } catch {}

        const fromIdx = Number.isInteger(payload?.catIdx)
          ? payload.catIdx
          : parseInt(e.dataTransfer?.getData?.('text/plain') || '', 10);
        if (!Number.isInteger(fromIdx) || fromIdx < 0) return;
        if (fromIdx === catIdx) return;

        const fieldIndex = state.activeFieldSource === FieldSource.OBS ? state.activeFieldIndex : -1;
        if (!Number.isInteger(fieldIndex) || fieldIndex < 0) return;
        const currentField = state.getFields?.()?.[fieldIndex];
        if (!currentField || currentField.kind !== FieldKind.CATEGORY) return;

        const fromLabel = String(currentField.categories?.[fromIdx] ?? '');
        const toLabel = String(currentField.categories?.[catIdx] ?? '');
        const inPlace = currentField._isUserDefined === true;

        showConfirmDialog({
          title: 'Merge categories',
          message:
            `Merge category \"${fromLabel}\" into \"${toLabel}\"?\n\n` +
            (inPlace
              ? `This edits the current derived column in place.\n` +
                `To undo, restore the original column from Deleted Fields.`
              : `This creates a new categorical column and moves the previous column to Deleted Fields for restore.`),
          confirmText: 'Merge',
          onConfirm: () => {
            const result = state.mergeCategoriesToNewField?.(fieldIndex, fromIdx, catIdx, { editInPlace: inPlace });
            if (!result) {
              getNotificationCenter().error('Failed to merge categories', { category: 'filter' });
              return;
            }
            const mergedLabel = result.mergedCategoryLabel ? ` → \"${result.mergedCategoryLabel}\"` : '';
            const suffix = result.updatedInPlace ? ' (edited in place)' : '';
            getNotificationCenter().success(
              `Merged \"${fromLabel}\" into \"${toLabel}\"${mergedLabel}${suffix}`,
              { category: 'filter', duration: 2400 }
            );
          }
        });
      });

      const countSpan = document.createElement('span');
      countSpan.className = 'legend-count';
      countSpan.textContent = formatCategoryCount(visibleCount, availableCount);

      row.appendChild(checkbox);
      row.appendChild(swatch);
      row.appendChild(labelSpan);
      row.appendChild(countSpan);
      row.appendChild(renameBtn);
      row.appendChild(deleteBtn);
      itemsContainer.appendChild(row);
    });

    catSection.appendChild(itemsContainer);
    legendEl.appendChild(catSection);
  }

  return {
    refreshCategoryCounts,
    renderCategoricalLegend
  };
}

