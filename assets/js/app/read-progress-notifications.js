/**
 * Progress notifications for long reads of an AnnData file: a gene a view
 * shows, an embedding or vector field, an obs field, a gene index, the
 * neighbour graph. Each read the reader worker reports
 * (`data/read-activity-log.js`) that runs longer than a moment gets one
 * notification saying what is read, how much of how much, how fast and how
 * long is left, updated as it goes, and closed with what it read and how
 * long it took. Opening a file is shown by the startup view instead, and a
 * job's reads (an analysis's, outlier quantiles': `JOB_READ_KINDS`, and a
 * read a job joined after something else started it: `adopt`) by the job's
 * own notification, which can cancel it (`jobs/cancellable-job.js`): a run
 * is one notification, whoever started its reads.
 *
 * @module app/read-progress-notifications
 */

import { getNotificationCenter } from './notification-center.js';
import { isJobRead } from './jobs/cancellable-job.js';
import { formatTransferBytes } from '../data/transfer-log.js';
import { describeReadProgress, formatDuration, getReadActivityLog } from '../data/read-activity-log.js';

/** A read is shown once it has run this long; shorter ones would only flicker. */
const SHOW_AFTER_MS = 700;

function percentOf(activity) {
  if (activity.bytesTotal > 0) return Math.min(100, (100 * activity.bytesFetched) / activity.bytesTotal);
  if (activity.progress?.total > 0) return (100 * activity.progress.done) / activity.progress.total;
  return 0;
}

function runningMessage(activity) {
  const progress = describeReadProgress(activity);
  return progress === null ? `Reading ${activity.label}` : `Reading ${activity.label}: ${progress}`;
}

function finishedMessage(activity) {
  const amount = activity.bytesFetched > 0 ? `${formatTransferBytes(activity.bytesFetched)} read` : 'read';
  return `${activity.label}: ${amount} in ${formatDuration(activity.elapsedMs)}`;
}

/**
 * Show long reads as progress notifications.
 *
 * @param {{log?: Object, notifications?: Object}} [options]
 * @returns {() => void} Stop showing them
 */
export function showReadProgress({ log = getReadActivityLog(), notifications = getNotificationCenter() } = {}) {
  /** @type {Map<number, string>} Notification id by activity id */
  const shown = new Map();
  return log.subscribe(activity => {
    const id = shown.get(activity.id) ?? null;
    if (activity.kind === 'open' || isJobRead(activity)) {
      // A read a job joined after it was shown is the job's now: its
      // notification goes, the job's shows it.
      if (id !== null) {
        shown.delete(activity.id);
        try {
          notifications.dismiss(id);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
        }
      }
      return;
    }
    try {
      if (activity.status === 'running') {
        if (id === null) {
          if (activity.elapsedMs < SHOW_AFTER_MS) return;
          shown.set(activity.id, notifications.progress(runningMessage(activity), percentOf(activity)));
        } else {
          notifications.updateProgress(id, percentOf(activity), { message: runningMessage(activity) });
        }
        return;
      }
      if (id === null) return;
      shown.delete(activity.id);
      if (activity.status === 'done') notifications.complete(id, finishedMessage(activity));
      else if (activity.status === 'failed') notifications.fail(id, `${activity.label} could not be read: ${activity.detail}`);
      else notifications.dismiss(id);
    } catch (error) {
      // A notification that was dismissed by hand is simply no longer updated.
      shown.delete(activity.id);
      if (!(error instanceof RangeError)) throw error;
    }
  });
}
