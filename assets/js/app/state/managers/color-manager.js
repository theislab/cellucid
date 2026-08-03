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
  DEFAULT_COLORMAP_ID,
  getCategoryColor,
  getCssStopsForColormap,
  sampleContinuousColormap
} from '../../../data/palettes.js';
import { NEUTRAL_GRAY_UINT8 } from '../core/constants.js';
import {
  UndrawableContinuousPayloadError,
  createNonFiniteTally,
  hasUndrawableValues,
  recordNonFiniteValue,
} from '../../../data/continuous-payload-diagnosis.js';
import { BaseManager } from '../core/base-manager.js';
import { colorOutlierMethods } from './color-outliers.js';

function requireBoolean(value, context) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${context} must be exactly true or false.`);
  }
  return value;
}

function requireContinuousField(field) {
  if (
    field === null
    || typeof field !== 'object'
    || Array.isArray(field)
    || field.kind !== 'continuous'
  ) {
    throw new TypeError('Continuous color operations require a continuous field.');
  }
  if (
    !(field.values instanceof Float32Array)
    && !(field.values instanceof Float64Array)
  ) {
    throw new TypeError('Continuous field values must be a Float32Array or Float64Array.');
  }
  return field;
}

function requireFiniteRange(range, context, bounds = null) {
  if (
    range === null
    || typeof range !== 'object'
    || Array.isArray(range)
    || Object.keys(range).sort().join(',') !== 'max,min'
    || !Number.isFinite(range.min)
    || !Number.isFinite(range.max)
  ) {
    throw new TypeError(`${context} must contain exactly finite min and max values.`);
  }
  if (range.min > range.max) {
    throw new RangeError(`${context} min must not exceed max.`);
  }
  if (
    bounds !== null
    && (range.min < bounds.min || range.max > bounds.max)
  ) {
    throw new RangeError(`${context} must stay within the field data range.`);
  }
  return range;
}

function requireColormap(colormapId) {
  if (typeof colormapId !== 'string' || colormapId.length === 0) {
    throw new TypeError('Continuous colormap id must be a nonempty string.');
  }
  const colormap = CONTINUOUS_COLORMAPS.find(entry => entry.id === colormapId);
  if (!colormap) {
    throw new RangeError(`Continuous colormap "${colormapId}" is not supported.`);
  }
  return colormap;
}

function requireRgb(color, context) {
  if (!Array.isArray(color) || color.length !== 3) {
    throw new TypeError(`${context} must be an RGB triplet.`);
  }
  for (let channel = 0; channel < color.length; channel++) {
    if (
      !Number.isFinite(color[channel])
      || color[channel] < 0
      || color[channel] > 1
    ) {
      throw new RangeError(`${context} channels must be finite values from 0 through 1.`);
    }
  }
  return color;
}

function requireCategoryField(field) {
  if (
    field === null
    || typeof field !== 'object'
    || Array.isArray(field)
    || field.kind !== 'category'
    || !Array.isArray(field.categories)
    || field.categories.length === 0
  ) {
    throw new TypeError('Category color operations require a nonempty category field.');
  }
  const categories = new Set();
  for (let index = 0; index < field.categories.length; index++) {
    const category = field.categories[index];
    const type = typeof category;
    if (
      (type !== 'string' && type !== 'number' && type !== 'boolean')
      || (type === 'number' && !Number.isFinite(category))
    ) {
      throw new TypeError(
        `Category ${index} must be a string, finite number, or boolean.`
      );
    }
    if (categories.has(category)) {
      throw new TypeError(`Category ${index} duplicates an existing category label.`);
    }
    categories.add(category);
  }
  return field;
}

function computeContinuousDomain(field, meta, useLog) {
  const useFilterRange = field._useFilterColorRange;
  const baseDomain = useFilterRange ? meta.colorRange : meta.stats;
  let domainMin = baseDomain.min;
  let domainMax = baseDomain.max;

  if (useLog) {
    const positive = meta.positiveStats;
    if (positive === null) {
      throw new RangeError('Log color scale requires at least one positive field value.');
    }
    domainMin = Math.max(domainMin, positive.min);
    domainMax = Math.min(domainMax, positive.max);
    if (domainMin > domainMax) {
      throw new RangeError(
        'Log color scale requires the selected color range to include a positive value.'
      );
    }
  }

  return {
    min: domainMin,
    max: domainMax,
    scale: useLog ? 'log' : 'linear',
    usingFilter: useFilterRange
  };
}

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

  /**
   * Name the field in the words it is shown under, for a diagnosis.
   *
   * Gene or observation column is the only thing that changes the remedy — a
   * gene comes out of `adata.X` and a field out of `adata.obs` — so it has to be
   * a property of the field being described, not of the viewer.
   *
   * This read `activeFieldSource`, which is what the viewer is *currently*
   * coloured by. That is right only when the field being validated is also the
   * active one, and three of the callers are the opposite case:
   * `computeGlobalVisibility()` walks every obs field carrying a filter, and
   * `toggleFilterEnabled` / `removeFilter` validate one obs field by name. While
   * a gene was coloured, `activeFieldSource` was `'var'` for all of them, so an
   * `obs` column that could not be drawn was reported as a gene and handed the
   * reader `adata.X` repair advice for a column that is not in `adata.X`.
   *
   * Membership answers it truthfully: this object owns both collections.
   *
   * @param {{key?: unknown}} field
   * @returns {{kind: 'gene'|'field', name: string}}
   */
  describeContinuousFieldSubject(field) {
    const name = typeof field?.key === 'string' && field.key.length > 0
      ? field.key
      : 'unnamed';
    const varFields = this.varData?.fields;
    const isGene = Array.isArray(varFields)
      ? varFields.includes(field)
      : false;
    return {
      kind: isGene ? 'gene' : 'field',
      name,
    };
  }

  ensureContinuousMetadata(field) {
    requireContinuousField(field);
    if (field.values.length !== this.pointCount) {
      throw new RangeError('Continuous field values must match the current point count.');
    }

    let min = Infinity;
    let max = -Infinity;
    let minPositive = Infinity;
    let maxPositive = -Infinity;
    // The range scan is also the diagnosis scan. Reporting on the first
    // offending value would name one flat index and nothing else; counting them
    // here costs one pass that was already being made, and turns the refusal
    // into something the person looking at the screen can act on.
    const tally = createNonFiniteTally(field.values.length);
    for (let index = 0; index < field.values.length; index++) {
      const value = field.values[index];
      if (!Number.isFinite(value)) {
        recordNonFiniteValue(tally, value, index);
        continue;
      }
      if (value < min) min = value;
      if (value > max) max = value;
      if (value > 0) {
        if (value < minPositive) minPositive = value;
        if (value > maxPositive) maxPositive = value;
      }
    }
    if (hasUndrawableValues(tally) || min === Infinity) {
      throw new UndrawableContinuousPayloadError({
        subject: this.describeContinuousFieldSubject(field),
        tally,
      });
    }

    const computedStats = { min, max };
    let stats;
    if (field._continuousStats === undefined) {
      stats = computedStats;
    } else {
      requireFiniteRange(field._continuousStats, 'Continuous field statistics');
      if (
        field._continuousStats.min !== computedStats.min
        || field._continuousStats.max !== computedStats.max
      ) {
        throw new RangeError('Continuous field statistics do not match its values.');
      }
      stats = field._continuousStats;
    }

    let filter;
    if (field._continuousFilter === undefined) {
      filter = {
        min: stats.min,
        max: stats.max
      };
    } else {
      filter = requireFiniteRange(
        field._continuousFilter,
        'Continuous filter range',
        stats
      );
    }

    let useFilterColorRange;
    if (field._useFilterColorRange === undefined) {
      useFilterColorRange = true;
    } else {
      useFilterColorRange = requireBoolean(
        field._useFilterColorRange,
        'Continuous color rescale'
      );
    }

    let colorRange;
    if (field._continuousColorRange === undefined) {
      colorRange = {
        min: filter.min,
        max: filter.max
      };
    } else {
      colorRange = requireFiniteRange(
        field._continuousColorRange,
        'Continuous color range',
        stats
      );
    }

    const computedPositiveStats = minPositive === Infinity
      ? null
      : { min: minPositive, max: maxPositive };
    let positiveStats;
    if (field._positiveStats === undefined) {
      positiveStats = computedPositiveStats;
    } else if (field._positiveStats === null) {
      if (computedPositiveStats !== null) {
        throw new RangeError('Continuous positive statistics do not match its values.');
      }
      positiveStats = null;
    } else {
      requireFiniteRange(field._positiveStats, 'Continuous positive statistics');
      if (
        field._positiveStats.min <= 0
        || field._positiveStats.min !== computedPositiveStats?.min
        || field._positiveStats.max !== computedPositiveStats?.max
      ) {
        throw new RangeError('Continuous positive statistics do not match its values.');
      }
      positiveStats = field._positiveStats;
    }

    let useLogScale;
    if (field._useLogScale === undefined) {
      useLogScale = false;
    } else {
      useLogScale = requireBoolean(field._useLogScale, 'Continuous log scale');
    }

    const colormapId = field._colormapId === undefined
      ? DEFAULT_COLORMAP_ID
      : field._colormapId;
    requireColormap(colormapId);

    let filterEnabled;
    if (field._filterEnabled === undefined) {
      filterEnabled = true;
    } else {
      filterEnabled = requireBoolean(field._filterEnabled, 'Continuous filter enabled');
    }

    if (useLogScale) {
      computeContinuousDomain(
        { _useFilterColorRange: useFilterColorRange },
        {
          stats,
          colorRange,
          positiveStats
        },
        true
      );
    }

    field._continuousStats = stats;
    field._continuousFilter = filter;
    field._useFilterColorRange = useFilterColorRange;
    field._continuousColorRange = colorRange;
    field._positiveStats = positiveStats;
    field._useLogScale = useLogScale;
    field._colormapId = colormapId;
    field._filterEnabled = filterEnabled;

    return {
      stats,
      filter,
      colorRange,
      positiveStats
    };
  }

  getContinuousColorDomain(field) {
    const meta = this.ensureContinuousMetadata(field);
    return computeContinuousDomain(field, meta, field._useLogScale);
  }

  updateColorsContinuous(field, { resetTransparency = false } = {}) {
    requireBoolean(resetTransparency, 'Continuous transparency reset');
    this.ensureContinuousMetadata(field);
    const domain = this.getContinuousColorDomain(field);
    const colormap = requireColormap(field._colormapId);
    const useLog = domain.scale === 'log';
    const domainMin = domain.min;
    const domainMax = domain.max;
    const logMin = useLog ? Math.log10(domainMin) : 0;
    const denom = useLog ? (Math.log10(domainMax) - logMin) : (domainMax - domainMin);
    const isConstantDomain = denom === 0;
    const values = field.values;
    const n = this.pointCount;

    if (
      !(this.colorsArray instanceof Uint8Array)
      || this.colorsArray.length !== n * 4
      || !(this.categoryTransparency instanceof Float32Array)
      || this.categoryTransparency.length !== n
    ) {
      throw new TypeError('Continuous coloring requires complete color and transparency buffers.');
    }
    if (resetTransparency) {
      this.categoryTransparency.fill(1.0);
    }

    for (let i = 0; i < n; i++) {
      const v = values[i];
      let r, g, b;
      if (Number.isNaN(v) || (useLog && v <= 0)) {
        r = NEUTRAL_GRAY_UINT8; g = NEUTRAL_GRAY_UINT8; b = NEUTRAL_GRAY_UINT8;
      } else {
        let t;
        if (isConstantDomain) {
          t = 0.5;
        } else if (useLog) {
          t = (Math.log10(v) - logMin) / denom;
        } else {
          t = (v - domainMin) / denom;
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
    if (
      !(this.colorsArray instanceof Uint8Array)
      || this.colorsArray.length !== n * 4
      || !(alpha instanceof Float32Array)
      || alpha.length !== n
    ) {
      throw new TypeError('Color alpha synchronization requires complete typed buffers.');
    }
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(alpha[i]) || alpha[i] < 0 || alpha[i] > 1) {
        throw new RangeError(`Transparency value ${i} must be from 0 through 1.`);
      }
      this.colorsArray[i * 4 + 3] = Math.round(alpha[i] * 255);
    }
  }

  ensureCategoryMetadata(field) {
    requireCategoryField(field);
    const categories = field.categories;
    const numCats = categories.length;
    let categoryColors;
    if (field._categoryColors === undefined) {
      categoryColors = new Array(numCats);
      for (let i = 0; i < numCats; i++) {
        categoryColors[i] = getCategoryColor(i);
      }
    } else {
      if (
        !Array.isArray(field._categoryColors)
        || field._categoryColors.length !== numCats
      ) {
        throw new TypeError('Category colors must contain one RGB triplet per category.');
      }
      for (let i = 0; i < numCats; i++) {
        requireRgb(field._categoryColors[i], `Category color ${i}`);
      }
      categoryColors = field._categoryColors;
    }

    let categoryVisible;
    if (field._categoryVisible === undefined) {
      categoryVisible = {};
      for (let i = 0; i < numCats; i++) {
        categoryVisible[i] = true;
      }
    } else {
      if (
        field._categoryVisible === null
        || typeof field._categoryVisible !== 'object'
        || Array.isArray(field._categoryVisible)
      ) {
        throw new TypeError('Category visibility must be an indexed object.');
      }
      const visibilityKeys = Object.keys(field._categoryVisible);
      if (
        visibilityKeys.length !== numCats
        || visibilityKeys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError('Category visibility must contain every category index exactly once.');
      }
      for (let i = 0; i < numCats; i++) {
        requireBoolean(field._categoryVisible[i], `Category visibility ${i}`);
      }
      categoryVisible = field._categoryVisible;
    }

    let categoryFilterEnabled;
    if (field._categoryFilterEnabled === undefined) {
      categoryFilterEnabled = true;
    } else {
      categoryFilterEnabled = requireBoolean(
        field._categoryFilterEnabled,
        'Category filter enabled'
      );
    }

    field._categoryColors = categoryColors;
    field._categoryVisible = categoryVisible;
    field._categoryFilterEnabled = categoryFilterEnabled;
  }

  updateColorsCategorical(field) {
    const n = this.pointCount;
    requireCategoryField(field);
    const categories = field.categories;
    const codes = field.codes;
    const numCats = categories.length;

    if (
      (!(codes instanceof Uint8Array) && !(codes instanceof Uint16Array))
      || codes.length !== n
      || !(this.colorsArray instanceof Uint8Array)
      || this.colorsArray.length !== n * 4
      || !(this.categoryTransparency instanceof Float32Array)
      || this.categoryTransparency.length !== n
    ) {
      throw new TypeError('Category coloring requires complete category, color, and transparency buffers.');
    }
    this.ensureCategoryMetadata(field);
    const catColors = field._categoryColors;
    const catVisible = field._categoryVisible;
    const missingCode = codes instanceof Uint8Array ? 255 : 65_535;
    for (let i = 0; i < n; i++) {
      const code = codes[i];
      if (code >= numCats && code !== missingCode) {
        throw new RangeError(`Category code ${i} is outside the category inventory.`);
      }
    }

    for (let i = 0; i < n; i++) {
      const code = codes[i];
      let r, g, b, alpha;
      if (code === missingCode) {
        r = NEUTRAL_GRAY_UINT8; g = NEUTRAL_GRAY_UINT8; b = NEUTRAL_GRAY_UINT8;
        alpha = 1.0;
      } else {
        const isVisible = catVisible[code];
        const c = catColors[code];
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

  buildCentroidsForField(field, options) {
    requireCategoryField(field);
    if (
      options === null
      || typeof options !== 'object'
      || Array.isArray(options)
      || Object.keys(options).join(',') !== 'viewId'
      || typeof options.viewId !== 'string'
      || options.viewId.length === 0
    ) {
      throw new TypeError('Centroid construction requires exactly one nonempty viewId.');
    }
    // Get dimension-specific centroids based on current dimension level
    const currentDim = this.activeDimensionLevel;
    if (!Number.isInteger(currentDim) || currentDim < 1 || currentDim > 3) {
      throw new RangeError('Centroid construction requires dimension 1, 2, or 3.');
    }
    const centroidsByDim = field.centroidsByDim;
    if (
      centroidsByDim === null
      || typeof centroidsByDim !== 'object'
      || Array.isArray(centroidsByDim)
    ) {
      throw new TypeError('Category field centroidsByDim must be an object.');
    }

    // Get centroids for current dimension
    const dimensionKey = String(currentDim);
    const centroids = Object.hasOwn(centroidsByDim, dimensionKey)
      ? centroidsByDim[dimensionKey]
      : [];
    if (!Array.isArray(centroids)) {
      throw new TypeError(`Category centroids for ${currentDim}D must be an array.`);
    }
    const categories = field.categories;
    this.ensureCategoryMetadata(field);
    const catColors = field._categoryColors;
    const catIndexByName = new Map();
    categories.forEach((category, index) => {
      if (catIndexByName.has(category)) {
        throw new TypeError('Centroid category inventory must not contain duplicates.');
      }
      catIndexByName.set(category, index);
    });
    for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
      const centroid = centroids[centroidIndex];
      if (
        centroid === null
        || typeof centroid !== 'object'
        || Array.isArray(centroid)
        || !Array.isArray(centroid.position)
        || centroid.position.length !== currentDim
        || !Number.isSafeInteger(centroid.n_points)
        || centroid.n_points < 0
      ) {
        throw new TypeError(
          `Centroid ${centroidIndex} must contain an exact ${currentDim}D position and point count.`
        );
      }
      for (let coordinate = 0; coordinate < centroid.position.length; coordinate++) {
        if (!Number.isFinite(centroid.position[coordinate])) {
          throw new TypeError(
            `Centroid ${centroidIndex} coordinate ${coordinate} must be finite.`
          );
        }
      }
      if (!catIndexByName.has(centroid.category)) {
        throw new RangeError(`Centroid ${centroidIndex} references an unknown category.`);
      }
    }

    // Lazy normalization: normalize centroids for this dimension if not already done.
    // Each dimension has its own normalization transform, so we track per-dimension.
    // This ensures centroids are correctly positioned regardless of which dimension
    // was loaded first or when switching between dimensions.
    //
    // centroidsByDim: per-dimension arrays, each normalized with its own transform
    if (centroids.length > 0) {
      if (field._normalizedDims === null || field._normalizedDims === undefined) {
        field._normalizedDims = new Set();
      } else if (!(field._normalizedDims instanceof Set)) {
        throw new TypeError('Centroid normalization state must be a Set.');
      }

      const dimKey = String(currentDim);

      // Check if this centroid array needs normalization
      if (!field._normalizedDims.has(dimKey)) {
        if (
          !this.dimensionManager
          || typeof this.dimensionManager.getNormTransform !== 'function'
        ) {
          throw new TypeError('Centroid normalization requires the current DimensionManager.');
        }
        const normTransform = this.dimensionManager.getNormTransform(currentDim);
        if (
          !normTransform
          || typeof normTransform !== 'object'
          || !Array.isArray(normTransform.center)
          || normTransform.center.length !== 3
          || normTransform.center.some((coordinate) => !Number.isFinite(coordinate))
          || !Number.isFinite(normTransform.scale)
          || normTransform.scale <= 0
        ) {
          throw new TypeError('Centroid normalization transform is unavailable or invalid.');
        }
        const { center, scale } = normTransform;
        const [cx, cy, cz] = center;

        // Normalize each centroid's position in-place
        for (const c of centroids) {
          const p = c.position;
          if (p.length >= 1) p[0] = (p[0] - cx) * scale;
          if (p.length >= 2) p[1] = (p[1] - cy) * scale;
          if (p.length >= 3) p[2] = (p[2] - cz) * scale;
        }

        field._normalizedDims.add(dimKey);
      }
    }

    // Determine the native dimension of these centroids (from position array length)
    const nativeDim = currentDim;

    const viewKey = options.viewId;
    this.centroidCount = centroids.length;
    const allowLabels = true;

    this.centroidPositions = new Float32Array(this.centroidCount * 3);
    this.centroidColors = new Uint8Array(this.centroidCount * 4); // RGBA uint8
    this.centroidOutliers = new Float32Array(this.centroidCount);
    this.centroidOutliers.fill(-1.0);

    this.centroidLabels = [];
    if (allowLabels && this.labelLayer) this._removeLabelsForView(viewKey);

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
      const pos = c.position;

      // Pad lower-dimensional positions to 3D for rendering
      // 1D: [x] -> [x, 0, 0]
      // 2D: [x, y] -> [x, y, 0]
      // 3D: [x, y, z] -> [x, y, z]
      this.centroidPositions[3 * i] = pos[0];
      this.centroidPositions[3 * i + 1] = nativeDim >= 2 ? pos[1] : 0;
      this.centroidPositions[3 * i + 2] = nativeDim >= 3 ? pos[2] : 0;

      const idx = catIndexByName.get(c.category);
      const color = catColors[idx];
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
    if (
      field === null
      || typeof field !== 'object'
      || (field.kind !== 'continuous' && field.kind !== 'category')
    ) {
      throw new TypeError('Legend state requires a category or continuous field.');
    }
    if (field.kind === 'continuous') {
      const meta = this.ensureContinuousMetadata(field);
      const colorDomain = this.getContinuousColorDomain(field);
      const colorbarMin = colorDomain.min;
      const colorbarMax = colorDomain.max;
      const colormap = requireColormap(field._colormapId);
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
      categories: field.categories,
      colors: field._categoryColors,
      visible: field._categoryVisible,
      picker: COLOR_PICKER_PALETTE,
      counts
    };
  }

  applyContinuousFilter(fieldIndex, newMin, newMax) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    requireContinuousField(field);
    const meta = this.ensureContinuousMetadata(field);
    const stats = meta.stats;
    const next = requireFiniteRange(
      { min: newMin, max: newMax },
      'Continuous filter range',
      stats
    );
    field._continuousFilter.min = next.min;
    field._continuousFilter.max = next.max;
    this.computeGlobalVisibility();
  }

  resetContinuousFilter(fieldIndex) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    requireContinuousField(field);
    const meta = this.ensureContinuousMetadata(field);
    field._continuousFilter.min = meta.stats.min;
    field._continuousFilter.max = meta.stats.max;
    this.computeGlobalVisibility();
  }

  setContinuousColorRescale(fieldIndex, enabled) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    requireContinuousField(field);
    requireBoolean(enabled, 'Continuous color rescale');
    this.ensureContinuousMetadata(field);
    if (field._useLogScale) {
      computeContinuousDomain(
        { ...field, _useFilterColorRange: enabled },
        {
          stats: field._continuousStats,
          colorRange: field._continuousColorRange,
          positiveStats: field._positiveStats
        },
        true
      );
    }
    field._useFilterColorRange = enabled;
    this.updateColorsContinuous(field);
    this._pushColorsToViewer();
    this._syncActiveContext();
  }

  setContinuousColorRange(fieldIndex, min, max) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    requireContinuousField(field);
    const meta = this.ensureContinuousMetadata(field);
    const nextRange = requireFiniteRange(
      { min, max },
      'Continuous color range',
      meta.stats
    );
    if (field._useFilterColorRange && field._useLogScale) {
      computeContinuousDomain(
        { ...field, _continuousColorRange: nextRange },
        { ...meta, colorRange: nextRange },
        true
      );
    }
    field._continuousColorRange = nextRange;
    if (field._useFilterColorRange) {
      this.updateColorsContinuous(field);
      this._pushColorsToViewer();
      this._syncActiveContext();
    }
  }

  setContinuousLogScale(fieldIndex, enabled) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    requireContinuousField(field);
    requireBoolean(enabled, 'Continuous log scale');
    const meta = this.ensureContinuousMetadata(field);
    if (enabled) computeContinuousDomain(field, meta, true);
    field._useLogScale = enabled;
    this.updateColorsContinuous(field);
    this._pushColorsToViewer();
    this._syncActiveContext();
  }

  setContinuousColormap(fieldIndex, colormapId) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    requireContinuousField(field);
    const colormap = requireColormap(colormapId);
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
