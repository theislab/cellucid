/**
 * @fileoverview The analysis panel docked in the sidebar: which analysis is
 * open, and every analysis's settings and result.
 *
 * Floating analysis windows are the analysis-windows contributor's. The
 * comparison module owns the docked panel and exports one record:
 * `{openMode: string|null, modes: {[mode]: {settings, result}}}`, where a
 * result is null or JSON values and typed numeric arrays (genes and
 * categories by key). It is stored as typed JSON (codecs/typed-json.js).
 *
 * @module session/contributors/analysis-docked
 */

import { decodeTypedJson, encodeTypedJson } from '../codecs/typed-json.js';
import { assertExactKeys, assertPlainRecord, requireMethod } from '../schema-contract.js';
import { getSessionRestoreSnapshot } from '../session-context.js';

export const id = 'analysis-docked';

function requireModule(ctx, methods) {
  const module = ctx?.comparisonModule;
  if (module === null || typeof module !== 'object') {
    throw new TypeError('Docked analysis session state requires the comparison module.');
  }
  for (const method of methods) requireMethod(module, method, 'Comparison module');
  return module;
}

function assertDockedState(value) {
  assertExactKeys(value, ['openMode', 'modes'], 'Docked analysis state');
  if (value.openMode !== null && (typeof value.openMode !== 'string' || value.openMode === '')) {
    throw new TypeError('Docked analysis openMode must be a mode id or null.');
  }
  assertPlainRecord(value.modes, 'Docked analysis modes');
  for (const [mode, record] of Object.entries(value.modes)) {
    assertExactKeys(record, ['settings', 'result'], `Docked analysis mode "${mode}"`);
  }
  if (value.openMode !== null && !Object.hasOwn(value.modes, value.openMode)) {
    throw new RangeError(`Docked analysis open mode "${value.openMode}" has no record.`);
  }
  return value;
}

export function capture(ctx) {
  const module = requireModule(ctx, ['exportSessionState']);
  const state = assertDockedState(module.exportSessionState());
  return [{
    id: 'analysis/docked',
    contributorId: id,
    priority: 'eager',
    kind: 'binary',
    codec: 'gzip',
    label: 'Docked analysis',
    datasetDependent: true,
    payload: encodeTypedJson(state)
  }];
}

export function restore(ctx, _chunkMeta, payload) {
  const module = requireModule(ctx, ['exportSessionState', 'importSessionState']);
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('Docked analysis payload must be typed JSON bytes.');
  }
  const state = assertDockedState(decodeTypedJson(payload));
  const restoreTransaction = ctx.restoreTransaction;
  if (restoreTransaction === null || typeof restoreTransaction !== 'object') {
    return module.importSessionState(state);
  }
  requireMethod(restoreTransaction, 'register', 'Docked analysis restore transaction');
  const shared = getSessionRestoreSnapshot(ctx, 'analysis/docked');
  const previous = assertDockedState(decodeTypedJson(
    shared === undefined ? capture(ctx)[0].payload : shared
  ));
  let applied = false;
  // Settings name highlight pages that later chunks stage and publish at
  // commit, so the panel is restored in the presentation stage.
  restoreTransaction.register('analysis-docked/state', {
    value: state,
    stage: 'presentation',
    prepare() {},
    async commit() {
      applied = true;
      await module.importSessionState(state);
    },
    async rollback() {
      if (!applied) return;
      await module.importSessionState(previous);
      applied = false;
    }
  });
}
