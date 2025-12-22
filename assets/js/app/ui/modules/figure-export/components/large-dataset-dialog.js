/**
 * @fileoverview Large dataset handling dialog.
 *
 * Requirement: for large exports, the user decides the strategy (vector vs
 * reduced vs hybrid vs raster). This dialog enforces an explicit choice when
 * the UI is set to "Ask".
 *
 * @module ui/modules/figure-export/components/large-dataset-dialog
 */

import { createElement } from '../../../../utils/dom-utils.js';
import { showFigureExportModal } from './modal.js';

/**
 * @typedef {'full-vector'|'optimized-vector'|'hybrid'|'raster'} LargeDatasetStrategy
 */

/**
 * @param {object} options
 * @param {number} options.pointCount
 * @param {number} [options.threshold]
 * @returns {Promise<LargeDatasetStrategy|null>}
 */
export function promptLargeDatasetStrategy({ pointCount, threshold = 50000 }) {
  const count = Math.max(0, Math.floor(pointCount || 0));

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = createElement('div', {}, [
      createElement('div', { className: 'legend-help' }, [
        `This export contains ${count.toLocaleString()} visible points (threshold: ${threshold.toLocaleString()}). Choose how to export points.`
      ])
    ]);

    const optionsBox = createElement('div', { className: 'control-block figure-export-divider' });

    /** @type {{ id: string; value: LargeDatasetStrategy; label: string; hint: string }[]} */
    const choices = [
      {
        id: 'figexp-strategy-full',
        value: 'full-vector',
        label: 'Full Vector (SVG circles)',
        hint: 'Best editability; may be slow/huge for large datasets.'
      },
      {
        id: 'figexp-strategy-optimized',
        value: 'optimized-vector',
        label: 'Optimized Vector (density-preserving reduction)',
        hint: 'Recommended for 50k–200k points; keeps clusters visually consistent.'
      },
      {
        id: 'figexp-strategy-hybrid',
        value: 'hybrid',
        label: 'Hybrid (points raster, annotations vector)',
        hint: 'Recommended for >200k points; fast and publication-safe.'
      },
      {
        id: 'figexp-strategy-raster',
        value: 'raster',
        label: 'High-DPI Raster (PNG)',
        hint: 'Maximum compatibility; axes/legend still included.'
      },
    ];

    let selected = /** @type {LargeDatasetStrategy} */ ('optimized-vector');

    for (const c of choices) {
      const radio = createElement('input', {
        type: 'radio',
        name: 'figure-export-large-strategy',
        id: c.id,
        checked: c.value === selected,
        onChange: () => { selected = c.value; }
      });
      const row = createElement('div', { className: 'legend-toggle-row' }, [
        createElement('label', { className: 'checkbox-inline', htmlFor: c.id }, [radio, ` ${c.label}`])
      ]);
      row.appendChild(createElement('div', { className: 'legend-help' }, [c.hint]));
      optionsBox.appendChild(row);
    }

    body.appendChild(optionsBox);

    const actions = createElement('div', { className: 'figure-export-modal-actions' }, [
      createElement('button', { type: 'button', className: 'btn-small' }, ['Cancel']),
      createElement('button', { type: 'button', className: 'btn-small' }, ['Continue'])
    ]);
    body.appendChild(actions);

    const { close } = showFigureExportModal({
      title: 'Large Dataset Export',
      content: body,
      onClose: () => settle(null)
    });

    const [cancelBtn, continueBtn] = actions.querySelectorAll('button');
    cancelBtn?.addEventListener('click', () => {
      settle(null);
      close();
    });
    continueBtn?.addEventListener('click', () => {
      settle(selected);
      close();
    });
  });
}
