/**
 * @fileoverview The legend's outlier filter: a label with its (i), then the
 * one control the active field's state calls for, and at most one short line.
 *
 * It shows the active field's outlier status (`state/managers/outlier-quantiles.js`):
 *
 * - no latent space chosen: only a "Choose latent space" button, which opens
 *   the Data mapping setting where one is chosen (it lists the file's
 *   candidate arrays; the button's title names them). What the filter
 *   measures is in the (i);
 * - no category large enough: one line saying the fewest cells a category
 *   needs;
 * - quantiles stored in the file, or already got: the slider alone, instant;
 * - quantiles to compute: the slider and one line naming what the first use
 *   reads and how large it is;
 * - while they are got: a progress bar, one line, and Cancel (which puts the
 *   slider back at 100%); the job's notification carries the details;
 * - when getting them failed: one line (the reason is its title, and the
 *   job's notification), and moving the slider tries again, or, when the
 *   latent space itself cannot be read, the button to choose another.
 *
 * The slider recomputes visibility at most once per frame while the thumb
 * moves, with the readout painted in the same frame; releasing the thumb
 * commits the final value. The first move below 100% starts getting the
 * quantiles; the filter applies when they arrive, at the slider's value by
 * then.
 *
 * @module ui/modules/outlier-filter-control
 */

