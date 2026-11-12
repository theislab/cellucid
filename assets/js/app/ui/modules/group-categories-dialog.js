/**
 * @fileoverview Group categories (Color by › Categorical obs, its toolbar's
 * Group button): a new categorical field whose categories are groups of the
 * selected field's (a lineage from cell types), made by the action
 * `field.group` as one step.
 *
 * One row per category: its swatch, its label and a box for the group it
 * joins (the labels typed so far are offered); a category left empty keeps
 * its name, or, with **Others into**, joins that category. **New field**
 * names the field made (by default "<field> (grouped)", numbered when
 * taken). One status line says what Group makes ("2 groups from 6
 * categories; 2 keep their names"); a refusal of the action is said there
 * and the dialog stays open.
 *
 * @module ui/modules/group-categories-dialog
 */

import { wireAppDialog } from '../components/app-dialog.js';
import { setControlAvailability } from '../core/control-availability.js';
import { getActions } from '../../actions/index.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { isQuietFailure, reportActionFailure } from '../../actions/control-dispatch.js';
import { categoryDisplayName, categoryLabel, isUnnamedCategory } from '../../actions/targets/names.js';
import { makeUniqueLabel } from '../../utils/label-utils.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { failureSentence } from '../../../utils/errors.js';

const IDS = Object.freeze({
  dialog: 'group-categories-dialog',
  form: 'group-categories-form',
  source: 'group-categories-source',
  rows: 'group-categories-rows',
  labels: 'group-categories-labels',
  restOn: 'group-categories-rest-on',
  rest: 'group-categories-rest',
  name: 'group-categories-name',
  status: 'group-categories-status',
  apply: 'group-categories-apply',
});

function requireById(ownerDocument, id) {
  const element = ownerDocument.getElementById(id);
  if (element === null) throw new TypeError(`The Group categories dialog requires #${id}.`);
  return element;
}

/**
 * The parameters of `field.group` the rows stand for: each group label typed
 * (trimmed) with the categories given it, in the order first typed; null
 * when no category is given a group.
 *
 * @param {string} fieldKey
 * @param {Array<{category: string, group: string}>} rows
 * @param {{rest: string|null, name: string}} choice
 * @returns {{field: {source: 'obs', key: string}, groups: Array<{label: string, categories: string[]}>, rest: string|null, name: string}|null}
 */
export function groupParamsOf(fieldKey, rows, { rest, name }) {
  const groups = new Map();
  for (const { category, group } of rows) {
    const label = group.trim();
    if (label === '') continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(category);
  }
  if (groups.size === 0) return null;
  return {
    field: { source: 'obs', key: fieldKey },
    groups: [...groups].map(([label, categories]) => ({ label, categories })),
    rest,
    name,
  };
}

/**
 * The status line: what Group makes, or what it needs first.
 *
 * @param {ReturnType<typeof groupParamsOf>} params
 * @param {number} categories - The field's categories
 * @returns {string}
 */
export function groupStatusOf(params, categories) {
  if (params === null) return 'Type a group for the categories it holds.';
  const grouped = params.groups.reduce((sum, group) => sum + group.categories.length, 0);
  const others = categories - grouped;
  const groups = formatCountOf(params.groups.length, 'group');
  const of = `${groups} from ${formatCountOf(grouped, 'category', 'categories')}`;
  if (others === 0) return `${of}.`;
  return params.rest === null
    ? `${of}; ${formatCountOf(others, 'other keeps its name', 'others keep their names')}.`
    : `${of}; ${formatCountOf(others, 'other', 'others')} into ${params.rest}.`;
}

/**
 * @param {{ownerDocument?: Document, state: object, actions?: ReturnType<typeof getActions>}} options
 * @returns {{open: (fieldIndex: number, opener?: HTMLElement|null) => void, destroy: () => void}}
 */
