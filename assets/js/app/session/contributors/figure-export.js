/**
 * @fileoverview Figure-export panel settings.
 *
 * The panel exports and imports one validated settings record
 * (`ui/modules/figure-export/utils/session-settings.js`); its controls stay
 * out of the generic UI-control inventory, so this record is the only one.
 *
 * @module session/contributors/figure-export
 */

import { assertFigureExportSessionSettings } from '../../ui/modules/figure-export/utils/session-settings.js';
import { requireMethod } from '../schema-contract.js';
import { getSessionRestoreSnapshot } from '../session-context.js';

export const id = 'figure-export';

function requirePanel(ctx, methods) {
  const panel = ctx?.figureExport;
  if (panel === null || typeof panel !== 'object') {
    throw new TypeError('Figure-export session settings require the figure-export panel.');
  }
  for (const method of methods) requireMethod(panel, method, 'Figure-export panel');
  return panel;
}

export function capture(ctx) {
  const panel = requirePanel(ctx, ['exportSessionSettings']);
  const settings = structuredClone(panel.exportSessionSettings());
  assertFigureExportSessionSettings(settings);
  return [{
    id: 'ui/figure-export',
    contributorId: id,
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Figure export',
    datasetDependent: false,
    payload: settings
  }];
}

export function restore(ctx, _chunkMeta, payload) {
  const panel = requirePanel(ctx, ['exportSessionSettings', 'importSessionSettings']);
  assertFigureExportSessionSettings(payload);
  const restoreTransaction = ctx.restoreTransaction;
  if (restoreTransaction === null || typeof restoreTransaction !== 'object') {
    panel.importSessionSettings(payload);
    return;
  }
  requireMethod(restoreTransaction, 'register', 'Figure-export restore transaction');
  const shared = getSessionRestoreSnapshot(ctx, 'ui/figure-export');
  const previous = shared === undefined
    ? structuredClone(panel.exportSessionSettings())
    : structuredClone(shared);
  let applied = false;
  // The frame and preview follow the views, so the panel is set once every
  // state participant has committed.
  restoreTransaction.register('figure-export/settings', {
    value: payload,
    stage: 'presentation',
    prepare() {},
    commit() {
      applied = true;
      panel.importSessionSettings(payload);
    },
    rollback() {
      if (!applied) return;
      panel.importSessionSettings(previous);
      applied = false;
    }
  });
}
