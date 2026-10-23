/**
 * Analysis result codec: an analysis result as JSON values plus typed numeric
 * arrays, and back, exactly.
 *
 * Sessions store an analysis result as typed JSON (`session/codecs/typed-json.js`):
 * finite numbers, strings, booleans, null, arrays, plain objects, and typed
 * arrays of six element types, which are written as their bytes. A result in
 * memory holds more than that: NaN and infinite statistics, `undefined`
 * fields, typed arrays of other element types, one object reached from two
 * places, and long columns of numbers or labels inside arrays of records. This
 * codec writes every such value as an explicit tagged node, so decoding gives
 * back a value deep-equal to the original, with the same sharing.
 *
 * Encoded nodes (every tag object has the key `$`; nothing else does):
 *
 * - `null`, booleans, strings, and finite numbers other than -0: themselves.
 * - `{$: 'number', value: 'NaN'|'Infinity'|'-Infinity'|'-0'}`.
 * - `{$: 'undefined'}`.
 * - `{$: 'typed', type, values}`: a typed array (copied, so the encoded value
 *   never aliases the live result). `values` is the array itself for the six
 *   element types typed JSON stores, else an Int32Array (Int8, Int16) or a
 *   Uint8Array (Uint8Clamped) of the same numbers.
 * - `{$: 'numbers', values: Float64Array}` and `{$: 'counts', values:
 *   Uint32Array}`: an array of numbers (`counts` when every one is an integer
 *   in [0, 2^32)).
 * - `{$: 'labels', labels: string[], codes}`: an array of strings that repeat,
 *   as its distinct strings and one code per element.
 * - `{$: 'records', length, keys, present, columns}`: an array of plain
 *   objects stored column by column. `keys` lists every key in first-use
 *   order; `present[k]` is null when every record has key k, else a Uint8Array
 *   flag per record; `columns[k]` is the encoded list of the values present.
 * - `{$: 'array', items}`: any other array.
 * - `{$: 'object', keys, values, nullPrototype}`: a plain object, as parallel
 *   lists, so keys such as "__proto__" or "$" stay ordinary data.
 * - `{$: 'ref', id}`: an object, array or typed array already met. Ids count
 *   those values in the order the encoder first meets them, which is the order
 *   the decoder creates them.
 *
 * Maps, Sets, class instances, functions, symbols and bigints are refused.
 *
 * @module shared/analysis-result-codec
 */

const NATIVE_TYPED_ARRAYS = new Map([
  ['Uint8Array', Uint8Array],
  ['Uint16Array', Uint16Array],
  ['Uint32Array', Uint32Array],
  ['Int32Array', Int32Array],
  ['Float32Array', Float32Array],
  ['Float64Array', Float64Array]
]);

const WIDENED_TYPED_ARRAYS = new Map([
  ['Int8Array', [Int8Array, Int32Array]],
  ['Int16Array', [Int16Array, Int32Array]],
  ['Uint8ClampedArray', [Uint8ClampedArray, Uint8Array]]
]);

