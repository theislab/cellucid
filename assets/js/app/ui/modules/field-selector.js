/**
 * @fileoverview Exact field-selection and field-operation UI contract.
 *
 * Owns the categorical/continuous observation selectors and coordinates the
 * gene-expression selector, deleted-fields panel, and category builder.
 *
 * @module ui/modules/field-selector
 */

import { getNotificationCenter } from '../../notification-center.js';
import { cancelled, isCancellation, throwIfAborted } from '../../../utils/abort.js';
import { InlineEditor } from '../components/inline-editor.js';
import { setControlAvailability } from '../core/control-availability.js';
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
import { annotationFieldKey } from '../../community-annotations/field-names.js';
import { quoteName } from '../../actions/targets/names.js';
import { ANNOTATION_CONNECTION_CHANGED_EVENT } from '../../community-annotations/connection-events.js';
import {
  createFieldInteractionOwner,
  describeUnshownField,
  unshownChoiceReason,
} from './field-interaction-owner.js';
import { useOpenCells } from '../../../data/open-cells-work.js';
import { requireExactKeys, requirePlainRecord } from '../../../utils/exact-record.js';
import { getActions } from '../../actions/index.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { markReported } from '../../../utils/errors.js';
import { requireNewName, resolveField } from '../../actions/targets/fields.js';
import { dispatchFromControl, isQuietFailure, reportActionFailure } from '../../actions/control-dispatch.js';

