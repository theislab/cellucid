/**
 * @fileoverview Replacing the latent space of a loaded dataset: the `obsm`
 * array a data mapping's `latent` names, in which every categorical obs
 * field's outlier quantiles are measured (`mapping-groups.js`).
 *
 * Cells, colours, category filters and every view's outlier threshold are
 * kept: a threshold is a share of a category ("hide the farthest 5%"), so it
 * means the same in the new space. Applying reads nothing — getting outlier
 * quantiles is its own operation, with progress and Cancel
 * (`outlier-quantiles.js`). What changes:
 * - every categorical field's descriptor names the new outlier route (or
 *   none), so its quantiles are got in the new space;
 * - every loaded field drops the quantiles of the old space, in every view
 *   and in the field cache; a field whose outlier filter is in use (a
 *   threshold below 1 in some view) gets the new ones at once
 *   (`resumeOutlierFilters`), the others on the filter's next use; with no
 *   latent space a field has none, and its outlier filter waits for one;
 * - every view coloured by a categorical field is recoloured, and
 *   `latent-space:changed` tells the interface to redraw the outlier
 *   controls.
 *
 * @module state/managers/latent-space
 */

import { getFieldRegistry } from '../../utils/field-registry.js';

function isCategoricalDescriptor(descriptor) {
  return descriptor !== null && descriptor !== undefined && descriptor.kind === 'category';
}

/** A categorical descriptor naming another outlier route, frozen. */
function withOutlierPath(descriptor, path) {
  return Object.freeze({ ...descriptor, outlierQuantilesPath: path });
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
   * The steps that publish a new latent space and restore the current one.
   * Nothing is read: fields whose outlier filter is in use get their new
   * quantiles after the commit, each as a job with progress and Cancel.
   *
   * @param {{outlierPathFor: (fieldIndex: number) => string|null}} latent -
   *   The outlier route of each categorical field in the new latent space
   *   (null for none).
   * @returns {Promise<{commit: () => void, rollback: () => void}>}
   */
  async stageLatentReplacement({ outlierPathFor }) {
    if (typeof outlierPathFor !== 'function') {
      throw new TypeError('A latent space requires the outlier route of each categorical field.');
    }
    // A categorical field still loading adopts the descriptor it started
    // with: let every such load finish first.
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
        ? withOutlierPath(descriptor, outlierPathFor(descriptor.fieldIndex))
        : descriptor
    ));
    // Each view's copy of each categorical field, with the quantiles it holds now.
    const held = [];
    for (const fields of this._everyObsFieldList()) {
      fields.forEach((field, index) => {
        if (field?.loaded === true && isCategoricalDescriptor(next[index])) {
          held.push({ field, quantiles: field.outlierQuantiles });
        }
      });
    }
    // Cache entries are keyed as field/loading.js keys them.
    const indexByCacheKey = new Map();
    (this.obsData?.fields ?? []).forEach((field, index) => {
      indexByCacheKey.set(field?._originalKey || field?.key || String(index), index);
    });
    const categoricalEntries = () => [...this._fieldDataCache].filter(
      ([key]) => isCategoricalDescriptor(next[indexByCacheKey.get(key)])
    );
    const previousCache = categoricalEntries();

    const publish = (nextDescriptors, restore) => {
      // Jobs of the space being left end; their fields' thresholds stay.
      for (let index = 0; index < descriptors.length; index++) {
        if (isCategoricalDescriptor(descriptors[index])) this.cancelOutlierQuantiles(index);
      }
      this._obsFieldDescriptors = Object.freeze([...nextDescriptors]);
      for (const { field, quantiles } of held) {
        if (restore && quantiles !== undefined) field.outlierQuantiles = quantiles;
        else delete field.outlierQuantiles;
      }
      for (const [key, entry] of restore ? previousCache : categoricalEntries()) {
        if (restore) {
          this._fieldDataCache.set(key, entry);
        } else if (entry.outlierQuantiles !== undefined) {
          const { outlierQuantiles: _dropped, ...rest } = entry;
          this._fieldDataCache.set(key, rest);
        }
      }
      this._recolourCategoricalViews();
      this.emit('latent-space:changed', {});
    };

    return {
      commit: () => {
        publish(next, false);
        this.resumeOutlierFilters();
      },
      rollback: () => publish(descriptors, true),
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
