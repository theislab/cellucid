import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  FieldLoadingMethods,
} from '../assets/js/app/state/managers/field/loading.js';
import {
  FieldOverlayPublicMethods,
} from '../assets/js/app/state/managers/field/overlay-public.js';
import {
  isSessionRestoreCanceledError,
  isSessionRestoreSupersededError,
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';
import {
  createObsFieldLoader,
  createVarFieldLoader,
} from '../assets/js/data/data-loaders.js';
import {
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import {
  InlineEditor,
} from '../assets/js/app/ui/components/inline-editor.js';
import {
  showConfirmDialog,
} from '../assets/js/app/ui/components/confirm-dialog.js';

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function createFieldLoadingState({
  obsFields = [],
  obsDescriptors = obsFields,
  varFields = [],
  varDescriptors = varFields,
  pointCount = 2,
} = {}) {
  return Object.assign(
    Object.create(FieldLoadingMethods.prototype),
    {
      _datasetGeneration: 1,
      _fieldDataCache: new Map(),
      _obsFieldDescriptors: Object.freeze([...obsDescriptors]),
      _varFieldDataCache: new Map(),
      _varFieldDescriptors: Object.freeze([...varDescriptors]),
      fieldLoader: null,
      obsData: { fields: obsFields },
      pointCount,
      varData: { fields: varFields },
      varFieldLoader: null,
    },
  );
}

function replaceObsGeneration(state, field, descriptor, loader) {
  state._datasetGeneration += 1;
  state.obsData = { fields: [field] };
  state._obsFieldDescriptors = Object.freeze([descriptor]);
  state.fieldLoader = loader;
  state._fieldDataCache.clear();
}

function replaceVarGeneration(state, field, descriptor, loader) {
  state._datasetGeneration += 1;
  state.varData = { fields: [field] };
  state._varFieldDescriptors = Object.freeze([descriptor]);
  state.varFieldLoader = loader;
  state._varFieldDataCache.clear();
}

test('inline field editors expose exact synchronous cancellation ownership', t => {
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  const listeners = new Map();
  let removed = false;
  const input = {
    classList: { add() {} },
    style: {},
    value: '',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    focus() {},
    remove() {
      removed = true;
    },
    select() {},
  };
  globalThis.document = {
    createElement() {
      return input;
    },
  };
  globalThis.requestAnimationFrame = callback => {
    callback();
    return 1;
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame;
    }
  });
  let saves = 0;
  let cancels = 0;
  const target = {
    getBoundingClientRect: () => ({ width: 100 }),
    parentNode: {
      insertBefore() {},
    },
    style: {
      display: '',
    },
  };
  const editor = InlineEditor.create(target, 'before', {
    onSave() {
      saves++;
    },
    onCancel() {
      cancels++;
    },
  });

  assert.strictEqual(editor, input);
  assert.equal(InlineEditor.cancel(editor), true);
  assert.equal(InlineEditor.cancel(editor), false);
  listeners.get('keydown')({
    key: 'Enter',
    preventDefault() {},
  });
  assert.deepEqual({ cancels, saves, removed }, {
    cancels: 1,
    saves: 0,
    removed: true,
  });
  assert.equal(target.style.display, '');
});

test('inline field editors replace one exact target owner and clean up callback failures', t => {
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  const inputs = [];
  globalThis.document = {
    createElement() {
      const listeners = new Map();
      const input = {
        classList: { add() {} },
        listeners,
        removed: false,
        style: {},
        value: '',
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
        focus() {},
        remove() {
          input.removed = true;
        },
        select() {},
      };
      inputs.push(input);
      return input;
    },
  };
  globalThis.requestAnimationFrame = callback => {
    callback();
    return 1;
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame;
    }
  });

  const target = {
    getBoundingClientRect: () => ({ width: 100 }),
    parentNode: {
      insertBefore() {},
    },
    style: {
      display: '',
    },
  };
  let firstCancellations = 0;
  const first = InlineEditor.create(target, 'first', {
    onSave() {},
    onCancel() {
      firstCancellations++;
    },
  });
  const callbackFailure = new Error('exact inline save failure');
  const second = InlineEditor.create(target, 'second', {
    onSave() {
      throw callbackFailure;
    },
  });

  assert.equal(firstCancellations, 1);
  assert.equal(first.removed, true);
  assert.equal(target.style.display, 'none');
  second.value = 'changed';
  assert.throws(
    () => second.listeners.get('keydown')({
      key: 'Enter',
      preventDefault() {},
    }),
    error => error === callbackFailure,
  );
  assert.equal(second.removed, true);
  assert.equal(InlineEditor.cancel(second), false);
  assert.equal(target.style.display, '');
});

