/**
 * Where every sign-in of the app is kept: the tab's `sessionStorage`, one
 * record per account (GitHub for community annotations, Google, Microsoft).
 *
 * A sign-in survives a reload of the same tab and is gone when the tab
 * closes. It is never written to `localStorage`, IndexedDB, cookies, a URL,
 * a session file, figure provenance, the console, analytics or an error
 * message: this module is the only code that stores a token, and a contract
 * test holds every other module to that.
 *
 * Whoever shows a sign-in (the Session panel's "Signed in to Google" line)
 * listens to the store ({@link onSignInChange}): it hears when a sign-in is
 * stored, removed, or reaches the end its account set for it
 * ({@link setSignInExpiry}).
 *
 * @module data/sources/auth/token-store
 */

/** A storage the browser refused (private mode, a full quota, a blocked site). */
export class TokenStoreError extends Error {
  /**
   * @param {'read'|'write'|'remove'} operation
   * @param {unknown} cause
   */
  constructor(operation, cause) {
    super(`sessionStorage ${operation} failed`, { cause });
    this.name = 'TokenStoreError';
    this.code = 'TOKEN_STORE_FAILED';
    this.operation = operation;
  }
}

const NAME = /^[a-z][a-z0-9-]*$/;

/** The longest delay a browser timer keeps (a signed 32-bit millisecond count). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** @type {Set<(change: {name: string, change: 'stored'|'removed'|'expired'}) => void>} */
const listeners = new Set();
/** @type {Map<string, ReturnType<typeof setTimeout>>} The expiry timer of each account */
const expiries = new Map();

function announce(name, change) {
  for (const listener of [...listeners]) {
    try {
      listener(Object.freeze({ name, change }));
    } catch {
      // One display that fails must not keep the others from hearing it.
    }
  }
}

/**
 * Hear every change to the stored sign-ins: `stored`, `removed`, or
 * `expired` (the end {@link setSignInExpiry} named has passed).
 *
 * @param {(change: {name: string, change: 'stored'|'removed'|'expired'}) => void} listener
 * @returns {() => void} Stop listening
 */
export function onSignInChange(listener) {
  if (typeof listener !== 'function') throw new TypeError('A sign-in listener is a function.');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Say when one account's sign-in ends: listeners hear `expired` once
 * `until` has passed by the account's own clock. A later call replaces the
 * earlier one; `until` null (no sign-in) cancels it.
 *
 * @param {string} name
 * @param {number|null} until - Milliseconds on the clock `now` reads
 * @param {() => number} [now]
 */
export function setSignInExpiry(name, until, now = () => Date.now()) {
  signInStorageKey(name);
  clearTimeout(expiries.get(name));
  expiries.delete(name);
  if (until === null) return;
  if (!Number.isFinite(until)) throw new TypeError('A sign-in ends at a finite time.');
  const arm = () => {
    const left = until - now();
    if (left <= 0) {
      expiries.delete(name);
      announce(name, 'expired');
      return;
    }
    const timer = setTimeout(arm, Math.min(left, MAX_TIMER_DELAY_MS));
    // A sign-in waiting to end keeps nothing running (Node's timers can say so).
    timer?.unref?.();
    expiries.set(name, timer);
  };
  arm();
}

/**
 * The storage key of one account's sign-in.
 *
 * @param {string} name - `github-app`, `google`, `microsoft`
 * @returns {string}
 */
export function signInStorageKey(name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError('A sign-in is named by a lower-case word.');
  }
  return `cellucid:${name}-auth:session`;
}

function storage() {
  if (typeof sessionStorage === 'undefined') throw new Error('sessionStorage is unavailable');
  return sessionStorage;
}

/**
 * One account's stored sign-in, as written, or null.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function readSignIn(name) {
  const key = signInStorageKey(name);
  try {
    return storage().getItem(key);
  } catch (cause) {
    throw new TokenStoreError('read', cause);
  }
}

/**
 * Keep one account's sign-in for this tab.
 *
 * @param {string} name
 * @param {string} text
 */
export function writeSignIn(name, text) {
  const key = signInStorageKey(name);
  if (typeof text !== 'string') throw new TypeError('A stored sign-in is text.');
  try {
    storage().setItem(key, text);
  } catch (cause) {
    throw new TokenStoreError('write', cause);
  }
  announce(name, 'stored');
}

/**
 * Forget one account's sign-in.
 *
 * @param {string} name
 */
export function removeSignIn(name) {
  const key = signInStorageKey(name);
  try {
    storage().removeItem(key);
  } catch (cause) {
    throw new TokenStoreError('remove', cause);
  }
  setSignInExpiry(name, null);
  announce(name, 'removed');
}

/**
 * One account's stored record, or null when there is none, the browser
 * refuses storage, or the record is not what `isValid` accepts (it is then
 * forgotten).
 *
 * @param {string} name
 * @param {(record: Object) => boolean} isValid
 * @returns {Object|null}
 */
export function readSignInRecord(name, isValid) {
  let text;
  try {
    text = readSignIn(name);
  } catch {
    return null;
  }
  if (text === null) return null;
  let record = null;
  try {
    record = JSON.parse(text);
  } catch {
    record = null;
  }
  if (record !== null && typeof record === 'object' && !Array.isArray(record) && isValid(record)) {
    return record;
  }
  try {
    removeSignIn(name);
  } catch {
    // Storage that refuses removal handed back nothing usable either.
  }
  return null;
}

/**
 * Keep one account's record for this tab. A browser that refuses storage
 * keeps the sign-in for this page only: the reader still has it in memory.
 *
 * @param {string} name
 * @param {Object} record
 * @returns {boolean} Whether it was stored
 */
export function writeSignInRecord(name, record) {
  try {
    writeSignIn(name, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
