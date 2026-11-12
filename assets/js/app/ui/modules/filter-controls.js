/**
 * @fileoverview Active filter summary UI.
 *
 * Renders the current filter stack, allows enabling/disabling filters, and
 * provides remove controls: each is an action (`filter.enable`,
 * `filter.remove`) naming the field and the kind of filter. This module does
 * not render the legend itself; it delegates cross-module refresh via
 * callbacks.
 *
 * The list's two interactions are delegated to the list element, so a render
 * only builds rows. Counting a filter's cells is a pass over the dataset per
 * filter, so the list is drawn only while its panel is shown and catches up
 * when the panel opens; the one-line total above it is always current, and
 * on a subsample says the open cells of every cell ("Showing all 300 of
 * 1,200 cells", `formatOpenCells`).
 *
 * @module ui/modules/filter-controls
 */

import {
  captureListItemFocus,
  createEmptyState,
  createListItem,
  restoreListItemFocus
} from '../components/controls.js';
import { formatCount, formatOpenCells } from '../../../utils/format-units.js';
import { createVisibilityGatedRender } from '../core/visibility-gate.js';
import { dispatchFromControl } from '../../actions/control-dispatch.js';

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
    if (destroyed) return;
    callbacks.onFiltersChanged?.();
    render();
  }

  /** The filter a row shows, by name: its field and kind. */
  function rowTarget(id) {
    const filter = (state.getActiveFiltersStructured?.() ?? []).find(candidate => candidate.id === id);
    if (filter === undefined) return null;
    return { field: { source: filter.source, key: filter.fieldKey }, kind: filter.type };
  }

  if (activeFiltersEl) {
    activeFiltersEl.addEventListener('change', (event) => {
      if (destroyed) return;
      const id = rowFilterId(event.target);
      if (id === null) return;
      const target = rowTarget(id);
      if (target === null) return;
      void dispatchFromControl(
        'filter.enable',
        { ...target, enabled: event.target.checked },
        { failure: 'Could not change the filter' }
      ).then(afterChange);
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
      const target = rowTarget(id);
      if (target === null) return;
      void dispatchFromControl('filter.remove', target, { failure: 'Could not remove the filter' }).then(afterChange);
    }, { signal: lifecycle.signal });
  }

  function renderList() {
    if (destroyed || !activeFiltersEl) return;
    const focused = captureListItemFocus(activeFiltersEl, 'filterId');
    const filters = state.getActiveFiltersStructured ? state.getActiveFiltersStructured() : [];
    if (filters.length === 0) {
      activeFiltersEl.replaceChildren(createEmptyState('No filters active.'));
      restoreListItemFocus(activeFiltersEl, focused, 'filterId');
      return;
    }
    const rows = filters.map((filter) => {
      const counts = state.getFilterCellCounts ? state.getFilterCellCounts(filter) : null;
      const counted = counts && Number.isFinite(counts.visible) && Number.isFinite(counts.available);
      // The cells it keeps, as a number; of how many (those the other filters keep), on hover.
      const { root } = createListItem({
        text: filter.text,
        count: counted ? formatCount(counts.visible) : null,
        countTitle: counted ? `${formatCount(counts.visible)} of ${formatOpenCells(counts.available)} pass this filter` : null,
        enabled: filter.enabled,
        noun: 'filter'
      });
      root.dataset.filterId = filter.id;
      return root;
    });
    activeFiltersEl.replaceChildren(...rows);
    // A toggle or a removal rebuilds the list under the keyboard's focus.
    restoreListItemFocus(activeFiltersEl, focused, 'filterId');
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
    // A subsample's open cells are said against every cell of the dataset.
    const open = formatOpenCells(total, state.cellIdentity?.nOriginal);
    filterCountEl.textContent = shown === total
      ? `Showing all ${open}`
      : `Showing ${formatCount(shown)} of ${open}`;

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
