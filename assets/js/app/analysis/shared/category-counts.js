/**
 * Category counts per page-values array.
 *
 * A categorical page's values are one category label per cell. Every
 * categorical consumer — bar, pie and heatmap plots, the summary table, the
 * chi-squared and Fisher tests, CSV export — reads how often each label occurs,
 * in first-occurrence order, and walking ten million labels through a `Map`
 * takes about 0.2 s of main-thread time each time it is done. The data layer
 * already visits every cell when it builds the values, so it counts them there
 * (by code, which costs one array increment) and adopts the counts for the
 * array it publishes; anything else is counted once and kept.
 *
 * Page-data arrays are never edited once published, and the map holds them
 * weakly. The returned map is shared: callers read it and never modify it.
 *
 * @module shared/category-counts
 */

/** @type {WeakMap<ArrayLike<unknown>, Map<unknown, number>>} */
const countsByValues = new WeakMap();

/**
 * How often each value occurs in `values`, in first-occurrence order (the order
 * a `Map` filled value by value has).
 *
 * @param {ArrayLike<unknown>} values
 * @returns {Map<unknown, number>}
 */
export function categoryCounts(values) {
  let counts = countsByValues.get(values);
  if (counts === undefined) {
    counts = new Map();
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    countsByValues.set(values, counts);
  }
  return counts;
}

/**
 * Record the counts of a values array its producer has already taken. They
 * must be exactly what `categoryCounts` would compute: every value of the
 * array, in first-occurrence order.
 *
 * @param {ArrayLike<unknown>} values
 * @param {Map<unknown, number>} counts
 */
export function adoptCategoryCounts(values, counts) {
  if (!(counts instanceof Map)) {
    throw new TypeError('Adopted category counts must be a Map');
  }
  countsByValues.set(values, counts);
}
