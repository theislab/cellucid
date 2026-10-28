/**
 * @fileoverview The export buttons: the highlighted cells of the active page
 * as an obs-name CSV or an `.h5ad` subset (the Highlights list), and the
 * selected categorical or continuous field as an obs-column CSV (the Color by
 * field actions). The files are what `app/exports/cell-exports.js` writes;
 * Python's `cellucid.pull()` and R's `cellucid_pull()` read them back.
 *
 * @module ui/modules/cell-exports-ui
 */

import { fieldCsv, highlightsCsv, highlightsH5ad, saveExport } from '../../exports/cell-exports.js';

const NONE_FIELD_VALUE = '-1';

/**
 * @param {{
 *   state: Object,
 *   dom: {highlightsCsvButton: HTMLButtonElement, highlightsH5adButton: HTMLButtonElement,
 *     categoricalExportButton: HTMLButtonElement, continuousExportButton: HTMLButtonElement,
 *     categoricalSelect: HTMLSelectElement, continuousSelect: HTMLSelectElement},
 *   getAnnDataSource: () => Object|null,
 *   notifications: Object,
 * }} options
 */
export function initCellExportsUi({ state, dom, getAnnDataSource, notifications }) {
  const controller = new AbortController();
  const { signal } = controller;
  let busy = false;

  const adapterOf = () => {
    const adapter = getAnnDataSource()?.getAdapter?.() ?? null;
    if (adapter === null) throw new Error('This dataset names no cells to export.');
    return adapter;
  };

  async function run(label, task) {
    if (busy) return;
    busy = true;
    const progress = notifications.progress(`${label}…`, 0, { category: 'download' });
    try {
      const made = await task(fraction => notifications.updateProgress(progress, Math.round(fraction * 100)));
      saveExport(made);
      notifications.complete(progress, `${label}: ${made.filename}`);
      // Keys an .h5ad cannot name as they are ("/" in them, ".") are written renamed.
      if (made.renamed?.length > 0) {
        notifications.info(
          `Written under other names in ${made.filename}: ` +
          made.renamed.map(({ key, name }) => `"${key}" as "${name}"`).join(', ')
        );
      }
    } catch (error) {
      console.error(`[Exports] ${label} failed:`, error);
      notifications.fail(progress, `${label} failed: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  const refreshHighlights = () => {
    const pageId = state.getActivePageId();
    const count = pageId === null ? 0 : state.getHighlightedCellCountForPage(pageId);
    for (const button of [dom.highlightsCsvButton, dom.highlightsH5adButton]) button.hidden = count === 0;
  };

  const selectedIndex = select => (select.value === NONE_FIELD_VALUE || select.value === '' ? -1 : Number(select.value));
  const refreshFields = () => {
    dom.categoricalExportButton.disabled = dom.categoricalSelect.disabled || selectedIndex(dom.categoricalSelect) < 0;
    dom.continuousExportButton.disabled = dom.continuousSelect.disabled || selectedIndex(dom.continuousSelect) < 0;
  };

  dom.highlightsCsvButton.addEventListener('click', () => {
    void run('Export the highlighted cells (CSV)', () =>
      highlightsCsv({ state, adapter: adapterOf(), pageId: state.getActivePageId() }));
  }, { signal });
  dom.highlightsH5adButton.addEventListener('click', () => {
    void run('Export the highlighted cells (.h5ad)', report =>
      highlightsH5ad({
        state,
        adapter: adapterOf(),
        pageId: state.getActivePageId(),
        onProgress: (done, total) => report(done / total),
      }));
  }, { signal });
  for (const [button, select] of [
    [dom.categoricalExportButton, dom.categoricalSelect],
    [dom.continuousExportButton, dom.continuousSelect],
  ]) {
    button.addEventListener('click', () => {
      const index = selectedIndex(select);
      if (index < 0) return;
      void run('Export the field (CSV)', () => fieldCsv({ state, adapter: adapterOf(), fieldIndex: index }));
    }, { signal });
    select.addEventListener('change', refreshFields, { signal });
  }
  const unsubscribers = [
    state.on('highlight:changed', refreshHighlights),
    state.on('page:changed', refreshHighlights),
    state.on('field:changed', refreshFields),
    // A field chosen in code (a session, the notebook) recolours the cells.
    state.on('visibility:changed', refreshFields),
  ];
  refreshHighlights();
  refreshFields();

  return {
    /** The buttons follow the selection the field selector shows now. */
    refresh() {
      refreshHighlights();
      refreshFields();
    },
    destroy() {
      controller.abort();
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
