/**
 * @fileoverview Highlight summary UI renderer.
 *
 * Renders the list of highlight groups and the highlighted cell count, and
 * wires basic interactions (enable/disable, remove, clear all) back to state.
 *
 * @module ui/modules/highlight/highlight-summary-ui
 */

import {
  requireDomElement,
  requireExactKeys,
  requireHighlightGroup,
  requireMethods,
  requireSafeInteger
} from './exact-contract.js';

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} [options.dom]
 * @param {HTMLElement|null} [options.dom.countEl]
 * @param {HTMLElement|null} [options.dom.groupsEl]
 * @param {HTMLButtonElement|null} [options.dom.clearAllBtn]
 */
export function initHighlightSummaryUI(options) {
  requireExactKeys(
    options,
    ['state', 'dom'],
    'Highlight summary UI options'
  );
  const { state, dom } = options;
  requireMethods(
    state,
    'Highlight summary state',
    [
      'clearAllHighlights',
      'getHighlightedCellCount',
      'getHighlightedGroups',
      'getTotalHighlightedCellCount',
      'removeHighlightGroup',
      'toggleHighlightEnabled'
    ]
  );
  requireExactKeys(
    dom,
    ['countEl', 'groupsEl', 'clearAllBtn'],
    'Highlight summary DOM'
  );
  const highlightCountEl = requireDomElement(
    dom.countEl,
    'Highlight count element'
  );
  const highlightedGroupsEl = requireDomElement(
    dom.groupsEl,
    'Highlighted groups element',
    ['appendChild']
  );
  const clearAllHighlightsBtn = requireDomElement(
    dom.clearAllBtn,
    'Clear highlights button',
    ['addEventListener']
  );
  const documentOwner = globalThis.document;
  requireMethods(
    documentOwner,
    'Highlight summary document',
    ['createElement']
  );
  const lifecycleController = new AbortController();
  let destroyed = false;

  function listen(target, eventName, listener) {
    target.addEventListener(eventName, (...args) => {
      if (destroyed) return;
      listener(...args);
    }, { signal: lifecycleController.signal });
  }

  function requireStateOperation(result, label) {
    if (result !== true) {
      throw new Error(`${label} was rejected by highlight state.`);
    }
  }

  function renderHighlightSummary() {
    if (destroyed) return;
    const groups = state.getHighlightedGroups();
    if (!Array.isArray(groups)) {
      throw new TypeError('Highlighted groups must be an array.');
    }
    const visibleCount = state.getHighlightedCellCount();
    const totalCount = state.getTotalHighlightedCellCount();
    requireSafeInteger(
      visibleCount,
      'Visible highlighted cell count',
      0
    );
    requireSafeInteger(totalCount, 'Total highlighted cell count', 0);
    if (visibleCount > totalCount) {
      throw new RangeError(
        'Visible highlighted cell count must not exceed total count.'
      );
    }
    const seenIds = new Set();
    for (const group of groups) {
      requireHighlightGroup(group, 'Highlight group');
      if (seenIds.has(group.id)) {
        throw new TypeError(
          'Highlight group ids must be unique.'
        );
      }
      seenIds.add(group.id);
    }

    if (totalCount === 0) {
      highlightCountEl.textContent = 'No cells highlighted';
    } else if (visibleCount === totalCount) {
      highlightCountEl.textContent = `${totalCount.toLocaleString()} cells highlighted`;
    } else {
      highlightCountEl.textContent = `${visibleCount.toLocaleString()} of ${totalCount.toLocaleString()} highlighted cells visible`;
    }

    clearAllHighlightsBtn.style.display =
      groups.length > 0 ? 'inline-block' : 'none';

    highlightedGroupsEl.innerHTML = '';

    if (groups.length === 0) return;

    groups.forEach((group) => {
      const enabled = group.enabled;
      const item = documentOwner.createElement('div');
      item.className = 'highlight-item' + (enabled ? '' : ' disabled');
      item.dataset.highlightId = group.id;

      const checkbox = documentOwner.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'highlight-checkbox';
      checkbox.checked = enabled;
      checkbox.title = enabled ? 'Disable this highlight' : 'Enable this highlight';
      listen(checkbox, 'change', () => {
        requireStateOperation(
          state.toggleHighlightEnabled(group.id, checkbox.checked),
          'Highlight toggle'
        );
      });

      const textSpan = documentOwner.createElement('span');
      textSpan.className = 'highlight-text';
      textSpan.textContent = `${group.label} (${group.cellCount.toLocaleString()})`;
      textSpan.title = group.label;

      const removeBtn = documentOwner.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'highlight-remove-btn';
      removeBtn.innerHTML = '×';
      removeBtn.title = 'Remove this highlight';
      listen(removeBtn, 'click', (e) => {
        e.stopPropagation();
        requireStateOperation(
          state.removeHighlightGroup(group.id),
          'Highlight removal'
        );
      });

      item.appendChild(checkbox);
      item.appendChild(textSpan);
      item.appendChild(removeBtn);
      highlightedGroupsEl.appendChild(item);
    });
  }

  listen(clearAllHighlightsBtn, 'click', () => {
    state.clearAllHighlights();
  });

  return {
    renderHighlightSummary,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lifecycleController.abort();
    }
  };
}
