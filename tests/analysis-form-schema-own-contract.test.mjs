import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateOptionsUI,
  parseOptionsFromForm,
} from '../assets/js/app/analysis/core/transform-registry.js';
import {
  mergeOptions,
  validateOptionSchema,
  validateOptionsAgainstSchema,
} from '../assets/js/app/analysis/core/analysis-types.js';
import {
  BasePluginRegistry,
  PlotPluginRegistry,
  StatPluginRegistry,
  TransformPluginRegistry,
} from '../assets/js/app/analysis/core/plugin-contract.js';
import {
  getTypedFormValues,
} from '../assets/js/app/analysis/shared/analysis-utils.js';
import {
  PlotRegistry,
} from '../assets/js/app/analysis/shared/plot-registry-utils.js';

test('malformed option schemas fail validation without throwing', () => {
  for (const schema of [null, [], 'not-a-schema', 1, () => {}]) {
    assert.deepEqual(
      validateOptionSchema(schema),
      ['Schema must be an object'],
    );
    assert.deepEqual(
      validateOptionsAgainstSchema({}, schema, {}),
      {
        valid: false,
        errors: ['Schema must be an object'],
        warnings: [],
      },
    );
  }

  const malformedDefinitions = {
    arrayDefinition: [],
    nullDefinition: null,
    stringDefinition: 'not-a-definition',
  };
  const definitionErrors = [
    'arrayDefinition: definition must be an object',
    'nullDefinition: definition must be an object',
    'stringDefinition: definition must be an object',
  ];
  assert.deepEqual(
    validateOptionSchema(malformedDefinitions),
    definitionErrors,
  );
  assert.deepEqual(
    validateOptionsAgainstSchema({}, malformedDefinitions, {}),
    {
      valid: false,
      errors: definitionErrors,
      warnings: [],
    },
  );

  const invalidDefinitionFields = {
    badChoice: {
      label: 'Bad choice',
      options: [null],
      type: 'select',
    },
    badChoiceLabel: {
      label: 'Bad choice label',
      options: [{ label: Symbol('label'), value: 'value' }],
      type: 'select',
    },
    badLabel: { label: Symbol('label'), type: 'text' },
    badMax: { label: 'Bad max', max: Infinity, type: 'number' },
    badMin: { label: 'Bad min', min: Symbol('min'), type: 'number' },
    badStep: { label: 'Bad step', step: 0, type: 'range' },
    badType: { label: 'Bad type', type: Symbol('type') },
    missingChoiceValue: {
      label: 'Missing choice value',
      options: [{ label: 'Missing value' }],
      type: 'select',
    },
    multiselectOptions: {
      label: 'Multiselect options',
      options: 'not-an-array',
      type: 'multiselect',
    },
  };
  const invalidFieldErrors = [
    'badChoice: options[0] must be an object',
    'badChoiceLabel: options[0].label must be a non-empty string',
    'badLabel: label must be a non-empty string',
    'badMax: max must be a finite number',
    'badMin: min must be a finite number',
    'badStep: step must be a positive finite number',
    'badType: type must be a non-empty string',
    'missingChoiceValue: options[0] is missing value',
    'multiselectOptions: options must be an array',
  ];
  assert.deepEqual(
    validateOptionSchema(invalidDefinitionFields),
    invalidFieldErrors,
  );
  assert.deepEqual(
    validateOptionsAgainstSchema({}, invalidDefinitionFields, {}),
    {
      valid: false,
      errors: invalidFieldErrors,
      warnings: [],
    },
  );

  for (const options of [null, [], 'not-options', 1, () => {}]) {
    assert.deepEqual(
      validateOptionsAgainstSchema(options, {}, {}),
      {
        valid: false,
        errors: ['Options must be an object'],
        warnings: [],
      },
    );
  }
  for (const defaults of [null, [], 'not-defaults', 1, () => {}]) {
    assert.deepEqual(
      validateOptionsAgainstSchema({}, {}, defaults),
      {
        valid: false,
        errors: ['Defaults must be an object'],
        warnings: [],
      },
    );
  }

  const nullPrototypeRecord = Object.create(null);
  assert.deepEqual(
    validateOptionsAgainstSchema(
      nullPrototypeRecord,
      nullPrototypeRecord,
      nullPrototypeRecord,
    ),
    { valid: true, errors: [], warnings: [] },
  );

  const coercionTrap = {
    toString() {
      throw new Error('option value must never be coerced');
    },
  };
  const selectSchema = {
    exactSelect: {
      label: 'Exact select',
      options: [{ label: 'Valid', value: 'valid' }],
      type: 'select',
    },
  };
  for (const value of [Symbol('invalid-select'), coercionTrap]) {
    assert.deepEqual(
      validateOptionsAgainstSchema(
        { exactSelect: value },
        selectSchema,
        {},
      ),
      {
        valid: false,
        errors: ['Exact select: invalid value'],
        warnings: [],
      },
    );
  }
  const multiselectSchema = {
    exactMultiselect: {
      label: 'Exact multiselect',
      options: [{ label: 'Valid', value: 'valid' }],
      type: 'multiselect',
    },
  };
  for (const value of [Symbol('invalid-multiselect'), coercionTrap]) {
    assert.deepEqual(
      validateOptionsAgainstSchema(
        { exactMultiselect: [value] },
        multiselectSchema,
        {},
      ),
      {
        valid: false,
        errors: ['Exact multiselect: invalid value'],
        warnings: [],
      },
    );
  }
  for (const customResult of [Symbol('validator'), coercionTrap]) {
    const validatorSchema = {
      exactValidator: {
        label: 'Exact validator',
        type: 'text',
        validate: () => customResult,
      },
    };
    assert.deepEqual(
      validateOptionsAgainstSchema(
        { exactValidator: 'value' },
        validatorSchema,
        {},
      ),
      {
        valid: false,
        errors: ['Exact validator: validation failed'],
        warnings: [],
      },
    );
  }
});

