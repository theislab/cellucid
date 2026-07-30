import assert from 'node:assert/strict';
import test from 'node:test';

import { initFilterControls } from '../assets/js/app/ui/modules/filter-controls.js';

function createElement() {
  const listeners = new Map();
  let html = '';
  return {
    checked: false,
    children: [],
    className: '',
    dataset: {},
    textContent: '',
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.removeEventListener(type, listener);
        }, { once: true });
      }
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter(candidate => candidate !== listener)
      );
    },
    appendChild(child) {
      this.children.push(child);
    },
    listeners(type) {
      return [...(listeners.get(type) ?? [])];
    },
    set innerHTML(value) {
      html = value;
      this.children = [];
    },
    get innerHTML() {
      return html;
    }
  };
}

test('filter-control destroy detaches and fences rendered child listeners', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement };
  try {
    const countEl = createElement();
    const activeFiltersEl = createElement();
    const mutations = [];
    const controls = initFilterControls({
      state: {
        getActiveFiltersStructured() {
          return [{ id: 'filter-1', text: 'Current filter', enabled: true }];
        },
        getFilterCellCounts() {
          return { visible: 1, available: 2 };
        },
        getFilteredCount() {
          return { shown: 1, total: 2 };
        },
        removeFilter(id) {
          mutations.push(['remove', id]);
        },
        toggleFilterEnabled(id, enabled) {
          mutations.push(['toggle', id, enabled]);
        }
      },
      viewer: {
        hasSnapshots() {
          return true;
        }
      },
      dom: { countEl, activeFiltersEl },
      callbacks: {
        onFiltersChanged() {
          mutations.push(['changed']);
        },
        onViewBadgesMaybeChanged() {
          mutations.push(['badges']);
        }
      }
    });
    controls.render();
    const renderedItem = activeFiltersEl.children[0];
    const checkbox = renderedItem.children[0];
    const removeButton = renderedItem.children[2];
    const retainedCheckboxListener = checkbox.listeners('change')[0];
    const retainedRemoveListener = removeButton.listeners('click')[0];
    mutations.length = 0;

    controls.destroy();
    controls.destroy();
    assert.equal(checkbox.listeners('change').length, 0);
    assert.equal(removeButton.listeners('click').length, 0);

    checkbox.checked = false;
    retainedCheckboxListener();
    retainedRemoveListener({ stopPropagation() {} });
    controls.render();
    assert.deepEqual(mutations, []);
  } finally {
    globalThis.document = previousDocument;
  }
});
