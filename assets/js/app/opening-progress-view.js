/**
 * Shows the opening under way (`data/opening-progress.js`) from its first
 * moment, in one of two places:
 *
 * - **The startup overlay**, centered over the empty viewer, while no dataset
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
 * An opening that waits for the person to pick one of the objects a file
 * holds (an `.rda` of several Seurat objects, `handle.choose()`) shows the
 * same panel with one button per object, wherever the opening is shown;
 * Cancel stays.
 *
 * A failed opening whose layer said what it means and offered ways on (the
 * data the page's address names, at startup) stays over the empty viewer:
 * one plain sentence, the failure's own message folded under Details, and
 * its actions (Try again, Open without this link). The app around it works;
 * a newer opening replaces it. So does a failure said as a card while a
 * dataset was shown: the next opening withdraws it as it begins, so a
 * refused file's card does not stay through later openings, reading as if the
 * dataset shown had failed.
 *
 * With no opening shown and no dataset on screen (None chosen, a link opened
 * without, an opening canceled), the same panel says so and where to open
 * one, with a button that shows that place (the viewer would otherwise be a
 * blank plane that says nothing). `refreshEmptyViewer` re-reads it when the cells
 * on screen come or go.
 *
 * @module app/opening-progress-view
 */

import { getNotificationCenter } from './notification-center.js';
import { createButton } from './ui/components/controls.js';
import { NO_DATASET_LABEL, OPEN_DATASET_PLACE } from './ui/no-dataset.js';
import { revealInSidebar } from './ui/modules/sidebar-controls.js';
import { getOpeningProgress } from '../data/opening-progress.js';
import { describeHostFault, isExplainedFailure } from '../data/data-source.js';
import { formatBytes, formatDuration } from '../utils/format-units.js';
import { debounce } from '../utils/debounce.js';

/** A running opening's figures are drawn at most this often (its name and its end at once); a second's tick keeps the elapsed time live. */
const UPDATE_EVERY_MS = 200;
const TICK_MS = 1000;

function stepText(snapshot) {
  return /[.…]$/.test(snapshot.step) ? snapshot.step : `${snapshot.step}…`;
}

