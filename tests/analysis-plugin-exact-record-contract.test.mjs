import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeOptions,
  validateOptionSchema,
  validateOptionsAgainstSchema,
} from '../assets/js/app/analysis/core/analysis-types.js';
import {
  BasePluginRegistry,
} from '../assets/js/app/analysis/core/plugin-contract.js';
import {
  parseOptionsFromForm,
} from '../assets/js/app/analysis/core/transform-registry.js';
import {
  getFormValues,
  getTypedFormValues,
} from '../assets/js/app/analysis/shared/analysis-utils.js';
import {
  PlotRegistry,
} from '../assets/js/app/analysis/shared/plot-registry-utils.js';
import {
  AnalysisUIManager,
} from '../assets/js/app/analysis/ui/analysis-ui-manager.js';
import {
  DetailedAnalysisUI,
} from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import {
  FormBasedAnalysisUI,
} from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import {
  renderPlotOptions,
} from '../assets/js/app/analysis/ui/components/options.js';

const PROTOTYPE_PROPERTY_NAMES =
  Object.getOwnPropertyNames(Object.prototype);

function assertExactOrdinaryRecord(record, expectedKeys) {
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.deepEqual(Object.keys(record), expectedKeys);
  for (const key of expectedKeys) {
    assert.equal(Object.hasOwn(record, key), true, key);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    assert.equal(descriptor.configurable, true, key);
    assert.equal(descriptor.enumerable, true, key);
    assert.equal(descriptor.writable, true, key);
  }
}

class ExactFakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.listeners = new Map();
    this.parentNode = null;
    this.selectedIndex = -1;
    this.textContent = '';
    this.type = '';
    this.value = '';
  }

  appendChild(child) {
    this.children.push(child);
    if (child && typeof child === 'object') child.parentNode = this;
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  querySelector(selector) {
    const match = /^\[data-setting-key="([^"]+)"\]$/.exec(selector);
    if (!match) return null;
    return this._descendants().find(
      element => element.dataset?.settingKey === match[1],
    ) ?? null;
  }

  querySelectorAll(selector) {
    if (!selector.startsWith('.')) return [];
    const className = selector.slice(1);
    return this._descendants().filter(element =>
      String(element.className).split(/\s+/).includes(className)
    );
  }

  _descendants() {
    const result = [];
    const pending = [...this.children];
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current || typeof current !== 'object') continue;
      result.push(current);
      pending.unshift(...(current.children || []));
    }
    return result;
  }

  set innerHTML(value) {
    if (value !== '') {
      throw new TypeError('The exact fake DOM accepts only an empty innerHTML');
    }
    this.children = [];
  }

  get innerHTML() {
    return '';
  }
}

function installExactFakeDocument(t) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return new ExactFakeElement(tagName);
    },
    createTextNode(text) {
      return { textContent: String(text) };
    },
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
}

test('analysis option merging and validation use exact own keys recursively', () => {
  const defaultSymbol = Symbol('default option');
  const mergedDefaultSymbol = mergeOptions(
    { [defaultSymbol]: 'preserved' },
    {},
  );
  assert.equal(mergedDefaultSymbol[defaultSymbol], 'preserved');

  const overrides = Object.fromEntries(
    PROTOTYPE_PROPERTY_NAMES.map((key, index) => [
      key,
      { nested: index },
    ]),
  );
  const merged = mergeOptions({}, overrides);

  assertExactOrdinaryRecord(merged, PROTOTYPE_PROPERTY_NAMES);
  for (const [index, key] of PROTOTYPE_PROPERTY_NAMES.entries()) {
    assert.deepEqual(merged[key], { nested: index }, key);
  }

  const nested = mergeOptions(
    Object.fromEntries([
      ['outer', Object.fromEntries([['__proto__', { left: true }]])],
    ]),
    {
      outer: Object.fromEntries([
        ['__proto__', { right: true }],
      ]),
    },
  );
  assertExactOrdinaryRecord(nested.outer, ['__proto__']);
  assert.deepEqual(nested.outer.__proto__, {
    left: true,
    right: true,
  });

  const schema = Object.fromEntries(
    PROTOTYPE_PROPERTY_NAMES.map(key => [
      key,
      { type: 'text', label: key },
    ]),
  );
  assert.deepEqual(
    validateOptionsAgainstSchema({}, schema, {}),
    { valid: true, errors: [], warnings: [] },
  );
  assert.deepEqual(
    validateOptionsAgainstSchema(
      Object.fromEntries(
        PROTOTYPE_PROPERTY_NAMES.map(key => [key, 'exact']),
      ),
      schema,
      {},
    ),
    { valid: true, errors: [], warnings: [] },
  );
  assert.deepEqual(
    validateOptionsAgainstSchema(overrides, {}, {}).warnings,
    PROTOTYPE_PROPERTY_NAMES.map(key => `Unknown option: ${key}`),
  );
});

