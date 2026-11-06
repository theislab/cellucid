/**
 * @fileoverview Genes read for (Session › Open data, below Cells to open):
 * how many of the open cells a gene of a matrix stored cell by cell is read
 * for (the gene sample: `data/anndata/subsample-plan.js`, `genes`), as a
 * share of the open cells, and the one place that changes it.
 *
 * It is a sibling of Cells to open: a slider and a percent box, one status
 * line under them and one action. The slider snaps to steps
 * (`geneReadSteps`): the share read now, then 1, 5, 10, 25, 50 and 100 % of
 * the open cells above it, up to the most whose gene index this device
 * keeps. The status line says the chosen step's cells and, before it is
 * read, what reading it costs (bytes and, over a measured link, time:
 * `DataState.geneSampleCost`), priced again while it is shown so the time
 * follows the link as it changes. Read grows the sample to the chosen step
 * (`DataState.readGenesForMoreCells`): the cells already read are kept and
 * only the cells added are read, in doubling steps; 100 % is what was Read
 * for all cells. While it reads, the line counts the cells read and the time
 * left (priced again after each step) and the action is Stop (what is read
 * stays); its notification says the same, with Cancel.
 *
 * It applies to every gene read: the colouring, analyses and exports. What
 * shows a gene's sample elsewhere links here (`createGeneReadLink`: the
 * gene's legend, an analysis's result) through `revealGeneReadControl`;
 * nothing else changes it. Read is the action `cells.read-genes` (a step;
 * its implementation is here, whoever asks); Stop ends it, and what was read
 * is the step. A session records the sample read
 * (`session/cell-subset-record.js`, `genes`).
 *
 * @module ui/modules/gene-read-control
 */

import { createInfoTip } from '../components/controls.js';
import { GENES_READ_PLACE, geneSampleCostText, geneSampleText, roughRemaining } from '../../../data/gene-read-plan.js';
import { getNotificationCenter } from '../../notification-center.js';
import { countNoun, formatCount, formatCountOf, parseDecimalText } from '../../../utils/format-units.js';
import { formatCompactCount } from '../components/display-format.js';
import { isCancellation, onAbort } from '../../../utils/abort.js';
import { revealSidebar } from './sidebar-controls.js';
import { expandSessionSection } from './session-sections.js';
import { getActions } from '../../actions/index.js';

/** The shares of the open cells the slider offers above the sample (percent). */
export const GENE_READ_STEPS = Object.freeze([1, 5, 10, 25, 50, 100]);

/**
 * How often the chosen step is priced again while it is shown, so its time
 * follows the link as the reads measure it (a scheduling choice: a price is
 * a computation over the layout, no request).
 */
const REPRICE_MS = 5000;

const DOM_KEYS = Object.freeze(['root', 'slider', 'percent', 'status', 'actions', 'action']);

/**
 * `cells` of `of` as the percent box writes it: whole above 10, two
 * significant figures below; never 100 short of every cell, never 0 above
 * none.
 *
 * @param {number} cells
 * @param {number} of
 * @returns {string}
 */
export function geneReadPercentText(cells, of) {
  if (!(of > 0) || cells >= of) return '100';
  const percent = (100 * cells) / of;
  if (percent >= 10) return String(Math.min(99, Math.round(percent)));
  if (percent <= 0) return '0';
  return String(Number(percent.toPrecision(2)));
}

/**
 * The open cells the slider stops at, ascending: the sample read now
 * (`cells`), each of `GENE_READ_STEPS` of the `of` open cells above it, and
 * `most` (the most open cells whose gene index is kept here: every one, or
 * fewer, `geneSampleCost`'s `index.fits`) as the last.
 *
 * @param {number} cells
 * @param {number} of
 * @param {number} [most]
 * @returns {number[]}
 */
export function geneReadSteps(cells, of, most = of) {
  const top = Math.max(cells, Math.min(of, most));
  const steps = [cells];
  for (const percent of GENE_READ_STEPS) {
    const at = percent >= 100 ? of : Math.round((of * percent) / 100);
    if (at > steps.at(-1) && at < top) steps.push(at);
  }
  if (top > steps.at(-1)) steps.push(top);
  return steps;
}

