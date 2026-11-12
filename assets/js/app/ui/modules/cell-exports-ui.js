/**
 * @fileoverview The export buttons: the highlighted cells of the active page
 * as an obs-column CSV or an `.h5ad` subset (the Highlights list), and the
 * selected categorical or continuous field as an obs-column CSV (the Color by
 * field actions). The files are what `app/exports/cell-exports.js` writes;
 * Python's `cellucid.pull()` and R's `cellucid_pull()` read them back. An
 * agent, a notebook and a replay make the same files through the same path
 * (`cells.export`, `field.export`, `app/actions/definitions/exports.js`):
 * the same card with its Cancel, the file handed to the browser.
 *
 * @module ui/modules/cell-exports-ui
 */

import { fieldCsv, highlightsCsv, highlightsH5ad, highlightsH5adCost, saveExport } from '../../exports/cell-exports.js';
import { geneSampleCostText } from '../../../data/gene-read-plan.js';
import { useOpenCells } from '../../../data/open-cells-work.js';
import { formatBytes, formatCountOf, formatRemaining } from '../../../utils/format-units.js';
import { cancel, isCancellation, onAbort, throwIfAborted } from '../../../utils/abort.js';
import { failureDetails, sayFailure } from '../../../utils/errors.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { resolveField } from '../../actions/targets/fields.js';
import { resolvePage } from '../../actions/targets/pages.js';
import { FieldKind } from '../../utils/field-constants.js';
import { quoteName } from '../../actions/targets/names.js';

const NONE_FIELD_VALUE = '-1';

/**
 * What an `.h5ad` export's read of the expression rows costs, in words for
 * the card's Details (`highlightsH5adCost`).
 *
 * @param {{cells: number, bytes: number, keptBytes: number, requests: number, ms: number|null}} cost
 * @returns {string}
 */
function exportCostDetails(cost) {
  const parts = [
    `The expression rows of ${formatCountOf(cost.cells, 'cell')}: ${formatBytes(cost.bytes)} to read in about ${formatCountOf(cost.requests, 'request')}`,
    cost.ms === null ? 'its time is said once this connection is measured' : `${formatRemaining(cost.ms)} over this connection as measured`,
  ];
  if (cost.keptBytes > 0) parts.push(`${formatBytes(cost.keptBytes)} more is read from this browser's copy of the file`);
  return `${parts.join('; ')}. The obs names, fields and embeddings of the cells add little. Cancel stops it; nothing is saved then.`;
}

/**
 * @param {{
 *   state: Object,
 *   dom: {highlightsCsvButton: HTMLButtonElement, highlightsH5adButton: HTMLButtonElement,
 *     categoricalExportButton: HTMLButtonElement, continuousExportButton: HTMLButtonElement,
 *     categoricalSelect: HTMLSelectElement, continuousSelect: HTMLSelectElement},
 *   getAnnDataSource: () => Object|null,
 *   notifications: Object,
 *   actions?: {provide: Function, provideEstimate: Function}|null,
 * }} options - `actions`: the page's dispatcher, on which the buttons' exports are provided as
 *   `cells.export` and `field.export` (with the `.h5ad` subset's estimate of its reading)
 */
