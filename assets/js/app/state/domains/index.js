/**
 * @fileoverview The owners of the page's state domains
 * (`app/actions/domains.js`), installed once the app's state, viewer and
 * interface exist.
 *
 * Each domain module makes one owner `{capture, restore, describe}` from the
 * objects that hold its state; `installStateDomains` provides every one to
 * the page's registry (`getStateDomains()`), so every domain the history,
 * the session file and the fingerprint read has its owner from then on.
 * Adding a domain is one module here and one line in `OWNERS`; the contract
 * test (`tests/state-domains-contract.test.mjs`) fails while a domain of
 * `domains.js` has no owner here.
 *
 * @module app/state/domains
 */

import { DOMAIN_IDS } from '../../actions/domains.js';
import { getStateDomains } from '../../actions/index.js';
import { createCellsDomain } from './cells.js';
import { createMappingDomain } from './mapping.js';
import { createFieldOverlaysDomain } from './field-overlays.js';
import { createGeneSetsDomain } from './gene-sets.js';
import { createViewsDomain } from './views.js';
import { createActiveFieldDomain } from './active-field.js';
import { createFiltersDomain } from './filters.js';
import { createColorsDomain } from './colors.js';
import { createVisibilityDomain } from './visibility.js';
import { createHighlightsDomain } from './highlights.js';
import { createCameraDomain } from './camera.js';
import { createCameraPathDomain } from './camera-path.js';
import { createSettingsDomain } from './settings.js';
import { createAnalysisDomain } from './analysis.js';
import { createLayoutDomain } from './layout.js';

/** Each domain's owner factory, by domain id. */
export const OWNERS = Object.freeze({
  cells: createCellsDomain,
  mapping: createMappingDomain,
  'field-overlays': createFieldOverlaysDomain,
  'gene-sets': createGeneSetsDomain,
  views: createViewsDomain,
  'active-field': createActiveFieldDomain,
  filters: createFiltersDomain,
  colors: createColorsDomain,
  visibility: createVisibilityDomain,
  highlights: createHighlightsDomain,
  camera: createCameraDomain,
  'camera-path': createCameraPathDomain,
  settings: createSettingsDomain,
  analysis: createAnalysisDomain,
  layout: createLayoutDomain,
});

/**
 * Provide every state domain's owner.
 *
 * @param {{
 *   state: object,
 *   viewer: object,
 *   sidebar: HTMLElement,
 *   refreshUi: () => void,
 *   cinematicCamera: object|null,
 *   figureExport: object|null,
 *   analysis: () => Promise<{comparisonModule: object, analysisWindowManager: object}|null>,
 *   getDockable: () => object|null,
 *   openCells: object,
 *   sidebarLayout: object,
 *   domains?: ReturnType<typeof import('../../actions/domains.js').createDomainRegistry>,
 * }} options
 * @returns {() => void} Withdraws every owner (the page closes).
 */
export function installStateDomains({ domains = getStateDomains(), ...context }) {
  for (const key of ['state', 'viewer', 'sidebar', 'openCells', 'sidebarLayout']) {
    if (context[key] === null || typeof context[key] !== 'object') throw new TypeError(`The state domains need the page's ${key}.`);
  }
  for (const key of ['refreshUi', 'analysis', 'getDockable']) {
    if (typeof context[key] !== 'function') throw new TypeError(`The state domains need ${key}().`);
  }
  const withdraw = DOMAIN_IDS.map(id => {
    const create = OWNERS[id];
    if (create === undefined) throw new Error(`The state domain "${id}" has no owner module.`);
    return domains.provide(id, create(context));
  });
  return () => {
    for (const remove of withdraw) remove();
  };
}