function finishedText(snapshot) {
  if (snapshot.message !== null) return snapshot.message;
  const read = snapshot.bytes > 0 ? `, ${formatBytes(snapshot.bytes)} read` : '';
  return `Opened ${snapshot.title} (${formatDuration(snapshot.elapsedMs)}${read}).`;
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
  // A host's answer says whose problem it is; only a cause nobody can name
  // is the generic sentence.
  const fault = describeHostFault(error);
  return { message: fault?.sentence ?? `Could not open ${snapshot.title}.`, details: rawText(error) };
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
  // How the opening reads its data, when the person should know it up front
  // (a file that cannot be read in parts).
  const note = documentOwner.createElement('p');
  note.className = 'opening-note';
  note.hidden = true;
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
  panel.append(title, step, bar, detail, note, failure, actions, cancel);
  root.appendChild(panel);
  return { root, panel, title, step, bar, fill, detail, note, cancel, failure, failureText, actions };
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
/** The shown view's re-read of the empty viewer (one view per page). */
let settleEmptyOfView = null;

/**
 * The cells on screen came or went (a dataset published, None chosen): the
 * empty viewer's panel is shown or withdrawn to match.
 */
export function refreshEmptyViewer() {
  settleEmptyOfView?.();
}

/** How long the viewer is empty before it says so: an opening's end and its first cells are not one moment. */
const EMPTY_AFTER_MS = 250;

/** What the empty viewer says. */
const EMPTY_VIEWER_SENTENCE =
  `Choose a sample, open a file or folder, or paste a link in ${OPEN_DATASET_PLACE}; a file can also be dropped here.`;

export function showOpeningProgress({
  hasDataset,
  documentOwner = document,
  progress = getOpeningProgress(),
  notifications = getNotificationCenter(),
}) {
  if (typeof hasDataset !== 'function') throw new TypeError('The opening view needs hasDataset().');
  const overlay = buildOverlay(documentOwner, () => progress.cancel());
  documentOwner.body.appendChild(overlay.root);

  /** @type {{id: number, mode: 'overlay'|'notification', notificationId: string|null, title: string|null}|null} The opening shown, and the name it was last drawn with */
  let shown = null;
  let latest = null;
  let drawTimer = null;
  let tick = null;

  function notificationMessage(snapshot) {
    const running = snapshot.detail ? `${stepText(snapshot)} ${snapshot.detail}` : stepText(snapshot);
    return snapshot.note ? `${running}\n${snapshot.note}` : running;
  }

  function drawNote(snapshot) {
    overlay.note.textContent = snapshot.note ?? '';
    overlay.note.hidden = !snapshot.note;
  }

  /** The person's pick among a file's objects, in the panel, whatever the mode. */
  function drawChoice(snapshot) {
    const { choice } = snapshot;
    const key = `${snapshot.id}:${choice.question}`;
    overlay.root.hidden = false;
    overlay.root.dataset.state = 'choosing';
    overlay.title.textContent = `Opening ${snapshot.title}`;
    overlay.step.textContent = choice.question;
    overlay.detail.textContent = snapshot.detail ?? '';
    if (overlay.actions.dataset.choice === key) return;
    overlay.actions.dataset.choice = key;
    overlay.actions.replaceChildren(...choice.options.map((label, index) => createButton({
      label,
      variant: 'secondary',
      className: 'btn-compact',
      onClick: () => {
        delete overlay.actions.dataset.choice;
        overlay.actions.replaceChildren();
        choice.choose(index);
      },
    })));
    overlay.actions.firstElementChild?.focus();
  }

  function clearChoice() {
    if (overlay.actions.dataset.choice === undefined) return;
    delete overlay.actions.dataset.choice;
    overlay.actions.replaceChildren();
    if (shown?.mode === 'notification') overlay.root.hidden = true;
  }

  function drawRunning(snapshot) {
    if (snapshot.choice) {
      drawChoice(snapshot);
      return;
    }
    clearChoice();
    if (shown.mode === 'overlay') {
      overlay.root.hidden = false;
      overlay.root.dataset.state = 'running';
      overlay.root.dataset.retrying = String(snapshot.retrying);
      overlay.title.textContent = `Opening ${snapshot.title}`;
      overlay.step.textContent = stepText(snapshot);
      overlay.detail.textContent = snapshot.detail ?? '';
      drawNote(snapshot);
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
    // The failure's message and what caused it (a host's failure: the requests made).
    overlay.failureText.textContent = rawText(snapshot.error) || (snapshot.message ?? '');
    overlay.actions.replaceChildren(...snapshot.actions.map((action, index) => createButton({
      label: action.label,
      variant: index === 0 ? 'primary' : 'secondary',
      className: 'btn-compact',
      onClick: () => {
        clearFailure();
        action.run();
        settleEmpty();
      },
    })));
    overlay.root.hidden = false;
    // Nothing else holds focus this early; a keyboard user starts on the way on.
    const active = documentOwner.activeElement;
    if (active === null || active === documentOwner.body) overlay.actions.firstElementChild?.focus();
  }

  /** Open data, shown and focused: the way on from the empty viewer. */
  function revealOpenData() {
    void revealInSidebar(documentOwner, () => {
      const session = documentOwner.getElementById('session-section');
      if (session !== null && 'open' in session) session.open = true;
      const target = documentOwner.getElementById('dataset-select');
      target?.scrollIntoView?.({ block: 'nearest' });
      target?.focus?.();
    });
  }

  function drawEmpty() {
    overlay.root.dataset.state = 'empty';
    overlay.panel.setAttribute('aria-label', NO_DATASET_LABEL);
    overlay.title.textContent = NO_DATASET_LABEL;
    overlay.step.textContent = EMPTY_VIEWER_SENTENCE;
    overlay.actions.replaceChildren(createButton({
      label: 'Show Open data',
      variant: 'secondary',
      className: 'btn-compact',
      onClick: revealOpenData,
    }));
    overlay.root.hidden = false;
  }

  // The empty viewer's panel is drawn once nothing else showed for EMPTY_AFTER_MS.
  const drawEmptySoon = debounce(() => {
    if (shown === null && !hasDataset() && overlay.root.dataset.state === 'running') drawEmpty();
  }, EMPTY_AFTER_MS);
  /** Show the empty viewer's panel when nothing else is, withdraw it when a dataset is. */
  function settleEmpty() {
    drawEmptySoon.cancel();
    const state = overlay.root.dataset.state;
    if (hasDataset()) {
      if (state === 'empty') clearEmpty();
      return;
    }
    if (shown !== null || state === 'failed' || state === 'choosing' || state === 'empty') return;
    drawEmptySoon();
  }

  function clearEmpty() {
    if (overlay.root.dataset.state !== 'empty') return;
    overlay.root.dataset.state = 'running';
    overlay.panel.setAttribute('aria-label', 'Opening data');
    overlay.actions.replaceChildren();
    overlay.root.hidden = true;
  }
  settleEmptyOfView = settleEmpty;

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
    clearChoice();
    const failedHere = shown.mode === 'overlay' && snapshot.state === 'failed' && snapshot.summary !== null;
    overlay.root.hidden = true;
    clearInterval(tick);
    tick = null;
    switch (snapshot.state) {
      case 'done':
        // Over the empty viewer, the dataset appearing says it opened; a
        // message of the layer that opened it (`User data ready: …`) is
        // still kept. Over a dataset already shown, the outcome is said even
        // when the opening was too quick for its card to appear: the person
        // chose it, and what opened (and how many cells) is news.
        if (!settleNotification(id => notifications.complete(id, finishedText(snapshot), { announce: true })) && snapshot.message !== null) {
          notifications.success(snapshot.message, { category: 'data' });
        }
        break;
      case 'failed': {
        // The layer that failed logged its error to the console. Over the
        // empty viewer the failure is said there, once, with its ways on;
        // a card saying it again beside it would only repeat it.
        if (failedHere) {
          settleNotification(id => notifications.dismiss(id));
          drawFailure(snapshot);
          break;
        }
        const { message, details } = failureNotice(snapshot);
        // Ways on the failing layer offered (Try again, for a host's
        // problem that may pass) ride on the card as its action.
        const way = snapshot.actions[0] ?? null;
        if (way !== null) {
          settleNotification(id => notifications.dismiss(id));
          progress.untilNextOpening(notifications.error(message, { category: 'data', details, action: { label: way.label, run: way.run } }));
          break;
        }
        const progressCard = shown.notificationId;
        if (settleNotification(id => notifications.fail(id, message, { details }))) {
          progress.untilNextOpening(progressCard);
        } else {
          progress.untilNextOpening(notifications.error(message, { category: 'data', details }));
        }
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
    settleEmpty();
  }

  function draw() {
    drawTimer = null;
    const snapshot = latest;
    if (snapshot === null || shown === null || snapshot.id !== shown.id) return;
    if (snapshot.state === 'running') {
      shown.title = snapshot.title;
      drawRunning(snapshot);
    } else drawEnded(snapshot);
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
      // A newer opening replaces a failure still shown, over the viewer or
      // as a card, and every notice kept until it began (`untilNextOpening`),
      // and the empty viewer's panel.
      clearFailure();
      clearEmpty();
      drawEmptySoon.cancel();
      for (const id of progress.takeEarlierNotices()) notifications.dismiss(id);
      // From its first moment: the first state is drawn at once.
      shown = { id: snapshot.id, mode: hasDataset() ? 'notification' : 'overlay', notificationId: null, title: null };
      tick = setInterval(() => {
        latest = progress.snapshot();
        draw();
      }, TICK_MS);
      draw();
      return;
    }
    // The end is drawn at once, and so is a new name: what is opened is said
    // from the moment it is known, however soon the next name or the end
    // follows (a catalog's name for a sample, then the file's own). Only the
    // figures of a running opening wait for the next drawing.
    if (snapshot.state !== 'running' || snapshot.title !== shown.title) {
      clearTimeout(drawTimer);
      draw();
      return;
    }
    drawTimer ??= setTimeout(draw, UPDATE_EVERY_MS);
  });

  return () => {
    stop();
    clearTimeout(drawTimer);
    drawEmptySoon.cancel();
    clearInterval(tick);
    if (settleEmptyOfView === settleEmpty) settleEmptyOfView = null;
    overlay.root.remove();
  };
}
