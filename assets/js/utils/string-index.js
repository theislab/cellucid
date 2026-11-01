/**
 * @fileoverview A map from strings to small integers for millions of
 * strings: cell names to cells, a text column's labels to codes.
 *
 * A JavaScript `Map` or `Set` refuses more than 2^24 entries (V8: "Map
 * maximum size exceeded") and holds an object per entry. This index holds
 * each string once in an array (by entry, in insertion order) and one
 * `Int32Array` slot per entry in an open-addressing table keyed by an FNV-1a
 * hash of the string's UTF-16 code units, the hashes kept beside it so the
 * table grows without hashing again.
 *
 * @module utils/string-index
 */

const EMPTY = -1;

/** FNV-1a, 32 bits, over a string's UTF-16 code units. */
function hashOf(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

export class StringIndex {
  /**
   * @param {number} [expected] - Entries expected (the table starts large
   *   enough for them)
   */
  constructor(expected = 16) {
    let capacity = 16;
    while (capacity < 2 * expected) capacity *= 2;
    this._slots = new Int32Array(capacity).fill(EMPTY);
    this._hashes = new Uint32Array(Math.max(16, expected));
    /** Each entry's string, by entry (insertion order). @type {string[]} */
    this.keys = [];
    /** @type {Int32Array|null} One value an entry (`StringIndex.of`). */
    this._values = null;
    /** Whether every name `StringIndex.of` was given is distinct (entry i is name i). */
    this.unique = false;
  }

  /**
   * The index of `names`: each distinct name an entry whose value is the
   * last position it holds in `names`, as `new Map(names.map((name, i) =>
   * [name, i]))` gives, at any count.
   *
   * @param {ArrayLike<string>} names
   * @returns {StringIndex}
   */
  static of(names) {
    const index = new StringIndex(names.length);
    const values = new Int32Array(names.length);
    for (let i = 0; i < names.length; i++) values[index.intern(String(names[i]))] = i;
    index._values = values;
    index.unique = index.keys.length === names.length;
    return index;
  }

  /** Distinct strings held. */
  get size() {
    return this.keys.length;
  }

  /**
   * The entry of `text`, or -1 when it holds none.
   *
   * @param {string} text
   * @returns {number}
   */
  find(text) {
    const mask = this._slots.length - 1;
    for (let slot = hashOf(text) & mask; ; slot = (slot + 1) & mask) {
      const entry = this._slots[slot];
      if (entry === EMPTY) return EMPTY;
      if (this.keys[entry] === text) return entry;
    }
  }

  /**
   * The value `StringIndex.of` gave `text` (its last position), or
   * `undefined`: what a `Map` of the names answers.
   *
   * @param {string} text
   * @returns {number|undefined}
   */
  get(text) {
    const entry = this.find(text);
    return entry === EMPTY || this._values === null ? undefined : this._values[entry];
  }

  /**
   * The entry of `text`, made the next one when it holds none.
   *
   * @param {string} text
   * @returns {number}
   */
  intern(text) {
    const hash = hashOf(text);
    let mask = this._slots.length - 1;
    let slot = hash & mask;
    for (; ; slot = (slot + 1) & mask) {
      const entry = this._slots[slot];
      if (entry === EMPTY) break;
      if (this._hashes[entry] === hash && this.keys[entry] === text) return entry;
    }
    const entry = this.keys.length;
    if (entry >= this._hashes.length) {
      const hashes = new Uint32Array(this._hashes.length * 2);
      hashes.set(this._hashes);
      this._hashes = hashes;
    }
    this.keys.push(text);
    this._hashes[entry] = hash;
    if (2 * (entry + 1) > this._slots.length) {
      this._grow();
      mask = this._slots.length - 1;
      for (slot = hash & mask; this._slots[slot] !== EMPTY; slot = (slot + 1) & mask);
    }
    this._slots[slot] = entry;
    return entry;
  }

  /** A table twice as large, every entry placed again by its kept hash. @private */
  _grow() {
    const slots = new Int32Array(this._slots.length * 2).fill(EMPTY);
    const mask = slots.length - 1;
    for (let entry = 0; entry < this.keys.length - 1; entry++) {
      let slot = this._hashes[entry] & mask;
      while (slots[slot] !== EMPTY) slot = (slot + 1) & mask;
      slots[slot] = entry;
    }
    this._slots = slots;
  }
}
