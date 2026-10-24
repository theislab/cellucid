/**
 * The openings (`data/opening-progress.js`) a test started, recorded as the
 * notification events they show as: `loading` when one begins, then one of
 * `complete` (with what it said), `fail` (with why) or `dismiss`.
 */
import { getOpeningProgress } from '../../assets/js/data/opening-progress.js';
import { dataSourceFailureDetails } from '../../assets/js/app/ui/modules/dataset-connections.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {Object[]} events - Where the events are pushed
 */
export function recordOpenings(t, events) {
  const seen = new Set();
  const stop = getOpeningProgress().subscribe(snapshot => {
    if (snapshot === null) return;
    const id = `opening-${snapshot.id}`;
    if (!seen.has(id)) {
      seen.add(id);
      events.push({ id, kind: 'loading', message: snapshot.title });
    }
    if (snapshot.state === 'running' || seen.has(`${id}:ended`)) return;
    seen.add(`${id}:ended`);
    if (snapshot.state === 'done') {
      events.push({ id, kind: 'complete', message: snapshot.message });
    } else if (snapshot.state === 'failed') {
      // A sentence of the layer's own, or an error whose cause (the raw
      // text) the notification folds under its Details.
      const said = typeof snapshot.error === 'string';
      events.push({
        id,
        kind: 'fail',
        message: said ? snapshot.error : snapshot.message,
        details: said ? '' : dataSourceFailureDetails(snapshot.error?.details?.cause ?? snapshot.error),
      });
    } else {
      events.push({ id, kind: 'dismiss' });
    }
  });
  t.after(stop);
}
