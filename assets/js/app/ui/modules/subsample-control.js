/**
 * @fileoverview Cells to open (Session accordion, Open data): how much of a
 * dataset is read, as a share of its cells, and how the cells are chosen
 * (`data/subsample.js`). One slider and its exact count; below 100 % the
 * method, its seed and what the method needs (a field to stratify by, an
 * embedding) appear, with Apply.
 *
 * Apply reads the open dataset again in place with the chosen cells
 * (`dataset-controls.js`, `reopenOpenDataset`), carrying highlights and
 * labels across by original cell position (`cell-subset-carry.js`), and
 * makes the choice this tab's for datasets opened next
 * (`data/cell-subset-policy.js`). A dataset too large for this device opens
 * fitted to it (`subsample-plan.js`, auto-fit): the control says so, with
 * Open all cells.
 *
 * @module ui/modules/subsample-control
 */

import {
  getTabCellSubsetRequest,
  setTabCellSubsetRequest,
} from '../../../data/cell-subset-policy.js';
import {
  DEFAULT_GRID_SIZE,
  FEWEST_OPEN_CELLS,
  FEWEST_OPEN_CELLS_REASON,
  countFromShare,
  describeSubsampleMethod,
} from '../../../data/subsample.js';
import { captureCarried, describeCarried, restoreCarried, takeInNewCells } from '../../cell-subset-carry.js';
import { formatBytes, formatCount, formatCountOf } from '../../../utils/format-units.js';
import { readDataSourceUrlParameters } from '../../url-state.js';
import { SUBSAMPLE_URL_PARAMETERS, subsampleLink } from '../../subsample-url.js';

const DOM_KEYS = Object.freeze([
  'root', 'slider', 'percent', 'count', 'settings', 'method', 'seed',
  'fieldRow', 'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'openAll', 'copyLink',
]);

/**
 * The cells a share of `nObs` stands for (`countFromShare`); none for a
 * share of 0 %.
 *
 * @param {number} percent
 * @param {number} nObs
 * @returns {number}
 */
export function shareCount(percent, nObs) {
  return percent > 0 ? countFromShare(String(percent), nObs, { percent: true }) : 0;
}

/**
 * The words under the slider: the exact count the share stands for, and
 * why it cannot be opened when it is under the fewest cells the viewer
 * draws (`FEWEST_OPEN_CELLS`).
 *
 * @param {number} percent
 * @param {number} nObs
 * @returns {string}
 */
export function describeShare(percent, nObs) {
  if (!(nObs > 0)) return '';
  if (percent >= 100) return `All ${formatCountOf(nObs, 'cell')}`;
  const k = shareCount(percent, nObs);
  const share = `${formatCount(k)} of ${formatCountOf(nObs, 'cell')}`;
  return k < FEWEST_OPEN_CELLS
    ? `${share}: ${FEWEST_OPEN_CELLS_REASON}, so at least ${formatCountOf(FEWEST_OPEN_CELLS, 'cell')} open.`
    : share;
}

/**
 * What the control says of the cells open now, or '' for every cell.
 *
 * @param {Object|null} subset - `AnnDataFileSource.getCellSubset()`
 * @returns {string}
 */
