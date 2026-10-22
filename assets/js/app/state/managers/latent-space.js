/**
 * @fileoverview Replacing the latent space of a loaded dataset: the `obsm`
 * array a data mapping's `latent` names, in which every categorical obs
 * field's outlier quantiles are measured (`mapping-groups.js`).
 *
 * Cells, colours, category filters and every view's outlier threshold are
 * kept: a threshold is a share of a category ("hide the farthest 5%"), so it
 * means the same in the new space. What changes:
 * - every categorical field's descriptor names the new outlier payload (or
 *   none), so a field loaded later reads it;
 * - a field already loaded gets the new quantiles, read before anything
 *   changes, in every view; with no latent space it has none, and its
 *   outlier filter goes away;
 * - every view coloured by a categorical field is recoloured, so its outlier
 *   filter applies the new quantiles at once, and `latent-space:changed`
 *   tells the interface to show or hide outlier controls.
 *
 * @module state/managers/latent-space
 */

import { getFieldRegistry } from '../../utils/field-registry.js';

const OUTLIER_BOUNDS = Object.freeze(['outlierMinValue', 'outlierMaxValue']);

function isCategoricalDescriptor(descriptor) {
  return descriptor !== null && descriptor !== undefined && descriptor.kind === 'category';
}

/** A categorical descriptor naming another outlier payload, frozen. */
function withOutlierPath(descriptor, path) {
  const next = { ...descriptor };
  for (const key of OUTLIER_BOUNDS) delete next[key];
  next.outlierQuantilesPath = path;
  next.outlierDtype = path === null ? null : 'float32';
  next.outlierQuantized = false;
  return Object.freeze(next);
}

export class DataStateLatentSpaceMethods {
  /**
   * Every obs field list a view holds: the focused view's (on the state) and
   * each other view's own copy.
   * @private
   */
  _everyObsFieldList() {
    const lists = [];
    if (Array.isArray(this.obsData?.fields)) lists.push(this.obsData.fields);
    for (const [viewId, context] of this.viewContexts ?? []) {
      if (viewId === this.activeViewId) continue;
      if (Array.isArray(context?.obsData?.fields)) lists.push(context.obsData.fields);
    }
    return lists;
  }

