/**
 * @fileoverview Exact field-selection and field-operation UI contract.
 *
 * Owns the categorical/continuous observation selectors and coordinates the
 * gene-expression selector, deleted-fields panel, and category builder.
 *
 * @module ui/modules/field-selector
 */

import { getNotificationCenter } from '../../notification-center.js';
import { InlineEditor } from '../components/inline-editor.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';
import { CategoryBuilder } from '../category-builder.js';
import { FieldKind, FieldSource } from '../../utils/field-constants.js';
import { StateValidator } from '../../utils/state-validator.js';
import { initDeletedFieldsPanel } from './field-selector-deleted-fields.js';
import { initGeneExpressionSelector } from './field-selector-gene-expression.js';
import { getCommunityAnnotationSession } from '../../community-annotations/session.js';
import {
  getCommunityAnnotationAccessStore,
  isAnnotationRepoConnected
} from '../../community-annotations/access-store.js';
import { syncCommunityAnnotationCacheContext } from '../../community-annotations/runtime-context.js';
import { ANNOTATION_CONNECTION_CHANGED_EVENT } from '../../community-annotations/connection-events.js';
import {
  createDatasetFieldLoadSupersededError,
  isDatasetFieldLoadSupersededError
} from '../../state/managers/field/loading.js';
import {
  createFieldInteractionOwner,
  isFieldInteractionSupersededError
} from './field-interaction-owner.js';

const NONE_FIELD_VALUE = '-1';
const INIT_KEYS = new Set(['state', 'dom', 'dataSourceManager', 'callbacks']);
const CALLBACK_KEYS = new Set(['onActiveFieldChanged']);
const DOM_TYPES = new Map([
  ['categoricalSelect', 'HTMLSelectElement'],
  ['categoricalCopyBtn', 'HTMLButtonElement'],
  ['categoricalRenameBtn', 'HTMLButtonElement'],
  ['categoricalDeleteBtn', 'HTMLButtonElement'],
  ['categoricalClearBtn', 'HTMLButtonElement'],
  ['continuousSelect', 'HTMLSelectElement'],
  ['continuousCopyBtn', 'HTMLButtonElement'],
  ['continuousRenameBtn', 'HTMLButtonElement'],
  ['continuousDeleteBtn', 'HTMLButtonElement'],
  ['continuousClearBtn', 'HTMLButtonElement'],
  ['geneContainer', 'HTMLElement'],
  ['geneSearch', 'HTMLInputElement'],
  ['geneDropdown', 'HTMLElement'],
  ['geneCopyBtn', 'HTMLButtonElement'],
  ['geneRenameBtn', 'HTMLButtonElement'],
  ['geneDeleteBtn', 'HTMLButtonElement'],
  ['geneClearBtn', 'HTMLButtonElement'],
  ['categoryBuilderContainer', 'HTMLElement'],
  ['deletedFieldsSection', 'HTMLElement']
]);
const REQUIRED_STATE_METHODS = [
  'clearActiveField',
  'deleteField',
  'duplicateField',
  'ensureFieldLoaded',
  'getDatasetGeneration',
  'getFields',
  'getVarFields',
  'getVisibleFields',
  'renameField',
  'setActiveField'
];

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

function requireExactKeys(value, allowedKeys, label) {
  requirePlainRecord(value, label);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unknown key "${key}"`);
    }
  }
  for (const key of allowedKeys) {
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

function requireNonNegativeIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireSelectableIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new TypeError(`${label} must be -1 or a non-negative safe integer`);
  }
  return value;
}

function parseSelectorIndex(value, label) {
  if (value === NONE_FIELD_VALUE) return -1;
  if (
    typeof value !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new TypeError(
      `${label} must be -1 or a canonical non-negative integer`
    );
  }
  return requireNonNegativeIndex(Number(value), label);
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

function requireFieldArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  value.forEach((field, index) => {
    requireField(field, `${label}[${index}]`);
  });
  return value;
}

function requireVisibleEntries(value, source, inventory, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((entry, entryIndex) => {
    requireExactKeys(
      entry,
      new Set(['field', 'index']),
      `${label}[${entryIndex}]`
    );
    const index = requireNonNegativeIndex(
      entry.index,
      `${label}[${entryIndex}].index`
    );
    if (index >= inventory.length || inventory[index] !== entry.field) {
      throw new Error(
        `${label}[${entryIndex}] must reference its exact ${source} inventory slot`
      );
    }
    const field = requireField(
      entry.field,
      `${label}[${entryIndex}].field`
    );
    if (field._isDeleted === true) {
      throw new Error(`${label}[${entryIndex}] cannot contain a deleted field`);
    }
    if (
      field.kind !== FieldKind.CATEGORY
      && field.kind !== FieldKind.CONTINUOUS
    ) {
      throw new TypeError(
        `${label}[${entryIndex}].field has an unsupported kind`
      );
    }
    return { field, index };
  });
}

function requireFieldInfo(value, expectedField, label) {
  requireExactKeys(
    value,
    new Set(['field', 'pointCount', 'centroidInfo']),
    label
  );
  if (value.field !== expectedField) {
    throw new Error(`${label}.field must equal the activated field`);
  }
  if (!Number.isSafeInteger(value.pointCount) || value.pointCount < 0) {
    throw new TypeError(
      `${label}.pointCount must be a non-negative safe integer`
    );
  }
  if (typeof value.centroidInfo !== 'string') {
    throw new TypeError(`${label}.centroidInfo must be a string`);
  }
  return value;
}

function requireDuplicateResult(value, source, state) {
  requireExactKeys(
    value,
    new Set(['newFieldIndex', 'newKey']),
    'Field duplicate result'
  );
  const index = requireNonNegativeIndex(
    value.newFieldIndex,
    'Field duplicate result.newFieldIndex'
  );
  StateValidator.validateFieldKey(value.newKey);
  const fields = source === FieldSource.VAR
    ? requireFieldArray(state.getVarFields(), 'Var field inventory')
    : requireFieldArray(state.getFields(), 'Obs field inventory');
  if (
    index >= fields.length
    || fields[index].key !== value.newKey
  ) {
    throw new Error(
      'Field duplicate result must identify the exact created field'
    );
  }
  return value;
}

function aggregateCleanup(cleanups, label) {
  const errors = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(requireError(error, label));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${label} failed`);
  }
}