test('replacing a confirm dialog synchronously cancels its prior owner', t => {
  const previousDocument = globalThis.document;
  let activeOverlay = null;

  function createBackground(attributes = {}) {
    const values = new Map(Object.entries(attributes));
    return {
      getAttribute(name) {
        return values.get(name) ?? null;
      },
      hasAttribute(name) {
        return values.has(name);
      },
      removeAttribute(name) {
        values.delete(name);
      },
      setAttribute(name, value) {
        values.set(name, String(value));
      },
    };
  }

  function createControl() {
    return {
      addEventListener() {},
      focus() {},
    };
  }

  function createOverlay() {
    const attributes = new Map();
    const cancelButton = createControl();
    const confirmButton = createControl();
    const root = {
      contains() {
        return false;
      },
      querySelectorAll() {
        return [];
      },
    };
    const overlay = {
      addEventListener() {},
      className: '',
      innerHTML: '',
      querySelector(selector) {
        if (selector === '.confirm-dialog') return root;
        if (selector === '.confirm-dialog-cancel') return cancelButton;
        if (selector === '.confirm-dialog-confirm') return confirmButton;
        return null;
      },
      remove() {
        if (activeOverlay === overlay) activeOverlay = null;
      },
      removeEventListener() {},
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      hasAttribute(name) {
        return attributes.has(name);
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
    };
    return overlay;
  }

  const ordinaryBackground = createBackground({
    'aria-hidden': 'false',
  });
  const preOwnedBackground = createBackground({
    'aria-hidden': 'owned-hidden',
    inert: 'owned-inert',
  });
  globalThis.document = {
    activeElement: {
      focus() {},
    },
    addEventListener() {},
    body: {
      children: [ordinaryBackground, preOwnedBackground],
      appendChild(overlay) {
        activeOverlay = overlay;
      },
    },
    createElement() {
      return createOverlay();
    },
    querySelector(selector) {
      return selector === '.confirm-dialog-overlay'
        ? activeOverlay
        : null;
    },
    removeEventListener() {},
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  let firstCancellations = 0;
  showConfirmDialog({
    title: 'First owner',
    message: 'First dialog',
    onConfirm() {},
    onCancel() {
      firstCancellations++;
    },
  });
  assert.equal(ordinaryBackground.getAttribute('aria-hidden'), 'true');
  assert.equal(ordinaryBackground.getAttribute('inert'), '');
  assert.equal(preOwnedBackground.getAttribute('aria-hidden'), 'true');
  assert.equal(preOwnedBackground.getAttribute('inert'), '');
  const closeSecond = showConfirmDialog({
    title: 'Replacement owner',
    message: 'Second dialog',
    onConfirm() {},
    onCancel() {},
  });

  assert.equal(firstCancellations, 1);
  assert.equal(ordinaryBackground.getAttribute('aria-hidden'), 'true');
  assert.equal(ordinaryBackground.getAttribute('inert'), '');
  closeSecond();
  assert.equal(ordinaryBackground.getAttribute('aria-hidden'), 'false');
  assert.equal(ordinaryBackground.hasAttribute('inert'), false);
  assert.equal(
    preOwnedBackground.getAttribute('aria-hidden'),
    'owned-hidden',
  );
  assert.equal(preOwnedBackground.getAttribute('inert'), 'owned-inert');
});

test(
  'field-loader factories preserve their configured abort owner without a runtime override',
  async t => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(new Float32Array([1, 2]));
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const controller = new AbortController();
    controller.abort(new Error('configured field-loader owner retired'));
    const options = { fetchInit: { signal: controller.signal } };
    const obsLoader = createObsFieldLoader(
      'https://example.test/obs/manifest.json',
      options,
    );
    const varLoader = createVarFieldLoader(
      'https://example.test/var/manifest.json',
      options,
    );
    const obsField = {
      centroids: null,
      key: 'score',
      kind: 'continuous',
      outlierQuantilesPath: null,
      quantized: false,
      valuesDtype: 'float32',
      valuesPath: 'score.values.f32',
    };
    const varField = {
      key: 'GAPDH',
      kind: 'continuous',
      quantized: false,
      valuesDtype: 'float32',
      valuesPath: 'GAPDH.values.f32',
    };

    await assert.rejects(obsLoader(obsField), /cancel|abort/i);
    await assert.rejects(varLoader(varField), /cancel|abort/i);
    assert.equal(fetchCalls, 0);

    const manager = getDataSourceManager();
    const previousSource = manager.activeSource;
    const previousDatasetId = manager.activeDatasetId;
    let directCalls = 0;
    const adapter = {
      async getObsFieldData() {
        directCalls++;
        return {
          data: Float32Array.from([1, 2]).buffer,
          kind: 'continuous',
        };
      },
      async getGeneExpression() {
        directCalls++;
        return Float32Array.from([1, 2]);
      },
    };
    manager.activeDatasetId = 'configured-owner';
    manager.activeSource = {
      datasetId: 'configured-owner',
      getAdapter: () => adapter,
      getType: () => 'zarr',
    };
    t.after(() => {
      manager.activeSource = previousSource;
      manager.activeDatasetId = previousDatasetId;
    });

    const directObsLoader = createObsFieldLoader(
      'zarr://configured-owner/obs/manifest.json',
      options,
    );
    const directVarLoader = createVarFieldLoader(
      'zarr://configured-owner/var/manifest.json',
      options,
    );
    await assert.rejects(directObsLoader(obsField), /cancel|abort/i);
    await assert.rejects(directVarLoader(varField), /cancel|abort/i);
    assert.equal(directCalls, 0);
  },
);

test(
  'field-loader factories preserve a configured top-level abort owner',
  async t => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(new Float32Array([1, 2]));
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const controller = new AbortController();
    const exactAbort = new Error('top-level field-loader owner retired');
    controller.abort(exactAbort);
    const options = { signal: controller.signal };
    const obsLoader = createObsFieldLoader(
      'https://example.test/obs/manifest.json',
      options,
    );
    const varLoader = createVarFieldLoader(
      'https://example.test/var/manifest.json',
      options,
    );
    const obsField = {
      centroids: null,
      key: 'score',
      kind: 'continuous',
      outlierQuantilesPath: null,
      quantized: false,
      valuesDtype: 'float32',
      valuesPath: 'score.values.f32',
    };
    const varField = {
      key: 'GAPDH',
      kind: 'continuous',
      quantized: false,
      valuesDtype: 'float32',
      valuesPath: 'GAPDH.values.f32',
    };

    await assert.rejects(
      obsLoader(obsField),
      error => error?.name === 'AbortError',
    );
    await assert.rejects(
      varLoader(varField),
      error => error?.name === 'AbortError',
    );
    assert.equal(fetchCalls, 0);
  },
);

