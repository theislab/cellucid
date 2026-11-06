/**
 * @fileoverview A history value as two parts, for keeping it outside the
 * page: a JSON skeleton, and the typed arrays it names by digest.
 *
 * The session file (`app/session/history-file.js`) and the autosave
 * (`autosave.js`) store the values of the history's pool this way, so an
 * array that several values share (a highlight group's cells in every
 * highlights value after it was made) is stored once, under the digest the
 * pool already hashed it by (`typedArrayDigest`), and comes back as one
 * array that every value refers to again.
 *
 * The skeleton is JSON: an array is `{"$array": "<digest>"}`; a number JSON
 * cannot hold is `{"$number": "NaN" | "Infinity" | "-Infinity" | "-0"}`, the
 * forms the pool hashes them by (`value-pool.js`). A value's own object may
 * not have a `$array`, `$number` or `$part` key: the pool refuses one, so no
 * skeleton is ambiguous. Values are plain data (the pool refuses anything
 * else), so nothing else needs a form of its own.
 *
 * **Parts** (when the caller keeps them, `splitValue(value, arrays, parts)`):
 * every object or list inside a value whose skeleton text is at least
 * {@link PART_MIN_CHARS} characters is stored once, as a part, and named
 * `{"$part": "<sha256 of its skeleton text>"}` where it stood (bottom-up, so
 * a part names the parts inside it). Values that share a sub-value (the gene
 * names of every analysis result, a user field in every field-overlays value
 * after it was made, a highlight group) then store it once. A part is
 * storage only: a value's hash is of the value itself (`value-pool.js`),
 * never of its parts, so the hash checks a joined value whatever parts it
 * was stored in, and a part's own name is never trusted.
 *
 * @module app/history/value-parts
 */

import { ARRAY_KEY, NUMBER_KEY, PART_KEY, requireUnreservedKeys, specialNumberName, typedArrayDigest } from './value-pool.js';
import { sha256Hex } from '../utils/sha256.js';
import { formatCountOf } from '../../utils/format-units.js';

/**
 * The skeleton text, in characters, from which an object or a list is stored
 * as a part. A part's reference is 76 characters and a part costs its name
 * once more where it is stored, so a smaller one gains little when it repeats
 * and costs most of its size when it does not (measured: `tests/stress/RESULTS.md`).
 */
export const PART_MIN_CHARS = 512;

/** A part's name: the SHA-256 of its skeleton text, lower-case hex. */
const PART_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The longest skeleton text one value may expand to: V8's longest string
 * (2^29 - 24 characters), past which a value can be neither hashed nor
 * written as text. A file that names more (parts that repeat parts) is
 * refused before it is expanded.
 */
export const MAX_VALUE_TEXT = 2 ** 29 - 24;

/** The typed arrays a value may hold, by the name their digest starts with. */
export const ARRAY_TYPES = Object.freeze(Object.fromEntries([
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  ...(typeof globalThis.Float16Array === 'function' ? [globalThis.Float16Array] : []),
].map(type => [type.name, type])));

const SPECIAL_NUMBERS = Object.freeze({ NaN: Number.NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 });

const DIGEST_PATTERN = /^([A-Za-z0-9]+):(0|[1-9]\d*):([0-9a-f]{64})$/;

function defineOwn(target, key, value) {
  // A plain assignment of "__proto__" would replace the prototype; stored values are untrusted.
  // Any other key of a fresh plain object is an own data property when assigned (and far quicker).
  if (key === '__proto__') Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A typed array a value may hold (not a DataView, not a subclass). */
function isStorableArray(node) {
  return ArrayBuffer.isView(node) && !(node instanceof DataView) && ARRAY_TYPES[node.constructor.name] === node.constructor;
}

/** The digest of every storable typed array in `value`, each once (`typedArrayDigest`, cached per array). */
async function arrayDigestsOf(value) {
  const digests = new Map();
  const stack = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (ArrayBuffer.isView(node)) {
      if (isStorableArray(node) && !digests.has(node)) digests.set(node, await typedArrayDigest(node));
    } else if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else if (isPlainObject(node)) {
      for (const key of Object.keys(node)) stack.push(node[key]);
    }
  }
  return digests;
}