test('option schema definitions require own fields and own constraints', () => {
  const inheritedDefinition = Object.create({
    label: 'Inherited label',
    type: 'text',
  });
  assert.deepEqual(
    validateOptionSchema({ inheritedDefinition }),
    [
      'inheritedDefinition: missing type',
      'inheritedDefinition: missing label',
    ],
  );

  const selectDefinition = Object.create({
    options: [{ label: 'Inherited', value: 'inherited' }],
  });
  selectDefinition.type = 'select';
  selectDefinition.label = 'Select';
  assert.deepEqual(
    validateOptionSchema({ selectDefinition }),
    ['selectDefinition: select type requires options array'],
  );

  const numberDefinition = Object.create({ max: 1, min: 10 });
  numberDefinition.type = 'number';
  numberDefinition.label = 'Number';
  assert.deepEqual(
    validateOptionSchema({ numberDefinition }),
    [],
  );

  const requiredDefinition = Object.create({ required: true });
  requiredDefinition.type = 'text';
  requiredDefinition.label = 'Required';
  const constrainedSelect = Object.create({
    options: [{ label: 'Inherited', value: 'inherited' }],
  });
  constrainedSelect.type = 'select';
  constrainedSelect.label = 'Select';
  const constrainedNumber = Object.create({ max: 20, min: 10 });
  constrainedNumber.type = 'number';
  constrainedNumber.label = 'Number';
  const inheritedValidator = Object.create({
    validate: () => 'inherited validator ran',
  });
  inheritedValidator.type = 'text';
  inheritedValidator.label = 'Validator';
  assert.deepEqual(
    validateOptionsAgainstSchema(
      {
        constrainedNumber: 5,
        constrainedSelect: 'not-in-inherited-options',
        inheritedValidator: 'exact',
      },
      {
        constrainedNumber,
        constrainedSelect,
        inheritedValidator,
        requiredDefinition,
      },
      {},
    ),
    {
      valid: false,
      errors: ['constrainedSelect: select type requires options array'],
      warnings: [],
    },
  );
  assert.deepEqual(
    validateOptionsAgainstSchema(
      {
        constrainedNumber: 5,
        inheritedValidator: 'exact',
      },
      {
        constrainedNumber,
        inheritedValidator,
        requiredDefinition,
      },
      {},
    ),
    { valid: true, errors: [], warnings: [] },
  );

  const ownValidator = {
    label: 'Own validator',
    type: 'text',
  };
  ownValidator.validate = function() {
    return this === ownValidator
      ? 'own validator ran'
      : 'own validator receiver changed';
  };
  assert.deepEqual(
    validateOptionsAgainstSchema(
      { ownValidator: 'exact' },
      { ownValidator },
      {},
    ),
    {
      valid: false,
      errors: ['Own validator: own validator ran'],
      warnings: [],
    },
  );
});

test('plugin registries reject inherited contracts and count exact supported types', () => {
  const inheritedPlugin = Object.create({
    id: 'inherited-contract',
    name: 'Inherited contract',
    supportedTypes: ['continuous'],
    render() {},
  });
  const inheritedRegistry = new BasePluginRegistry({
    name: 'Inherited contract probe',
    pluginType: 'plot',
  });
  assert.equal(inheritedRegistry.register(inheritedPlugin), false);
  assert.equal(inheritedRegistry.has('inherited-contract'), false);

  const registry = new BasePluginRegistry({
    name: 'Exact type probe',
    pluginType: 'plugin',
  });
  assert.equal(registry.register({
    id: 'exact-type-probe',
    name: 'Exact type probe',
    supportedTypes: PROTOTYPE_PROPERTY_NAMES,
    defaultOptions: {},
    optionSchema: {},
  }), true);

  const stats = registry.getStats();
  assertExactOrdinaryRecord(stats.byType, PROTOTYPE_PROPERTY_NAMES);
  for (const type of PROTOTYPE_PROPERTY_NAMES) {
    assert.equal(stats.byType[type], 1, type);
  }
});

