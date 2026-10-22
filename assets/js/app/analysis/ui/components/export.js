/**
 * Export Components
 *
 * UI components for exporting analysis results:
 * - Export toolbar with PNG, SVG, CSV buttons
 * - Expand button for popup view
 *
 * Both are built by the shared control kit, so they are the same buttons the
 * rest of the sidebar draws.
 */

import { createButton } from '../../../ui/components/controls.js';

// =============================================================================
// EXPORT TOOLBAR
// =============================================================================

/**
 * Create export toolbar - compact buttons (for inline use)
 * @param {Object} options
 * @param {Function} options.onExportPNG - Export PNG callback
 * @param {Function} options.onExportSVG - Export SVG callback
 * @param {Function} options.onExportCSV - Export CSV callback
 * @returns {HTMLElement}
 */
export function createExportToolbar(options = {}) {
  const { onExportPNG, onExportSVG, onExportCSV } = options;

  const container = document.createElement('div');
  container.className = 'analysis-export-toolbar';

  for (const [label, title, onClick] of [
    ['PNG', 'Download as PNG', onExportPNG],
    ['SVG', 'Download as SVG', onExportSVG],
    ['CSV', 'Download data as CSV', onExportCSV]
  ]) {
    if (!onClick) continue;
    container.appendChild(createButton({
      label,
      title,
      className: 'btn-compact',
      onClick
    }));
  }

  return container;
}

// =============================================================================
// EXPAND BUTTON
// =============================================================================

/**
 * Create the button that opens the analysis in its expanded window.
 * @param {Function} onClick - Click handler
 * @returns {HTMLButtonElement}
 */
export function createExpandButton(onClick) {
  return createButton({
    label: 'Expand',
    title: 'Open in a larger window with more options',
    className: 'analysis-expand-btn',
    onClick
  });
}
