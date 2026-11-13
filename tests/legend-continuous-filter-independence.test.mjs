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

  focus() {
    this.ownerDocument.focused = this;
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains?.(node));
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
const { installFieldActions } = await import('../assets/js/app/state/actions/field-actions.js');

// The legend's controls dispatch actions (`app/actions/`): the state's own
// implementations, installed for the legend drawn last.
let removeFieldActions = null;
test.after(() => removeFieldActions?.());
const settle = () => new Promise(resolve => setImmediate(resolve));

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
      return this.obsData.fields;
    },
    getVarFields() {
      return this.varData.fields;
    },
    // A DataState is an event emitter: a color change says so (`colors:changed`).
    emit() {},
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
  removeFieldActions?.();
  removeFieldActions = installFieldActions({ state: proxy });
  const legend = initLegendRenderer({
    state: proxy,
    viewer: null,
    dom: { legendEl, optionsContainer: new FakeElement() },
    dataSourceManager: { getCurrentIdentityId: () => null },
  });
  legend.render(field);
  const nodes = [];
  (function walk(node) {
    nodes.push(node);
    node.children.forEach(walk);
  })(legendEl);
  const sliders = nodes.filter((node) => node.tagName === 'input' && node.type === 'range');
  const boxes = nodes.filter((node) => node.tagName === 'input' && node.type === 'text');
  const buttons = nodes.filter((node) => node.tagName === 'button');
  const switchNamed = (label) => buttons.find((node) => node.attributes.role === 'switch' && node.children.some((child) => child.textContent === label));
  // The legend's controls as drawn now (a rebuild replaces them).
  const drawn = () => {
    const all = [];
    (function walk(node) {
      all.push(node);
      node.children.forEach(walk);
    })(legendEl);
    return all;
  };
  return {
    field,
    state,
    drawn,
    // The legend drawn again (another field and back, another view, a session).
    redraw: () => legend.render(field),
    visibilityPublications,
    minSlider: sliders[0],
    maxSlider: sliders[1],
    minBox: boxes[0],
    maxBox: boxes[1],
    logToggle: switchNamed('Log color scale'),
    zeroGrayToggle: switchNamed('Gray for zero'),
    resetButton: buttons.find((node) => node.textContent === 'Reset'),
    // A control's change is dispatched: it has applied once the dispatch settles.
    async fire(node, type) {
      node.listeners[type].forEach((listener) => listener({ target: node }));
      runFrames();
      await settle();
      runFrames();
    },
  };
}

test('a log color scale never stops the range filter from applying', async () => {
  const legend = renderLegend([0, 0.5, 5, 10]);
  await legend.fire(legend.logToggle, 'click');
  assert.equal(legend.field._useLogScale, true);

  // Max at the track's start (the zeros' step, below the smallest positive
  // value 0.5): the filter is in data units and must follow the slider.
  legend.maxSlider.value = '0';
  await legend.fire(legend.maxSlider, 'input');
  assert.deepEqual(legend.field._continuousFilter, { min: 0, max: 0 });
  // And a typed bound below it, exactly as typed.
  legend.maxBox.value = '0,3';
  await legend.fire(legend.maxBox, 'change');
  assert.deepEqual(legend.field._continuousFilter, { min: 0, max: 0.3 });
  assert.deepEqual(legend.visibilityPublications.at(-1), { min: 0, max: 0.3 });
});

test('RESET and the sliders work on a constant field', async () => {
  const legend = renderLegend([2, 2, 2]);
  assert.equal(legend.minSlider.value, '0');
  assert.equal(legend.maxSlider.value, '1000');

  await legend.fire(legend.resetButton, 'click');
  assert.deepEqual(legend.field._continuousFilter, { min: 2, max: 2 });

  legend.maxSlider.value = '400';
  await legend.fire(legend.maxSlider, 'input');
  assert.deepEqual(legend.field._continuousFilter, { min: 2, max: 2 });
});

test('the slider track ends are the exact data bounds', async () => {
  const legend = renderLegend([0.1, 0.4, 0.7]);
  legend.minSlider.value = '0';
  await legend.fire(legend.minSlider, 'input');
  legend.maxSlider.value = '1000';
  await legend.fire(legend.maxSlider, 'input');
  assert.deepEqual(
    legend.field._continuousFilter,
    { min: Math.fround(0.1), max: Math.fround(0.7) },
  );
});