test(
  'an old observation load cannot publish into a same-key same-length replacement dataset',
  async () => {
    const oldField = { key: 'cell_type', kind: 'category', loaded: false };
    const oldDescriptor = { key: 'cell_type', kind: 'category' };
    const oldLoad = deferred();
    const state = createFieldLoadingState({
      obsFields: [oldField],
      obsDescriptors: [oldDescriptor],
    });
    state.fieldLoader = descriptor => {
      assert.strictEqual(descriptor, oldDescriptor);
      return oldLoad.promise;
    };

    const loadTask = state.ensureFieldLoaded(0, { silent: true });
    const nextField = { key: 'cell_type', kind: 'category', loaded: false };
    const nextDescriptor = { key: 'cell_type', kind: 'category' };
    replaceObsGeneration(
      state,
      nextField,
      nextDescriptor,
      async () => ({ codes: Uint16Array.from([1, 1]) }),
    );

    oldLoad.resolve({ codes: Uint16Array.from([0, 0]) });
    await assert.rejects(loadTask, /dataset|superseded|generation/i);

    assert.equal(oldField.loaded, false);
    assert.equal(Object.hasOwn(oldField, 'codes'), false);
    assert.equal(nextField.loaded, false);
    assert.equal(state._fieldDataCache.has('cell_type'), false);
  },
);

test(
  'an old gene load cannot publish into a same-key same-length replacement dataset',
  async () => {
    const oldField = { key: 'GAPDH', kind: 'continuous', loaded: false };
    const oldDescriptor = { key: 'GAPDH', kind: 'continuous' };
    const oldLoad = deferred();
    const state = createFieldLoadingState({
      varFields: [oldField],
      varDescriptors: [oldDescriptor],
    });
    state.varFieldLoader = descriptor => {
      assert.strictEqual(descriptor, oldDescriptor);
      return oldLoad.promise;
    };

    const loadTask = state.ensureVarFieldLoaded(0, { silent: true });
    const nextField = { key: 'GAPDH', kind: 'continuous', loaded: false };
    const nextDescriptor = { key: 'GAPDH', kind: 'continuous' };
    replaceVarGeneration(
      state,
      nextField,
      nextDescriptor,
      async () => ({ values: Float32Array.from([7, 8]) }),
    );

    oldLoad.resolve({ values: Float32Array.from([1, 2]) });
    await assert.rejects(loadTask, /dataset|superseded|generation/i);

    assert.equal(oldField.loaded, false);
    assert.equal(Object.hasOwn(oldField, 'values'), false);
    assert.equal(nextField.loaded, false);
    assert.equal(state._varFieldDataCache.has('GAPDH'), false);
  },
);

test(
  'field loading aborts cooperatively and never publishes the abandoned payload',
  async () => {
    const field = { key: 'score', kind: 'continuous', loaded: false };
    const descriptor = { key: 'score', kind: 'continuous' };
    const load = deferred();
    const state = createFieldLoadingState({
      obsFields: [field],
      obsDescriptors: [descriptor],
    });
    let receivedSignal = null;
    state.fieldLoader = (_descriptor, options) => {
      receivedSignal = options?.signal ?? null;
      return load.promise;
    };
    const controller = new AbortController();
    const exactAbort = new Error('exact field interaction supersession');

    const loadTask = state.ensureFieldLoaded(0, {
      signal: controller.signal,
      silent: true,
    });
    await Promise.resolve();
    controller.abort(exactAbort);
    load.resolve({ values: Float32Array.from([3, 4]) });

    await assert.rejects(loadTask, error => error === exactAbort);
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.notStrictEqual(receivedSignal, controller.signal);
    assert.equal(receivedSignal.aborted, true);
    assert.strictEqual(receivedSignal.reason, exactAbort);
    assert.equal(field.loaded, false);
    assert.equal(Object.hasOwn(field, 'values'), false);
    assert.equal(state._fieldDataCache.has('score'), false);
  },
);

test(
  'a new same-field owner restarts an already-aborted deduplicated load',
  async () => {
    const field = { key: 'score', kind: 'continuous', loaded: false };
    const descriptor = { key: 'score', kind: 'continuous' };
    const loads = [deferred(), deferred()];
    const state = createFieldLoadingState({
      obsFields: [field],
      obsDescriptors: [descriptor],
    });
    let loadCalls = 0;
    state.fieldLoader = () => loads[loadCalls++].promise;
    const firstController = new AbortController();
    const secondController = new AbortController();
    const exactAbort = new Error('exact first same-field abort');

    const first = state.ensureFieldLoaded(0, {
      signal: firstController.signal,
      silent: true,
    });
    await Promise.resolve();
    firstController.abort(exactAbort);
    const second = state.ensureFieldLoaded(0, {
      signal: secondController.signal,
      silent: true,
    });

    loads[0].resolve({ values: Float32Array.from([1, 2]) });
    loads[1].resolve({ values: Float32Array.from([7, 8]) });
    await assert.rejects(first, error => error === exactAbort);
    const loaded = await second;

    assert.equal(loadCalls, 2);
    assert.deepEqual([...loaded.values], [7, 8]);
    assert.deepEqual(
      [...state._fieldDataCache.get('score').values],
      [7, 8],
    );
  },
);

