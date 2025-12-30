/**
 * @fileoverview Session contributor: field overlays (rename/delete/user-defined meta).
 *
 * EAGER chunk (dataset-dependent):
 * - RenameRegistry.toJSON()
 * - DeleteRegistry.toJSON()
 * - UserDefinedFieldsRegistry.toSessionMeta() (definitions only; codes stored separately)
 *
 * Restore order (per plan):
 *  1) clear registries
 *  2) load registries
 *  3) state.applyFieldOverlays()
 *
 * @module session/contributors/field-overlays
 */

export const id = 'field-overlays';

/**
 * Capture rename/delete registries + user-defined field definitions.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const state = ctx?.state;
  if (!state) return [];

  const renames = state.getRenameRegistry?.()?.toJSON?.() || null;
  const deletedFields = state.getDeleteRegistry?.()?.toJSON?.() || null;
  const userDefinedFields = state.getUserDefinedFieldsRegistry?.()?.toSessionMeta?.() || [];

  return [
    {
      id: 'core/field-overlays',
      contributorId: id,
      priority: 'eager',
      kind: 'json',
      codec: 'gzip',
      label: 'Field overlays',
      datasetDependent: true,
      payload: { renames, deletedFields, userDefinedFields }
    }
  ];
}

/**
 * Restore rename/delete registries + user-defined field definitions.
 * @param {object} ctx
 * @param {any} _chunkMeta
 * @param {{ renames?: any, deletedFields?: any, userDefinedFields?: any[] }} payload
 */
export function restore(ctx, _chunkMeta, payload) {
  const state = ctx?.state;
  if (!state || !payload) return;

  // 0) Field operation registries must be restored first so overlays apply to metadata.
  const renameRegistry = state.getRenameRegistry?.();
  const deleteRegistry = state.getDeleteRegistry?.();
  const userDefinedRegistry = state.getUserDefinedFieldsRegistry?.();

  renameRegistry?.clear?.();
  deleteRegistry?.clear?.();
  userDefinedRegistry?.clear?.();

  if (payload.renames) {
    renameRegistry?.fromJSON?.(payload.renames);
  }
  if (payload.deletedFields) {
    deleteRegistry?.fromJSON?.(payload.deletedFields);
  }
  if (Array.isArray(payload.userDefinedFields)) {
    // Session bundles store user-defined field metadata separately from codes.
    userDefinedRegistry?.fromSessionMeta?.(payload.userDefinedFields);
  }

  // Apply overlays to the currently loaded field metadata.
  state.applyFieldOverlays?.();
}

