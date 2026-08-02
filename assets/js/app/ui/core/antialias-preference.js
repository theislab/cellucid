/**
 * @module app/ui/core/antialias-preference
 *
 * Multisample antialiasing, and why this preference is stored rather than
 * published.
 *
 * `antialias` is a WebGL **context-creation attribute**. It is fixed by the
 * `canvas.getContext('webgl2', …)` call in `rendering/viewer.js` and there is no
 * API that changes it on a live context. Honouring a change therefore means a
 * new context, and Cellucid deliberately has no path to one: a lost context is
 * terminal by design — `viewer.js` refuses to rebuild GPU resources even when
 * the browser physically restores the context, and tells the user a reload is
 * required. Every GPU-resident thing the app owns (the point store, the alpha
 * texture, highlight buffers, snapshot views, the LOD index, connectivity edge
 * textures, the smoke volume, every program) hangs off that one context, and the
 * single `createViewer` result is captured by `createDataState` and every UI
 * module with no indirection to swap it behind.
 *
 * So the setting is stored here and read once, before the viewer is built. It
 * applies on the next load, and the control says so rather than pretending.
 *
 * A stored value in neither form is discarded rather than obeyed, and the caller
 * is handed the raw value so it can say so. It is deliberately not fatal: the
 * application is the only writer of this key, so a partial write or a tab killed
 * mid-save is enough to produce one, and there is no in-app recovery from a
 * startup that fails the same way on every reload. That is the same call
 * `github-auth-session` makes for a corrupt stored session, and for the same
 * reason. Nothing is silent — `main.js` reports the discarded value once the
 * notification centre exists.
 */

/** The `localStorage` key. */
export const ANTIALIAS_STORAGE_KEY = 'cellucid_antialias';

/**
 * Antialiasing is on unless the user turned it off.
 *
 * Smoothed point edges are the scientifically safer default: at the shipped
 * point size a dense cloud is nearly all edge pixels, so turning this off
 * changes what is drawn, not merely how fast it is drawn.
 */
export const DEFAULT_ANTIALIASING = true;

const STORED_ENABLED = 'on';
const STORED_DISABLED = 'off';

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
 * @property {boolean} enabled What the context should be created with.
 * @property {string|null} discarded The stored value that was thrown away, so
 *   the caller can report it. `null` when nothing had to be discarded — which
 *   includes a storage that cannot be read at all.
 */

/**
 * Resolve the antialiasing to create the WebGL context with.
 *
 * Never throws for anything a browser can legitimately present: an absent key,
 * an unreadable storage, and a value in neither form all resolve to the
 * default. Only the last of those is something to tell the user about, and it
 * comes back in `discarded` rather than being swallowed.
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
    return { enabled: DEFAULT_ANTIALIASING, discarded: null };
  }
  if (stored === null || stored === undefined) {
    return { enabled: DEFAULT_ANTIALIASING, discarded: null };
  }
  if (stored === STORED_ENABLED) return { enabled: true, discarded: null };
  if (stored === STORED_DISABLED) return { enabled: false, discarded: null };
  try {
    storage.removeItem(ANTIALIAS_STORAGE_KEY);
  } catch {
    // Removing it is not required for a coherent start. A storage that refuses
    // the removal keeps the unusable value, which is then reported again on the
    // next load — noisy but true. Refusing to start would be neither.
  }
  return { enabled: DEFAULT_ANTIALIASING, discarded: stored };
}

/**
 * Store the antialiasing preference.
 *
 * @param {Storage} storage
 * @param {boolean} enabled
 */
export function writeAntialiasPreference(storage, enabled) {
  assertStorage(storage, 'Storing the antialiasing preference');
  if (typeof enabled !== 'boolean') {
    throw new TypeError('Antialiasing preference must be an exact boolean.');
  }
  storage.setItem(
    ANTIALIAS_STORAGE_KEY,
    enabled ? STORED_ENABLED : STORED_DISABLED
  );
}
