/**
 * @fileoverview View context and snapshot management helpers for DataState.
 *
 * Split out of `view-manager.js` to keep modules below the refactoring size
 * limit while preserving behavior and performance characteristics.
 *
 * @module state/managers/view-context-core
 */

import { FieldSource } from '../../utils/field-constants.js';
import { collectViewFilters } from './filter-manager.js';
import { getFieldRegistry } from '../../utils/field-registry.js';
import { markSnapshotPublishedColors } from './per-cell-array-ownership.js';
import {
  POINT_VISIBILITY_THRESHOLD,
  requirePointTransparency,
} from '../../../rendering/alpha-visibility.js';

/**
 * Validate a kept view's point attributes and adopt them by reference.
 *
 * `colors` is the kept view's own array, which the viewer just published for
 * the snapshot by reference (it is frozen from here on), and `transparency`
 * is the source view's current array: the new context shares it until either
 * view's next visibility write, which copies first (see
 * per-cell-array-ownership.js). Centroid arrays are a few bytes per category
 * and are written in place, so they are copied.
 */
function adoptSnapshotPointAttributes(config, pointCount) {
  if (
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config)
  ) {
    throw new TypeError(
      'Snapshot context attributes require one configuration object.'
    );
  }
  if (
    !(config.colors instanceof Uint8Array) ||
    config.colors.length !== pointCount * 4
  ) {
    throw new TypeError(
      'Snapshot context colors must be an exact dataset-length Uint8 RGBA array.'
    );
  }
  requirePointTransparency(
    config.transparency,
    pointCount,
    'Snapshot context transparency'
  );

  const hasCentroidPositions = config.centroidPositions !== null;
  const hasCentroidColors = config.centroidColors !== null;
  if (hasCentroidPositions !== hasCentroidColors) {
    throw new TypeError(
      'Snapshot context centroid positions and colors must be published together.'
    );
  }
  let centroidPositions = null;
  let centroidColors = null;
  if (hasCentroidPositions) {
    if (
      !(config.centroidPositions instanceof Float32Array) ||
      config.centroidPositions.length % 3 !== 0
    ) {
      throw new TypeError(
        'Snapshot context centroids must contain complete Float32 XYZ triples.'
      );
    }
    const centroidCount = config.centroidPositions.length / 3;
    if (
      !(config.centroidColors instanceof Uint8Array) ||
      config.centroidColors.length !== centroidCount * 4
    ) {
      throw new TypeError(
        'Snapshot context centroid colors must contain one Uint8 RGBA value per centroid.'
      );
    }
    for (
      let index = 0;
      index < config.centroidPositions.length;
      index += 1
    ) {
      if (!Number.isFinite(config.centroidPositions[index])) {
        throw new RangeError(
          `Snapshot context centroid position ${index} must be finite.`
        );
      }
    }
    centroidPositions = new Float32Array(config.centroidPositions);
    centroidColors = new Uint8Array(config.centroidColors);
  }
  markSnapshotPublishedColors(config.colors);
  return {
    colors: config.colors,
    transparency: config.transparency,
    centroidPositions,
    centroidColors,
  };
}

