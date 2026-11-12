/**
 * @fileoverview Orders of per-cell integer keys in linear time.
 *
 * Ordering millions of cells by a key through `Array.prototype.sort` with a
 * comparator calls a function O(n log n) times (seconds at 10M cells) and,
 * on arrays of pairs, holds a JavaScript object per cell. A stable
 * least-significant-digit radix sort of 32-bit keys is a few sequential
 * passes over the keys and one `Uint32Array` beside them.
 *
 * Each pass counts the keys by one digit, so it walks the keys and every
 * digit's count: the digit is as wide as costs least for the keys sorted
 * (`digitPlanOf`, 16 bits at most). A fixed 16-bit digit made every sort
 * walk 65,536 counts a pass whatever its keys: a gene's few hundred entries
 * put in open order cost two such walks a gene (`prefix-column-index.js`
 * `fileOrderedAccess`), 6 s of a 30,000-gene differential expression at 1M
 * cells.
 *
 * @module utils/radix-order
 */

/** The widest digit a pass sorts by: 65,536 counts. */
const MAX_DIGIT_BITS = 16;

/**
 * How a sort of `keys` passes over them: the digit width (`bits`) and the
 * largest key (`largest`; no pass above its digits is made). A pass walks
 * the keys twice (counted, then moved) and every digit's count twice
 * (cleared, then summed), so `p` passes over keys of `b` bits cost about
 * `p × (2n + 2^ceil(b / p))`: the fewest-cost `p` is taken, its digit
 * `MAX_DIGIT_BITS` wide at most (a fixed 16-bit digit walked 65,536 counts
 * a pass for a few hundred keys). Keys too many for a digit of
 * `MAX_DIGIT_BITS` to cost more than they do (65,536 and more) take that
 * width with no walk for the largest key: a pass whose digit every key
 * shares moves nothing and is skipped (`digitStarts`). `bits` 0 when every
 * key is 0.
 */
function digitPlanOf(keys) {
  const n = keys.length;
  if (n >= 1 << MAX_DIGIT_BITS) return { bits: MAX_DIGIT_BITS, largest: 0xffffffff };
  let largest = 0;
  for (let i = 0; i < n; i++) if (keys[i] > largest) largest = keys[i];
  const keyBits = 32 - Math.clz32(largest);
  if (keyBits === 0) return { bits: 0, largest };
  let bits = Math.min(keyBits, MAX_DIGIT_BITS);
  let cost = Math.ceil(keyBits / bits) * (2 * n + 2 ** bits);
  for (let passes = Math.ceil(keyBits / bits) + 1; passes <= keyBits; passes++) {
    const width = Math.ceil(keyBits / passes);
    const passCost = passes * (2 * n + 2 ** width);
    if (passCost < cost) {
      cost = passCost;
      bits = width;
    }
  }
  return { bits, largest };
}

/**
 * Each digit's count of `keys` at `shift` (`mask` wide) into `counts`, then
 * turned into each digit's first slot; false (and the counts left) when
 * every key has the same digit there, a pass that would move nothing. Each
 * long loop of a sort is a function of its own, optimized on its own: a
 * sort is not left running a later loop in a slower tier when the first one
 * was compiled mid-loop.
 */
function digitStarts(keys, shift, mask, counts) {
  counts.fill(0);
  for (let i = 0; i < keys.length; i++) counts[(keys[i] >>> shift) & mask]++;
  if (counts[(keys[0] >>> shift) & mask] === keys.length) return false;
  let sum = 0;
  for (let digit = 0; digit < counts.length; digit++) {
    const count = counts[digit];
    counts[digit] = sum;
    sum += count;
  }
  return true;
}

/** `order` (indexes of `keys`) moved into `next` by their keys' digit at `shift` (`digitStarts`). */
function scatterOrder(keys, order, next, shift, mask, starts) {
  for (let i = 0; i < order.length; i++) {
    const index = order[i];
    next[starts[(keys[index] >>> shift) & mask]++] = index;
  }
}

/** `from` moved into `to` by each value's digit at `shift` (`digitStarts`). */
function scatterValues(from, to, shift, mask, starts) {
  for (let i = 0; i < from.length; i++) {
    const value = from[i];
    to[starts[(value >>> shift) & mask]++] = value;
  }
}

