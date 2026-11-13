/**
 * @module app/ui/core/antialias-preference
 *
 * Multisample antialiasing: what the user asked for, and what a dataset asks for
 * when the user has not.
 *
 * Antialiasing is not a WebGL context-creation attribute fixed for the life of
 * the page: `rendering/scene-msaa-target.js` multisamples a renderbuffer the
 * application owns, so the setting is live, and this module answers what to
 * do when nothing has been chosen.
 *
 * The question is what to do when nothing has been chosen. A single default
 * cannot be right for every dataset: at millions of cells multisampling is the
 * difference between a view that turns and one that does not, and at a few
 * thousand it costs nothing worth measuring. So the stored preference has three
 * states rather than two, and the third — `auto`, which is also what an absent
 * key means — defers to the cell count of whatever dataset is open. Because
 * datasets are switched in place, `auto` is re-evaluated per dataset rather than
 * once per page.
 *
 * A stored value in none of the three forms is discarded rather than obeyed, and
 * the caller is handed the raw value so it can say so. That is deliberately not
 * fatal: the application is the only writer of this key, so a partial write or a
 * tab killed mid-save is enough to produce one, and there is no in-app recovery
 * from a startup that fails the same way on every reload. It is the same call
 * `github-auth-session` makes for a corrupt stored session, and for the same
 * reason. Nothing is silent — `main.js` reports the discarded value once the
 * notification center exists.
 */

/** The `localStorage` key. */
export const ANTIALIAS_STORAGE_KEY = 'cellucid_antialias';

/** The three things the preference can say. */
export const ANTIALIAS_MODES = Object.freeze(['auto', 'on', 'off']);

/**
 * What an absent or unusable stored value means.
 *
 * `auto` rather than `on`: the cell count is a better predictor of the right
 * answer than any constant, and it is known as soon as a dataset is
 * published.
 */
export const DEFAULT_ANTIALIAS_MODE = 'auto';

/**
 * The cell count at which automatic antialiasing turns off.
 *
 * Multisampling multiplies the cost of every covered pixel, and a cloud of this
 * many cells covers nearly every pixel it is drawn over — so this is where the
 * cost stops being a rounding error and starts being the frame budget. Below it
 * the smoothing is close to free and it is what makes a sparse cloud read as
 * round dots rather than as squares; at and above it, points are far smaller than
 * the smoothing they would receive, and there is little left for it to smooth.
 */
export const AUTOMATIC_ANTIALIAS_CELL_LIMIT = 5_000_000;

/**
 * The cell count at which automatic antialiasing turns off for a 1D or 2D view.
 *
 * A flat view draws without depth testing, so every overlapping point is shaded
 * and blended in order — per sample under multisampling, which more than
 * doubles the GPU frame time of a million-cell 2D view, against a much smaller
 * cost in 3D, where depth testing rejects most fragments
 * first (measured: 28_decisions_rendering_layers.md). The cost grows with the
 * cell count, so at this many cells the antialiased frame fits a 120 Hz budget
 * on far smaller GPUs.
 */
export const AUTOMATIC_ANTIALIAS_CELL_LIMIT_FLAT = 200_000;

function assertStorage(storage, operation) {
  // Null: this browser keeps nothing for the site (`utils/web-storage.js`).
  if (storage === null) return null;
  if (
    typeof storage !== 'object'
    || typeof storage.getItem !== 'function'
    || typeof storage.setItem !== 'function'
    || typeof storage.removeItem !== 'function'
  ) {
    throw new TypeError(
      `${operation} requires one current key/value storage, or null.`
    );
  }
  return storage;
}

/**
 * @typedef {object} ResolvedAntialiasPreference
 * @property {'auto'|'on'|'off'} mode What the user chose, or `auto`.
 * @property {string|null} discarded The stored value that was thrown away, so
 *   the caller can report it. `null` when nothing had to be discarded — which
 *   includes a storage that cannot be read at all.
 */

