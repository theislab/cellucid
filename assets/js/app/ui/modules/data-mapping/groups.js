/**
 * @fileoverview The Data mapping disclosures after Embeddings: one per
 * mapping group the open dataset can change (genes, neighbour graph, latent
 * space, vector fields), each naming its current choice in its header.
 *
 * Markup only, as `dom.js` is: the controller (`../data-mapping-controls.js`)
 * stages the chosen values in its staged mapping, keyed by group name, and
 * applies them in the same transaction as the embeddings.
 *
 * @module ui/modules/data-mapping/groups
 */

import {
  createDisclosure,
  createStatusLine,
} from '../../components/controls.js';
import { setText } from './dom.js';

/** The value a menu uses for a group's null choice ("None"). */
export const NONE_VALUE = '';

/**
 * Every group section the panel can show, in the order it shows them.
 * `fields` are the selects of one section: the group whose value each one
 * stages, its element id, its label, and the analytics id its change is
 * counted under.
 */
export const GROUP_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'genes',
    title: 'Genes',
    tip: 'data-mapping-genes',
    fields: Object.freeze([
      Object.freeze({ group: 'expression', id: 'data-mapping-expression', label: 'Expression', analyticsId: 'data-mapping:expression' }),
      Object.freeze({ group: 'geneNames', id: 'data-mapping-gene-names', label: 'Gene names', analyticsId: 'data-mapping:gene-names' }),
    ]),
  }),
  Object.freeze({
    id: 'knn',
    title: 'Neighbour graph',
    tip: 'data-mapping-knn',
    fields: Object.freeze([
      Object.freeze({ group: 'knn', id: 'data-mapping-knn', label: 'Graph', analyticsId: 'data-mapping:knn' }),
    ]),
  }),
  Object.freeze({
    id: 'latent',
    title: 'Latent space',
    tip: 'data-mapping-latent',
    fields: Object.freeze([
      Object.freeze({ group: 'latent', id: 'data-mapping-latent', label: 'Outliers in', analyticsId: 'data-mapping:latent' }),
    ]),
  }),
]);

/** The vector-field section: one checkbox list per embedding. */
export const VECTOR_SECTION = Object.freeze({
  id: 'vectors',
  group: 'vectorFields',
  title: 'Vector fields',
  tip: 'data-mapping-vectors',
  analyticsId: 'data-mapping:vector-fields',
});

/** Every group a section stages. */
export const SECTION_GROUPS = Object.freeze([
  ...GROUP_SECTIONS.flatMap(section => section.fields.map(field => field.group)),
  VECTOR_SECTION.group,
]);

/** The key a vector binding is staged and compared under. */
export function bindingKey(binding) {
  return JSON.stringify(binding);
}

// What each select's options and each vector list were last drawn from: a
// render that would draw the same thing leaves the DOM alone, so the control
// the user is on keeps its focus and the sidebar keeps its scroll position.
const drawn = new WeakMap();