/** A part's name while its parts are named: as long as a name, never in JSON text (a raw U+0000). */
const PENDING_NAME = /\u0000(\d{62})\u0000/g;

function pendingName(index) {
  return `\u0000${String(index).padStart(62, '0')}\u0000`;
}

/**
 * The skeleton of `value`, adding every typed array it holds to `arrays`
 * (digest → array; shared between the values of one save) and, when `parts`
 * is given, every sub-value at least {@link PART_MIN_CHARS} characters long
 * to it (name → skeleton; shared likewise).
 *
 * The arrays' digests are taken first (cached per array), then the skeleton
 * is made in one synchronous pass, each part's name left pending (a
 * placeholder as long as a name), then the parts are named bottom-up, each
 * from its text with the names of the parts inside it filled in: a value of
 * many nodes waits once per array and once per part, not once per node.
 *
 * @param {unknown} value
 * @param {Map<string, ArrayBufferView>} arrays
 * @param {Map<string, unknown>|null} [parts]
 * @returns {Promise<unknown>}
 */
export async function splitValue(value, arrays, parts = null) {
  const digests = await arrayDigestsOf(value);
  /** Parts met, inner first: {text, skeleton, ref}. */
  const pending = [];
  /** Returns [skeleton, its JSON text] (the text only when parts are kept). */
  function visit(node, path, root) {
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return [node, parts === null ? '' : JSON.stringify(node)];
    if (typeof node === 'number') {
      const name = specialNumberName(node);
      const out = name === null ? node : { [NUMBER_KEY]: name };
      return [out, parts === null ? '' : JSON.stringify(out)];
    }
    if (ArrayBuffer.isView(node)) {
      if (!isStorableArray(node)) throw new TypeError(`A state value holds a ${node.constructor.name} at ${path}, which cannot be stored`);
      const digest = digests.get(node);
      if (!arrays.has(digest)) arrays.set(digest, node);
      const out = { [ARRAY_KEY]: digest };
      return [out, parts === null ? '' : JSON.stringify(out)];
    }
    let out;
    let text = '';
    if (Array.isArray(node)) {
      out = [];
      const texts = [];
      for (let i = 0; i < node.length; i++) {
        if (!Object.hasOwn(node, i) || node[i] === undefined) throw new TypeError(`A state value has a hole at ${path}[${i}]`);
        const [child, childText] = visit(node[i], `${path}[${i}]`, false);
        out.push(child);
        if (parts !== null) texts.push(childText);
      }
      if (parts !== null) text = `[${texts.join(',')}]`;
    } else if (typeof node === 'object') {
      if (!isPlainObject(node)) {
        throw new TypeError(`A state value holds a ${Object.getPrototypeOf(node)?.constructor?.name ?? 'non-plain'} object at ${path}`);
      }
      requireUnreservedKeys(node, path);
      out = {};
      const texts = [];
      for (const key of Object.keys(node)) {
        if (node[key] === undefined) continue;
        const [child, childText] = visit(node[key], `${path}.${key}`, false);
        defineOwn(out, key, child);
        if (parts !== null) texts.push(`${JSON.stringify(key)}:${childText}`);
      }
      if (parts !== null) text = `{${texts.join(',')}}`;
    } else {
      throw new TypeError(`A state value holds a ${typeof node} at ${path}`);
    }
    if (parts === null || root || text.length < PART_MIN_CHARS) return [out, text];
    const ref = { [PART_KEY]: pendingName(pending.length) };
    pending.push({ text, skeleton: out, ref });
    return [ref, `{"${PART_KEY}":"${ref[PART_KEY]}"}`];
  }
  const [skeleton] = visit(value, 'value', true);
  if (pending.length > 0) {
    const encoder = new TextEncoder();
    const names = [];
    // Inner parts come first: a part's text names only parts already named.
    for (const part of pending) {
      const text = part.text.replace(PENDING_NAME, (_, index) => names[Number(index)]);
      const name = await sha256Hex(encoder.encode(text));
      names.push(name);
      part.ref[PART_KEY] = name;
      if (!parts.has(name)) parts.set(name, part.skeleton);
    }
  }
  return skeleton;
}

