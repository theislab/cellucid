/**
 * @fileoverview The page's one action catalogue, dispatcher and state-domain
 * registry. Owner modules call `getActions().provide(type, handler)` and
 * `getStateDomains().provide(id, owner)` when they start; controls call
 * `getActions().dispatch(type, params)`.
 *
 * @module app/actions
 */

import { createActionCatalog } from './catalog.js';
import { createActionDispatcher } from './dispatcher.js';
import { createDomainRegistry } from './domains.js';
import { ACTION_DEFINITIONS } from './definitions/index.js';

let catalog = null;
let dispatcher = null;
let domains = null;

/** The catalogue of every action (pure; also what the generated documents come from). */
export function getActionCatalog() {
  catalog ??= createActionCatalog(ACTION_DEFINITIONS);
  return catalog;
}

/** The page's dispatcher. */
export function getActions() {
  dispatcher ??= createActionDispatcher({ catalog: getActionCatalog() });
  return dispatcher;
}

/** The page's state-domain registry. */
export function getStateDomains() {
  domains ??= createDomainRegistry();
  return domains;
}
