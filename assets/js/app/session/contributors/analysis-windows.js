/**
 * @fileoverview Session contributor: floating analysis windows.
 *
 * EAGER chunk (dataset-dependent):
 * - Reopen floating analysis windows with their modeId + geometry + settings.
 *
 * Uses AnalysisWindowManager public APIs added for session restore:
 * - exportSessionWindows()
 * - createFromSessionDescriptor()
 *
 * @module session/contributors/analysis-windows
 */

export const id = 'analysis-windows';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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
    !isPlainObject(payload) ||
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, 'windows')
  ) {
    throw new TypeError(
      'Analysis-window restore payload must contain exactly: windows'
    );
  }
  if (!Array.isArray(payload.windows)) {
    throw new TypeError('Analysis-window restore payload windows must be an array');
  }
  return structuredClone(payload.windows);
}

/**
 * Capture all floating analysis windows.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const mgr = requireManager(ctx, ['exportSessionWindows']);
  const exportedWindows = mgr.exportSessionWindows();
  if (!Array.isArray(exportedWindows)) {
    throw new TypeError(
      'analysisWindowManager.exportSessionWindows() must return an array'
    );
  }
  const windows = structuredClone(exportedWindows);
  return [
    {
      id: 'analysis/windows',
      contributorId: id,
      priority: 'eager',
      kind: 'json',
      codec: 'gzip',
      label: 'Analysis windows',
      datasetDependent: true,
      payload: { windows }
    }
  ];
}

/**
 * Restore floating analysis windows from descriptors.
 * @param {object} ctx
 * @param {any} _chunkMeta
 * @param {{ windows: any[] }} payload
 */
export function restore(ctx, _chunkMeta, payload) {
  const mgr = requireManager(
    ctx,
    ['closeAll', 'createFromSessionDescriptor']
  );
  const windows = requireRestorePayload(payload);

  mgr.closeAll();
  for (const descriptor of windows) {
    mgr.createFromSessionDescriptor(descriptor);
  }
}
