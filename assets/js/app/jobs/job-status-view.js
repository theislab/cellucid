/**
 * @fileoverview The running state of a cancellable job, in the panel that
 * started it (`jobs/cancellable-job.js`):
 *
 * - running: what the job is and costs (`plan`), what it is doing (`step`,
 *   items done of how many, bytes read, how fast, time left), a progress bar
 *   and Cancel;
 * - cancelled: a calm `Cancelled after 12 s.` and Run again;
 * - failed: why, and Run again;
 * - done: nothing (the result shows).
 *
 * A running job is shown once it has run `showAfterMs`, so a quick one does
 * not flicker; its outcome is shown at once.
 *
 * @module app/jobs/job-status-view
 */

import { createButton } from '../ui/components/controls.js';
import { formatDuration, formatCount } from '../../utils/format-units.js';

/** A running job is shown once it has run this long. */
const SHOW_RUNNING_AFTER_MS = 250;

/**
 * The words a job's state shows: `{title, detail, tone, action}` (`action`
 * `cancel`, `run-again` or null), or null when nothing is shown.
 *
 * @param {import('./cancellable-job.js').CancellableJob} job
 * @returns {{title: string, detail: string|null, tone: 'info'|'muted'|'danger', action: 'cancel'|'run-again'|null}|null}
 */
function describeJobState(job) {
  switch (job.state) {
    case 'running':
      return { title: job.title, detail: job.describe(), tone: 'info', action: 'cancel' };
    case 'cancelled': {
      const after = formatDuration((job.endedAt ?? performance.now()) - job.startedAt);
      // "Nothing was kept." is one sentence of its own whatever was done.
      const done = job.itemsTotal > 0 && job.itemsDone > 0
        ? ` ${formatCount(job.itemsDone)} of ${formatCount(job.itemsTotal)}${job.itemsUnit ? ` ${job.itemsUnit}` : ''} were done.`
        : '';
      return { title: `${job.title} cancelled`, detail: `Cancelled after ${after}.${done} Nothing was kept.`, tone: 'muted', action: 'run-again' };
    }
    case 'failed':
      return { title: `${job.title} failed`, detail: job.message, tone: 'danger', action: 'run-again' };
    default:
      return null;
  }
}

/**
 * @param {{onRunAgain: () => void, showAfterMs?: number}} options
 * @returns {{root: HTMLElement, show: (job: Object|null) => void, destroy: () => void}}
 */
export function createJobStatusView({ onRunAgain, showAfterMs = SHOW_RUNNING_AFTER_MS }) {
  if (typeof onRunAgain !== 'function') throw new TypeError('A job status view needs onRunAgain.');
  const root = document.createElement('div');
  root.className = 'job-status';
  root.hidden = true;

  const title = document.createElement('p');
  title.className = 'job-status-title';
  const plan = document.createElement('p');
  plan.className = 'job-status-plan';
  const detail = document.createElement('p');
  detail.className = 'job-status-detail';
  detail.setAttribute('role', 'status');
  detail.setAttribute('aria-live', 'polite');
  const progress = document.createElement('div');
  progress.className = 'job-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  const bar = document.createElement('div');
  bar.className = 'job-progress-bar';
  progress.appendChild(bar);

  let job = null;
  let unsubscribe = null;
  let showTimer = null;
  let action = null;
  const button = createButton({
    label: 'Cancel',
    className: 'job-status-action',
    onClick: () => {
      if (action === 'cancel') job?.cancel();
      else if (action === 'run-again') onRunAgain();
    },
  });
  root.append(title, plan, detail, progress, button);

  function render() {
    const described = job === null ? null : describeJobState(job);
    if (described === null || (job.state === 'running' && showTimer !== null)) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.dataset.state = job.state;
    root.dataset.tone = described.tone;
    title.textContent = described.title;
    plan.hidden = job.state !== 'running' || !job.plan;
    plan.textContent = job.plan ?? '';
    detail.textContent = described.detail ?? '';
    const running = job.state === 'running';
    progress.hidden = !running;
    if (running) {
      const percent = job.percent();
      progress.classList.toggle('indeterminate', percent === null);
      bar.style.width = percent === null ? '' : `${percent}%`;
      if (percent === null) progress.removeAttribute('aria-valuenow');
      else progress.setAttribute('aria-valuenow', String(Math.round(percent)));
    }
    action = described.action;
    button.hidden = action === null;
    button.disabled = false;
    button.textContent = action === 'cancel' ? 'Cancel' : 'Run again';
  }

  return {
    root,
    /** Follow `job` (null shows nothing). */
    show(nextJob) {
      unsubscribe?.();
      unsubscribe = null;
      clearTimeout(showTimer);
      showTimer = null;
      job = nextJob;
      if (job !== null) {
        unsubscribe = job.subscribe(render);
        if (job.state === 'running') {
          showTimer = setTimeout(() => {
            showTimer = null;
            render();
          }, showAfterMs);
        }
      }
      render();
    },
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
      clearTimeout(showTimer);
      showTimer = null;
      job = null;
      root.remove();
    },
  };
}
