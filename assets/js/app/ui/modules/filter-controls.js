/**
 * @fileoverview Active filter summary UI.
 *
 * Renders the current filter stack, allows enabling/disabling filters, and
 * provides remove controls. This module does not render the legend itself; it
 * delegates cross-module refresh via callbacks.
 *
 * The list's two interactions are delegated to the list element, so a render
 * only builds rows. Counting a filter's cells is a pass over the dataset per
 * filter, so the list is drawn only while its panel is shown and catches up
 * when the panel opens; the one-line total above it is always current.
 *
 * @module ui/modules/filter-controls
 */

import { createEmptyState, createListItem } from '../components/controls.js';
import { formatCount } from '../components/display-format.js';
import { createVisibilityGatedRender } from '../core/visibility-gate.js';

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
  const lifecycle = new AbortController();
  let destroyed = false;

  function rowFilterId(target) {
    const item = typeof target?.closest === 'function'
      ? target.closest('.list-item')
      : null;
    if (item === null || !activeFiltersEl.contains(item)) return null;
    const id = item.dataset.filterId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('Active filter row requires its filter id');
    }
    return id;
  }

  function afterChange() {
    callbacks.onFiltersChanged?.();
    render();
  }

  if (activeFiltersEl) {
    activeFiltersEl.addEventListener('change', (event) => {
      if (destroyed) return;
      const id = rowFilterId(event.target);
      if (id === null) return;
      state.toggleFilterEnabled?.(id, event.target.checked);
      afterChange();
    }, { signal: lifecycle.signal });
    activeFiltersEl.addEventListener('click', (event) => {
      if (destroyed) return;
      const button = typeof event.target?.closest === 'function'
        ? event.target.closest('.list-item-remove')
        : null;
      if (button === null) return;
      const id = rowFilterId(button);
      if (id === null) return;
      event.stopPropagation();
      state.removeFilter?.(id);
      afterChange();
    }, { signal: lifecycle.signal });
  }

  function renderList() {
    if (destroyed || !activeFiltersEl) return;
    const filters = state.getActiveFiltersStructured ? state.getActiveFiltersStructured() : [];
    if (filters.length === 0) {
      activeFiltersEl.replaceChildren(createEmptyState('No filters active.'));
      return;
    }
    const rows = filters.map((filter) => {
      const counts = state.getFilterCellCounts ? state.getFilterCellCounts(filter) : null;
      const countText =
        counts && Number.isFinite(counts.visible) && Number.isFinite(counts.available)
          ? ` • ${formatCount(counts.visible)} / ${formatCount(counts.available)} cells`
          : '';
      const { root } = createListItem({
        text: filter.text + countText,
        enabled: filter.enabled,
        noun: 'filter'
      });
      root.dataset.filterId = filter.id;
      return root;
    });
    activeFiltersEl.replaceChildren(...rows);
  }

  const listGate = activeFiltersEl
    ? createVisibilityGatedRender(activeFiltersEl, renderList)
    : null;

  function render() {
    if (destroyed) return;
    if (!activeFiltersEl || !filterCountEl) return;
    listGate.request();

    const counts = state.getFilteredCount ? state.getFilteredCount() : { shown: 0, total: 0 };
    const shown = counts?.shown ?? 0;
    const total = counts?.total ?? 0;
    filterCountEl.textContent = shown === total
      ? `Showing all ${formatCount(total)} cells`
      : `Showing ${formatCount(shown)} of ${formatCount(total)} cells`;

    if (viewer?.hasSnapshots && viewer.hasSnapshots()) {
      callbacks.onViewBadgesMaybeChanged?.();
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    lifecycle.abort();
    listGate?.destroy();
  }

  return { render, destroy };
}