import { coalesceToFrame } from '../components/controls.js';
import { formatPercent } from '../components/display-format.js';
import { describePlanBytes } from '../../state/managers/outlier-quantiles.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** Join names as people list them: `a`, `a or b`, `a, b or c`. */
function listOr(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * What the filter shows for one status: its one line (`text`, with
 * `detail` as the line's title), which action it offers (`latent` or
 * `cancel`) and whether the slider is shown; null when the slider needs no
 * words.
 *
 * @param {Object} status - `getOutlierFilterStatus()`
 * @returns {{text: string|null, detail: string|null, tone: 'info'|'error',
 *   action: 'latent'|'cancel'|null, slider: boolean}|null}
 */
export function describeOutlierStatus(status) {
  switch (status.state) {
    case 'no-latent': {
      const names = status.suggestions.map(item => item.key);
      return {
        text: null,
        detail: names.length === 0
          ? 'This file has no obsm array that looks like a latent space (more than three columns).'
          : `Candidates in this file: ${listOr(names)}.`,
        tone: 'info',
        action: 'latent',
        slider: false,
      };
    }
    case 'too-small':
      return {
        text: `No category has ${formatCountOf(status.minPoints, 'cell')}.`,
        detail: `No category of “${status.fieldKey}” has ${formatCountOf(status.minPoints, 'cell')}, the fewest the filter ` +
          `measures (the largest has ${status.largest}), so it has nothing to hide.`,
        tone: 'info',
        action: null,
        slider: false,
      };
    case 'available': {
      const plan = status.plan;
      if (plan?.source !== 'read') return null;
      const bytes = describePlanBytes(plan);
      const size = bytes === null ? '' : ` (${bytes})`;
      return {
        text: plan.kept
          ? `First use reads ${plan.latentKey}${size}.`
          : `Each field’s first use reads ${plan.latentKey}${size}.`,
        detail: plan.kept
          ? 'The outlier distances are computed once from the latent space; every other field then filters at once.'
          : 'The latent space is larger than the memory Cellucid keeps for it, so each field reads it again.',
        tone: 'info',
        action: null,
        slider: true,
      };
    }
    case 'running':
      return {
        text: status.plan?.source === 'stored'
          ? 'Reading the stored distances…'
          : 'Computing outlier distances…',
        detail: null,
        tone: 'info',
        action: 'cancel',
        slider: true,
      };
    case 'failed':
      return status.latentUnusable
        ? {
          text: 'This latent space cannot be used.',
          detail: status.message,
          tone: 'error',
          action: 'latent',
          slider: false,
        }
        : {
          text: 'Could not compute. Move the slider to try again.',
          detail: status.message,
          tone: 'error',
          action: null,
          slider: true,
        };
    default:
      return null;
  }
}

/** How far a running status has come, 0–100, or null when not known. */
function percentOf(status) {
  const activity = status.progress;
  if (activity?.status !== 'running' || !(activity.bytesTotal > 0)) return null;
  return Math.min(100, (100 * activity.bytesFetched) / activity.bytesTotal);
}

/**
 * @param {{
 *   state: Object,
 *   dom: {container: HTMLElement|null, input: HTMLInputElement|null, display: HTMLElement|null,
 *     note: HTMLElement|null, progress: HTMLElement|null, progressBar: HTMLElement|null,
 *     action: HTMLButtonElement|null},
 *   onChooseLatent?: () => void
 * }} options - `onChooseLatent` opens the Data mapping setting of the latent space.
 * @returns {{render: (field: Object|null) => void, destroy: () => void}}
 */
export function initOutlierFilterControl({ state, dom, onChooseLatent = () => {} }) {
  const { container, input, display, note, progress, progressBar, action } = dom;
  const lifecycle = new AbortController();
  let destroyed = false;
  let field = null;
  let shownAction = null;
  // The thumb under a pointer is the person's; a render leaves it there.
  let dragging = false;

  function activeFieldOf(candidate) {
    return Boolean(candidate)
      && state.activeFieldSource === 'obs'
      && state.getActiveField() === candidate
      ? candidate
      : null;
  }

  function render(nextField = field) {
    if (destroyed) return;
    field = activeFieldOf(nextField);
    const status = field === null ? { state: 'none' } : state.getOutlierFilterStatus(state.activeFieldIndex);
    if (container) container.hidden = status.state === 'none';
    if (status.state === 'none') return;

    const usable = status.state !== 'no-latent' && status.state !== 'too-small';
    const described = describeOutlierStatus(status);
    const sliderRow = input?.closest?.('.slider-row') ?? null;
    if (sliderRow) sliderRow.hidden = described !== null && !described.slider;
    if (input) {
      input.disabled = !usable;
      // The thumb is left alone while it is being dragged.
      if (!dragging || !usable) {
        const pct = usable ? Math.round((field._outlierThreshold ?? 1) * 100) : 100;
        input.value = String(pct);
        if (display) display.textContent = formatPercent(pct);
      }
    }

    if (note) {
      const text = described?.text ?? null;
      note.hidden = text === null;
      note.textContent = text ?? '';
      note.dataset.tone = described?.tone ?? 'info';
      if (described?.detail) note.title = described.detail;
      else note.removeAttribute?.('title');
    }
    if (progress) {
      const running = status.state === 'running';
      progress.hidden = !running;
      const percent = running ? percentOf(status) : null;
      progress.classList.toggle('indeterminate', running && percent === null);
      if (progressBar) progressBar.style.width = percent === null ? '' : `${percent}%`;
      if (percent === null) progress.removeAttribute?.('aria-valuenow');
      else progress.setAttribute?.('aria-valuenow', String(Math.round(percent)));
    }
    if (action) {
      shownAction = described?.action ?? null;
      action.hidden = shownAction === null;
      action.textContent = shownAction === 'latent' ? 'Choose latent space' : 'Cancel';
      if (shownAction === 'latent' && described?.detail) action.title = described.detail;
      else action.removeAttribute?.('title');
    }
  }

  const applyThreshold = () => {
    if (destroyed || input === null) return;
    const pct = parseFloat(input.value);
    if (display) display.textContent = formatPercent(pct);
    // The first move below 100% gets the field's quantiles; a cancelled or
    // failed attempt is told by the status line.
    void state.setOutlierThresholdForActive(pct / 100).finally(() => render());
  };
  const frame = coalesceToFrame(applyThreshold);
  if (input) {
    input.addEventListener('pointerdown', () => {
      dragging = true;
    }, { signal: lifecycle.signal });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      render();
    };
    input.ownerDocument?.defaultView?.addEventListener?.('pointerup', release, { signal: lifecycle.signal });
    input.ownerDocument?.defaultView?.addEventListener?.('pointercancel', release, { signal: lifecycle.signal });
    input.addEventListener('input', () => {
      if (!destroyed) frame();
    }, { signal: lifecycle.signal });
    input.addEventListener('change', () => {
      if (destroyed) return;
      frame.cancel();
      applyThreshold();
    }, { signal: lifecycle.signal });
  }
  if (action) {
    action.addEventListener('click', () => {
      if (shownAction === 'latent') onChooseLatent();
      else if (shownAction === 'cancel') state.cancelOutlierQuantiles();
    }, { signal: lifecycle.signal });
  }
  const unsubscribe = state.on('outliers:status', () => render());

  return {
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      frame.cancel();
      lifecycle.abort();
      unsubscribe?.();
    },
  };
}