function exactTypedArrayEqual(left, right) {
  if (
    !ArrayBuffer.isView(left) ||
    !ArrayBuffer.isView(right) ||
    left?.constructor !== right?.constructor ||
    left.length !== right.length
  ) {
    return left === right;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function composeViewLabel(field, filters) {
  const firstFilter = filters && filters.length ? filters[0] : null;
  const labelParts = [];
  if (field && field.key) labelParts.push(field.key);
  if (firstFilter && !/No filters active/i.test(firstFilter)) {
    labelParts.push(firstFilter);
  }
  const label = labelParts.join(' • ') || 'All cells';
  return {
    label,
    fieldKey: field ? field.key : null,
    fieldKind: field ? field.kind : null,
    filtersText: filters || []
  };
}

function activeFieldOfContext(ctx) {
  if (ctx.activeFieldSource === FieldSource.OBS) {
    return ctx.obsData?.fields?.[ctx.activeFieldIndex] ?? null;
  }
  if (ctx.activeFieldSource === FieldSource.VAR) {
    return ctx.varData?.fields?.[ctx.activeVarFieldIndex] ?? null;
  }
  return null;
}

function sameFieldIdentity(candidate, renamed) {
  if (candidate === null || typeof candidate !== 'object') return false;
  if (renamed._isUserDefined === true) {
    return candidate._isUserDefined === true
      && candidate._userDefinedId === renamed._userDefinedId;
  }
  if (candidate._isUserDefined === true) return false;
  const originalOf = (field) => (
    Object.hasOwn(field, '_originalKey') ? field._originalKey : field.key
  );
  return originalOf(candidate) === originalOf(renamed);
}

export const viewContextCoreMethods = {
  _removeLabelsForView(viewId) {
    if (!this.labelLayer) return;
    const target = String(viewId ?? this.activeViewId ?? 'live');
    const nodes = Array.from(this.labelLayer.querySelectorAll(`[data-view-id="${target}"]`));
    nodes.forEach((node) => node.remove());
  },

  _cloneFieldState(field) {
    if (!field) return null;
    const clone = { ...field };
    if (field._categoryColors) clone._categoryColors = field._categoryColors.map((c) => (c ? [...c] : c));
    if (field._categoryVisible) clone._categoryVisible = { ...field._categoryVisible };
    if (field._continuousStats) clone._continuousStats = { ...field._continuousStats };
    if (field._continuousFilter) clone._continuousFilter = { ...field._continuousFilter };
    if (field._continuousColorRange) clone._continuousColorRange = { ...field._continuousColorRange };
    if (field._positiveStats) clone._positiveStats = { ...field._positiveStats };
    if (field._useFilterColorRange != null) clone._useFilterColorRange = field._useFilterColorRange;
    if (field._useLogScale != null) clone._useLogScale = field._useLogScale;
    if (field._filterEnabled != null) clone._filterEnabled = field._filterEnabled;
    if (field._categoryFilterEnabled != null) clone._categoryFilterEnabled = field._categoryFilterEnabled;
    if (field._outlierFilterEnabled != null) clone._outlierFilterEnabled = field._outlierFilterEnabled;
    if (field._outlierThreshold != null) clone._outlierThreshold = field._outlierThreshold;
    if (field._categoryCounts) {
      // Copy the whole count record: every array (total/available/visible)
      // and every scalar total. A partial copy left `available` behind and the
      // Active filters row of a view read "N / 0 cells" after a view switch.
      clone._categoryCounts = Object.fromEntries(
        Object.entries(field._categoryCounts).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value
        ])
      );
    }
    clone._loadingPromise = null;
    return clone;
  },

  _cloneObsData(obsData) {
    if (!obsData) return null;
    const fields = (obsData.fields || []).map((f) => this._cloneFieldState(f));
    return { ...obsData, fields };
  },

  _cloneVarData(varData) {
    if (!varData) return null;
    const fields = (varData.fields || []).map((f) => this._cloneFieldState(f));
    return { ...varData, fields };
  },

  _buildContextFromCurrent(id, { cloneArrays = true } = {}) {
    const ctx = {
      id: String(id),
      obsData: this._cloneObsData(this.obsData),
      varData: this._cloneVarData(this.varData),
      activeFieldIndex: this.activeFieldIndex,
      activeVarFieldIndex: this.activeVarFieldIndex,
      activeFieldSource: this.activeFieldSource,
      // A new context shows its dimension's default until a representation
      // is chosen for it.
      followsDefault: true
    };

    const wrap = (arr) => {
      if (!arr) return null;
      return cloneArrays ? arr.slice() : arr;
    };
    ctx.colorsArray = wrap(this.colorsArray);
    ctx.categoryTransparency = wrap(this.categoryTransparency);
    ctx.cellVisibilityMask = wrap(this.cellVisibilityMask);
    ctx.centroidPositions = wrap(this.centroidPositions);
    ctx.centroidColors = wrap(this.centroidColors);
    ctx.centroidOutliers = wrap(this.centroidOutliers);
    ctx.centroidLabels = this.centroidLabels ? [...this.centroidLabels] : [];
    ctx.filteredCount = this.filteredCount
      ? { ...this.filteredCount }
      : { shown: this.pointCount, total: this.pointCount };
    return ctx;
  },

  /**
   * A new context with the field state of `source`.
   *
   * The per-cell arrays (colors, transparency, cell mask) are shared, not
   * copied: whichever view writes one next copies it first
   * (per-cell-array-ownership.js), so
   * a kept view costs no per-cell bytes until it actually diverges. The
   * centroid arrays are a few bytes per category and are written in place, so
   * they are copied.
   */
  _cloneViewContext(source, id) {
    if (
      source === null ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      typeof source.id !== 'string' ||
      source.id.length === 0 ||
      source.id.trim() !== source.id
    ) {
      throw new TypeError(
        'View-context cloning requires one exact published source context.'
      );
    }
    const exactBuffer = (value, Type, copy) => {
      if (value === null || value === undefined) return null;
      if (!(value instanceof Type)) {
        throw new TypeError(
          `View "${source.id}" contains a non-${Type.name} context buffer.`
        );
      }
      return copy ? new Type(value) : value;
    };
    return {
      id,
      obsData: this._cloneObsData(source.obsData),
      varData: this._cloneVarData(source.varData),
      activeFieldIndex: source.activeFieldIndex,
      activeVarFieldIndex: source.activeVarFieldIndex,
      activeFieldSource: source.activeFieldSource,
      // The representation itself is the dimension manager's (copyViewLayout);
      // whether it was chosen or followed is the view's.
      followsDefault: source.followsDefault === true,
      colorsArray: exactBuffer(source.colorsArray, Uint8Array, false),
      categoryTransparency: exactBuffer(source.categoryTransparency, Uint8Array, false),
      cellVisibilityMask: exactBuffer(source.cellVisibilityMask, Uint8Array, false),
      centroidPositions: exactBuffer(source.centroidPositions, Float32Array, true),
      centroidColors: exactBuffer(source.centroidColors, Uint8Array, true),
      centroidOutliers: exactBuffer(source.centroidOutliers, Float32Array, true),
      centroidLabels: Array.isArray(source.centroidLabels)
        ? source.centroidLabels.map(label => (
            label === null || label === undefined
              ? label
              : { ...label }
          ))
        : [],
      filteredCount: source.filteredCount
        ? { ...source.filteredCount }
        : { shown: this.pointCount, total: this.pointCount },
    };
  },

  captureCurrentContext() {
    return this._buildContextFromCurrent(this.activeViewId || 'live', { cloneArrays: true });
  },

  restoreContext(ctx, { preserveSnapshots = true } = {}) {
    if (!ctx) return;
    this.obsData = this._cloneObsData(ctx.obsData);
    this.varData = this._cloneVarData(ctx.varData);
    this.activeFieldIndex = ctx.activeFieldIndex ?? -1;
    this.activeVarFieldIndex = ctx.activeVarFieldIndex ?? -1;
    this.activeFieldSource = ctx.activeFieldSource ?? null;
    this.colorsArray = ctx.colorsArray ? new Uint8Array(ctx.colorsArray) : null;
    this.categoryTransparency = ctx.categoryTransparency ? new Uint8Array(ctx.categoryTransparency) : null;
    this.cellVisibilityMask = ctx.cellVisibilityMask ? new Uint8Array(ctx.cellVisibilityMask) : null;
    this.centroidPositions = ctx.centroidPositions ? new Float32Array(ctx.centroidPositions) : null;
    this.centroidColors = ctx.centroidColors ? new Uint8Array(ctx.centroidColors) : null;
    this.centroidOutliers = ctx.centroidOutliers ? new Float32Array(ctx.centroidOutliers) : null;
    this.centroidLabels = ctx.centroidLabels ? ctx.centroidLabels.map((c) => (c ? { ...c } : c)) : [];
    this.filteredCount = ctx.filteredCount ? { ...ctx.filteredCount } : { shown: this.pointCount, total: this.pointCount };

    this._applyOverlaysToFields(
      this.obsData === null ? null : this.obsData.fields,
      FieldSource.OBS
    );
    this._applyOverlaysToFields(
      this.varData === null ? null : this.varData.fields,
      FieldSource.VAR
    );
    this._injectUserDefinedFields();
    this._ensureActiveSelectionNotDeleted();
    getFieldRegistry().invalidate();

    if (preserveSnapshots) {
      // A context holds the view's data state; which representation it shows
      // is the dimension manager's, and whether it follows its dimension's
      // default stays what the live view has. A fresh context claims it
      // follows, and a later mapping change then moved a live view that
      // shows a representation it was turned to (a session restore did).
      const followsDefault = this.viewContexts.get('live')?.followsDefault ?? true;
      this.activeViewId = 'live';
      const live = this._buildContextFromCurrent('live', { cloneArrays: false });
      live.followsDefault = followsDefault === true;
      this.viewContexts.set('live', live);
    } else {
      this._resetViewContexts();
    }
    this._syncActiveContext();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushCentroidsToViewer();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
  },

  /**
   * Point the active view's context at the current state.
   *
   * The active context shares the state's per-cell arrays instead of copying
   * them: this runs after every coloring, filtering and centroid change, and a
   * copy of four per-cell arrays each time was hundreds of megabytes of
   * transient memory while one large dataset loaded. A context needs arrays of
   * its own only once its view stops being active, and `setActiveView` hands
   * the outgoing arrays to it at exactly that point.
   */
  _syncActiveContext() {
    const ctx = this.viewContexts.get(String(this.activeViewId));
    if (!ctx) return;
    ctx.obsData = this._cloneObsData(this.obsData);
    ctx.varData = this._cloneVarData(this.varData);
    ctx.activeFieldIndex = this.activeFieldIndex;
    ctx.activeVarFieldIndex = this.activeVarFieldIndex;
    ctx.activeFieldSource = this.activeFieldSource;
    ctx.colorsArray = this.colorsArray ?? null;
    ctx.categoryTransparency = this.categoryTransparency ?? null;
    ctx.cellVisibilityMask = this.cellVisibilityMask ?? null;
    ctx.centroidPositions = this.centroidPositions ?? null;
    ctx.centroidColors = this.centroidColors ?? null;
    ctx.centroidOutliers = this.centroidOutliers ?? null;
    ctx.centroidLabels = this.centroidLabels ? [...this.centroidLabels] : [];
    ctx.filteredCount = this.filteredCount ? { ...this.filteredCount } : { shown: 0, total: 0 };
  },

  _resetViewContexts() {
    this.viewContexts.clear();
    const liveCtx = this._buildContextFromCurrent('live', { cloneArrays: false });
    this.viewContexts.set('live', liveCtx);
    this.activeViewId = 'live';
  },

  _computeActiveViewLabel(filtersOverride) {
    const field = this.getActiveField();
    const filters = Array.isArray(filtersOverride)
      ? filtersOverride
      : this.getFilterSummaryLines();
    return composeViewLabel(field, filters);
  },

  /**
   * Re-publish the label and filter text of every view that is not focused.
   *
   * Renames are dataset-wide, so a rename made from one view changes what
   * every other view's label and filter summary say. These are the same
   * strings the focused view publishes (`_computeActiveViewLabel`), which a
   * saved session replays and compares exactly.
   */
  _refreshInactiveViewLabels() {
    if (!this.viewer || !(this.viewContexts instanceof Map)) return;
    const activeId = String(this.activeViewId);
    for (const [viewId, ctx] of this.viewContexts) {
      if (viewId === activeId) continue;
      const rows = collectViewFilters(ctx);
      const filters = rows.length > 0
        ? rows.map((row) => row.text)
        : ['No filters active'];
      const { label, fieldKey, fieldKind, filtersText } =
        composeViewLabel(activeFieldOfContext(ctx), filters);
      if (viewId === 'live') {
        if (typeof this.viewer.setLiveViewLabel === 'function') {
          this.viewer.setLiveViewLabel(label);
        }
        continue;
      }
      if (typeof this.viewer.updateSnapshotAttributes === 'function') {
        this.viewer.updateSnapshotAttributes(viewId, {
          label,
          fieldKey,
          fieldKind,
          meta: { filtersText }
        });
      }
    }
  },

  /**
   * Carry a dataset-wide rename of one field into every stored view context.
   *
   * View contexts hold shallow clones of the field inventory, so a rename in
   * the focused view reached only that view's objects: a kept view went on
   * naming the field by its old key (and saved it so), and lacked the
   * original key/categories a later revert needs. The rename-owned
   * properties are copied from the renamed field onto the same field in every
   * other view, and those views' centroid labels follow a category rename.
   *
   * @param {'obs'|'var'} source
   * @param {object} renamed - The focused view's renamed field.
   * @param {{previousLabel: unknown, newLabel: unknown}|null} categoryRename
   */
  _propagateRenameToViewContexts(source, renamed, categoryRename = null) {
    if (!(this.viewContexts instanceof Map)) return;
    const activeId = String(this.activeViewId);
    for (const [viewId, ctx] of this.viewContexts) {
      if (viewId === activeId) continue;
      const inventory = source === FieldSource.VAR ? ctx.varData : ctx.obsData;
      if (!inventory || !Array.isArray(inventory.fields)) continue;
      const fieldIndex = inventory.fields.findIndex(
        (candidate) => sameFieldIdentity(candidate, renamed)
      );
      if (fieldIndex < 0) continue;
      const target = inventory.fields[fieldIndex];
      target.key = renamed.key;
      if (Object.hasOwn(renamed, '_originalKey')) {
        target._originalKey = renamed._originalKey;
      } else {
        delete target._originalKey;
      }
      if (Array.isArray(renamed.categories)) {
        if (target.categories !== renamed.categories) {
          target.categories = [...renamed.categories];
        }
        if (Array.isArray(renamed._originalCategories)) {
          target._originalCategories = [...renamed._originalCategories];
        } else {
          delete target._originalCategories;
        }
      }
      const showsField = source === FieldSource.OBS
        ? ctx.activeFieldSource === FieldSource.OBS
          && ctx.activeFieldIndex === fieldIndex
        : ctx.activeFieldSource === FieldSource.VAR
          && ctx.activeVarFieldIndex === fieldIndex;
      if (
        categoryRename !== null
        && showsField
        && Array.isArray(ctx.centroidLabels)
      ) {
        const previousText = String(categoryRename.previousLabel);
        let relabelled = false;
        for (const entry of ctx.centroidLabels) {
          if (entry?.el && entry.el.textContent === previousText) {
            entry.el.textContent = String(categoryRename.newLabel);
            relabelled = true;
          }
        }
        if (
          relabelled
          && typeof this.viewer?.setCentroidLabels === 'function'
        ) {
          this.viewer.setCentroidLabels(ctx.centroidLabels, viewId);
        }
      }
    }
  },

  _pushActiveViewLabelToViewer(filtersOverride) {
    if (!this.viewer) return;
    const { label, fieldKey, fieldKind, filtersText } =
      this._computeActiveViewLabel(filtersOverride);
    if (String(this.activeViewId) === 'live') {
      if (typeof this.viewer.setLiveViewLabel === 'function') {
        this.viewer.setLiveViewLabel(label);
      }
      return;
    }
    if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, {
        label,
        fieldKey,
        fieldKind,
        meta: { filtersText }
      });
    }
  },

  setActiveView(viewId) {
    if (typeof viewId !== 'string' || viewId.trim().length === 0) {
      throw new TypeError('Active view id must be a non-empty string.');
    }
    if (!(this.viewContexts instanceof Map)) {
      throw new TypeError('Active view selection requires the exact view-context map.');
    }
    if (!this.viewContexts.has(viewId)) {
      throw new RangeError(`Active view "${viewId}" does not exist.`);
    }
    const key = viewId;
    const ctx = this.viewContexts.get(key);
    if (
      ctx === null
      || typeof ctx !== 'object'
      || Array.isArray(ctx)
      || ctx.id !== key
    ) {
      throw new TypeError(`Active view "${key}" has an invalid context.`);
    }

    const prevKey = this.activeViewId;
    if (
      typeof prevKey !== 'string'
      || prevKey.trim().length === 0
      || !this.viewContexts.has(prevKey)
    ) {
      throw new Error('The current active view does not have an exact context.');
    }
    const prevCtx = this.viewContexts.get(prevKey);
    if (
      prevCtx === null
      || typeof prevCtx !== 'object'
      || Array.isArray(prevCtx)
      || prevCtx.id !== prevKey
    ) {
      throw new TypeError(`Current active view "${prevKey}" has an invalid context.`);
    }
    if (
      !(this.cellVisibilityMask instanceof Uint8Array)
      || this.cellVisibilityMask.length !== this.pointCount
      || !(ctx.cellVisibilityMask instanceof Uint8Array)
      || ctx.cellVisibilityMask.length !== this.pointCount
    ) {
      throw new TypeError(
        'Active view selection requires complete per-view cell visibility masks.'
      );
    }
    if (prevKey === key) {
      return key;
    }
    // The arrays move instead of being copied: the outgoing context takes the
    // state's arrays, which the state stops writing to as it adopts the
    // incoming context's, and that context, now active, shares them as
    // `_syncActiveContext` would.
    prevCtx.obsData = this._cloneObsData(this.obsData);
    prevCtx.varData = this._cloneVarData(this.varData);
    prevCtx.activeFieldIndex = this.activeFieldIndex;
    prevCtx.activeVarFieldIndex = this.activeVarFieldIndex;
    prevCtx.activeFieldSource = this.activeFieldSource;
    prevCtx.colorsArray = this.colorsArray ?? null;
    prevCtx.categoryTransparency = this.categoryTransparency ?? null;
    prevCtx.cellVisibilityMask = this.cellVisibilityMask;
    prevCtx.centroidPositions = this.centroidPositions ?? null;
    prevCtx.centroidColors = this.centroidColors ?? null;
    prevCtx.centroidOutliers = this.centroidOutliers ?? null;
    prevCtx.centroidLabels = this.centroidLabels ? this.centroidLabels.map(c => c ? { ...c } : c) : [];
    prevCtx.filteredCount = this.filteredCount ? { ...this.filteredCount } : { shown: this.pointCount, total: this.pointCount };
    // The outgoing and incoming layouts, as their owner published them.
    const layoutOf = (viewKey) => (
      this.dimensionManager ? this.dimensionManager.getViewLayout(viewKey) : null
    );
    const previousActiveLayoutKey = layoutOf(prevKey);

    this.activeViewId = key;
    if (this.viewer && typeof this.viewer.setViewLayout === 'function') {
      // Only the focus is ours to change. The layout mode belongs to the
      // viewer, so it is read back rather than asserted: forcing "grid" here
      // silently overrode the mode a restore had just set one line earlier,
      // and a session saved in "single" reached the viewer as a grid until a
      // later refresh happened to correct it.
      const currentMode = typeof this.viewer.getViewLayout === 'function'
        ? this.viewer.getViewLayout().mode
        : 'grid';
      this.viewer.setViewLayout(currentMode, this.activeViewId);
    }
    this.obsData = this._cloneObsData(ctx.obsData);
    this.varData = this._cloneVarData(ctx.varData);
    this.activeFieldIndex = ctx.activeFieldIndex ?? -1;
    this.activeVarFieldIndex = ctx.activeVarFieldIndex ?? -1;
    this.activeFieldSource = ctx.activeFieldSource ?? null;
    this.colorsArray = ctx.colorsArray ?? null;
    this.categoryTransparency = ctx.categoryTransparency ?? null;
    this.cellVisibilityMask = ctx.cellVisibilityMask;
    this.centroidPositions = ctx.centroidPositions ?? null;
    this.centroidColors = ctx.centroidColors ?? null;
    this.centroidOutliers = ctx.centroidOutliers ?? null;
    this.centroidLabels = ctx.centroidLabels ? ctx.centroidLabels.map(c => c ? { ...c } : c) : [];
    this.filteredCount = ctx.filteredCount ? { ...ctx.filteredCount } : { shown: this.pointCount, total: this.pointCount };

    this._applyOverlaysToFields(
      this.obsData === null ? null : this.obsData.fields,
      FieldSource.OBS
    );
    this._applyOverlaysToFields(
      this.varData === null ? null : this.varData.fields,
      FieldSource.VAR
    );
    this._injectUserDefinedFields();
    this._ensureActiveSelectionNotDeleted();
    getFieldRegistry().invalidate();

    if (layoutOf(key) !== previousActiveLayoutKey) {
      this._notifyRepresentationChange(key, previousActiveLayoutKey);
    }

    this._reinitializeActiveField();
    this._rebuildLabelLayerFromCentroids();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushCentroidsToViewer();
    this.updateFilterSummary();
    this._syncActiveContext();
    this._notifyVisibilityChange();
    return this.activeViewId;
  },

  _reinitializeActiveField() {
    const field = this.getActiveField();
    if (!field || !field.loaded) return;

    if (field.kind === 'continuous') {
      this.ensureContinuousMetadata(field);
    } else if (field.kind === 'category') {
      this.ensureCategoryMetadata(field);
      const counts = this.computeCategoryCountsForField(field);
      if (counts) {
        field._categoryCounts = counts;
        this._activeCategoryCounts = counts;
      }
    }
  },

  createViewFromSource(sourceViewId, viewId) {
    for (const [label, value] of [
      ['Snapshot source view id', sourceViewId],
      ['Snapshot view id', viewId],
    ]) {
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value
      ) {
        throw new TypeError(
          `${label} must be a non-empty, exactly trimmed string.`
        );
      }
    }
    if (!(this.viewContexts instanceof Map)) {
      throw new TypeError(
        'Snapshot context publication requires the exact view-context map.'
      );
    }
    if (viewId === 'live') {
      throw new RangeError('A snapshot context cannot replace the live view.');
    }
    if (this.viewContexts.has(viewId)) {
      throw new RangeError(`View context "${viewId}" already exists.`);
    }
    const source = this.viewContexts.get(sourceViewId);
    if (
      source === null ||
      typeof source !== 'object' ||
      source.id !== sourceViewId
    ) {
      throw new RangeError(
        `Snapshot source view "${sourceViewId}" does not exist.`
      );
    }
    const ctx = viewContextCoreMethods._cloneViewContext.call(
      this,
      source,
      viewId
    );
    this.viewContexts.set(viewId, ctx);
    return ctx;
  },

  createViewFromActive(viewId) {
    return viewContextCoreMethods.createViewFromSource.call(
      this,
      String(this.activeViewId),
      viewId
    );
  },

  applySnapshotConfigToView(viewId, config) {
    if (
      typeof viewId !== 'string' ||
      viewId.length === 0 ||
      viewId.trim() !== viewId ||
      viewId === 'live'
    ) {
      throw new TypeError(
        'Snapshot context configuration requires one exact snapshot id.'
      );
    }
    const context = this.viewContexts.get(viewId);
    if (
      context === null ||
      typeof context !== 'object' ||
      context.id !== viewId
    ) {
      throw new RangeError(
        `Snapshot context "${viewId}" does not exist.`
      );
    }
    if (
      !Number.isSafeInteger(this.pointCount) ||
      this.pointCount < 0
    ) {
      throw new RangeError(
        'Snapshot context publication requires a non-negative point count.'
      );
    }
    const attributes = adoptSnapshotPointAttributes(
      config,
      this.pointCount
    );
    const centroidsUnchanged =
      exactTypedArrayEqual(
        context.centroidPositions,
        attributes.centroidPositions
      ) &&
      exactTypedArrayEqual(
        context.centroidColors,
        attributes.centroidColors
      );

    context.colorsArray = attributes.colors;
    context.categoryTransparency = attributes.transparency;
    let shown = 0;
    for (let index = 0; index < this.pointCount; index += 1) {
      const visible =
        attributes.transparency[index] >= POINT_VISIBILITY_THRESHOLD;
      if (visible) shown += 1;
    }
    context.centroidPositions = attributes.centroidPositions;
    context.centroidColors = attributes.centroidColors;
    if (!centroidsUnchanged) {
      const centroidCount =
        attributes.centroidPositions === null
          ? 0
          : attributes.centroidPositions.length / 3;
      context.centroidOutliers = new Float32Array(centroidCount);
      context.centroidOutliers.fill(-1);
      context.centroidLabels = [];
    }
    context.filteredCount = {
      shown,
      total: this.pointCount,
    };
    return context;
  },

  removeView(viewId) {
    if (
      typeof viewId !== 'string' ||
      viewId.length === 0 ||
      viewId.trim() !== viewId
    ) {
      throw new TypeError(
        'Removed view id must be a non-empty, exactly trimmed string.'
      );
    }
    const key = viewId;
    if (key === 'live') {
      throw new RangeError('The live view context cannot be removed.');
    }
    const failures = [];
    const attempt = operation => {
      try {
        return operation();
      } catch (error) {
        failures.push(error);
        return undefined;
      }
    };
    if (this.activeViewId === key) {
      attempt(() => this.setActiveView('live'));
    }
    const dimensionManager = this.dimensionManager;
    if (dimensionManager !== null && dimensionManager !== undefined) {
      if (typeof dimensionManager.removeView !== 'function') {
        failures.push(
          new TypeError(
            'View removal requires DimensionManager.removeView().'
          )
        );
      } else {
        attempt(() => dimensionManager.removeView(key));
      }
    }
    let contextRemoved = false;
    attempt(() => {
      contextRemoved = this.viewContexts.delete(key);
    });
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `View "${key}" retirement was incomplete.`
      );
    }
    return contextRemoved;
  },

  clearSnapshotViews() {
    viewContextCoreMethods.syncSnapshotContexts.call(this, []);
  },

  syncSnapshotContexts(snapshotIds) {
    const keep = new Set((snapshotIds || []).map((id) => String(id)));
    const failures = [];
    if (!keep.has(String(this.activeViewId)) && this.activeViewId !== 'live') {
      try {
        this.setActiveView('live');
      } catch (error) {
        failures.push(error);
      }
    }
    const keys = Array.from(this.viewContexts.keys());
    for (const key of keys) {
      if (key === 'live') continue;
      if (!keep.has(String(key))) {
        try {
          viewContextCoreMethods.removeView.call(this, key);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Snapshot context reconciliation was incomplete.'
      );
    }
  },

  getActiveViewId() {
    return this.activeViewId;
  },

  _isLiveView() {
    return String(this.activeViewId) === 'live';
  }
};
