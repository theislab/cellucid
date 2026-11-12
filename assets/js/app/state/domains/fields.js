/**
 * @fileoverview How a state domain value names a field, and finds it again.
 *
 * A field is `{source, key}` with the key the dataset gave it (its original
 * key, `_originalKey`, whatever it is shown as after a rename), or, for a
 * field the person or a notebook made, `{source, user}` with its id
 * (`_userDefinedId`, kept by the `field-overlays` domain). So renaming a field
 * changes the `field-overlays` value only: the filters, colors and active
 * field that name it are unchanged, and a rename undone or redone leaves them
 * alone. Never a position: a field's index moves when the inventory does.
 *
 * @module app/state/domains/fields
 */

import { abortReason, awaitWithSignal, onAbort, throwIfAborted } from '../../../utils/abort.js';
import { categoryDisplayName, listNames, namedError, quoteName } from '../../actions/targets/names.js';
import { upperFirst } from '../../../utils/text-case.js';

/**
 * @param {object} field
 * @param {'obs'|'var'} source
 * @returns {{source: 'obs'|'var', key: string}|{source: 'obs'|'var', user: string}}
 */
export function fieldRef(field, source) {
  if (field._isUserDefined === true) return { source, user: field._userDefinedId };
  return { source, key: field._originalKey || field.key };
}

/** A string that names one field reference (a Map key, a sort key). */
export function refId(ref) {
  return ref.user === undefined ? `${ref.source}\u0000k\u0000${ref.key}` : `${ref.source}\u0000u\u0000${ref.user}`;
}

/** Compare two references for a canonical order: source, then dataset before user, then name. */
export function compareRefs(a, b) {
  const x = refId(a);
  const y = refId(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Every field of one inventory by reference.
 *
 * @param {object|null} data - `obsData` or `varData`
 * @param {'obs'|'var'} source
 * @returns {Map<string, {field: object, index: number}>}
 */
export function fieldsByRef(data, source) {
  const out = new Map();
  const fields = data?.fields ?? [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === null || typeof field !== 'object') continue;
    out.set(refId(fieldRef(field, source)), { field, index });
  }
  return out;
}

/**
 * The field a reference names in one view, with its index, or null.
 *
 * @param {object} owner - The state, or a view context
 * @param {object} ref
 * @param {{obs?: Map, var?: Map}} [cache] - Lookups made once per restore
 */
export function findField(owner, ref, cache = {}) {
  const map = cache[ref.source] ??= fieldsByRef(ref.source === 'var' ? owner.varData : owner.obsData, ref.source);
  return map.get(refId(ref)) ?? null;
}

/**
 * The name a person sees for a field reference, from the open dataset when
 * it has the field (a renamed field reads as it is shown), else from the
 * reference itself.
 *
 * @param {object|null} state
 * @param {object|null} ref
 */
export function fieldName(state, ref) {
  if (ref === null) return 'nothing';
  const found = state === null ? null : findField(state, ref);
  if (found !== null) return found.field.key;
  return ref.key ?? ref.user;
}

/** Whether a field holds what it needs read: its values, or its codes and categories. */
function isReadField(field) {
  return field.loaded === true && (field.kind !== 'category' || Array.isArray(field.categories));
}

/**
 * Load a field of the focused view (its values or codes and categories), the
 * way the app does before it uses one. `signal` (a session load the person
 * can cancel) stops the read.
 *
 * @param {object} state
 * @param {object} ref
 * @param {{field: object, index: number}} found
 * @param {AbortSignal|null} [signal]
 */
export async function loadField(state, ref, found, signal = null) {
  throwIfAborted(signal);
  const { field, index } = found;
  if (isReadField(field)) return;
  if (ref.source === 'var') await state.ensureVarFieldLoaded(index, { silent: true, signal });
  else await state.ensureFieldLoaded(index, { silent: true, signal });
}

/**
 * Load several fields of the focused view at once (`loadField`). The first
 * read that fails stops the others, and resolves only once every one has
 * settled, so nothing goes on reading after the restore has failed. Resolves
 * with every one read: a field the memory model released while another was
 * still being read (the page hidden meanwhile: `field/residency.js`) is read
 * again, and the caller uses them in the same turn.
 *
 * @param {object} state
 * @param {object[]} refs
 * @param {Array<{field: object, index: number}>} found - each ref's field
 * @param {AbortSignal|null} [signal]
 */
export async function loadFields(state, refs, found, signal = null) {
  const together = new AbortController();
  const stop = onAbort(signal, () => together.abort(abortReason(signal)));
  try {
    do {
      const reads = refs.map((ref, i) => loadField(state, ref, found[i], together.signal).catch(error => {
        together.abort(error);
        throw error;
      }));
      const settled = await Promise.allSettled(reads);
      const failed = settled.find(outcome => outcome.status === 'rejected');
      if (failed !== undefined) throw signal?.aborted ? abortReason(signal) : failed.reason;
    } while (found.some(({ field }) => !isReadField(field)));
  } finally {
    stop();
  }
}

/** Wait for the gene list, as a field of genes needs it, or until `signal` stops the restore. */
export function whenGenesListed(state, signal = null) {
  return awaitWithSignal(state.whenGenesListed(), signal);
}

/**
 * Resolve a reference in the focused view, or say plainly why it cannot be.
 *
 * @param {object} state
 * @param {object} ref
 * @param {object} cache
 * @param {string} what - What needed it ("a filter", "the colors")
 */
export function requireField(state, ref, cache, what) {
  const found = findField(state, ref, cache);
  if (found === null) {
    const name = ref.key ?? ref.user;
    throw namedError(RangeError, `${upperFirst(what)} names the ${ref.source} field ${quoteName(name)}, which this dataset does not have now.`);
  }
  return found;
}

/**
 * Where each category label of a categorical field is (label → position),
 * read once for a restore that checks and applies labels.
 *
 * @param {object} field - a categorical field, loaded
 * @returns {Map<string|boolean, number>}
 */
export function categoryPlaces(field) {
  const places = new Map();
  const categories = field.categories;
  const count = categories.length;
  for (let index = 0; index < count; index++) places.set(categories[index], index);
  return places;
}

/**
 * Refuse a value that names a category its field does not have. A field
 * whose categories are what its open cells hold (`discovered`: a text or
 * boolean column on a subsample) may lack a label the value was captured
 * with, which is then held until cells holding it open
 * (`pending-categories.js`); any other field's dictionary is the dataset's,
 * so a label it lacks belongs to another dataset (a category renamed in a
 * re-export) and is refused by name, before anything is changed.
 *
 * @param {object} field - a categorical field, loaded
 * @param {Map<string|boolean, number>} places - `categoryPlaces(field)`
 * @param {Iterable<string|boolean>} labels
 * @param {string} what - What names them ("A filter", "A color")
 */
export function requireCategoriesOf(field, places, labels, what) {
  if (field.discovered === true) return;
  for (const label of labels) {
    if (places.has(label)) continue;
    throw namedError(RangeError,
      `${what} names the category ${quoteName(categoryDisplayName(label))}, which ${quoteName(field.key)} no longer has; `
      + `its categories are ${listNames([...places.keys()].map(categoryDisplayName))}.`,
    );
  }
}