test('option merging rejects malformed records with descriptive errors', () => {
  for (const defaults of [null, [], 'not-defaults', 1, () => {}]) {
    assert.throws(
      () => mergeOptions(defaults, {}),
      /Defaults must be an object/,
    );
  }
  for (const overrides of [null, [], 'not-overrides', 1, () => {}]) {
    assert.throws(
      () => mergeOptions({}, overrides),
      /Overrides must be an object/,
    );
  }

  const defaults = Object.create(null);
  defaults.exact = 'default';
  const overrides = Object.create(null);
  overrides.exact = 'override';
  assert.deepEqual(
    mergeOptions(defaults, overrides),
    { exact: 'override' },
  );
});

test('form schema consumers reject malformed definitions descriptively', () => {
  const emptyForm = { querySelector: () => null };
  for (const definition of [null, [], 'not-a-definition']) {
    assert.throws(
      () => generateOptionsUI({ broken: definition }),
      /Option broken definition must be an object/,
    );
    assert.throws(
      () => parseOptionsFromForm(emptyForm, { broken: definition }),
      /Option broken definition must be an object/,
    );
    assert.throws(
      () => getTypedFormValues(emptyForm, { broken: definition }),
      /Field broken configuration must be an object/,
    );
  }
});

test('plugin registration rejects malformed schemas without storing a plugin', t => {
  const registry = new BasePluginRegistry({
    name: 'Malformed schema probe',
    pluginType: 'plugin',
  });
  for (const [suffix, optionSchema] of [
    ['null-schema', null],
    ['array-schema', []],
    ['primitive-schema', 'not-a-schema'],
    ['null-definition', { broken: null }],
  ]) {
    const id = `malformed-${suffix}`;
    assert.doesNotThrow(() => {
      assert.equal(registry.register({
        defaultOptions: {},
        id,
        name: id,
        optionSchema,
        supportedTypes: ['continuous'],
      }), false);
    });
    assert.equal(registry.has(id), false);
  }
  for (const [suffix, defaultOptions] of [
    ['null-defaults', null],
    ['array-defaults', []],
    ['primitive-defaults', 'not-defaults'],
  ]) {
    const id = `malformed-${suffix}`;
    assert.doesNotThrow(() => {
      assert.equal(registry.register({
        defaultOptions,
        id,
        name: id,
        optionSchema: {},
        supportedTypes: ['continuous'],
      }), false);
    });
    assert.equal(registry.has(id), false);
  }
  const validContract = {
    defaultOptions: {},
    id: 'valid-contract',
    name: 'Valid contract',
    optionSchema: {},
    supportedTypes: ['continuous'],
  };
  for (const [label, plugin] of [
    ['array plugin', []],
    ['function plugin', () => {}],
    ['primitive plugin', 'not-a-plugin'],
    ['coercive id', {
      ...validContract,
      id: { toString: () => 'coercive-id' },
    }],
    ['symbol id', {
      ...validContract,
      id: Symbol('symbol-id'),
    }],
    ['throwing id coercion', {
      ...validContract,
      id: {
        toString() {
          throw new Error('id must never be coerced');
        },
      },
    }],
    ['object name', {
      ...validContract,
      id: 'object-name',
      name: {},
    }],
    ['numeric name', {
      ...validContract,
      id: 'numeric-name',
      name: 1,
    }],
    ['blank name', {
      ...validContract,
      id: 'blank-name',
      name: '   ',
    }],
    ['empty supported types', {
      ...validContract,
      id: 'empty-supported-types',
      supportedTypes: [],
    }],
  ]) {
    assert.equal(registry.register(plugin), false, label);
  }
  assert.equal(registry.getAll().length, 0);

  assert.equal(registry.register({
    defaultOptions: undefined,
    id: 'undefined-option-records',
    name: 'Undefined option records',
    optionSchema: undefined,
    supportedTypes: ['continuous'],
  }), true);
  assert.deepEqual(
    registry.get('undefined-option-records').defaultOptions,
    {},
  );
  assert.deepEqual(
    registry.get('undefined-option-records').optionSchema,
    {},
  );

  const nullSchemaId = 'plot-null-schema-probe';
  const arraySchemaId = 'plot-array-schema-probe';
  const primitiveSchemaId = 'plot-primitive-schema-probe';
  const nullDefinitionId = 'plot-null-definition-probe';
  const nullDefaultsId = 'plot-null-defaults-probe';
  const arrayDefaultsId = 'plot-array-defaults-probe';
  const primitiveDefaultsId = 'plot-primitive-defaults-probe';
  const mutationId = 'plot-schema-mutation-probe';
  t.after(() => {
    PlotRegistry.unregister(nullSchemaId);
    PlotRegistry.unregister(arraySchemaId);
    PlotRegistry.unregister(primitiveSchemaId);
    PlotRegistry.unregister(nullDefinitionId);
    PlotRegistry.unregister(nullDefaultsId);
    PlotRegistry.unregister(arrayDefaultsId);
    PlotRegistry.unregister(primitiveDefaultsId);
    PlotRegistry.unregister(mutationId);
  });

  assert.doesNotThrow(() => {
    for (const plotType of [null, [], 'not-a-plot', 1, () => {}]) {
      assert.equal(PlotRegistry.register(plotType), false);
    }
    for (const id of [
      Symbol('symbol-plot-id'),
      {
        toString() {
          throw new Error('plot id must never be coerced');
        },
      },
      'Invalid Plot ID',
    ]) {
      assert.equal(PlotRegistry.register({
        id,
        name: 'Malformed plot id',
        optionSchema: {},
        supportedTypes: ['continuous'],
      }), false);
    }
    for (const [id, optionSchema] of [
      [nullSchemaId, null],
      [arraySchemaId, []],
      [primitiveSchemaId, 'not-a-schema'],
    ]) {
      assert.equal(PlotRegistry.register({
        id,
        name: id,
        optionSchema,
        render() {},
        supportedTypes: ['continuous'],
        supportsLegend: false,
      }), false);
    }
    assert.equal(PlotRegistry.register({
      id: nullDefinitionId,
      name: nullDefinitionId,
      optionSchema: { broken: null },
      render() {},
      supportedTypes: ['continuous'],
      supportsLegend: false,
    }), false);
    for (const [id, defaultOptions] of [
      [nullDefaultsId, null],
      [arrayDefaultsId, []],
      [primitiveDefaultsId, 'not-defaults'],
    ]) {
      assert.equal(PlotRegistry.register({
        defaultOptions,
        id,
        name: id,
        optionSchema: {},
        render() {},
        supportedTypes: ['continuous'],
        supportsLegend: false,
      }), false);
    }
  });
  assert.equal(PlotRegistry.has(nullSchemaId), false);
  assert.equal(PlotRegistry.has(arraySchemaId), false);
  assert.equal(PlotRegistry.has(primitiveSchemaId), false);
  assert.equal(PlotRegistry.has(nullDefinitionId), false);
  assert.equal(PlotRegistry.has(nullDefaultsId), false);
  assert.equal(PlotRegistry.has(arrayDefaultsId), false);
  assert.equal(PlotRegistry.has(primitiveDefaultsId), false);

  assert.equal(PlotRegistry.register({
    id: mutationId,
    name: mutationId,
    optionSchema: {
      visible: { label: 'Visible', type: 'text' },
    },
    render() {},
    supportedTypes: ['continuous'],
    supportsLegend: false,
  }), true);
  const mutablePlot = PlotRegistry.get(mutationId);
  const validSchema = mutablePlot.optionSchema;
  for (const malformedSchema of [null, [], 'not-a-schema']) {
    mutablePlot.optionSchema = malformedSchema;
    assert.throws(
      () => PlotRegistry.getVisibleOptions(mutationId, {}),
      /option schema must be an object/i,
    );
  }
  mutablePlot.optionSchema = validSchema;
  mutablePlot.optionSchema.broken = null;
  assert.throws(
    () => PlotRegistry.getVisibleOptions(mutationId, {}),
    /definition must be an object/i,
  );
});

