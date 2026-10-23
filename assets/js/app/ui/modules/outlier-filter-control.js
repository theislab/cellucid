/**
 * @fileoverview The legend's outlier filter: its slider, and a line that
 * always says what the filter can do for the active field and why.
 *
 * It shows the active field's outlier status (`state/managers/outlier-quantiles.js`):
 *
 * - a categorical field with no latent space chosen: the slider is shown
 *   disabled, with what the filter measures, the file's arrays that look
 *   like a latent space (suggested, never chosen for the person) and a button
 *   that opens the Data mapping setting where one is chosen;
 * - no category large enough: the slider is disabled and the line says the
 *   fewest cells a category needs;
 * - quantiles stored in the file, or already got: the slider alone, instant;
 * - quantiles to compute: the line says, before anything is read, that the
 *   first use reads the latent space once and how many bytes that is;
 * - while they are got: a progress bar with how much of how much is read,
 *   how fast, how long is left, and Cancel (which puts the slider back at
 *   100%);
 * - when getting them failed: why, and that moving the slider tries again,
 *   or, when the latent space itself cannot be read, a button to choose
 *   another.
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
import { describeReadProgress } from '../../../data/read-activity-log.js';
import { describePlanBytes } from '../../state/managers/outlier-quantiles.js';

/** Join names as people list them: `a`, `a or b`, `a, b or c`. */
function listOr(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * What the line under the slider says for one status, and which action it
 * offers: `{text, tone, action}` (`tone` `info` or `error`; `action` `latent`
 * or `cancel`), or null when the slider needs no words.
 *
 * @param {Object} status - `getOutlierFilterStatus()`
 * @returns {{text: string, tone: 'info'|'error', action: 'latent'|'cancel'|null}|null}
 */
export function describeOutlierStatus(status) {
  switch (status.state) {
    case 'no-latent': {
      const names = status.suggestions.map(item => item.key);
      const found = names.length === 0
        ? 'This file has no obsm array that looks like one (more than three columns).'
        : `This file has ${listOr(names)}.`;
      return {
        text: 'Measures each cell’s distance to its category’s centre in a latent space (scVI, PCA), ' +
          `not in the 2D/3D layout. Choose the latent space in Data mapping. ${found}`,
        tone: 'info',
        action: 'latent',
      };
    }
    case 'too-small':
      return {
        text: `No category of “${status.fieldKey}” has ${status.minPoints} cells, the fewest the filter measures ` +
          `(the largest has ${status.largest}), so it has nothing to hide.`,
        tone: 'info',
        action: null,
      };
    case 'available': {
      const plan = status.plan;
      if (plan?.source !== 'read') return null;
      const bytes = describePlanBytes(plan);
      const size = bytes === null ? '' : ` (${bytes})`;
      const elsewhere = plan.storedLatentKey !== null && plan.storedLatentKey !== plan.latentKey
        ? ` This file stores them for ${plan.storedLatentKey} only.`
        : ' This file does not store them.';
      const reads = plan.kept
        ? `The first use reads the latent space ${plan.latentKey}${size} once to compute the outlier distances; ` +
          'every other field then filters at once.'
        : `Each field’s first use reads the latent space ${plan.latentKey}${size} to compute its outlier distances: ` +
          'it is larger than the memory Cellucid keeps for it.';
      return { text: `${reads}${elsewhere}`, tone: 'info', action: null };
    }
    case 'running': {
      const reading = status.progress?.status === 'running' ? describeReadProgress(status.progress) : null;
      const what = status.plan?.source === 'stored'
        ? 'Reading the stored outlier distances'
        : status.plan?.source === 'held' || (status.progress === null && status.plan?.source !== 'read')
          ? 'Computing the outlier distances'
          : `Reading ${status.latentKey} to compute the outlier distances`;
      return { text: reading === null ? `${what}…` : `${what}: ${reading}`, tone: 'info', action: 'cancel' };
    }
    case 'failed':
      return status.latentUnusable
        ? {
          text: `The outlier distances could not be computed: ${status.message} Choose another latent space in Data mapping.`,
          tone: 'error',
          action: 'latent',
        }
        : {
          text: `The outlier distances could not be computed: ${status.message} Move the slider to try again.`,
          tone: 'error',
          action: null,
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
    if (input) {
      input.disabled = !usable;
      // The thumb is left alone while it is being dragged.
      if (!dragging || !usable) {
        const pct = usable ? Math.round((field._outlierThreshold ?? 1) * 100) : 100;
        input.value = String(pct);
        if (display) display.textContent = formatPercent(pct);
      }
    }

    const described = describeOutlierStatus(status);
    if (note) {
      note.hidden = described === null;
      note.textContent = described?.text ?? '';
      note.dataset.tone = described?.tone ?? 'info';
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
