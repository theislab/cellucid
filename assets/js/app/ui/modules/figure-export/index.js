/**
 * @fileoverview Figure export module entry point.
 *
 * This module is intentionally isolated from the render loop: it only touches
 * large arrays when the user requests an export (or preview, if enabled).
 *
 * @module ui/modules/figure-export
 */

import { initFigureExportUI } from './figure-export-ui.js';
import { createFigureExportEngine } from './figure-export-engine.js';

/**
 * Initialize the Figure Export UI + engine.
 *
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {{ section?: HTMLElement|null; controls?: HTMLElement|null } | null} options.dom
 * @param {import('../../../../data/data-source-manager.js').DataSourceManager | null} [options.dataSourceManager]
 */
export function initFigureExport({ state, viewer, dom, dataSourceManager = null }) {
  const container = dom?.controls || null;
  if (!container) return {};

  const engine = createFigureExportEngine({ state, viewer, dataSourceManager });
  const ui = initFigureExportUI({ state, viewer, container, engine });

  return { ...ui, exportFigure: engine.exportFigure };
}

