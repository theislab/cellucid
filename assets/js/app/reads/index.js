/**
 * @fileoverview The reads an agent, a notebook or a test makes of the open
 * dataset (`app/actions/definitions/reads.js`), provided on the page's
 * dispatcher. The history provides its own read (`history.get`,
 * `app/history/history.js`); the analyses theirs (`analysis/actions.js`);
 * settings and layout theirs (`ui/modules/settings-actions.js`,
 * `ui/modules/layout-actions.js`).
 *
 * @module app/reads
 */

import { createDatasetReads } from './dataset.js';
import { createViewReads } from './views.js';
import { createFramingReads } from './framing.js';
import { createVectorFieldReads } from './vector-field.js';

/**
 * @param {{
 *   actions: ReturnType<typeof import('../actions/dispatcher.js').createActionDispatcher>,
 *   state: object,
 *   viewer: object,
 *   dataSourceManager: object|null,
 *   documentRef: Document,
 *   getFigureExport: () => ({renderFigure: Function}|null),
 * }} owners
 * @returns {() => void} Removes the reads.
 */
export function installReadActions({ actions, state, viewer, dataSourceManager, documentRef, getFigureExport }) {
  if (typeof actions?.provide !== 'function') throw new TypeError('Reads need the action dispatcher.');
  const dataset = createDatasetReads({ state, viewer, dataSourceManager });
  const views = createViewReads({ state, viewer, documentRef, getFigureExport });
  const framing = createFramingReads({ state, viewer });
  const vectorField = createVectorFieldReads({ state, viewer });
  const removers = [
    actions.provide('dataset.summary', () => dataset.summary()),
    actions.provide('fields.list', params => dataset.listFields(params)),
    actions.provide('field.categories', (params, ctx) => dataset.categories(params, ctx)),
    actions.provide('genes.search', params => dataset.searchGenes(params)),
    actions.provide('cells.values', (params, ctx) => dataset.cellValues(params, ctx)),
    actions.provide('field.summary', (params, ctx) => dataset.fieldSummary(params, ctx)),
    actions.provide('vector-field.summary', (params, ctx) => vectorField.summary(params, ctx)),
    actions.provide('views.state', () => views.viewsState()),
    actions.provide('view.picture', (params, ctx) => views.picture(params, ctx)),
    actions.provide('camera.framing', (params, ctx) => framing.framing(params, ctx)),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
