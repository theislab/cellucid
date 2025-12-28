/**
 * Theme bootstrap (runs before CSS loads).
 *
 * Purpose:
 * - Apply the persisted theme to `documentElement.dataset.theme` as early as possible
 *   to avoid a flash of the wrong theme while CSS is still downloading.
 *
 * Notes:
 * - This file is loaded directly from `index.html` (not bundled).
 * - It must not throw; failures should degrade to the default theme.
 */
(() => {
  try {
    const storedTheme = localStorage.getItem('cellucid_theme');
    document.documentElement.dataset.theme = storedTheme === 'dark' ? 'dark' : 'light';
  } catch {
    // localStorage unavailable (e.g., privacy mode); keep default theme.
  }
})();
