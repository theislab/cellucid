// @ts-check

/**
 * ThemeManager
 *
 * - Only supports `light` and `dark`
 * - Persists to `localStorage` under `cellucid_theme`
 * - Applies theme via `document.documentElement.dataset.theme`
 * - Emits `cellucid:theme-change` with `{ detail: { theme } }`
 *
 * @typedef {import('../../../types/design-tokens').ThemeName} ThemeName
 */

const STORAGE_KEY = 'cellucid_theme';

/** @type {ReadonlySet<string>} */
const VALID_THEMES = new Set(['light', 'dark']);

/**
 * @param {unknown} value
 * @returns {ThemeName}
 */
function requireTheme(value) {
  if (typeof value === 'string' && VALID_THEMES.has(value)) {
    // @ts-ignore - runtime validation above.
    return value;
  }
  throw new TypeError('Theme must be exactly "light" or "dark".');
}

/**
 * @returns {HTMLElement}
 */
function requireDocumentRoot() {
  if (typeof document === 'undefined' || !(document.documentElement instanceof Object)) {
    throw new Error('ThemeManager requires the current document element.');
  }
  return document.documentElement;
}

/**
 * @param {unknown} options
 * @returns {{ persist: boolean; withTransition: boolean }}
 */
function requireOptions(options) {
  if (options === undefined) {
    return { persist: true, withTransition: true };
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Theme options must be an object with exact keys.');
  }

  const allowedKeys = new Set(['persist', 'withTransition']);
  const keys = Reflect.ownKeys(options);
  if (keys.some(key => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw new TypeError('Theme options must contain only the exact keys "persist" and "withTransition".');
  }

  // @ts-ignore - the object shape is validated immediately below.
  const persist = options.persist === undefined ? true : options.persist;
  // @ts-ignore - the object shape is validated immediately below.
  const withTransition = options.withTransition === undefined ? true : options.withTransition;
  if (typeof persist !== 'boolean') {
    throw new TypeError('Theme option "persist" must be a boolean.');
  }
  if (typeof withTransition !== 'boolean') {
    throw new TypeError('Theme option "withTransition" must be a boolean.');
  }
  return { persist, withTransition };
}

/**
 * Adds a temporary class to enable smooth theme transitions without making
 * every interaction animate.
 *
 * @param {HTMLElement} root
 */
function withThemeTransition(root) {
  if (root.classList.contains('theme-transition')) return;
  root.classList.add('theme-transition');
  window.setTimeout(() => root.classList.remove('theme-transition'), 220);
}

/**
 * @param {HTMLElement} root
 * @param {ThemeName} theme
 */
function applyTheme(root, theme) {
  root.dataset.theme = theme;
}

/**
 * @param {ThemeName} theme
 */
function emitThemeChange(theme) {
  window.dispatchEvent(new CustomEvent('cellucid:theme-change', {
    detail: { theme }
  }));
}

/** @type {ThemeName | null} */
let currentTheme = null;

export const ThemeManager = {
  /**
   * Adopt the exact theme already selected by the early document bootstrap.
   * Safe to call multiple times.
   */
  init() {
    if (Object.hasOwn(globalThis, '__cellucidThemeBootstrapFailure')) {
      throw Reflect.get(globalThis, '__cellucidThemeBootstrapFailure');
    }
    const root = requireDocumentRoot();
    currentTheme = requireTheme(root.dataset.theme);
  },

  /**
   * @returns {ThemeName}
   */
  getTheme() {
    if (currentTheme === null) {
      throw new Error('ThemeManager is not initialized.');
    }
    return currentTheme;
  },

  /**
   * @param {ThemeName} theme
   * @param {{ persist?: boolean; withTransition?: boolean }} [options]
   */
  setTheme(theme, options) {
    const nextTheme = requireTheme(theme);
    const { persist, withTransition: doTransition } = requireOptions(options);
    const root = requireDocumentRoot();
    const prevTheme = this.getTheme();
    const appliedTheme = requireTheme(root.dataset.theme);
    const alreadyApplied = appliedTheme === nextTheme;

    if (persist && (
      typeof localStorage === 'undefined'
      || typeof localStorage.setItem !== 'function'
    )) {
      throw new Error('Theme persistence requires the current localStorage owner.');
    }
    if (!alreadyApplied && doTransition && (
      typeof window === 'undefined'
      || typeof window.setTimeout !== 'function'
    )) {
      throw new Error('Theme transitions require the current window timer owner.');
    }
    if (prevTheme !== nextTheme && (
      typeof window === 'undefined'
      || typeof window.dispatchEvent !== 'function'
      || typeof CustomEvent !== 'function'
    )) {
      throw new Error('Theme changes require the current browser event owner.');
    }

    if (persist) localStorage.setItem(STORAGE_KEY, nextTheme);

    currentTheme = nextTheme;

    if (!alreadyApplied) {
      if (doTransition) withThemeTransition(root);
      applyTheme(root, nextTheme);
    }

    if (prevTheme !== nextTheme) emitThemeChange(nextTheme);
  },

  /**
   * Convenience toggle between light/dark.
   * @returns {ThemeName}
   */
  toggle() {
    const next = this.getTheme() === 'dark' ? 'light' : 'dark';
    this.setTheme(next);
    return next;
  }
};
