/**
 * @fileoverview Color Manager.
 *
 * Hosts color buffer updates, continuous/categorical color configuration,
 * and legend state computation.

 * ⚡ PERFORMANCE CRITICAL: color updates can touch millions of points.

 * @module state/managers/color-manager
 */

import {
  COLOR_PICKER_PALETTE,
  CONTINUOUS_COLORMAPS,
  getCategoryColor,
  getColormap,
  getCssStopsForColormap,
  sampleContinuousColormap
} from '../../../data/palettes.js';
import { clamp } from '../../utils/number-utils.js';
import { NEUTRAL_GRAY_UINT8 } from '../core/constants.js';
import { BaseManager } from '../core/base-manager.js';
import { colorOutlierMethods } from './color-outliers.js';

export class DataStateColorMethods {
  _updateActiveCategoryCounts() {
    const field = this.getActiveField();
    if (!field || field.kind !== 'category') {
      this._activeCategoryCounts = null;
      return false;
    }
    const counts = this.computeCategoryCountsForField(field);
    field._categoryCounts = counts;
    this._activeCategoryCounts = counts;
    return this._applyCategoryCountsToCentroids(field, counts);
  }

  ensureContinuousMetadata(field) {
    if (!field || field.kind !== 'continuous') return null;
    const needsStats = !field._continuousStats
      || !isFinite(field._continuousStats.min)
      || !isFinite(field._continuousStats.max);
    if (needsStats) {
      const values = field.values || [];
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null || Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!isFinite(min) || !isFinite(max)) {
        min = 0; max = 1;
      }
      if (max === min) max = min + 1;
      if (!field._continuousStats) field._continuousStats = { min, max };
      else {
        field._continuousStats.min = min;
        field._continuousStats.max = max;
      }
    }
    if (!field._continuousFilter) {
      field._continuousFilter = {
        min: field._continuousStats.min,
        max: field._continuousStats.max
      };
    } else {
      field._continuousFilter.min = Math.max(
        field._continuousStats.min,
        Math.min(field._continuousFilter.min, field._continuousStats.max)
      );
      field._continuousFilter.max = Math.max(
        field._continuousStats.min,
        Math.min(field._continuousFilter.max, field._continuousStats.max)
      );
      if (field._continuousFilter.min > field._continuousFilter.max) {
        field._continuousFilter.min = field._continuousStats.min;
        field._continuousFilter.max = field._continuousStats.max;
      }
    }
    if (field._useFilterColorRange == null) field._useFilterColorRange = true;
    if (!field._continuousColorRange) {
      field._continuousColorRange = {
        min: field._continuousFilter.min,
        max: field._continuousFilter.max
      };
    } else {
      field._continuousColorRange.min = Math.max(
        field._continuousStats.min,
        Math.min(field._continuousColorRange.min, field._continuousStats.max)
      );
      field._continuousColorRange.max = Math.max(
        field._continuousStats.min,
        Math.min(field._continuousColorRange.max, field._continuousStats.max)
      );
      if (field._continuousColorRange.min > field._continuousColorRange.max) {
        field._continuousColorRange.min = field._continuousStats.min;
        field._continuousColorRange.max = field._continuousStats.max;
      }
    }
    const needsPositiveStats = !field._positiveStats
      || !isFinite(field._positiveStats.min)
      || !isFinite(field._positiveStats.max);
    if (needsPositiveStats) {
      const values = field.values || [];
      let minPos = Infinity;
      let maxPos = -Infinity;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null || Number.isNaN(v) || v <= 0) continue;
        if (v < minPos) minPos = v;
        if (v > maxPos) maxPos = v;
      }
      field._positiveStats = (minPos !== Infinity && maxPos !== -Infinity)
        ? { min: minPos, max: maxPos }
        : null;
    }
    if (field._useLogScale == null) field._useLogScale = false;
    const colormap = getColormap(field._colormapId);
    field._colormapId = colormap.id;
    return {
      stats: field._continuousStats,
      filter: field._continuousFilter,
      colorRange: field._continuousColorRange,
      positiveStats: field._positiveStats
    };
  }

  getContinuousColorDomain(field) {
    if (!field || field.kind !== 'continuous') {
      return { min: 0, max: 1, scale: 'linear', usingFilter: false };
    }
    const meta = this.ensureContinuousMetadata(field);
    if (!meta) return { min: 0, max: 1, scale: 'linear', usingFilter: false };
    const stats = meta.stats;
    const useFilterRange = field._useFilterColorRange === true;
    const baseDomain = useFilterRange ? meta.colorRange : stats;
    const requestedLog = field._useLogScale === true;

    let domainMin = baseDomain?.min ?? stats.min;
    let domainMax = baseDomain?.max ?? stats.max;
    let scale = requestedLog ? 'log' : 'linear';

    if (scale === 'log') {
      const pos = meta.positiveStats;
      if (pos && pos.min > 0 && pos.max > 0) {
        domainMin = Math.max(domainMin, pos.min);
        domainMax = Math.min(domainMax, pos.max);
        if (!isFinite(domainMin) || domainMin <= 0) domainMin = pos.min;
        if (!isFinite(domainMax) || domainMax <= 0) domainMax = pos.max;
        if (domainMax <= domainMin) {
          domainMin = pos.min;
          domainMax = pos.max;
        }
      } else {
        // No positive values to drive a log scale; fall back to a safe dummy range
        domainMin = 1;
        domainMax = 10;
      }
    }

    if (!isFinite(domainMin) || !isFinite(domainMax)) {
      domainMin = stats.min;
      domainMax = stats.max;
    }

    if (scale === 'log') {
      if (domainMin <= 0) domainMin = Math.max(domainMax / 10, 1e-6);
      if (domainMax <= domainMin) domainMax = domainMin * 10;
    } else if (domainMax === domainMin) {
      domainMax = domainMin + 1;
    }

    return {
      min: domainMin,
      max: domainMax,
      scale,
      usingFilter: useFilterRange
    };
  }

  updateColorsContinuous(field, { resetTransparency = false } = {}) {
    if (!field || field.kind !== 'continuous') return;
    const meta = this.ensureContinuousMetadata(field);
    const domain = this.getContinuousColorDomain(field);
    const colormap = getColormap(field._colormapId);
    const useLog = domain.scale === 'log';
    let domainMin = domain.min;
    let domainMax = domain.max;
    if (!isFinite(domainMin) || !isFinite(domainMax) || domainMin === domainMax) {
      domainMin = meta?.stats?.min ?? 0;
      domainMax = meta?.stats?.max ?? (domainMin + 1);
      if (domainMax === domainMin) domainMax = domainMin + 1;
    }
    const logMin = useLog ? Math.log10(domainMin) : 0;
    const denom = useLog ? (Math.log10(domainMax) - logMin) : (domainMax - domainMin);
    const range = denom || 1;
    const values = field.values || [];
    const n = this.pointCount;

    if (!this.categoryTransparency || this.categoryTransparency.length !== n) {
      this.categoryTransparency = new Float32Array(n);
    }
    if (resetTransparency) {
      this.categoryTransparency.fill(1.0);
    }

    for (let i = 0; i < n; i++) {
      const v = values[i];
      let r, g, b;
      if (v === null || Number.isNaN(v) || (useLog && v <= 0)) {
        r = NEUTRAL_GRAY_UINT8; g = NEUTRAL_GRAY_UINT8; b = NEUTRAL_GRAY_UINT8;
      } else {
        let t;
        if (useLog) {
          t = (Math.log10(v) - logMin) / range;
        } else {
          t = (v - domainMin) / range;
        }
        const c = sampleContinuousColormap(colormap.id, t);
        // Convert from 0-1 float to 0-255 uint8
        r = Math.round(c[0] * 255);
        g = Math.round(c[1] * 255);
        b = Math.round(c[2] * 255);
      }
      const j = i * 4;
      this.colorsArray[j] = r;
      this.colorsArray[j + 1] = g;
      this.colorsArray[j + 2] = b;
      // Alpha will be synced from categoryTransparency in syncColorsAlpha
    }
    this._syncColorsAlpha();
  }

  // Sync alpha from categoryTransparency to packed RGBA colorsArray
  _syncColorsAlpha() {
    const n = this.pointCount;
    const alpha = this.categoryTransparency;
    for (let i = 0; i < n; i++) {
      this.colorsArray[i * 4 + 3] = Math.round((alpha[i] ?? 1.0) * 255);
    }
  }

  ensureCategoryMetadata(field) {
    const categories = field.categories || [];
    const numCats = categories.length;
    if (!field._categoryColors) {
      const catColors = new Array(numCats);
      for (let i = 0; i < numCats; i++) {
        catColors[i] = getCategoryColor(i);
      }
      field._categoryColors = catColors;
    } else {
      for (let i = 0; i < numCats; i++) {
        const color = field._categoryColors[i];
        if (!color || color.length !== 3) {
          field._categoryColors[i] = getCategoryColor(i);
        }
      }
    }
    if (!field._categoryVisible) {
      field._categoryVisible = {};
      for (let i = 0; i < numCats; i++) {
        field._categoryVisible[i] = true;
      }
    }
  }

  updateColorsCategorical(field) {
    const n = this.pointCount;
    const categories = field.categories || [];
    const codes = field.codes || [];
    const numCats = categories.length;

    this.ensureCategoryMetadata(field);
    const catColors = field._categoryColors;
    const catVisible = field._categoryVisible;

    if (!this.categoryTransparency || this.categoryTransparency.length !== n) {
      this.categoryTransparency = new Float32Array(n);
    }

    for (let i = 0; i < n; i++) {
      const code = codes[i];
      let r, g, b, alpha;
      if (code == null || code < 0 || code >= numCats) {
        r = NEUTRAL_GRAY_UINT8; g = NEUTRAL_GRAY_UINT8; b = NEUTRAL_GRAY_UINT8;
        alpha = 1.0;
      } else {
        const isVisible = catVisible[code] !== false;
        const c = catColors[code] || getCategoryColor(code) || [0.5, 0.5, 0.5];
        if (!isVisible) {
          r = g = b = 128; // gray in uint8
          alpha = 0.0;
        } else {
          // Convert from 0-1 float to 0-255 uint8
          r = Math.round(c[0] * 255);
          g = Math.round(c[1] * 255);
          b = Math.round(c[2] * 255);
          alpha = 1.0;
        }
      }
      const j = i * 4;
      this.colorsArray[j] = r;
      this.colorsArray[j + 1] = g;
      this.colorsArray[j + 2] = b;
      this.colorsArray[j + 3] = Math.round(alpha * 255);
      this.categoryTransparency[i] = alpha;
    }
    this._pushTransparencyToViewer();
    this._syncActiveContext();
  }

  clearCentroids() {
    this.centroidCount = 0;
    this.centroidPositions = null;
    this.centroidColors = null; // RGBA uint8
    this.centroidOutliers = null;
    this.centroidLabels = [];
    this._removeLabelsForView(this.activeViewId);
    if (this.viewer && typeof this.viewer.setCentroidLabels === 'function') {
      this.viewer.setCentroidLabels([], this.activeViewId);
    }
    this._pushCentroidsToViewer();
    this._syncActiveContext();
  }

  buildCentroidsForField(field, { viewId = null } = {}) {
    // Get dimension-specific centroids based on current dimension level
    const currentDim = this.activeDimensionLevel || 3;
    const centroidsByDim = field.centroidsByDim || {};

    // Get centroids for current dimension
    let centroids = centroidsByDim[String(currentDim)]
      || centroidsByDim[currentDim]
      || [];

    // Lazy normalization: normalize centroids for this dimension if not already done.
    // Each dimension has its own normalization transform, so we track per-dimension.
    // This ensures centroids are correctly positioned regardless of which dimension
    // was loaded first or when switching between dimensions.
    //
    // centroidsByDim: per-dimension arrays, each normalized with its own transform
    if (centroids.length > 0 && this.dimensionManager) {
      // Initialize normalization tracking map if needed
      if (!field._normalizedDims) {
        field._normalizedDims = new Set();
      }

      const dimKey = String(currentDim);

      // Check if this centroid array needs normalization
      if (!field._normalizedDims.has(dimKey)) {
        const normTransform = this.dimensionManager.getNormTransform(currentDim);

        if (normTransform) {
          const { center, scale } = normTransform;
          const [cx, cy, cz] = center;

          // Normalize each centroid's position in-place
          for (const c of centroids) {
            const p = c.position;
            if (!p) continue;
            // Handle 1D, 2D, and 3D positions
            if (p.length >= 1) p[0] = (p[0] - cx) * scale;
            if (p.length >= 2) p[1] = (p[1] - cy) * scale;
            if (p.length >= 3) p[2] = (p[2] - cz) * scale;
          }

          // Mark as normalized
          field._normalizedDims.add(dimKey);
        }
      }
    }

    // Determine the native dimension of these centroids (from position array length)
    let nativeDim = 3;
    if (centroids.length > 0 && centroids[0].position) {
      nativeDim = centroids[0].position.length;
    }

    const categories = field.categories || [];
    this.ensureCategoryMetadata(field);
    const catColors = field._categoryColors || [];
    // Use provided viewId or fall back to activeViewId
    const viewKey = String(viewId || this.activeViewId || 'live');
    this.centroidCount = centroids.length;
    const allowLabels = true;

    this.centroidPositions = new Float32Array(this.centroidCount * 3);
    this.centroidColors = new Uint8Array(this.centroidCount * 4); // RGBA uint8
    this.centroidOutliers = new Float32Array(this.centroidCount);
    this.centroidOutliers.fill(-1.0);

    this.centroidLabels = [];
    if (allowLabels && this.labelLayer) this._removeLabelsForView(viewKey);

    const catIndexByName = new Map();
    categories.forEach((cat, idx) => catIndexByName.set(String(cat), idx));

    // Pre-compute counts so centroids/labels respect visibility immediately
    // Only compute and save counts when building for the active view, as
    // computeCategoryCountsForField uses active view's transparency/filters
    const isActiveView = viewKey === String(this.activeViewId);
    if (isActiveView) {
      const counts = this.computeCategoryCountsForField(field);
      if (counts) {
        field._categoryCounts = counts;
        this._activeCategoryCounts = counts;
      }
    }

    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      const pos = c.position || [0, 0, 0];

      // Pad lower-dimensional positions to 3D for rendering
      // 1D: [x] -> [x, 0, 0]
      // 2D: [x, y] -> [x, y, 0]
      // 3D: [x, y, z] -> [x, y, z]
      this.centroidPositions[3 * i] = pos[0] || 0;
      this.centroidPositions[3 * i + 1] = nativeDim >= 2 ? (pos[1] || 0) : 0;
      this.centroidPositions[3 * i + 2] = nativeDim >= 3 ? (pos[2] || 0) : 0;

      const idx = catIndexByName.get(String(c.category));
      let color = [0, 0, 0];
      if (idx != null) {
        const fallback = getCategoryColor(idx) || [0, 0, 0];
        color = catColors[idx] || fallback;
      }
      // Convert float 0-1 to uint8 0-255, RGBA format
      const colBase = i * 4;
      this.centroidColors[colBase] = Math.round(color[0] * 255);
      this.centroidColors[colBase + 1] = Math.round(color[1] * 255);
      this.centroidColors[colBase + 2] = Math.round(color[2] * 255);
      this.centroidColors[colBase + 3] = 255; // full alpha

      // Store 3D position for labels
      const pos3D = [
        this.centroidPositions[3 * i],
        this.centroidPositions[3 * i + 1],
        this.centroidPositions[3 * i + 2]
      ];

      if (allowLabels && this.labelLayer) {
        const el = document.createElement('div');
        el.className = 'centroid-label';
        el.dataset.viewId = viewKey;
        el.textContent = String(c.category);
        this.labelLayer.appendChild(el);
        this.centroidLabels.push({ el, position: pos3D });
      }
    }
    if (typeof this.viewer.setCentroidLabels === 'function') {
      this.viewer.setCentroidLabels(this.centroidLabels, viewKey);
    }
  }

  updateLegendState(field) {
    if (!field) return null;
    if (field.kind === 'continuous') {
      const meta = this.ensureContinuousMetadata(field);
      if (!meta) return null;
      const colorDomain = this.getContinuousColorDomain(field);
      const colorbarMin = colorDomain?.min ?? meta.stats.min;
      const colorbarMax = colorDomain?.max ?? meta.stats.max;
      const colormap = getColormap(field._colormapId);
      const colorStops = getCssStopsForColormap(colormap.id);
      return {
        kind: 'continuous',
        stats: meta.stats,
        filter: meta.filter,
        scale: colorDomain.scale,
        logEnabled: field._useLogScale === true,
        colorStops,
        colormap: {
          id: colormap.id,
          label: colormap.label
        },
        colorbar: {
          min: colorbarMin,
          max: colorbarMax,
          usingFilter: colorDomain.usingFilter,
          scale: colorDomain.scale
        }
      };
    }
    this.ensureCategoryMetadata(field);
    const counts = field._categoryCounts || null;
    return {
      kind: 'category',
      categories: field.categories || [],
      colors: field._categoryColors,
      visible: field._categoryVisible,
      picker: COLOR_PICKER_PALETTE,
      counts
    };
  }

  applyContinuousFilter(fieldIndex, newMin, newMax) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    const meta = this.ensureContinuousMetadata(field);
    if (!meta) return;
    const stats = meta.stats;
    const clampedMin = clamp(newMin, stats.min, stats.max);
    const clampedMax = clamp(newMax, stats.min, stats.max);
    field._continuousFilter.min = Math.min(clampedMin, clampedMax);
    field._continuousFilter.max = Math.max(clampedMin, clampedMax);
    this.computeGlobalVisibility();
  }

  resetContinuousFilter(fieldIndex) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    const meta = this.ensureContinuousMetadata(field);
    if (!meta) return;
    field._continuousFilter.min = meta.stats.min;
    field._continuousFilter.max = meta.stats.max;
    this.computeGlobalVisibility();
  }

  setContinuousColorRescale(fieldIndex, enabled) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    this.ensureContinuousMetadata(field);
    field._useFilterColorRange = Boolean(enabled);
    this.updateColorsContinuous(field);
    this._pushColorsToViewer();
    this._syncActiveContext();
  }

  setContinuousColorRange(fieldIndex, min, max) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    const meta = this.ensureContinuousMetadata(field);
    if (!meta) return;
    const clampedMin = clamp(min, meta.stats.min, meta.stats.max);
    const clampedMax = clamp(max, meta.stats.min, meta.stats.max);
    field._continuousColorRange = {
      min: Math.min(clampedMin, clampedMax),
      max: Math.max(clampedMin, clampedMax)
    };
    if (field._useFilterColorRange) {
      this.updateColorsContinuous(field);
      this._pushColorsToViewer();
      this._syncActiveContext();
    }
  }

  setContinuousLogScale(fieldIndex, enabled) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    this.ensureContinuousMetadata(field);
    field._useLogScale = Boolean(enabled);
    this.updateColorsContinuous(field);
    this._pushColorsToViewer();
    this._syncActiveContext();
  }

  setContinuousColormap(fieldIndex, colormapId) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    const colormap = getColormap(colormapId);
    this.ensureContinuousMetadata(field);
    field._colormapId = colormap.id;
    this.updateColorsContinuous(field);
    this._pushColorsToViewer();
    this._syncActiveContext();
  }

  getContinuousColormaps() {
    return CONTINUOUS_COLORMAPS;
  }

}

Object.assign(DataStateColorMethods.prototype, colorOutlierMethods);

export class ColorManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
