/**
 * Shows the opening under way (`data/opening-progress.js`) from its first
 * moment, in one of two places:
 *
 * - **The startup overlay**, centred over the empty viewer, while no dataset
 *   is shown (the first load, from a link, a sample, a server or a notebook):
 *   what is opened, the step under way, a progress bar, how much has arrived,
 *   how fast and how long is left, and Cancel.
 * - **A notification with Cancel**, while another dataset stays on screen:
 *   the same words, updated as it goes.
 *
 * How it ended goes to the notification center: opened (with how long it
 * took; over the empty viewer only what the layer that opened it said, the
 * dataset appearing says the rest), failed (one short sentence; the
 * failure's own message is folded under its Details, and the layer that
 * failed logs it to the console), or cancelled. Nothing is written into the
 * sidebar.
 *
 * A failed opening whose layer said what it means and offered ways on (the
 * data the page's address names, at startup) stays over the empty viewer:
 * one plain sentence, the failure's own message folded under Details, and
 * its actions (Try again, Open without this link). The app around it works;
 * a newer opening replaces it.
 *
 * @module app/opening-progress-view
 */

import { getNotificationCenter } from './notification-center.js';
import { createButton } from './ui/components/controls.js';
import { formatTransferBytes } from '../data/transfer-log.js';
import { formatOpeningDuration, getOpeningProgress } from '../data/opening-progress.js';
import { isExplainedFailure } from '../data/data-source.js';

/** Updates are drawn at most this often; a second's tick keeps the elapsed time live. */
const UPDATE_EVERY_MS = 200;
const TICK_MS = 1000;

function stepText(snapshot) {
  return /[.…]$/.test(snapshot.step) ? snapshot.step : `${snapshot.step}…`;
}

function finishedText(snapshot) {
  if (snapshot.message !== null) return snapshot.message;
  const read = snapshot.bytes > 0 ? `, ${formatTransferBytes(snapshot.bytes)} read` : '';
  return `Opened ${snapshot.title} (${formatOpeningDuration(snapshot.elapsedMs)}${read}).`;
}

/** The text of an error and of the errors it aggregates or was caused by. */
function rawText(error) {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  const own = error instanceof Error ? error.message : String(error);
  const parts = [own];
  if (error instanceof AggregateError) parts.push(...error.errors.map(rawText));
  else {
    // What caused it: the standard `cause`, or a data source error's `details.cause`.
    const cause = error?.cause ?? error?.details?.cause;
    if (cause !== undefined && cause !== error) parts.push(rawText(cause));
  }
  // A message that already quotes its cause says it once.
  return parts.filter((part, index) => part !== '' && !parts.slice(0, index).some(earlier => earlier.includes(part)))
    .join(' — ');
}

/**
 * What a failed opening's notification says: a layer's own sentence as it
 * is, a failure written for the person (`explainedFailure`) as it is with
 * what caused it under Details, and anything else as one short sentence
 * with the failure's message under Details.
 *
 * @returns {{message: string, details: string}}
 */
function failureNotice(snapshot) {
  const { error } = snapshot;
  if (typeof error === 'string') return { message: error, details: '' };
  if (isExplainedFailure(error)) {
    return { message: error.message, details: rawText(error?.cause ?? error?.details?.cause) };
  }
  return { message: `Could not open ${snapshot.title}.`, details: rawText(error) };
}