/**
 * The value a skeleton describes, its arrays taken from `arrayOf(digest)`
 * and its parts from `partOf(name)` (`partJoiner`), each of which throws for
 * a name it does not hold. Every object made is a plain object; a malformed
 * skeleton is refused, naming where.
 *
 * @param {unknown} skeleton
 * @param {(digest: string) => ArrayBufferView} arrayOf
 * @param {((name: string) => unknown)|null} [partOf] - null where no part may be named
 * @returns {unknown}
 */
export function joinValue(skeleton, arrayOf, partOf = null) {
  function visit(node, path) {
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new TypeError(`A stored value has a non-finite number at ${path}`);
      return node;
    }
    if (Array.isArray(node)) return node.map((item, i) => visit(item, `${path}[${i}]`));
    if (typeof node !== 'object' || !isPlainObject(node)) throw new TypeError(`A stored value is not JSON at ${path}`);
    const reserved = placeholderKey(node, path);
    if (reserved !== null) {
      if (reserved === ARRAY_KEY) return arrayOf(node[ARRAY_KEY]);
      if (reserved === PART_KEY) {
        if (partOf === null) throw new TypeError(`A stored value names a part where none may be at ${path}`);
        return partOf(node[PART_KEY]);
      }
      if (!Object.hasOwn(SPECIAL_NUMBERS, node[NUMBER_KEY])) throw new TypeError(`A stored value has an unknown number at ${path}`);
      return SPECIAL_NUMBERS[node[NUMBER_KEY]];
    }
    const out = {};
    for (const [key, child] of Object.entries(node)) defineOwn(out, key, visit(child, `${path}.${key}`));
    return out;
  }
  return visit(skeleton, 'value');
}

/** The placeholder key an object of a skeleton is (`$array`, `$number`, `$part`), or null; a malformed one is refused. */
function placeholderKey(node, path) {
  const key = [ARRAY_KEY, NUMBER_KEY, PART_KEY].find(candidate => Object.hasOwn(node, candidate));
  if (key === undefined) return null;
  if (Object.keys(node).length !== 1) throw new TypeError(`A stored value has a malformed placeholder at ${path}`);
  if (key === ARRAY_KEY && typeof node[ARRAY_KEY] !== 'string') throw new TypeError(`A stored value names an array wrongly at ${path}`);
  if (key === PART_KEY && (typeof node[PART_KEY] !== 'string' || !PART_PATTERN.test(node[PART_KEY]))) {
    throw new TypeError(`A stored value names a part wrongly at ${path}`);
  }
  return key;
}

/**
 * Joining over stored parts (untrusted input): `partOf(name)` joins a part
 * once and gives the same value to every value that names it; a part that
 * names itself (through others) and a value whose text would pass
 * {@link MAX_VALUE_TEXT} are refused before anything is expanded
 * (`expandedLength`).
 *
 * @param {{skeletonOf: (name: string) => unknown, arrayOf: (digest: string) => ArrayBufferView}} stores -
 *   `skeletonOf` throws for a part it does not hold
 */