test(
  'one canceled field waiter cannot abort an independent deduplicated waiter',
  async () => {
    const field = { key: 'score', kind: 'continuous', loaded: false };
    const descriptor = { key: 'score', kind: 'continuous' };
    const load = deferred();
    const state = createFieldLoadingState({
      obsFields: [field],
      obsDescriptors: [descriptor],
    });
    let loadCalls = 0;
    let sharedSignal = null;
    state.fieldLoader = (_descriptor, options) => {
      loadCalls++;
      sharedSignal = options.signal;
      return load.promise;
    };
    const uiController = new AbortController();
    const exactAbort = new Error('retired UI field waiter');
    const uiWaiter = state.ensureFieldLoaded(0, {
      signal: uiController.signal,
      silent: true,
    });
    const analysisWaiter = state.ensureFieldLoaded(0, { silent: true });
    await Promise.resolve();

    uiController.abort(exactAbort);
    const sharedWasAborted = sharedSignal.aborted;
    load.resolve({ values: Float32Array.from([7, 8]) });

    const [uiOutcome, analysisOutcome] = await Promise.allSettled([
      uiWaiter,
      analysisWaiter,
    ]);
    assert.equal(sharedWasAborted, false);
    assert.equal(uiOutcome.status, 'rejected');
    assert.strictEqual(uiOutcome.reason, exactAbort);
    assert.equal(analysisOutcome.status, 'fulfilled');
    const loaded = analysisOutcome.value;
    assert.equal(loadCalls, 1);
    assert.strictEqual(loaded, field);
    assert.deepEqual([...field.values], [7, 8]);
    assert.deepEqual(
      [...state._fieldDataCache.get('score').values],
      [7, 8],
    );
  },
);

test(
  'abort between loader settlement and publication still retires the payload',
  async () => {
    const field = { key: 'score', kind: 'continuous', loaded: false };
    const descriptor = { key: 'score', kind: 'continuous' };
    const load = deferred();
    const state = createFieldLoadingState({
      obsFields: [field],
      obsDescriptors: [descriptor],
    });
    state.fieldLoader = () => load.promise;
    const controller = new AbortController();
    const exactAbort = new Error('exact post-load pre-publication abort');
    const loading = state.ensureFieldLoaded(0, {
      signal: controller.signal,
      silent: true,
    });

    load.resolve({ values: Float32Array.from([4, 5]) });
    queueMicrotask(() => controller.abort(exactAbort));

    await assert.rejects(loading, error => error === exactAbort);
    assert.equal(field.loaded, false);
    assert.equal(Object.hasOwn(field, 'values'), false);
    assert.equal(state._fieldDataCache.has('score'), false);
  },
);

test(
  'a malformed loaded field is rejected without partially mutating scientific state',
  async () => {
    const field = { key: 'score', kind: 'continuous', loaded: false };
    const descriptor = { key: 'score', kind: 'continuous' };
    const state = createFieldLoadingState({
      obsFields: [field],
      obsDescriptors: [descriptor],
    });
    state.fieldLoader = async () => ({
      values: Float32Array.from([1]),
    });

    await assert.rejects(
      state.ensureFieldLoaded(0, { silent: true }),
      /length mismatch/i,
    );

    assert.equal(field.loaded, false);
    assert.equal(Object.hasOwn(field, 'values'), false);
    assert.equal(state._fieldDataCache.has('score'), false);
  },
);

test(
  'field duplication cannot adopt a source captured from a replaced dataset',
  async () => {
    const sourceField = {
      key: 'score',
      kind: 'continuous',
      loaded: true,
      values: Float32Array.from([1, 2]),
    };
    const load = deferred();
    let registryMutations = 0;
    const state = Object.assign(
      Object.create(FieldOverlayPublicMethods.prototype),
      {
        _datasetGeneration: 1,
        obsData: { fields: [sourceField] },
        pointCount: 2,
        varData: { fields: [] },
        getDatasetGeneration() {
          return this._datasetGeneration;
        },
        ensureFieldLoaded: () => load.promise,
        _userDefinedFields: {
          computeCentroidsByDim() {},
          createContinuousAlias() {
            registryMutations++;
            throw new Error('replacement registry was mutated');
          },
          createFromCategoricalCodes() {},
          getField() {},
          updateField() {},
        },
      },
    );

    const duplication = state.duplicateField('obs', 0);
    state._datasetGeneration += 1;
    state.obsData = {
      fields: [{
        key: 'score',
        kind: 'continuous',
        loaded: true,
        values: Float32Array.from([7, 8]),
      }],
    };
    load.resolve(sourceField);

    await assert.rejects(
      duplication,
      /dataset|superseded|generation/i,
    );
    assert.equal(registryMutations, 0);
    assert.equal(state.obsData.fields.length, 1);
  },
);