test('a bound is typed exactly, a slider sets a short one, and only the moved bound changes', async () => {
  // total_counts from 500 to 100,000: a 1% step is 995 counts, so "≥ 1,500" cannot be set by it.
  const legend = renderLegend([500, 900, 1500, 2000, 40000, 100000]);
  legend.minBox.value = '1500';
  await legend.fire(legend.minBox, 'change');
  assert.deepEqual(legend.field._continuousFilter, { min: 1500, max: 100000 });
  assert.equal(legend.minSlider.value, '10', 'the slider follows the typed bound');
  // The other slider moves; the typed bound stays exactly as typed.
  legend.maxSlider.value = '500';
  await legend.fire(legend.maxSlider, 'input');
  assert.deepEqual(legend.field._continuousFilter, { min: 1500, max: 50250 });
  assert.equal(legend.maxBox.value, '50250', 'the box shows the bound applied');
  assert.equal(legend.minBox.value, '1500');
  // Text that is not a number is not applied; the box shows the bound again.
  legend.minBox.value = '1.2.3';
  await legend.fire(legend.minBox, 'change');
  assert.equal(legend.minBox.value, '1500');
  assert.deepEqual(legend.field._continuousFilter, { min: 1500, max: 50250 });
  // A bound past the data is the data's end; a minimum past the maximum moves it.
  legend.minBox.value = '70000';
  await legend.fire(legend.minBox, 'change');
  assert.deepEqual(legend.field._continuousFilter, { min: 70000, max: 70000 });
});

test("a session's exact bounds are shown exactly and survive the other slider moving", async () => {
  const legend = renderLegend([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], (field) => {
    field._continuousFilter.min = 1.234;
    field._continuousFilter.max = 8.765;
  });
  assert.equal(legend.minBox.value, '1.234');
  assert.equal(legend.maxBox.value, '8.765');
  legend.maxSlider.value = '900';
  await legend.fire(legend.maxSlider, 'input');
  assert.deepEqual(legend.field._continuousFilter, { min: 1.234, max: 9 });
});

test('drawing the legend does not rewrite the filter it displays', () => {
  const legend = renderLegend([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], (field) => {
    field._continuousFilter.min = 1.234;
    field._continuousFilter.max = 8.765;
  });
  assert.deepEqual(legend.visibilityPublications, []);
  assert.deepEqual(legend.field._continuousFilter, { min: 1.234, max: 8.765 });
});

test('a color range following a filter of "≥ 1" on counts keeps the cells at 1 colored; with gray for zero, only zeros are gray', async () => {
  const { NEUTRAL_GRAY_UINT8 } = await import('../assets/js/app/state/core/constants.js');
  const counts = [0, 0, 1, 1, 1, 2, 5, 9];
  const legend = renderLegend(counts);
  // Colored as a gene with gray for zero on: count data has a gray floor at its zeros.
  legend.state.activeFieldSource = 'var';
  legend.state.setContinuousZeroGray(0, true);
  legend.minBox.value = '1';
  await legend.fire(legend.minBox, 'change');
  legend.state.setContinuousColorRescale(0, true);
  legend.state.setContinuousColorRange(0, 1, 9);
  legend.state.updateColorsContinuous(legend.field, { expression: true });
  const colors = legend.state.colorsArray;
  const isGray = cell => colors[cell * 4] === NEUTRAL_GRAY_UINT8 && colors[cell * 4 + 1] === NEUTRAL_GRAY_UINT8 && colors[cell * 4 + 2] === NEUTRAL_GRAY_UINT8 && colors[cell * 4 + 3] !== 255;
  assert.deepEqual(counts.map((_, cell) => isGray(cell)), [true, true, false, false, false, false, false, false]);
  // The cells at the bound take the colormap's lowest color, opaque.
  assert.equal(colors[2 * 4 + 3], 255);
});