test('PlotRegistry preserves exact option schemas, values, and type statistics', t => {
  const pluginId = 'exact-record-probe';
  t.after(() => PlotRegistry.unregister(pluginId));
  PlotRegistry.unregister(pluginId);

  const optionSchema = Object.fromEntries(
    PROTOTYPE_PROPERTY_NAMES.map(key => {
      const definition = Object.create({ showWhen: () => false });
      definition.type = 'text';
      definition.label = key;
      return [key, definition];
    }),
  );
  const ownShowWhenDefinition = optionSchema[PROTOTYPE_PROPERTY_NAMES[0]];
  ownShowWhenDefinition.showWhen = function() {
    return this === ownShowWhenDefinition;
  };
  const defaultOptions = Object.fromEntries(
    PROTOTYPE_PROPERTY_NAMES.map((key, index) => [
      key,
      `default-${index}`,
    ]),
  );
  const baselineStats = PlotRegistry.getStats().byType;

  assert.equal(PlotRegistry.register({
    id: pluginId,
    name: 'Exact record probe',
    supportedTypes: PROTOTYPE_PROPERTY_NAMES,
    supportsLegend: false,
    defaultOptions,
    optionSchema,
    render() {},
  }), true);

  const visible = PlotRegistry.getVisibleOptions(pluginId, {});
  assertExactOrdinaryRecord(visible, PROTOTYPE_PROPERTY_NAMES);

  const overrides = Object.fromEntries(
    PROTOTYPE_PROPERTY_NAMES.map((key, index) => [
      key,
      `override-${index}`,
    ]),
  );
  const merged = PlotRegistry.mergeOptions(pluginId, overrides);
  assertExactOrdinaryRecord(merged, PROTOTYPE_PROPERTY_NAMES);
  for (const [index, key] of PROTOTYPE_PROPERTY_NAMES.entries()) {
    assert.equal(merged[key], `override-${index}`, key);
  }

  const stats = PlotRegistry.getStats().byType;
  for (const type of PROTOTYPE_PROPERTY_NAMES) {
    const prior = Object.hasOwn(baselineStats, type)
      ? baselineStats[type]
      : 0;
    assert.equal(Object.hasOwn(stats, type), true, type);
    assert.equal(stats[type], prior + 1, type);
  }
});

test('analysis form value publishers preserve every prototype-named key', () => {
  const valuesByKey = new Map(
    PROTOTYPE_PROPERTY_NAMES.map((key, index) => [
      key,
      `value-${index}`,
    ]),
  );
  const form = {
    querySelector(selector) {
      const key = PROTOTYPE_PROPERTY_NAMES.find(
        candidate => (
          selector === `[data-key="${candidate}"]` ||
          selector === `[name="${candidate}"]`
        ),
      );
      return key === undefined
        ? null
        : { type: 'text', value: valuesByKey.get(key) };
    },
  };
  const schema = Object.fromEntries(
    PROTOTYPE_PROPERTY_NAMES.map(key => [
      key,
      { type: 'text', default: 'missing' },
    ]),
  );

  const transformValues = parseOptionsFromForm(form, schema);
  assertExactOrdinaryRecord(
    transformValues,
    PROTOTYPE_PROPERTY_NAMES,
  );
  const plainValues = getFormValues(form, PROTOTYPE_PROPERTY_NAMES);
  assertExactOrdinaryRecord(plainValues, PROTOTYPE_PROPERTY_NAMES);
  const typedValues = getTypedFormValues(form, schema);
  assertExactOrdinaryRecord(typedValues, PROTOTYPE_PROPERTY_NAMES);
  for (const [index, key] of PROTOTYPE_PROPERTY_NAMES.entries()) {
    const expected = `value-${index}`;
    assert.equal(transformValues[key], expected, key);
    assert.equal(plainValues[key], expected, key);
    assert.equal(typedValues[key], expected, key);
  }
});

test('form-control snapshots preserve a prototype-named DOM control', t => {
  const previousInput = globalThis.HTMLInputElement;
  const previousSelect = globalThis.HTMLSelectElement;
  const previousTextArea = globalThis.HTMLTextAreaElement;

  class FakeInput {
    constructor(name, value) {
      this.name = name;
      this.type = 'text';
      this.value = value;
    }

    getAttribute(name) {
      return name === 'name' ? this.name : null;
    }
  }
  class FakeSelect {}
  class FakeTextArea {}
  globalThis.HTMLInputElement = FakeInput;
  globalThis.HTMLSelectElement = FakeSelect;
  globalThis.HTMLTextAreaElement = FakeTextArea;
  t.after(() => {
    if (previousInput === undefined) delete globalThis.HTMLInputElement;
    else globalThis.HTMLInputElement = previousInput;
    if (previousSelect === undefined) delete globalThis.HTMLSelectElement;
    else globalThis.HTMLSelectElement = previousSelect;
    if (previousTextArea === undefined) delete globalThis.HTMLTextAreaElement;
    else globalThis.HTMLTextAreaElement = previousTextArea;
  });

  const controls = PROTOTYPE_PROPERTY_NAMES.map(
    (name, index) => new FakeInput(name, `control-${index}`),
  );
  const ui = Object.create(FormBasedAnalysisUI.prototype);
  ui._formContainer = {
    querySelector(selector) {
      if (selector !== '.analysis-form') return null;
      return {
        querySelectorAll() {
          return controls;
        },
      };
    },
  };

  const snapshot = ui._snapshotNamedFormControls();
  assertExactOrdinaryRecord(snapshot, PROTOTYPE_PROPERTY_NAMES);
  for (const [index, key] of PROTOTYPE_PROPERTY_NAMES.entries()) {
    assert.deepEqual(snapshot[key], {
      type: 'value',
      value: `control-${index}`,
    });
  }
});