/**
 * The stable order of `keys` ascending: `order[k]` is the index of the k-th
 * smallest key, equal keys in index order. A pass whose digit every key
 * shares is skipped.
 *
 * @param {Uint32Array} keys - Unsigned 32-bit keys
 * @returns {Uint32Array}
 */
export function orderByKey(keys) {
  if (!(keys instanceof Uint32Array)) throw new TypeError('orderByKey keys must be a Uint32Array.');
  const n = keys.length;
  let order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  if (n < 2) return order;
  const { bits, largest } = digitPlanOf(keys);
  if (bits === 0) return order;
  const mask = (1 << bits) - 1;
  let next = null;
  const counts = new Uint32Array(1 << bits);
  for (let shift = 0; shift < 32 && largest >>> shift !== 0; shift += bits) {
    if (!digitStarts(keys, shift, mask, counts)) continue;
    next ??= new Uint32Array(n);
    scatterOrder(keys, order, next, shift, mask, counts);
    [order, next] = [next, order];
  }
  return order;
}

/**
 * `values` sorted ascending, in place (and returned): the same result as
 * `Uint32Array.prototype.sort`, in sequential radix passes (two for 10M
 * values) and one scratch array instead of a comparison sort (10M values:
 * 239 → 72 ms).
 *
 * @param {Uint32Array} values
 * @returns {Uint32Array}
 */
export function sortUint32(values) {
  if (!(values instanceof Uint32Array)) throw new TypeError('sortUint32 values must be a Uint32Array.');
  const n = values.length;
  if (n < 2) return values;
  const { bits, largest } = digitPlanOf(values);
  if (bits === 0) return values;
  const mask = (1 << bits) - 1;
  let from = values;
  let to = new Uint32Array(n);
  const counts = new Uint32Array(1 << bits);
  for (let shift = 0; shift < 32 && largest >>> shift !== 0; shift += bits) {
    if (!digitStarts(from, shift, mask, counts)) continue;
    scatterValues(from, to, shift, mask, counts);
    [from, to] = [to, from];
  }
  if (from !== values) values.set(from);
  return values;
}

/** `keys` and their `values` moved into `toKeys`/`toValues` by each key's digit at `shift` (`digitStarts`). */
function scatterPairs(keys, values, toKeys, toValues, shift, mask, starts) {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const at = starts[(key >>> shift) & mask]++;
    toKeys[at] = key;
    toValues[at] = values[i];
  }
}

/**
 * `keys` sorted ascending in place, each of `values` moved with its key
 * (equal keys keep their order); both returned. What `orderByKey` and a
 * gather of both by the order give, without the order: a gene's entries
 * put in open order (`prefix-column-index.js`) are two arrays, sorted where
 * they are.
 *
 * @param {Uint32Array} keys
 * @param {Float32Array|Float64Array} values - As many as `keys`
 * @returns {{keys: Uint32Array, values: Float32Array|Float64Array}}
 */
export function sortByKeyWithValues(keys, values) {
  if (!(keys instanceof Uint32Array)) throw new TypeError('sortByKeyWithValues keys must be a Uint32Array.');
  if (!(values instanceof Float32Array || values instanceof Float64Array) || values.length !== keys.length) {
    throw new TypeError('sortByKeyWithValues values must be a Float32Array or Float64Array of one value a key.');
  }
  const n = keys.length;
  if (n < 2) return { keys, values };
  const { bits, largest } = digitPlanOf(keys);
  if (bits === 0) return { keys, values };
  const mask = (1 << bits) - 1;
  let fromKeys = keys;
  let fromValues = values;
  let toKeys = null;
  let toValues = null;
  const counts = new Uint32Array(1 << bits);
  for (let shift = 0; shift < 32 && largest >>> shift !== 0; shift += bits) {
    if (!digitStarts(fromKeys, shift, mask, counts)) continue;
    toKeys ??= new Uint32Array(n);
    toValues ??= new values.constructor(n);
    scatterPairs(fromKeys, fromValues, toKeys, toValues, shift, mask, counts);
    [fromKeys, toKeys] = [toKeys, fromKeys];
    [fromValues, toValues] = [toValues, fromValues];
  }
  if (fromKeys !== keys) {
    keys.set(fromKeys);
    values.set(fromValues);
  }
  return { keys, values };
}