function buildOverlay(documentOwner, onCancel) {
  const root = documentOwner.createElement('div');
  root.className = 'opening-overlay';
  root.dataset.state = 'running';
  root.hidden = true;
  const panel = documentOwner.createElement('section');
  panel.className = 'opening-panel';
  panel.setAttribute('aria-label', 'Opening data');
  const title = documentOwner.createElement('p');
  title.className = 'opening-title';
  const step = documentOwner.createElement('p');
  step.className = 'opening-step';
  step.setAttribute('role', 'status');
  step.setAttribute('aria-live', 'polite');
  const bar = documentOwner.createElement('div');
  bar.className = 'job-progress opening-bar indeterminate';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-label', 'Opening progress');
  const fill = documentOwner.createElement('div');
  fill.className = 'job-progress-bar';
  bar.appendChild(fill);
  const detail = documentOwner.createElement('p');
  detail.className = 'opening-detail tabular-nums';
  const cancel = createButton({ label: 'Cancel', className: 'btn-compact opening-cancel', onClick: onCancel });
  // A failed opening: the failure's own message, folded (the brand card's
  // Details, components/_welcome.css), and the ways on.
  const failure = documentOwner.createElement('details');
  failure.className = 'welcome-details opening-failure';
  const failureSummary = documentOwner.createElement('summary');
  failureSummary.textContent = 'Details';
  const failureText = documentOwner.createElement('p');
  failureText.className = 'welcome-details-text';
  failure.append(failureSummary, failureText);
  const actions = documentOwner.createElement('div');
  actions.className = 'opening-actions';
  panel.append(title, step, bar, detail, failure, actions, cancel);
  root.appendChild(panel);
  return { root, panel, title, step, bar, fill, detail, cancel, failure, failureText, actions };
}

/**
 * Show every opening of the page.
 *
 * @param {Object} options
 * @param {() => boolean} options.hasDataset - Whether a dataset is on screen
 *   now (an opening begun then shows as a notification)
 * @param {Document} [options.documentOwner]
 * @param {Object} [options.progress] - Opening progress
 * @param {Object} [options.notifications] - Notification center
 * @returns {() => void} Stop showing openings
 */
