/**
 * @fileoverview Domain values kept once, by content.
 *
 * A history refers to domain values by the SHA-256 of their canonical form,
 * so a value that comes back (undoing a recolour, toggling a filter twice)
 * is stored once, and two steps show the same state exactly when their
 * hashes agree. Typed arrays are hashed over their bytes once each (they are
 * immutable once captured, `app/actions/domains.js`); the rest is canonical
 * JSON (keys sorted). What JSON cannot hold is written as the stored
 * skeleton writes it (`value-parts.js`): a typed array as
 * `{"$array": "<digest>"}`, a number JSON cannot hold as
 * `{"$number": "NaN" | "Infinity" | "-Infinity" | "-0"}`, so NaN never
 * hashes like the text "NaN" nor -0 like 0, and a value's own object may not
 * use either key (it would read as one of them).
 *
 * SHA-256 comes from `app/utils/sha256.js`, which answers outside a secure
 * context too (the Python package's plain-HTTP LAN address), where
 * `crypto.subtle` does not exist.
 *
 * @module app/history/value-pool
 */

import { sha256Hex } from '../utils/sha256.js';

const arrayDigests = new WeakMap();

/** The key that names a typed array, by its digest, in a value's canonical text and stored skeleton. */
export const ARRAY_KEY = '$array';
/** The key that names a number JSON cannot hold, in a value's canonical text and stored skeleton. */
export const NUMBER_KEY = '$number';

/**
 * The name of a number JSON cannot hold (`"NaN"`, `"Infinity"`,
 * `"-Infinity"`, `"-0"`), or null for one it can.
 * @param {number} value
 * @returns {string|null}
 */
export function specialNumberName(value) {
  if (Object.is(value, -0)) return '-0';
  return Number.isFinite(value) ? null : String(value);
}

/**
 * The key a stored skeleton names a sub-value kept once by (the session file
 * and the autosave, `value-parts.js`); never part of a value's canonical text.
 */
export const PART_KEY = '$part';

/** Refuse a value's own object that uses a key the canonical text and the skeleton keep for themselves. */
export function requireUnreservedKeys(node, path) {
  if (Object.hasOwn(node, ARRAY_KEY) || Object.hasOwn(node, NUMBER_KEY) || Object.hasOwn(node, PART_KEY)) {
    throw new TypeError(`A state value uses the reserved key "${ARRAY_KEY}", "${NUMBER_KEY}" or "${PART_KEY}" at ${path}`);
  }
}

function digestBytes(bytes) {
  return sha256Hex(bytes);
}

/**
 * The digest a typed array is known by: its type, length and the SHA-256 of
 * its bytes (`Uint32Array:3:ab…`). Computed once per array (arrays in values
 * are immutable), so the values, the session file and the autosave that
 * share one array hash it once.
 *
 * @param {ArrayBufferView} array
 * @returns {Promise<string>}
 */
export async function typedArrayDigest(array) {
  let digest = arrayDigests.get(array);
  if (digest === undefined) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    digest = `${array.constructor.name}:${array.length}:${await digestBytes(bytes)}`;
    arrayDigests.set(array, digest);
  }
  return digest;
}

/**
 * The typed arrays of `value` whose digest is not known yet, each once.
 * Values are plain data; anything else is refused where it is met, naming
 * the path, so a capture that leaks an owner object fails where it is made.
 */
function arraysToDigest(value) {
  const out = [];
  const stack = [[value, 'value']];
  while (stack.length > 0) {
    const [node, path] = stack.pop();
    if (node === null || typeof node !== 'object') {
      if (node !== null && typeof node !== 'boolean' && typeof node !== 'string' && typeof node !== 'number') {
        throw new TypeError(`A state value holds a ${typeof node} at ${path}`);
      }
      continue;
    }
    if (ArrayBuffer.isView(node) && !(node instanceof DataView)) {
      if (!arrayDigests.has(node)) out.push(node);
      continue;
    }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], `${path}[${i}]`]);
      continue;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`A state value holds a ${proto?.constructor?.name ?? 'non-plain'} object at ${path}`);
    }
    requireUnreservedKeys(node, path);
    for (const key of Object.keys(node)) if (node[key] !== undefined) stack.push([node[key], `${path}.${key}`]);
  }
  return out;
}

/**
 * The canonical text of `value`: JSON with sorted keys, typed arrays by
 * digest (every digest known: `arraysToDigest` ran first). Synchronous, so a
 * large value is written in one pass with no wait per node.
 */
function canonicalText(value, parts) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    parts.push(JSON.stringify(value));
  } else if (typeof value === 'number') {
    const name = specialNumberName(value);
    parts.push(name === null ? JSON.stringify(value) : `{"${NUMBER_KEY}":${JSON.stringify(name)}}`);
  } else if (ArrayBuffer.isView(value)) {
    parts.push(`{"${ARRAY_KEY}":${JSON.stringify(arrayDigests.get(value))}}`);
  } else if (Array.isArray(value)) {
    parts.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) parts.push(',');
      canonicalText(value[i], parts);
    }
    parts.push(']');
  } else {
    const keys = Object.keys(value).sort();
    parts.push('{');
    let first = true;
    for (const key of keys) {
      if (value[key] === undefined) continue;
      if (!first) parts.push(',');
      first = false;
      parts.push(JSON.stringify(key), ':');
      canonicalText(value[key], parts);
    }
    parts.push('}');
  }
}