/**
 * The step nearest a typed share (percent of `of`), among `steps`.
 *
 * @param {number[]} steps
 * @param {number} percent
 * @param {number} of
 * @returns {number} Its index
 */
export function nearestGeneReadStep(steps, percent, of) {
  const wanted = (of * percent) / 100;
  let best = 0;
  for (let index = 1; index < steps.length; index++) {
    if (Math.abs(steps[index] - wanted) < Math.abs(steps[best] - wanted)) best = index;
  }
  return best;
}

/**
 * The status line of the control (`initGeneReadControl`), as text and its
 * title: the chosen step's cells, and what reading them costs once priced
 * (`cost`: `geneSampleCost`); while genes are read for more cells, how far
 * that is and the time left (`left`, once priced).
 *
 * @param {{cells: number, of: number}} sample
 * @param {{chosen: number, cost?: {bytes: number, ms: number|null}|null, noRoom?: string|null,
 *   growth?: {cells: number, target: number}|null, left?: {bytes: number, ms: number|null}|null}} state
 * @returns {{text: string, title: string}}
 */
export function geneReadStatus(sample, { chosen, cost = null, noRoom = null, growth = null, left = null }) {
  const of = sample.of;
  if (growth !== null) {
    const remaining = left === null || !(left.ms > 0) ? '' : ` · ${roughRemaining(left.ms)} left`;
    return {
      text: `Reading ${formatCompactCount(growth.cells)} of ${formatCompactCount(growth.target)} ${countNoun(growth.target, 'cell')}${remaining}`,
      title: `Reading genes for ${formatCountOf(growth.target, 'open cell')}: ${formatCount(growth.cells)} read so far${left === null ? '' : `, ${geneSampleCostText(left)} to go`}. Every gene shown fills in as its cells are read; what is read stays if you stop.`,
    };
  }
  const cells = `${formatCompactCount(chosen)} of ${formatCompactCount(of)} ${countNoun(of, 'cell')}`;
  if (chosen <= sample.cells) {
    const room = noRoom === null ? '' : ' · no more fits here';
    return {
      text: `${cells}${room}`,
      title: `${geneSampleText({ cells: sample.cells, of }, { plural: true })}: the first of the open cells in their order, a sample of them.${noRoom === null ? '' : ` Genes cannot be read for more cells here: ${noRoom}.`}`,
    };
  }
  return {
    text: cost === null ? cells : `${cells} · ${geneSampleCostText(cost, { compact: true })}`,
    title: `Read genes for ${formatCountOf(chosen, 'open cell')} (${formatCount(chosen - sample.cells)} more; the ${formatCount(sample.cells)} read are kept)${cost === null ? '' : `: ${geneSampleCostText(cost)}`}.`,
  };
}

/**
 * Read genes for the first `target` open cells, with a notification of its
 * progress and Cancel; resolves once it ends (read, stopped or failed:
 * said). `what` names the cells in the notification ("every open cell",
 * "the session's cells").
 *
 * @param {Object} state - DataState
 * @param {number} target
 * @param {string|null} cost - The cost as said before it ran (`geneSampleCostText`)
 * @param {string} [what]
 * @returns {Promise<{ended: 'read'|'stopped'|'failed', error: Error|null}>} How it ended (said already)
 */
