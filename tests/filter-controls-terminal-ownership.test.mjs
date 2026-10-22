import assert from 'node:assert/strict';
import test from 'node:test';

import { initFilterControls } from '../assets/js/app/ui/modules/filter-controls.js';

function createElement(tagName = 'div') {
  const listeners = new Map();
  const element = {
    tagName,
    checked: false,
    children: [],
    className: '',
    dataset: {},
    attributes: {},
    textContent: '',
    parentElement: null,
    ownerDocument: {
      getElementById() {
        return null;
      },
      defaultView: {}
    },
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
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = [];
      for (const child of children) this.appendChild(child);
    },
    contains(node) {
      for (let current = node; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    },
    closest(selector) {
      const className = selector.slice(1);
      for (let current = this; current; current = current.parentElement) {
        if (String(current.className).split(/\s+/).includes(className)) return current;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    listeners(type) {
      return [...(listeners.get(type) ?? [])];
    }
  };
  return element;
}

test('filter-control destroy detaches and fences the delegated list listeners', () => {
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
    assert.equal(countEl.textContent, 'Showing 1 of 2 cells');
    const renderedItem = activeFiltersEl.children[0];
    assert.equal(renderedItem.dataset.filterId, 'filter-1');
    const checkbox = renderedItem.children[0];
    const removeButton = renderedItem.children[2];
    // Rows carry no listeners: the list delegates both interactions.
    assert.equal(checkbox.listeners('change').length, 0);
    assert.equal(removeButton.listeners('click').length, 0);
    const retainedChange = activeFiltersEl.listeners('change')[0];
    const retainedClick = activeFiltersEl.listeners('click')[0];

    mutations.length = 0;
    checkbox.checked = false;
    retainedChange({ target: checkbox });
    assert.deepEqual(mutations.slice(0, 2), [['toggle', 'filter-1', false], ['changed']]);
    mutations.length = 0;

    controls.destroy();
    controls.destroy();
    assert.equal(activeFiltersEl.listeners('change').length, 0);
    assert.equal(activeFiltersEl.listeners('click').length, 0);

    retainedChange({ target: checkbox });
    retainedClick({ target: removeButton, stopPropagation() {} });
    controls.render();
    assert.deepEqual(mutations, []);
  } finally {
    globalThis.document = previousDocument;
  }
});
