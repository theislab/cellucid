/**
 * The viewer background enum: the one list every owner of the `Background`
 * control reads.
 *
 * The renderer (`viewer.setBackground`), its boundary guard
 * (`viewer/viewer-contracts.js`), the sidebar control
 * (`app/ui/modules/render-controls.js`), the visualization reset
 * (`app/ui/modules/visualization-reset.js`) and figure export
 * (`app/ui/modules/figure-export/utils/viewer-background.js`) import it.
 * Three owners cannot import a module and restate it instead: the
 * `#background-select` options and the `<html data-viewer-background>`
 * default in `index.html`, the early bootstrap `app/ui/core/theme-init.js`
 * (a classic script that runs before any module), and the page colours in
 * `assets/css`. `tests/viewer-background-enum-contract.test.mjs` holds all of
 * them to this list, so a background cannot exist in one place only.
 *
 * Order is menu order: the Light group (plain, grid, studio, then the baked
 * looks Atelier, Abyss, Aurora), then the Dark group in the same order
 * (Nebula is Atelier's dark twin); `VIEWER_BACKGROUND_GROUPS` names the groups.
 */

/** Every background the viewer draws, in `#background-select` order. */
export const VIEWER_BACKGROUNDS = Object.freeze([
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

/** The `#background-select` option groups, in menu order. */
export const VIEWER_BACKGROUND_GROUPS = Object.freeze([
  Object.freeze({ label: 'Light', backgrounds: Object.freeze(['white', 'grid', 'studio', 'atelier', 'abyss', 'aurora']) }),
  Object.freeze({ label: 'Dark', backgrounds: Object.freeze(['black', 'grid-dark', 'studio-dark', 'nebula', 'abyss-dark', 'aurora-dark']) }),
]);

/** The background a first visit opens with (`<html data-viewer-background>`). */
export const DEFAULT_VIEWER_BACKGROUND = 'studio';

/** Reader-facing names: exactly the `#background-select` option text. */
export const VIEWER_BACKGROUND_LABELS = Object.freeze({
  white: 'White',
  grid: 'Grid (light)',
  studio: 'Studio (light)',
  atelier: 'Atelier (light)',
  abyss: 'Abyss (light)',
  aurora: 'Aurora (light)',
  black: 'Black',
  'grid-dark': 'Grid (dark)',
  'studio-dark': 'Studio (dark)',
  nebula: 'Nebula (dark)',
  'abyss-dark': 'Abyss (dark)',
  'aurora-dark': 'Aurora (dark)',
});

/** The backgrounds that draw the studio floor and dot surface. */
export const STUDIO_VIEWER_BACKGROUNDS = Object.freeze(['studio', 'studio-dark']);

/**
 * The baked procedural looks (`rendering/backdrops/`). Their
 * ids and labels are `BACKDROP_LOOKS` in `backdrops/backdrop-looks.js`.
 */
export const LOOK_VIEWER_BACKGROUNDS = Object.freeze([
  'atelier',
  'abyss',
  'aurora',
  'nebula',
  'abyss-dark',
  'aurora-dark',
]);

/** The backgrounds that draw the reference grid box. */
export const GRID_VIEWER_BACKGROUNDS = Object.freeze(['grid', 'grid-dark']);

/** The message every owner raises for a value outside the enum. */
export const VIEWER_BACKGROUND_ERROR_MESSAGE =
  `Viewer background must be exactly one of ${
    VIEWER_BACKGROUNDS.map((mode) => `"${mode}"`).join(', ')
  }.`;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isViewerBackground(value) {
  return VIEWER_BACKGROUNDS.includes(value);
}
