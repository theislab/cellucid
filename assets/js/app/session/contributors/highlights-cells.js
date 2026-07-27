/**
 * @fileoverview Exact highlight-group cell membership session contributor.
 *
 * @module session/contributors/highlights-cells
 */

import { encodeDeltaUvarint, decodeDeltaUvarint } from '../codecs/delta-varint.js';
import {
  assertArray,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from '../schema-contract.js';
import {
  HIGHLIGHT_RESTORE_TRANSACTION_ID
} from './highlights-meta.js';

export const id = 'highlights-cells';
const CHUNK_PREFIX = 'highlights/cells/';
const CHUNK_META_KEYS = Object.freeze([
  'id',
  'contributorId',
  'priority',
  'kind',
  'codec',
  'label',
  'datasetDependent',
  'storedBytes',
  'uncompressedBytes'
]);

function getState(ctx, operation) {
  if (
    ctx === null
    || typeof ctx !== 'object'
    || ctx.state === null
    || typeof ctx.state !== 'object'
  ) {
    throw new TypeError(`Highlight cells ${operation} requires the current DataState owner.`);
  }
  return ctx.state;
}

function assertGroupId(groupId, context) {
  const value = assertNonEmptyString(groupId, context);
  if (!/^highlight_[1-9]\d*$/.test(value)) {
    throw new TypeError(`${context} must use the current highlight identity.`);
  }
  return value;
}

function getRestoreTransaction(ctx) {
  if (
    ctx === null
    || typeof ctx !== 'object'
    || ctx.restoreTransaction === null
    || typeof ctx.restoreTransaction !== 'object'
  ) {
    throw new TypeError(
      'Highlight cells restore requires the current session restore transaction.'
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

function requireStagedHighlightState(value, state) {
  assertPlainRecord(value, 'Staged highlight restore state');
  assertExactKeys(
    value,
    [
      'state',
      'pointCount',
      'pages',
      'groupById',
      'expectedCellGroupIds',
      'receivedCellGroupIds',
      'nextCellIndex'
    ],
    'Staged highlight restore state'
  );
  if (value.state !== state) {
    throw new TypeError(
      'Staged highlight restore state belongs to a different DataState owner.'
    );
  }
  assertSafeInteger(
    value.pointCount,
    'Staged highlight restore pointCount',
    { minimum: 1 }
  );
  assertArray(value.pages, 'Staged highlight restore pages');
  if (!(value.groupById instanceof Map)) {
    throw new TypeError('Staged highlight restore group inventory must be a Map.');
  }
  assertArray(
    value.expectedCellGroupIds,
    'Staged highlight restore expected cell groups'
  );
  if (!(value.receivedCellGroupIds instanceof Set)) {
    throw new TypeError(
      'Staged highlight restore received cell groups must be a Set.'
    );
  }
  assertSafeInteger(
    value.nextCellIndex,
    'Staged highlight restore next cell index'
  );
  return value;
}

export function capture(ctx) {
  const state = getState(ctx, 'capture');
  requireMethod(state, 'getHighlightPages', 'Highlight cells capture owner');
  const pointCount = assertSafeInteger(
    state.pointCount,
    'Highlight cells dataset pointCount'
  );
  const pages = assertArray(
    state.getHighlightPages(),
    'Current highlight pages'
  );
  const groupIds = new Set();
  const chunks = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === null || typeof page !== 'object') {
      throw new TypeError(`Current highlight page ${pageIndex} must be an object.`);
    }
    const groups = assertArray(
      page.highlightedGroups,
      `Current highlight page ${pageIndex} groups`
    );
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      if (group === null || typeof group !== 'object') {
        throw new TypeError(`Current highlight group ${pageIndex}:${groupIndex} must be an object.`);
      }
      const groupId = assertGroupId(
        group.id,
        `Current highlight group ${pageIndex}:${groupIndex} id`
      );
      if (groupIds.has(groupId)) {
        throw new TypeError(`Current highlight group id "${groupId}" is duplicated.`);
      }
      groupIds.add(groupId);
      const label = assertNonEmptyString(
        group.label,
        `Current highlight group "${groupId}" label`
      );
      const indices = group.cellIndices;
      if (
        indices === null
        || typeof indices !== 'object'
        || !Number.isSafeInteger(indices.length)
        || indices.length < 0
      ) {
        throw new TypeError(`Current highlight group "${groupId}" requires cellIndices.`);
      }
      if (indices.length > pointCount) {
        throw new RangeError(`Current highlight group "${groupId}" exceeds dataset pointCount.`);
      }
      if (indices.length === 0) continue;

      chunks.push({
        id: `${CHUNK_PREFIX}${groupId}`,
        contributorId: id,
        priority: 'lazy',
        kind: 'binary',
        codec: 'gzip',
        label: `Highlight cells: ${label}`,
        datasetDependent: true,
        payload: encodeDeltaUvarint(indices)
      });
    }
  }

  return chunks;
}

export async function restore(ctx, chunkMeta, payload) {
  const state = getState(ctx, 'restore');
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('Highlight cells payload must be a Uint8Array.');
  }
  assertExactKeys(
    chunkMeta,
    CHUNK_META_KEYS,
    'Highlight cells chunk metadata'
  );
  if (chunkMeta.contributorId !== id) {
    throw new TypeError(
      `Highlight cells contributorId must equal "${id}".`
    );
  }
  if (
    chunkMeta.priority !== 'lazy'
    || chunkMeta.kind !== 'binary'
    || chunkMeta.codec !== 'gzip'
    || chunkMeta.datasetDependent !== true
  ) {
    throw new TypeError(
      'Highlight cells chunks must be lazy, binary, gzip, and dataset-dependent.'
    );
  }
  const chunkId = assertNonEmptyString(
    chunkMeta.id,
    'Highlight cells chunk id'
  );
  if (!chunkId.startsWith(CHUNK_PREFIX)) {
    throw new TypeError(`Highlight cells chunk id must start with "${CHUNK_PREFIX}".`);
  }
  const groupId = assertGroupId(
    chunkId.slice(CHUNK_PREFIX.length),
    'Highlight cells chunk group id'
  );
  const pointCount = assertSafeInteger(
    state.pointCount,
    'Highlight cells dataset pointCount',
    { minimum: 1 }
  );
  const restoreTransaction = getRestoreTransaction(ctx);
  const stagedState = requireStagedHighlightState(
    restoreTransaction.get(HIGHLIGHT_RESTORE_TRANSACTION_ID),
    state
  );
  if (stagedState.pointCount !== pointCount) {
    throw new Error(
      'Highlight dataset pointCount changed during session restore.'
    );
  }
  if (stagedState.nextCellIndex >= stagedState.expectedCellGroupIds.length) {
    throw new RangeError(
      `Highlight group "${groupId}" has no expected cell membership chunk.`
    );
  }
  const expectedGroupId =
    stagedState.expectedCellGroupIds[stagedState.nextCellIndex];
  if (groupId !== expectedGroupId) {
    throw new RangeError(
      `Highlight cell membership chunk "${groupId}" is out of order; `
      + `expected "${expectedGroupId}".`
    );
  }
  if (stagedState.receivedCellGroupIds.has(groupId)) {
    throw new TypeError(
      `Highlight group "${groupId}" cell membership is duplicated.`
    );
  }
  const targetGroup = stagedState.groupById.get(groupId);
  if (targetGroup === undefined) {
    throw new RangeError(
      `Highlight group "${groupId}" was not found in staged metadata.`
    );
  }
  const groupLabel = assertNonEmptyString(
    targetGroup.label,
    `Highlight group "${groupId}" label`
  );
  if (chunkMeta.label !== `Highlight cells: ${groupLabel}`) {
    throw new TypeError(
      `Highlight cells chunk label must match group "${groupId}".`
    );
  }
  assertSafeInteger(
    chunkMeta.storedBytes,
    'Highlight cells chunk storedBytes'
  );
  const uncompressedBytes = assertSafeInteger(
    chunkMeta.uncompressedBytes,
    'Highlight cells chunk uncompressedBytes'
  );
  if (uncompressedBytes !== payload.byteLength) {
    throw new RangeError(
      'Highlight cells payload length must equal metadata uncompressedBytes.'
    );
  }
  const expectedCellCount = assertSafeInteger(
    targetGroup.cellCount,
    `Highlight group "${groupId}" cellCount`,
    { minimum: 1, maximum: pointCount }
  );

  const signal = ctx.abortSignal;
  if (
    signal !== null
    && (
      typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError('Highlight cells abortSignal must be an AbortSignal or null.');
  }
  const decoded = await decodeDeltaUvarint(payload, {
    maxCount: pointCount,
    maxIndex: pointCount - 1,
    signal
  });
  if (decoded.length !== expectedCellCount) {
    throw new RangeError(
      `Highlight group "${groupId}" decoded cell count does not match metadata.`
    );
  }

  targetGroup.cellIndices = decoded;
  stagedState.receivedCellGroupIds.add(groupId);
  stagedState.nextCellIndex += 1;
}