/**
 * @param {object} options
 * @param {import('../../state/core/data-state.js').DataState} options.state
 * @param {object} options.dom
 * @param {import('../../../data/data-source-manager.js').DataSourceManager} options.dataSourceManager
 * @param {{onActiveFieldChanged: (fieldInfo: object) => void}} options.callbacks
 */
export function initFieldSelector(options) {
  requireExactKeys(options, INIT_KEYS, 'Field selector options');
  const { state, dom, dataSourceManager, callbacks } = options;

  for (const methodName of REQUIRED_STATE_METHODS) {
    requireMethod(state, methodName, 'Field selector state');
  }
  requireExactKeys(callbacks, CALLBACK_KEYS, 'Field selector callbacks');
  if (typeof callbacks.onActiveFieldChanged !== 'function') {
    throw new TypeError(
      'Field selector callbacks.onActiveFieldChanged must be a function'
    );
  }
  requireExactKeys(dom, new Set(DOM_TYPES.keys()), 'Field selector DOM');

  const firstElement = dom.categoricalSelect;
  const ownerDocument = firstElement?.ownerDocument;
  const view = ownerDocument?.defaultView;
  if (view === null || view === undefined) {
    throw new TypeError(
      'Field selector DOM must belong to a document with a window'
    );
  }
  for (const [name, constructorName] of DOM_TYPES) {
    const Constructor = view[constructorName];
    if (
      typeof Constructor !== 'function'
      || !(dom[name] instanceof Constructor)
      || dom[name].ownerDocument !== ownerDocument
    ) {
      throw new TypeError(
        `Field selector DOM.${name} must be one ${constructorName} from the shared document`
      );
    }
  }
  for (const methodName of [
    'getCurrentDatasetId',
    'offDatasetChange',
    'onDatasetChange'
  ]) {
    requireMethod(
      dataSourceManager,
      methodName,
      'Field selector dataSourceManager'
    );
  }

  const {
    categoricalSelect,
    categoricalCopyBtn,
    categoricalRenameBtn,
    categoricalDeleteBtn,
    categoricalClearBtn,
    continuousSelect,
    continuousCopyBtn,
    continuousRenameBtn,
    continuousDeleteBtn,
    continuousClearBtn,
    geneContainer,
    geneSearch,
    geneDropdown,
    geneCopyBtn,
    geneRenameBtn,
    geneDeleteBtn,
    geneClearBtn,
    categoryBuilderContainer,
    deletedFieldsSection
  } = dom;

  const annotationSession = getCommunityAnnotationSession();
  const access = getCommunityAnnotationAccessStore();
  for (const methodName of [
    'isFieldAnnotated',
    'isFieldClosed',
    'on',
    'setFieldAnnotated'
  ]) {
    requireMethod(
      annotationSession,
      methodName,
      'Community annotation session'
    );
  }
  for (const methodName of ['isAuthor', 'on']) {
    requireMethod(
      access,
      methodName,
      'Community annotation access store'
    );
  }

  const lifecycle = new view.AbortController();
  const interactionOwner = createFieldInteractionOwner();
  let destroyed = false;
  let destroyPromise = null;
  let forceDisableFieldSelects = false;
  let hasCategoricalFields = false;
  let hasContinuousFields = false;
  let geneSelector;
  let categoryBuilder;
  const transientClosers = new Set();
  let adoptedDatasetGeneration = state.getDatasetGeneration();
  if (
    !Number.isSafeInteger(adoptedDatasetGeneration)
    || adoptedDatasetGeneration < 0
  ) {
    throw new TypeError(
      'Field selector dataset generation must be a non-negative safe integer'
    );
  }

  function resetFieldSelect(select, label) {
    if (typeof label !== 'string' || label.length === 0) {
      throw new TypeError('Empty field-selector label must be a non-empty string');
    }
    const noneOption = ownerDocument.createElement('option');
    noneOption.value = NONE_FIELD_VALUE;
    noneOption.textContent = label;
    select.replaceChildren(noneOption);
    if (select.value !== NONE_FIELD_VALUE) {
      throw new Error('Field selector failed to adopt its canonical empty value');
    }
  }

  resetFieldSelect(
    categoricalSelect,
    '(no categorical obs fields)'
  );
  resetFieldSelect(
    continuousSelect,
    '(no continuous obs fields)'
  );

  function assertAlive() {
    if (destroyed) {
      throw new Error('Field selector has been destroyed');
    }
  }

  function ownTransient(close) {
    if (typeof close !== 'function') {
      throw new TypeError('Field transient closer must be a function');
    }
    transientClosers.add(close);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      transientClosers.delete(close);
    };
  }

  function closeTransientInteractions() {
    const closers = [...transientClosers];
    transientClosers.clear();
    const errors = [];
    for (const close of closers) {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Field transient interaction cleanup failed'
      );
    }
  }

  function reportTaskFailure(task, prefix, category) {
    if (
      task === null
      || typeof task !== 'object'
      || typeof task.then !== 'function'
      || typeof task.catch !== 'function'
    ) {
      throw new TypeError('Field selector UI task must be a Promise');
    }
    interactionOwner.track(task);
    task.catch((error) => {
      if (
        isFieldInteractionSupersededError(error)
        || isDatasetFieldLoadSupersededError(error)
      ) {
        return;
      }
      const exactError = requireError(error, 'Field selector UI task');
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
        'Field selector dataset generation must be a non-negative safe integer'
      );
    }
    return generation;
  }

  function synchronizeDatasetGeneration() {
    const generation = readDatasetGeneration();
    if (generation !== adoptedDatasetGeneration) {
      closeTransientInteractions();
      interactionOwner.invalidate();
      adoptedDatasetGeneration = generation;
      forceDisableFieldSelects = false;
    }
    return generation;
  }

  function isCapturedFieldCurrent(
    datasetGeneration,
    source,
    index,
    field
  ) {
    if (
      destroyed
      || readDatasetGeneration() !== datasetGeneration
    ) {
      return false;
    }
    const fields = source === FieldSource.OBS
      ? state.getFields()
      : state.getVarFields();
    return Array.isArray(fields) && fields[index] === field;
  }

  function isIntentionalInteractionRetirement(error, token) {
    return (
      interactionOwner.isCurrent(token) === false
      || isFieldInteractionSupersededError(error)
      || isDatasetFieldLoadSupersededError(error)
    );
  }

  function isCommunityAnnotationUiEnabled() {
    const ctx = syncCommunityAnnotationCacheContext({ dataSourceManager });
    const connected = isAnnotationRepoConnected(ctx.datasetId, ctx.userKey);
    return requireBoolean(
      connected,
      'Annotation repository connection state'
    );
  }

  syncCommunityAnnotationCacheContext({ dataSourceManager });

  const deletedFieldsPanel = initDeletedFieldsPanel({
    state,
    deletedFieldsSection
  });
  requireExactKeys(
    deletedFieldsPanel,
    new Set(['destroy', 'renderDeletedFieldsSection']),
    'Deleted fields panel'
  );
  for (const methodName of ['destroy', 'renderDeletedFieldsSection']) {
    if (typeof deletedFieldsPanel[methodName] !== 'function') {
      throw new TypeError(
        `Deleted fields panel.${methodName} must be a function`
      );
    }
  }

  function readObsFields() {
    return requireFieldArray(state.getFields(), 'Obs field inventory');
  }

  function readVarFields() {
    return requireFieldArray(state.getVarFields(), 'Var field inventory');
  }

  function getFieldForSource(source, fieldIndex) {
    if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
      throw new TypeError('Field source must be exactly obs or var');
    }
    const fields = source === FieldSource.VAR
      ? readVarFields()
      : readObsFields();
    const index = requireNonNegativeIndex(fieldIndex, 'Field index');
    if (index >= fields.length) {
      throw new RangeError('Field index is outside its exact inventory');
    }
    return { fields, field: fields[index], index };
  }

  function getFieldsByKind(kind) {
    if (kind !== FieldKind.CATEGORY && kind !== FieldKind.CONTINUOUS) {
      throw new TypeError('Field kind must be exactly category or continuous');
    }
    const inventory = readObsFields();
    const entries = requireVisibleEntries(
      state.getVisibleFields(FieldSource.OBS),
      FieldSource.OBS,
      inventory,
      'Visible obs fields'
    );
    return entries
      .filter(({ field }) => field.kind === kind)
      .map(({ field, index }) => ({ field, idx: index }));
  }

  function readAnnotationFlag(methodName, fieldKey) {
    const value = annotationSession[methodName](fieldKey);
    return requireBoolean(
      value,
      `Community annotation session.${methodName}()`
    );
  }

  function updateFieldActionButtons() {
    assertAlive();
    const catIdx = parseSelectorIndex(
      categoricalSelect.value,
      'Categorical field selection'
    );
    const contIdx = parseSelectorIndex(
      continuousSelect.value,
      'Continuous field selection'
    );
    const catSelected = catIdx >= 0;
    const contSelected = contIdx >= 0;
    const catDisabled = categoricalSelect.disabled || !catSelected;
    const contDisabled = continuousSelect.disabled || !contSelected;

    let catVotingLocked = false;
    if (catSelected) {
      const { field } = getFieldForSource(FieldSource.OBS, catIdx);
      if (field.kind !== FieldKind.CATEGORY) {
        throw new Error(
          'Categorical selector must reference one categorical field'
        );
      }
      if (isCommunityAnnotationUiEnabled()) {
        catVotingLocked = readAnnotationFlag(
          'isFieldAnnotated',
          field.key
        );
      }
    }

    categoricalCopyBtn.disabled = catDisabled;
    categoricalRenameBtn.disabled = catDisabled || catVotingLocked;
    categoricalDeleteBtn.disabled = catDisabled || catVotingLocked;
    categoricalClearBtn.disabled = catDisabled;
    continuousCopyBtn.disabled = contDisabled;
    continuousRenameBtn.disabled = contDisabled;
    continuousDeleteBtn.disabled = contDisabled;
    continuousClearBtn.disabled = contDisabled;
  }

  function updateFieldSelectDisabledStates() {
    assertAlive();
    categoricalSelect.disabled = (
      forceDisableFieldSelects || !hasCategoricalFields
    );
    continuousSelect.disabled = (
      forceDisableFieldSelects || !hasContinuousFields
    );
    updateFieldActionButtons();
    geneSelector.updateGeneActionButtons(forceDisableFieldSelects);
  }

  function validateUniqueFieldName(nextValue, fields, fieldIndex) {
    if (typeof nextValue !== 'string') {
      return 'Field name must be a string';
    }
    try {
      StateValidator.validateFieldKey(nextValue);
    } catch (error) {
      return requireError(error, 'Field-name validation').message;
    }
    if (StateValidator.isDuplicateKey(nextValue, fields, fieldIndex)) {
      return 'A field with this name already exists';
    }
    return true;
  }

  function startFieldRename(source, fieldIndex, targetEl) {
    assertAlive();
    if (!(targetEl instanceof view.HTMLElement)) {
      throw new TypeError('Field rename target must be an HTMLElement');
    }
    const { field, index } = getFieldForSource(source, fieldIndex);
    const datasetGeneration = readDatasetGeneration();
    if (
      isCommunityAnnotationUiEnabled()
      && source === FieldSource.OBS
      && field.kind === FieldKind.CATEGORY
      && readAnnotationFlag('isFieldAnnotated', field.key)
    ) {
      getNotificationCenter().error(
        'Rename is disabled while voting is enabled for this field',
        { category: 'annotation' }
      );
      return;
    }

    let releaseTransient = () => {};
    const editor = InlineEditor.create(targetEl, field.key, {
      onSave: (newName) => {
        releaseTransient();
        if (
          !isCapturedFieldCurrent(
            datasetGeneration,
            source,
            index,
            field
          )
        ) {
          return;
        }
        const renamed = requireBoolean(
          state.renameField(source, index, newName),
          'Field rename result'
        );
        if (!renamed) {
          getNotificationCenter().error(
            'Failed to rename field',
            { category: 'filter' }
          );
          return;
        }
        getNotificationCenter().success(
          `Renamed to "${newName}"`,
          { category: 'filter', duration: 2000 }
        );
      },
      onCancel: () => {
        releaseTransient();
      },
      validate: name => (
        isCapturedFieldCurrent(
          datasetGeneration,
          source,
          index,
          field
        )
          ? validateUniqueFieldName(
              name,
              source === FieldSource.OBS
                ? state.getFields()
                : state.getVarFields(),
              index
            )
          : 'The dataset changed; rename was canceled'
      )
    });
    if (!(editor instanceof view.HTMLInputElement)) {
      throw new Error('Field rename editor failed to initialize');
    }
    releaseTransient = ownTransient(
      () => InlineEditor.cancel(editor)
    );
  }

  function startFieldDelete(source, fieldIndex) {
    assertAlive();
    const { field, index } = getFieldForSource(source, fieldIndex);
    const datasetGeneration = readDatasetGeneration();
    if (
      isCommunityAnnotationUiEnabled()
      && source === FieldSource.OBS
      && field.kind === FieldKind.CATEGORY
      && readAnnotationFlag('isFieldAnnotated', field.key)
    ) {
      getNotificationCenter().error(
        'Delete is disabled while voting is enabled for this field',
        { category: 'annotation' }
      );
      return;
    }

    let releaseTransient = () => {};
    const closeDialog = showConfirmDialog({
      title: 'Delete field',
      message: `Delete "${field.key}"? You can restore it from Deleted Fields.`,
      confirmText: 'Delete',
      onConfirm: () => {
        releaseTransient();
        if (
          !isCapturedFieldCurrent(
            datasetGeneration,
            source,
            index,
            field
          )
        ) {
          return;
        }
        const deleted = requireBoolean(
          state.deleteField(source, index),
          'Field deletion result'
        );
        if (!deleted) {
          getNotificationCenter().error(
            'Failed to delete field',
            { category: 'filter' }
          );
          return;
        }
        getNotificationCenter().success(
          `Deleted "${field.key}"`,
          { category: 'filter', duration: 2500 }
        );
      },
      onCancel: () => {
        releaseTransient();
      }
    });
    releaseTransient = ownTransient(closeDialog);
  }

  function clearFieldSelections() {
    categoricalSelect.value = NONE_FIELD_VALUE;
    continuousSelect.value = NONE_FIELD_VALUE;
  }

  function syncSelectsForField(idx) {
    const index = requireNonNegativeIndex(idx, 'Active obs field index');
    const { field } = getFieldForSource(FieldSource.OBS, index);
    const value = String(index);
    if (field.kind === FieldKind.CATEGORY) {
      if (categoricalSelect.querySelector(`option[value="${value}"]`) === null) {
        throw new Error(
          'Active categorical field is absent from its rendered selector'
        );
      }
      categoricalSelect.value = value;
      continuousSelect.value = NONE_FIELD_VALUE;
      return;
    }
    if (field.kind === FieldKind.CONTINUOUS) {
      if (continuousSelect.querySelector(`option[value="${value}"]`) === null) {
        throw new Error(
          'Active continuous field is absent from its rendered selector'
        );
      }
      continuousSelect.value = value;
      categoricalSelect.value = NONE_FIELD_VALUE;
      return;
    }
    throw new TypeError('Active obs field has an unsupported kind');
  }

  function requireActiveState() {
    const source = state.activeFieldSource;
    if (
      source !== null
      && source !== FieldSource.OBS
      && source !== FieldSource.VAR
    ) {
      throw new TypeError('Active field source must be exactly obs, var, or null');
    }
    const obsIdx = requireSelectableIndex(
      state.activeFieldIndex,
      'Active obs field index'
    );
    const varIdx = requireSelectableIndex(
      state.activeVarFieldIndex,
      'Active var field index'
    );
    if (source === null && (obsIdx !== -1 || varIdx !== -1)) {
      throw new Error('No active field requires both active indices to be -1');
    }
    if (source === FieldSource.OBS && (obsIdx < 0 || varIdx !== -1)) {
      throw new Error(
        'Active obs selection requires one obs index and var index -1'
      );
    }
    if (source === FieldSource.VAR && (varIdx < 0 || obsIdx !== -1)) {
      throw new Error(
        'Active var selection requires one var index and obs index -1'
      );
    }
    return { source, obsIdx, varIdx };
  }

  function syncFromState() {
    assertAlive();
    synchronizeDatasetGeneration();
    const { source, obsIdx } = requireActiveState();
    if (source === FieldSource.OBS) {
      geneSelector.clearLocalSelectionUI();
      syncSelectsForField(obsIdx);
    } else {
      clearFieldSelections();
      if (source === null) {
        geneSelector.clearLocalSelectionUI();
      }
    }
    updateFieldActionButtons();
    geneSelector.syncFromState();
    geneSelector.updateGeneActionButtons(forceDisableFieldSelects);
  }

  function renderFieldSelects() {
    assertAlive();
    synchronizeDatasetGeneration();
    const ctx = syncCommunityAnnotationCacheContext({ dataSourceManager });
    const annotationUiEnabled = requireBoolean(
      isAnnotationRepoConnected(ctx.datasetId, ctx.userKey),
      'Annotation repository connection state'
    );
    const fields = readObsFields();
    const categoricalFields = getFieldsByKind(FieldKind.CATEGORY);
    const continuousFields = getFieldsByKind(FieldKind.CONTINUOUS);
    hasCategoricalFields = categoricalFields.length > 0;
    hasContinuousFields = continuousFields.length > 0;

    function populateSelect(select, entries, emptyLabel) {
      resetFieldSelect(
        select,
        entries.length > 0 ? 'None' : emptyLabel
      );
      const fragment = ownerDocument.createDocumentFragment();
      for (const { field, idx } of entries) {
        const option = ownerDocument.createElement('option');
        option.value = String(idx);
        let baseLabel = field.key;
        if (Object.hasOwn(field, '_originalKey')) {
          StateValidator.validateFieldKey(field._originalKey);
          baseLabel = `${field.key} *`;
        }
        let annotationBadge = '';
        if (
          annotationUiEnabled
          && select === categoricalSelect
          && readAnnotationFlag('isFieldAnnotated', field.key)
        ) {
          annotationBadge = readAnnotationFlag('isFieldClosed', field.key)
            ? '🗳️🏁 '
            : '🗳️ ';
        }
        option.textContent = `${annotationBadge}${baseLabel}`;
        fragment.appendChild(option);
      }
      select.appendChild(fragment);
    }

    populateSelect(
      categoricalSelect,
      categoricalFields,
      '(no categorical obs fields)'
    );
    populateSelect(
      continuousSelect,
      continuousFields,
      '(no continuous obs fields)'
    );
    updateFieldSelectDisabledStates();
    syncFromState();

    if (fields.length === 0) {
      callbacks.onActiveFieldChanged({
        field: null,
        pointCount: 0,
        centroidInfo: ''
      });
    }
  }

  function activateField(idx) {
    assertAlive();
    const index = requireSelectableIndex(idx, 'Field activation index');
    if (interactionOwner.isSuspended()) {
      return Promise.resolve(null);
    }
    const datasetGeneration = synchronizeDatasetGeneration();
    return interactionOwner.run(async token => {
      syncCommunityAnnotationCacheContext({ dataSourceManager });

      if (index === -1) {
        interactionOwner.assertCurrent(token);
        const cleared = requireFieldInfo(
          state.clearActiveField(),
          null,
          'Clear active field result'
        );
        forceDisableFieldSelects = false;
        clearFieldSelections();
        geneSelector.clearLocalSelectionUI();
        geneSelector.updateGeneActionButtons(false);
        updateFieldSelectDisabledStates();
        callbacks.onActiveFieldChanged(cleared);
        return cleared;
      }

      const { field } = getFieldForSource(FieldSource.OBS, index);
      geneSelector.clearLocalSelectionUI();
      geneSelector.updateGeneActionButtons(forceDisableFieldSelects);
      forceDisableFieldSelects = true;
      updateFieldSelectDisabledStates();
      try {
        await state.ensureFieldLoaded(index, {
          signal: token.signal
        });
        interactionOwner.assertCurrent(token);
        if (
          readDatasetGeneration() !== datasetGeneration
          || state.getFields()?.[index] !== field
        ) {
          throw createDatasetFieldLoadSupersededError();
        }
        const info = requireFieldInfo(
          state.setActiveField(index),
          field,
          'Activate obs field result'
        );
        syncSelectsForField(index);
        callbacks.onActiveFieldChanged(info);
        return info;
      } catch (error) {
        if (isIntentionalInteractionRetirement(error, token)) {
          return null;
        }
        const activationError = requireError(error, 'Obs field activation');
        try {
          syncFromState();
        } catch (rollbackError) {
          throw new AggregateError(
            [
              activationError,
              requireError(rollbackError, 'Obs field activation rollback')
            ],
            'Obs field activation and UI rollback failed'
          );
        }
        throw activationError;
      } finally {
        if (interactionOwner.isCurrent(token)) {
          forceDisableFieldSelects = false;
          updateFieldSelectDisabledStates();
        }
      }
    });
  }

  async function duplicateSelectedField(select, expectedKind) {
    const index = parseSelectorIndex(
      select.value,
      `${expectedKind} duplicate selection`
    );
    if (index === -1) return;
    const { field } = getFieldForSource(FieldSource.OBS, index);
    if (field.kind !== expectedKind) {
      throw new Error(
        `${expectedKind} duplicate action references the wrong field kind`
      );
    }
    const intent = interactionOwner.beginIntent();

    const notifications = getNotificationCenter();
    const notificationId = notifications.loading(
      `Duplicating "${field.key}"…`,
      { category: 'filter' }
    );
    try {
      const result = requireDuplicateResult(
        await state.duplicateField(FieldSource.OBS, index),
        FieldSource.OBS,
        state
      );
      interactionOwner.assertIntentCurrent(intent);
      if (expectedKind === FieldKind.CATEGORY) {
        categoricalSelect.value = String(result.newFieldIndex);
        continuousSelect.value = NONE_FIELD_VALUE;
      } else {
        continuousSelect.value = String(result.newFieldIndex);
        categoricalSelect.value = NONE_FIELD_VALUE;
      }
      await activateField(result.newFieldIndex);
      if (expectedKind === FieldKind.CATEGORY) {
        const updated = requireBoolean(
          annotationSession.setFieldAnnotated(result.newKey, false),
          'Duplicated field annotation reset'
        );
        if (!updated) {
          throw new Error(
            'Duplicated field annotation reset did not complete'
          );
        }
      }
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
      const exactError = requireError(error, 'Field duplication');
      console.error(exactError);
      notifications.fail(
        notificationId,
        `Duplicate failed: ${exactError.message}`
      );
    }
  }

  geneSelector = initGeneExpressionSelector({
    state,
    interactionOwner,
    dom: {
      geneContainer,
      geneSearch,
      geneDropdown,
      geneCopyBtn,
      geneRenameBtn,
      geneDeleteBtn,
      geneClearBtn
    },
    obsDom: {
      categoricalSelect,
      continuousSelect
    },
    noneFieldValue: NONE_FIELD_VALUE,
    callbacks: {
      onActiveFieldChanged: callbacks.onActiveFieldChanged,
      onStartFieldRename: startFieldRename,
      onStartFieldDelete: startFieldDelete,
      onBusyChanged: (busy) => {
        forceDisableFieldSelects = requireBoolean(
          busy,
          'Gene selector busy state'
        );
        updateFieldSelectDisabledStates();
      },
      onActivateField: idx => activateField(idx)
    }
  });
  requireExactKeys(
    geneSelector,
    new Set([
      'clearGeneSelection',
      'clearLocalSelectionUI',
      'destroy',
      'initGeneExpressionDropdown',
      'selectGene',
      'syncFromState',
      'updateGeneActionButtons'
    ]),
    'Gene expression selector'
  );
  for (const methodName of Object.keys(geneSelector)) {
    if (typeof geneSelector[methodName] !== 'function') {
      throw new TypeError(
        `Gene expression selector.${methodName} must be a function`
      );
    }
  }

  categoricalSelect.addEventListener('contextmenu', (event) => {
    assertAlive();
    event.preventDefault();
    if (!isCommunityAnnotationUiEnabled()) return;
    const author = requireBoolean(
      access.isAuthor(),
      'Community annotation author state'
    );
    if (!author) {
      getNotificationCenter().error(
        'Only repo authors can change which columns are annotatable',
        { category: 'annotation' }
      );
      return;
    }
    const index = parseSelectorIndex(
      categoricalSelect.value,
      'Categorical annotation selection'
    );
    if (index === -1) return;
    const { field } = getFieldForSource(FieldSource.OBS, index);
    if (field.kind !== FieldKind.CATEGORY) {
      throw new Error(
        'Categorical annotation action references a non-categorical field'
      );
    }
    const datasetGeneration = readDatasetGeneration();
    const enabled = readAnnotationFlag('isFieldAnnotated', field.key);
    let releaseTransient = () => {};
    const closeDialog = showConfirmDialog({
      title: enabled
        ? 'Disable community annotation'
        : 'Enable community annotation',
      message: enabled
        ? `Disable annotation voting for "${field.key}"? (Votes remain in local storage.)`
        : `Enable annotation voting for "${field.key}"? You will see 🗳️ next to the field name and can click category labels to vote in a popup.`,
      confirmText: enabled ? 'Disable' : 'Enable',
      onConfirm: () => {
        releaseTransient();
        if (
          !isCapturedFieldCurrent(
            datasetGeneration,
            FieldSource.OBS,
            index,
            field
          )
        ) {
          return;
        }
        const updated = requireBoolean(
          annotationSession.setFieldAnnotated(field.key, !enabled),
          'Community annotation field update'
        );
        if (!updated) {
          throw new Error(
            'Community annotation field update did not complete'
          );
        }
        getNotificationCenter().success(
          `${enabled ? 'Disabled' : 'Enabled'} community annotation for "${field.key}"`,
          { category: 'annotation', duration: 2400 }
        );
        renderFieldSelects();
      },
      onCancel: () => {
        releaseTransient();
      }
    });
    releaseTransient = ownTransient(closeDialog);
  }, { signal: lifecycle.signal });

  categoricalSelect.addEventListener('change', () => {
    const index = parseSelectorIndex(
      categoricalSelect.value,
      'Categorical field selection'
    );
    if (index >= 0) {
      continuousSelect.value = NONE_FIELD_VALUE;
      reportTaskFailure(
        activateField(index),
        'Failed to load field',
        'data'
      );
    } else if (continuousSelect.value === NONE_FIELD_VALUE) {
      reportTaskFailure(
        activateField(-1),
        'Failed to clear field',
        'filter'
      );
    }
  }, { signal: lifecycle.signal });

  continuousSelect.addEventListener('change', () => {
    const index = parseSelectorIndex(
      continuousSelect.value,
      'Continuous field selection'
    );
    if (index >= 0) {
      categoricalSelect.value = NONE_FIELD_VALUE;
      reportTaskFailure(
        activateField(index),
        'Failed to load field',
        'data'
      );
    } else if (categoricalSelect.value === NONE_FIELD_VALUE) {
      reportTaskFailure(
        activateField(-1),
        'Failed to clear field',
        'filter'
      );
    }
  }, { signal: lifecycle.signal });

  categoricalCopyBtn.addEventListener('click', () => {
    reportTaskFailure(
      duplicateSelectedField(categoricalSelect, FieldKind.CATEGORY),
      'Categorical duplicate action failed',
      'filter'
    );
  }, { signal: lifecycle.signal });
  categoricalRenameBtn.addEventListener('click', () => {
    const index = parseSelectorIndex(
      categoricalSelect.value,
      'Categorical rename selection'
    );
    if (index >= 0) {
      startFieldRename(FieldSource.OBS, index, categoricalSelect);
    }
  }, { signal: lifecycle.signal });
  categoricalDeleteBtn.addEventListener('click', () => {
    const index = parseSelectorIndex(
      categoricalSelect.value,
      'Categorical delete selection'
    );
    if (index >= 0) startFieldDelete(FieldSource.OBS, index);
  }, { signal: lifecycle.signal });
  categoricalClearBtn.addEventListener('click', () => {
    reportTaskFailure(
      activateField(-1),
      'Failed to clear field',
      'filter'
    );
  }, { signal: lifecycle.signal });

  continuousCopyBtn.addEventListener('click', () => {
    reportTaskFailure(
      duplicateSelectedField(continuousSelect, FieldKind.CONTINUOUS),
      'Continuous duplicate action failed',
      'filter'
    );
  }, { signal: lifecycle.signal });
  continuousRenameBtn.addEventListener('click', () => {
    const index = parseSelectorIndex(
      continuousSelect.value,
      'Continuous rename selection'
    );
    if (index >= 0) {
      startFieldRename(FieldSource.OBS, index, continuousSelect);
    }
  }, { signal: lifecycle.signal });
  continuousDeleteBtn.addEventListener('click', () => {
    const index = parseSelectorIndex(
      continuousSelect.value,
      'Continuous delete selection'
    );
    if (index >= 0) startFieldDelete(FieldSource.OBS, index);
  }, { signal: lifecycle.signal });
  continuousClearBtn.addEventListener('click', () => {
    reportTaskFailure(
      activateField(-1),
      'Failed to clear field',
      'filter'
    );
  }, { signal: lifecycle.signal });

  const rerenderForExternalState = () => renderFieldSelects();
  const unsubscribeAnnotation = annotationSession.on(
    'changed',
    rerenderForExternalState
  );
  if (typeof unsubscribeAnnotation !== 'function') {
    throw new TypeError(
      'Annotation subscription must return an unsubscribe function'
    );
  }
  const unsubscribeAccess = access.on(
    'changed',
    rerenderForExternalState
  );
  if (typeof unsubscribeAccess !== 'function') {
    unsubscribeAnnotation();
    throw new TypeError(
      'Annotation access subscription must return an unsubscribe function'
    );
  }
  view.addEventListener(
    ANNOTATION_CONNECTION_CHANGED_EVENT,
    rerenderForExternalState,
    { signal: lifecycle.signal }
  );
  dataSourceManager.onDatasetChange(rerenderForExternalState);

  if (Object.hasOwn(categoryBuilderContainer.dataset, 'catBuilderInitialized')) {
    throw new Error('Category builder container is already initialized');
  }
  categoryBuilder = new CategoryBuilder(state, categoryBuilderContainer);
  categoryBuilder.init();
  if (typeof categoryBuilder.destroy !== 'function') {
    dataSourceManager.offDatasetChange(rerenderForExternalState);
    unsubscribeAccess();
    unsubscribeAnnotation();
    lifecycle.abort();
    geneSelector.destroy();
    deletedFieldsPanel.destroy();
    throw new TypeError('Category builder must implement destroy()');
  }
  categoryBuilderContainer.dataset.catBuilderInitialized = 'true';

  function destroy() {
    if (destroyPromise !== null) return destroyPromise;
    destroyed = true;
    let resolveDestruction;
    let rejectDestruction;
    destroyPromise = new Promise((resolve, reject) => {
      resolveDestruction = resolve;
      rejectDestruction = reject;
    });
    const interactionDestruction = interactionOwner.destroy();
    const errors = [];
    const cleanups = [
      () => closeTransientInteractions(),
      () => lifecycle.abort(),
      () => dataSourceManager.offDatasetChange(rerenderForExternalState),
      () => unsubscribeAccess(),
      () => unsubscribeAnnotation(),
      () => categoryBuilder.destroy(),
      () => {
        delete categoryBuilderContainer.dataset.catBuilderInitialized;
      },
      () => geneSelector.destroy(),
      () => deletedFieldsPanel.destroy()
    ];
    try {
      aggregateCleanup(cleanups, 'Field selector cleanup');
    } catch (error) {
      errors.push(error);
    }
    void Promise.allSettled([interactionDestruction]).then(outcomes => {
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          errors.push(outcome.reason);
        }
      }
      const exactErrors = [...new Set(errors)];
      if (exactErrors.length === 0) {
        resolveDestruction();
      } else if (exactErrors.length === 1) {
        rejectDestruction(exactErrors[0]);
      } else {
        rejectDestruction(
          new AggregateError(
            exactErrors,
            'Field selector destruction failed'
          )
        );
      }
    });
    void destroyPromise.catch(() => {});
    return destroyPromise;
  }

  function prepareDatasetReplacement() {
    assertAlive();
    closeTransientInteractions();
    interactionOwner.invalidate();
    forceDisableFieldSelects = false;
  }

  function settleCurrentInteraction() {
    assertAlive();
    return interactionOwner.settleCurrent();
  }

  function settleAllInteractions() {
    assertAlive();
    return interactionOwner.settleAll();
  }

  async function acquireSessionOperation(retireCurrent) {
    if (typeof retireCurrent !== 'boolean') {
      throw new TypeError(
        'Session field ownership requires an exact retirement choice'
      );
    }
    assertAlive();
    const releaseOwner = retireCurrent
      ? interactionOwner.acquireRetiringSuspension()
      : interactionOwner.acquireSuspension();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseOwner();
      if (destroyed) return;
      forceDisableFieldSelects = false;
      geneSelector.updateGeneActionButtons(false);
      syncFromState();
      updateFieldSelectDisabledStates();
    };
    try {
      closeTransientInteractions();
      forceDisableFieldSelects = true;
      geneSelector.updateGeneActionButtons(true);
      updateFieldSelectDisabledStates();
      await interactionOwner.settleAll();
      return release;
    } catch (error) {
      try {
        release();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'Field interaction suspension failed'
        );
      }
      throw error;
    }
  }

  function acquireSessionCaptureOperation() {
    return acquireSessionOperation(false);
  }

  function acquireSessionRestoreOperation() {
    return acquireSessionOperation(true);
  }

  function initGeneExpressionDropdown() {
    assertAlive();
    geneSelector.initGeneExpressionDropdown();
    geneSelector.updateGeneActionButtons(forceDisableFieldSelects);
  }

  async function selectGene(originalIdx) {
    assertAlive();
    return geneSelector.selectGene(originalIdx);
  }

  function clearGeneSelection() {
    assertAlive();
    return geneSelector.clearGeneSelection();
  }

  return {
    acquireSessionCaptureOperation,
    acquireSessionRestoreOperation,
    destroy,
    activateField,
    prepareDatasetReplacement,
    selectGene,
    settleAllInteractions,
    settleCurrentInteraction,
    syncFromState,
    renderFieldSelects,
    initGeneExpressionDropdown,
    renderDeletedFieldsSection: () => {
      assertAlive();
      return deletedFieldsPanel.renderDeletedFieldsSection();
    },
    clearGeneSelection,
    updateFieldSelectDisabledStates
  };
}
