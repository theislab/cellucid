/**
 * @fileoverview The options of an analysis, declared once.
 *
 * An analysis declares every setting it has as an entry of one schema; the
 * form is rendered from the schema (`render-options-form.js`), the session
 * saves the options record the schema validates, and the docs list the
 * schema's defaults (`tests/analysis-options-schema-contract.test.mjs` holds
 * the docs table to the schema). An options record holds exactly the
 * schema's keys: an unknown or missing key is refused, never ignored.
 *
 * Entry:
 *   key       the record key
 *   kind      'select' | 'segmented' | 'number' | 'boolean' | 'text' |
 *             'flags' | 'groups' | 'gene-sets' | 'variable' (null or
 *             `{type, key}` of one of `types`, checked by
 *             `context.variableExists(type, key)`)
 *   label     sentence case, no colon
 *   tip       the (i) tip registry key (`ui/components/info-tips.js`)
 *   group     'essentials' (always shown) or the id of a declared group
 *   default   the value, or `(context) => value` when it depends on the data
 *   choices   select / segmented / flags: `[{value, label}]`, or
 *             `(context, record) => [{value, label}]`
 *   min, max  number bounds (inclusive); `integer: true` for whole numbers
 *   when      `(record, context) => boolean`: shown and applied only then
 *   check     `(value, record, context) => string|null`: a further rule,
 *             returning the reason a value is refused
 *   defaultText  how the docs table states a default that depends on data
 *
 * `context` is what the data offers (fields, groups, matrices, genes); a
 * schema validates a record's shape without it and its choices with it.
 *
 * @module analysis/options/option-schema
 */

import { isObjectRecord } from '../../../utils/exact-record.js';


export const OPTION_KINDS = Object.freeze([
  'select', 'segmented', 'number', 'boolean', 'text', 'flags', 'groups', 'gene-sets', 'variable'
]);

const ESSENTIALS = 'essentials';

