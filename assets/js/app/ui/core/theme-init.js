/**
 * Theme bootstrap (runs before CSS loads).
 *
 * Purpose:
 * - Apply the persisted theme to `documentElement.dataset.theme` as early as possible
 *   to avoid a flash of the wrong theme while CSS is still downloading.
 * - Apply the persisted viewer background mode early as well (`data-viewer-background`)
 *   since it is part of the overall visual theme (grid vs plain, light vs dark).
 *
 * Notes:
 * - This file is loaded directly from `index.html` (not bundled).
 * - `index.html` declares the exact current defaults before this script runs.
 * - Invalid preferences and browser storage failures remain actionable errors.
 */
(() => {
  const failureKey = '__cellucidThemeBootstrapFailure';
  delete globalThis[failureKey];

  try {
    const root = document.documentElement;
    if (!root) {
      throw new Error('Theme bootstrap requires the current document element.');
    }

    const validThemes = new Set(['light', 'dark']);
    const validBackgrounds = new Set(['grid', 'grid-dark', 'white', 'black']);
    const declaredTheme = root.dataset.theme;
    const declaredBackground = root.dataset.viewerBackground;
    if (!validThemes.has(declaredTheme)) {
      throw new TypeError('Declared theme must be exactly "light" or "dark".');
    }
    if (!validBackgrounds.has(declaredBackground)) {
      throw new TypeError(
        'Declared viewer background must be exactly "grid", "grid-dark", "white", or "black".',
      );
    }

    const storedTheme = localStorage.getItem('cellucid_theme');
    const storedBackground = localStorage.getItem('cellucid_viewer_background');
    if (storedTheme !== null && !validThemes.has(storedTheme)) {
      throw new TypeError('Stored theme must be exactly "light" or "dark".');
    }
    if (storedBackground !== null && !validBackgrounds.has(storedBackground)) {
      throw new TypeError(
        'Stored viewer background must be exactly "grid", "grid-dark", "white", or "black".',
      );
    }

    const theme = storedTheme === null ? declaredTheme : storedTheme;
    const background = storedBackground === null ? declaredBackground : storedBackground;
    root.dataset.theme = theme;
    root.dataset.viewerBackground = background;
    if (document.body) document.body.dataset.viewerBackground = background;
  } catch (error) {
    // Preserve the original owner failure for ThemeManager.init(), which is the
    // single module-bootstrap boundary. This prevents the app from starting
    // with substituted state without reporting the same exception twice.
    globalThis[failureKey] = error;
  }
})();