test('specialized registries ignore inherited optional contract fields', () => {
  const transformRegistry = new TransformPluginRegistry();
  const transform = Object.create({
    gpuMethod: 'inherited-gpu-method',
    workerMethod: 'inherited-worker-method',
  });
  Object.assign(transform, {
    defaultOptions: {},
    execute() {},
    id: 'inherited-transform-optionals',
    name: 'Inherited transform optionals',
    optionSchema: {},
    supportedTypes: ['continuous'],
  });
  assert.equal(transformRegistry.register(transform), true);
  const storedTransform = transformRegistry.get(transform.id);
  assert.equal(storedTransform.gpuMethod, null);
  assert.equal(storedTransform.workerMethod, null);
  transformRegistry._gpuAvailable = true;
  transformRegistry._workerAvailable = true;
  assert.equal(transformRegistry.selectBackend(storedTransform), 'cpu');

  const plotRegistry = new PlotPluginRegistry();
  const plot = Object.create({ supportedLayouts: ['inherited-layout'] });
  Object.assign(plot, {
    defaultOptions: {},
    id: 'inherited-plot-optionals',
    name: 'Inherited plot optionals',
    optionSchema: {},
    render() {},
    supportedTypes: ['continuous'],
  });
  assert.equal(plotRegistry.register(plot), true);
  assert.deepEqual(
    plotRegistry.get(plot.id).supportedLayouts,
    ['single'],
  );

  const statRegistry = new StatPluginRegistry();
  const stat = Object.create({
    assumptions: ['inherited-assumption'],
    testType: 'inherited-test-type',
  });
  Object.assign(stat, {
    compute() {},
    defaultOptions: {},
    id: 'inherited-stat-optionals',
    name: 'Inherited stat optionals',
    optionSchema: {},
    supportedTypes: ['continuous'],
  });
  assert.equal(statRegistry.register(stat), true);
  const storedStat = statRegistry.get(stat.id);
  assert.equal(storedStat.testType, 'generic');
  assert.deepEqual(storedStat.assumptions, []);
});

