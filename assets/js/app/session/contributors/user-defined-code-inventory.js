/**
 * @fileoverview Shared exact inventory rules for user-defined code chunks.
 *
 * The field-overlay contributor owns the expected categorical inventory while
 * the binary-code contributor owns each payload. Both use this module to
 * derive the one truthful eager/lazy split from the restored active fields.
 */

import {
  assertNonEmptyString,
  assertSafeInteger
} from '../schema-contract.js';

export const USER_DEFINED_CODES_RESTORE_TRANSACTION_ID =
  'field-overlays/state';

function addCriticalField(ids, field, context) {
  if (field === null) return;
  if (field === undefined || typeof field !== 'object') {
    throw new TypeError(`${context} must be an object or null.`);
  }
  if (field._isUserDefined !== true) return;
  if (field.kind !== 'category') {
    if (field.kind !== 'continuous') {
      throw new TypeError(`${context} has unsupported kind.`);
    }
    return;
  }
  ids.add(
    assertNonEmptyString(
      field._userDefinedId,
      `${context} user-defined id`
    )
  );
}

function getExactActiveField(owner, context) {
  const source = owner.activeFieldSource;
  if (source === null) {
    if (owner.activeFieldIndex !== -1 || owner.activeVarFieldIndex !== -1) {
      throw new TypeError(
        `${context} inactive field indexes must both equal -1.`
      );
    }
    return null;
  }
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError(`${context} has unsupported activeFieldSource.`);
  }
  const fieldIndex = source === 'obs'
    ? owner.activeFieldIndex
    : owner.activeVarFieldIndex;
  const inactiveIndex = source === 'obs'
    ? owner.activeVarFieldIndex
    : owner.activeFieldIndex;
  assertSafeInteger(fieldIndex, `${context} active field index`);
  if (inactiveIndex !== -1) {
    throw new TypeError(`${context} inactive field index must equal -1.`);
  }
  const data = source === 'obs' ? owner.obsData : owner.varData;
  if (data === null || typeof data !== 'object' || !Array.isArray(data.fields)) {
    throw new TypeError(`${context} requires its active field inventory.`);
  }
  if (fieldIndex >= data.fields.length) {
    throw new RangeError(`${context} active field index is out of range.`);
  }
  const field = data.fields[fieldIndex];
  if (field === null || typeof field !== 'object') {
    throw new TypeError(`${context} active field must be an object.`);
  }
  return field;
}

export function getCriticalUserDefinedFieldIds(state) {
  if (!(state.viewContexts instanceof Map)) {
    throw new TypeError(
      'User-defined codes require the current viewContexts Map.'
    );
  }
  const ids = new Set();
  addCriticalField(
    ids,
    getExactActiveField(state, 'Current field state'),
    'Current active field'
  );

  for (const [viewId, context] of state.viewContexts) {
    const exactViewId = assertNonEmptyString(viewId, 'Snapshot view id');
    if (context === null || typeof context !== 'object') {
      throw new TypeError(
        `Snapshot view "${exactViewId}" context must be an object.`
      );
    }
    addCriticalField(
      ids,
      getExactActiveField(context, `Snapshot view "${exactViewId}"`),
      `Snapshot view "${exactViewId}" active field`
    );
  }
  return ids;
}