export function describeOpenCells(subset) {
  if (subset === null || subset.kept === null) return subset?.note ?? '';
  const parts = [];
  if (subset.autoFit !== null) {
    const what = subset.autoFit.limit === 'columnIndex'
      ? 'reading its genes would hold'
      : 'its cells would hold';
    parts.push(
      `Opened ${formatCount(subset.kept.length)} of ${formatCountOf(subset.nObs, 'cell')} (${describeSubsampleMethod(subset.spec)}) to fit this device: `
      + `${what} ${formatBytes(subset.autoFit.neededBytes)} in memory, and this device has ${formatBytes(subset.autoFit.budgetBytes)} for it.`
    );
  } else {
    parts.push(`Open: ${formatCount(subset.kept.length)} of ${formatCountOf(subset.nObs, 'cell')} (${describeSubsampleMethod(subset.spec)}).`);
  }
  if (subset.spec?.method === 'blocks') parts.push('Cells next to each other in the file are kept together.');
  // A priority-ordered file reads only its share for a uniform subsample
  // under its own seed; anything else lies throughout it.
  if (subset.prioritySeed !== null && subset.prioritySeed !== undefined && subset.prefix === null) {
    parts.push(`This file is stored in priority order: uniform with its seed (${subset.prioritySeed}) reads only the share of cells it keeps; these cells lie throughout it, so more of it is read.`);
  }
  // What reading genes costs: the share of the matrix's chunks the kept
  // cells lie in, said when it is well above the share of the cells.
  const share = subset.matrixChunkShare;
  if (typeof share === 'number' && share > 1.5 * (subset.kept.length / subset.nObs)) {
    parts.push(`Reading genes fetches ${Math.round(100 * share)} % of the matrix for these ${(100 * subset.kept.length / subset.nObs).toPrecision(2)} % of the cells (blocks fetch about their share).`);
  }
  if (subset.reproduced === false) parts.push("These are the session's own cells; its settings no longer give exactly these.");
  if (subset.note) parts.push(`${subset.note}.`);
  return parts.join(' ');
}

/**
 * How evenly a subsample represents a categorical field, or '' when it is
 * not known: the largest difference between a category's share of the open
 * cells and its share of every cell.
 *
 * @param {{field: string, largestDeviation: number, category: string|null}|null} representation
 * @returns {string}
 */
export function describeRepresentation(representation) {
  if (representation === null || representation === undefined) return '';
  const points = (100 * representation.largestDeviation).toFixed(representation.largestDeviation < 0.001 ? 2 : 1);
  // No category stands out when every share rounds to the same.
  if (Number(points) === 0) return `Every category of ${representation.field} keeps its share of every cell.`;
  const which = representation.category === null ? 'cells without a category' : representation.category;
  return `Largest difference from every cell in ${representation.field}: ${points} percentage points (${which}).`;
}

/**
 * @param {{dom: Object, state: Object, getCellSubset: () => (Object|null),
 *   reopen: (cellSubset: Object) => Promise<{shown: boolean, inPlace: boolean}>, notify?: (text: string) => void,
 *   representation?: (key: string) => Promise<Object|null>}} options
 *   `representation`: how the open subsample represents a categorical field
 *   (`AnnDataFileSource.subsampleRepresentation`)
 * @returns {{refresh: () => void, showGrowth: (progress: {cells: number, target: number}|null) => void, showOpenCells: () => void, destroy: () => void}}
 */
