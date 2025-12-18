/**
 * Export Components
 *
 * UI components for exporting analysis results:
 * - Export toolbar with PNG, SVG, CSV buttons
 * - Expand button for popup view
 */

import { createButton } from '../../shared/dom-utils.js';

// =============================================================================
// EXPORT TOOLBAR
// =============================================================================

/**
 * Create export toolbar - compact style (for inline use)
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

  if (onExportPNG) {
    container.appendChild(createButton({
      text: 'PNG',
      className: 'btn-small',
      title: 'Download as PNG',
      onClick: onExportPNG
    }));
  }

  if (onExportSVG) {
    container.appendChild(createButton({
      text: 'SVG',
      className: 'btn-small',
      title: 'Download as SVG',
      onClick: onExportSVG
    }));
  }

  if (onExportCSV) {
    container.appendChild(createButton({
      text: 'CSV',
      className: 'btn-small',
      title: 'Download data',
      onClick: onExportCSV
    }));
  }

  return container;
}

// =============================================================================
// EXPAND BUTTON
// =============================================================================

/**
 * Create "Open in Popup" button for expanding the analysis view
 * @param {Function} onClick - Click handler
 * @returns {HTMLButtonElement}
 */
export function createExpandButton(onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-small analysis-expand-btn';
  btn.innerHTML = '⤢ Expand';
  btn.title = 'Open in popup for more options';
  btn.addEventListener('click', onClick);
  return btn;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  createExportToolbar,
  createExpandButton
};
