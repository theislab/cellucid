/**
 * Progress of the reads a person waits for that nothing else shows: one
 * notification for all of them, in plain words ("Reading field cell_type and
 * the neighbour graph · 4.1 MB of 9.3 MB · ~3 s left"), on screen once the
 * reads have run `NOTICE_AFTER_MS` (`notification-center.js`), and gone when
 * they end: the view changing is their answer. A read that fails leaves the
 * card and says nothing here: what asked for it (the opening, the field or
 * gene, the job) reports its failure, once. Said here too, the same failure
 * was said twice, and a read nobody asked to hear about (an optional one its
 * caller lets fail) would have been said at all.
 *
 * Shown elsewhere, and so not here:
 * - the reads of an opening (the file's structure, the embedding and field
 *   its first view draws): the opening progress (`data/opening-progress.js`,
 *   `app/opening-progress-view.js`);
 * - the reads of a growing opening (the cells added to the open ones,
 *   `cells added`): the Dataset box, which says how many cells are open;
 * - a job's reads (an analysis's, outlier quantiles': `JOB_READ_KINDS`, and
 *   a read a job joined after something else started it): the job's own
 *   notification, which can cancel it (`jobs/cancellable-job.js`);
 * - work nobody waits for (`background`: an index built ahead of need).
 *
 * The reader's own words for each read (`obsm['X_umap'] columns 0, 1, open
 * cells 0–262,144`) stay in the console (`[cellucid:read]`).
 *
 * @module app/read-progress-notifications
 */

import { getNotificationCenter } from './notification-center.js';
import { isJobRead } from './jobs/cancellable-job.js';
import { GROWTH_READ_REASON, getReadActivityLog } from '../data/read-activity-log.js';
import { getOpeningProgress } from '../data/opening-progress.js';
import { formatBytes, formatRemaining } from '../utils/format-units.js';

/** A read of the cells added to a growing opening (`embedding-payload.js`). */
function isGrowthRead(activity) {
  return activity.label.endsWith(`, ${GROWTH_READ_REASON})`);
}

/**
 * What one read is, in the words of what the person asked for: `field
 * cell_type`, `the embedding X_umap`, `genes`, `the neighbour graph`.
 *
 * @param {{kind: string, label: string}} activity
 * @returns {string}
 */
function describeReadPurpose(activity) {
  const quoted = pattern => pattern.exec(activity.label)?.[1] ?? null;
  switch (activity.kind) {
    case 'embedding': {
      const key = quoted(/obsm\['([^']+)'\]/);
      return key === null ? 'the embedding' : `the embedding ${key}`;
    }
    case 'field':
    case 'fields': {
      const key = quoted(/obs\['([^']+)'\]/);
      return key === null ? 'a field' : `field ${key}`;
    }
    case 'genes':
      return 'genes';
    case 'cells':
      return 'cells';
    case 'names':
      return /obs names/.test(activity.label) ? 'cell names' : 'gene names';
    case 'graph':
      return 'the neighbour graph';
    case 'transcode':
      return 'the file, once, whole';
    case 'transpose':
      return 'the matrix, gene by gene';
    case 'index':
      return 'a gene index';
    default:
      return 'data';
  }
}

function joinPurposes(purposes) {
  const distinct = [...new Set(purposes)];
  if (distinct.length <= 2) return distinct.join(' and ');
  return `${distinct.slice(0, 2).join(', ')} and ${distinct.length - 2} more`;
}

/** The one line of the reads under way: what, how much of how much, how long is left. */
function describeReads(reads) {
  const fetched = reads.reduce((sum, read) => sum + read.bytesFetched, 0);
  const total = reads.every(read => read.bytesTotal > 0)
    ? reads.reduce((sum, read) => sum + read.bytesTotal, 0)
    : null;
  const left = reads.reduce(
    (most, read) => (Number.isFinite(read.remainingMs) ? Math.max(most ?? 0, read.remainingMs) : most),
    null
  );
  const parts = [`Reading ${joinPurposes(reads.map(describeReadPurpose))}`];
  if (total !== null && total > fetched) parts.push(`${formatBytes(fetched)} of ${formatBytes(total)}`);
  else if (fetched > 0) parts.push(`${formatBytes(fetched)} read`);
  if (left !== null) parts.push(`${formatRemaining(left)} left`);
  const waiting = reads.find(read => read.waiting)?.waiting ?? null;
  if (waiting !== null) parts.push(`waiting: ${waiting.text}`);
  return {
    message: parts.join(' · '),
    percent: total !== null && total > 0 ? Math.min(100, (100 * fetched) / total) : null,
  };
}

/**
 * Show the reads nothing else shows as one progress notification.
 *
 * @param {{log?: Object, notifications?: Object, opening?: Object}} [options]
 * @returns {() => void} Stop showing them
 */
export function showReadProgress({
  log = getReadActivityLog(),
  notifications = getNotificationCenter(),
  opening = getOpeningProgress(),
} = {}) {
  /** @type {Map<number, Object>} The reads shown, running, by activity id */
  const running = new Map();
  let id = null;

  const shownHere = activity => !(
    activity.kind === 'open'
    || activity.background === true
    || isGrowthRead(activity)
    || opening.shows(activity)
    || isJobRead(activity)
  );

  const close = () => {
    if (id === null) return;
    const closing = id;
    id = null;
    try {
      notifications.dismiss(closing);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  };

  const publish = () => {
    if (running.size === 0) {
      close();
      return;
    }
    const { message, percent } = describeReads([...running.values()]);
    try {
      if (id === null || !notifications.hasNotification(id)) {
        id = notifications.progress(message, percent ?? 0, { category: 'data' });
        if (percent === null) notifications.updateProgress(id, null);
      } else {
        notifications.updateProgress(id, percent, { message });
      }
    } catch (error) {
      // Dismissed by hand: the reads go on without it.
      id = null;
      if (!(error instanceof RangeError)) throw error;
    }
  };

  return log.subscribe(activity => {
    if (!shownHere(activity)) {
      // A read someone else took over after it was shown is theirs now.
      if (running.delete(activity.id)) publish();
      return;
    }
    if (activity.status === 'running') running.set(activity.id, activity);
    else running.delete(activity.id);
    publish();
  });
}