export function partJoiner({ skeletonOf, arrayOf }) {
  const joined = new Map();
  const lengths = new Map();
  const visiting = new Set();
  const used = new Set();

  function partLength(name) {
    if (lengths.has(name)) return lengths.get(name);
    if (visiting.has(name)) throw new TypeError('A stored value names a part inside itself');
    visiting.add(name);
    const length = textLength(skeletonOf(name));
    visiting.delete(name);
    lengths.set(name, length);
    return length;
  }

  /** The skeleton's text length with every part expanded (each part counted from its own text). */
  function textLength(node) {
    if (node === null || typeof node !== 'object') return JSON.stringify(node)?.length ?? 0;
    if (Array.isArray(node)) {
      let length = 1 + Math.max(node.length - 1, 0) + 1;
      for (const item of node) length += textLength(item);
      return length;
    }
    // A placeholder's shape is checked before what it names is looked for.
    const reserved = placeholderKey(node, 'value');
    if (reserved === PART_KEY) return partLength(node[PART_KEY]);
    if (reserved !== null) return JSON.stringify(node).length;
    let length = 2;
    let first = true;
    for (const [key, child] of Object.entries(node)) {
      length += (first ? 0 : 1) + JSON.stringify(key).length + 1 + textLength(child);
      first = false;
    }
    return length;
  }

  function partOf(name) {
    if (joined.has(name)) return joined.get(name);
    const value = joinValue(skeletonOf(name), arrayOf, partOf);
    joined.set(name, value);
    used.add(name);
    return value;
  }

  return Object.freeze({
    partOf,
    /** The text length `skeleton` expands to; refused past {@link MAX_VALUE_TEXT}. */
    expandedLength(skeleton) {
      const length = textLength(skeleton);
      if (length > MAX_VALUE_TEXT) {
        throw new RangeError(`A stored value expands to ${formatCountOf(length, 'character')} of text, more than a page can hold (${MAX_VALUE_TEXT})`);
      }
      return length;
    },
    /** `skeleton` joined, after its expanded size is checked. */
    join(skeleton) {
      this.expandedLength(skeleton);
      return joinValue(skeleton, arrayOf, partOf);
    },
    /** The parts joined so far (a reader refuses parts nothing named). */
    used: () => new Set(used),
  });
}

/**
 * Every part name a skeleton names directly (not those inside the parts), in
 * the order met.
 *
 * @param {unknown} skeleton
 * @returns {string[]}
 */
export function skeletonParts(skeleton) {
  const out = [];
  const visit = node => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (Object.hasOwn(node, PART_KEY) && typeof node[PART_KEY] === 'string') {
      out.push(node[PART_KEY]);
      return;
    }
    if (Object.hasOwn(node, ARRAY_KEY)) return;
    for (const child of Object.values(node)) visit(child);
  };
  visit(skeleton);
  return out;
}

/**
 * Every array digest a skeleton names directly (not those inside its parts), in the order met.
 *
 * @param {unknown} skeleton
 * @returns {string[]}
 */
export function skeletonArrays(skeleton) {
  const out = [];
  const visit = node => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (Object.hasOwn(node, ARRAY_KEY) && typeof node[ARRAY_KEY] === 'string') {
      out.push(node[ARRAY_KEY]);
      return;
    }
    if (Object.hasOwn(node, PART_KEY)) return;
    for (const child of Object.values(node)) visit(child);
  };
  visit(skeleton);
  return out;
}

/**
 * What an array digest says: its type, its length and the SHA-256 of its
 * bytes. A digest of another shape, or of a type no value may hold, is
 * refused.
 *
 * @param {unknown} digest
 * @returns {{type: Function, length: number, sha256: string}}
 */
export function parseArrayDigest(digest) {
  const match = typeof digest === 'string' ? DIGEST_PATTERN.exec(digest) : null;
  const type = match === null ? undefined : ARRAY_TYPES[match[1]];
  if (match === null || type === undefined || !Number.isSafeInteger(Number(match[2]))) {
    throw new TypeError(`"${String(digest).slice(0, 80)}" is not the digest of an array a state value may hold`);
  }
  return { type, length: Number(match[2]), sha256: match[3] };
}

/**
 * Check that `array` is exactly what `digest` names (its type, length and
 * bytes); the digest is remembered for the array, so hashing a value that
 * holds it does not read its bytes again.
 *
 * @param {ArrayBufferView} array
 * @param {string} digest
 * @returns {Promise<void>}
 */
export async function verifyArray(array, digest) {
  const { type, length } = parseArrayDigest(digest);
  if (!(array instanceof type) || array.length !== length || await typedArrayDigest(array) !== digest) {
    throw new RangeError(`A stored array does not match its digest ${digest.slice(0, 40)}…`);
  }
}