test('analysis plot-option writers preserve an own __proto__ schema key', () => {
  const value = { exact: true };
  const detailed = Object.create(DetailedAnalysisUI.prototype);
  detailed._currentConfig = {
    plotType: 'exact-record-probe',
    plotOptions: {},
  };
  detailed._saveOptionsForPlotType = () => {};
  detailed._scheduleUpdate = () => {};
  detailed._handlePlotOptionChange('__proto__', value);
  assertExactOrdinaryRecord(
    detailed._currentConfig.plotOptions,
    ['__proto__'],
  );
  assert.equal(detailed._currentConfig.plotOptions.__proto__, value);
});

test('plot option rendering reads defaults and definitions only from own fields', t => {
  installExactFakeDocument(t);
  const pluginId = 'exact-default-ownership-probe';
  const definitionPluginId = 'exact-definition-ownership-probe';
  t.after(() => {
    PlotRegistry.unregister(pluginId);
    PlotRegistry.unregister(definitionPluginId);
  });
  PlotRegistry.unregister(pluginId);
  PlotRegistry.unregister(definitionPluginId);

  const optionSchema = Object.fromEntries(
    PROTOTYPE_PROPERTY_NAMES.map(key => [
      key,
      {
        type: 'select',
        label: key,
        options: [{ value: undefined, label: 'Unset' }],
      },
    ]),
  );
  assert.equal(PlotRegistry.register({
    id: pluginId,
    name: 'Exact default ownership probe',
    supportedTypes: ['continuous'],
    supportsLegend: false,
    defaultOptions: {},
    optionSchema,
    render() {},
  }), true);

  const container = new ExactFakeElement('div');
  renderPlotOptions(
    container,
    pluginId,
    {},
    () => {},
    { idPrefix: 'exact-defaults' },
  );

  assert.equal(
    container.children.length,
    PROTOTYPE_PROPERTY_NAMES.length,
  );
  for (const [index, row] of container.children.entries()) {
    const select = row.children[1];
    assert.equal(select.selectedIndex, 0, PROTOTYPE_PROPERTY_NAMES[index]);
    assert.equal(select.children.length, 1, PROTOTYPE_PROPERTY_NAMES[index]);
  }

  const inheritedDefinition = Object.create({
    placeholder: { inherited: true },
  });
  inheritedDefinition.type = 'text';
  inheritedDefinition.label = 'Exact text';
  assert.equal(PlotRegistry.register({
    id: definitionPluginId,
    name: 'Exact definition ownership probe',
    supportedTypes: ['continuous'],
    supportsLegend: false,
    defaultOptions: { exactText: 'own default' },
    optionSchema: { exactText: inheritedDefinition },
    render() {},
  }), true);

  const definitionContainer = new ExactFakeElement('div');
  renderPlotOptions(
    definitionContainer,
    definitionPluginId,
    {},
    () => {},
    { idPrefix: 'exact-definition' },
  );
  const textInput = definitionContainer.children[0].children[1];
  assert.equal(textInput.value, 'own default');
  assert.equal(textInput.placeholder, '');

  for (const currentValue of [null, undefined]) {
    const nullishContainer = new ExactFakeElement('div');
    renderPlotOptions(
      nullishContainer,
      definitionPluginId,
      { exactText: currentValue },
      () => {},
      {
        idPrefix: currentValue === null
          ? 'exact-null-current'
          : 'exact-undefined-current',
      },
    );
    const fallbackInput = nullishContainer.children[0].children[1];
    assert.equal(fallbackInput.value, 'own default');
    assert.equal(fallbackInput.placeholder, '');
  }
});

