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
 * - It must not throw; failures should degrade to the default theme.
 */
(() => {
  try {
    const root = document.documentElement;
    if (!root) return;

    const storedTheme = localStorage.getItem('cellucid_theme');
    root.dataset.theme = storedTheme === 'dark' ? 'dark' : 'light';

    const storedBg = localStorage.getItem('cellucid_viewer_background');
    const bg = storedBg === 'grid' || storedBg === 'grid-dark' || storedBg === 'white' || storedBg === 'black'
      ? storedBg
      : 'grid';

    root.dataset.viewerBackground = bg;
    if (document.body) document.body.dataset.viewerBackground = bg;
  } catch {
    // localStorage unavailable (e.g., privacy mode); keep defaults.
  }
})();
