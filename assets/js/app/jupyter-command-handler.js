/**
 * Apply authenticated Python commands to the current browser-owned state.
 */

import { cellListFrom } from './utils/cell-set.js';

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

/**
 * @param {{
 *   state: Object,
 *   viewer: Object,
 *   refreshUi: () => void,
 *   reportDataMapping: (report: {origin: 'notebook', requestId: string, mapping: Object}) => Promise<boolean>,
 * }} options
 *   `reportDataMapping` answers a `setDataMapping` command with the mapping
 *   the viewer shows once it is applied.
 */
export function createJupyterCommandHandlers(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 4 ||
    !Object.hasOwn(options, 'state') ||
    !Object.hasOwn(options, 'viewer') ||
    !Object.hasOwn(options, 'refreshUi') ||
    !Object.hasOwn(options, 'reportDataMapping')
  ) {
    throw new TypeError(
      'Jupyter command handlers require exactly state, viewer, refreshUi, and reportDataMapping'
    );
  }
  if (typeof options.refreshUi !== 'function') {
    throw new TypeError('Jupyter command refreshUi must be a function');
  }
  if (typeof options.reportDataMapping !== 'function') {
    throw new TypeError('Jupyter command reportDataMapping must be a function');
  }
  const { state, viewer, refreshUi, reportDataMapping } = options;

  function handleHighlight(cells, color) {
    if (color === null) {
      if (!Array.isArray(cells) || cells.length !== 0) {
        throw new TypeError(
          'Jupyter clear-highlight cells must be an empty array'
        );
      }
      requireMethod(
        state,
        'clearAllHighlights',
        'Jupyter clear-highlight command'
      )();
      return;
    }

    if (!Array.isArray(cells) || cells.length === 0) {
      throw new TypeError('Jupyter highlight cells must be a non-empty array');
    }
    // One cell list, sorted once when Python sent the cells unordered.
    const cellList = cellListFrom(
      cells,
      state.pointCount,
      'Jupyter highlight cells'
    );
    if (
      typeof color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(color)
    ) {
      throw new TypeError(
        'Jupyter highlight color must be an exact six-digit hex color'
      );
    }

    requireMethod(
      state,
      'ensureHighlightPage',
      'Jupyter highlight command'
    )();
    const page = requireMethod(
      state,
      'getActivePage',
      'Jupyter highlight command'
    )();
    if (
      page === null ||
      typeof page !== 'object' ||
      typeof page.id !== 'string' ||
      page.id.length === 0
    ) {
      throw new Error(
        'Jupyter highlight command requires one active highlight page'
      );
    }
    if (
      requireMethod(
        state,
        'setHighlightPageColor',
        'Jupyter highlight command'
      )(page.id, color) !== true
    ) {
      throw new Error(
        'Jupyter highlight command could not publish its exact color'
      );
    }
    const group = requireMethod(
      state,
      'addHighlightDirect',
      'Jupyter highlight command'
    )({
      type: 'annotation',
      label: `Python selection (${cellList.length} cells)`,
      cellIndices: cellList
    });
    if (group === null || typeof group !== 'object') {
      throw new Error(
        'Jupyter highlight command could not publish its selection'
      );
    }
  }

  async function handleMessage(message) {
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      typeof message.type !== 'string'
    ) {
      throw new TypeError(
        'Jupyter command handler requires an authenticated message object'
      );
    }

    switch (message.type) {
      case 'setColorBy': {
        const fields = requireMethod(
          state,
          'getFields',
          'Jupyter set-color-by command'
        )();
        if (!Array.isArray(fields)) {
          throw new TypeError(
            'Jupyter set-color-by command requires an exact field array'
          );
        }
        const matches = [];
        for (let index = 0; index < fields.length; index++) {
          if (fields[index]?.key === message.field) {
            matches.push(index);
          }
        }
        if (matches.length !== 1) {
          throw new Error(
            `Jupyter set-color-by command requires exactly one field ` +
            `${JSON.stringify(message.field)}`
          );
        }
        const fieldIndex = matches[0];
        await requireMethod(
          state,
          'ensureFieldLoaded',
          'Jupyter set-color-by command'
        )(fieldIndex);
        const result = requireMethod(
          state,
          'setActiveField',
          'Jupyter set-color-by command'
        )(fieldIndex);
        if (
          result === null ||
          typeof result !== 'object' ||
          result.field !== fields[fieldIndex]
        ) {
          throw new Error(
            'Jupyter set-color-by command did not publish the selected field'
          );
        }
        refreshUi();
        return;
      }

      case 'setVisibility':
        requireMethod(
          state,
          'setCellVisibility',
          'Jupyter set-visibility command'
        )(message.cells, message.visible);
        return;

      case 'setDataMapping': {
        // Applied as one transaction: a mapping the viewer refuses leaves it
        // unchanged, and the failure reaches the notebook as command_error.
        await requireMethod(
          state,
          'applyDataMapping',
          'Jupyter set-data-mapping command'
        )(message.mapping, { origin: 'notebook' });
        refreshUi();
        await reportDataMapping({
          origin: 'notebook',
          requestId: message.requestId,
          mapping: requireMethod(
            state,
            'getDataMapping',
            'Jupyter set-data-mapping command'
          )()
        });
        return;
      }

      case 'resetCamera':
        requireMethod(
          viewer,
          'resetCamera',
          'Jupyter reset-camera command'
        )();
        return;

      default:
        return;
    }
  }

  return Object.freeze({
    handleHighlight,
    handleMessage
  });
}
