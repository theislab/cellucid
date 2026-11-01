/**
 * @fileoverview The address of a shipped file, naming its bytes.
 *
 * Every file under `assets/` is requested at a URL that names its bytes
 * (`?v=` and the first 12 hex digits of its SHA-256): the page's import map
 * lists each script at that URL (index.html, CELLUCID_MODULE_VERSIONS). A
 * file the app adds to the page itself (a classic `<script>`, which no import
 * map reaches) takes its address from here.
 *
 * The address is resolved relative to this module, so this module is never
 * bundled: a deployed page imports it at its own versioned URL
 * (`scripts/build-page-bundle.mjs`, `PAGE_EXTERNALS`).
 *
 * @module asset-url
 */

/**
 * The URL of a shipped file, at its version.
 *
 * @param {string} path the file's path under `assets/` (`external/plotly.min.js`)
 * @returns {string}
 */
export function versionedAssetUrl(path) {
  return import.meta.resolve(`../../${path}`);
}