test('a diverging colormap over data spanning 0 is centred there; a sequential one and one-signed data are not', async () => {
  const { buildColorScaleNote } = await import('../assets/js/app/ui/modules/figure-export/components/legend-builder.js');
  const { CONTINUOUS_COLORMAPS } = await import('../assets/js/data/palettes.js');
  assert.deepEqual(
    CONTINUOUS_COLORMAPS.filter(map => map.diverging).map(map => map.id),
    ['coolwarm', 'bluered', 'spectral', 'rdylbu', 'rdbu', 'piyg', 'prgn', 'brbg', 'seismic']
  );
  // z-scores from -1 to 4: RdBu's white middle at 0, not at 1.5.
  const scaled = renderLegend([-1, 0, 2, 4], field => { field._colormapId = 'rdbu'; });
  const domain = scaled.state.getContinuousColorDomain(scaled.field);
  assert.deepEqual([domain.min, domain.max, domain.centered], [-4, 4, true]);
  const model = scaled.state.updateLegendState(scaled.field);
  assert.equal(model.colorbar.centered, true);
  assert.equal(buildColorScaleNote(model, model.colorbar.min, model.colorbar.max), 'Color scale centered at 0');
  // The color of 0 is the map's middle.
  const values = Float32Array.of(-4, 0, 4);
  const { writeContinuousColors } = await import('../assets/js/app/state/managers/continuous-colors.js');
  const rdbu = CONTINUOUS_COLORMAPS.find(map => map.id === 'rdbu');
  const colors = new Uint8Array(12);
  writeContinuousColors(colors, values, domain, rdbu);
  const middle = [0, 1, 2].map(channel => Math.round(rdbu.sample(0.5)[channel] * 255));
  assert.deepEqual([...colors.subarray(4, 7)], middle);
  // Viridis, and RdBu over one-signed data, keep the data's own range.
  const sequential = renderLegend([-1, 0, 2, 4]);
  assert.deepEqual([sequential.state.getContinuousColorDomain(sequential.field).min, sequential.state.getContinuousColorDomain(sequential.field).centered], [-1, false]);
  const positive = renderLegend([1, 2, 4], field => { field._colormapId = 'rdbu'; });
  assert.deepEqual(positive.state.getContinuousColorDomain(positive.field).min, Math.fround(1));
});

test('gray for zero is off by default: a gene\'s 0 takes the scale\'s lowest color; on, it is gray beneath; never for an obs field or data with negatives', async () => {
  const { NEUTRAL_GRAY_UINT8 } = await import('../assets/js/app/state/core/constants.js');
  const { getColormap, getColormapByteTable } = await import('../assets/js/data/palettes.js');
  const { BENEATH_ALPHA_BYTE } = await import('../assets/js/rendering/alpha-visibility.js');
  const counts = [0, 0, 1, 4];
  const legend = renderLegend(counts);
  const colors = legend.state.colorsArray;
  const gray = cell => colors[cell * 4] === NEUTRAL_GRAY_UINT8 && colors[cell * 4 + 3] === BENEATH_ALPHA_BYTE;
  // An obs field: 0 is a value, whatever the switch says.
  legend.state.updateColorsContinuous(legend.field, { expression: false });
  assert.equal(gray(0), false);
  assert.equal(legend.state.getLegendModel(legend.field).zeroGray.applies, false);
  // A gene, the switch off (the default): the lowest color, opaque.
  legend.state.varData = { fields: [legend.field] };
  legend.state.activeFieldSource = 'var';
  assert.equal(legend.field._zeroGray, false);
  legend.state.updateColorsContinuous(legend.field, { expression: true });
  const lowest = Array.from(getColormapByteTable(getColormap(legend.state.getLegendModel(legend.field).colormap.id)).subarray(0, 3));
  assert.deepEqual(Array.from(colors.subarray(0, 3)), lowest);
  assert.equal(colors[3], 255);
  assert.deepEqual(legend.state.getLegendModel(legend.field).zeroGray, { enabled: false, applies: true, drawn: false });
  // On: zeros gray beneath, the expressing cells colored.
  legend.state.setContinuousZeroGray(0, true);
  assert.deepEqual(counts.map((_, cell) => gray(cell)), [true, true, false, false]);
  assert.deepEqual(legend.state.getLegendModel(legend.field).zeroGray, { enabled: true, applies: true, drawn: true });
  // Off again: the lowest color again.
  legend.state.setContinuousZeroGray(0, false);
  assert.equal(gray(0), false);
  // A log scale draws 0 gray either way (it has no logarithm): said by the model.
  legend.state.setContinuousLogScale(0, true);
  assert.equal(gray(0), true);
  assert.deepEqual(legend.state.getLegendModel(legend.field).zeroGray, { enabled: false, applies: true, drawn: true });
  assert.throws(() => legend.state.setContinuousZeroGray(0, 'yes'), /exactly true or false/);
  // Scaled data (negative values): no floor, the switch does not apply.
  const scaled = renderLegend([-1, 0, 2]);
  scaled.state.varData = { fields: [scaled.field] };
  scaled.state.activeFieldSource = 'var';
  scaled.state.setContinuousZeroGray(0, true);
  assert.equal(scaled.state.colorsArray[1 * 4 + 3], 255);
  assert.equal(scaled.state.getLegendModel(scaled.field).zeroGray.applies, false);
});


