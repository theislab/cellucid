/**
 * @fileoverview Session serializer entry point.
 *
 * Exposes a single factory that creates the SessionSerializer orchestrator.
 *
 * @module session
 */

import { SessionSerializer } from './session-serializer.js';
import * as fieldOverlays from './contributors/field-overlays.js';
import * as userDefinedCodes from './contributors/user-defined-codes.js';
import * as coreState from './contributors/core-state.js';
import * as dockableLayout from './contributors/dockable-layout.js';
import * as analysisWindows from './contributors/analysis-windows.js';
import * as highlightsMeta from './contributors/highlights-meta.js';
import * as highlightsCells from './contributors/highlights-cells.js';
import * as analysisArtifacts from './contributors/analysis-artifacts.js';

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
  // Contributors are registered in a fixed order (plan requirement).
  const contributors = [
    fieldOverlays,
    userDefinedCodes,
    coreState,
    dockableLayout,
    analysisWindows,
    highlightsMeta,
    highlightsCells,
    analysisArtifacts
  ];
  return new SessionSerializer({ ...options, contributors });
}