const SPECIAL_NUMBERS = new Map([
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['-0', -0]
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function specialNumberName(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return null;
}

function defineData(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function smallestCodeArray(count, length) {
  if (count <= 0x100) return new Uint8Array(length);
  if (count <= 0x10000) return new Uint16Array(length);
  return new Uint32Array(length);
}

/**
 * Encode an analysis result.
 *
 * @param {unknown} value
 * @param {string} [label='Analysis result']
 * @returns {unknown} JSON values and typed arrays only
 */
export function encodeAnalysisResult(value, label = 'Analysis result') {
  const ids = new Map();

  function register(node) {
    ids.set(node, ids.size);
  }

  function encodeNode(node, path) {
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return node;
    if (node === undefined) return { $: 'undefined' };
    if (typeof node === 'number') {
      const special = specialNumberName(node);
      return special === null ? node : { $: 'number', value: special };
    }
    if (typeof node !== 'object') {
      throw new TypeError(`${path} is a ${typeof node}, which a result cannot hold`);
    }
    if (ids.has(node)) return { $: 'ref', id: ids.get(node) };
    if (isTypedArray(node)) {
      register(node);
      const type = node.constructor.name;
      if (NATIVE_TYPED_ARRAYS.has(type)) {
        return { $: 'typed', type, values: node.slice() };
      }
      const widened = WIDENED_TYPED_ARRAYS.get(type);
      if (widened === undefined) {
        throw new TypeError(`${path} is a ${type}, which a result cannot hold`);
      }
      return { $: 'typed', type, values: widened[1].from(node) };
    }
    if (Array.isArray(node)) {
      register(node);
      return encodeList(node, path);
    }
    if (!isPlainObject(node)) {
      throw new TypeError(
        `${path} is a ${node?.constructor?.name ?? 'non-plain object'}, which a result cannot hold`
      );
    }
    register(node);
    const keys = Object.keys(node);
    if (Object.getOwnPropertySymbols(node).length > 0) {
      throw new TypeError(`${path} has symbol keys, which a result cannot hold`);
    }
    return {
      $: 'object',
      keys,
      values: keys.map(key => encodeNode(node[key], `${path}.${key}`)),
      nullPrototype: Object.getPrototypeOf(node) === null
    };
  }

  // Records are stored by column when every element is a plain object met
  // for the first time and each one's keys follow one shared order.
  function recordLayout(list) {
    if (list.length === 0) return null;
    const keys = [];
    const position = new Map();
    const seen = new Set();
    for (const item of list) {
      if (
        !isPlainObject(item) ||
        Object.getPrototypeOf(item) === null ||
        ids.has(item) ||
        seen.has(item)
      ) {
        return null;
      }
      seen.add(item);
      for (const key of Object.keys(item)) {
        if (!position.has(key)) {
          position.set(key, keys.length);
          keys.push(key);
        }
      }
    }
    for (const item of list) {
      let last = -1;
      for (const key of Object.keys(item)) {
        const at = position.get(key);
        if (at <= last) return null;
        last = at;
      }
    }
    return keys;
  }

  function encodeList(list, path) {
    const length = list.length;
    if (length > 0 && list.every(item => typeof item === 'number')) {
      const counts = list.every(
        item => Number.isInteger(item) && item >= 0 && item <= 0xffffffff && !Object.is(item, -0)
      );
      return counts
        ? { $: 'counts', values: Uint32Array.from(list) }
        : { $: 'numbers', values: Float64Array.from(list) };
    }
    if (length > 1 && list.every(item => typeof item === 'string')) {
      const codeOf = new Map();
      for (const item of list) if (!codeOf.has(item)) codeOf.set(item, codeOf.size);
      if (codeOf.size * 2 <= length) {
        const codes = smallestCodeArray(codeOf.size, length);
        for (let i = 0; i < length; i++) codes[i] = codeOf.get(list[i]);
        return { $: 'labels', labels: [...codeOf.keys()], codes };
      }
    }
    const keys = recordLayout(list);
    if (keys !== null) {
      for (const item of list) register(item);
      const present = [];
      const columns = [];
      for (const key of keys) {
        const flags = new Uint8Array(length);
        const values = [];
        for (let i = 0; i < length; i++) {
          if (Object.hasOwn(list[i], key)) {
            flags[i] = 1;
            values.push(list[i][key]);
          }
        }
        present.push(values.length === length ? null : flags);
        columns.push(encodeList(values, `${path}[*].${key}`));
      }
      return { $: 'records', length, keys, present, columns };
    }
    return {
      $: 'array',
      items: list.map((item, index) => encodeNode(item, `${path}[${index}]`))
    };
  }

  return encodeNode(value, label);
}

/**
 * Decode a value made by `encodeAnalysisResult`. Every node is checked; a
 * malformed one is refused with its path.
 *
 * @param {unknown} encoded
 * @param {string} [label='Analysis result']
 * @returns {unknown}
 */
export function decodeAnalysisResult(encoded, label = 'Analysis result') {
  const nodes = [];

  function fail(path, what) {
    throw new TypeError(`${path} ${what}`);
  }

  function requireTag(node, path, keys) {
    const actual = Object.keys(node).sort();
    const expected = ['$', ...keys].sort();
    if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
      fail(path, `must hold exactly ${expected.join(', ')}`);
    }
  }

  function decodeNode(node, path) {
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) fail(path, 'must be a finite number');
      return node;
    }
    if (!isPlainObject(node) || typeof node.$ !== 'string') {
      fail(path, 'must be an encoded result node');
    }
    switch (node.$) {
      case 'undefined':
        requireTag(node, path, []);
        return undefined;
      case 'number': {
        requireTag(node, path, ['value']);
        if (!SPECIAL_NUMBERS.has(node.value)) fail(path, 'names an unknown number');
        return SPECIAL_NUMBERS.get(node.value);
      }
      case 'ref': {
        requireTag(node, path, ['id']);
        if (!Number.isSafeInteger(node.id) || node.id < 0 || node.id >= nodes.length) {
          fail(path, 'refers to a value not yet decoded');
        }
        return nodes[node.id];
      }
      case 'typed': {
        requireTag(node, path, ['type', 'values']);
        const native = NATIVE_TYPED_ARRAYS.get(node.type);
        if (native !== undefined) {
          if (!(node.values instanceof native)) fail(path, `values must be a ${node.type}`);
          nodes.push(node.values);
          return node.values;
        }
        const widened = WIDENED_TYPED_ARRAYS.get(node.type);
        if (widened === undefined) fail(path, 'names an unknown typed array type');
        if (!(node.values instanceof widened[1])) {
          fail(path, `values must be a ${widened[1].name}`);
        }
        const values = widened[0].from(node.values);
        for (let i = 0; i < values.length; i++) {
          if (values[i] !== node.values[i]) fail(path, `holds a value outside ${node.type}`);
        }
        nodes.push(values);
        return values;
      }
      case 'object': {
        requireTag(node, path, ['keys', 'values', 'nullPrototype']);
        if (
          !Array.isArray(node.keys) ||
          !Array.isArray(node.values) ||
          node.keys.length !== node.values.length ||
          node.keys.some(key => typeof key !== 'string') ||
          new Set(node.keys).size !== node.keys.length ||
          typeof node.nullPrototype !== 'boolean'
        ) {
          fail(path, 'must list distinct string keys and one value per key');
        }
        const out = node.nullPrototype ? Object.create(null) : {};
        nodes.push(out);
        for (let i = 0; i < node.keys.length; i++) {
          defineData(out, node.keys[i], decodeNode(node.values[i], `${path}.${node.keys[i]}`));
        }
        return out;
      }
      default: {
        const out = [];
        nodes.push(out);
        for (const item of decodeListInto(node, path)) out.push(item);
        return out;
      }
    }
  }

  // Returns the decoded elements of a list node. A list that is itself a node
  // has been registered by the caller before this runs.
  function decodeListInto(node, path) {
    if (!isPlainObject(node) || typeof node.$ !== 'string') {
      fail(path, 'must be an encoded list');
    }
    switch (node.$) {
      case 'numbers':
        requireTag(node, path, ['values']);
        if (!(node.values instanceof Float64Array)) fail(path, 'values must be a Float64Array');
        return Array.from(node.values);
      case 'counts':
        requireTag(node, path, ['values']);
        if (!(node.values instanceof Uint32Array)) fail(path, 'values must be a Uint32Array');
        return Array.from(node.values);
      case 'labels': {
        requireTag(node, path, ['labels', 'codes']);
        if (
          !Array.isArray(node.labels) ||
          node.labels.some(item => typeof item !== 'string') ||
          !(node.codes instanceof Uint8Array || node.codes instanceof Uint16Array || node.codes instanceof Uint32Array)
        ) {
          fail(path, 'must hold string labels and integer codes');
        }
        const out = new Array(node.codes.length);
        for (let i = 0; i < out.length; i++) {
          const code = node.codes[i];
          if (code >= node.labels.length) fail(path, `code ${code} has no label`);
          out[i] = node.labels[code];
        }
        return out;
      }
      case 'records': {
        requireTag(node, path, ['length', 'keys', 'present', 'columns']);
        const { length, keys, present, columns } = node;
        if (
          !Number.isSafeInteger(length) || length < 1 ||
          !Array.isArray(keys) || keys.some(key => typeof key !== 'string') ||
          new Set(keys).size !== keys.length ||
          !Array.isArray(present) || present.length !== keys.length ||
          !Array.isArray(columns) || columns.length !== keys.length
        ) {
          fail(path, 'must describe records by keys, presence and columns');
        }
        const records = Array.from({ length }, () => ({}));
        for (const record of records) nodes.push(record);
        const valueLists = [];
        for (let k = 0; k < keys.length; k++) {
          const flags = present[k];
          if (flags !== null && !(flags instanceof Uint8Array && flags.length === length)) {
            fail(`${path}.${keys[k]}`, 'presence must be null or one Uint8Array flag per record');
          }
          const values = decodeListInto(columns[k], `${path}[*].${keys[k]}`);
          const expected = flags === null ? length : flags.reduce((sum, flag) => sum + (flag === 1 ? 1 : 0), 0);
          if (values.length !== expected) {
            fail(`${path}[*].${keys[k]}`, `holds ${values.length} values for ${expected} records`);
          }
          valueLists.push(values);
        }
        const cursors = new Array(keys.length).fill(0);
        for (let i = 0; i < length; i++) {
          for (let k = 0; k < keys.length; k++) {
            const flags = present[k];
            if (flags !== null && flags[i] === 0) continue;
            if (flags !== null && flags[i] !== 1) fail(`${path}.${keys[k]}`, 'presence flags must be 0 or 1');
            defineData(records[i], keys[k], valueLists[k][cursors[k]++]);
          }
        }
        return records;
      }
      case 'array':
        requireTag(node, path, ['items']);
        if (!Array.isArray(node.items)) fail(path, 'items must be an array');
        return node.items.map((item, index) => decodeNode(item, `${path}[${index}]`));
      default:
        return fail(path, `has an unknown tag "${String(node.$)}"`);
    }
  }

  return decodeNode(encoded, label);
}

/**
 * Throw unless `value` is made only of JSON values and the six typed array
 * types typed JSON stores, with no object using the reserved key "$typed".
 *
 * @param {unknown} value
 * @param {string} [path='value']
 */
export function requireTypedJsonValue(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    return;
  }
  if (isTypedArray(value)) {
    if (!NATIVE_TYPED_ARRAYS.has(value.constructor.name)) {
      throw new TypeError(`${path} is a ${value.constructor.name}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => requireTypedJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) throw new TypeError(`${path} must be a plain object`);
  if (Object.hasOwn(value, '$typed')) throw new TypeError(`${path} uses the reserved key "$typed"`);
  for (const [key, child] of Object.entries(value)) requireTypedJsonValue(child, `${path}.${key}`);
}
