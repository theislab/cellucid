/**
 * Apply authenticated Python commands to the current browser-owned state.
 */

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

function requireCellIndices(cells, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(cells) || (!allowEmpty && cells.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  const seen = new Set();
  for (let index = 0; index < cells.length; index++) {
    if (
      !Object.hasOwn(cells, index) ||
      !Number.isInteger(cells[index]) ||
      cells[index] < 0
    ) {
      throw new TypeError(
        `${label}[${index}] must be a non-negative integer`
      );
    }
    if (seen.has(cells[index])) {
      throw new TypeError(`${label} must not contain duplicates`);
    }
    seen.add(cells[index]);
  }
  return cells;
}

/**
 * @param {{
 *   state: Object,
 *   viewer: Object,
 *   refreshUi: () => void,
 * }} options
 */
export function createJupyterCommandHandlers(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 3 ||
    !Object.hasOwn(options, 'state') ||
    !Object.hasOwn(options, 'viewer') ||
    !Object.hasOwn(options, 'refreshUi')
  ) {
    throw new TypeError(
      'Jupyter command handlers require exactly state, viewer, and refreshUi'
    );
  }
  if (typeof options.refreshUi !== 'function') {
    throw new TypeError('Jupyter command refreshUi must be a function');
  }
  const { state, viewer, refreshUi } = options;

  function handleHighlight(cells, color) {
    if (color === null) {
      requireCellIndices(cells, 'Jupyter clear-highlight cells');
      if (cells.length !== 0) {
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

    requireCellIndices(
      cells,
      'Jupyter highlight cells',
      { allowEmpty: false }
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
      label: `Python selection (${cells.length} cells)`,
      cellIndices: cells
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