function requireText(value, what) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${what} must be exact non-empty text`);
  }
  return value;
}

/** Sentence case: a capital first letter, no colon, no Title Case words after it. */
export function isSentenceCase(label) {
  if (typeof label !== 'string' || label.length === 0) return false;
  if (label.endsWith(':')) return false;
  if (!/^[A-Z0-9%]/.test(label)) return false;
  const words = label.split(/\s+/).slice(1);
  // Later words may be acronyms (AUROC, BH) or symbols, never capitalised
  // ordinary words ("Max Adjusted P").
  return words.every(word => !/^[A-Z][a-z]+$/.test(word));
}

/** Structural equality of option values (plain data only). */
export function sameOptionValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameOptionValue(item, b[i]));
  }
  if (isObjectRecord(a)) {
    if (!isObjectRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every(key => Object.hasOwn(b, key) && sameOptionValue(a[key], b[key]));
  }
  return Number.isNaN(a) && Number.isNaN(b);
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validateEntry(entry, groupIds, keys) {
  if (!isObjectRecord(entry)) throw new TypeError('An option entry must be an object');
  const key = requireText(entry.key, 'Option key');
  if (keys.has(key)) throw new Error(`Option "${key}" is declared twice`);
  keys.add(key);
  if (!OPTION_KINDS.includes(entry.kind)) throw new RangeError(`Option "${key}" has unknown kind ${entry.kind}`);
  requireText(entry.label, `Option "${key}" label`);
  if (!isSentenceCase(entry.label)) throw new TypeError(`Option "${key}" label "${entry.label}" must be sentence case`);
  requireText(entry.tip, `Option "${key}" tip`);
  if (entry.group !== ESSENTIALS && !groupIds.has(entry.group)) {
    throw new RangeError(`Option "${key}" names unknown group ${entry.group}`);
  }
  if (!Object.hasOwn(entry, 'default')) throw new TypeError(`Option "${key}" needs a default`);
  if (['select', 'segmented', 'flags'].includes(entry.kind)) {
    if (!Array.isArray(entry.choices) && typeof entry.choices !== 'function') {
      throw new TypeError(`Option "${key}" needs its choices`);
    }
    if (Array.isArray(entry.choices)) {
      for (const choice of entry.choices) {
        if (!isObjectRecord(choice) || typeof choice.value !== 'string') {
          throw new TypeError(`Option "${key}" choices are { value: string, label }`);
        }
        requireText(choice.label, `Option "${key}" choice label`);
      }
    }
  }
  for (const name of ['when', 'check']) {
    if (entry[name] !== undefined && typeof entry[name] !== 'function') {
      throw new TypeError(`Option "${key}" ${name} must be a function`);
    }
  }
  if (entry.kind === 'number') {
    for (const bound of ['min', 'max']) {
      if (entry[bound] !== undefined && !Number.isFinite(entry[bound])) {
        throw new TypeError(`Option "${key}" ${bound} must be finite`);
      }
    }
  }
}

/** An entry's choices; null when they depend on data and no context is given. */
export function choicesOf(entry, context, record) {
  if (Array.isArray(entry.choices)) return entry.choices;
  if (typeof entry.choices === 'function') return context === undefined ? null : entry.choices(context, record);
  return null;
}

/** The reason `value` is not a valid value of `entry`, or null. */
function refuseValue(entry, value, record, context) {
  const label = entry.label;
  switch (entry.kind) {
    case 'select':
    case 'segmented': {
      if (typeof value !== 'string') return `${label} must be one of its choices`;
      const choices = choicesOf(entry, context, record);
      if (choices !== null && !choices.some(choice => choice.value === value)) {
        return `${label} has no choice "${value}"`;
      }
      break;
    }
    case 'flags': {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) {
        return `${label} must be a list of distinct choices`;
      }
      const choices = choicesOf(entry, context, record);
      if (choices !== null) {
        const allowed = new Set(choices.map(choice => choice.value));
        const unknown = value.find(item => !allowed.has(item));
        if (unknown !== undefined) return `${label} has no choice "${unknown}"`;
      }
      break;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a number`;
      if (entry.integer === true && !Number.isSafeInteger(value)) return `${label} must be a whole number`;
      if (entry.min !== undefined && value < entry.min) return `${label} must be at least ${entry.min}`;
      if (entry.max !== undefined && value > entry.max) return `${label} must be at most ${entry.max}`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `${label} must be on or off`;
      break;
    case 'text':
      if (typeof value !== 'string') return `${label} must be text`;
      break;
    case 'groups':
      if (!isObjectRecord(value)) return `${label} must be all groups or a list of groups`;
      if (value.mode === 'all') {
        if (Object.keys(value).length !== 1) return `${label} "all" holds no other keys`;
      } else if (value.mode === 'subset') {
        if (Object.keys(value).length !== 2 || !Array.isArray(value.ids) ||
          value.ids.some(id => typeof id !== 'string' || id.length === 0) ||
          new Set(value.ids).size !== value.ids.length) {
          return `${label} must list distinct group ids`;
        }
      } else {
        return `${label} must be all groups or a list of groups`;
      }
      break;
    case 'variable':
      if (value === null) break;
      if (!isObjectRecord(value) || Object.keys(value).length !== 2 ||
        typeof value.type !== 'string' || typeof value.key !== 'string' || value.key.length === 0 ||
        !(entry.types ?? []).includes(value.type)) {
        return `${label} must be a variable of ${(entry.types ?? []).join(' or ')}`;
      }
      if (context !== undefined && typeof context.variableExists === 'function' &&
        !context.variableExists(value.type, value.key)) {
        return `${label}: this dataset has no "${value.key}"`;
      }
      break;
    case 'gene-sets':
      if (!Array.isArray(value)) return `${label} must be a list of gene sets`;
      for (const set of value) {
        if (!isObjectRecord(set) || Object.keys(set).length !== 2 ||
          typeof set.name !== 'string' || set.name.trim().length === 0 ||
          !Array.isArray(set.genes) || set.genes.some(gene => typeof gene !== 'string' || gene.length === 0)) {
          return `${label} must be gene sets of { name, genes }`;
        }
      }
      if (new Set(value.map(set => set.name)).size !== value.length) return `${label} set names must be distinct`;
      break;
    default:
      return `${label} has an unknown kind`;
  }
  if (entry.check !== undefined) {
    const reason = entry.check(value, record, context);
    if (reason !== null && reason !== undefined) return reason;
  }
  return null;
}

/**
 * Declare an analysis's options.
 *
 * @param {object} spec
 * @param {string} spec.id - The analysis id (`genesPanel`, `differential`, …).
 * @param {Array<{id: string, title: string, tip?: string}>} spec.groups -
 *   The "More options" sections, in order.
 * @param {object[]} spec.options - The entries, in form order.
 */