export function initGroupCategoriesDialog({ ownerDocument = document, state, actions = getActions() }) {
  const dom = Object.fromEntries(Object.entries(IDS).map(([key, id]) => [key, requireById(ownerDocument, id)]));
  const owner = wireAppDialog(dom.dialog);
  const controller = new AbortController();
  const { signal } = controller;
  /** The field the dialog groups: its key and categories as the legend shows them. */
  let shown = null;
  let busy = false;

  function rowsNow() {
    return [...dom.rows.querySelectorAll('input[data-category]')].map(input => ({ category: input.dataset.category, group: input.value }));
  }

  function choiceNow() {
    const rest = dom.restOn.checked ? dom.rest.value.trim() : null;
    return { rest: rest === '' ? null : rest, name: dom.name.value.trim() };
  }

  function paramsNow() {
    return shown === null ? null : groupParamsOf(shown.key, rowsNow(), choiceNow());
  }

  function render() {
    const params = paramsNow();
    setControlAvailability(dom.rest, dom.restOn.checked ? null : 'tick Others into to name the category the others join');
    dom.status.textContent = shown === null ? '' : groupStatusOf(params, shown.categories.length);
    dom.apply.disabled = busy || params === null || choiceNow().name === '';
    // The group labels typed so far, offered in every row.
    const labels = [...new Set(rowsNow().map(row => row.group.trim()).filter(label => label !== ''))];
    dom.labels.replaceChildren(...labels.map(label => {
      const option = ownerDocument.createElement('option');
      option.value = label;
      return option;
    }));
  }

  function swatchOf(field, index) {
    const swatch = ownerDocument.createElement('span');
    swatch.className = 'group-categories-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const rgb = state.getColorForCategory(field, index);
    swatch.style.backgroundColor = `rgb(${rgb.map(channel => Math.round(channel * 255)).join(', ')})`;
    return swatch;
  }

  /** Open the dialog for the categorical obs field at `fieldIndex`. */
  function open(fieldIndex, opener = null) {
    const field = state.getFields()[fieldIndex];
    if (field?.kind !== 'category' || !Array.isArray(field.categories)) return;
    const categories = field.categories.map(categoryLabel);
    shown = { key: field.key, categories };
    dom.source.textContent = `${field.key}: type the group each category joins; one left empty keeps its name.`;
    dom.rows.replaceChildren(...categories.map((category, index) => {
      const row = ownerDocument.createElement('div');
      row.className = 'group-categories-row';
      const name = ownerDocument.createElement('span');
      name.className = 'group-categories-category';
      // Shown by its display name; the group plan keys it by `category` itself.
      const shownName = categoryDisplayName(field.categories[index]);
      name.textContent = shownName;
      name.title = shownName;
      name.classList.toggle('is-unnamed', isUnnamedCategory(field.categories[index]));
      const input = ownerDocument.createElement('input');
      input.type = 'text';
      input.className = 'obs-select';
      input.dataset.category = category;
      input.setAttribute('list', IDS.labels);
      input.placeholder = 'keeps its name';
      input.setAttribute('aria-label', `The group ${shownName} joins`);
      row.append(swatchOf(field, index), name, input);
      return row;
    }));
    dom.restOn.checked = false;
    dom.rest.value = 'Other';
    const taken = state.getFields().filter(each => each && each._isDeleted !== true).map(each => each.key);
    dom.name.value = makeUniqueLabel(`${field.key} (grouped)`, taken);
    busy = false;
    render();
    owner.open(opener);
  }

  async function apply() {
    const params = paramsNow();
    if (params === null || busy) return;
    busy = true;
    render();
    try {
      await actions.dispatch('field.group', params);
      owner.close();
    } catch (error) {
      if (error instanceof ActionRefused && !isQuietFailure(error)) dom.status.textContent = failureSentence(error);
      else reportActionFailure(error, { failure: 'The categories could not be grouped', category: 'filter' });
      busy = false;
      dom.apply.disabled = false;
      return;
    }
    busy = false;
  }

  dom.form.addEventListener('input', render, { signal });
  dom.form.addEventListener('change', render, { signal });
  dom.form.addEventListener('submit', event => {
    event.preventDefault();
    void apply();
  }, { signal });
  dom.dialog.addEventListener('close', () => {
    shown = null;
    dom.rows.replaceChildren();
  }, { signal });

  return {
    open,
    destroy() {
      controller.abort();
      owner.destroy();
    },
  };
}
