/**
 * Theme bootstrap (runs before CSS loads).
 *
 * Purpose:
 * - Apply the persisted theme to `documentElement.dataset.theme` as early as possible
 *   to avoid a flash of the wrong theme while CSS is still downloading.
 * - Apply the persisted viewer background mode early as well (`data-viewer-background`)
 *   since it is part of the overall visual theme (grid, studio or plain; light or dark).
 *
 * Notes:
 * - This file is loaded directly from `index.html` (not bundled).
 * - `index.html` declares the exact current defaults before this script runs.
 * - A preference this browser did not keep, or one this version does not know,
 *   starts the page on the declared defaults; invalid declared defaults remain
 *   actionable errors.
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
    // Restates `rendering/viewer-backgrounds.js`, which a classic script
    // cannot import; tests/viewer-background-enum-contract.test.mjs holds the
    // two to the same list.
    const validBackgrounds = new Set([
      'white',
      'grid',
      'studio',
      'atelier',
      'abyss',
      'aurora',
      'black',
      'grid-dark',
      'studio-dark',
      'nebula',
      'abyss-dark',
      'aurora-dark',
    ]);
    const backgroundList = [...validBackgrounds].map((mode) => `"${mode}"`).join(', ');
    const declaredTheme = root.dataset.theme;
    const declaredBackground = root.dataset.viewerBackground;
    if (!validThemes.has(declaredTheme)) {
      throw new TypeError('Declared theme must be exactly "light" or "dark".');
    }
    if (!validBackgrounds.has(declaredBackground)) {
      throw new TypeError(
        `Declared viewer background must be exactly one of ${backgroundList}.`,
      );
    }

    // What this browser kept of the person's choices. A browser that keeps
    // nothing for this site throws on the very read of `localStorage`
    // (`utils/web-storage.js`, which a classic script cannot import), and a
    // value this version does not know (another version wrote it) is no
    // choice: either way the page starts on the declared defaults.
    const stored = (key, valid) => {
      try {
        const value = localStorage.getItem(key);
        return value !== null && valid.has(value) ? value : null;
      } catch {
        return null;
      }
    };
    const storedTheme = stored('cellucid_theme', validThemes);
    const storedBackground = stored('cellucid_viewer_background', validBackgrounds);

    const theme = storedTheme === null ? declaredTheme : storedTheme;
    // A background the person never chose follows the theme: its twin in the
    // theme's group, at the same place (`viewer-backgrounds.js` `backgroundForTheme`).
    const ordered = [...validBackgrounds];
    const half = ordered.length / 2;
    const at = ordered.indexOf(declaredBackground);
    const followed = theme === 'dark' && at < half ? ordered[at + half]
      : theme === 'light' && at >= half ? ordered[at - half] : declaredBackground;
    const background = storedBackground === null ? followed : storedBackground;
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
