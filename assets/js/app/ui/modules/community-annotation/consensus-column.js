/**
 * @fileoverview Derivation of the manual community consensus column.
 *
 * Turns the per-category consensus the session computes into a user-defined
 * categorical field on the dataset. Cells whose source category has no
 * consensus become "Pending"; cells whose annotators disagree become
 * "Disputed"; a missing source code is "Pending" rather than an error.
 *
 * The consensus settings are read through `readSettings()` rather than captured
 * once, because the minimum-annotator and threshold values are read after the
 * source field has been loaded and must be the values in force at that moment.
 *
 * @module ui/modules/community-annotation/consensus-column
 */

import { categoricalStorageForCount } from '../../../../data/categorical-storage-contract.js';

/**
 * @param {object} deps
 * @param {object} deps.state Visualization state manager.
 * @param {object} deps.session Community annotation session singleton.
 * @param {object} deps.notifications Notification center.
 * @returns {(readSettings: () => object) => Promise<void>} `applyConsensusColumn`
 */
export function createConsensusColumnApplier({ state, session, notifications }) {
  if (
    state === null ||
    typeof state !== 'object' ||
    session === null ||
    typeof session !== 'object' ||
    notifications === null ||
    typeof notifications !== 'object'
  ) {
    throw new TypeError(
      'The community consensus column requires the visualization state, the annotation session, and the notification center'
    );
  }

  async function applyConsensusColumn(readSettings) {
    if (typeof readSettings !== 'function') {
      throw new TypeError(
        'Building the community consensus column requires a settings reader'
      );
    }
    const {
      consensusSourceFieldKey,
      selectedFieldKey,
      consensusColumnKey,
    } = readSettings();
    const sourceFieldKey = consensusSourceFieldKey || selectedFieldKey || null;
    if (!sourceFieldKey) return;
    const targetKey = String(consensusColumnKey || '').trim();
    if (!targetKey) {
      notifications.error('Consensus column key is required', { category: 'annotation', duration: 2600 });
      return;
    }

    const fields = state.getFields?.() || [];
    const fieldIndex = fields.findIndex((f) => f?.kind === 'category' && f?.key === sourceFieldKey && f?._isDeleted !== true);
    if (fieldIndex < 0) return;

    try {
      await state.ensureFieldLoaded?.(fieldIndex, { silent: true });
    } catch (err) {
      notifications.error(err?.message || 'Failed to load field for consensus', { category: 'annotation' });
      return;
    }

    const field = state.getFields?.()?.[fieldIndex] || null;
    const categories = Array.isArray(field?.categories) ? field.categories : [];
    const codes = field?.codes;
    if (!categories.length || !codes || typeof codes.length !== 'number') return;
    session.setFieldCategories(sourceFieldKey, categories);

    const labelToIndex = new Map();
    const outCategories = [];

    const getLabelIndex = (label) => {
      if (
        typeof label !== 'string' ||
        !/\S/.test(label) ||
        /^\s|\s$/.test(label)
      ) {
        throw new Error('Consensus labels must be exact nonblank strings');
      }
      const k = label;
      if (labelToIndex.has(k)) return labelToIndex.get(k);
      const idx = outCategories.length;
      outCategories.push(k);
      labelToIndex.set(k, idx);
      return idx;
    };

    const {
      consensusColumnMinAnnotators,
      consensusColumnThreshold,
    } = readSettings();
    const oldToNew = new Array(categories.length);
    for (let i = 0; i < categories.length; i++) {
      const c = session.computeConsensus(sourceFieldKey, i, { minAnnotators: consensusColumnMinAnnotators, threshold: consensusColumnThreshold });
      const label =
        c.status === 'consensus' && c.label
          ? c.label
          : c.status === 'disputed'
            ? 'Disputed'
            : 'Pending';
      oldToNew[i] = getLabelIndex(label);
    }

    const missingSourceCode =
      codes instanceof Uint8Array
        ? 255
        : codes instanceof Uint16Array
          ? 65535
          : null;

    // "Pending" is reserved for cells the community has not resolved. It is
    // added only when some cell actually needs it: a category that no cell
    // carries would show as an empty entry in the legend and the filters, and
    // reserving it unconditionally also costs one of the 255 code slots a
    // Uint8 field has, which can push an otherwise valid column over the limit.
    let missingIndex = -1;
    if (labelToIndex.has('Pending')) {
      missingIndex = labelToIndex.get('Pending');
    } else if (missingSourceCode !== null) {
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === missingSourceCode) {
          missingIndex = getLabelIndex('Pending');
          break;
        }
      }
    }

    // The code width follows the final category inventory, which is only known
    // once every label - including a needed "Pending" - has been assigned. The
    // format owns where the width changes; deriving it here is how this file
    // would come to disagree with the readers and writers.
    const outStorage = categoricalStorageForCount(
      outCategories.length,
      'Community consensus column'
    );
    const outCodes = new outStorage.TypedArrayClass(codes.length);
    for (let i = 0; i < codes.length; i++) {
      const oldIdx = codes[i];
      if (missingSourceCode !== null && oldIdx === missingSourceCode) {
        outCodes[i] = missingIndex;
        continue;
      }
      if (!Number.isInteger(oldIdx) || oldIdx < 0 || oldIdx >= oldToNew.length) {
        throw new Error(
          `Consensus source code at cell ${i} is outside the exact category range`
        );
      }
      outCodes[i] = oldToNew[oldIdx];
    }

    const result = state.upsertUserDefinedCategoricalField({
      key: targetKey,
      categories: outCategories,
      codes: outCodes,
      meta: {
        _sourceField: {
          kind: 'community-annotation',
          sourceKey: sourceFieldKey,
          sourceIndex: fieldIndex
        },
        _operation: {
          type: 'community-consensus',
          fieldKey: sourceFieldKey,
          builtAt: Date.now()
        }
      }
    });

    const suffix = result.updatedInPlace ? '' : ` (created as "${result.key}")`;
    notifications.success(`Updated consensus column: ${result.key}${suffix}`, { category: 'annotation', duration: 2600 });
  }

  return applyConsensusColumn;
}
