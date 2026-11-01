/**
 * The order a point store holds its points in.
 *
 * A store (`point-store-segments.js`) is published in source order: slot
 * `s` holds open cell `s`. When the open cells are in priority order (a
 * priority-ordered file, any cell-level subsample: `data/cell-priority.js`,
 * `OPEN_ORDER_PRIORITY`), slot `s` holds the cell of rank `s`, so every level
 * of detail is a prefix of the store as it is (`draw-order.js`): it draws
 * at once, with no permutation and no gather.
 *
 * A tree's draw order (`draw-order.js`) is adopted for frustum culling and
 * for the spatial coherence of drawing neighbours together. Its bands are
 * fixed runs of ranks, and each band of the order holds exactly the cells of
 * its ranks, so a store can take the order **one band at a time** while it
 * is drawn: after any number of bands, slots `[0, adopted)` hold the order,
 * the rest hold what they held, and every prefix that ends on a band
 * boundary still holds exactly the cells of its ranks. Every level of detail
 * ends on one, so every level draws its own cells at every step.
 *
 * A `StoreOrder` describes one such state, and never changes; a store's
 * order is replaced by a new one at each step. Slot `s` holds the cell:
 *
 * - `target.indices[s]` for `s < adopted` (the order being adopted, or
 *   adopted when `adopted` is every slot);
 * - `base[s]` for `adopted <= s < baseEnd` (an order the store held before:
 *   cells added after a store took an order are appended in rank order, so
 *   the old order is kept below them until the new tree's order replaces it);
 * - `s` for every slot from `orderedSlots` on.
 *
 * The GPU reads the same mapping from one R32UI linear texture, `map`
 * (`texture`, `plan`): texel `s` holds the cell of slot `s` for every
 * `s < orderedSlots`, and a shader takes slot `s` itself from there on
 * (`u_orderedSlots`). The texture is shared by the states of one adoption;
 * each step writes the texels of the slots it adopts.
 *
 * @module rendering/high-perf/store-order
 */

/**
 * @typedef {{texture: WebGLTexture|null, plan: object, byteLength: number}} StoreOrderMap
 */

export class StoreOrder {
  /**
   * @param {object} state
   * @param {number} state.pointCount - Slots the store holds.
   * @param {object|null} state.target - The draw order being adopted
   *   (`SpatialIndex#drawOrder`), or null.
   * @param {number} state.adopted - Slots `[0, adopted)` hold `target`.
   * @param {Uint32Array|null} state.base - The cell of each slot of
   *   `[adopted, baseEnd)` (indexed by slot), or null.
   * @param {number} state.baseEnd
   * @param {StoreOrderMap} state.map
   * @param {boolean} state.ranked - Whether every slot range that ends on a
   *   band boundary holds exactly the cells of its ranks (see the module
   *   comment): the store can be drawn by levels of rank and change order
   *   band by band.
   */
  constructor({ pointCount, target, adopted, base, baseEnd, map, ranked }) {
    if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
      throw new RangeError(`A store order describes a non-negative number of slots, not ${pointCount}.`);
    }
    if (!Number.isSafeInteger(adopted) || adopted < 0 || adopted > pointCount || (target === null && adopted !== 0)) {
      throw new RangeError(`A store order adopts 0 to ${pointCount} slots of its target, not ${adopted}.`);
    }
    if (target !== null && (!(target.indices instanceof Uint32Array) || target.indices.length < adopted)) {
      throw new TypeError('A store order names the cells of the slots it adopted.');
    }
    if (!Number.isSafeInteger(baseEnd) || baseEnd < 0 || baseEnd > pointCount) {
      throw new RangeError(`A store order's earlier order covers 0 to ${pointCount} slots, not ${baseEnd}.`);
    }
    if (baseEnd > adopted && !(base instanceof Uint32Array && base.length >= baseEnd)) {
      throw new TypeError('A store order names the cells of the slots its earlier order holds.');
    }
    if (map === null || typeof map !== 'object') {
      throw new TypeError('A store order needs its slot map texture.');
    }
    this.pointCount = pointCount;
    this.target = target;
    this.adopted = adopted;
    this.base = baseEnd > adopted ? base : null;
    this.baseEnd = baseEnd > adopted ? baseEnd : adopted;
    this.map = map;
    this.ranked = ranked === true;
    // Made when first asked for (`slotSources`). The object is not sealed:
    // the viewer's read-only renderer facade detaches a sealed object to its
    // own fields, which would drop the getters below.
    this._slotSources = undefined;
  }

  /** Slots read through the map; every later slot holds its own cell. */
  get orderedSlots() {
    return this.baseEnd;
  }

  /** Whether the store holds `target` in every slot. */
  get complete() {
    return this.target !== null && this.adopted === this.pointCount && this.target.pointCount === this.pointCount;
  }

  /**
   * The draw order the store holds whole, or null while it holds another
   * order in any slot: what a tree's order is compared with before the tree
   * draws reduced levels or culled ranges from it.
   */
  get drawOrder() {
    return this.complete ? this.target : null;
  }

  /** The map texture (`u_orderedSlots` reads it below `orderedSlots`). */
  get texture() {
    return this.map.texture;
  }

  get plan() {
    return this.map.plan;
  }

  get byteLength() {
    return this.map.byteLength;
  }

  /**
   * The cell slot `slot` holds.
   * @param {number} slot
   * @returns {number}
   */
  sourceOf(slot) {
    if (slot < this.adopted) return this.target.indices[slot];
    if (slot < this.baseEnd) return this.base[slot];
    return slot;
  }

  /**
   * The cell of every slot, as one array, or null when every slot holds its
   * own cell. The adopted target's own indices when it is complete; else
   * made once for this state (a transient `4 B` a slot: only consumers that
   * iterate a store's slots on the CPU ask, such as figure export).
   *
   * @returns {Uint32Array|null}
   */
  slotSources() {
    if (this._slotSources !== undefined) return this._slotSources;
    if (this.orderedSlots === 0) {
      this._slotSources = null;
    } else if (this.complete) {
      this._slotSources = this.target.indices;
    } else {
      const sources = new Uint32Array(this.pointCount);
      if (this.adopted > 0) sources.set(this.target.indices.subarray(0, this.adopted));
      if (this.baseEnd > this.adopted) sources.set(this.base.subarray(this.adopted, this.baseEnd), this.adopted);
      for (let slot = this.baseEnd; slot < this.pointCount; slot++) sources[slot] = slot;
      this._slotSources = sources;
    }
    return this._slotSources;
  }

  /**
   * The same slots, described for a store of `pointCount` slots: cells
   * appended keep their own slots, and a store cut to fewer slots keeps the
   * mapping of those it still holds (the caller rewrote the cut band, see
   * `HighPerfRenderer#resizeLiveCells`, and passes `keep`, the slots whose
   * mapping is kept).
   *
   * @param {number} pointCount
   * @param {number} [keep=Math.min(this.orderedSlots, pointCount)]
   * @returns {StoreOrder}
   */
  resized(pointCount, keep = Math.min(this.orderedSlots, pointCount)) {
    const adopted = Math.min(this.adopted, keep);
    return new StoreOrder({
      pointCount,
      target: adopted > 0 ? this.target : null,
      adopted,
      base: this.base,
      baseEnd: Math.min(this.baseEnd, keep),
      map: this.map,
      ranked: this.ranked,
    });
  }
}
