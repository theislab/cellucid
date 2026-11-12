/**
 * @fileoverview A field, a gene, a category, a deleted field by its name: the
 * names a step's parameters give (`app/actions/definitions/params.js`)
 * resolved to the open dataset's current objects, for every action and read
 * that names them. A name that does not resolve is refused with one sentence
 * that says what there is instead (`ActionRefused`), so a person, an agent and
 * a replay on another dataset can act on it.
 *
 * @module app/actions/targets/fields
 */

import { ActionRefused } from '../dispatcher.js';
import { describeUnavailableGene, resolveExactGene } from '../../utils/gene-lookup.js';
import { getFieldRegistry } from '../../utils/field-registry.js';
import { StateValidator } from '../../utils/state-validator.js';
import { categoryDisplayName, categoryLabel, listNames, quoteName } from './names.js';

const KIND_WORDS = Object.freeze({ category: 'categorical', continuous: 'continuous' });

/** A field kind in words: "categorical" or "continuous". */
export function kindWord(kind) {
  return KIND_WORDS[kind] ?? String(kind);
}

function inventoryOf(state, source) {
  const fields = source === 'var' ? state.getVarFields() : state.getFields();
  return Array.isArray(fields) ? fields : [];
}

/** The fields of a source that are shown (not deleted), with their positions. */
function shownFields(state, source) {
  const out = [];
  inventoryOf(state, source).forEach((field, index) => {
    if (field && field._isDeleted !== true) out.push({ field, index });
  });
  return out;
}

/** Why `key` names no field of the cells: the fields like it, else the fields there are. */
function describeMissingField(key, shown) {
  const wanted = key.toLowerCase();
  const near = shown.filter(({ field }) => field.key.toLowerCase().includes(wanted)).map(({ field }) => field.key);
  return near.length > 0
    ? `There is no field ${quoteName(key)}; fields like it: ${listNames(near)}.`
    : `There is no field ${quoteName(key)}; the fields are ${listNames(shown.map(({ field }) => field.key))}.`;
}

/** Why `name` names no gene: the gene list's own words, and a name that differs only in case. */
function describeMissingGene(state, name, shown, outcome) {
  const failure = state.getGeneListFailure?.() ?? null;
  let message = describeUnavailableGene(name, outcome, failure, quoteName);
  if (outcome.kind === 'absent') {
    const wanted = name.toLowerCase();
    const near = shown.filter(({ field }) => field.key.toLowerCase() === wanted).map(({ field }) => field.key);
    message += near.length > 0 ? ` Names are exact: did you mean ${listNames(near)}?` : ' genes.search finds a gene by part of its name.';
  }
  return message;
}

/**
 * The field `ref` names among the fields shown (not deleted): a column of
 * the cells by its key as shown, a gene by its name exactly as the gene list
 * shows it.
 *
 * @param {object} state - DataState
 * @param {{source: 'obs'|'var', key: string}} ref
 * @param {{kind?: 'category'|'continuous'|null}} [options]
 * @returns {{field: object, index: number, source: 'obs'|'var'}}
 */
export function resolveField(state, ref, { kind = null } = {}) {
  const shown = shownFields(state, ref.source);
  const matches = shown.filter(({ field }) => field.key === ref.key);
  if (matches.length === 0) {
    if (ref.source === 'var') {
      const outcome = resolveExactGene(ref.key, {
        keys: shown.map(({ field }) => field.key),
        pending: state.areGenesPending?.() === true,
        failure: state.getGeneListFailure?.() ?? null,
      });
      throw new ActionRefused(describeMissingGene(state, ref.key, shown, outcome), {
        code: 'no-such-gene', missing: { kind: 'gene', name: ref.key, field: null },
      });
    }
    throw new ActionRefused(describeMissingField(ref.key, shown), {
      code: 'no-such-field', missing: { kind: 'field', name: ref.key, field: null },
    });
  }
  if (matches.length > 1) {
    throw new ActionRefused(`Two fields are named ${quoteName(ref.key)}; rename one first.`, { code: 'ambiguous-field' });
  }
  const [{ field, index }] = matches;
  if (kind !== null && field.kind !== kind) {
    throw new ActionRefused(`${quoteName(ref.key)} is a ${kindWord(field.kind)} field, not a ${kindWord(kind)} one.`, { code: 'wrong-kind' });
  }
  return { field, index, source: ref.source };
}

/**
 * The field `ref` names, read for the open cells first (its codes or
 * values): what a filter, a category edit or a read of values works on.
 */
export async function resolveLoadedField(state, ref, { kind = null, signal = null } = {}) {
  const target = resolveField(state, ref, { kind });
  if (target.source === 'var') {
    await state.ensureVarFieldLoaded(target.index, { signal, priority: 'high' });
  } else {
    await state.ensureFieldLoaded(target.index, { signal });
  }
  // The inventory may have been replaced while it was read.
  return resolveField(state, ref, { kind });
}

