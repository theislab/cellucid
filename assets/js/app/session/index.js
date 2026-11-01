/**
 * @fileoverview Session serializer entry point.
 *
 * Exposes a single factory that creates the SessionSerializer orchestrator.
 *
 * @module session
 */

import {
  SessionSerializer
} from './session-serializer.js';
import * as fieldOverlays from './contributors/field-overlays.js';
import * as userDefinedCodes from './contributors/user-defined-codes.js';
import * as userDefinedValues from './contributors/user-defined-values.js';
import * as geneSets from './contributors/gene-sets.js';
import * as coreState from './contributors/core-state.js';
import * as dockableLayout from './contributors/dockable-layout.js';
import * as analysisWindows from './contributors/analysis-windows.js';
import * as analysisDocked from './contributors/analysis-docked.js';
import * as figureExport from './contributors/figure-export.js';
import * as highlightsMeta from './contributors/highlights-meta.js';
import * as highlightsCells from './contributors/highlights-cells.js';
import * as cinematicCamera from './contributors/cinematic-camera.js';
import { requireExactKeys } from '../../utils/exact-record.js';

/**
 * Create the SessionSerializer.
 *
 * Contributors are registered in a fixed order in `session/index.js` so the
 * orchestrator remains IO/scheduling-only.
 *
 * @param {object} options
 * @param {import('../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {HTMLElement|null} [options.sidebar]
 * @param {import('../../data/data-source-manager.js').DataSourceManager|null} [options.dataSourceManager]
 * @returns {SessionSerializer}
 */
export function createSessionSerializer(options) {
  requireExactKeys(
    options,
    ['state', 'viewer', 'sidebar', 'dataSourceManager'],
    'Session factory options'
  );
  // Contributors are registered in a fixed order (plan requirement).
  const contributors = [
    fieldOverlays,
    userDefinedCodes,
    userDefinedValues,
    geneSets,
    cinematicCamera,
    coreState,
    dockableLayout,
    figureExport,
    analysisWindows,
    analysisDocked,
    highlightsMeta,
    highlightsCells
  ];
  return new SessionSerializer({
    state: options.state,
    viewer: options.viewer,
    sidebar: options.sidebar,
    dataSourceManager: options.dataSourceManager,
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    figureExport: null,
    contributors
  });
}