export function showOpeningProgress({
  hasDataset,
  documentOwner = document,
  progress = getOpeningProgress(),
  notifications = getNotificationCenter(),
}) {
  if (typeof hasDataset !== 'function') throw new TypeError('The opening view needs hasDataset().');
  const overlay = buildOverlay(documentOwner, () => progress.cancel());
  documentOwner.body.appendChild(overlay.root);

  /** @type {{id: number, mode: 'overlay'|'notification', notificationId: string|null}|null} */
  let shown = null;
  let latest = null;
  let drawTimer = null;
  let tick = null;

  function notificationMessage(snapshot) {
    return snapshot.detail ? `${stepText(snapshot)} ${snapshot.detail}` : stepText(snapshot);
  }

  function drawRunning(snapshot) {
    if (shown.mode === 'overlay') {
      overlay.root.hidden = false;
      overlay.root.dataset.state = 'running';
      overlay.root.dataset.retrying = String(snapshot.retrying);
      overlay.title.textContent = `Opening ${snapshot.title}`;
      overlay.step.textContent = stepText(snapshot);
      overlay.detail.textContent = snapshot.detail ?? '';
      const percent = snapshot.percent;
      overlay.bar.classList.toggle('indeterminate', percent === null);
      overlay.fill.style.width = percent === null ? '' : `${percent}%`;
      if (percent === null) overlay.bar.removeAttribute('aria-valuenow');
      else overlay.bar.setAttribute('aria-valuenow', String(Math.round(percent)));
      return;
    }
    const message = notificationMessage(snapshot);
    if (shown.notificationId === null) {
      shown.notificationId = notifications.progress(message, snapshot.percent, {
        category: 'data',
        title: `Opening ${snapshot.title}`,
        onCancel: () => {
          progress.cancel();
        },
      });
      return;
    }
    try {
      notifications.updateProgress(shown.notificationId, snapshot.percent, {
        message,
        title: `Opening ${snapshot.title}`,
      });
    } catch (error) {
      // Dismissed by hand: the opening goes on, without its notification.
      if (!(error instanceof RangeError)) throw error;
    }
  }

  /** The failed opening over the empty viewer, until it is acted on or replaced. */
  function drawFailure(snapshot) {
    overlay.root.dataset.state = 'failed';
    overlay.panel.setAttribute('aria-label', 'Data not opened');
    overlay.title.textContent = 'The data could not be opened';
    overlay.step.textContent = snapshot.summary;
    overlay.failure.open = false;
    overlay.failureText.textContent = snapshot.message ?? '';
    overlay.actions.replaceChildren(...snapshot.actions.map((action, index) => createButton({
      label: action.label,
      variant: index === 0 ? 'primary' : 'secondary',
      className: 'btn-compact',
      onClick: () => {
        clearFailure();
        action.run();
      },
    })));
    overlay.root.hidden = false;
    // Nothing else holds focus this early; a keyboard user starts on the way on.
    const active = documentOwner.activeElement;
    if (active === null || active === documentOwner.body) overlay.actions.firstElementChild?.focus();
  }

  function clearFailure() {
    if (overlay.root.dataset.state !== 'failed') return;
    overlay.root.dataset.state = 'running';
    overlay.panel.setAttribute('aria-label', 'Opening data');
    overlay.actions.replaceChildren();
    overlay.root.hidden = true;
  }

  function settleNotification(close) {
    const id = shown.notificationId;
    shown.notificationId = null;
    if (id === null) return false;
    try {
      close(id);
      return true;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return false;
    }
  }

  function drawEnded(snapshot) {
    const failedHere = shown.mode === 'overlay' && snapshot.state === 'failed' && snapshot.summary !== null;
    overlay.root.hidden = true;
    clearInterval(tick);
    tick = null;
    switch (snapshot.state) {
      case 'done':
        // Over the empty viewer, the dataset appearing says it opened; a
        // message of the layer that opened it (`User data ready: …`) is
        // still kept.
        if (!settleNotification(id => notifications.complete(id, finishedText(snapshot))) && snapshot.message !== null) {
          notifications.success(snapshot.message, { category: 'data' });
        }
        break;
      case 'failed': {
        // The layer that failed logged its error to the console.
        const { message, details } = failureNotice(snapshot);
        if (!settleNotification(id => notifications.fail(id, message, { details }))) {
          notifications.error(message, { category: 'data', details });
        }
        if (failedHere) drawFailure(snapshot);
        break;
      }
      case 'cancelled':
        settleNotification(id => notifications.dismiss(id));
        notifications.info(snapshot.message, { category: 'data', duration: 3000 });
        break;
      default:
        settleNotification(id => notifications.dismiss(id));
    }
    shown = null;
  }

  function draw() {
    drawTimer = null;
    const snapshot = latest;
    if (snapshot === null || shown === null || snapshot.id !== shown.id) return;
    if (snapshot.state === 'running') drawRunning(snapshot);
    else drawEnded(snapshot);
  }

  const stop = progress.subscribe(snapshot => {
    latest = snapshot;
    if (snapshot === null) return;
    if (shown !== null && shown.id !== snapshot.id) {
      // A newer opening began while the last one's end was still to draw.
      clearTimeout(drawTimer);
      drawTimer = null;
      overlay.root.hidden = true;
      settleNotification(id => notifications.dismiss(id));
      shown = null;
    }
    if (shown === null) {
      if (snapshot.state !== 'running') return;
      // A newer opening replaces a failure still shown.
      clearFailure();
      // From its first moment: the first state is drawn at once.
      shown = { id: snapshot.id, mode: hasDataset() ? 'notification' : 'overlay', notificationId: null };
      tick = setInterval(() => {
        latest = progress.snapshot();
        draw();
      }, TICK_MS);
      draw();
      return;
    }
    if (snapshot.state !== 'running') {
      clearTimeout(drawTimer);
      draw();
      return;
    }
    drawTimer ??= setTimeout(draw, UPDATE_EVERY_MS);
  });

  return () => {
    stop();
    clearTimeout(drawTimer);
    clearInterval(tick);
    overlay.root.remove();
  };
}