test('generated option UI ignores inherited definition fields and keeps own fields', () => {
  const inheritedDefinition = Object.create({
    default: 'inherited-default',
    description: 'Inherited description',
    label: 'Inherited label',
    max: 99,
    min: 1,
    options: [{ label: 'Inherited option', value: 'inherited-option' }],
    showWhen: () => false,
    step: 2,
    type: 'select',
  });
  const inheritedValues = Object.create({
    inheritedOnly: 'inherited-current-value',
  });
  const inheritedHTML = generateOptionsUI(
    { inheritedOnly: inheritedDefinition },
    inheritedValues,
    'probe',
  );

  assert.match(
    inheritedHTML,
    /<label for="probe-inheritedOnly">inheritedOnly<\/label>/,
  );
  assert.doesNotMatch(inheritedHTML, /data-show-when=/);
  assert.doesNotMatch(inheritedHTML, /<select|<input/);
  assert.doesNotMatch(
    inheritedHTML,
    /Inherited|inherited-default|inherited-current-value/,
  );

  const ownDefinition = {
    default: 'own-option',
    description: 'Own description',
    label: 'Own label',
    options: [
      { label: 'Own option', value: 'own-option' },
      { label: 'Other option', value: 'other-option' },
    ],
    showWhen() {
      return false;
    },
    type: 'select',
  };
  const ownHTML = generateOptionsUI(
    { ownDefinition },
    {},
    'probe',
  );

  assert.match(ownHTML, /data-show-when="ownDefinition"/);
  assert.match(ownHTML, /<label for="probe-ownDefinition">Own label<\/label>/);
  assert.match(
    ownHTML,
    /<option value="own-option" selected>Own option<\/option>/,
  );
  assert.match(ownHTML, /<small class="form-help">Own description<\/small>/);
});