// A click as the page delivers it: the legend's palette controls stop it.
async function press(node) {
  node.listeners.click.forEach((listener) => listener({ target: node, stopPropagation() {} }));
  runFrames();
  await settle();
  runFrames();
}
const paletteBar = (legend) => legend.drawn().find((node) => node.className === 'colorbar-gradient');
const paletteOption = (legend, label) => legend.drawn().find((node) => String(node.className ?? '').startsWith('colormap-option') && node.children.some((child) => child.textContent === label));
const liveSwitch = (legend) => legend.drawn().find((node) => node.attributes.role === 'switch' && node.children.some((child) => child.textContent === 'Live filtering'));

test('the palette menu marks the palette the field is drawn in now, and choosing it applies it', async () => {
  const legend = renderLegend([0, 1, 2, 3]);
  await press(paletteBar(legend));
  await press(paletteOption(legend, 'Plasma'));
  assert.equal(legend.field._colormapId, 'plasma');
  // Set elsewhere (an undo, an agent): the menu marks it, and Plasma can be chosen again.
  legend.state.setContinuousColormap(0, 'viridis');
  await press(paletteBar(legend));
  assert.equal(paletteOption(legend, 'Viridis').attributes['aria-pressed'], 'true');
  assert.equal(paletteOption(legend, 'Plasma').attributes['aria-pressed'], 'false');
  await press(paletteOption(legend, 'Plasma'));
  assert.equal(legend.field._colormapId, 'plasma');
});

test('choosing a palette keeps Live filtering off and the bounds moved but not filtered', async () => {
  const legend = renderLegend([0, 1, 2, 3, 4]);
  await legend.fire(liveSwitch(legend), 'click');
  assert.equal(liveSwitch(legend).attributes['aria-checked'], 'false');
  legend.minBox.value = '2';
  await legend.fire(legend.minBox, 'change');
  assert.deepEqual(legend.field._continuousFilter, { min: 0, max: 4 });
  await press(paletteBar(legend));
  await press(paletteOption(legend, 'Magma'));
  assert.equal(legend.field._colormapId, 'magma');
  assert.equal(liveSwitch(legend).attributes['aria-checked'], 'false');
  assert.equal(legend.drawn().find((node) => node === legend.minBox)?.value, '2');
  assert.equal(paletteBar(legend).attributes['aria-label'], 'Color palette: Magma');
});

test('Live filtering, turned off, stays off when the legend is drawn again', async () => {
  const legend = renderLegend([0, 1, 2, 3, 4]);
  await legend.fire(liveSwitch(legend), 'click');
  legend.redraw();
  assert.equal(liveSwitch(legend).attributes['aria-checked'], 'false');
  const filterButton = legend.drawn().find((node) => node.tagName === 'button' && node.textContent === 'Filter');
  assert.equal(filterButton.hidden, false);
  // A bound typed is not applied until Filter.
  const box = legend.drawn().filter((node) => node.tagName === 'input' && node.type === 'text')[0];
  box.value = '3';
  await legend.fire(box, 'change');
  assert.deepEqual(legend.field._continuousFilter, { min: 0, max: 4 });
  await legend.fire(filterButton, 'click');
  assert.deepEqual(legend.field._continuousFilter, { min: 3, max: 4 });
});
