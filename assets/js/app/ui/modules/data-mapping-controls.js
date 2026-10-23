/**
 * @fileoverview The "Data mapping" group at the bottom of the Session panel.
 *
 * Its "Embeddings" checklist lists every representation the open dataset can
 * be shown with -- any `obsm` array of an `.h5ad` or Zarr file read in the
 * browser (an array of two or more columns at any selection of 1 to 3 of
 * them, chosen in its row's editor; one wider than three columns in as many
 * selections as wanted) -- and the user turns any number on, of any mix of 1D, 2D and 3D, and makes one per
 * dimension the default. Views then show any representation that is on (see
 * the Compare views picker). Choices are staged until Apply, so editing
 * columns does not load an array once per axis; turning a representation on
 * loads nothing until a view shows it. Apply runs `DataState.applyDataMapping`
 * as one transaction; Revert drops the staged choices. The other groups the
 * dataset can change -- genes, neighbour graph, latent space, vector fields
 * -- follow as their own disclosures (`data-mapping/groups.js`), staged with
 * the embeddings and applied in the same transaction.
 *
 * When a file opens on a best guess (it has no default UMAP), this module
 * tells the user what was shown and where to change it, and opens the
 * checklist (on a phone it only marks it open, so the plot is not covered).
 *
 * @module ui/modules/data-mapping-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import {
  DIMENSIONAL_UMAP_KEYS,
  DIMENSION_SLOTS,
  UNSUFFIXED_UMAP_KEY,
  compareEmbeddingRefs,
  dimensionSlot,
  slotDimension,
  sortVectorBindings,
  uniqueNamesNote,
  validateEmbeddingColumns,
} from '../../../data/data-mapping.js';
import { EmbeddingLoadError, MappingLoadError, obsmWidth } from '../../../data/data-mapping-candidates.js';
import { representationName } from '../../../data/representation-names.js';
import {
  buildDataMappingPanel,
  createRepresentationRow,
  setText,
  syncChildren,
} from './data-mapping/dom.js';
import {
  GROUP_SECTIONS,
  SECTION_GROUPS,
  bindingKey,
  buildGroupSection,
  buildVectorSection,
  decodeChoice,
  encodeChoice,
  renderGroupSection,
  renderVectorSection,
  VECTOR_SECTION,
} from './data-mapping/groups.js';

const PHONE_LAYOUT_QUERY = '(max-width: 720px)';
// Var columns that usually hold gene symbols (the Ensembl hint names one).
const SYMBOL_COLUMNS = Object.freeze([
  'gene_symbols',
  'gene_symbol',
  'symbol',
  'feature_name',
  'gene_name',
  'gene_names',
]);

const REQUIRED_STATE_METHODS = Object.freeze([
  'applyDataMapping',
  'canChangeMappingGroup',
  'canMapAnyEmbedding',
  'describeDataMappingRefusal',
  'getDataMapping',
  'getDataMappingOrigin',
  'getDimensionManager',
  'getGeneNameChoices',
  'getGuessedMappingGroups',
  'getMappingCandidates',
  'getMappingGroupChoices',
  'getRepresentationChoices',
  'getVectorBindingChoices',
  'previewRepresentationMoves',
  'on',
]);

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneRef(ref) {
  return { key: ref.key, columns: ref.columns === null ? null : [...ref.columns] };
}

function sameRef(left, right) {
  return left !== null && right !== null && compareEmbeddingRefs(left, right) === 0;
}

/**
 * Every `obsm` key the default embedding rule accepts, as the best-guess
 * notification names them: "X_umap_1d, X_umap_2d, X_umap_3d or X_umap". Built
 * from the rule's own constants, so the message cannot drift from the rule.
 */
export const DEFAULT_UMAP_KEYS_TEXT = `${DIMENSIONAL_UMAP_KEYS.join(', ')} or ${UNSUFFIXED_UMAP_KEY}`;

/**
 * The notification of a best guess: which arrays are shown, and where to
 * change them.
 *
 * @param {Object} mapping
 * @param {ReadonlyArray<string>} guessed - e.g. `['embeddings.2d']`
 * @param {(key: string) => number|null} widthOf - The column count of an
 *   `obsm` key.
 * @returns {string}
 */
