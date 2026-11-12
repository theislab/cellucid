/**
 * The camera's keys: which physical key moves the camera which way, and how
 * long each was held during a frame.
 *
 * `NAVIGATION_KEYS` is the one place a camera key is named. The viewer moves
 * the camera by them (`updateFreefly`, `updateOrbitPlanarKeys` in
 * `viewer.js`); the Keyboard shortcuts panel lists them
 * (`app/ui/onboarding/shortcut-table.js`). Keys are `KeyboardEvent.code`
 * values: the physical key, whatever the keyboard layout prints on it.
 *
 * `createHeldKeys` is what the viewer holds of them between frames. A held key
 * accelerates the camera for the time it was held: a frame credits each key
 * with the share of that frame it was down (`share`), so a press and release
 * between two frames still moves the camera, and a key held through part of a
 * slow frame moves it for that part only. Sampling only "is it down now" at
 * frame time lost a tap shorter than a frame and credited a held key with the
 * whole frame it was seen in, so equal presses moved the camera by different
 * amounts on a slow frame (round 9, R9K-3).
 *
 * @module rendering/navigation-keys
 */

/** Each camera movement and the physical keys that make it. */
export const NAVIGATION_KEYS = Object.freeze({
  forward: Object.freeze(['KeyW']),
  left: Object.freeze(['KeyA']),
  back: Object.freeze(['KeyS']),
  right: Object.freeze(['KeyD']),
  up: Object.freeze(['KeyE']),
  down: Object.freeze(['KeyQ']),
  zoomIn: Object.freeze(['Equal', 'BracketRight']),
  zoomOut: Object.freeze(['Minus', 'BracketLeft']),
  faster: Object.freeze(['ShiftLeft', 'ShiftRight']),
});

/** The movements each navigation mode answers (free-fly has no zoom: W and S fly instead). */
export const NAVIGATION_KEY_MODES = Object.freeze({
  forward: Object.freeze(['orbit', 'planar', 'free']),
  left: Object.freeze(['orbit', 'planar', 'free']),
  back: Object.freeze(['orbit', 'planar', 'free']),
  right: Object.freeze(['orbit', 'planar', 'free']),
  up: Object.freeze(['free']),
  down: Object.freeze(['free']),
  zoomIn: Object.freeze(['orbit', 'planar']),
  zoomOut: Object.freeze(['orbit', 'planar']),
  faster: Object.freeze(['orbit', 'planar', 'free']),
});

/** Every key that moves the camera (Shift alone moves nothing: it speeds a movement up). */
export const MOVEMENT_KEY_CODES = Object.freeze(new Set(
  Object.entries(NAVIGATION_KEYS).filter(([movement]) => movement !== 'faster').flatMap(([, codes]) => codes),
));

/** Every key the camera listens to. */
export const NAVIGATION_KEY_CODES = Object.freeze(new Set(Object.values(NAVIGATION_KEYS).flat()));

/** The label a key is printed with on a US keyboard (the panel shows these). */
export function keyLabelOf(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  const label = { Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', ShiftLeft: 'Shift', ShiftRight: 'Shift' }[code];
  if (label === undefined) throw new RangeError(`No label for the key ${code}.`);
  return label;
}

/**
 * The camera keys held now and since the last frame.
 *
 * Times are milliseconds on the `performance.now()` clock, which a key
 * event's `timeStamp` shares.
 *
 * @returns {{
 *   press: (code: string, at: number) => void,
 *   release: (code: string, at: number) => boolean,
 *   isDown: (codes: readonly string[]) => boolean,
 *   isMovementDown: () => boolean,
 *   share: (codes: readonly string[], from: number, to: number) => number,
 *   endFrame: (at: number) => void,
 *   clear: () => boolean,
 *   size: () => number,
 * }}
 */
export function createHeldKeys() {
  /** code → when it went down (null once released) and how long it was down, released, since the last frame. */
  const keys = new Map();

  const heldWithin = (entry, from, to) => {
    const open = entry.since === null ? 0 : Math.max(0, to - Math.max(entry.since, from));
    return entry.carried + open;
  };

  return {
    /** A key went down (a repeat of a held key changes nothing). */
    press(code, at) {
      const entry = keys.get(code);
      if (entry === undefined) keys.set(code, { since: at, carried: 0 });
      else if (entry.since === null) entry.since = at;
    },
    /**
     * A key came up: the time it was down stays credited to the next frame.
     * @returns {boolean} whether it was held
     */
    release(code, at) {
      const entry = keys.get(code);
      if (entry === undefined || entry.since === null) return false;
      entry.carried += Math.max(0, at - entry.since);
      entry.since = null;
      return true;
    },
    /** Whether one of `codes` is down now. */
    isDown(codes) {
      return codes.some(code => keys.get(code)?.since != null);
    },
    /** Whether a movement key is down now, or was pressed since the last frame. */
    isMovementDown() {
      for (const code of keys.keys()) if (MOVEMENT_KEY_CODES.has(code)) return true;
      return false;
    },
    /**
     * The share of the frame from `from` to `to` that one of `codes` was
     * down: 1 for a key held throughout, a fraction for a key pressed or
     * released during it (or both: a tap between two frames), 0 otherwise.
     */
    share(codes, from, to) {
      const span = to - from;
      let held = 0;
      for (const code of codes) {
        const entry = keys.get(code);
        if (entry !== undefined) held = Math.max(held, heldWithin(entry, from, to));
      }
      if (held <= 0) return 0;
      if (!(span > 0)) return 1;
      return Math.min(1, held / span);
    },
    /** The frame ending at `at` has used what was held: released keys are forgotten. */
    endFrame(at) {
      for (const [code, entry] of keys) {
        if (entry.since === null) keys.delete(code);
        else {
          entry.carried = 0;
          entry.since = Math.max(entry.since, at);
        }
      }
    },
    /** Forget every key (a mode change, focus lost). @returns {boolean} whether one was held */
    clear() {
      const had = keys.size > 0;
      keys.clear();
      return had;
    },
    size() {
      return keys.size;
    },
  };
}
