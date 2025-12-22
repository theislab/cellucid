/**
 * @fileoverview Highlight summary UI renderer.
 *
 * Renders the list of highlight groups and the highlighted cell count, and
 * wires basic interactions (enable/disable, remove, clear all) back to state.
 *
 * @module ui/modules/highlight/highlight-summary-ui
 */

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} [options.dom]
 * @param {HTMLElement|null} [options.dom.countEl]
 * @param {HTMLElement|null} [options.dom.groupsEl]
 * @param {HTMLButtonElement|null} [options.dom.clearAllBtn]
 */
export function initHighlightSummaryUI({ state, dom }) {
  const highlightCountEl = dom?.countEl || null;
  const highlightedGroupsEl = dom?.groupsEl || null;
  const clearAllHighlightsBtn = dom?.clearAllBtn || null;

  function renderHighlightSummary() {
    if (!highlightedGroupsEl || !highlightCountEl) return;

    const groups = state.getHighlightedGroups();
    const visibleCount = state.getHighlightedCellCount();
    const totalCount = state.getTotalHighlightedCellCount ? state.getTotalHighlightedCellCount() : visibleCount;

    if (totalCount === 0) {
      highlightCountEl.textContent = 'No cells highlighted';
    } else if (visibleCount === totalCount) {
      highlightCountEl.textContent = `${totalCount.toLocaleString()} cells highlighted`;
    } else {
      highlightCountEl.textContent = `${visibleCount.toLocaleString()} of ${totalCount.toLocaleString()} highlighted cells visible`;
    }

    if (clearAllHighlightsBtn) {
      clearAllHighlightsBtn.style.display = groups.length > 0 ? 'inline-block' : 'none';
    }

    highlightedGroupsEl.innerHTML = '';

    if (groups.length === 0) return;

    groups.forEach((group) => {
      const enabled = group.enabled !== false;
      const item = document.createElement('div');
      item.className = 'highlight-item' + (enabled ? '' : ' disabled');
      item.dataset.highlightId = group.id;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'highlight-checkbox';
      checkbox.checked = enabled;
      checkbox.title = enabled ? 'Disable this highlight' : 'Enable this highlight';
      checkbox.addEventListener('change', () => {
        state.toggleHighlightEnabled(group.id, checkbox.checked);
      });

      const textSpan = document.createElement('span');
      textSpan.className = 'highlight-text';
      textSpan.textContent = `${group.label} (${group.cellCount.toLocaleString()})`;
      textSpan.title = group.label;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'highlight-remove-btn';
      removeBtn.innerHTML = '×';
      removeBtn.title = 'Remove this highlight';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.removeHighlightGroup(group.id);
      });

      item.appendChild(checkbox);
      item.appendChild(textSpan);
      item.appendChild(removeBtn);
      highlightedGroupsEl.appendChild(item);
    });
  }

  if (clearAllHighlightsBtn) {
    clearAllHighlightsBtn.addEventListener('click', () => {
      state.clearAllHighlights();
    });
  }

  return { renderHighlightSummary };
}

