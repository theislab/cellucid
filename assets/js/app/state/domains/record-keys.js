/**
 * @fileoverview The keys of a state domain's record, read across versions
 * (R9R-13, 2026-11-11; the class of F181).
 *
 * A record saved before a key existed must still read: the samples' starting
 * views and every older session hold records of the day they were written,
 * and a reader that demanded the exact key set of today refused them all the
 * moment a key was added ("Camera Path state must contain exactly autoplay,
 * captions, …" on every opening). So a record has two kinds of keys:
 *
 * - **required** keys, which every record of the current session format has;
 * - **added** keys, each added after records were first written, with the
 *   value its absence means. An added key is written only when it differs
 *   from that value, so a record that never used it reads — and hashes — the
 *   same as one written before it existed (the history sees no change), and
 *   a reader fills it in.
 *
 * A key that is neither is refused, and so is a missing required key: those
 * are truly wrong records, not older ones. Two more kinds complete a record's
 * history: **optional** keys, written only when they say something (a
 * filter's `off`), absent otherwise and never filled in; and **dropped**
 * keys, which a record of before held and today's no longer does (the
 * analyses' `sizes`, moved to the layout): read and left out.
 *
 * **Every state domain reads its records through one declaration** (round 9
 * close, F244's class): a domain's value is a tree of records, and its shape
 * (`record`, `listOf`, `nullable`, below) names each record's keys of every
 * kind. `readRecordShape` reads a value of any earlier version against it
 * (filling added keys, leaving out dropped ones, refusing only a truly wrong
 * record, naming where), `writeRecordShape` writes one as before. The state
 * domains (`index.js` `RECORDS`) read every value they restore or describe so,
 * and `tests/state-record-added-keys.test.mjs` reads every published starting
 * view and an older saved state through every domain's shape. A record whose
 * keys another module owns (a camera state, a data mapping, an analysis's
 * settings, the Camera Path's own state) is that module's to read; its shape
 * here stops at it.
 *
 * @module app/state/domains/record-keys
 */

/**
 * The record `value` read with `keys`: every required key present, every
 * added key filled with its default when absent; a copy, `value` untouched.
 *
 * @param {object} value
 * @param {{required: readonly string[], added?: Readonly<Record<string, unknown>>,
 *   optional?: readonly string[], dropped?: readonly string[]}} keys
 * @param {string} label - what the record is, for a refusal ("Camera Path state")
 * @returns {object}
 */
