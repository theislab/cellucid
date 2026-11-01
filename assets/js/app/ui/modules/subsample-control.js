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
 * What is open is said in one short line (`openCellsStatus`), and the facts
 * behind it in a Details table (`openCellsFacts`, drawn by
 * `renderFactList`): rows of label, short value and the longer text as its
 * title, the same rows the gene-cost wording is made of
 * (`data/gene-read-plan.js`).
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
  describeSubsampleChoice,
  describeSubsampleMethod,
} from '../../../data/subsample.js';
import { captureCarried, describeCarried, restoreCarried, takeInNewCells } from '../../cell-subset-carry.js';
import { formatBytes, formatCount, formatCountOf, parseDecimalText } from '../../../utils/format-units.js';
import { geneReadPlanFacts, geneSampleFacts } from '../../../data/gene-read-plan.js';
import { cellShareReadShare } from '../../../data/anndata/subsample-plan.js';
import { renderFactList } from '../components/controls.js';
import { readDataSourceUrlParameters } from '../../url-state.js';
import { SUBSAMPLE_URL_PARAMETERS, subsampleLink } from '../../subsample-url.js';
import { onAbort } from '../../../utils/abort.js';

const DOM_KEYS = Object.freeze([
  'root', 'slider', 'percent', 'count', 'settings', 'method', 'seed',
  'fieldRow', 'field', 'balanced', 'embeddingRow', 'embedding', 'actions', 'apply', 'notice', 'details', 'detailsList',
  'openAll', 'copyLink', 'useBlocks',
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
 * @param {number} [k] - The exact count, when it is known (the open
 *   subsample's: the share shown is rounded)
 * @returns {string}
 */
export function describeShare(percent, nObs, k = shareCount(percent, nObs)) {
  if (!(nObs > 0)) return '';
  // "All" only when every cell is: a share that rounds to 100 % of more
  // cells than it opens says how many.
  if (k >= nObs) return `All ${formatCountOf(nObs, 'cell')}`;
  const share = `${formatCount(k)} of ${formatCountOf(nObs, 'cell')}`;
  return k < FEWEST_OPEN_CELLS
    ? `${share}: ${FEWEST_OPEN_CELLS_REASON}, so at least ${formatCountOf(FEWEST_OPEN_CELLS, 'cell')} open.`
    : share;
}

/**
 * The share `k` of `nObs` cells is, as the box and the slider show it: four
 * significant figures, more when four would round a subsample up to 100
 * (99,996 of 100,000 cells is "99.996", never "100"), so the box says 100
 * only when every cell is open.
 *
 * @param {number} k
 * @param {number} nObs
 * @returns {number}
 */
export function shareShown(k, nObs) {
  if (k >= nObs) return 100;
  const percent = (100 * k) / nObs;
  let figures = 4;
  while (figures < 17 && Number(percent.toPrecision(figures)) >= 100) figures += 1;
  return Number(percent.toPrecision(figures));
}

/** A sentence's first letter in upper case. */
const sentence = text => `${text[0].toUpperCase()}${text.slice(1)}`;

/**
 * The one short line under the settings: how the open cells were chosen, or
 * what needs the person's attention (`tone` `warning`: the session's own
 * cells no longer reproduced by its settings, a method the dataset cannot
 * take), or how far a progressive opening has grown (`growing`). Empty for
 * every cell. The facts behind it are `openCellsFacts`, under Details.
 *
 * @param {Object|null} subset - `AnnDataFileSource.getCellSubset()`
 * @param {{cells: number, target: number, chunked?: boolean}|null} [growth]
 * @returns {{text: string, tone: 'muted'|'warning', growing: boolean}}
 */
export function openCellsStatus(subset, growth = null) {
  if (growth !== null) {
    return { text: `Reading ${formatCount(growth.cells)} of ${formatCountOf(growth.target, 'cell')}…`, tone: 'muted', growing: true };
  }
  if (subset?.note) return { text: `${subset.note}.`, tone: 'warning', growing: false };
  // Every cell open: nothing to say. Genes read for a sample of them
  // (`genes`) is the control below (`gene-read-control.js`).
  if (subset === null || subset.kept === null) return { text: '', tone: 'muted', growing: false };
  if (subset.reproduced === false) {
    return { text: "The session's own cells: its settings no longer give exactly these.", tone: 'warning', growing: false };
  }
  const how = describeSubsampleMethod(subset.spec);
  if (subset.autoFit != null) return { text: `Fitted to this device: ${how}.`, tone: 'muted', growing: false };
  return { text: `${sentence(how)}.`, tone: 'muted', growing: false };
}

/**
 * What a share asked for (not yet applied) reads of the file, when that is
 * far more than its share of the cells: the cells of a scattered method lie
 * in nearly every stored chunk, so a 1 % uniform share of a 10M-cell `.h5ad`
 * reads as much as every cell (`cellShareReadShare`, from the layout the
 * open cells came with: `readLayout`). Which method is scattered depends on
 * the file's order: on a file in its own order, every method but `blocks`
 * (runs of neighbouring cells); on a priority-ordered file (Cellucid's),
 * every method but uniform under the file's own seed (its first rows),
 * `blocks` included, whose runs of original positions lie throughout it.
 * Said before Apply, in one line, with what the cheap method reads instead
 * (`alternative`: `blocks`, or `file`: the file's own order); null when the
 * share costs about its cells, the layout says nothing, or every cell.
 *
 * @param {Object|null} subset - `AnnDataFileSource.getCellSubset()`
 * @param {{method: string, seed: number|null, fraction: number}} request - The share asked for
 * @returns {{text: string, title: string, read: number, cheap: number, alternative: 'blocks'|'file'}|null}
 */
export function scatteredShareCost(subset, { method, seed, fraction }) {
  if (subset === null || !(fraction > 0 && fraction < 1)) return null;
  const priorityFile = subset.prioritySeed != null;
  const cheapAsked = priorityFile
    ? method === 'uniform' && (seed ?? subset.prioritySeed) === subset.prioritySeed
    : method === 'blocks';
  // The cheap method reads about its share ('blocks' prices a share); the
  // asked one, scattered, every chunk one of its cells lies in.
  const read = cellShareReadShare(subset.readLayout ?? null, fraction, cheapAsked ? 'blocks' : 'uniform');
  const cheap = cellShareReadShare(subset.readLayout ?? null, fraction, 'blocks');
  if (read === null || cheap === null || read < 0.5 || read < 3 * cheap) return null;
  const percent = share => `${share >= 0.995 ? 100 : Math.max(1, Math.round(100 * share))} %`;
  const cells = `${(100 * fraction).toPrecision(2)} %`;
  const alternative = priorityFile ? 'file' : 'blocks';
  const instead = priorityFile ? "this file's own order reads" : 'blocks read';
  return {
    text: `Reads about ${percent(read)} of the file for ${cells} of its cells; ${instead} about ${percent(cheap)}.`,
    title: priorityFile
      ? `These cells lie throughout the file, so nearly every stored chunk holds one and is read whole: about as much as every cell takes. Uniform with this file's own seed (${subset.prioritySeed}) reads only its first cells, about their share.`
      : 'These cells lie throughout the file, so nearly every stored chunk holds one and is read whole: about as much as every cell takes. Blocks keep runs of neighbouring cells and read about their share.',
    read,
    cheap,
    alternative,
  };
}

/**
 * How evenly a subsample represents a categorical field, as a Details row,
 * or null when it is not known: the largest difference between a
 * category's share of the open cells and its share of every cell.
 *
 * @param {{field: string, largestDeviation: number, category: string|null}|null} representation
 * @returns {import('../components/controls.js').FactRow|null}
 */
export function representationFact(representation) {
  if (representation === null || representation === undefined) return null;
  const points = (100 * representation.largestDeviation).toFixed(representation.largestDeviation < 0.001 ? 2 : 1);
  // No category stands out when every share rounds to the same.
  if (Number(points) === 0) {
    return { label: 'Categories', value: `${representation.field}: every category keeps its share`, title: `Every category of ${representation.field} keeps its share of every cell.` };
  }
  const which = representation.category === null ? 'cells without a category' : representation.category;
  return {
    label: 'Categories',
    value: `${representation.field}: within ${points} percentage points (${which})`,
    title: `Largest difference from every cell in ${representation.field}: ${points} percentage points (${which}).`,
  };
}

/**
 * The facts behind the status line, as rows of the Details table
 * (`renderFactList`): the cells open, how they were chosen and with which
 * seed, why this many (fitted to the device's memory), what reading them
 * costs on how the file is stored, the cell set's digest, how well a field
 * is represented, the cells a gene is read for and why (`genes`,
 * `geneSampleFacts`, with what the file's layout makes a gene cost), and
 * what a gene costs now (`geneCost`, `geneReadPlanFacts`' rows, once
 * known). For every cell open, only the gene sample's.
 *
 * @param {Object|null} subset - `AnnDataFileSource.getCellSubset()`
 * @param {{growth?: {cells: number, target: number, chunked?: boolean}|null, digest?: string|null,
 *   representation?: import('../components/controls.js').FactRow|null,
 *   geneCost?: import('../components/controls.js').FactRow[]|null}} [extra]
 * @returns {import('../components/controls.js').FactRow[]}
 */
export function openCellsFacts(subset, { growth = null, digest = null, representation = null, geneCost = null } = {}) {
  const rows = [];
  if (growth !== null) {
    rows.push({
      label: 'Reading',
      value: `${formatCount(growth.cells)} of ${formatCountOf(growth.target, 'cell')} so far`,
      title: growth.chunked === true
        ? 'The cells asked for, read in steps: those open so far are those in the parts of the file read so far, not yet a sample of them.'
        : 'The cells asked for, read in steps: those open so far are a sample of them.',
    });
  }
  if (subset?.note) rows.push({ label: 'Note', value: `${subset.note}.` });
  if (subset === null || subset.kept === null) return [...rows, ...geneSampleFacts(subset?.genes ?? null)];
  const k = subset.kept.length;
  rows.push({ label: 'Open', value: `${formatCount(k)} of ${formatCountOf(subset.nObs, 'cell')}` });
  rows.push({
    label: 'Chosen by',
    value: describeSubsampleChoice(subset.spec),
    title: subset.spec.method === 'blocks' ? 'Cells next to each other in the file are kept together.' : null,
  });
  rows.push({
    label: 'Seed',
    value: String(subset.spec.seed),
    title: subset.prioritySeed != null && subset.spec.seed === subset.prioritySeed ? "This file's own seed." : null,
  });
  if (subset.reproduced === false) {
    rows.push({ label: 'Cells', value: "the session's own", title: "These are the session's own cells; its settings no longer give exactly these." });
  }
  const fit = subset.autoFit ?? null;
  if (fit !== null) {
    const what = fit.limit === 'columnIndex' ? 'reading its genes would hold' : 'its cells would hold';
    rows.push({
      label: 'Fitted to',
      value: `this device: needs ${formatBytes(fit.neededBytes)}, has ${formatBytes(fit.budgetBytes)}`,
      title: `${sentence(what)} ${formatBytes(fit.neededBytes)} in memory, and this device has ${formatBytes(fit.budgetBytes)} for it.`,
    });
  }
  // A priority-ordered file reads only its share for a uniform subsample
  // under its own seed; anything else lies throughout it.
  if (subset.prioritySeed !== null && subset.prioritySeed !== undefined && subset.prefix === null) {
    rows.push({
      label: 'Stored order',
      value: `priority (seed ${subset.prioritySeed}); these cells lie throughout it`,
      title: `This file is stored in priority order: uniform with its seed (${subset.prioritySeed}) reads only the share of cells it keeps; these cells lie throughout it, so more of it is read.`,
    });
  }
  // What reading genes costs: the share of the matrix's chunks the kept
  // cells lie in, said when it is well above the share of the cells.
  const share = subset.matrixChunkShare;
  if (typeof share === 'number' && share > 1.5 * (k / subset.nObs)) {
    rows.push({
      label: 'Matrix read',
      value: `${Math.round(100 * share)} % for ${(100 * k / subset.nObs).toPrecision(2)} % of the cells`,
      title: `Reading genes fetches ${Math.round(100 * share)} % of the matrix for these ${(100 * k / subset.nObs).toPrecision(2)} % of the cells (blocks fetch about their share).`,
    });
  }
  // The cells a gene is read for, and why (sized by what the first gene reads: the cause, from the layout).
  rows.push(...geneSampleFacts(subset.genes ?? null));
  // A sample sized by what a gene reads already says what a gene costs.
  if (geneCost !== null && subset.genes?.fit == null) rows.push(...geneCost);
  if (digest !== null) rows.push({ label: 'Cell set', value: digest, title: 'Two people who see the same cell set see the same cells.' });
  if (representation !== null) rows.push(representation);
  return rows;
}

/**
 * What a gene costs now, as Details rows, from the read plan of a gene of
 * the matrix genes are read from (`geneReadPlanFacts`): what the first gene
 * reads on a matrix stored cell by cell and why, or that a gene reads only
 * its own values. Null when there is no plan.
 *
 * @param {Object|null} plan - `geneReadPlan`
 * @returns {import('../components/controls.js').FactRow[]|null}
 */
export function geneCostFacts(plan) {
  if (plan === null || plan === undefined) return null;
  const facts = geneReadPlanFacts(plan);
  if (facts === null) return [{ label: 'A gene reads', value: 'only its own values', title: null }];
  return [{ label: 'First gene', value: facts.summary, title: null }, ...facts.rows];
}

/**
 * @param {{dom: Object, state: Object, getCellSubset: () => (Object|null),
 *   reopen: (cellSubset: Object) => Promise<{shown: boolean, inPlace: boolean}>, notify?: (text: string) => void,
 *   representation?: (key: string) => Promise<Object|null>,
 *   geneCost?: () => Promise<import('../components/controls.js').FactRow[]|null>}} options
 *   `representation`: how the open subsample represents a categorical field
 *   (`AnnDataFileSource.subsampleRepresentation`); `geneCost`: what a gene
 *   costs now, as Details rows (`geneCostFacts`), asked once per opening
 *   when Details is first opened (working it out may read the matrix's row
 *   pointers, which the first gene reads anyway)
 * @returns {{refresh: () => void, showGrowth: (progress: {cells: number, target: number}|null) => void, showOpenCells: () => void, destroy: () => void}}
 */
export function initSubsampleControl({ dom, state, getCellSubset, reopen, notify = () => {}, representation = async () => null, geneCost = async () => null, viewCarry = null }) {
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
  // How the subsample open now represents the field it is judged by (a Details row).
  let represented = null;
  let representationRequest = 0;
  // What a gene costs now (Details rows), asked when Details first opens.
  let geneCostRows = null;
  let geneCostAsked = false;
  let geneCostRequest = 0;
  // The Details rows drawn last, so an unchanged table is not redrawn.
  let drawnFacts = '';
  const detailsHeader = dom.details.querySelector?.('.disclosure-header') ?? null;
  const detailsOpen = () => detailsHeader?.getAttribute('aria-expanded') === 'true';

  function nObsOf(subset) {
    return subset?.nObs ?? state.pointCount ?? 0;
  }

  /** The share last typed or set that the box could read: what stands while it holds none (cleared, or "12," half typed). */
  let lastPercent = 100;

  /**
   * The share in the box, as a number: typed with a decimal point or a
   * decimal comma, whatever the browser or its locale ("12,5" is 12.5, never
   * 125: `parseDecimalText`); the box always shows it with a point, as every
   * other number in the app is written.
   */
  function percentShown() {
    const value = parseDecimalText(dom.percent.value);
    if (Number.isFinite(value)) lastPercent = Math.min(100, Math.max(0, value));
    return lastPercent;
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

  /**
   * The cells the control asks for now: the open subsample's exact count
   * while the share has not been edited, else the count the share stands
   * for (`shareCount`); every cell for 100 %.
   */
  function chosenCount(nObs) {
    if (exactK !== null) return exactK;
    const percent = percentShown();
    return percent >= 100 ? nObs : shareCount(percent, nObs);
  }

  /** The request the control describes now; a method or seed left unset is the file's. */
  function chosenRequest() {
    const percent = percentShown();
    // Every cell only when the count is every cell: a share shown as 100
    // of a subsample one cell short is that subsample.
    if (chosenCount(nObsOf(getCellSubset())) >= nObsOf(getCellSubset())) return { mode: 'all' };
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
    if (subset === null) return false;
    const all = chosenCount(subset.nObs) >= subset.nObs;
    if (subset.kept === null) return all;
    if (all) return false;
    const request = chosenRequest();
    const spec = subset.spec;
    const defaults = fileDefaults(subset);
    const k = request.k ?? shareCount(Number(request.percent), subset.nObs);
    // While the cells open grow toward a share, they are that share.
    const openK = growth === null ? spec.k : growth.target;
    return k === openK && (request.method ?? defaults.method) === spec.method && (request.seed ?? defaults.seed) === spec.seed &&
      (spec.method !== 'stratified' || (request.field === spec.field && request.allocation === spec.allocation)) &&
      (spec.method !== 'spatial' || request.embedding === undefined || request.embedding === spec.embedding);
  }

  function render() {
    const subset = getCellSubset();
    const percent = percentShown();
    const nObs = nObsOf(subset);
    const all = chosenCount(nObs) >= nObs;
    dom.count.textContent = exactK === null ? describeShare(percent, nObs) : describeShare(percent, nObs, exactK);
    dom.settings.hidden = all;
    dom.fieldRow.hidden = dom.method.value !== 'stratified';
    dom.embeddingRow.hidden = dom.method.value !== 'spatial';
    // A share of fewer cells than the viewer draws is not offered
    // (`describeShare` says why).
    const tooFew = !all && chosenCount(nObs) < FEWEST_OPEN_CELLS;
    dom.apply.disabled = busy || subset === null || tooFew || sameAsOpen(subset) ||
      (dom.method.value === 'stratified' && !all && dom.field.value === '');
    // One short line; the facts behind it under Details. A share asked for
    // that would read near the whole file says so first, with Use blocks.
    const request = chosenRequest();
    // Never while the cells asked for are still growing in: the notice says how far they are.
    const pending = growth === null && !all && !dom.apply.disabled && request.mode === 'subsample'
      ? scatteredShareCost(subset, { method: request.method ?? fileDefaults(subset).method, seed: request.seed ?? null, fraction: chosenCount(nObs) / nObs })
      : null;
    const status = pending === null ? openCellsStatus(subset, growth) : { text: pending.text, tone: 'warning', growing: false };
    dom.notice.textContent = status.text;
    dom.notice.title = pending?.title ?? '';
    dom.notice.dataset.tone = status.tone;
    dom.notice.dataset.state = status.growing ? 'growing' : 'settled';
    dom.notice.hidden = status.text === '';
    dom.useBlocks.hidden = pending === null;
    if (pending !== null) dom.useBlocks.textContent = pending.alternative === 'file' ? "Use the file's order" : 'Use blocks';
    const open = subset?.kept != null;
    const facts = openCellsFacts(subset, {
      growth,
      // The cells' digest: two people who see the same one see the same
      // cells. Said once the cells settle: a step of a progressive opening
      // would pay a pass over every open cell for a set that is about to
      // change (81 ms of a 10M-cell opening's growth).
      digest: open && !status.growing ? state.cellIdentity.digest : null,
      representation: open ? represented : null,
      geneCost: open ? geneCostRows : null,
    });
    dom.details.hidden = facts.length === 0;
    const drawn = JSON.stringify(facts);
    if (drawn !== drawnFacts) {
      drawnFacts = drawn;
      renderFactList(dom.detailsList, facts);
    }
    dom.openAll.hidden = !(subset?.kept != null && subset.autoFit !== null);
    dom.copyLink.hidden = !(subset?.kept != null && datasetParameters().size > 0);
    // The buttons show only when one of them has something to do: every
    // cell open and 100 % chosen leaves the control at its slider.
    dom.actions.hidden = !busy && dom.apply.disabled && dom.openAll.hidden && dom.copyLink.hidden && dom.useBlocks.hidden;
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

  /** Ask once per opening what a gene costs now, for Details. */
  function askGeneCost() {
    if (geneCostAsked || getCellSubset()?.kept == null) return;
    geneCostAsked = true;
    const request = geneCostRequest;
    Promise.resolve().then(geneCost).then(rows => {
      if (request !== geneCostRequest || rows == null) return;
      geneCostRows = rows;
      render();
    }, () => {});
  }

  /** Show the cells open now (a dataset was opened or read again). */
  function refresh() {
    const subset = getCellSubset();
    edited = false;
    represented = null;
    const request = ++representationRequest;
    const key = subset?.kept != null ? judgedField(subset) : null;
    if (key !== null) {
      representation(key).then(result => {
        if (request !== representationRequest) return;
        represented = representationFact(result);
        render();
      }, () => {});
    }
    // Another opening: what a gene costs is asked again, at once when Details is open.
    geneCostRows = null;
    geneCostAsked = false;
    geneCostRequest++;
    if (detailsOpen()) askGeneCost();
    fillChoices(subset);
    // A progressive opening shows the share it grows to.
    const openCount = growth !== null ? growth.target : subset?.kept != null ? subset.kept.length : null;
    const shown = openCount !== null && subset !== null ? shareShown(openCount, subset.nObs) : 100;
    dom.percent.value = String(shown);
    dom.slider.value = String(shown);
    exactK = openCount !== null && openCount < (subset?.nObs ?? 0) ? openCount : null;
    const defaults = fileDefaults(subset);
    // Short enough for the narrowest panel; the (i) tip says what each does.
    dom.method.options[0].textContent = `File default (${defaults.method})`;
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

  /** Readings of the open dataset made by this control: a restoring older than the last says nothing. */
  let reopenings = 0;

  /**
   * Read the open dataset again with the cells `cellSubset` asks for,
   * keeping what the person made and where they were: highlights and labels
   * by original cell position (`cell-subset-carry.js`), and the views
   * (cameras, layout), each view's active field and filters, the sidebar
   * controls and the analysis windows (`viewCarry`, the session's records of
   * them). The cells newly open then join what is derived from the file (a
   * label made from a column, a category or range group), as growing in
   * place gives the cells added (`takeInNewCells`).
   *
   * Resolves once the new cells are open, with `restoring`: what was shown
   * coming back on them (a view coloured by a gene reads that gene again
   * for the new cells: on a large atlas tens of seconds). The control is
   * the person's again as soon as the cells are open, so a share chosen by
   * mistake can be changed at once; a later Apply supersedes the restoring
   * (its reads end with the cells they were for), whose notes are then not
   * said.
   */
  async function reopenKeeping(cellSubset) {
    const carried = captureCarried(state);
    const view = viewCarry === null ? null : viewCarry.capture();
    const { shown, inPlace } = await reopen(cellSubset);
    // Cells grown or cut in place kept everything shown
    // (`app/open-cells-resize.js`); a new reading gets it back.
    if (shown !== true || inPlace === true) return { restoring: Promise.resolve() };
    // Labels first: a view may be coloured by one.
    const restored = restoreCarried(state, carried);
    const reading = ++reopenings;
    const restoring = (async () => {
      const lost = view === null ? [] : await viewCarry.restore(view);
      await takeInNewCells(state, carried, restored);
      if (reading !== reopenings) return;
      const said = describeCarried(restored);
      if (said !== '') notify(said);
      for (const reason of lost) notify(`Not kept after reading the cells again — ${reason}`);
    })();
    return { restoring };
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
      const { restoring } = await reopenKeeping(exact);
      busy = false;
      refresh();
      await restoring;
    } finally {
      if (busy) {
        busy = false;
        refresh();
      }
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
  on(dom.useBlocks, 'click', () => {
    // A priority-ordered file's own order is its default (uniform, its seed); any other file's, blocks.
    const own = getCellSubset()?.prioritySeed != null;
    dom.method.value = own ? '' : 'blocks';
    if (own) dom.seed.value = '';
    edited = true;
    render();
  });
  // The disclosure's own listener (`bindDisclosure`) ran first: it is open now when it opened.
  if (detailsHeader !== null) on(detailsHeader, 'click', () => { if (detailsOpen()) askGeneCost(); });
  on(dom.copyLink, 'click', () => { void copyLink(); });
  on(dom.openAll, 'click', () => {
    // Every cell of this dataset; the tab keeps fitting datasets opened next.
    void (async () => {
      if (busy) return;
      busy = true;
      render();
      try {
        const { restoring } = await reopenKeeping({ mode: 'all' });
        busy = false;
        refresh();
        await restoring;
      } finally {
        if (busy) {
          busy = false;
          refresh();
        }
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

  // The cells genes are read for changed (Genes read for): Details says so.
  if (typeof state?.on === 'function') {
    const onGeneSample = () => {
      if (!lifecycle.signal.aborted) render();
    };
    state.on('gene-sample:changed', onGeneSample);
    onAbort(lifecycle.signal, () => state.off?.('gene-sample:changed', onGeneSample));
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