export function initSubsampleControl({ dom, state, getCellSubset, reopen, notify = () => {}, representation = async () => null, viewCarry = null }) {
  for (const key of DOM_KEYS) {
    if (!dom?.[key]) throw new TypeError(`The cells-to-open control needs its ${key}.`);
  }
  const lifecycle = new AbortController();
  const on = (element, event, handler) => element.addEventListener(event, handler, { signal: lifecycle.signal });
  let busy = false;
  // A progressive opening growing in place: `{cells, target}`, or null.
  let growth = null;
  // Whether the person changed a setting since the control last showed the
  // open cells: a growth step then leaves the settings as they are.
  let edited = false;
  // How the subsample open now represents the field it is judged by.
  let represented = '';
  let representationRequest = 0;

  function nObsOf(subset) {
    return subset?.nObs ?? state.pointCount ?? 0;
  }

  function percentShown() {
    const value = Number(dom.percent.value);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
  }

  function fillChoices(subset) {
    const fields = (state.obsData?.fields ?? []).filter(field => field?.kind === 'category' && field._isUserDefined !== true);
    const chosenField = subset?.spec?.field ?? dom.field.value;
    dom.field.replaceChildren(...fields.map(field => new Option(field.key, field.key, false, field.key === chosenField)));
    const layouts = state.getMappingCandidates?.()?.obsm ?? null;
    const embeddings = Array.isArray(layouts) ? layouts.filter(item => item.usable).map(item => item.key) : [];
    const chosenEmbedding = subset?.spec?.embedding ?? dom.embedding.value;
    dom.embedding.replaceChildren(...embeddings.map(key => new Option(key, key, false, key === chosenEmbedding)));
  }

  /**
   * The method and seed a request that names none takes on this file
   * (`subsample-plan.js`, `defaultSubsampleMethod`): a priority-ordered
   * file's uniform under its own seed, else blocks with seed 0.
   */
  function fileDefaults(subset) {
    const seed = subset?.prioritySeed ?? null;
    return seed === null ? { method: 'blocks', seed: 0 } : { method: 'uniform', seed };
  }

  /**
   * The open subsample's exact count while the share has not been edited:
   * the shown percentage is rounded for display and must not change it.
   */
  let exactK = null;

  /** The request the control describes now; a method or seed left unset is the file's. */
  function chosenRequest() {
    const percent = percentShown();
    if (percent >= 100) return { mode: 'all' };
    const request = { mode: 'subsample' };
    if (dom.method.value !== '') request.method = dom.method.value;
    if (exactK !== null) request.k = exactK;
    else request.percent = String(percent);
    if (dom.seed.value.trim() !== '') request.seed = Math.max(0, Math.min(0xffffffff, Math.trunc(Number(dom.seed.value) || 0)));
    if (request.method === 'stratified') {
      request.field = dom.field.value;
      request.allocation = dom.balanced.checked ? 'balanced' : 'proportional';
    }
    if (request.method === 'spatial') {
      if (dom.embedding.value !== '') request.embedding = dom.embedding.value;
      request.gridSize = DEFAULT_GRID_SIZE;
    }
    return request;
  }

  function sameAsOpen(subset) {
    const percent = percentShown();
    if (subset === null) return false;
    if (subset.kept === null) return percent >= 100;
    if (percent >= 100) return false;
    const request = chosenRequest();
    const spec = subset.spec;
    const defaults = fileDefaults(subset);
    const k = request.k ?? shareCount(Number(request.percent), subset.nObs);
    return k === spec.k && (request.method ?? defaults.method) === spec.method && (request.seed ?? defaults.seed) === spec.seed &&
      (spec.method !== 'stratified' || (request.field === spec.field && request.allocation === spec.allocation)) &&
      (spec.method !== 'spatial' || request.embedding === undefined || request.embedding === spec.embedding);
  }

  function render() {
    const subset = getCellSubset();
    const percent = percentShown();
    dom.count.textContent = describeShare(percent, nObsOf(subset));
    dom.settings.hidden = percent >= 100;
    dom.fieldRow.hidden = dom.method.value !== 'stratified';
    dom.embeddingRow.hidden = dom.method.value !== 'spatial';
    // A share of fewer cells than the viewer draws is not offered
    // (`describeShare` says why).
    const tooFew = percent < 100 && (exactK ?? shareCount(percent, nObsOf(subset))) < FEWEST_OPEN_CELLS;
    dom.apply.disabled = busy || subset === null || tooFew || sameAsOpen(subset) ||
      (dom.method.value === 'stratified' && percent < 100 && dom.field.value === '');
    // The cells' digest: two people who see the same one see the same cells.
    const digest = subset?.kept != null ? `Cell set ${state.cellIdentity.digest}.` : '';
    // While a progressive opening grows, what it grows to is what is open.
    const notice = (growth !== null
      ? [describeGrowth(growth)]
      : [describeOpenCells(subset), digest, subset?.kept != null ? represented : '']).filter(Boolean).join(' ');
    dom.notice.textContent = notice;
    dom.notice.hidden = notice === '';
    dom.openAll.hidden = !(subset?.kept != null && subset.autoFit !== null);
    dom.copyLink.hidden = !(subset?.kept != null && datasetParameters().size > 0);
    // The buttons show only when one of them has something to do: every
    // cell open and 100 % chosen leaves the control at its slider.
    dom.actions.hidden = !busy && dom.apply.disabled && dom.openAll.hidden && dom.copyLink.hidden;
  }

  /**
   * The field a subsample is judged by: its stratifying field, else the
   * categorical obs field shown now, else the first categorical one.
   */
  function judgedField(subset) {
    if (subset?.spec?.field) return subset.spec.field;
    const fields = state.obsData?.fields ?? [];
    const shown = state.activeFieldSource === 'obs' ? fields[state.activeFieldIndex] : null;
    const usable = field => field?.kind === 'category' && field._isUserDefined !== true;
    return (usable(shown) ? shown : fields.find(usable))?.key ?? null;
  }

  /** The parameters that name the open dataset in a link (none for a local file). */
  function datasetParameters() {
    const params = readDataSourceUrlParameters(window.location.href);
    for (const name of SUBSAMPLE_URL_PARAMETERS) params.delete(name);
    return params;
  }

  /** Copy a link that opens this dataset with exactly the subsample open now. */
  async function copyLink() {
    const subset = getCellSubset();
    if (subset?.kept == null) return;
    const link = subsampleLink(window.location.href, datasetParameters(), subset.spec);
    try {
      await navigator.clipboard.writeText(link);
      notify(`Copied a link that opens these ${formatCountOf(subset.kept.length, 'cell')} (cells ${state.cellIdentity.digest}).`);
    } catch {
      notify(`Link to these cells: ${link}`);
    }
  }

  /** Show the cells open now (a dataset was opened or read again). */
  function refresh() {
    const subset = getCellSubset();
    edited = false;
    represented = '';
    const request = ++representationRequest;
    const key = subset?.kept != null ? judgedField(subset) : null;
    if (key !== null) {
      representation(key).then(result => {
        if (request !== representationRequest) return;
        represented = describeRepresentation(result);
        render();
      }, () => {});
    }
    fillChoices(subset);
    // A progressive opening shows the share it grows to.
    const openCount = growth !== null ? growth.target : subset?.kept != null ? subset.kept.length : null;
    const percent = openCount !== null && subset !== null ? (100 * openCount) / subset.nObs : 100;
    const shown = Number(percent.toPrecision(4));
    dom.percent.value = String(shown);
    dom.slider.value = String(shown);
    exactK = openCount !== null && openCount < (subset?.nObs ?? 0) ? openCount : null;
    const defaults = fileDefaults(subset);
    dom.method.options[0].textContent = defaults.method === 'uniform'
      ? `This file's default: uniform in its stored order (seed ${defaults.seed}), reads only its share`
      : "This file's default: blocks aligned to how it is stored, reads only their share";
    dom.seed.placeholder = `This file's (${defaults.seed})`;
    if (subset?.spec) {
      const isDefault = subset.spec.method === defaults.method && subset.spec.seed === defaults.seed;
      dom.method.value = isDefault ? '' : subset.spec.method;
      dom.seed.value = isDefault ? '' : String(subset.spec.seed);
      dom.balanced.checked = subset.spec.allocation === 'balanced';
    } else {
      const tab = getTabCellSubsetRequest();
      dom.method.value = tab.mode === 'subsample' ? (tab.method ?? '') : '';
      dom.seed.value = tab.mode === 'subsample' && tab.seed !== undefined ? String(tab.seed) : '';
    }
    render();
  }

  /**
   * Read the open dataset again with the cells `cellSubset` asks for,
   * keeping what the person made and where they were: highlights and labels
   * by original cell position (`cell-subset-carry.js`), and the views
   * (cameras, layout), each view's active field and filters, the sidebar
   * controls and the analysis windows (`viewCarry`, the session's records of
   * them). The cells newly open then join what is derived from the file (a
   * label made from a column, a category or range group), as growing in
   * place gives the cells added (`takeInNewCells`).
   */
  async function reopenKeeping(cellSubset) {
    const carried = captureCarried(state);
    const view = viewCarry === null ? null : viewCarry.capture();
    const { shown, inPlace } = await reopen(cellSubset);
    // Cells grown or cut in place kept everything shown
    // (`app/open-cells-resize.js`); a new reading gets it back.
    if (shown !== true || inPlace === true) return;
    // Labels first: a view may be coloured by one.
    const restored = restoreCarried(state, carried);
    const lost = view === null ? [] : await viewCarry.restore(view);
    await takeInNewCells(state, carried, restored);
    const said = describeCarried(restored);
    if (said !== '') notify(said);
    for (const reason of lost) notify(`Not kept after reading the cells again — ${reason}`);
  }

  async function apply(request) {
    if (busy) return;
    const subset = getCellSubset();
    if (subset === null) return;
    busy = true;
    render();
    try {
      // The open dataset is read with exactly this many cells; datasets
      // opened next take the same share.
      const exact = request.mode === 'subsample'
        ? { ...request, k: request.k ?? shareCount(Number(request.percent), subset.nObs), percent: undefined, strict: true }
        : request;
      // Datasets opened next take the share shown.
      const tab = request.mode === 'subsample' ? { ...request, k: undefined, percent: String(percentShown()) } : request;
      if (request.mode !== 'kept') setTabCellSubsetRequest(request.mode === 'all' ? { mode: 'all' } : tab);
      await reopenKeeping(exact);
    } finally {
      busy = false;
      refresh();
    }
  }

  on(dom.slider, 'input', () => {
    edited = true;
    exactK = null;
    dom.percent.value = dom.slider.value;
    render();
  });
  on(dom.percent, 'input', () => {
    edited = true;
    exactK = null;
    dom.slider.value = String(percentShown());
    render();
  });
  for (const element of [dom.method, dom.seed, dom.field, dom.balanced, dom.embedding]) {
    on(element, 'change', () => {
      edited = true;
      render();
    });
  }
  on(dom.apply, 'click', () => { void apply(chosenRequest()); });
  on(dom.copyLink, 'click', () => { void copyLink(); });
  on(dom.openAll, 'click', () => {
    // Every cell of this dataset; the tab keeps fitting datasets opened next.
    void (async () => {
      if (busy) return;
      busy = true;
      render();
      try {
        await reopenKeeping({ mode: 'all' });
      } finally {
        busy = false;
        refresh();
      }
    })();
  });
  /**
   * The open cells changed in place (a growth step, an Apply): the count
   * line follows them; settings the person is changing stay as they are.
   */
  function showOpenCells() {
    if (edited) render();
    else refresh();
  }

  refresh();
  return {
    refresh,
    /**
     * Say how far a progressive opening has grown (`{cells, target}`), or
     * that it is done (null): the control shows the cells open so far.
     */
    showGrowth(progress) {
      growth = progress;
      showOpenCells();
    },
    showOpenCells,
    destroy() {
      lifecycle.abort();
    },
  };
}

/**
 * What the control says of a progressive opening under way, or ''.
 * Grown from few chunks (`chunked`), the cells open so far are those of the
 * parts of the file read so far, not a sample of the cells asked for.
 *
 * @param {{cells: number, target: number, chunked?: boolean}|null} growth
 * @returns {string}
 */
export function describeGrowth(growth) {
  if (growth === null) return '';
  const open = `Reading the cells asked for: ${formatCount(growth.cells)} of ${formatCountOf(growth.target, 'cell')} open so far`;
  return growth.chunked === true
    ? `${open}, those in the parts of the file read so far (not yet a sample of them).`
    : `${open}, each step a sample of them.`;
}
