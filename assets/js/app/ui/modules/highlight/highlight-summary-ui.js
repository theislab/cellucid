/**
 * @fileoverview Highlight summary UI renderer.
 *
 * Renders the list of highlight groups and the highlighted cell count, and
 * wires basic interactions (enable/disable, remove, clear all) back to state.
 *
 * The count and Clear appear on two surfaces, the Highlighting panel and the
 * selection bar over the plot; both are drawn and handled here, so the bar's
 * Clear is the panel's Clear and nothing else.
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
import { createListItem } from '../../components/controls.js';
import { formatCount } from '../../components/display-format.js';

function requireDomElementList(elements, label, methods = []) {
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new TypeError(`${label}s must be a nonempty array.`);
  }
  return elements.map(element => requireDomElement(element, label, methods));
}

/**
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} [options.dom]
 * @param {HTMLElement[]} options.dom.countEls every highlighted-count line
 * @param {HTMLElement} options.dom.groupsEl
 * @param {HTMLButtonElement[]} options.dom.clearButtons every Clear button
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
    ['countEls', 'groupsEl', 'clearButtons'],
    'Highlight summary DOM'
  );
  const highlightCountEls = requireDomElementList(
    dom.countEls,
    'Highlight count element'
  );
  const highlightedGroupsEl = requireDomElement(
    dom.groupsEl,
    'Highlighted groups element',
    ['addEventListener', 'contains', 'replaceChildren']
  );
  const clearButtons = requireDomElementList(
    dom.clearButtons,
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

  // Validating a group walks every one of its cells, and the summary is
  // redrawn on every visibility frame and every level-of-detail change while
  // the camera moves. A group object is validated once per dataset size; a
  // new or replaced group is validated when it first appears.
  const validatedGroups = new WeakMap();
  function requireGroupOnce(group) {
    if (
      group !== null
      && typeof group === 'object'
      && validatedGroups.get(group) === state.pointCount
    ) {
      return;
    }
    requireHighlightGroup(group, 'Highlight group', state.pointCount);
    validatedGroups.set(group, state.pointCount);
  }

  function rowGroupId(target) {
    const item = target !== null && typeof target === 'object' && typeof target.closest === 'function'
      ? target.closest('.list-item')
      : null;
    if (item === null || !highlightedGroupsEl.contains(item)) return null;
    const id = item.dataset.highlightId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('Highlighted group row requires its highlight id.');
    }
    return id;
  }

  // The rows carry no listeners: the list handles both interactions.
  listen(highlightedGroupsEl, 'change', (event) => {
    const id = rowGroupId(event.target);
    if (id === null) return;
    requireStateOperation(
      state.toggleHighlightEnabled(id, event.target.checked),
      'Highlight toggle'
    );
  });
  listen(highlightedGroupsEl, 'click', (event) => {
    const target = event.target;
    const button = target !== null && typeof target === 'object' && typeof target.closest === 'function'
      ? target.closest('.list-item-remove')
      : null;
    if (button === null) return;
    const id = rowGroupId(button);
    if (id === null) return;
    event.stopPropagation();
    requireStateOperation(
      state.removeHighlightGroup(id),
      'Highlight removal'
    );
  });

  let renderedGroupsKey = null;

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
      requireGroupOnce(group);
      if (seenIds.has(group.id)) {
        throw new TypeError(
          'Highlight group ids must be unique.'
        );
      }
      seenIds.add(group.id);
    }

    let countText;
    if (totalCount === 0) {
      countText = 'No cells highlighted';
    } else if (visibleCount === totalCount) {
      countText = `${formatCount(totalCount)} cells highlighted`;
    } else {
      countText = `${formatCount(visibleCount)} of ${formatCount(totalCount)} highlighted cells visible`;
    }
    for (const countEl of highlightCountEls) {
      if (countEl.textContent !== countText) countEl.textContent = countText;
    }
    for (const clearButton of clearButtons) {
      clearButton.hidden = groups.length === 0;
    }

    // The rows change only when a group is added, removed, renamed or
    // switched; a visibility frame that changed none of that leaves them.
    const groupsKey = JSON.stringify(
      groups.map(group => [group.id, group.label, group.cellCount, group.enabled])
    );
    if (groupsKey === renderedGroupsKey) return;
    renderedGroupsKey = groupsKey;

    const rows = groups.map((group) => {
      const { root } = createListItem({
        text: `${group.label} (${formatCount(group.cellCount)})`,
        enabled: group.enabled,
        noun: 'highlight'
      });
      root.dataset.highlightId = group.id;
      // The text's tooltip is the group's own label, without the count.
      root.children[1].title = group.label;
      return root;
    });
    highlightedGroupsEl.replaceChildren(...rows);
  }

  for (const clearButton of clearButtons) {
    listen(clearButton, 'click', () => {
      state.clearAllHighlights();
    });
  }

  return {
    renderHighlightSummary,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lifecycleController.abort();
    }
  };
}
