/**
 * @fileoverview Exact active-field serialization and restoration.
 *
 * @module state-serializer/active-fields
 */

import {
  assertExactKeys,
  assertNonEmptyString,
  requireMethod
} from '../session/schema-contract.js';

const ACTIVE_FIELD_KEYS = ['activeFieldKey', 'activeFieldSource'];

function assertFieldInventory(fields, context) {
  if (!Array.isArray(fields)) {
    throw new TypeError(`${context} must be an array.`);
  }
  const keys = new Set();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === null || typeof field !== 'object') {
      throw new TypeError(`${context} entry ${index} must be an object.`);
    }
    const key = assertNonEmptyString(field.key, `${context} entry ${index} key`);
    if (keys.has(key)) {
      throw new TypeError(`${context} contains duplicate key "${key}".`);
    }
    keys.add(key);
  }
  return fields;
}

export function assertActiveFieldsState(activeFields) {
  assertExactKeys(activeFields, ACTIVE_FIELD_KEYS, 'Active-field session state');
  const source = activeFields.activeFieldSource;
  const key = activeFields.activeFieldKey;
  if (source === null) {
    if (key !== null) {
      throw new TypeError('Active-field key must be null when its source is null.');
    }
    return activeFields;
  }
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError('Active-field source must be "obs", "var", or null.');
  }
  assertNonEmptyString(key, 'Active-field key');
  return activeFields;
}

function getExactCurrentActiveField(state, context) {
  requireMethod(state, 'getFields', context);
  requireMethod(state, 'getVarFields', context);
  const obsFields = assertFieldInventory(
    state.getFields(),
    'Current obs field inventory'
  );
  const varFields = assertFieldInventory(
    state.getVarFields(),
    'Current var field inventory'
  );
  const source = state.activeFieldSource;
  if (source === null) {
    if (state.activeFieldIndex !== -1 || state.activeVarFieldIndex !== -1) {
      throw new TypeError(
        'Inactive current field indexes must both equal -1.'
      );
    }
    return { source, field: null, obsFields };
  }
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError('Current active-field source is unsupported.');
  }
  const fieldIndex = source === 'obs'
    ? state.activeFieldIndex
    : state.activeVarFieldIndex;
  const inactiveIndex = source === 'obs'
    ? state.activeVarFieldIndex
    : state.activeFieldIndex;
  if (!Number.isSafeInteger(fieldIndex) || fieldIndex < 0) {
    throw new TypeError('Current active-field index must be a nonnegative safe integer.');
  }
  if (inactiveIndex !== -1) {
    throw new TypeError('Current inactive field index must equal -1.');
  }
  const fields = source === 'obs' ? obsFields : varFields;
  if (fieldIndex >= fields.length) {
    throw new RangeError('Current active-field index is out of range.');
  }
  const field = fields[fieldIndex];
  if (field._isDeleted === true) {
    throw new TypeError('Current active field must not be deleted.');
  }
  return { source, field, obsFields };
}

export function serializeActiveFields(state) {
  const {
    field: activeField,
    source: activeFieldSource
  } = getExactCurrentActiveField(state, 'Active-field capture owner');
  if (activeField === null) {
    return assertActiveFieldsState({
      activeFieldKey: null,
      activeFieldSource: null
    });
  }
  return assertActiveFieldsState({
    activeFieldKey: assertNonEmptyString(
      activeField.key,
      'Captured active-field key'
    ),
    activeFieldSource: activeFieldSource
  });
}

/**
 * Restore one exact active field selection.
 * @param {object} state
 * @param {unknown} activeFields
 */
export async function restoreActiveFields(state, activeFields) {
  const plan = validateActiveFieldsForState(state, activeFields);

  if (plan.source === null) {
    state.clearActiveField();
    return;
  }

  if (plan.source === 'obs') {
    await state.ensureFieldLoaded(plan.fieldIndex);
    const result = state.setActiveField(plan.fieldIndex);
    if (result === null) {
      throw new Error(`DataState rejected active obs field "${plan.field.key}".`);
    }
    return;
  }

  await state.ensureVarFieldLoaded(plan.fieldIndex);
  const result = state.setActiveVarField(plan.fieldIndex);
  if (result === null) {
    throw new Error(`DataState rejected active var field "${plan.field.key}".`);
  }
}