export function readRecordKeys(value, { required, added = {}, optional = [], dropped = [] }, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const known = key => required.includes(key) || Object.hasOwn(added, key) || optional.includes(key) || dropped.includes(key);
  const unknown = Object.keys(value).filter(key => !known(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    const all = [...required, ...[...Object.keys(added), ...optional].map(key => `${key} (optional)`)].sort();
    throw new TypeError(`${label} must contain exactly ${all.join(', ')}${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}${unknown.length > 0 ? `; unknown ${unknown.join(', ')}` : ''}.`);
  }
  const read = { ...value };
  for (const key of dropped) delete read[key];
  for (const [key, absent] of Object.entries(added)) {
    if (!Object.hasOwn(read, key)) read[key] = structuredClone(absent);
  }
  return read;
}

/**
 * The record to save: `value` with every added key that holds the value its
 * absence means left out, so a record that does not use a key added since
 * is byte for byte the record written before it.
 *
 * @param {object} value
 * @param {{added: Readonly<Record<string, unknown>>}} keys
 * @returns {object}
 */
export function writeRecordKeys(value, { added }) {
  const written = { ...value };
  for (const [key, absent] of Object.entries(added)) {
    if (Object.hasOwn(written, key) && JSON.stringify(written[key]) === JSON.stringify(absent)) delete written[key];
  }
  return written;
}

// ------------------------------------------------------------- Record shapes

const RECORD = Symbol('record');
const LIST = Symbol('list');
const NULLABLE = Symbol('nullable');

/**
 * A record's shape: its keys of each kind and, by key, the shape of a value
 * that is itself a record (or a list of them). A key not in `fields` is read
 * as it is (a number, a string, a typed array, or a record another module
 * owns and reads).
 *
 * @param {{required?: string[], optional?: string[], added?: Record<string, unknown>,
 *   dropped?: string[], fields?: Record<string, object>}} keys
 */
export function record({ required = [], optional = [], added = {}, dropped = [], fields = {} }) {
  for (const key of Object.keys(fields)) {
    if (!required.includes(key) && !optional.includes(key) && !Object.hasOwn(added, key)) {
      throw new TypeError(`A record shape names the field "${key}" among none of its keys.`);
    }
  }
  const shape = { kind: RECORD, keys: Object.freeze({ required: Object.freeze([...required]), optional: Object.freeze([...optional]), added: Object.freeze({ ...added }), dropped: Object.freeze([...dropped]) }), fields: Object.freeze({ ...fields }) };
  shape.writes = Object.keys(added).length > 0 || Object.values(fields).some(writesSomething);
  return Object.freeze(shape);
}

/** A list whose every item has `shape`. */
export function listOf(shape) {
  return Object.freeze({ kind: LIST, item: shape, writes: writesSomething(shape) });
}

/** `shape`, or null. */
export function nullable(shape) {
  return Object.freeze({ kind: NULLABLE, item: shape, writes: writesSomething(shape) });
}

function writesSomething(shape) {
  return shape.writes === true;
}

/**
 * `value` read against `shape` (a record of any earlier version): every
 * record checked, added keys filled, dropped keys left out. Records that
 * need no change are given back as they are; a record or list is copied only
 * on the path to one that changed.
 *
 * @param {unknown} value
 * @param {object} shape - `record`, `listOf` or `nullable`'s
 * @param {string} label - what the value is ("The highlights to restore")
 * @returns {unknown}
 */
export function readRecordShape(value, shape, label) {
  if (shape.kind === NULLABLE) return value === null ? null : readRecordShape(value, shape.item, label);
  if (shape.kind === LIST) {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be a list.`);
    let out = value;
    value.forEach((item, index) => {
      const read = readRecordShape(item, shape.item, `${label} [${index + 1}]`);
      if (read !== item) {
        if (out === value) out = [...value];
        out[index] = read;
      }
    });
    return out;
  }
  const keys = shape.keys;
  const changes = keys.dropped.some(key => Object.hasOwn(value ?? {}, key))
    || Object.keys(keys.added).some(key => !Object.hasOwn(value ?? {}, key));
  // Checked whatever it holds; copied only when a key is filled or left out.
  const checked = readRecordKeys(value, keys, label);
  let out = changes ? checked : value;
  for (const [key, field] of Object.entries(shape.fields)) {
    if (!Object.hasOwn(out, key)) continue;
    const read = readRecordShape(out[key], field, `${label} › ${key}`);
    if (read !== out[key]) {
      if (out === value) out = { ...value };
      out[key] = read;
    }
  }
  return out;
}

/**
 * `value` as it is saved: every added key that holds the value its absence
 * means left out, so a value that uses none is byte for byte the value of
 * before. A shape with no added key anywhere gives `value` back unread.
 *
 * @param {unknown} value
 * @param {object} shape
 * @returns {unknown}
 */
export function writeRecordShape(value, shape) {
  if (!shape.writes || value === null) return value;
  if (shape.kind === NULLABLE) return writeRecordShape(value, shape.item);
  if (shape.kind === LIST) {
    let out = value;
    value.forEach((item, index) => {
      const written = writeRecordShape(item, shape.item);
      if (written !== item) {
        if (out === value) out = [...value];
        out[index] = written;
      }
    });
    return out;
  }
  let out = value;
  for (const [key, absent] of Object.entries(shape.keys.added)) {
    if (Object.hasOwn(out, key) && JSON.stringify(out[key]) === JSON.stringify(absent)) {
      if (out === value) out = { ...value };
      delete out[key];
    }
  }
  for (const [key, field] of Object.entries(shape.fields)) {
    if (!Object.hasOwn(out, key)) continue;
    const written = writeRecordShape(out[key], field);
    if (written !== out[key]) {
      if (out === value) out = { ...value };
      out[key] = written;
    }
  }
  return out;
}