test(
  'an older loader cannot clear a newer exact loading-promise owner',
  async () => {
    const field = { key: 'score', kind: 'continuous', loaded: false };
    const descriptor = { key: 'score', kind: 'continuous' };
    const load = deferred();
    const state = createFieldLoadingState({
      obsFields: [field],
      obsDescriptors: [descriptor],
    });
    state.fieldLoader = () => load.promise;
    const exactFailure = new Error('exact retired loader failure');

    const loadTask = state.ensureFieldLoaded(0, { silent: true });
    const replacementOwner = Promise.resolve(field);
    field._loadingPromise = replacementOwner;
    load.reject(exactFailure);

    await assert.rejects(loadTask, error => error === exactFailure);
    assert.strictEqual(field._loadingPromise, replacementOwner);
  },
);

test('unloading a gene aborts its shared backend generation immediately', async () => {
  const field = { key: 'GAPDH', kind: 'continuous', loaded: false };
  const descriptor = { key: 'GAPDH', kind: 'continuous' };
  const load = deferred();
  const state = createFieldLoadingState({
    varFields: [field],
    varDescriptors: [descriptor],
  });
  state.activeFieldSource = null;
  state.activeFieldIndex = -1;
  state.activeVarFieldIndex = -1;
  state.viewContexts = new Map();
  let backendSignal = null;
  state.varFieldLoader = (_field, options) => {
    backendSignal = options.signal;
    return load.promise;
  };

  const loading = state.ensureVarFieldLoaded(0, { silent: true });
  await Promise.resolve();
  assert.equal(state.unloadVarField(0), true);
  const abortedSynchronously = backendSignal.aborted;
  load.resolve({ values: Float32Array.from([1, 2]) });

  await assert.rejects(loading, /abort|superseded|consumer/i);
  assert.equal(abortedSynchronously, true);
  assert.equal(field.loaded, false);
  assert.equal(field.values, null);
});

test(
  'the shared interaction owner is latest-wins, abortable, drainable, and exact',
  async () => {
    const {
      createFieldInteractionOwner,
      isFieldInteractionSupersededError,
    } = await import(
      '../assets/js/app/ui/modules/field-interaction-owner.js'
    );
    const owner = createFieldInteractionOwner();
    const firstGate = deferred();
    const published = [];
    let firstSignal = null;

    const first = owner.run(async token => {
      firstSignal = token.signal;
      await firstGate.promise;
      owner.assertCurrent(token);
      published.push('first');
    });
    const secondGate = deferred();
    const second = owner.run(async token => {
      await secondGate.promise;
      owner.assertCurrent(token);
      published.push('second');
    });

    assert.equal(firstSignal.aborted, true);
    firstGate.resolve();
    await assert.rejects(first, isFieldInteractionSupersededError);

    let settled = false;
    const settlement = owner.settleCurrent().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);

    secondGate.resolve();
    await second;
    await settlement;
    assert.deepEqual(published, ['second']);

    const releaseSuspension = owner.acquireSuspension();
    assert.equal(owner.isSuspended(), true);
    assert.throws(
      () => owner.run(async () => {}),
      isFieldInteractionSupersededError,
    );
    releaseSuspension();
    assert.equal(owner.isSuspended(), false);

    const exactFailure = new Error('exact interaction destruction failure');
    const rejected = owner.run(async () => {
      throw exactFailure;
    });
    rejected.catch(() => {});
    const destruction = owner.destroy();
    assert.strictEqual(owner.destroy(), destruction);
    await assert.rejects(
      destruction,
      error => (
        error === exactFailure
        || (
          error instanceof AggregateError
          && error.errors.includes(exactFailure)
        )
      ),
    );
  },
);

test(
  'session suspension drains the current token and intent without invalidating either',
  async () => {
    const {
      createFieldInteractionOwner,
      isFieldInteractionSupersededError,
    } = await import(
      '../assets/js/app/ui/modules/field-interaction-owner.js'
    );
    const tokenOwner = createFieldInteractionOwner();
    const intentOwner = createFieldInteractionOwner();
    const tokenGate = deferred();
    const intentGate = deferred();
    let tokenSignal = null;
    let tokenPublished = false;
    let intentPublished = false;

    const tokenTask = tokenOwner.run(async token => {
      tokenSignal = token.signal;
      await tokenGate.promise;
      tokenOwner.assertCurrent(token);
      tokenPublished = true;
    });
    const intent = intentOwner.beginIntent();
    const intentTask = (async () => {
      await intentGate.promise;
      intentOwner.assertIntentCurrent(intent);
      intentPublished = true;
    })();
    intentOwner.track(intentTask);

    const releaseTokenSuspension = tokenOwner.acquireSuspension();
    const releaseIntentSuspension = intentOwner.acquireSuspension();
    assert.equal(tokenOwner.isSuspended(), true);
    assert.equal(intentOwner.isSuspended(), true);
    assert.equal(tokenSignal.aborted, false);
    assert.equal(intentOwner.isIntentCurrent(intent), true);
    assert.throws(
      () => tokenOwner.run(async () => {}),
      isFieldInteractionSupersededError,
    );
    assert.throws(
      () => intentOwner.beginIntent(),
      isFieldInteractionSupersededError,
    );

    let tokenDrained = false;
    let intentDrained = false;
    const tokenSettlement = tokenOwner.settleAll().then(() => {
      tokenDrained = true;
    });
    const intentSettlement = intentOwner.settleAll().then(() => {
      intentDrained = true;
    });
    await Promise.resolve();
    assert.equal(tokenDrained, false);
    assert.equal(intentDrained, false);

    tokenGate.resolve();
    intentGate.resolve();
    await Promise.all([
      tokenTask,
      intentTask,
      tokenSettlement,
      intentSettlement,
    ]);
    assert.equal(tokenPublished, true);
    assert.equal(intentPublished, true);

    releaseTokenSuspension();
    releaseIntentSuspension();
    assert.equal(tokenOwner.isSuspended(), false);
    assert.equal(intentOwner.isSuspended(), false);
    await Promise.all([tokenOwner.destroy(), intentOwner.destroy()]);
  },
);