function element(ownerDocument, tag, className, text) {
  const node = ownerDocument.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Encode a group value as a select value: a group's null is "None".
 *
 * @param {string|null} value
 * @returns {string}
 */
export function encodeChoice(value) {
  return value === null ? NONE_VALUE : value;
}

/**
 * Decode a select value back to the group value it stands for.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function decodeChoice(value) {
  return value === NONE_VALUE ? null : value;
}

/**
 * A collapsed disclosure for one group: its title, the current choice in its
 * header, and its (i) tip.
 */
function buildGroupDisclosure(section) {
  const disclosure = createDisclosure({
    title: section.title,
    description: '—',
    tip: section.tip,
    expanded: false,
  });
  disclosure.root.classList.add('data-mapping-group');
  disclosure.root.dataset.mappingSection = section.id;
  return {
    disclosure,
    description: disclosure.header.querySelector('.disclosure-desc'),
  };
}

/**
 * Build one group disclosure, once: one labelled select per field and their
 * error lines, and the hint line. The disclosure is built once and filled by
 * `renderGroupSection` on every render.
 *
 * @param {Document} ownerDocument
 * @param {(typeof GROUP_SECTIONS)[number]} section
 * @returns {{root: HTMLDivElement, disclosure: Object, description: HTMLElement, fields: Map<string, {block: HTMLDivElement, select: HTMLSelectElement, error: {set: Function}}>, hint: {root: HTMLParagraphElement, set: Function}}}
 */
export function buildGroupSection(ownerDocument, section) {
  const { disclosure, description } = buildGroupDisclosure(section);
  const body = disclosure.content;
  const fields = new Map();
  for (const spec of section.fields) {
    const block = element(ownerDocument, 'div', 'control-block data-mapping-choice');
    block.dataset.mappingGroup = spec.group;
    const select = element(ownerDocument, 'select', 'obs-select');
    select.id = spec.id;
    select.dataset.mappingGroup = spec.group;
    select.dataset.analyticsId = spec.analyticsId;
    const label = element(ownerDocument, 'label', '', spec.label);
    label.htmlFor = select.id;
    const error = createStatusLine({ tone: 'danger' });
    error.root.classList.add('data-mapping-row-error');
    block.append(label, select, error.root);
    body.appendChild(block);
    fields.set(spec.group, { block, select, error });
  }
  const hint = createStatusLine({ tone: 'muted' });
  hint.root.classList.add('data-mapping-hint');
  body.appendChild(hint.root);
  return { root: disclosure.root, disclosure, description, fields, hint };
}

/**
 * Show one built section's current choices. A field with no model is hidden
 * (a prepared export has gene names but no expression choice); a section
 * with no field shown is hidden.
 *
 * @param {ReturnType<typeof buildGroupSection>} node
 * @param {{
 *   summary: string,
 *   fields: Map<string, {
 *     options: Array<{value: string, label: string, disabled?: boolean, title?: string}>,
 *     value: string,
 *     disabled: boolean,
 *     disabledReason: string,
 *     error: string
 *   }>,
 *   hint: string
 * }} model
 */
export function renderGroupSection(node, { summary, fields, hint }) {
  const ownerDocument = node.root.ownerDocument;
  setText(node.description, summary);
  let shown = 0;
  for (const [group, { block, select, error }] of node.fields) {
    const field = fields.get(group);
    block.hidden = field === undefined;
    if (field === undefined) continue;
    shown += 1;
    const options = JSON.stringify(field.options);
    if (drawn.get(select) !== options) {
      drawn.set(select, options);
      select.replaceChildren(...field.options.map(option => {
        const element = ownerDocument.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        element.disabled = option.disabled === true;
        if (option.title !== undefined) element.title = option.title;
        return element;
      }));
    }
    if (select.value !== field.value) select.value = field.value;
    select.disabled = field.disabled;
    if (field.disabled) select.title = field.disabledReason;
    else select.removeAttribute('title');
    error.set(field.error, 'danger');
  }
  node.hint.set(hint, 'muted');
  node.hint.root.hidden = hint === '';
  node.root.hidden = shown === 0;
}

/**
 * Build the vector-field disclosure, once: the list the embeddings fill, its
 * error line and its hint line.
 *
 * @param {Document} ownerDocument
 * @returns {{root: HTMLDivElement, disclosure: Object, description: HTMLElement, list: HTMLDivElement, error: {root: HTMLElement, set: Function}, hint: {root: HTMLElement, set: Function}}}
 */
export function buildVectorSection(ownerDocument) {
  const { disclosure, description } = buildGroupDisclosure(VECTOR_SECTION);
  const list = element(ownerDocument, 'div', 'data-mapping-vector-list');
  list.dataset.mappingGroup = VECTOR_SECTION.group;
  const error = createStatusLine({ tone: 'danger' });
  error.root.classList.add('data-mapping-row-error');
  const hint = createStatusLine({ tone: 'muted' });
  hint.root.classList.add('data-mapping-hint');
  disclosure.content.append(list, error.root, hint.root);
  return { root: disclosure.root, disclosure, description, list, error, hint };
}

/**
 * Show the vector bindings one can choose, per embedding: a checkbox for each
 * `obsm` array (or exported field) that can be drawn on it, checked when the
 * staged mapping binds it. Each checkbox carries its binding as JSON.
 *
 * @param {ReturnType<typeof buildVectorSection>} node
 * @param {{
 *   summary: string,
 *   groups: Array<{embeddingKey: string, label: string, options: Array<{binding: Object, label: string, usable: boolean, reason: string|null, suggested: boolean}>}>|null,
 *   selected: Set<string>,
 *   disabled: boolean,
 *   error: string,
 *   hint: string
 * }} model - `groups` null hides the section; `selected` holds `bindingKey`s.
 */
export function renderVectorSection(node, { summary, groups, selected, disabled, error, hint }) {
  node.root.hidden = groups === null;
  if (groups === null) return;
  setText(node.description, summary);
  node.error.set(error, 'danger');
  node.hint.set(hint, 'muted');
  node.hint.root.hidden = hint === '';
  const choices = JSON.stringify(groups);
  if (drawn.get(node.list) === choices) {
    // The same choices: only what is bound, and whether it can change.
    for (const input of node.list.querySelectorAll('.data-mapping-vector-input')) {
      input.checked = selected.has(input.value);
      input.disabled = disabled || (input.dataset.usable !== 'true' && !input.checked);
    }
    return;
  }
  drawn.set(node.list, choices);
  const ownerDocument = node.root.ownerDocument;
  node.list.replaceChildren(...groups.map(entry => {
    const fieldset = element(ownerDocument, 'fieldset', 'data-mapping-vector-embedding');
    fieldset.dataset.embedding = entry.embeddingKey;
    fieldset.appendChild(element(ownerDocument, 'legend', '', entry.label));
    if (entry.options.length === 0) {
      fieldset.appendChild(element(ownerDocument, 'p', 'data-mapping-vector-empty', 'No vector array fits.'));
    }
    for (const option of entry.options) {
      const key = bindingKey(option.binding);
      const label = element(ownerDocument, 'label', 'data-mapping-vector-option');
      const input = element(ownerDocument, 'input', 'data-mapping-vector-input');
      input.type = 'checkbox';
      input.value = key;
      input.checked = selected.has(key);
      input.disabled = disabled || (!option.usable && !input.checked);
      input.dataset.usable = String(option.usable);
      input.dataset.mappingGroup = VECTOR_SECTION.group;
      input.dataset.analyticsId = VECTOR_SECTION.analyticsId;
      const text = option.usable ? option.label : `${option.label} · ${option.reason}`;
      label.append(input, element(ownerDocument, 'span', '', text));
      if (option.suggested) {
        // The space keeps "suggested" a separate word for screen readers.
        label.append(ownerDocument.createTextNode(' '), element(ownerDocument, 'span', 'data-mapping-tag', 'suggested'));
      }
      if (!option.usable) label.title = option.reason;
      fieldset.appendChild(label);
    }
    return fieldset;
  }));
}
