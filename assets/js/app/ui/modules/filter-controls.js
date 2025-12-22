/**
 * @fileoverview Active filter summary UI.
 *
 * Renders the current filter stack, allows enabling/disabling filters, and
 * provides remove controls. This module does not render the legend itself; it
 * delegates cross-module refresh via callbacks.
 *
 * @module ui/modules/filter-controls
 */

/**
 * @typedef {object} FilterCallbacks
 * @property {() => void} [onFiltersChanged] Called after toggling/removing a filter.
 * @property {() => void} [onViewBadgesMaybeChanged] Called when snapshot badges should refresh.
 */

/**
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {object} options.dom
 * @param {HTMLElement|null} options.dom.countEl
 * @param {HTMLElement|null} options.dom.activeFiltersEl
 * @param {FilterCallbacks} [options.callbacks]
 */
export function initFilterControls({ state, viewer, dom, callbacks = {} }) {
  const filterCountEl = dom?.countEl || null;
  const activeFiltersEl = dom?.activeFiltersEl || null;

  function render() {
    if (!activeFiltersEl || !filterCountEl) return;

    const filters = state.getActiveFiltersStructured ? state.getActiveFiltersStructured() : [];
    activeFiltersEl.innerHTML = '';

    if (filters.length === 0) {
      const line = document.createElement('div');
      line.className = 'filter-info';
      line.textContent = 'No filters active';
      activeFiltersEl.appendChild(line);
    } else {
      filters.forEach((filter) => {
        const item = document.createElement('div');
        item.className = 'filter-item' + (filter.enabled ? '' : ' disabled');
        item.dataset.filterId = filter.id;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'filter-checkbox';
        checkbox.checked = filter.enabled;
        checkbox.title = filter.enabled ? 'Disable this filter' : 'Enable this filter';
        checkbox.addEventListener('change', () => {
          const enabled = checkbox.checked;
          state.toggleFilterEnabled?.(filter.id, enabled);
          callbacks.onFiltersChanged?.();
          render();
        });

        const textSpan = document.createElement('span');
        textSpan.className = 'filter-text';
        const counts = state.getFilterCellCounts ? state.getFilterCellCounts(filter) : null;
        const countText =
          counts && Number.isFinite(counts.visible) && Number.isFinite(counts.available)
            ? ` • ${counts.visible.toLocaleString()} / ${counts.available.toLocaleString()} cells`
            : '';
        const fullText = filter.text + countText;
        textSpan.textContent = fullText;
        textSpan.title = fullText;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'filter-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.title = 'Remove this filter';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.removeFilter?.(filter.id);
          callbacks.onFiltersChanged?.();
          render();
        });

        item.appendChild(checkbox);
        item.appendChild(textSpan);
        item.appendChild(removeBtn);
        activeFiltersEl.appendChild(item);
      });
    }

    const counts = state.getFilteredCount ? state.getFilteredCount() : { shown: 0, total: 0 };
    const shown = counts?.shown ?? 0;
    const total = counts?.total ?? 0;
    if (shown === total) {
      filterCountEl.textContent = `Showing all ${total.toLocaleString()} points`;
    } else {
      filterCountEl.textContent = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} points`;
    }

    if (viewer?.hasSnapshots && viewer.hasSnapshots()) {
      callbacks.onViewBadgesMaybeChanged?.();
    }
  }

  return { render };
}

