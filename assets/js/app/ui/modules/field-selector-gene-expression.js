/**
 * @fileoverview Exact gene-expression (var field) selector UI contract.
 *
 * @module ui/modules/field-selector-gene-expression
 */

import { getNotificationCenter } from '../../notification-center.js';
import { FieldSource } from '../../utils/field-constants.js';
import { StateValidator } from '../../utils/state-validator.js';
import {
  createDatasetFieldLoadSupersededError,
  isDatasetFieldLoadSupersededError
} from '../../state/managers/field/loading.js';
import {
  isFieldInteractionSupersededError
} from './field-interaction-owner.js';

const INIT_KEYS = new Set([
  'state',
  'interactionOwner',
  'dom',
  'callbacks',
  'obsDom',
  'noneFieldValue'
]);
const DOM_TYPES = new Map([
  ['geneContainer', 'HTMLElement'],
  ['geneSearch', 'HTMLInputElement'],
  ['geneDropdown', 'HTMLElement'],
  ['geneCopyBtn', 'HTMLButtonElement'],
  ['geneRenameBtn', 'HTMLButtonElement'],
  ['geneDeleteBtn', 'HTMLButtonElement'],
  ['geneClearBtn', 'HTMLButtonElement']
]);
const OBS_DOM_TYPES = new Map([
  ['categoricalSelect', 'HTMLSelectElement'],
  ['continuousSelect', 'HTMLSelectElement']
]);
const CALLBACK_KEYS = new Set([
  'onActiveFieldChanged',
  'onStartFieldRename',
  'onStartFieldDelete',
  'onBusyChanged',
  'onActivateField'
]);
const RETURN_KEYS = new Set([
  'clearGeneSelection',
  'clearLocalSelectionUI',
  'destroy',
  'initGeneExpressionDropdown',
  'selectGene',
  'syncFromState',
  'updateGeneActionButtons'
]);

function requirePlainRecord(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  requirePlainRecord(value, label);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new TypeError(`${label} contains unknown key "${key}"`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} requires key "${key}"`);
    }
  }
  return value;
}

function requireMethod(owner, methodName, label) {
  if (
    owner === null
    || typeof owner !== 'object'
    || typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must implement ${methodName}()`);
  }
}

function requireError(error, label) {
  if (!(error instanceof Error)) {
    throw new TypeError(`${label} must reject with an Error`);
  }
  if (typeof error.message !== 'string' || error.message.length === 0) {
    throw new TypeError(`${label} Error must have a non-empty message`);
  }
  return error;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be exactly boolean`);
  }
  return value;
}

function requireIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireActiveIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new TypeError(`${label} must be -1 or a non-negative safe integer`);
  }
  return value;
}

function parseIndex(value, label) {
  if (
    typeof value !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical non-negative integer`);
  }
  return requireIndex(Number(value), label);
}

function requireField(field, label) {
  if (
    field === null
    || typeof field !== 'object'
    || Array.isArray(field)
  ) {
    throw new TypeError(`${label} must be one field metadata object`);
  }
  StateValidator.validateFieldKey(field.key);
  return field;
}

function requireVarInventory(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('Var field inventory must be an array');
  }
  value.forEach((field, index) => {
    requireField(field, `Var field inventory[${index}]`);
  });
  return value;
}

function requireVisibleVarEntries(value, inventory) {
  if (!Array.isArray(value)) {
    throw new TypeError('Visible var fields must be an array');
  }
  return value.map((entry, entryIndex) => {
    requireExactKeys(
      entry,
      new Set(['field', 'index']),
      `Visible var fields[${entryIndex}]`
    );
    const index = requireIndex(
      entry.index,
      `Visible var fields[${entryIndex}].index`
    );
    if (index >= inventory.length || inventory[index] !== entry.field) {
      throw new Error(
        `Visible var fields[${entryIndex}] must reference its exact inventory slot`
      );
    }
    const field = requireField(
      entry.field,
      `Visible var fields[${entryIndex}].field`
    );
    if (field._isDeleted === true) {
      throw new Error('Visible var fields cannot contain a deleted field');
    }
    return { field, originalIdx: index };
  });
}