export function defineOptions(spec) {
  if (!isObjectRecord(spec)) throw new TypeError('An options schema spec must be an object');
  const id = requireText(spec.id, 'Options schema id');
  if (!Array.isArray(spec.groups) || !Array.isArray(spec.options)) {
    throw new TypeError(`Options schema "${id}" needs groups and options arrays`);
  }
  const groupIds = new Set();
  const groups = spec.groups.map(group => {
    if (!isObjectRecord(group)) throw new TypeError('An option group must be an object');
    const groupId = requireText(group.id, 'Option group id');
    if (groupId === ESSENTIALS || groupIds.has(groupId)) throw new Error(`Option group "${groupId}" is reserved or duplicated`);
    groupIds.add(groupId);
    requireText(group.title, `Option group "${groupId}" title`);
    if (!isSentenceCase(group.title)) throw new TypeError(`Option group title "${group.title}" must be sentence case`);
    return Object.freeze({ id: groupId, title: group.title, tip: group.tip ?? null });
  });
  const keys = new Set();
  for (const entry of spec.options) validateEntry(entry, groupIds, keys);
  const entries = spec.options.map(entry => Object.freeze({ ...entry }));
  const byKey = new Map(entries.map(entry => [entry.key, entry]));

  const defaultOf = (entry, context) => cloneValue(
    typeof entry.default === 'function' ? entry.default(context) : entry.default
  );

  const schema = {
    id,
    groups: Object.freeze(groups),
    entries: Object.freeze(entries),
    keys: Object.freeze([...keys]),

    entry(key) {
      const entry = byKey.get(key);
      if (entry === undefined) throw new RangeError(`Options "${id}" have no option "${key}"`);
      return entry;
    },

    /** The entries of one group ('essentials' or a declared group id). */
    group(groupId) {
      if (groupId !== ESSENTIALS && !groupIds.has(groupId)) {
        throw new RangeError(`Options "${id}" have no group "${groupId}"`);
      }
      return entries.filter(entry => entry.group === groupId);
    },

    /** A fresh record of every default. */
    defaults(context) {
      const record = {};
      for (const entry of entries) record[entry.key] = defaultOf(entry, context);
      return record;
    },

    defaultOf(key, context) {
      return defaultOf(schema.entry(key), context);
    },

    isVisible(key, record, context) {
      const entry = schema.entry(key);
      return entry.when === undefined || entry.when(record, context) === true;
    },

    /**
     * @returns {{ valid: boolean, errors: string[] }} Every reason the
     *   record is refused: not an object, an unknown or missing key, or a
     *   value its entry refuses.
     */
    validate(record, context) {
      const errors = [];
      if (!isObjectRecord(record)) {
        return { valid: false, errors: [`${id} options must be an object`] };
      }
      for (const key of Object.keys(record)) {
        if (!byKey.has(key)) errors.push(`${id} options have no option "${key}"`);
      }
      // `when` reads other keys: on a record missing some, every value is
      // held only to its kind, and the missing keys are the refusal.
      const complete = entries.every(entry => Object.hasOwn(record, entry.key));
      for (const entry of entries) {
        if (!Object.hasOwn(record, entry.key)) {
          errors.push(`${id} options are missing "${entry.key}"`);
          continue;
        }
        // An option that does not apply (`when`) keeps its value but is held
        // only to its kind: its choices may name what this data lacks.
        const applies = entry.when === undefined || context === undefined ||
          (complete && entry.when(record, context) === true);
        const reason = refuseValue(entry, record[entry.key], record, applies ? context : undefined);
        if (reason !== null) errors.push(reason);
      }
      return { valid: errors.length === 0, errors };
    },

    /** The reason one value is refused, or null. */
    refuse(key, value, record, context) {
      return refuseValue(schema.entry(key), value, record, context);
    },

    /** A validated copy; throws a TypeError naming every refusal. */
    normalize(record, context) {
      const { valid, errors } = schema.validate(record, context);
      if (!valid) throw new TypeError(errors.join('; '));
      const copy = {};
      for (const entry of entries) copy[entry.key] = cloneValue(record[entry.key]);
      return copy;
    },

    /**
     * A record from some keys: the defaults with `partial` over them, as a
     * preset sends ("Score as signature"). Unknown keys are refused.
     */
    withDefaults(partial, context) {
      if (!isObjectRecord(partial)) throw new TypeError(`${id} preset options must be an object`);
      for (const key of Object.keys(partial)) {
        if (!byKey.has(key)) throw new RangeError(`${id} options have no option "${key}"`);
      }
      return schema.normalize({ ...schema.defaults(context), ...structuredClone(partial) }, context);
    },

    /**
     * The keys whose value differs from the default and that apply (their
     * `when` holds), optionally within one group.
     */
    changedKeys(record, context, groupId = null) {
      return entries
        .filter(entry => groupId === null || entry.group === groupId)
        .filter(entry => entry.when === undefined || entry.when(record, context) === true)
        .filter(entry => !sameOptionValue(record[entry.key], defaultOf(entry, context)))
        .map(entry => entry.key);
    },

    /** How the docs table states an entry's default. */
    describeDefault(key) {
      const entry = schema.entry(key);
      if (typeof entry.defaultText === 'string') return entry.defaultText;
      if (typeof entry.default === 'function') {
        throw new TypeError(`Option "${key}" has a data-dependent default and needs defaultText`);
      }
      return describeValue(entry, entry.default);
    },
  };
  return Object.freeze(schema);
}

/** A value as text, as the docs and the "n changed" summary state it. */
export function describeValue(entry, value) {
  switch (entry.kind) {
    case 'select':
    case 'segmented': {
      const choice = Array.isArray(entry.choices) ? entry.choices.find(c => c.value === value) : null;
      return choice ? choice.label : String(value);
    }
    case 'flags': {
      if (value.length === 0) return 'None';
      const labels = Array.isArray(entry.choices)
        ? value.map(item => entry.choices.find(c => c.value === item)?.label ?? item)
        : value;
      return labels.join(', ');
    }
    case 'boolean':
      return value ? 'On' : 'Off';
    case 'groups':
      return value.mode === 'all' ? 'All' : `${value.ids.length} selected`;
    case 'gene-sets':
      return value.length === 0 ? 'None' : value.map(set => set.name).join(', ');
    case 'variable':
      return value === null ? 'None' : value.key;
    case 'text':
      return value.length === 0 ? 'None' : value;
    default:
      return String(value);
  }
}