const NONE_FIELD_VALUE = '-1';
const INIT_KEYS = new Set(['state', 'dom', 'dataSourceManager', 'callbacks']);
const CALLBACK_KEYS = new Set(['onActiveFieldChanged', 'onChooseGeneNames', 'onGroupCategories']);
const DOM_TYPES = new Map([
  ['categoricalSelect', 'HTMLSelectElement'],
  ['categoricalCopyBtn', 'HTMLButtonElement'],
  ['categoricalGroupBtn', 'HTMLButtonElement'],
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
  'duplicateField',
  'ensureFieldLoaded',
  'getDatasetGeneration',
  'getFields',
  'getVarFields',
  'getVisibleFields',
  'setActiveField'
];

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
    'getCurrentIdentityId',
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
    categoricalGroupBtn,
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
  // The obs choice under way -- `field` null for no coloring -- from the
  // person's pick in a menu (`token` null while its action waits its turn:
  // `pickObsField`) or an action's start (`activateField`, with its choice's
  // token) until it ends. While it is the latest choice the menus name it and
  // are held: they render from it, not from what is shown, so a refresh under
  // way (the gene list read after the first view, an annotation change, a
  // field event) never puts back what the person just replaced. A gene
  // choice under way (`geneSelector.isChoosing`) shows no obs field.
  let obsChoice = null;
  // Session saves and restores holding the menus (`acquireSessionOperation`).
  let sessionHolds = 0;
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

  function readDatasetGeneration() {
    const generation = state.getDatasetGeneration();
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new TypeError(
        'Field selector dataset generation must be a non-negative safe integer'
      );
    }
    return generation;
  }

  /**
   * Take the generation of the cells open now as the one shown, without
   * retiring the choice under way. A choice calls it once it holds the open
   * cells (`useOpenCells`): the cells a progressive opening's step or Apply
   * grew or cut before it are the ones it is shown on, not a reason to drop
   * it (`synchronizeDatasetGeneration` would, at the next refresh).
   *
   * @returns {number}
   */
  function adoptDatasetGeneration() {
    const generation = readDatasetGeneration();
    if (generation !== adoptedDatasetGeneration) {
      closeTransientInteractions();
      adoptedDatasetGeneration = generation;
    }
    return generation;
  }

  function synchronizeDatasetGeneration() {
    const generation = readDatasetGeneration();
    if (generation !== adoptedDatasetGeneration) {
      closeTransientInteractions();
      interactionOwner.invalidate();
      adoptedDatasetGeneration = generation;
      obsChoice = null;
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
          annotationFieldKey(field)
        );
      }
    }

    categoricalCopyBtn.disabled = catDisabled;
    categoricalGroupBtn.disabled = catDisabled;
    categoricalRenameBtn.disabled = catDisabled || catVotingLocked;
    categoricalDeleteBtn.disabled = catDisabled || catVotingLocked;
    categoricalClearBtn.disabled = catDisabled;
    continuousCopyBtn.disabled = contDisabled;
    continuousRenameBtn.disabled = contDisabled;
    continuousDeleteBtn.disabled = contDisabled;
    continuousClearBtn.disabled = contDisabled;
  }

  /**
   * The obs choice under way while it is the latest (`obsChoice`), or null.
   * A pick waiting its turn is not shown while choices are refused (a
   * session being saved or restored refuses it when its turn comes), and a
   * choice whose field the menus no longer list is not shown.
   * @returns {{field: object|null, token: object|null}|null}
   */
  function obsChoiceUnderWay() {
    if (obsChoice === null) return null;
    const live = obsChoice.token === null
      ? !interactionOwner.isSuspended()
      : interactionOwner.isCurrent(obsChoice.token);
    if (!live) return null;
    if (obsChoice.field === null) return obsChoice;
    const listed = state.getVisibleFields(FieldSource.OBS)
      .some(({ field }) => field === obsChoice.field);
    return listed ? obsChoice : null;
  }

  function endObsChoice(token) {
    if (obsChoice !== null && obsChoice.token === token) obsChoice = null;
  }

  /** The menus are held while a session operation or any choice is under way. */
  function menusHeld() {
    return sessionHolds > 0
      || obsChoiceUnderWay() !== null
      || geneSelector.isChoosing();
  }

  function updateFieldSelectDisabledStates() {
    assertAlive();
    const held = menusHeld();
    const heldReason = 'a field, a gene or a session is being opened; try again once it has';
    setControlAvailability(categoricalSelect, held ? heldReason
      : !hasCategoricalFields ? 'this dataset has no categorical field' : null);
    setControlAvailability(continuousSelect, held ? heldReason
      : !hasContinuousFields ? 'this dataset has no continuous field' : null);
    updateFieldActionButtons();
    geneSelector.updateGeneActionButtons(held);
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
      && readAnnotationFlag('isFieldAnnotated', annotationFieldKey(field))
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
        void dispatchFromControl(
          'field.rename',
          { field: { source, key: field.key }, name: newName },
          { failure: 'Could not rename the field', category: 'filter' }
        ).then(done => {
          if (done?.outcome == null) return;
          getNotificationCenter().success(
            `Renamed to "${newName}"`,
            { category: 'filter', duration: 2000 }
          );
        });
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
      && readAnnotationFlag('isFieldAnnotated', annotationFieldKey(field))
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
      message: `Delete "${field.key}"? You can restore it from Deleted fields.`,
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
        void dispatchFromControl(
          'field.delete',
          { field: { source, key: field.key } },
          { failure: 'Could not delete the field', category: 'filter' }
        ).then(done => {
          if (done === null) return;
          getNotificationCenter().success(
            `Deleted "${field.key}"`,
            { category: 'filter', duration: 2500 }
          );
        });
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
    renderChoices();
  }

  /**
   * Name, in the menus and the gene search, the latest choice under way, or
   * else what is shown; hold them while a choice or a session operation is
   * under way. Every refresh of the menus ends here.
   */
  function renderChoices() {
    assertAlive();
    const { source, obsIdx } = requireActiveState();
    const choice = obsChoiceUnderWay();
    if (choice !== null) {
      geneSelector.clearLocalSelectionUI();
      if (choice.field === null) clearFieldSelections();
      else syncSelectsForField(readObsFields().indexOf(choice.field));
    } else if (geneSelector.isChoosing()) {
      clearFieldSelections();
      geneSelector.syncFromState();
    } else if (source === FieldSource.OBS) {
      geneSelector.clearLocalSelectionUI();
      syncSelectsForField(obsIdx);
      geneSelector.syncFromState();
    } else {
      clearFieldSelections();
      if (source === null) {
        geneSelector.clearLocalSelectionUI();
      }
      geneSelector.syncFromState();
    }
    updateFieldSelectDisabledStates();
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
          && readAnnotationFlag('isFieldAnnotated', annotationFieldKey(field))
        ) {
          annotationBadge = readAnnotationFlag('isFieldClosed', annotationFieldKey(field))
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
    syncFromState();

    if (fields.length === 0) {
      callbacks.onActiveFieldChanged({
        field: null,
        pointCount: 0,
        centroidInfo: ''
      });
    }
  }

  /**
   * Show obs field `idx` (-1 clears the coloring). A choice is work on the
   * open cells (`data/open-cells-work.js`): one made while a progressive
   * opening's step or Apply changes them starts on the cells after it, and
   * no change commits under it. Whatever keeps it from being shown is said
   * (`describeUnshownField`), except a newer choice, Cancel, or another
   * dataset.
   *
   * It is the implementation of the action `color.by` (`colorByAction`):
   * the controls dispatch the action, and `signal` is the action's.
   *
   * @param {number} idx
   * @param {{signal?: AbortSignal|null, onUnshown?: ((message: string) => void)|null}} [options] -
   *   `onUnshown` hears the sentence said when the field is not shown, its
   *   name marked as data (`quoteName`), so the action can refuse with it
   */
  function activateField(idx, { signal = null, onUnshown = null } = {}) {
    assertAlive();
    const index = requireSelectableIndex(idx, 'Field activation index');
    if (interactionOwner.isSuspended()) {
      // The selects are put back to what is shown when the suspension ends
      // (`acquireSessionOperation`'s release).
      const reason = interactionOwner.suspensionReason();
      const sentence = name => (index === -1
        ? `The coloring is not cleared: ${reason}. Clear it again when that has ended.`
        : describeUnshownField(name, reason));
      const key = index === -1 ? null : getFieldForSource(FieldSource.OBS, index).field.key;
      getNotificationCenter().info(sentence(key), { category: 'data' });
      onUnshown?.(sentence(key === null ? null : quoteName(key)));
      return Promise.resolve(null);
    }
    synchronizeDatasetGeneration();
    return interactionOwner.run(async token => {
      // The choice is named and the menus held at once, while the cells it
      // is read on settle and while it is read.
      obsChoice = {
        field: index === -1 ? null : getFieldForSource(FieldSource.OBS, index).field,
        token
      };
      renderChoices();
      try {
        return await useOpenCells(
          () => activateFieldOnOpenCells(index, token, onUnshown),
          token.signal
        );
      } finally {
        // Ended, however (shown, failed, a newer choice, Stop, a session
        // restore): the menus name the choices under way now, or what is shown.
        endObsChoice(token);
        if (!destroyed) renderChoices();
      }
    }, { signal });
  }

  async function activateFieldOnOpenCells(index, token, onUnshown) {
    const datasetGeneration = adoptDatasetGeneration();
    syncCommunityAnnotationCacheContext({ dataSourceManager });

    if (index === -1) {
      interactionOwner.assertCurrent(token);
      const cleared = requireFieldInfo(
        state.clearActiveField(),
        null,
        'Clear active field result'
      );
      endObsChoice(token);
      renderChoices();
      callbacks.onActiveFieldChanged(cleared);
      return cleared;
    }

    const { field } = getFieldForSource(FieldSource.OBS, index);
    try {
      await state.ensureFieldLoaded(index, {
        signal: token.signal
      });
      interactionOwner.assertCurrent(token);
      if (
        readDatasetGeneration() !== datasetGeneration
        || state.getFields()?.[index] !== field
      ) {
        throw cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.');
      }
      if (field.kind === 'category') {
        // The dataset-length part of the activation, in slices.
        await state.prepareCategoryFieldActivation(field, {
          signal: token.signal
        });
        interactionOwner.assertCurrent(token);
        if (
          readDatasetGeneration() !== datasetGeneration
          || state.getFields()?.[index] !== field
        ) {
          throw cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.');
        }
      }
      const info = requireFieldInfo(
        state.setActiveField(index),
        field,
        'Activate obs field result'
      );
      endObsChoice(token);
      renderChoices();
      callbacks.onActiveFieldChanged(info);
      return info;
    } catch (error) {
      // Ended unshown: the menus name what is shown again.
      endObsChoice(token);
      if (isCancellation(error)) {
        const reason = unshownChoiceReason(
          interactionOwner,
          token,
          error,
          readDatasetGeneration() === datasetGeneration
            ? 'the dataset\'s fields changed while it was read'
            : null
        );
        // Still the latest choice: the selects show what is shown again.
        if (interactionOwner.isCurrent(token)) syncFromState();
        if (reason !== null) {
          getNotificationCenter().info(describeUnshownField(field.key, reason), { category: 'data' });
          onUnshown?.(describeUnshownField(quoteName(field.key), reason));
        }
        return null;
      }
      if (!interactionOwner.isCurrent(token)) return null;
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
    }
  }

  /**
   * Duplicate a field and color by the copy (the toolbars' copy button),
   * as a step: the action `field.duplicate`, said while it runs.
   *
   * @param {'obs'|'var'} source
   * @param {number} index
   */
  function duplicateFieldAt(source, index) {
    assertAlive();
    const { field } = getFieldForSource(source, index);
    const notifications = getNotificationCenter();
    const notificationId = notifications.loading(
      `Duplicating "${field.key}"…`,
      { category: 'filter' }
    );
    void getActions().dispatch('field.duplicate', { field: { source, key: field.key } }).then(
      ({ outcome }) => {
        notifications.complete(notificationId, `Created "${outcome.name}"`, { announce: true });
      },
      error => {
        if (isQuietFailure(error)) {
          notifications.dismiss(notificationId);
          return;
        }
        notifications.dismiss(notificationId);
        reportActionFailure(error, { failure: 'Could not duplicate the field', category: 'filter' });
      }
    );
  }

  /**
   * Color the view in focus by the obs field `field` (null: by nothing) as the person picked
   * it in a menu or cleared it: the pick is the choice under way the menus
   * name and hold from now on, while its action waits its turn (a change of
   * the open cells under way first: `cells.open`) and runs.
   *
   * @param {object|null} field
   */
  function pickObsField(field) {
    const pick = { field, token: null };
    obsChoice = pick;
    renderChoices();
    void dispatchFromControl(
      'color.by',
      { field: field === null ? null : { source: FieldSource.OBS, key: field.key } },
      field === null
        ? { failure: 'Could not clear the field', category: 'filter' }
        : { failure: 'Could not load the field', category: 'data' }
    ).finally(() => {
      if (obsChoice === pick) obsChoice = null;
      if (!destroyed) renderChoices();
    });
  }

  /**
   * The action `color.by`: color by a field of the cells or a gene (named),
   * or by nothing (null), through this selector's own choice, so the selects
   * and the gene search name what is shown whoever chose it.
   */
  async function colorByAction({ field }, { signal }) {
    assertAlive();
    // A choice that ends unshown is refused with the sentence the person is
    // told, never answered with a bare null an agent takes for done (F95).
    // The person has heard all they need (that sentence, or nothing after
    // their own newer choice or Cancel), so the refusal is marked reported
    // and no control says it again.
    let unshown = null;
    const onUnshown = message => { unshown = message; };
    const refuseUnshown = name => {
      throwIfAborted(signal);
      throw markReported(new ActionRefused(
        unshown ?? (name === null
          ? 'The coloring is not cleared: another choice or Cancel ended it first.'
          : `${name} is not shown: another choice or Cancel ended it before it was shown.`),
        { code: 'not-shown', type: 'color.by' }
      ));
    };
    if (field === null) {
      const cleared = await activateField(-1, { signal, onUnshown });
      if (cleared === null) refuseUnshown(null);
      return { field: null };
    }
    const target = resolveField(state, field);
    const info = target.source === FieldSource.OBS
      ? await activateField(target.index, { signal, onUnshown })
      : await geneSelector.selectGene(target.index, { signal, onUnshown });
    if (info === null) refuseUnshown(quoteName(target.field.key));
    return { field: target.field.key, source: target.source, kind: target.field.kind };
  }

  /**
   * The action `field.duplicate`: copy a field (named) and color by the
   * copy; a categorical copy starts without community annotation voting.
   */
  async function duplicateAction({ field: ref, name }, { signal }) {
    assertAlive();
    const target = resolveField(state, ref);
    if (name !== undefined) requireNewName(state, target.source, name);
    // The copy is the latest choice: one under way ends, and a session or
    // another dataset taking over meanwhile leaves the copy unshown.
    const intent = interactionOwner.beginIntent();
    const result = requireDuplicateResult(
      // Stopped while the field is read, nothing is made.
      await state.duplicateField(target.source, target.index, name === undefined ? { signal } : { newKey: name, signal }),
      target.source,
      state
    );
    interactionOwner.assertIntentCurrent(intent);
    if (target.source === FieldSource.VAR) {
      geneSelector.initGeneExpressionDropdown();
      await geneSelector.selectGene(result.newFieldIndex, { signal });
      return { name: result.newKey };
    }
    renderFieldSelects();
    await activateField(result.newFieldIndex, { signal });
    if (target.field.kind === FieldKind.CATEGORY) {
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
    return { name: result.newKey };
  }

  /**
   * Why a field's name and categories cannot be edited now (community
   * annotation voting on it), or null: the field and category actions refuse
   * then, as the toolbar and the legend do.
   *
   * @param {'obs'|'var'} source
   * @param {object} field
   * @returns {string|null}
   */
  function fieldLock(source, field) {
    if (destroyed) return null;
    if (
      source === FieldSource.OBS
      && field.kind === FieldKind.CATEGORY
      && isCommunityAnnotationUiEnabled()
      && readAnnotationFlag('isFieldAnnotated', annotationFieldKey(field))
    ) {
      return `${quoteName(field.key)} cannot be edited while community annotation voting is enabled for it.`;
    }
    return null;
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
        // A gene choice started is the latest: an obs pick still waiting its
        // turn is replaced by it (its action is superseded).
        if (destroyed) return;
        if (requireBoolean(busy, 'Gene selector busy state')) {
          obsChoice = null;
          updateFieldSelectDisabledStates();
        } else {
          renderChoices();
        }
      },
      onActivateField: idx => activateField(idx),
      onAdoptDatasetGeneration: adoptDatasetGeneration,
      onChooseGeneNames: callbacks.onChooseGeneNames,
      onDuplicateField: duplicateFieldAt,
      onClearColoring: () => pickObsField(null)
    }
  });
  requireExactKeys(
    geneSelector,
    new Set([
      'clearGeneSelection',
      'clearLocalSelectionUI',
      'colorByGene',
      'destroy',
      'initGeneExpressionDropdown',
      'isChoosing',
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
    const enabled = readAnnotationFlag('isFieldAnnotated', annotationFieldKey(field));
    let releaseTransient = () => {};
    const closeDialog = showConfirmDialog({
      title: enabled
        ? 'Disable community annotation'
        : 'Enable community annotation',
      message: enabled
        ? `Disable annotation voting for "${field.key}"? (Votes remain in local storage.)`
        : `Enable annotation voting for "${field.key}"? You will see 🗳️ next to the field name and can click category labels to vote in a popup.`,
      confirmText: enabled ? 'Disable' : 'Enable',
      tone: 'primary',
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
          annotationSession.setFieldAnnotated(annotationFieldKey(field), !enabled),
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
      pickObsField(getFieldForSource(FieldSource.OBS, index).field);
    } else if (continuousSelect.value === NONE_FIELD_VALUE) {
      pickObsField(null);
    }
  }, { signal: lifecycle.signal });

  continuousSelect.addEventListener('change', () => {
    const index = parseSelectorIndex(
      continuousSelect.value,
      'Continuous field selection'
    );
    if (index >= 0) {
      pickObsField(getFieldForSource(FieldSource.OBS, index).field);
    } else if (categoricalSelect.value === NONE_FIELD_VALUE) {
      pickObsField(null);
    }
  }, { signal: lifecycle.signal });

  categoricalCopyBtn.addEventListener('click', () => {
    const index = parseSelectorIndex(categoricalSelect.value, 'Categorical duplicate selection');
    if (index >= 0) duplicateFieldAt(FieldSource.OBS, index);
  }, { signal: lifecycle.signal });
  // Group categories: a new field of groups of its categories (`group-categories-dialog.js`, `field.group`).
  categoricalGroupBtn.addEventListener('click', () => {
    const index = parseSelectorIndex(categoricalSelect.value, 'Categorical group selection');
    if (index >= 0) callbacks.onGroupCategories(index, categoricalGroupBtn);
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
    pickObsField(null);
  }, { signal: lifecycle.signal });

  continuousCopyBtn.addEventListener('click', () => {
    const index = parseSelectorIndex(continuousSelect.value, 'Continuous duplicate selection');
    if (index >= 0) duplicateFieldAt(FieldSource.OBS, index);
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
    pickObsField(null);
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

  // The orchestration above is the implementation of coloring and
  // duplicating, whoever asks: a control here, an agent, a notebook, a replay.
  const unprovideActions = [
    getActions().provide('color.by', colorByAction),
    getActions().provide('field.duplicate', duplicateAction),
  ];

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
      ...unprovideActions,
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
    obsChoice = null;
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
      ? interactionOwner.acquireRetiringSuspension('a saved view is being restored')
      : interactionOwner.acquireSuspension('the view is being saved');
    // A restore retires the choice under way, a pick waiting its turn too.
    if (retireCurrent) obsChoice = null;
    sessionHolds++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseOwner();
      sessionHolds--;
      if (destroyed) return;
      // A restore replaces the field inventory without a field event (a
      // user-defined field it brings back is new to the page), so the
      // selectors are rebuilt from the restored inventory before the active
      // field is synced into them. A capture changes no field.
      if (retireCurrent) {
        renderFieldSelects();
      } else {
        syncFromState();
      }
    };
    try {
      closeTransientInteractions();
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
    geneSelector.updateGeneActionButtons(menusHeld());
  }

  async function colorByGene(geneKey) {
    assertAlive();
    return geneSelector.colorByGene(geneKey);
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
    colorByGene,
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
    fieldLock,
    updateFieldSelectDisabledStates
  };
}
