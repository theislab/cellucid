/**
 * @fileoverview The parameter schemas of actions: a closed subset of JSON
 * Schema (draft 2020-12) that every consumer reads the same way.
 *
 * One schema is written per action and used five times: to check a dispatch
 * here, as the input schema of the agent tool (`app/agent/`), as the
 * protocol entry Python and R generate their methods from, in the docs
 * reference, and to make sample parameters for the round-trip tests. So the
 * subset is small on purpose, and a schema outside it is refused when the
 * action is defined, not when someone first calls it.
 *
 * Supported keywords: `type` (object, array, string, integer, number,
 * boolean, null, or a list of them), `properties`, `required`,
 * `additionalProperties: false` (required on every object), `items`,
 * `minItems`, `maxItems`, `uniqueItems`, `enum`, `const`, `minimum`,
 * `maximum`, `exclusiveMinimum`, `minLength`, `maxLength`, `pattern`,
 * `oneOf`, `description`, `title`, `default`, `examples`, `contentEncoding`
 * and `contentMediaType` (annotations of a string of bytes: a result's
 * picture is `contentEncoding: 'base64'`, `contentMediaType: 'image/png'`,
 * which an agent receives as an image rather than as text), and the Cellucid
 * annotation `x-cells: true` on an array of original cell positions (a
 * `Uint32Array` is accepted for it, so a binary protocol frame and a JSON
 * tool call land on the same check), and `x-values: true` on an array of
 * per-cell numbers (a column a notebook pushes: any numeric typed array is
 * accepted for it, as its binary frame carries it).
 *
 * @module app/actions/schema
 */

import { formatCountOf } from '../../utils/format-units.js';

const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'minLength',
  'maxLength', 'pattern', 'oneOf', 'description', 'title', 'default', 'examples', 'x-cells',
  'x-values', 'contentEncoding', 'contentMediaType',
]);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

function fail(path, message) {
  throw new TypeError(`Action schema ${path}: ${message}`);
}

function typesOf(schema) {
  if (schema.type === undefined) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

/**
 * Check that `schema` stays inside the supported subset. Every object must
 * close its properties, so a misspelt parameter is refused by name instead of
 * being ignored.
 * @param {unknown} schema
 * @param {string} [path]
 */
export function assertActionSchema(schema, path = 'params') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    fail(path, 'must be an object');
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) fail(path, `uses unsupported keyword "${key}"`);
  }
  const types = typesOf(schema);
  if (types === null && schema.oneOf === undefined && schema.const === undefined && schema.enum === undefined) {
    fail(path, 'must name a type, an enum, a const or oneOf');
  }
  for (const type of types ?? []) {
    if (!TYPES.has(type)) fail(path, `has unknown type "${type}"`);
  }
  if (types?.includes('object')) {
    if (schema.additionalProperties !== false) fail(path, 'objects must set additionalProperties: false');
    const properties = schema.properties ?? {};
    if (properties === null || typeof properties !== 'object') fail(path, 'properties must be an object');
    for (const [name, sub] of Object.entries(properties)) assertActionSchema(sub, `${path}.${name}`);
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(properties, name)) fail(path, `requires undeclared "${name}"`);
    }
  }
  if (types?.includes('array')) {
    if (schema.items === undefined) fail(path, 'arrays must declare items');
    assertActionSchema(schema.items, `${path}[]`);
  }
  if (schema['x-cells'] === true) {
    if (!types?.includes('array') || schema.items?.type !== 'integer') {
      fail(path, 'x-cells must annotate an array of integers');
    }
  }
  if (schema['x-values'] === true) {
    if (!types?.includes('array') || !['integer', 'number'].includes(schema.items?.type) || schema['x-cells'] === true) {
      fail(path, 'x-values must annotate an array of numbers that is not x-cells');
    }
  }
  if (schema.contentEncoding !== undefined || schema.contentMediaType !== undefined) {
    if (!types?.includes('string') || schema.contentEncoding !== 'base64'
      || typeof schema.contentMediaType !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/.test(schema.contentMediaType)) {
      fail(path, 'contentEncoding (base64) and contentMediaType (a media type) annotate a string of bytes together');
    }
  }
  if (schema.pattern !== undefined) new RegExp(schema.pattern, 'u');
  for (const [index, sub] of (schema.oneOf ?? []).entries()) {
    assertActionSchema(sub, `${path}.oneOf[${index}]`);
  }
  if (schema.default !== undefined) {
    const problem = schemaProblem(schema, schema.default, `${path}.default`);
    if (problem !== null) fail(path, `default does not match: ${problem}`);
  }
  for (const example of schema.examples ?? []) {
    const problem = schemaProblem(schema, example, `${path} example`);
    if (problem !== null) fail(path, `example does not match: ${problem}`);
  }
  return schema;
}

function typeMatches(type, value) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
      && !ArrayBuffer.isView(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  return typeof value === 'string' ? `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"` : String(value);
}

/**
 * The first way `value` breaks `schema`, as one sentence naming where, or
 * null when it matches.
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string|null}
 */
