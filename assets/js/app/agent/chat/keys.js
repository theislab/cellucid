/**
 * @fileoverview Where the chat bar keeps the person's API keys.
 *
 * A key is kept **for this tab only** by default: in the tab's
 * `sessionStorage`, so a reload keeps it and closing the tab forgets it. Ticking
 * **Remember on this browser** keeps it in `localStorage` as well, so every
 * tab of this browser profile has it until **Forget**, which removes it from
 * both (and unticking Remember removes the remembered copy). A key is never
 * written anywhere else: not in a session file, the history, the URL, a log
 * or a request other than to its own provider.
 *
 * A browser that keeps no site data (a strict private mode) keeps the key in
 * memory for as long as the page is open.
 *
 * @module app/agent/chat/keys
 */

const PREFIX = 'cellucid:agent-key:';

/** The storage key of one provider's API key. */
export function keyStorageName(providerId) {
  return `${PREFIX}${providerId}`;
}

function storageOf(name, win) {
  try {
    return win?.[name] ?? null;
  } catch {
    return null;
  }
}

function read(storage, name) {
  try {
    return storage?.getItem(name) ?? null;
  } catch {
    return null;
  }
}

function write(storage, name, value) {
  try {
    if (value === null) storage?.removeItem(name);
    else storage?.setItem(name, value);
    return storage !== null;
  } catch {
    return false;
  }
}

/**
 * @param {{win?: object|null}} [options]
 */
export function createKeyStore({ win = globalThis.window ?? null } = {}) {
  const memory = new Map();
  const tab = () => storageOf('sessionStorage', win);
  const browser = () => storageOf('localStorage', win);

  return Object.freeze({
    /**
     * The key of `providerId` and where it is kept, or null.
     * @returns {{key: string, remembered: boolean}|null}
     */
    get(providerId) {
      const name = keyStorageName(providerId);
      const remembered = read(browser(), name);
      if (remembered !== null) return { key: remembered, remembered: true };
      const kept = read(tab(), name) ?? memory.get(name) ?? null;
      return kept === null ? null : { key: kept, remembered: false };
    },
    /**
     * Keep `key` for this tab, and on this browser when `remember`.
     * @returns {{tab: boolean, browser: boolean}} where it could be written (false: the browser keeps no site data)
     */
    set(providerId, key, { remember }) {
      const exact = String(key).trim();
      if (exact === '') throw new TypeError('An API key cannot be empty');
      const name = keyStorageName(providerId);
      memory.set(name, exact);
      const inTab = write(tab(), name, exact);
      const inBrowser = remember ? write(browser(), name, exact) : (write(browser(), name, null), false);
      return { tab: inTab, browser: inBrowser };
    },
    /** Keep the key of `providerId` on this browser too, or no longer. */
    remember(providerId, remember) {
      const name = keyStorageName(providerId);
      const kept = read(tab(), name) ?? memory.get(name) ?? read(browser(), name);
      if (kept === null) return false;
      return remember ? write(browser(), name, kept) : (write(browser(), name, null), true);
    },
    /** Forget the key of `providerId` everywhere this page kept it. */
    forget(providerId) {
      const name = keyStorageName(providerId);
      memory.delete(name);
      write(tab(), name, null);
      write(browser(), name, null);
    },
  });
}