test(
  'restore suspension retires the current token and intent before draining',
  async () => {
    const {
      createFieldInteractionOwner,
      isFieldInteractionSupersededError,
    } = await import(
      '../assets/js/app/ui/modules/field-interaction-owner.js'
    );
    const tokenOwner = createFieldInteractionOwner();
    const tokenGate = deferred();
    let tokenSignal = null;
    const tokenTask = tokenOwner.run(async token => {
      tokenSignal = token.signal;
      await tokenGate.promise;
      tokenOwner.assertCurrent(token);
    });
    const tokenRejection = assert.rejects(
      tokenTask,
      isFieldInteractionSupersededError,
    );

    const releaseTokenSuspension =
      tokenOwner.acquireRetiringSuspension();
    assert.equal(tokenOwner.isSuspended(), true);
    assert.equal(tokenSignal.aborted, true);
    tokenGate.resolve();
    await Promise.all([tokenRejection, tokenOwner.settleAll()]);
    releaseTokenSuspension();

    const intentOwner = createFieldInteractionOwner();
    const intent = intentOwner.beginIntent();
    const releaseIntentSuspension =
      intentOwner.acquireRetiringSuspension();
    assert.equal(intentOwner.isSuspended(), true);
    assert.equal(intentOwner.isIntentCurrent(intent), false);
    releaseIntentSuspension();

    await Promise.all([tokenOwner.destroy(), intentOwner.destroy()]);
  },
);

test(
  'field settlement drains tasks added by a failing task before surfacing errors',
  async () => {
    const {
      createFieldInteractionOwner,
    } = await import(
      '../assets/js/app/ui/modules/field-interaction-owner.js'
    );
    const owner = createFieldInteractionOwner();
    const later = deferred();
    const exactFailure = new Error('exact first settlement failure');
    const first = Promise.reject(exactFailure);
    first.catch(() => {
      owner.track(later.promise);
    });
    owner.track(first);

    let finished = false;
    const settlement = owner.settleAll().then(
      () => {
        finished = true;
        return null;
      },
      error => {
        finished = true;
        return error;
      },
    );
    for (let checkpoint = 0; checkpoint < 10; checkpoint++) {
      await Promise.resolve();
    }
    assert.equal(finished, false);

    later.resolve();
    const error = await settlement;
    assert.strictEqual(error, exactFailure);
  },
);

test(
  'field settlement journals a fast failure that retires before an older task',
  async () => {
    const {
      createFieldInteractionOwner,
    } = await import(
      '../assets/js/app/ui/modules/field-interaction-owner.js'
    );
    const owner = createFieldInteractionOwner();
    const older = deferred();
    owner.track(older.promise);
    const settlement = owner.settleAll();

    const exactFailure = new Error('exact fast settlement failure');
    const fastFailure = Promise.reject(exactFailure);
    fastFailure.catch(() => {});
    owner.track(fastFailure);
    for (let checkpoint = 0; checkpoint < 4; checkpoint++) {
      await Promise.resolve();
    }
    older.resolve();

    await assert.rejects(
      settlement,
      error => error === exactFailure,
    );
  },
);

test(
  'current field settlement journals a fast replacement failure',
  async () => {
    const {
      createFieldInteractionOwner,
    } = await import(
      '../assets/js/app/ui/modules/field-interaction-owner.js'
    );
    const owner = createFieldInteractionOwner();
    const older = deferred();
    const olderTask = owner.run(async () => {
      await older.promise;
    });
    const settlement = owner.settleCurrent();

    const exactFailure = new Error('exact fast current failure');
    const replacement = owner.run(async () => {
      throw exactFailure;
    });
    replacement.catch(() => {});
    for (let checkpoint = 0; checkpoint < 4; checkpoint++) {
      await Promise.resolve();
    }
    older.resolve();

    await olderTask;
    await assert.rejects(
      settlement,
      error => error === exactFailure,
    );
  },
);

test(
  'a deferred duplicate intent cannot publish after a newer field selection',
  async () => {
    const {
      createFieldInteractionOwner,
      isFieldInteractionSupersededError,
    } = await import(
      '../assets/js/app/ui/modules/field-interaction-owner.js'
    );
    const owner = createFieldInteractionOwner();
    const duplication = deferred();
    const intent = owner.beginIntent();
    let duplicatePublications = 0;
    const duplicateTask = duplication.promise.then(() => {
      owner.assertIntentCurrent(intent);
      duplicatePublications++;
    });
    owner.track(duplicateTask);

    const selection = owner.run(async token => {
      owner.assertCurrent(token);
      return 'newer-selection';
    });
    duplication.resolve();

    assert.equal(await selection, 'newer-selection');
    await assert.rejects(
      duplicateTask,
      isFieldInteractionSupersededError,
    );
    assert.equal(duplicatePublications, 0);
  },
);

