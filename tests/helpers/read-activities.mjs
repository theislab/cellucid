/**
 * The read operations the app's read activity log tells of
 * (`data/read-activity-log.js`), each by its latest report: the log keeps
 * only the operations under way, and tells its subscribers of every one.
 */
import { getReadActivityLog } from '../../assets/js/data/read-activity-log.js';

/**
 * Start recording.
 *
 * @returns {{all: () => Object[], clear: () => void, stop: () => void}}
 */
export function recordReadActivities() {
  const log = getReadActivityLog();
  const told = new Map();
  const stop = log.subscribe(activity => told.set(activity.id, activity));
  return {
    /** Every operation told of since the start or the last `clear()`, oldest first. */
    all() {
      log.flush();
      return [...told.values()];
    },
    clear() {
      log.flush();
      told.clear();
    },
    stop,
  };
}