export function initCellExportsUi({ state, dom, getAnnDataSource, notifications, actions = null }) {
  const controller = new AbortController();
  const { signal } = controller;
  let busy = false;

  const adapterOf = () => {
    const adapter = getAnnDataSource()?.getAdapter?.() ?? null;
    if (adapter === null) throw new Error('This dataset names no cells to export.');
    return adapter;
  };

  /**
   * Make one export with the open cells in use (`useOpenCells`): it starts
   * once no growth step or Apply is changing them, and none commits until
   * it is written, so every row it reads is of the cells it began on. The
   * task reads the dataset's adapter and state when it starts, inside.
   * A button's export says its failure on its card; an action's
   * (`forAction`, stopped also by `caller`) rethrows it to its caller, and
   * resolves to the file handed to the browser.
   */
  async function run(label, task, { forAction = false, caller = null } = {}) {
    if (busy) {
      if (forAction) throw new ActionRefused('An export is being written: wait for it to finish.', { code: 'busy' });
      notifications.info('An export is being written: wait for it, or cancel it on its card.', { category: 'download' });
      return null;
    }
    busy = true;
    // Its own stop: the card's Cancel, or the controls going away, or the action's caller.
    const job = new AbortController();
    const stopWithControls = onAbort(signal, () => cancel(job, 'closed', 'The export controls were closed.'));
    const stopWithCaller = caller === null ? () => {} : onAbort(caller, () => cancel(job, 'user', `${label} was canceled.`));
    const progress = notifications.progress(`${label}…`, 0, {
      category: 'download',
      onCancel: () => cancel(job, 'user', `${label} was canceled.`),
    });
    try {
      // A file's size is said as soon as it is known (a CSV's after its
      // first rows), before the rest is written.
      let said = false;
      const report = (fraction, expectedBytes = null) => {
        const message = !said && Number.isFinite(expectedBytes) ? `${label} · about ${formatBytes(expectedBytes)}…` : null;
        said ||= message !== null;
        notifications.updateProgress(progress, Math.round(fraction * 100), message === null ? {} : { message });
      };
      // What the export will read, said before it reads it: one compact
      // line on the card, the parts in its Details.
      const tell = (line, details) => {
        notifications.updateProgress(progress, 0, { message: `${label} · ${line}…`, details });
      };
      const made = await useOpenCells(() => task(report, job.signal, tell), job.signal);
      // Stopped after its last read: nothing is handed to the browser.
      throwIfAborted(job.signal);
      saveExport(made);
      notifications.complete(progress, `${label}: ${made.filename} (${formatBytes(made.blob.size)})`, { announce: true });
      // Keys an .h5ad cannot name as they are ("/" in them, ".") are written renamed.
      if (made.renamed?.length > 0) {
        notifications.info(
          `Written under other names in ${made.filename}: ` +
          made.renamed.map(({ key, name }) => `"${key}" as "${name}"`).join(', ')
        );
      }
      return made;
    } catch (error) {
      if (isCancellation(error) || job.signal.aborted) {
        // Stopped, never failed: nothing is written (a read that failed
        // after Cancel was asked for is part of what was stopped).
        if (notifications.hasNotification?.(progress) ?? true) notifications.dismiss(progress);
      } else {
        console.error(`[Exports] ${label} failed:`, error);
        notifications.fail(progress, `${label} failed: ${sayFailure(error)}`, failureDetails(error));
      }
      if (forAction) throw error;
      return null;
    } finally {
      stopWithControls();
      stopWithCaller();
      busy = false;
    }
  }

  const refreshHighlights = () => {
    const pageId = state.getActivePageId();
    const count = pageId === null ? 0 : state.getHighlightedCellCountForPage(pageId);
    for (const button of [dom.highlightsCsvButton, dom.highlightsH5adButton]) button.hidden = count === 0;
  };

  const selectedIndex = select => (select.value === NONE_FIELD_VALUE || select.value === '' ? -1 : Number(select.value));
  // A button follows the field its select names, not whether the select is
  // enabled: the field selector disables both selects while the chosen
  // field loads and enables them after, with no event, so a button tied to
  // that stayed disabled after every choice. An export of a field still
  // loading waits for it (`fieldCsv`).
  const refreshFields = () => {
    dom.categoricalExportButton.disabled = selectedIndex(dom.categoricalSelect) < 0;
    dom.continuousExportButton.disabled = selectedIndex(dom.continuousSelect) < 0;
  };

  /** The highlighted cells of a page (`pageId` read when it starts: the page shown) as a CSV. */
  const exportHighlightsCsv = (pageOf, how) => run('Export the highlighted cells (CSV)', (report, stop) =>
    highlightsCsv({
      state,
      adapter: adapterOf(),
      pageId: pageOf(),
      onProgress: (done, total, expectedBytes) => report(done / total, expectedBytes),
      signal: stop,
    }), how);
  /** The highlighted cells of a page as an `.h5ad` subset, its reading's price said on its card first. */
  const exportHighlightsH5ad = (pageOf, how) => run('Export the highlighted cells (.h5ad)', async (report, stop, tell) => {
    const adapter = adapterOf();
    const pageId = pageOf();
    // Its price first, from the reader's model of the file (the one "Read
    // for all cells" states): no request is made for it.
    const cost = await highlightsH5adCost({ state, adapter, pageId }).catch(() => null);
    throwIfAborted(stop);
    if (cost !== null) {
      tell(`reads ${geneSampleCostText(cost, { compact: true })}`, exportCostDetails(cost));
    }
    return highlightsH5ad({
      state,
      adapter,
      pageId,
      onProgress: (done, total) => report(done / total),
      signal: stop,
    });
  }, how);
  /** A column of the cells (by its index among the obs fields) as a CSV. */
  const exportFieldCsv = (index, how) => run('Export the field (CSV)', (report, stop) => fieldCsv({
    state,
    adapter: adapterOf(),
    fieldIndex: index,
    onProgress: (done, total, expectedBytes) => report(done / total, expectedBytes),
    signal: stop,
  }), how);

  dom.highlightsCsvButton.addEventListener('click', () => {
    void exportHighlightsCsv(() => state.getActivePageId());
  }, { signal });
  dom.highlightsH5adButton.addEventListener('click', () => {
    void exportHighlightsH5ad(() => state.getActivePageId());
  }, { signal });
  for (const [button, select] of [
    [dom.categoricalExportButton, dom.categoricalSelect],
    [dom.continuousExportButton, dom.continuousSelect],
  ]) {
    button.addEventListener('click', () => {
      const index = selectedIndex(select);
      if (index < 0) return;
      void exportFieldCsv(index);
    }, { signal });
    select.addEventListener('change', refreshFields, { signal });
  }

  // ------------------------------------------------------------- as actions

  /** The page an action names (the page shown when it names none), with the cells highlighted on it. */
  function pageFor({ page }, type) {
    const target = page === undefined ? state.getHighlightPages().find(each => each.id === state.getActivePageId()) : resolvePage(state, page);
    if (target === undefined) throw new ActionRefused('No highlight page is shown.', { code: 'no-target', type });
    const cells = state.getHighlightedCellCountForPage(target.id);
    if (cells === 0) {
      throw new ActionRefused(`Highlight page ${quoteName(target.name)} highlights no cells, so there is nothing to export.`, { code: 'no-target', type });
    }
    return { page: target, cells };
  }

  const removers = actions === null ? [] : [
    actions.provide('cells.export', async (params, { signal: caller }) => {
      const { page, cells } = pageFor(params, 'cells.export');
      const how = { forAction: true, caller };
      const made = params.format === 'h5ad'
        ? await exportHighlightsH5ad(() => page.id, how)
        : await exportHighlightsCsv(() => page.id, how);
      return { file: made.filename, bytes: made.blob.size, format: params.format, page: page.name, cells, renamed: made.renamed ?? [] };
    }),
    // What an `.h5ad` subset reads, from the reader's model of the file: the agent's permissions judge heavy work by it.
    actions.provideEstimate('cells.export', async params => {
      if (params.format !== 'h5ad') return null;
      const { page } = pageFor(params, 'cells.export');
      const adapter = getAnnDataSource()?.getAdapter?.() ?? null;
      const cost = adapter === null ? null : await highlightsH5adCost({ state, adapter, pageId: page.id }).catch(() => null);
      if (cost === null) return null;
      return { ms: cost.ms ?? null, bytes: cost.bytes ?? null, what: `Reads ${geneSampleCostText(cost, { compact: true })} for the .h5ad` };
    }),
    actions.provide('field.export', async ({ field }, { signal: caller }) => {
      const { index, field: target } = resolveField(state, field);
      if (target.kind !== FieldKind.CATEGORY && target.kind !== FieldKind.CONTINUOUS) {
        throw new ActionRefused(`${quoteName(field.key)} is neither categorical nor continuous, so it has no CSV export.`, { code: 'wrong-kind', type: 'field.export' });
      }
      const made = await exportFieldCsv(index, { forAction: true, caller });
      return { file: made.filename, bytes: made.blob.size, field: target.key, kind: target.kind === FieldKind.CATEGORY ? 'categorical' : 'continuous' };
    }),
  ];
  const unsubscribers = [
    state.on('highlight:changed', refreshHighlights),
    state.on('page:changed', refreshHighlights),
    state.on('field:changed', refreshFields),
    // A field chosen in code (a session, the notebook) recolors the cells.
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
      for (const remove of removers) remove();
      cancel(controller, 'closed', 'The export controls were closed.');
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
