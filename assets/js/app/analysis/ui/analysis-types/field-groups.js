/**
 * @fileoverview The categories of a categorical field as group-picker groups
 * — id, name, cell count and color — for Composition's "Only these cell
 * types" and Dot plot's "Groups to show".
 *
 * The counts come from one pass over the field's codes in a worker
 * (`COMPOSITION_COUNTS` with one unit), so describing a field of ten million
 * cells never holds the page. A field is described once per dataset; the
 * caller hears when a description arrives and redraws its form.
 *
 * @module analysis-types/field-groups
 */

import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';
import { defaultCategoryColor } from '../../../../data/palettes.js';

/** A field's category color as CSS. */
export function categoryColorCss(field, index) {
  const rgb = field._categoryColors?.[index] ?? defaultCategoryColor(field, index);
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

/**
 * @param {object} options
 * @param {object} options.dataLayer
 * @param {() => void} options.onReady - A field's groups arrived.
 * @param {(error: Error) => void} options.onError
 */
export function createFieldGroups({ dataLayer, onReady, onError }) {
  /** @type {Map<string, {groups: Array<{id: string, name: string, count: number, color: string}>|null, task: Promise<void>|null}>} */
  const byField = new Map();
  let generation = 0;

  async function describe(fieldKey, at) {
    const field = await dataLayer.ensureObsFieldLoaded(fieldKey);
    const categories = field.categories.map(String);
    const counted = await getComputeManager().execute(
      OperationType.COMPOSITION_COUNTS,
      {
        typeCodes: field.codes,
        typeIndexOfCode: Int32Array.from({ length: Math.max(1, categories.length) }, (_, index) => index),
        typeCount: Math.max(1, categories.length),
        sampleCodes: null,
        sampleIndexOfCode: null,
        sampleCount: 1,
        conditionCodes: null,
        conditionIndexOfCode: null,
        conditionCount: 1,
        scope: null
      },
      // The codes are the field's own array: copied, never moved.
      { transfer: false }
    );
    if (at !== generation) return;
    const state = dataLayer.state.obsData.fields.find(candidate => candidate.key === fieldKey);
    byField.set(fieldKey, {
      groups: categories.map((name, index) => ({
        id: name,
        name,
        count: counted.counts[index],
        color: categoryColorCss(state, index)
      })),
      task: null
    });
    onReady();
  }

  return {
    /** The groups of a field, or [] while they are being counted. */
    groups(fieldKey) {
      if (typeof fieldKey !== 'string' || fieldKey === '') return [];
      const known = byField.get(fieldKey);
      if (known?.groups) return known.groups;
      if (known?.task) return [];
      const at = generation;
      const task = describe(fieldKey, at).catch(error => {
        if (at !== generation) return;
        byField.delete(fieldKey);
        onError(error);
      });
      byField.set(fieldKey, { groups: null, task });
      return [];
    },
    /** Forget every description (a new dataset). */
    reset() {
      generation += 1;
      byField.clear();
    }
  };
}