/**
 * The position of category `label` in `field`.
 * @param {object} field - A categorical field
 * @param {string} label
 * @returns {number}
 */
export function resolveCategory(field, label) {
  const categories = Array.isArray(field.categories) ? field.categories : [];
  // A category is named by what it is shown as too (`(empty)`, `(blank)`, `" x "`:
  // `categoryDisplayName`), unless a category is named so.
  const named = categories.some(category => categoryLabel(category) === label);
  let found = -1;
  for (let index = 0; index < categories.length; index++) {
    const matches = categoryLabel(categories[index]) === label
      || (!named && categoryDisplayName(categories[index]) === label);
    if (!matches) continue;
    if (found >= 0) {
      throw new ActionRefused(`${quoteName(field.key)} lists the category ${quoteName(label)} twice; rename one first.`, { code: 'ambiguous-category' });
    }
    found = index;
  }
  if (found < 0) {
    const open = field.discovered === true ? ' its open cells hold' : '';
    throw new ActionRefused(
      `There is no category ${quoteName(label)} in ${quoteName(field.key)}; the categories${open} are ${listNames(categories.map(categoryDisplayName))}.`,
      { code: 'no-such-category', missing: { kind: 'category', name: label, field: field.key } },
    );
  }
  return found;
}

/**
 * The field the view in focus is colored by, which `ref` must name: a
 * color setting of a continuous field, a range or outlier filter.
 */
export function resolveShownField(state, ref, { kind }) {
  const target = resolveField(state, ref, { kind });
  const shown = state.getActiveField();
  if (shown !== target.field) {
    const now = shown === null ? 'nothing' : `${state.activeFieldSource === 'var' ? 'gene ' : ''}${quoteName(shown.key)}`;
    throw new ActionRefused(
      `The view in focus is colored by ${now}, not by ${quoteName(ref.key)}; color it by ${quoteName(ref.key)} first.`,
      { code: 'not-shown' },
    );
  }
  return target;
}

/**
 * A deleted field by the name it had: its inventory position (-1 for a
 * user-defined field kept only in its registry) and its user-defined id.
 *
 * @returns {{field: object, index: number, source: 'obs'|'var', userDefinedId: string|null}}
 */
export function resolveDeletedField(state, ref, which = undefined) {
  const deleted = getFieldRegistry().getDeletedFields(ref.source);
  const matches = deleted.filter(entry => entry.field.key === ref.key);
  if (matches.length === 0) {
    throw new ActionRefused(
      `There is no deleted field ${quoteName(ref.key)}; the deleted ${ref.source === 'var' ? 'genes' : 'fields'} are ${listNames(deleted.map(entry => entry.field.key))}.`,
      { code: 'no-such-deleted-field' },
    );
  }
  // Several of one name (one deleted, another renamed to its name and
  // deleted too): `which` names one by its place among them, as Deleted
  // fields lists them.
  if (which === undefined && matches.length > 1) {
    const places = matches.map((_, place) => place + 1);
    throw new ActionRefused(
      `${matches.length} deleted fields are named ${quoteName(ref.key)}; say which with \`which\`: ${places.slice(0, -1).join(', ')} or ${places.at(-1)}, in the order Deleted fields lists them.`,
      { code: 'ambiguous-field' },
    );
  }
  if (which !== undefined && which > matches.length) {
    throw new ActionRefused(
      `There ${matches.length === 1 ? 'is one deleted field' : `are ${matches.length} deleted fields`} named ${quoteName(ref.key)}; \`which\` ${which} names none.`,
      { code: 'no-such-deleted-field' },
    );
  }
  const { field, index } = matches[(which ?? 1) - 1];
  return { field, index, source: ref.source, userDefinedId: index < 0 ? field._userDefinedId : null };
}

/**
 * Refuse `label` as a category label given now (a rename, a merge, a group,
 * a page's label): the one rule, `StateValidator.validateNewCategoryLabel`.
 */
export function requireNewCategoryLabel(label) {
  try {
    StateValidator.validateNewCategoryLabel(label);
  } catch (error) {
    throw new ActionRefused(`${quoteName(label)} cannot be a category label: ${error.message}.`, { code: 'bad-name' });
  }
}

/**
 * Refuse `name` as a new field name of `source`: not a valid name, or one a
 * field shown has (other than the field at `exceptIndex`).
 */
export function requireNewName(state, source, name, exceptIndex = -1) {
  try {
    StateValidator.validateFieldKey(name);
  } catch (error) {
    throw new ActionRefused(`${quoteName(name)} cannot be a field name: ${error.message}.`, { code: 'bad-name' });
  }
  const fields = source === 'var' ? state.getVarFields() : state.getFields();
  if (StateValidator.isDuplicateKey(name, fields, exceptIndex)) {
    throw new ActionRefused(`A field named ${quoteName(name)} exists already; choose another name.`, { code: 'name-taken' });
  }
}
