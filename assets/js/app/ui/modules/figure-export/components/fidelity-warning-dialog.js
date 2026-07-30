/**
 * @fileoverview Export fidelity warning dialog.
 *
 * Blocks an export when it cannot exactly reproduce the current view.
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
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<boolean>} True only when there are no fidelity blockers
 */
export function confirmExportFidelityWarnings({
  warnings,
  heading = 'Export blocked',
  signal = null,
}) {
  if (!Array.isArray(warnings)) {
    throw new TypeError('Figure export fidelity warnings must be an array.');
  }
  if (typeof heading !== 'string' || heading.trim().length === 0) {
    throw new TypeError('Figure export fidelity heading must be a non-empty string.');
  }
  if (
    signal !== null &&
    (
      typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'
    )
  ) {
    throw new TypeError(
      'Figure export fidelity signal must be null or an AbortSignal.'
    );
  }
  warnings.forEach((warning, index) => {
    if (
      warning === null ||
      typeof warning !== 'object' ||
      Array.isArray(warning) ||
      Object.getPrototypeOf(warning) !== Object.prototype ||
      Object.keys(warning).sort().join(',') !== 'detail,title' ||
      typeof warning.title !== 'string' ||
      warning.title.trim().length === 0 ||
      typeof warning.detail !== 'string' ||
      warning.detail.trim().length === 0
    ) {
      throw new TypeError(
        `Figure export fidelity warning ${index} must contain exact non-empty title and detail strings.`
      );
    }
  });
  if (signal?.aborted) return Promise.resolve(false);
  if (warnings.length === 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let closeModal = null;
    const onAbort = () => {
      if (closeModal === null) {
        settleBlocked();
        return;
      }
      closeModal();
    };
    const settleBlocked = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    };

    const body = createElement('div', {}, [
      createElement('div', { className: 'legend-help' }, [
        'Cellucid will not create an export that differs from the active view. Resolve the following first:'
      ])
    ]);

    const list = createElement('div', { className: 'control-block figure-export-divider' });
    for (const warning of warnings) {
      const row = createElement('div', { className: 'legend-toggle-row' }, [
        createElement('div', { className: 'analysis-accordion-title' }, [warning.title]),
      ]);
      row.appendChild(
        createElement('div', { className: 'legend-help' }, [warning.detail])
      );
      list.appendChild(row);
    }
    body.appendChild(list);

    const actions = createElement('div', { className: 'figure-export-modal-actions' }, [
      createElement('button', { type: 'button', className: 'btn-small' }, ['Back'])
    ]);
    body.appendChild(actions);

    const { close } = showFigureExportModal({
      title: heading,
      content: body,
      onClose: settleBlocked
    });
    closeModal = close;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      close();
      return;
    }

    const [backBtn] = actions.querySelectorAll('button');
    backBtn.addEventListener('click', () => {
      settleBlocked();
      close();
    });
  });
}
