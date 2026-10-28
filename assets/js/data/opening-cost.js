/**
 * What showing a cell costs this page, measured: the page side of a
 * progressive opening's cost model (`anndata/progressive-open.js`), which
 * predicts that a first view of `k` cells takes the link's time to read
 * them plus `k` times it. Its meaning is that prediction's: what a cell
 * adds to the time from the moment an opening's cells are in the page
 * (read, their GPU stores about to be made) until the first frame that
 * draws them (`recordFirstFrame`, from `app/main.js` on every opening of a
 * dataset, a progressive opening's first view among them). Work on the
 * cells shown already is not an opening and is not recorded: an in-place
 * resize (`app/open-cells-resize.js`) keeps the GPU stores of the cells it
 * keeps, appends only the cells it adds and makes every open cell's
 * colours and filters again, so its time is neither its added cells' cost
 * nor its open cells' on an opening (measured, a 20M-cell store in
 * Chromium: raising 10M cells to 20M took 340-380 ms to its first frame,
 * 34-38 ns an added cell, against an opening's 9 ns a cell below).
 *
 * An opening also costs what showing any dataset costs, whatever its
 * cells (its controls made again, its first frame begun): measured in
 * Chromium, 10K cells took 27 ms to their first frame, 100K 23 ms, 1M 31 ms
 * and 5M 70 ms, about 25 ms and 9 ns a cell. So the measure is the cost a
 * cell adds, the slope of the line through the records (time against
 * cells, least squares), not their ratio, which would make a cell of the
 * 10K-cell opening cost 300 times one of the 5M. Each earlier record counts
 * half as much as the one after it, so an odd record (a slow moment) fades
 * as later ones come and no single record keeps sizing later openings.
 * While the records hold one size only (one opening, or several of the
 * same cells), or the line would cost an opening less than nothing (its
 * records too close in size to tell the slope from noise), the line goes
 * through the origin (the cells' share is then all of the time). An opening
 * asks for its first view with it (`progressiveRequest`). Kept in memory
 * and, as a convenience across visits, in this browser's storage (never
 * required); with nothing measured, only the link's cost counts.
 *
 * @module data/opening-cost
 */

/**
 * How soon a first view should show: the response time below which a
 * person's flow of thought is kept (about one second; Card, Robertson and
 * Mackinlay 1991; Nielsen 1993). It sizes a progressive opening's first view;
 * it limits nothing: the opening grows to every cell asked for.
 */
export const FIRST_VIEW_TARGET_MS = 1000;

/**
 * Where the measure is kept across visits. `v2`: an opening's cells in the
 * page to their first frame (`v1` held in-place resize commits, another
 * quantity, and is not read).
 */
export const OPENING_COST_STORAGE_KEY = 'cellucid:opening-cost:v2';

/**
 * The decayed sums of the records (cells `x`, milliseconds `y`, each with
 * its weight `w`): `{w, x, y, xx, xy}` (the sums of `w`, `w x`, `w y`,
 * `w x^2`, `w x y`), or null before any.
 */
let sums = null;
let loaded = false;
const SUM_KEYS = ['w', 'x', 'y', 'xx', 'xy'];

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isSums(value) {
  return value !== null && typeof value === 'object'
    && SUM_KEYS.every(key => Number.isFinite(value[key]) && value[key] >= 0)
    && value.w > 0 && value.x > 0 && value.xx > 0;
}

function load() {
  if (loaded) return sums;
  loaded = true;
  try {
    const saved = JSON.parse(storage()?.getItem(OPENING_COST_STORAGE_KEY) ?? 'null');
    if (isSums(saved)) sums = Object.fromEntries(SUM_KEYS.map(key => [key, saved[key]]));
  } catch {
    // Storage unavailable or unreadable: measure afresh.
  }
  return sums;
}

/**
 * Record that showing `cells` cells of an opening took `ms`.
 *
 * @param {number} cells
 * @param {number} ms
 */
export function recordShownCells(cells, ms) {
  if (!(cells > 0) || !(ms >= 0) || !Number.isFinite(ms)) return;
  const earlier = load();
  const record = { w: 1, x: cells, y: ms, xx: cells * cells, xy: cells * ms };
  sums = Object.fromEntries(SUM_KEYS.map(key => [key, (earlier === null ? 0 : earlier[key] / 2) + record[key]]));
  try {
    storage()?.setItem(OPENING_COST_STORAGE_KEY, JSON.stringify(sums));
  } catch {
    // Storage full or blocked: the measure lives on in memory.
  }
}

/**
 * Record an opening's cost once its cells are drawn: `cells` cells in the
 * page since `startedAt` (`performance.now()`), the first frame after this
 * call (`afterNextFrame`: run once the next frame is drawn,
 * `rendering/frame-phases.js` `runAfterNextFrame`) the one that shows
 * them. It is recorded when that frame drew cells of the opening
 * (`drawn()`); a frame that drew none (every cell outside the camera, the
 * viewer stopped), or one the page waited for while hidden (no frame is
 * drawn then), says nothing of what they cost, and nothing is recorded.
 * `signal` (the opening's publication) ends the wait: cells replaced before
 * their first frame are not recorded either.
 *
 * @param {{cells: number, startedAt: number, afterNextFrame: (run: () => void) => (() => void),
 *   drawn: () => boolean, signal?: AbortSignal|null}} options
 * @returns {Promise<number|null>} The milliseconds recorded, or null
 */
export function recordFirstFrame({ cells, startedAt, afterNextFrame, drawn, signal = null }) {
  if (!(cells > 0) || !Number.isFinite(startedAt) || signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let cancel = () => {};
    const stop = () => {
      cancel();
      resolve(null);
    };
    signal?.addEventListener('abort', stop, { once: true });
    cancel = afterNextFrame(() => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted || !drawn()) {
        resolve(null);
        return;
      }
      const ms = performance.now() - startedAt;
      recordShownCells(cells, ms);
      resolve(ms);
    });
  });
}

/** Forget every record (tests). */
export function resetShownCells() {
  sums = null;
  loaded = true;
}

/**
 * The measured milliseconds a shown cell adds to an opening (module doc),
 * or null before any measure.
 */
export function shownMsPerCell() {
  const m = load();
  if (m === null) return null;
  // The spread of the records' sizes; nothing beside rounding when they are
  // one size.
  const spread = m.w * m.xx - m.x * m.x;
  if (spread > m.w * m.xx * Number.EPSILON * 64) {
    const slope = (m.w * m.xy - m.x * m.y) / spread;
    const fixed = (m.y - slope * m.x) / m.w;
    if (fixed >= 0) return Math.max(0, slope);
  }
  return m.xy / m.xx;
}

/**
 * What an opening asks of a progressive first view (`AnnDataReader`
 * `_openCells`, `request.progressive`).
 *
 * @returns {{targetMs: number, msPerCell: number|null}}
 */
export function progressiveRequest() {
  return { targetMs: FIRST_VIEW_TARGET_MS, msPerCell: shownMsPerCell() };
}
