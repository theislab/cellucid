/**
 * @fileoverview Exact highlight page/group metadata session contributor.
 *
 * Cell membership remains in the highlights-cells contributor.
 *
 * @module session/contributors/highlights-meta
 */

import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertFiniteNumber,
  assertNonEmptyString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from '../schema-contract.js';

export const id = 'highlights-meta';
export const HIGHLIGHT_RESTORE_TRANSACTION_ID = 'highlight-state';

const PAGE_KEYS = ['id', 'name', 'color', 'highlightedGroups'];
const DIRECT_GROUP_KEYS = [
  'id',
  'type',
  'label',
  'enabled',
  'cellCount'
];
const FIELD_GROUP_KEYS = [
  ...DIRECT_GROUP_KEYS,
  'fieldKey',
  'fieldIndex',
  'fieldSource'
];
const CATEGORY_GROUP_KEYS = [
  ...FIELD_GROUP_KEYS,
  'categoryIndex',
  'categoryName'
];
const RANGE_GROUP_KEYS = [
  ...FIELD_GROUP_KEYS,
  'rangeMin',
  'rangeMax'
];
const GROUP_TYPES = new Set([
  'annotation',
  'category',
  'combined',
  'knn',
  'lasso',
  'proximity',
  'range'
]);

function assertPageColor(value, context) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new TypeError(`${context} must be a six-digit hex color.`);
  }
  return value;
}