export function validateActiveFieldsForState(state, activeFields) {
  assertActiveFieldsState(activeFields);
  requireMethod(state, 'getFields', 'Active-field restore owner');
  requireMethod(state, 'getVarFields', 'Active-field restore owner');

  const obsFields = assertFieldInventory(
    state.getFields(),
    'Current obs field inventory'
  );
  const varFields = assertFieldInventory(
    state.getVarFields(),
    'Current var field inventory'
  );

  if (activeFields.activeFieldSource === null) {
    requireMethod(state, 'clearActiveField', 'Active-field restore owner');
    return { source: null, fieldIndex: null, field: null };
  }

  const fields = activeFields.activeFieldSource === 'obs'
    ? obsFields
    : varFields;
  const fieldIndex = fields.findIndex(
    field => (
      field.key === activeFields.activeFieldKey
      && field._isDeleted !== true
    )
  );
  if (fieldIndex < 0) {
    throw new RangeError(
      `Current field "${activeFields.activeFieldKey}" was not found for source "${activeFields.activeFieldSource}".`
    );
  }

  const field = fields[fieldIndex];
  if (field.kind !== 'category' && field.kind !== 'continuous') {
    throw new TypeError(
      `Current field "${field.key}" has unsupported kind "${String(field.kind)}".`
    );
  }

  if (activeFields.activeFieldSource === 'obs') {
    requireMethod(state, 'ensureFieldLoaded', 'Active-field restore owner');
    requireMethod(state, 'setActiveField', 'Active-field restore owner');
    return { source: 'obs', fieldIndex, field };
  }

  requireMethod(state, 'ensureVarFieldLoaded', 'Active-field restore owner');
  requireMethod(state, 'setActiveVarField', 'Active-field restore owner');
  return { source: 'var', fieldIndex, field };
}

function requireControl(id) {
  const control = document.getElementById(id);
  if (control === null) {
    throw new TypeError(`Active-field UI requires current control "${id}".`);
  }
  return control;
}

/**
 * Sync the current active field to the three domain-owned controls.
 * @param {object} state
 */
export function syncFieldSelectsToActiveField(state) {
  const {
    field: activeField,
    source: activeFieldSource,
    obsFields: fields
  } = getExactCurrentActiveField(state, 'Active-field UI sync owner');

  const categoricalSelect = requireControl('categorical-field');
  const continuousSelect = requireControl('continuous-field');
  const geneSearch = requireControl('gene-expression-search');

  if (activeField === null) {
    if (activeFieldSource !== null) {
      throw new TypeError('DataState active-field source must be null when no field is active.');
    }
    categoricalSelect.value = '-1';
    continuousSelect.value = '-1';
    geneSearch.value = '';
    return;
  }
  const key = assertNonEmptyString(activeField.key, 'Current active-field key');

  if (activeFieldSource === 'var') {
    categoricalSelect.value = '-1';
    continuousSelect.value = '-1';
    geneSearch.value = key;
    return;
  }
  if (activeFieldSource !== 'obs') {
    throw new TypeError('DataState active-field source must be "obs", "var", or null.');
  }

  const fieldIndex = fields.findIndex(
    field => field.key === key && field._isDeleted !== true
  );
  if (fieldIndex < 0) {
    throw new RangeError(`Current active obs field "${key}" was not found.`);
  }
  if (activeField.kind === 'category') {
    categoricalSelect.value = String(fieldIndex);
    continuousSelect.value = '-1';
  } else if (activeField.kind === 'continuous') {
    categoricalSelect.value = '-1';
    continuousSelect.value = String(fieldIndex);
  } else {
    throw new TypeError(`Current active field "${key}" has an unsupported kind.`);
  }
  geneSearch.value = '';
}