export function schemaProblem(schema, value, path = 'params') {
  if (schema['x-cells'] === true && value instanceof Uint32Array) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${path} needs at least ${formatCountOf(schema.minItems, 'cell')}`;
    }
    return null;
  }
  if (schema['x-values'] === true && ArrayBuffer.isView(value) && !(value instanceof DataView)
    && typeof value.BYTES_PER_ELEMENT === 'number' && !(value instanceof BigInt64Array) && !(value instanceof BigUint64Array)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${path} needs at least ${formatCountOf(schema.minItems, 'value')}`;
    }
    return null;
  }
  if (schema.const !== undefined && value !== schema.const) {
    return `${path} must be ${JSON.stringify(schema.const)}, not ${describeValue(value)}`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return `${path} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}, not ${describeValue(value)}`;
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(sub => schemaProblem(sub, value, path) === null).length;
    if (matches !== 1) {
      return matches === 0
        ? `${path} matches none of its ${schema.oneOf.length} forms`
        : `${path} matches more than one of its forms`;
    }
  }
  const types = typesOf(schema);
  if (types !== null) {
    const type = types.find(t => typeMatches(t, value));
    if (type === undefined) return `${path} must be ${types.join(' or ')}, not ${describeValue(value)}`;
    if (type === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path} must have at least ${formatCountOf(schema.minLength, 'character')}`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} must have at most ${formatCountOf(schema.maxLength, 'character')}`;
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
        return `${path} ${describeValue(value)} does not have the expected form`;
      }
    }
    if (type === 'integer' || type === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
        return `${path} must be more than ${schema.exclusiveMinimum}`;
      }
    }
    if (type === 'array') {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} needs at least ${formatCountOf(schema.minItems, 'item')}`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} takes at most ${formatCountOf(schema.maxItems, 'item')}`;
      }
      for (let index = 0; index < value.length; index++) {
        const problem = schemaProblem(schema.items, value[index], `${path}[${index}]`);
        if (problem !== null) return problem;
      }
      if (schema.uniqueItems === true) {
        const seen = new Set(value.map(item => JSON.stringify(item)));
        if (seen.size !== value.length) return `${path} must not repeat an item`;
      }
    }
    if (type === 'object') {
      const properties = schema.properties ?? {};
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          const known = Object.keys(properties);
          return `${path} has no parameter "${key}"${known.length ? ` (known: ${known.join(', ')})` : ''}`;
        }
      }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key)) continue;
        const problem = schemaProblem(sub, value[key], `${path}.${key}`);
        if (problem !== null) return problem;
      }
    }
  }
  return null;
}

/**
 * `value` with every omitted parameter that has a default filled in, so a
 * recorded step names everything it was applied with (a replay on a later
 * version, whose defaults moved, does the same thing).
 * @param {object} schema
 * @param {unknown} value
 */
export function withDefaults(schema, value) {
  if (!typesOf(schema)?.includes('object') || value === null || typeof value !== 'object'
    || Array.isArray(value) || ArrayBuffer.isView(value)) {
    return value;
  }
  const out = {};
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(value, key)) out[key] = withDefaults(sub, value[key]);
    else if (sub.default !== undefined) out[key] = structuredClone(sub.default);
  }
  return out;
}

/**
 * One example value of `schema`: its first example, its default, or the
 * smallest value of its type. The round-trip tests apply every action with
 * this.
 * @param {object} schema
 */
export function exampleOf(schema) {
  if (schema.examples?.length) return structuredClone(schema.examples[0]);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum !== undefined) return schema.enum[0];
  if (schema.oneOf !== undefined) return exampleOf(schema.oneOf[0]);
  const type = typesOf(schema)[0];
  switch (type) {
    case 'object': {
      const out = {};
      for (const key of schema.required ?? []) out[key] = exampleOf(schema.properties[key]);
      return out;
    }
    case 'array': return Array.from({ length: schema.minItems ?? 0 }, () => exampleOf(schema.items));
    case 'string': return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    case 'integer': case 'number': return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0);
    case 'boolean': return false;
    default: return null;
  }
}

/**
 * Examples that together use every part of a schema: every property of every
 * object (optional ones included), and one example for each branch of each
 * `oneOf` (the first example holds the first branch of each; every other
 * branch gets one example of its own). What the action-version drift test
 * upgrades, so an upgrader that forgets an optional parameter, or a branch,
 * fails on the kept examples. Each one is valid for `schema` when the schema
 * has no rule across properties.
 * @param {object} schema
 * @returns {unknown[]}
 */
export function examplesOf(schema) {
  if (schema.oneOf !== undefined) {
    const { oneOf, ...rest } = schema;
    return oneOf.flatMap(branch => examplesOf({ ...rest, ...branch }));
  }
  if (schema.const !== undefined || schema.enum !== undefined) return [exampleOf(schema)];
  const type = typesOf(schema)?.[0];
  if (type === 'object' && schema.properties !== undefined) {
    const parts = Object.entries(schema.properties).map(([key, sub]) => [key, examplesOf(sub)]);
    const base = Object.fromEntries(parts.map(([key, values]) => [key, values[0]]));
    const out = [base];
    for (const [key, values] of parts) for (const value of values.slice(1)) out.push({ ...base, [key]: value });
    return out;
  }
  if (type === 'array' && schema.items !== undefined) {
    const items = examplesOf(schema.items);
    const length = Math.max(1, schema.minItems ?? 0);
    // Distinct items where they must be: the item's own values, else numbered texts or numbers.
    const nth = index => {
      if (schema.items.enum !== undefined) return schema.items.enum[index % schema.items.enum.length];
      const kind = typesOf(schema.items)?.[0];
      if (kind === 'string') return `${exampleOf(schema.items)}${index}`;
      if (kind === 'integer' || kind === 'number') return exampleOf(schema.items) + index;
      return exampleOf(schema.items);
    };
    const fill = value => (schema.uniqueItems && length > 1
      ? Array.from({ length }, (_, index) => (index === 0 ? value : nth(index)))
      : Array.from({ length }, () => structuredClone(value)));
    return items.map(fill);
  }
  return [exampleOf(schema)];
}