function assertCategoryPrimitive(value, context) {
  if (
    typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new TypeError(
    `${context} must be a string, finite number, or boolean.`
  );
}

function numericSuffix(idValue, prefix, context) {
  const idString = assertNonEmptyString(idValue, context);
  const match = new RegExp(`^${prefix}([1-9]\\d*)$`).exec(idString);
  if (match === null) {
    throw new TypeError(`${context} must use the current "${prefix}<positive integer>" identity.`);
  }
  return assertSafeInteger(Number(match[1]), `${context} numeric suffix`, {
    minimum: 1
  });
}

function groupKeys(type, context) {
  if (type === 'category') return CATEGORY_GROUP_KEYS;
  if (type === 'range') return RANGE_GROUP_KEYS;
  if (
    type === 'annotation'
    || type === 'combined'
    || type === 'knn'
    || type === 'lasso'
    || type === 'proximity'
  ) {
    return DIRECT_GROUP_KEYS;
  }
  throw new TypeError(`${context} has unsupported type.`);
}

function serializeGroup(group, pointCount, context) {
  assertPlainRecord(group, context);
  const keys = groupKeys(group.type, context);
  assertExactKeys(group, [...keys, 'cellIndices'], context);
  if (
    group.cellIndices === null
    || group.cellIndices === undefined
    || !Number.isSafeInteger(group.cellIndices.length)
    || group.cellIndices.length < 0
  ) {
    throw new TypeError(`${context} requires an exact cellIndices collection.`);
  }
  const payload = Object.fromEntries(keys.map(key => [key, group[key]]));
  assertGroup(payload, pointCount, context);
  if (payload.cellCount !== group.cellIndices.length) {
    throw new RangeError(`${context} cellCount does not match cellIndices.`);
  }
  return payload;
}

function assertGroup(group, pointCount, context) {
  assertPlainRecord(group, context);
  assertExactKeys(group, groupKeys(group.type, context), context);
  numericSuffix(group.id, 'highlight_', `${context} id`);
  if (!GROUP_TYPES.has(group.type)) throw new TypeError(`${context} has unsupported type.`);
  assertNonEmptyString(group.label, `${context} label`);
  assertBoolean(group.enabled, `${context} enabled`);
  const cellCount = assertSafeInteger(
    group.cellCount,
    `${context} cellCount`,
    { minimum: 1 }
  );
  if (cellCount > pointCount) {
    throw new RangeError(`${context} cellCount exceeds the current dataset.`);
  }

  if (group.type === 'category') {
    assertNonEmptyString(group.fieldKey, `${context} fieldKey`);
    assertSafeInteger(group.fieldIndex, `${context} fieldIndex`);
    if (group.fieldSource !== 'obs' && group.fieldSource !== 'var') {
      throw new TypeError(`${context} fieldSource must be "obs" or "var".`);
    }
    assertSafeInteger(group.categoryIndex, `${context} categoryIndex`);
    assertCategoryPrimitive(group.categoryName, `${context} categoryName`);
  } else if (group.type === 'range') {
    assertNonEmptyString(group.fieldKey, `${context} fieldKey`);
    assertSafeInteger(group.fieldIndex, `${context} fieldIndex`);
    if (group.fieldSource !== 'obs' && group.fieldSource !== 'var') {
      throw new TypeError(`${context} fieldSource must be "obs" or "var".`);
    }
    assertFiniteNumber(group.rangeMin, `${context} rangeMin`);
    assertFiniteNumber(group.rangeMax, `${context} rangeMax`);
    if (group.rangeMin > group.rangeMax) {
      throw new RangeError(`${context} rangeMin must not exceed rangeMax.`);
    }
  }
}

function assertPayload(payload, pointCount) {
  assertExactKeys(payload, ['pages', 'activePageId'], 'Highlight metadata payload');
  assertArray(payload.pages, 'Highlight metadata pages');
  if (payload.pages.length === 0) {
    throw new TypeError('Highlight metadata must contain the current nonempty page inventory.');
  }
  const pageIds = new Set();
  const groupIds = new Set();
  for (let pageIndex = 0; pageIndex < payload.pages.length; pageIndex++) {
    const page = payload.pages[pageIndex];
    const context = `Highlight page ${pageIndex}`;
    assertExactKeys(page, PAGE_KEYS, context);
    numericSuffix(page.id, 'page_', `${context} id`);
    if (pageIds.has(page.id)) {
      throw new TypeError(`Highlight page id "${page.id}" is duplicated.`);
    }
    pageIds.add(page.id);
    assertNonEmptyString(page.name, `${context} name`);
    assertPageColor(page.color, `${context} color`);
    assertArray(page.highlightedGroups, `${context} highlightedGroups`);
    for (let groupIndex = 0; groupIndex < page.highlightedGroups.length; groupIndex++) {
      const group = page.highlightedGroups[groupIndex];
      assertGroup(group, pointCount, `${context} group ${groupIndex}`);
      if (groupIds.has(group.id)) {
        throw new TypeError(`Highlight group id "${group.id}" is duplicated.`);
      }
      groupIds.add(group.id);
    }
  }
  assertNonEmptyString(payload.activePageId, 'Highlight metadata activePageId');
  if (!pageIds.has(payload.activePageId)) {
    throw new RangeError(
      `Highlight metadata activePageId "${payload.activePageId}" is not in the current page inventory.`
    );
  }
}

function getState(ctx, operation) {
  if (
    ctx === null
    || typeof ctx !== 'object'
    || ctx.state === null
    || typeof ctx.state !== 'object'
  ) {
    throw new TypeError(`Highlight metadata ${operation} requires the current DataState owner.`);
  }
  return ctx.state;
}

function getRestoreTransaction(ctx) {
  if (
    ctx === null
    || typeof ctx !== 'object'
    || ctx.restoreTransaction === null
    || typeof ctx.restoreTransaction !== 'object'
  ) {
    throw new TypeError(
      'Highlight metadata restore requires the current session restore transaction.'
    );
  }
  for (const methodName of ['register', 'get', 'commit', 'rollback']) {
    requireMethod(
      ctx.restoreTransaction,
      methodName,
      'Highlight session restore transaction'
    );
  }
  return ctx.restoreTransaction;
}

export function capture(ctx) {
  const state = getState(ctx, 'capture');
  requireMethod(state, 'getHighlightPages', 'Highlight metadata capture owner');
  requireMethod(state, 'getActivePageId', 'Highlight metadata capture owner');
  const pointCount = assertSafeInteger(
    state.pointCount,
    'Highlight metadata dataset pointCount'
  );
  const pages = assertArray(
    state.getHighlightPages(),
    'Current highlight pages'
  );
  const payload = {
    pages: pages.map((page, pageIndex) => {
      if (page === null || typeof page !== 'object') {
        throw new TypeError(`Current highlight page ${pageIndex} must be an object.`);
      }
      const groups = assertArray(
        page.highlightedGroups,
        `Current highlight page ${pageIndex} groups`
      );
      return {
        id: page.id,
        name: page.name,
        color: page.color,
        highlightedGroups: groups.map((group, groupIndex) => (
          serializeGroup(
            group,
            pointCount,
            `Current highlight page ${pageIndex} group ${groupIndex}`
          )
        ))
      };
    }),
    activePageId: state.getActivePageId()
  };
  assertPayload(payload, pointCount);

  return [{
    id: 'highlights/meta',
    contributorId: id,
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Highlight metadata',
    datasetDependent: true,
    payload
  }];
}

export function restore(ctx, chunkMeta, payload) {
  const state = getState(ctx, 'restore');
  requireMethod(state, '_recomputeHighlightArray', 'Highlight metadata restore owner');
  requireMethod(state, '_notifyHighlightPageChange', 'Highlight metadata restore owner');
  requireMethod(state, '_notifyHighlightChange', 'Highlight metadata restore owner');
  const pointCount = assertSafeInteger(
    state.pointCount,
    'Highlight metadata dataset pointCount'
  );
  assertPayload(payload, pointCount);
  if (
    chunkMeta === null
    || typeof chunkMeta !== 'object'
    || chunkMeta.id !== 'highlights/meta'
  ) {
    throw new TypeError(
      'Highlight metadata restore requires the exact "highlights/meta" chunk.'
    );
  }
  const restoreTransaction = getRestoreTransaction(ctx);
  const previousState = {
    highlightPages: assertArray(
      state.highlightPages,
      'Current highlight page inventory'
    ),
    activePageId: assertNonEmptyString(
      state.activePageId,
      'Current active highlight page id'
    ),
    highlightPageIdCounter: assertSafeInteger(
      state._highlightPageIdCounter,
      'Current highlight page id counter'
    ),
    highlightIdCounter: assertSafeInteger(
      state._highlightIdCounter,
      'Current highlight id counter'
    )
  };

  let maxPageCounter = 0;
  let maxGroupCounter = 0;
  const groupById = new Map();
  const expectedCellGroupIds = [];
  const restoredPages = payload.pages.map((page, pageIndex) => {
    maxPageCounter = Math.max(
      maxPageCounter,
      numericSuffix(page.id, 'page_', `Highlight page ${pageIndex} id`)
    );
    return {
      id: page.id,
      name: page.name,
      color: page.color,
      highlightedGroups: page.highlightedGroups.map((group, groupIndex) => {
        maxGroupCounter = Math.max(
          maxGroupCounter,
          numericSuffix(
            group.id,
            'highlight_',
            `Highlight page ${pageIndex} group ${groupIndex} id`
          )
        );
        const restoredGroup = {
          ...group,
          cellIndices: new Uint32Array(0)
        };
        groupById.set(restoredGroup.id, restoredGroup);
        expectedCellGroupIds.push(restoredGroup.id);
        return restoredGroup;
      })
    };
  });
  const stagedState = {
    state,
    pointCount,
    pages: restoredPages,
    groupById,
    expectedCellGroupIds,
    receivedCellGroupIds: new Set(),
    nextCellIndex: 0
  };
  let applied = false;
  restoreTransaction.register(
    HIGHLIGHT_RESTORE_TRANSACTION_ID,
    {
      value: stagedState,
      prepare() {
        if (
          state.highlightPages !== previousState.highlightPages
          || state.activePageId !== previousState.activePageId
          || state._highlightPageIdCounter
            !== previousState.highlightPageIdCounter
          || state._highlightIdCounter !== previousState.highlightIdCounter
        ) {
          throw new Error(
            'Highlight state changed while its session restore was staged.'
          );
        }
        if (
          stagedState.nextCellIndex !== expectedCellGroupIds.length
          || stagedState.receivedCellGroupIds.size
            !== expectedCellGroupIds.length
        ) {
          throw new Error(
            'Highlight session restore is missing exact cell membership chunks.'
          );
        }
        for (const groupId of expectedCellGroupIds) {
          const group = groupById.get(groupId);
          if (
            !stagedState.receivedCellGroupIds.has(groupId)
            || !(group.cellIndices instanceof Uint32Array)
            || group.cellIndices.length !== group.cellCount
          ) {
            throw new Error(
              `Highlight group "${groupId}" cell membership is incomplete.`
            );
          }
        }
      },
      commit() {
        applied = true;
        state.highlightPages = restoredPages;
        state.activePageId = payload.activePageId;
        state._highlightPageIdCounter = maxPageCounter;
        state._highlightIdCounter = maxGroupCounter;
        state._recomputeHighlightArray();
        state._notifyHighlightPageChange();
        state._notifyHighlightChange();
      },
      rollback() {
        if (!applied) return;
        state.highlightPages = previousState.highlightPages;
        state.activePageId = previousState.activePageId;
        state._highlightPageIdCounter =
          previousState.highlightPageIdCounter;
        state._highlightIdCounter = previousState.highlightIdCounter;
        applied = false;
        state._recomputeHighlightArray();
        state._notifyHighlightPageChange();
        state._notifyHighlightChange();
      }
    }
  );
}