  /**
   * Read what a new latent space gives the categorical fields that need it
   * now, and return the steps that publish it and restore the current one.
   *
   * @param {{
   *   outlierPathFor: (payloadIndex: number) => string|null,
   *   loadOutliers: (descriptor: Object) => Promise<Float32Array>
   * }} latent - The outlier payload of each categorical field in the new
   *   latent space (null for none), and the reader of one descriptor's payload.
   * @returns {Promise<{commit: () => void, rollback: () => void}>}
   */
  async stageLatentReplacement({ outlierPathFor, loadOutliers }) {
    if (typeof outlierPathFor !== 'function' || typeof loadOutliers !== 'function') {
      throw new TypeError('A latent space requires its outlier paths and their reader.');
    }
    // A categorical field still loading reads the descriptor it started
    // with, so it would land without the new space's quantiles: let every
    // such load finish first, and treat its field as loaded.
    const loading = [];
    for (const fields of this._everyObsFieldList()) {
      for (const field of fields) {
        if (field?.kind === 'category' && field._loadingPromise) loading.push(field._loadingPromise);
      }
    }
    await Promise.allSettled(loading);

    const descriptors = this._obsFieldDescriptors ?? [];
    const next = descriptors.map(descriptor => (
      isCategoricalDescriptor(descriptor)
        ? withOutlierPath(descriptor, outlierPathFor(descriptor.payloadIndex))
        : descriptor
    ));

    // The fields loaded in any view are read now; every other field reads
    // its new payload when it is first loaded.
    // A field's arrays are the same in every view that loaded it, so its
    // previous quantiles are kept by position.
    const loaded = new Map();
    for (const fields of this._everyObsFieldList()) {
      fields.forEach((field, index) => {
        if (field?.loaded === true && isCategoricalDescriptor(next[index]) && !loaded.has(index)) {
          loaded.set(index, field.outlierQuantiles);
        }
      });
    }
    const staged = new Map();
    const reads = [...loaded.keys()].filter(index => next[index].outlierQuantilesPath !== null);
    // A latent space no loaded field needs yet is still read and checked
    // once, through the first categorical field, so a broken one is refused
    // now and not when a field is first coloured.
    const check = reads.length === 0
      ? next.findIndex(descriptor => isCategoricalDescriptor(descriptor) && descriptor.outlierQuantilesPath !== null)
      : -1;
    for (const index of reads) {
      const quantiles = await loadOutliers(next[index]);
      if (!(quantiles instanceof Float32Array) || quantiles.length !== this.pointCount) {
        throw new Error(`Outlier quantiles of "${next[index].key}" did not load one value per cell.`);
      }
      staged.set(index, quantiles);
    }
    if (check >= 0) await loadOutliers(next[check]);

    // Cache entries are keyed as field/loading.js keys them.
    const indexByCacheKey = new Map();
    (this.obsData?.fields ?? []).forEach((field, index) => {
      indexByCacheKey.set(field?._originalKey || field?.key || String(index), index);
    });
    const categoricalEntries = () => [...this._fieldDataCache].filter(
      ([key]) => isCategoricalDescriptor(next[indexByCacheKey.get(key)])
    );
    const previous = { descriptors, cache: categoricalEntries() };

    const publish = (nextDescriptors, quantilesOf, cacheEntryOf) => {
      this._obsFieldDescriptors = Object.freeze([...nextDescriptors]);
      for (const fields of this._everyObsFieldList()) {
        fields.forEach((field, index) => {
          if (!loaded.has(index) || field?.loaded !== true) return;
          const quantiles = quantilesOf(index);
          if (quantiles === undefined) delete field.outlierQuantiles;
          else field.outlierQuantiles = quantiles;
        });
      }
      // A categorical cache entry carries the outliers of the latent space it
      // was read in: it is replaced, or dropped so the field reads its new
      // payload when it is loaded again.
      for (const [key, entry] of categoricalEntries()) {
        const replacement = cacheEntryOf(key, entry);
        if (replacement === null) this._fieldDataCache.delete(key);
        else this._fieldDataCache.set(key, replacement);
      }
      this._recolourCategoricalViews();
      this.emit('latent-space:changed', {});
    };

    return {
      commit: () => {
        publish(
          next,
          index => staged.get(index),
          (key, entry) => {
            const index = indexByCacheKey.get(key);
            return loaded.has(index) ? { ...entry, outlierQuantiles: staged.get(index) } : null;
          }
        );
      },
      rollback: () => {
        const restoredCache = new Map(previous.cache);
        publish(
          previous.descriptors,
          index => loaded.get(index),
          key => restoredCache.get(key) ?? null
        );
        for (const [key, entry] of restoredCache) this._fieldDataCache.set(key, entry);
      },
    };
  }

  /**
   * Recolour every view coloured by a categorical obs field, so its outlier
   * filter reads the quantiles it now has. Focus returns to the view that
   * had it.
   * @private
   */
  _recolourCategoricalViews() {
    const focused = this.activeViewId;
    const colouredBy = viewId => {
      const view = viewId === focused ? this : this.viewContexts.get(viewId);
      if (view?.activeFieldSource !== 'obs' || !(view.activeFieldIndex >= 0)) return null;
      const field = view.obsData?.fields?.[view.activeFieldIndex];
      // A view whose field is not loaded is coloured when it loads, from
      // the descriptor that now names the new payload.
      return field?.kind === 'category' && field.loaded === true ? view.activeFieldIndex : null;
    };
    const own = colouredBy(focused);
    if (own !== null) this.setActiveField(own);
    for (const viewId of [...(this.viewContexts?.keys() ?? [])]) {
      if (viewId === focused) continue;
      const index = colouredBy(viewId);
      if (index === null) continue;
      this.setActiveView(viewId);
      this.setActiveField(index);
    }
    if (this.activeViewId !== focused) this.setActiveView(focused);
    getFieldRegistry().invalidate();
  }
}
