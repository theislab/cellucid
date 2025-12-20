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

function safeGetStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return typeof value === 'string' ? value : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {ThemeName}
 */
function normalizeTheme(value) {
  if (typeof value === 'string' && VALID_THEMES.has(value)) {
    // @ts-ignore - runtime validation above.
    return value;
  }
  return 'light';
}

function safeStoreTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (_) {
    /* localStorage unavailable */
  }
}

/**
 * Adds a temporary class to enable smooth theme transitions without making
 * every interaction animate.
 */
function withThemeTransition() {
  const root = document.documentElement;
  if (!root) return;
  if (root.classList.contains('theme-transition')) return;
  root.classList.add('theme-transition');
  window.setTimeout(() => root.classList.remove('theme-transition'), 220);
}

/**
 * @param {ThemeName} theme
 */
function applyTheme(theme) {
  const root = document.documentElement;
  if (!root) return;
  root.dataset.theme = theme;
}

/**
 * @param {ThemeName} theme
 */
function emitThemeChange(theme) {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('cellucid:theme-change', {
      detail: { theme }
    }));
  } catch (_) {
    // Ignore CustomEvent failures in very old environments.
  }
}

let currentTheme = /** @type {ThemeName} */ ('light');

export const ThemeManager = {
  /**
   * Initialize theme from storage.
   * Safe to call multiple times.
   */
  init() {
    const root = document.documentElement;
    const stored = safeGetStoredTheme();
    const fromDom = root?.dataset?.theme || '';
    const theme = normalizeTheme(stored || fromDom);
    this.setTheme(theme, { persist: true, withTransition: false });
  },

  /**
   * @returns {ThemeName}
   */
  getTheme() {
    return currentTheme;
  },

  /**
   * @param {ThemeName | string} theme
   * @param {{ persist?: boolean; withTransition?: boolean }} [options]
   */
  setTheme(theme, options = {}) {
    const nextTheme = normalizeTheme(theme);
    const persist = options.persist ?? true;
    const doTransition = options.withTransition ?? true;

    const prevTheme = currentTheme;
    currentTheme = nextTheme;

    if (persist) safeStoreTheme(nextTheme);

    const root = document.documentElement;
    const appliedTheme = root?.dataset?.theme || '';
    const alreadyApplied = appliedTheme === nextTheme;

    if (!alreadyApplied) {
      if (doTransition) withThemeTransition();
      applyTheme(nextTheme);
    }

    if (prevTheme !== nextTheme) emitThemeChange(nextTheme);
  },

  /**
   * Convenience toggle between light/dark.
   * @returns {ThemeName}
   */
  toggle() {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    this.setTheme(next);
    return next;
  }
};
