/**
 * Names the web app's JavaScript uses and no module defines: globals a
 * classic script of the page sets, and one that exists only outside a browser.
 * Read by the type check alone (`tsconfig.json`); no page loads this file.
 */

/** gl-matrix (`assets/external/gl-matrix-min.js`), loaded by the page before its modules. */
declare const glMatrix: { mat4: any; vec3: any; vec4: any };

/** Plotly (`assets/external/plotly.min.js`), loaded on first use (`app/analysis/plots/plotly-loader.js`). */
declare const Plotly: any;

/** Node only (the contract tests run modules there); absent in every browser. */
declare const setImmediate: ((callback: () => void) => unknown) | undefined;