test('plot option rendering rejects invalid post-registration record mutations', t => {
  installExactFakeDocument(t);
  const pluginId = 'mutated-option-record-probe';
  t.after(() => PlotRegistry.unregister(pluginId));
  PlotRegistry.unregister(pluginId);

  assert.equal(PlotRegistry.register({
    id: pluginId,
    name: 'Mutated option record probe',
    supportedTypes: ['continuous'],
    supportsLegend: false,
    defaultOptions: {},
    optionSchema: {},
    render() {},
  }), true);
  const plotType = PlotRegistry.get(pluginId);

  const renderMutation = (property, value, index) => {
    plotType[property] = value;
    const container = new ExactFakeElement('div');
    try {
      renderPlotOptions(
        container,
        pluginId,
        {},
        () => {},
        { idPrefix: `mutated-${property}-${index}` },
      );
      return null;
    } catch (error) {
      return error;
    }
  };

  const invalidRecords = [null, [], 'not-an-object'];
  const schemaErrors = invalidRecords.map((value, index) =>
    renderMutation('optionSchema', value, index)
  );

  plotType.optionSchema = {
    enabled: { type: 'checkbox', label: 'Enabled' },
  };
  const defaultErrors = invalidRecords.map((value, index) =>
    renderMutation('defaultOptions', value, index)
  );

  assert.deepEqual({
    defaultOptions: defaultErrors.map(error => error?.name ?? null),
    optionSchema: schemaErrors.map(error => error?.name ?? null),
  }, {
    defaultOptions: invalidRecords.map(() => 'TypeError'),
    optionSchema: invalidRecords.map(() => 'TypeError'),
  });
  for (const error of schemaErrors) {
    assert.match(error.message, /optionSchema.*non-null, non-array object/i);
  }
  for (const error of defaultErrors) {
    assert.match(error.message, /defaultOptions.*non-null, non-array object/i);
  }

  plotType.optionSchema = {};
  plotType.defaultOptions = {};
  const emptyContainer = new ExactFakeElement('div');
  renderPlotOptions(
    emptyContainer,
    pluginId,
    {},
    () => {},
    { idPrefix: 'valid-empty-schema' },
  );
  assert.equal(emptyContainer.children.length, 1);
  assert.equal(emptyContainer.children[0].className, 'legend-help');
  assert.equal(
    emptyContainer.children[0].textContent,
    'No customization options available.',
  );
});

test('AnalysisUIManager requires own container membership for exact mode IDs', t => {
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'id',
  );
  t.after(() => {
    if (prototypeDescriptor === undefined) delete Object.prototype.id;
    else {
      Object.defineProperty(
        Object.prototype,
        'id',
        prototypeDescriptor,
      );
    }
  });
  const missingManager = new AnalysisUIManager({
    containerMap: {},
    dataLayer: {},
    comparisonModule: {},
  });
  missingManager.register({
    id: '__proto__',
    name: 'Missing exact container',
    factory() {},
  });
  missingManager.initContainers();
  assert.equal(missingManager.getContainer('__proto__'), null);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(Object.prototype, 'id'),
    prototypeDescriptor,
  );

  const unusableContainer = {
    classList: {},
    id: 'unchanged',
  };
  const unusableManager = new AnalysisUIManager({
    containerMap: Object.fromEntries([
      ['constructor', unusableContainer],
    ]),
    dataLayer: {},
    comparisonModule: {},
  });
  unusableManager.register({
    id: 'constructor',
    name: 'Unusable exact container',
    factory() {},
  });
  assert.throws(
    () => unusableManager.initContainers(),
    {
      name: 'TypeError',
      message: /container.*constructor.*classList/i,
    },
  );
  assert.equal(unusableContainer.id, 'unchanged');

  const classes = [];
  const attributes = new Map();
  const container = {
    classList: {
      add(...names) {
        classes.push(...names);
      },
    },
    setAttribute(name, value) {
      attributes.set(String(name), String(value));
    },
  };
  const manager = new AnalysisUIManager({
    containerMap: Object.fromEntries([['__proto__', container]]),
    dataLayer: {},
    comparisonModule: {},
  });
  manager.register({
    id: '__proto__',
    name: 'Exact container',
    factory() {},
  });
  manager.initContainers();

  assert.equal(manager.getContainer('__proto__'), container);
  assert.equal(container.id, '__proto__-analysis-container');
  assert.deepEqual(classes, [
    '__proto__-analysis-panel',
    'analysis-panel',
  ]);
  // Analysis panels are built lazily, so their controls must stay out of the
  // exact session UI-control inventory.
  assert.equal(attributes.get('data-state-serializer-skip'), 'true');
});
