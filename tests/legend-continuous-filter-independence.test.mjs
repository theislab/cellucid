import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.ownerDocument = globalThis.document;
    this.children = [];
    this.style = { setProperty() {} };
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    };
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren() {
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  set innerHTML(_value) {
    this.children = [];
  }
}

const previousDocument = globalThis.document;
const previousHTMLElement = globalThis.HTMLElement;
const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
globalThis.HTMLElement = FakeElement;
globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
  createTextNode: (text) => ({ textContent: text, children: [] }),
  addEventListener() {},
};
// A slider applies its work once per animation frame. Frames here run at the
// end of the dispatching task, which is when the filter state is read.
const pendingFrames = [];
globalThis.requestAnimationFrame = (callback) => pendingFrames.push(callback);
globalThis.cancelAnimationFrame = (handle) => {
  pendingFrames[handle - 1] = null;
};
function runFrames() {
  while (pendingFrames.some(Boolean)) {
    const frames = pendingFrames.splice(0);
    for (const frame of frames) frame?.();
  }
}
test.after(() => {
  globalThis.document = previousDocument;
  globalThis.HTMLElement = previousHTMLElement;
  globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
});

const { initLegendRenderer } = await import('../assets/js/app/ui/modules/legend-renderer.js');
const { DataStateColorMethods } = await import('../assets/js/app/state/managers/color-manager.js');

function renderLegend(values, prepare = () => {}) {
  const field = {
    kind: 'continuous',
    key: 'gene',
    values: Float32Array.from(values),
    loaded: true,
  };
  const visibilityPublications = [];
  const state = {
    pointCount: values.length,
    activeFieldIndex: 0,
    activeFieldSource: 'obs',
    activeVarFieldIndex: -1,
    obsData: { fields: [field] },
    varData: { fields: [] },
    colorsArray: new Uint8Array(values.length * 4),
    categoryTransparency: new Uint8Array(values.length).fill(1),
    getActiveField() {
      return field;
    },
    getContinuousFieldRef() {
      return { field };
    },
    getLegendModel(target) {
      return this.updateLegendState(target);
    },
    getContinuousColormaps() {
      return [];
    },
    computeGlobalVisibility() {
      visibilityPublications.push({ ...field._continuousFilter });
    },
    _pushColorsToViewer() {},
    _syncActiveContext() {},
    on() {
      return () => {};
    },
    getActiveViewId() {
      return 'live';
    },
    getDatasetGeneration() {
      return 0;
    },
    getFields() {
      return [];
    },
  };
  for (const name of Object.getOwnPropertyNames(DataStateColorMethods.prototype)) {
    if (name !== 'constructor') state[name] = DataStateColorMethods.prototype[name];
  }
  state.ensureContinuousMetadata(field);
  prepare(field);
  const proxy = new Proxy(state, {
    get(target, key) {
      return key in target ? target[key] : () => {};
    },
  });
  const legendEl = new FakeElement();
  legendEl.ownerDocument = {
    defaultView: {
      HTMLElement: FakeElement,
      HTMLButtonElement: FakeElement,
      addEventListener() {},
    },
    createElement: (tagName) => new FakeElement(tagName),
  };
  const legend = initLegendRenderer({
    state: proxy,
    viewer: null,
    dom: { legendEl, optionsContainer: new FakeElement() },
    dataSourceManager: { getCurrentDatasetId: () => null },
  });
  legend.render(field);
  const nodes = [];
  (function walk(node) {
    nodes.push(node);
    node.children.forEach(walk);
  })(legendEl);
  const sliders = nodes.filter((node) => node.tagName === 'input');
  const buttons = nodes.filter((node) => node.tagName === 'button');
  return {
    field,
    visibilityPublications,
    minSlider: sliders[0],
    maxSlider: sliders[1],
    logToggle: buttons.find((node) => node.attributes.role === 'switch'),
    resetButton: buttons.find((node) => node.textContent === 'Reset'),
    fire(node, type) {
      node.listeners[type].forEach((listener) => listener({ target: node }));
      runFrames();
    },
  };
}

test('a log colour scale never stops the range filter from applying', () => {
  const legend = renderLegend([0, 0.5, 5, 10]);
  legend.fire(legend.logToggle, 'click');
  assert.equal(legend.field._useLogScale, true);

  // Max below the smallest positive value (0.5): the filter is in data
  // units and must follow the slider.
  legend.maxSlider.value = '3';
  legend.fire(legend.maxSlider, 'input');

  assert.deepEqual(legend.field._continuousFilter, { min: 0, max: 0.3 });
  assert.deepEqual(legend.visibilityPublications.at(-1), { min: 0, max: 0.3 });
});

test('RESET and the sliders work on a constant field', () => {
  const legend = renderLegend([2, 2, 2]);
  assert.equal(legend.minSlider.value, '0');
  assert.equal(legend.maxSlider.value, '100');

  legend.fire(legend.resetButton, 'click');
  assert.deepEqual(legend.field._continuousFilter, { min: 2, max: 2 });

  legend.maxSlider.value = '40';
  legend.fire(legend.maxSlider, 'input');
  assert.deepEqual(legend.field._continuousFilter, { min: 2, max: 2 });
});

test('the slider track ends are the exact data bounds', () => {
  const legend = renderLegend([0.1, 0.4, 0.7]);
  legend.minSlider.value = '0';
  legend.maxSlider.value = '100';
  legend.fire(legend.maxSlider, 'input');
  assert.deepEqual(
    legend.field._continuousFilter,
    { min: Math.fround(0.1), max: Math.fround(0.7) },
  );
});

test('drawing the legend does not rewrite the filter it displays', () => {
  const legend = renderLegend([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], (field) => {
    field._continuousFilter.min = 1.234;
    field._continuousFilter.max = 8.765;
  });
  assert.deepEqual(legend.visibilityPublications, []);
  assert.deepEqual(legend.field._continuousFilter, { min: 1.234, max: 8.765 });
});
