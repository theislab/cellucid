/**
 * @fileoverview Field filter serialization/restoration helpers.
 *
 * This module snapshots only modified filter state to minimize snapshot size
 * and avoid forcing unnecessary data loads when restoring.
 *
 * @module state-serializer/filters
 */

import { getCategoryColor } from '../../data/palettes.js';
import { makeFieldId, parseFieldId } from '../utils/field-constants.js';

/**
 * Compare two RGB colors for equality within a small epsilon.
 * @param {number[]|null} a
 * @param {number[]|null} b
 * @param {number} [epsilon=1e-4]
 * @returns {boolean}
 */
function colorsEqual(a, b, epsilon = 1e-4) {
  if (!a || !b) return !a && !b;
  return Math.abs(a[0] - b[0]) < epsilon &&
         Math.abs(a[1] - b[1]) < epsilon &&
         Math.abs(a[2] - b[2]) < epsilon;
}

function isCategoryFieldModified(field) {
  if (!field || field.kind !== 'category') return false;
  if (field._categoryFilterEnabled === false) return true;
  if (field._categoryVisible) {
    for (const visible of Object.values(field._categoryVisible)) {
      if (visible === false) return true;
    }
  }
  if (field._colormapId) return true;
  if (field._categoryColors) {
    for (let i = 0; i < field._categoryColors.length; i++) {
      const color = field._categoryColors[i];
      if (color) {
        const defaultColor = getCategoryColor(i);
        if (!colorsEqual(color, defaultColor)) return true;
      }
    }
  }
  return false;
}

function isContinuousFieldModified(field) {
  if (!field || field.kind !== 'continuous') return false;

  if (field._filterEnabled === false) return true;

  if (field._continuousFilter && field._continuousStats) {
    const stats = field._continuousStats;
    const filter = field._continuousFilter;
    const minChanged = filter.min > stats.min + 1e-6;
    const maxChanged = filter.max < stats.max - 1e-6;
    if (minChanged || maxChanged) return true;
  }

  if (field._continuousColorRange && field._continuousStats) {
    const stats = field._continuousStats;
    const colorRange = field._continuousColorRange;
    const minChanged = Math.abs(colorRange.min - stats.min) > 1e-6;
    const maxChanged = Math.abs(colorRange.max - stats.max) > 1e-6;
    if (minChanged || maxChanged) return true;
  }

  if (field._useFilterColorRange === false) return true;
  if (field._useLogScale) return true;

  const outlierEnabled = field._outlierFilterEnabled !== false;
  if (!outlierEnabled) return true;
  if (outlierEnabled && field._outlierThreshold != null && field._outlierThreshold < 0.9999) return true;

  if (field._colormapId && field._colormapId !== 'viridis') return true;
  return false;
}

export function serializeFiltersForFields(fields, source) {
  const filters = {};
  (fields || []).forEach((field) => {
    if (!field) return;
    if (field._isDeleted === true) return;

    const modified =
      field.kind === 'category'
        ? isCategoryFieldModified(field)
        : isContinuousFieldModified(field);
    if (!modified) return;

    const key = makeFieldId(source, field.key);
    if (field.kind === 'category') {
      const visibility = {};
      if (field._categoryVisible) {
        Object.entries(field._categoryVisible).forEach(([catIdx, visible]) => {
          visibility[catIdx] = visible;
        });
      }
      const colors = {};
      if (field._categoryColors) {
        field._categoryColors.forEach((color, catIdx) => {
          if (color) {
            const defaultColor = getCategoryColor(catIdx);
            if (!colorsEqual(color, defaultColor)) {
              colors[catIdx] = [...color];
            }
          }
        });
      }
      filters[key] = {
        kind: 'category',
        filterEnabled: field._categoryFilterEnabled !== false,
        visibility,
        colors,
        colormapId: field._colormapId || null
      };
    } else if (field.kind === 'continuous') {
      filters[key] = {
        kind: 'continuous',
        filterEnabled: field._filterEnabled !== false,
        filter: field._continuousFilter ? { ...field._continuousFilter } : null,
        colorRange: field._continuousColorRange ? { ...field._continuousColorRange } : null,
        useLogScale: field._useLogScale ?? false,
        useFilterColorRange: field._useFilterColorRange ?? true,
        outlierFilterEnabled: field._outlierFilterEnabled ?? true,
        outlierThreshold: field._outlierThreshold ?? 1.0,
        colormapId: field._colormapId || null
      };
    }
  });
  return filters;
}

