/**
 * @module app/ui/core/antialias-preference
 *
 * Multisample antialiasing: what the user asked for, and what a dataset asks for
 * when the user has not.
 *
 * Antialiasing used to be a WebGL context-creation attribute, fixed for the life
 * of the page, and this module existed to say so: it stored `on` or `off`, was
 * read once before the viewer was built, and the control told the user the choice
 * applied on the next load. `rendering/scene-msaa-target.js` replaced that with a
 * multisampled renderbuffer the application owns, so the setting is now live, and
 * this module answers a different question.
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
 * notification centre exists.
 */

/** The `localStorage` key. */
export const ANTIALIAS_STORAGE_KEY = 'cellucid_antialias';

/** The three things the preference can say. */
export const ANTIALIAS_MODES = Object.freeze(['auto', 'on', 'off']);

/**
 * What an absent or unusable stored value means.
 *
 * `auto` rather than `on`: the cell count is a better predictor of the right
 * answer than any constant, and it is known by the time the first frame is
 * drawn.
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

function assertStorage(storage, operation) {
  if (
    storage === null
    || typeof storage !== 'object'
    || typeof storage.getItem !== 'function'
    || typeof storage.setItem !== 'function'
    || typeof storage.removeItem !== 'function'
  ) {
    throw new TypeError(
      `${operation} requires one current key/value storage.`
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
 * @param {Storage} storage
 * @returns {ResolvedAntialiasPreference}
 */
export function resolveAntialiasPreference(storage) {
  assertStorage(storage, 'Reading the antialiasing preference');
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
 * Store the antialiasing preference.
 *
 * @param {Storage} storage
 * @param {'auto'|'on'|'off'} mode
 */
export function writeAntialiasPreference(storage, mode) {
  assertStorage(storage, 'Storing the antialiasing preference');
  if (!ANTIALIAS_MODES.includes(mode)) {
    throw new TypeError(
      'Antialiasing preference must be exactly "auto", "on", or "off".'
    );
  }
  storage.setItem(ANTIALIAS_STORAGE_KEY, mode);
}

/**
 * Whether a dataset of this many cells should be drawn antialiased.
 *
 * @param {number} cellCount
 * @returns {boolean}
 */
export function automaticAntialiasingForCellCount(cellCount) {
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
    throw new RangeError(
      'Automatic antialiasing requires one positive safe integer cell count.'
    );
  }
  return cellCount < AUTOMATIC_ANTIALIAS_CELL_LIMIT;
}

/**
 * Resolve one mode and one cell count into what the renderer should do.
 *
 * @param {'auto'|'on'|'off'} mode
 * @param {number|null} cellCount Null while no dataset is open.
 * @returns {boolean}
 */
export function antialiasingInForce(mode, cellCount) {
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
  return automaticAntialiasingForCellCount(cellCount);
}