function requireFieldInfo(value, field) {
  requireExactKeys(
    value,
    new Set(['field', 'pointCount', 'centroidInfo']),
    'Activate var field result'
  );
  if (value.field !== field) {
    throw new Error(
      'Activate var field result.field must equal the selected gene'
    );
  }
  if (!Number.isSafeInteger(value.pointCount) || value.pointCount < 0) {
    throw new TypeError(
      'Activate var field result.pointCount must be a non-negative safe integer'
    );
  }
  if (value.centroidInfo !== '') {
    throw new TypeError(
      'Activate var field result.centroidInfo must be the empty string'
    );
  }
  return value;
}

function requireDuplicateResult(value, state) {
  requireExactKeys(
    value,
    new Set(['newFieldIndex', 'newKey']),
    'Gene duplicate result'
  );
  const index = requireIndex(
    value.newFieldIndex,
    'Gene duplicate result.newFieldIndex'
  );
  StateValidator.validateFieldKey(value.newKey);
  const fields = requireVarInventory(state.getVarFields());
  if (
    index >= fields.length
    || fields[index].key !== value.newKey
  ) {
    throw new Error(
      'Gene duplicate result must identify the exact created field'
    );
  }
  return value;
}

/**
 * @param {object} options
 */
export function initGeneExpressionSelector(options) {
  requireExactKeys(options, INIT_KEYS, 'Gene expression selector options');
  const {
    state,
    interactionOwner,
    dom,
    callbacks,
    obsDom,
    noneFieldValue
  } = options;
  for (const methodName of [
    'duplicateField',
    'ensureVarFieldLoaded',
    'getDatasetGeneration',
    'getVarFields',
    'getVisibleFields',
    'setActiveVarField'
  ]) {
    requireMethod(state, methodName, 'Gene expression selector state');
  }
  for (const methodName of [
    'assertCurrent',
    'isCurrent',
    'isSuspended',
    'run',
    'track'
  ]) {
    requireMethod(
      interactionOwner,
      methodName,
      'Gene selector interaction owner'
    );
  }
  requireExactKeys(callbacks, CALLBACK_KEYS, 'Gene selector callbacks');
  for (const callbackName of CALLBACK_KEYS) {
    if (typeof callbacks[callbackName] !== 'function') {
      throw new TypeError(
        `Gene selector callbacks.${callbackName} must be a function`
      );
    }
  }
  if (noneFieldValue !== '-1') {
    throw new TypeError(
      'Gene selector noneFieldValue must be exactly "-1"'
    );
  }
  requireExactKeys(dom, new Set(DOM_TYPES.keys()), 'Gene selector DOM');
  requireExactKeys(
    obsDom,
    new Set(OBS_DOM_TYPES.keys()),
    'Gene selector obs DOM'
  );

  const ownerDocument = dom.geneSearch?.ownerDocument;
  const view = ownerDocument?.defaultView;
  if (view === null || view === undefined) {
    throw new TypeError(
      'Gene selector DOM must belong to a document with a window'
    );
  }
  for (const [name, constructorName] of [...DOM_TYPES, ...OBS_DOM_TYPES]) {
    const value = DOM_TYPES.has(name) ? dom[name] : obsDom[name];
    const Constructor = view[constructorName];
    if (
      typeof Constructor !== 'function'
      || !(value instanceof Constructor)
      || value.ownerDocument !== ownerDocument
    ) {
      throw new TypeError(
        `Gene selector ${name} must be one ${constructorName} from the shared document`
      );
    }
  }

  const {
    geneContainer,
    geneSearch,
    geneDropdown,
    geneCopyBtn,
    geneRenameBtn,
    geneDeleteBtn,
    geneClearBtn
  } = dom;
  const { categoricalSelect, continuousSelect } = obsDom;
  const lifecycle = new view.AbortController();
  let destroyed = false;
  let hasGeneExpressionFields = false;
  let geneFieldList = [];
  let selectedGeneOriginalIdx = -1;
  let forceDisabled = false;

  function assertAlive() {
    if (destroyed) {
      throw new Error('Gene expression selector has been destroyed');
    }
  }

  function reportTaskFailure(task, prefix, category) {
    if (
      task === null
      || typeof task !== 'object'
      || typeof task.then !== 'function'
      || typeof task.catch !== 'function'
    ) {
      throw new TypeError('Gene selector UI task must be a Promise');
    }
    interactionOwner.track(task);
    task.catch((error) => {
      if (
        isFieldInteractionSupersededError(error)
        || isDatasetFieldLoadSupersededError(error)
      ) {
        return;
      }
      const exactError = requireError(error, 'Gene selector UI task');
      console.error(exactError);
      getNotificationCenter().error(
        `${prefix}: ${exactError.message}`,
        { category }
      );
    });
  }

  function readDatasetGeneration() {
    const generation = state.getDatasetGeneration();
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new TypeError(
        'Gene selector dataset generation must be a non-negative safe integer'
      );
    }
    return generation;
  }

  function readVarInventory() {
    return requireVarInventory(state.getVarFields());
  }

  function updateGeneActionButtons(nextForceDisabled = forceDisabled) {
    assertAlive();
    forceDisabled = requireBoolean(
      nextForceDisabled,
      'Gene selector forced-disabled state'
    );
    const hasSelection = selectedGeneOriginalIdx >= 0;
    const disableAll = forceDisabled || !hasGeneExpressionFields;
    geneCopyBtn.disabled = disableAll || !hasSelection;
    geneRenameBtn.disabled = disableAll || !hasSelection;
    geneDeleteBtn.disabled = disableAll || !hasSelection;
    geneClearBtn.disabled = forceDisabled || !hasSelection;
  }

  function initGeneExpressionDropdown() {
    assertAlive();
    const inventory = readVarInventory();
    geneFieldList = requireVisibleVarEntries(
      state.getVisibleFields(FieldSource.VAR),
      inventory
    );
    hasGeneExpressionFields = geneFieldList.length > 0;
    geneContainer.classList.toggle('visible', hasGeneExpressionFields);
    if (
      selectedGeneOriginalIdx >= 0
      && !geneFieldList.some(
        ({ originalIdx }) => originalIdx === selectedGeneOriginalIdx
      )
    ) {
      selectedGeneOriginalIdx = -1;
    }
    updateGeneActionButtons();
  }

  function renderGeneDropdownResults(query) {
    assertAlive();
    if (typeof query !== 'string') {
      throw new TypeError('Gene search query must be a string');
    }
    const normalizedQuery = query.toLowerCase().trim();
    const filtered = normalizedQuery.length === 0
      ? geneFieldList
      : geneFieldList.filter(({ field }) => (
          field.key.toLowerCase().includes(normalizedQuery)
        ));
    const fragment = ownerDocument.createDocumentFragment();
    const results = filtered.slice(0, 100);

    if (results.length === 0) {
      const noResults = ownerDocument.createElement('div');
      noResults.className = 'dropdown-no-results';
      noResults.textContent = normalizedQuery.length > 0
        ? 'No genes found'
        : 'Type to search genes...';
      fragment.appendChild(noResults);
    } else {
      for (const { field, originalIdx } of results) {
        const item = ownerDocument.createElement('div');
        item.className = 'dropdown-item';
        if (originalIdx === selectedGeneOriginalIdx) {
          item.classList.add('selected');
        }
        let label = field.key;
        if (Object.hasOwn(field, '_originalKey')) {
          StateValidator.validateFieldKey(field._originalKey);
          label = `${field.key} *`;
          item.title = `Original: ${field._originalKey}`;
        }
        item.textContent = label;
        item.dataset.originalIdx = String(originalIdx);
        item.addEventListener('click', () => {
          reportTaskFailure(
            selectGene(originalIdx),
            'Failed to load gene',
            'data'
          );
        }, { signal: lifecycle.signal });
        fragment.appendChild(item);
      }
      if (filtered.length > 100) {
        const more = ownerDocument.createElement('div');
        more.className = 'dropdown-no-results';
        more.textContent = (
          `...and ${filtered.length - 100} more. Type to narrow results.`
        );
        fragment.appendChild(more);
      }
    }
    geneDropdown.replaceChildren(fragment);
  }

  function showGeneDropdown() {
    renderGeneDropdownResults(geneSearch.value);
    geneDropdown.classList.add('visible');
  }

  function hideGeneDropdown() {
    geneDropdown.classList.remove('visible');
  }

  function findGeneEntry(originalIdx) {
    const index = requireIndex(originalIdx, 'Gene field index');
    const entry = geneFieldList.find(
      candidate => candidate.originalIdx === index
    );
    if (entry === undefined) {
      throw new RangeError(
        'Gene field index is absent from the visible gene inventory'
      );
    }
    return entry;
  }

  function syncFromState() {
    assertAlive();
    const source = state.activeFieldSource;
    if (
      source !== null
      && source !== FieldSource.OBS
      && source !== FieldSource.VAR
    ) {
      throw new TypeError('Active field source must be exactly obs, var, or null');
    }
    const varIdx = requireActiveIndex(
      state.activeVarFieldIndex,
      'Active var field index'
    );
    if (source === FieldSource.VAR) {
      if (varIdx < 0) {
        throw new Error('Active var source requires one active var index');
      }
      const inventory = readVarInventory();
      if (varIdx >= inventory.length) {
        throw new RangeError(
          'Active var field index is outside its exact inventory'
        );
      }
      selectedGeneOriginalIdx = varIdx;
      geneSearch.value = inventory[varIdx].key;
    } else {
      if (varIdx !== -1) {
        throw new Error(
          'Inactive var source requires active var field index -1'
        );
      }
      selectedGeneOriginalIdx = -1;
      geneSearch.value = '';
    }
    updateGeneActionButtons();
  }

  function selectGene(originalIdx) {
    assertAlive();
    if (interactionOwner.isSuspended()) {
      return Promise.resolve(null);
    }
    const datasetGeneration = readDatasetGeneration();
    return interactionOwner.run(async token => {
      const { field, originalIdx: index } = findGeneEntry(originalIdx);
      hideGeneDropdown();
      selectedGeneOriginalIdx = index;
      categoricalSelect.value = noneFieldValue;
      continuousSelect.value = noneFieldValue;
      geneSearch.value = field.key;
      updateGeneActionButtons();
      callbacks.onBusyChanged(true);
      try {
        await state.ensureVarFieldLoaded(index, {
          signal: token.signal
        });
        interactionOwner.assertCurrent(token);
        if (
          readDatasetGeneration() !== datasetGeneration
          || readVarInventory()[index] !== field
        ) {
          throw createDatasetFieldLoadSupersededError();
        }
        const info = requireFieldInfo(
          state.setActiveVarField(index),
          field
        );
        callbacks.onActiveFieldChanged(info);
        return info;
      } catch (error) {
        if (
          interactionOwner.isCurrent(token) === false
          || isFieldInteractionSupersededError(error)
          || isDatasetFieldLoadSupersededError(error)
        ) {
          return null;
        }
        const selectionError = requireError(error, 'Gene selection');
        try {
          syncFromState();
        } catch (rollbackError) {
          throw new AggregateError(
            [
              selectionError,
              requireError(rollbackError, 'Gene selection rollback')
            ],
            'Gene selection and UI rollback failed'
          );
        }
        throw selectionError;
      } finally {
        if (interactionOwner.isCurrent(token)) {
          callbacks.onBusyChanged(false);
          updateGeneActionButtons(false);
        }
      }
    });
  }

  async function clearGeneSelection() {
    assertAlive();
    selectedGeneOriginalIdx = -1;
    geneSearch.value = '';
    updateGeneActionButtons();
    try {
      return await callbacks.onActivateField(-1);
    } catch (error) {
      const clearError = requireError(error, 'Gene selection clear');
      try {
        syncFromState();
      } catch (rollbackError) {
        throw new AggregateError(
          [
            clearError,
            requireError(rollbackError, 'Gene selection clear rollback')
          ],
          'Gene selection clear and UI rollback failed'
        );
      }
      throw clearError;
    }
  }

  function clearLocalSelectionUI() {
    assertAlive();
    selectedGeneOriginalIdx = -1;
    geneSearch.value = '';
    updateGeneActionButtons();
  }

  async function duplicateSelectedGene() {
    if (selectedGeneOriginalIdx < 0) return;
    const { field, originalIdx } = findGeneEntry(
      selectedGeneOriginalIdx
    );
    const intent = interactionOwner.beginIntent();
    const notifications = getNotificationCenter();
    const notificationId = notifications.loading(
      `Duplicating "${field.key}"…`,
      { category: 'filter' }
    );
    try {
      const result = requireDuplicateResult(
        await state.duplicateField(FieldSource.VAR, originalIdx),
        state
      );
      interactionOwner.assertIntentCurrent(intent);
      initGeneExpressionDropdown();
      await selectGene(result.newFieldIndex);
      notifications.complete(
        notificationId,
        `Created "${result.newKey}"`
      );
    } catch (error) {
      if (
        isDatasetFieldLoadSupersededError(error)
        || isFieldInteractionSupersededError(error)
      ) {
        notifications.dismiss(notificationId);
        return;
      }
      const exactError = requireError(error, 'Gene duplication');
      console.error(exactError);
      notifications.fail(
        notificationId,
        `Duplicate failed: ${exactError.message}`
      );
    }
  }

  geneCopyBtn.addEventListener('click', () => {
    reportTaskFailure(
      duplicateSelectedGene(),
      'Gene duplicate action failed',
      'filter'
    );
  }, { signal: lifecycle.signal });
  geneRenameBtn.addEventListener('click', () => {
    if (selectedGeneOriginalIdx >= 0) {
      callbacks.onStartFieldRename(
        FieldSource.VAR,
        selectedGeneOriginalIdx,
        geneSearch
      );
    }
  }, { signal: lifecycle.signal });
  geneDeleteBtn.addEventListener('click', () => {
    if (selectedGeneOriginalIdx >= 0) {
      callbacks.onStartFieldDelete(
        FieldSource.VAR,
        selectedGeneOriginalIdx
      );
    }
  }, { signal: lifecycle.signal });
  geneClearBtn.addEventListener('click', () => {
    reportTaskFailure(
      clearGeneSelection(),
      'Failed to clear gene selection',
      'filter'
    );
  }, { signal: lifecycle.signal });

  geneSearch.addEventListener('focus', () => {
    geneSearch.select();
    showGeneDropdown();
  }, { signal: lifecycle.signal });
  geneSearch.addEventListener('input', () => {
    renderGeneDropdownResults(geneSearch.value);
    if (!geneDropdown.classList.contains('visible')) {
      geneDropdown.classList.add('visible');
    }
  }, { signal: lifecycle.signal });
  geneSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideGeneDropdown();
      geneSearch.blur();
      return;
    }
    if (event.key !== 'Enter') return;
    const firstItem = geneDropdown.querySelector('.dropdown-item');
    if (firstItem === null) return;
    if (!(firstItem instanceof view.HTMLElement)) {
      throw new TypeError('Gene dropdown item must be an HTMLElement');
    }
    const originalIdx = parseIndex(
      firstItem.dataset.originalIdx,
      'Gene dropdown index'
    );
    reportTaskFailure(
      selectGene(originalIdx),
      'Failed to load gene',
      'data'
    );
  }, { signal: lifecycle.signal });
  geneSearch.addEventListener('blur', () => {
    if (selectedGeneOriginalIdx < 0 || geneSearch.value.length > 0) return;
    geneSearch.value = findGeneEntry(selectedGeneOriginalIdx).field.key;
  }, { signal: lifecycle.signal });

  ownerDocument.addEventListener('click', (event) => {
    if (!(event.target instanceof view.Node)) {
      throw new TypeError('Gene selector click target must be a Node');
    }
    if (
      !geneSearch.contains(event.target)
      && !geneDropdown.contains(event.target)
    ) {
      hideGeneDropdown();
    }
  }, { signal: lifecycle.signal });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    lifecycle.abort();
    geneDropdown.replaceChildren();
  }

  const api = {
    initGeneExpressionDropdown,
    selectGene,
    clearGeneSelection,
    clearLocalSelectionUI,
    syncFromState,
    updateGeneActionButtons,
    destroy
  };
  requireExactKeys(api, RETURN_KEYS, 'Gene selector API');
  return api;
}