function createSessionSerializer(contributor) {
  return new SessionSerializer({
    state: {
      getDatasetGeneration: () => 0,
      obsData: { fields: [] },
      pointCount: 0,
      getViewDimensionLevel: () => 3,
      positionsArray: new Float32Array(0),
      varData: { fields: [] },
    },
    viewer: {},
    sidebar: {},
    dataSourceManager: null,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors: [contributor],
  });
}

test(
  'session capture drains the exact current UI mutation before contributors read state',
  async () => {
    const settlement = deferred();
    const capture = deferred();
    const events = [];
    const serializer = createSessionSerializer({
      id: 'owned-state',
      async capture() {
        events.push('capture:start');
        await capture.promise;
        events.push('capture:done');
        return [{
          id: 'owned/state',
          contributorId: 'owned-state',
          priority: 'eager',
          kind: 'json',
          codec: 'none',
          label: 'Owned state',
          datasetDependent: false,
          payload: { activeFieldKey: 'cell_type' },
        }];
      },
      restore() {},
    });
    serializer.setCaptureSettlement(async () => {
      events.push('settle:start');
      await settlement.promise;
      events.push('settle:done');
      return () => {
        events.push('settle:release');
      };
    });

    const captureTask = serializer.createSessionBundle();
    await Promise.resolve();
    assert.deepEqual(events, ['settle:start']);

    settlement.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, [
      'settle:start',
      'settle:done',
      'capture:start',
    ]);
    capture.resolve();
    await captureTask;
    assert.deepEqual(events, [
      'settle:start',
      'settle:done',
      'capture:start',
      'capture:done',
      'settle:release',
    ]);
  },
);

test(
  'session capture rejects a dataset generation replaced between contributor awaits',
  async () => {
    const entered = deferred();
    const release = deferred();
    let generation = 1;
    const state = {
      getDatasetGeneration: () => generation,
      obsData: { fields: [] },
      pointCount: 2,
      getViewDimensionLevel: () => 3,
      positionsArray: new Float32Array(6),
      varData: { fields: [{ key: 'GENE_A' }] },
    };
    const serializer = new SessionSerializer({
      state,
      viewer: {},
      sidebar: {},
      dataSourceManager: null,
      comparisonModule: null,
      analysisWindowManager: null,
      cinematicCamera: null,
      contributors: [{
        id: 'dataset-owned',
        async capture() {
          const capturedCount = state.pointCount;
          entered.resolve();
          await release.promise;
          return [{
            id: 'dataset/owned',
            contributorId: 'dataset-owned',
            priority: 'eager',
            kind: 'json',
            codec: 'none',
            label: 'Dataset-owned state',
            datasetDependent: true,
            payload: { capturedCount },
          }];
        },
        restore() {},
      }],
    });

    const capture = serializer.createSessionBundle();
    await entered.promise;
    generation++;
    state.pointCount = 3;
    state.positionsArray = new Float32Array(9);
    state.obsData = { fields: [] };
    state.varData = {
      fields: [{ key: 'GENE_A' }, { key: 'GENE_B' }],
    };
    release.resolve();

    await assert.rejects(
      capture,
      /dataset.*(?:changed|replaced|generation)/i,
    );
  },
);

test(
  'session restore retires the current UI mutation before contributor snapshots or writes',
  async () => {
    const target = createSessionSerializer({
      id: 'owned-state',
      capture() {
        return [{
          id: 'owned/state',
          contributorId: 'owned-state',
          priority: 'eager',
          kind: 'json',
          codec: 'none',
          label: 'Owned state',
          datasetDependent: false,
          payload: { value: 1 },
        }];
      },
      restore() {},
    });
    const settlement = deferred();
    const restore = deferred();
    const events = [];
    target.setRestoreSettlement(async () => {
      events.push('settle:start');
      await settlement.promise;
      events.push('settle:done');
      return () => {
        events.push('settle:release');
      };
    });

    const restoreTask = target._runOwnedRestore(
      async () => {
        events.push('restore:start');
        await restore.promise;
        events.push('restore:done');
      },
      { signal: null },
    );
    await Promise.resolve();
    assert.deepEqual(events, ['settle:start']);

    settlement.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, [
      'settle:start',
      'settle:done',
      'restore:start',
    ]);
    restore.resolve();
    await restoreTask;
    assert.deepEqual(events, [
      'settle:start',
      'settle:done',
      'restore:start',
      'restore:done',
      'settle:release',
    ]);
  },
);

test(
  'session capture waits for an active restore to reach one terminal state',
  async () => {
    const restore = deferred();
    const events = [];
    let value = 'before';
    const serializer = createSessionSerializer({
      id: 'owned-state',
      capture() {
        events.push(`capture:${value}`);
        return [{
          id: 'owned/state',
          contributorId: 'owned-state',
          priority: 'eager',
          kind: 'json',
          codec: 'none',
          label: 'Owned state',
          datasetDependent: false,
          payload: { value },
        }];
      },
      restore() {},
    });
    const restoreTask = serializer._runOwnedRestore(
      async () => {
        value = 'half-restored';
        events.push('restore:start');
        await restore.promise;
        value = 'restored';
        events.push('restore:done');
      },
      { signal: null },
    );
    await Promise.resolve();
    assert.deepEqual(events, ['restore:start']);

    const captureTask = serializer.createSessionBundle();
    await Promise.resolve();
    assert.deepEqual(events, ['restore:start']);

    restore.resolve();
    await restoreTask;
    await captureTask;
    assert.deepEqual(events, [
      'restore:start',
      'restore:done',
      'capture:restored',
    ]);
  },
);

