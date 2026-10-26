/**
 * @fileoverview Session contributor: floating analysis windows.
 *
 * EAGER chunk (dataset-dependent), payload
 * `{windows: [{headerTitle, modeId, open, rect, z, result, settings}], sizes}`:
 * - reopen floating analysis windows, back to front, with their box, open
 *   state, layer, settings and result;
 * - restore the sizes remembered per analysis for new windows and expanded
 *   views (`sizes: {window, expandedView}`, shared/analysis-view-sizes.js).
 *
 * Uses the AnalysisWindowManager session API: exportSessionWindows(),
 * exportViewSizes(), importViewSizes(), closeAll() and
 * createFromSessionDescriptor().
 *
 * @module session/contributors/analysis-windows
 */

import {
  getSessionRestoreSnapshot
} from '../session-context.js';

import { decodeTypedJson, encodeTypedJson } from '../codecs/typed-json.js';
import { isPlainRecord } from '../../../utils/exact-record.js';

export const id = 'analysis-windows';

function requireManager(ctx, methods) {
  const manager = ctx?.analysisWindowManager;
  if (
    manager === null ||
    typeof manager !== 'object' ||
    methods.some(method => typeof manager[method] !== 'function')
  ) {
    throw new TypeError(
      `analysisWindowManager must implement ${methods.join('() and ')}()`
    );
  }
  return manager;
}

function requireRestorePayload(payload) {
  if (
    !isPlainRecord(payload) ||
    Object.keys(payload).length !== 2 ||
    !Object.hasOwn(payload, 'windows') ||
    !Object.hasOwn(payload, 'sizes')
  ) {
    throw new TypeError(
      'Analysis-window restore payload must contain exactly: sizes, windows'
    );
  }
  if (!Array.isArray(payload.windows)) {
    throw new TypeError('Analysis-window restore payload windows must be an array');
  }
  if (!isPlainRecord(payload.sizes)) {
    throw new TypeError('Analysis-window restore payload sizes must be an object');
  }
  return structuredClone({ windows: payload.windows, sizes: payload.sizes });
}

/**
 * Capture all floating analysis windows.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const mgr = requireManager(ctx, ['exportSessionWindows', 'exportViewSizes']);
  const exportedWindows = mgr.exportSessionWindows();
  if (!Array.isArray(exportedWindows)) {
    throw new TypeError(
      'analysisWindowManager.exportSessionWindows() must return an array'
    );
  }
  const sizes = mgr.exportViewSizes();
  // Settings are JSON; a window's result columns are typed arrays, stored
  // as their bytes (codecs/typed-json.js).
  return [
    {
      id: 'analysis/windows',
      contributorId: id,
      priority: 'eager',
      kind: 'binary',
      codec: 'gzip',
      label: 'Analysis windows',
      datasetDependent: true,
      payload: encodeTypedJson({ windows: exportedWindows, sizes })
    }
  ];
}

/**
 * Close the open windows, then restore the remembered sizes and reopen the
 * saved windows.
 * @param {object} manager
 * @param {{ windows: any[], sizes: Object }} state
 */
async function applyWindows(manager, { windows, sizes }) {
  await manager.closeAll();
  manager.importViewSizes(sizes);
  for (const descriptor of windows) {
    await manager.createFromSessionDescriptor(descriptor);
  }
}

export async function restore(ctx, _chunkMeta, payload) {
  const mgr = requireManager(
    ctx,
    ['closeAll', 'createFromSessionDescriptor', 'importViewSizes']
  );
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('Analysis-window payload must be typed JSON bytes.');
  }
  const restored = requireRestorePayload(decodeTypedJson(payload));
  const restoreTransaction = ctx?.restoreTransaction;
  if (
    restoreTransaction === null
    || typeof restoreTransaction !== 'object'
  ) {
    await applyWindows(mgr, restored);
    return;
  }
  if (typeof restoreTransaction.register !== 'function') {
    throw new TypeError(
      'Analysis-window restore transaction must implement register().'
    );
  }
  const sharedSnapshot = getSessionRestoreSnapshot(
    ctx,
    'analysis/windows'
  );
  const previous = requireRestorePayload(decodeTypedJson(
    sharedSnapshot === undefined ? capture(ctx)[0].payload : sharedSnapshot
  ));
  // Window settings name highlight pages and analysis caches that later
  // chunks stage and publish only at commit, so the windows reopen in the
  // transaction's presentation stage, after every state participant has
  // committed. The windows being replaced close now so none of them observes
  // the restore half-applied.
  let applied = false;
  restoreTransaction.register('analysis-windows/state', {
    value: restored,
    stage: 'presentation',
    prepare() {},
    async commit() {
      await applyWindows(mgr, restored);
    },
    async rollback() {
      if (!applied) return;
      await applyWindows(mgr, previous);
      applied = false;
    }
  });

  applied = true;
  await mgr.closeAll();
}
