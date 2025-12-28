/**
 * @fileoverview Export fidelity warning dialog.
 *
 * Requirement: when an export cannot exactly reproduce the current view
 * (format limitations, missing WebGL2, unsupported overlays), warn the user
 * BEFORE exporting and let them cancel.
 *
 * @module ui/modules/figure-export/components/fidelity-warning-dialog
 */

import { createElement } from '../../../../utils/dom-utils.js';
import { showFigureExportModal } from './modal.js';

/**
 * @typedef {object} ExportFidelityWarning
 * @property {string} title
 * @property {string} detail
 */

/**
 * @param {object} options
 * @param {ExportFidelityWarning[]} options.warnings
 * @param {string} [options.heading]
 * @returns {Promise<boolean>} True if user chooses to proceed
 */
export function confirmExportFidelityWarnings({ warnings, heading = 'Export Fidelity Warnings' }) {
  const items = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  if (!items.length) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(value));
    };

    const body = createElement('div', {}, [
      createElement('div', { className: 'legend-help' }, [
        'This export may not exactly match what you currently see on screen:'
      ])
    ]);

    const list = createElement('div', { className: 'control-block figure-export-divider' });
    for (const w of items) {
      const title = String(w?.title || '').trim() || 'Warning';
      const detail = String(w?.detail || '').trim();
      const row = createElement('div', { className: 'legend-toggle-row' }, [
        createElement('div', { className: 'analysis-accordion-title' }, [title]),
      ]);
      if (detail) row.appendChild(createElement('div', { className: 'legend-help' }, [detail]));
      list.appendChild(row);
    }
    body.appendChild(list);

    const actions = createElement('div', { className: 'figure-export-modal-actions' }, [
      createElement('button', { type: 'button', className: 'btn-small' }, ['Cancel']),
      createElement('button', { type: 'button', className: 'btn-small' }, ['Export anyway'])
    ]);
    body.appendChild(actions);

    const { close } = showFigureExportModal({
      title: heading,
      content: body,
      onClose: () => settle(false)
    });

    const [cancelBtn, continueBtn] = actions.querySelectorAll('button');
    cancelBtn?.addEventListener('click', () => {
      settle(false);
      close();
    });
    continueBtn?.addEventListener('click', () => {
      settle(true);
      close();
    });
  });
}