test(
  'session restore waits for an active capture and captures are serialized',
  async () => {
    const firstCapture = deferred();
    const events = [];
    let captureCalls = 0;
    const serializer = createSessionSerializer({
      id: 'owned-state',
      async capture() {
        const call = ++captureCalls;
        events.push(`capture:${call}:start`);
        if (call === 1) await firstCapture.promise;
        events.push(`capture:${call}:done`);
        return [{
          id: 'owned/state',
          contributorId: 'owned-state',
          priority: 'eager',
          kind: 'json',
          codec: 'none',
          label: 'Owned state',
          datasetDependent: false,
          payload: { call },
        }];
      },
      restore() {},
    });

    const firstBundle = serializer.createSessionBundle();
    await Promise.resolve();
    assert.deepEqual(events, ['capture:1:start']);
    const restoreTask = serializer._runOwnedRestore(
      async () => {
        events.push('restore');
      },
      { signal: null },
    );
    const secondBundle = serializer.createSessionBundle();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, ['capture:1:start']);

    firstCapture.resolve();
    await Promise.all([firstBundle, restoreTask, secondBundle]);
    assert.deepEqual(events, [
      'capture:1:start',
      'capture:1:done',
      'restore',
      'capture:2:start',
      'capture:2:done',
    ]);
  },
);

test(
  'session restore releases its field lease after failure, cancellation, and supersession',
  async () => {
    const serializer = createSessionSerializer({
      id: 'owned-state',
      capture() {
        return [];
      },
      restore() {},
    });
    let acquisitions = 0;
    let releases = 0;
    serializer.setRestoreSettlement(async () => {
      acquisitions++;
      return () => {
        releases++;
      };
    });

    const exactFailure = new Error('exact restore operation failure');
    await assert.rejects(
      serializer._runOwnedRestore(
        async () => {
          throw exactFailure;
        },
        { signal: null },
      ),
      error => error === exactFailure,
    );
    assert.deepEqual({ acquisitions, releases }, {
      acquisitions: 1,
      releases: 1,
    });

    const canceled = serializer._runOwnedRestore(
      async abortController => new Promise((resolve, reject) => {
        abortController.signal.addEventListener(
          'abort',
          () => reject(abortController.signal.reason),
          { once: true },
        );
      }),
      { signal: null },
    );
    await Promise.resolve();
    await serializer.cancelRestore();
    await assert.rejects(canceled, isSessionRestoreCanceledError);
    assert.deepEqual({ acquisitions, releases }, {
      acquisitions: 2,
      releases: 2,
    });

    const first = serializer._runOwnedRestore(
      async abortController => new Promise((resolve, reject) => {
        abortController.signal.addEventListener(
          'abort',
          () => reject(abortController.signal.reason),
          { once: true },
        );
      }),
      { signal: null },
    );
    await Promise.resolve();
    const second = serializer._runOwnedRestore(
      async () => {},
      { signal: null },
    );
    await assert.rejects(first, isSessionRestoreSupersededError);
    await second;
    assert.deepEqual({ acquisitions, releases }, {
      acquisitions: 4,
      releases: 4,
    });
  },
);

test(
  'the UI binds the shared field owner to every session capture path',
  async () => {
    const coordinatorSource = await readFile(
      new URL(
        '../assets/js/app/ui/core/ui-coordinator.js',
        import.meta.url,
      ),
      'utf8',
    );
    const fieldSelectorSource = await readFile(
      new URL(
        '../assets/js/app/ui/modules/field-selector.js',
        import.meta.url,
      ),
      'utf8',
    );
    const geneSelectorSource = await readFile(
      new URL(
        '../assets/js/app/ui/modules/field-selector-gene-expression.js',
        import.meta.url,
      ),
      'utf8',
    );
    const confirmDialogSource = await readFile(
      new URL(
        '../assets/js/app/ui/components/confirm-dialog.js',
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(
      coordinatorSource,
      /sessionSerializer\.setCaptureSettlement\(\s*fieldSelector\.acquireSessionCaptureOperation\s*\)/,
    );
    assert.match(
      coordinatorSource,
      /sessionSerializer\.setRestoreSettlement\(\s*fieldSelector\.acquireSessionRestoreOperation\s*\)/,
    );
    assert.match(
      coordinatorSource,
      /prepareDatasetReplacement:\s*fieldSelector\.prepareDatasetReplacement/,
    );
    assert.match(
      coordinatorSource,
      /settleFieldInteractions:\s*fieldSelector\.settleAllInteractions/,
    );
    assert.match(
      fieldSelectorSource,
      /function isCapturedFieldCurrent\(/,
    );
    assert.match(
      fieldSelectorSource,
      /closeTransientInteractions\(\);\s*interactionOwner\.invalidate\(\)/,
    );
    assert.match(
      fieldSelectorSource,
      /readDatasetGeneration\(\) !== datasetGeneration/,
    );
    for (const source of [fieldSelectorSource, geneSelectorSource]) {
      assert.match(
        source,
        /const intent = interactionOwner\.beginIntent\(\)/,
      );
      assert.match(
        source,
        /interactionOwner\.assertIntentCurrent\(intent\)/,
      );
    }
    assert.match(confirmDialogSource, /return cancel;/);
  },
);