export function describeBestGuess(mapping, guessed, widthOf) {
  const shown = guessed
    .map(group => group.replace(/^embeddings\./, ''))
    .filter(slot => DIMENSION_SLOTS.includes(slot))
    .sort((left, right) => slotDimension(right) - slotDimension(left))
    .map(slot => {
      const ref = mapping.embeddings.defaults[slot];
      const what = widthOf(ref.key) === ref.columns.length
        ? `'${ref.key}'`
        : `columns ${ref.columns.join(' and ')} of '${ref.key}'`;
      return `${what} as ${slot.toUpperCase()}`;
    });
  const list = shown.length <= 1
    ? shown.join('')
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return (
    `This file has no default UMAP (${DEFAULT_UMAP_KEYS_TEXT}). `
    + `Showing ${list}. `
    + 'Change it under Session › Data mapping.'
  );
}

/**
 * @param {{state: Object, root: HTMLElement}} options
 * @returns {{datasetPublished: () => void, render: () => void, reveal: (options?: {openSidebar?: boolean}) => void, destroy: () => void}}
 */
export function initDataMappingControls({ state, root }) {
  for (const method of REQUIRED_STATE_METHODS) {
    if (typeof state?.[method] !== 'function') {
      throw new TypeError(`Data mapping controls require state.${method}().`);
    }
  }
  if (!(root instanceof HTMLElement)) {
    throw new TypeError('Data mapping controls require their root element.');
  }
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const lifecycle = new AbortController();
  let destroyed = false;
  let expanded = false;
  let busy = false;
  let notifiedMapping = null;
  let guessNotificationId = null;
  let loadError = null;
  // The other groups' staged values, by group name (data-mapping/groups.js),
  // and the load-time refusal each one last met.
  const stagedGroups = new Map();
  const groupErrors = new Map();
  // Genes the last gene-list change dropped from a view's colouring.
  let droppedGenes = [];

  /**
   * The staged checklist: one row per representation the panel lists, and
   * the default of each dimension. Null until a mapping is shown; rebuilt
   * from the mapping whenever nothing is staged.
   *
   * @type {null|{
   *   rows: Array<{uid: number, ref: {key: string, columns: number[]|null},
   *     enabled: boolean, usable: boolean, reason: string|null,
   *     width: number|null, name: string, added: boolean, open: boolean}>,
   *   defaults: Record<'1d'|'2d'|'3d', {key: string, columns: number[]|null}|null>
   * }}
   */
  let staged = null;
  // The rows staged last, kept while the checklist is restaged from a new
  // mapping (after Apply or Revert), so a representation that is listed
  // again keeps its row -- its DOM node and whether its editor is open.
  let previousRows = [];
  let nextRowUid = 0;
  // One checklist row node per staged row, by the row's uid: rows are built
  // once and updated in place, never rebuilt by a render.
  const rowNodes = new Map();

  // One disclosure per further group, built once, listed between Embeddings
  // and "Read from file".
  const groupNodes = new Map(GROUP_SECTIONS.map(section => [
    section.id,
    buildGroupSection(ownerDocument, section),
  ]));
  const vectorNode = buildVectorSection(ownerDocument);
  const panel = buildDataMappingPanel(ownerDocument, {
    expanded,
    onToggle: next => {
      expanded = next;
    },
    groupSections: [...groupNodes.values(), vectorNode].map(node => node.root),
  });
  root.replaceChildren(panel.root);

  function setExpanded(next) {
    expanded = next;
    panel.disclosure.setExpanded(next);
  }

  function stageFromMapping(mapping) {
    const defaults = {};
    for (const slot of DIMENSION_SLOTS) {
      const ref = mapping.embeddings.defaults[slot];
      defaults[slot] = ref === null ? null : cloneRef(ref);
    }
    // Listed like the picker: by dimension, highest first; each dimension's
    // default first; then by name. Unusable arrays come last.
    const choices = [...state.getRepresentationChoices()].sort((left, right) => (
      (right.dimension ?? 0) - (left.dimension ?? 0) ||
      Number(right.isDefault) - Number(left.isDefault) ||
      left.name.localeCompare(right.name)
    ));
    const unclaimed = [...previousRows];
    return {
      rows: choices.map(choice => {
        const at = unclaimed.findIndex(row => sameRef(row.ref, choice.ref));
        const previous = at < 0 ? null : unclaimed.splice(at, 1)[0];
        return {
          uid: previous?.uid ?? nextRowUid++,
          ref: cloneRef(choice.ref),
          enabled: choice.enabled,
          usable: choice.usable,
          reason: choice.reason,
          width: choice.width,
          name: choice.name,
          added: false,
          open: previous?.open ?? false,
        };
      }),
      defaults,
    };
  }

  function stagedRows(mapping) {
    if (staged === null) staged = stageFromMapping(mapping);
    return staged;
  }

  /** Drop the staged checklist; the next render restages it from the mapping. */
  function unstage() {
    if (staged !== null) previousRows = staged.rows;
    staged = null;
  }

  function dimensionOf(row) {
    if (!row.usable) return null;
    if (row.ref.columns !== null) return row.ref.columns.length;
    return state.getDimensionManager().getLayout(row.ref.key).dimension;
  }

  function nameOf(row) {
    if (row.ref.columns === null || row.width === null) return row.name;
    return representationName({
      layoutKey: row.ref.key,
      label: row.ref.key,
      provenance: { key: row.ref.key, columns: row.ref.columns },
      width: row.width,
    });
  }

  function enabledRefs() {
    return staged.rows
      .filter(row => row.usable && row.enabled)
      .map(row => cloneRef(row.ref))
      .sort(compareEmbeddingRefs);
  }

  function nextMapping(mapping) {
    return {
      ...mapping,
      embeddings: { enabled: enabledRefs(), defaults: staged.defaults },
      ...Object.fromEntries(stagedGroups),
    };
  }

  /** The value one group shows: its staged choice, else the mapping's. */
  function shownGroupValue(mapping, group) {
    return stagedGroups.has(group) ? stagedGroups.get(group) : mapping[group];
  }

  /** The label one choice of one group is listed with, or its value. */
  function choiceLabel(choices, value) {
    return choices.find(choice => choice.value === value)?.label ?? String(value);
  }

  /** Fill the disclosure of every group this dataset can change. */
  function renderGroupSections(mapping) {
    for (const section of GROUP_SECTIONS) {
      const fields = new Map();
      const summary = [];
      for (const { group } of section.fields) {
        let choices = state.getMappingGroupChoices(group);
        if (choices === null) continue;
        // Gene names are columns of the axis of the expression shown.
        if (group === 'geneNames') {
          choices = state.getGeneNameChoices(shownGroupValue(mapping, 'expression'));
        }
        const value = shownGroupValue(mapping, group);
        summary.push(choiceLabel(choices, value));
        fields.set(group, {
          options: choices.map(choice => ({
            value: encodeChoice(choice.value),
            label: choice.usable ? choice.label : `${choice.label} · ${choice.reason}`,
            disabled: !choice.usable && choice.value !== value,
            ...(choice.usable ? {} : { title: choice.reason }),
          })),
          value: encodeChoice(value),
          disabled: busy,
          disabledReason: 'Applying the data mapping…',
          error: groupErrors.get(group) ?? '',
        });
      }
      const hint = fields.size > 0 && section.id === 'genes' ? genesHint(mapping) : '';
      renderGroupSection(groupNodes.get(section.id), { summary: summary.join(' · '), fields, hint });
    }
    // The vector fields of every embedding the panel shows, staged or not.
    const groups = state.getVectorBindingChoices(nextMapping(mapping));
    const bindings = shownGroupValue(mapping, VECTOR_SECTION.group);
    renderVectorSection(vectorNode, {
      summary: bindings.length === 0 ? 'None' : `${bindings.length} bound`,
      groups,
      selected: new Set(bindings.map(bindingKey)),
      disabled: busy,
      error: groupErrors.get(VECTOR_SECTION.group) ?? '',
      hint: groups !== null && groups.every(entry => entry.options.length === 0)
        ? 'No obsm array can be drawn on these embeddings.'
        : '',
    });
  }

  /**
   * The one line under the genes: what making the names in use unique
   * changed, else the Ensembl hint.
   */
  function genesHint(mapping) {
    const pending = changedGroups(mapping).some(group => group === 'geneNames' || group === 'expression');
    const set = pending ? null : namesInUse();
    const note = set === null
      ? null
      : uniqueNamesNote({
          filledFromIndex: set.filledFromIndex,
          renamed: set.renamed,
          source: set.source,
        });
    const guess = !pending && state.getGuessedMappingGroups().includes('expression')
      ? 'Expression is guessed: this file has no X.'
      : '';
    return [guess, note ?? ensemblHint(mapping)].filter(Boolean).join(' ');
  }

  /** The gene-name set the gene list in use was made from. */
  function namesInUse() {
    return state.varData?.geneNames ?? null;
  }

  /**
   * A hint when the genes are named by Ensembl ids and the axis has a symbol
   * column: at least 90% of a 200-name sample match `ENS…G<digits>`.
   */
  function ensemblHint(mapping) {
    if (shownGroupValue(mapping, 'geneNames') !== 'index') return '';
    const keys = (state.varData?.fields ?? [])
      .filter(field => field?._isUserDefined !== true)
      .slice(0, 200)
      .map(field => field.key);
    if (keys.length === 0) return '';
    const ensembl = keys.filter(key => /^ENS[A-Z]*G\d+/.test(key)).length;
    if (ensembl < 0.9 * keys.length) return '';
    const symbol = state.getGeneNameChoices(shownGroupValue(mapping, 'expression'))
      .find(choice => choice.usable && SYMBOL_COLUMNS.includes(choice.label));
    return symbol === undefined
      ? ''
      : `Gene names are Ensembl ids; '${symbol.label}' holds symbols.`;
  }

  /** The groups whose staged value differs from the mapping's. */
  function changedGroups(mapping) {
    return SECTION_GROUPS.filter(
      group => stagedGroups.has(group) && !sameJson(stagedGroups.get(group), mapping[group])
    );
  }

  /** The status after Apply, naming any gene a view lost. */
  function describeApplied(dropped) {
    if (dropped.length === 0) return 'Applied.';
    const names = dropped.slice(0, 3).map(name => `'${name}'`).join(', ')
      + (dropped.length > 3 ? ` and ${dropped.length - 3} more` : '');
    return `Applied. ${names} ${dropped.length === 1 ? 'is' : 'are'} not on the new gene list; `
      + `${dropped.length === 1 ? 'its' : 'their'} colouring was removed.`;
  }

  /** What Apply changes in the other groups, in short sentences. */
  function describeGroupConsequences(next, groupsChanged) {
    const parts = [];
    if (groupsChanged.includes('expression') || groupsChanged.includes('geneNames')) {
      parts.push('Apply keeps each coloured gene it finds and closes analysis windows.');
    }
    if (groupsChanged.includes('knn')) {
      parts.push(next.knn === null
        ? 'Apply removes the neighbour graph.'
        : 'Apply replaces the neighbour graph.');
    }
    if (groupsChanged.includes('latent')) {
      parts.push(next.latent === null
        ? 'Apply removes outlier filters.'
        : 'Apply measures outliers in the new space.');
    }
    if (groupsChanged.includes('vectorFields')) {
      parts.push('Apply rebinds vector fields; the overlay turns off.');
    }
    return parts;
  }

  /** Keep each dimension's default on an enabled row of that dimension. */
  function settleDefaults() {
    for (const slot of DIMENSION_SLOTS) {
      const dimension = slotDimension(slot);
      const current = staged.defaults[slot];
      const rowsOfDimension = staged.rows.filter(
        row => row.usable && row.enabled && dimensionOf(row) === dimension
      );
      if (current !== null && rowsOfDimension.some(row => sameRef(row.ref, current))) continue;
      staged.defaults[slot] = rowsOfDimension.length === 0 ? null : cloneRef(rowsOfDimension[0].ref);
    }
  }

  /**
   * Rows whose embedding draws a vector field -- as the Vector fields
   * disclosure stages it -- cannot be turned off until it is unbound.
   */
  function boundRefs(mapping) {
    return shownGroupValue(mapping, 'vectorFields').map(binding => binding.embedding);
  }

  function rowProblem(row) {
    if (!row.usable || row.ref.columns === null || row.width === null) return null;
    try {
      validateEmbeddingColumns(row.ref.columns, {
        dimension: row.ref.columns.length,
        width: row.width,
      });
      return null;
    } catch (error) {
      return `${nameOf(row)}: ${error.message}`;
    }
  }

  function checklistProblem() {
    for (const row of staged.rows) {
      const problem = rowProblem(row);
      if (problem !== null) return problem;
    }
    const enabled = staged.rows.filter(row => row.usable && row.enabled);
    if (enabled.length === 0) return 'Turn at least one embedding on.';
    for (let index = 1; index < enabled.length; index++) {
      for (let other = 0; other < index; other++) {
        if (sameRef(enabled[index].ref, enabled[other].ref)) {
          return `${nameOf(enabled[index])} is listed twice. Remove one of them.`;
        }
      }
    }
    if (DIMENSION_SLOTS.every(slot => staged.defaults[slot] === null)) {
      return 'Make one embedding a default.';
    }
    return null;
  }

  function describeCurrent(mapping) {
    const dimensionManager = state.getDimensionManager();
    const count = mapping.embeddings.enabled.length;
    const defaults = [...DIMENSION_SLOTS].reverse()
      .filter(slot => mapping.embeddings.defaults[slot] !== null)
      .map(slot => {
        const ref = mapping.embeddings.defaults[slot];
        const layout = dimensionManager.getLayout(dimensionManager.resolveRepresentation(ref));
        return `${representationName(layout)} ${slot.toUpperCase()}`;
      });
    const parts = [`${count} on`, ...defaults];
    if (state.getGuessedMappingGroups().length > 0) parts.push('guessed');
    return parts.join(' · ');
  }

  function render() {
    if (destroyed) return;
    const focused = ownerDocument.activeElement;
    const focusedId = focused?.id ?? '';
    const mapping = state.getDataMapping();
    panel.emptyState.hidden = mapping !== null;
    panel.body.hidden = mapping === null;
    if (mapping === null) {
      staged = null;
      previousRows = [];
      rowNodes.clear();
      setText(panel.description, '—');
      panel.rows.replaceChildren();
      for (const node of [...groupNodes.values(), vectorNode]) node.root.hidden = true;
      return;
    }
    stagedRows(mapping);
    setText(panel.description, describeCurrent(mapping));
    const guessed = new Set(state.getGuessedMappingGroups());
    const bound = boundRefs(mapping);
    const enabledCount = staged.rows.filter(row => row.usable && row.enabled).length;
    const canAddColumns = state.canMapAnyEmbedding();

    const nodes = staged.rows.map((row, index) => {
      const dimension = dimensionOf(row);
      const slot = dimension === null ? null : dimensionSlot(dimension);
      const isDefault = slot !== null && sameRef(staged.defaults[slot], row.ref);
      let lockedReason = null;
      if (row.enabled && bound.some(ref => sameRef(ref, row.ref))) {
        lockedReason = 'A vector field is drawn on this embedding, so it stays on.';
      } else if (row.enabled && enabledCount === 1) {
        lockedReason = 'At least one embedding stays on.';
      }
      const siblings = staged.rows.filter(other => other.ref.key === row.ref.key);
      // Every array of two or more columns can be shown at any 1 to 3 of
      // them, so its dimension and columns can always be changed.
      const configurable = row.usable && row.width !== null && row.width > 1 && row.ref.columns !== null;
      const model = {
        index,
        name: nameOf(row),
        title: row.ref.columns === null
          ? row.ref.key
          : `obsm['${row.ref.key}'], columns ${row.ref.columns.join(', ')} (0-based)`,
        dimension,
        enabled: row.enabled,
        isDefault,
        usable: row.usable,
        reason: row.reason,
        busy,
        lockedReason,
        columns: configurable ? { width: row.width, selected: row.ref.columns } : null,
        removable: row.added || (siblings.length > 1 && !row.enabled),
        guessed: isDefault && slot !== null && guessed.has(`embeddings.${slot}`)
          && sameRef(mapping.embeddings.defaults[slot], row.ref),
        open: configurable && row.open,
        add: configurable && canAddColumns && row.width > 3
          ? {
              key: row.ref.key,
              name: representationName({ layoutKey: row.ref.key, label: row.ref.key, provenance: null }),
            }
          : null,
      };
      const shape = `${row.usable}:${configurable}`;
      let entry = rowNodes.get(row.uid);
      if (entry === undefined || entry.shape !== shape) {
        entry = { shape, ...createRepresentationRow(ownerDocument, { usable: row.usable, configurable }) };
        rowNodes.set(row.uid, entry);
      }
      entry.update(model);
      return entry.root;
    });
    const listed = new Set(staged.rows.map(row => row.uid));
    for (const uid of rowNodes.keys()) if (!listed.has(uid)) rowNodes.delete(uid);
    syncChildren(panel.rows, nodes);
    renderGroupSections(mapping);

    const next = nextMapping(mapping);
    const embeddingsChanged = !sameJson(next.embeddings, mapping.embeddings);
    const groupsChanged = changedGroups(mapping);
    const changed = embeddingsChanged || groupsChanged.length > 0;
    panel.revert.disabled = busy || !changed;
    const problem = embeddingsChanged ? checklistProblem() : null;
    let canApply = changed && problem === null && !busy;
    if (!busy) {
      if (!changed) {
        panel.status.set(loadError ?? '', loadError === null ? 'muted' : 'danger');
      } else if (problem !== null) {
        panel.status.set(problem, 'danger');
      } else {
        const refusal = state.describeDataMappingRefusal(next);
        if (refusal !== null) {
          canApply = false;
          panel.status.set(refusal, 'danger');
        } else {
          const parts = [];
          if (embeddingsChanged) {
            const moves = state.previewRepresentationMoves(next);
            parts.push(moves === 0
              ? 'Apply offers these embeddings to every view.'
              : `Apply also switches ${moves === 1 ? '1 view' : `${moves} views`} to the new default.`);
          }
          parts.push(...describeGroupConsequences(next, groupsChanged));
          panel.status.set(parts.join(' '), 'muted');
        }
      }
    }
    panel.apply.disabled = !canApply;
    // A disabled button says why, as every disabled control does.
    const idleReason = busy ? 'Applying the data mapping…' : 'Change something above first.';
    panel.revert.title = panel.revert.disabled ? idleReason : 'Drop the changes above.';
    panel.apply.title = panel.apply.disabled
      ? (changed ? 'Fix the problem shown above first.' : idleReason)
      : 'Load what changed and show it.';
    // Rows are updated in place, so the focused control is normally still
    // there; one that a render did replace (a row rebuilt) is found by id.
    if (focused !== null && focused !== undefined && !focused.isConnected && focusedId !== '') {
      ownerDocument.getElementById(focusedId)?.focus({ preventScroll: true });
    }
  }

  function rowAt(target) {
    const node = target.closest('.data-mapping-row');
    if (node === null) return null;
    return staged.rows[Number(node.dataset.row)] ?? null;
  }

  function nextUnusedColumns(key, count, width) {
    const used = new Set(
      staged.rows.filter(row => row.ref.key === key && row.ref.columns !== null)
        .flatMap(row => row.ref.columns)
    );
    const free = [];
    for (let column = 0; column < width && free.length < count; column++) {
      if (!used.has(column)) free.push(column);
    }
    for (let column = 0; column < width && free.length < count; column++) {
      if (!free.includes(column)) free.push(column);
    }
    return free;
  }

  function changeRef(row, columns) {
    const oldSlot = dimensionSlot(row.ref.columns.length);
    const wasDefault = sameRef(staged.defaults[oldSlot], row.ref);
    row.ref = { key: row.ref.key, columns };
    if (wasDefault && columns.length === Number(oldSlot[0])) {
      staged.defaults[oldSlot] = cloneRef(row.ref);
    }
    settleDefaults();
  }

  function onRowsChange(event) {
    const target = event.target;
    if (busy || staged === null) return;
    const row = rowAt(target);
    if (row === null) return;
    loadError = null;
    if (target instanceof HTMLInputElement && target.classList.contains('data-mapping-enable')) {
      row.enabled = target.checked;
      settleDefaults();
    } else if (target instanceof HTMLSelectElement && target.classList.contains('data-mapping-axes')) {
      const count = Number(target.value);
      const columns = row.ref.columns.slice(0, count);
      for (const column of nextUnusedColumns(row.ref.key, row.width, row.width)) {
        if (columns.length >= count) break;
        if (!columns.includes(column)) columns.push(column);
      }
      changeRef(row, columns);
    } else if (target instanceof HTMLSelectElement && target.dataset.axis !== undefined) {
      const columns = [...row.ref.columns];
      columns[Number(target.dataset.axis)] = Number(target.value);
      changeRef(row, columns);
    } else {
      return;
    }
    render();
  }

  function onRowsClick(event) {
    if (busy || staged === null) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const add = target.closest('.data-mapping-add');
    if (add !== null) {
      const key = add.dataset.key;
      const source = staged.rows.find(row => row.ref.key === key);
      const columns = nextUnusedColumns(key, 2, source.width);
      const index = staged.rows.findLastIndex(row => row.ref.key === key) + 1;
      // The new selection opens its editor: its columns are what it is for.
      staged.rows.splice(index, 0, {
        ...source,
        uid: nextRowUid++,
        ref: { key, columns },
        enabled: true,
        added: true,
        open: true,
      });
      settleDefaults();
      render();
      ownerDocument.getElementById(`data-mapping-row-${index}`)?.focus({ preventScroll: true });
      return;
    }
    const row = rowAt(target);
    if (row === null) return;
    if (target.closest('.data-mapping-edit') !== null) {
      row.open = !row.open;
      render();
    } else if (target.closest('.data-mapping-default') !== null) {
      staged.defaults[dimensionSlot(dimensionOf(row))] = cloneRef(row.ref);
      render();
    } else if (target.closest('.data-mapping-remove') !== null) {
      staged.rows.splice(staged.rows.indexOf(row), 1);
      settleDefaults();
      render();
    }
  }

  function onGroupsChange(event) {
    const target = event.target;
    if (busy) return;
    const mapping = state.getDataMapping();
    if (mapping === null) return;
    loadError = null;
    if (target instanceof HTMLInputElement && target.dataset.mappingGroup === VECTOR_SECTION.group) {
      groupErrors.delete(VECTOR_SECTION.group);
      const bindings = shownGroupValue(mapping, VECTOR_SECTION.group)
        .filter(binding => bindingKey(binding) !== target.value);
      if (target.checked) bindings.push(JSON.parse(target.value));
      stagedGroups.set(VECTOR_SECTION.group, sortVectorBindings(bindings));
      render();
      return;
    }
    if (!(target instanceof HTMLSelectElement)) return;
    const group = target.dataset.mappingGroup;
    if (!SECTION_GROUPS.includes(group)) return;
    groupErrors.delete(group);
    const value = decodeChoice(target.value);
    stagedGroups.set(group, value);
    if (group === 'expression') {
      // Another axis keeps a gene-name column only if it has one of that
      // name (raw has its own var); otherwise the names come from its index.
      const names = shownGroupValue(mapping, 'geneNames');
      const available = state.getGeneNameChoices(value).some(choice => choice.value === names);
      if (!available) stagedGroups.set('geneNames', 'index');
    }
    render();
  }

  async function onApply() {
    const mapping = state.getDataMapping();
    if (busy || mapping === null || staged === null) return;
    const next = nextMapping(mapping);
    droppedGenes = [];
    busy = true;
    panel.status.set('Loading…', 'muted');
    render();
    try {
      await state.applyDataMapping(next, { origin: 'user' });
      if (destroyed) return;
      unstage();
      stagedGroups.clear();
      groupErrors.clear();
      loadError = null;
      panel.status.set(describeApplied(droppedGenes), 'success');
    } catch (error) {
      if (destroyed) return;
      loadError = error instanceof Error ? error.message : String(error);
      if (error instanceof EmbeddingLoadError) {
        // An embedding failed its load-time check: it stays off, with its
        // reason. The type, not the
        // key, says so: one obsm key can also be a latent space or a vector
        // field, whose refusal belongs to that group.
        unstage();
      } else if (error instanceof MappingLoadError) {
        // A group's choice failed its check: that group shows the reason, in
        // its open disclosure, and goes back to what is applied.
        for (const group of changedGroups(mapping)) {
          const value = stagedGroups.get(group);
          const names = group === VECTOR_SECTION.group
            ? value.some(binding => binding.key === error.key)
            : [error.key, `column:${error.key}`, `layer:${error.key}`].includes(value);
          if (!names) continue;
          groupErrors.set(group, `${error.key}: ${error.reason}.`);
          stagedGroups.delete(group);
          const section = group === VECTOR_SECTION.group
            ? vectorNode
            : groupNodes.get(GROUP_SECTIONS.find(entry => entry.fields.some(field => field.group === group)).id);
          section.disclosure.setExpanded(true);
        }
      }
      panel.status.set(loadError, 'danger');
    } finally {
      busy = false;
      if (!destroyed) {
        const message = panel.status.root.textContent;
        const tone = panel.status.root.dataset.tone;
        render();
        panel.status.set(message, tone);
      }
    }
  }

  function onRevert() {
    if (busy) return;
    unstage();
    stagedGroups.clear();
    groupErrors.clear();
    loadError = null;
    render();
  }

  /**
   * Show the checklist: open the Session section and the Embeddings
   * disclosure, and on request the sidebar (the phone sheet), then bring it
   * into view. `focusGroup` (a group such as `latent`) brings that group's
   * choice into view and focuses it instead.
   */
  function reveal({ openSidebar = false, focusGroup = null } = {}) {
    if (destroyed) return;
    const sidebar = ownerDocument.getElementById('sidebar');
    if (openSidebar && sidebar?.classList.contains('hidden')) {
      ownerDocument.getElementById('sidebar-toggle')?.click();
    }
    const section = ownerDocument.getElementById('session-section');
    if (section instanceof HTMLDetailsElement && !section.open) section.open = true;
    setExpanded(true);
    const target = focusGroup === null ? null : ownerDocument.getElementById(`data-mapping-${focusGroup}`);
    if (target !== null) {
      // The group's own disclosure opens too.
      const section = GROUP_SECTIONS.find(entry => entry.fields.some(field => field.group === focusGroup));
      if (section !== undefined) groupNodes.get(section.id)?.disclosure.setExpanded(true);
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
      return;
    }
    panel.disclosure.root.scrollIntoView({ block: 'nearest' });
    if (openSidebar) panel.disclosure.header.focus({ preventScroll: true });
  }

  function announceBestGuess(mapping) {
    if (state.getDataMappingOrigin() !== 'best_guess' || notifiedMapping === mapping) return;
    notifiedMapping = mapping;
    // The notification is about what is drawn: the guessed embeddings.
    const guessed = state.getGuessedMappingGroups().filter(group => group.startsWith('embeddings.'));
    if (guessed.length === 0) return;
    // Only an AnnData source is guessed, and every AnnData source can plot
    // any obsm array, so the panel can always change what the guess showed.
    const notifications = getNotificationCenter();
    if (guessNotificationId !== null && notifications.hasNotification(guessNotificationId)) {
      notifications.dismiss(guessNotificationId);
    }
    const candidates = state.getMappingCandidates();
    const widthOf = key => {
      const item = candidates?.obsm.find(entry => entry.key === key);
      return item === undefined ? null : obsmWidth(item);
    };
    guessNotificationId = notifications.info(describeBestGuess(mapping, guessed, widthOf), {
      category: 'data',
      duration: 0,
      action: { label: 'Show', run: () => reveal({ openSidebar: true }) },
    });
    const phone = ownerWindow?.matchMedia?.(PHONE_LAYOUT_QUERY).matches === true;
    if (phone) {
      setExpanded(true);
    } else {
      reveal();
    }
  }

  /** An applied mapping: drop staged choices that are now current. */
  function onMappingChanged() {
    if (destroyed) return;
    if (!busy) {
      unstage();
      stagedGroups.clear();
    }
    render();
  }

  /**
   * A dataset (or none) was published: start from its mapping, and say so when
   * it was guessed.
   */
  function datasetPublished() {
    if (destroyed) return;
    staged = null;
    previousRows = [];
    stagedGroups.clear();
    groupErrors.clear();
    loadError = null;
    panel.status.set('');
    render();
    const mapping = state.getDataMapping();
    if (mapping !== null) announceBestGuess(mapping);
  }

  panel.rows.addEventListener('change', onRowsChange, { signal: lifecycle.signal });
  panel.rows.addEventListener('click', onRowsClick, { signal: lifecycle.signal });
  panel.apply.addEventListener('click', () => {
    void onApply();
  }, { signal: lifecycle.signal });
  panel.revert.addEventListener('click', onRevert, { signal: lifecycle.signal });
  for (const node of [...groupNodes.values(), vectorNode]) {
    node.root.addEventListener('change', onGroupsChange, { signal: lifecycle.signal });
  }
  const unsubscribeVarAxis = state.on('var-axis:changed', ({ dropped }) => {
    droppedGenes = [...dropped];
  });
  const unsubscribeMapping = state.on('mapping:changed', onMappingChanged);
  // A choice found unusable when it was read (a latent space with a NaN)
  // is offered no more.
  const unsubscribeChoices = state.on('mapping:choices-changed', () => render());

  datasetPublished();

  return {
    datasetPublished,
    render,
    reveal,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lifecycle.abort();
      unsubscribeMapping();
      unsubscribeChoices();
      unsubscribeVarAxis();
      root.replaceChildren();
    },
  };
}