test('form option parsing ignores inherited definition types', () => {
  const elements = new Map([
    ['inheritedCheckbox', {
      checked: true,
      type: 'checkbox',
      value: 'literal-checkbox-value',
    }],
    ['ownCheckbox', {
      checked: true,
      type: 'checkbox',
      value: 'ignored-checkbox-value',
    }],
    ['inheritedNumber', {
      type: 'number',
      value: '4.5',
    }],
    ['ownNumber', {
      type: 'number',
      value: '4.5',
    }],
  ]);
  const form = {
    querySelector(selector) {
      const match = /^\[data-key="([^"]+)"\]$/.exec(selector);
      return match ? elements.get(match[1]) ?? null : null;
    },
  };
  const inheritedCheckbox = Object.create({ type: 'checkbox' });
  const inheritedNumber = Object.create({ type: 'number' });

  const values = parseOptionsFromForm(form, {
    inheritedCheckbox,
    inheritedNumber,
    ownCheckbox: { type: 'checkbox' },
    ownNumber: { type: 'number' },
  });

  assert.deepEqual(values, {
    inheritedCheckbox: 'literal-checkbox-value',
    inheritedNumber: '4.5',
    ownCheckbox: true,
    ownNumber: 4.5,
  });
});

test('typed form parsing ignores inherited config type and default values', () => {
  const elements = new Map([
    ['inheritedWithElement', {
      type: 'number',
      value: '42.8',
    }],
    ['ownBoolean', {
      checked: true,
      type: 'checkbox',
      value: 'false',
    }],
    ['ownInteger', {
      type: 'number',
      value: 'not-an-integer',
    }],
  ]);
  const form = {
    querySelector(selector) {
      const match = /^\[name="([^"]+)"\]$/.exec(selector);
      return match ? elements.get(match[1]) ?? null : null;
    },
  };
  const inheritedWithElement = Object.create({
    default: 99,
    type: 'int',
  });
  const inheritedWithoutElement = Object.create({
    default: 'inherited-default',
    type: 'string',
  });

  const values = getTypedFormValues(form, {
    inheritedWithElement,
    inheritedWithoutElement,
    ownBoolean: { default: false, type: 'boolean' },
    ownDefault: { default: 'own-default', type: 'string' },
    ownInteger: { default: 12, type: 'int' },
  });

  assert.deepEqual(values, {
    inheritedWithElement: '42.8',
    inheritedWithoutElement: undefined,
    ownBoolean: true,
    ownDefault: 'own-default',
    ownInteger: 12,
  });
  assert.equal(Object.hasOwn(values, 'inheritedWithoutElement'), true);
});