export async function readGenesForMoreCellsSaid(state, target, cost = null, what = 'every open cell') {
  const notifications = getNotificationCenter();
  const id = notifications.loading(`Reading genes for ${what}${cost === null ? '' : ` (${cost})`}`, {
    category: 'data',
    onCancel: () => state.stopReadingGenesForMoreCells(),
  });
  const said = () => {
    const left = state.getGeneSample();
    return left === null ? 'Genes are read for every open cell' : geneSampleText(left, { plural: true });
  };
  try {
    await state.readGenesForMoreCells(target, {
      onStep: (_sample, cells) => {
        if (notifications.hasNotification(id)) {
          notifications.loading(`Reading genes for ${what}: ${formatCount(cells)} of ${formatCountOf(target, 'cell')} read`, { id, category: 'data' });
        }
      },
    });
    notifications.complete(id, said());
    return { ended: 'read', error: null };
  } catch (error) {
    if (isCancellation(error)) {
      notifications.complete(id, `Stopped. ${said()}`);
      return { ended: 'stopped', error: null };
    }
    notifications.fail(id, `Reading genes for ${what} failed: ${error?.message ?? String(error)}`);
    return { ended: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Bring Genes read for into view and focus its slider: the sidebar opened
 * (the phone's sheet too), the Session panel and its Subsampling section
 * opened. False when there is no
 * gene sample to change (the control is hidden).
 *
 * @param {Document} [ownerDocument]
 * @returns {boolean}
 */
export function revealGeneReadControl(ownerDocument = document) {
  const block = ownerDocument.getElementById('gene-read-block');
  if (block === null || block.hidden) return false;
  revealSidebar(ownerDocument);
  expandSessionSection(ownerDocument, 'subsampling');
  block.scrollIntoView({ block: 'center' });
  ownerDocument.getElementById('gene-read-slider')?.focus({ preventScroll: true });
  return true;
}

/**
 * One line that names a gene sample and links to Genes read for
 * (`revealGeneReadControl`), with an (i) whose live line holds the exact
 * numbers: what the gene's legend and an analysis's result show. `set`
 * writes it (text, its exact words); `hidden` hides it.
 *
 * @param {{className: string, tip: string, label: string}} options - `tip`: the (i)'s tip (`info-tips.js`)
 * @returns {{root: HTMLElement, link: HTMLButtonElement, set: (text: string, detail: string) => void}}
 */
export function createGeneReadNote({ className, tip, label }) {
  const root = document.createElement('div');
  root.className = `gene-read-note ${className}`.trim();
  const row = document.createElement('div');
  row.className = 'checkbox-info-row gene-read-note-row';
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'gene-read-link';
  const info = createInfoTip({ tip, label });
  row.append(link, info.button);
  root.append(row, info.popover);
  // The exact words, first under the tip's title (`data-info-tip-live`).
  const live = document.createElement('p');
  live.className = 'info-tip-text gene-read-note-detail';
  live.dataset.infoTipLive = '';
  info.popover.querySelector('.info-tip-header')?.after(live);
  link.addEventListener('click', () => {
    revealGeneReadControl(link.ownerDocument);
  });
  return {
    root,
    link,
    set(text, detail) {
      link.textContent = text;
      link.title = `${detail} Change it in ${GENES_READ_PLACE}.`;
      link.setAttribute('aria-label', `${text}: change it in ${GENES_READ_PLACE}`);
      live.textContent = detail;
    },
  };
}

/**
 * The gene's legend's line (`legend-renderer.js`): the gene sample now, or
 * the growth under way, linked to Genes read for; null for a field not a
 * gene, or when every open cell's genes are read. It follows the sample (`'gene-sample:changed'`)
 * until `signal` (the legend's render) ends.
 *
 * @param {Object} state - DataState
 * @param {AbortSignal} signal
 * @returns {HTMLElement|null}
 */
export function createGeneReadLink(state, signal) {
  const sampleOf = () => state.getGeneSample?.() ?? null;
  const growthOf = () => state.getGeneSampleGrowth?.() ?? null;
  if (state.activeFieldSource !== 'var' || (sampleOf() === null && growthOf() === null)) return null;
  const note = createGeneReadNote({ className: 'legend-gene-read', tip: 'gene-sample', label: 'About the gene sample' });
  const render = () => {
    const sample = sampleOf();
    const growth = growthOf();
    note.root.hidden = sample === null && growth === null;
    if (growth !== null) {
      note.set(
        `Reading ${formatCompactCount(growth.cells)} of ${formatCompactCount(growth.target)} ${countNoun(growth.target, 'cell')}`,
        `Reading genes for ${formatCountOf(growth.target, 'open cell')}: ${formatCount(growth.cells)} read so far.`
      );
    } else if (sample !== null) {
      note.set(
        geneSampleText(sample, { format: formatCompactCount }),
        `${geneSampleText(sample)}. The other ${formatCountOf(sample.of - sample.cells, 'cell')} are drawn faded: not read, which is not 0.`
      );
    }
  };
  const listener = () => { if (!signal.aborted) render(); };
  state.on?.('gene-sample:changed', listener);
  onAbort(signal, () => state.off?.('gene-sample:changed', listener));
  render();
  return note.root;
}

/**
 * Genes read for, in Session › Open data.
 *
 * The count of open cells genes were asked to be read for (the action
 * `cells.read-genes`) is kept here with the open cells it was asked on
 * (`openCellsKey`): the `cells` state domain reads and restores it
 * (`genesAsked`, `setGenesAsked`; `app/state/domains/cells.js`).
 *
 * @param {{dom: {root: HTMLElement, slider: HTMLInputElement, percent: HTMLInputElement, status: HTMLElement, actions: HTMLElement, action: HTMLButtonElement}, state: Object,
 *   openCellsKey: () => string}} options - `openCellsKey`: the open cells now (`cells.js` `openCellsKey`)
 * @returns {{refresh: () => void, destroy: () => void, genesAsked: () => (number|null), setGenesAsked: (cells: number|null) => void}}
 */
export function initGeneReadControl({ dom, state, openCellsKey }) {
  for (const key of DOM_KEYS) {
    if (!dom?.[key]) throw new TypeError(`Genes read for needs its ${key}.`);
  }
  if (typeof openCellsKey !== 'function') throw new TypeError('Genes read for needs openCellsKey().');
  /** The genes asked for: a count of open cells, on the open cells keyed `key`. */
  let asked = null;
  // Reading genes for more cells, whoever asks, is this control's (`readGenesAction`);
  // provided first, so a second control on the page fails before it starts anything.
  const unprovide = getActions().provide('cells.read-genes', (params, context) => readGenesAction(params, context));
  // What reading genes for more cells would take, priced at the link as measured now (the agent presence's heavy work).
  const unestimate = getActions().provideEstimate('cells.read-genes', async ({ cells }) => {
    const sample = sampleNow();
    if (sample === null) return null;
    const target = Math.min(cells, sample.of);
    if (target <= sample.cells) return null;
    const priced = await Promise.resolve(state.geneSampleCost(target)).catch(() => null);
    if (priced === null) return null;
    return { ms: priced.ms ?? null, bytes: priced.bytes ?? null, what: `Reads genes for ${formatCountOf(target, 'cell')} (${geneSampleCostText(priced)})` };
  });
  const lifecycle = new AbortController();
  onAbort(lifecycle.signal, unprovide);
  onAbort(lifecycle.signal, unestimate);
  const on = (element, event, handler) => element.addEventListener(event, handler, { signal: lifecycle.signal });
  // The sample the steps were made for, the steps, and the one chosen.
  let pricedFor = null;
  let steps = [];
  let chosen = 0;
  let noRoom = null;
  let roomAsked = false;
  // The chosen step's price, and the growth's time left; each asked by a
  // numbered request, so an answer for an earlier choice is dropped.
  let cost = null;
  let left = null;
  let request = 0;
  let repriceTimer = null;

  const sampleNow = () => state.getGeneSample?.() ?? null;
  const growthNow = () => state.getGeneSampleGrowth?.() ?? null;

  function render() {
    const sample = sampleNow();
    const growth = growthNow();
    dom.root.hidden = sample === null && growth === null;
    if (dom.root.hidden) return;
    const of = sample?.of ?? state.pointCount;
    const shown = sample ?? { cells: growth.cells, of };
    if (growth !== null) {
      dom.slider.disabled = true;
      dom.percent.disabled = true;
      dom.slider.max = '1';
      dom.slider.value = '1';
      dom.percent.value = geneReadPercentText(growth.target, of);
      const status = geneReadStatus(shown, { chosen: growth.target, growth, left });
      dom.status.textContent = status.text;
      dom.status.title = status.title;
      dom.action.textContent = 'Stop';
      dom.action.title = 'Stop reading genes for more cells; what is read stays.';
      dom.actions.hidden = false;
      dom.action.disabled = false;
      return;
    }
    dom.slider.disabled = steps.length < 2;
    dom.percent.disabled = steps.length < 2;
    dom.slider.min = '0';
    dom.slider.max = String(Math.max(0, steps.length - 1));
    const index = Math.max(0, steps.indexOf(chosen));
    dom.slider.value = String(index);
    if (document.activeElement !== dom.percent) dom.percent.value = geneReadPercentText(chosen, of);
    dom.slider.setAttribute('aria-valuetext', `${geneReadPercentText(chosen, of)} % of the open cells: ${formatCountOf(chosen, 'cell')}`);
    const status = geneReadStatus(sample, { chosen, cost, noRoom });
    dom.status.textContent = status.text;
    dom.status.title = status.title;
    dom.action.textContent = 'Read';
    dom.action.title = status.title;
    dom.actions.hidden = chosen <= sample.cells;
    dom.action.disabled = false;
  }

  /** Price the chosen step (bytes and time over the link as measured now). */
  function priceChosen() {
    const sample = sampleNow();
    const asked = ++request;
    if (sample === null || growthNow() !== null || chosen <= sample.cells) {
      cost = null;
      render();
      return;
    }
    const target = chosen;
    Promise.resolve(state.geneSampleCost(target)).then(priced => {
      if (asked !== request || lifecycle.signal.aborted) return;
      cost = priced === null ? null : { bytes: priced.bytes, ms: priced.ms };
      // More than the gene index is kept for here: the most that is, the last step.
      const fits = priced?.index?.refusal == null ? null : priced.index.fits;
      if (fits !== null && fits < target && sample.cells < fits) {
        steps = geneReadSteps(sample.cells, sample.of, fits);
        chosen = steps.at(-1);
        cost = null;
        render();
        priceChosen();
        return;
      }
      render();
    }, () => {});
  }

  /** The time left of a growth under way, priced from what is read now. */
  function priceLeft() {
    const growth = growthNow();
    const asked = ++request;
    if (growth === null) return;
    Promise.resolve(state.geneSampleCost(growth.target)).then(priced => {
      if (asked !== request || lifecycle.signal.aborted || growthNow() === null) return;
      left = priced === null ? null : { bytes: priced.bytes, ms: priced.ms };
      render();
    }, () => {});
  }

  /**
   * The steps for the sample now, before what this device keeps is asked:
   * every share up to every open cell. What is kept is asked once per
   * sample, when the control is first used (`askRoom`): pricing reads the
   * matrix's row pointers of the sample, which the first gene reads
   * anyway, so nothing is read for it while the dataset opens.
   */
  function stepsFor(sample) {
    pricedFor = sample;
    roomAsked = false;
    noRoom = null;
    steps = geneReadSteps(sample.cells, sample.of);
    chosen = sample.cells;
    cost = null;
  }

  /** How many open cells the gene index is kept for here: the last step. */
  function askRoom() {
    const sample = sampleNow();
    if (roomAsked || sample === null || growthNow() !== null) return;
    roomAsked = true;
    Promise.resolve(state.geneSampleCost(sample.of)).then(every => {
      if (lifecycle.signal.aborted || pricedFor !== sample) return;
      const refusal = every?.index?.refusal ?? null;
      const most = refusal === null ? sample.of : every.index.fits;
      if (refusal !== null && most <= sample.cells) noRoom = refusal;
      steps = geneReadSteps(sample.cells, sample.of, most);
      if (!steps.includes(chosen)) {
        chosen = steps.at(-1);
        priceChosen();
      }
      render();
    }, () => {});
  }

  function sync() {
    const sample = sampleNow();
    const growth = growthNow();
    if (growth !== null) {
      priceLeft();
      render();
      return;
    }
    left = null;
    if (sample === null) {
      pricedFor = null;
      render();
      return;
    }
    if (pricedFor?.cells !== sample.cells || pricedFor?.of !== sample.of) stepsFor(sample);
    render();
  }

  function choose(index) {
    const next = steps[Math.max(0, Math.min(steps.length - 1, index))] ?? chosen;
    if (next === chosen) return;
    chosen = next;
    cost = null;
    render();
    priceChosen();
  }

  for (const element of [dom.slider, dom.percent]) {
    on(element, 'focus', askRoom);
    on(element, 'pointerdown', askRoom);
  }
  on(dom.slider, 'input', () => choose(Number(dom.slider.value)));
  const commitPercent = () => {
    const sample = sampleNow();
    const typed = parseDecimalText(dom.percent.value);
    if (sample === null || !Number.isFinite(typed)) {
      render();
      return;
    }
    choose(nearestGeneReadStep(steps, Math.min(100, Math.max(0, typed)), sample.of));
    dom.percent.value = geneReadPercentText(chosen, sample.of);
  };
  on(dom.percent, 'change', commitPercent);
  on(dom.percent, 'keydown', event => { if (event.key === 'Enter') commitPercent(); });
  /**
   * The action `cells.read-genes`: read genes for the first `cells` open
   * cells (never past what the gene index is kept for here), said while it
   * runs. Stopped, what was read is the step; a failure that read nothing is
   * refused (it was said).
   */
  async function readGenesAction({ cells }, { signal }) {
    const sample = sampleNow();
    if (sample === null) return null;
    // Priced now, at the link as measured now.
    const priced = await Promise.resolve(state.geneSampleCost(Math.min(cells, sample.of))).catch(() => null);
    const fits = priced?.index?.refusal == null ? Infinity : priced.index.fits;
    const target = Math.min(cells, sample.of, fits);
    if (target <= sample.cells || growthNow() !== null) return null;
    const what = target >= sample.of ? 'every open cell' : `${geneReadPercentText(target, sample.of)} % of the open cells (${formatCountOf(target, 'cell')})`;
    const said = priced === null || target !== cells ? null : geneSampleCostText(priced);
    // Stopping the action stops the reading; what is read stays.
    const remove = onAbort(signal, () => state.stopReadingGenesForMoreCells());
    let ended;
    try {
      ended = await readGenesForMoreCellsSaid(state, target, said, what);
    } finally {
      remove();
    }
    const now = sampleNow();
    const read = now === null ? sample.of : now.cells;
    if (ended.ended === 'failed' && read <= sample.cells) throw ended.error;
    // What was read is what the step asked for (the `cells` state domain).
    asked = { cells: read, key: openCellsKey() };
    return { cells: read, stopped: read < target };
  }

  on(dom.action, 'click', () => {
    if (growthNow() !== null) {
      // Ends the action reading them (`readGenesAction`): what is read stays.
      state.stopReadingGenesForMoreCells();
      return;
    }
    const sample = sampleNow();
    if (sample === null || chosen <= sample.cells) return;
    dom.action.disabled = true;
    // Its notification says how it went, a failure included.
    void getActions().dispatch('cells.read-genes', { cells: chosen }).catch(() => {}).finally(() => {
      if (!lifecycle.signal.aborted) render();
    });
  });

  // The chosen step priced again while it is shown: its time follows the
  // link as the reads measure it.
  repriceTimer = setInterval(() => {
    const sample = sampleNow();
    if (dom.root.hidden || sample === null || growthNow() !== null || chosen <= sample.cells || document.hidden) return;
    priceChosen();
  }, REPRICE_MS);
  onAbort(lifecycle.signal, () => clearInterval(repriceTimer));

  const listener = () => { if (!lifecycle.signal.aborted) sync(); };
  state.on?.('gene-sample:changed', listener);
  onAbort(lifecycle.signal, () => state.off?.('gene-sample:changed', listener));
  sync();
  return {
    refresh: sync,
    /** The count of open cells genes were asked to be read for, on the cells open now; null when not asked on them. */
    genesAsked: () => (asked !== null && asked.key === openCellsKey() ? asked.cells : null),
    /** Put back a count asked for (a history step shown), for the cells open now. */
    setGenesAsked(cells) {
      if (cells !== null && (!Number.isSafeInteger(cells) || cells < 1)) throw new RangeError('Genes are asked for a whole number of cells.');
      asked = cells === null ? null : { cells, key: openCellsKey() };
    },
    destroy() {
      lifecycle.abort();
    },
  };
}