/**
 * Resolve the stored antialiasing preference.
 *
 * Never throws for anything a browser can legitimately present: an absent key, an
 * unreadable storage, and a value in none of the three forms all resolve to
 * `auto`. Only the last is something to tell the user about, and it comes back in
 * `discarded` rather than being swallowed.
 *
 * @param {Storage|null} storage - Null where this browser keeps nothing
 * @returns {ResolvedAntialiasPreference}
 */
export function resolveAntialiasPreference(storage) {
  if (assertStorage(storage, 'Reading the antialiasing preference') === null) {
    return { mode: DEFAULT_ANTIALIAS_MODE, discarded: null };
  }
  let stored;
  try {
    stored = storage.getItem(ANTIALIAS_STORAGE_KEY);
  } catch {
    // A sandboxed frame or blocked third-party storage. Nothing was chosen, so
    // nothing was lost, and there is nothing to report.
    return { mode: DEFAULT_ANTIALIAS_MODE, discarded: null };
  }
  if (stored === null || stored === undefined) {
    return { mode: DEFAULT_ANTIALIAS_MODE, discarded: null };
  }
  if (ANTIALIAS_MODES.includes(stored)) {
    return { mode: stored, discarded: null };
  }
  try {
    storage.removeItem(ANTIALIAS_STORAGE_KEY);
  } catch {
    // Removing it is not required for a coherent start. A storage that refuses
    // the removal keeps the unusable value, which is then reported again on the
    // next load — noisy but true. Refusing to start would be neither.
  }
  return { mode: DEFAULT_ANTIALIAS_MODE, discarded: stored };
}

/**
 * Store the antialiasing preference where this browser keeps it. A browser
 * that keeps nothing for the site, or refuses the write (a full store), keeps
 * the choice for this page only: the choice is made either way.
 *
 * @param {Storage|null} storage
 * @param {'auto'|'on'|'off'} mode
 * @returns {boolean} Whether it is kept for the next visit
 */
export function writeAntialiasPreference(storage, mode) {
  const kept = assertStorage(storage, 'Storing the antialiasing preference');
  if (!ANTIALIAS_MODES.includes(mode)) {
    throw new TypeError(
      'Antialiasing preference must be exactly "auto", "on", or "off".'
    );
  }
  if (kept === null) return false;
  try {
    kept.setItem(ANTIALIAS_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a view of this many cells, drawn in this dimension, should be
 * antialiased.
 *
 * @param {number} cellCount
 * @param {1|2|3} dimension The dimension of the view being drawn.
 * @returns {boolean}
 */
export function automaticAntialiasing(cellCount, dimension) {
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
    throw new RangeError(
      'Automatic antialiasing requires one positive safe integer cell count.'
    );
  }
  if (dimension !== 1 && dimension !== 2 && dimension !== 3) {
    throw new RangeError(
      'Automatic antialiasing requires a view dimension of 1, 2, or 3.'
    );
  }
  const limit = dimension === 3
    ? AUTOMATIC_ANTIALIAS_CELL_LIMIT
    : AUTOMATIC_ANTIALIAS_CELL_LIMIT_FLAT;
  return cellCount < limit;
}

/**
 * Resolve one mode, cell count and view dimension into what the renderer
 * should do.
 *
 * @param {'auto'|'on'|'off'} mode
 * @param {number|null} cellCount Null while no dataset is open.
 * @param {1|2|3|null} dimension Null while no dataset is open.
 * @returns {boolean}
 */
export function antialiasingInForce(mode, cellCount, dimension) {
  if (!ANTIALIAS_MODES.includes(mode)) {
    throw new TypeError(
      'Antialiasing preference must be exactly "auto", "on", or "off".'
    );
  }
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  // With no dataset there is nothing to measure and nothing on screen to
  // smooth, so the answer is the one a small dataset would get.
  if (cellCount === null) return true;
  return automaticAntialiasing(cellCount, dimension);
}