/** The typed arrays a value holds, each once (what its bytes are counted by). */
function arraysOf(value) {
  const out = new Set();
  const stack = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (ArrayBuffer.isView(node)) { out.add(node); continue; }
    for (const item of Array.isArray(node) ? node : Object.values(node)) stack.push(item);
  }
  return out;
}

/**
 * The hash of each value object hashed already: a value is never changed
 * after capture (`app/actions/domains.js`), so an owner that gives back the
 * same object for an unchanged state (the analyses, captured with every
 * highlight change they follow) costs no hashing the second time.
 * @type {WeakMap<object, string>}
 */
const valueHashes = new WeakMap();

/** The content hash of one domain value. */
export async function hashValue(value) {
  const known = value !== null && typeof value === 'object' ? valueHashes.get(value) : undefined;
  if (known !== undefined) return known;
  for (const array of arraysToDigest(value)) await typedArrayDigest(array);
  const parts = [];
  canonicalText(value, parts);
  const hash = await digestBytes(new TextEncoder().encode(parts.join('')));
  if (value !== null && typeof value === 'object') valueHashes.set(value, hash);
  return hash;
}

/**
 * The pool of values one or more trackers refer to.
 *
 * A value nothing refers to any more goes: at a `prune` (the history names
 * every value it refers to), or at once when the history knows it made it
 * and nothing took it (`release`: a camera gesture's values merged into one
 * step, an action that changed nothing or was cancelled). A reader that
 * walks values across awaits (the autosave, a session file being written)
 * `hold`s the pool: a value released meanwhile stays readable until the
 * last hold ends.
 *
 * Its size in bytes (`byteLength`, the typed arrays held, each array's
 * buffer once) is a counter kept as values come and go, so reading it costs
 * nothing whatever the history's size (the memory accounting reads it after
 * every change).
 */
export function createValuePool() {
  /** @type {Map<string, {value: unknown, buffers: ArrayBuffer[]}>} */
  const values = new Map();
  /** buffer → how many held values name it, and its bytes counted once. */
  const buffers = new Map();
  let bytes = 0;
  /** Values released while a reader holds the pool: dropped when the last hold ends. */
  const released = new Set();
  let holds = 0;

  function keep(hash, value) {
    const held = [];
    const seen = new Set();
    for (const array of arraysOf(value)) {
      const buffer = array.buffer;
      if (seen.has(buffer)) continue;
      seen.add(buffer);
      held.push(buffer);
      const entry = buffers.get(buffer);
      if (entry === undefined) {
        buffers.set(buffer, { count: 1, bytes: array.byteLength });
        bytes += array.byteLength;
      } else {
        entry.count++;
      }
    }
    values.set(hash, { value, buffers: held });
  }

  function drop(hash) {
    const entry = values.get(hash);
    if (entry === undefined) return;
    values.delete(hash);
    for (const buffer of entry.buffers) {
      const counted = buffers.get(buffer);
      if (--counted.count === 0) {
        buffers.delete(buffer);
        bytes -= counted.bytes;
      }
    }
  }

  function release(hash) {
    if (!values.has(hash)) return;
    if (holds > 0) released.add(hash); else drop(hash);
  }

  return Object.freeze({
    /** Keep `value`; returns its hash. */
    async put(value) {
      const hash = await hashValue(value);
      released.delete(hash);
      if (!values.has(hash)) keep(hash, value);
      return hash;
    },
    /** Keep `value`; returns its hash and whether the pool did not hold it before (`added`). */
    async putNew(value) {
      const hash = await hashValue(value);
      // A value released but still held for a reader comes back as new: nothing refers to it yet.
      if (released.delete(hash)) return { hash, added: true };
      if (values.has(hash)) return { hash, added: false };
      keep(hash, value);
      return { hash, added: true };
    },
    /** Drop a value nothing refers to (the caller knows): now, or when the last hold ends. */
    release,
    /** Keep every value readable until the returned function is called (a reader across awaits). */
    hold() {
      holds++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        if (--holds > 0) return;
        for (const hash of released) drop(hash);
        released.clear();
      };
    },
    /** Keep a value whose hash is already known (a session being loaded). */
    adopt(hash, value) {
      released.delete(hash);
      if (!values.has(hash)) keep(hash, value);
    },
    get(hash) {
      const entry = values.get(hash);
      if (entry === undefined) throw new RangeError(`The history has no value ${String(hash).slice(0, 12)}`);
      return entry.value;
    },
    has: hash => values.has(hash),
    hashes: () => [...values.keys()],
    /** Drop every value no hash in `keep` names (while held, once the last hold ends). */
    prune(keepHashes) {
      for (const hash of [...values.keys()]) if (!keepHashes.has(hash)) release(hash);
    },
    /**
     * Bytes of the typed arrays held (what grows with the data): each
     * buffer once (as its first view counts it), however many values share it. A counter, never a walk.
     */
    byteLength: () => bytes,
    /**
     * The bytes each of `hashes` adds, in order: the typed arrays it holds
     * that no hash before it held (each buffer counted once, for the first
     * that names it), so they sum to at most `byteLength`. A hash the pool
     * does not hold adds 0. A walk over the hashes given, made on demand
     * (where the memory goes), never on a write.
     * @param {string[]} hashes
     * @returns {number[]}
     */
    bytesAdded(hashes) {
      const seen = new Set();
      return hashes.map(hash => {
        const entry = values.get(hash);
        if (entry === undefined) return 0;
        let added = 0;
        for (const buffer of entry.buffers) {
          if (seen.has(buffer)) continue;
          seen.add(buffer);
          added += buffers.get(buffer).bytes;
        }
        return added;
      });
    },
    get size() { return values.size; },
  });
}
