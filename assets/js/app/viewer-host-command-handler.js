/**
 * Apply authenticated host commands (Python, R) to the current browser-owned
 * state.
 *
 * Every cell a command names is an original position (a row of the
 * dataset's `obs`, `data/viewer-protocol.js`); the handlers find the open
 * cells among them with the dataset's cell identity. A cell the open
 * subsample does not hold is left out: a highlight of the open ones, a pushed
 * column without a value there.
 */

import { requireCellList } from './utils/cell-set.js';
import { formatCountOf } from '../utils/format-units.js';
import { categoricalStorageForCount } from '../data/categorical-storage-contract.js';
import { NOTEBOOK_PUSH_OPERATION } from './viewer-host-results.js';

function requireMethod(owner, key, label) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    typeof owner[key] !== 'function'
  ) {
    throw new TypeError(`${label} requires ${key}()`);
  }
  return owner[key].bind(owner);
}

const HANDLER_OPTIONS = Object.freeze([
  'state', 'viewer', 'refreshUi', 'reportDataMapping', 'getCellIdentity', 'getShownHostDataset', 'results',
  'getHostLabel',
]);

/**
 * @param {{
 *   state: Object,
 *   viewer: Object,
 *   refreshUi: () => void,
 *   reportDataMapping: (report: {origin: 'notebook', requestId: string, mapping: Object}) => Promise<boolean>,
 *   getCellIdentity: () => import('../data/cell-identity.js').CellIdentity,
 *   getShownHostDataset: () => string|null,
 *   results: ReturnType<typeof import('./viewer-host-results.js').createViewerHostResults>,
 *   getHostLabel: () => string|null,
 * }} options
 *   `reportDataMapping` answers a `setDataMapping` command with the mapping
 *   the viewer shows once it is applied; `results` answers `setField` and
 *   `setGeneSet`; `getHostLabel` names the host ("Python",
 *   "Jupyter", "R") in the label of a highlight it did not name;
 *   `getShownHostDataset` names the host's dataset the viewer shows, or null
 *   while the person has another one open, when a command that names cells
 *   (`highlight`, `setVisibility`, `setField`) or is answered by a result
 *   (`setGeneSet`) is refused.
 */
