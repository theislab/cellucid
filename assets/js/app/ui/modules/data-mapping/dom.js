/**
 * @fileoverview DOM of the Session panel's "Data mapping" group, built from
 * the sidebar control kit (`ui/components/controls.js`).
 *
 * Everything here is markup: the controller (`../data-mapping-controls.js`)
 * owns the state and wires the listeners. The group's heading and (i) are
 * static markup in `index.html`; this module fills `#data-mapping-root`, which
 * is outside the session UI inventory (`data-state-serializer-skip`): the
 * mapping itself is saved in the session's dataset fingerprint.
 *
 * The group is a list of disclosures -- "Embeddings" (the checklist of
 * representations) first, then one disclosure per further mapping group --
 * and one status line with Revert and Apply for all of them.
 *
 * @module ui/modules/data-mapping/dom
 */

import {
  createButton,
  createDisclosure,
  createEmptyState,
  createIconButton,
  createStatusLine,
  ICONS,
} from '../../components/controls.js';

const AXES = Object.freeze(['x', 'y', 'z']);

function element(ownerDocument, tag, className, text) {
  const node = ownerDocument.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build the empty group: the Embeddings disclosure with its checklist, the
 * read-only facts, the status line and the Revert/Apply row.
 *
 * @param {Document} ownerDocument
 * @param {{expanded: boolean, onToggle: (expanded: boolean) => void, groupSections: HTMLElement[]}} options
 *   `groupSections` are the disclosures of the further mapping groups
 *   (`groups.js`), listed between Embeddings and "Read from file".
 * @returns {Object} The parts the controller fills.
 */
export function buildDataMappingPanel(ownerDocument, { expanded, onToggle, groupSections }) {
  const root = element(ownerDocument, 'div', 'data-mapping');
  const emptyState = createEmptyState('Load a dataset to choose its data mapping.');

  const body = element(ownerDocument, 'div', 'data-mapping-body');
  const list = element(ownerDocument, 'div', 'disclosure-list');
  const disclosure = createDisclosure({
    title: 'Embeddings',
    description: '—',
    tip: 'data-mapping-embeddings',
    expanded,
    onToggle,
  });
  disclosure.root.id = 'data-mapping-disclosure';
  const description = disclosure.header.querySelector('.disclosure-desc');
  const rows = element(ownerDocument, 'div', 'list-box data-mapping-list');
  rows.id = 'data-mapping-embeddings';
  rows.setAttribute('role', 'group');
  rows.setAttribute('aria-label', 'Embeddings this dataset can show');
  // Arrays that are off and wider than a 3D layout (a PCA, a wide latent
  // space), or that cannot be drawn, are listed last, collapsed: a wide one
  // can be shown at any 1 to 3 of its columns, but is rarely what a view is
  // for.
  const more = createDisclosure({
    title: 'Other arrays',
    expanded: false,
    className: 'disclosure-inline data-mapping-more',
  });
  more.root.id = 'data-mapping-more';
  const moreTitle = more.header.querySelector('.disclosure-title');
  disclosure.content.appendChild(rows);

  list.append(disclosure.root, ...groupSections);

  const status = createStatusLine();
  status.root.classList.add('data-mapping-status');
  const revert = createButton({ label: 'Revert', className: 'btn-compact' });
  revert.id = 'data-mapping-revert';
  const apply = createButton({ label: 'Apply', variant: 'primary', className: 'btn-compact' });
  apply.id = 'data-mapping-apply';
  const actions = element(ownerDocument, 'div', 'data-mapping-actions');
  actions.append(revert, apply);

  body.append(list, status.root, actions);
  root.append(emptyState, body);

  return {
    root,
    disclosure,
    description,
    emptyState,
    body,
    rows,
    more: { root: more.root, content: more.content, title: moreTitle, setExpanded: more.setExpanded },
    status,
    revert,
    apply,
  };
}

function createOption(ownerDocument, { value, label, disabled = false, title }) {
  const option = ownerDocument.createElement('option');
  option.value = value;
  option.textContent = label;
  option.disabled = disabled;
  if (title !== undefined) option.title = title;
  return option;
}

/**
 * Write a node's text only when it changes: writing the same text still
 * replaces the node's text child, which a browser may take as a change of
 * the content the sidebar's scroll position is anchored on.
 *
 * @param {Node} node
 * @param {string} text
 */
export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setTitle(node, title) {
  if (title === null || title === '') node.removeAttribute('title');
  else node.title = title;
}

function fillColumnOptions(ownerDocument, select, width) {
  if (select.options?.length === width) return;
  const options = [];
  for (let column = 0; column < width; column++) {
    options.push(createOption(ownerDocument, {
      value: String(column),
      label: String(column + 1),
      title: `Column ${column} (0-based)`,
    }));
  }
  select.replaceChildren(...options);
}

/**
 * One row of the checklist, built once per staged representation and updated
 * in place on every render, so a change elsewhere in the panel never replaces
 * the rows around it (a replaced row lost the sidebar's scroll anchor in
 * WebKit, which then scrolled the sidebar by about a screen, and dropped the
 * focus of the control the user was on).
 *
 * The first line is the enable checkbox named by the representation, its
 * dimension and, for an added selection, its remove button. A second line
 * appears only while it has something to say: the reason an array is
 * unusable, or -- for a representation that is on -- its "Default" toggle and
 * "guessed" mark. A representation whose columns can be chosen (any AnnData
 * array of two or more columns) shows its dimension as a button that opens
 * and closes its editor: the dimension, one column per axis, and "Add
 * columns" for an array wider than three columns.
 *
 * @param {Document} ownerDocument
 * @param {{usable: boolean, configurable: boolean}} shape - What the row can
 *   ever show; a row whose shape changes is rebuilt.
 * @returns {{root: HTMLDivElement, update: (row: Object) => void}} `update`
 *   takes the row model:
 *   {
 *     index: number, name: string, title: string, dimension: number|null,
 *     enabled: boolean, isDefault: boolean, usable: boolean,
 *     reason: string|null, busy: boolean, lockedReason: string|null,
 *     columns: {width: number, selected: number[]}|null, removable: boolean,
 *     guessed: boolean, open: boolean, widthNote: string|null,
 *     add: {key: string, name: string}|null
 *   }
 */
export function createRepresentationRow(ownerDocument, { usable, configurable }) {
  const root = element(ownerDocument, 'div', 'list-item data-mapping-row');
  const main = element(ownerDocument, 'div', 'data-mapping-row-main');
  const checkbox = element(ownerDocument, 'input');
  checkbox.type = 'checkbox';
  checkbox.className = 'data-mapping-enable';
  checkbox.dataset.analyticsId = 'data-mapping:embedding';
  const label = element(ownerDocument, 'label', 'list-item-text data-mapping-name');
  main.append(checkbox, label);

  const meta = element(ownerDocument, 'div', 'data-mapping-row-meta');
  let dimension = null;
  let reason = null;
  let isDefault = null;
  let guessed = null;
  let widthNote = null;
  let remove = null;
  let editor = null;
  if (!usable) {
    reason = element(ownerDocument, 'span', 'data-mapping-reason');
    meta.appendChild(reason);
  } else {
    if (configurable) {
      // The dimension opens the editor: one button, so the row keeps one line.
      dimension = element(ownerDocument, 'button', 'data-mapping-dim data-mapping-edit');
      dimension.type = 'button';
      dimension.dataset.analyticsId = 'data-mapping:embedding-edit';
    } else {
      dimension = element(ownerDocument, 'span', 'data-mapping-dim');
    }
    main.appendChild(dimension);
    remove = createIconButton({
      label: 'Remove this column selection',
      icon: ICONS.close,
      tone: 'danger',
      className: 'list-item-remove data-mapping-remove',
    });
    main.appendChild(remove);

    isDefault = element(ownerDocument, 'button', 'data-mapping-default', 'Default');
    isDefault.type = 'button';
    isDefault.dataset.analyticsId = 'data-mapping:default';
    guessed = element(ownerDocument, 'span', 'data-mapping-tag', 'guessed');
    // How wide a wide array is, under its name: it is not an embedding at a
    // glance. The name keeps the whole first line.
    widthNote = element(ownerDocument, 'span', 'data-mapping-width');
    meta.append(isDefault, guessed, widthNote);
  }
  root.append(main, meta);

  let axesSelect = null;
  let axesLabel = null;
  let axisFields = [];
  let add = null;
  if (usable && configurable) {
    editor = element(ownerDocument, 'div', 'data-mapping-editor');
    editor.setAttribute('role', 'group');
    const grid = element(ownerDocument, 'div', 'data-mapping-editor-grid');
    axesSelect = element(ownerDocument, 'select', 'obs-select data-mapping-axes');
    axesSelect.dataset.analyticsId = 'data-mapping:embedding-columns';
    axesLabel = element(ownerDocument, 'label', 'data-mapping-field-label', 'Dimension');
    const axesField = element(ownerDocument, 'div', 'data-mapping-field data-mapping-dimension-field');
    axesField.append(axesLabel, axesSelect);
    add = createButton({ label: 'Add columns', className: 'btn-compact data-mapping-add' });
    add.dataset.analyticsId = 'data-mapping:add-columns';
    grid.append(axesField, add);
    axisFields = AXES.map((axis, position) => {
      const select = element(ownerDocument, 'select', 'obs-select data-mapping-axis-select');
      select.dataset.axis = String(position);
      select.dataset.analyticsId = 'data-mapping:embedding-columns';
      const axisLabel = element(ownerDocument, 'label', 'data-mapping-field-label data-mapping-axis', axis);
      const field = element(ownerDocument, 'div', 'data-mapping-field data-mapping-axis-field');
      field.dataset.axis = String(position);
      field.append(axisLabel, select);
      grid.appendChild(field);
      return { field, label: axisLabel, select };
    });
    editor.appendChild(grid);
    root.appendChild(editor);
  }

  function update(row) {
    const prefix = `data-mapping-row-${row.index}`;
    root.dataset.row = String(row.index);
    if (row.enabled) delete root.dataset.disabled;
    else root.dataset.disabled = 'true';
    checkbox.id = prefix;
    checkbox.checked = row.enabled;
    const disabledReason = !row.usable
      ? row.reason
      : (row.busy ? 'Applying the data mapping…' : row.lockedReason);
    checkbox.disabled = disabledReason !== null;
    checkbox.title = disabledReason
      ?? (row.enabled ? `Stop offering ${row.name} to views` : `Offer ${row.name} to views`);
    label.htmlFor = checkbox.id;
    setText(label, row.name);
    label.title = row.title;

    if (!row.usable) {
      setText(reason, row.reason);
      reason.title = row.reason;
      meta.hidden = false;
      return;
    }
    setText(dimension, `${row.dimension}D`);
    if (editor !== null) {
      editor.id = `${prefix}-editor`;
      editor.setAttribute('aria-label', `Columns of ${row.name}`);
      editor.hidden = !row.open;
      dimension.id = `${prefix}-edit`;
      dimension.setAttribute('aria-controls', editor.id);
      dimension.setAttribute('aria-expanded', String(row.open));
      dimension.setAttribute('aria-label', `${row.dimension}D: dimension and columns of ${row.name}`);
      dimension.title = row.open
        ? `Close the dimension and columns of ${row.name}`
        : `Choose the dimension and columns of ${row.name}`;
    } else {
      dimension.title = `${row.dimension}D`;
    }
    remove.hidden = !row.removable;
    remove.disabled = row.busy;
    remove.setAttribute('aria-label', `Remove this column selection of ${row.name}`);
    remove.title = `Remove this column selection of ${row.name}`;

    // "Default" belongs to a representation that is on; one that is off
    // keeps a single line.
    isDefault.hidden = !row.enabled;
    isDefault.id = `${prefix}-default`;
    isDefault.setAttribute('aria-pressed', row.isDefault ? 'true' : 'false');
    // The pressed default stays focusable (aria-disabled, not disabled), so
    // pressing it does not drop the keyboard focus to the page.
    isDefault.disabled = row.busy || !row.enabled;
    if (row.isDefault && !isDefault.disabled) isDefault.setAttribute('aria-disabled', 'true');
    else isDefault.removeAttribute('aria-disabled');
    isDefault.title = row.busy
      ? 'Applying the data mapping…'
      : row.isDefault
        ? `New ${row.dimension}D views show ${row.name}.`
        : `Show ${row.name} when a view switches to ${row.dimension}D.`;
    guessed.hidden = !row.guessed;
    widthNote.hidden = row.widthNote === null;
    setText(widthNote, row.widthNote ?? '');
    meta.hidden = isDefault.hidden && guessed.hidden && widthNote.hidden;

    if (editor === null) return;
    const width = row.columns.width;
    axesSelect.id = `${prefix}-axes`;
    if (axesSelect.options?.length !== Math.min(width, AXES.length)) {
      const options = [];
      for (let axes = 1; axes <= Math.min(width, AXES.length); axes++) {
        options.push(createOption(ownerDocument, { value: String(axes), label: `${axes}D` }));
      }
      axesSelect.replaceChildren(...options);
    }
    axesSelect.value = String(row.dimension);
    axesSelect.disabled = row.busy;
    setTitle(axesSelect, row.busy ? 'Applying the data mapping…' : null);
    axesLabel.htmlFor = axesSelect.id;
    axisFields.forEach(({ field, label: axisLabel, select }, position) => {
      field.hidden = position >= row.dimension;
      select.id = `${prefix}-${AXES[position]}`;
      axisLabel.htmlFor = select.id;
      fillColumnOptions(ownerDocument, select, width);
      if (position < row.dimension) select.value = String(row.columns.selected[position]);
      select.disabled = row.busy;
      setTitle(select, row.busy ? 'Applying the data mapping…' : null);
    });
    add.hidden = row.add === null;
    if (row.add !== null) {
      add.dataset.key = row.add.key;
      add.disabled = row.busy;
      add.title = row.busy
        ? 'Applying the data mapping…'
        : `Add another selection of ${row.add.name}'s columns, for example components 3 and 4.`;
      add.setAttribute('aria-label', `Add columns of ${row.add.name}`);
    }
  }

  return { root, update };
}

/**
 * Make `parent`'s children exactly `nodes`, in order, moving only the nodes
 * that are out of place: a node already in place is not touched, so neither
 * its focus nor the scroll position anchored on it is disturbed.
 *
 * @param {HTMLElement} parent
 * @param {HTMLElement[]} nodes
 */
export function syncChildren(parent, nodes) {
  nodes.forEach((node, index) => {
    const current = parent.children[index] ?? null;
    if (current !== node) parent.insertBefore(node, current);
  });
  while (parent.children.length > nodes.length) {
    parent.removeChild(parent.children[parent.children.length - 1]);
  }
}