export function createFilterSerializer({ state }) {
  function serializeFilters() {
    const filters = {};
    Object.assign(filters, serializeFiltersForFields(state.getFields?.(), 'obs'));
    Object.assign(filters, serializeFiltersForFields(state.getVarFields?.(), 'var'));
    return filters;
  }

  /**
   * Restore filters to fields (async).
   * Returns counts so callers can avoid noisy logs when nothing is applied.
   */
  async function restoreFilters(filters) {
    if (!filters) return { restored: 0, skippedNoop: 0 };

    const entries = Object.entries(filters);
    if (!entries.length) return { restored: 0, skippedNoop: 0 };

    let restored = 0;
    let skippedNoop = 0;

    const isCategoryFilterNoop = (data) => {
      if (!data) return true;
      if (data.filterEnabled === false) return false;
      if (data.colormapId) return false;
      if (data.colors && Object.keys(data.colors).length > 0) return false;
      if (data.visibility) {
        for (const v of Object.values(data.visibility)) {
          if (v === false) return false;
        }
      }
      return true;
    };

    const isContinuousFilterNoop = (data) => {
      if (!data) return true;
      if (data.filterEnabled === false) return false;
      if (data.filter) return false;
      if (data.colorRange) return false;
      if (data.useLogScale) return false;
      if (data.useFilterColorRange) return false;
      if (data.outlierFilterEnabled === false) return false;
      if (typeof data.outlierThreshold === 'number' && data.outlierThreshold < 0.9999) return false;
      if (data.colormapId) return false;
      return true;
    };

    const obsFields = state.getFields?.() || [];
    const varFields = state.getVarFields?.() || [];
    const obsLookup = new Map();
    const varLookup = new Map();

    obsFields.forEach((field, idx) => {
      if (field?.key && field._isDeleted !== true) obsLookup.set(field.key, idx);
    });
    varFields.forEach((field, idx) => {
      if (field?.key && field._isDeleted !== true) varLookup.set(field.key, idx);
    });

    const toRestore = [];

    for (const [key, data] of entries) {
      const parsed = parseFieldId(key);
      const source = parsed?.source;
      const fieldKey = parsed?.fieldKey;
      if (!source || !fieldKey) {
        skippedNoop += 1;
        continue;
      }

      const lookup = source === 'var' ? varLookup : obsLookup;
      const fields = source === 'var' ? varFields : obsFields;
      const fieldIndex = lookup.get(fieldKey);

      if (fieldIndex == null || fieldIndex < 0) {
        skippedNoop += 1;
        continue;
      }

      const field = fields[fieldIndex];
      if (!field) {
        skippedNoop += 1;
        continue;
      }

      const isNoop =
        data.kind === 'category'
          ? isCategoryFilterNoop(data)
          : data.kind === 'continuous'
            ? isContinuousFilterNoop(data)
            : true;

      if (isNoop) {
        skippedNoop += 1;
        continue;
      }

      toRestore.push({ source, fieldIndex, data });
    }

    if (!toRestore.length) {
      return { restored: 0, skippedNoop };
    }

    const preloadPromises = toRestore
      .map(({ source, fieldIndex }) => {
        if (source === 'var') {
          return state.ensureVarFieldLoaded?.(fieldIndex);
        }
        return state.ensureFieldLoaded?.(fieldIndex);
      })
      .filter(Boolean);

    if (preloadPromises.length > 0) {
      await Promise.all(preloadPromises);
    }

    state.beginBatch?.();

    try {
      for (const { source, fieldIndex, data } of toRestore) {
        const fields = source === 'var' ? (state.getVarFields?.() || []) : (state.getFields?.() || []);
        const field = fields[fieldIndex];
        if (!field) {
          skippedNoop += 1;
          continue;
        }

        if (data.kind === 'category' && field.kind === 'category') {
          if (data.visibility) {
            Object.entries(data.visibility).forEach(([catIdx, visible]) => {
              state.setVisibilityForCategory?.(field, parseInt(catIdx, 10), visible);
            });
          }
          if (data.colors) {
            Object.entries(data.colors).forEach(([catIdx, color]) => {
              state.setColorForCategory?.(field, parseInt(catIdx, 10), color);
            });
          }
          field._categoryFilterEnabled = data.filterEnabled !== false;
          if (data.colormapId) {
            field._colormapId = data.colormapId;
          }
          restored += 1;
          continue;
        }

        if (data.kind === 'continuous' && field.kind === 'continuous') {
          if (data.filter) {
            field._continuousFilter = { ...data.filter };
          }
          if (data.colorRange) {
            field._continuousColorRange = { ...data.colorRange };
          }
          field._filterEnabled = data.filterEnabled !== false;
          field._useLogScale = data.useLogScale ?? false;
          field._useFilterColorRange = data.useFilterColorRange ?? true;
          field._outlierFilterEnabled = data.outlierFilterEnabled ?? true;
          field._outlierThreshold = data.outlierThreshold ?? 1.0;
          if (data.colormapId) {
            field._colormapId = data.colormapId;
          }
          restored += 1;
          continue;
        }

        skippedNoop += 1;
      }
    } finally {
      state.endBatch?.();
    }

    return { restored, skippedNoop };
  }

  return { serializeFiltersForFields, serializeFilters, restoreFilters };
}