export function createViewerHostCommandHandlers(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== HANDLER_OPTIONS.length ||
    !HANDLER_OPTIONS.every(key => Object.hasOwn(options, key))
  ) {
    throw new TypeError(
      `Viewer host command handlers require exactly ${HANDLER_OPTIONS.join(', ')}`
    );
  }
  for (const key of ['refreshUi', 'reportDataMapping', 'getCellIdentity', 'getShownHostDataset', 'getHostLabel']) {
    if (typeof options[key] !== 'function') {
      throw new TypeError(`Viewer host command ${key} must be a function`);
    }
  }
  const {
    state, viewer, refreshUi, reportDataMapping, getCellIdentity, getShownHostDataset, results, getHostLabel,
  } = options;

  /** Refuse a command that names cells while another dataset is open. */
  function requireHostDataset(command) {
    if (getShownHostDataset() !== null) return;
    const host = getHostLabel() ?? 'the host';
    throw new Error(
      `The viewer shows a dataset ${host} did not open, so ${command} names none of its cells; ` +
      `open ${host}'s dataset again in the viewer, or show the viewer again.`
    );
  }

  /** The open cells among `cells` (original positions), in subset positions. */
  function openCells(cells, label) {
    const identity = getCellIdentity();
    const { positions } = identity.fromOriginal(cells);
    return requireCellList(positions, state.pointCount, label);
  }

  function handleHighlight(cells, color, label) {
    if (color === null) {
      if (cells !== null || label !== null) {
        throw new TypeError(
          'Viewer host clear-highlight names no cells'
        );
      }
      // Every page, as the notebook's `clear_highlights()` promises.
      requireMethod(
        state,
        'clearHighlightsOnAllPages',
        'Viewer host clear-highlight command'
      )();
      return;
    }

    if (!(cells instanceof Uint32Array) || cells.length === 0) {
      throw new TypeError('Viewer host highlight cells must be a non-empty cell list');
    }
    requireHostDataset('the highlight');
    // The binary frame's cells, ascending already: the open ones among them,
    // checked against this dataset.
    const cellList = openCells(cells, 'Viewer host highlight cells');
    if (cellList.length === 0) {
      throw new Error(
        `None of the ${formatCountOf(cells.length, 'cell')} to highlight is open in this subsample`
      );
    }
    if (
      typeof color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(color)
    ) {
      throw new TypeError(
        'Viewer host highlight color must be an exact six-digit hex color'
      );
    }

    requireMethod(
      state,
      'ensureHighlightPage',
      'Viewer host highlight command'
    )();
    const page = requireMethod(
      state,
      'getActivePage',
      'Viewer host highlight command'
    )();
    if (
      page === null ||
      typeof page !== 'object' ||
      typeof page.id !== 'string' ||
      page.id.length === 0
    ) {
      throw new Error(
        'Viewer host highlight command requires one active highlight page'
      );
    }
    if (
      requireMethod(
        state,
        'setHighlightPageColor',
        'Viewer host highlight command'
      )(page.id, color) !== true
    ) {
      throw new Error(
        'Viewer host highlight command could not publish its exact color'
      );
    }
    const group = requireMethod(
      state,
      'addHighlightDirect',
      'Viewer host highlight command'
    )({
      type: 'annotation',
      label: label ?? `${getHostLabel() ?? 'Notebook'} selection (${formatCountOf(cellList.length, 'cell')})`,
      cellIndices: cellList
    });
    if (group === null || typeof group !== 'object') {
      throw new Error(
        'Viewer host highlight command could not publish its selection'
      );
    }
  }

  /**
   * A field the notebook pushed: a categorical by `upsertUserDefinedCategoricalField`,
   * a continuous by `upsertUserDefinedContinuousField`, each under its key.
   * A field of that key the notebook did not push is never replaced.
   */
  function setField(message) {
    requireHostDataset(`the pushed column "${message.key}"`);
    const identity = getCellIdentity();
    if (message.nObs !== identity.nOriginal) {
      throw new Error(
        `The pushed column "${message.key}" has ${formatCountOf(message.nObs, 'cell')} and this dataset ` +
        `${formatCountOf(identity.nOriginal, 'cell')}: it belongs to another dataset`
      );
    }
    const operation = { type: NOTEBOOK_PUSH_OPERATION };
    if (message.kind === 'continuous') {
      const values = identity.openValues(message, Float32Array, NaN);
      const { fieldId } = requireMethod(state, 'upsertUserDefinedContinuousField', 'Viewer host set-field command')({
        key: message.key,
        values,
        operation,
      });
      return { kind: 'continuous', id: fieldId };
    }
    const fields = requireMethod(state, 'getFields', 'Viewer host set-field command')() ?? [];
    const existing = fields.find(field => field?._isDeleted !== true && field?.key === message.key);
    if (existing !== undefined && existing._operation?.type !== NOTEBOOK_PUSH_OPERATION) {
      throw new Error(`A field named "${message.key}" exists already; push the column under another key`);
    }
    const storage = categoricalStorageForCount(message.categories.length, `The pushed column "${message.key}"`);
    const ArrayType = storage.TypedArrayClass;
    const sourceMissing = 2 ** (8 * message.values.BYTES_PER_ELEMENT) - 1;
    const codes = identity.openValues(message, ArrayType, storage.missingValue);
    if (sourceMissing !== storage.missingValue) {
      for (let index = 0; index < codes.length; index++) {
        if (codes[index] === sourceMissing) codes[index] = storage.missingValue;
      }
    }
    const { fieldIndex } = requireMethod(state, 'upsertUserDefinedCategoricalField', 'Viewer host set-field command')({
      key: message.key,
      categories: [...message.categories],
      codes,
      meta: { _operation: operation },
    });
    return { kind: 'categorical', id: fields[fieldIndex]._userDefinedId };
  }

  async function handleMessage(message) {
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      typeof message.type !== 'string'
    ) {
      throw new TypeError(
        'Viewer host command handler requires an authenticated message object'
      );
    }

    switch (message.type) {
      case 'setColorBy': {
        const fields = requireMethod(
          state,
          'getFields',
          'Viewer host set-color-by command'
        )();
        if (!Array.isArray(fields)) {
          throw new TypeError(
            'Viewer host set-color-by command requires an exact field array'
          );
        }
        const matches = [];
        for (let index = 0; index < fields.length; index++) {
          if (fields[index]?.key === message.field && fields[index]?._isDeleted !== true) {
            matches.push(index);
          }
        }
        if (matches.length !== 1) {
          throw new Error(
            `Viewer host set-color-by command requires exactly one field ` +
            `${JSON.stringify(message.field)}`
          );
        }
        const fieldIndex = matches[0];
        await requireMethod(
          state,
          'ensureFieldLoaded',
          'Viewer host set-color-by command'
        )(fieldIndex);
        const result = requireMethod(
          state,
          'setActiveField',
          'Viewer host set-color-by command'
        )(fieldIndex);
        if (
          result === null ||
          typeof result !== 'object' ||
          result.field !== fields[fieldIndex]
        ) {
          throw new Error(
            'Viewer host set-color-by command did not publish the selected field'
          );
        }
        refreshUi();
        return;
      }

      case 'setVisibility':
        requireHostDataset('the visibility command');
        requireMethod(
          state,
          'setCellVisibility',
          'Viewer host set-visibility command'
        )(
          message.cells === null ? null : openCells(message.cells, 'Viewer host set-visibility cells'),
          message.visible
        );
        return;

      case 'setDataMapping': {
        // Applied as one transaction: a mapping the viewer refuses leaves it
        // unchanged, and the failure reaches the notebook as command_error.
        await requireMethod(
          state,
          'applyDataMapping',
          'Viewer host set-data-mapping command'
        )(message.mapping, { origin: 'notebook' });
        refreshUi();
        await reportDataMapping({
          origin: 'notebook',
          requestId: message.requestId,
          mapping: requireMethod(
            state,
            'getDataMapping',
            'Viewer host set-data-mapping command'
          )()
        });
        return;
      }

      case 'resetCamera':
        requireMethod(
          viewer,
          'resetCamera',
          'Viewer host reset-camera command'
        )();
        return;

      case 'setField': {
        const made = setField(message);
        refreshUi();
        results.answer(message.requestId, made.kind, made.id);
        return;
      }

      case 'setGeneSet': {
        // Its answer is a result, and no result describes another dataset.
        requireHostDataset(`the gene set "${message.name}"`);
        const entry = requireMethod(state, 'getDerivedResults', 'Viewer host set-gene-set command')()
          .upsertNotebookGeneSet({ name: message.name, description: message.description, genes: message.genes });
        results.answer(message.requestId, 'geneSet', entry.id);
        return;
      }

      default:
        return;
    }
  }

  return Object.freeze({
    handleHighlight,
    handleMessage
  });
}
